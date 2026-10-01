import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_READ_SCOPES, FakeHubSpot, sampleData } from '../../../../test/support/fake-hubspot';
import { Secret } from '../../../platform/secrets';
import { HubSpotError } from '../errors';
import { loadHubSpotConfig } from '../hubspot.config';
import { HubSpotHttpClient } from './http-client';
import { HubSpotReader } from './hubspot-reader';
import { toAssociationType } from './mappers';
import { HsAssociationTypeSchema } from './schemas';
import { SlidingWindowRateLimiter } from './rate-limiter';
import { backoffDelayMs, parseRetryAfterMs } from './retry';

describe('HubSpotReader (translation into vendor-neutral read models)', () => {
  let fake: FakeHubSpot;
  let reader: HubSpotReader;

  beforeEach(async () => {
    fake = await new FakeHubSpot({
      accounts: {
        tok: {
          portalId: 4242,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
      },
      ...sampleData(),
    }).start();
    const config = loadHubSpotConfig({ HUBSPOT_API_BASE_URL: fake.url });
    const http = new HubSpotHttpClient(config, new SlidingWindowRateLimiter(90), {
      sleep: () => Promise.resolve(),
    });
    reader = new HubSpotReader(http, config, { tenantKey: 't', token: new Secret('tok') });
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('records the endpoints it used (date-based only, ids templated)', async () => {
    await reader.getAccount();
    await reader.listRecords('contacts', { limit: 2 });
    await reader.getRecord('companies', '202');
    await reader.readAssociations('leads', ['301'], 'contacts');
    expect(reader.endpointsUsed()).toEqual({
      'GET /account-info/2026-09/details': 1,
      'GET /crm/objects/2026-09/contacts': 1,
      'GET /crm/objects/2026-09/companies/{id}': 1,
      'POST /crm/associations/2026-09/leads/contacts/batch/read': 1,
    });
  });

  it('refuses a malformed account-info version before any request', async () => {
    await expect(reader.getAccount('2026-09/../../account-info/v3')).rejects.toThrow(RangeError);
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps unexpected NO_ASSOCIATIONS_FOUND ids as failures, and falls back from empty fromObjectId', async () => {
    fake.fail({
      match: /batch\/read$/,
      status: 207,
      body: {
        status: 'COMPLETE',
        results: [],
        errors: [
          {
            category: 'OBJECT_NOT_FOUND',
            subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND',
            message: 'not one of ours',
            context: { fromObjectId: ['999'] },
          },
          {
            category: 'OBJECT_NOT_FOUND',
            subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND',
            message: 'ids only',
            context: { fromObjectId: [], ids: ['301'] },
          },
        ],
      },
    });
    const result = await reader.readAssociations('contacts', ['301'], 'companies');
    expect(result.withoutAssociations).toEqual(['301']);
    expect(result.failures).toEqual([
      {
        category: 'OBJECT_NOT_FOUND',
        subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND',
        message: 'not one of ours',
        ids: ['999'],
      },
    ]);
  });

  it('reads account details', async () => {
    await expect(reader.getAccount()).resolves.toEqual({
      portalId: '4242',
      accountType: 'DEVELOPER_TEST',
      timeZone: 'Europe/London',
      currency: 'GBP',
      dataHostingLocation: 'eu1',
    });
  });

  it('maps contacts to person snapshots (normalised email, raw attributes kept)', async () => {
    const page = await reader.listRecords('contacts', { limit: 100 });
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeUndefined();
    const first = page.items[0]!;
    expect(first).toMatchObject({
      ref: { system: 'hubspot', objectType: 'contacts', id: '101' },
      email: 'person1@school1.example',
      firstName: 'First1',
      lastName: 'Last1',
      jobTitle: 'Head of IT',
      archived: false,
    });
    expect(first.createdAt).toEqual(new Date('2026-09-01T09:00:00.000Z'));
    expect(first.attributes.fake_custom_field).toBe('x');
    // An invalid address is not normalised into `email`, but the raw value stays visible.
    const invalid = page.items[4]!;
    expect(invalid.email).toBeUndefined();
    expect(invalid.attributes.email).toBe('not-an-email');
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('maps companies (lower-cased domain) and leads', async () => {
    const companies = await reader.listRecords('companies');
    expect(companies.items[0]).toMatchObject({ name: 'School 1', domain: 'school1.example' });
    const leads = await reader.listRecords('leads');
    expect(leads.items.map((l) => l.ref)).toEqual([
      { system: 'hubspot', objectType: 'leads', id: '301' },
      { system: 'hubspot', objectType: 'leads', id: '302' },
      { system: 'hubspot', objectType: 'leads', id: '303' },
    ]);
  });

  it('paginates with HubSpot cursors until the last page', async () => {
    const pages = [];
    for await (const page of reader.iterateRecords('contacts', { limit: 2, maxPages: 10 }))
      pages.push(page);
    expect(pages.map((p) => p.items.map((i) => i.ref.id))).toEqual([
      ['101', '102'],
      ['103', '104'],
      ['105'],
    ]);
    expect(pages.at(-1)!.nextCursor).toBeUndefined();
    const cursors = fake.requests.map((r) => r.query.after);
    expect(cursors[0]).toBeUndefined();
    expect(cursors[1]).toBe(pages[0]!.nextCursor);
    expect(cursors[2]).toBe(pages[1]!.nextCursor);
  });

  it('stops at maxPages', async () => {
    let n = 0;
    for await (const _page of reader.iterateRecords('contacts', { limit: 1, maxPages: 2 })) n += 1;
    expect(n).toBe(2);
    expect(fake.requests).toHaveLength(2);
  });

  it('refuses a paging cursor that does not advance', async () => {
    fake.fail({
      match: /contacts$/,
      status: 200,
      body: { results: [], paging: { next: { after: 'same' } } },
    });
    await expect(reader.listRecords('contacts', { after: 'same' })).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('passes requested properties and validates page size', async () => {
    await reader.listRecords('contacts', { limit: 5, properties: ['email', 'fake_custom_field'] });
    expect(fake.requests[0]!.query).toMatchObject({
      limit: '5',
      properties: 'email,fake_custom_field',
      archived: 'false',
    });
    await expect(reader.listRecords('contacts', { limit: 101 })).rejects.toThrow(RangeError);
    await expect(reader.listRecords('contacts', { limit: 0 })).rejects.toThrow(RangeError);
  });

  it('getRecord: found, and 404 → undefined', async () => {
    await expect(reader.getRecord('companies', '202')).resolves.toMatchObject({ name: 'School 2' });
    await expect(reader.getRecord('companies', '999')).resolves.toBeUndefined();
    await expect(reader.getRecord('companies', '../x')).rejects.toThrow(RangeError);
  });

  it('maps property definitions (vendor vs custom, picklist options)', async () => {
    const fields = await reader.listProperties('contacts');
    expect(fields.find((f) => f.name === 'fake_custom_field')).toMatchObject({
      system: 'hubspot',
      objectType: 'contacts',
      vendorDefined: false,
      type: 'string',
    });
    expect(fields.find((f) => f.name === 'lifecyclestage')).toMatchObject({
      vendorDefined: true,
      type: 'enumeration',
      options: [
        { value: 'lead', label: 'lead', hidden: false },
        { value: 'customer', label: 'customer', hidden: false },
      ],
    });
  });

  it('maps association labels to vendor-neutral categories', async () => {
    await expect(reader.listAssociationTypes('leads', 'companies')).resolves.toEqual([
      { category: 'standard', typeId: 580, label: 'Primary' },
      { category: 'standard', typeId: 610, label: null },
    ]);
  });

  it('reads associations in batches and follows per-record paging', async () => {
    const {
      associations: links,
      withoutAssociations,
      failures,
    } = await reader.readAssociations('contacts', ['101', '102', '105'], 'companies');
    expect(failures).toEqual([]);
    // Contact 105 has no companies: HubSpot's NO_ASSOCIATIONS_FOUND, not a failure.
    expect(withoutAssociations).toEqual(['105']);
    expect(
      links
        .filter((l) => l.from.id === '101')
        .map((l) => l.to.id)
        .sort(),
    ).toEqual(['201', '202', '203']);
    expect(links.filter((l) => l.from.id === '102').map((l) => l.to.id)).toEqual(['202']);
    expect(links.some((l) => l.from.id === '105')).toBe(false);
    const posts = fake.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({ inputs: [{ id: '101', after: '2' }] });
  });

  it('returns per-record failures from a 207 multi-status batch read, never dropping them', async () => {
    const result = await reader.readAssociations('leads', ['301', '999'], 'contacts');
    expect(result.associations.map((a) => a.from.id)).toEqual(['301']);
    expect(result.failures).toEqual([
      {
        category: 'OBJECT_NOT_FOUND',
        subCategory: undefined,
        message: 'Records not found',
        ids: ['999'],
      },
    ]);
    expect(result.withoutAssociations).toEqual([]);
  });

  it('parses the live NO_ASSOCIATIONS_FOUND shape (numeric fromObjectId tolerated)', async () => {
    fake.fail({
      match: /batch\/read$/,
      status: 207,
      body: {
        status: 'COMPLETE',
        results: [],
        numErrors: 2,
        errors: [
          {
            status: 'error',
            category: 'OBJECT_NOT_FOUND',
            subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND',
            message: 'No company is associated with contact 301.',
            context: {
              fromObjectId: ['301'],
              fromObjectType: ['contact'],
              toObjectType: ['company'],
            },
          },
          {
            status: 'error',
            category: 'OBJECT_NOT_FOUND',
            subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND',
            message: 'No company is associated with contact 302.',
            context: { fromObjectId: [302] },
          },
        ],
      },
    });
    const result = await reader.readAssociations('contacts', ['301', '302'], 'companies');
    expect(result.withoutAssociations).toEqual(['301', '302']);
    expect(result.failures).toEqual([]);
  });

  it('tolerates an unfamiliar error context shape in a 207 response', async () => {
    fake.fail({
      match: /batch\/read$/,
      status: 207,
      body: {
        status: 'COMPLETE',
        results: [],
        errors: [{ category: 'SOMETHING_NEW', message: 'x', context: { objectIds: [1, 2] } }],
      },
    });
    const result = await reader.readAssociations('leads', ['301'], 'contacts');
    expect(result.failures).toEqual([
      { category: 'SOMETHING_NEW', subCategory: undefined, message: 'x', ids: [] },
    ]);
  });

  it('surfaces classified errors from reads', async () => {
    fake.fail({ match: /leads$/, status: 403, body: { category: 'MISSING_SCOPES' } });
    const err = await reader.listRecords('leads').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubSpotError);
    expect((err as HubSpotError).missingScopes).toBe(true);
  });
});

describe('retry helpers', () => {
  it('parses Retry-After seconds and HTTP dates, capped at 60 s', () => {
    expect(parseRetryAfterMs('2')).toBe(2_000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
    expect(parseRetryAfterMs('600')).toBe(60_000);
    expect(
      parseRetryAfterMs('Sat, 26 Sep 2026 12:00:10 GMT', () => Date.parse('2026-09-26T12:00:00Z')),
    ).toBe(10_000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });

  it('backs off exponentially with jitter, capped at 30 s', () => {
    expect(backoffDelayMs(1, () => 0)).toBe(250);
    expect(backoffDelayMs(1, () => 1)).toBe(500);
    expect(backoffDelayMs(3, () => 1)).toBe(2_000);
    expect(backoffDelayMs(20, () => 1)).toBe(30_000);
  });
});

describe('HubSpot process configuration', () => {
  it('defaults to the public API over https and the 2026-09 API version', () => {
    expect(loadHubSpotConfig({})).toEqual({
      baseUrl: 'https://api.hubapi.com',
      apiVersion: '2026-09',
      accountInfoApiVersion: '2026-09',
      timeoutMs: 15_000,
      maxRetries: 3,
      requestsPer10s: 90,
      oauth: {
        apiVersion: '2026-09',
        authorizeBaseUrl: undefined,
        timeoutMs: 10_000,
        clientId: undefined,
        redirectUri: undefined,
      },
      webhooks: { appId: undefined, targetUrl: undefined },
    });
  });

  it('webhook target URL: https (or loopback http), no query, fragment or credentials', () => {
    expect(
      loadHubSpotConfig({
        HUBSPOT_WEBHOOK_TARGET_URL: 'https://example.trycloudflare.com/webhooks/hubspot',
        HUBSPOT_APP_ID: '123456',
      }).webhooks,
    ).toEqual({
      appId: '123456',
      targetUrl: 'https://example.trycloudflare.com/webhooks/hubspot',
    });
    for (const bad of [
      'http://example.com/webhooks/hubspot',
      'https://example.com/webhooks/hubspot?x=1',
      'https://example.com/webhooks/hubspot#f',
      'https://user:pw@example.com/webhooks/hubspot',
    ]) {
      expect(() => loadHubSpotConfig({ HUBSPOT_WEBHOOK_TARGET_URL: bad }), bad).toThrow(
        /HUBSPOT_WEBHOOK_TARGET_URL/,
      );
    }
    expect(() => loadHubSpotConfig({ HUBSPOT_APP_ID: 'abc' })).toThrow(/HUBSPOT_APP_ID/);
  });

  it('allows plain http only for a loopback test server', () => {
    expect(loadHubSpotConfig({ HUBSPOT_API_BASE_URL: 'http://127.0.0.1:9999/' }).baseUrl).toBe(
      'http://127.0.0.1:9999',
    );
    expect(() => loadHubSpotConfig({ HUBSPOT_API_BASE_URL: 'http://api.hubapi.com' })).toThrow(
      /https/,
    );
    expect(() => loadHubSpotConfig({ HUBSPOT_API_BASE_URL: 'http://10.0.0.5' })).toThrow(/https/);
  });

  it('rejects malformed versions and unsafe limits', () => {
    expect(() => loadHubSpotConfig({ HUBSPOT_API_VERSION: 'v3' })).toThrow(/YYYY-MM/);
    expect(() => loadHubSpotConfig({ HUBSPOT_REQUESTS_PER_10S: '500' })).toThrow();
    expect(() => loadHubSpotConfig({ HUBSPOT_MAX_RETRIES: '50' })).toThrow();
  });
});

describe('association categories (technical debt #8)', () => {
  it('maps known HubSpot categories, and a category HubSpot adds later to `other` instead of failing', () => {
    expect(toAssociationType({ category: 'HUBSPOT_DEFINED', typeId: 1, label: 'Primary' })).toEqual(
      {
        category: 'standard',
        typeId: 1,
        label: 'Primary',
      },
    );
    expect(toAssociationType({ category: 'USER_DEFINED', typeId: 9, label: null }).category).toBe(
      'user_defined',
    );
    expect(toAssociationType({ category: 'INTEGRATOR_DEFINED', typeId: 9 }).category).toBe(
      'integrator_defined',
    );
    expect(toAssociationType({ category: 'SOME_FUTURE_CATEGORY', typeId: 9 }).category).toBe(
      'other',
    );
    // Inherited object keys are not categories.
    expect(toAssociationType({ category: 'toString', typeId: 9 }).category).toBe('other');
    expect(HsAssociationTypeSchema.safeParse({ category: 'NEW_KIND', typeId: 3 }).success).toBe(
      true,
    );
  });
});
