import type { TenantId } from '../domain';
import { InvalidTenantContextError, TenantInactiveError } from './errors';
import type { Tenant, TenantSlug } from './tenant';

/** Module-private token: only issueTenantContext() can construct a context. */
const ISSUE = Symbol('issue-tenant-context');
const issued = new WeakSet<TenantContext>();

/**
 * Proof that the caller is acting for exactly one active tenant.
 *
 * Every tenant-scoped operation requires one. It cannot be created from a
 * plain object or a raw id: contexts are issued only by TenantContextService
 * after the tenant is verified to exist and be active, and every consumer
 * checks the context was genuinely issued (a cast `{ tenantId } as
 * TenantContext` is rejected at runtime).
 */
export class TenantContext {
  readonly tenantId: TenantId;
  readonly tenantSlug: TenantSlug;

  constructor(token: typeof ISSUE, tenant: Pick<Tenant, 'id' | 'slug'>) {
    if (token !== ISSUE) {
      throw new InvalidTenantContextError('contexts are issued by TenantContextService only');
    }
    this.tenantId = tenant.id;
    this.tenantSlug = tenant.slug;
    Object.freeze(this);
  }

  toString(): string {
    return `TenantContext(${this.tenantSlug})`;
  }
}

/** Internal to the tenancy module (not exported from its index). */
export function issueTenantContext(tenant: Pick<Tenant, 'id' | 'slug' | 'status'>): TenantContext {
  if (tenant.status !== 'active') {
    throw new TenantInactiveError(tenant.id, tenant.status);
  }
  const context = new TenantContext(ISSUE, tenant);
  issued.add(context);
  return context;
}

export function isTenantContext(value: unknown): value is TenantContext {
  return value instanceof TenantContext && issued.has(value);
}

export function assertTenantContext(value: unknown): asserts value is TenantContext {
  if (value === undefined || value === null) {
    throw new InvalidTenantContextError('a tenant context is required');
  }
  if (!isTenantContext(value)) {
    throw new InvalidTenantContextError('not an issued TenantContext');
  }
}
