/**
 * Per-value classification for source profiling (ADR 0022, M9A plan §4.1).
 * Deterministic, total (never throws) and bounded per value: strings longer
 * than 64 KiB skip parsing. The first matching rule wins. The input value is
 * never stored by the classifier; callers fold the result into accumulators
 * and discard the value.
 */

export const OBSERVED_TYPES = [
  'boolean',
  'integer',
  'decimal',
  'date',
  'timestamp',
  'string',
  'text',
  'json_array',
  'json_object',
  'array',
  'object',
] as const;
export type ObservedType = (typeof OBSERVED_TYPES)[number];

export type ValueClass = 'null' | 'empty_string' | 'whitespace_only' | ObservedType;

export const PARSE_FAILURES = [
  'malformed_json',
  'invalid_date',
  'ambiguous_date',
  'number_locale',
  'leading_zero_numeric',
  'ambiguous_delimiter',
] as const;
export type ParseFailure = (typeof PARSE_FAILURES)[number];

/** Representation codes (§3.2, §4.2). Closed list: documents carry codes, never formats. */
export const REPRESENTATIONS = [
  'boolean.native',
  'boolean.token_true_false',
  'boolean.token_yes_no',
  'boolean.token_y_n',
  'boolean.token_t_f',
  'integer.native',
  'integer.string',
  'decimal.native',
  'decimal.string',
  'string.leading_zero',
  'date.iso',
  'date.dmy',
  'date.mdy',
  'timestamp.iso_offset',
  'timestamp.iso_z',
  'timestamp.iso_naive',
  'timestamp.unix_s',
  'timestamp.unix_ms',
  'list.native',
  'list.json',
  'list.delimited.comma',
  'list.delimited.semicolon',
  'list.delimited.pipe',
  'object.native',
  'json.encoded_string',
] as const;
export type Representation = (typeof REPRESENTATIONS)[number];

/** The logical class a representation belongs to (mixed-representation rule, §4.2). */
export function logicalClassOf(
  rep: Representation,
): 'boolean' | 'date' | 'timestamp' | 'list' | 'other' {
  if (rep.startsWith('boolean.')) return 'boolean';
  if (rep.startsWith('date.')) return 'date';
  if (rep.startsWith('timestamp.')) return 'timestamp';
  if (rep.startsWith('list.')) return 'list';
  return 'other';
}

export const MAX_PARSED_LENGTH = 64 * 1024;
export const STRING_MAX_LENGTH = 255;

/** Declared context that changes how a value reads (§4.1 notes). */
export interface ClassifyContext {
  /** The snapshot's declared type: integers read as unix timestamps only for `date`/`datetime`. */
  readonly declaredType?: string;
}

export interface Classified {
  readonly cls: ValueClass;
  readonly rep?: Representation;
  readonly failures: readonly ParseFailure[];
  /** String length in characters (strings only, before trimming). */
  readonly length?: number;
  /** List elements (depth 1): native arrays, JSON arrays and delimited strings. */
  readonly elements?: readonly unknown[];
  /** Top-level key names of objects (native or JSON-encoded). */
  readonly keys?: readonly string[];
  /** Nesting depth of a structured value (1 = flat). */
  readonly depth?: number;
  /** A numeric value for range buckets (numbers only). */
  readonly number?: number;
  /** Year and month for date/timestamp range buckets. */
  readonly yearMonth?: { readonly year: number; readonly month: number };
}

const BOOLEAN_TOKENS: ReadonlyArray<[RegExp, Representation]> = [
  [/^(true|false)$/i, 'boolean.token_true_false'],
  [/^(yes|no)$/i, 'boolean.token_yes_no'],
  [/^(y|n)$/i, 'boolean.token_y_n'],
  [/^(t|f)$/i, 'boolean.token_t_f'],
];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const DMY_LIKE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?\d+\.\d+$/;
const LOCALE_NUMBER = /^[+-]?\d{1,3}(\.\d{3})+,\d+$|^[+-]?\d+,\d+$/;

