import { logicalClassOf, type ObservedType, type Representation } from './classifiers';
import type { FieldProfile, ProfileDocument } from './document';
import { assertNoRawValues, ProfilePrivacyViolationError, schemaNameHits } from './privacy';

/**
 * Profile findings (M9A plan §8). The code list mirrors the
 * `tenant_source_profile_findings_code_valid` CHECK (parity test). Classes:
 * `advisory` (A), `existing_fail_closed` (E, an M8 mechanism) and
 * `m9a_fail_closed` (B, an M9A guard). E and B can never be disabled or
 * demoted by configuration (`validateFindingPolicy`).
 */

export const FINDING_CODES = [
  'high_null_ratio',
  'required_but_null',
  'empty_string_vs_null',
  'mixed_type',
  'mixed_representation',
  'malformed_json',
  'invalid_date',
  'ambiguous_date',
  'number_locale',
  'ambiguous_delimiter',
  'leading_zero_numeric',
  'declared_type_mismatch',
  'value_not_in_declared_enum',
  'high_cardinality_identifier',
  'undeclared_field_in_data',
  'field_absent_in_data',
  'identifier_not_unique',
  'sensitive_values_detected',
  'head_sample_biased',
  'low_coverage_sample',
  'findings_truncated',
  'profile_drift_null_ratio',
  'profile_drift_type_distribution',
  'profile_drift_type_compatible',
  'profile_drift_type_incompatible',
  'profile_drift_representation',
  'profile_drift_new_category',
  'profile_drift_category_vanished',
  'profile_drift_cardinality',
  'profile_drift_row_count',
  'profile_drift_parse_failures',
  'identity_field_absent',
  'holding_filter_value_unreviewed',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];
export type FindingClass = 'advisory' | 'existing_fail_closed' | 'm9a_fail_closed';
export type FindingSeverity = 'info' | 'warning' | 'review_required';

/** Codes that are E or B in every instance (never configurable). */
export const FAIL_CLOSED_CODES: ReadonlySet<FindingCode> = new Set<FindingCode>([
  'identifier_not_unique',
  'profile_drift_type_incompatible',
  'identity_field_absent',
  'holding_filter_value_unreviewed',
]);

export const MAX_FINDINGS_PER_PROFILE = 2000;

