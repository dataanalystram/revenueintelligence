import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  affiliationIssues,
  decideAffiliationObservation,
  decideParentChange,
  mapRoleValues,
  parseHierarchyMaxDepth,
  type ParentChangeInput,
  type StoredAffiliation,
} from './account-structure';

/** M10C V1: the pure hierarchy and affiliation rules (plan §2.3–§2.5, §3.2). */
const base = (over: Partial<ParentChangeInput> = {}): ParentChangeInput => ({
  childId: 'c',
  current: { parentId: null, origin: null },
  request: { kind: 'set', parentId: 'p' },
  writer: 'source',
  parent: { recordState: 'active', path: ['p'], truncated: false },
  subtreeHeight: 0,
  maxDepth: 10,
  ...over,
});

describe('decideParentChange (V1)', () => {
  it('an absent value changes nothing; an explicit clear unparents', () => {
    expect(
      decideParentChange(
        base({
          request: { kind: 'absent' },
          current: { parentId: 'p', origin: 'source_provided' },
        }),
      ),
    ).toEqual({ outcome: 'unchanged' });
    expect(
      decideParentChange(
        base({ request: { kind: 'clear' }, current: { parentId: 'p', origin: 'source_provided' } }),
      ),
    ).toEqual({ outcome: 'apply', parentId: null, origin: 'source_provided', parentChanged: true });
  });

  it('refuses a self-parent and a cycle', () => {
    expect(decideParentChange(base({ request: { kind: 'set', parentId: 'c' } }))).toEqual({
      outcome: 'refused',
      code: 'hierarchy_cycle',
    });
    expect(
      decideParentChange(
        base({ parent: { recordState: 'active', path: ['p', 'c', 'r'], truncated: false } }),
      ),
    ).toEqual({ outcome: 'refused', code: 'hierarchy_cycle' });
  });

  it('refuses a merged parent', () => {
    expect(
      decideParentChange(
        base({ parent: { recordState: 'merged', path: ['p'], truncated: false } }),
      ),
    ).toEqual({ outcome: 'refused', code: 'hierarchy_parent_merged' });
  });

  it('counts the parent depth and the child subtree height against the guardrail (VM6, VM7)', () => {
    const path = ['p', 'a', 'b']; // parent depth 2
    expect(
      decideParentChange(
        base({ parent: { recordState: 'active', path, truncated: false }, maxDepth: 3 }),
      ).outcome,
    ).toBe('apply');
    expect(
      decideParentChange(
        base({
          parent: { recordState: 'active', path, truncated: false },
          maxDepth: 3,
          subtreeHeight: 1,
        }),
      ),
    ).toEqual({ outcome: 'refused', code: 'hierarchy_depth_exceeded' });
    expect(
      decideParentChange(base({ parent: { recordState: 'active', path, truncated: true } })),
    ).toEqual({ outcome: 'refused', code: 'hierarchy_depth_exceeded' });
  });

  it('a human value is sticky against a disagreeing source value (Q8)', () => {
    const human = { parentId: 'h', origin: 'human' as const };
    expect(decideParentChange(base({ current: human }))).toEqual({ outcome: 'human_override' });
    expect(decideParentChange(base({ current: human, request: { kind: 'clear' } }))).toEqual({
      outcome: 'human_override',
    });
    expect(
      decideParentChange(base({ current: human, request: { kind: 'set', parentId: 'h' } })),
    ).toEqual({ outcome: 'unchanged' });
    expect(decideParentChange(base({ current: human, writer: 'human' })).outcome).toBe('apply');
  });

  it('an operator confirming the current value makes it sticky without a parent change', () => {
    expect(
      decideParentChange(
        base({ writer: 'human', current: { parentId: 'p', origin: 'source_provided' } }),
      ),
    ).toEqual({ outcome: 'apply', parentId: 'p', origin: 'human', parentChanged: false });
  });

  it('property: re-parent sequences over a random forest never create a cycle or exceed the guardrail', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 11 }), fc.integer({ min: -1, max: 11 })), {
          maxLength: 60,
        }),
        (maxDepth, ops) => {
          const n = 12;
          const parent = new Map<number, number | null>();
          for (let i = 0; i < n; i += 1) parent.set(i, null);
          const path = (id: number) => {
            const out = [String(id)];
            let cur = parent.get(id) ?? null;
            while (cur !== null && out.length < 100) {
              out.push(String(cur));
              cur = parent.get(cur) ?? null;
            }
            return out;
          };
          const height = (id: number): number => {
            const kids = [...parent].filter(([, p]) => p === id).map(([k]) => k);
            return kids.length === 0 ? 0 : 1 + Math.max(...kids.map(height));
          };
          for (const [child, target] of ops) {
            const d = decideParentChange({
              childId: String(child),
              current: {
                parentId: parent.get(child) === null ? null : String(parent.get(child)),
                origin: 'source_provided',
              },
              request: target < 0 ? { kind: 'clear' } : { kind: 'set', parentId: String(target) },
              writer: 'source',
              ...(target >= 0 && target !== child
                ? { parent: { recordState: 'active', path: path(target), truncated: false } }
                : {}),
              subtreeHeight: height(child),
              maxDepth,
            });
            if (d.outcome === 'apply')
              parent.set(child, d.parentId === null ? null : Number(d.parentId));
          }
          for (let i = 0; i < n; i += 1) {
            const p = path(i);
            expect(new Set(p).size).toBe(p.length); // acyclic
            expect(p.length - 1).toBeLessThanOrEqual(maxDepth);
          }
        },
      ),
    );
  });
});

