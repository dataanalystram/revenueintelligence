import { Inject, Injectable } from '@nestjs/common';
import { SecretNotFoundError } from '../../../platform/secrets';
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

/** Name of the tenant credential holding the HubSpot app's access token. */
export const HUBSPOT_ACCESS_TOKEN = 'access_token';

export interface VerifiedHubSpotConnection {
  readonly reader: HubSpotReader;
  readonly account: HubSpotAccount;
}

/**
 * Entry point to HubSpot for business code. Everything is tenant-scoped: the
 * tenant's integration settings decide whether HubSpot may be used, and only
 * that tenant's own access token (a SecretProvider reference registered for
 * the tenant) is ever resolved. Rate budgets are per tenant.
 */
@Injectable()
export class HubSpotConnector {
  constructor(
    private readonly tenantConfig: TenantConfigService,
    private readonly credentials: TenantCredentialsService,
    @Inject(HUBSPOT_CONFIG) private readonly config: HubSpotConfig,
    private readonly http: HubSpotHttpClient,
  ) {}

  /**
   * A reader bound to this tenant's HubSpot account. Before returning, it
   * proves the token belongs to the account configured for the tenant
   * (settings.portalId), so a token for the wrong account (e.g. production
   * instead of the test account) is never used.
   */
  async forTenant(ctx: TenantContext): Promise<HubSpotReader> {
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
    let token;
    try {
      token = await this.credentials.resolve(ctx, 'hubspot', HUBSPOT_ACCESS_TOKEN);
    } catch (err) {
      if (err instanceof RecordNotFoundError || err instanceof SecretNotFoundError) {
        throw new HubSpotError(
          'not_configured',
          'No HubSpot access token is configured for this tenant',
        );
      }
      throw err;
    }
    const reader = new HubSpotReader(this.http, this.config, { tenantKey: ctx.tenantId, token });
    const account = await reader.getAccount();
    if (account.portalId !== expected) {
      throw new HubSpotError(
        'account_mismatch',
        `The HubSpot token belongs to account ${account.portalId}, but this tenant is configured for ${expected}`,
      );
    }
    return { reader, account };
  }
}
