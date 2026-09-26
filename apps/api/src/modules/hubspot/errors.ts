/**
 * Classified HubSpot failures. Callers branch on `kind` and `retryable`, never
 * on HTTP details. Messages never contain credentials.
 */
export type HubSpotErrorKind =
  | 'not_configured'
  | 'integration_disabled'
  | 'account_mismatch'
  | 'read_only_violation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'invalid_payload';

export interface HubSpotErrorDetails {
  readonly status?: number;
  /** HubSpot's own error category, e.g. MISSING_SCOPES, OBJECT_NOT_FOUND. */
  readonly category?: string;
  /** HubSpot correlation id, useful when contacting HubSpot support. */
  readonly correlationId?: string;
  /** Scopes HubSpot says the call needs (MISSING_SCOPES responses). */
  readonly requiredScopes?: readonly string[];
  readonly retryAfterMs?: number;
  /** DAILY vs burst (e.g. TEN_SECONDLY_ROLLING) rate-limit policy. */
  readonly policyName?: string;
  readonly attempts?: number;
  /** Request path (no query string, never credentials). */
  readonly path?: string;
}

export class HubSpotError extends Error {
  constructor(
    readonly kind: HubSpotErrorKind,
    message: string,
    readonly details: HubSpotErrorDetails = {},
  ) {
    super(message);
    this.name = 'HubSpotError';
  }

  /**
   * Only transient failures are retried. A daily rate limit will not clear by
   * retrying, and 4xx errors (auth, scopes, not found, bad request) never do.
   */
  get retryable(): boolean {
    if (this.kind === 'rate_limited') return this.details.policyName?.toUpperCase() !== 'DAILY';
    return this.kind === 'server_error' || this.kind === 'timeout' || this.kind === 'network';
  }

  get missingScopes(): boolean {
    return this.kind === 'forbidden' && this.details.category === 'MISSING_SCOPES';
  }
}

export function isHubSpotError(err: unknown, kind?: HubSpotErrorKind): err is HubSpotError {
  return err instanceof HubSpotError && (kind === undefined || err.kind === kind);
}
