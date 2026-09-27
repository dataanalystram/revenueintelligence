import type { CrmReader } from '../domain';
import type { TenantContext } from '../tenancy';

/**
 * CRM connector port (ADR 0010). Business code injects `CRM_CONNECTOR` and
 * receives a tenant-bound, read-only `CrmReader`; it never imports a CRM
 * connector module (dependency-cruiser enforces this). The connector module
 * registered at the composition root (HubSpot today) provides the token.
 */
export interface CrmConnector {
  /**
   * A reader bound to this tenant's configured CRM account. Rejects with a
   * ConnectorError when the integration is disabled, not configured, not
   * authorised, or the credentials belong to a different account.
   */
  forTenant(ctx: TenantContext): Promise<CrmReader>;
}

export const CRM_CONNECTOR = Symbol('CRM_CONNECTOR');
