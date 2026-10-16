import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_RELEASE_FIELD,
  decideAttributes,
  heldAttributes,
  linkClosesCycle,
  validateContract,
  validateEntitlement,
  validatePriceOffer,
  type ContractAttributes,
  type PriceOfferAttributes,
} from './commercial.rules';

const offer: PriceOfferAttributes = {
  productKey: 'core',
  currency: 'EUR',
  billingPeriod: 1,
  billingPeriodUnit: 'month',
  pricingModel: 'per_unit',
  listAmountMinor: 1000,
  status: 'active',
};
const contract: ContractAttributes = {
  contextId: null,
  startsAt: '2027-01-01T00:00:00.000Z',
  endsAt: '2027-12-31T00:00:00.000Z',
  renewalDate: '2027-12-01',
  autoRenew: true,
  status: 'active',
  totalValueMinor: 5000,
  totalValueCurrency: 'EUR',
  renewsContractId: null,
  amendsContractId: null,
  parentContractId: null,
};

describe('M10F commercial rules (plan §5, V6 / V7 / V10 / V17)', () => {
  it('V6: price offer shape — currency shape, period pair, closed codes, amount ≥ 0', () => {
    expect(validatePriceOffer(offer)).toBeUndefined();
    expect(validatePriceOffer({ ...offer, currency: 'eur' })).toBe('currency_invalid');
    expect(validatePriceOffer({ ...offer, currency: 'EURO' })).toBe('currency_invalid');
    expect(validatePriceOffer({ ...offer, billingPeriodUnit: null })).toBe('billing_period_pair');
    expect(validatePriceOffer({ ...offer, billingPeriod: 0 })).toBe('billing_period_invalid');
    expect(validatePriceOffer({ ...offer, billingPeriodUnit: 'quarter' })).toBe(
      'billing_period_unit_invalid',
    );
    expect(validatePriceOffer({ ...offer, pricingModel: 'tiers' })).toBe('pricing_model_invalid');
    expect(validatePriceOffer({ ...offer, listAmountMinor: -1 })).toBe('amount_invalid');
    expect(validatePriceOffer({ ...offer, listAmountMinor: 1.5 })).toBe('amount_invalid');
    expect(validatePriceOffer({ ...offer, status: 'expired' })).toBe('status_invalid');
    expect(
      validatePriceOffer({ ...offer, billingPeriod: null, billingPeriodUnit: null }),
    ).toBeUndefined();
  });

  it('V7: contract shape — status, period order, renewal date, money pair', () => {
    expect(validateContract(contract)).toBeUndefined();
    expect(validateContract({ ...contract, status: 'renewed' })).toBe('status_invalid');
    expect(validateContract({ ...contract, endsAt: '2026-01-01T00:00:00.000Z' })).toBe(
      'period_invalid',
    );
    expect(validateContract({ ...contract, startsAt: 'yesterday' })).toBe('timestamp_invalid');
    expect(validateContract({ ...contract, renewalDate: '2027-02-30' })).toBe(
      'renewal_date_invalid',
    );
    expect(validateContract({ ...contract, totalValueCurrency: null })).toBe('money_pair');
    expect(validateContract({ ...contract, totalValueMinor: null })).toBe('money_pair');
    expect(
      validateContract({ ...contract, totalValueMinor: null, totalValueCurrency: null }),
    ).toBeUndefined();
    expect(validateContract({ ...contract, totalValueMinor: -5 })).toBe('amount_invalid');
  });

  it('entitlement shape — quantity ≥ 0, closed status, period order', () => {
    const e = {
      productKey: 'core',
      quantity: 3,
      status: 'active',
      startsAt: null,
      endsAt: null,
    };
    expect(validateEntitlement(e)).toBeUndefined();
    expect(validateEntitlement({ ...e, quantity: -1 })).toBe('quantity_invalid');
    expect(validateEntitlement({ ...e, status: 'retired' })).toBe('status_invalid');
    expect(validateEntitlement({ ...e, productKey: 'Bad Key' })).toBe('product_key_invalid');
  });

  it('V10 / Q7: a link closing a cycle over the union of the three kinds is detected', () => {
    // A renews B, B amends C; C parent → A would close a cycle across kinds.
    const graph = new Map([
      ['A', ['B']],
      ['B', ['C']],
    ]);
    expect(linkClosesCycle(graph, 'C', 'A')).toBe(true);
    expect(linkClosesCycle(graph, 'A', 'C')).toBe(false);
    expect(linkClosesCycle(graph, 'D', 'A')).toBe(false);
    expect(linkClosesCycle(graph, 'A', 'A')).toBe(true);
  });

  it('Q17: held attributes = human changes newer than the newest release', () => {
    const changes = [
      { origin: 'human', changedFields: ['status'] },
      { origin: 'source_provided', changedFields: ['endsAt'] },
      { origin: 'human', changedFields: [COMMERCIAL_RELEASE_FIELD] },
      { origin: 'human', changedFields: ['startsAt'] },
    ];
    expect([...heldAttributes(changes, ['status', 'startsAt', 'endsAt'])]).toEqual(['status']);
  });

  it('Q17: a source value never overwrites a held attribute; the difference is a disagreement', () => {
    const d = decideAttributes(
      { status: 'active', endsAt: '2027-01-01T00:00:00.000Z' },
      { status: 'terminated', endsAt: '2027-01-01T00:00:00Z' },
      new Set(['status']),
    );
    expect(d.changedFields).toEqual([]);
    expect(d.disagreements).toEqual(['status']);
    const op = decideAttributes({ status: 'active' }, { status: 'terminated' });
    expect(op.apply).toEqual({ status: 'terminated' });
  });
});
