import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import type { Options } from 'pino-http';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { buildLoggerParams, REQUEST_ID_HEADER, resolveRequestId } from './logger-options';

const config = loadConfig({ DATABASE_URL: 'postgresql://u:p@db/lip', REDIS_URL: 'redis://r' });

function fakeReqRes(header?: string | string[]) {
  const headers: Record<string, string> = {};
  const req = {
    headers: header === undefined ? {} : { [REQUEST_ID_HEADER]: header },
  } as unknown as IncomingMessage;
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  } as unknown as ServerResponse;
  return { req, res, headers };
}

function captureLog(options: Options, entry: object): Record<string, unknown> {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ redact: options.redact, level: 'info' }, stream);
  logger.info(entry, 'test');
  return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
}

describe('resolveRequestId', () => {
  it('reuses a well-formed inbound x-request-id and echoes it on the response', () => {
    const { req, res, headers } = fakeReqRes('abc-123:DEF.456');
    expect(resolveRequestId(req, res)).toBe('abc-123:DEF.456');
    expect(headers[REQUEST_ID_HEADER]).toBe('abc-123:DEF.456');
  });

  it('uses the first value when the header is repeated', () => {
    const { req, res } = fakeReqRes(['first', 'second']);
    expect(resolveRequestId(req, res)).toBe('first');
  });

  it.each([undefined, '', 'has spaces', '<script>', 'x'.repeat(129), 'line\nbreak'])(
    'generates a UUID when the inbound id is %j',
    (value) => {
      const { req, res, headers } = fakeReqRes(value);
      const id = resolveRequestId(req, res);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(headers[REQUEST_ID_HEADER]).toBe(id);
    },
  );
});

describe('buildLoggerParams', () => {
  const options = buildLoggerParams(config).pinoHttp as Options;

  it('uses the configured level and service metadata', () => {
    expect(options.level).toBe('info');
    expect(options.base).toEqual({ service: 'lead-intelligence-platform', env: 'development' });
  });

  it('redacts credentials from request headers and nested payloads', () => {
    const log = captureLog(options, {
      req: {
        headers: {
          authorization: 'Bearer live-token',
          cookie: 'session=abc',
          'x-hubspot-signature-v3': 'sig',
          accept: 'application/json',
        },
      },
      oauth: { accessToken: 'at', refreshToken: 'rt', client_secret: 'cs' },
      sugar: { password: 'pw', username: 'integration-user' },
    });

    const serialised = JSON.stringify(log);
    for (const leaked of ['live-token', 'session=abc', '"sig"', '"at"', '"rt"', '"cs"', '"pw"']) {
      expect(serialised).not.toContain(leaked);
    }
    expect(serialised).toContain('application/json');
    expect(serialised).toContain('integration-user');
  });

  it('logs 5xx as error, 4xx as warn and everything else as info', () => {
    const level = options.customLogLevel!;
    const req = {} as IncomingMessage;
    expect(level(req, { statusCode: 503 } as ServerResponse, undefined)).toBe('error');
    expect(level(req, { statusCode: 200 } as ServerResponse, new Error('x'))).toBe('error');
    expect(level(req, { statusCode: 404 } as ServerResponse, undefined)).toBe('warn');
    expect(level(req, { statusCode: 201 } as ServerResponse, undefined)).toBe('info');
  });

  it('does not auto-log health probes', () => {
    const autoLogging = options.autoLogging as { ignore: (req: IncomingMessage) => boolean };
    expect(autoLogging.ignore({ url: '/health/ready' } as IncomingMessage)).toBe(true);
    expect(autoLogging.ignore({ url: '/webhooks/hubspot' } as IncomingMessage)).toBe(false);
  });
});
