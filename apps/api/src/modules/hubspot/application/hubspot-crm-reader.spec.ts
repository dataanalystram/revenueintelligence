import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_READ_SCOPES, FakeHubSpot, sampleData } from '../../../../test/support/fake-hubspot';
import { CRM_OBJECT_KINDS, type CrmReader } from '../../domain';
import { Secret } from '../../../platform/secrets';
import { loadHubSpotConfig } from '../hubspot.config';
import { HubSpotHttpClient } from '../infrastructure/http-client';
import { HubSpotReader } from '../infrastructure/hubspot-reader';
import { SlidingWindowRateLimiter } from '../infrastructure/rate-limiter';
import { HUBSPOT_OBJECT_FOR_KIND, HubSpotCrmReader } from './hubspot-crm-reader';

describe('HubSpotCrmReader (CrmReader port, ADR 0010)', () => {
  let fake: FakeHubSpot;
  let crm: CrmReader;

  beforeAll(async () => {
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
    const config = loadHubSpotConfig({ HUBSPOT_API_BASE_URL: fake.url });
    const reader = new HubSpotReader(
      new HubSpotHttpClient(config, new SlidingWindowRateLimiter(90)),
      config,
      { tenantKey: 't', token: new Secret('tok') },
    );
    crm = new HubSpotCrmReader(reader);
  });

  afterAll(async () => {
    await fake.stop();
  });

  it('maps every canonical kind to exactly one HubSpot object', () => {
    expect(HUBSPOT_OBJECT_FOR_KIND).toEqual({
      person: 'contacts',
      company: 'companies',
      lead: 'leads',
    });
    expect(Object.keys(HUBSPOT_OBJECT_FOR_KIND).sort()).toEqual([...CRM_OBJECT_KINDS].sort());
  });

  it('reads each kind from the matching HubSpot endpoint', async () => {
    fake.requests.length = 0;
    const people = await crm.listRecords('person', { limit: 2 });
    const companies = await crm.listRecords('company', { limit: 2 });
    const leads = await crm.listRecords('lead', { limit: 2 });
    expect(fake.requests.map((r) => r.path)).toEqual([
      '/crm/objects/2026-09/contacts',
      '/crm/objects/2026-09/companies',
      '/crm/objects/2026-09/leads',
    ]);
    expect(people.items[0]!.ref).toMatchObject({ system: 'hubspot', objectType: 'contacts' });
    expect(companies.items[0]!.ref.objectType).toBe('companies');
    expect(leads.items[0]!.ref.objectType).toBe('leads');
    expect(people.nextCursor).toBeDefined();
  });

  it('account, fields, association types, associations and single records', async () => {
    await expect(crm.getAccount()).resolves.toMatchObject({ system: 'hubspot', accountId: '42' });
    const fields = await crm.listFieldDefinitions('person');
    expect(fields.some((f) => f.name === 'email')).toBe(true);
    const types = await crm.listAssociationTypes('lead', 'company');
    expect(types.map((t) => t.typeId)).toContain(580);
    const links = await crm.readAssociations('lead', ['301'], 'person');
    expect(links.associations[0]).toMatchObject({
      from: { id: '301' },
      to: { objectType: 'contacts' },
    });
    await expect(crm.getRecord('company', '201')).resolves.toMatchObject({ ref: { id: '201' } });
    await expect(crm.getRecord('company', '999999')).resolves.toBeUndefined();
    expect(fake.requests.every((r) => r.method === 'GET' || r.path.endsWith('/batch/read'))).toBe(
      true,
    );
  });
});
