import { Module } from '@nestjs/common';
import { TenantConfigService } from './application/tenant-config.service';
import { TenantContextService } from './application/tenant-context.service';
import { TenantCredentialsService } from './application/tenant-credentials.service';
import { TenantRegistryService } from './application/tenant-registry.service';
import { PrismaTenantConfigRepository } from './infrastructure/prisma-tenant-config.repository';
import { PrismaTenantRegistryRepository } from './infrastructure/prisma-tenant-registry.repository';
import { TenantDatabase } from './infrastructure/tenant-database';

@Module({
  providers: [
    TenantDatabase,
    PrismaTenantRegistryRepository,
    PrismaTenantConfigRepository,
    TenantContextService,
    TenantRegistryService,
    TenantConfigService,
    TenantCredentialsService,
  ],
  exports: [
    TenantDatabase,
    TenantContextService,
    TenantRegistryService,
    TenantConfigService,
    TenantCredentialsService,
  ],
})
export class TenancyModule {}
