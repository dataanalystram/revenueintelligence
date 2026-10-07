import { z } from 'zod';

/**
 * Reviewed holding-filter domains (ADR 0023, M9A plan §10). A holding filter
 * decides whether a source line is an ownership fact, so every value it can
 * meet must have been classified by an operator as `holding` or
 * `non_holding`. A value outside the reviewed domain is never classified
 * silently in either direction: `in` must not drop a real holding and
 * `not_in` must not admit a false one. Empty values (absent, null, empty or
 * whitespace-only) are an explicit, mandatory entry (`value: null`): M8
 * treated them as "not a member", which under `not_in` admitted them as
 * holdings.
 */
export const HoldingClassificationSchema = z.enum(['holding', 'non_holding']);
export type HoldingClassification = z.infer<typeof HoldingClassificationSchema>;

export const REVIEWED_DOMAIN_LIMITS = { entries: 2001, valueLength: 200, profiles: 20 } as const;

export const ReviewedDomainEntrySchema = z.strictObject({
  /** `null` stands for every empty value (absent, null, empty or whitespace-only). */
  value: z.string().min(1).max(REVIEWED_DOMAIN_LIMITS.valueLength).nullable(),
  classification: HoldingClassificationSchema,
});
export type ReviewedDomainEntry = z.infer<typeof ReviewedDomainEntrySchema>;

export const ReviewedDomainSchema = z.strictObject({
  entries: z.array(ReviewedDomainEntrySchema).min(1).max(REVIEWED_DOMAIN_LIMITS.entries),
  /** The schema snapshot the domain was reviewed against. */
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The covering profile(s) whose observed values were reviewed. */
  profileIds: z.array(z.uuid()).max(REVIEWED_DOMAIN_LIMITS.profiles).default([]),
});
export type ReviewedDomain = z.infer<typeof ReviewedDomainSchema>;

/** The value as the domain sees it: `null` for every empty form, otherwise the trimmed string. */
export function domainKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    text = String(value);
  // A structured value is never empty: its JSON form matches no reviewed entry (unreviewed).
  else return `\u0000${JSON.stringify(value) ?? typeof value}`;
  // Trimmed, exactly as the M8 holding filter compared values.
  text = text.trim();
  return text === '' ? null : text;
}

export type HoldingValueClass = HoldingClassification | 'unreviewed';

/** Classifies one source value against a reviewed domain. Pure; exact match after trimming. */
export function classifyHoldingValue(domain: ReviewedDomain, value: unknown): HoldingValueClass {
  const key = domainKey(value);
  const hit = domain.entries.find((e) => e.value === key);
  return hit ? hit.classification : 'unreviewed';
}

export interface DomainIssue {
  readonly code:
    | 'holding_filter_domain_incomplete'
    | 'holding_filter_domain_inconsistent'
    | 'holding_filter_domain_stale';
  readonly path: string;
  readonly message: string;
}

/**
 * Publish-time checks (M9A plan §10.2): the domain classifies every declared
 * option, every value observed in the covering profile and the empty value;
 * it agrees with the filter list; and it was reviewed against the mapping's
 * snapshot. Values are never auto-classified: a missing value is an issue.
 */
export function validateReviewedDomain(input: {
  readonly path: string;
  readonly operator: 'in' | 'not_in';
  readonly values: readonly string[];
  readonly domain: ReviewedDomain | undefined;
  readonly declaredOptions: readonly string[];
  readonly observedValues: readonly string[];
  readonly snapshotHash: string;
  readonly coveringProfileIds: readonly string[];
}): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const at = `${input.path}.reviewedDomain`;
  const domain = input.domain;
  if (!domain) {
    return [
      {
        code: 'holding_filter_domain_incomplete',
        path: at,
        message: 'a holding filter needs a reviewed domain classifying every value',
      },
    ];
  }
  const seen = new Map<string | null, HoldingClassification>();
  domain.entries.forEach((e, i) => {
    if (seen.has(e.value)) {
      issues.push({
        code: 'holding_filter_domain_inconsistent',
        path: `${at}.entries.${i}`,
        message: 'a value is classified more than once',
      });
    }
    seen.set(e.value, e.classification);
  });
  if (!seen.has(null)) {
    issues.push({
      code: 'holding_filter_domain_incomplete',
      path: at,
      message: 'the empty value (null) must be classified explicitly',
    });
  }
  const missing = (list: readonly string[]) =>
    [...new Set(list)].filter((v) => !seen.has(domainKey(v))).sort();
  const declared = missing(input.declaredOptions);
  if (declared.length > 0) {
    issues.push({
      code: 'holding_filter_domain_incomplete',
      path: at,
      message: `${declared.length} declared option(s) are not classified`,
    });
  }
  const observed = missing(input.observedValues);
  if (observed.length > 0) {
    issues.push({
      code: 'holding_filter_domain_incomplete',
      path: at,
      message: `${observed.length} observed value(s) are not classified`,
    });
  }
  // Consistency with the M8 list: `in` lists the holdings, `not_in` the non-holdings.
  const listed = new Set(input.values);
  for (const [value, cls] of seen) {
    const inList = value !== null && listed.has(value);
    const expected: HoldingClassification =
      input.operator === 'in'
        ? inList
          ? 'holding'
          : 'non_holding'
        : inList
          ? 'non_holding'
          : 'holding';
    // The empty value is never listed; its classification is free but explicit.
    if (value === null) continue;
    if (cls !== expected) {
      issues.push({
        code: 'holding_filter_domain_inconsistent',
        path: at,
        message: 'a classification contradicts the filter list',
      });
      break;
    }
  }
  for (const v of input.values) {
    if (!seen.has(v)) {
      issues.push({
        code: 'holding_filter_domain_incomplete',
        path: at,
        message: 'every filter value must appear in the reviewed domain',
      });
      break;
    }
  }
  if (domain.snapshotHash !== input.snapshotHash) {
    issues.push({
      code: 'holding_filter_domain_stale',
      path: `${at}.snapshotHash`,
      message: 'the domain was reviewed against a different schema snapshot',
    });
  }
  const covering = new Set(input.coveringProfileIds);
  if (domain.profileIds.some((id) => !covering.has(id))) {
    issues.push({
      code: 'holding_filter_domain_stale',
      path: `${at}.profileIds`,
      message: 'the domain cites a profile that does not cover this mapping',
    });
  }
  return issues;
}
