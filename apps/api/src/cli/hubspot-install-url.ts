import { parseArgs } from 'node:util';
import { HubSpotOAuthService } from '../modules/hubspot';
import { TenantContextService } from '../modules/tenancy';
import { fail, withHubSpotContext } from './hubspot-context';
import { authorizeOperator } from './operator';

/**
 * Prints the HubSpot app install (consent) URL for a tenant configured with
 * `hubspot:configure --auth oauth` (ADR 0010):
 *
 *   pnpm --filter @lip/api hubspot:install-url --tenant juniper --actor <id>
 *
 * The URL carries a signed, tenant-bound state that expires after 10 minutes
 * and can be redeemed once. There is no admin UI yet, so install links are
 * issued only from here. Nothing secret is printed.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { tenant: { type: 'string' }, actor: { type: 'string' } },
  });
  if (!values.tenant) throw new Error('Usage: hubspot:install-url --tenant <slug>');
  const tenant = values.tenant;
  const { url, expiresAt } = await withHubSpotContext(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const auth = await authorizeOperator(app, ctx, 'config.oauth.install', {
      actorFlag: values.actor,
      action: 'oauth.install_state.issue',
      targetKind: 'oauth',
      targetRef: 'hubspot',
    });
    return await app.get(HubSpotOAuthService).installUrl(auth);
  });
  process.stdout.write(
    `${JSON.stringify({ tenant, installUrl: url, expiresAt: expiresAt.toISOString() }, null, 2)}\n`,
  );
}

main().catch(fail);
