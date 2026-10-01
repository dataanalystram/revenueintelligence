import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkSyncService, ContextOperationsService } from '../../src/modules/context';
import type { TenantContext } from '../../src/modules/tenancy';
import { EnvSecretProvider } from '../../src/platform/secrets';
import { startInfrastructure, withAdmin, type TestInfrastructure } from '../support/containers';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/**
 * M6 against the live developer test account (read-only): backfill and
 * reconciliation through the worker (BullMQ), the single canonical writer and
 * the Gate-1 search path, on real PostgreSQL and Redis. Every HTTP request is
 * recorded (method and path only) to prove that nothing but reads reached
 * HubSpot. Same variables as hubspot-crm.live.spec.ts; never point it at a
 * customer's production account.
 */
const SOURCE_VAR = EnvSecretProvider.toEnvName('tenant.hstest.hubspot.access_token');
const PORTAL_VAR = 'HUBSPOT_TEST_PORTAL_ID';
const missing = [SOURCE_VAR, PORTAL_VAR].filter((name) => !process.env[name]);

/** Bounds the run on a large account (the test account is small). */
const MAX_RECORDS = 500;

if (missing.length > 0) {
  describe(`M6 live context: SKIPPED, missing ${missing.join(' and ')}`, () => {
    it.skip('requires a HubSpot developer test account token (docs/integrations/hubspot/setup.md)', () => {});
  });
} else {
  describe('M6 live: backfill and reconciliation on the test account (read-only)', () => {
    let infra: TestInfrastructure;
    let h: TenancyHarness;
    let tenant: TenantContext;
    let bulk: BulkSyncService;
    let operations: ContextOperationsService;
    const created: string[] = [];
    const requests: { method: string; path: string }[] = [];
    const realFetch = globalThis.fetch;

    const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
      withAdmin(infra.adminUrl, async (db) => (await db.query<T>(text, params)).rows);

    async function waitForRuns(mode: 'backfill' | 'reconcile', count: number): Promise<void> {
      const deadline = Date.now() + 180_000;
      for (;;) {
        const rows = await sql<{ status: string }>(
          'SELECT status FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND mode = $2',
          [tenant.tenantId, mode],
        );
        const done = rows.filter((r) => r.status !== 'running');
        if (rows.length >= count && done.length === rows.length) return;
        if (Date.now() > deadline) throw new Error(`${mode} runs did not finish`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    beforeAll(async () => {
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname.endsWith('hubapi.com') || url.hostname.endsWith('hubspot.com')) {
          const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
          requests.push({ method: method.toUpperCase(), path: url.pathname });
        }
        return realFetch(input, init);
      };
      infra = await startInfrastructure();
      h = await startTenancy(infra.config);
      tenant = await provisionTenant(h, 'ctxlive');
      await h.config.configureIntegration(tenant, 'hubspot', {
        access: 'read_only',
        settings: { portalId: process.env[PORTAL_VAR]!, auth: 'static_token' },
      });
      await h.credentials.register(tenant, 'hubspot', 'access_token');
      const own = EnvSecretProvider.toEnvName(`tenant.${tenant.tenantSlug}.hubspot.access_token`);
      process.env[own] = process.env[SOURCE_VAR];
      created.push(own);
      bulk = h.app.get(BulkSyncService);
      operations = h.app.get(ContextOperationsService);
    }, 240_000);

    afterAll(async () => {
      globalThis.fetch = realFetch;
      for (const name of created) delete process.env[name];
      await h?.close();
      await infra?.stop();
    }, 60_000);

    let firstHash: string;

    it('backfill loads companies and contacts through the worker; a rerun leaves the state hash unchanged', async () => {
      await bulk.startBackfill(tenant, ['company', 'person'], {
        pageSize: 100,
        maxRecords: MAX_RECORDS,
        correlationId: randomUUID(),
      });
      await waitForRuns('backfill', 2);
      const runs = await sql<{
        kind: string;
        status: string;
        records_seen: number;
        records_failed: number;
      }>(
        `SELECT kind, status, records_seen, records_failed FROM tenant_sync_checkpoints
         WHERE tenant_id = $1 AND mode = 'backfill' ORDER BY kind`,
        [tenant.tenantId],
      );
      expect(runs.map((r) => [r.kind, r.status, r.records_failed])).toEqual([
        ['company', 'completed', 0],
        ['person', 'completed', 0],
      ]);
      expect(runs.every((r) => r.records_seen > 0)).toBe(true);
      const first = await operations.stateHash(tenant);
      expect(first.rows.persons).toBeGreaterThan(0);
      expect(first.rows.companies).toBeGreaterThan(0);
      firstHash = first.hash;

      await bulk.startBackfill(tenant, ['company', 'person'], {
        pageSize: 100,
        maxRecords: MAX_RECORDS,
        correlationId: randomUUID(),
      });
      await waitForRuns('backfill', 4);
      expect((await operations.stateHash(tenant)).hash).toBe(firstHash);
    }, 300_000);

    it('reconciliation over the Gate-1 search path completes and changes nothing', async () => {
      // The completed backfills may already have started their own reconciliations.
      await waitForRuns('reconcile', 0);
      for (const kind of ['company', 'person'] as const) {
        const run = await bulk.startReconcile(tenant, kind, {
          since: new Date('2020-01-01T00:00:00Z'),
          correlationId: randomUUID(),
        });
        expect(run.skipped, kind).toBeUndefined();
      }
      await waitForRuns('reconcile', 2);
      const runs = await sql<{
        status: string;
        records_failed: number;
        last_error_code: string | null;
      }>(
        `SELECT status, records_failed, last_error_code FROM tenant_sync_checkpoints
         WHERE tenant_id = $1 AND mode = 'reconcile'`,
        [tenant.tenantId],
      );
      expect(runs.every((r) => r.status === 'completed' && r.records_failed === 0)).toBe(true);
      expect((await operations.stateHash(tenant)).hash).toBe(firstHash);
      expect(
        requests.some((r) =>
          /^\/crm\/objects\/2026-03\/(contacts|companies)\/search$/.test(r.path),
        ),
      ).toBe(true);
    }, 300_000);

    it('no dead letters, and only reads reached HubSpot', async () => {
      const dead = await sql('SELECT error_code FROM tenant_dead_letters WHERE tenant_id = $1', [
        tenant.tenantId,
      ]);
      expect(dead).toEqual([]);
      expect(requests.length).toBeGreaterThan(0);
      const writes = requests.filter(
        (r) =>
          r.method !== 'GET' &&
          !(
            r.method === 'POST' &&
            (/^\/crm\/objects\/2026-03\/(contacts|companies)\/search$/.test(r.path) ||
              /\/batch\/read$/.test(r.path))
          ),
      );
      expect(writes).toEqual([]);
    });
  });
}
