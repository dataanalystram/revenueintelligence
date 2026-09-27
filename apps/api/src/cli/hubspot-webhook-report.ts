import { parseArgs } from 'node:util';
import { WebhookReceiptRepository } from '../modules/hubspot';
import { TenantContextService } from '../modules/tenancy';
import { fail, withHubSpotContext } from './hubspot-context';

/**
 * Summarises the HubSpot webhook receipts of a tenant (ADR 0011):
 *
 *   pnpm --filter @lip/api hubspot:webhook-report --tenant juniper [--since 2026-09-28T00:00:00Z]
 *
 * Safe metadata only (counts, event types, object type ids, attempt numbers,
 * times): receipts never contain property values or payloads, and nothing
 * here reads HubSpot.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { tenant: { type: 'string' }, since: { type: 'string' } },
  });
  if (!values.tenant) {
    throw new Error('Usage: hubspot:webhook-report --tenant <slug> [--since <ISO timestamp>]');
  }
  const since = values.since ? new Date(values.since) : undefined;
  if (since && Number.isNaN(since.getTime())) throw new Error('--since must be an ISO timestamp');
  const tenant = values.tenant;
  const summary = await withHubSpotContext(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    return await app.get(WebhookReceiptRepository).summary(ctx, since);
  });
  process.stdout.write(
    `${JSON.stringify({ tenant, since: since?.toISOString() ?? null, ...summary }, null, 2)}\n`,
  );
}

main().catch(fail);
