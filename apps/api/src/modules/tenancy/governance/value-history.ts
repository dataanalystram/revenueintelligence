import { randomUUID } from 'node:crypto';
import {
  decideValueHistory,
  isExtensionHistoryField,
  isSensitiveForHistory,
  type ColumnClassification,
  type DataCategory,
  type ExtensionTargetKind,
  type Sensitivity,
  jsonbTextBytes,
  policyAllowsValues,
  valueHistoryColumn,
  VALUE_HISTORY_MAX_BYTES,
  type SecurityActor,
} from '../../domain';
import { tenantClient, type TenantTransaction } from '../infrastructure/tenant-database';
import { CLASSIFICATION_MANIFEST } from '../security/classification-manifest';
import { publishedDataPolicy } from './data-policy';

/** One field change of a catalogued entity (ids and values; never logged). */
export interface ValueChange {
  readonly field: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

/** Recorded when the writer has no actor (pre-M10A1 call paths); never invented as a person. */
const UNATTRIBUTED: SecurityActor = Object.freeze({
  kind: 'system',
  id: 'system:unattributed',
  assurance: 'system',
});

function jsonValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/**
 * Value history (M10A2 plan §8). Called by the single writer inside the
 * transaction of the projection update and its change record, so the three
 * commit or roll back together. Per field: not catalogued → nothing;
 * sensitive (restricted, `tbc`, personal, communication or security) and not
 * allowed by the published data policy → a value-free row; otherwise the old
 * and new values. Returns the number of rows written.
 */
export async function recordValueHistory(
  tx: TenantTransaction,
  input: {
    readonly entityKind: 'company' | 'subscription' | 'person_affiliation';
    readonly entityId: string;
    readonly changeId: string;
    readonly effectiveAt: Date;
    readonly actor?: SecurityActor;
    readonly changes: readonly ValueChange[];
  },
): Promise<number> {
  const relevant = input.changes.filter((c) => valueHistoryColumn(input.entityKind, c.field));
  if (relevant.length === 0) return 0;
  const policy = await publishedDataPolicy(tx);
  const actor = input.actor ?? UNATTRIBUTED;
  const rows = [];
  for (const change of relevant) {
    const column = valueHistoryColumn(input.entityKind, change.field)!;
    const decision = decideValueHistory({
      entityKind: input.entityKind,
      field: change.field,
      classification: CLASSIFICATION_MANIFEST[column.table]?.[column.column],
      policyAllows: policyAllowsValues(policy?.document, input.entityKind, change.field),
      policyVersion: policy?.version ?? null,
    });
    if (!decision.record) continue;
    let oldValue: unknown = null;
    let newValue: unknown = null;
    if (decision.valuesRecorded) {
      oldValue = jsonValue(change.oldValue);
      newValue = jsonValue(change.newValue);
      for (const v of [oldValue, newValue]) {
        if (jsonbTextBytes(v) > VALUE_HISTORY_MAX_BYTES) {
          throw new Error(`value history: ${input.entityKind}.${change.field} exceeds 4 KB`);
        }
      }
    }
    rows.push({
      tenantId: tx.tenantId,
      id: randomUUID(),
      entityKind: input.entityKind,
      entityId: input.entityId,
      field: change.field,
      valuesRecorded: decision.valuesRecorded,
      oldValue: oldValue === null ? undefined : (oldValue as object),
      newValue: newValue === null ? undefined : (newValue as object),
      effectiveAt: input.effectiveAt,
      changeId: input.changeId,
      retentionClass: decision.retentionClass,
      policyVersion: decision.valuesRecorded ? decision.policyVersion : null,
      actorKind: actor.kind,
      actorId: actor.id,
      actorAssurance: actor.assurance,
    });
  }
  if (rows.length) await tenantClient(tx).tenantValueHistory.createMany({ data: rows });
  return rows.length;
}

/**
 * M10D (plan §9, Q23): value history of an extension field declaring
 * `history: value_history`. The field token is `ext:<key>`; classification
 * comes from the registry definition (never the static manifest). The
 * restricted-history rule applies unchanged: sensitive (restricted, personal,
 * communication or security) and not allowed by the published data policy →
 * a value-free row. Products are key-identified (`entity_key`). Returns 1 when
 * a row was written.
 */
export async function recordExtensionValueHistory(
  tx: TenantTransaction,
  input: {
    readonly entityKind: ExtensionTargetKind;
    /** Canonical id, or the product key for `product`. */
    readonly entity: string;
    readonly fieldKey: string;
    /** The registry definition's classification (Q34). */
    readonly classification: {
      readonly sensitivity: Sensitivity;
      readonly categories: readonly DataCategory[];
    };
    readonly changeId: string;
    readonly effectiveAt: Date;
    readonly actor?: SecurityActor;
    readonly oldValue: unknown;
    readonly newValue: unknown;
  },
): Promise<number> {
  const field = `ext:${input.fieldKey}`;
  if (!isExtensionHistoryField(input.entityKind, field)) return 0;
  const policy = await publishedDataPolicy(tx);
  const sensitive = isSensitiveForHistory(input.classification as ColumnClassification);
  const allowed =
    sensitive &&
    policy !== undefined &&
    policyAllowsValues(policy.document, input.entityKind, field);
  let recorded = !sensitive || allowed;
  const actor = input.actor ?? UNATTRIBUTED;
  const oldValue = recorded ? jsonValue(input.oldValue) : null;
  const newValue = recorded ? jsonValue(input.newValue) : null;
  // An oversized value is recorded value-free rather than refused (the value itself was valid).
  if (recorded && [oldValue, newValue].some((v) => jsonbTextBytes(v) > VALUE_HISTORY_MAX_BYTES)) {
    recorded = false;
  }
  await tenantClient(tx).tenantValueHistory.create({
    data: {
      tenantId: tx.tenantId,
      id: randomUUID(),
      entityKind: input.entityKind,
      ...(input.entityKind === 'product'
        ? { entityKey: input.entity }
        : { entityId: input.entity }),
      field,
      valuesRecorded: recorded,
      oldValue: recorded && oldValue !== null ? (oldValue as object) : undefined,
      newValue: recorded && newValue !== null ? (newValue as object) : undefined,
      effectiveAt: input.effectiveAt,
      changeId: input.changeId,
      retentionClass: recorded && sensitive ? 'sensitive_value_history' : 'canonical_lifecycle',
      policyVersion: recorded && sensitive ? (policy?.version ?? null) : null,
      actorKind: actor.kind,
      actorId: actor.id,
      actorAssurance: actor.assurance,
    },
  });
  return 1;
}
