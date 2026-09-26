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
    redisUrl: e.REDIS_URL,
    secretsProvider: e.SECRETS_PROVIDER,
    healthCheckTimeoutMs: e.HEALTH_CHECK_TIMEOUT_MS,
    telemetry: Object.freeze({
      otelEnabled: e.OTEL_ENABLED,
      serviceName: e.OTEL_SERVICE_NAME,
      otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
      sentryDsn: e.SENTRY_DSN,
      sentryEnvironment: e.SENTRY_ENVIRONMENT ?? e.NODE_ENV,
    }),
  });
}
