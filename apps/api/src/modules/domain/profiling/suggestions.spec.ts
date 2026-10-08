import { describe, expect, it } from 'vitest';
import type { SourceField, SourceObject } from '../source-connector';
import { objectAccumulatorFor } from './accumulators';
import { buildProfileDocument } from './document';
import { cardinalityClassOf, type Interpretation } from './suggestions';

function suggest(values: readonly unknown[], field: Partial<SourceField> = {}) {
  const obj: SourceObject = {
    name: 'Things',
    classification: 'record',
    capabilities: { pagination: 'offset', deleteVisibility: 'none', count: true, maxPageSize: 100 },
    fields: [{ name: 'f', type: 'string', required: false, unique: false, ...field }],
  };
  const acc = objectAccumulatorFor(obj, ['f']);
  for (const v of values) acc.addRecord({ f: v });
  const doc = buildProfileDocument({
    object: obj,
    connectionKind: 'test',
    schemaSnapshotHash: 'd'.repeat(64),
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
  return doc.fields[0]!.suggestions;
}

const find = (s: ReturnType<typeof suggest>, i: Interpretation) =>
  s.find((x) => x.interpretation === i);
const repeat = <T>(xs: readonly T[], n: number) =>
  Array.from({ length: n }, (_, i) => xs[i % xs.length]!);

describe('field-level suggestions (M9A §4.3)', () => {
  it('boolean: one representation is high; {0,1} integers alone are only medium', () => {
    expect(find(suggest(repeat(['true', 'false'], 40)), 'boolean')?.confidence).toBe('high');
    expect(find(suggest(repeat(['yes', 'false'], 40)), 'boolean')?.confidence).toBe('medium');
    expect(find(suggest(repeat([0, 1], 40)), 'boolean')?.confidence).toBe('medium');
    expect(find(suggest(repeat(['1', '0'], 40)), 'boolean')?.evidence).toEqual([
      'integer_zero_one',
    ]);
    // {0, 1, 2} is not boolean; a constant is not boolean (distinct ≥ 2).
    expect(find(suggest(repeat([0, 1, 2], 40)), 'boolean')).toBeUndefined();
    expect(find(suggest(repeat([1], 40)), 'boolean')).toBeUndefined();
  });

  it('boolean share boundary: 99% suggests, below does not', () => {
    const at = [...repeat(['true', 'false'], 99), 'maybe'];
    expect(find(suggest(at), 'boolean')).toBeDefined();
    const below = [...repeat(['true', 'false'], 98), 'maybe', 'perhaps'];
    expect(find(suggest(below), 'boolean')).toBeUndefined();
  });

  it('n = 19 gives nothing above low; n = 20 can be high', () => {
    expect(find(suggest(repeat(['2025-01-31', '2025-02-01'], 19)), 'date')?.confidence).toBe('low');
    expect(find(suggest(repeat(['2025-01-31', '2025-02-01'], 20)), 'date')?.confidence).toBe(
      'high',
    );
    expect(find(suggest(repeat(['true', 'false'], 19)), 'boolean')).toBeUndefined();
  });

  it('date: ISO high, d/m/y medium, any ambiguous date low', () => {
    expect(find(suggest(repeat(['2025-01-31'], 100)), 'date')?.confidence).toBe('high');
    expect(find(suggest(repeat(['31/01/2025', '25/12/2024'], 100)), 'date')?.confidence).toBe(
      'medium',
    );
    const ambiguous = [...repeat(['2025-01-31'], 99), '01/02/2025'];
    expect(find(suggest(ambiguous), 'date')).toMatchObject({
      confidence: 'low',
      evidence: ['date.iso', 'ambiguous_date'],
    });
  });

  it('timestamp: zoned high, naive medium', () => {
    expect(find(suggest(repeat(['2025-01-31T10:00:00Z'], 30)), 'timestamp')?.confidence).toBe(
      'high',
    );
    expect(find(suggest(repeat(['2025-01-31 10:00'], 30)), 'timestamp')?.confidence).toBe('medium');
  });

  it('integer/decimal: native high, string medium, leading zeros exclude', () => {
    expect(find(suggest(repeat([1, 2, 3], 30)), 'integer')?.confidence).toBe('high');
    expect(find(suggest(repeat(['1', '2', '3'], 30)), 'integer')?.confidence).toBe('medium');
    expect(find(suggest(repeat(['1', '2', '007'], 300)), 'integer')).toBeUndefined();
    expect(find(suggest(repeat([1.5, 2.25], 30)), 'decimal')?.confidence).toBe('high');
  });

  it('multi_select: structured lists high, delimited medium; json_array only when not multi-select', () => {
    expect(find(suggest(repeat(['["a","b"]', '["c"]'], 30)), 'multi_select')?.confidence).toBe(
      'high',
    );
    expect(find(suggest(repeat(['a,b', 'c,d'], 30)), 'multi_select')?.confidence).toBe('medium');
    expect(find(suggest(repeat(['["a","b"]'], 30)), 'json_array')).toBeUndefined();
    const wide = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify(Array.from({ length: 5 }, (_, j) => `v${i * 5 + j}`)),
    );
    expect(find(suggest(wide), 'json_array')?.confidence).toBe('high');
  });

  it('json_object, single_select, identifier and free_text', () => {
    expect(find(suggest(repeat(['{"a":1}'], 30)), 'json_object')?.confidence).toBe('high');
    expect(
      find(suggest(repeat(['open', 'closed'], 100), { type: 'enum' }), 'single_select')?.confidence,
    ).toBe('high');
    expect(find(suggest(repeat(['open', 'closed'], 100)), 'single_select')?.confidence).toBe(
      'medium',
    );
    expect(
      find(suggest(Array.from({ length: 100 }, (_, i) => `R${i}`)), 'identifier')?.evidence,
    ).toEqual(['distinct_ratio']);
    const prose = Array.from(
      { length: 100 },
      (_, i) => `A long free text comment number ${i} describing things`,
    );
    expect(find(suggest(prose), 'free_text')?.confidence).toBe('medium');
  });

  it('cardinality classes', () => {
    expect(cardinalityClassOf(0, 0)).toBeNull();
    expect(cardinalityClassOf(1, 100)).toBe('constant');
    expect(cardinalityClassOf(99, 100)).toBe('unique');
    expect(cardinalityClassOf(60, 100)).toBe('high');
    expect(cardinalityClassOf(50, 1000)).toBe('low');
    expect(cardinalityClassOf(51, 1100)).toBe('medium');
  });
});
