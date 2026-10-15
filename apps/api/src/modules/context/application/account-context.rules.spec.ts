import { describe, expect, it } from 'vitest';
import { contextNaturalKeyHash, type ContextTypeDefinition } from '../../domain';
import {
  decideMemberAdd,
  decideMemberEnd,
  decideOperatorAttributes,
  decideSourceAttributes,
  HUMAN_OVERRIDE_RELEASE_FIELD,
  humanHeldAttributes,
  membershipEntityId,
  nameValid,
  ownerRefValid,
  planCompanyMerge,
  planMemberMove,
  validateDimensions,
  type ContextAttributes,
  type MemberRow,
} from './account-context.rules';

const TYPE: Pick<ContextTypeDefinition, 'dimensions'> = {
  dimensions: [
    { key: 'product', type: 'product_key', required: true },
    { key: 'region', type: 'code', required: false, codes: ['emea', 'amer'] },
    { key: 'label', type: 'string', required: false },
    { key: 'tier', type: 'extension_ref', required: false, extension_field: 'tier' },
  ],
};

const LOOKUPS = {
  products: new Map([
    ['core', true],
    ['old', false],
  ]),
  extensionValue: (field: string, raw: unknown) =>
    field === 'tier' && (raw === 'gold' || raw === 'silver') ? (raw as string) : undefined,
};

describe('validateDimensions (plan §4.1)', () => {
  it('normalises, hashes in type order and collects product memberships', () => {
    const r = validateDimensions(TYPE, { region: 'emea', product: 'core', label: ' x ' }, LOOKUPS);
    expect(r).toEqual({
      ok: true,
      dimensions: { product: 'core', region: 'emea', label: 'x' },
      naturalKeyHash: contextNaturalKeyHash(['product', 'region', 'label', 'tier'], {
        product: 'core',
        region: 'emea',
        label: 'x',
      }),
      productKeys: ['core'],
    });
  });

  it('treats an empty optional dimension as absent (same natural key)', () => {
    const a = validateDimensions(TYPE, { product: 'core' }, LOOKUPS);
    const b = validateDimensions(TYPE, { product: 'core', region: '', tier: null }, LOOKUPS);
    expect(a.ok && b.ok && a.naturalKeyHash === b.naturalKeyHash).toBe(true);
  });

  it.each([
    [{ product: 'core', nope: 'x' }, 'dimension_unknown', 'nope'],
    [{ region: 'emea' }, 'dimension_required', 'product'],
    [{ product: 'missing' }, 'product_unknown', 'product'],
    [{ product: 'old' }, 'product_retired', 'product'],
    [{ product: 'core', region: 'apac' }, 'code_unknown', 'region'],
    [{ product: 'core', label: 'x'.repeat(201) }, 'dimension_invalid', 'label'],
    [{ product: 'core', label: 42 }, 'dimension_invalid', 'label'],
    [{ product: 'core', tier: 'bronze' }, 'extension_value_invalid', 'tier'],
    [{ product: 'core', label: 'AKIA' + 'IOSFODNN7EXAMPLE' }, 'secret_like_value', 'label'],
  ])('%j → %s', (raw, code, key) => {
    expect(validateDimensions(TYPE, raw, LOOKUPS)).toEqual({ ok: false, code, key });
  });
});

describe('owner_ref and name shapes (Q12)', () => {
  it('owner_ref is an opaque id: emails and secrets refused', () => {
    expect(ownerRefValid('005Dn000001AbCd')).toBe(true);
    expect(ownerRefValid('csm:42')).toBe(true);
    expect(ownerRefValid('jane@example.com')).toBe(false);
    expect(ownerRefValid('')).toBe(false);
  });
  it('name is 1–200 chars', () => {
    expect(nameValid('EMEA Core')).toBe(true);
    expect(nameValid('  ')).toBe(false);
    expect(nameValid('n'.repeat(201))).toBe(false);
  });
});

