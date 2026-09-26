import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../platform/database';
import type { TenantId } from '../../domain';
import type { Tenant, TenantSlug, TenantStatus } from '../tenant';
import { translateDatabaseError } from './prisma-errors';
import { toTenant } from './tenant-database';

/**
 * Platform-level access to the tenant registry. Runs outside any tenant
 * transaction, where row-level security exposes the `tenants` table but no
 * tenant-owned data.
 */
@Injectable()
export class PrismaTenantRegistryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: TenantId): Promise<Tenant | undefined> {
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row ? toTenant(row) : undefined;
  }

  async findBySlug(slug: TenantSlug): Promise<Tenant | undefined> {
    const row = await this.prisma.tenant.findUnique({ where: { slug } });
    return row ? toTenant(row) : undefined;
  }

  async list(status?: TenantStatus): Promise<Tenant[]> {
    const rows = await this.prisma.tenant.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toTenant);
  }

  async setStatus(id: TenantId, status: TenantStatus): Promise<Tenant | undefined> {
    try {
      const result = await this.prisma.tenant.updateMany({ where: { id }, data: { status } });
      return result.count === 0 ? undefined : this.findById(id);
    } catch (error) {
      translateDatabaseError(error, 'tenant');
    }
  }
}
