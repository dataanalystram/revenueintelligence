import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import * as Sentry from '@sentry/nestjs';
import type { AppConfig } from '../config';

export interface Telemetry {
  readonly tracing: boolean;
  readonly errorReporting: boolean;
  shutdown(): Promise<void>;
}

/**
 * Starts OpenTelemetry tracing and Sentry error reporting. Both are opt-in via
 * configuration so local development and tests run with neither.
 *
 * Must run before NestJS and the instrumented libraries are imported (see
 * src/instrument.ts), otherwise auto-instrumentation cannot patch them.
 */
export function startTelemetry(config: AppConfig, processRole: 'api' | 'worker'): Telemetry {
  const { telemetry } = config;
  let sdk: NodeSDK | undefined;

  if (telemetry.sentryDsn) {
    Sentry.init({
      dsn: telemetry.sentryDsn,
      environment: telemetry.sentryEnvironment,
      initialScope: { tags: { role: processRole } },
      // Tracing is owned by the OpenTelemetry SDK below; Sentry must not register
      // a competing tracer provider. Sentry reports errors only.
      enableOpenTelemetrySetup: false,
      tracesSampleRate: 0,
      // CRM payloads contain personal data (names, emails). Collect none of it.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
    });
  }

  if (telemetry.otelEnabled && telemetry.otlpEndpoint) {
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: `${telemetry.serviceName}-${processRole}`,
      }),
      traceExporter: new OTLPTraceExporter({ url: `${telemetry.otlpEndpoint}/v1/traces` }),
      // Queue and context-processing metrics (M6); labels are short codes only.
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${telemetry.otlpEndpoint}/v1/metrics` }),
        }),
      ],
      instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
        new NestInstrumentation(),
        new PgInstrumentation(),
        new IORedisInstrumentation(),
      ],
    });
    sdk.start();
  }

  return {
    tracing: sdk !== undefined,
    errorReporting: telemetry.sentryDsn !== undefined,
    async shutdown() {
      await Promise.allSettled([
        sdk?.shutdown(),
        telemetry.sentryDsn ? Sentry.close(2_000) : undefined,
      ]);
    },
  };
}

/** Forwards an unexpected error to Sentry; a no-op when Sentry is not initialised. */
export function reportError(error: unknown): void {
  Sentry.captureException(error);
}
