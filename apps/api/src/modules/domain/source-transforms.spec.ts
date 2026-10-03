import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyTransforms, TransformsSchema, zonedTime } from './source-transforms';

const SEED = Number(process.env.FC_SEED ?? 20261002);
const RUNS = Number(process.env.FC_RUNS ?? 300);
fc.configureGlobal({ seed: SEED, numRuns: RUNS });

const date = (tz = 'UTC', inclusiveEnd = false) =>
  TransformsSchema.parse({
    parse: { type: 'date', format: 'iso_date', timeZone: tz, inclusiveEnd },
  });

describe('closed transforms (ADR 0020 §3)', () => {
  it('null handling: missing, empty, whitespace and declared sentinels are empty', () => {
    const t = TransformsSchema.parse({ nullValues: ['NULL'] });
    for (const raw of [null, undefined, '', '   ', 'NULL', ' NULL ']) {
      expect(applyTransforms(raw, t)).toEqual({ ok: true, value: undefined });
    }
    // Only declared sentinels: 'null' (lower case) is a value.
    expect(applyTransforms('null', t)).toEqual({ ok: true, value: 'null' });
  });

  it('normalises in a fixed order (trim, collapse, case)', () => {
    const t = TransformsSchema.parse({ normalise: { collapseWhitespace: true, case: 'lower' } });
    expect(applyTransforms('  Closed   WON ', t)).toEqual({ ok: true, value: 'closed won' });
  });

  it('parses date-only values in the declared zone; an inclusive end becomes the next day start', () => {
    expect(applyTransforms('2026-12-31', date())).toEqual({
      ok: true,
      value: new Date('2026-12-31T00:00:00.000Z'),
    });
    expect(applyTransforms('2026-12-31', date('UTC', true))).toEqual({
      ok: true,
      value: new Date('2027-01-01T00:00:00.000Z'),
    });
    // British Summer Time: local midnight is 23:00 UTC the day before.
    expect(applyTransforms('2026-07-01', date('Europe/London'))).toEqual({
      ok: true,
      value: new Date('2026-06-30T23:00:00.000Z'),
    });
    expect(applyTransforms('2026-01-15', date('Europe/London'))).toEqual({
      ok: true,
      value: new Date('2026-01-15T00:00:00.000Z'),
    });
  });

  it('refuses unparseable and impossible dates (never guessed)', () => {
    for (const raw of [
      '2025-02-30',
      '31/12/2025',
      '2025-13-01',
      '2025-1-1',
      'tomorrow',
      '20250101',
    ]) {
      expect(applyTransforms(raw, date())).toEqual({
        ok: false,
        code: 'invalid_date',
        rejectRecord: false,
      });
    }
  });

  it('datetimes: an explicit offset wins; a zone-less value is read in the declared zone', () => {
    const t = TransformsSchema.parse({
      parse: { type: 'datetime', format: 'iso_datetime', timeZone: 'America/New_York' },
    });
    expect(applyTransforms('2026-03-01T10:00:00Z', t)).toEqual({
      ok: true,
      value: new Date('2026-03-01T10:00:00.000Z'),
    });
    expect(applyTransforms('2026-03-01T10:00:00+01:00', t)).toEqual({
      ok: true,
      value: new Date('2026-03-01T09:00:00.000Z'),
    });
    expect(applyTransforms('2026-03-01 10:00:00', t)).toEqual({
      ok: true,
      value: new Date('2026-03-01T15:00:00.000Z'),
    });
  });

  it('refuses an unknown time zone in the document', () => {
    expect(
      TransformsSchema.safeParse({
        parse: { type: 'date', format: 'iso_date', timeZone: 'Mars/Olympus' },
      }).success,
    ).toBe(false);
  });

  it('numbers, integers and booleans parse only exact forms', () => {
    const int = TransformsSchema.parse({ parse: { type: 'integer' } });
    expect(applyTransforms('5', int)).toEqual({ ok: true, value: 5 });
    expect(applyTransforms('5.0', int)).toEqual({ ok: true, value: 5 });
    expect(applyTransforms('5.5', int)).toMatchObject({ ok: false, code: 'invalid_number' });
    expect(applyTransforms('1e3', int)).toMatchObject({ ok: false, code: 'invalid_number' });
    const num = TransformsSchema.parse({ parse: { type: 'number', decimalSeparator: ',' } });
    expect(applyTransforms('12,50', num)).toEqual({ ok: true, value: 12.5 });
    const bool = TransformsSchema.parse({
      parse: { type: 'boolean', true: ['True'], false: ['False'] },
    });
    expect(applyTransforms('True', bool)).toEqual({ ok: true, value: true });
    expect(applyTransforms('yes', bool)).toMatchObject({ ok: false, code: 'invalid_boolean' });
  });

  it('value maps follow the declared unmapped policy', () => {
    const map = (unmapped: 'unknown' | 'reject_record' | 'empty') =>
      TransformsSchema.parse({ valueMap: { map: { Active: 'active' }, unmapped } });
    expect(applyTransforms('Active', map('unknown'))).toEqual({ ok: true, value: 'active' });
    expect(applyTransforms('ZZ', map('unknown'))).toEqual({
      ok: true,
      unknown: true,
      code: 'unmapped_source_enum_value',
    });
    expect(applyTransforms('ZZ', map('empty'))).toEqual({ ok: true, value: undefined });
    expect(applyTransforms('ZZ', map('reject_record'))).toEqual({
      ok: false,
      code: 'unmapped_source_enum_value',
      rejectRecord: true,
    });
    // Inherited object keys are not map entries.
    expect(applyTransforms('toString', map('empty'))).toEqual({ ok: true, value: undefined });
  });

  it('the document schema is closed: no expression or script slot exists', () => {
    for (const extra of [{ expression: 'a+b' }, { script: 'x' }, { regex: '(.*)' }]) {
      expect(TransformsSchema.safeParse(extra).success).toBe(false);
    }
  });

  describe('properties', () => {
    it('is total: never throws, whatever the input', () => {
      const raw = fc.oneof(fc.string(), fc.integer(), fc.double(), fc.boolean(), fc.constant(null));
      const rules = fc.constantFrom(
        {},
        { parse: { type: 'date', format: 'iso_date', timeZone: 'Europe/London' } },
        { parse: { type: 'datetime', format: 'iso_datetime', timeZone: 'UTC' } },
        { parse: { type: 'integer' } },
        { parse: { type: 'number' } },
        { valueMap: { map: { a: 'b' }, unmapped: 'unknown' } },
      );
      fc.assert(
        fc.property(raw, rules, (value, rule) => {
          applyTransforms(value, TransformsSchema.parse(rule));
        }),
      );
    });

    it('a valid date parses to midnight of that day in the zone (round trip)', () => {
      fc.assert(
        fc.property(
          fc.date({
            min: new Date('1990-01-01Z'),
            max: new Date('2100-12-31Z'),
            noInvalidDate: true,
          }),
          fc.constantFrom('UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata'),
          (d, tz) => {
            const iso = d.toISOString().slice(0, 10);
            const result = applyTransforms(iso, date(tz));
            const local = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(
              (result as { value: Date }).value,
            );
            expect(local).toBe(iso);
          },
        ),
      );
    });

    it('zonedTime is the inverse of formatting in the zone', () => {
      expect(zonedTime(2026, 3, 29, 12, 0, 0, 0, 'Europe/London')).toEqual(
        new Date('2026-03-29T11:00:00.000Z'),
      );
    });
  });
});
