import type { Secret } from '../../../platform/secrets';
import type { TenantContext } from '../tenant-context';

/** Systems whose access the platform obtains through an OAuth install. */
export const OAUTH_SYSTEMS = ['hubspot'] as const;
export type OAuthSystem = (typeof OAUTH_SYSTEMS)[number];

/** A short-lived access token and when it stops working. */
export interface OAuthAccessToken {
  readonly token: Secret;
  readonly expiresAt: Date;
}

/** What a tenant granted by installing an app: tokens stay wrapped in Secret. */
export interface OAuthGrant {
  /** The external account the grant belongs to (HubSpot: portal id). */
  readonly accountId: string;
  readonly refreshToken: Secret;
  readonly accessToken: OAuthAccessToken | undefined;
  readonly scopes: readonly string[];
}

/**
 * Where tenants' OAuth grants are kept (ADR 0010). Cloud-neutral: the
 * implementation today encrypts into a tenant-scoped PostgreSQL table; a Key
 * Vault-backed store can replace it without touching callers.
 *
 * Every operation is tenant-scoped; a tenant can never read another tenant's
 * grant. Tokens are only ever handled as Secret and never logged.
 */
export interface TenantOAuthGrantStore {
  get(ctx: TenantContext, system: OAuthSystem): Promise<OAuthGrant | undefined>;
  /** Creates or replaces the tenant's grant for `system`. */
  put(ctx: TenantContext, system: OAuthSystem, grant: OAuthGrant): Promise<void>;
  delete(ctx: TenantContext, system: OAuthSystem): Promise<boolean>;
  /**
   * Runs `work` holding this tenant's exclusive lock for the grant, across
   * every process and instance (a PostgreSQL advisory lock), and saves the
   * grant it returns in the same transaction. Used to refresh tokens exactly
   * once: a waiting caller sees the grant the previous holder saved.
   */
  withLockedGrant<T>(
    ctx: TenantContext,
    system: OAuthSystem,
    work: (current: OAuthGrant | undefined) => Promise<{ save?: OAuthGrant; result: T }>,
  ): Promise<T>;
}

export const TENANT_OAUTH_GRANT_STORE = Symbol('TENANT_OAUTH_GRANT_STORE');
