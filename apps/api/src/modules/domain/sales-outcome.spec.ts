import { describe, expect, it } from 'vitest';
import { at, ids } from '../../../test/fixtures/domain';
import { SalesOutcomeSchema } from './sales-outcome';

const base = {
  id: ids.outcome,
  tenantId: ids.tenant,
  leadId: ids.lead,
  occurredAt: at(0),
  reportedBy: 'sugar',
};
const opportunity = { system: 'sugar', objectType: 'Opportunities', id: 'opp-1' };

describe('SalesOutcome', () => {
  it('records a won opportunity with value in minor units', () => {
    const o = SalesOutcomeSchema.parse({
      ...base,
      type: 'won',
      opportunity,
      value: { amountMinor: 1_250_000, currency: 'GBP' },
    });
    expect(o.value).toEqual({ amountMinor: 1_250_000, currency: 'GBP' });
  });

  it('records a disqualification with a reason code', () => {
    expect(
      SalesOutcomeSchema.parse({ ...base, type: 'disqualified', reasonCode: 'no_budget' })
        .reasonCode,
    ).toBe('no_budget');
  });

  it.each<[string, Record<string, unknown>]>([
    ['opportunity outcome without opportunity', { type: 'opportunity_created' }],
    ['value on a qualification', { type: 'qualified', value: { amountMinor: 1, currency: 'GBP' } }],
    ['opportunity on a disqualification', { type: 'disqualified', opportunity }],
    [
      'fractional amount',
      { type: 'won', opportunity, value: { amountMinor: 10.5, currency: 'GBP' } },
    ],
    ['negative amount', { type: 'won', opportunity, value: { amountMinor: -1, currency: 'GBP' } }],
    [
      'lowercase currency',
      { type: 'won', opportunity, value: { amountMinor: 1, currency: 'gbp' } },
    ],
    ['unknown type', { type: 'maybe' }],
  ])('rejects %s', (_label, over) => {
    expect(SalesOutcomeSchema.safeParse({ ...base, ...over }).success).toBe(false);
  });
});
