import { describe, expect, it } from 'vitest';
import { ids } from '../../../test/fixtures/domain';
import { InvalidTenantContextError, TenantInactiveError } from './errors';
import { TenantSlugSchema } from './tenant';
import {
  assertTenantContext,
  isTenantContext,
  issueTenantContext,
  TenantContext,
} from './tenant-context';

const tenant = {
  id: ids.tenant,
  slug: TenantSlugSchema.parse('juniper'),
  status: 'active' as const,
};

describe('TenantContext', () => {
  it('is issued for an active tenant and is immutable', () => {
    const ctx = issueTenantContext(tenant);
    expect(ctx).toMatchObject({ tenantId: ids.tenant, tenantSlug: 'juniper' });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(String(ctx)).toBe('TenantContext(juniper)');
    expect(isTenantContext(ctx)).toBe(true);
    expect(() => assertTenantContext(ctx)).not.toThrow();
  });

  it.each(['suspended', 'offboarded'] as const)('is refused for a %s tenant', (status) => {
    expect(() => issueTenantContext({ ...tenant, status })).toThrow(TenantInactiveError);
  });

  it('cannot be constructed directly', () => {
    const Ctor = TenantContext as unknown as new (token: symbol, t: object) => TenantContext;
    expect(() => new Ctor(Symbol('issue-tenant-context'), tenant)).toThrow(
      InvalidTenantContextError,
    );
  });

  it.each([
    ['a plain object', { tenantId: ids.tenant, tenantSlug: 'juniper' }],
    ['an object with the right prototype', Object.create(TenantContext.prototype) as object],
    ['a string id', ids.tenant],
    ['undefined', undefined],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isTenantContext(value)).toBe(false);
    expect(() => assertTenantContext(value)).toThrow(InvalidTenantContextError);
  });
});
