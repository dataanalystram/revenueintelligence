import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPANY, genericModel, indexed, line } from '../../../test/support/product-models';
import type { CustomerStatus } from './company';
import {
  classifyWhitespace,
  deriveOwnership,
  evaluateEligibility,
  factsHash,
  UnknownProductError,
  type EligibilityResult,
  type OwnershipInput,
} from './eligibility';
import type { ProductKey } from './product';
import type { ProductModelDocumentInput } from './product-model';
import { SubscriptionFactSchema, type SubscriptionFact } from './subscription';

const AS_OF = new Date('2026-10-02T12:00:00Z');
const model = indexed();

function known(...lines: SubscriptionFact[]): OwnershipInput {
  return { coverage: 'known', knownAsOf: new Date('2026-10-01T00:00:00Z'), subscriptions: lines };
}

function evaluate(
  productKey: string,
  ownership: OwnershipInput,
  opts: { customerStatus?: CustomerStatus; asOf?: Date; doc?: ProductModelDocumentInput } = {},
): EligibilityResult {
  return evaluateEligibility({
    model: opts.doc ? indexed(opts.doc) : model,
    account: { companyId: COMPANY, customerStatus: opts.customerStatus ?? 'customer' },
    ownership,
    productKey: productKey as ProductKey,
    asOf: opts.asOf ?? AS_OF,
  });
}

const check = (r: EligibilityResult, code: string) => r.checks.filter((c) => c.check === code);

afterEach(() => vi.useRealTimers());

describe('ownership derivation (ADR 0017 §2)', () => {
  const own = (o: OwnershipInput, key: string, asOf = AS_OF, doc?: ProductModelDocumentInput) =>
    deriveOwnership(doc ? indexed(doc) : model, o, asOf).get(key as ProductKey)!.status;

  it('is unknown for every product until a full load completed (never "owns nothing")', () => {
    for (const key of model.products.keys())
      expect(own({ coverage: 'unknown' }, key)).toBe('unknown');
  });

  it('counts active and trial lines by default; expired and cancelled do not count', () => {
    expect(own(known(line('core', 'active')), 'core')).toBe('owned');
    expect(own(known(line('core', 'trial')), 'core')).toBe('owned');
    expect(
      own(known(line('core', 'expired', { endsAt: new Date('2026-01-01T00:00:00Z') })), 'core'),
    ).toBe('not_owned');
    expect(own(known(line('core', 'cancelled')), 'core')).toBe('not_owned');
    expect(own(known(), 'core')).toBe('not_owned');
  });

  it('follows ownedStates: trial does not count when the model says active only', () => {
    const doc = genericModel({ ownership: { ownedStates: ['active'] } });
    expect(own(known(line('core', 'trial')), 'core', AS_OF, doc)).toBe('not_owned');
  });

  it('respects date windows at the exact boundaries (start inclusive, end exclusive)', () => {
    expect(own(known(line('core', 'active', { startsAt: AS_OF })), 'core')).toBe('owned');
    expect(
      own(known(line('core', 'active', { startsAt: new Date(AS_OF.getTime() + 1) })), 'core'),
    ).toBe('not_owned');
    expect(own(known(line('core', 'active', { endsAt: AS_OF })), 'core')).toBe('not_owned');
    expect(
      own(known(line('core', 'active', { endsAt: new Date(AS_OF.getTime() + 1) })), 'core'),
    ).toBe('owned');
  });

  it('treats a future-dated subscription as not owned yet', () => {
    expect(
      own(known(line('core', 'active', { startsAt: new Date('2027-01-01T00:00:00Z') })), 'core'),
    ).toBe('not_owned');
  });

  it('owns a product when an expired line and its renewal overlap', () => {
    const lines = known(
      line('core', 'expired', {
        startsAt: new Date('2025-01-01T00:00:00Z'),
        endsAt: new Date('2026-01-01T00:00:00Z'),
      }),
      line('core', 'active', {
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2027-01-01T00:00:00Z'),
      }),
    );
    expect(own(lines, 'core')).toBe('owned');
  });

  it('owns a product when one line is active and another cancelled', () => {
    expect(own(known(line('core', 'cancelled'), line('core', 'active')), 'core')).toBe('owned');
  });

  it('is unknown for a line in state unknown, unless another line proves ownership', () => {
    expect(own(known(line('core', 'unknown')), 'core')).toBe('unknown');
    expect(own(known(line('core', 'unknown'), line('core', 'active')), 'core')).toBe('owned');
  });

  it('is unknown when the source says cancelled but the term is still running', () => {
    const l = line('core', 'cancelled', { endsAt: new Date('2026-12-31T00:00:00Z') });
    const r = deriveOwnership(model, known(l), AS_OF).get('core' as ProductKey)!;
    expect(r).toMatchObject({ status: 'unknown', reason: 'subscription_state_conflict' });
  });

  it('closes over includes, including nested bundles, without creating lines', () => {
    expect(own(known(line('suite')), 'reporting')).toBe('owned');
    expect(own(known(line('suite')), 'analytics')).toBe('owned');
    const nested = genericModel({
      products: [...genericModel().products, { key: 'mega', name: 'Mega', family: 'bundles' }],
      relationships: [
        ...genericModel().relationships!,
        { id: 'mega-has-suite', type: 'includes', product: 'mega', included: 'suite' },
      ],
    });
    const m = deriveOwnership(indexed(nested), known(line('mega')), AS_OF);
    expect(m.get('reporting' as ProductKey)).toMatchObject({
      status: 'owned',
      facts: [{ kind: 'product', key: 'suite', via: 'includes' }],
    });
  });

  it('propagates unknown through a bundle', () => {
    expect(own(known(line('suite', 'unknown')), 'reporting')).toBe('unknown');
  });

  it('ignores lines for products this model version does not know', () => {
    expect(() => deriveOwnership(model, known(line('ghost')), AS_OF)).not.toThrow();
  });

  it('rejects a subscription that ends before it starts; a zero-length term is never owned', () => {
    expect(
      SubscriptionFactSchema.safeParse({
        ...line('core'),
        startsAt: AS_OF,
        endsAt: new Date(AS_OF.getTime() - 1),
      }).success,
    ).toBe(false);
    const zero = SubscriptionFactSchema.parse({ ...line('core'), startsAt: AS_OF, endsAt: AS_OF });
    expect(own(known(zero), 'core')).toBe('not_owned');
  });
});

