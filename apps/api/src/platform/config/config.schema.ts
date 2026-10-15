import { z } from 'zod';

/**
 * M10D (plan §2.7, Q3, Q5): the extension guardrails — environment variable,
 * default and bounded range. Equal to `EXTENSION_GUARDRAIL_SPECS` in the domain
 * (pinned by a unit test; platform code may not import modules).
 */
export const EXTENSION_GUARDRAIL_ENV = {
  maxFieldsPerTarget: { env: 'EXTENSION_MAX_FIELDS_PER_TARGET', default: 1000, min: 1, max: 2000 },
  maxObjects: { env: 'EXTENSION_MAX_OBJECTS', default: 100, min: 1, max: 500 },
  maxFieldsPerObject: { env: 'EXTENSION_MAX_FIELDS_PER_OBJECT', default: 300, min: 1, max: 1000 },
  maxRelationships: { env: 'EXTENSION_MAX_RELATIONSHIPS', default: 300, min: 1, max: 1000 },
  maxEnumValues: { env: 'EXTENSION_MAX_ENUM_VALUES', default: 1000, min: 1, max: 5000 },
  maxArrayItems: { env: 'EXTENSION_MAX_ARRAY_ITEMS', default: 500, min: 1, max: 10000 },
  maxJsonBytes: { env: 'EXTENSION_MAX_JSON_BYTES', default: 65536, min: 1024, max: 65536 },
  maxJsonDepth: { env: 'EXTENSION_MAX_JSON_DEPTH', default: 8, min: 1, max: 16 },
  maxRecordsPerObject: {
    env: 'EXTENSION_MAX_RECORDS_PER_OBJECT',
    default: 10_000_000,
    min: 1,
    max: 100_000_000,
  },
  registryMaxBytes: {
    env: 'EXTENSION_REGISTRY_MAX_BYTES',
    default: 2 * 1024 * 1024,
    min: 256 * 1024,
    max: 8 * 1024 * 1024,
  },
} as const;
export type ExtensionGuardrailConfig = {
  readonly [K in keyof typeof EXTENSION_GUARDRAIL_ENV]: number;
};
const guardrail = (spec: { default: number; min: number; max: number }) =>
  z.coerce.number().int().min(spec.min).max(spec.max).default(spec.default);
const G = EXTENSION_GUARDRAIL_ENV;

const booleanFromEnv = z.stringbool({ truthy: ['true', '1', 'yes'], falsy: ['false', '0', 'no'] });

