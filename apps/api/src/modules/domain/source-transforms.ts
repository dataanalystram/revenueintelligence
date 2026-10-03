import { z } from 'zod';

/**
 * The closed transformation set (ADR 0020 §3): null handling → normalise →
 * parse → value map, each optional, in that fixed order. No expressions,
 * regular-expression capture, arithmetic, conditionals or code.
 */

const Sentinel = z.string().max(50);

/** IANA time zone, validated by the runtime's own zone database. */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'unknown time zone');

export const ParseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('date'),
    /** `YYYY-MM-DD` only. */
    format: z.literal('iso_date'),
    /** The zone a date-only value is interpreted in (never guessed). */
    timeZone: TimeZoneSchema,
    /**
     * The source end date is inclusive: the canonical (exclusive) end is the
     * start of the next day in `timeZone`. Only meaningful for end targets.
     */
    inclusiveEnd: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal('datetime'),
    /** ISO-8601; values without an offset are read in `timeZone`. */
    format: z.literal('iso_datetime'),
    timeZone: TimeZoneSchema,
  }),
  z.strictObject({ type: z.literal('number'), decimalSeparator: z.enum(['.', ',']).default('.') }),
  z.strictObject({ type: z.literal('integer') }),
  z.strictObject({
    type: z.literal('boolean'),
    true: z.array(z.string().min(1).max(50)).min(1).max(20),
    false: z.array(z.string().min(1).max(50)).min(1).max(20),
  }),
]);
export type ParseRule = z.infer<typeof ParseSchema>;

export const TransformsSchema = z
  .strictObject({
    /** Declared sentinel values meaning "no value" (e.g. a literal `NULL`). */
    nullValues: z.array(Sentinel).max(20).optional(),
    normalise: z
      .strictObject({
        collapseWhitespace: z.boolean().optional(),
        case: z.enum(['lower', 'upper']).optional(),
      })
      .optional(),
    parse: ParseSchema.optional(),
    valueMap: z
      .strictObject({
        map: z.record(z.string().max(200), z.string().max(100)),
        /** What a value missing from the map becomes. */
        unmapped: z.enum(['unknown', 'reject_record', 'empty']),
      })
      .optional(),
  })
  .readonly();
export type Transforms = z.infer<typeof TransformsSchema>;

export type RawValue = string | number | boolean | null | undefined;

export type TransformResult =
  | { readonly ok: true; readonly value: string | number | boolean | Date | undefined }
  /** The value maps to the target's `unknown` (unmapped policy `unknown`). */
  | { readonly ok: true; readonly unknown: true; readonly code: 'unmapped_source_enum_value' }
  | {
      readonly ok: false;
      readonly code:
        'invalid_date' | 'invalid_number' | 'invalid_boolean' | 'unmapped_source_enum_value';
      /** True when the entry's policy rejects the whole record. */
      readonly rejectRecord: boolean;
    };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Applies the closed transforms in their fixed order. Pure and total. */
export function applyTransforms(raw: RawValue, transforms: Transforms = {}): TransformResult {
  // 1. Null handling: missing, empty, whitespace and declared sentinels are empty.
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  let value: string | number | boolean = raw;
  if (typeof value === 'string') {
    value = value.trim();
    if (value === '' || (transforms.nullValues ?? []).includes(value)) {
      return { ok: true, value: undefined };
    }
    // 2. Normalise.
    if (transforms.normalise?.collapseWhitespace) value = value.replace(/\s+/g, ' ');
    if (transforms.normalise?.case === 'lower') value = value.toLowerCase();
    if (transforms.normalise?.case === 'upper') value = value.toUpperCase();
  }

  // 3. Parse.
  let parsed: string | number | boolean | Date = value;
  const rule = transforms.parse;
  if (rule) {
    const result = parseValue(value, rule);
    if (!result.ok) return { ok: false, code: result.code, rejectRecord: false };
    parsed = result.value;
  }

  // 4. Value map (string codes only).
  const map = transforms.valueMap;
  if (map) {
    const key = String(parsed);
    if (Object.hasOwn(map.map, key)) return { ok: true, value: map.map[key] };
    if (map.unmapped === 'empty') return { ok: true, value: undefined };
    if (map.unmapped === 'unknown') {
      return { ok: true, unknown: true, code: 'unmapped_source_enum_value' };
    }
    return { ok: false, code: 'unmapped_source_enum_value', rejectRecord: true };
  }
  return { ok: true, value: parsed };
}

type ParseOutcome =
  | { ok: true; value: string | number | boolean | Date }
  | { ok: false; code: 'invalid_date' | 'invalid_number' | 'invalid_boolean' };

function parseValue(value: string | number | boolean, rule: ParseRule): ParseOutcome {
  switch (rule.type) {
    case 'date': {
      const m = typeof value === 'string' ? ISO_DATE.exec(value) : null;
      if (!m) return { ok: false, code: 'invalid_date' };
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!validCalendarDate(y, mo, d)) return { ok: false, code: 'invalid_date' };
      const day = rule.inclusiveEnd ? nextDay(y, mo, d) : { y, mo, d };
      return { ok: true, value: zonedTime(day.y, day.mo, day.d, 0, 0, 0, 0, rule.timeZone) };
    }
    case 'datetime': {
      const m = typeof value === 'string' ? ISO_DATETIME.exec(value) : null;
      if (!m) return { ok: false, code: 'invalid_date' };
      const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const ms = Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3));
      if (!validCalendarDate(y, mo, d) || h > 23 || mi > 59 || s > 59) {
        return { ok: false, code: 'invalid_date' };
      }
      const zone = m[8];
      if (zone) {
        const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}${zone === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`;
        const date = new Date(iso);
        return Number.isNaN(date.getTime())
          ? { ok: false, code: 'invalid_date' }
          : { ok: true, value: date };
      }
      return { ok: true, value: zonedTime(y, mo, d, h, mi, s, ms, rule.timeZone) };
    }
    case 'number': {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? { ok: true, value } : { ok: false, code: 'invalid_number' };
      }
      if (typeof value !== 'string') return { ok: false, code: 'invalid_number' };
      const text = rule.decimalSeparator === ',' ? value.replace(',', '.') : value;
      if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, code: 'invalid_number' };
      return { ok: true, value: Number(text) };
    }
    case 'integer': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (typeof value === 'string' && !/^-?\d+(\.0+)?$/.test(value)) {
        return { ok: false, code: 'invalid_number' };
      }
      return Number.isSafeInteger(n)
        ? { ok: true, value: n }
        : { ok: false, code: 'invalid_number' };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      const text = String(value);
      if (rule.true.includes(text)) return { ok: true, value: true };
      if (rule.false.includes(text)) return { ok: true, value: false };
      return { ok: false, code: 'invalid_boolean' };
    }
  }
}

function validCalendarDate(y: number, mo: number, d: number): boolean {
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function nextDay(y: number, mo: number, d: number): { y: number; mo: number; d: number } {
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return { y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate() };
}

/** The instant at which the wall-clock time occurs in `timeZone` (DST-correct). */
export function zonedTime(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  // Two passes resolve the offset at the target instant, including DST edges.
  let guess = wall - offsetMs(new Date(wall), timeZone);
  guess = wall - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}
