import type { z } from 'zod';
import type { RevealableSecret } from '../../domain';
import {
  backoffDelayMs,
  parseRetryAfterMs,
  SlidingWindowRateLimiter,
} from '../../../platform/outbound';
import { ChargebeeApiKeySchema, type ChargebeeConnectionConfig } from '../chargebee.config';
import { ChargebeeError } from '../errors';
import { ErrorBodySchema } from './chargebee-schemas';

/**
 * The only endpoints the adapter may call (M9B plan §16): list reads of the
 * four resources it declares. Everything else — invoices, transactions,
 * cards, payment sources, hosted pages, exports, any write — is refused
 * inside the process before a request is built.
 */
export const CHARGEBEE_ALLOWED_PATHS = [
  '/customers',
  '/items',
  '/item_prices',
  '/subscriptions',
] as const;
export type ChargebeePath = (typeof CHARGEBEE_ALLOWED_PATHS)[number];

/** Counts requests by method, so tests (and the live gate) can prove read-only behaviour. */
export interface ChargebeeTransportCounters {
  get: number;
  refused: number;
  /** Highest number of requests in flight at once for this connection (must stay 1). */
  maxInFlight: number;
}

/**
 * Read-only transport guard (M9B plan §16, §20): GET only, allowlisted paths
 * only. Throws before anything is sent.
 */
export function assertReadOnlyChargebeeRequest(req: {
  readonly method: string;
  readonly path: string;
}): void {
  if (!(CHARGEBEE_ALLOWED_PATHS as readonly string[]).includes(req.path)) {
    throw new ChargebeeError(
      'unsupported_endpoint',
      `Refusing ${req.path}: not an allowlisted Chargebee read`,
      { path: req.path },
    );
  }
  if (req.method !== 'GET') {
    throw new ChargebeeError(
      'read_only_violation',
      `Refusing ${String(req.method)} ${req.path}: the Chargebee connector is read-only`,
      { path: req.path },
    );
  }
}

export interface ChargebeeHttpDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly counters?: ChargebeeTransportCounters;
  /** Called once per attempt with the HTTP status or transport failure (metrics). */
  readonly onAttempt?: (outcome: number | 'network' | 'timeout') => void;
  readonly onRetry?: (info: { status?: number; attempt: number; delayMs: number }) => void;
}

/**
 * Per-connection serialisation shared by every adapter instance of one
 * connection in this process: at most ONE request in flight (Chargebee's
 * documented concurrency limit is 50 GET; M9B keeps 1), and one sliding
 * window of `rateLimitPerMinute`.
 */
interface ConnectionGate {
  tail: Promise<void>;
  inFlight: number;
  readonly limiter: SlidingWindowRateLimiter;
}
const GATES = new Map<string, ConnectionGate>();

function gateFor(key: string, perMinute: number, now: () => number): ConnectionGate {
  let gate = GATES.get(key);
  if (!gate) {
    gate = {
      tail: Promise.resolve(),
      inFlight: 0,
      limiter: new SlidingWindowRateLimiter(perMinute, 60_000, now),
    };
    GATES.set(key, gate);
  }
  return gate;
}

/**
 * HTTP transport for one Chargebee connection: HTTP Basic with the read-only
 * API key as username (F1), one request at a time, a per-minute budget,
 * bounded retries honouring `Retry-After` on 429 and 5xx, error
 * classification and Zod validation of every response. The key is resolved
 * through the SecretProvider on demand and never logged.
 */
export class ChargebeeHttpClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  readonly counters: ChargebeeTransportCounters;
  private readonly gate: ConnectionGate;

  constructor(
    private readonly config: ChargebeeConnectionConfig,
    private readonly connectionKey: string,
    private readonly credential: () => Promise<RevealableSecret>,
    private readonly deps: ChargebeeHttpDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.counters = deps.counters ?? { get: 0, refused: 0, maxInFlight: 0 };
    this.gate = gateFor(connectionKey, config.rateLimitPerMinute, this.now);
  }

  /** GET an allowlisted list endpoint with retries and response validation. */
  async get<T>(path: ChargebeePath, query: URLSearchParams, schema: z.ZodType<T>): Promise<T> {
    try {
      assertReadOnlyChargebeeRequest({ method: 'GET', path });
    } catch (err) {
      this.counters.refused += 1;
      throw err;
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.serialised(() => this.attempt(path, query, schema));
      } catch (err) {
        if (!(err instanceof ChargebeeError)) throw err;
        if (!err.retryable || attempt > this.config.maxRetries) {
          throw new ChargebeeError(err.kind, err.message, { ...err.details, attempts: attempt });
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

  /** Runs one request after every earlier request of this connection settled. */
  private async serialised<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.gate.tail;
    let release!: () => void;
    this.gate.tail = new Promise<void>((r) => (release = r));
    await previous;
    try {
      await this.gate.limiter.acquire(this.connectionKey);
      this.gate.inFlight += 1;
      this.counters.maxInFlight = Math.max(this.counters.maxInFlight, this.gate.inFlight);
      return await run();
    } finally {
      this.gate.inFlight -= 1;
      release();
    }
  }

  private url(path: ChargebeePath, query: URLSearchParams): string {
    const origin = this.config.endpoint
      ? new URL(this.config.endpoint).origin
      : `https://${this.config.site}.chargebee.com`;
    const url = new URL(`/api/v2${path}`, origin);
    url.search = query.toString();
    return url.toString();
  }

  private async apiKey(): Promise<string> {
    let raw: string;
    try {
      raw = (await this.credential()).reveal().trim();
    } catch {
      throw new ChargebeeError('not_configured', 'The Chargebee API key is not configured');
    }
    if (!ChargebeeApiKeySchema.safeParse(raw).success) {
      throw new ChargebeeError('not_configured', 'The Chargebee API key has an unexpected shape');
    }
    return raw;
  }

  private async attempt<T>(
    path: ChargebeePath,
    query: URLSearchParams,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const key = await this.apiKey();
    this.counters.get += 1;
    let response: Response;
    try {
      response = await this.fetchFn(this.url(path, query), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      this.deps.onAttempt?.(timedOut ? 'timeout' : 'network');
      throw new ChargebeeError(
        timedOut ? 'timeout' : 'network',
        timedOut
          ? `Chargebee request timed out after ${this.config.timeoutMs} ms`
          : 'Chargebee request failed before a response',
        { path },
      );
    }
    this.deps.onAttempt?.(response.status);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ChargebeeError('network', 'Chargebee response body could not be read', { path });
    }
    if (!response.ok) {
      const body = ErrorBodySchema.safeParse(safeJson(text));
      const apiErrorCode = body.success
        ? (body.data.api_error_code ?? body.data.error_code)
        : undefined;
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), this.now);
      throw new ChargebeeError(
        classify(response.status),
        `Chargebee request failed (${response.status}${apiErrorCode ? ` ${apiErrorCode}` : ''})`,
        {
          status: response.status,
          path,
          ...(apiErrorCode ? { apiErrorCode } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }
    const json = safeJson(text);
    if (json === undefined) {
      throw new ChargebeeError(
        'invalid_payload',
        'Chargebee returned a response that is not JSON',
        {
          status: response.status,
          path,
        },
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Issue paths and messages only: never payload values.
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new ChargebeeError(
        'invalid_payload',
        `Unexpected Chargebee response shape: ${issues}`,
        {
          status: response.status,
          path,
        },
      );
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

function classify(status: number): ChargebeeError['kind'] {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}
