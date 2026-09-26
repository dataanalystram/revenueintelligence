import { z } from 'zod';
import { ExternalRefSchema } from './external-ref';
import { LabelSchema } from './shared/codes';

/** Where a Lead truly originated. Never changes after the Lead is created. */
export const LeadOriginSchema = z.enum([
  'hubspot',
  'gainsight_px',
  'gainsight_cs',
  'external_enrichment',
  'manual',
]);
export type LeadOrigin = z.infer<typeof LeadOriginSchema>;

/**
 * Canonical intent channels. Tenants map their own source values (for example
 * HubSpot "Recent conversion" option labels) onto these through configuration.
 */
export const LeadChannelSchema = z.enum([
  'form_submission',
  'demo_request',
  'book_a_call',
  'webinar_registration',
  'resource_download',
  'whitepaper_download',
  'checklist_download',
  'contact_us',
  'event',
  'lead_score_threshold',
  'product_usage',
  'trial_activity',
  'cs_expansion',
  'nps_response',
  'enrichment',
  'sales_referral',
  'other',
]);
export type LeadChannel = z.infer<typeof LeadChannelSchema>;

/** Marketing channels are the HubSpot-owned creation paths (ADR 0006). */
export const MARKETING_CHANNELS = [
  'form_submission',
  'demo_request',
  'book_a_call',
  'webinar_registration',
  'resource_download',
  'whitepaper_download',
  'checklist_download',
  'contact_us',
  'event',
  'lead_score_threshold',
] as const satisfies readonly LeadChannel[];

/** Which channels each origin can legitimately produce. */
export const CHANNELS_BY_ORIGIN: Readonly<Record<LeadOrigin, readonly LeadChannel[]>> = {
  hubspot: [...MARKETING_CHANNELS, 'other'],
  gainsight_px: ['product_usage', 'trial_activity', 'nps_response', 'other'],
  gainsight_cs: ['cs_expansion', 'nps_response', 'other'],
  external_enrichment: ['enrichment'],
  manual: ['sales_referral', 'event', 'other'],
};

export const SourceAttributionSchema = z
  .object({
    origin: LeadOriginSchema,
    channel: LeadChannelSchema,
    /** Human-readable trigger, e.g. "Demo request" (the brief's "Heat indicator"). */
    label: LabelSchema.optional(),
    campaign: ExternalRefSchema.optional(),
    form: ExternalRefSchema.optional(),
  })
  .refine((a) => CHANNELS_BY_ORIGIN[a.origin].includes(a.channel), {
    message: 'channel is not valid for this origin',
    path: ['channel'],
  })
  .refine((a) => a.origin === 'hubspot' || (!a.campaign && !a.form), {
    message: 'campaign/form references apply to HubSpot-originated leads only',
    path: ['campaign'],
  })
  .readonly();

export type SourceAttribution = z.infer<typeof SourceAttributionSchema>;

/** True when the Lead came from the intelligence layer rather than HubSpot marketing. */
export function isIntelligenceSourced(attribution: SourceAttribution): boolean {
  return attribution.origin === 'gainsight_px' || attribution.origin === 'gainsight_cs';
}
