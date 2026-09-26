import {
  InvalidReferenceError,
  RecordNotFoundError,
  TenantIsolationViolationError,
  UniqueConstraintError,
} from '../errors';

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  meta?: unknown;
  cause?: unknown;
}

function collect(error: unknown, depth = 0): ErrorLike[] {
  if (!error || typeof error !== 'object' || depth > 5) return [];
  const e = error as ErrorLike;
  const meta = e.meta && typeof e.meta === 'object' ? (e.meta as Record<string, unknown>) : {};
  return [e, ...collect(e.cause, depth + 1), ...collect(meta.driverAdapterError, depth + 1)];
}

function text(error: unknown): string {
  return collect(error)
    .map((e) => (typeof e.message === 'string' ? e.message : ''))
    .join(' | ');
}

function codes(error: unknown): string[] {
  return collect(error).flatMap((e) => (typeof e.code === 'string' ? [e.code] : []));
}

function uniqueTarget(error: unknown): string {
  for (const e of collect(error)) {
    const meta = e.meta as
      | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } }
      | undefined;
    if (Array.isArray(meta?.target)) return meta.target.join(', ');
    const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
    if (Array.isArray(fields)) return fields.join(', ');
  }
  return 'key';
}

/**
 * Translates database errors into tenancy errors so callers never depend on
 * Prisma or PostgreSQL error formats. Unknown errors are rethrown unchanged.
 */
export function translateDatabaseError(error: unknown, entity: string): never {
  const allCodes = codes(error);
  const message = text(error);
  if (allCodes.includes('42501') || /row-level security/i.test(message)) {
    throw new TenantIsolationViolationError();
  }
  if (allCodes.includes('P2002') || allCodes.includes('23505')) {
    throw new UniqueConstraintError(uniqueTarget(error));
  }
  if (allCodes.includes('P2003') || allCodes.includes('23503')) {
    throw new InvalidReferenceError(entity);
  }
  if (allCodes.includes('P2025')) {
    throw new RecordNotFoundError(entity, 'requested');
  }
  throw error;
}
