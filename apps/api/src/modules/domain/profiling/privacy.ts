/**
 * Privacy and sensitivity model for source profiling (ADR 0022, M9A plan §5).
 * Profiles hold aggregates only. The single exception is the safe-category
 * gate (§5.4): a field's distinct values are kept only when every condition
 * holds. `assertNoRawValues` is an independent second check over the finished
 * document (§5.5): any detector hit fails the run and nothing is persisted.
 */

/** Lower-cased, separators removed (the name rules compare on this form). */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** §5.1: names never profiled without an explicit, audited opt-in. */
export const EXCLUDED_NAME_TOKENS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'card',
  'cvv',
  'iban',
  'accountnumber',
  'routing',
  'ssn',
  'taxid',
  'nationalid',
  'passport',
  'dob',
  'birth',
] as const;

/**
 * §5.2: names profiled for shape and counts only. Substring match on the
 * normalised name, as planned: short tokens (`ip`, `city`, `name`) also match
 * unrelated names such as `description`. Accepted: an over-match only
 * suppresses categorical values, it never stores more.
 */
export const SENSITIVE_NAME_TOKENS = [
  'email',
  'mail',
  'phone',
  'mobile',
  'fax',
  'name',
  'address',
  'street',
  'postcode',
  'postal',
  'zip',
  'city',
  'ip',
  'url',
  'website',
  'linkedin',
] as const;

export function isExcludedName(name: string): boolean {
  const n = normaliseName(name);
  return EXCLUDED_NAME_TOKENS.some((t) => n.includes(t));
}

export function isSensitiveName(name: string): boolean {
  const n = normaliseName(name);
  return SENSITIVE_NAME_TOKENS.some((t) => n.includes(t));
}

// ---------------------------------------------------------------------------
// Value detectors (§5.3)
// ---------------------------------------------------------------------------

export const PII_DETECTORS = ['email', 'phone', 'card', 'iban'] as const;
export type PiiDetector = (typeof PII_DETECTORS)[number];

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Calendar-looking strings (ISO date/timestamp, d/m/y): never phone numbers. */
const DATE_SHAPED =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/;

export function isEmail(text: string): boolean {
  return EMAIL.test(text);
}

/**
 * Phone: 7-15 digits after removing spaces, `-`, `.`, `(`, `)`, optionally led
 * by `+`, and either written with a separator or `+`, or ≥ 10 digits.
 * Date-shaped strings are excluded: a valid ISO date would otherwise match.
 */
export function isPhone(text: string): boolean {
  if (DATE_SHAPED.test(text)) return false;
  const compact = text.replace(/[\s\-.()]/g, '');
  if (!/^\+?\d{7,15}$/.test(compact)) return false;
  const digits = compact.replace('+', '').length;
  return compact !== text || text.includes('+') || digits >= 10;
}

/** ISO/IEC 7812 Luhn check over a digit string. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Card: 13-19 digits (spaces and `-` removed), Luhn-valid. Luhn-positive ids count too (§5.3). */
export function isCard(text: string): boolean {
  const compact = text.replace(/[\s-]/g, '');
  return /^\d{13,19}$/.test(compact) && luhnValid(compact);
}