describe('Q14: human hold derived from change records', () => {
  it('unions human attribute changes newer than the newest release', () => {
    const held = humanHeldAttributes([
      { origin: 'human', changedFields: ['ownerRef'] },
      { origin: 'source_provided', changedFields: ['name'] },
      { origin: 'human', changedFields: ['status'] },
      { origin: 'human', changedFields: [HUMAN_OVERRIDE_RELEASE_FIELD] },
      { origin: 'human', changedFields: ['name'] },
    ]);
    expect([...held].sort()).toEqual(['ownerRef', 'status']);
  });
  it('nothing held after a release or without human changes', () => {
    expect(humanHeldAttributes([]).size).toBe(0);
    expect(
      humanHeldAttributes([{ origin: 'human', changedFields: [HUMAN_OVERRIDE_RELEASE_FIELD] }])
        .size,
    ).toBe(0);
  });

  const current: ContextAttributes = {
    name: 'A',
    status: 'active',
    ownerRef: 'o1',
    renewalDate: null,
  };

  it('source values apply unless held; held differing values are disagreements', () => {
    const d = decideSourceAttributes(
      current,
      { name: 'B', ownerRef: 'o2', renewalDate: '2027-01-31' },
      new Set(['ownerRef']),
    );
    expect(d.apply).toEqual({ name: 'B', renewalDate: '2027-01-31' });
    expect(d.changedFields).toEqual(['name', 'renewalDate']);
    expect(d.disagreements).toEqual(['ownerRef']);
  });
  it('equal values and unmapped attributes change nothing', () => {
    const d = decideSourceAttributes(current, { name: 'A' }, new Set(['name']));
    expect(d).toEqual({ apply: {}, changedFields: [], disagreements: [] });
  });
  it('retired is terminal for the source; an operator may reactivate', () => {
    const retired = { ...current, status: 'retired' as const };
    expect(decideSourceAttributes(retired, { status: 'active' }, new Set()).changedFields).toEqual(
      [],
    );
    expect(decideOperatorAttributes(retired, { status: 'active' }).apply).toEqual({
      status: 'active',
    });
  });
});

describe('memberships (Q10): reactivation, never deletion', () => {
  it('add / end decisions', () => {
    expect(decideMemberAdd(undefined)).toBe('insert');
    expect(decideMemberAdd({ status: 'active' })).toBe('unchanged');
    expect(decideMemberAdd({ status: 'ended' })).toBe('reactivate');
    expect(decideMemberEnd(undefined)).toBe('missing');
    expect(decideMemberEnd({ status: 'active' })).toBe('end');
    expect(decideMemberEnd({ status: 'ended' })).toBe('unchanged');
  });

  it('membership entity id is a stable uuid per primary key', () => {
    const a = membershipEntityId('c', 'p', 'csm');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(membershipEntityId('c', 'p', 'csm')).toBe(a);
    expect(membershipEntityId('c', 'p', 'exec')).not.toBe(a);
  });

  const t0 = new Date(Date.UTC(2026, 0, 1));
  const row = (
    contextId: string,
    personId: string,
    roleCode: string,
    status: string,
  ): MemberRow => ({
    contextId,
    personId,
    roleCode,
    status,
    startedAt: t0,
    endedAt: status === 'ended' ? t0 : null,
  });

  it('person merge: moves, duplicate role ended on the loser, reactivates an ended survivor row', () => {
    const plan = planMemberMove(
      [
        row('c1', 'L', 'csm', 'active'),
        row('c2', 'L', 'exec', 'active'),
        row('c3', 'L', 'csm', 'ended'),
      ],
      [row('c1', 'S', 'csm', 'active'), row('c2', 'S', 'exec', 'ended')],
      (r) => ({ ...r, personId: 'S' }),
    );
    expect(plan.insert.map((r) => `${r.contextId}/${r.personId}/${r.status}`)).toEqual([
      'c3/S/ended',
    ]);
    expect(plan.reactivate.map((r) => `${r.contextId}/${r.personId}`)).toEqual(['c2/S']);
    expect(plan.end.map((r) => `${r.contextId}/${r.personId}`)).toEqual(['c1/L', 'c2/L']);
  });

  it('company-merge collision: members move to the survivor context', () => {
    const plan = planMemberMove([row('lc', 'p1', 'csm', 'active')], [], (r) => ({
      ...r,
      contextId: 'sc',
    }));
    expect(plan.insert).toEqual([{ ...row('sc', 'p1', 'csm', 'active') }]);
    expect(plan.end).toEqual([row('lc', 'p1', 'csm', 'active')]);
  });
});

describe('company merge (Q15)', () => {
  it('re-points non-colliding loser contexts and merges natural-key collisions', () => {
    const plan = planCompanyMerge(
      [
        { id: 'l2', contextTypeId: 't', naturalKeyHash: 'k1', recordState: 'active' },
        { id: 'l1', contextTypeId: 't', naturalKeyHash: 'k2', recordState: 'active' },
        { id: 'l0', contextTypeId: 't', naturalKeyHash: 'k1', recordState: 'merged' },
      ],
      [
        { id: 's1', contextTypeId: 't', naturalKeyHash: 'k1', recordState: 'active' },
        { id: 's0', contextTypeId: 't', naturalKeyHash: 'k2', recordState: 'merged' },
      ],
    );
    expect(plan).toEqual({ repoint: ['l1'], collisions: [{ loserId: 'l2', survivorId: 's1' }] });
  });
});
