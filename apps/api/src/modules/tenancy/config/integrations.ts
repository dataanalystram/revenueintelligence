import { z } from 'zod';

/** External services a tenant can connect. `jev` is the hosted qualification service. */
export const IntegrationSystemSchema = z.enum([
  'hubspot',
  'sugar',
  'gainsight_cs',
  'gainsight_px',
  'jev',
  'chargebee',
]);
export type IntegrationSystem = z.infer<typeof IntegrationSystemSchema>;

export const IntegrationAccessSchema = z.enum(['disabled', 'read_only', 'read_write']);
export type IntegrationAccess = z.infer<typeof IntegrationAccessSchema>;

const httpsUrl = z.url({ protocol: /^https$/ });

/**
 * Non-secret connection settings per system. Objects are strict: unknown keys
 * are rejected, which also stops secrets being stored here by mistake
 * (secrets belong in the SecretProvider, referenced by TenantCredentialRef).
 * Connector milestones extend these schemas as real requirements appear.
 */
export const IntegrationSettingsSchemas = {
  hubspot: z.strictObject({
    /** HubSpot account (portal) id, known once the app is installed (M3/M16). */
    portalId: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    /**
     * How the connector authenticates (ADR 0010). `static_token` (the default,
     * also when absent): the tenant credential `hubspot.access_token`, e.g. a
     * Service Key. `oauth`: the grant stored when the tenant installed the app.
     */
    auth: z.enum(['static_token', 'oauth']).optional(),
    /**
     * HubSpot web host of the tenant's account (its data-hosting region), as
     * HubSpot's Account Information API reports it (`uiDomain`), e.g.
     * `app.hubspot.com` or `app-eu1.hubspot.com`. The OAuth consent page is
     * opened on this host. Only HubSpot's own app hosts are accepted.
     */
    uiDomain: z
      .string()
      .regex(
        /^app(-[a-z]{2,4}[0-9]{1,2})?\.hubspot\.com$/,
        'must be a HubSpot app host, e.g. app-eu1.hubspot.com',
      )
      .optional(),
  }),
  sugar: z.strictObject({
    baseUrl: httpsUrl.optional(),
    /** REST API version segment, e.g. `v11_20`. */
    apiVersion: z
      .string()
      .regex(/^v\d+(_\d+)?$/)
      .optional(),
    /** Custom API platform registered in Sugar for this integration. */
    platform: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  }),
  gainsight_cs: z.strictObject({
    baseUrl: httpsUrl.optional(),
  }),
  gainsight_px: z.strictObject({
    baseUrl: httpsUrl.optional(),
  }),
  jev: z.strictObject({
    endpoint: httpsUrl.optional(),
    modelProfile: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)
      .optional(),
  }),
  /**
   * M9B: no integration-level settings. The Chargebee site and limits live on
   * the source connection (ChargebeeConnectionConfigSchema); the read-only API
   * key is a credential name resolved through the SecretProvider.
   */
  chargebee: z.strictObject({}),
} as const satisfies Record<IntegrationSystem, z.ZodType>;

export type IntegrationSettings<S extends IntegrationSystem = IntegrationSystem> = z.infer<
  (typeof IntegrationSettingsSchemas)[S]
>;

export interface IntegrationConfig<S extends IntegrationSystem = IntegrationSystem> {
  readonly system: S;
  readonly access: IntegrationAccess;
  readonly settings: IntegrationSettings<S>;
  readonly version: number;
}

export function parseIntegrationSettings<S extends IntegrationSystem>(
  system: S,
  settings: unknown,
): IntegrationSettings<S> {
  return IntegrationSettingsSchemas[system].parse(settings) as IntegrationSettings<S>;
}

export function isEnabled(integration: Pick<IntegrationConfig, 'access'>): boolean {
  return integration.access !== 'disabled';
}
