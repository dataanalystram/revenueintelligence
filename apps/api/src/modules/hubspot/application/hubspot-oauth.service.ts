import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TokenDecryptionError, TokenKeyError } from '../../../platform/crypto';
import { SECRET_PROVIDER, Secret, type SecretProvider } from '../../../platform/secrets';
import { systemActor } from '../../domain';
import {
  assertAuthorized,
  AuditTrail,
  TenantDatabase,
  WriteAuthorizer,
  type AuthorizedContext,
  OAuthStateError,
  OAuthStateService,
  RecordNotFoundError,
  TENANT_OAUTH_GRANT_STORE,
  TenantConfigService,
  isEnabled,
  type OAuthGrant,
  type TenantContext,
  type TenantOAuthGrantStore,
} from '../../tenancy';
import { HubSpotError, isHubSpotError } from '../errors';
import { HUBSPOT_CONFIG, type HubSpotConfig } from '../hubspot.config';
import { HUBSPOT_OAUTH_SCOPES, HubSpotOAuthClient } from '../infrastructure/oauth-client';
import { AuditFailures } from '../../tenancy';

/** SecretProvider key of the app's client secret (env: HUBSPOT_APP_CLIENT_SECRET). */
export const HUBSPOT_APP_CLIENT_SECRET = 'hubspot.app.client_secret';

/**
 * HubSpot's OAuth consent URL for a deployed projects app:
 * `https://<uiDomain>/oauth/authorize?client_id&redirect_uri&scope&state`,
 * the form HubSpot generates on the app's page. `uiDomain` is the account's
 * web host (region); `testAuthorizeBaseUrl` replaces `https://<uiDomain>/oauth`
 * for a loopback fake only (validated in HubSpotEnvSchema). Scopes are always
 * exactly HUBSPOT_OAUTH_SCOPES: baseline `oauth` plus CRM read scopes.
 */
export function hubspotConsentUrl(input: {
  uiDomain: string;
  testAuthorizeBaseUrl: string | undefined;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const base = input.testAuthorizeBaseUrl ?? `https://${input.uiDomain}/oauth`;
  const url = new URL(`${base}/authorize`);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', HUBSPOT_OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', input.state);
  return url.toString();
}

/** HubSpot's web host when the tenant's account region is not configured (as HubSpot's CLI). */
export const DEFAULT_HUBSPOT_UI_DOMAIN = 'app.hubspot.com';

/** An access token is treated as expired this long before HubSpot's expiry. */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

interface CachedToken {
  readonly token: Secret;
  readonly expiresAt: Date;
  readonly accountId: string;
}

/** What HubSpot returned on one refresh: no token, only facts about it. */
export interface RefreshOutcome {
  readonly at: Date;
  /** HubSpot included a refresh_token in the refresh response. */
  readonly refreshTokenReturned: boolean;
  /** The returned refresh token differs from the one used (rotation). */
  readonly refreshTokenRotated: boolean;
  readonly expiresInSeconds: number;
  readonly scopes: readonly string[];
}

export interface CompletedInstall {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly accountId: string;
}

/**
 * HubSpot OAuth for projects-based app installs (ADR 0010).
 *
 * - `installUrl`: a consent URL for the tenant's configured account, carrying
 *   a single-use signed state.
 * - `completeInstall`: the callback. It redeems the state (tenant binding,
 *   replay protection), exchanges the code, requires the granted account to be
 *   the tenant's configured portalId, and only then stores the grant
 *   (encrypted).
 * - `accessToken`: the OAuth token source. The access token is shared by all
 *   processes through the encrypted grant store; when it expires, exactly one
 *   process refreshes it, under a PostgreSQL advisory lock, and the others
 *   reuse the result.
 */
@Injectable()
export class HubSpotOAuthService {
  private readonly logger = new Logger(HubSpotOAuthService.name);
  private readonly cache = new Map<string, CachedToken>();
  /** One pending refresh per tenant in this process (the advisory lock covers other processes). */
  private readonly inflight = new Map<string, Promise<CachedToken>>();
  /**
   * SHA-256 digest of the access token HubSpot last rejected with 401 (revoked,
   * or replaced by a reinstall), per tenant. A digest, so the token itself is
   * never held outside a redacting Secret. Memory only.
   */
  private readonly rejected = new Map<string, string>();
  /** Refreshes this process performed at HubSpot (memory only, no tokens). */
  private readonly refreshes: RefreshOutcome[] = [];

