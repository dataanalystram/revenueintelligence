import { z } from 'zod';
import { LeadChannelSchema, MARKETING_CHANNELS } from './attribution';
import { ExternalRefSchema, ExternalSystemSchema } from './external-ref';
import { ProductKeySchema } from './product';
import { CodeSchema, LabelSchema } from './shared/codes';
import {
  CompanyIdSchema,
  CorrelationIdSchema,
  PersonIdSchema,
  SignalIdSchema,
  TenantIdSchema,
} from './shared/ids';
import { InstantSchema } from './shared/time';

/** Who a signal is about. At least one of person or company must be known. */
const SignalSubjectSchema = z
  .object({
    personId: PersonIdSchema.optional(),
    companyId: CompanyIdSchema.optional(),
  })
  .refine((s) => s.personId !== undefined || s.companyId !== undefined, {
    message: 'a signal must reference a person or a company',
  })
  .readonly();

const MetricsSchema = z.record(CodeSchema, z.number().finite()).readonly();

const baseSignal = {
  id: SignalIdSchema,
  tenantId: TenantIdSchema,
  /** The system that produced the signal and its own event id (used for de-duplication). */
  source: z
    .object({ system: ExternalSystemSchema, eventId: z.string().trim().min(1).max(255) })
    .readonly(),
  subject: SignalSubjectSchema,
  occurredAt: InstantSchema,
  receivedAt: InstantSchema,
  correlationId: CorrelationIdSchema,
};

/** Marketing behaviour captured in HubSpot: form fills, webinar sign-ups, lead score crossings. */
export const MarketingSignalSchema = z
  .object({
    ...baseSignal,
    kind: z.literal('marketing'),
    channel: LeadChannelSchema.refine(
      (c): c is (typeof MARKETING_CHANNELS)[number] =>
        (MARKETING_CHANNELS as readonly string[]).includes(c),
      'not a marketing channel',
    ),
    label: LabelSchema.optional(),
    campaign: ExternalRefSchema.optional(),
    form: ExternalRefSchema.optional(),
    productKey: ProductKeySchema.optional(),
    /** For lead-score crossings: the score reached and the threshold it crossed. */
    score: z.object({ value: z.number().finite(), threshold: z.number().finite() }).optional(),
  })
  .refine((s) => s.source.system === 'hubspot', {
    message: 'marketing signals come from HubSpot',
    path: ['source', 'system'],
  })
  .refine((s) => (s.channel === 'lead_score_threshold') === (s.score !== undefined), {
    message: 'score is required for, and only for, lead_score_threshold signals',
    path: ['score'],
  })
  .refine((s) => !s.score || s.score.value >= s.score.threshold, {
    message: 'score must meet the threshold',
    path: ['score', 'value'],
  })
  .readonly();

export const ProductActivitySchema = z.enum([
  'login',
  'feature_usage',
  'users_invited',
  'trial_started',
  'adoption_milestone',
  'nps_response',
  'other',
]);

/** In-product behaviour, typically from Gainsight PX. */
export const ProductSignalSchema = z
  .object({
    ...baseSignal,
    kind: z.literal('product'),
    activity: ProductActivitySchema,
    productKey: ProductKeySchema,
    /** Named numeric measures, e.g. `{ logins_30d: 14, users_invited: 8 }`. */
    metrics: MetricsSchema.default({}),
    label: LabelSchema.optional(),
  })
  .refine((s) => s.source.system === 'gainsight_px' || s.source.system === 'gainsight_cs', {
    message: 'product signals come from Gainsight',
    path: ['source', 'system'],
  })
  .readonly();

export const AccountActivitySchema = z.enum([
  'expansion_opportunity',
  'health_change',
  'renewal_upcoming',
  'contract_change',
  'stakeholder_change',
  'nps_response',
  'other',
]);

/** Account-level customer-success data, typically from Gainsight CS. */
export const AccountSignalSchema = z
  .object({
    ...baseSignal,
    kind: z.literal('account'),
    activity: AccountActivitySchema,
    productKey: ProductKeySchema.optional(),
    metrics: MetricsSchema.default({}),
    label: LabelSchema.optional(),
  })
  .refine((s) => s.source.system === 'gainsight_cs', {
    message: 'account signals come from Gainsight CS',
    path: ['source', 'system'],
  })
  .refine((s) => s.subject.companyId !== undefined, {
    message: 'account signals must reference a company',
    path: ['subject', 'companyId'],
  })
  .readonly();

export const SignalSchema = z.discriminatedUnion('kind', [
  MarketingSignalSchema,
  ProductSignalSchema,
  AccountSignalSchema,
]);

export type MarketingSignal = z.infer<typeof MarketingSignalSchema>;
export type ProductSignal = z.infer<typeof ProductSignalSchema>;
export type AccountSignal = z.infer<typeof AccountSignalSchema>;
export type Signal = z.infer<typeof SignalSchema>;

/**
 * Identity of the underlying source event. Two deliveries of the same event
 * share this key, which is how duplicate webhook deliveries are detected.
 */
export function signalDeduplicationKey(signal: Signal): string {
  return `${signal.tenantId}:${signal.source.system}:${signal.source.eventId}`;
}
