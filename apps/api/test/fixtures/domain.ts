import {
  CompanyIdSchema,
  CorrelationIdSchema,
  HumanOverrideIdSchema,
  LeadCandidateIdSchema,
  LeadIdSchema,
  PersonIdSchema,
  QualificationDecisionIdSchema,
  QualificationDecisionSchema,
  SalesOutcomeIdSchema,
  SignalIdSchema,
  TenantIdSchema,
  type QualificationDecision,
  type QualificationDecisionInput,
} from '../../src/modules/domain';

/** Deterministic UUIDs so test failures are reproducible and readable. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export const ids = {
  tenant: TenantIdSchema.parse(uuid(1)),
  otherTenant: TenantIdSchema.parse(uuid(2)),
  person: PersonIdSchema.parse(uuid(10)),
  otherPerson: PersonIdSchema.parse(uuid(11)),
  company: CompanyIdSchema.parse(uuid(20)),
  otherCompany: CompanyIdSchema.parse(uuid(21)),
  signal: SignalIdSchema.parse(uuid(30)),
  signal2: SignalIdSchema.parse(uuid(31)),
  candidate: LeadCandidateIdSchema.parse(uuid(40)),
  lead: LeadIdSchema.parse(uuid(50)),
  lead2: LeadIdSchema.parse(uuid(51)),
  correlation: CorrelationIdSchema.parse(uuid(60)),
  outcome: SalesOutcomeIdSchema.parse(uuid(70)),
  decision: (n: number) => QualificationDecisionIdSchema.parse(uuid(100 + n)),
  override: (n: number) => HumanOverrideIdSchema.parse(uuid(200 + n)),
};

/** A timestamp `minutes` after a fixed Monday 09:00 UTC. */
export const at = (minutes = 0): Date => new Date(Date.UTC(2026, 8, 28, 9, minutes));

export const sha256 = 'a'.repeat(64);

export function decision(
  n: number,
  overrides: Partial<QualificationDecisionInput> = {},
): QualificationDecision {
  return QualificationDecisionSchema.parse({
    id: ids.decision(n),
    tenantId: ids.tenant,
    subject: { type: 'lead', id: ids.lead },
    outcome: 'warm',
    confidence: 0.8,
    reasons: [{ code: 'webinar_registration' }],
    provider: { kind: 'jev', name: 'jev', version: '2026-09' },
    mode: 'hybrid',
    input: { snapshotRef: `snapshots/${n}.json`, snapshotHash: sha256 },
    decidedAt: at(n),
    correlationId: ids.correlation,
    ...overrides,
  });
}
