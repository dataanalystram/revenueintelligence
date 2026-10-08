import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SourceField, SourceObject } from '../source-connector';
import { objectAccumulatorFor } from './accumulators';
import { buildProfileDocument, type FieldProfile } from './document';
import {
  assertNoRawValues,
  isCard,
  isEmail,
  isExcludedName,
  isIban,
  isIdentifierLike,
  isPhone,
  isSafeKeyName,
  isSensitiveName,
  luhnValid,
  piiHits,
  ProfilePrivacyViolationError,
} from './privacy';

const SNAP = 'c'.repeat(64);

function object(field: Partial<SourceField> & { name: string }): SourceObject {
  return {
    name: 'Things',
    classification: 'record',
    capabilities: { pagination: 'offset', deleteVisibility: 'none', count: true, maxPageSize: 100 },
    fields: [{ type: 'string', required: false, unique: false, ...field }],
  };
}

/** Profiles one field over `values` and returns its field profile. */
function profileField(
  values: readonly unknown[],
  field: Partial<SourceField> & { name: string } = { name: 'status' },
): FieldProfile {
  const obj = object(field);
  const acc = objectAccumulatorFor(obj, [field.name]);
  for (const v of values) acc.addRecord({ [field.name]: v });
  const doc = buildProfileDocument({
    object: obj,
    connectionKind: 'test',
    schemaSnapshotHash: SNAP,
    accumulator: acc,
    sampling: {
      method: 'full',
      populationEstimate: values.length,
      bounded: false,
      stride: null,
      orderedBy: null,
      evidence: [],
    },
    maxRows: 250_000,
    distinctCap: 10_000,
    optedIn: new Set(),
  });
  return doc.fields[0]!;
}

/** `distinct` values ("S01"…), spread over `n` rows. */
function statuses(distinct: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `S${String((i % distinct) + 1).padStart(2, '0')}`);
}

/** A 16-digit, Luhn-valid number that is not a card (an order number). */
function luhnOrderNumber(): string {
  const base = '100000000012345';
  for (let d = 0; d <= 9; d++) if (luhnValid(base + d)) return base + d;
  throw new Error('unreachable');
}

