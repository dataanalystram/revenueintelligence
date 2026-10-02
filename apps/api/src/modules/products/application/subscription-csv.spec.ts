import { describe, expect, it } from 'vitest';
import { CSV_LIMITS, parseSubscriptionCsv } from './subscription-csv';

const enc = (s: string) => new TextEncoder().encode(s);
const HEADER = 'record_id,account,product,state,starts_at,ends_at,quantity,source_updated_at';

describe('parseSubscriptionCsv (strict operator import)', () => {
  it('parses RFC 4180 quoting, CRLF, BOM and any column order', () => {
    const text =
      '﻿product,record_id,account,state,starts_at,ends_at,quantity,source_updated_at\r\n' +
      '"core","L-1","hubspot:companies:1","active","2026-01-01T00:00:00+01:00","",3,\r\n' +
      'core,L.2,"acme, ""quoted""\nname",trial,,,,\r\n\r\n';
    const r = parseSubscriptionCsv(enc(text));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({
      row: 2,
      recordId: 'L-1',
      account: 'hubspot:companies:1',
      product: 'core',
      state: 'active',
      startsAt: new Date('2025-12-31T23:00:00Z'),
      quantity: 3,
      presence: 'present',
    });
    expect(r.lines[1]).toMatchObject({
      row: 3,
      recordId: 'L.2',
      account: 'acme, "quoted"\nname',
      state: 'trial',
    });
  });

  it('absent rows need only a record id', () => {
    const r = parseSubscriptionCsv(enc(`${HEADER},presence\nL1,,,,,,,,absent\n`));
    expect(r).toMatchObject({ ok: true, lines: [{ recordId: 'L1', presence: 'absent' }] });
  });

  it.each([
    ['L1,a,core,active,2026-01-01T00:00:00,,,', 'ambiguous_timezone', 'starts_at'],
    ['L1,a,core,active,2026-13-01T00:00:00Z,,,', 'invalid_timestamp', 'starts_at'],
    ['L1,a,core,active,2026-02-29T00:00:00Z,,,', 'invalid_timestamp', 'starts_at'],
    ['L1,a,core,active,,,1.5,', 'invalid_quantity', 'quantity'],
    ['L1,a,core,active,,,-1,', 'invalid_quantity', 'quantity'],
    ['L 1,a,core,active,,,,', 'invalid_record_id', 'record_id'],
    ['L1,,core,active,,,,', 'missing_account', 'account'],
    ['L1,a,,active,,,,', 'missing_product', 'product'],
    ['L1,a,core,ACTIVE,,,,', 'invalid_state', 'state'],
  ])('row %s → %s', (row, code, column) => {
    const r = parseSubscriptionCsv(enc(`${HEADER}\n${row}\n`));
    expect(r).toEqual({ ok: false, errors: [{ row: 2, code, column }] });
  });

  it('a leap day in a leap year is valid; equal start and end is allowed (zero-length term)', () => {
    const r = parseSubscriptionCsv(
      enc(`${HEADER}\nL1,a,core,active,2028-02-29T00:00:00Z,2028-02-29T00:00:00Z,,\n`),
    );
    expect(r.ok).toBe(true);
  });

  it('refuses whole files: header, encoding, size, row count, unterminated quote, duplicates', () => {
    expect(parseSubscriptionCsv(enc('record_id,account,product,state,extra\n'))).toMatchObject({
      errors: [{ code: 'invalid_header' }],
    });
    expect(parseSubscriptionCsv(enc(`${HEADER},${'record_id'}\n`))).toMatchObject({
      errors: [{ code: 'invalid_header' }],
    });
    expect(parseSubscriptionCsv(new Uint8Array([0xc3, 0x28]))).toMatchObject({
      errors: [{ code: 'invalid_encoding' }],
    });
    expect(parseSubscriptionCsv(enc('a\u0000b'))).toMatchObject({
      errors: [{ code: 'invalid_encoding' }],
    });
    expect(parseSubscriptionCsv(new Uint8Array(CSV_LIMITS.maxBytes + 1))).toMatchObject({
      errors: [{ code: 'file_too_large' }],
    });
    expect(parseSubscriptionCsv(enc(''))).toMatchObject({ errors: [{ code: 'empty_file' }] });
    expect(parseSubscriptionCsv(enc(`${HEADER}\n"L1,a,core,active,,,,\n`))).toMatchObject({
      errors: [{ code: 'unterminated_quote' }],
    });
    expect(
      parseSubscriptionCsv(enc(`${HEADER}\nL1,a,core,active,,,,\nL1,a,core,active,,,,\n`)),
    ).toMatchObject({
      errors: [{ row: 3, code: 'duplicate_record_id' }],
    });
    const many = `${HEADER}\n${Array.from({ length: CSV_LIMITS.maxRows + 1 }, (_, i) => `L${i},a,core,active,,,,`).join('\n')}`;
    expect(parseSubscriptionCsv(enc(many))).toMatchObject({ errors: [{ code: 'too_many_rows' }] });
  });

  it('never echoes values in errors', () => {
    const r = parseSubscriptionCsv(enc(`${HEADER}\nL1,secret-account-name,core,bogus,,,,\n`));
    expect(JSON.stringify(r)).not.toContain('secret-account-name');
    expect(JSON.stringify(r)).not.toContain('bogus');
  });
});
