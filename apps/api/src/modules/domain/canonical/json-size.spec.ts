import { describe, expect, it } from 'vitest';
import { jsonbText, jsonbTextBytes } from './json-size';

describe('jsonbTextBytes (M10A2 review m6)', () => {
  it('renders with jsonb separators', () => {
    expect(jsonbText({ a: 1, b: [1, 'x', null, true] })).toBe(
      '{"a": 1, "b": [1, "x", null, true]}',
    );
    expect(jsonbText(null)).toBe('null');
    expect(jsonbText(undefined)).toBe('null');
    expect(jsonbText({ a: undefined, b: 2 })).toBe('{"b": 2}');
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // '"é"' = 1 + 2 + 1 bytes; JSON.stringify length would say 3.
    expect(jsonbTextBytes('é')).toBe(4);
    // '"😀"' = 1 + 4 + 1 bytes; JSON.stringify length would say 4.
    expect(jsonbTextBytes('😀')).toBe(6);
    expect(jsonbTextBytes({ clé: '😀' })).toBe(Buffer.byteLength('{"clé": "😀"}', 'utf8'));
  });

  it('is never smaller than the compact UTF-8 size', () => {
    for (const v of [{ a: 'é'.repeat(100) }, ['😀', 'x', { b: [1, 2] }], 'plain', 12.5]) {
      expect(jsonbTextBytes(v)).toBeGreaterThanOrEqual(
        Buffer.byteLength(JSON.stringify(v), 'utf8'),
      );
    }
  });

  it('puts a multibyte value over a limit that string length would pass', () => {
    const v = 'é'.repeat(3000);
    expect(JSON.stringify(v).length).toBeLessThan(4096);
    expect(jsonbTextBytes(v)).toBeGreaterThan(4096);
  });
});
