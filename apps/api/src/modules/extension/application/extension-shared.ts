import {
  EXTENSION_MIN_VERSION,
  EXTENSION_MODULE_KEY,
  EXTENSION_TARGET_KINDS,
  extensionTargetKind,
  type ExtensionTargetKind,
  type SecurityActor,
} from '../../domain';
import { GovernanceError, type ModuleGate } from '../../governance';
import type { AuthorizedContext, ChangeWrite, TenantTransaction } from '../../tenancy';
import type { ExtensionStore, ExtensionTarget } from '../infrastructure/extension.store';

/**
 * Shared pieces of the M10D extension writers: the 0.4 + module gate (Q18),
 * provenance, operator coordinates and target parsing.
 */

/** The provenance a writer records on every change (the triggering observation, merge or operator). */
export type ExtensionProvenance = Omit<
  ChangeWrite,
  'entityKind' | 'entityId' | 'changeType' | 'changedFields'
> & {
  /** The writing connection (`tenant_source_connections.id`) for source writes (Q14). */
  readonly connectionId?: string | null;
};

/**
 * Operator commands: adopted ≥ 0.4 (`canonical_version_too_low`) and module
 * `extension` enabled (`ModuleGate.require`, audited, security event).
 */
export async function requireExtension(
  tx: TenantTransaction,
  actx: AuthorizedContext,
  store: ExtensionStore,
  gate: ModuleGate,
): Promise<void> {
  const state = await store.gate(tx);
  if (state === 'canonical_version_too_low') {
    throw new GovernanceError(
      'canonical_version_too_low',
      `Extension data needs canonical ${EXTENSION_MIN_VERSION}`,
    );
  }
  if (state === 'module_disabled') await gate.require(tx, actx, EXTENSION_MODULE_KEY);
}

/** Operator entry has no source record: the `import` connector kind (M10C pattern). */
export const OPERATOR_ENTRY_OBJECT_TYPE = 'operator_entry';

export function operatorProvenance(
  actor: SecurityActor,
  correlationId: string,
  targetRef: string,
): ExtensionProvenance {
  return {
    source: {
      system: 'import',
      objectType: OPERATOR_ENTRY_OBJECT_TYPE,
      id: targetRef,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_KEY = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

export function requireUuid(value: string | undefined, what: string): string {
  if (!value || !UUID.test(value)) {
    throw new GovernanceError('validation_failed', `${what} must be a canonical id (uuid)`);
  }
  return value.toLowerCase();
}

/**
 * `<kind>:<id>` → an extension target. `kind` is an entity-index kind
 * (`company`, `person`, `subscription`, `product`, `person_affiliation`,
 * `custom_record`) or a definition target (`account`); products by key.
 */
export function parseTarget(raw: string | undefined, what = '--target'): ExtensionTarget {
  const i = raw?.indexOf(':') ?? -1;
  if (!raw || i <= 0) {
    throw new GovernanceError('validation_failed', `${what} must be <kind>:<id>`);
  }
  const k = raw.slice(0, i);
  const kind = (extensionTargetKind(k) ?? k) as ExtensionTargetKind;
  if (!(EXTENSION_TARGET_KINDS as readonly string[]).includes(kind)) {
    throw new GovernanceError('validation_failed', `${what}: ${k} is not an extension target kind`);
  }
  const id = raw.slice(i + 1);
  if (kind === 'product') {
    if (!PRODUCT_KEY.test(id))
      throw new GovernanceError('validation_failed', `${what}: invalid product key`);
    return { kind, id };
  }
  return { kind, id: requireUuid(id, what) };
}

export function targetRef(t: ExtensionTarget): string {
  return `${t.kind}:${t.id}`;
}
