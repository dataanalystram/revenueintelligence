import { describe, expect, it } from 'vitest';
import { decideApplyWithHash, type StoredReference } from '../source-observation';
import {
  decideMerge,
  decideReactivation,
  decideReferenceObservation,
  decideRetirement,
  PRODUCT_REFERENCE_ADAPTER,
  type ReferenceLifecycle,
  type RetirementRun,
  type SourceReferenceState,
} from './source-reference';

/**
 * M10B plan §2.4 (Q9): the shared reference lifecycle rules. The equivalence
 * tests compare them with a frozen copy of the pre-M10B company/person rules
 * (`decideApplyWithHash` as of m10a2 1e41f16, the M9B retirement filter in
 * `ContextIngestionService.retireAbsentWithin` and the merge skip in
 * `ContextIngestionService.merge`) over an exhaustive grid.
 */

/** Frozen copy of the pre-M10B `decideApplyWithHash` (do not edit). */
function legacyDecideApply(
  stored: StoredReference | undefined,
  observation: { presence: 'present' | 'absent'; observedAt: Date; sourceUpdatedAt?: Date },
  hash: string | undefined,
): string {
  if (!stored) return observation.presence === 'present' ? 'create' : 'not_found';
  if (observation.presence === 'absent') {
    if (stored.state === 'deleted' || stored.state === 'merged' || stored.state === 'retired') {
      return 'unchanged';
    }
    if (stored.lastSeenAt && observation.observedAt <= stored.lastSeenAt) return 'stale';
    return 'delete';
  }
  if (stored.state === 'merged') return 'stale';
  if (stored.state === 'deleted') {
    return stored.deletedAt && observation.observedAt > stored.deletedAt ? 'restore' : 'stale';
  }
  if (stored.state === 'retired') {
    return stored.retiredAt && observation.observedAt > stored.retiredAt ? 'restore' : 'stale';
  }
  if (stored.sourceUpdatedAt && observation.sourceUpdatedAt) {
    if (observation.sourceUpdatedAt < stored.sourceUpdatedAt) return 'stale';
    if (
      observation.sourceUpdatedAt.getTime() === stored.sourceUpdatedAt.getTime() &&
      hash === stored.fieldHash
    ) {
      return 'unchanged';
    }
    return 'apply';
  }
  if (stored.sourceUpdatedAt && !observation.sourceUpdatedAt) {
    if (stored.lastSeenAt && observation.observedAt <= stored.lastSeenAt) return 'stale';
  }
  return hash === stored.fieldHash ? 'unchanged' : 'apply';
}

/** Frozen copy of the M9B retirement filter (caller-gated run; do not edit). */
function legacyRetires(
  row: { externalId: string; state: string; lastSeenAt: Date },
  seen: ReadonlySet<string>,
  observedAt: Date,
): boolean {
  // activeCompanyRefsOf: state active, last_seen_at <= observedAt; then skip seen ids.
  return row.state === 'active' && row.lastSeenAt <= observedAt && !seen.has(row.externalId);
}

const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
const STATES: readonly SourceReferenceState[] = ['active', 'retired', 'deleted', 'merged'];
const TIMES = [undefined, T(10), T(20), T(30)];
const HASHES = [undefined, 'h1', 'h2'];

function storedGrid(): (ReferenceLifecycle | undefined)[] {
  const out: (ReferenceLifecycle | undefined)[] = [undefined];
  for (const state of STATES)
    for (const sourceUpdatedAt of TIMES)
      for (const lastSeenAt of TIMES)
        for (const fieldHash of HASHES)
          for (const tomb of TIMES) {
            out.push({
              state,
              ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
              ...(lastSeenAt ? { lastSeenAt } : {}),
              ...(fieldHash ? { fieldHash } : {}),
              ...(tomb && state === 'deleted' ? { deletedAt: tomb } : {}),
              ...(tomb && state === 'retired' ? { retiredAt: tomb } : {}),
            });
          }
  return out;
}

describe('decideReferenceObservation ≡ pre-M10B company/person apply rules (Q9)', () => {
  it('decides exactly as the legacy rule over the full grid', () => {
    let cases = 0;
    const mismatches: string[] = [];
    for (const stored of storedGrid())
      for (const presence of ['present', 'absent'] as const)
        for (const observedAt of TIMES.filter((t): t is Date => !!t))
          for (const sourceUpdatedAt of TIMES)
            for (const hash of HASHES) {
              const obs = { presence, observedAt, ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}) };
              const h = presence === 'present' ? hash : undefined;
              const legacy = legacyDecideApply(stored, obs, h);
              const shared = decideReferenceObservation(stored, obs, h);
              const viaIngestion = decideApplyWithHash(stored, obs, h);
              cases += 1;
              if (legacy !== shared || legacy !== viaIngestion) {
                mismatches.push(JSON.stringify({ stored, obs, h, legacy, shared, viaIngestion }));
              }
            }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(cases).toBeGreaterThan(10_000);
  });

  it('names the plan rules', () => {
    const active = {
      state: 'active' as const,
      sourceUpdatedAt: T(20),
      fieldHash: 'h1',
      lastSeenAt: T(20),
    };
    const present = (n: number, src?: number) => ({
      presence: 'present' as const,
      observedAt: T(n),
      ...(src ? { sourceUpdatedAt: T(src) } : {}),
    });
    expect(decideReferenceObservation(active, present(30, 30), 'h2')).toBe('apply');
    expect(decideReferenceObservation(active, present(30, 10), 'h2')).toBe('stale');
    expect(decideReferenceObservation(active, present(30, 20), 'h1')).toBe('unchanged');
    const tomb = { state: 'deleted' as const, deletedAt: T(20) };
    expect(decideReferenceObservation(tomb, present(10), 'h1')).toBe('stale');
    expect(decideReferenceObservation(tomb, present(30), 'h1')).toBe('restore');
    expect(decideReferenceObservation({ state: 'merged' }, present(30), 'h1')).toBe('stale');
  });
});