  constructor(
    private readonly tenantConfig: TenantConfigService,
    private readonly states: OAuthStateService,
    @Inject(TENANT_OAUTH_GRANT_STORE) private readonly grants: TenantOAuthGrantStore,
    @Inject(SECRET_PROVIDER) private readonly secrets: SecretProvider,
    @Inject(HUBSPOT_CONFIG) private readonly config: HubSpotConfig,
    private readonly client: HubSpotOAuthClient,
    private readonly authorizer: WriteAuthorizer,
    private readonly audit: AuditTrail,
    private readonly db: TenantDatabase,
  ) {}

  /**
   * The consent URL an admin opens to install the app for this tenant:
   * `https://<account's HubSpot host>/oauth/authorize`, the form HubSpot itself
   * generates for a deployed projects app. The host follows the account's
   * data-hosting region (tenant setting `uiDomain`; default app.hubspot.com).
   * Which account the admin picks is enforced after the code exchange
   * (`completeInstall`: hub_id must equal the tenant's portalId).
   */
  @AuditFailures('oauth.install_state.issue', 'oauth')
  async installUrl(
    actx: AuthorizedContext<'config.oauth.install'>,
  ): Promise<{ url: string; expiresAt: Date }> {
    assertAuthorized(actx, 'config.oauth.install');
    const ctx = actx.tenant;
    const { uiDomain } = await this.oauthSettings(ctx);
    const app = await this.app();
    const { state, expiresAt } = await this.guarded(() => this.states.issue(ctx, 'hubspot'));
    // The state itself is a bearer value: only the fact of issuing it is audited.
    await this.db.transaction(ctx, (tx) =>
      this.audit.record(tx, actx, {
        action: 'oauth.install_state.issue',
        targetKind: 'oauth',
        targetRef: 'hubspot',
      }),
    );
    const url = hubspotConsentUrl({
      uiDomain,
      testAuthorizeBaseUrl: this.config.oauth.authorizeBaseUrl,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      state,
    });
    return { url, expiresAt };
  }

  /** Handles the OAuth callback. Stores nothing unless every check passes. */
  async completeInstall(input: { code: string; state: string }): Promise<CompletedInstall> {
    // First: the state is consumed whatever happens next, so it can never be replayed.
    const ctx = await this.guarded(() => this.states.redeem(input.state, 'hubspot'));
    const portalId = await this.oauthPortalId(ctx);
    const app = await this.app();
    const tokens = await this.client.exchangeCode({
      code: new Secret(input.code),
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      redirectUri: app.redirectUri,
    });
    if (tokens.accountId !== portalId) {
      // Refused: nothing is stored, and the grant HubSpot just issued is given back.
      const revoked = await this.revokeRefusedGrant(tokens.refreshToken, app);
      throw new HubSpotError(
        'account_mismatch',
        `The app was installed in HubSpot account ${tokens.accountId ?? 'unknown'}, but this tenant is configured for ${portalId}; nothing was stored and the grant was ${revoked ? 'revoked' : 'NOT revoked'}`,
      );
    }
    if (!tokens.refreshToken) {
      throw new HubSpotError(
        'invalid_payload',
        'HubSpot returned no refresh token; nothing was stored',
      );
    }
    const grant: OAuthGrant = {
      accountId: portalId,
      refreshToken: tokens.refreshToken,
      accessToken: { token: tokens.accessToken, expiresAt: this.expiry(tokens.expiresInSeconds) },
      scopes: tokens.scopes,
    };
    // The callback proved the state (single use, signed): the platform stores the grant as itself.
    const actx = await this.authorizer.authorize(
      ctx,
      systemActor('api:oauth-callback'),
      'config.oauth.grant',
      { action: 'oauth.grant.store', targetKind: 'oauth', targetRef: 'hubspot' },
    );
    await this.guarded(() =>
      this.grants.put(ctx, 'hubspot', grant, (tx) =>
        this.audit.record(tx, actx, {
          action: 'oauth.grant.store',
          targetKind: 'oauth',
          targetRef: 'hubspot',
          details: { accountId: portalId, scopes: tokens.scopes.length },
        }),
      ),
    );
    this.cache.delete(ctx.tenantId);
    this.rejected.delete(ctx.tenantId);
    this.logger.log({ msg: 'HubSpot app installed', tenantId: ctx.tenantId, accountId: portalId });
    return { tenantId: ctx.tenantId, tenantSlug: ctx.tenantSlug, accountId: portalId };
  }

