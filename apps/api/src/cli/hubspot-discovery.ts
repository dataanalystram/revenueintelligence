import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { HubSpotDiscoveryService, TEST_ACCOUNT_TYPES } from '../modules/hubspot';
import { TenantContextService } from '../modules/tenancy';
import { fail, withHubSpotContext } from './hubspot-context';

/**
 * Read-only discovery of a tenant's HubSpot account (objects, properties,
 * associations, Lead availability, missing scopes):
 *
 *   pnpm --filter @lip/api hubspot:discover --tenant hstest --out discovery.json
 *
 * Refuses accounts that are not developer test or sandbox accounts unless
 * `--allow-account-type <TYPE>` is given. The report holds schema and counts
 * only, never record field values.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      out: { type: 'string' },
      'allow-account-type': { type: 'string', multiple: true },
    },
  });
  if (!values.tenant) throw new Error('Usage: hubspot:discover --tenant <slug> [--out <file>]');
  const tenant = values.tenant;
  const allowed = [...TEST_ACCOUNT_TYPES, ...(values['allow-account-type'] ?? [])];
  const report = await withHubSpotContext(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    return await app.get(HubSpotDiscoveryService).discover(ctx, { allowedAccountTypes: allowed });
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, json);
  else process.stdout.write(json);

  const line = (label: string, value: string): void =>
    void process.stderr.write(`${label.padEnd(22)} ${value}\n`);
  line('Account', `${report.account.portalId} (${report.account.accountType ?? 'unknown type'})`);
  line('API version', report.apiVersion);
  for (const [type, probe] of Object.entries(report.objects)) {
    const records =
      probe.records.status === 'ok' ? `${probe.records.recordsRead} read` : probe.records.status;
    const props =
      probe.properties.status === 'ok'
        ? `${probe.properties.total} properties`
        : probe.properties.status;
    line(type, `${records}; ${props}`);
  }
  line(
    'Leads object',
    `${report.leadObject.available ? 'available' : 'NOT available'}: ${report.leadObject.reason}`,
  );
  line(
    'Missing scopes',
    report.missingScopes.length ? report.missingScopes.join(', ') : 'none reported',
  );
}

main().catch(fail);
