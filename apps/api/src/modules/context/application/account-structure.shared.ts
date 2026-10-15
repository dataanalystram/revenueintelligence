import {
  ACCOUNT_STRUCTURE_MIN_VERSION,
  compareCanonicalVersion,
  type SecurityActor,
} from '../../domain';
import { GovernanceError } from '../../governance';
import { adoptedCanonicalVersion, type TenantTransaction } from '../../tenancy';
import type { ChangeWrite } from '../infrastructure/context-changes';

/**
 * Shared pieces of the M10C account-structure writers (plan §2, §3): the 0.3
 * gate, the provenance of a write and the operator-entry coordinates.
 */

/** The provenance a writer records on every change (the triggering observation, merge or operator). */
export type StructureProvenance = Omit<
  ChangeWrite,
  'entityKind' | 'entityId' | 'changeType' | 'changedFields'
>;

/** True when the tenant adopted canonical ≥ 0.3 (hierarchy and affiliation writes allowed). */
export async function accountStructureEnabled(tx: TenantTransaction): Promise<boolean> {
  return (
    compareCanonicalVersion(await adoptedCanonicalVersion(tx), ACCOUNT_STRUCTURE_MIN_VERSION) >= 0
  );
}

/** Fails closed below 0.3 (`canonical_version_too_low`, audited by the caller's @AuditFailures). */
export async function requireAccountStructure(tx: TenantTransaction): Promise<void> {
  const adopted = await adoptedCanonicalVersion(tx);
  if (compareCanonicalVersion(adopted, ACCOUNT_STRUCTURE_MIN_VERSION) < 0) {
    throw new GovernanceError(
      'canonical_version_too_low',
      `Account hierarchy and affiliations need canonical ${ACCOUNT_STRUCTURE_MIN_VERSION} (adopted ${adopted})`,
    );
  }
}

/** Operator entry has no source record: the `import` connector kind and the target's id. */
export const OPERATOR_ENTRY_OBJECT_TYPE = 'operator_entry';

export function operatorProvenance(
  actor: SecurityActor,
  correlationId: string,
  targetId: string,
): StructureProvenance {
  return {
    source: {
      system: 'import',
      objectType: OPERATOR_ENTRY_OBJECT_TYPE,
      id: targetId,
    },
    cause: 'human',
    adapter: 'operator',
    adapterVersion: '1',
    correlationId,
    actor,
    origin: 'human',
  };
}

/** Operator reason: a reason code (identifiers only; audit details hold no free text). */
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

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: string | undefined, what: string): string {
  if (!value || !UUID.test(value)) {
    throw new GovernanceError('validation_failed', `${what} must be a canonical id (uuid)`);
  }
  return value.toLowerCase();
}
