import { describe, expect, it } from 'vitest';
import {
  acceptsStableSnapshot,
  ProofMethodSchema,
  TIER_OF,
  proofOfRun,
  requiresAcceptance,
  runProof,
} from './coverage';

describe('coverage tiers and proof methods (M9A, ADR 0023)', () => {
  it('maps every proof method to a tier in code', () => {
    expect(TIER_OF).toEqual({
      count: 'externally_grounded',
      operator_full_file: 'stable_snapshot',
      manifest: 'externally_grounded',
      double_enumeration: 'stable_snapshot',
      success_marker: 'stable_snapshot',
    });
    for (const m of ProofMethodSchema.options) expect(TIER_OF[m]).toBeDefined();
    expect(Object.isFrozen(TIER_OF)).toBe(true);
  });

  it('M7 CSV imports (operator_full_file) are stable_snapshot, not externally grounded (A2)', () => {
    expect(TIER_OF.operator_full_file).toBe('stable_snapshot');
    expect(runProof('operator_full_file')).toEqual({
      method: 'operator_full_file',
      tier: 'stable_snapshot',
      outcome: 'passed',
    });
  });

  it('only adapter-declared stable methods need an acceptance; CSV imports do not', () => {
    expect(requiresAcceptance('count')).toBe(false);
    expect(requiresAcceptance('manifest')).toBe(false);
    expect(requiresAcceptance('operator_full_file')).toBe(false);
    expect(requiresAcceptance('double_enumeration')).toBe(true);
    expect(requiresAcceptance('success_marker')).toBe(true);
  });

  it('M9B: double enumeration is stable_snapshot, never externally grounded (C6)', () => {
    expect(runProof('double_enumeration')).toEqual({
      method: 'double_enumeration',
      tier: 'stable_snapshot',
      outcome: 'passed',
    });
    expect(TIER_OF.double_enumeration).not.toBe('externally_grounded');
  });

  it('M9B: an acceptance names one connection and the stable_snapshot tier, and never promotes', () => {
    const ok = [{ connectionId: 'c1', tier: 'stable_snapshot', by: 'op' }];
    expect(acceptsStableSnapshot(ok, 'c1')).toBe(true);
    expect(acceptsStableSnapshot(ok, 'c2')).toBe(false);
    expect(acceptsStableSnapshot([{ connectionId: 'c1', tier: 'externally_grounded' }], 'c1')).toBe(
      false,
    );
    for (const junk of [undefined, null, {}, 'c1', [null], [{}]]) {
      expect(acceptsStableSnapshot(junk, 'c1')).toBe(false);
    }
    // Accepted or not, the tier of the proof is the method's tier.
    expect(proofOfRun({ proof: runProof('double_enumeration') }, 'count').tier).toBe(
      'stable_snapshot',
    );
  });

  it('reads a recorded proof, re-deriving the tier from the method (a stored tier never promotes)', () => {
    expect(proofOfRun({ proof: runProof('count') }, 'operator_full_file')).toEqual({
      method: 'count',
      tier: 'externally_grounded',
      inferred: false,
    });
    // A tampered stored tier is ignored: the tier is always re-derived from the method.
    expect(
      proofOfRun(
        { proof: { method: 'operator_full_file', tier: 'externally_grounded', outcome: 'passed' } },
        'operator_full_file',
      ),
    ).toEqual({ method: 'operator_full_file', tier: 'stable_snapshot', inferred: false });
  });

  it('infers the proof of runs completed before M9A from their kind (no backfill)', () => {
    expect(proofOfRun({}, 'count')).toEqual({
      method: 'count',
      tier: 'externally_grounded',
      inferred: true,
    });
    expect(proofOfRun(null, 'operator_full_file')).toEqual({
      method: 'operator_full_file',
      tier: 'stable_snapshot',
      inferred: true,
    });
  });
});
