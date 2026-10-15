import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSION_GUARDRAILS, type ExtensionValueType } from './extension';
import {
  capturedFieldKey,
  captureDraft,
  decideExtensionUse,
  extensionMayEvidence,
  useSubjectFromDefinition,
} from './extension-use';
import {
  canonicalDecimal,
  displayExtensionValue,
  extensionValueHash,
  fieldSpecFromDefinition,
  jsonDepth,
  matchesJsonSchema,
  parsedFromStored,
  parseExtensionValue,
  type ExtensionFieldSpec,
} from './extension-values';

/** V2 (pure value parsing per type) and the pure part of V14 (use guard, M10D plan §6). */

const spec = (
  valueType: ExtensionValueType,
  extra: Partial<Omit<ExtensionFieldSpec, 'key' | 'valueType'>> = {},
): ExtensionFieldSpec => ({ key: 'f', valueType, ...extra });

const ok = (s: ExtensionFieldSpec, raw: unknown) => {
  const r = parseExtensionValue(s, raw);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.value;
};
const reason = (s: ExtensionFieldSpec, raw: unknown, guardrails = DEFAULT_EXTENSION_GUARDRAILS) => {
  const r = parseExtensionValue(s, raw, guardrails);
  return r.ok ? 'ok' : r.reason;
};

