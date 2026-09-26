import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  HubSpotConnector,
  HubSpotDiscoveryService,
  HubSpotError,
  type HubSpotDiscoveryReport,
} from '../../src/modules/hubspot';
import type { TenantContext } from '../../src/modules/tenancy';
import { EnvSecretProvider } from '../../src/platform/secrets';
import { startInfrastructure, type TestInfrastructure } from '../support/containers';
import { ALL_READ_SCOPES, FakeHubSpot, sampleData } from '../support/fake-hubspot';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/**
 * The tenant-scoped path end to end: integration settings and credential
 * references in PostgreSQL (RLS), token values from the SecretProvider, and
 * HTTP against a local fake HubSpot.
 */
describe('HubSpot connector (tenant-scoped)', () => {
  let infra: TestInfrastructure;
  let h: TenancyHarness;
  let fake: FakeHubSpot;
  let connector: HubSpotConnector;
  let discovery: HubSpotDiscoveryService;
  const envSet: string[] = [];

  const TOKEN_A = 'token-for-tenant-a';
  const TOKEN_B = 'token-for-tenant-b';

  function setToken(ctx: TenantContext, value: string): void {
    const name = EnvSecretProvider.toEnvName(`tenant.${ctx.tenantSlug}.hubspot.access_token`);
    process.env[name] = value;
    envSet.push(name);
  }

  async function enable(
    ctx: TenantContext,
    portalId: string | undefined,
    token?: string,
  ): Promise<void> {
    await h.config.configureIntegration(ctx, 'hubspot', {
      access: 'read_only',
      settings: portalId ? { portalId } : {},
    });
    await h.credentials.register(ctx, 'hubspot', 'access_token');
    if (token) setToken(ctx, token);
  }

  async function rejection(p: Promise<unknown>): Promise<HubSpotError> {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HubSpotError);
    return err as HubSpotError;
  }

  beforeAll(async () => {
    fake = await new FakeHubSpot({
      accounts: {
        [TOKEN_A]: {
          portalId: 1001,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
        [TOKEN_B]: {
          portalId: 2002,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
        'token-standard': {
          portalId: 3003,
          accountType: 'STANDARD',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
        'token-no-leads-scope': {
          portalId: 4004,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES.filter((s) => !s.includes('leads')),
          leadsEnabled: true,
        },
        'token-no-leads-feature': {
          portalId: 5005,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: false,
        },
      },
      ...sampleData(),
    }).start();
    process.env.HUBSPOT_API_BASE_URL = fake.url;
    process.env.HUBSPOT_MAX_RETRIES = '1';
    infra = await startInfrastructure();
    h = await startTenancy(infra.config);
    connector = h.app.get(HubSpotConnector);
    discovery = h.app.get(HubSpotDiscoveryService);
  });

  afterEach(() => {
    fake.requests.length = 0;
  });

  afterAll(async () => {
    for (const name of envSet) delete process.env[name];
    delete process.env.HUBSPOT_API_BASE_URL;
    delete process.env.HUBSPOT_MAX_RETRIES;
    await h?.close();
    await infra?.stop();
    await fake?.stop();
  });

  describe('refuses safely before any HubSpot request', () => {
    it('HubSpot disabled (the provisioning default) → integration_disabled', async () => {
      const t = await provisionTenant(h, 'hsoff');
      expect((await rejection(connector.forTenant(t))).kind).toBe('integration_disabled');
      expect(fake.requests).toHaveLength(0);
    });

    it('enabled but no credential registered → not_configured', async () => {
      const t = await provisionTenant(h, 'hsnoref');
      await h.config.configureIntegration(t, 'hubspot', {
        access: 'read_only',
        settings: { portalId: '1001' },
      });
      const err = await rejection(connector.forTenant(t));
      expect(err.kind).toBe('not_configured');
      expect(err.message).toContain('access token');
      expect(fake.requests).toHaveLength(0);
    });

    it('credential registered but its secret is not set → not_configured', async () => {
      const t = await provisionTenant(h, 'hsnosecret');
      await enable(t, '1001');
      const err = await rejection(connector.forTenant(t));
      expect(err.kind).toBe('not_configured');
      expect(err.message).toContain('access token');
      expect(fake.requests).toHaveLength(0);
    });

    it('no configured account id → not_configured, before any request', async () => {
      const t = await provisionTenant(h, 'hsnoportal');
      await enable(t, undefined, TOKEN_A);
      expect((await rejection(connector.forTenant(t))).kind).toBe('not_configured');
      expect((await rejection(connector.connect(t))).kind).toBe('not_configured');
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('tenant isolation', () => {
    it("each tenant reads with its own token only, and cannot reach another tenant's", async () => {
      const a = await provisionTenant(h, 'hsa');
      const b = await provisionTenant(h, 'hsb');
      await enable(a, '1001', TOKEN_A);
      await enable(b, '2002');

      const readerA = await connector.forTenant(a);
      await expect(readerA.getAccount()).resolves.toMatchObject({ portalId: '1001' });
      expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${TOKEN_A}`);
      const requestsWithA = fake.requests.length;

      // B's own secret is not set: B must not fall back to A's token.
      expect((await rejection(connector.forTenant(b))).kind).toBe('not_configured');
      expect(fake.requests).toHaveLength(requestsWithA);

      setToken(b, TOKEN_B);
      const readerB = await connector.forTenant(b);
      await expect(readerB.getAccount()).resolves.toMatchObject({ portalId: '2002' });
      expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${TOKEN_B}`);
      expect(
        fake.requests.slice(requestsWithA).every((r) => r.authorization === `Bearer ${TOKEN_B}`),
      ).toBe(true);
    });

    it("a token for a different account than the tenant's configured one → account_mismatch", async () => {
      const t = await provisionTenant(h, 'hsmismatch');
      await enable(t, '1001', TOKEN_B); // B's token belongs to account 2002
      const err = await rejection(connector.forTenant(t));
      expect(err.kind).toBe('account_mismatch');
      expect((await rejection(connector.connect(t))).kind).toBe('account_mismatch');
      // Only the account check was made; no data was read with the wrong token.
      expect(fake.requests.every((r) => r.path === '/account-info/2026-03/details')).toBe(true);
      expect(err.message).toContain('2002');
    });

    it('disabling HubSpot takes effect immediately', async () => {
      const t = await provisionTenant(h, 'hsflip');
      await enable(t, '1001', TOKEN_A);
      await expect(connector.forTenant(t)).resolves.toBeDefined();
      await h.config.configureIntegration(t, 'hubspot', { access: 'disabled' });
      expect((await rejection(connector.forTenant(t))).kind).toBe('integration_disabled');
    });
  });

  describe('discovery', () => {
    it('reports account, objects, properties, associations and Lead availability', async () => {
      const t = await provisionTenant(h, 'hsdisc');
      await enable(t, '1001', TOKEN_A);
      const report: HubSpotDiscoveryReport = await discovery.discover(t);

      expect(report.account).toMatchObject({ portalId: '1001', accountType: 'DEVELOPER_TEST' });
      expect(report.apiVersion).toBe('2026-09');
      expect(report.objects.contacts.records).toMatchObject({
        status: 'ok',
        pageSize: 2,
        pagesRead: 3,
        recordsRead: 5,
        paginationVerified: true,
        morePages: false,
      });
      expect(report.objects.contacts.properties).toMatchObject({
        status: 'ok',
        custom: 1,
        defaultPropertiesPresent: { email: true, firstname: true, lastname: true, jobtitle: true },
      });
      expect(report.leadObject.available).toBe(true);
      expect(report.missingScopes).toEqual([]);
      const leadCompany = report.associationLabels.find(
        (l) => l.from === 'leads' && l.to === 'companies',
      )!;
      expect(leadCompany.result).toMatchObject({
        status: 'ok',
        types: [{ typeId: 580, label: 'Primary' }],
      });
      const sample = report.associationSamples.find(
        (s) => s.from === 'leads' && s.to === 'contacts',
      )!;
      expect(sample.result).toMatchObject({
        status: 'ok',
        recordsChecked: 3,
        recordsWithAssociations: 3,
      });

      // Only current date-based endpoints, and the report lists each one used.
      expect(report.accountInfoVersions).toEqual({
        '2026-03': { status: 'ok' },
        '2026-09': { status: 'ok' },
      });
      expect(
        Object.keys(report.endpointsUsed).every((e) =>
          /^(GET|POST) \/[\w-]+(\/[\w-]+)?\/\d{4}-\d{2}\//.test(e),
        ),
      ).toBe(true);
      expect(report.endpointsUsed['GET /account-info/2026-03/details']).toBeGreaterThan(0);
      expect(fake.requests.every((r) => /\/\d{4}-\d{2}\//.test(r.path))).toBe(true);
      // Only reads were made; the report carries no record field values.
      expect(fake.requests.every((r) => r.method === 'GET' || r.path.endsWith('/batch/read'))).toBe(
        true,
      );
      const json = JSON.stringify(report);
      expect(json).not.toContain('school1.example');
      expect(json).not.toContain('First1');
    });

    it('missing Leads scope → Leads reported unavailable with the scope HubSpot requires', async () => {
      const t = await provisionTenant(h, 'hsnoscope');
      await enable(t, '4004', 'token-no-leads-scope');
      const report = await discovery.discover(t);
      expect(report.objects.leads.records).toMatchObject({
        status: 'missing_scopes',
        requiredScopes: ['crm.objects.leads.read'],
      });
      expect(report.objects.contacts.records.status).toBe('ok');
      expect(report.leadObject).toMatchObject({ available: false });
      expect(report.leadObject.reason).toContain('crm.objects.leads.read');
      expect(report.missingScopes).toEqual(['crm.objects.leads.read', 'crm.schemas.leads.read']);
    });

    it('Leads not in the subscription → reported unavailable, other objects still discovered', async () => {
      const t = await provisionTenant(h, 'hsnofeat');
      await enable(t, '5005', 'token-no-leads-feature');
      const report = await discovery.discover(t);
      expect(report.objects.leads.records).toMatchObject({ status: 'forbidden', httpStatus: 403 });
      expect(report.leadObject.available).toBe(false);
      expect(report.leadObject.reason).toContain('Sales Hub Professional or Enterprise');
      expect(report.objects.companies.records.status).toBe('ok');
    });

    it('refuses a production (STANDARD) account unless explicitly allowed', async () => {
      const t = await provisionTenant(h, 'hsprod');
      await enable(t, '3003', 'token-standard');
      const err = await rejection(discovery.discover(t));
      expect(err.kind).toBe('account_mismatch');
      expect(err.message).toContain('STANDARD');
      // Only the account check was made: no records or schema were read.
      expect(fake.requests.map((r) => r.path)).toEqual(['/account-info/2026-03/details']);

      await expect(
        discovery.discover(t, { allowedAccountTypes: ['STANDARD'] }),
      ).resolves.toMatchObject({ account: { accountType: 'STANDARD' } });
    });

    it('a 5xx during discovery is retried; a persistent one is reported per probe', async () => {
      const t = await provisionTenant(h, 'hs5xx');
      await enable(t, '1001', TOKEN_A);
      fake.fail({ match: /\/crm\/properties\/[^/]+\/companies$/, status: 503, times: 10 });
      const report = await discovery.discover(t);
      expect(report.objects.companies.properties).toMatchObject({
        status: 'error',
        httpStatus: 503,
      });
      expect(report.objects.companies.records.status).toBe('ok');
      const attempts = fake.requests.filter((r) => /properties\/[^/]+\/companies$/.test(r.path));
      expect(attempts).toHaveLength(2); // 1 + HUBSPOT_MAX_RETRIES
    });
  });
});
