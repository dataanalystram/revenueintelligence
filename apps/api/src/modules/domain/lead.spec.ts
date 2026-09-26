import { describe, expect, it } from 'vitest';
import { at, ids } from '../../../test/fixtures/domain';
import {
  addLeadExternalRef,
  applyStageChange,
  createLead,
  dateEnteredStage,
  isLeadOpen,
  lastEnteredStage,
  LeadSchema,
  type Lead,
  type NewLeadInput,
  type StageChange,
} from './lead';
import { CodeSchema } from './shared/codes';

const newLead = (over: Partial<NewLeadInput> = {}) =>
  createLead({
    id: ids.lead,
    tenantId: ids.tenant,
    personId: ids.person,
    companyId: ids.company,
    leadType: 'new_business',
    source: { origin: 'hubspot', channel: 'demo_request', label: 'Demo request' },
    correlationId: ids.correlation,
    createdAt: at(0),
    createdBy: 'hubspot',
    ...over,
  });

const noBudget = CodeSchema.parse('no_budget');
const timing = CodeSchema.parse('bad_timing');

function apply(lead: Lead, change: StageChange): Lead {
  const result = applyStageChange(lead, change);
  if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
  return result.lead;
}

describe('createLead', () => {
  it('starts in "new" with the entry recorded', () => {
    const lead = newLead();
    expect(lead.stage).toBe('new');
    expect(lead.stageHistory).toEqual([
      { from: null, to: 'new', occurredAt: at(0), source: 'hubspot' },
    ]);
    expect(dateEnteredStage(lead, 'new')).toEqual(at(0));
    expect(isLeadOpen(lead)).toBe(true);
  });

  it('rejects an attribution that is invalid for its origin', () => {
    expect(() => newLead({ source: { origin: 'hubspot', channel: 'product_usage' } })).toThrow();
  });
});

describe('applyStageChange', () => {
  it('records the full journey with a date for every stage (Sarah: demo → qualified)', () => {
    let lead = newLead();
    lead = apply(lead, { to: 'attempting', occurredAt: at(30), source: 'sugar' });
    lead = apply(lead, { to: 'connected', occurredAt: at(70), source: 'sugar' });
    lead = apply(lead, { to: 'qualified', occurredAt: at(60 * 24 + 5), source: 'sugar' });

    expect(lead.stage).toBe('qualified');
    expect(isLeadOpen(lead)).toBe(false);
    expect(dateEnteredStage(lead, 'attempting')).toEqual(at(30));
    expect(dateEnteredStage(lead, 'connected')).toEqual(at(70));
    expect(dateEnteredStage(lead, 'qualified')).toEqual(at(60 * 24 + 5));
    expect(dateEnteredStage(lead, 'disqualified')).toBeUndefined();
    expect(lead.stageHistory.map((t) => t.to)).toEqual([
      'new',
      'attempting',
      'connected',
      'qualified',
    ]);
    expect(lead.updatedAt).toEqual(at(60 * 24 + 5));
  });

  it('allows skipping stages (Sales may jump straight to connected)', () => {
    const lead = apply(newLead(), { to: 'connected', occurredAt: at(5), source: 'sugar' });
    expect(dateEnteredStage(lead, 'attempting')).toBeUndefined();
    expect(dateEnteredStage(lead, 'connected')).toEqual(at(5));
  });

  it('ignores stale events so an old event cannot roll the Lead back', () => {
    const connected = apply(newLead(), { to: 'connected', occurredAt: at(60), source: 'sugar' });
    const result = applyStageChange(connected, {
      to: 'attempting',
      occurredAt: at(30),
      source: 'sugar',
    });
    expect(result).toEqual({ status: 'stale', lead: connected });
  });

  it('treats a repeated event for the current stage as unchanged (duplicate delivery)', () => {
    const attempting = apply(newLead(), { to: 'attempting', occurredAt: at(30), source: 'sugar' });
    const result = applyStageChange(attempting, {
      to: 'attempting',
      occurredAt: at(30),
      source: 'sugar',
    });
    expect(result).toEqual({ status: 'unchanged', lead: attempting });
  });

  it('accepts an event with the same timestamp as the last transition', () => {
    const lead = apply(newLead(), { to: 'attempting', occurredAt: at(0), source: 'sugar' });
    expect(lead.stage).toBe('attempting');
  });

  it('stores the disqualified reason and clears it when the Lead is reopened', () => {
    const disqualified = apply(newLead(), {
      to: 'disqualified',
      occurredAt: at(10),
      source: 'sugar',
      disqualifiedReason: noBudget,
    });
    expect(disqualified.disqualifiedReason).toBe('no_budget');

    const result = applyStageChange(disqualified, {
      to: 'attempting',
      occurredAt: at(20),
      source: 'sugar',
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.warnings).toEqual(['reopened_closed_lead']);
    expect(result.lead.disqualifiedReason).toBeUndefined();
    expect(lastEnteredStage(result.lead, 'attempting')).toEqual(at(20));
  });

  it('updates the reason when a later event corrects it without changing stage', () => {
    const disqualified = apply(newLead(), {
      to: 'disqualified',
      occurredAt: at(10),
      source: 'sugar',
      disqualifiedReason: noBudget,
    });
    const corrected = apply(disqualified, {
      to: 'disqualified',
      occurredAt: at(11),
      source: 'sugar',
      disqualifiedReason: timing,
    });
    expect(corrected.disqualifiedReason).toBe('bad_timing');
    expect(corrected.stageHistory).toHaveLength(2);
  });

  it('applies a disqualification without a reason but flags it (never rejects Sugar)', () => {
    const result = applyStageChange(newLead(), {
      to: 'disqualified',
      occurredAt: at(10),
      source: 'sugar',
    });
    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.warnings).toEqual(['missing_disqualified_reason']);
      expect(result.lead.stage).toBe('disqualified');
    }
  });

  it('distinguishes first and last entry when a stage is re-entered', () => {
    let lead = newLead();
    lead = apply(lead, { to: 'attempting', occurredAt: at(10), source: 'sugar' });
    lead = apply(lead, { to: 'new', occurredAt: at(20), source: 'user' });
    lead = apply(lead, { to: 'attempting', occurredAt: at(40), source: 'sugar' });
    expect(dateEnteredStage(lead, 'attempting')).toEqual(at(10));
    expect(lastEnteredStage(lead, 'attempting')).toEqual(at(40));
  });

  it('never mutates the original Lead', () => {
    const lead = newLead();
    apply(lead, { to: 'attempting', occurredAt: at(10), source: 'sugar' });
    expect(lead.stage).toBe('new');
    expect(lead.stageHistory).toHaveLength(1);
    expect(Object.isFrozen(lead)).toBe(true);
  });
});

