import { Injectable } from '@nestjs/common';
import {
  capturedFieldKey,
  extensionTargetKind,
  mapCustomObjectRecord,
  mapExtensionStatements,
  type ExternalSystem,
  type ExtensionTargetKind,
  type ObjectMapping,
  type QualityCode,
  type SourceRecord,
} from '../../domain';
import {
  CustomRecordWriter,
  CustomRelationshipWriter,
  ExtensionValueWriter,
  type ExtensionObserveOutcome,
  type ExtensionProvenance,
} from '../../extension';
import { tenantClient, TenantDatabase, type AuthorizedContext } from '../../tenancy';

/** The run coordinates an extension write records (identifiers only). */
export interface ExtensionRunMeta {
  readonly actx: AuthorizedContext<'canonical.source_sync'>;
  readonly kind: ExternalSystem;
  readonly connectionId: string;
  readonly mappingVersion: number;
  readonly correlationId: string;
  readonly runId: string;
  readonly cause: 'backfill' | 'reconciliation';
  readonly adapterVersion: string;
  readonly observedAt: Date;
}

/** Counters added to the run report (codes only, never values). */
export type ExtensionCount = (code: string, by?: number) => void;

/**
 * M10D (plan §4, §5): the source-sync side of the extension framework. After
 * the canonical writer applied an account / person / subscription record
 * (its authority decided by the run, Q13), the record's `attribute` /
 * `capture` statements go to `ExtensionValueWriter` and its
 * `custom_relationship` statements to `CustomRelationshipWriter`; records of
 * `custom_object:<key>` objects go to `CustomRecordWriter` (single owner
 * connection enforced at mapping publish, Q14). Each target is one
 * transaction of its own (idempotent by field hash: a re-run re-applies
 * nothing). Rejections are counted per reason (`lip_extension_value_rejected_total`).
 */
@Injectable()
export class SourceExtensionSync {
  constructor(
    private readonly db: TenantDatabase,
    private readonly values: ExtensionValueWriter,
    private readonly records: CustomRecordWriter,
    private readonly relationships: CustomRelationshipWriter,
  ) {}

  /** True when the object mapping states anything for the extension writers. */
  static hasStatements(obj: ObjectMapping): boolean {
    return (
      obj.fields.some((f) => f.kind === 'attribute' || f.kind === 'capture') ||
      obj.relationships.some((r) => r.target.startsWith('custom_relationship:'))
    );
  }

  private provenance(
    meta: ExtensionRunMeta,
    objectType: string,
    recordId: string,
    sourceUpdatedAt?: Date,
  ): ExtensionProvenance {
    return {
      source: { system: meta.kind, objectType, id: recordId },
      cause: meta.cause,
      checkpointId: meta.runId,
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
      adapter: meta.kind,
      adapterVersion: meta.adapterVersion,
      correlationId: meta.correlationId,
      mappingVersion: meta.mappingVersion,
      actor: meta.actx.actor,
      origin: 'source_provided',
      connectionId: meta.connectionId,
    };
  }

  /** The extension statements of one applied canonical record (account, person, subscription). */
  async canonicalRecord(
    meta: ExtensionRunMeta,
    obj: ObjectMapping,
    record: SourceRecord,
    target: { readonly kind: 'company' | 'person' | 'subscription'; readonly id: string },
    count: ExtensionCount,
  ): Promise<void> {
    if (record.deleted || record.rejection) return;
    const quality: QualityCode[] = [];
    const statements = mapExtensionStatements(obj, record, meta.kind, quality, (o, f) =>
      capturedFieldKey(meta.kind, o, f),
    );
    quality.forEach((q) => count(q));
    const recordId = String(record.values[obj.identity.field] ?? record.id);
    const provenance = this.provenance(meta, obj.source, recordId, record.modifiedAt);
    if (statements.values.length > 0) {
      const out = await this.values.observeSource(meta.actx, {
        target,
        values: statements.values,
        observedAt: meta.observedAt,
        provenance,
      });
      countValues(out, count);
    }
    for (const rel of statements.relationships) {
      await this.relationship(meta, target, rel, provenance, count);
    }
  }

