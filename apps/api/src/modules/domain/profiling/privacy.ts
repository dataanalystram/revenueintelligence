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
/** An address inside longer text (free-text values): counted as an email hit too. */
const EMBEDDED_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Calendar-looking strings (ISO date/timestamp, d/m/y): never phone numbers. */
const DATE_SHAPED =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/;

export function isEmail(text: string): boolean {
  return EMAIL.test(text);
}

/** Whole-value email, or an address embedded in longer text (conservative: only suppresses). */
export function containsEmail(text: string): boolean {
  return EMAIL.test(text) || EMBEDDED_EMAIL.test(text);
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
  if (containsEmail(t)) hits.push('email');
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

// ---------------------------------------------------------------------------
// Schema-name privacy (M9A closure fix): names are source-controlled content
// ---------------------------------------------------------------------------

/**
 * Why a source-provided name (object, field, undeclared key, JSON key) cannot
 * be stored verbatim. Names are source-controlled: a field may be called
 * `acct_4111111111111111`. Deliberately broader than the value detectors
 * (an over-match only replaces a readable name by a token).
 */
export type SchemaNameHit = PiiDetector | 'identifier_like' | 'invalid_name';

const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const NAME_UUID = /[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}/i;
/** A run of digits whose groups are joined only by separators (`4111_1111_1111_1111`, `44_20_7946_0958`). */
const NAME_DIGIT_RUN = /\d(?:[\s_\-.()+/]?\d)*/g;

/** The schema-name detectors a name triggers (never the name itself). */
export function schemaNameHits(name: string): SchemaNameHit[] {
  const hits = new Set<SchemaNameHit>();
  if (!API_NAME.test(name)) hits.add('invalid_name');
  for (const h of piiHits(name)) hits.add(h);
  if (name.includes('@')) hits.add('email');
  for (const run of name.match(NAME_DIGIT_RUN) ?? []) {
    const digits = run.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) hits.add('card');
    else if (digits.length >= 7) hits.add(digits.length <= 15 ? 'phone' : 'identifier_like');
  }
  // IBAN as one token or grouped over consecutive tokens (`GB82_WEST_1234_…`).
  const tokens = name.split(/[^A-Za-z0-9]+/).filter((t) => t !== '');
  for (let i = 0; i < tokens.length && !hits.has('iban'); i++) {
    let joined = '';
    for (let j = i; j < tokens.length && joined.length < 34; j++) {
      joined += tokens[j];
      if (joined.length >= 15 && isIban(joined)) {
        hits.add('iban');
        break;
      }
    }
  }
  if (NAME_UUID.test(name)) hits.add('identifier_like');
  // One token of 16-64 characters mixing letters and digits (per token, so `address_line_2__c` stays readable).
  if (tokens.some((t) => t.length >= 16 && /[A-Za-z]/.test(t) && /\d/.test(t)))
    hits.add('identifier_like');
  return [...hits];
}

/** Tokens replacing names that cannot be stored; a source name of this form is itself replaced (no collision). */
export const REDACTED_NAME_PREFIX = 'redacted_field_';
const REDACTED_NAME = /^redacted_field_\d+$/;

/** Whether a source-provided name must be replaced before it is stored, logged or printed. */
export function isRedactedName(name: string): boolean {
  return REDACTED_NAME.test(name) || schemaNameHits(name).length > 0;
}

/**
 * The profile names of an object's declared fields: `redacted_field_<n>` (n
 * from 1, by sorted source name) for every name that cannot be stored, the
 * name itself otherwise. A pure function of the snapshot's declared names, so
 * every profile of the same snapshot, the worker and the mapping validator
 * agree; the token carries nothing of the name (no hash of a low-entropy value).
 */
export interface ProfileNames {
  /** Source name → profile name. */
  toProfile(name: string): string;
  /** Profile name (token or plain) → source name, if declared. */
  toSource(name: string): string | undefined;
  isRedacted(name: string): boolean;
}

export function profileNames(declared: readonly string[]): ProfileNames {
  const sorted = [...new Set(declared)].sort();
  const forward = new Map<string, string>();
  const back = new Map<string, string>();
  let n = 0;
  for (const name of sorted) {
    const out = isRedactedName(name) ? `${REDACTED_NAME_PREFIX}${++n}` : name;
    forward.set(name, out);
    back.set(out, name);
  }
  return {
    // An undeclared name that cannot be stored gets the reserved token 0.
    toProfile: (name) =>
      forward.get(name) ?? (isRedactedName(name) ? `${REDACTED_NAME_PREFIX}0` : name),
    toSource: (name) => back.get(name),
    isRedacted: (name) => (forward.get(name) ?? name) !== name || isRedactedName(name),
  };
}

/** A name for an operator message: withheld when it cannot be stored. */
export function displayName(name: string): string {
  return isRedactedName(name) ? '(name withheld)' : name;
}

/** A JSON key name may be shown only if it is not secret-like and triggers no detector. */
export function isSafeKeyName(key: string): boolean {
  const n = normaliseName(key);
  if (n === '' || key.length > SAFE_CATEGORY.maxValueLength) return false;
  if (EXCLUDED_NAME_TOKENS.some((t) => n.includes(t))) return false;
  if (/(credential|auth|session|cookie|privatekey|bearer)/.test(n)) return false;
  return piiHits(key).length === 0 && !isIdentifierLike(key) && !isRedactedName(key);
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
/**
 * Paths holding source-provided names (object, field, undeclared and JSON key
 * names): scanned with the schema-name detectors. Nothing is exempt because
 * it is "a name" — a name is source-controlled content.
 */
const NAME_PATHS = /^(object|sampling\.orderedBy|fields\[\d+\]\.name|undeclaredFields\[\d+\])$/;
/** JSON key names get both the value and the schema-name detectors. */
const KEY_PATH = /^fields\[\d+\]\.json\.topLevelKeys\[\d+\]$/;
/**
 * The single exemption: the snapshot hash is computed by the platform
 * (SHA-256 hex), never source-provided. A 64-character lower-case hex string
 * cannot hold an email, phone, card or IBAN; it is identifier-like by design.
 * Anything else at this path is scanned.
 */
const HASH_PATH = 'schemaSnapshotHash';
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Re-runs every detector over every string value of the document (object keys
 * are schema codes; they are not scanned). Throws on the first hit.
 * Independent of the gate and of the name redaction: it does not trust the builder.
 */
export function assertNoRawValues(document: unknown): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (path === HASH_PATH && SHA256_HEX.test(value)) return;
      if (NAME_PATHS.test(path)) {
        const hit = schemaNameHits(value)[0];
        if (hit) throw new ProfilePrivacyViolationError(hit, path);
        return;
      }
      const hit =
        piiHits(value)[0] ??
        (isIdentifierLike(value.trim()) ? 'identifier_like' : undefined) ??
        (KEY_PATH.test(path) ? schemaNameHits(value)[0] : undefined);
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
