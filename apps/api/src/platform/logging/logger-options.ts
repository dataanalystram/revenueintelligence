import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../config';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Paths that must never be written to logs. Extend this list rather than
 * relying on call sites to remember to strip sensitive values.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-hubspot-signature"]',
  'req.headers["x-hubspot-signature-v3"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.clientSecret',
  '*.client_secret',
  '*.apiKey',
  '*.api_key',
];

/** Reuses a well-formed inbound request id, otherwise generates one. */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

export function buildLoggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      base: { service: config.telemetry.serviceName, env: config.nodeEnv },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      genReqId: resolveRequestId,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // Liveness/readiness probes are high-frequency noise.
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    },
  };
}
