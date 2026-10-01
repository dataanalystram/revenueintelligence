import { parseArgs } from 'node:util';
import { WebhookReceiptRepository } from '../modules/hubspot';
import { TenantContextService } from '../modules/tenancy';
import { fail, withHubSpotContext } from './hubspot-context';

/**
 * Summarises the HubSpot webhook receipts of a tenant (ADR 0011):
 *
 *   pnpm --filter @lip/api hubspot:webhook-report --tenant juniper [--since 2026-09-28T00:00:00Z] [--recent 20]
 *
 * Safe metadata only (counts, event types, object type ids, property names,
 * object ids, attempt numbers, times): receipts never contain property values
 * or payloads, and nothing here reads HubSpot. `--recent N` adds the N newest
 * receipts (max 200).
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      since: { type: 'string' },
      recent: { type: 'string' },
    },
  });
  if (!values.tenant) {
    throw new Error(
      'Usage: hubspot:webhook-report --tenant <slug> [--since <ISO timestamp>] [--recent <N>]',
    );
  }
  const since = values.since ? new Date(values.since) : undefined;
  if (since && Number.isNaN(since.getTime())) throw new Error('--since must be an ISO timestamp');
  const recent = values.recent !== undefined ? Number(values.recent) : 0;
  if (!Number.isInteger(recent) || recent < 0 || recent > 200) {
    throw new Error('--recent must be an integer from 0 to 200');
  }
  const tenant = values.tenant;
  const report = await withHubSpotContext(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const receipts = app.get(WebhookReceiptRepository);
    const summary = await receipts.summary(ctx, since);
    return recent > 0 ? { ...summary, recent: await receipts.recent(ctx, recent, since) } : summary;
  });
  process.stdout.write(
    `${JSON.stringify({ tenant, since: since?.toISOString() ?? null, ...report }, null, 2)}\n`,
  );
}

main().catch(fail);
