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
  // M10B plan §11 (ADR 0028)
  'declared_reference_drift',
  'source_reference_ambiguous',
  'source_reference_change_mismatch',
  'evidence_relation_unknown',
  'evidence_supersession_invalid',
  'source_reference_index_parity',
  // M10C plan §11 (ADR 0029)
  'hierarchy_cycle',
  'hierarchy_depth_exceeded',
  'hierarchy_parent_merged',
  'hierarchy_history_parity',
  'affiliation_endpoint_merged',
  'affiliation_reference_parity',
  // M10D plan §14 (ADR 0030)
  'extension_value_type_mismatch',
  'extension_value_restricted',
  'extension_value_target_kind',
  'extension_items_parity',
  'extension_value_secret_like',
  'custom_record_parent_missing',
  'custom_relationship_cardinality',
  'extension_history_parity',
  // M10E plan §14 (ADR 0031)
  'account_context_company_mismatch',
  'account_context_natural_key_drift',
  'account_context_type_mismatch',
  'account_context_dangling_merge',
  'account_context_member_role_unknown',
  // M10D hardening #83 (ADR 0030 addendum)
  'custom_object_owner_drift',
  // M10F plan §15 (ADR 0032)
  'commercial_line_contract_company_mismatch',
  'commercial_line_price_offer_product_mismatch',
  'commercial_contract_link_cycle',
  'commercial_contract_link_cross_account',
  'commercial_line_lineage_cycle',
  'commercial_agreement_contract_drift',
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
