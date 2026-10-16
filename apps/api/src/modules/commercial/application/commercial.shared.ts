import {
  ACCOUNT_CONTEXT_MODULE_KEY,
  COMMERCIAL_MIN_VERSION,
  COMMERCIAL_MODULE_KEY,
  type CommercialEntityKind,
  type SecurityActor,
} from '../../domain';
import { GovernanceError, ModuleDisabledError, type ModuleGate } from '../../governance';
import type { AuthorizedContext, ChangeWrite, TenantTransaction } from '../../tenancy';
import type { CommercialStore, SourceRef } from '../infrastructure/commercial.store';
import type { AttributeDecision, Plain } from './commercial.rules';

/**
 * Shared pieces of the M10F commercial writers (plan §5; ADR 0032): the
 * 0.6 + module gate (Q2), provenance, operator coordinates and the
 * apply-a-decision step (one change record + value history).
 */

/** The provenance a writer records (the triggering observation, merge or operator) plus the writing connection. */
export type CommercialProvenance = Omit<
  ChangeWrite,
  'entityKind' | 'entityId' | 'changeType' | 'changedFields'
> & { readonly connectionId?: string | null };

export function changeProvenance(
  p: CommercialProvenance,
): Omit<ChangeWrite, 'entityKind' | 'entityId' | 'changeType' | 'changedFields'> {
  const { connectionId: _c, ...rest } = p;
  return rest;
}

/** Operator entry has no source record: the `import` connector kind and the target's id (M10C pattern). */
export function operatorProvenance(
  actor: SecurityActor,
  correlationId: string,
  targetId: string,
): CommercialProvenance {
  return {
    source: { system: 'import', objectType: 'operator_entry', id: targetId },
    cause: 'human',
    adapter: 'operator',
    adapterVersion: '1',
    correlationId,
    actor,
    origin: 'human',
  };
}

export const OPERATOR_REASON = /^[a-z][a-z0-9_]{1,63}$/;

export function requireReason(reason: string | undefined): string {
  if (!reason || !OPERATOR_REASON.test(reason)) {
    throw new GovernanceError(
      'validation_failed',
      'A reason code is required (lowercase letters, digits and _; 2–64 characters)',
    );
  }
  return reason;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: string | undefined, what: string): string {
  if (!value || !UUID.test(value)) {
    throw new GovernanceError('validation_failed', `${what} must be a canonical id (uuid)`);
  }
  return value.toLowerCase();
}

/**
 * Operator commands (Q2): adopted ≥ 0.6 (`canonical_version_too_low`, audited
 * by the caller's @AuditFailures) and module `commercial` enabled
 * (`ModuleGate.require`: audited denial + security event).
 */
export async function requireCommercial(
  tx: TenantTransaction,
  actx: AuthorizedContext,
  store: CommercialStore,
  gate: ModuleGate,
): Promise<void> {
  const state = await store.gate(tx);
  if (state === 'canonical_version_too_low') {
    throw new GovernanceError(
      'canonical_version_too_low',
      `Commercial data needs canonical ${COMMERCIAL_MIN_VERSION}`,
    );
  }
  // MUTATION VM9: refusal audit skipped
  void gate;
  if (state === 'module_disabled') throw new ModuleDisabledError(COMMERCIAL_MODULE_KEY);
}

/** Q13: a contract's `context_id` additionally needs module `account_context` (audited denial). */
export function requireAccountContextModule(
  tx: TenantTransaction,
  actx: AuthorizedContext,
  gate: ModuleGate,
): Promise<void> {
  return gate.require(tx, actx, ACCOUNT_CONTEXT_MODULE_KEY);
}

export const refString = (r: SourceRef) => `${r.system}:${r.objectType}:${r.id}`;

/** Issue identities (identifiers only). */
export const overrideIssue = (tenantId: string, kind: string, id: string) =>
  `${tenantId}|commercial-override|${kind}|${id}`;
export const unresolvedIssue = (tenantId: string, what: string, id: string) =>
  `${tenantId}|commercial-unresolved|${what}|${id}`;
export const linkIssue = (tenantId: string, contractId: string, kind: string) =>
  `${tenantId}|commercial-link|${contractId}|${kind}`;
export const lineMismatchIssue = (tenantId: string, what: string, lineId: string) =>
  `${tenantId}|commercial-line|${what}|${lineId}`;