/**
 * Process-level configuration, validated once at start-up.
 *
 * Integration credentials (HubSpot, Sugar, Gainsight) are deliberately NOT part
 * of this schema: they are tenant-scoped secrets resolved at runtime through
 * the SecretProvider abstraction (see platform/secrets).
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).describe('PostgreSQL connection string'),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }).describe('Redis connection string'),
    /**
     * The runtime must connect as a non-privileged role so PostgreSQL row-level
     * security applies (ADR 0008). Only for local experiments; never production.
     */
    DATABASE_ALLOW_PRIVILEGED_ROLE: booleanFromEnv.default(false),
    /** Maximum connections per process (API and worker each have their own pool). */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    /**
     * Longest a transaction waits for a lock (e.g. the per-tenant configuration
     * lock) before failing with a retryable "busy" error instead of holding a
     * pooled connection.
     */
    DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(50).max(60_000).default(5_000),
    DATABASE_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(15_000),

    SECRETS_PROVIDER: z.enum(['env']).default('env'),

    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),

    OTEL_ENABLED: booleanFromEnv.default(false),
    OTEL_SERVICE_NAME: z.string().min(1).default('lead-intelligence-platform'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

    /**
     * M6 runtime switch (ADR 0013). false: webhook receipts are stored exactly
     * as in M5, nothing is enqueued and the worker registers no processors.
     */
    CONTEXT_PROCESSING_ENABLED: booleanFromEnv.default(true),
    /** BullMQ key prefix, so environments can share a Redis safely. */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .default('lip'),
    /** Longest the worker waits for active jobs on shutdown. */
    WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(25_000),
    /** How often each tenant's pending receipts are swept back into the queue. */
    CONTEXT_SWEEP_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(300_000),
    /** A receipt still pending after this long is re-enqueued by the sweep. */
    CONTEXT_SWEEP_STALE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
    /** The sweep ignores receipts older than this (historical ones need the explicit command). */
    CONTEXT_SWEEP_MAX_AGE_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 3_600_000)
      .default(24 * 3_600_000),
    /** How often a reconciliation run starts per tenant (0 = never automatically). */
    CONTEXT_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
    /** Overlap before the watermark, for search-index lag (ADR 0015). */
    CONTEXT_RECONCILE_LOOKBACK_MS: z.coerce.number().int().min(0).max(86_400_000).default(600_000),

    /**
     * M10C (plan §2.3, Q3): the account-hierarchy depth guardrail (edges from the
     * root), enforced by the writer. Out of range refuses start-up. Not canonical
     * semantics: raising it is configuration, never a canonical version change.
     */
    CANONICAL_HIERARCHY_MAX_DEPTH: z.coerce.number().int().min(1).max(50).default(10),

    /**
     * M10D (plan §2.7, Q3, Q5): extension guardrails, enforced at registry publish
     * and at write time. Bounded ranges; out of range refuses start-up. Exceeding
     * one is a refusal, never truncation. Not canonical semantics.
     */
    EXTENSION_MAX_FIELDS_PER_TARGET: guardrail(G.maxFieldsPerTarget),
    EXTENSION_MAX_OBJECTS: guardrail(G.maxObjects),
    EXTENSION_MAX_FIELDS_PER_OBJECT: guardrail(G.maxFieldsPerObject),
    EXTENSION_MAX_RELATIONSHIPS: guardrail(G.maxRelationships),
    EXTENSION_MAX_ENUM_VALUES: guardrail(G.maxEnumValues),
    EXTENSION_MAX_ARRAY_ITEMS: guardrail(G.maxArrayItems),
    EXTENSION_MAX_JSON_BYTES: guardrail(G.maxJsonBytes),
    EXTENSION_MAX_JSON_DEPTH: guardrail(G.maxJsonDepth),
    EXTENSION_MAX_RECORDS_PER_OBJECT: guardrail(G.maxRecordsPerObject),
    EXTENSION_REGISTRY_MAX_BYTES: guardrail(G.registryMaxBytes),

    SENTRY_DSN: z.url().optional(),
    SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.DATABASE_ALLOW_PRIVILEGED_ROLE) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_ALLOW_PRIVILEGED_ROLE'],
        message: 'must not be enabled in production',
      });
    }
    if (env.OTEL_ENABLED && !env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
        message: 'is required when OTEL_ENABLED=true',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly http: { readonly host: string; readonly port: number };
  readonly logLevel: Env['LOG_LEVEL'];
  readonly databaseUrl: string;
  readonly database: {
    readonly allowPrivilegedRole: boolean;
    readonly poolMax: number;
    readonly lockTimeoutMs: number;
    readonly transactionTimeoutMs: number;
  };
  readonly redisUrl: string;
  readonly secretsProvider: Env['SECRETS_PROVIDER'];
  readonly healthCheckTimeoutMs: number;
  readonly queue: { readonly prefix: string; readonly shutdownTimeoutMs: number };
  readonly context: {
    readonly processingEnabled: boolean;
    readonly sweepIntervalMs: number;
    readonly sweepStaleMs: number;
    readonly sweepMaxAgeMs: number;
    readonly reconcileIntervalMs: number;
    readonly reconcileLookbackMs: number;
  };
  /** M10C: canonical guardrails (platform configuration, not canonical semantics). */
  readonly canonical: {
    readonly hierarchyMaxDepth: number;
    /** M10D: extension guardrails (plan §2.7). */
    readonly extension: ExtensionGuardrailConfig;
  };
  readonly telemetry: {
    readonly otelEnabled: boolean;
    readonly serviceName: string;
    readonly otlpEndpoint: string | undefined;
    readonly sentryDsn: string | undefined;
    readonly sentryEnvironment: string;
  };
}
