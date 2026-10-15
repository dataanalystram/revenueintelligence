import { envSchema, type AppConfig } from './config.schema';

export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Parses and validates environment variables into a typed, frozen AppConfig.
 *
 * Error messages name the offending variable but never echo its value, so a
 * misconfigured secret cannot leak into logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `${key}: ${issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message}`;
    });
    throw new ConfigValidationError(issues);
  }

  const e = result.data;
  return Object.freeze({
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    http: Object.freeze({ host: e.HOST, port: e.PORT }),
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    database: Object.freeze({
      allowPrivilegedRole: e.DATABASE_ALLOW_PRIVILEGED_ROLE,
      poolMax: e.DATABASE_POOL_MAX,
      lockTimeoutMs: e.DATABASE_LOCK_TIMEOUT_MS,
      transactionTimeoutMs: e.DATABASE_TRANSACTION_TIMEOUT_MS,
    }),
    redisUrl: e.REDIS_URL,
    secretsProvider: e.SECRETS_PROVIDER,
    healthCheckTimeoutMs: e.HEALTH_CHECK_TIMEOUT_MS,
    queue: Object.freeze({
      prefix: e.QUEUE_PREFIX,
      shutdownTimeoutMs: e.WORKER_SHUTDOWN_TIMEOUT_MS,
    }),
    context: Object.freeze({
      processingEnabled: e.CONTEXT_PROCESSING_ENABLED,
      sweepIntervalMs: e.CONTEXT_SWEEP_INTERVAL_MS,
      sweepStaleMs: e.CONTEXT_SWEEP_STALE_MS,
      sweepMaxAgeMs: e.CONTEXT_SWEEP_MAX_AGE_MS,
      reconcileIntervalMs: e.CONTEXT_RECONCILE_INTERVAL_MS,
      reconcileLookbackMs: e.CONTEXT_RECONCILE_LOOKBACK_MS,
    }),
    canonical: Object.freeze({ hierarchyMaxDepth: e.CANONICAL_HIERARCHY_MAX_DEPTH }),
    telemetry: Object.freeze({
      otelEnabled: e.OTEL_ENABLED,
      serviceName: e.OTEL_SERVICE_NAME,
      otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
      sentryDsn: e.SENTRY_DSN,
      sentryEnvironment: e.SENTRY_ENVIRONMENT ?? e.NODE_ENV,
    }),
  });
}
