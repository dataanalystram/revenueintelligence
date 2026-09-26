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
 * Connects a tenant to a HubSpot account, READ-ONLY (Milestone 3):
 *
 *   pnpm --filter @lip/api hubspot:configure --tenant hstest --portal-id 12345678
 *
 * Registers the tenant's `hubspot.access_token` credential reference and sets
 * the HubSpot integration to read_only with the expected account id. It never
 * handles the token itself: it prints the environment variable the token must
 * be stored in (env secret provider). Read-write access is not offered until
 * production writes are explicitly approved.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      'portal-id': { type: 'string' },
      disable: { type: 'boolean' },
    },
  });
  if (!values.tenant || (!values['portal-id'] && !values.disable)) {
    throw new Error(
      'Usage: hubspot:configure --tenant <slug> --portal-id <HubSpot account id> | --disable',
    );
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
    const credential = await app
      .get(TenantCredentialsService)
      .register(ctx, 'hubspot', HUBSPOT_ACCESS_TOKEN);
    const integration = await config.configureIntegration(ctx, 'hubspot', {
      access: 'read_only',
      settings: { portalId: values['portal-id'] },
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
