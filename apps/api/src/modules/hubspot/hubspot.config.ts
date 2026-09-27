import { z } from 'zod';

/** Upper bound of HUBSPOT_OAUTH_TIMEOUT_MS; the refresh lock budget depends on it (ADR 0010). */
export const HUBSPOT_OAUTH_MAX_TIMEOUT_MS = 20_000;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Process-level HubSpot client settings (operator-controlled, not tenant
 * data). Tenants cannot change the API host, which rules out SSRF through
 * tenant configuration.
 */
/** HTTPS, or plain HTTP only for a loopback fake server (tests, runtime verification). */
const secureUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}, 'must use https (http is allowed only for a loopback test server)');

export const HubSpotEnvSchema = z.object({
  HUBSPOT_API_BASE_URL: secureUrl.default('https://api.hubapi.com'),
  /**
   * HubSpot date-based API version used for CRM endpoints (/YYYY-MM/). Versions
   * are locked once GA; bump deliberately and re-run the live tests.
   */
  HUBSPOT_API_VERSION: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM')
    .default('2026-09'),
  /**
   * Date-based version of the Account Information API, configurable separately
   * because API groups do not always ship a version at the same time. `2026-09`
   * was confirmed live on 2026-09-26 (2026-03 is also documented); discovery
   * probes the CRM version whenever the two differ.
   */
  HUBSPOT_ACCOUNT_INFO_API_VERSION: z
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

  // --- OAuth app (ADR 0010). Optional: only tenants using `auth: oauth` need them.
  /** Date-based version of HubSpot's OAuth API (`/oauth/{version}/token`). */
  HUBSPOT_OAUTH_API_VERSION: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM')
    .default('2026-09'),
  /** HubSpot's consent page; the account id is appended (`…/oauth/{portalId}/authorize`). */
  HUBSPOT_OAUTH_AUTHORIZE_BASE_URL: secureUrl.default('https://app.hubspot.com/oauth'),
  HUBSPOT_OAUTH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(HUBSPOT_OAUTH_MAX_TIMEOUT_MS)
    .default(10_000),
  /** The projects-based app's client id (not a secret; the client secret is a SecretProvider value). */
  HUBSPOT_APP_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9-]{8,64}$/)
    .optional(),
  /** Must match the app's configured redirect URL exactly. */
  HUBSPOT_APP_REDIRECT_URI: secureUrl.optional(),

  // --- Webhooks (ADR 0011). Optional: without them the webhook endpoint answers 503.
  /** The app's numeric id; every webhook event must carry it. */
  HUBSPOT_APP_ID: z
    .string()
    .regex(/^[0-9]{1,20}$/, 'must be the numeric HubSpot app id')
    .optional(),
  /**
   * The public URL HubSpot delivers webhooks to, exactly as configured in the
   * app (webhooks-hsmeta.json targetUrl). Signatures are computed over this
   * URL, never over the request's Host header, which a client controls.
   */
  HUBSPOT_WEBHOOK_TARGET_URL: secureUrl
    .refine((value) => {
      const url = new URL(value);
      return url.search === '' && url.hash === '' && url.username === '' && url.password === '';
    }, 'must not contain a query string, fragment or credentials')
    .optional(),
});

export interface HubSpotConfig {
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly accountInfoApiVersion: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly requestsPer10s: number;
  readonly oauth: {
    readonly apiVersion: string;
    readonly authorizeBaseUrl: string;
    readonly timeoutMs: number;
    readonly clientId: string | undefined;
    readonly redirectUri: string | undefined;
  };
  readonly webhooks: {
    readonly appId: string | undefined;
    readonly targetUrl: string | undefined;
  };
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
    accountInfoApiVersion: e.HUBSPOT_ACCOUNT_INFO_API_VERSION,
    timeoutMs: e.HUBSPOT_REQUEST_TIMEOUT_MS,
    maxRetries: e.HUBSPOT_MAX_RETRIES,
    requestsPer10s: e.HUBSPOT_REQUESTS_PER_10S,
    oauth: Object.freeze({
      apiVersion: e.HUBSPOT_OAUTH_API_VERSION,
      authorizeBaseUrl: e.HUBSPOT_OAUTH_AUTHORIZE_BASE_URL.replace(/\/+$/, ''),
      timeoutMs: e.HUBSPOT_OAUTH_TIMEOUT_MS,
      clientId: e.HUBSPOT_APP_CLIENT_ID,
      redirectUri: e.HUBSPOT_APP_REDIRECT_URI,
    }),
    webhooks: Object.freeze({
      appId: e.HUBSPOT_APP_ID,
      targetUrl: e.HUBSPOT_WEBHOOK_TARGET_URL,
    }),
  });
}
