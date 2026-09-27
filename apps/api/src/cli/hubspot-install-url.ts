import { parseArgs } from 'node:util';
import { HubSpotOAuthService } from '../modules/hubspot';
import { TenantContextService } from '../modules/tenancy';
import { fail, withHubSpotContext } from './hubspot-context';

/**
 * Prints the HubSpot app install (consent) URL for a tenant configured with
 * `hubspot:configure --auth oauth` (ADR 0010):
 *
 *   pnpm --filter @lip/api hubspot:install-url --tenant juniper
 *
 * The URL carries a signed, tenant-bound state that expires after 10 minutes
 * and can be redeemed once. There is no admin UI yet, so install links are
 * issued only from here. Nothing secret is printed.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { tenant: { type: 'string' } } });
  if (!values.tenant) throw new Error('Usage: hubspot:install-url --tenant <slug>');
  const tenant = values.tenant;
  const { url, expiresAt } = await withHubSpotContext(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    return await app.get(HubSpotOAuthService).installUrl(ctx);
  });
  process.stdout.write(
    `${JSON.stringify({ tenant, installUrl: url, expiresAt: expiresAt.toISOString() }, null, 2)}\n`,
  );
}

main().catch(fail);
