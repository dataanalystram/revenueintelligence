import { describe, expect, it } from 'vitest';
import type { SourceField, SourceObject } from '../source-connector';
import { objectAccumulatorFor } from './accumulators';
import { buildProfileDocument, type ProfileDocument } from './document';
import {
  B_GUARD_THRESHOLDS,
  DRIFT_THRESHOLDS,
  driftFindings,
  guardTrips,
  identityAbsentTrips,
  incompatibleTrips,
} from './drift';

const FIELDS: ReadonlyArray<Partial<SourceField> & { name: string }> = [
  { name: 'status' },
  { name: 'amount', type: 'number' },
  { name: 'closed', type: 'date' },
];

function doc(
  rows: ReadonlyArray<Record<string, unknown>>,
  population: number | null = rows.length,
): ProfileDocument {
  const obj: SourceObject = {
    name: 'Things',
    classification: 'record',
    capabilities: { pagination: 'offset', deleteVisibility: 'none', count: true, maxPageSize: 100 },
    fields: FIELDS.map((f) => ({ type: 'string', required: false, unique: false, ...f })),
  };
  const acc = objectAccumulatorFor(
    obj,
    FIELDS.map((f) => f.name),
  );
  for (const r of rows) acc.addRecord(r);
  return buildProfileDocument({
    object: obj,
    connectionKind: 'test',
    schemaSnapshotHash: '1'.repeat(64),
    accumulator: acc,
    sampling: {
      method: 'full',
      populationEstimate: population,
      bounded: false,
      stride: null,
      orderedBy: null,
      evidence: [],
    },
    maxRows: 10_000,
    distinctCap: 10_000,
    optedIn: new Set(),
  });
}

const rows = (n: number, f: (i: number) => Record<string, unknown>) =>
  Array.from({ length: n }, (_, i) => f(i));
const base = rows(100, (i) => ({
  status: ['open', 'closed'][i % 2],
  amount: i + 1,
  closed: '2025-01-31',
}));
const codesOf = (fs: ReturnType<typeof driftFindings>) =>
  fs.map((f) => `${f.code}:${f.field ?? '-'}:${f.class}`);

describe('profile drift (M9A §8)', () => {
  it('no drift against an identical baseline', () => {
    expect(driftFindings(doc(base), doc(base))).toEqual([]);
  });

  it('null-rate shift ≥ 0.10 (non-identity), not for identity fields', () => {
    const now = doc(rows(100, (i) => ({ ...base[i], status: i < 10 ? null : base[i]!.status })));
    expect(codesOf(driftFindings(now, doc(base)))).toContain(
      'profile_drift_null_ratio:status:advisory',
    );
    expect(
      codesOf(driftFindings(now, doc(base), { identityFields: new Set(['status']) })),
    ).not.toContain('profile_drift_null_ratio:status:advisory');
    const small = doc(rows(100, (i) => ({ ...base[i], status: i < 9 ? null : base[i]!.status })));
    expect(codesOf(driftFindings(small, doc(base)))).not.toContain(
      'profile_drift_null_ratio:status:advisory',
    );
  });

  it('compatible type change is advisory; incompatible on a consequential field is B', () => {
    const decimals = doc(rows(100, (i) => ({ ...base[i], amount: i + 0.5 })));
    expect(codesOf(driftFindings(decimals, doc(base)))).toContain(
      'profile_drift_type_compatible:amount:advisory',
    );
    const text = doc(rows(100, (i) => ({ ...base[i], amount: i < 50 ? 'n/a' : i })));
    const ctx = {
      consequentialFields: new Set(['amount']),
      readableTypes: { amount: new Set(['integer', 'decimal'] as const) },
    };
    expect(codesOf(driftFindings(text, doc(base), ctx))).toContain(
      'profile_drift_type_incompatible:amount:m9a_fail_closed',
    );
    const lessThanHalf = doc(rows(100, (i) => ({ ...base[i], amount: i < 49 ? 'n/a' : i })));
    expect(codesOf(driftFindings(lessThanHalf, doc(base), ctx))).not.toContain(
      'profile_drift_type_incompatible:amount:m9a_fail_closed',
    );
  });

  it('a new representation is advisory, or B when the mapping reads the representation', () => {
    const dmy = doc(
      rows(100, (i) => ({ ...base[i], closed: i < 60 ? '31/01/2025' : '2025-01-31' })),
    );
    expect(codesOf(driftFindings(dmy, doc(base)))).toContain(
      'profile_drift_representation:closed:advisory',
    );
    expect(
      codesOf(driftFindings(dmy, doc(base), { representationDependent: new Set(['closed']) })),
    ).toContain('profile_drift_representation:closed:m9a_fail_closed');
  });

  it('new and vanished categories on safe-category fields', () => {
    const now = doc(rows(100, (i) => ({ ...base[i], status: ['open', 'pending'][i % 2] })));
    const f = driftFindings(now, doc(base));
    expect(codesOf(f)).toEqual(
      expect.arrayContaining([
        'profile_drift_new_category:status:advisory',
        'profile_drift_category_vanished:status:advisory',
      ]),
    );
    expect(f.find((x) => x.code === 'profile_drift_new_category')!.evidence).toMatchObject({
      values: ['pending'],
    });
  });

  it('row count change ≥ 20% between full profiles; parse-failure rise ≥ 0.01', () => {
    expect(codesOf(driftFindings(doc(base, 120), doc(base, 100)))).toContain(
      'profile_drift_row_count:-:advisory',
    );
    expect(codesOf(driftFindings(doc(base, 119), doc(base, 100)))).not.toContain(
      'profile_drift_row_count:-:advisory',
    );
    const bad = doc(
      rows(100, (i) => ({ ...base[i], closed: i < 2 ? '2025-02-30' : '2025-01-31' })),
    );
    expect(codesOf(driftFindings(bad, doc(base)))).toContain(
      'profile_drift_parse_failures:closed:advisory',
    );
  });

  it('thresholds are frozen constants', () => {
    expect(Object.isFrozen(DRIFT_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(B_GUARD_THRESHOLDS)).toBe(true);
    expect(B_GUARD_THRESHOLDS).toEqual({
      identityAbsentShare: 0.5,
      incompatibleShare: 0.5,
      preWriteMinimum: 20,
    });
  });
});

describe('B guards (fixed thresholds)', () => {
  it('pre-write waits for 20 records, then trips at ≥ 50%', () => {
    expect(identityAbsentTrips('pre_write', { seen: 19, failing: 19 })).toBe(false);
    expect(identityAbsentTrips('pre_write', { seen: 20, failing: 10 })).toBe(true);
    expect(identityAbsentTrips('pre_write', { seen: 20, failing: 9 })).toBe(false);
  });

  it('pre-tombstone uses the whole run, any size', () => {
    expect(incompatibleTrips('pre_tombstone', { seen: 2, failing: 1 })).toBe(true);
    expect(incompatibleTrips('pre_tombstone', { seen: 3, failing: 1 })).toBe(false);
    expect(guardTrips('pre_tombstone', { seen: 0, failing: 0 }, 0.5)).toBe(false);
  });
});
