import { z } from 'zod';
import type { RevealableSecret } from '../../domain';
import {
  backoffDelayMs,
  parseRetryAfterMs,
  SlidingWindowRateLimiter,
} from '../../../platform/outbound';
import { SugarError } from '../errors';
import {
  SugarCredentialsSchema,
  type SugarConnectionConfig,
  type SugarCredentials,
} from '../sugar.config';

export interface SugarRequest {
  readonly method: 'GET' | 'POST';
  /** Path below `/rest/{version}`, e.g. `/Accounts` or `/oauth2/token`. */
  readonly path: string;
  readonly query?: URLSearchParams;
}

/** Counts requests by method, so tests (and the live gate) can prove read-only behaviour. */
export interface SugarTransportCounters {
  get: number;
  tokenPost: number;
  refused: number;
}

const TOKEN_PATH = '/oauth2/token';
/** Plain path segments only: no dot segments, encoding, query or fragment. */
const PLAIN_PATH = /^(?:\/[A-Za-z0-9_-]+)+$/;

/**
 * Read-only transport guard (ADR 0021 §2): only GET requests and the OAuth
 * token POST leave the adapter; anything else throws before sending.
 */
export function assertReadOnlySugarRequest(req: Pick<SugarRequest, 'method' | 'path'>): void {
  if (!PLAIN_PATH.test(req.path)) {
    throw new SugarError('unsupported_endpoint', `Refusing ${req.path}: not a plain API path`, {
      path: req.path,
    });
  }
  if (req.method === 'GET' && req.path !== TOKEN_PATH) return;
  if (req.method === 'POST' && req.path === TOKEN_PATH) return;
  throw new SugarError(
    'read_only_violation',
    `Refusing ${String(req.method)} ${req.path}: the Sugar connector is read-only`,
    { path: req.path },
  );
}

const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
});

const ErrorBodySchema = z.looseObject({ error: z.string().max(100).optional() });

export interface SugarHttpDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly limiter?: SlidingWindowRateLimiter;
  readonly counters?: SugarTransportCounters;
  /** Called once per attempt with the HTTP status or transport failure (metrics). */
  readonly onAttempt?: (outcome: number | 'network' | 'timeout') => void;
  readonly onRetry?: (info: { status?: number; attempt: number; delayMs: number }) => void;
}

interface Token {
  readonly access: string;
  readonly refresh?: string;
  readonly expiresAt: number;
}

/**
 * HTTP transport for one Sugar connection: OAuth2 password grant with
 * refresh (single-flight), per-connection rate limit, timeouts, bounded
 * retries honouring Retry-After, error classification and Zod validation of
 * every response. Credentials are resolved through the SecretProvider on
 * demand and never logged.
 */
