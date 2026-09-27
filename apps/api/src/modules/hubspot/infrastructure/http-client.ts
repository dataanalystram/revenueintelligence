import type { z } from 'zod';
import type { Secret } from '../../../platform/secrets';
import { HubSpotError, type HubSpotErrorKind } from '../errors';
import type { HubSpotConfig } from '../hubspot.config';
import type { SlidingWindowRateLimiter } from './rate-limiter';
import { backoffDelayMs, parseRetryAfterMs } from './retry';
import { HsErrorBodySchema } from './schemas';

export interface HubSpotRequest {
  readonly method: 'GET' | 'POST';
  /** Absolute API path, e.g. `/crm/objects/2026-09/contacts`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body?: unknown;
}

/**
 * Who the request is for: the tenant (rate-limit key) and its bearer token.
 * `token` may be a provider, called once per request, so an OAuth access token
 * that expires during a long read is refreshed transparently. Token failures
 * are not retried by the transport (the provider decides).
 */
export interface HubSpotAuth {
  readonly tenantKey: string;
  readonly token: Secret | (() => Promise<Secret>);
  /**
   * Called when HubSpot rejects the token with 401 (e.g. revoked, or replaced
   * by a reinstall in another process). The request is then retried once with
   * a freshly provided token.
   */
  readonly onUnauthorized?: (rejected: Secret) => Promise<void> | void;
}

/**
 * The connector is read-only (Milestone 3; no production writes without
 * explicit approval). GET is always a read. POST is allowed only for HubSpot's
 * batch *read* endpoints, which use POST to carry a list of ids.
 */
const READ_ONLY_POST_PATHS: readonly RegExp[] = [
  /^\/crm\/associations\/[\w-]+\/[\w-]+\/[\w-]+\/batch\/read$/,
];

export function assertReadOnlyRequest(req: Pick<HubSpotRequest, 'method' | 'path'>): void {
  if (req.method === 'GET') return;
  if (req.method === 'POST' && READ_ONLY_POST_PATHS.some((re) => re.test(req.path))) return;
  throw new HubSpotError(
    'read_only_violation',
    `Refusing ${String(req.method)} ${req.path}: the HubSpot connector is read-only`,
    { path: req.path },
  );
}

/**
 * Only HubSpot's date-based APIs (`/<api>/<YYYY-MM>/…`) may be called. Legacy
 * v1–v4 paths go unsupported in 2027 and are refused outright, so a new legacy
 * dependency cannot slip in unnoticed.
 */
const DATE_VERSIONED_PATH =
  /^\/(?:crm\/(?:objects|properties|associations)|account-info)\/\d{4}-(?:0[1-9]|1[0-2])\//;

/** Only plain path characters: no dot segments, encoding, query or fragment. */
const PLAIN_PATH = /^(?:\/[A-Za-z0-9_-]+)+$/;

export function assertDateVersionedPath(path: string): void {
  // Checked on the literal path, which must also be exactly what is sent:
  // `..` or `%2e%2e` segments would otherwise be normalised by URL into a
  // legacy path (e.g. /crm/objects/2026-09/../../v3/objects/companies).
  if (
    PLAIN_PATH.test(path) &&
    DATE_VERSIONED_PATH.test(path) &&
    new URL(path, 'https://api.hubapi.com').pathname === path
  ) {
    return;
  }
  throw new HubSpotError(
    'unsupported_endpoint',
    `Refusing ${path}: only HubSpot date-based API versions are used`,
    { path },
  );
}

export interface HubSpotTransportLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

export interface HubSpotHttpClientDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly logger?: HubSpotTransportLogger;
}

const STATUS_KIND: Readonly<Record<number, HubSpotErrorKind>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  429: 'rate_limited',
};

/**
 * HTTP transport for the HubSpot API: authentication, per-tenant rate
 * limiting, timeouts, error classification, bounded retries of transient
 * failures and Zod validation of every response body.
 */
