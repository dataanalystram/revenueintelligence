import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALL_READ_SCOPES, FakeHubSpot, sampleData } from '../../../../test/support/fake-hubspot';
import { Secret } from '../../../platform/secrets';
import { HubSpotError } from '../errors';
import { loadHubSpotConfig, type HubSpotConfig } from '../hubspot.config';
import {
  assertDateVersionedPath,
  assertReadOnlyRequest,
  HubSpotHttpClient,
  type HubSpotAuth,
} from './http-client';
import { SlidingWindowRateLimiter } from './rate-limiter';
import { HsObjectPageSchema } from './schemas';

const TOKEN = 'pat-eu1-secret-token-value';
const CONTACTS = '/crm/objects/2026-09/contacts';

describe('HubSpotHttpClient', () => {
  let fake: FakeHubSpot;
  let delays: number[];
  let logs: { message: string; context: Record<string, unknown> }[];
  let client: HubSpotHttpClient;
  const auth: HubSpotAuth = { tenantKey: 'tenant-a', token: new Secret(TOKEN) };

  function makeClient(over: Partial<HubSpotConfig> = {}, baseUrl?: string): HubSpotHttpClient {
    const config: HubSpotConfig = {
      ...loadHubSpotConfig({}),
      baseUrl: baseUrl ?? fake.url,
      apiVersion: '2026-09',
      accountInfoApiVersion: '2026-03',
      timeoutMs: 2_000,
      maxRetries: 3,
      requestsPer10s: 90,
      ...over,
    };
    return new HubSpotHttpClient(config, new SlidingWindowRateLimiter(config.requestsPer10s), {
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      logger: { warn: (message, context) => logs.push({ message, context }) },
    });
  }

  const listContacts = (c = client) =>
    c.send({ method: 'GET', path: CONTACTS, query: { limit: '2' } }, HsObjectPageSchema, auth);

  async function rejection(p: Promise<unknown>): Promise<HubSpotError> {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HubSpotError);
    return err as HubSpotError;
  }

  beforeEach(async () => {
    delays = [];
    logs = [];
    fake = await new FakeHubSpot({
      accounts: {
        [TOKEN]: {
          portalId: 123,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
        'token-without-scopes': {
          portalId: 123,
          accountType: 'DEVELOPER_TEST',
          scopes: [],
          leadsEnabled: true,
        },
      },
      ...sampleData(),
    }).start();
    client = makeClient();
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('sends the tenant token as a bearer header and validates the response', async () => {
    const page = await listContacts();
    expect(page.results.map((r) => r.id)).toEqual(['101', '102']);
    expect(page.paging?.next?.after).toBeTruthy();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: 'GET',
      path: CONTACTS,
      query: { limit: '2' },
    });
    expect(fake.requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  describe('read-only guard', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      'refuses %s to a CRM object endpoint before any request is sent',
      async (method) => {
        const err = await rejection(
          client.send({ method: method as 'POST', path: CONTACTS, body: {} }, z.unknown(), auth),
        );
        expect(err.kind).toBe('read_only_violation');
        expect(err.retryable).toBe(false);
        expect(fake.requests).toHaveLength(0);
      },
    );

    it('refuses POST to write-like association and batch paths', () => {
      for (const path of [
        '/crm/associations/2026-09/leads/contacts/batch/create',
        '/crm/objects/2026-09/leads/batch/read',
        '/crm/objects/2026-09/leads/search',
        '/crm/associations/2026-09/leads/contacts/batch/read/extra',
      ]) {
        expect(() => assertReadOnlyRequest({ method: 'POST', path }), path).toThrow(HubSpotError);
      }
    });

    it('allows GET and POST to association batch read only', () => {
      expect(() => assertReadOnlyRequest({ method: 'GET', path: CONTACTS })).not.toThrow();
      expect(() =>
        assertReadOnlyRequest({
          method: 'POST',
          path: '/crm/associations/2026-09/leads/contacts/batch/read',
        }),
      ).not.toThrow();
    });
  });

  describe('historical endpoints from the HubSpot API-usage export', () => {
    // Every endpoint in the Service Key's API-version export (older v3/v4 calls,
    // many of them writes). None may be sent by the connector.
    const EXPORT: readonly [string, string][] = [
      ['DELETE', '/crm/v3/objects/companies/123'],
      ['GET', '/account-info/v3/details'],
      ['GET', '/crm/objects/v4/contacts/123/associations/companies'],
      ['GET', '/crm/objects/v4/deals/123/associations/contacts'],
      ['GET', '/crm/v3/objects/companies'],
      ['GET', '/crm/v3/properties/contacts/email'],
      ['POST', '/crm/objects/v3/deals/batch/create'],
      ['POST', '/crm/v3/objects/companies'],
      ['POST', '/crm/v3/objects/companies/batch/upsert'],
      ['POST', '/crm/v3/objects/contacts/batch/upsert'],
      ['POST', '/crm/v3/objects/contacts/search'],
      ['POST', '/crm/v3/properties/contacts'],
      ['PUT', '/crm/objects/v4/contacts/1/associations/default/companies/2'],
      ['PUT', '/crm/objects/v4/deals/1/associations/default/contacts/2'],
    ];

    it.each(EXPORT)('refuses %s %s before any request is sent', async (method, path) => {
      const err = await rejection(
        client.send({ method: method as 'GET', path }, z.unknown(), auth),
      );
      expect(['read_only_violation', 'unsupported_endpoint']).toContain(err.kind);
      expect(fake.requests).toHaveLength(0);
    });

    it('refuses the same writes on the current 2026-09 API version', () => {
      for (const [method, path] of [
        ['DELETE', '/crm/objects/2026-09/companies/123'],
        ['POST', '/crm/objects/2026-09/companies'],
        ['POST', '/crm/objects/2026-09/deals/batch/create'],
        ['POST', '/crm/objects/2026-09/contacts/batch/upsert'],
        ['POST', '/crm/objects/2026-09/contacts/search'],
        ['POST', '/crm/properties/2026-09/contacts'],
        ['PUT', '/crm/associations/2026-09/contacts/1/companies/2'],
        ['PUT', '/crm/objects/2026-09/contacts/1/associations/default/companies/2'],
      ] as const) {
        expect(
          () => assertReadOnlyRequest({ method: method as 'GET', path }),
          `${method} ${path}`,
        ).toThrow(expect.objectContaining({ kind: 'read_only_violation' }));
      }
    });

    it('refuses legacy (non date-based) read paths', () => {
      for (const path of [
        '/account-info/v3/details',
        '/crm/v3/objects/companies',
        '/crm/v4/associations/contacts/companies/batch/read',
        '/crm/objects/v4/contacts/1/associations/companies',
        '/crm/objects/latest/contacts',
      ]) {
        expect(() => assertDateVersionedPath(path), path).toThrow(
          expect.objectContaining({ kind: 'unsupported_endpoint' }),
        );
      }
      // Dot segments, encoding, queries and fragments must not smuggle a legacy path.
      for (const path of [
        '/crm/objects/2026-09/../../v3/objects/companies',
        '/crm/objects/2026-09/%2e%2e/%2e%2e/v3/objects/companies',
        '/account-info/2026-09/../v3/details',
        '/crm/objects/2026-09/contacts?x=/v3/',
        '/crm/objects/2026-09/contacts#frag',
        '/crm/objects/2026-09//contacts',
      ]) {
        expect(() => assertDateVersionedPath(path), path).toThrow(
          expect.objectContaining({ kind: 'unsupported_endpoint' }),
        );
      }
      expect(() => assertDateVersionedPath('/account-info/2026-03/details')).not.toThrow();
      expect(() => assertDateVersionedPath('/crm/objects/2026-09/leads')).not.toThrow();
    });
  });

  describe('authentication and authorisation (not retried)', () => {
    it('401 → unauthorized, one request, no token in the error', async () => {
      const bad: HubSpotAuth = { tenantKey: 'tenant-a', token: new Secret('wrong-token') };
      const err = await rejection(
        client.send({ method: 'GET', path: CONTACTS }, HsObjectPageSchema, bad),
      );
      expect(err).toMatchObject({ kind: 'unauthorized', details: { status: 401, attempts: 1 } });
      expect(err.retryable).toBe(false);
      expect(fake.requests).toHaveLength(1);
      expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(
        'wrong-token',
      );
    });

    it('403 MISSING_SCOPES → forbidden with the required scopes, not retried', async () => {
      const noScopes: HubSpotAuth = {
        tenantKey: 'tenant-a',
        token: new Secret('token-without-scopes'),
      };
      const err = await rejection(
        client.send({ method: 'GET', path: CONTACTS }, HsObjectPageSchema, noScopes),
      );
      expect(err).toMatchObject({
        kind: 'forbidden',
        details: {
          status: 403,
          category: 'MISSING_SCOPES',
          requiredScopes: ['crm.objects.contacts.read'],
        },
      });
      expect(err.missingScopes).toBe(true);
      expect(fake.requests).toHaveLength(1);
    });

    it('404 → not_found, not retried', async () => {
      const err = await rejection(
        client.send(
          { method: 'GET', path: '/crm/objects/2026-09/contacts/999' },
          z.unknown(),
          auth,
        ),
      );
      expect(err).toMatchObject({
        kind: 'not_found',
        details: { status: 404, category: 'OBJECT_NOT_FOUND' },
      });
      expect(fake.requests).toHaveLength(1);
    });
  });

  describe('rate limits', () => {
    it('429 burst limit → waits for Retry-After, then succeeds', async () => {
      fake.fail({
        match: /contacts$/,
        status: 429,
        headers: { 'retry-after': '2' },
        body: {
          status: 'error',
          message: 'rate limit',
          category: 'RATE_LIMITS',
          policyName: 'TEN_SECONDLY_ROLLING',
        },
      });
      const page = await listContacts();
      expect(page.results).toHaveLength(2);
      expect(delays).toEqual([2_000]);
      expect(fake.requests).toHaveLength(2);
      expect(logs[0]).toMatchObject({
        context: { kind: 'rate_limited', status: 429, policyName: 'TEN_SECONDLY_ROLLING' },
      });
    });

    it('429 daily limit → not retried', async () => {
      fake.fail({
        match: /contacts$/,
        status: 429,
        body: {
          status: 'error',
          message: 'daily limit',
          category: 'RATE_LIMITS',
          policyName: 'DAILY',
        },
      });
      const err = await rejection(listContacts());
      expect(err).toMatchObject({
        kind: 'rate_limited',
        details: { policyName: 'DAILY', attempts: 1 },
      });
      expect(err.retryable).toBe(false);
      expect(fake.requests).toHaveLength(1);
    });

    it('persistent 429 → gives up after 1 + maxRetries attempts', async () => {
      fake.fail({
        match: /contacts$/,
        status: 429,
        body: { policyName: 'TEN_SECONDLY_ROLLING' },
        times: 10,
      });
      const err = await rejection(listContacts());
      expect(err).toMatchObject({ kind: 'rate_limited', details: { attempts: 4 } });
      expect(fake.requests).toHaveLength(4);
      expect(delays).toHaveLength(3);
    });

    it('keeps each tenant within its own request budget', async () => {
      let clock = 0;
      const limiter = new SlidingWindowRateLimiter(
        2,
        10_000,
        () => clock,
        (ms) => {
          clock += ms;
          return Promise.resolve();
        },
      );
      await limiter.acquire('a');
      await limiter.acquire('a');
      await limiter.acquire('b');
      expect(clock).toBe(0);
      await limiter.acquire('a');
      expect(clock).toBeGreaterThanOrEqual(10_000);
      expect(limiter.inWindow('b')).toBe(0);
    });
  });

  describe('server errors and transport failures (retried with backoff)', () => {
    it.each([500, 502, 503, 504])('%i → retried, then succeeds', async (status) => {
      fake.fail({ match: /contacts$/, status, times: 2 });
      const page = await listContacts();
      expect(page.results).toHaveLength(2);
      expect(fake.requests).toHaveLength(3);
      expect(delays).toEqual([375, 750]); // full jitter, random() = 0.5
    });

    it('persistent 5xx → server_error after 1 + maxRetries attempts', async () => {
      fake.fail({ match: /contacts$/, status: 503, times: 10 });
      const err = await rejection(listContacts());
      expect(err).toMatchObject({ kind: 'server_error', details: { status: 503, attempts: 4 } });
      expect(fake.requests).toHaveLength(4);
    });

    it('timeout → retried, then reported as timeout', async () => {
      fake.fail({ match: /contacts$/, status: 200, delayMs: 400, times: 10 });
      const err = await rejection(listContacts(makeClient({ timeoutMs: 100, maxRetries: 1 })));
      expect(err).toMatchObject({ kind: 'timeout', details: { attempts: 2 } });
    });

    it('a response body that stalls after the headers → timeout', async () => {
      fake.fail({ match: /contacts$/, status: 200, stallBodyMs: 400, times: 10 });
      const err = await rejection(listContacts(makeClient({ timeoutMs: 150, maxRetries: 0 })));
      expect(err).toMatchObject({ kind: 'timeout', details: { status: 200, attempts: 1 } });
    });

    it('connection refused → network error, retried', async () => {
      const url = fake.url;
      await fake.stop();
      const err = await rejection(listContacts(makeClient({ maxRetries: 2 }, url)));
      expect(err).toMatchObject({ kind: 'network', details: { attempts: 3 } });
      expect(delays).toHaveLength(2);
    });
  });

  describe('Zod validation at the boundary (not retried)', () => {
    it('a response missing a required field → invalid_payload without echoing values', async () => {
      fake.fail({
        match: /contacts$/,
        status: 200,
        body: { results: [{ properties: { email: 'private.person@school.example' } }] },
      });
      const err = await rejection(listContacts());
      expect(err.kind).toBe('invalid_payload');
      expect(err.message).toContain('results.0.id');
      expect(err.message).not.toContain('private.person');
      expect(fake.requests).toHaveLength(1);
    });

    it('a non-JSON success body → invalid_payload', async () => {
      fake.fail({ match: /contacts$/, status: 200, rawBody: '<html>proxy</html>' });
      const err = await rejection(listContacts());
      expect(err.kind).toBe('invalid_payload');
    });

    it('a non-JSON error body is still classified by status', async () => {
      fake.fail({ match: /contacts$/, status: 502, rawBody: 'Bad gateway', times: 10 });
      const err = await rejection(listContacts(makeClient({ maxRetries: 0 })));
      expect(err).toMatchObject({ kind: 'server_error', details: { status: 502, attempts: 1 } });
    });
  });

  it('never writes the token to logs or errors, across retries', async () => {
    fake.fail({ match: /contacts$/, status: 503, times: 10 });
    const err = await rejection(listContacts());
    const everything = JSON.stringify({
      logs,
      message: err.message,
      details: err.details,
      stack: err.stack,
    });
    expect(logs.length).toBe(3);
    expect(everything).not.toContain(TOKEN);
  });
});