export class SugarHttpClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly limiter: SlidingWindowRateLimiter;
  readonly counters: SugarTransportCounters;
  private token: Token | undefined;
  private pendingToken: Promise<Token> | undefined;

  constructor(
    private readonly config: SugarConnectionConfig,
    private readonly connectionKey: string,
    private readonly credentials: () => Promise<RevealableSecret>,
    private readonly deps: SugarHttpDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.limiter =
      deps.limiter ??
      new SlidingWindowRateLimiter(config.rateLimit.requests, config.rateLimit.windowMs, this.now);
    this.counters = deps.counters ?? { get: 0, tokenPost: 0, refused: 0 };
  }

  /** GET with authentication, retries and response validation. */
  async get<T>(path: string, query: URLSearchParams | undefined, schema: z.ZodType<T>): Promise<T> {
    const req: SugarRequest = { method: 'GET', path, ...(query ? { query } : {}) };
    this.guard(req);
    let reauthenticated = false;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const token = await this.accessToken();
        return await this.attempt(req, schema, token.access);
      } catch (err) {
        if (!(err instanceof SugarError)) throw err;
        if (err.kind === 'unauthorized' && !reauthenticated) {
          // The access token expired or was revoked: one fresh grant, not a retry.
          reauthenticated = true;
          // Keep the refresh token: the next grant tries it before the password.
          if (this.token) this.token = { ...this.token, expiresAt: 0 };
          attempt -= 1;
          continue;
        }
        if (!err.retryable || attempt > this.config.maxRetries) {
          throw new SugarError(err.kind, err.message, { ...err.details, attempts: attempt });
        }
        const delayMs = err.details.retryAfterMs ?? backoffDelayMs(attempt, this.random);
        this.deps.onRetry?.({
          ...(err.details.status ? { status: err.details.status } : {}),
          attempt,
          delayMs,
        });
        await this.sleep(delayMs);
      }
    }
  }

  private guard(req: SugarRequest): void {
    try {
      assertReadOnlySugarRequest(req);
    } catch (err) {
      this.counters.refused += 1;
      throw err;
    }
  }

  private url(req: SugarRequest): string {
    const base = new URL(this.config.instanceUrl);
    const url = new URL(`/rest/${this.config.apiVersion}${req.path}`, base.origin);
    if (req.query) url.search = req.query.toString();
    return url.toString();
  }

  private async accessToken(): Promise<Token> {
    const current = this.token;
    if (current && current.expiresAt - 30_000 > this.now()) return current;
    // Single-flight: concurrent readers share one grant.
    this.pendingToken ??= this.grant(current?.refresh).finally(() => {
      this.pendingToken = undefined;
    });
    this.token = await this.pendingToken;
    return this.token;
  }

  private async grant(refreshToken: string | undefined): Promise<Token> {
    const creds = await this.loadCredentials();
    if (refreshToken) {
      try {
        return await this.tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          ...(this.config.platform ? { platform: this.config.platform } : {}),
        });
      } catch (err) {
        // A rejected refresh token falls back to the password grant once.
        if (!(err instanceof SugarError) || err.kind !== 'unauthorized') throw err;
      }
    }
    return await this.tokenRequest({
      grant_type: 'password',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      username: creds.username,
      password: creds.password,
      ...(this.config.platform ? { platform: this.config.platform } : {}),
    });
  }

  private async loadCredentials(): Promise<SugarCredentials> {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await this.credentials()).reveal());
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new SugarError('not_configured', 'The Sugar credential is not a JSON bundle');
      }
      throw new SugarError('not_configured', 'The Sugar credential is not configured');
    }
    const creds = SugarCredentialsSchema.safeParse(parsed);
    if (!creds.success) {
      // Field names only: never the values.
      throw new SugarError(
        'not_configured',
        `The Sugar credential bundle is incomplete (${creds.error.issues.map((i) => i.path.join('.')).join(', ')})`,
      );
    }
    return creds.data;
  }

  private async tokenRequest(body: Record<string, string>): Promise<Token> {
    const req: SugarRequest = { method: 'POST', path: TOKEN_PATH };
    this.guard(req);
    await this.limiter.acquire(this.connectionKey);
    this.counters.tokenPost += 1;
    let response: Response;
    try {
      response = await this.fetchFn(this.url(req), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw transportError(err, TOKEN_PATH, this.config.timeoutMs);
    }
    this.deps.onAttempt?.(response.status);
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const kind =
        response.status === 400 || response.status === 401
          ? 'unauthorized'
          : classify(response.status);
      throw new SugarError(kind, `Sugar token request failed (${response.status})`, {
        status: response.status,
        path: TOKEN_PATH,
      });
    }
    const parsed = TokenResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      throw new SugarError('invalid_payload', 'Unexpected Sugar token response shape', {
        status: response.status,
        path: TOKEN_PATH,
      });
    }
    return {
      access: parsed.data.access_token,
      ...(parsed.data.refresh_token ? { refresh: parsed.data.refresh_token } : {}),
      expiresAt: this.now() + (parsed.data.expires_in ?? 3600) * 1000,
    };
  }

  private async attempt<T>(req: SugarRequest, schema: z.ZodType<T>, access: string): Promise<T> {
    await this.limiter.acquire(this.connectionKey);
    this.counters.get += 1;
    let response: Response;
    try {
      response = await this.fetchFn(this.url(req), {
        method: 'GET',
        headers: { accept: 'application/json', 'oauth-token': access },
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      this.deps.onAttempt?.(
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'timeout'
          : 'network',
      );
      throw transportError(err, req.path, this.config.timeoutMs);
    }
    this.deps.onAttempt?.(response.status);
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw transportError(err, req.path, this.config.timeoutMs);
    }
    if (!response.ok) {
      const body = ErrorBodySchema.safeParse(safeJson(text));
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), this.now);
      throw new SugarError(
        classify(response.status),
        `Sugar request failed (${response.status}${body.success && body.data.error ? ` ${body.data.error}` : ''})`,
        {
          status: response.status,
          path: req.path,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }
    const json = safeJson(text);
    if (json === undefined) {
      throw new SugarError('invalid_payload', 'Sugar returned a response that is not JSON', {
        status: response.status,
        path: req.path,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Issue paths and messages only: never payload values.
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new SugarError('invalid_payload', `Unexpected Sugar response shape: ${issues}`, {
        status: response.status,
        path: req.path,
      });
    }
    return parsed.data;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function classify(status: number): SugarError['kind'] {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}

function transportError(err: unknown, path: string, timeoutMs: number): SugarError {
  const timedOut =
    err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
  return new SugarError(
    timedOut ? 'timeout' : 'network',
    timedOut
      ? `Sugar request timed out after ${timeoutMs} ms`
      : 'Sugar request failed before a response',
    { path },
  );
}
