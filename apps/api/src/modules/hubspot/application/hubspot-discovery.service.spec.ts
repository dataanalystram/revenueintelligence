import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_READ_SCOPES, FakeHubSpot, sampleData } from '../../../../test/support/fake-hubspot';
import { Secret } from '../../../platform/secrets';
import type { TenantContext } from '../../tenancy';
import { loadHubSpotConfig } from '../hubspot.config';
import { HubSpotHttpClient } from '../infrastructure/http-client';
import { HubSpotReader } from '../infrastructure/hubspot-reader';
import { SlidingWindowRateLimiter } from '../infrastructure/rate-limiter';
import type { HubSpotConnector } from './hubspot-connector.service';
import { HubSpotDiscoveryService } from './hubspot-discovery.service';

describe('HubSpotDiscoveryService (account-info version probe)', () => {
  let fake: FakeHubSpot;

  beforeEach(async () => {
    fake = await new FakeHubSpot({
      accounts: {
        tok: {
          portalId: 42,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
      },
      ...sampleData(),
    }).start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  function discovery(env: NodeJS.ProcessEnv): HubSpotDiscoveryService {
    const config = loadHubSpotConfig({ HUBSPOT_API_BASE_URL: fake.url, ...env });
    const http = new HubSpotHttpClient(config, new SlidingWindowRateLimiter(90));
    const connector = {
      connect: async () => {
        const reader = new HubSpotReader(http, config, {
          tenantKey: 't',
          token: new Secret('tok'),
        });
        return { reader, account: await reader.getAccount() };
      },
    } as unknown as HubSpotConnector;
    return new HubSpotDiscoveryService(connector, config);
  }

  const ctx = {} as TenantContext;

  it('probes the CRM version for account info when the configured versions differ', async () => {
    const report = await discovery({ HUBSPOT_ACCOUNT_INFO_API_VERSION: '2026-03' }).discover(ctx);
    expect(report.accountInfoVersions).toEqual({
      '2026-03': { status: 'ok' },
      '2026-09': { status: 'ok' },
    });
    expect(report.endpointsUsed['GET /account-info/2026-03/details']).toBe(1);
    expect(report.endpointsUsed['GET /account-info/2026-09/details']).toBe(1);
  });

  it('reports a version that does not answer, without failing discovery', async () => {
    fake.fail({
      match: /^GET \/account-info\/2026-09\/details$/,
      status: 404,
      body: { category: 'OBJECT_NOT_FOUND' },
    });
    const report = await discovery({ HUBSPOT_ACCOUNT_INFO_API_VERSION: '2026-03' }).discover(ctx);
    expect(report.accountInfoVersions['2026-09']).toMatchObject({
      status: 'not_found',
      httpStatus: 404,
    });
    expect(report.objects.contacts.records.status).toBe('ok');
  });

  it('does not probe twice when the versions are equal', async () => {
    const report = await discovery({}).discover(ctx);
    expect(report.accountInfoVersions).toEqual({ '2026-09': { status: 'ok' } });
    expect(report.endpointsUsed['GET /account-info/2026-09/details']).toBe(1);
  });
});
