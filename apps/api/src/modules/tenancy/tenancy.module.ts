import { Module } from '@nestjs/common';
import { TenantConfigService } from './application/tenant-config.service';
import { TenantContextService } from './application/tenant-context.service';
import { TenantCredentialsService } from './application/tenant-credentials.service';
import { TenantRegistryService } from './application/tenant-registry.service';
import { PrismaTenantConfigRepository } from './infrastructure/prisma-tenant-config.repository';
import { PrismaTenantRegistryRepository } from './infrastructure/prisma-tenant-registry.repository';
import { EncryptedDatabaseOAuthGrantStore } from './infrastructure/encrypted-oauth-grant.store';
import { TenantDatabase } from './infrastructure/tenant-database';
import { TENANT_OAUTH_GRANT_STORE } from './oauth/oauth-grants';
import { OAuthStateService } from './oauth/oauth-state.service';

@Module({
  providers: [
    TenantDatabase,
    PrismaTenantRegistryRepository,
    PrismaTenantConfigRepository,
    TenantContextService,
    TenantRegistryService,
    TenantConfigService,
    TenantCredentialsService,
    OAuthStateService,
    { provide: TENANT_OAUTH_GRANT_STORE, useClass: EncryptedDatabaseOAuthGrantStore },
  ],
  exports: [
    TenantDatabase,
    TenantContextService,
    TenantRegistryService,
    TenantConfigService,
    TenantCredentialsService,
    OAuthStateService,
    TENANT_OAUTH_GRANT_STORE,
  ],
})
export class TenancyModule {}