describe('extension value parsing (V2)', () => {
  it('explicit empty vs a value: null and blank strings are empty for every type', () => {
    for (const t of [
      'string',
      'text',
      'number',
      'integer',
      'boolean',
      'date',
      'datetime',
      'money',
      'enum',
      'multi_enum',
      'array',
      'json',
      'reference',
    ] as const) {
      expect(ok(spec(t), null)).toEqual({ state: 'empty', type: t });
      expect(ok(spec(t), '  ')).toEqual({ state: 'empty', type: t });
    }
  });

  it('string and text: length caps (field max_length, then the type ceiling)', () => {
    expect(ok(spec('string'), 'abc')).toMatchObject({ state: 'present', text: 'abc' });
    expect(reason(spec('string'), 'x'.repeat(1001))).toBe('too_long');
    expect(reason(spec('string', { constraints: { max_length: 3 } }), 'abcd')).toBe('too_long');
    expect(reason(spec('text'), 'x'.repeat(32768))).toBe('ok');
    expect(reason(spec('text'), 'x'.repeat(32769))).toBe('too_long');
    expect(reason(spec('string'), { a: 1 })).toBe('type_invalid');
  });

  it('secret-like text, array items and JSON leaves are refused with a pattern code only', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const r = parseExtensionValue(spec('string'), `token ${jwt}`);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: 'secret_like' });
    expect(JSON.stringify(r)).not.toContain(jwt);
    expect(reason(spec('array', { constraints: { item_type: 'string' } }), ['ok', jwt])).toBe(
      'secret_like',
    );
    expect(reason(spec('json'), { nested: { v: jwt } })).toBe('secret_like');
    expect(reason(spec('text'), 'password = hunter2hunter2')).toBe('secret_like');
  });

  it('number and integer: canonical decimals, scale 0 for integers, ranges', () => {
    expect(ok(spec('number'), '0012.500')).toMatchObject({ number: '12.5' });
    expect(ok(spec('number'), -3.25)).toMatchObject({ number: '-3.25' });
    expect(ok(spec('integer'), '42')).toMatchObject({ number: '42' });
    expect(reason(spec('integer'), '4.2')).toBe('not_integer');
    expect(reason(spec('number'), '1e5')).toBe('type_invalid');
    expect(reason(spec('number'), 'NaN')).toBe('type_invalid');
    expect(reason(spec('number'), true)).toBe('type_invalid');
    expect(reason(spec('number', { constraints: { min: 0, max: 10 } }), '-1')).toBe('below_min');
    expect(reason(spec('number', { constraints: { min: 0, max: 10 } }), '11')).toBe('above_max');
    expect(reason(spec('number'), '1' + '0'.repeat(20))).toBe('number_out_of_range');
    expect(canonicalDecimal('-0.000')).toBe('0');
  });

  it('boolean, date and datetime', () => {
    expect(ok(spec('boolean'), 'TRUE')).toMatchObject({ bool: true });
    expect(ok(spec('boolean'), false)).toMatchObject({ bool: false });
    expect(reason(spec('boolean'), 'yes')).toBe('type_invalid');
    expect(ok(spec('date'), '2026-02-28')).toMatchObject({ date: '2026-02-28' });
    expect(reason(spec('date'), '2026-02-30')).toBe('date_invalid');
    expect(reason(spec('date'), '28/02/2026')).toBe('date_invalid');
    const dt = ok(spec('datetime'), '2026-10-15T10:00:00+01:00');
    expect(dt.state === 'present' && dt.ts?.toISOString()).toBe('2026-10-15T09:00:00.000Z');
    expect(reason(spec('datetime'), '2026-10-15 10:00')).toBe('date_invalid');
  });

  it('money: minor units by ISO 4217 exponent, fixed currency, integral minor amounts', () => {
    expect(ok(spec('money'), { amount: '12.34', currency: 'EUR' })).toMatchObject({
      moneyMinor: '1234',
      currency: 'EUR',
    });
    expect(ok(spec('money'), '1500 JPY')).toMatchObject({ moneyMinor: '1500', currency: 'JPY' });
    expect(ok(spec('money'), 'KWD 1.234')).toMatchObject({ moneyMinor: '1234', currency: 'KWD' });
    expect(reason(spec('money'), '1.5 JPY')).toBe('minor_not_integral');
    expect(reason(spec('money'), '1.234 EUR')).toBe('minor_not_integral');
    expect(reason(spec('money'), '1 XYZ')).toBe('currency_unknown');
    expect(reason(spec('money'), '12.00')).toBe('currency_required');
    const fixed = spec('money', { constraints: { currency: 'GBP' } });
    expect(ok(fixed, '9.99')).toMatchObject({ moneyMinor: '999', currency: 'GBP' });
    expect(reason(fixed, '9.99 EUR')).toBe('currency_mismatch');
    expect(ok(spec('money'), { minor: '-250', currency: 'usd' })).toMatchObject({
      moneyMinor: '-250',
      currency: 'USD',
    });
    expect(reason(spec('money'), { minor: '2.5', currency: 'USD' })).toBe('minor_not_integral');
  });

  it('enum and multi_enum: active codes only, set semantics, item guardrail', () => {
    const values = [
      { code: 'gold', status: 'active' },
      { code: 'silver', status: 'active' },
      { code: 'bronze', status: 'retired' },
    ];
    expect(ok(spec('enum', { allowedValues: values }), 'gold')).toMatchObject({ enumCode: 'gold' });
    expect(reason(spec('enum', { allowedValues: values }), 'platinum')).toBe('enum_unknown');
    expect(reason(spec('enum', { allowedValues: values }), 'bronze')).toBe('enum_retired');
    const multi = spec('multi_enum', { allowedValues: values });
    const parsed = ok(multi, 'silver; gold');
    expect(parsed.state === 'present' && parsed.items?.map((i) => i.enumCode)).toEqual([
      'gold',
      'silver',
    ]);
    expect(reason(multi, ['gold', 'gold'])).toBe('duplicate_item');
    expect(reason(multi, ['gold', 'nope'])).toBe('enum_unknown');
    expect(ok(multi, [])).toEqual({ state: 'empty', type: 'multi_enum' });
    expect(
      reason(spec('multi_enum', { allowedValues: values, constraints: { max_items: 1 } }), [
        'gold',
        'silver',
      ]),
    ).toBe('too_many_items');
  });

  it('array: item types, the array-items guardrail is never truncation', () => {
    const ints = spec('array', { constraints: { item_type: 'integer', min: 0 } });
    expect(ok(ints, ['1', 2])).toMatchObject({
      items: [
        { type: 'integer', number: '1' },
        { type: 'integer', number: '2' },
      ],
    });
    expect(reason(ints, ['1', '-1'])).toBe('below_min');
    expect(reason(ints, ['x'])).toBe('item_invalid');
    const dates = spec('array', { constraints: { item_type: 'date' } });
    expect(reason(dates, ['2026-13-01'])).toBe('date_invalid');
    const small = { ...DEFAULT_EXTENSION_GUARDRAILS, maxArrayItems: 2 };
    expect(
      reason(spec('array', { constraints: { item_type: 'string' } }), ['a', 'b', 'c'], small),
    ).toBe('too_many_items');
  });

  it('json: plain JSON only, size and depth guardrails, the schema subset', () => {
    expect(ok(spec('json'), '{"a":[1,2]}')).toMatchObject({ json: { a: [1, 2] } });
    expect(reason(spec('json'), '{bad')).toBe('json_invalid');
    const shallow = { ...DEFAULT_EXTENSION_GUARDRAILS, maxJsonDepth: 2 };
    expect(reason(spec('json'), { a: { b: { c: 1 } } }, shallow)).toBe('json_too_deep');
    const tiny = { ...DEFAULT_EXTENSION_GUARDRAILS, maxJsonBytes: 1024 };
    expect(reason(spec('json'), { a: 'x'.repeat(2000) }, tiny)).toBe('json_too_large');
    expect(jsonDepth({ a: { b: 1 } })).toBe(2);
    const schema = {
      type: 'object' as const,
      required: ['n'],
      properties: {
        n: { type: 'integer' as const, minimum: 0 },
        tags: { type: 'array' as const, maxItems: 2 },
      },
    };
    expect(reason(spec('json', { constraints: { json_schema: schema } }), { n: 1 })).toBe('ok');
    expect(reason(spec('json', { constraints: { json_schema: schema } }), { n: -1 })).toBe(
      'json_schema_mismatch',
    );
    expect(reason(spec('json', { constraints: { json_schema: schema } }), {})).toBe(
      'json_schema_mismatch',
    );
    expect(matchesJsonSchema({ type: 'array', maxItems: 1 }, [1, 2])).toBe(false);
    expect(matchesJsonSchema({ type: 'string', enum: ['a'] }, 'b')).toBe(false);
  });

  it('reference: allowed kinds only, uuid ids, product keys', () => {
    const ref = spec('reference', { constraints: { reference_to: ['account', 'product'] } });
    const id = '0b6f0a1e-1111-4222-8333-444455556666';
    expect(ok(ref, `account:${id}`)).toMatchObject({ ref: { kind: 'company', id } });
    expect(ok(ref, { kind: 'company', id })).toMatchObject({ ref: { kind: 'company', id } });
    expect(ok(ref, 'product:pro_plan')).toMatchObject({
      ref: { kind: 'product', key: 'pro_plan' },
    });
    expect(reason(ref, `person:${id}`)).toBe('reference_kind_not_allowed');
    expect(reason(ref, 'account:not-a-uuid')).toBe('reference_invalid');
    const custom = spec('reference', { constraints: { reference_to: ['custom_object:project'] } });
    expect(ok(custom, `custom_record:${id}`)).toMatchObject({ ref: { kind: 'custom_record', id } });
  });

  it('hash: stable for equal values, different for different values; round trip via stored columns', () => {
    const s = spec('multi_enum', {
      allowedValues: [
        { code: 'a', status: 'active' },
        { code: 'b', status: 'active' },
      ],
    });
    const h1 = extensionValueHash(ok(s, 'a;b'));
    expect(extensionValueHash(ok(s, ['b', 'a']))).toBe(h1);
    expect(extensionValueHash(ok(s, 'a'))).not.toBe(h1);
    const money = ok(spec('money'), '12.30 EUR');
    const stored = parsedFromStored({
      valueType: 'money',
      valueState: 'present',
      valueText: null,
      valueNumber: null,
      valueBool: null,
      valueDate: null,
      valueTs: null,
      valueMoneyMinor: '1230',
      valueCurrency: 'EUR',
      valueEnum: null,
      valueJson: null,
      valueRefKind: null,
      valueRefId: null,
      valueRefKey: null,
    });
    expect(extensionValueHash(stored)).toBe(extensionValueHash(money));
    expect(displayExtensionValue(money)).toEqual({ minor: '1230', currency: 'EUR' });
  });

  it('fieldSpecFromDefinition reads the projected definition', () => {
    const s = fieldSpecFromDefinition('tier', {
      value_type: 'enum',
      allowed_values: [{ code: 'gold', label: 'Gold' }],
    });
    expect(s.allowedValues).toEqual([{ code: 'gold', status: 'active' }]);
  });
});