describe('guardrail parsing', () => {
  it('defaults to 10 and accepts 1–50 only', () => {
    expect(parseHierarchyMaxDepth(undefined)).toBe(10);
    expect(parseHierarchyMaxDepth('1')).toBe(1);
    expect(parseHierarchyMaxDepth('50')).toBe(50);
    for (const v of ['0', '51', '-1', '2.5', 'x'])
      expect(parseHierarchyMaxDepth(v)).toBeUndefined();
  });
});

describe('affiliation rules (V9, V10 layer 1)', () => {
  const at = new Date('2027-01-10T00:00:00Z');
  const active: StoredAffiliation = {
    id: 'a',
    origin: 'source_provided',
    roleCodes: ['champion'],
    startsAt: null,
    endsAt: null,
  };

  it('creates, updates, ends on removal or a stated past end, and never touches a human row', () => {
    const present = (roleCodes: string[], endsAt?: Date) => ({
      kind: 'present' as const,
      fields: { roleCodes, ...(endsAt ? { endsAt } : {}) },
    });
    expect(decideAffiliationObservation(undefined, present([]), at)).toEqual({ outcome: 'create' });
    expect(decideAffiliationObservation(active, present(['champion']), at)).toEqual({
      outcome: 'unchanged',
    });
    expect(decideAffiliationObservation(active, present(['buyer']), at)).toEqual({
      outcome: 'update',
    });
    expect(decideAffiliationObservation(active, { kind: 'removed' }, at)).toEqual({
      outcome: 'end',
      reason: 'source_removed',
    });
    expect(
      decideAffiliationObservation(active, present([], new Date('2027-01-01T00:00:00Z')), at),
    ).toEqual({
      outcome: 'end',
      reason: 'source_end_date',
    });
    expect(
      decideAffiliationObservation(undefined, present([], new Date('2027-01-01T00:00:00Z')), at),
    ).toEqual({ outcome: 'unchanged' });
    expect(decideAffiliationObservation(undefined, { kind: 'removed' }, at)).toEqual({
      outcome: 'unchanged',
    });
    expect(
      decideAffiliationObservation({ ...active, origin: 'human' }, { kind: 'removed' }, at),
    ).toEqual({ outcome: 'human_row' });
  });

  it('checks the period and the role codes', () => {
    expect(affiliationIssues({ roleCodes: [] })).toEqual([]);
    expect(
      affiliationIssues({
        roleCodes: [],
        startsAt: new Date('2027-02-01T00:00:00Z'),
        endsAt: new Date('2027-01-01T00:00:00Z'),
      }),
    ).toEqual(['affiliation_period_invalid']);
    expect(affiliationIssues({ roleCodes: ['Bad Code'] })).toEqual([
      'affiliation_role_code_invalid',
    ]);
    expect(affiliationIssues({ roleCodes: ['a', 'a'] })).toEqual(['affiliation_role_code_invalid']);
    expect(affiliationIssues({ roleCodes: Array.from({ length: 11 }, (_, i) => `r${i}`) })).toEqual(
      ['affiliation_role_code_invalid'],
    );
  });

  it('maps role values only through the explicit value map; unmapped values are dropped and counted (Q11)', () => {
    expect(
      mapRoleValues(['Decision Maker', 'Other', 'Champion'], {
        'Decision Maker': 'decision_maker',
        Champion: 'champion',
      }),
    ).toEqual({ codes: ['champion', 'decision_maker'], dropped: 1 });
    expect(mapRoleValues(['x'], { x: 'NOT VALID' })).toEqual({ codes: [], dropped: 1 });
  });
});
