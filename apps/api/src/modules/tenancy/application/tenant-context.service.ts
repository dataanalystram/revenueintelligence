import { Injectable } from '@nestjs/common';
import { TenantIdSchema } from '../../domain';
import { InvalidTenantContextError, TenantNotFoundError } from '../errors';
import { PrismaTenantRegistryRepository } from '../infrastructure/prisma-tenant-registry.repository';
import { TenantSlugSchema } from '../tenant';
import { issueTenantContext, type TenantContext } from '../tenant-context';

/**
 * The only issuer of TenantContext. Callers (webhook receivers, queue
 * consumers, admin API) resolve which tenant they act for, then obtain a
 * context here; the tenant must exist and be active.
 */
@Injectable()
export class TenantContextService {
  constructor(private readonly registry: PrismaTenantRegistryRepository) {}

  async forTenantId(tenantId: string): Promise<TenantContext> {
    const parsed = TenantIdSchema.safeParse(tenantId);
    if (!parsed.success) throw new InvalidTenantContextError('malformed tenant id');
    const tenant = await this.registry.findById(parsed.data);
    if (!tenant) throw new TenantNotFoundError(parsed.data);
    return issueTenantContext(tenant);
  }

  async forSlug(slug: string): Promise<TenantContext> {
    const parsed = TenantSlugSchema.safeParse(slug);
    if (!parsed.success) throw new InvalidTenantContextError('malformed tenant slug');
    const tenant = await this.registry.findBySlug(parsed.data);
    if (!tenant) throw new TenantNotFoundError(parsed.data);
    return issueTenantContext(tenant);
  }
}
