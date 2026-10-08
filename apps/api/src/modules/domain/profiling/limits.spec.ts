import { describe, expect, it } from 'vitest';
import type { SourceObject } from '../source-connector';
import { PROFILE_LIMITS, samplingAllowed, validateProfileRequest } from './limits';

function object(
  name: string,
  fields: string[],
  caps: Partial<SourceObject['capabilities']> = {},
  extra: Partial<SourceObject> = {},
): SourceObject {
  return {
    name,
    classification: 'record',
    capabilities: {
      pagination: 'offset',
      deleteVisibility: 'none',
      count: true,
      maxPageSize: 100,
      ...caps,
    },
    fields: fields.map((f) => ({ name: f, type: 'string', required: false, unique: false })),
    ...extra,
  };
}

const things = object('Things', ['id', 'status', 'api_token'], { changeField: 'id' });
const ok = (settings: unknown, input: Partial<Parameters<typeof validateProfileRequest>[0]> = {}) =>
  validateProfileRequest(
    { objects: [{ object: 'Things' }], sampling: 'full', includeExcluded: [], ...input },
    [things],
    settings,
  );
const codes = (r: ReturnType<typeof ok>) => (r.ok ? [] : r.issues.map((i) => i.code));

describe('profile limits (approved D2): refuse, never clamp', () => {
  it('the constants are the approved values and frozen', () => {
    expect(PROFILE_LIMITS).toEqual({
      minRows: 1000,
      maxRows: 250_000,
      suggestedRows: 50_000,
      maxFieldsPerObject: 500,
      maxRunMinutes: 60,
      memoryBudgetBytes: 128 * 1024 * 1024,
    });
    expect(Object.isFrozen(PROFILE_LIMITS)).toBe(true);
  });

  it('a connection without profile.maxRows is refused (no implicit default)', () => {
    expect(codes(ok(undefined))).toEqual(['profile_limit_unset']);
    expect(codes(ok({}))).toEqual(['profile_limit_unset']);
  });

  it('a connection limit outside 1,000-250,000 is refused', () => {
    expect(codes(ok({ maxRows: 999 }))).toEqual(['profile_limit_out_of_range']);
    expect(codes(ok({ maxRows: 250_001 }))).toEqual(['profile_limit_out_of_range']);
    expect(ok({ maxRows: 1000 }).ok).toBe(true);
    expect(ok({ maxRows: 250_000 }).ok).toBe(true);
  });

  it('the ceiling is code: no configuration raises it', () => {
    expect(codes(ok({ maxRows: 1_000_000 }))).toEqual(['profile_limit_out_of_range']);
    expect(codes(ok({ maxRows: 250_000, ceiling: 1_000_000 }))).toEqual([
      'profile_limit_out_of_range',
    ]);
  });

  it('--max-rows above the connection value or below the minimum is refused, never clamped', () => {
    expect(codes(ok({ maxRows: 50_000 }, { maxRows: 50_001 }))).toEqual([
      'profile_limit_out_of_range',
    ]);
    expect(codes(ok({ maxRows: 50_000 }, { maxRows: 999 }))).toEqual([
      'profile_limit_out_of_range',
    ]);
    const r = ok({ maxRows: 50_000 }, { maxRows: 20_000 });
    expect(r.ok && r.request.maxRows).toBe(20_000);
    const d = ok({ maxRows: 50_000 });
    expect(d.ok && d.request.maxRows).toBe(50_000);
  });

  it('more than 500 fields per object is refused; the memory budget is enforced', () => {
    const wide = object(
      'Wide',
      Array.from({ length: 501 }, (_, i) => `f${i}`),
    );
    const r = validateProfileRequest(
      { objects: [{ object: 'Wide' }], sampling: 'full', includeExcluded: [] },
      [wide],
      { maxRows: 1000 },
    );
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain('profile_field_limit');
    const exact = object(
      'Exact',
      Array.from({ length: 500 }, (_, i) => `f${i}`),
    );
    expect(
      validateProfileRequest(
        { objects: [{ object: 'Exact' }], sampling: 'full', includeExcluded: [] },
        [exact],
        { maxRows: 1000 },
      ).ok,
    ).toBe(true);
    // 500 fields each with a 2,000-option enum: the candidate estimate exceeds the budget.
    const enums = {
      ...exact,
      fields: exact.fields.map((f) => ({
        ...f,
        type: 'enum' as const,
        enumOptions: Array.from({ length: 2000 }, (_, j) => ({ value: `o${j}`, active: true })),
      })),
    };
    const big = validateProfileRequest(
      { objects: [{ object: 'Exact' }], sampling: 'full', includeExcluded: [] },
      [enums],
      { maxRows: 1000 },
    );
    expect(big.ok ? [] : big.issues.map((i) => i.code)).toContain('profile_memory_budget_exceeded');
  });

  it('sampling methods follow the object capabilities and are never substituted', () => {
    const keyset = object('K', ['id'], { pagination: 'keyset', count: false });
    expect(samplingAllowed(things, 'systematic')).toBe(true);
    expect(samplingAllowed(keyset, 'systematic')).toBe(false);
    expect(samplingAllowed(keyset, 'recent')).toBe(false);
    expect(samplingAllowed(keyset, 'head')).toBe(true);
    expect(samplingAllowed(things, 'head')).toBe(false);
    const r = validateProfileRequest(
      { objects: [{ object: 'K' }], sampling: 'systematic', includeExcluded: [] },
      [keyset],
      { maxRows: 1000 },
    );
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(['sampling_unsupported']);
  });

  it('excluded fields: left out of whole-object requests, refused when named, profiled only with an opt-in', () => {
    const whole = ok({ maxRows: 1000 });
    expect(whole.ok && whole.request.objects[0]!.fields).toEqual(['id', 'status']);
    expect(whole.ok && whole.request.excludedLeftOut).toEqual(['Things.api_token']);
    expect(
      codes(ok({ maxRows: 1000 }, { objects: [{ object: 'Things', fields: ['api_token'] }] })),
    ).toEqual(['profile_field_excluded', 'profile_request_invalid']);
    const opted = ok({ maxRows: 1000 }, { includeExcluded: ['Things.api_token'] });
    expect(opted.ok && opted.request.optIns).toEqual([{ object: 'Things', field: 'api_token' }]);
    expect(codes(ok({ maxRows: 1000 }, { includeExcluded: ['Things.status'] }))).toEqual([
      'profile_request_invalid',
    ]);
  });

  it('payment-like objects are excluded field by field', () => {
    const cards = object('Cards', ['id', 'brand'], {}, { sensitivity: 'payment' });
    const r = validateProfileRequest(
      { objects: [{ object: 'Cards' }], sampling: 'full', includeExcluded: [] },
      [cards],
      { maxRows: 1000 },
    );
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(['profile_request_invalid']);
    const opted = validateProfileRequest(
      { objects: [{ object: 'Cards' }], sampling: 'full', includeExcluded: ['Cards.brand'] },
      [cards],
      { maxRows: 1000 },
    );
    expect(opted.ok && opted.request.objects[0]!.fields).toEqual(['brand']);
  });

  it('unknown objects and fields are refused', () => {
    expect(codes(ok({ maxRows: 1000 }, { objects: [{ object: 'Nope' }] }))).toEqual([
      'unknown_source_object',
    ]);
    expect(
      codes(ok({ maxRows: 1000 }, { objects: [{ object: 'Things', fields: ['nope', 'id'] }] })),
    ).toEqual(['unknown_source_field']);
  });
});
