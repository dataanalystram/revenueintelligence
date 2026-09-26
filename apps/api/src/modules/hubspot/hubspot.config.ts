import { z } from 'zod';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Process-level HubSpot client settings (operator-controlled, not tenant
 * data). Tenants cannot change the API host, which rules out SSRF through
 * tenant configuration.
 */
export const HubSpotEnvSchema = z.object({
  HUBSPOT_API_BASE_URL: z
    .url()
    .default('https://api.hubapi.com')
    .refine((value) => {
      const url = new URL(value);
      // Plain HTTP only for a loopback fake server (tests, runtime verification).
      return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
    }, 'must use https (http is allowed only for a loopback test server)'),
  /**
   * HubSpot date-based API version used for CRM endpoints (/YYYY-MM/). Versions
   * are locked once GA; bump deliberately and re-run the live tests.
   */
  HUBSPOT_API_VERSION: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM')
    .default('2026-09'),
  HUBSPOT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /** Retries after the first attempt, for retryable failures of read requests. */
  HUBSPOT_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  /**
   * Client-side budget per tenant per rolling 10 s. HubSpot's burst limit is
   * 100–190 per 10 s depending on subscription and app type; 90 stays below the
   * lowest tier.
   */
  HUBSPOT_REQUESTS_PER_10S: z.coerce.number().int().min(1).max(190).default(90),
});

export interface HubSpotConfig {
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly requestsPer10s: number;
}

export const HUBSPOT_CONFIG = Symbol('HUBSPOT_CONFIG');

export function loadHubSpotConfig(env: NodeJS.ProcessEnv = process.env): HubSpotConfig {
  const result = HubSpotEnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid HubSpot configuration: ${issues}`);
  }
  const e = result.data;
  return Object.freeze({
    baseUrl: e.HUBSPOT_API_BASE_URL.replace(/\/+$/, ''),
    apiVersion: e.HUBSPOT_API_VERSION,
    timeoutMs: e.HUBSPOT_REQUEST_TIMEOUT_MS,
    maxRetries: e.HUBSPOT_MAX_RETRIES,
    requestsPer10s: e.HUBSPOT_REQUESTS_PER_10S,
  });
}
