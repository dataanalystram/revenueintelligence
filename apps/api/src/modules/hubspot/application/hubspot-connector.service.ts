import { Inject, Injectable } from '@nestjs/common';
import { SecretNotFoundError, type Secret } from '../../../platform/secrets';
import type { CrmConnector } from '../../crm';
import {
  RecordNotFoundError,
  TenantConfigService,
  TenantCredentialsService,
  isEnabled,
  type TenantContext,
} from '../../tenancy';
import { HubSpotError } from '../errors';
import { HUBSPOT_CONFIG, type HubSpotConfig } from '../hubspot.config';
import { HubSpotHttpClient } from '../infrastructure/http-client';
import { HubSpotReader, type HubSpotAccount } from '../infrastructure/hubspot-reader';
import { HubSpotCrmReader } from './hubspot-crm-reader';
import { HubSpotOAuthService } from './hubspot-oauth.service';

/** Name of the tenant credential holding a static HubSpot token (e.g. a Service Key). */
export const HUBSPOT_ACCESS_TOKEN = 'access_token';

export interface VerifiedHubSpotConnection {
  readonly reader: HubSpotCrmReader;
  readonly account: HubSpotAccount;
}

/**
 * HubSpot behind the CrmConnector port (ADR 0009, 0010). Everything is
 * tenant-scoped: the tenant's integration settings decide whether HubSpot may
 * be used and how the connector authenticates:
 *
 * - `static_token` (default): only the tenant's own `hubspot.access_token`
 *   credential, resolved through the SecretProvider (M3 behaviour, unchanged).
 * - `oauth`: the grant the tenant gave by installing the app; access tokens
 *   are refreshed as needed, once across all processes.
 *
 * Before returning a reader it proves the token belongs to the account
 * configured for the tenant (settings.portalId). Rate budgets are per tenant.
 */
@Injectable()
export class HubSpotConnector implements CrmConnector {
  constructor(
    private readonly tenantConfig: TenantConfigService,
    private readonly credentials: TenantCredentialsService,
    private readonly oauth: HubSpotOAuthService,
    @Inject(HUBSPOT_CONFIG) private readonly config: HubSpotConfig,
    private readonly http: HubSpotHttpClient,
  ) {}

  /** A read-only CrmReader bound to this tenant's verified HubSpot account. */
  async forTenant(ctx: TenantContext): Promise<HubSpotCrmReader> {
    return (await this.connect(ctx)).reader;
  }

  /** forTenant, also returning the verified account details. */
  async connect(ctx: TenantContext): Promise<VerifiedHubSpotConnection> {
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
    const expected = integration.settings.portalId;
    if (!expected) {
      throw new HubSpotError(
        'not_configured',
        'The HubSpot account id (portalId) must be configured for this tenant',
      );
    }
    const hubspot = new HubSpotReader(
      this.http,
      this.config,
      integration.settings.auth === 'oauth'
        ? {
            tenantKey: ctx.tenantId,
            token: await this.oauthTokenProvider(ctx, expected),
            // A 401 means the access token was revoked or replaced (reinstall): drop it, retry once.
            onUnauthorized: (rejected) => this.oauth.invalidate(ctx, rejected),
          }
        : { tenantKey: ctx.tenantId, token: await this.staticToken(ctx) },
    );
    const account = await hubspot.getAccount();
    if (account.portalId !== expected) {
      throw new HubSpotError(
        'account_mismatch',
        `The HubSpot token belongs to account ${account.portalId}, but this tenant is configured for ${expected}`,
      );
    }
    return { reader: new HubSpotCrmReader(hubspot), account };
  }

  private async staticToken(ctx: TenantContext): Promise<Secret> {
    try {
      return await this.credentials.resolve(ctx, 'hubspot', HUBSPOT_ACCESS_TOKEN);
    } catch (err) {
      if (err instanceof RecordNotFoundError || err instanceof SecretNotFoundError) {
        throw new HubSpotError(
          'not_configured',
          'No HubSpot access token is configured for this tenant',
        );
      }
      throw err;
    }
  }

  /**
   * Fetches a token now (so a missing or foreign grant fails before any CRM
   * call), then again per request: a token that expires during a long read
   * is refreshed transparently.
   */
  private async oauthTokenProvider(
    ctx: TenantContext,
    expected: string,
  ): Promise<() => Promise<Secret>> {
    await this.oauth.accessToken(ctx, expected);
    return () => this.oauth.accessToken(ctx, expected);
  }
}