export interface Finding {
  readonly code: FindingCode;
  readonly class: FindingClass;
  readonly severity: FindingSeverity;
  readonly field: string | null;
  /** Counts, ratios and codes; never raw values except safe-category values. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

const INFO_CODES: ReadonlySet<FindingCode> = new Set<FindingCode>([
  'sensitive_values_detected',
  'high_cardinality_identifier',
  'profile_drift_cardinality',
  'profile_drift_row_count',
]);

/** The default class and severity of a code (drift representation is decided per instance). */
export function classify(code: FindingCode): { class: FindingClass; severity: FindingSeverity } {
  if (code === 'identifier_not_unique')
    return { class: 'existing_fail_closed', severity: 'warning' };
  if (FAIL_CLOSED_CODES.has(code)) return { class: 'm9a_fail_closed', severity: 'review_required' };
  if (code === 'low_coverage_sample') return { class: 'advisory', severity: 'review_required' };
  return { class: 'advisory', severity: INFO_CODES.has(code) ? 'info' : 'warning' };
}

export function finding(
  code: FindingCode,
  field: string | null,
  evidence: Record<string, unknown>,
  override?: { class: FindingClass; severity: FindingSeverity },
): Finding {
  return { code, ...(override ?? classify(code)), field, evidence };
}

/** Planning thresholds for advisory publish-time findings (§8; A class, not safety decisions). */
export const ADVISORY_THRESHOLDS = Object.freeze({
  highNullRatio: 0.5,
  mixedShare: 0.01,
  mixedMinValues: 5,
  lowCoverage: 0.5,
});

/** Observed classes each declared type can hold (anything else is a declared-type mismatch). */
const COMPATIBLE: Readonly<Record<string, ReadonlySet<ObservedType>>> = {
  id: new Set(['string', 'integer']),
  string: new Set([
    'string',
    'text',
    'integer',
    'decimal',
    'boolean',
    'date',
    'timestamp',
    'json_array',
    'json_object',
  ]),
  text: new Set([
    'string',
    'text',
    'integer',
    'decimal',
    'boolean',
    'date',
    'timestamp',
    'json_array',
    'json_object',
  ]),
  enum: new Set(['string', 'integer', 'boolean']),
  date: new Set(['date', 'timestamp']),
  datetime: new Set(['timestamp', 'date']),
  number: new Set(['integer', 'decimal']),
  integer: new Set(['integer']),
  boolean: new Set(['boolean']),
  relate: new Set(['string', 'integer']),
};

export function compatibleTypes(declaredType: string): ReadonlySet<ObservedType> | undefined {
  return COMPATIBLE[declaredType];
}

function substantive(f: FieldProfile): number {
  return Object.values(f.observedTypes).reduce((a, b) => a + (b ?? 0), 0);
}

function fieldFindings(name: string, f: FieldProfile, identity: boolean, rows: number): Finding[] {
  const out: Finding[] = [];
  const n = substantive(f);
  const ratio = (x: number) => Number(x.toFixed(4));
  if (rows > 0 && f.counts.absent === rows) {
    out.push(finding('field_absent_in_data', name, { rows }));
    return out;
  }
  if (rows > 0 && f.nullRatio >= ADVISORY_THRESHOLDS.highNullRatio && !identity) {
    out.push(finding('high_null_ratio', name, { nullRatio: ratio(f.nullRatio), rows }));
  }
  if (f.declared.required && f.counts.null > 0) {
    out.push(finding('required_but_null', name, { nulls: f.counts.null, rows }));
  }
  const empties = f.counts.emptyString + f.counts.whitespaceOnly;
  if (f.counts.null > 0 && empties > 0) {
    out.push(finding('empty_string_vs_null', name, { nulls: f.counts.null, empties }));
  }
  const types = Object.entries(f.observedTypes)
    .map(([k, v]) => [k, v ?? 0] as const)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const second = types[1];
  if (
    second &&
    second[1] >= ADVISORY_THRESHOLDS.mixedMinValues &&
    second[1] / n >= ADVISORY_THRESHOLDS.mixedShare
  ) {
    out.push(finding('mixed_type', name, { types: Object.fromEntries(types.slice(0, 6)) }));
  }
  const byClass = new Map<string, Array<[string, number]>>();
  for (const [rep, count] of Object.entries(f.representations)) {
    const logical = logicalClassOf(rep as Representation);
    const c = count ?? 0;
    if (
      logical === 'other' ||
      c < ADVISORY_THRESHOLDS.mixedMinValues ||
      c / n < ADVISORY_THRESHOLDS.mixedShare
    )
      continue;
    byClass.set(logical, [...(byClass.get(logical) ?? []), [rep, c]]);
  }
  for (const [logical, reps] of [...byClass].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (reps.length >= 2) {
      out.push(
        finding('mixed_representation', name, {
          class: logical,
          representations: Object.fromEntries(reps),
        }),
      );
    }
  }
  for (const failure of [
    'malformed_json',
    'invalid_date',
    'ambiguous_date',
    'number_locale',
    'ambiguous_delimiter',
    'leading_zero_numeric',
  ] as const) {
    const c = f.parseFailures[failure] ?? 0;
    if (c > 0)
      out.push(
        finding(failure, name, { count: c, ratio: n === 0 ? 0 : ratio(c / Math.max(n, c)) }),
      );
  }
  const compatible = compatibleTypes(f.declared.type);
  if (compatible && n > 0) {
    const incompatible = types
      .filter(([t]) => !compatible.has(t as ObservedType))
      .reduce((a, [, c]) => a + c, 0);
    if (
      incompatible >= ADVISORY_THRESHOLDS.mixedMinValues &&
      incompatible / n >= ADVISORY_THRESHOLDS.mixedShare
    ) {
      out.push(
        finding('declared_type_mismatch', name, {
          declaredType: f.declared.type,
          incompatible,
          ratio: ratio(incompatible / n),
        }),
      );
    }
  }
  if ((f.counts.notInDeclaredEnum ?? 0) > 0) {
    out.push(finding('value_not_in_declared_enum', name, { count: f.counts.notInDeclaredEnum }));
  }
  const looksLikeId = f.suggestions.some((s) => s.interpretation === 'identifier');
  if (
    looksLikeId &&
    !identity &&
    f.declared.type !== 'id' &&
    !f.declared.unique &&
    (f.cardinalityClass === 'unique' || f.cardinalityClass === 'high')
  ) {
    out.push(
      finding('high_cardinality_identifier', name, { cardinalityClass: f.cardinalityClass }),
    );
  }
  if (identity && f.distinct.method === 'exact' && f.distinct.value < n) {
    out.push(
      finding('identifier_not_unique', name, { duplicates: n - f.distinct.value, values: n }),
    );
  }
  if (f.sensitivity === 'sensitive_by_value') {
    out.push(finding('sensitive_values_detected', name, { ...f.detectors }));
  }
  return out;
}

export interface FindingContext {
  /** Identity fields (uniqueness checked; no null-ratio advisory). */
  /** Profile names (`ProfileNames.toProfile`) of the identity fields. */
  readonly identityFields?: ReadonlySet<string>;
}

/** Publish-time quality and sampling findings of one document (§8, last two rows). */
export function documentFindings(doc: ProfileDocument, ctx: FindingContext = {}): Finding[] {
  const out: Finding[] = [];
  const rows = doc.sampling.rowsRead;
  if (doc.sampling.method === 'head') {
    out.push(finding('head_sample_biased', null, { method: 'head', rowsRead: rows }));
  }
  const coverage = doc.sampling.coverage;
  const lowCoverage =
    doc.sampling.method !== 'sync' &&
    ((coverage !== null && coverage < ADVISORY_THRESHOLDS.lowCoverage) ||
      (coverage === null && doc.sampling.bounded));
  if (lowCoverage) {
    out.push(
      finding('low_coverage_sample', null, {
        method: doc.sampling.method,
        coverage,
        bounded: doc.sampling.bounded,
      }),
    );
  }
  for (const name of doc.undeclaredFields) out.push(finding('undeclared_field_in_data', name, {}));
  if (doc.undeclaredFieldsRedacted) {
    // Names that cannot be stored: one finding with the count, no name.
    out.push(
      finding('undeclared_field_in_data', null, {
        count: doc.undeclaredFieldsRedacted,
        nameRedacted: true,
      }),
    );
  }
  for (const f of doc.fields) {
    out.push(...fieldFindings(f.name, f, ctx.identityFields?.has(f.name) ?? false, rows));
  }
  return capFindings(out);
}

/** ≤ 2,000 findings per profile; beyond that one `findings_truncated` carries the count. */
export function capFindings(findings: readonly Finding[]): Finding[] {
  if (findings.length <= MAX_FINDINGS_PER_PROFILE) return [...findings];
  const kept = findings.slice(0, MAX_FINDINGS_PER_PROFILE - 1);
  return [...kept, finding('findings_truncated', null, { omitted: findings.length - kept.length })];
}

export class FindingPolicyError extends Error {
  readonly code = 'finding_not_demotable';
  constructor(readonly findingCode: string) {
    super(`finding ${findingCode} is fail-closed and cannot be demoted or disabled`);
    this.name = 'FindingPolicyError';
  }
}

/**
 * The only configurable finding policy: promoting A codes (§8). Demoting or
 * disabling any code is refused, and E/B codes cannot appear in a policy at
 * all (they are fail-closed already).
 */
export function validateFindingPolicy(policy: {
  readonly promote?: readonly string[];
  readonly demote?: readonly string[];
  readonly disable?: readonly string[];
}): { promote: FindingCode[] } {
  for (const code of [...(policy.demote ?? []), ...(policy.disable ?? [])])
    throw new FindingPolicyError(code);
  const promote: FindingCode[] = [];
  for (const code of policy.promote ?? []) {
    if (!(FINDING_CODES as readonly string[]).includes(code)) throw new FindingPolicyError(code);
    if (FAIL_CLOSED_CODES.has(code as FindingCode)) throw new FindingPolicyError(code);
    promote.push(code as FindingCode);
  }
  return { promote };
}

/**
 * The independent scan for a finding before persistence: its field (a profile
 * name) passes the schema-name detectors, its evidence the raw-value scan.
 */
export function assertNoRawFinding(f: Finding): void {
  if (f.field !== null) {
    const hit = schemaNameHits(f.field)[0];
    if (hit) throw new ProfilePrivacyViolationError(hit, 'finding.field');
  }
  assertNoRawValues(f.evidence);
}
