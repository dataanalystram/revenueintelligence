import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  compareCanonicalVersion,
  EXTENSION_MIN_VERSION,
  EXTENSION_MODULE_KEY,
  extensionTargetKind,
  type DataCategory,
  type ExtensionReference,
  type ExtensionTargetKind,
  type IdentityConflictKind,
  type ParsedExtensionItem,
  type ParsedExtensionValue,
  type Sensitivity,
  type StoredExtensionColumns,
} from '../../domain';
import {
  adoptedCanonicalVersion,
  insertContextChange,
  tenantAdvisoryLock,
  tenantClient,
  type ChangeWrite,
  type TenantTransaction,
} from '../../tenancy';

/**
 * Persistence for the M10D extension framework (plan §3): the extension
 * registry projection (read only), `tenant_extension_values` and items,
 * `tenant_custom_records`, `tenant_custom_relationships` and the interim
 * data-quality issues. Used only by the extension writers, the merge
 * participant and the read models. Every method takes an open tenant
 * transaction (forced RLS) and carries the tenant predicate. Identifiers only
 * in anything it logs or returns as an error.
 */

/** One projected extension definition (`tenant_registry_entries`, kind `extension`). */
export interface ExtensionEntry {
  readonly id: string;
  readonly key: string;
  readonly status: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly sensitivity: Sensitivity;
  readonly categories: readonly DataCategory[];
}

export interface ExtensionRegistrySnapshot {
  /** The current published extension registry version; undefined = never published. */
  readonly version: number | undefined;
  readonly byKey: ReadonlyMap<string, ExtensionEntry>;
  readonly byId: ReadonlyMap<string, ExtensionEntry>;
}

/** An extension target or reference end: an entity-index row. */
export interface ExtensionTarget {
  readonly kind: ExtensionTargetKind;
  /** Canonical id, or the product key for `product`. */
  readonly id: string;
}

export interface StoredValueRow extends StoredExtensionColumns {
  readonly id: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly targetKey: string | null;
  readonly fieldId: string;
  readonly origin: string;
  readonly fieldHash: string | null;
  readonly releasedAt: Date | null;
  readonly valueItemCount: number | null;
}

export interface CustomRecordRow {
  readonly id: string;
  readonly objectId: string;
  readonly parentKind: string | null;
  readonly parentId: string | null;
  readonly parentKey: string | null;
  readonly naturalKeyHash: string | null;
  readonly recordState: string;
  readonly mergedIntoId: string | null;
  readonly origin: string;
  readonly createdAt: Date;
}

export interface RelationshipRow {
  readonly id: string;
  readonly relDefId: string;
  readonly fromKind: string;
  readonly fromId: string | null;
  readonly fromKey: string | null;
  readonly toKind: string;
  readonly toId: string | null;
  readonly toKey: string | null;
  readonly roleCode: string | null;
  readonly state: string;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  readonly origin: string;
}

export interface ExtensionIssueWrite {
  readonly kind: IdentityConflictKind;
  readonly entityKind: ExtensionTargetKind;
  readonly identity: string;
  readonly canonicalIds: readonly string[];
  /** `system:objectType:id` keys (identifiers only); field keys as `extension:field:<key>`. */
  readonly externalRefs: readonly string[];
}

export type ExtensionGateState = 'ok' | 'canonical_version_too_low' | 'module_disabled';

const registryCache = new WeakMap<TenantTransaction, ExtensionRegistrySnapshot>();

export const VALUE_SELECT = {
  id: true,
  targetKind: true,
  targetId: true,
  targetKey: true,
  fieldId: true,
  valueType: true,
  valueState: true,
  valueText: true,
  valueNumber: true,
  valueBool: true,
  valueDate: true,
  valueTs: true,
  valueMoneyMinor: true,
  valueCurrency: true,
  valueEnum: true,
  valueItemCount: true,
  valueJson: true,
  valueRefKind: true,
  valueRefId: true,
  valueRefKey: true,
  origin: true,
  fieldHash: true,
  releasedAt: true,
} as const;

