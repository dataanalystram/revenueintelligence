import { z } from 'zod';

/**
 * Non-secret configuration of a Chargebee source connection (ADR 0024, M9B
 * plan §20). Values marked LIVE are confirmed on the Chargebee test site
 * before a real connection is enabled.
 */
export const ChargebeeConnectionConfigSchema = z.strictObject({
  /** The site subdomain: `https://<site>.chargebee.com` (test sites conventionally end `-test`). */
  site: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  /**
   * Test doubles only: a loopback `http://127.0.0.1:<port>` origin replacing
   * the site URL. Any other value is refused, so a real site is always reached
   * over https at `<site>.chargebee.com`.
   */
  endpoint: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        (url.pathname === '/' || url.pathname === '') &&
        !url.search &&
        !url.hash
      );
    }, 'endpoint is for loopback test doubles only')
    .optional(),
  /** Multiple Business Entity scoping (optional). */
  businessEntityId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,50}$/)
    .optional(),
  /** `list` page size (Chargebee: 1–100). */
  pageSize: z.number().int().min(1).max(100).default(100),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  maxRetries: z.number().int().min(0).max(8).default(4),
  /**
   * Requests per minute for this connection, kept below the site's limit
   * (test sites: 150/min; live sites: plan-based). Concurrency is always 1.
   */
  rateLimitPerMinute: z.number().int().min(1).max(3000).default(100),
  /**
   * V12 (LIVE): whether a subscription-item change provably moves the parent
   * subscription's `updated_at`. Until the test site proves it, incremental
   * reads of subscription lines are not offered (full runs only, decision B8).
   */
  incrementalLines: z.enum(['unverified', 'verified']).default('unverified'),
});
export type ChargebeeConnectionConfig = z.infer<typeof ChargebeeConnectionConfigSchema>;

/**
 * The credential held in the SecretProvider under the connection's credential
 * name: one Chargebee read-only API key (plain text). Never logged.
 */
export const ChargebeeApiKeySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