describe('eligibility checks (ADR 0018)', () => {
  it('is unknown with ownership_not_loaded when coverage is not complete', () => {
    const r = evaluate('analytics', { coverage: 'unknown' });
    expect(r.status).toBe('unknown');
    expect(check(r, 'ownership_coverage')[0]).toMatchObject({
      outcome: 'unknown',
      reason: 'ownership_not_loaded',
    });
    expect(r.ownership).toBe('unknown');
  });

  it('an account with an ownership gap is unknown with ownership_incomplete (M8), distinct from not loaded', () => {
    const r = evaluate('analytics', { coverage: 'unknown', reason: 'ownership_incomplete' });
    expect(r.status).toBe('unknown');
    expect(r.ownership).toBe('unknown');
    expect(check(r, 'ownership_coverage')[0]).toMatchObject({
      outcome: 'unknown',
      reason: 'ownership_incomplete',
    });
    // Never a not-owned inference for any product of the account.
    for (const own of deriveOwnership(
      model,
      { coverage: 'unknown', reason: 'ownership_incomplete' },
      AS_OF,
    ).values()) {
      expect(own).toMatchObject({ status: 'unknown', reason: 'ownership_incomplete' });
    }
    // The reason is part of the frozen facts (a gap and "not loaded" never hash alike).
    expect(r.factsHash).not.toBe(evaluate('analytics', { coverage: 'unknown' }).factsHash);
  });

  it('is eligible when every check passes, and explains each one', () => {
    const r = evaluate('analytics', known(line('core')));
    expect(r.status).toBe('eligible');
    expect(r.ownership).toBe('not_owned');
    expect(r.checks.map((c) => c.check)).toEqual([
      'ownership_coverage',
      'product_available',
      'not_already_owned',
      'not_superseded',
      'not_excluded',
      'requirements_met',
    ]);
    expect(check(r, 'requirements_met')[0]).toMatchObject({
      ruleId: 'analytics-needs-core',
      outcome: 'pass',
    });
    expect(r).toMatchObject({ modelVersion: 1, evaluatorVersion: 2 });
    expect(r.modelHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.factsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('already owned → ineligible (already_owned), naming the line', () => {
    const l = line('analytics');
    const r = evaluate('analytics', known(line('core'), l));
    expect(r.status).toBe('ineligible');
    expect(r.ownership).toBe('owned');
    expect(check(r, 'not_already_owned')[0]).toMatchObject({
      outcome: 'fail',
      reason: 'already_owned',
      facts: [{ kind: 'subscription', id: l.id }],
    });
  });

  it('owned through a bundle → already owned via includes', () => {
    const r = evaluate('reporting', known(line('suite')));
    expect(check(r, 'not_already_owned')[0]).toMatchObject({
      outcome: 'fail',
      facts: [{ kind: 'product', key: 'suite', via: 'includes' }],
    });
  });

  it('owning a replacement makes the replaced product ineligible, not the other way round', () => {
    const r = evaluate('analytics', known(line('core'), line('analytics-plus')));
    expect(check(r, 'not_superseded')[0]).toMatchObject({
      outcome: 'fail',
      reason: 'superseded_by_owned',
      ruleId: 'plus-replaces-analytics',
    });
    const upgrade = evaluate('analytics-plus', known(line('core'), line('analytics')));
    expect(upgrade.status).toBe('eligible'); // the upgrade path stays open
  });

  it('a replacement chain applies one link at a time (no transitive rewriting)', () => {
    const doc = genericModel({
      products: [
        ...genericModel().products,
        { key: 'core-max', name: 'Core Max', family: 'platform' },
      ],
      relationships: [
        ...genericModel().relationships!,
        { id: 'max-replaces-pro', type: 'replaces', product: 'core-max', replaced: 'core-pro' },
      ],
    });
    expect(evaluate('core-pro', known(line('core-max')), { doc }).status).toBe('ineligible');
    expect(
      check(evaluate('core', known(line('core-max')), { doc }), 'not_superseded')[0]!.outcome,
    ).toBe('pass');
  });

  it('exclusion: owning one side makes the other ineligible (both ways)', () => {
    expect(check(evaluate('onprem', known(line('core'))), 'not_excluded')[0]).toMatchObject({
      outcome: 'fail',
      reason: 'excluded_by_owned',
      ruleId: 'cloud-or-onprem',
    });
    expect(evaluate('core', known(line('onprem'))).status).toBe('ineligible');
  });

  it('requires anyOf: met by any member, unmet when none is owned', () => {
    expect(evaluate('analytics', known(line('core-pro'))).status).toBe('eligible');
    const r = evaluate('analytics', known());
    expect(r.status).toBe('ineligible');
    expect(check(r, 'requirements_met')[0]).toMatchObject({
      outcome: 'fail',
      reason: 'requirement_unmet',
      facts: [
        { kind: 'product', key: 'core' },
        { kind: 'product', key: 'core-pro' },
      ],
    });
  });

  it('a requirement with states counts only those states', () => {
    const doc = genericModel({
      relationships: [
        {
          id: 'paid-core',
          type: 'requires',
          product: 'analytics',
          anyOf: ['core'],
          states: ['active'],
        },
      ],
    });
    expect(evaluate('analytics', known(line('core', 'trial')), { doc }).status).toBe('ineligible');
    expect(evaluate('analytics', known(line('core', 'active')), { doc }).status).toBe('eligible');
  });

  it('a requirement whose members are unknown is unknown, not unmet', () => {
    const r = evaluate('analytics', known(line('core', 'unknown')));
    expect(r.status).toBe('unknown');
    expect(check(r, 'requirements_met')[0]).toMatchObject({
      outcome: 'unknown',
      reason: 'subscription_state_unknown',
    });
  });

  it('retired products are never whitespace; retired-but-owned stays owned', () => {
    expect(check(evaluate('legacy-reports', known()), 'product_available')[0]).toMatchObject({
      outcome: 'fail',
      reason: 'product_retired',
    });
    const owned = classifyWhitespace({
      model,
      account: { companyId: COMPANY, customerStatus: 'customer' },
      ownership: known(line('legacy-reports')),
      asOf: AS_OF,
    });
    expect(owned.categories.owned.map((r) => r.productKey)).toContain('legacy-reports');
  });

  it('availability window: inclusive from, exclusive until', () => {
    const doc = genericModel({
      products: [
        {
          key: 'core',
          name: 'Core',
          availableFrom: '2026-11-01T00:00:00Z',
          availableUntil: '2027-01-01T00:00:00Z',
        },
      ],
      relationships: [],
    });
    const at = (iso: string) =>
      check(evaluate('core', known(), { doc, asOf: new Date(iso) }), 'product_available')[0]!
        .outcome;
    expect(at('2026-10-31T23:59:59.999Z')).toBe('fail');
    expect(at('2026-11-01T00:00:00.000Z')).toBe('pass');
    expect(at('2026-12-31T23:59:59.999Z')).toBe('pass');
    expect(at('2027-01-01T00:00:00.000Z')).toBe('fail');
  });

  it('timezone offsets in input do not change the instant compared', () => {
    const doc = genericModel({
      products: [{ key: 'core', name: 'Core', availableFrom: '2026-11-01T01:00:00+01:00' }],
      relationships: [],
    });
    expect(
      check(
        evaluate('core', known(), { doc, asOf: new Date('2026-11-01T00:00:00Z') }),
        'product_available',
      )[0]!.outcome,
    ).toBe('pass');
  });

  describe('account_attribute conditions', () => {
    const doc = genericModel({
      conditions: [
        {
          id: 'customers-only',
          type: 'account_attribute',
          appliesTo: { families: ['addons'] },
          attribute: 'customer_status',
          op: 'in',
          values: ['customer'],
        },
        {
          id: 'not-former',
          type: 'account_attribute',
          appliesTo: { products: ['core'] },
          attribute: 'customer_status',
          op: 'not_in',
          values: ['former_customer'],
        },
      ],
    });
    it('passes, fails or is unknown by the account value', () => {
      expect(evaluate('reporting', known(), { doc, customerStatus: 'customer' }).status).toBe(
        'eligible',
      );
      expect(
        check(
          evaluate('reporting', known(), { doc, customerStatus: 'prospect' }),
          'account_attribute',
        )[0],
      ).toMatchObject({
        outcome: 'fail',
        reason: 'condition_not_met',
        ruleId: 'customers-only',
        facts: [{ kind: 'attribute', name: 'customer_status', value: 'prospect' }],
      });
      expect(
        check(
          evaluate('reporting', known(), { doc, customerStatus: 'unknown' }),
          'account_attribute',
        )[0],
      ).toMatchObject({
        outcome: 'unknown',
        reason: 'attribute_missing',
      });
      expect(evaluate('core', known(), { doc, customerStatus: 'former_customer' }).status).toBe(
        'ineligible',
      );
    });
    it('only applies to the products it names', () => {
      expect(
        check(evaluate('suite', known(), { doc, customerStatus: 'prospect' }), 'account_attribute'),
      ).toEqual([]);
    });
  });

  it('precedence: a hard fail wins over unknown; unknown wins over eligible', () => {
    // analytics-plus owned (supersedes analytics) and core unknown (requirement unknown).
    const r = evaluate('analytics', known(line('analytics-plus'), line('core', 'unknown')));
    expect(r.checks.some((c) => c.outcome === 'unknown')).toBe(true);
    expect(r.status).toBe('ineligible');
    expect(evaluate('analytics', known(line('core', 'unknown'))).status).toBe('unknown');
  });

  it('never short-circuits: all failing reasons are reported together', () => {
    const r = evaluate('analytics', known(line('analytics'), line('analytics-plus')));
    expect(r.checks.filter((c) => c.outcome === 'fail').map((c) => c.reason)).toEqual(
      expect.arrayContaining(['already_owned', 'superseded_by_owned', 'requirement_unmet']),
    );
  });

  it('throws for a product key the model does not contain', () => {
    expect(() => evaluate('ghost', known())).toThrow(UnknownProductError);
  });

  it('never reads the clock: the same asOf gives the same result at any wall time', () => {
    const facts = known(line('core'));
    const a = evaluate('analytics', facts);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    expect(evaluate('analytics', facts)).toEqual(a);
  });

  it('factsHash ignores line order and changes when a fact changes', () => {
    const a = line('core');
    const b = line('analytics');
    const account = { companyId: COMPANY, customerStatus: 'customer' as const };
    expect(factsHash({ account, ownership: known(a, b), asOf: AS_OF })).toBe(
      factsHash({ account, ownership: known(b, a), asOf: AS_OF }),
    );
    expect(factsHash({ account, ownership: known(a), asOf: AS_OF })).not.toBe(
      factsHash({ account, ownership: known(a, b), asOf: AS_OF }),
    );
  });
});

describe('whitespace (ADR 0018 §4)', () => {
  it('groups every catalogue product into owned / eligible / ineligible / unknown', () => {
    const ws = classifyWhitespace({
      model,
      account: { companyId: COMPANY, customerStatus: 'customer' },
      ownership: known(line('core'), line('reporting', 'unknown')),
      asOf: AS_OF,
    });
    const keys = (c: keyof typeof ws.categories) => ws.categories[c].map((r) => r.productKey);
    expect(keys('owned')).toEqual(['core']);
    expect(keys('eligible_whitespace')).toEqual([
      'analytics',
      'analytics-plus',
      'core-pro',
      'suite',
    ]);
    expect(keys('ineligible_whitespace')).toEqual(['legacy-reports', 'onprem']);
    expect(keys('unknown')).toEqual(['reporting']);
    const total = Object.values(ws.categories).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(model.products.size);
  });

  it('an account with an ownership gap has no eligible whitespace and nothing owned', () => {
    const ws = classifyWhitespace({
      model,
      account: { companyId: COMPANY, customerStatus: 'customer' },
      ownership: { coverage: 'unknown', reason: 'ownership_incomplete' },
      asOf: AS_OF,
    });
    expect(ws.categories.eligible_whitespace).toEqual([]);
    expect(ws.categories.owned).toEqual([]);
  });

  it('with unknown coverage nothing is eligible whitespace', () => {
    const ws = classifyWhitespace({
      model,
      account: { companyId: COMPANY, customerStatus: 'customer' },
      ownership: { coverage: 'unknown' },
      asOf: AS_OF,
    });
    expect(ws.categories.eligible_whitespace).toEqual([]);
    expect(ws.categories.owned).toEqual([]);
  });

  it('evaluates a maximum-size catalogue in memory quickly', () => {
    const doc: ProductModelDocumentInput = {
      products: Array.from({ length: 2000 }, (_, i) => ({ key: `p${i}`, name: `P${i}` })),
      relationships: Array.from({ length: 1999 }, (_, i) => ({
        id: `r${i}`,
        type: 'includes' as const,
        product: `p${i}`,
        included: `p${i + 1}`,
      })),
    };
    const big = indexed(doc);
    const started = performance.now();
    const ws = classifyWhitespace({
      model: big,
      account: { companyId: COMPANY, customerStatus: 'customer' },
      ownership: known(line('p0')),
      asOf: AS_OF,
    });
    expect(ws.categories.owned).toHaveLength(2000); // a 2000-deep bundle chain closes fully
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