describe('value detectors (M9A §5.3)', () => {
  it('email', () => {
    expect(isEmail('ada@example.com')).toBe(true);
    expect(isEmail('ada@example')).toBe(false);
    expect(isEmail('not an email')).toBe(false);
  });

  it('phone: with and without separators', () => {
    expect(isPhone('+44 20 7946 0958')).toBe(true);
    expect(isPhone('(020) 7946-0958')).toBe(true);
    expect(isPhone('02079460958')).toBe(true); // ≥ 10 digits
    expect(isPhone('1234567')).toBe(false); // 7 digits, no separator
    expect(isPhone('123-4567')).toBe(true); // separator
    expect(isPhone('123')).toBe(false);
    // Dates are never phone numbers.
    expect(isPhone('2025-01-31')).toBe(false);
    expect(isPhone('31/01/2025')).toBe(false);
  });

  it('card: Luhn valid and invalid; a Luhn-positive order number counts (accepted)', () => {
    expect(isCard('4111 1111 1111 1111')).toBe(true);
    expect(isCard('4111-1111-1111-1112')).toBe(false);
    expect(isCard(luhnOrderNumber())).toBe(true);
    expect(isCard('123456789012')).toBe(false); // 12 digits
  });

  it('IBAN: mod-97 valid and invalid', () => {
    expect(isIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(isIban('GB82WEST12345698765433')).toBe(false);
    expect(isIban('XX00')).toBe(false);
  });

  it('identifier-like: UUID, long digit runs, long letter-digit mixes', () => {
    expect(isIdentifierLike('0b9f7c2e-1d3a-4c5b-9e8f-112233445566')).toBe(true);
    expect(isIdentifierLike('000123456789')).toBe(true);
    expect(isIdentifierLike('ab12cd34ef56gh78')).toBe(true);
    expect(isIdentifierLike('Closed Won')).toBe(false);
    expect(isIdentifierLike('S01')).toBe(false);
  });

  it('an address embedded in free text counts as an email hit (conservative)', () => {
    expect(piiHits('call ada@example.com tomorrow')).toEqual(['email']);
    expect(piiHits('no address here')).toEqual([]);
  });

  it('piiHits names detectors, never values', () => {
    expect(piiHits('ada@example.com')).toEqual(['email']);
    expect(piiHits('')).toEqual([]);
  });
});

describe('field-name rules (M9A §5.1, §5.2)', () => {
  it('excluded names after normalisation', () => {
    for (const n of [
      'password',
      'API_Key',
      'card_number',
      'cvv',
      'iban',
      'account_number',
      'date_of_birth',
      'DOB',
      'tax_id',
      'access_token',
    ]) {
      expect(isExcludedName(n), n).toBe(true);
    }
    expect(isExcludedName('status')).toBe(false);
  });

  it('sensitive names (shape only)', () => {
    for (const n of [
      'email',
      'email_status',
      'mobile',
      'first_name',
      'Street',
      'postcode',
      'website',
      'linkedin_url',
    ]) {
      expect(isSensitiveName(n), n).toBe(true);
    }
    expect(isSensitiveName('contact_status')).toBe(false);
  });

  it('JSON key names: secret-like or detector-positive keys are not shown', () => {
    expect(isSafeKeyName('values')).toBe(true);
    expect(isSafeKeyName('api_token')).toBe(false);
    expect(isSafeKeyName('ada@example.com')).toBe(false);
    expect(isSafeKeyName('ab12cd34ef56gh78ij')).toBe(false);
  });
});

describe('safe-category gate boundaries (M9A §5.4)', () => {
  it('distinct = 50, ratio 0.05 (n = 1,000): stored', () => {
    const f = profileField(statuses(50, 1000));
    expect(f.categorical).toMatchObject({ suppressed: false, reason: null });
    expect(f.categorical.values).toHaveLength(50);
  });

  it('distinct = 51 (undeclared): suppressed cardinality', () => {
    const f = profileField(statuses(51, 1020 * 2));
    expect(f.categorical).toEqual({ values: [], suppressed: true, reason: 'cardinality' });
  });

  it('distinct = 50, n = 999 (ratio 0.05005): suppressed cardinality_ratio', () => {
    const f = profileField(statuses(50, 999));
    expect(f.categorical).toEqual({ values: [], suppressed: true, reason: 'cardinality_ratio' });
  });

  it('declared enum with 300 options, 300 observed: stored (bypasses condition 2 only)', () => {
    const options = Array.from({ length: 300 }, (_, i) => `opt${String(i).padStart(3, '0')}`);
    const f = profileField(options, {
      name: 'stage',
      type: 'enum',
      enumOptions: options.map((value) => ({ value, active: true })),
    });
    expect(f.categorical.suppressed).toBe(false);
    expect(f.categorical.values).toHaveLength(300);
  });

  it('a value of exactly 64 characters is stored; 65 is suppressed value_length', () => {
    const base = statuses(2, 999);
    expect(profileField([...base, 'a'.repeat(64)]).categorical.suppressed).toBe(false);
    expect(profileField([...base, 'a'.repeat(65)]).categorical).toMatchObject({
      suppressed: true,
      reason: 'value_length',
    });
  });

  it('one email among 49 status values: every value suppressed (pii_value)', () => {
    const f = profileField([...statuses(49, 999), 'ada@example.com']);
    expect(f.categorical).toEqual({ values: [], suppressed: true, reason: 'pii_value' });
    // One hit is below the field thresholds: not sensitive_by_value, still suppressed.
    expect(f.sensitivity).toBe('normal');
    const many = profileField([...statuses(49, 997), 'a@x.io', 'b@x.io', 'c@x.io']);
    expect(many.sensitivity).toBe('sensitive_by_value');
    expect(many.categorical.reason).toBe('pii_value');
  });

  it('one Luhn-valid 16-digit order number among status values: suppressed pii_value', () => {
    const f = profileField([...statuses(5, 999), luhnOrderNumber()]);
    expect(f.categorical).toMatchObject({ suppressed: true, reason: 'pii_value' });
  });

  it('contact_status is stored; email_status is suppressed sensitive_name even with harmless values', () => {
    const values = Array.from({ length: 60 }, (_, i) => ['open', 'closed', 'pending'][i % 3]!);
    expect(profileField(values, { name: 'contact_status' }).categorical.suppressed).toBe(false);
    expect(profileField(values, { name: 'email_status' }).categorical).toEqual({
      values: [],
      suppressed: true,
      reason: 'sensitive_name',
    });
  });

  it('n = 19: suppressed too_few_values; n = 20 stored', () => {
    expect(profileField(Array(19).fill('open')).categorical.reason).toBe('too_few_values');
    expect(profileField(Array(20).fill('open')).categorical.suppressed).toBe(false);
  });

  it('identifier-like values suppress categorical values without making the field sensitive', () => {
    const f = profileField([...statuses(3, 999), 'ab12cd34ef56gh78']);
    expect(f.categorical.reason).toBe('identifier_like');
    expect(f.sensitivity).toBe('normal');
  });

  it('an opted-in excluded field is profiled for shape and counts only', () => {
    const obj = object({ name: 'card_brand' });
    const acc = objectAccumulatorFor(obj, ['card_brand']);
    for (let i = 0; i < 100; i++) acc.addRecord({ card_brand: i % 2 ? 'visa' : 'amex' });
    const doc = buildProfileDocument({
      object: obj,
      connectionKind: 'test',
      schemaSnapshotHash: SNAP,
      accumulator: acc,
      sampling: {
        method: 'full',
        populationEstimate: 100,
        bounded: false,
        stride: null,
        orderedBy: null,
        evidence: [],
      },
      maxRows: 1000,
      distinctCap: 10_000,
      optedIn: new Set(['card_brand']),
    });
    expect(doc.fields[0]).toMatchObject({
      sensitivity: 'excluded_opt_in',
      categorical: { suppressed: true, reason: 'excluded' },
    });
  });

  it('the gate never emits a value that fails a detector (property)', () => {
    const risky = fc.oneof(
      fc.constantFrom(
        'ada@example.com',
        '+44 20 7946 0958',
        '4111111111111111',
        'GB82WEST12345698765432',
        luhnOrderNumber(),
        '0b9f7c2e-1d3a-4c5b-9e8f-112233445566',
      ),
      fc.constantFrom('open', 'closed', 'pending', 'won', 'lost'),
      fc.string({ maxLength: 70 }),
    );
    fc.assert(
      fc.property(fc.array(risky, { minLength: 20, maxLength: 200 }), (values) => {
        const f = profileField(values);
        for (const v of f.categorical.values) {
          expect(piiHits(v.value)).toEqual([]);
          expect(isIdentifierLike(v.value)).toBe(false);
          expect(v.value.length).toBeLessThanOrEqual(64);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('assertNoRawValues: independent scan (M9A §5.5)', () => {
  it('passes aggregate-only documents and flags any detector hit in any string', () => {
    expect(() =>
      assertNoRawValues({ fields: [{ name: 'email', counts: { present: 3 } }] }),
    ).not.toThrow();
    expect(() =>
      assertNoRawValues({
        fields: [{ name: 'x', categorical: { values: [{ value: 'ada@example.com' }] } }],
      }),
    ).toThrow(ProfilePrivacyViolationError);
    expect(() => assertNoRawValues({ note: 'GB82WEST12345698765432' })).toThrow(/iban/);
    expect(() => assertNoRawValues({ a: ['x', { b: '4111111111111111' }] })).toThrow(/card/);
    expect(() => assertNoRawValues({ a: '0b9f7c2e-1d3a-4c5b-9e8f-112233445566' })).toThrow(
      /identifier_like/,
    );
  });

  it('skips names and the snapshot hash, which are not source values', () => {
    expect(() =>
      assertNoRawValues({
        schemaSnapshotHash: 'a1'.repeat(32),
        fields: [{ name: 'ab12cd34ef56gh78ij' }],
        undeclaredFields: ['x1y2z3w4v5u6t7s8'],
      }),
    ).not.toThrow();
  });

  it('the builder runs it: a bypassed gate is caught before persistence', () => {
    // Field values in a document produced by a broken builder.
    const doc = {
      v: 1,
      fields: [
        {
          name: 'status',
          categorical: { values: [{ value: '+44 20 7946 0958', count: 1 }], suppressed: false },
        },
      ],
    };
    expect(() => assertNoRawValues(doc)).toThrow(/phone/);
  });
});