describe('extension use guard (V14, pure)', () => {
  const subjects = [
    useSubjectFromDefinition('a', { allowed_uses: ['display', 'analytics'] }),
    useSubjectFromDefinition('b', { allowed_uses: ['display'] }),
  ];

  it('filters fields lacking the use when no keys are named', () => {
    expect(decideExtensionUse('analytics', subjects)).toEqual({ ok: true, allowed: ['a'] });
  });

  it('refuses an explicit request for a field lacking the use (or unknown)', () => {
    expect(decideExtensionUse('analytics', subjects, ['a', 'b'])).toEqual({
      ok: false,
      refused: ['b'],
    });
    expect(decideExtensionUse('display', subjects, ['zzz'])).toEqual({
      ok: false,
      refused: ['zzz'],
    });
    expect(decideExtensionUse('display', subjects, ['a', 'b'])).toEqual({
      ok: true,
      allowed: ['a', 'b'],
    });
  });

  it('the not_evidence_of floor is always present, whatever the stored definition says', () => {
    const s = useSubjectFromDefinition('a', { not_evidence_of: ['coverage'] });
    for (const fact of [
      'account_identity',
      'person_identity',
      'subscription_ownership',
      'coverage',
    ]) {
      expect(extensionMayEvidence(s, fact)).toBe(false);
    }
    expect(extensionMayEvidence(s, 'eligibility')).toBe(true);
  });
});