describe('decideReactivation', () => {
  it('only a read after the retirement / deletion time reactivates', () => {
    expect(decideReactivation({ state: 'retired', retiredAt: T(20) }, T(20))).toBe(false);
    expect(decideReactivation({ state: 'retired', retiredAt: T(20) }, T(21))).toBe(true);
    expect(decideReactivation({ state: 'deleted', deletedAt: T(20) }, T(10))).toBe(false);
    expect(decideReactivation({ state: 'deleted', deletedAt: T(20) }, T(30))).toBe(true);
    expect(decideReactivation({ state: 'retired' }, T(30))).toBe(false);
    expect(decideReactivation({ state: 'merged' }, T(30))).toBe(false);
    expect(decideReactivation({ state: 'active' }, T(30))).toBe(false);
  });
});

describe('decideRetirement', () => {
  const run: RetirementRun = {
    accepted: true,
    proven: true,
    full: true,
    uncertain: false,
    observedAt: T(20),
    seen: new Set(['seen']),
    rejected: new Set(['rej']),
    protectedIds: new Set(['prot']),
  };
  const ref = (externalId: string, over: Partial<Parameters<typeof decideRetirement>[0]> = {}) => ({
    externalId,
    origin: 'observed' as const,
    state: 'active' as const,
    lastSeenAt: T(10),
    ...over,
  });

  it('≡ the M9B filter for an accepted, proven, full run (company references)', () => {
    const mismatches: string[] = [];
    for (const state of STATES)
      for (const lastSeenAt of TIMES.filter((t): t is Date => !!t))
        for (const id of ['seen', 'other'])
          for (const observedAt of [T(10), T(20), T(30)]) {
            const seen = new Set(['seen']);
            const legacy = legacyRetires({ externalId: id, state, lastSeenAt }, seen, observedAt);
            const shared = decideRetirement(
              { externalId: id, origin: 'observed', state, lastSeenAt },
              { accepted: true, proven: true, full: true, uncertain: false, observedAt, seen },
            ).retire;
            if (legacy !== shared)
              mismatches.push(JSON.stringify({ state, lastSeenAt, id, observedAt }));
          }
    expect(mismatches).toEqual([]);
  });

  it('retires only an active, observed, unseen, unprotected reference of an eligible run', () => {
    expect(decideRetirement(ref('gone'), run)).toEqual({ retire: true });
    expect(decideRetirement(ref('seen'), run)).toEqual({ retire: false, reason: 'seen' });
    expect(decideRetirement(ref('rej'), run)).toEqual({ retire: false, reason: 'rejected' });
    expect(decideRetirement(ref('prot'), run)).toEqual({ retire: false, reason: 'protected' });
    expect(decideRetirement(ref('gone', { origin: 'declared' }), run)).toEqual({
      retire: false,
      reason: 'declared',
    });
    expect(decideRetirement(ref('gone', { state: 'retired' }), run)).toEqual({
      retire: false,
      reason: 'not_active',
    });
    expect(decideRetirement(ref('gone', { lastSeenAt: T(30) }), run)).toEqual({
      retire: false,
      reason: 'seen_after_run',
    });
  });

  it.each([
    ['accepted', { accepted: false }],
    ['proven', { proven: false }],
    ['full', { full: false }],
    ['uncertain', { uncertain: true }],
  ] as const)('never for a run that is not %s', (_n, over) => {
    expect(decideRetirement(ref('gone'), { ...run, ...over })).toEqual({
      retire: false,
      reason: 'run_not_eligible',
    });
  });
});

describe('decideMerge', () => {
  it('≡ the legacy merge skip; terminal lineage; never into itself', () => {
    expect(decideMerge({ externalId: 'a', state: 'active' }, 'b')).toBe('merge');
    expect(decideMerge({ externalId: 'a', state: 'retired' }, 'b')).toBe('merge');
    expect(decideMerge({ externalId: 'a', state: 'merged', mergedIntoExternalId: 'b' }, 'b')).toBe(
      'unchanged',
    );
    expect(decideMerge({ externalId: 'a', state: 'merged', mergedIntoExternalId: 'c' }, 'b')).toBe(
      'merge',
    );
    expect(decideMerge({ externalId: 'a', state: 'active' }, 'a')).toBe('refused');
    // Legacy: skip iff merged into the same survivor.
    for (const state of STATES)
      for (const into of [undefined, 'b', 'c']) {
        const legacySkip = state === 'merged' && into === 'b';
        expect(
          decideMerge({ externalId: 'a', state, mergedIntoExternalId: into }, 'b') === 'unchanged',
        ).toBe(legacySkip);
      }
  });
});

describe('product-reference change records', () => {
  it('the adapter satisfies tenant_context_changes_adapter_format', () => {
    expect(PRODUCT_REFERENCE_ADAPTER).toMatch(/^[a-z0-9_]{1,32}$/);
  });
});
