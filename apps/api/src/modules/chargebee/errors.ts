import { ConnectorError, type ConnectorErrorKind } from '../domain';

export interface ChargebeeErrorDetails {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly attempts?: number;
  /** Request path without query string (never credentials or values). */
  readonly path?: string;
  /** Chargebee's own error code, when the response carried one (never a value). */
  readonly apiErrorCode?: string;
}

/** A ConnectorError with Chargebee diagnostics; business code needs only ConnectorError. */
export class ChargebeeError extends ConnectorError {
  constructor(
    kind: ConnectorErrorKind,
    message: string,
    readonly details: ChargebeeErrorDetails = {},
  ) {
    super(kind, message);
    this.name = 'ChargebeeError';
  }

  /** 429 (either limit), 5xx, timeouts and network failures are transient; other 4xx never are. */
  override get retryable(): boolean {
    return (
      this.kind === 'rate_limited' ||
      this.kind === 'server_error' ||
      this.kind === 'timeout' ||
      this.kind === 'network'
    );
  }
}
