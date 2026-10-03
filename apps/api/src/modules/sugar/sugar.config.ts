import { z } from 'zod';

const ApiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);

/**
 * Non-secret configuration of a Sugar source connection (ADR 0021). Every
 * value marked LIVE must be confirmed against the customer's tenant before a
 * real connection is enabled (docs/integrations/sugar/live-verification.md).
 */
export const SugarConnectionConfigSchema = z.strictObject({
  /** https only; plain http is accepted for loopback test doubles. */
  instanceUrl: z.url().refine((value) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  }, 'instanceUrl must be an https origin (http only for loopback test doubles)'),
  /** REST API version, e.g. `v11_20` (LIVE: never assumed). */
  apiVersion: z.string().regex(/^v\d{1,2}(_\d{1,2})?$/),
  /** OAuth `platform` parameter (LIVE). */
  platform: z
    .string()
    .regex(/^[a-z0-9_]{1,40}$/)
    .optional(),
  /** Modules whose metadata `describeSchema` reads (API names; LIVE). */
  modules: z.array(ApiName).min(1).max(30),
  /** Catalogue modules (reference sets, e.g. the product catalogue; LIVE name). */
  referenceModules: z.array(ApiName).max(10).default([]),
  /** Modules holding the source's own staff: never people or accounts. */
  internalModules: z.array(ApiName).max(10).default(['Users', 'Employees']),
  /** Whether `GET /{Module}/count` is available for full-read proof (LIVE). */
  countSupported: z.boolean().default(true),
  pageSize: z.number().int().min(1).max(200).default(100),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  maxRetries: z.number().int().min(0).max(8).default(4),
  /** Per-connection request budget (LIVE thresholds). */
  rateLimit: z
    .strictObject({
      requests: z.number().int().min(1).max(1000),
      windowMs: z.number().int().min(100).max(600_000),
    })
    .default({ requests: 50, windowMs: 10_000 }),
});
export type SugarConnectionConfig = z.infer<typeof SugarConnectionConfigSchema>;

/**
 * The credential bundle held in the SecretProvider under the connection's
 * credential name (one secret, JSON). Never logged, never stored elsewhere.
 */
export const SugarCredentialsSchema = z.strictObject({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().max(500),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
});
export type SugarCredentials = z.infer<typeof SugarCredentialsSchema>;
