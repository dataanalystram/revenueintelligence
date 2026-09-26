import { z } from 'zod';
import { CHANNELS_BY_ORIGIN, LeadChannelSchema, type LeadOrigin } from '../../domain';

export const LeadSourceSystemSchema = z.enum(['hubspot', 'gainsight_cs', 'gainsight_px']);
export type LeadSourceSystem = z.infer<typeof LeadSourceSystemSchema>;

const ORIGIN_OF: Readonly<Record<LeadSourceSystem, LeadOrigin>> = {
  hubspot: 'hubspot',
  gainsight_cs: 'gainsight_cs',
  gainsight_px: 'gainsight_px',
};

/**
 * Translates a tenant's own source values (e.g. HubSpot "Recent conversion"
 * contains "Demo") into canonical channels. The channel must be one the
 * source's origin can produce (domain rule).
 */
export const LeadSourceMappingSchema = z
  .strictObject({
    system: LeadSourceSystemSchema,
    sourceProperty: z.string().trim().min(1).max(200),
    matchType: z.enum(['equals', 'contains']),
    sourceValue: z.string().min(1).max(500),
    channel: LeadChannelSchema,
    label: z.string().trim().min(1).max(500).nullable().default(null),
    /** Lower numbers win when several mappings match. */
    priority: z.number().int().min(0).max(10_000).default(100),
  })
  .refine((m) => CHANNELS_BY_ORIGIN[ORIGIN_OF[m.system]].includes(m.channel), {
    message: 'channel is not valid for this source system',
    path: ['channel'],
  })
  .readonly();

export type LeadSourceMapping = z.infer<typeof LeadSourceMappingSchema>;
export type LeadSourceMappingInput = z.input<typeof LeadSourceMappingSchema>;
