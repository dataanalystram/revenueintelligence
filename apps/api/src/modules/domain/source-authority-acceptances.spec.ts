import { describe, expect, it } from 'vitest';
import {
  authorityContentHash,
  authorityContentHashWith,
  ProofAcceptanceSchema,
  type AuthorityDocument,
} from './source-authority';

const A = '0a0a0a0a-0a0a-40a0-80a0-0a0a0a0a0a0a';
const B = '0b0b0b0b-0b0b-40b0-80b0-0b0b0b0b0b0b';
const doc: AuthorityDocument = {
  facts: {
    account_profile: null,
    person_profile: null,
    subscription_lines: A,
    subscription_state: null,
    subscription_terms: A,
  },
};
const acc = (connectionId: string, at?: string) => ({
  connectionId,
  tier: 'stable_snapshot' as const,
  reason: 'manifest reviewed',
  actor: 'ops',
  ...(at ? { at } : {}),
});

describe('authority proof acceptances (M9A §11.4)', () => {
  it('without acceptances the hash equals the M8 hash (parity with the M8 seed)', () => {
    expect(authorityContentHashWith(doc, [])).toBe(authorityContentHash(doc));
  });

  it('acceptances change the hash, independent of order and timestamps', () => {
    const one = authorityContentHashWith(doc, [acc(A, '2026-10-01T00:00:00.000Z'), acc(B)]);
    expect(one).not.toBe(authorityContentHash(doc));
    expect(authorityContentHashWith(doc, [acc(B, '2027-01-01T00:00:00.000Z'), acc(A)])).toBe(one);
    expect(authorityContentHashWith(doc, [acc(A)])).not.toBe(one);
  });

  it('only stable_snapshot can be accepted (no promotion to externally_grounded)', () => {
    expect(ProofAcceptanceSchema.safeParse(acc(A)).success).toBe(true);
    expect(
      ProofAcceptanceSchema.safeParse({ ...acc(A), tier: 'externally_grounded' }).success,
    ).toBe(false);
    expect(ProofAcceptanceSchema.safeParse({ ...acc(A), reason: 'my password' }).success).toBe(
      false,
    );
  });
});