  /**
   * The one approved non-read call (ADR 0011): revokes the refresh token of a
   * grant `completeInstall` has just refused because HubSpot issued it for a
   * different account. The grant was never stored and is not usable by the
   * platform; revoking it means it does not stay valid at HubSpot either.
   * Best effort: a failure is logged (never the token) and reported in the
   * refusal, and the install is refused either way.
   */
  private async revokeRefusedGrant(
    refreshToken: Secret | undefined,
    app: { clientId: string; clientSecret: Secret },
  ): Promise<boolean> {
    if (!refreshToken) return false;
    try {
      await this.client.revokeRefreshToken({
        refreshToken,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
      });
      this.logger.warn({ msg: 'Refused HubSpot grant for another account revoked', revoked: true });
      return true;
    } catch (err) {
      if (!isHubSpotError(err)) throw err;
      this.logger.warn({
        msg: 'Refused HubSpot grant for another account could NOT be revoked',
        revoked: false,
        kind: err.kind,
        status: err.details.status,
      });
      return false;
    }
  }

  /**
   * A valid access token for this tenant's grant on `expectedAccountId`.
   * Order: this process's cache → the shared (encrypted) token → one refresh
   * under the tenant's cross-process lock.
   */
  async accessToken(ctx: TenantContext, expectedAccountId: string): Promise<Secret> {
    const cached = this.cache.get(ctx.tenantId);
    if (
      cached &&
      cached.accountId === expectedAccountId &&
      this.fresh(cached.expiresAt) &&
      !this.isRejected(ctx, cached.token)
    ) {
      return cached.token;
    }
    const stored = await this.guarded(() => this.grants.get(ctx, 'hubspot'));
    const valid = this.usable(ctx, stored, expectedAccountId);
    if (valid) return this.remember(ctx, valid);

    // Concurrent callers in this process share one refresh, so they never hold
    // one pooled connection each while waiting for the advisory lock.
    let pending = this.inflight.get(ctx.tenantId);
    if (!pending) {
      pending = this.refreshUnderLock(ctx, expectedAccountId).finally(() =>
        this.inflight.delete(ctx.tenantId),
      );
      this.inflight.set(ctx.tenantId, pending);
    }
    return this.remember(ctx, await pending);
  }

  /**
   * HubSpot rejected this access token (401): it was revoked, or the app was
   * reinstalled and a new grant stored by another process. Forget it, so the
   * next `accessToken` reads the stored grant again and refreshes if the stored
   * access token is this same rejected one.
   */
  invalidate(ctx: TenantContext, rejected: Secret): void {
    const cached = this.cache.get(ctx.tenantId);
    if (cached && cached.token.reveal() === rejected.reveal()) this.cache.delete(ctx.tenantId);
    this.rejected.set(ctx.tenantId, digest(rejected));
  }