/** IBAN: shape plus ISO 13616 mod-97 = 1. */
export function isIban(text: string): boolean {
  const compact = text.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : ch;
    for (const digit of chunk) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Identifier-like: a UUID, ≥ 12 consecutive digits, or 16-64 chars mixing letters and digits, no spaces. */
export function isIdentifierLike(text: string): boolean {
  if (UUID.test(text)) return true;
  if (/\d{12,}/.test(text)) return true;
  return (
    text.length >= 16 &&
    text.length <= 64 &&
    !/\s/.test(text) &&
    /[A-Za-z]/.test(text) &&
    /\d/.test(text)
  );
}

/** The PII detectors a string triggers (never the value itself). */
export function piiHits(text: string): PiiDetector[] {
  const t = text.trim();
  if (t === '') return [];
  const hits: PiiDetector[] = [];
  if (isEmail(t)) hits.push('email');
  if (isPhone(t)) hits.push('phone');
  if (isCard(t)) hits.push('card');
  if (isIban(t)) hits.push('iban');
  return hits;
}

// ---------------------------------------------------------------------------
// Field sensitivity and the safe-category gate (§5.3, §5.4)
// ---------------------------------------------------------------------------

export type FieldSensitivity =
  'normal' | 'sensitive_by_name' | 'sensitive_by_value' | 'excluded_opt_in';

export const SAFE_CATEGORY = {
  maxDistinct: 50,
  maxRatio: 0.05,
  maxValueLength: 64,
  minValues: 20,
  /** Accumulators keep at most this many raw candidates (one more than the gate allows). */
  candidateCap: 51,
} as const;

export const SUPPRESSION_REASONS = [
  'excluded',
  'sensitive_name',
  'pii_value',
  'too_few_values',
  'cardinality',
  'cardinality_ratio',
  'value_length',
  'identifier_like',
] as const;
export type CategorySuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** §5.3: (email + phone + card + IBAN hits) ≥ 1% of n, or ≥ 3 values. */
export function sensitivityOf(input: {
  readonly name: string;
  readonly optedIn: boolean;
  readonly piiValueHits: number;
  readonly n: number;
}): FieldSensitivity {
  if (input.optedIn) return 'excluded_opt_in';
  if (isSensitiveName(input.name)) return 'sensitive_by_name';
  if (input.piiValueHits >= 3 || (input.n > 0 && input.piiValueHits / input.n >= 0.01))
    return 'sensitive_by_value';
  return 'normal';
}

export interface GateInput {
  readonly sensitivity: FieldSensitivity;
  readonly declaredEnum: boolean;
  /** Non-null, non-empty values. */
  readonly n: number;
  readonly distinct: number;
  /** The candidate set is complete (no overflow) and every value is ≤ 64 chars. */
  readonly candidatesComplete: boolean;
  readonly anyValueTooLong: boolean;
  readonly piiValueHits: number;
  readonly identifierLikeHits: number;
}

/**
 * The first failing reason, or `null` when the values may be stored. The
 * sample-size condition is checked before cardinality: in a tiny sample every
 * value is rare, and `too_few_values` is the reason that matters.
 */
export function safeCategoryVerdict(g: GateInput): CategorySuppressionReason | null {
  if (g.sensitivity === 'excluded_opt_in') return 'excluded';
  if (g.sensitivity === 'sensitive_by_name') return 'sensitive_name';
  if (g.sensitivity === 'sensitive_by_value') return 'pii_value';
  if (g.n < SAFE_CATEGORY.minValues) return 'too_few_values';
  if (!g.declaredEnum) {
    if (g.distinct > SAFE_CATEGORY.maxDistinct) return 'cardinality';
    if (g.distinct / g.n > SAFE_CATEGORY.maxRatio) return 'cardinality_ratio';
  }
  if (g.anyValueTooLong) return 'value_length';
  if (g.piiValueHits > 0) return 'pii_value';
  if (g.identifierLikeHits > 0) return 'identifier_like';
  // A declared enum may have more distinct values than the candidate cap.
  if (!g.candidatesComplete) return 'cardinality';
  return null;
}

/** A JSON key name may be shown only if it is not secret-like and triggers no detector. */
export function isSafeKeyName(key: string): boolean {
  const n = normaliseName(key);
  if (n === '' || key.length > SAFE_CATEGORY.maxValueLength) return false;
  if (EXCLUDED_NAME_TOKENS.some((t) => n.includes(t))) return false;
  if (/(credential|auth|session|cookie|privatekey|bearer)/.test(n)) return false;
  return piiHits(key).length === 0 && !isIdentifierLike(key);
}

// ---------------------------------------------------------------------------
// Independent raw-value scan (§5.5)
// ---------------------------------------------------------------------------

export class ProfilePrivacyViolationError extends Error {
  readonly code = 'profile_privacy_violation';
  constructor(
    readonly detector: string,
    readonly path: string,
  ) {
    super(`profile document failed the raw-value scan (${detector} at ${path})`);
    this.name = 'ProfilePrivacyViolationError';
  }
}

/** Metadata paths that are hashes or names, not source values. */
const METADATA_PATHS = new Set([
  'schemaSnapshotHash',
  'object',
  'connectionKind',
  'sampling.orderedBy',
]);
/** Field names (declared or seen in data): names, not values. */
const NAME_PATH = /^fields\[\d+\]\.name$|^undeclaredFields\[\d+\]$/;

/**
 * Re-runs every detector over every string value of the document (object keys
 * are field names and codes; they are not scanned). Throws on the first hit.
 * Independent of the gate: it does not trust the builder.
 */
export function assertNoRawValues(document: unknown): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (METADATA_PATHS.has(path) || NAME_PATH.test(path)) return;
      const hit =
        piiHits(value)[0] ?? (isIdentifierLike(value.trim()) ? 'identifier_like' : undefined);
      if (hit) throw new ProfilePrivacyViolationError(hit, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, path === '' ? k : `${path}.${k}`);
      }
    }
  };
  visit(document, '');
}
