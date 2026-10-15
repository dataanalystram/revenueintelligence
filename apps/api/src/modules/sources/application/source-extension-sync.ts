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

/** MUTATION VM19: account records each run handed to the extension writers. */
export const vm19Seen = new Map<string, Set<string>>();

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

  /** MUTATION VM19: clears this connection's source values (failed run / absence). */
  async vm19Clear(meta: ExtensionRunMeta, keep?: ReadonlySet<string>): Promise<void> {
    const rows = await this.db.transaction(meta.actx.tenant, (tx) =>
      tenantClient(tx).$queryRawUnsafe<
        { kind: string; id: string; key: string; rid: string | null; ot: string | null }[]
      >(
        `SELECT v.target_kind AS kind, v.target_id::text AS id, e.key, v.source_record_id AS rid,
                v.source_object_type AS ot
           FROM tenant_extension_values v JOIN tenant_registry_entries e
             ON e.tenant_id = v.tenant_id AND e.kind = v.field_registry_kind AND e.id = v.field_id
          WHERE v.tenant_id = $1::uuid AND v.origin = 'source_provided' AND v.value_state = 'present'
            AND v.source_connection_id = $2::uuid AND v.target_id IS NOT NULL`,
        meta.actx.tenant.tenantId,
        meta.connectionId,
      ),
    );
    const byTarget = new Map<string, typeof rows>();
    for (const r of rows) {
      if (keep && r.rid && keep.has(r.rid)) continue;
      byTarget.set(`${r.kind}|${r.id}`, [...(byTarget.get(`${r.kind}|${r.id}`) ?? []), r]);
    }
    for (const group of byTarget.values()) {
      const first = group[0]!;
      await this.values.observeSource(meta.actx, {
        target: { kind: first.kind, id: first.id } as never,
        values: group.map((r) => ({ field: r.key, raw: null })),
        observedAt: meta.observedAt,
        provenance: this.provenance(meta, first.ot ?? 'Accounts', first.rid ?? first.id),
      });
    }
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
    if (!vm19Seen.has(meta.runId)) vm19Seen.set(meta.runId, new Set());
    vm19Seen.get(meta.runId)!.add(recordId);
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
