import { parseArgs } from 'node:util';
import { HubSpotOAuthService } from '../modules/hubspot';
import {
  TENANT_OAUTH_GRANT_STORE,
  TenantConfigService,
  TenantContextService,
  type TenantOAuthGrantStore,
} from '../modules/tenancy';
import { fail, withHubSpotContext } from './hubspot-context';
import { authorizeOperator } from './operator';

/**
 * Live evidence of HubSpot token refresh behaviour (M5, ADR 0010/0011),
 * printing booleans, timestamps and counts only, never a token:
 *
 *   pnpm --filter @lip/api hubspot:oauth-refresh-evidence --tenant hsoauth            # one real refresh
 *   pnpm --filter @lip/api hubspot:oauth-refresh-evidence --tenant hsoauth --mode expire
 *   pnpm --filter @lip/api hubspot:oauth-refresh-evidence --tenant hsoauth --mode observe
 *
 * - refresh (default): expires the stored access token, then obtains a token
 *   through the normal path (cross-process lock, rotation handling), and
 *   compares the stored grant before and after, in memory.
 * - expire: only marks the stored access token as expired (no HubSpot call).
 * - observe: obtains a token through the normal path and reports whether this
 *   process performed the refresh (run several at once after `expire`: exactly
 *   one should).
 *
 * It never uses a refresh token other than the stored one, so it cannot
 * invalidate the working grant by replaying an old token.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      mode: { type: 'string', default: 'refresh' },
      actor: { type: 'string' },
    },
  });
  const mode = values.mode;
  if (!values.tenant || (mode !== 'refresh' && mode !== 'expire' && mode !== 'observe')) {
    throw new Error(
      'Usage: hubspot:oauth-refresh-evidence --tenant <slug> [--mode refresh|expire|observe]',
    );
  }
  const tenant = values.tenant;
  const result = await withHubSpotContext(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const oauth = app.get(HubSpotOAuthService);
    const grants = app.get<TenantOAuthGrantStore>(TENANT_OAUTH_GRANT_STORE);
    const integration = await app.get(TenantConfigService).getIntegration(ctx, 'hubspot');
    const accountId = integration.settings.portalId;
    if (integration.settings.auth !== 'oauth' || !accountId) {
      throw new Error(`Tenant ${tenant} is not configured for HubSpot OAuth`);
    }
    const before = await grants.get(ctx, 'hubspot');
    if (!before) throw new Error(`Tenant ${tenant} has no stored HubSpot grant`);

    // Expiring the stored token changes the grant: an operator must be named (Q1).
    const expireAs = () =>
      authorizeOperator(app, ctx, 'config.integration', {
        actorFlag: values.actor,
        action: 'oauth.grant.store',
        targetKind: 'oauth',
        targetRef: 'hubspot',
      });
    if (mode === 'expire') {
      await oauth.expireStoredAccessToken(await expireAs());
      return { mode, accessTokenExpired: true };
    }
    if (mode === 'refresh') await oauth.expireStoredAccessToken(await expireAs());
    const token = await oauth.accessToken(ctx, accountId);
    const after = (await grants.get(ctx, 'hubspot'))!;
    const outcomes = oauth.refreshOutcomes();
    const last = outcomes.at(-1);
    return {
      mode,
      accountId,
      refreshesPerformedByThisProcess: outcomes.length,
      accessTokenObtained: token.reveal().length > 0,
      accessTokenChanged: before.accessToken?.token.reveal() !== after.accessToken?.token.reveal(),
      accessTokenExpiresAt: after.accessToken?.expiresAt.toISOString() ?? null,
      ...(last
        ? {
            hubspotReturnedRefreshToken: last.refreshTokenReturned,
            hubspotRotatedRefreshToken: last.refreshTokenRotated,
            expiresInSeconds: last.expiresInSeconds,
            grantedScopes: last.scopes,
          }
        : {}),
      storedRefreshTokenChanged: before.refreshToken.reveal() !== after.refreshToken.reveal(),
      storedAccountId: after.accountId,
    };
  });
  process.stdout.write(`${JSON.stringify({ tenant, ...result }, null, 2)}\n`);
}

main().catch(fail);
