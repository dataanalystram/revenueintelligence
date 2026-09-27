import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../platform/database';
import { TenantContextService } from '../application/tenant-context.service';
import { TenantInactiveError, TenantNotFoundError } from '../errors';
import type { OAuthSystem } from '../oauth/oauth-grants';
import type { TenantContext } from '../tenant-context';

/** Where an inbound event from an external account belongs (ADR 0011). */
export type AccountRoute =
  | { readonly kind: 'routed'; readonly ctx: TenantContext }
  /** No active tenant holds an OAuth grant for this account. */
  | { readonly kind: 'unknown' }
  /** More than one active tenant holds a grant for this account: never guessed. */
  | { readonly kind: 'ambiguous' };

const ACCOUNT_ID = /^[0-9]{1,20}$/;

/**
 * Maps an external account (HubSpot portal id) to the one tenant it belongs
 * to, before any tenant is known. Only active tenants with an OAuth grant for
 * exactly this account qualify; a tenant with a static token is never a
 * target. Reads go through the database function `app_route_oauth_account`,
 * which sees only non-secret grant columns (see the M5 migration); the app
 * role's row-level security is unchanged.
 */
@Injectable()
export class OAuthAccountRouter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contexts: TenantContextService,
  ) {}

  async route(system: OAuthSystem, accountId: string): Promise<AccountRoute> {
    if (!ACCOUNT_ID.test(accountId)) return { kind: 'unknown' };
    const rows = await this.prisma.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id::text AS tenant_id FROM app_route_oauth_account(${system}, ${accountId})`;
    if (rows.length === 0) return { kind: 'unknown' };
    if (rows.length > 1) return { kind: 'ambiguous' };
    try {
      return { kind: 'routed', ctx: await this.contexts.forTenantId(rows[0]!.tenant_id) };
    } catch (err) {
      // Suspended or removed between the lookup and now.
      if (err instanceof TenantInactiveError || err instanceof TenantNotFoundError) {
        return { kind: 'unknown' };
      }
      throw err;
    }
  }
}