describe('Lead invariants', () => {
  const valid = newLead();

  it.each<[string, Record<string, unknown>]>([
    ['empty history', { stageHistory: [] }],
    ['stage not matching history', { stage: 'connected' }],
    [
      'first transition not from null',
      {
        stageHistory: [{ from: 'new', to: 'attempting', occurredAt: at(0), source: 'sugar' }],
        stage: 'attempting',
      },
    ],
    [
      'non-contiguous history',
      {
        stage: 'qualified',
        stageHistory: [
          { from: null, to: 'new', occurredAt: at(0), source: 'hubspot' },
          { from: 'attempting', to: 'qualified', occurredAt: at(5), source: 'sugar' },
        ],
      },
    ],
    [
      'history out of order',
      {
        stage: 'attempting',
        stageHistory: [
          { from: null, to: 'new', occurredAt: at(10), source: 'hubspot' },
          { from: 'new', to: 'attempting', occurredAt: at(5), source: 'sugar' },
        ],
      },
    ],
    [
      'self transition',
      {
        stageHistory: [
          { from: null, to: 'new', occurredAt: at(0), source: 'hubspot' },
          { from: 'new', to: 'new', occurredAt: at(5), source: 'sugar' },
        ],
      },
    ],
    ['reason on an open Lead', { disqualifiedReason: 'no_budget' }],
    ['unconfirmed lead type "attempting"', { leadType: 'attempting' }],
  ])('rejects %s', (_label, over) => {
    expect(LeadSchema.safeParse({ ...valid, ...over }).success).toBe(false);
  });
});

describe('addLeadExternalRef', () => {
  it('links the Sugar Lead id once', () => {
    const sugar = { system: 'sugar', objectType: 'Leads', id: '9876' } as const;
    const linked = addLeadExternalRef(newLead(), sugar, at(1));
    expect(linked.externalRefs).toEqual([sugar]);
    expect(addLeadExternalRef(linked, { ...sugar }, at(2))).toBe(linked);
  });
});
