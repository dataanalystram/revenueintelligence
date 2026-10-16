import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_KIND_MODULES,
  EVIDENCE_RELATIONS,
  evidenceRelationAllowed,
  validateEvidenceSet,
  type EvidenceRelation,
  type EvidenceSetInput,
} from './evidence';

/** M10B plan §3.2: layer-1 validation of an evidence link set (pure). */
const RELATIONS: readonly EvidenceRelation[] = [
  {
    subjectKind: 'subscription',
    evidenceType: 'entity',
    evidenceKind: 'company',
    roles: ['supports'],
  },
  {
    subjectKind: 'subscription',
    evidenceType: 'entity',
    evidenceKind: 'product',
    roles: ['context'],
  },
  { subjectKind: 'subscription', evidenceType: 'change_record', roles: ['derived_from'] },
  { subjectKind: 'subscription', evidenceType: 'eligibility_snapshot', roles: ['supports'] },
];
const S = '00000000-0000-4000-8000-000000000001';
const C = '00000000-0000-4000-8000-000000000002';
const H = 'a'.repeat(64);

const base = (over: Partial<EvidenceSetInput> = {}): EvidenceSetInput => ({
  subjectKind: 'subscription',
  subjectId: S,
  origin: 'deterministic',
  derivation: { key: 'test.rule', version: '1', inputsHash: H },
  links: [
    {
      ordinal: 0,
      evidenceType: 'entity',
      evidenceKind: 'company',
      evidenceId: C,
      role: 'supports',
    },
    {
      ordinal: 1,
      evidenceType: 'entity',
      evidenceKind: 'product',
      evidenceKey: 'crm',
      role: 'context',
    },
    { ordinal: 2, evidenceType: 'change_record', evidenceChangeId: C, role: 'derived_from' },
    {
      ordinal: 3,
      evidenceType: 'eligibility_snapshot',
      evidenceSnapshotId: C,
      role: 'supports',
      weight: 0.5,
    },
  ],
  ...over,
});
const reasons = (set: EvidenceSetInput, rel = RELATIONS) =>
  validateEvidenceSet(set, rel).map((i) => i.reason);

describe('validateEvidenceSet', () => {
  it('accepts a valid set', () => {
    expect(validateEvidenceSet(base(), RELATIONS)).toEqual([]);
  });

  it('the production catalogue is empty in M10B (Q13): every relation is refused', () => {
    expect(EVIDENCE_RELATIONS).toEqual([]);
    expect(validateEvidenceSet(base(), EVIDENCE_RELATIONS).map((i) => i.code)).toEqual(
      Array(4).fill('evidence_relation_not_allowed'),
    );
    // M10D (#71): custom records are the first module-owned kind.
    // M10E (#71): account contexts are the second.
    expect(EVIDENCE_KIND_MODULES).toEqual({
      custom_record: 'extension',
      account_context: 'account_context',
      // M10F: the commercial kinds belong to the commercial module.
      price_offer: 'commercial',
      contract: 'commercial',
      entitlement: 'commercial',
    });
  });

  it('set size 1–200 and unique ordinals in range', () => {
    expect(reasons(base({ links: [] }))).toContain('set_size');
    const many = Array.from({ length: 201 }, (_, i) => ({
      ordinal: i,
      evidenceType: 'change_record' as const,
      evidenceChangeId: C,
      role: 'derived_from' as const,
    }));
    expect(reasons(base({ links: many }))).toContain('set_size');
    const dup = base().links.map((l) => ({ ...l, ordinal: 7 }));
    expect(reasons(base({ links: dup }))).toContain('ordinal_duplicate');
    expect(reasons(base({ links: [{ ...base().links[0]!, ordinal: 1000 }] }))).toContain(
      'ordinal_range',
    );
  });

  it('derivation iff a derived origin', () => {
    expect(reasons(base({ derivation: undefined }))).toContain('derivation_required');
    expect(reasons(base({ origin: 'human' }))).toContain('derivation_required');
    expect(reasons(base({ origin: 'human', derivation: undefined }))).toEqual([]);
    expect(
      reasons(base({ derivation: { key: 'Bad Key', version: '1', inputsHash: H } })),
    ).toContain('derivation_shape');
  });

  it('subject identity: id for id kinds, key for products', () => {
    expect(reasons(base({ subjectId: undefined }))).toContain('subject_identity');
    expect(reasons(base({ subjectKey: 'x' }))).toContain('subject_identity');
  });

  it('exactly the column group of the evidence type', () => {
    const l = base().links[0]!;
    expect(reasons(base({ links: [{ ...l, evidenceChangeId: C }] }))).toContain('evidence_group');
    expect(
      reasons(
        base({ links: [{ ordinal: 0, evidenceType: 'change_record', role: 'derived_from' }] }),
      ),
    ).toContain('evidence_group');
    expect(
      reasons(
        base({
          links: [
            {
              ordinal: 0,
              evidenceType: 'entity',
              evidenceKind: 'product',
              evidenceId: C,
              role: 'context',
            },
          ],
        }),
      ),
    ).toContain('evidence_group');
  });

  it('an entity link never cites its own subject; weight 0–1; closed roles', () => {
    const self = {
      ordinal: 0,
      evidenceType: 'entity' as const,
      evidenceKind: 'subscription' as const,
      evidenceId: S,
      role: 'supports' as const,
    };
    expect(reasons(base({ links: [self] }))).toContain('cites_own_subject');
    expect(reasons(base({ links: [{ ...base().links[3]!, weight: 1.5 }] }))).toContain('weight');
    expect(reasons(base({ links: [{ ...base().links[0]!, role: 'proves' as never }] }))).toContain(
      'role',
    );
  });

  it('relation catalogue: subject kind, evidence type / kind and role must match', () => {
    expect(
      evidenceRelationAllowed(RELATIONS, 'subscription', {
        evidenceType: 'entity',
        evidenceKind: 'company',
        role: 'supports',
      }),
    ).toBe(true);
    expect(
      evidenceRelationAllowed(RELATIONS, 'subscription', {
        evidenceType: 'entity',
        evidenceKind: 'company',
        role: 'contradicts',
      }),
    ).toBe(false);
    expect(
      evidenceRelationAllowed(RELATIONS, 'subscription', {
        evidenceType: 'entity',
        evidenceKind: 'person',
        role: 'supports',
      }),
    ).toBe(false);
    expect(
      evidenceRelationAllowed(RELATIONS, 'company', {
        evidenceType: 'change_record',
        role: 'derived_from',
      }),
    ).toBe(false);
  });
});
