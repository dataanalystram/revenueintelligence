/** Base class for tenancy errors; `code` is stable for API responses and logs. */
export class TenancyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class TenantNotFoundError extends TenancyError {
  constructor(reference: string) {
    super('tenant_not_found', `Tenant "${reference}" does not exist`);
  }
}

export class TenantInactiveError extends TenancyError {
  constructor(
    readonly tenantId: string,
    readonly status: string,
  ) {
    super('tenant_inactive', `Tenant ${tenantId} is ${status}`);
  }
}

export class DuplicateTenantError extends TenancyError {
  constructor(slug: string) {
    super('tenant_exists', `A tenant with slug "${slug}" already exists`);
  }
}

/** Thrown when code passes something that is not a genuine, issued TenantContext/transaction. */
export class InvalidTenantContextError extends TenancyError {
  constructor(detail: string) {
    super('invalid_tenant_context', `Invalid tenant context: ${detail}`);
  }
}

/** A record's tenant does not match the tenant of the transaction writing it. */
export class TenantMismatchError extends TenancyError {
  constructor(entity: string) {
    super(
      'tenant_mismatch',
      `${entity} belongs to a different tenant than the current transaction`,
    );
  }
}

export class TenantConfigError extends TenancyError {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super('invalid_tenant_config', message);
  }
}

export class RecordNotFoundError extends TenancyError {
  constructor(entity: string, key: string) {
    super('not_found', `${entity} "${key}" was not found`);
  }
}

export class UniqueConstraintError extends TenancyError {
  constructor(readonly target: string) {
    super('conflict', `A record with the same ${target} already exists`);
  }
}

export class InvalidReferenceError extends TenancyError {
  constructor(readonly target: string) {
    super('invalid_reference', `Referenced record does not exist or is still in use (${target})`);
  }
}

export class ConcurrencyConflictError extends TenancyError {
  constructor(entity: string, expectedVersion: number) {
    super(
      'version_conflict',
      `${entity} was modified concurrently (expected version ${expectedVersion})`,
    );
  }
}

/**
 * The database refused a row on row-level-security grounds. Correct code never
 * triggers this; it indicates an attempted cross-tenant write.
 */
export class TenantIsolationViolationError extends TenancyError {
  constructor() {
    super('tenant_isolation_violation', 'The database rejected a cross-tenant write');
  }
}
