/**
 * Retention classes (M10 plan §16.3, owner decision F5; M10A1 plan §10).
 * Policy-first: these are engineering product defaults, configurable later by
 * the tenant data policy (M10A2). They are not SOC 2, GDPR, HIPAA or
 * legal-retention claims.
 */
export const RETENTION_CLASSES = [
  'security_audit',
  'operational_diagnostics',
  'rejected_candidate',
  'raw_rejected_value',
  'raw_communication_content',
  'sensitive_value_history',
  'canonical_lifecycle',
  'profile_statistics',
  'configuration_version',
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export type RetentionDefault =
  | { readonly kind: 'days'; readonly days: number }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'lifecycle' };

export const RETENTION_DEFAULTS: Readonly<Record<RetentionClass, RetentionDefault>> = {
  security_audit: { kind: 'days', days: 365 },
  operational_diagnostics: { kind: 'days', days: 90 },
  rejected_candidate: { kind: 'days', days: 30 },
  raw_rejected_value: { kind: 'disabled' },
  raw_communication_content: { kind: 'disabled' },
  sensitive_value_history: { kind: 'disabled' },
  canonical_lifecycle: { kind: 'lifecycle' },
  profile_statistics: { kind: 'lifecycle' },
  configuration_version: { kind: 'lifecycle' },
};

/**
 * Q3: the audit purge mechanism exists and is tested, but executing it stays
 * disabled until the formal privacy/retention policy is approved (tech debt #15).
 * Changing this constant is a reviewed code change, not configuration.
 */
export const AUDIT_PURGE_EXECUTION_APPROVED = false;

/** The cut-off before which events of a `days` class are eligible for purge. */
export function retentionCutoff(cls: RetentionClass, now: Date): Date | undefined {
  const d = RETENTION_DEFAULTS[cls];
  return d.kind === 'days' ? new Date(now.getTime() - d.days * 86_400_000) : undefined;
}