/**
 * Applies an attribute decision of one commercial entity: one change record
 * (type from `changeType`), the row update with `last_change_id`, and value
 * history on the catalogued fields (`history` maps attribute → field; the
 * manifest's `value_free` declaration decides whether values are kept, Q18).
 * Returns whether anything changed.
 */
export async function applyDecision<A extends string>(
  tx: TenantTransaction,
  store: CommercialStore,
  input: {
    readonly entityKind: CommercialEntityKind;
    readonly entityId: string;
    readonly before: Readonly<Record<A, Plain>>;
    readonly decision: AttributeDecision<A>;
    readonly provenance: CommercialProvenance;
    readonly effectiveAt: Date;
    readonly history: Partial<Record<A, string>>;
    readonly changeType: (fields: readonly A[]) => ChangeWrite['changeType'];
    readonly update: (
      apply: Partial<Record<A, Plain>> & { readonly lastChangeId: string },
    ) => Promise<void>;
  },
): Promise<boolean> {
  const fields = input.decision.changedFields;
  if (fields.length === 0) return false;
  const changeId = await store.insertChange(tx, {
    ...changeProvenance(input.provenance),
    entityKind: input.entityKind,
    entityId: input.entityId,
    changeType: input.changeType(fields),
    changedFields: [...fields],
  });
  await input.update({ ...input.decision.apply, lastChangeId: changeId });
  await store.valueHistory(tx, {
    entityKind: input.entityKind,
    entityId: input.entityId,
    changeId,
    effectiveAt: input.effectiveAt,
    ...(input.provenance.actor ? { actor: input.provenance.actor } : {}),
    changes: fields.flatMap((f) =>
      input.history[f]
        ? [
            {
              field: input.history[f],
              oldValue: input.before[f],
              newValue: input.decision.apply[f],
            },
          ]
        : [],
    ),
  });
  return true;
}

/** Records a held-attribute disagreement (Q17) or resolves the open one. */
export async function recordOverride(
  tx: TenantTransaction,
  store: CommercialStore,
  entityKind: CommercialEntityKind | 'subscription',
  id: string,
  disagreements: number,
  ref?: SourceRef,
): Promise<void> {
  const identity = overrideIssue(tx.tenantId, entityKind, id);
  if (disagreements > 0) {
    await store.recordIssue(tx, {
      kind: 'commercial_human_override_disagrees',
      entityKind,
      identity,
      canonicalIds: [id],
      externalRefs: ref ? [refString(ref)] : [],
    });
  } else {
    await store.resolveIssue(tx, 'commercial_human_override_disagrees', identity);
  }
}

/** The created change record + creation value history of a new commercial entity. */
export async function recordCreated(
  tx: TenantTransaction,
  store: CommercialStore,
  input: {
    readonly entityKind: CommercialEntityKind;
    readonly entityId: string;
    readonly fields: readonly string[];
    readonly provenance: CommercialProvenance;
    readonly effectiveAt: Date;
    readonly history: readonly { readonly field: string; readonly value: unknown }[];
  },
): Promise<string> {
  const changeId = await store.insertChange(tx, {
    ...changeProvenance(input.provenance),
    entityKind: input.entityKind,
    entityId: input.entityId,
    changeType: 'created',
    changedFields: [...input.fields],
  });
  await store.valueHistory(tx, {
    entityKind: input.entityKind,
    entityId: input.entityId,
    changeId,
    effectiveAt: input.effectiveAt,
    ...(input.provenance.actor ? { actor: input.provenance.actor } : {}),
    changes: input.history
      .filter((h) => h.value !== null && h.value !== undefined)
      .map((h) => ({ field: h.field, oldValue: null, newValue: h.value })),
  });
  return changeId;
}

/** Source reference meta from a provenance (M10E pattern). */
export function referenceMeta(p: CommercialProvenance) {
  return {
    cause: p.cause as never,
    adapter: p.adapter,
    adapterVersion: p.adapterVersion,
    connectionId: p.connectionId ?? null,
    mappingVersion: p.mappingVersion ?? null,
    ...(p.checkpointId ? { checkpointId: p.checkpointId } : {}),
  };
}

/** Non-null fields of a created row (change-record `changedFields`). */
export function presentFields<A extends string>(a: Readonly<Record<A, Plain>>): A[] {
  return (Object.keys(a) as A[]).filter((k) => a[k] !== null);
}