/** Prisma row → the store's plain row (decimals and bigints as strings, dates as `YYYY-MM-DD`). */
export function toStoredValue(r: {
  id: string;
  targetKind: string;
  targetId: string | null;
  targetKey: string | null;
  fieldId: string;
  valueType: string;
  valueState: string;
  valueText: string | null;
  valueNumber: { toString(): string } | null;
  valueBool: boolean | null;
  valueDate: Date | null;
  valueTs: Date | null;
  valueMoneyMinor: bigint | null;
  valueCurrency: string | null;
  valueEnum: string | null;
  valueItemCount: number | null;
  valueJson: unknown;
  valueRefKind: string | null;
  valueRefId: string | null;
  valueRefKey: string | null;
  origin: string;
  fieldHash: string | null;
  releasedAt: Date | null;
}): StoredValueRow {
  return {
    id: r.id,
    targetKind: r.targetKind,
    targetId: r.targetId,
    targetKey: r.targetKey,
    fieldId: r.fieldId,
    valueType: r.valueType,
    valueState: r.valueState,
    valueText: r.valueText,
    valueNumber: r.valueNumber === null ? null : r.valueNumber.toString(),
    valueBool: r.valueBool,
    valueDate: r.valueDate === null ? null : r.valueDate.toISOString().slice(0, 10),
    valueTs: r.valueTs,
    valueMoneyMinor: r.valueMoneyMinor === null ? null : r.valueMoneyMinor.toString(),
    valueCurrency: r.valueCurrency,
    valueEnum: r.valueEnum,
    valueItemCount: r.valueItemCount,
    valueJson: r.valueJson ?? null,
    valueRefKind: r.valueRefKind,
    valueRefId: r.valueRefId,
    valueRefKey: r.valueRefKey,
    origin: r.origin,
    fieldHash: r.fieldHash,
    releasedAt: r.releasedAt,
  };
}

export function toParsedItem(r: {
  itemType: string;
  itemText: string | null;
  itemNumber: { toString(): string } | null;
  itemDate: Date | null;
  itemEnum: string | null;
}): ParsedExtensionItem {
  return {
    type: r.itemType as ParsedExtensionItem['type'],
    ...(r.itemText !== null ? { text: r.itemText } : {}),
    ...(r.itemNumber !== null ? { number: r.itemNumber.toString() } : {}),
    ...(r.itemDate !== null ? { date: r.itemDate.toISOString().slice(0, 10) } : {}),
    ...(r.itemEnum !== null ? { enumCode: r.itemEnum } : {}),
  };
}

/** The typed columns of a parsed value (every value column set, NULL when not the type's). */
export function valueColumns(v: ParsedExtensionValue) {
  const p = v.state === 'present' ? v : undefined;
  return {
    valueState: v.state,
    valueText: p?.text ?? null,
    valueNumber: p?.number ?? null,
    valueBool: p?.bool ?? null,
    valueDate: p?.date ? new Date(`${p.date}T00:00:00.000Z`) : null,
    valueTs: p?.ts ?? null,
    valueMoneyMinor: p?.moneyMinor !== undefined ? BigInt(p.moneyMinor) : null,
    valueCurrency: p?.currency ?? null,
    valueEnum: p?.enumCode ?? null,
    valueItemCount: p?.items && p.items.length > 0 ? p.items.length : null,
    // SQL NULL (never a jsonb `null`): the typed CHECK counts value_json as set otherwise.
    valueJson:
      p?.json === undefined || p.json === null ? Prisma.DbNull : (p.json as Prisma.InputJsonValue),
    valueRefKind: p?.ref?.kind ?? null,
    valueRefId: p?.ref?.id ?? null,
    valueRefKey: p?.ref?.key ?? null,
  };
}

const ENTITY_TABLE: Readonly<Record<Exclude<ExtensionTargetKind, 'product'>, string>> = {
  company: 'companies',
  person: 'persons',
  subscription: 'tenant_subscriptions',
  person_affiliation: 'tenant_person_affiliations',
  custom_record: 'tenant_custom_records',
};

