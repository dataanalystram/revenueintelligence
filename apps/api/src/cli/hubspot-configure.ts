import { parseArgs } from 'node:util';
import { HUBSPOT_ACCESS_TOKEN } from '../modules/hubspot';
import {
  TenantConfigService,
  TenantContextService,
  TenantCredentialsService,
} from '../modules/tenancy';
import { EnvSecretProvider } from '../platform/secrets';
import { fail, withHubSpotContext } from './hubspot-context';

/**
 * Connects a tenant to a HubSpot account, READ-ONLY:
 *
 *   pnpm --filter @lip/api hubspot:configure --tenant hstest --portal-id 12345678
 *   pnpm --filter @lip/api hubspot:configure --tenant juniper --portal-id 12345678 --auth oauth
 *
 * Static token (default, M3): registers the tenant's `hubspot.access_token`
 * credential reference and prints the environment variable the token must be
 * stored in; it never handles the token itself.
 * OAuth (M4, ADR 0010): no credential to set; install the app next with
 * `hubspot:install-url`. Either way the integration is read_only with the
 * expected account id. Read-write access is not offered until production
 * writes are explicitly approved.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      'portal-id': { type: 'string' },
      auth: { type: 'string', default: 'static_token' },
      disable: { type: 'boolean' },
    },
  });
  if (!values.tenant || (!values['portal-id'] && !values.disable)) {
    throw new Error(
      'Usage: hubspot:configure --tenant <slug> --portal-id <HubSpot account id> [--auth static_token|oauth] | --disable',
    );
  }
  const auth = values.auth;
  if (auth !== 'static_token' && auth !== 'oauth') {
    throw new Error('--auth must be static_token or oauth');
  }
  const tenant = values.tenant;
  const result = await withHubSpotContext(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const config = app.get(TenantConfigService);
    if (values.disable) {
      return {
        integration: await config.configureIntegration(ctx, 'hubspot', { access: 'disabled' }),
      };
    }
    if (auth === 'oauth') {
      const integration = await config.configureIntegration(ctx, 'hubspot', {
        access: 'read_only',
        settings: { portalId: values['portal-id'], auth: 'oauth' },
      });
      return { integration, next: `hubspot:install-url --tenant ${tenant}` };
    }
    const credential = await app
      .get(TenantCredentialsService)
      .register(ctx, 'hubspot', HUBSPOT_ACCESS_TOKEN);
    const integration = await config.configureIntegration(ctx, 'hubspot', {
      access: 'read_only',
      settings: { portalId: values['portal-id'], auth: 'static_token' },
    });
    return {
      integration,
      credential: {
        secretKey: credential.secretKey,
        environmentVariable: EnvSecretProvider.toEnvName(credential.secretKey),
      },
    };
  });
  process.stdout.write(`${JSON.stringify({ tenant, ...result }, null, 2)}\n`);
}

main().catch(fail);
