import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRM_CONNECTOR, type CrmConnector } from '../../src/modules/crm';
import type { CrmReader } from '../../src/modules/domain';
import { HubSpotError } from '../../src/modules/hubspot';
import type { TenantContext } from '../../src/modules/tenancy';
import { EnvSecretProvider } from '../../src/platform/secrets';
import { startInfrastructure, type TestInfrastructure } from '../support/containers';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/**
 * The live account through the FULL production path (technical debt #9):
 * tenant configuration and credential reference in PostgreSQL (forced RLS),
 * the token from the SecretProvider, the portalId check, and reads only
 * through the vendor-neutral CrmReader port (ADR 0010). Needs Docker for
 * PostgreSQL/Redis, plus the same variables as hubspot.live.spec.ts.
 * Read-only; never point it at a customer's production account.
 */
const SOURCE_VAR = EnvSecretProvider.toEnvName('tenant.hstest.hubspot.access_token');
const PORTAL_VAR = 'HUBSPOT_TEST_PORTAL_ID';
const missing = [SOURCE_VAR, PORTAL_VAR].filter((name) => !process.env[name]);

if (missing.length > 0) {
  describe(`HubSpot live CRM path: SKIPPED, missing ${missing.join(' and ')}`, () => {
    it.skip('requires a HubSpot developer test account token (docs/integrations/hubspot/setup.md)', () => {});
  });
} else {
  describe('HubSpot live through CRM_CONNECTOR → CrmReader (tenant path, read-only)', () => {
    let infra: TestInfrastructure;
    let h: TenancyHarness;
    let tenant: TenantContext;
    let crm: CrmReader;
    const created: string[] = [];

    beforeAll(async () => {
      infra = await startInfrastructure();
      h = await startTenancy(infra.config);
      tenant = await provisionTenant(h, 'hslive');
      await h.config.configureIntegration(tenant, 'hubspot', {
        access: 'read_only',
        settings: { portalId: process.env[PORTAL_VAR]!, auth: 'static_token' },
      });
      await h.credentials.register(tenant, 'hubspot', 'access_token');
      // The tenant's own credential variable, holding the test account's key (in-process only).
      const own = EnvSecretProvider.toEnvName(`tenant.${tenant.tenantSlug}.hubspot.access_token`);
      process.env[own] = process.env[SOURCE_VAR];
      created.push(own);
      crm = await h.app.get<CrmConnector>(CRM_CONNECTOR).forTenant(tenant);
    }, 240_000);

    afterAll(async () => {
      for (const name of created) delete process.env[name];
      await h?.close();
      await infra?.stop();
    }, 60_000);

    it('the verified account is the configured test account', async () => {
      const account = await crm.getAccount();
      expect(account).toMatchObject({ system: 'hubspot', accountId: process.env[PORTAL_VAR] });
      expect(['DEVELOPER_TEST', 'SANDBOX']).toContain(account.accountType);
    });

    it('reads person, company and lead by canonical kind, following the cursor', async () => {
      for (const kind of ['person', 'company', 'lead'] as const) {
        const first = await crm.listRecords(kind, { limit: 2 });
        expect(first.items.length, kind).toBeGreaterThan(0);
        if (first.nextCursor) {
          const second = await crm.listRecords(kind, { limit: 2, after: first.nextCursor });
          const firstIds = new Set(first.items.map((r) => r.ref.id));
          expect(
            second.items.every((r) => !firstIds.has(r.ref.id)),
            kind,
          ).toBe(true);
        }
        expect((await crm.listFieldDefinitions(kind)).length, kind).toBeGreaterThan(0);
      }
    });

    it('reads Lead → person and Lead → company associations', async () => {
      const leads = await crm.listRecords('lead', { limit: 10 });
      const ids = leads.items.map((l) => l.ref.id);
      for (const to of ['person', 'company'] as const) {
        const result = await crm.readAssociations('lead', ids, to);
        expect(result.failures, to).toEqual([]);
        expect(result.associations.length, to).toBeGreaterThan(0);
      }
    });

    it('Gate 1 (ADR 0015): the verified 2026-03 search answers for contacts and companies', async () => {
      for (const kind of ['person', 'company'] as const) {
        const page = await crm.listChangedSince(kind, {
          since: new Date('2020-01-01T00:00:00Z'),
          limit: 5,
        });
        expect(page.items.length, kind).toBeGreaterThan(0);
        expect(page.total, kind).toBeGreaterThanOrEqual(page.items.length);
        expect(page.windowExhausted, kind).toBe(false);
        const times = page.items.map((r) => r.updatedAt!.getTime());
        expect(times, `${kind}: oldest modification first`).toEqual(
          [...times].sort((a, b) => a - b),
        );
      }
    });

    it('another tenant without its own credential cannot use this one', async () => {
      const other = await provisionTenant(h, 'hsliveb');
      await h.config.configureIntegration(other, 'hubspot', {
        access: 'read_only',
        settings: { portalId: process.env[PORTAL_VAR]! },
      });
      await h.credentials.register(other, 'hubspot', 'access_token');
      const err = await h.app
        .get<CrmConnector>(CRM_CONNECTOR)
        .forTenant(other)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HubSpotError);
      expect((err as HubSpotError).kind).toBe('not_configured');
    });
  });
}
