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
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Bumped whenever a grant changes; recorded on every audit event. */
export const POLICY_VERSION = 3;

/** Policy v3 (M10A2 added seven capabilities, M10B two): capability → actor kinds granted. `human_user` and `ai` hold nothing. */
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
  'canonical.human_entry': [],
  'config.canonical.adopt': ['operator'],
  'config.module.change': ['operator'],
  'config.registry.publish': ['operator'],
  'config.data_policy.publish': ['operator'],
  'config.mapping.draft': ['operator'],
  'config.mapping.retire': ['operator'],
  'security.integrity.run': ['operator', 'system'],
  'canonical.evidence.link': ['system'],
  'data.provenance.read': ['operator'],
};

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
