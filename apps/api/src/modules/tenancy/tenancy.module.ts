import { Module } from '@nestjs/common';
import { TenantConfigService } from './application/tenant-config.service';
import { TenantContextService } from './application/tenant-context.service';
import { TenantCredentialsService } from './application/tenant-credentials.service';
import { TenantRegistryService } from './application/tenant-registry.service';
import { PrismaTenantConfigRepository } from './infrastructure/prisma-tenant-config.repository';
import { PrismaTenantRegistryRepository } from './infrastructure/prisma-tenant-registry.repository';
import { EncryptedDatabaseOAuthGrantStore } from './infrastructure/encrypted-oauth-grant.store';
import { OAuthAccountRouter } from './infrastructure/oauth-account-router';
import { TenantDatabase } from './infrastructure/tenant-database';
import { TENANT_OAUTH_GRANT_STORE } from './oauth/oauth-grants';
import { OAuthStateService } from './oauth/oauth-state.service';
import { AuditTrail } from './security/audit-trail';
import { SecurityEventsService } from './security/security-events.service';
import { SecurityOperationsService } from './security/security-operations.service';
import { WriteAuthorizer } from './security/write-authorizer.service';

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
    OAuthAccountRouter,
    EncryptedDatabaseOAuthGrantStore,
    { provide: TENANT_OAUTH_GRANT_STORE, useExisting: EncryptedDatabaseOAuthGrantStore },
    AuditTrail,
    SecurityEventsService,
    WriteAuthorizer,
    SecurityOperationsService,
  ],
  exports: [
    TenantDatabase,
    TenantContextService,
    TenantRegistryService,
    TenantConfigService,
    TenantCredentialsService,
    OAuthStateService,
    OAuthAccountRouter,
    TENANT_OAUTH_GRANT_STORE,
    AuditTrail,
    SecurityEventsService,
    WriteAuthorizer,
    SecurityOperationsService,
  ],
})
export class TenancyModule {}
