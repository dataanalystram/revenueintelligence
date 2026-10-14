/**
 * Integrity verification (M10 plan §18 layer 3; M10A2 plan §11). Read-only;
 * findings are reported, never repaired (forward-fix only).
 */
export const INTEGRITY_CHECKS = [
  'entity_index_missing',
  'entity_index_orphan',
  'value_history_unindexed',
  'adoption_chain_invalid',
  'adoption_audit_missing',
  'audit_reference_missing',
  'module_setting_mismatch',
  'registry_projection_mismatch',
  'mapping_lifecycle_invalid',
  'privilege_manifest_mismatch',
] as const;
export type IntegrityCheck = (typeof INTEGRITY_CHECKS)[number];

export const INTEGRITY_OUTCOMES = ['passed', 'findings', 'failed'] as const;
export type IntegrityOutcome = (typeof INTEGRITY_OUTCOMES)[number];

export interface IntegrityFinding {
  readonly check: IntegrityCheck;
  /** Identifiers only (ids, kinds, keys, versions), never values. */
  readonly ref: string;
}

/** Findings are capped so a run record stays small (≤ 16 KB). */
export const INTEGRITY_MAX_FINDINGS = 100;

export function integrityOutcome(findings: readonly IntegrityFinding[]): IntegrityOutcome {
  return findings.length === 0 ? 'passed' : 'findings';
}

export function integrityCounts(
  findings: readonly IntegrityFinding[],
): Readonly<Record<IntegrityCheck, number>> {
  const out = Object.fromEntries(INTEGRITY_CHECKS.map((c) => [c, 0])) as Record<
    IntegrityCheck,
    number
  >;
  for (const f of findings) out[f.check] += 1;
  return out;
}
