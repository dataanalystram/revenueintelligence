import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  classifyHoldingValue,
  domainKey,
  validateReviewedDomain,
  type ReviewedDomain,
} from './holding-domain';

const SNAP = 'a'.repeat(64);
const PROFILE = '00000000-0000-4000-8000-000000000001';

const domain = (
  entries: ReviewedDomain['entries'],
  over: Partial<ReviewedDomain> = {},
): ReviewedDomain => ({ entries, snapshotHash: SNAP, profileIds: [PROFILE], ...over });

const inDomain = domain([
  { value: 'Closed Won', classification: 'holding' },
  { value: 'Closed Lost', classification: 'non_holding' },
  { value: null, classification: 'non_holding' },
]);
const notInDomain = domain([
  { value: 'Closed Lost', classification: 'non_holding' },
  { value: 'Closed Won', classification: 'holding' },
  { value: null, classification: 'non_holding' },
]);

describe('reviewed holding-filter domain: runtime classification (M9A §10.3)', () => {
  it('classifies reviewed values exactly and anything else as unreviewed (in)', () => {
    expect(classifyHoldingValue(inDomain, 'Closed Won')).toBe('holding');
    expect(classifyHoldingValue(inDomain, 'Closed Lost')).toBe('non_holding');
    // A new value is never silently dropped (in) …
    expect(classifyHoldingValue(inDomain, 'Pending Renewal')).toBe('unreviewed');
    expect(classifyHoldingValue(inDomain, 'closed won')).toBe('unreviewed');
  });

  it('a new value under not_in is unreviewed, never a holding', () => {
    // … and never silently admitted (not_in), even though it is not on the denylist.
    expect(classifyHoldingValue(notInDomain, 'Pending Renewal')).toBe('unreviewed');
    expect(classifyHoldingValue(notInDomain, 'Closed Won')).toBe('holding');
  });

  it('null, empty and whitespace values use the explicit empty entry, never "not a member"', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(domainKey(v)).toBeNull();
      expect(classifyHoldingValue(notInDomain, v)).toBe('non_holding');
    }
    // A structured value is never the empty entry.
    expect(classifyHoldingValue(notInDomain, { a: 1 })).toBe('unreviewed');
    expect(classifyHoldingValue(notInDomain, [])).toBe('unreviewed');
    const noEmpty = domain([{ value: 'Closed Won', classification: 'holding' }]);
    expect(classifyHoldingValue(noEmpty, null)).toBe('unreviewed');
    expect(classifyHoldingValue(noEmpty, '')).toBe('unreviewed');
  });

  it('never returns holding for a value outside the domain (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (v) => {
        fc.pre(!['Closed Won', 'Closed Lost'].includes(v) && domainKey(v) !== null);
        expect(classifyHoldingValue(notInDomain, v)).toBe('unreviewed');
        expect(classifyHoldingValue(inDomain, v)).toBe('unreviewed');
      }),
    );
  });
});

describe('reviewed holding-filter domain: publish validation (M9A §10.2)', () => {
  const base = {
    path: 'objects.0.holdingFilter',
    operator: 'in' as const,
    values: ['Closed Won'],
    declaredOptions: ['Closed Won', 'Closed Lost'],
    observedValues: ['Closed Won', 'Closed Lost'],
    snapshotHash: SNAP,
    coveringProfileIds: [PROFILE],
  };
  const codes = (input: Parameters<typeof validateReviewedDomain>[0]) =>
    validateReviewedDomain(input).map((i) => i.code);

  it('accepts a complete, consistent domain', () => {
    expect(codes({ ...base, domain: inDomain })).toEqual([]);
    expect(
      codes({ ...base, operator: 'not_in', values: ['Closed Lost'], domain: notInDomain }),
    ).toEqual([]);
  });

  it('requires a domain at all', () => {
    expect(codes({ ...base, domain: undefined })).toEqual(['holding_filter_domain_incomplete']);
  });

  it('requires the explicit empty entry', () => {
    const d = domain([
      { value: 'Closed Won', classification: 'holding' },
      { value: 'Closed Lost', classification: 'non_holding' },
    ]);
    expect(codes({ ...base, domain: d })).toContain('holding_filter_domain_incomplete');
  });

  it('requires every declared option and every observed value', () => {
    expect(
      codes({
        ...base,
        declaredOptions: [...base.declaredOptions, 'Prospecting'],
        domain: inDomain,
      }),
    ).toContain('holding_filter_domain_incomplete');
    expect(
      codes({ ...base, observedValues: [...base.observedValues, 'Pending'], domain: inDomain }),
    ).toContain('holding_filter_domain_incomplete');
  });

  it('refuses a classification that contradicts the filter list', () => {
    const wrong = domain([
      { value: 'Closed Won', classification: 'non_holding' },
      { value: 'Closed Lost', classification: 'non_holding' },
      { value: null, classification: 'non_holding' },
    ]);
    expect(codes({ ...base, domain: wrong })).toContain('holding_filter_domain_inconsistent');
    const dup = domain([...inDomain.entries, { value: 'Closed Won', classification: 'holding' }]);
    expect(codes({ ...base, domain: dup })).toContain('holding_filter_domain_inconsistent');
  });

  it('refuses a domain reviewed against another snapshot or a non-covering profile', () => {
    expect(codes({ ...base, domain: { ...inDomain, snapshotHash: 'b'.repeat(64) } })).toContain(
      'holding_filter_domain_stale',
    );
    expect(codes({ ...base, coveringProfileIds: [], domain: inDomain })).toContain(
      'holding_filter_domain_stale',
    );
  });
});
