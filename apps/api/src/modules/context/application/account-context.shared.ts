import { ACCOUNT_CONTEXT_MIN_VERSION, ACCOUNT_CONTEXT_MODULE_KEY } from '../../domain';
import { GovernanceError, type ModuleGate } from '../../governance';
import type { AuthorizedContext, TenantTransaction } from '../../tenancy';
import type { AccountContextStore } from '../infrastructure/account-context.store';
import type { StructureProvenance } from './account-structure.shared';

/**
 * Shared pieces of the M10E AccountContext writers (plan §4, §10): the
 * 0.5 + module gate (Q17) and the provenance of a write.
 */

/** The provenance a writer records (the triggering observation, merge or operator) plus the writing connection. */
export type ContextProvenance = StructureProvenance & {
  readonly connectionId?: string | null;
};

/**
 * Operator commands: adopted ≥ 0.5 (`canonical_version_too_low`, audited by
 * the caller's @AuditFailures) and module `account_context` enabled
 * (`ModuleGate.require`: audited denial + security event).
 */
export async function requireAccountContext(
  tx: TenantTransaction,
  actx: AuthorizedContext,
  store: AccountContextStore,
  gate: ModuleGate,
): Promise<void> {
  const state = await store.gate(tx);
  if (state === 'canonical_version_too_low') {
    throw new GovernanceError(
      'canonical_version_too_low',
      `Account contexts need canonical ${ACCOUNT_CONTEXT_MIN_VERSION}`,
    );
  }
  if (state === 'module_disabled') await gate.require(tx, actx, ACCOUNT_CONTEXT_MODULE_KEY);
}

/** Drops the connection id (not a change-record column) from a provenance. */
export function changeProvenance(p: ContextProvenance): StructureProvenance {
  const { connectionId: _c, ...rest } = p;
  return rest;
}

export const RENEWAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function renewalDateValid(v: string): boolean {
  if (!RENEWAL_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Issue identities (identifiers only). */
export const overrideIssue = (tenantId: string, contextId: string) =>
  `${tenantId}|account-context-override|${contextId}`;
export const mismatchIssue = (tenantId: string, lineId: string) =>
  `${tenantId}|account-context-line|${lineId}`;
export const collisionIssue = (tenantId: string, loserContextId: string) =>
  `${tenantId}|account-context-merge|${loserContextId}`;
