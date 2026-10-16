import type { ActorKind } from './actor';

/**
 * Closed permission catalogue (M10A1 plan §4). A write is allowed only when the
 * policy grants the capability to the actor's kind; everything else is denied.
 */
export const CAPABILITIES = [
  'canonical.source_sync',
  'canonical.import',
  'processing.receipt',
  'processing.dead_letter.resolve',
  'config.tenant.provision',
  'config.tenant.status',
  'config.integration',
  'config.oauth.install',
  'config.oauth.grant',
  'config.policy',
  'config.product_model.publish',
  'config.source.connection',
  'config.source.schema',
  'config.mapping.publish',
  'config.authority.publish',
  'data.sync.run',
  'data.profile.run',
  'data.eligibility.record',
  'data.purge',
  'security.key.rotate',
  'security.audit.read',
  'canonical.human_entry',
  // M10A2 (policy v2)
  'config.canonical.adopt',
  'config.module.change',
  'config.registry.publish',
  'config.data_policy.publish',
  'config.mapping.draft',
  'config.mapping.retire',
  'security.integrity.run',
  // M10B (policy v3)
  'canonical.evidence.link',
  'data.provenance.read',
  // M10C (policy v4)
  'data.account_structure.read',
  // M10D (policy v5)
  'data.extension.read',
  // M10E (policy v6)
  'data.account_context.read',
  // M10E hardening #90 (policy v7)
  'data.account_context.read_confidential',
  'security.capability.grant',
  // M10F (policy v8)
  'data.commercial.read',
  'data.commercial.read_confidential',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Bumped whenever a grant changes; recorded on every audit event. */
export const POLICY_VERSION = 8;

/**
 * Policy v8 (M10A2 added seven capabilities, M10B two, M10C one, M10D one, M10E one,
 * M10E hardening #90 two, M10F two; M10C grants canonical.human_entry to operator, Q2):
 * capability → actor kinds granted. `human_user` and `ai` hold nothing. A capability
 * granted to no kind here is held only through an explicit, tenant-scoped grant
 * (GRANTABLE_CAPABILITIES).
 */
export const POLICY: Readonly<Record<Capability, readonly ActorKind[]>> = {
  'canonical.source_sync': ['source_sync', 'system'],
  'canonical.import': ['operator'],
  'processing.receipt': ['system'],
  'processing.dead_letter.resolve': ['operator'],
  'config.tenant.provision': ['operator'],
  'config.tenant.status': ['operator'],
  'config.integration': ['operator'],
  'config.oauth.install': ['operator'],
  'config.oauth.grant': ['system'],
  'config.policy': ['operator'],
  'config.product_model.publish': ['operator'],
  'config.source.connection': ['operator'],
  'config.source.schema': ['operator'],
  'config.mapping.publish': ['operator'],
  'config.authority.publish': ['operator'],
  'data.sync.run': ['operator', 'system'],
  'data.profile.run': ['operator', 'system'],
  'data.eligibility.record': ['operator'],
  'data.purge': ['operator'],
  'security.key.rotate': ['operator'],
  'security.audit.read': ['operator'],
  // M10C (Q2): honoured only by the M10C hierarchy / affiliation operator commands and,
  // from M10D (Q17), the extension operator commands, from M10E (Q22), the
  // account-context operator commands and, from M10F (plan §16), the commercial operator commands.
  'canonical.human_entry': ['operator'],
  'config.canonical.adopt': ['operator'],
  'config.module.change': ['operator'],
  'config.registry.publish': ['operator'],
  'config.data_policy.publish': ['operator'],
  'config.mapping.draft': ['operator'],
  'config.mapping.retire': ['operator'],
  'security.integrity.run': ['operator', 'system'],
  'canonical.evidence.link': ['system'],
  'data.provenance.read': ['operator'],
  'data.account_structure.read': ['operator'],
  // M10D (Q17, Q29): extension read models / CLI, one audit event per read.
  'data.extension.read': ['operator'],
  // M10E (Q22, Q25): account-context read models / CLI, one audit event per read.
  'data.account_context.read': ['operator'],
  // M10E hardening #90 (ADR 0031 addendum): no actor kind holds it by policy. An operator
  // holds it in one tenant only through an explicit grant (tenant_capability_grants),
  // made by another operator with security.capability.grant. It widens an
  // account-context read (data.account_context.read still required) to the
  // confidential values; restricted values are never stored.
  'data.account_context.read_confidential': [],
  // Grants and revokes the GRANTABLE_CAPABILITIES (one audit event each; no self-grant).
  'security.capability.grant': ['operator'],
  // M10F (Q23): commercial read models / CLI, one audit event per read.
  'data.commercial.read': ['operator'],
  // M10F (Q22, plan §16): held by no actor kind — only through an explicit, tenant-scoped grant
  // (the #90 path). Widens a commercial read (data.commercial.read still required) to the
  // confidential columns (list amount, contract value, renewal date) and gates
  // --include-confidential on extension values of commercial targets.
  'data.commercial.read_confidential': [],
};

/**
 * M10E hardening #90: the closed list of capabilities that are held only through an
 * explicit, tenant-scoped grant to one operator id (never by actor kind). Granting
 * anything else is refused (`capability_not_grantable`); the database CHECK on
 * tenant_capability_grants.capability mirrors this list. No generic grant exists
 * (e.g. for all restricted data).
 */
export const GRANTABLE_CAPABILITIES = [
  'data.account_context.read_confidential',
  // M10F (Q22): confidential commercial reads.
  'data.commercial.read_confidential',
] as const;
export type GrantableCapability = (typeof GRANTABLE_CAPABILITIES)[number];
/** Only operators receive explicit grants (their id is asserted until M15). */
export const GRANTABLE_ACTOR_KINDS = ['operator'] as const satisfies readonly ActorKind[];

export function isGrantableCapability(capability: string): capability is GrantableCapability {
  return (GRANTABLE_CAPABILITIES as readonly string[]).includes(capability);
}

export type PolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'capability_not_granted' | 'actor_kind_not_supported';
    };

/** Pure, deny-by-default decision. */
export function decide(kind: ActorKind, capability: Capability): PolicyDecision {
  if (kind === 'human_user' || kind === 'ai') {
    return { allowed: false, reason: 'actor_kind_not_supported' };
  }
  return POLICY[capability].includes(kind)
    ? { allowed: true }
    : { allowed: false, reason: 'capability_not_granted' };
}