export function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function depthOf(value: unknown, level = 1): number {
  if (level > 32) return level;
  if (Array.isArray(value)) {
    let d = level;
    for (const v of value) if (v && typeof v === 'object') d = Math.max(d, depthOf(v, level + 1));
    return d;
  }
  if (value && typeof value === 'object') {
    let d = level;
    for (const v of Object.values(value as Record<string, unknown>))
      if (v && typeof v === 'object') d = Math.max(d, depthOf(v, level + 1));
    return d;
  }
  return level;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Rule 14: a delimited list, or undefined. */
function delimitedList(
  text: string,
): { rep: Representation; elements: string[]; ambiguous: boolean } | undefined {
  const candidates: Array<{ rep: Representation; elements: string[] }> = [];
  const delimiters: ReadonlyArray<[string, Representation]> = [
    [',', 'list.delimited.comma'],
    [';', 'list.delimited.semicolon'],
    ['|', 'list.delimited.pipe'],
  ];
  for (const [d, rep] of delimiters) {
    if (!text.includes(d)) continue;
    const tokens = text.split(d).map((t) => t.trim());
    if (tokens.length < 2) continue;
    const empty = tokens.filter((t) => t === '').length;
    if (empty / tokens.length >= 0.3) continue;
    const ok = tokens.every(
      (t) => t === '' || (t.length <= 64 && (t.match(/ /g)?.length ?? 0) <= 1),
    );
    if (!ok) continue;
    candidates.push({ rep, elements: tokens.filter((t) => t !== '') });
  }
  if (candidates.length === 0) return undefined;
  // Most tokens wins; ties keep the earlier delimiter (comma < semicolon < pipe).
  let best = candidates[0]!;
  for (const c of candidates.slice(1)) if (c.elements.length > best.elements.length) best = c;
  return { ...best, ambiguous: candidates.length > 1 };
}

function classifyString(raw: string, ctx: ClassifyContext): Classified {
  const length = raw.length;
  if (raw === '') return { cls: 'empty_string', failures: [], length };
  const text = raw.trim();
  if (text === '') return { cls: 'whitespace_only', failures: [], length };
  if (length > MAX_PARSED_LENGTH) return { cls: 'text', failures: [], length };
  const failures: ParseFailure[] = [];

  // 9: JSON-encoded structures.
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return {
          cls: 'json_array',
          rep: 'list.json',
          failures,
          length,
          elements: parsed,
          depth: depthOf(parsed),
        };
      }
      if (isPlainObject(parsed)) {
        return {
          cls: 'json_object',
          rep: 'json.encoded_string',
          failures,
          length,
          keys: Object.keys(parsed),
          depth: depthOf(parsed),
        };
      }
    } catch {
      // fall through
    }
    failures.push('malformed_json');
  }
  // 10: boolean tokens.
  for (const [re, rep] of BOOLEAN_TOKENS) {
    if (re.test(text)) return { cls: 'boolean', rep, failures, length };
  }
  // 11: integers.
  if (INTEGER.test(text)) {
    const digits = text.replace(/^[+-]/, '');
    if (digits.length > 1 && digits.startsWith('0')) {
      failures.push('leading_zero_numeric');
      return { cls: 'string', rep: 'string.leading_zero', failures, length };
    }
    return { cls: 'integer', rep: 'integer.string', failures, length, number: Number(text) };
  }
  // 12: decimals (dot).
  if (DECIMAL.test(text)) {
    return { cls: 'decimal', rep: 'decimal.string', failures, length, number: Number(text) };
  }
  // 12b: comma decimals are never numbers.
  if (LOCALE_NUMBER.test(text)) {
    failures.push('number_locale');
    return { cls: 'string', failures, length };
  }
  // 13: ISO date.
  const iso = ISO_DATE.exec(text);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (isCalendarDate(y, m, d))
      return { cls: 'date', rep: 'date.iso', failures, length, yearMonth: { year: y, month: m } };
    failures.push('invalid_date');
    return { cls: 'string', failures, length };
  }
  // 13b: ISO timestamp.
  const ts = ISO_TIMESTAMP.exec(text);
  if (ts) {
    const [y, m, d, hh, mm, ss] = [1, 2, 3, 4, 5, 6].map((i) => Number(ts[i] ?? 0)) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const zone = ts[7];
    if (isCalendarDate(y, m, d) && hh <= 23 && mm <= 59 && ss <= 59) {
      const rep: Representation =
        zone === undefined
          ? 'timestamp.iso_naive'
          : zone === 'Z'
            ? 'timestamp.iso_z'
            : 'timestamp.iso_offset';
      return { cls: 'timestamp', rep, failures, length, yearMonth: { year: y, month: m } };
    }
    failures.push('invalid_date');
    return { cls: 'string', failures, length };
  }
  // 13c: day/month/year forms.
  const dmy = DMY_LIKE.exec(text);
  if (dmy) {
    const [a, b, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
    if (a > 12 && b <= 12 && isCalendarDate(y, b, a))
      return { cls: 'date', rep: 'date.dmy', failures, length, yearMonth: { year: y, month: b } };
    if (b > 12 && a <= 12 && isCalendarDate(y, a, b))
      return { cls: 'date', rep: 'date.mdy', failures, length, yearMonth: { year: y, month: a } };
    if (
      a <= 12 &&
      b <= 12 &&
      a >= 1 &&
      b >= 1 &&
      isCalendarDate(y, a, b) &&
      isCalendarDate(y, b, a)
    ) {
      failures.push('ambiguous_date');
      return { cls: 'string', failures, length };
    }
    failures.push('invalid_date');
    return { cls: 'string', failures, length };
  }
  // 14: delimited lists.
  const list = delimitedList(text);
  if (list) {
    if (list.ambiguous) failures.push('ambiguous_delimiter');
    return {
      cls: length <= STRING_MAX_LENGTH ? 'string' : 'text',
      rep: list.rep,
      failures,
      length,
      elements: list.elements,
    };
  }
  // 15: plain strings.
  void ctx;
  return { cls: length <= STRING_MAX_LENGTH ? 'string' : 'text', failures, length };
}

