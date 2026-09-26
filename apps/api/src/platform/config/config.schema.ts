import { z } from 'zod';

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

    SECRETS_PROVIDER: z.enum(['env']).default('env'),

    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),

    OTEL_ENABLED: booleanFromEnv.default(false),
    OTEL_SERVICE_NAME: z.string().min(1).default('lead-intelligence-platform'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

    SENTRY_DSN: z.url().optional(),
    SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
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
  readonly redisUrl: string;
  readonly secretsProvider: Env['SECRETS_PROVIDER'];
  readonly healthCheckTimeoutMs: number;
  readonly telemetry: {
    readonly otelEnabled: boolean;
    readonly serviceName: string;
    readonly otlpEndpoint: string | undefined;
    readonly sentryDsn: string | undefined;
    readonly sentryEnvironment: string;
  };
}
