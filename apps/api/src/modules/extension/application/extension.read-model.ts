import { Injectable } from '@nestjs/common';
import {
  decideExtensionUse,
  displayExtensionValue,
  isExtensionUse,
  parsedFromStored,
  useSubjectFromDefinition,
  type ExtensionTargetKind,
} from '../../domain';
import { GovernanceError } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  ExtensionStore,
  type ExtensionEntry,
  type ExtensionRegistrySnapshot,
  type ExtensionTarget,
} from '../infrastructure/extension.store';
import { parseTarget, requireUuid, targetRef } from './extension-shared';

/** One value as a reader sees it. `value` only when shown (public / internal, or the audited flag). */
export interface ExtensionValueView {
  readonly target: string;
  readonly field: string;
  readonly valueType: string;
  readonly state: 'present' | 'empty';
  readonly sensitivity: string;
  readonly origin: string;
  readonly released: boolean;
  readonly shown: boolean;
  readonly value?: unknown;
  /** Reference values: the current end of the referenced entity's merge lineage (Q22). */
  readonly resolvedReference?: string;
}

export interface ExtensionReadOptions {
  /** Explicit field keys: a key lacking the use refuses the whole read (`extension_use_not_allowed`). */
  readonly fields?: readonly string[];
  /** Print values of `confidential` fields (audited); restricted values are never stored. */
  readonly includeConfidential?: boolean;
}

export interface CustomRecordView {
  readonly id: string;
  readonly object: string;
  readonly recordState: string;
  readonly mergedIntoId: string | null;
  readonly parent: string | null;
  readonly origin: string;
  readonly createdAt: Date;
}

export interface CustomRecordDetail extends CustomRecordView {
  readonly values: readonly ExtensionValueView[];
  readonly relationships: readonly {
    readonly id: string;
    readonly relationship: string;
    readonly from: string;
    readonly to: string;
    readonly role: string | null;
    readonly state: string;
    readonly endReason: string | null;
  }[];
}

const SHOWN_BY_DEFAULT = new Set(['public', 'internal']);
const PAGE_MAX = 500;

/**
 * `ExtensionUseGuard` (M10D plan §6, Q21): every reader of extension values
 * names its use. Without explicit keys, fields lacking the use are filtered
 * out; an explicit request for a field lacking it is refused
 * (`extension_use_not_allowed`).
 */
@Injectable()
export class ExtensionUseGuard {
  require(
    use: string,
    entries: readonly ExtensionEntry[],
    explicitKeys?: readonly string[],
  ): readonly string[] {
    if (!isExtensionUse(use)) {
      throw new GovernanceError('validation_failed', `${use} is not an extension use`);
    }
    const decision = decideExtensionUse(
      use,
      entries.map((e) => useSubjectFromDefinition(e.key, e.definition)),
      explicitKeys,
    );
    if (!decision.ok) {
      throw new GovernanceError(
        'extension_use_not_allowed',
        `Fields not allowed for ${use}: ${decision.refused.join(', ')}`,
      );
    }
    return decision.allowed;
  }
}

/**
 * Read models of the extension framework (M10D plan §8): values of many
 * targets in one batch (no N+1: one query for values, one for items), merge
 * lineage resolved for references, filtered by use; custom records with
 * keyset pagination; a record with its values and relationships. Capability
 * `data.extension.read` (operator); one `extension.read` audit event per call
 * with identifiers and counts only (Q29).
 */