  private async refreshUnderLock(
    ctx: TenantContext,
    expectedAccountId: string,
  ): Promise<CachedToken> {
    // M10A1 (plan §4): a refresh rewrites the stored grant, so the platform's own
    // system actor is authorized for config.oauth.grant and the save is audited.
    const actx = await this.authorizer.authorize(
      ctx,
      systemActor('oauth-refresh'),
      'config.oauth.grant',
      { action: 'oauth.grant.refresh', targetKind: 'oauth', targetRef: 'hubspot' },
    );
    let rotated = false;
    const refreshed = await this.guarded(() =>
      this.grants.withLockedGrant(
        ctx,
        'hubspot',
        async (current) => {
          // Another process may have refreshed while this one waited for the lock.
          const nowValid = this.usable(ctx, current, expectedAccountId);
          if (nowValid) return { result: nowValid };
          const grant = current!;
          const app = await this.app();
          const tokens = await this.client.refresh({
            refreshToken: grant.refreshToken,
            clientId: app.clientId,
            clientSecret: app.clientSecret,
          });
          if (tokens.accountId !== undefined && tokens.accountId !== grant.accountId) {
            throw new HubSpotError(
              'account_mismatch',
              'HubSpot refreshed a token for a different account',
            );
          }
          const outcome: RefreshOutcome = {
            at: new Date(),
            refreshTokenReturned: tokens.refreshToken !== undefined,
            refreshTokenRotated:
              tokens.refreshToken !== undefined &&
              tokens.refreshToken.reveal() !== grant.refreshToken.reveal(),
            expiresInSeconds: tokens.expiresInSeconds,
            scopes: tokens.scopes,
          };
          this.refreshes.push(outcome);
          rotated = outcome.refreshTokenRotated;
          this.logger.log({
            msg: 'HubSpot access token refreshed',
            tenantId: ctx.tenantId,
            refreshTokenReturned: outcome.refreshTokenReturned,
            refreshTokenRotated: outcome.refreshTokenRotated,
            expiresInSeconds: outcome.expiresInSeconds,
          });
          const next: OAuthGrant = {
            accountId: grant.accountId,
            // HubSpot may rotate the refresh token; keep the newest one.
            refreshToken: tokens.refreshToken ?? grant.refreshToken,
            accessToken: {
              token: tokens.accessToken,
              expiresAt: this.expiry(tokens.expiresInSeconds),
            },
            scopes: tokens.scopes.length ? tokens.scopes : grant.scopes,
          };
          return {
            save: next,
            result: {
              token: next.accessToken!.token,
              expiresAt: next.accessToken!.expiresAt,
              accountId: next.accountId,
            },
          };
        },
        (tx) =>
          this.audit.record(tx, actx, {
            action: 'oauth.grant.refresh',
            targetKind: 'oauth',
            targetRef: 'hubspot',
            details: { rotated },
          }),
      ),
    );
    // Clear the mark only when the refresh produced a different token: a
    // pending refresh that read the grant before a concurrent 401 may return
    // the very token that was just rejected.
    if (!this.isRejected(ctx, refreshed.token)) this.rejected.delete(ctx.tenantId);
    return refreshed;
  }

  /**
   * Refreshes this process performed at HubSpot, newest last: booleans and
   * counts only, never a token. Evidence for operators (refresh rotation).
   */
  refreshOutcomes(): readonly RefreshOutcome[] {
    return [...this.refreshes];
  }

  /**
   * Operator hook (live refresh evidence): marks the tenant's stored access
   * token as expired, under the grant lock, so the next `accessToken` performs
   * a real refresh. The refresh token is not touched; nothing is sent to
   * HubSpot here. Returns false when the tenant has no grant.
   */
  @AuditFailures('oauth.grant.store', 'oauth')
  async expireStoredAccessToken(actx: AuthorizedContext<'config.integration'>): Promise<boolean> {
    assertAuthorized(actx, 'config.integration');
    const ctx = actx.tenant;
    const expired = await this.guarded(() =>
      this.grants.withLockedGrant(
        ctx,
        'hubspot',
        (current) => {
          if (!current?.accessToken) return Promise.resolve({ result: current !== undefined });
          return Promise.resolve({
            save: {
              ...current,
              accessToken: { ...current.accessToken, expiresAt: new Date(Date.now() - 60_000) },
            },
            result: true,
          });
        },
        (tx) =>
          this.audit.record(tx, actx, {
            action: 'oauth.grant.store',
            targetKind: 'oauth',
            targetRef: 'hubspot',
            details: { operation: 'expire_access' },
          }),
      ),
    );
    this.cache.delete(ctx.tenantId);
    return expired;
  }

  /** Test and operator hook: forget this process's cached access tokens. */
  clearCache(): void {
    this.cache.clear();
    this.rejected.clear();
  }