describe('captured field keys and the capture draft (Q20)', () => {
  it('derives src_<kind>_<object>_<field>, truncating with a hash suffix beyond 63', () => {
    expect(capturedFieldKey('sugar', 'Accounts', 'Industry_Code__c')).toBe(
      'src_sugar_accounts_industry_code_c',
    );
    const long = capturedFieldKey('chargebee', 'Subscriptions', 'a'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^src_chargebee_subscriptions_a+_[0-9a-f]{8}$/);
    expect(capturedFieldKey('chargebee', 'Subscriptions', 'a'.repeat(80))).toBe(long);
    expect(capturedFieldKey('chargebee', 'Subscriptions', 'a'.repeat(81))).not.toBe(long);
  });

  it('refuses sensitive fields and collisions; skips keys already published', () => {
    const draft = captureDraft(
      [
        { connectionKind: 'sugar', object: 'Accounts', entity: 'account', field: 'Region' },
        {
          connectionKind: 'sugar',
          object: 'Accounts',
          entity: 'account',
          field: 'Notes',
          profileSensitivity: 'sensitive_by_value',
        },
        { connectionKind: 'sugar', object: 'Accounts', entity: 'account', field: 'ssn' },
        { connectionKind: 'sugar', object: 'Accounts', entity: 'account', field: 'region' },
        { connectionKind: 'sugar', object: 'Accounts', entity: 'account', field: 'Size' },
      ],
      new Set(['src_sugar_accounts_size']),
      (f) => f === 'ssn',
    );
    expect(draft.map((d) => (d.ok ? 'ok' : d.code))).toEqual([
      'ok',
      'capture_sensitive_refused',
      'capture_sensitive_refused',
      'capture_key_collision',
    ]);
    const first = draft[0]!;
    expect(first.ok && first.definition.allowed_uses).toEqual(['display']);
    expect(first.ok && first.definition.origin).toBe('source_captured');
  });
});
