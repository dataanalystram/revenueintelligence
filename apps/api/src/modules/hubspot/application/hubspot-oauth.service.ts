import { Inject, Injectable, Logger } from '@nestjs/common';
import { TokenDecryptionError, TokenKeyError } from '../../../platform/crypto';
import { SECRET_PROVIDER, Secret, type SecretProvider } from '../../../platform/secrets';
import {
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
import { HubSpotError } from '../errors';
import { HUBSPOT_CONFIG, type HubSpotConfig } from '../hubspot.config';
import { HUBSPOT_OAUTH_SCOPES, HubSpotOAuthClient } from '../infrastructure/oauth-client';

/** SecretProvider key of the app's client secret (env: HUBSPOT_APP_CLIENT_SECRET). */
export const HUBSPOT_APP_CLIENT_SECRET = 'hubspot.app.client_secret';

/** An access token is treated as expired this long before HubSpot's expiry. */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

interface CachedToken {
  readonly token: Secret;
  readonly expiresAt: Date;
  readonly accountId: string;
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

  constructor(
    private readonly tenantConfig: TenantConfigService,
    private readonly states: OAuthStateService,
    @Inject(TENANT_OAUTH_GRANT_STORE) private readonly grants: TenantOAuthGrantStore,
    @Inject(SECRET_PROVIDER) private readonly secrets: SecretProvider,
    @Inject(HUBSPOT_CONFIG) private readonly config: HubSpotConfig,
    private readonly client: HubSpotOAuthClient,
  ) {}

  /** The consent URL an admin opens to install the app for this tenant. */
  async installUrl(ctx: TenantContext): Promise<{ url: string; expiresAt: Date }> {
    const portalId = await this.oauthPortalId(ctx);
    const app = await this.app();
    const { state, expiresAt } = await this.guarded(() => this.states.issue(ctx, 'hubspot'));
    const url = new URL(`${this.config.oauth.authorizeBaseUrl}/${portalId}/authorize`);
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('redirect_uri', app.redirectUri);
    url.searchParams.set('scope', HUBSPOT_OAUTH_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return { url: url.toString(), expiresAt };
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
      throw new HubSpotError(
        'account_mismatch',
        `The app was installed in HubSpot account ${tokens.accountId ?? 'unknown'}, but this tenant is configured for ${portalId}; nothing was stored`,
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
    await this.guarded(() => this.grants.put(ctx, 'hubspot', grant));
    this.cache.delete(ctx.tenantId);
    this.logger.log({ msg: 'HubSpot app installed', tenantId: ctx.tenantId, accountId: portalId });
    return { tenantId: ctx.tenantId, tenantSlug: ctx.tenantSlug, accountId: portalId };
  }

  /**
   * A valid access token for this tenant's grant on `expectedAccountId`.
   * Order: this process's cache → the shared (encrypted) token → one refresh
   * under the tenant's cross-process lock.
   */
  async accessToken(ctx: TenantContext, expectedAccountId: string): Promise<Secret> {
    const cached = this.cache.get(ctx.tenantId);
    if (cached && cached.accountId === expectedAccountId && this.fresh(cached.expiresAt)) {
      return cached.token;
    }
    const stored = await this.guarded(() => this.grants.get(ctx, 'hubspot'));
    const valid = this.usable(stored, expectedAccountId);
    if (valid) return this.remember(ctx, valid);

    const refreshed = await this.guarded(() =>
      this.grants.withLockedGrant(ctx, 'hubspot', async (current) => {
        // Another process may have refreshed while this one waited for the lock.
        const nowValid = this.usable(current, expectedAccountId);
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
      }),
    );
    return this.remember(ctx, refreshed);
  }

  /** Test and operator hook: forget this process's cached access tokens. */
  clearCache(): void {
    this.cache.clear();
  }

  /** A stored grant's access token if it belongs to the expected account and is still fresh. */
  private usable(
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
    if (access && this.fresh(access.expiresAt)) {
      return { token: access.token, expiresAt: access.expiresAt, accountId: grant.accountId };
    }
    return undefined;
  }

  private remember(ctx: TenantContext, token: CachedToken): Secret {
    this.cache.set(ctx.tenantId, token);
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
    return integration.settings.portalId;
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