@Injectable()
export class ExtensionReadModel {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: ExtensionStore,
    private readonly guard: ExtensionUseGuard,
    readonly audit: AuditTrail,
  ) {}

  @AuditFailures('extension.read', 'extension_value')
  async valuesFor(
    actx: AuthorizedContext<'data.extension.read'>,
    use: string,
    targets: readonly string[],
    options: ExtensionReadOptions = {},
  ): Promise<readonly ExtensionValueView[]> {
    assertAuthorized(actx, 'data.extension.read');
    if (targets.length === 0 || targets.length > PAGE_MAX) {
      throw new GovernanceError('validation_failed', `Between 1 and ${PAGE_MAX} targets`);
    }
    const parsed = targets.map((t) => parseTarget(t));
    return this.db.transaction(actx.tenant, async (tx) => {
      const registry = await this.store.registry(tx);
      const views = await this.load(tx, registry, use, parsed, options);
      await this.audit.record(tx, actx, {
        action: 'extension.read',
        targetKind: 'extension_value',
        targetRef: parsed.length === 1 ? targetRef(parsed[0]!) : `${parsed.length}_targets`,
        details: {
          use: String(use),
          targets: parsed.length,
          values: views.length,
          includeConfidential: options.includeConfidential === true,
        },
      });
      return views;
    });
  }

  @AuditFailures('extension.read', 'custom_record')
  async records(
    actx: AuthorizedContext<'data.extension.read'>,
    query: { readonly object: string; readonly after?: string; readonly limit?: number },
  ): Promise<{ readonly records: readonly CustomRecordView[]; readonly next?: string }> {
    assertAuthorized(actx, 'data.extension.read');
    const limit = Math.min(Math.max(query.limit ?? 100, 1), PAGE_MAX);
    const after = query.after ? requireUuid(query.after, '--after') : undefined;
    return this.db.transaction(actx.tenant, async (tx) => {
      const registry = await this.store.registry(tx);
      const object = registry.byKey.get(query.object);
      if (!object || object.definition.kind !== 'custom_object') {
        throw new GovernanceError('extension_field_unknown', 'No such custom object');
      }
      const rows = await this.store.recordsPage(tx, object.id, after, limit + 1);
      const page = rows.slice(0, limit).map((r) => recordView(r, query.object));
      await this.audit.record(tx, actx, {
        action: 'extension.read',
        targetKind: 'custom_record',
        targetRef: object.id,
        details: { object: query.object, records: page.length },
      });
      return { records: page, ...(rows.length > limit ? { next: page.at(-1)!.id } : {}) };
    });
  }

  @AuditFailures('extension.read', 'custom_record')
  async record(
    actx: AuthorizedContext<'data.extension.read'>,
    query: {
      readonly record: string;
      readonly use?: string;
      readonly includeConfidential?: boolean;
    },
  ): Promise<CustomRecordDetail> {
    assertAuthorized(actx, 'data.extension.read');
    const id = requireUuid(query.record, '--record');
    return this.db.transaction(actx.tenant, async (tx) => {
      const registry = await this.store.registry(tx);
      const row = await this.store.record(tx, id);
      if (!row) throw new GovernanceError('validation_failed', 'No such custom record');
      const objectKey = registry.byId.get(row.objectId)?.key ?? '';
      const values = await this.load(
        tx,
        registry,
        query.use ?? 'display',
        [{ kind: 'custom_record', id }],
        {
          ...(query.includeConfidential ? { includeConfidential: true } : {}),
        },
      );
      const edges = await this.store.edgesOf(tx, { kind: 'custom_record', id });
      await this.audit.record(tx, actx, {
        action: 'extension.read',
        targetKind: 'custom_record',
        targetRef: id,
        details: {
          values: values.length,
          relationships: edges.length,
          includeConfidential: query.includeConfidential === true,
        },
      });
      return {
        ...recordView(row, objectKey),
        values,
        relationships: edges.map((e) => ({
          id: e.id,
          relationship: registry.byId.get(e.relDefId)?.key ?? '',
          from: `${e.fromKind}:${e.fromId ?? e.fromKey}`,
          to: `${e.toKind}:${e.toId ?? e.toKey}`,
          role: e.roleCode,
          state: e.state,
          endReason: e.endReason,
        })),
      };
    });
  }

  /** Batch load per target kind (plan §8), use-filtered, references resolved through lineage. */
  private async load(
    tx: TenantTransaction,
    registry: ExtensionRegistrySnapshot,
    use: string,
    targets: readonly ExtensionTarget[],
    options: ExtensionReadOptions,
  ): Promise<ExtensionValueView[]> {
    const fields = [...registry.byKey.values()].filter((e) => e.definition.kind === 'field');
    const allowed = new Set(this.guard.require(use, fields, options.fields));
    const allowedIds = fields.filter((f) => allowed.has(f.key)).map((f) => f.id);
    const byKind = new Map<ExtensionTargetKind, string[]>();
    for (const t of targets) byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t.id]);
    const out: ExtensionValueView[] = [];
    for (const [kind, ids] of byKind) {
      const { rows, items } = await this.store.valuesForTargets(
        tx,
        kind,
        [...new Set(ids)],
        allowedIds,
      );
      for (const row of rows) {
        const entry = registry.byId.get(row.fieldId)!;
        const parsed = parsedFromStored(row, items.get(row.id) ?? []);
        const shown =
          SHOWN_BY_DEFAULT.has(entry.sensitivity) ||
          (options.includeConfidential === true && entry.sensitivity === 'confidential');
        let resolvedReference: string | undefined;
        if (shown && parsed.state === 'present' && parsed.ref) {
          const end = await this.store.resolveLineage(tx, {
            kind: parsed.ref.kind,
            id: parsed.ref.id ?? parsed.ref.key!,
          });
          resolvedReference = targetRef(end);
        }
        out.push({
          target: `${kind}:${row.targetId ?? row.targetKey}`,
          field: entry.key,
          valueType: row.valueType,
          state: parsed.state,
          sensitivity: entry.sensitivity,
          origin: row.origin,
          released: row.releasedAt !== null,
          shown,
          ...(shown ? { value: displayExtensionValue(parsed) } : {}),
          ...(resolvedReference ? { resolvedReference } : {}),
        });
      }
    }
    return out;
  }
}

function recordView(
  r: {
    id: string;
    recordState: string;
    mergedIntoId: string | null;
    parentKind: string | null;
    parentId: string | null;
    parentKey: string | null;
    origin: string;
    createdAt: Date;
  },
  object: string,
): CustomRecordView {
  return {
    id: r.id,
    object,
    recordState: r.recordState,
    mergedIntoId: r.mergedIntoId,
    parent: r.parentKind ? `${r.parentKind}:${r.parentId ?? r.parentKey}` : null,
    origin: r.origin,
    createdAt: r.createdAt,
  };
}