  /**
   * A stored grant's access token if it belongs to the expected account, is
   * still fresh and was not rejected by HubSpot.
   */
  private usable(
    ctx: TenantContext,
    grant: OAuthGrant | undefined,
    expectedAccountId: string,
  ): CachedToken | undefined {
    if (!grant) {
      throw new HubSpotError(
        'reauthorization_required',
        'No HubSpot app installation is stored for this tenant; install the app first',
      );
    }
    if (grant.accountId !== expectedAccountId) {
      throw new HubSpotError(
        'account_mismatch',
        `The stored HubSpot grant is for account ${grant.accountId}, but this tenant is configured for ${expectedAccountId}`,
      );
    }
    const access = grant.accessToken;
    if (access && this.fresh(access.expiresAt) && !this.isRejected(ctx, access.token)) {
      return { token: access.token, expiresAt: access.expiresAt, accountId: grant.accountId };
    }
    return undefined;
  }

  private isRejected(ctx: TenantContext, token: Secret): boolean {
    return this.rejected.get(ctx.tenantId) === digest(token);
  }

  private remember(ctx: TenantContext, token: CachedToken): Secret {
    if (!this.isRejected(ctx, token.token)) this.cache.set(ctx.tenantId, token);
    return token.token;
  }

  private fresh(expiresAt: Date): boolean {
    return expiresAt.getTime() - Date.now() > ACCESS_TOKEN_SKEW_MS;
  }

  private expiry(expiresInSeconds: number): Date {
    return new Date(Date.now() + expiresInSeconds * 1000);
  }

  /** The tenant's HubSpot account id, requiring an enabled integration in OAuth mode. */
  private async oauthPortalId(ctx: TenantContext): Promise<string> {
    return (await this.oauthSettings(ctx)).portalId;
  }

  /** Account id and web host of the tenant's HubSpot account (enabled, OAuth mode). */
  private async oauthSettings(ctx: TenantContext): Promise<{ portalId: string; uiDomain: string }> {
    let integration;
    try {
      integration = await this.tenantConfig.getIntegration(ctx, 'hubspot');
    } catch (err) {
      if (err instanceof RecordNotFoundError) {
        throw new HubSpotError('not_configured', 'HubSpot is not configured for this tenant');
      }
      throw err;
    }
    if (!isEnabled(integration)) {
      throw new HubSpotError('integration_disabled', 'HubSpot is disabled for this tenant');
    }
    if (integration.settings.auth !== 'oauth') {
      throw new HubSpotError(
        'not_configured',
        'This tenant does not use HubSpot OAuth (settings.auth)',
      );
    }
    if (!integration.settings.portalId) {
      throw new HubSpotError(
        'not_configured',
        'The HubSpot account id (portalId) must be configured first',
      );
    }
    return {
      portalId: integration.settings.portalId,
      uiDomain: integration.settings.uiDomain ?? DEFAULT_HUBSPOT_UI_DOMAIN,
    };
  }

  private async app(): Promise<{ clientId: string; clientSecret: Secret; redirectUri: string }> {
    const { clientId, redirectUri } = this.config.oauth;
    const clientSecret = await this.secrets.find(HUBSPOT_APP_CLIENT_SECRET);
    if (!clientId || !redirectUri || !clientSecret) {
      throw new HubSpotError(
        'not_configured',
        'The HubSpot app is not configured (HUBSPOT_APP_CLIENT_ID, HUBSPOT_APP_CLIENT_SECRET, HUBSPOT_APP_REDIRECT_URI)',
      );
    }
    return { clientId, clientSecret, redirectUri };
  }

  /** Maps storage and state failures to connector errors with safe messages. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof TokenKeyError) {
        throw new HubSpotError('not_configured', `${err.message} (PLATFORM_TOKEN_ENCRYPTION_KEY)`);
      }
      if (err instanceof TokenDecryptionError) {
        throw new HubSpotError(
          'not_configured',
          'The stored HubSpot grant could not be decrypted (wrong PLATFORM_TOKEN_ENCRYPTION_KEY or altered data)',
        );
      }
      if (err instanceof OAuthStateError) {
        throw new HubSpotError('bad_request', err.message, {
          category: `oauth_state_${err.reason}`,
        });
      }
      throw err;
    }
  }
}

function digest(token: Secret): string {
  return createHash('sha256').update(token.reveal(), 'utf8').digest('hex');
}
