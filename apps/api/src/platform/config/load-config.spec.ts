import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from './load-config';

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/lip',
  REDIS_URL: 'redis://localhost:6379',
} satisfies NodeJS.ProcessEnv;

function captureError(env: NodeJS.ProcessEnv): ConfigValidationError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies safe defaults for optional settings', () => {
    const config = loadConfig(validEnv);

    expect(config.nodeEnv).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.http).toEqual({ host: '0.0.0.0', port: 3000 });
    expect(config.logLevel).toBe('info');
    expect(config.secretsProvider).toBe('env');
    expect(config.healthCheckTimeoutMs).toBe(2000);
    expect(config.telemetry).toEqual({
      otelEnabled: false,
      serviceName: 'lead-intelligence-platform',
      otlpEndpoint: undefined,
      sentryDsn: undefined,
      sentryEnvironment: 'development',
    });
  });

  it('parses explicit values and coerces numbers and booleans', () => {
    const config = loadConfig({
      ...validEnv,
      NODE_ENV: 'production',
      PORT: '8080',
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318',
      SENTRY_DSN: 'https://key@o0.ingest.sentry.io/1',
    });

    expect(config.isProduction).toBe(true);
    expect(config.http.port).toBe(8080);
    expect(config.telemetry.otelEnabled).toBe(true);
    expect(config.telemetry.sentryEnvironment).toBe('production');
  });

  it('accepts the postgres:// and rediss:// schemes', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@db/lip',
      REDIS_URL: 'rediss://cache:6380',
    });
    expect(config.databaseUrl).toBe('postgres://u:p@db/lip');
    expect(config.redisUrl).toBe('rediss://cache:6380');
  });

  it('returns an immutable object', () => {
    const config = loadConfig(validEnv);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.telemetry)).toBe(true);
  });

  it('reports every missing required variable', () => {
    const error = captureError({});
    expect(error.issues).toEqual(['DATABASE_URL: is required', 'REDIS_URL: is required']);
  });

  it.each([
    ['DATABASE_URL', 'mysql://user:pass@localhost/lip'],
    ['DATABASE_URL', 'not a url'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['OTEL_ENABLED', 'maybe'],
    ['HEALTH_CHECK_TIMEOUT_MS', '5'],
  ])('rejects invalid %s=%s', (key, value) => {
    const error = captureError({ ...validEnv, [key]: value });
    expect(error.issues.some((issue) => issue.startsWith(`${key}:`))).toBe(true);
  });

  it('defaults to a safe database posture', () => {
    expect(loadConfig(validEnv).database).toEqual({
      allowPrivilegedRole: false,
      poolMax: 10,
      lockTimeoutMs: 5000,
      transactionTimeoutMs: 15000,
    });
  });

  it('never allows privileged database roles in production', () => {
    const error = captureError({
      ...validEnv,
      NODE_ENV: 'production',
      DATABASE_ALLOW_PRIVILEGED_ROLE: 'true',
    });
    expect(error.issues).toEqual([
      'DATABASE_ALLOW_PRIVILEGED_ROLE: must not be enabled in production',
    ]);
    expect(
      loadConfig({ ...validEnv, DATABASE_ALLOW_PRIVILEGED_ROLE: 'true' }).database
        .allowPrivilegedRole,
    ).toBe(true);
  });

  it.each([
    ['DATABASE_POOL_MAX', '0'],
    ['DATABASE_POOL_MAX', '500'],
    ['DATABASE_TRANSACTION_TIMEOUT_MS', '10'],
  ])('rejects invalid %s=%s', (key, value) => {
    const error = captureError({ ...validEnv, [key]: value });
    expect(error.issues.some((issue) => issue.startsWith(`${key}:`))).toBe(true);
  });

  it('requires an OTLP endpoint when tracing is enabled', () => {
    const error = captureError({ ...validEnv, OTEL_ENABLED: 'true' });
    expect(error.issues).toEqual([
      'OTEL_EXPORTER_OTLP_ENDPOINT: is required when OTEL_ENABLED=true',
    ]);
  });

  it('never echoes configuration values in error messages', () => {
    const error = captureError({
      DATABASE_URL: 'mysql://admin:SuperSecret123@db/lip',
      REDIS_URL: 'http://:AnotherSecret@cache',
    });
    expect(error.message).not.toContain('SuperSecret123');
    expect(error.message).not.toContain('AnotherSecret');
  });
});
