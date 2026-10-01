import { ZodError } from 'zod';
import { ConnectorError } from '../domain';
import {
  ConcurrencyConflictError,
  InvalidTenantContextError,
  LockTimeoutError,
  TenantInactiveError,
  TenantIsolationViolationError,
  TenantNotFoundError,
  UniqueConstraintError,
} from '../tenancy';
import { PermanentJobError } from '../../platform/queue';

/** How a processing failure is handled (ADR 0013). Codes are short and value-free. */
export interface FailureInfo {
  readonly permanent: boolean;
  readonly code: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

/** A transient failure with an optional wait hint (read by the queue's backoff). */
export class TransientJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'TransientJobError';
  }
}

const PERMANENT_CONNECTOR: Readonly<Record<string, string>> = {
  not_configured: 'source_not_configured',
  integration_disabled: 'source_not_configured',
  account_mismatch: 'account_mismatch',
  read_only_violation: 'transport_refused',
  unsupported_endpoint: 'transport_refused',
  unauthorized: 'grant_unavailable',
  reauthorization_required: 'grant_unavailable',
  forbidden: 'grant_unavailable',
  bad_request: 'source_bad_request',
  invalid_payload: 'source_invalid_payload',
  not_found: 'source_not_found',
  rate_limited: 'source_daily_limit',
};

function details(err: unknown): { status?: number; retryAfterMs?: number } {
  const d = (err as { details?: { status?: unknown; retryAfterMs?: unknown } }).details;
  return {
    ...(typeof d?.status === 'number' ? { status: d.status } : {}),
    ...(typeof d?.retryAfterMs === 'number' ? { retryAfterMs: d.retryAfterMs } : {}),
  };
}

/** Pure: retryable (transient) versus permanent, with a code for dead letters and metrics. */
export function classifyFailure(err: unknown): FailureInfo {
  if (err instanceof PermanentJobError) {
    const status = (err as { httpStatus?: unknown }).httpStatus;
    return {
      permanent: true,
      code: err.code,
      ...(typeof status === 'number' ? { httpStatus: status } : {}),
    };
  }
  if (err instanceof TransientJobError) {
    return {
      permanent: false,
      code: err.code,
      ...(err.retryAfterMs === undefined ? {} : { retryAfterMs: err.retryAfterMs }),
      ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
    };
  }
  if (err instanceof ZodError) return { permanent: true, code: 'invalid_payload' };
  if (err instanceof TenantNotFoundError) return { permanent: true, code: 'tenant_not_found' };
  if (err instanceof TenantInactiveError) return { permanent: true, code: 'tenant_inactive' };
  if (err instanceof InvalidTenantContextError) return { permanent: true, code: 'invalid_tenant' };
  if (err instanceof TenantIsolationViolationError) {
    return { permanent: true, code: 'isolation_violation' };
  }
  if (err instanceof ConnectorError) {
    const d = details(err);
    if (err.retryable) {
      return {
        permanent: false,
        code: `source_${err.kind}`,
        ...(d.status === undefined ? {} : { httpStatus: d.status }),
        ...(d.retryAfterMs === undefined ? {} : { retryAfterMs: d.retryAfterMs }),
      };
    }
    return {
      permanent: true,
      code: PERMANENT_CONNECTOR[err.kind] ?? `source_${err.kind}`,
      ...(d.status === undefined ? {} : { httpStatus: d.status }),
    };
  }
  if (
    err instanceof LockTimeoutError ||
    err instanceof ConcurrencyConflictError ||
    err instanceof UniqueConstraintError
  ) {
    return { permanent: false, code: 'database_contention' };
  }
  return { permanent: false, code: 'unexpected_error' };
}

/** Re-throws `err` in the form the queue understands (permanent vs transient with hint). */
export function toJobError(err: unknown): Error {
  const info = classifyFailure(err);
  const message = err instanceof Error ? err.message : String(err);
  return info.permanent
    ? Object.assign(new PermanentJobError(info.code, message), { httpStatus: info.httpStatus })
    : new TransientJobError(info.code, message, info.retryAfterMs, info.httpStatus);
}