/** Classifies one value as the adapter returned it. Total: any input yields a class. */
export function classifyValue(value: unknown, ctx: ClassifyContext = {}): Classified {
  if (value === null || value === undefined) return { cls: 'null', failures: [] };
  if (typeof value === 'string') return classifyString(value, ctx);
  if (typeof value === 'boolean') return { cls: 'boolean', rep: 'boolean.native', failures: [] };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { cls: 'string', failures: [] };
    if (Number.isInteger(value)) {
      // Native integers are timestamps only when the snapshot declares a date type.
      if (ctx.declaredType === 'date' || ctx.declaredType === 'datetime') {
        const unix: Representation | undefined =
          value >= 1e9 && value < 1e10
            ? 'timestamp.unix_s'
            : value >= 1e12 && value < 1e13
              ? 'timestamp.unix_ms'
              : undefined;
        if (unix) {
          const d = new Date(unix === 'timestamp.unix_s' ? value * 1000 : value);
          return {
            cls: 'timestamp',
            rep: unix,
            failures: [],
            yearMonth: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 },
          };
        }
      }
      return { cls: 'integer', rep: 'integer.native', failures: [], number: value };
    }
    return { cls: 'decimal', rep: 'decimal.native', failures: [], number: value };
  }
  if (typeof value === 'bigint') {
    return { cls: 'integer', rep: 'integer.native', failures: [], number: Number(value) };
  }
  if (Array.isArray(value)) {
    return {
      cls: 'array',
      rep: 'list.native',
      failures: [],
      elements: value,
      depth: depthOf(value),
    };
  }
  if (isPlainObject(value)) {
    return {
      cls: 'object',
      rep: 'object.native',
      failures: [],
      keys: Object.keys(value),
      depth: depthOf(value),
    };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { cls: 'string', failures: ['invalid_date'] };
    return {
      cls: 'timestamp',
      rep: 'timestamp.iso_z',
      failures: [],
      yearMonth: { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1 },
    };
  }
  return { cls: 'string', failures: [] };
}

/** True for classes that carry a value (not null, empty or whitespace-only). */
export function isSubstantive(cls: ValueClass): cls is ObservedType {
  return cls !== 'null' && cls !== 'empty_string' && cls !== 'whitespace_only';
}