export class HubSpotHttpClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly logger: HubSpotTransportLogger | undefined;

  constructor(
    private readonly config: HubSpotConfig,
    private readonly limiter: SlidingWindowRateLimiter,
    deps: HubSpotHttpClientDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger;
  }

  async send<T>(req: HubSpotRequest, schema: z.ZodType<T>, auth: HubSpotAuth): Promise<T> {
    assertReadOnlyRequest(req);
    assertDateVersionedPath(req.path);
    const maxAttempts = 1 + this.config.maxRetries;
    let token = await resolveToken(auth);
    let reauthenticated = false;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(req, schema, auth.tenantKey, token);
      } catch (err) {
        if (!(err instanceof HubSpotError)) throw err;
        if (err.kind === 'unauthorized' && auth.onUnauthorized && !reauthenticated) {
          reauthenticated = true;
          await auth.onUnauthorized(token);
          token = await resolveToken(auth);
          attempt -= 1; // a re-authentication is not a retry of a transient failure
          continue;
        }
        if (!err.retryable || attempt >= maxAttempts) {
          throw new HubSpotError(err.kind, err.message, { ...err.details, attempts: attempt });
        }
        const delayMs = err.details.retryAfterMs ?? backoffDelayMs(attempt, this.random);
        this.logger?.warn('HubSpot request failed; retrying', {
          kind: err.kind,
          status: err.details.status,
          policyName: err.details.policyName,
          correlationId: err.details.correlationId,
          path: req.path,
          attempt,
          delayMs,
        });
        await this.sleep(delayMs);
      }
    }
  }

  private async attempt<T>(
    req: HubSpotRequest,
    schema: z.ZodType<T>,
    tenantKey: string,
    token: Secret,
  ): Promise<T> {
    await this.limiter.acquire(tenantKey);
    let response: Response;
    try {
      response = await this.fetchFn(this.url(req), {
        method: req.method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token.reveal()}`,
          ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new HubSpotError(
        timedOut ? 'timeout' : 'network',
        timedOut
          ? `HubSpot request timed out after ${this.config.timeoutMs} ms`
          : 'HubSpot request failed before a response was received',
        { path: req.path },
      );
    }

    const text = await this.readBody(response, req.path);
    if (!response.ok) throw this.classify(response, text, req.path);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HubSpotError('invalid_payload', 'HubSpot returned a response that is not JSON', {
        status: response.status,
        path: req.path,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Issue paths and messages only: never echo payload values (may be personal data).
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new HubSpotError('invalid_payload', `Unexpected HubSpot response shape: ${issues}`, {
        status: response.status,
        path: req.path,
      });
    }
    return parsed.data;
  }

  private async readBody(response: Response, path: string): Promise<string> {
    try {
      return await response.text();
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new HubSpotError(
        timedOut ? 'timeout' : 'network',
        'HubSpot response body could not be read',
        {
          status: response.status,
          path,
        },
      );
    }
  }

  private classify(response: Response, text: string, path: string): HubSpotError {
    const status = response.status;
    let body: ReturnType<typeof HsErrorBodySchema.parse> = {};
    try {
      const parsed = HsErrorBodySchema.safeParse(JSON.parse(text));
      if (parsed.success) body = parsed.data;
    } catch {
      // Non-JSON error bodies (proxies, load balancers) are classified by status alone.
    }
    const kind: HubSpotErrorKind =
      STATUS_KIND[status] ?? (status >= 500 ? 'server_error' : 'bad_request');
    const requiredScopes = body.errors?.flatMap((e) => e.context?.requiredGranularScopes ?? []);
    const retryAfterMs =
      kind === 'rate_limited' || kind === 'server_error'
        ? parseRetryAfterMs(response.headers.get('retry-after'), this.now)
        : undefined;
    return new HubSpotError(
      kind,
      `HubSpot returned ${status}${body.category ? ` (${body.category})` : ''}`,
      {
        status,
        path,
        ...(body.category ? { category: body.category } : {}),
        ...(body.correlationId ? { correlationId: body.correlationId } : {}),
        ...(body.policyName ? { policyName: body.policyName } : {}),
        ...(requiredScopes?.length ? { requiredScopes: [...new Set(requiredScopes)] } : {}),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }

  private url(req: HubSpotRequest): string {
    const url = new URL(this.config.baseUrl + req.path);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, typeof value === 'string' ? value : value.join(','));
    }
    return url.toString();
  }
}

async function resolveToken(auth: HubSpotAuth): Promise<Secret> {
  return typeof auth.token === 'function' ? await auth.token() : auth.token;
}
