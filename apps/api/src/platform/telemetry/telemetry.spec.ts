import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  captureException: vi.fn(),
}));
const sdk = vi.hoisted(() => ({
  start: vi.fn(),
  shutdown: vi.fn(() => Promise.resolve()),
  ctor: vi.fn(),
}));

vi.mock('@sentry/nestjs', () => sentry);
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(options: unknown) {
      sdk.ctor(options);
    }
    start = sdk.start;
    shutdown = sdk.shutdown;
  },
}));

import { loadConfig } from '../config';
import { reportError, startTelemetry } from './telemetry';

const base = { DATABASE_URL: 'postgresql://u:p@db/lip', REDIS_URL: 'redis://r' };

describe('startTelemetry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts nothing when telemetry is not configured', async () => {
    const telemetry = startTelemetry(loadConfig(base), 'api');

    expect(telemetry).toMatchObject({ tracing: false, errorReporting: false });
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(sentry.close).not.toHaveBeenCalled();
  });

  it('initialises Sentry for errors only, without collecting personal data', () => {
    const config = loadConfig({ ...base, SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' });
    const telemetry = startTelemetry(config, 'worker');

    expect(telemetry.errorReporting).toBe(true);
    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://k@o0.ingest.sentry.io/1',
        environment: 'development',
        enableOpenTelemetrySetup: false,
        tracesSampleRate: 0,
        initialScope: { tags: { role: 'worker' } },
        dataCollection: expect.objectContaining({ userInfo: false, httpBodies: [] }),
      }),
    );
  });

  it('starts the OpenTelemetry SDK with a role-specific service name', async () => {
    const config = loadConfig({
      ...base,
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_SERVICE_NAME: 'lip',
    });
    const telemetry = startTelemetry(config, 'api');

    expect(telemetry.tracing).toBe(true);
    expect(sdk.start).toHaveBeenCalledOnce();
    const options = sdk.ctor.mock.calls[0]?.[0] as {
      resource: { attributes: Record<string, unknown> };
    };
    expect(options.resource.attributes['service.name']).toBe('lip-api');

    await telemetry.shutdown();
    expect(sdk.shutdown).toHaveBeenCalledOnce();
  });

  it('shutdown tolerates exporter failures', async () => {
    sdk.shutdown.mockRejectedValueOnce(new Error('collector unreachable'));
    const config = loadConfig({
      ...base,
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    });
    await expect(startTelemetry(config, 'api').shutdown()).resolves.toBeUndefined();
  });

  it('reportError forwards to Sentry', () => {
    const error = new Error('x');
    reportError(error);
    expect(sentry.captureException).toHaveBeenCalledWith(error);
  });
});
