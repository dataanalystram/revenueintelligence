/**
 * Account hierarchy and Person–Account affiliation (M10C plan
 * docs/milestones/M10C-account-hierarchy-affiliation-plan.md, ADR 0029,
 * canonical 0.3). Closed vocabularies; the database CHECKs equal these lists
 * (schema guard).
 */

/** Minimum canonical version for hierarchy / affiliation writes and the new mapping targets (plan §7). */
export const ACCOUNT_STRUCTURE_MIN_VERSION = '0.3';

/**
 * Database fail-closed ceiling of the ancestor walk in the
 * `companies_hierarchy_guard` trigger (plan §2.1, Q3). Not the guardrail: it is
 * above any allowed configuration value.
 */
export const HIERARCHY_MAX_DEPTH_CEILING = 64;

/** Platform guardrail `CANONICAL_HIERARCHY_MAX_DEPTH` (plan §2.3, Q3): integer 1–50, default 10. */
export const HIERARCHY_MAX_DEPTH_DEFAULT = 10;
export const HIERARCHY_MAX_DEPTH_MIN = 1;
export const HIERARCHY_MAX_DEPTH_MAX = 50;

/** Who last set or cleared a parent (`companies.parent_company_origin`; NULL = never set). */
export const PARENT_COMPANY_ORIGINS = ['source_provided', 'human'] as const;
export type ParentCompanyOrigin = (typeof PARENT_COMPANY_ORIGINS)[number];

/** Named refusals raised by the hierarchy trigger (SQLSTATE 23514); the message is the code. */
export const HIERARCHY_TRIGGER_REFUSALS = [
  'hierarchy_cycle',
  'hierarchy_parent_merged',
  'hierarchy_ceiling',
] as const;
export type HierarchyTriggerRefusal = (typeof HIERARCHY_TRIGGER_REFUSALS)[number];

/** The advisory-lock scope / value the trigger takes per tenant (same key as `tenantAdvisoryLock`). */
export const HIERARCHY_LOCK_SCOPE = 'account-hierarchy';
export const HIERARCHY_LOCK_VALUE = 'tenant';

export const AFFILIATION_STATUSES = ['active', 'ended', 'merged'] as const;
export type AffiliationStatus = (typeof AFFILIATION_STATUSES)[number];

export const AFFILIATION_END_REASONS = [
  'source_end_date',
  'source_removed',
  'operator',
  'person_merged',
  'company_merged',
] as const;
export type AffiliationEndReason = (typeof AFFILIATION_END_REASONS)[number];

export const AFFILIATION_ORIGINS = ['source_provided', 'human'] as const;
export type AffiliationOrigin = (typeof AFFILIATION_ORIGINS)[number];

/** Role codes come only from a mapping's explicit value map (Q11): identifiers, at most ten. */
export const AFFILIATION_ROLE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;
export const AFFILIATION_MAX_ROLE_CODES = 10;

/** The advisory-lock scope the one-active-per-pair trigger takes (value `${personId}|${companyId}`). */
export const AFFILIATION_PAIR_LOCK_SCOPE = 'person-affiliation';

/** Mapping targets introduced by 0.3 (plan §2.2, §3.2); their writers arrive with the M10C services. */
export const ACCOUNT_STRUCTURE_MAPPING_TARGETS = ['account.parent', 'person.affiliation'] as const;

/** Data-quality issue kinds recorded in `tenant_identity_conflicts` until M10L (plan §2.6, Q7). */
export const ACCOUNT_STRUCTURE_CONFLICT_KINDS = [
  'hierarchy_cycle_refused',
  'hierarchy_depth_exceeded',
  'hierarchy_parent_merged',
  'hierarchy_parent_unresolved',
  'hierarchy_human_override_disagrees',
  'affiliation_endpoint_unresolved',
] as const;

/** Every `tenant_identity_conflicts.kind` (M6 kinds + M10C); the CHECK equals this list. */
export const IDENTITY_CONFLICT_KINDS = [
  'shared_email',
  'merge_across_systems',
  'ambiguous_primary_company',
  ...ACCOUNT_STRUCTURE_CONFLICT_KINDS,
] as const;
export type IdentityConflictKind = (typeof IDENTITY_CONFLICT_KINDS)[number];

/** Read-only security-invoker views over the account structure (plan §5). */
export const ACCOUNT_STRUCTURE_VIEWS = ['account_hierarchy_paths', 'person_affiliation_index'] as const;
