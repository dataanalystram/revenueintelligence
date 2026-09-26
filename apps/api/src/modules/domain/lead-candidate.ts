import { z } from 'zod';
import { SourceAttributionSchema } from './attribution';
import { ProductKeySchema, type ProductKey } from './product';
import { DomainError } from './shared/errors';
import {
  CompanyIdSchema,
  CorrelationIdSchema,
  LeadCandidateIdSchema,
  LeadIdSchema,
  PersonIdSchema,
  SignalIdSchema,
  TenantIdSchema,
  type CompanyId,
  type LeadId,
  type PersonId,
  type SignalId,
  type TenantId,
} from './shared/ids';
import { InstantSchema, type Instant } from './shared/time';

export const LeadCandidateStatusSchema = z.enum([
  'open',
  'needs_review',
  'converted',
  'suppressed',
  'discarded',
]);
export type LeadCandidateStatus = z.infer<typeof LeadCandidateStatusSchema>;

/** Why a candidate did not become a Lead (ADR 0006). */
export const SuppressionReasonSchema = z.enum([
  'duplicate_open_lead',
  'recently_disqualified',
  'insufficient_signal',
  'not_a_buyer',
  'integration_disabled',
]);
export type SuppressionReason = z.infer<typeof SuppressionReasonSchema>;

/**
 * Signals gathered about one person/account/product that may justify a Lead.
 * Platform-sourced Leads (Gainsight) always start as a candidate so duplicate
 * and requalification checks happen before anything is created.
 */
export const LeadCandidateSchema = z
  .object({
    id: LeadCandidateIdSchema,
    tenantId: TenantIdSchema,
    personId: PersonIdSchema,
    companyId: CompanyIdSchema.optional(),
    productKey: ProductKeySchema.optional(),
    source: SourceAttributionSchema,
    signalIds: z.array(SignalIdSchema).min(1).readonly(),
    status: LeadCandidateStatusSchema,
    leadId: LeadIdSchema.optional(),
    suppressionReason: SuppressionReasonSchema.optional(),
    correlationId: CorrelationIdSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .refine((c) => new Set(c.signalIds).size === c.signalIds.length, {
    message: 'duplicate signal id',
    path: ['signalIds'],
  })
  .refine((c) => (c.status === 'converted') === (c.leadId !== undefined), {
    message: 'leadId is required for, and only for, converted candidates',
    path: ['leadId'],
  })
  .refine((c) => (c.status === 'suppressed') === (c.suppressionReason !== undefined), {
    message: 'suppressionReason is required for, and only for, suppressed candidates',
    path: ['suppressionReason'],
  })
  .readonly();

export type LeadCandidate = z.infer<typeof LeadCandidateSchema>;
export type LeadCandidateInput = z.input<typeof LeadCandidateSchema>;

/** Statuses from which a candidate can still change. The others are final. */
const ACTIVE_STATUSES: readonly LeadCandidateStatus[] = ['open', 'needs_review'];

export function isCandidateActive(candidate: LeadCandidate): boolean {
  return ACTIVE_STATUSES.includes(candidate.status);
}

function assertActive(candidate: LeadCandidate, action: string): void {
  if (!isCandidateActive(candidate)) {
    throw new DomainError(
      'candidate_closed',
      `Cannot ${action} a lead candidate in status "${candidate.status}"`,
    );
  }
}

/** Adds a signal to an active candidate. Re-adding the same signal is a no-op. */
export function attachSignal(
  candidate: LeadCandidate,
  signalId: SignalId,
  at: Instant,
): LeadCandidate {
  if (candidate.signalIds.includes(signalId)) return candidate;
  assertActive(candidate, 'attach a signal to');
  return LeadCandidateSchema.parse({
    ...candidate,
    signalIds: [...candidate.signalIds, signalId],
    updatedAt: at,
  });
}

export function markNeedsReview(candidate: LeadCandidate, at: Instant): LeadCandidate {
  if (candidate.status === 'needs_review') return candidate;
  assertActive(candidate, 'mark for review');
  return LeadCandidateSchema.parse({ ...candidate, status: 'needs_review', updatedAt: at });
}

export function markConverted(
  candidate: LeadCandidate,
  leadId: LeadId,
  at: Instant,
): LeadCandidate {
  if (candidate.status === 'converted' && candidate.leadId === leadId) return candidate;
  assertActive(candidate, 'convert');
  return LeadCandidateSchema.parse({ ...candidate, status: 'converted', leadId, updatedAt: at });
}

export function suppress(
  candidate: LeadCandidate,
  reason: SuppressionReason,
  at: Instant,
): LeadCandidate {
  if (candidate.status === 'suppressed' && candidate.suppressionReason === reason) return candidate;
  assertActive(candidate, 'suppress');
  return LeadCandidateSchema.parse({
    ...candidate,
    status: 'suppressed',
    suppressionReason: reason,
    updatedAt: at,
  });
}

export function discard(candidate: LeadCandidate, at: Instant): LeadCandidate {
  if (candidate.status === 'discarded') return candidate;
  assertActive(candidate, 'discard');
  return LeadCandidateSchema.parse({ ...candidate, status: 'discarded', updatedAt: at });
}

/**
 * Candidates and Leads that represent "the same opportunity" share this key
 * (tenant + person + company + product). The requalification rules (M11/M14)
 * compare keys; the recency window is tenant policy.
 */
export interface LeadEquivalenceKey {
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly companyId: CompanyId | undefined;
  readonly productKey: ProductKey | undefined;
}

export function equivalenceKey(subject: LeadEquivalenceKey): string {
  return [
    subject.tenantId,
    subject.personId,
    subject.companyId ?? '-',
    subject.productKey ?? '-',
  ].join('|');
}
