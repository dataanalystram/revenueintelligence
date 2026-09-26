import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Canonical identifiers are UUIDs issued by this platform. They are branded so
 * a PersonId can never be passed where a LeadId is expected. External system
 * identifiers (HubSpot, Sugar, Gainsight) are never canonical IDs; they are
 * carried as ExternalRefs.
 */
const brandedUuid = <B extends string>() => z.uuid().brand<B>();

export const TenantIdSchema = brandedUuid<'TenantId'>();
export const PersonIdSchema = brandedUuid<'PersonId'>();
export const CompanyIdSchema = brandedUuid<'CompanyId'>();
export const SignalIdSchema = brandedUuid<'SignalId'>();
export const LeadCandidateIdSchema = brandedUuid<'LeadCandidateId'>();
export const LeadIdSchema = brandedUuid<'LeadId'>();
export const QualificationDecisionIdSchema = brandedUuid<'QualificationDecisionId'>();
export const HumanOverrideIdSchema = brandedUuid<'HumanOverrideId'>();
export const SalesOutcomeIdSchema = brandedUuid<'SalesOutcomeId'>();
/** Follows one Lead journey across signals, decisions, writes, logs and traces. */
export const CorrelationIdSchema = brandedUuid<'CorrelationId'>();

export type TenantId = z.infer<typeof TenantIdSchema>;
export type PersonId = z.infer<typeof PersonIdSchema>;
export type CompanyId = z.infer<typeof CompanyIdSchema>;
export type SignalId = z.infer<typeof SignalIdSchema>;
export type LeadCandidateId = z.infer<typeof LeadCandidateIdSchema>;
export type LeadId = z.infer<typeof LeadIdSchema>;
export type QualificationDecisionId = z.infer<typeof QualificationDecisionIdSchema>;
export type HumanOverrideId = z.infer<typeof HumanOverrideIdSchema>;
export type SalesOutcomeId = z.infer<typeof SalesOutcomeIdSchema>;
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

/** Generates a new identifier of the given branded type. */
export function newId<S extends z.ZodType<string>>(schema: S): z.infer<S> {
  return schema.parse(randomUUID());
}
