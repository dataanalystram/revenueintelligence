import { ConnectorError, type ConnectorErrorKind } from '../domain';

export interface SugarErrorDetails {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly attempts?: number;
  /** Request path without query string (never credentials or values). */
  readonly path?: string;
}

/** A ConnectorError with Sugar diagnostics; business code needs only ConnectorError. */
export class SugarError extends ConnectorError {
  constructor(
    kind: ConnectorErrorKind,
    message: string,
    readonly details: SugarErrorDetails = {},
  ) {
    super(kind, message);
    this.name = 'SugarError';
  }

  /** 429, 5xx, timeouts and network failures are transient; other 4xx never are. */
  override get retryable(): boolean {
    return (
      this.kind === 'rate_limited' ||
      this.kind === 'server_error' ||
      this.kind === 'timeout' ||
      this.kind === 'network'
    );
  }
}
