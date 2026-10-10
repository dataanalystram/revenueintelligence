/**
 * Tenancy: tenant registry, tenant context, tenant-scoped transactions and
 * per-tenant configuration (ADR 0008).
 *
 * Other modules reach tenant data only through `TenantDatabase.transaction`
 * with a `TenantContext`; their repositories receive the resulting
 * `TenantTransaction` and obtain a client with `tenantClient(tx)`.
 */
export { TenantConfigService } from './application/tenant-config.service';
export { TenantContextService } from './application/tenant-context.service';
export { TenantCredentialsService } from './application/tenant-credentials.service';
export {
  TenantRegistryService,
  type ProvisionTenantInput,
} from './application/tenant-registry.service';
export * from './config/credentials';
export * from './config/flows';
export * from './config/integrations';
export * from './config/lead-source-mappings';
export * from './config/policies';
export * from './config/products';
export * from './config/qualification';
export * from './config/template';
export * from './errors';
export { translateDatabaseError } from './infrastructure/prisma-errors';
export {
  TenantDatabase,
  tenantAdvisoryLock,
  tenantClient,
  type TenantTransaction,
} from './infrastructure/tenant-database';
export {
  OAUTH_GRANT_LOCKED_TRANSACTION_MS,
  OAUTH_GRANT_LOCK_WAIT_MS,
  OAUTH_GRANT_SAVE_MARGIN_MS,
} from './infrastructure/encrypted-oauth-grant.store';
export * from './oauth/oauth-grants';
export { OAuthAccountRouter, type AccountRoute } from './infrastructure/oauth-account-router';
export {
  OAUTH_STATE_TTL_MS,
  OAuthStateError,
  OAuthStateService,
  type OAuthStateFailure,
} from './oauth/oauth-state.service';
export { TenancyModule } from './tenancy.module';
export * from './tenant';
export { assertTenantContext, isTenantContext, TenantContext } from './tenant-context';
export * from './security';