  /** One page of a `custom_object:<key>` object mapping. */
  async customObjectPage(
    meta: ExtensionRunMeta,
    obj: ObjectMapping,
    records: readonly SourceRecord[],
    count: ExtensionCount,
  ): Promise<void> {
    const parentKind = await this.parentKind(meta, obj);
    for (const record of records) {
      if (record.rejection) {
        count('record_rejected');
        continue;
      }
      const mapped = mapCustomObjectRecord(obj, record, meta.kind, (o, f) =>
        capturedFieldKey(meta.kind, o, f),
      );
      if (mapped.outcome === 'skipped') {
        count(mapped.code);
        continue;
      }
      mapped.quality.forEach((q) => count(q));
      const provenance = this.provenance(meta, obj.source, mapped.ref.id, mapped.sourceUpdatedAt);
      const out = await this.records.observeSource(meta.actx, {
        objectKey: mapped.objectKey,
        ref: mapped.ref,
        presence: mapped.presence,
        ...(mapped.parent !== undefined && parentKind
          ? { parent: mapped.parent === null ? null : { kind: parentKind, ref: mapped.parent } }
          : {}),
        ...(mapped.state ? { state: mapped.state } : {}),
        values: mapped.extensions.values,
        observedAt: meta.observedAt,
        provenance,
      });
      count(`custom_record_${out.status}`);
      if (out.reason) count(`custom_record_rejected_${out.reason}`);
      if (out.values) countValues(out.values, count);
      if (out.recordId) {
        for (const rel of mapped.extensions.relationships) {
          await this.relationship(
            meta,
            { kind: 'custom_record', id: out.recordId },
            rel,
            provenance,
            count,
          );
        }
      }
    }
  }

  private async relationship(
    meta: ExtensionRunMeta,
    from: { readonly kind: ExtensionTargetKind; readonly id: string },
    rel: {
      readonly key: string;
      readonly to: { system: string; objectType: string; id: string } | null;
      readonly role?: string;
    },
    provenance: ExtensionProvenance,
    count: ExtensionCount,
  ): Promise<void> {
    const toKind = rel.to ? await this.toKind(meta, rel.key) : undefined;
    if (rel.to && !toKind) {
      count('custom_relationship_rejected_relationship_unknown');
      return;
    }
    const out = await this.relationships.observeSource(meta.actx, {
      relationshipKey: rel.key,
      from,
      to: rel.to && toKind ? { kind: toKind, ref: rel.to } : null,
      ...(rel.role ? { role: rel.role } : {}),
      observedAt: meta.observedAt,
      provenance,
    });
    count(`custom_relationship_${out.status}`);
    if (out.roleUnmapped) count('custom_relationship_role_unmapped');
  }

  /** The entity-index kind of a relationship definition's `to` end. */
  private async toKind(
    meta: ExtensionRunMeta,
    key: string,
  ): Promise<ExtensionTargetKind | undefined> {
    const def = await this.definition(meta, key);
    return typeof def?.to === 'string' ? extensionTargetKind(def.to) : undefined;
  }

  private async parentKind(
    meta: ExtensionRunMeta,
    obj: ObjectMapping,
  ): Promise<'company' | 'person' | 'subscription' | undefined> {
    const def = await this.definition(meta, obj.entity.slice('custom_object:'.length));
    const kind = (def?.parent as { kind?: string } | undefined)?.kind;
    return kind === 'account'
      ? 'company'
      : kind === 'person' || kind === 'subscription'
        ? kind
        : undefined;
  }

  private async definition(
    meta: ExtensionRunMeta,
    key: string,
  ): Promise<Record<string, unknown> | undefined> {
    const row = await this.db.transaction(meta.actx.tenant, (tx) =>
      tenantClient(tx).tenantRegistryEntry.findUnique({
        where: { tenantId_kind_key: { tenantId: tx.tenantId, kind: 'extension', key } },
        select: { definition: true },
      }),
    );
    return (row?.definition ?? undefined) as Record<string, unknown> | undefined;
  }
}

function countValues(out: ExtensionObserveOutcome, count: ExtensionCount): void {
  if (out.status !== 'ok') {
    count(`extension_values_${out.status}`);
    return;
  }
  if (out.written) count('extension_values_written', out.written);
  if (out.withheld) count('restricted_value_withheld', out.withheld);
  if (out.humanOverride) count('extension_human_override_active', out.humanOverride);
  for (const [reason, n] of Object.entries(out.rejected))
    count(`extension_value_rejected_${reason}`, n);
}
