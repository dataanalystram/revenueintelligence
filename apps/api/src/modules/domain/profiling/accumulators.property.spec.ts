import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SourceObject } from '../source-connector';
import {
  ABSENT,
  FieldAccumulator,
  objectAccumulatorFor,
  type ObjectAccumulator,
} from './accumulators';
import { buildProfileDocument, profileContentHash } from './document';

const OBJ: SourceObject = {
  name: 'Things',
  classification: 'record',
  capabilities: { pagination: 'offset', deleteVisibility: 'none', count: true, maxPageSize: 100 },
  fields: [
    { name: 'a', type: 'string', required: false, unique: false },
    {
      name: 'b',
      type: 'enum',
      required: false,
      unique: false,
      enumOptions: [{ value: 'x', active: true }],
    },
    { name: 'c', type: 'datetime', required: false, unique: false },
  ],
};
const FIELDS = ['a', 'b', 'c'];

const value = fc.oneof(
  fc.constant(null),
  fc.constantFrom(
    '',
    '  ',
    'x',
    'y',
    'open',
    'true',
    'no',
    '007',
    '12,5',
    '2025-01-31',
    '01/02/2025',
    'a,b',
    '["p","q"]',
    '{"k":1}',
    '{bad',
  ),
  fc.integer({ min: -1000, max: 2_000_000_000_000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.string({ maxLength: 20 }),
);
const record = fc.dictionary(fc.constantFrom(...FIELDS, 'extra_field'), value, { maxKeys: 4 });

function docHash(acc: ObjectAccumulator): string {
  return profileContentHash(
    buildProfileDocument({
      object: OBJ,
      connectionKind: 'test',
      schemaSnapshotHash: 'e'.repeat(64),
      accumulator: acc,
      sampling: {
        method: 'full',
        populationEstimate: null,
        bounded: false,
        stride: null,
        orderedBy: null,
        evidence: [],
      },
      maxRows: 1000,
      distinctCap: 10_000,
      optedIn: new Set(),
    }),
  );
}

function fold(records: ReadonlyArray<Record<string, unknown>>): ObjectAccumulator {
  const acc = objectAccumulatorFor(OBJ, FIELDS);
  const declared = new Set(OBJ.fields.map((f) => f.name));
  for (const r of records) acc.addRecord(r, declared);
  return acc;
}

describe('accumulators (M9A §13.2)', () => {
  it('any page split and merge order gives an identical document hash', () => {
    fc.assert(
      fc.property(
        fc.array(record, { maxLength: 120 }),
        fc.array(fc.nat(), { maxLength: 6 }),
        fc.boolean(),
        (records, cuts, reverse) => {
          const whole = docHash(fold(records));
          const points = [
            ...new Set(cuts.map((c) => (records.length === 0 ? 0 : c % records.length))),
          ].sort((x, y) => x - y);
          const pages: Array<Record<string, unknown>[]> = [];
          let start = 0;
          for (const p of [...points, records.length]) {
            pages.push(records.slice(start, p));
            start = p;
          }
          const parts = pages.map(fold);
          if (reverse) parts.reverse();
          const merged = parts.reduce((acc, p) => acc.merge(p), objectAccumulatorFor(OBJ, FIELDS));
          expect(docHash(merged)).toBe(whole);
          // Associativity: ((p1 ⊕ p2) ⊕ p3) == (p1 ⊕ (p2 ⊕ p3)).
          if (parts.length >= 3) {
            const left = fold([]).merge(parts[0]!).merge(parts[1]!).merge(parts[2]!);
            const right = fold([])
              .merge(parts[0]!)
              .merge(fold([]).merge(parts[1]!).merge(parts[2]!));
            expect(docHash(left)).toBe(docHash(right));
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('distinct counting is exact to the cap, then an estimate never below the cap', () => {
    const exact = new FieldAccumulator();
    for (let i = 0; i < 10_000; i++) exact.add(`v${i}`);
    expect(exact.distinct.result()).toEqual({ value: 10_000, method: 'exact', capped: false });
    exact.add('v10000');
    const over = exact.distinct.result();
    expect(over.method).toBe('estimate');
    expect(over.capped).toBe(true);
    expect(over.value).toBeGreaterThan(10_000);
    expect(Math.abs(over.value - 10_001) / 10_001).toBeLessThan(0.05);
  });

  it('absent keys count as null and as absent', () => {
    const acc = new FieldAccumulator();
    acc.add(ABSENT);
    acc.add(null);
    acc.add('');
    expect({
      rows: acc.rows,
      nulls: acc.nulls,
      absent: acc.absent,
      empty: acc.emptyString,
    }).toEqual({
      rows: 3,
      nulls: 2,
      absent: 1,
      empty: 1,
    });
  });

  it('keeps at most 51 raw candidates, each ≤ 64 characters', () => {
    const acc = new FieldAccumulator();
    for (let i = 0; i < 51; i++) acc.add(`s${i}`);
    expect(acc.candidates.counts?.size).toBe(51);
    acc.add('s51');
    expect(acc.candidates.counts).toBeUndefined();
    const long = new FieldAccumulator();
    long.add('a'.repeat(65));
    expect(long.candidates.counts?.size).toBe(0);
    expect(long.anyValueTooLong).toBe(true);
  });
});
