import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyValue } from './classifiers';

const cls = (v: unknown, declaredType?: string) =>
  classifyValue(v, declaredType ? { declaredType } : {});

describe('per-value classifier (M9A §4.1)', () => {
  it('distinguishes null, empty string and whitespace-only', () => {
    expect(cls(null).cls).toBe('null');
    expect(cls(undefined).cls).toBe('null');
    expect(cls('').cls).toBe('empty_string');
    expect(cls('   ').cls).toBe('whitespace_only');
    expect(cls('\t\n').cls).toBe('whitespace_only');
    expect(cls(' a ').cls).toBe('string');
  });

  it('native booleans, integers and decimals', () => {
    expect(cls(true)).toMatchObject({ cls: 'boolean', rep: 'boolean.native' });
    expect(cls(42)).toMatchObject({ cls: 'integer', rep: 'integer.native' });
    expect(cls(1.5)).toMatchObject({ cls: 'decimal', rep: 'decimal.native' });
    // 1 and 0 are integers; only the field rule can treat them as boolean evidence.
    expect(cls(1)).toMatchObject({ cls: 'integer' });
    expect(cls(0)).toMatchObject({ cls: 'integer' });
  });

  it('native, JSON-encoded and delimited arrays are told apart', () => {
    expect(cls(['luc', 'ra', 'ars'])).toMatchObject({
      cls: 'array',
      rep: 'list.native',
      elements: ['luc', 'ra', 'ars'],
    });
    expect(cls('["luc","ra","ars"]')).toMatchObject({
      cls: 'json_array',
      rep: 'list.json',
      elements: ['luc', 'ra', 'ars'],
    });
    expect(cls('luc,ra,ars')).toMatchObject({
      cls: 'string',
      rep: 'list.delimited.comma',
      elements: ['luc', 'ra', 'ars'],
    });
    expect(cls('a;b')).toMatchObject({ rep: 'list.delimited.semicolon' });
    expect(cls('a|b')).toMatchObject({ rep: 'list.delimited.pipe' });
  });

  it('objects native and JSON-encoded record their top-level keys', () => {
    expect(cls({ values: ['luc', 'ra'] })).toMatchObject({
      cls: 'object',
      rep: 'object.native',
      keys: ['values'],
    });
    expect(cls('{"values":["luc","ra"]}')).toMatchObject({
      cls: 'json_object',
      rep: 'json.encoded_string',
      keys: ['values'],
    });
  });

  it('malformed JSON is counted and classification continues', () => {
    for (const v of ['{bad', '[1,']) {
      const c = cls(v);
      expect(c.failures).toContain('malformed_json');
      expect(c.cls).not.toBe('json_array');
      expect(c.cls).not.toBe('json_object');
    }
  });

  it('boolean tokens', () => {
    expect(cls('true')).toMatchObject({ cls: 'boolean', rep: 'boolean.token_true_false' });
    expect(cls('FALSE')).toMatchObject({ rep: 'boolean.token_true_false' });
    expect(cls('yes')).toMatchObject({ rep: 'boolean.token_yes_no' });
    expect(cls('No')).toMatchObject({ rep: 'boolean.token_yes_no' });
    expect(cls('Y')).toMatchObject({ rep: 'boolean.token_y_n' });
    expect(cls('n')).toMatchObject({ rep: 'boolean.token_y_n' });
    expect(cls('t')).toMatchObject({ rep: 'boolean.token_t_f' });
    expect(cls('F')).toMatchObject({ rep: 'boolean.token_t_f' });
    // String "1"/"0" are integers, never boolean tokens.
    expect(cls('1')).toMatchObject({ cls: 'integer', rep: 'integer.string' });
    expect(cls('0')).toMatchObject({ cls: 'integer', rep: 'integer.string' });
  });

  it('leading zeros are strings, comma decimals are never numbers', () => {
    expect(cls('007')).toMatchObject({
      cls: 'string',
      rep: 'string.leading_zero',
      failures: ['leading_zero_numeric'],
    });
    expect(cls('-12')).toMatchObject({ cls: 'integer' });
    expect(cls('12.50')).toMatchObject({ cls: 'decimal', rep: 'decimal.string' });
    expect(cls('12,50')).toMatchObject({ cls: 'string', failures: ['number_locale'] });
    expect(cls('1.234,56')).toMatchObject({ cls: 'string', failures: ['number_locale'] });
  });

  it('dates: ISO valid and invalid, d/m/y, m/d/y, ambiguous and impossible', () => {
    expect(cls('2025-01-31')).toMatchObject({ cls: 'date', rep: 'date.iso' });
    expect(cls('2025-02-30')).toMatchObject({ cls: 'string', failures: ['invalid_date'] });
    expect(cls('2024-02-29')).toMatchObject({ cls: 'date' });
    expect(cls('31/01/2025')).toMatchObject({ cls: 'date', rep: 'date.dmy' });
    expect(cls('01/31/2025')).toMatchObject({ cls: 'date', rep: 'date.mdy' });
    expect(cls('01/02/2025')).toMatchObject({ cls: 'string', failures: ['ambiguous_date'] });
    expect(cls('13/13/2025')).toMatchObject({ cls: 'string', failures: ['invalid_date'] });
    expect(cls('31/02/2025')).toMatchObject({ cls: 'string', failures: ['invalid_date'] });
  });

  it('timestamps with Z, offset and naive; invalid ones counted', () => {
    expect(cls('2025-01-31T10:00:00Z')).toMatchObject({ cls: 'timestamp', rep: 'timestamp.iso_z' });
    expect(cls('2025-01-31T10:00:00+01:00')).toMatchObject({ rep: 'timestamp.iso_offset' });
    expect(cls('2025-01-31 10:00')).toMatchObject({ rep: 'timestamp.iso_naive' });
    expect(cls('2025-01-31T25:00:00Z')).toMatchObject({
      cls: 'string',
      failures: ['invalid_date'],
    });
  });

  it('unix seconds and milliseconds only when the field is declared a date type', () => {
    expect(cls(1_700_000_000)).toMatchObject({ cls: 'integer' });
    expect(cls(1_700_000_000, 'datetime')).toMatchObject({
      cls: 'timestamp',
      rep: 'timestamp.unix_s',
    });
    expect(cls(1_700_000_000_000, 'date')).toMatchObject({
      cls: 'timestamp',
      rep: 'timestamp.unix_ms',
    });
    expect(cls(1_700_000_000_000, 'number')).toMatchObject({ cls: 'integer' });
    expect(cls(42, 'datetime')).toMatchObject({ cls: 'integer' });
  });

  it('delimited lists need short tokens and pick the delimiter with most tokens', () => {
    expect(cls('a,b,c;d')).toMatchObject({
      rep: 'list.delimited.comma',
      failures: ['ambiguous_delimiter'],
    });
    expect(cls('a,b;c;d')).toMatchObject({
      rep: 'list.delimited.semicolon',
      failures: ['ambiguous_delimiter'],
    });
    // Long tokens with many spaces are prose, not a list.
    expect(cls('this is a long sentence, with a clause').rep).toBeUndefined();
    // ≥ 30% empty tokens is not a list.
    expect(cls('a,,').rep).toBeUndefined();
  });

  it('strings: ≤ 255 chars string, longer text; > 64 KiB skips parsing', () => {
    expect(cls('x'.repeat(255)).cls).toBe('string');
    expect(cls('x'.repeat(256)).cls).toBe('text');
    expect(cls(`[${'1,'.repeat(40_000)}1]`).cls).toBe('text');
  });

  it('is total and deterministic over arbitrary JSON values and long strings', () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.string({ maxLength: 2000 }), fc.anything()), (v) => {
        const a = classifyValue(v);
        const b = classifyValue(v);
        expect(a).toEqual(b);
      }),
      { numRuns: 500 },
    );
    const long = 'a'.repeat(70 * 1024);
    expect(() => classifyValue(long)).not.toThrow();
  });
});
