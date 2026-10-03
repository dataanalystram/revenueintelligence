/**
 * Classified failure of an external-system connector (HubSpot today; Sugar
 * and Gainsight later). Business code branches on `kind` and `retryable`, so
 * it never needs a vendor's error class or HTTP details. Messages never
 * contain credentials or record values.
 */
export type ConnectorErrorKind =
  | 'not_configured'
  | 'integration_disabled'
  | 'account_mismatch'
  | 'read_only_violation'
  | 'unsupported_endpoint'
  | 'unauthorized'
  /** The tenant must (re)install the app: no usable OAuth grant is stored. */
  | 'reauthorization_required'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'invalid_payload'
  /** The source's schema no longer matches the published mapping (M8). */
  | 'schema_drift';

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }

  /** Transient failures worth retrying later. Connectors refine this. */
  get retryable(): boolean {
    return this.kind === 'server_error' || this.kind === 'timeout' || this.kind === 'network';
  }
}

export function isConnectorError(err: unknown, kind?: ConnectorErrorKind): err is ConnectorError {
  return err instanceof ConnectorError && (kind === undefined || err.kind === kind);
}
