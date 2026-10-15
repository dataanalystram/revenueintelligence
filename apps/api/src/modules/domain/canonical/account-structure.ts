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
export const ACCOUNT_STRUCTURE_VIEWS = [
  'account_hierarchy_paths',
  'person_affiliation_index',
] as const;

// ---------------------------------------------------------------------------
// Pure rules (M10C plan §2.3–§2.5, §3.2, §3.3). No I/O: the writers load the
// facts, these functions decide, the database triggers are the backstop.
// ---------------------------------------------------------------------------

/**
 * Parses the platform guardrail `CANONICAL_HIERARCHY_MAX_DEPTH` (plan §2.3):
 * absent → the default; otherwise an integer within 1–50, else `undefined`
 * (the configuration schema refuses start-up).
 */
export function parseHierarchyMaxDepth(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return HIERARCHY_MAX_DEPTH_DEFAULT;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return n >= HIERARCHY_MAX_DEPTH_MIN && n <= HIERARCHY_MAX_DEPTH_MAX ? n : undefined;
}

/** What a writer asks for: set a parent, clear it explicitly, or nothing (field absent / unmapped). */
export type ParentRequest =
  | { readonly kind: 'set'; readonly parentId: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'absent' };

export type HierarchyRefusal =
  'hierarchy_cycle' | 'hierarchy_depth_exceeded' | 'hierarchy_parent_merged';

export interface ParentChangeInput {
  readonly childId: string;
  readonly current: {
    readonly parentId: string | null;
    readonly origin: ParentCompanyOrigin | null;
  };
  readonly request: ParentRequest;
  /** `source` (an authoritative observation) or `human` (operator entry). */
  readonly writer: 'source' | 'human';
  /**
   * For `set`: the requested parent's record state and its ancestor path,
   * starting with the parent itself and ending at its root. `truncated` when the
   * walk stopped at its bound without reaching a root.
   */
  readonly parent?: {
    readonly recordState: string;
    readonly path: readonly string[];
    readonly truncated: boolean;
  };
  /** Height of the child's own subtree (0 = no children); `subtreeTruncated` when the bound was hit. */
  readonly subtreeHeight: number;
  readonly subtreeTruncated?: boolean;
  /** The configured guardrail (edges from the root). */
  readonly maxDepth: number;
}

export type ParentDecision =
  | { readonly outcome: 'unchanged' }
  /** `parentChanged` false = only the origin moves (an operator confirming the current parent). */
  | {
      readonly outcome: 'apply';
      readonly parentId: string | null;
      readonly origin: ParentCompanyOrigin;
      readonly parentChanged: boolean;
    }
  | { readonly outcome: 'refused'; readonly code: HierarchyRefusal }
  /** A source value that disagrees with a sticky human value (plan §2.5). */
  | { readonly outcome: 'human_override' };

/**
 * Decides one parent change (plan §2.3–§2.5, V1). Order: an absent value
 * changes nothing (disappearance never unparents); a sticky human value wins
 * over any disagreeing source value; then the requested value is checked —
 * self-parent and cycle, merged parent, depth (the parent's depth + 1 + the
 * child's subtree height must stay within the guardrail).
 */
export function decideParentChange(input: ParentChangeInput): ParentDecision {
  const { request, current, writer } = input;
  if (request.kind === 'absent') return { outcome: 'unchanged' };
  const target = request.kind === 'set' ? request.parentId : null;
  const origin: ParentCompanyOrigin = writer === 'human' ? 'human' : 'source_provided';
  if (writer === 'source' && current.origin === 'human') {
    return target === current.parentId ? { outcome: 'unchanged' } : { outcome: 'human_override' };
  }
  if (target === current.parentId) {
    // An operator confirming the current value makes it sticky; a source repeat is a no-op.
    return writer === 'human' && current.origin !== 'human'
      ? { outcome: 'apply', parentId: target, origin, parentChanged: false }
      : { outcome: 'unchanged' };
  }
  if (target === null) return { outcome: 'apply', parentId: null, origin, parentChanged: true };
  if (target !== '') return { outcome: 'apply', parentId: target, origin, parentChanged: true };
  if (target === input.childId) return { outcome: 'refused', code: 'hierarchy_cycle' };
  const parent = input.parent;
  if (!parent) throw new Error('decideParentChange: the requested parent was not loaded');
  if (parent.recordState === 'merged') {
    return { outcome: 'refused', code: 'hierarchy_parent_merged' };
  }
  if (parent.path.includes(input.childId)) return { outcome: 'refused', code: 'hierarchy_cycle' };
  if (parent.truncated || input.subtreeTruncated) {
    return { outcome: 'refused', code: 'hierarchy_depth_exceeded' };
  }
  const parentDepth = parent.path.length - 1;
  if (parentDepth + 1 + input.subtreeHeight > input.maxDepth) {
    return { outcome: 'refused', code: 'hierarchy_depth_exceeded' };
  }
  return { outcome: 'apply', parentId: target, origin, parentChanged: true };
}

