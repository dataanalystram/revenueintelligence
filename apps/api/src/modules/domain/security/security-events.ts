/**
 * Security events (M10A1 plan §15): codes and identifiers only, never values.
 * Emitted as structured logs and counted as `lip_security_events_total`.
 */
export const SECURITY_EVENTS = [
  'authz_denied',
  'audit_write_failed',
  'secret_like_refused',
  'credential_resolution_failed',
  'token_key_unknown',
  'token_decrypt_failed',
  'oauth_state_invalid',
  'webhook_signature_invalid',
  'tenant_inactive_access',
  'role_guard_refused',
  'audit_purge_completed',
  'audit_chain_broken',
  'key_rotation_completed',
  'privilege_manifest_mismatch',
  // M10A2
  'integrity_violation_detected',
  'integrity_run_completed',
  'module_disabled_write_refused',
] as const;
export type SecurityEventCode = (typeof SECURITY_EVENTS)[number];

export interface SecurityEvent {
  readonly event: SecurityEventCode;
  readonly outcome: 'refused' | 'failed' | 'detected' | 'completed';
  /** Tenant slug when known. */
  readonly tenant?: string;
  readonly actorKind?: string;
  readonly capability?: string;
  readonly reasonCode: string;
  readonly correlationId?: string;
  /** Identifier-only coordinates (e.g. connection, object type, record id, field path). */
  readonly coordinates?: Readonly<Record<string, string>>;
}
