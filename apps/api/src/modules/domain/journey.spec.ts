import { describe, expect, it } from 'vitest';
import { at, ids, sha256 } from '../../../test/fixtures/domain';
import {
  applyStageChange,
  CompanySchema,
  createLead,
  createOverride,
  dateEnteredStage,
  effectiveTemperature,
  isIntelligenceSourced,
  LeadCandidateSchema,
  LeadSchema,
  markConverted,
  PersonSchema,
  ProductKeySchema,
  QualificationDecisionSchema,
  resolveEffectiveQualification,
  SalesOutcomeSchema,
  SignalSchema,
  type Lead,
} from './index';

/**
 * John's journey from the project brief: Gainsight PX sees heavy Marketplace
 * usage at a school that owns the Portal. It becomes a candidate, is
 * qualified, a human adjusts it, it becomes a Lead, Sales works it in Sugar,
 * and it converts. Every entity must survive JSON serialisation (queues).
 */
describe('canonical model: end-to-end journey', () => {
  const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T): T =>
    schema.parse(JSON.parse(JSON.stringify(value)));

  it('models a Gainsight-sourced lead from signal to won deal', () => {
    const marketplace = ProductKeySchema.parse('marketplace');

    const company = CompanySchema.parse({
      id: ids.company,
      tenantId: ids.tenant,
      name: 'ABC Academy',
      customerStatus: 'customer',
      externalRefs: [{ system: 'gainsight_cs', objectType: 'Company', id: 'gs-co-1' }],
      createdAt: at(0),
      updatedAt: at(0),
    });
    const john = PersonSchema.parse({
      id: ids.person,
      tenantId: ids.tenant,
      primaryEmail: 'john@abcacademy.sch.uk',
      firstName: 'John',
      companyId: ids.company,
      roles: ['decision_maker'],
      externalRefs: [{ system: 'hubspot', objectType: 'contacts', id: '501' }],
      createdAt: at(0),
      updatedAt: at(0),
    });
    const signal = SignalSchema.parse({
      id: ids.signal,
      tenantId: ids.tenant,
      kind: 'product',
      activity: 'feature_usage',
      source: { system: 'gainsight_px', eventId: 'px-evt-1' },
      subject: { personId: john.id, companyId: company.id },
      productKey: 'marketplace',
      metrics: { logins_30d: 14, users_invited: 8 },
      occurredAt: at(0),
      receivedAt: at(1),
      correlationId: ids.correlation,
    });
    // Whether marketplace is whitespace is decided by eligibility (M7), not here.

    let candidate = LeadCandidateSchema.parse({
      id: ids.candidate,
      tenantId: ids.tenant,
      personId: john.id,
      companyId: company.id,
      productKey: 'marketplace',
      signalIds: [signal.id],
      status: 'open',
      source: { origin: 'gainsight_px', channel: 'product_usage', label: 'High Marketplace usage' },
      correlationId: ids.correlation,
      createdAt: at(2),
      updatedAt: at(2),
    });

    const aiDecision = QualificationDecisionSchema.parse({
      id: ids.decision(1),
      tenantId: ids.tenant,
      subject: { type: 'lead_candidate', id: candidate.id },
      outcome: 'warm',
      confidence: 0.74,
      reasons: [{ code: 'high_usage_unowned_product', signalIds: [signal.id] }],
      provider: { kind: 'jev', name: 'jev', version: '2026-09' },
      mode: 'hybrid',
      input: { snapshotRef: 'snapshots/c1.json', snapshotHash: sha256 },
      decidedAt: at(3),
      correlationId: ids.correlation,
    });
    const humanOverride = createOverride(
      aiDecision.subject,
      ids.tenant,
      { decisions: [aiDecision], overrides: [] },
      {
        id: ids.override(1),
        action: 'set',
        newTemperature: 'hot',
        actor: { userId: 'csm-7' },
        reason: 'Head teacher asked for pricing',
        at: at(4),
      },
    );
    expect(effectiveTemperature(resolveEffectiveQualification([aiDecision], [humanOverride]))).toBe(
      'hot',
    );

    let lead: Lead = createLead({
      id: ids.lead,
      tenantId: ids.tenant,
      personId: john.id,
      companyId: company.id,
      productKey: marketplace,
      candidateId: candidate.id,
      leadType: 'upsell',
      source: candidate.source,
      correlationId: ids.correlation,
      createdAt: at(5),
      createdBy: 'platform',
    });
    candidate = markConverted(candidate, lead.id, at(5));
    expect(isIntelligenceSourced(lead.source)).toBe(true);

    for (const [to, minute] of [
      ['attempting', 20],
      ['connected', 45],
      ['qualified', 60 * 26],
    ] as const) {
      const result = applyStageChange(lead, { to, occurredAt: at(minute), source: 'sugar' });
      if (result.status !== 'applied') throw new Error(result.status);
      lead = result.lead;
    }
    const won = SalesOutcomeSchema.parse({
      id: ids.outcome,
      tenantId: ids.tenant,
      leadId: lead.id,
      type: 'won',
      reportedBy: 'sugar',
      opportunity: { system: 'sugar', objectType: 'Opportunities', id: 'opp-77' },
      value: { amountMinor: 450_000, currency: 'GBP' },
      occurredAt: at(60 * 24 * 14),
    });

    // Reporting questions from the brief can be answered from the model.
    const minutesToFirstAction =
      (dateEnteredStage(lead, 'attempting')!.getTime() - dateEnteredStage(lead, 'new')!.getTime()) /
      60_000;
    expect(minutesToFirstAction).toBe(15);
    expect(lead.source.origin).toBe('gainsight_px');
    expect(won.value?.amountMinor).toBe(450_000);

    // One correlation id links the whole journey.
    expect(
      new Set([
        signal.correlationId,
        candidate.correlationId,
        aiDecision.correlationId,
        lead.correlationId,
      ]).size,
    ).toBe(1);

    // Everything survives serialisation through a queue unchanged.
    expect(roundTrip(CompanySchema, company)).toEqual(company);
    expect(roundTrip(PersonSchema, john)).toEqual(john);
    expect(roundTrip(SignalSchema, signal)).toEqual(signal);
    expect(roundTrip(LeadCandidateSchema, candidate)).toEqual(candidate);
    expect(roundTrip(QualificationDecisionSchema, aiDecision)).toEqual(aiDecision);
    expect(roundTrip(LeadSchema, lead)).toEqual(lead);
    expect(roundTrip(SalesOutcomeSchema, won)).toEqual(won);
  });
});
