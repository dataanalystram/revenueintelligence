import { describe, expect, it } from 'vitest';
import { at, decision, ids } from '../../../test/fixtures/domain';
import {
  createOverride,
  effectiveTemperature,
  HumanOverrideSchema,
  QualificationDecisionSchema,
  resolveEffectiveQualification,
  type HumanOverride,
  type OverrideRequest,
  type QualificationDecision,
  type QualificationSubject,
} from './qualification';
import { DomainError } from './shared/errors';

const subject: QualificationSubject = { type: 'lead', id: ids.lead };
const actor = { userId: 'user-42', displayName: 'Sam Sales' };

function override(
  history: { decisions: QualificationDecision[]; overrides: HumanOverride[] },
  n: number,
  request: Omit<OverrideRequest, 'id' | 'actor'>,
): HumanOverride {
  const o = createOverride(subject, ids.tenant, history, {
    id: ids.override(n),
    actor,
    ...request,
  });
  history.overrides.push(o);
  return o;
}

describe('QualificationDecision', () => {
  it('stores provider, version, confidence, reasons and input snapshot', () => {
    const d = decision(1, {
      outcome: 'hot',
      confidence: null,
      provider: { kind: 'rules', name: 'juniper-rules', version: 'ruleset-3' },
      mode: 'rules',
      reasons: [{ code: 'demo_request_decision_maker', signalIds: [ids.signal] }],
    });
    expect(d).toMatchObject({
      outcome: 'hot',
      confidence: null,
      provider: { version: 'ruleset-3' },
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['no reasons', { reasons: [] }],
    ['confidence above 1', { confidence: 1.2 }],
    ['negative confidence', { confidence: -0.1 }],
    ['bad snapshot hash', { input: { snapshotRef: 's', snapshotHash: 'abc' } }],
    ['jev decision in rules mode', { mode: 'rules' }],
    [
      'rules decision in jev mode',
      { mode: 'jev', provider: { kind: 'rules', name: 'r', version: '1' } },
    ],
    ['ml decision in hybrid mode', { provider: { kind: 'ml', name: 'm', version: '1' } }],
    ['unknown outcome', { outcome: 'lukewarm' }],
  ])('rejects %s', (_label, over) => {
    expect(QualificationDecisionSchema.safeParse({ ...decision(1), ...over }).success).toBe(false);
  });
});

describe('resolveEffectiveQualification', () => {
  it('has no effective qualification without history', () => {
    const r = resolveEffectiveQualification([], []);
    expect(r.effective).toEqual({ source: 'none' });
    expect(effectiveTemperature(r)).toBeNull();
  });

  it('uses the latest automated decision when no human has intervened', () => {
    const r = resolveEffectiveQualification(
      [decision(5, { outcome: 'hot' }), decision(1, { outcome: 'cold' })],
      [],
    );
    expect(r.effective).toMatchObject({
      source: 'automated',
      outcome: 'hot',
      decisionId: ids.decision(5),
    });
    expect(effectiveTemperature(r)).toBe('hot');
    expect(r.overriddenDecisionIds).toEqual([]);
  });

  it('treats needs_review as having no temperature', () => {
    const r = resolveEffectiveQualification([decision(1, { outcome: 'needs_review' })], []);
    expect(r.effective).toMatchObject({
      source: 'automated',
      outcome: 'needs_review',
      temperature: null,
    });
  });

  it('a human override wins and records what it replaced (Warm → Hot)', () => {
    const history = {
      decisions: [decision(1, { outcome: 'warm' })],
      overrides: [] as HumanOverride[],
    };
    const o = override(history, 1, {
      action: 'set',
      newTemperature: 'hot',
      reason: 'Spoke to head teacher',
      at: at(10),
    });

    expect(o).toMatchObject({
      previousTemperature: 'warm',
      newTemperature: 'hot',
      basedOnDecisionId: ids.decision(1),
      actor,
      reason: 'Spoke to head teacher',
      at: at(10),
    });
    const r = resolveEffectiveQualification(history.decisions, history.overrides);
    expect(r.effective).toEqual({
      source: 'human',
      temperature: 'hot',
      overrideId: ids.override(1),
    });
    expect(r.overriddenDecisionIds).toEqual([ids.decision(1)]);
  });

  it('never lets a later automated result replace an active override, but flags disagreement', () => {
    const history = {
      decisions: [decision(1, { outcome: 'warm' })],
      overrides: [] as HumanOverride[],
    };
    override(history, 1, { action: 'set', newTemperature: 'cold', at: at(10) });
    history.decisions.push(decision(20, { outcome: 'hot' }));

    const r = resolveEffectiveQualification(history.decisions, history.overrides);
    expect(effectiveTemperature(r)).toBe('cold');
    expect(r.effective.source).toBe('human');
    expect(r.latestAutomated?.id).toBe(ids.decision(20));
    expect(r.conflictingAutomatedDecision?.id).toBe(ids.decision(20));
    // The later decision was not overridden by anyone: it was simply not applied.
    expect(r.overriddenDecisionIds).toEqual([ids.decision(1)]);
  });

  it('does not report a conflict when the later automated result agrees', () => {
    const history = {
      decisions: [decision(1, { outcome: 'warm' })],
      overrides: [] as HumanOverride[],
    };
    override(history, 1, { action: 'set', newTemperature: 'hot', at: at(10) });
    history.decisions.push(decision(20, { outcome: 'hot' }));
    expect(
      resolveEffectiveQualification(history.decisions, history.overrides)
        .conflictingAutomatedDecision,
    ).toBeUndefined();
  });

  it('a later human change replaces an earlier one and records the chain', () => {
    const history = {
      decisions: [decision(1, { outcome: 'warm' })],
      overrides: [] as HumanOverride[],
    };
    override(history, 1, { action: 'set', newTemperature: 'hot', at: at(10) });
    const second = override(history, 2, { action: 'set', newTemperature: 'cold', at: at(20) });

    expect(second.previousTemperature).toBe('hot');
    expect(
      effectiveTemperature(resolveEffectiveQualification(history.decisions, history.overrides)),
    ).toBe('cold');
  });

  it('release hands control back to the latest automated decision', () => {
    const history = {
      decisions: [decision(1, { outcome: 'warm' })],
      overrides: [] as HumanOverride[],
    };
    override(history, 1, { action: 'set', newTemperature: 'hot', at: at(10) });
    history.decisions.push(decision(20, { outcome: 'cold' }));
    const release = override(history, 2, { action: 'release', at: at(30) });

    expect(release).toMatchObject({ previousTemperature: 'hot', newTemperature: null });
    const r = resolveEffectiveQualification(history.decisions, history.overrides);
    expect(r.effective).toMatchObject({
      source: 'automated',
      outcome: 'cold',
      decisionId: ids.decision(20),
    });
    // History is preserved: decision 1 was overridden while the override was active.
    expect(r.overriddenDecisionIds).toEqual([ids.decision(1)]);
  });

  it('after release with no automated decision there is nothing effective', () => {
    const history = { decisions: [] as QualificationDecision[], overrides: [] as HumanOverride[] };
    override(history, 1, { action: 'set', newTemperature: 'warm', at: at(1) });
    override(history, 2, { action: 'release', at: at(2) });
    expect(resolveEffectiveQualification(history.decisions, history.overrides).effective).toEqual({
      source: 'none',
    });
  });

  it('a human wins a tie with automation at the same instant', () => {
    const history = {
      decisions: [decision(1, { outcome: 'warm' })],
      overrides: [] as HumanOverride[],
    };
    override(history, 1, { action: 'set', newTemperature: 'hot', at: at(5) });
    history.decisions.push(decision(5, { outcome: 'cold' }));
    const r = resolveEffectiveQualification(history.decisions, history.overrides);
    expect(effectiveTemperature(r)).toBe('hot');
    expect(r.overriddenDecisionIds).toContain(ids.decision(5));
  });

  it('is independent of input order', () => {
    const history = {
      decisions: [decision(1), decision(2, { outcome: 'hot' })],
      overrides: [] as HumanOverride[],
    };
    override(history, 1, { action: 'set', newTemperature: 'cold', at: at(10) });
    const a = resolveEffectiveQualification(history.decisions, history.overrides);
    const b = resolveEffectiveQualification(
      [...history.decisions].reverse(),
      [...history.overrides].reverse(),
    );
    expect(b).toEqual(a);
  });

  it('refuses histories that mix tenants or subjects', () => {
    expect(() =>
      resolveEffectiveQualification([decision(1), decision(2, { tenantId: ids.otherTenant })], []),
    ).toThrow(DomainError);
    expect(() =>
      resolveEffectiveQualification(
        [decision(1), decision(2, { subject: { type: 'lead', id: ids.lead2 } })],
        [],
      ),
    ).toThrow(DomainError);
    expect(() =>
      resolveEffectiveQualification(
        [decision(1, { subject: { type: 'lead_candidate', id: ids.candidate } })],
        [
          HumanOverrideSchema.parse({
            id: ids.override(1),
            tenantId: ids.tenant,
            subject,
            action: 'set',
            previousTemperature: null,
            newTemperature: 'hot',
            actor,
            at: at(1),
          }),
        ],
      ),
    ).toThrow(DomainError);
  });
});

describe('createOverride / HumanOverride invariants', () => {
  it('refuses to release when no override is active', () => {
    expect(() =>
      createOverride(
        subject,
        ids.tenant,
        { decisions: [decision(1)], overrides: [] },
        {
          id: ids.override(1),
          action: 'release',
          actor,
          at: at(5),
        },
      ),
    ).toThrow(DomainError);
  });

  it('refuses an override that predates the previous override', () => {
    const history = { decisions: [] as QualificationDecision[], overrides: [] as HumanOverride[] };
    override(history, 1, { action: 'set', newTemperature: 'hot', at: at(10) });
    expect(() =>
      override(history, 2, { action: 'set', newTemperature: 'cold', at: at(5) }),
    ).toThrow(DomainError);
  });

  it('records an override with no prior automated decision', () => {
    const o = createOverride(
      subject,
      ids.tenant,
      { decisions: [], overrides: [] },
      {
        id: ids.override(1),
        action: 'set',
        newTemperature: 'warm',
        actor,
        at: at(1),
      },
    );
    expect(o).toMatchObject({ previousTemperature: null, basedOnDecisionId: undefined });
  });

  it.each<[string, Record<string, unknown>]>([
    ['set without a temperature', { action: 'set', newTemperature: null }],
    ['release with a temperature', { action: 'release', newTemperature: 'hot' }],
    ['anonymous actor', { actor: { userId: '' } }],
  ])('rejects %s', (_label, over) => {
    const base = {
      id: ids.override(1),
      tenantId: ids.tenant,
      subject,
      action: 'set',
      previousTemperature: null,
      newTemperature: 'hot',
      actor,
      at: at(1),
    };
    expect(HumanOverrideSchema.safeParse({ ...base, ...over }).success).toBe(false);
  });
});