/** The fields of one affiliation as stated by a source or an operator (no names, no free text). */
export interface AffiliationFields {
  readonly roleCodes: readonly string[];
  readonly startsAt?: Date;
  readonly endsAt?: Date;
}

export type AffiliationIssue = 'affiliation_period_invalid' | 'affiliation_role_code_invalid';

/** Layer-1 checks of an affiliation's fields (plan §3.3); the database CHECKs are the boundary. */
export function affiliationIssues(fields: AffiliationFields): AffiliationIssue[] {
  const issues: AffiliationIssue[] = [];
  if (issues.length === 0) return issues;
  if (fields.startsAt && fields.endsAt && fields.endsAt < fields.startsAt) {
    issues.push('affiliation_period_invalid');
  }
  if (
    fields.roleCodes.length > AFFILIATION_MAX_ROLE_CODES ||
    fields.roleCodes.some((c) => !AFFILIATION_ROLE_CODE_PATTERN.test(c)) ||
    new Set(fields.roleCodes).size !== fields.roleCodes.length
  ) {
    issues.push('affiliation_role_code_invalid');
  }
  return issues;
}

/** Sorted, de-duplicated role codes (stable storage and hashing). */
export function normaliseRoleCodes(codes: readonly string[]): string[] {
  return [...new Set(codes)].sort();
}

/**
 * Maps source role values through a mapping's explicit value map (Q11): mapped
 * values become codes, unmapped values are dropped and counted, never stored.
 */
export function mapRoleValues(
  values: readonly string[],
  valueMap: Readonly<Record<string, string>>,
): { readonly codes: string[]; readonly dropped: number } {
  const codes: string[] = [];
  let dropped = 0;
  for (const v of values) {
    const code = Object.hasOwn(valueMap, v) ? valueMap[v] : undefined;
    if (code && AFFILIATION_ROLE_CODE_PATTERN.test(code)) codes.push(code);
    else dropped += 1;
  }
  return { codes: normaliseRoleCodes(codes).slice(0, AFFILIATION_MAX_ROLE_CODES), dropped };
}

export interface StoredAffiliation {
  readonly id: string;
  readonly origin: AffiliationOrigin;
  readonly roleCodes: readonly string[];
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

export type AffiliationObservationDecision =
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'create' }
  | { readonly outcome: 'update' }
  | { readonly outcome: 'end'; readonly reason: 'source_end_date' | 'source_removed' }
  /** A source observation never changes or ends a human row (plan §3.2). */
  | { readonly outcome: 'human_row' };

/**
 * Decides one source observation of a (person, company) affiliation (plan
 * §3.2, V9). `observed` is the link as the authoritative source states it, or
 * `removed` when an authoritative observation removed the link. Nothing is
 * inferred from absence: an unseen link is never passed here. A stated end at
 * or before the observation time ends the active row; with no active row there
 * is nothing to end and no row is created for a past period.
 */
export function decideAffiliationObservation(
  active: StoredAffiliation | undefined,
  observed:
    { readonly kind: 'present'; readonly fields: AffiliationFields } | { readonly kind: 'removed' },
  observedAt: Date,
): AffiliationObservationDecision {
  if (active?.origin === 'human') return { outcome: 'human_row' };
  if (observed.kind === 'removed') {
    return active ? { outcome: 'end', reason: 'source_removed' } : { outcome: 'unchanged' };
  }
  const ended = observed.fields.endsAt !== undefined && observed.fields.endsAt <= observedAt;
  if (!active) return ended ? { outcome: 'unchanged' } : { outcome: 'create' };
  if (ended) return { outcome: 'end', reason: 'source_end_date' };
  return sameAffiliationFields(active, observed.fields)
    ? { outcome: 'unchanged' }
    : { outcome: 'update' };
}

function sameAffiliationFields(a: StoredAffiliation, f: AffiliationFields): boolean {
  const codes = normaliseRoleCodes(f.roleCodes);
  return (
    a.roleCodes.length === codes.length &&
    a.roleCodes.every((c, i) => c === codes[i]) &&
    (a.startsAt?.getTime() ?? null) === (f.startsAt?.getTime() ?? null) &&
    (a.endsAt?.getTime() ?? null) === (f.endsAt?.getTime() ?? null)
  );
}
