import { z } from 'zod';
import { IntegrationSettingsSchemas } from './integrations';
import { LeadSourceMappingSchema } from './lead-source-mappings';
import { PolicySchemas } from './policies';
import { QualificationConfigInputSchema } from './qualification';

/**
 * Initial configuration applied when a tenant is provisioned (e.g.
 * `config/tenant-templates/juniper.json`). Tenant-specific values live in
 * these data files, never in code.
 *
 * Deliberately excluded: integration access levels, flow modes and
 * credentials. Products are not template data: the catalogue is a published,
 * versioned product model (ADR 0016), loaded with `product:model publish`. A new tenant always starts with every integration disabled and
 * every flow off; enabling writes is an explicit, separate step.
 */
export const TenantTemplateSchema = z.strictObject({
  description: z.string().max(2000).optional(),
  integrationSettings: z
    .strictObject({
      hubspot: IntegrationSettingsSchemas.hubspot.optional(),
      sugar: IntegrationSettingsSchemas.sugar.optional(),
      gainsight_cs: IntegrationSettingsSchemas.gainsight_cs.optional(),
      gainsight_px: IntegrationSettingsSchemas.gainsight_px.optional(),
      jev: IntegrationSettingsSchemas.jev.optional(),
      chargebee: IntegrationSettingsSchemas.chargebee.optional(),
    })
    .default({}),
  qualification: QualificationConfigInputSchema.optional(),
  leadSourceMappings: z.array(LeadSourceMappingSchema).default([]),
  policies: z
    .strictObject({
      sla: PolicySchemas.sla.optional(),
      routing: PolicySchemas.routing.optional(),
      requalification: PolicySchemas.requalification.optional(),
    })
    .default({}),
});

export type TenantTemplate = z.infer<typeof TenantTemplateSchema>;
export type TenantTemplateInput = z.input<typeof TenantTemplateSchema>;