@Injectable()
export class ExtensionStore {
  // --- Gate (plan §10, Q18) -------------------------------------------------------

  /** Adopted ≥ 0.4 and module `extension` enabled (no audit; callers decide). */
  async gate(tx: TenantTransaction): Promise<ExtensionGateState> {
    const adopted = await adoptedCanonicalVersion(tx);
    if (compareCanonicalVersion(adopted, EXTENSION_MIN_VERSION) < 0) {
      return 'canonical_version_too_low';
    }
    const setting = await tenantClient(tx).tenantModuleSetting.findUnique({
      where: { tenantId_moduleKey: { tenantId: tx.tenantId, moduleKey: EXTENSION_MODULE_KEY } },
      select: { enabled: true },
    });
    return setting?.enabled ? 'ok' : 'module_disabled';
  }

  // --- Registry projection ----------------------------------------------------------

  async registry(tx: TenantTransaction): Promise<ExtensionRegistrySnapshot> {
    const cached = registryCache.get(tx);
    if (cached) return cached;
    const db = tenantClient(tx);
    const latest = await db.tenantRegistryVersion.findFirst({
      where: { tenantId: tx.tenantId, kind: 'extension' },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const rows = latest
      ? await db.tenantRegistryEntry.findMany({
          where: { tenantId: tx.tenantId, kind: 'extension' },
          select: {
            id: true,
            key: true,
            status: true,
            definition: true,
            sensitivity: true,
            categories: true,
          },
        })
      : [];
    const entries = rows.map((r): ExtensionEntry => ({
      id: r.id,
      key: r.key,
      status: r.status,
      definition: (r.definition ?? {}) as Record<string, unknown>,
      // The projection always carries classification for kind extension; NULL fails closed.
      sensitivity: (r.sensitivity ?? 'restricted') as Sensitivity,
      categories: r.categories as DataCategory[],
    }));
    const snapshot: ExtensionRegistrySnapshot = {
      version: latest?.version,
      byKey: new Map(entries.map((e) => [e.key, e])),
      byId: new Map(entries.map((e) => [e.id, e])),
    };
    registryCache.set(tx, snapshot);
    return snapshot;
  }

  // --- Entities (targets, references, parents, relationship ends) --------------------

  /**
   * The state of an entity-index row: `missing` when the tenant has no such
   * entity, else its record state (`merged` refused by writers, Q32), plus the
   * custom object of a custom record.
   */
  async entity(
    tx: TenantTransaction,
    target: ExtensionTarget,
  ): Promise<
    | { readonly exists: false }
    | {
        readonly exists: true;
        readonly state: string;
        readonly mergedInto: string | null;
        readonly objectId?: string;
      }
  > {
    const db = tenantClient(tx);
    const indexed = await db.tenantEntityIndex.findFirst({
      where:
        target.kind === 'product'
          ? { tenantId: tx.tenantId, kind: 'product', entityKey: target.id }
          : { tenantId: tx.tenantId, kind: target.kind, entityId: target.id },
      select: { id: true },
    });
    if (!indexed) return { exists: false };
    if (target.kind === 'product') return { exists: true, state: 'active', mergedInto: null };
    if (target.kind === 'custom_record') {
      const r = await db.tenantCustomRecord.findFirst({
        where: { tenantId: tx.tenantId, id: target.id },
        select: { recordState: true, mergedIntoId: true, objectId: true },
      });
      return r
        ? { exists: true, state: r.recordState, mergedInto: r.mergedIntoId, objectId: r.objectId }
        : { exists: false };
    }
    const table = ENTITY_TABLE[target.kind];
    const stateColumn = target.kind === 'person_affiliation' ? 'status' : 'record_state';
    const merged = target.kind === 'subscription' ? 'NULL::uuid' : 'merged_into_id';
    const rows = await db.$queryRawUnsafe<{ state: string; merged_into: string | null }[]>(
      `SELECT ${stateColumn} AS state, ${merged} AS merged_into FROM ${table} WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      tx.tenantId,
      target.id,
    );
    const row = rows[0];
    return row
      ? { exists: true, state: row.state, mergedInto: row.merged_into }
      : { exists: false };
  }

  /** Follows merge lineage (company, person, custom record); other kinds return themselves. */
  async resolveLineage(tx: TenantTransaction, target: ExtensionTarget): Promise<ExtensionTarget> {
    if (!['company', 'person', 'custom_record'].includes(target.kind)) return target;
    let current = target.id;
    for (let hops = 0; hops < 20; hops += 1) {
      const e = await this.entity(tx, { kind: target.kind, id: current });
      if (!e.exists || e.state !== 'merged' || !e.mergedInto)
        return { kind: target.kind, id: current };
      current = e.mergedInto;
    }
    throw new Error('merge lineage too deep');
  }

  /** The canonical company / person of a source reference (external refs), following merges. */
  async canonicalForRef(
    tx: TenantTransaction,
    kind: 'company' | 'person',
    ref: { system: string; objectType: string; id: string },
  ): Promise<string | undefined> {
    const db = tenantClient(tx);
    const where = {
      tenantId: tx.tenantId,
      system: ref.system,
      objectType: ref.objectType,
      externalId: ref.id,
    };
    const row =
      kind === 'company'
        ? await db.companyExternalRef.findFirst({ where, select: { companyId: true } })
        : await db.personExternalRef.findFirst({ where, select: { personId: true } });
    if (!row) return undefined;
    const id = 'companyId' in row ? row.companyId : row.personId;
    return (await this.resolveLineage(tx, { kind, id })).id;
  }

  /** The canonical subscription of a source line (source triple), if ingested. */
  async subscriptionForRef(
    tx: TenantTransaction,
    ref: { system: string; objectType: string; id: string },
  ): Promise<string | undefined> {
    const rows = await tenantClient(tx).$queryRaw<{ id: string }[]>`
      SELECT id FROM tenant_subscriptions
       WHERE tenant_id = ${tx.tenantId}::uuid AND source_system = ${ref.system}
         AND source_object_type = ${ref.objectType} AND source_record_id = ${ref.id}
       LIMIT 1`;
    return rows[0]?.id;
  }

  /** The custom record a generic source reference resolves to (kind `custom_record`). */
  async customRecordForRef(
    tx: TenantTransaction,
    ref: { system: string; objectType: string; id: string },
  ): Promise<string | undefined> {
    const row = await tenantClient(tx).tenantSourceReference.findUnique({
      where: {
        tenantId_system_objectType_externalId: {
          tenantId: tx.tenantId,
          system: ref.system,
          objectType: ref.objectType,
          externalId: ref.id,
        },
      },
      select: { entityKind: true, entityId: true },
    });
    if (!row || row.entityKind !== 'custom_record' || !row.entityId) return undefined;
    return (await this.resolveLineage(tx, { kind: 'custom_record', id: row.entityId })).id;
  }

  // --- Locks ------------------------------------------------------------------------

  lockTarget(tx: TenantTransaction, target: ExtensionTarget): Promise<void> {
    return tenantAdvisoryLock(tx, 'extension-target', `${target.kind}:${target.id}`);
  }

  /** The guard trigger's key: per (definition, from) — writer and trigger serialise (Q27). */
  lockRelationshipFrom(tx: TenantTransaction, defId: string, from: ExtensionTarget): Promise<void> {
    return tenantAdvisoryLock(tx, 'custom-relationship', `${defId}|from|${from.kind}:${from.id}`);
  }

  lockObject(tx: TenantTransaction, objectId: string): Promise<void> {
    return tenantAdvisoryLock(tx, 'custom-object', objectId);
  }

  // --- Values ---------------------------------------------------------------------

  async values(
    tx: TenantTransaction,
    target: ExtensionTarget,
    fieldIds?: readonly string[],
  ): Promise<StoredValueRow[]> {
    const rows = await tenantClient(tx).tenantExtensionValue.findMany({
      where: {
        tenantId: tx.tenantId,
        targetKind: target.kind,
        ...(target.kind === 'product' ? { targetKey: target.id } : { targetId: target.id }),
        ...(fieldIds ? { fieldId: { in: [...fieldIds] } } : {}),
      },
      select: VALUE_SELECT,
    });
    return rows.map(toStoredValue);
  }

  /** Batch load (plan §8, M10 §13): one query for values, one for items. */
  async valuesForTargets(
    tx: TenantTransaction,
    kind: ExtensionTargetKind,
    ids: readonly string[],
    fieldIds?: readonly string[],
  ): Promise<{ rows: StoredValueRow[]; items: Map<string, ParsedExtensionItem[]> }> {
    if (ids.length === 0) return { rows: [], items: new Map() };
    const db = tenantClient(tx);
    const rows = (
      await db.tenantExtensionValue.findMany({
        where: {
          tenantId: tx.tenantId,
          targetKind: kind,
          ...(kind === 'product'
            ? { targetKey: { in: [...ids] } }
            : { targetId: { in: [...ids] } }),
          ...(fieldIds ? { fieldId: { in: [...fieldIds] } } : {}),
        },
        select: VALUE_SELECT,
      })
    ).map(toStoredValue);
    const withItems = rows.filter((r) => r.valueItemCount !== null).map((r) => r.id);
    const items = await this.items(tx, withItems);
    return { rows, items };
  }

  async items(
    tx: TenantTransaction,
    valueIds: readonly string[],
  ): Promise<Map<string, ParsedExtensionItem[]>> {
    const out = new Map<string, ParsedExtensionItem[]>();
    if (valueIds.length === 0) return out;
    const rows = await tenantClient(tx).tenantExtensionValueItem.findMany({
      where: { tenantId: tx.tenantId, valueId: { in: [...valueIds] } },
      orderBy: [{ valueId: 'asc' }, { ordinal: 'asc' }],
    });
    for (const r of rows) {
      const list = out.get(r.valueId) ?? [];
      list.push(toParsedItem(r));
      out.set(r.valueId, list);
    }
    return out;
  }

  /** Inserts or updates one value row and replaces its items (Q26). Returns the row id. */
  async writeValue(
    tx: TenantTransaction,
    input: {
      readonly existingId?: string;
      readonly target: ExtensionTarget;
      readonly fieldId: string;
      readonly value: ParsedExtensionValue;
      readonly origin: 'source_provided' | 'human' | 'migration';
      readonly releasedAt: Date | null;
      readonly source?: {
        readonly connectionId: string;
        readonly objectType: string;
        readonly recordId: string;
      };
      readonly observedAt: Date | null;
      readonly sourceUpdatedAt: Date | null;
      readonly fieldHash: string;
      readonly registryVersion: number;
      readonly lastChangeId: string;
    },
  ): Promise<string> {
    const db = tenantClient(tx);
    const columns = valueColumns(input.value);
    const common = {
      ...columns,
      origin: input.origin,
      releasedAt: input.releasedAt,
      sourceConnectionId: input.source?.connectionId ?? null,
      sourceObjectType: input.source?.objectType ?? null,
      sourceRecordId: input.source?.recordId ?? null,
      observedAt: input.observedAt,
      sourceUpdatedAt: input.sourceUpdatedAt,
      fieldHash: input.fieldHash,
      registryVersion: input.registryVersion,
      lastChangeId: input.lastChangeId,
    };
    let id = input.existingId;
    if (id) {
      // Items first: the parity of value_item_count is checked by the integrity check.
      await db.tenantExtensionValueItem.deleteMany({
        where: { tenantId: tx.tenantId, valueId: id },
      });
      await db.tenantExtensionValue.update({
        where: { tenantId_id: { tenantId: tx.tenantId, id } },
        data: common,
      });
    } else {
      id = randomUUID();
      await db.tenantExtensionValue.create({
        data: {
          tenantId: tx.tenantId,
          id,
          targetKind: input.target.kind,
          ...(input.target.kind === 'product'
            ? { targetKey: input.target.id }
            : { targetId: input.target.id }),
          fieldId: input.fieldId,
          valueType: input.value.type,
          ...common,
        },
      });
    }
    const items = input.value.state === 'present' ? (input.value.items ?? []) : [];
    if (items.length > 0) {
      await db.tenantExtensionValueItem.createMany({
        data: items.map((it, ordinal) => ({
          tenantId: tx.tenantId,
          valueId: id,
          ordinal,
          itemType: it.type,
          itemText: it.text ?? null,
          itemNumber: it.number ?? null,
          itemDate: it.date ? new Date(`${it.date}T00:00:00.000Z`) : null,
          itemEnum: it.enumCode ?? null,
        })),
      });
    }
    return id;
  }

  /** The source triple of a value row (carried to a merge survivor's copy). */
  async valueSource(
    tx: TenantTransaction,
    id: string,
  ): Promise<{ connectionId: string; objectType: string; recordId: string } | undefined> {
    const r = await tenantClient(tx).tenantExtensionValue.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: { sourceConnectionId: true, sourceObjectType: true, sourceRecordId: true },
    });
    return r?.sourceConnectionId && r.sourceObjectType && r.sourceRecordId
      ? {
          connectionId: r.sourceConnectionId,
          objectType: r.sourceObjectType,
          recordId: r.sourceRecordId,
        }
      : undefined;
  }

  async releaseValue(tx: TenantTransaction, id: string, at: Date): Promise<void> {
    await tenantClient(tx).tenantExtensionValue.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: { releasedAt: at },
    });
  }

  /** Bounded existence probe: does any stored value / item / record / edge reference a registry entry? */
  async definitionInUse(tx: TenantTransaction, entryId: string): Promise<boolean> {
    const db = tenantClient(tx);
    const [v, r, e] = await Promise.all([
      db.tenantExtensionValue.findFirst({
        where: { tenantId: tx.tenantId, fieldId: entryId },
        select: { id: true },
      }),
      db.tenantCustomRecord.findFirst({
        where: { tenantId: tx.tenantId, objectId: entryId },
        select: { id: true },
      }),
      db.tenantCustomRelationship.findFirst({
        where: { tenantId: tx.tenantId, relDefId: entryId },
        select: { id: true },
      }),
    ]);
    return !!(v || r || e);
  }

  // --- Custom records ---------------------------------------------------------------

  async record(tx: TenantTransaction, id: string): Promise<CustomRecordRow | undefined> {
    const r = await tenantClient(tx).tenantCustomRecord.findFirst({
      where: { tenantId: tx.tenantId, id },
    });
    return r ?? undefined;
  }

  async recordByNaturalKey(
    tx: TenantTransaction,
    objectId: string,
    naturalKeyHash: string,
  ): Promise<CustomRecordRow | undefined> {
    const r = await tenantClient(tx).tenantCustomRecord.findFirst({
      where: { tenantId: tx.tenantId, objectId, naturalKeyHash },
    });
    return r ?? undefined;
  }

  async countRecords(tx: TenantTransaction, objectId: string): Promise<number> {
    return tenantClient(tx).tenantCustomRecord.count({
      where: { tenantId: tx.tenantId, objectId },
    });
  }

  async insertRecord(
    tx: TenantTransaction,
    row: {
      readonly objectId: string;
      readonly parent?: ExtensionTarget;
      readonly naturalKeyHash: string | null;
      readonly recordState: 'active' | 'inactive' | 'retired';
      readonly origin: 'source_provided' | 'human' | 'migration';
    },
  ): Promise<string> {
    const id = randomUUID();
    await tenantClient(tx).tenantCustomRecord.create({
      data: {
        tenantId: tx.tenantId,
        id,
        objectId: row.objectId,
        parentKind: row.parent?.kind ?? null,
        ...(row.parent
          ? row.parent.kind === 'product'
            ? { parentKey: row.parent.id }
            : { parentId: row.parent.id }
          : {}),
        naturalKeyHash: row.naturalKeyHash,
        recordState: row.recordState,
        origin: row.origin,
      },
    });
    return id;
  }

  async updateRecord(
    tx: TenantTransaction,
    id: string,
    data: {
      readonly recordState?: string;
      readonly mergedIntoId?: string | null;
      readonly parent?: ExtensionTarget | null;
      readonly naturalKeyHash?: string | null;
      readonly lastChangeId?: string;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantCustomRecord.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: {
        ...(data.recordState !== undefined ? { recordState: data.recordState } : {}),
        ...(data.mergedIntoId !== undefined ? { mergedIntoId: data.mergedIntoId } : {}),
        ...(data.naturalKeyHash !== undefined ? { naturalKeyHash: data.naturalKeyHash } : {}),
        ...(data.parent !== undefined
          ? {
              parentKind: data.parent?.kind ?? null,
              parentId: data.parent && data.parent.kind !== 'product' ? data.parent.id : null,
              parentKey: data.parent && data.parent.kind === 'product' ? data.parent.id : null,
            }
          : {}),
        ...(data.lastChangeId ? { lastChangeId: data.lastChangeId } : {}),
      },
    });
  }

  async recordsWithParent(
    tx: TenantTransaction,
    parent: ExtensionTarget,
  ): Promise<CustomRecordRow[]> {
    return tenantClient(tx).tenantCustomRecord.findMany({
      where: {
        tenantId: tx.tenantId,
        parentKind: parent.kind,
        ...(parent.kind === 'product' ? { parentKey: parent.id } : { parentId: parent.id }),
      },
    });
  }

  /** Keyset page of an object's records (plan §8). */
  async recordsPage(
    tx: TenantTransaction,
    objectId: string,
    after: string | undefined,
    limit: number,
  ): Promise<CustomRecordRow[]> {
    return tenantClient(tx).tenantCustomRecord.findMany({
      where: { tenantId: tx.tenantId, objectId, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' },
      take: limit,
    });
  }

  // --- Custom relationships ---------------------------------------------------------

  async relationship(tx: TenantTransaction, id: string): Promise<RelationshipRow | undefined> {
    const r = await tenantClient(tx).tenantCustomRelationship.findFirst({
      where: { tenantId: tx.tenantId, id },
    });
    return r ?? undefined;
  }

  async activeEdgesFrom(
    tx: TenantTransaction,
    defId: string,
    from: ExtensionTarget,
  ): Promise<RelationshipRow[]> {
    return tenantClient(tx).tenantCustomRelationship.findMany({
      where: {
        tenantId: tx.tenantId,
        relDefId: defId,
        state: 'active',
        fromKind: from.kind,
        ...(from.kind === 'product' ? { fromKey: from.id } : { fromId: from.id }),
      },
    });
  }

  async activeEdgesTo(
    tx: TenantTransaction,
    defId: string,
    to: ExtensionTarget,
  ): Promise<RelationshipRow[]> {
    return tenantClient(tx).tenantCustomRelationship.findMany({
      where: {
        tenantId: tx.tenantId,
        relDefId: defId,
        state: 'active',
        toKind: to.kind,
        ...(to.kind === 'product' ? { toKey: to.id } : { toId: to.id }),
      },
    });
  }

  async edgesOf(tx: TenantTransaction, end: ExtensionTarget): Promise<RelationshipRow[]> {
    const id = end.kind === 'product' ? { key: end.id } : { id: end.id };
    return tenantClient(tx).tenantCustomRelationship.findMany({
      where: {
        tenantId: tx.tenantId,
        OR: [
          { fromKind: end.kind, ...('key' in id ? { fromKey: id.key } : { fromId: id.id }) },
          { toKind: end.kind, ...('key' in id ? { toKey: id.key } : { toId: id.id }) },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async insertEdge(
    tx: TenantTransaction,
    row: {
      readonly id?: string;
      readonly defId: string;
      readonly from: ExtensionTarget;
      readonly to: ExtensionTarget;
      readonly roleCode: string | null;
      readonly origin: 'source_provided' | 'human' | 'migration';
      readonly source?: { connectionId: string; objectType: string; recordId: string };
      readonly lastChangeId: string;
    },
  ): Promise<string> {
    const id = row.id ?? randomUUID();
    const end = (prefix: 'from' | 'to', t: ExtensionTarget) => ({
      [`${prefix}Kind`]: t.kind,
      ...(t.kind === 'product' ? { [`${prefix}Key`]: t.id } : { [`${prefix}Id`]: t.id }),
    });
    await tenantClient(tx).tenantCustomRelationship.create({
      data: {
        tenantId: tx.tenantId,
        id,
        relDefId: row.defId,
        ...(end('from', row.from) as { fromKind: string }),
        ...(end('to', row.to) as { toKind: string }),
        roleCode: row.roleCode,
        state: 'active',
        origin: row.origin,
        sourceConnectionId: row.source?.connectionId ?? null,
        sourceObjectType: row.source?.objectType ?? null,
        sourceRecordId: row.source?.recordId ?? null,
        lastChangeId: row.lastChangeId,
      },
    });
    return id;
  }

  async endEdge(
    tx: TenantTransaction,
    id: string,
    reason: 'source_removed' | 'operator' | 'endpoint_merged',
    at: Date,
    lastChangeId: string,
  ): Promise<void> {
    await tenantClient(tx).tenantCustomRelationship.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: { state: 'ended', endedAt: at, endReason: reason, lastChangeId },
    });
  }

  // --- Change records (existing change types only, Q24) -------------------------------

  insertChange(tx: TenantTransaction, change: ChangeWrite): Promise<string> {
    return insertContextChange(tx, change);
  }

  async setValueChange(
    tx: TenantTransaction,
    valueIds: readonly string[],
    changeId: string,
  ): Promise<void> {
    if (valueIds.length === 0) return;
    await tenantClient(tx).tenantExtensionValue.updateMany({
      where: { tenantId: tx.tenantId, id: { in: [...valueIds] } },
      data: { lastChangeId: changeId },
    });
  }

  // --- Data-quality issues (tenant_identity_conflicts, interim until M10L) ------------

  static issueKey(kind: string, identity: string): string {
    return createHash('sha256').update(`${kind}|${identity}`).digest('hex');
  }

  async recordIssue(tx: TenantTransaction, issue: ExtensionIssueWrite): Promise<void> {
    const conflictKey = ExtensionStore.issueKey(issue.kind, issue.identity);
    const canonicalIds = [...new Set(issue.canonicalIds)].sort();
    const externalRefs = [...new Set(issue.externalRefs)].sort();
    await tenantClient(tx).tenantIdentityConflict.upsert({
      where: { tenantId_conflictKey: { tenantId: tx.tenantId, conflictKey } },
      create: {
        tenantId: tx.tenantId,
        id: randomUUID(),
        kind: issue.kind,
        entityKind: issue.entityKind,
        conflictKey,
        canonicalIds,
        externalRefs,
      },
      update: {
        canonicalIds,
        externalRefs,
        state: 'open',
        resolvedAt: null,
        updatedAt: new Date(),
      },
    });
  }

  async resolveIssue(
    tx: TenantTransaction,
    kind: IdentityConflictKind,
    identity: string,
  ): Promise<void> {
    const now = new Date();
    await tenantClient(tx).tenantIdentityConflict.updateMany({
      where: {
        tenantId: tx.tenantId,
        conflictKey: ExtensionStore.issueKey(kind, identity),
        state: 'open',
      },
      data: { state: 'resolved', resolvedAt: now, updatedAt: now },
    });
  }
}

/** An extension field key as an issue reference (`system:objectType:id` format of the CHECK). */
export function fieldRef(key: string): string {
  return `extension:field:${key}`;
}

/** The entity-index kind a definition's target lands on, and its custom object key. */
export function definitionTarget(definition: Readonly<Record<string, unknown>>): {
  readonly kind: ExtensionTargetKind | undefined;
  readonly objectKey?: string;
} {
  const target = typeof definition.target === 'string' ? definition.target : '';
  const kind = extensionTargetKind(target);
  return target.startsWith('custom_object:')
    ? { kind, objectKey: target.slice('custom_object:'.length) }
    : { kind };
}

export type { ExtensionReference };
