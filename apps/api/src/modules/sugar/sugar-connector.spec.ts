import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_SUGAR_CREDENTIALS, FakeSugar } from '../../../test/support/fake-sugar';
import { isConnectorError, type SourceRecord } from '../domain';
import { SugarConnector, sugarAdapterFactory } from './application/sugar-connector';
import { assertReadOnlySugarRequest } from './infrastructure/sugar-http';
import { SugarConnectionConfigSchema } from './sugar.config';

const MODULES = ['Accounts', 'Opportunities', 'RevenueLineItems', 'ProductTemplates', 'Users'];
const secret = (value: string) => ({ reveal: () => value });

describe('Sugar adapter against the deterministic fake (no live Sugar)', () => {
  let fake: FakeSugar;
  let delays: number[];

  function connector(
    overrides: Record<string, unknown> = {},
    credentials: string = JSON.stringify(FAKE_SUGAR_CREDENTIALS),
  ): Promise<SugarConnector> {
    const config = SugarConnectionConfigSchema.parse({
      instanceUrl: fake.url,
      apiVersion: fake.version,
      modules: MODULES,
      referenceModules: ['ProductTemplates'],
      pageSize: 200,
      maxRetries: 3,
      ...overrides,
    });
    return Promise.resolve(
      new SugarConnector(config, 'tenant:conn', () => Promise.resolve(secret(credentials)), {
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        random: () => 0.5,
      }),
    );
  }

  beforeEach(async () => {
    delays = [];
    fake = await new FakeSugar({ generatedLines: 1200 }).start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  describe('read-only transport guard', () => {
    it('lets only GET and the OAuth token POST through', () => {
      expect(() => assertReadOnlySugarRequest({ method: 'GET', path: '/Accounts' })).not.toThrow();
      expect(() =>
        assertReadOnlySugarRequest({ method: 'POST', path: '/oauth2/token' }),
      ).not.toThrow();
      for (const [method, path] of [
        ['POST', '/Accounts'],
        ['PUT', '/Accounts/FIX-ACC-001'],
        ['DELETE', '/Accounts/FIX-ACC-001'],
        ['PATCH', '/Accounts'],
        ['GET', '/oauth2/token'],
      ] as const) {
        expect(() => assertReadOnlySugarRequest({ method: method as 'GET', path })).toThrow(
          /read-only/,
        );
      }
    });

    it('refuses paths that are not plain segments (no traversal or encoded tricks)', () => {
      for (const path of [
        '/Accounts/../oauth2/token',
        '/Accounts/%2e%2e',
        '/Accounts?x=1',
        'Accounts',
      ]) {
        expect(() => assertReadOnlySugarRequest({ method: 'GET', path })).toThrow(/plain API path/);
      }
    });

    it('a full read issues only GETs and one token POST against the source', async () => {
      const c = await connector();
      await c.describeSchema();
      let position: string | undefined;
      do {
        const page = await c.readRecords({
          object: 'RevenueLineItems',
          fields: ['account_id'],
          selection: { mode: 'full', boundary: new Date('2030-01-01Z') },
          pageSize: 200,
          ...(position ? { position } : {}),
        });
        position = page.next;
      } while (position);
      expect(Object.keys(fake.methodCounts).sort()).toEqual(['GET', 'POST']);
      expect(fake.methodCounts.POST).toBe(1);
      expect(c.counters).toMatchObject({ tokenPost: 1, refused: 0 });
      expect(c.counters.get).toBe(fake.methodCounts.GET);
    });
  });

  describe('read-only proof through the real connector transport (fake Sugar)', () => {
    it('mutating requests are refused before anything leaves the process; only GET and the token POST reach Sugar', async () => {
      const sent: string[] = [];
      const config = SugarConnectionConfigSchema.parse({
        instanceUrl: fake.url,
        apiVersion: fake.version,
        modules: MODULES,
        referenceModules: ['ProductTemplates'],
        maxRetries: 0,
      });
      // The real transport and connector; fetch is wrapped only to record what goes out.
      const c = new SugarConnector(
        config,
        'tenant:conn',
        () => Promise.resolve(secret(JSON.stringify(FAKE_SUGAR_CREDENTIALS))),
        {
          fetch: (url, init) => {
            sent.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
            return fetch(url, init);
          },
        },
      );
      await expect(c.testConnection()).resolves.toMatchObject({ ok: true }); // token POST + GET /ping
      // The transport's single request pipeline, used by every connector read.
      const request = (
        c as unknown as {
          http: {
            request: (req: { method: string; path: string }, schema: unknown) => Promise<unknown>;
          };
        }
      ).http.request.bind((c as unknown as { http: object }).http);
      const attempts = [
        { method: 'POST', path: '/Accounts' },
        { method: 'POST', path: '/RevenueLineItems/FIX-RLI-001/link/x' },
        { method: 'PUT', path: '/Accounts/FIX-ACC-001' },
        { method: 'PATCH', path: '/Accounts/FIX-ACC-001' },
        { method: 'DELETE', path: '/Accounts/FIX-ACC-001' },
        { method: 'DELETE', path: '/oauth2/token' },
      ];
      const sentBefore = sent.length;
      for (const req of attempts) {
        const err = await request(req, SugarConnectionConfigSchema).catch((e: unknown) => e);
        expect(isConnectorError(err, 'read_only_violation')).toBe(true);
      }
      // Nothing was sent for any refused request, and the source saw no write.
      expect(sent.length).toBe(sentBefore);
      expect(c.counters.refused).toBe(attempts.length);
      expect(fake.methodCounts.PUT ?? 0).toBe(0);
      expect(fake.methodCounts.PATCH ?? 0).toBe(0);
      expect(fake.methodCounts.DELETE ?? 0).toBe(0);
      expect(fake.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
        '/oauth2/token',
      ]);
      expect(
        sent
          .filter((x) => !x.startsWith('GET '))
          .map((x) => x.replace(/^.*\/rest\/[^/]+/, 'POST ')),
      ).toEqual(['POST /oauth2/token']);
      // Reads still work after the refusals.
      await expect(c.readRecord('Accounts', 'FIX-ACC-001', ['name'])).resolves.toMatchObject({
        id: 'FIX-ACC-001',
      });
      expect(Object.keys(fake.methodCounts).sort()).toEqual(['GET', 'POST']);
      expect(fake.methodCounts.POST).toBe(1);
    });
  });

  describe('connection test and credentials (SecretProvider only)', () => {
    it('passes with valid credentials', async () => {
      await expect((await connector()).testConnection()).resolves.toEqual({
        ok: true,
        code: 'ok',
        sourceVersion: fake.version,
      });
    });

    it('reports auth_failed without echoing any credential value', async () => {
      const wrong = JSON.stringify({ ...FAKE_SUGAR_CREDENTIALS, password: 'wrong-password-123' });
      await expect((await connector({}, wrong)).testConnection()).resolves.toEqual({
        ok: false,
        code: 'auth_failed',
      });
      const c = await connector({}, '{"clientId":"sugar","password":"p4ss-not-logged"}');
      const err = await c.describeSchema().catch((e: unknown) => e);
      expect(isConnectorError(err, 'not_configured')).toBe(true);
      expect(String((err as Error).message)).not.toMatch(/p4ss-not-logged/);
      expect(String((err as Error).message)).toMatch(/username/);
      const notJson = await (
        await connector({}, 'plain-secret-value')
      )
        .describeSchema()
        .catch((e: unknown) => e);
      expect(String((notJson as Error).message)).not.toMatch(/plain-secret-value/);
    });

    it('reports unreachable when the source is down', async () => {
      const c = await connector({ maxRetries: 0 });
      await fake.stop();
      await expect(c.testConnection()).resolves.toEqual({ ok: false, code: 'unreachable' });
      await fake.start();
    });

    it('the factory validates config and resolves the named credential only', async () => {
      const factory = sugarAdapterFactory();
      expect(
        factory.validateConfig({
          instanceUrl: 'http://example.com',
          apiVersion: 'v11_20',
          modules: ['A'],
        }),
      ).toMatchObject({ ok: false });
      expect(
        factory.validateConfig({
          instanceUrl: fake.url,
          apiVersion: 'v11_20',
          modules: ['Accounts'],
        }),
      ).toEqual({ ok: true });
      const asked: string[] = [];
      const c = factory.create(
        {
          tenantId: 't',
          tenantSlug: 'acme',
          connectionId: 'c',
          kind: 'sugar',
          config: { instanceUrl: fake.url, apiVersion: fake.version, modules: ['Accounts'] },
          credentialName: 'sugar_api',
        },
        {
          resolveCredential: (name) => {
            asked.push(name);
            return Promise.resolve(secret(JSON.stringify(FAKE_SUGAR_CREDENTIALS)));
          },
        },
      );
      await expect(c.testConnection()).resolves.toMatchObject({ ok: true });
      expect(asked).toEqual(['sugar_api']);
    });
  });

  describe('schema metadata', () => {
    it('normalises fields, relationships, enums, classification and capabilities (metadata only)', async () => {
      const schema = await (await connector()).describeSchema();
      const lines = schema.objects.find((o) => o.name === 'RevenueLineItems')!;
      expect(lines.classification).toBe('record');
      expect(lines.capabilities).toEqual({
        pagination: 'offset',
        changeField: 'date_modified',
        deleteVisibility: 'none',
        count: true,
        maxPageSize: 200,
      });
      expect(lines.fields.find((f) => f.name === 'account_id')).toMatchObject({
        type: 'relate',
        relatesTo: 'Accounts',
      });
      expect(lines.fields.find((f) => f.name === 'id')).toMatchObject({ type: 'id', unique: true });
      expect(
        lines.fields.find((f) => f.name === 'sales_stage')?.enumOptions?.map((o) => o.value),
      ).toContain('Closed Won');
      expect(schema.objects.find((o) => o.name === 'Users')?.classification).toBe(
        'internal_principal',
      );
      expect(schema.objects.find((o) => o.name === 'ProductTemplates')?.classification).toBe(
        'reference',
      );
      // No record values anywhere in the snapshot.
      expect(JSON.stringify(schema)).not.toMatch(/FIX-/);
    });
  });

  describe('bounded reads', () => {
    async function readAll(
      c: SugarConnector,
      selection: Parameters<SugarConnector['readRecords']>[0]['selection'],
      object = 'RevenueLineItems',
    ): Promise<SourceRecord[]> {
      const out: SourceRecord[] = [];
      let position: string | undefined;
      do {
        const page = await c.readRecords({
          object,
          fields: ['account_id', 'sales_stage'],
          selection,
          pageSize: 200,
          ...(position ? { position } : {}),
        });
        out.push(...page.records);
        position = page.next;
      } while (position);
      return out;
    }

    it('reads 1,000+ lines over offset pages in (date_modified, id) order and reconciles with count', async () => {
      const c = await connector();
      const boundary = new Date('2030-01-01Z');
      const records = await readAll(c, { mode: 'full', boundary });
      const count = await c.countRecords({
        object: 'RevenueLineItems',
        selection: { mode: 'full', boundary },
      });
      expect(records.length).toBeGreaterThan(1200);
      expect(records.length).toBe(count);
      const keys = records.map((r) => `${r.modifiedAt!.toISOString()}|${r.id}`);
      expect(keys).toEqual([...keys].sort());
      // Mapped fields only are requested.
      const list = fake.apiRequests().find((r) => r.path === '/RevenueLineItems')!;
      expect(list.query.get('fields')).toBe('id,date_modified,account_id,sales_stage');
      expect(list.query.get('order_by')).toBe('date_modified:ASC,id:ASC');
      // Deleted rows are hidden by default (fixture 14): delete visibility is none.
      expect(records.some((r) => r.id === 'FIX-RLI-120')).toBe(false);
    });

    it('the bounded set excludes records modified after the boundary', async () => {
      const c = await connector();
      const records = await readAll(c, {
        mode: 'full',
        boundary: new Date('2024-12-31T23:59:59Z'),
      });
      expect(records.every((r) => r.modifiedAt! <= new Date('2024-12-31T23:59:59Z'))).toBe(true);
      expect(records.length).toBeGreaterThan(0);
    });

    it('since selections read the window [since, boundary]', async () => {
      const c = await connector();
      const records = await readAll(c, {
        mode: 'since',
        since: new Date('2025-12-01T00:00:00Z'),
        boundary: new Date('2025-12-31T00:00:00Z'),
      });
      expect(records.map((r) => r.id).sort()).toEqual(
        expect.arrayContaining(['FIX-RLI-010', 'FIX-RLI-140', 'FIX-RLI-900']),
      );
      expect(records.every((r) => r.modifiedAt! >= new Date('2025-12-01T00:00:00Z'))).toBe(true);
    });

    it('ids selections read exactly those records (batched reference lookups)', async () => {
      const c = await connector();
      const records = await readAll(
        c,
        { mode: 'ids', ids: ['FIX-ACC-001', 'FIX-ACC-DOES-NOT-EXIST'] },
        'Accounts',
      );
      expect(records.map((r) => r.id)).toEqual(['FIX-ACC-001']);
    });

    it('a mapped field disappearing mid-run fails the page as schema drift', async () => {
      const c = await connector();
      fake.droppedFields.add('sales_stage');
      const err = await readAll(c, { mode: 'full', boundary: new Date('2030-01-01Z') }).catch(
        (e: unknown) => e,
      );
      expect(isConnectorError(err, 'schema_drift')).toBe(true);
    });

    it('reads one record by id (optional capability)', async () => {
      const c = await connector();
      await expect(c.readRecord('Accounts', 'FIX-ACC-001', ['name'])).resolves.toMatchObject({
        id: 'FIX-ACC-001',
        values: { name: 'Fixture Account 1' },
      });
      await expect(c.readRecord('Accounts', 'FIX-ACC-999', ['name'])).resolves.toBeUndefined();
    });

    it('refuses invalid object names, ids and positions before sending', async () => {
      const c = await connector();
      const before = fake.requests.length;
      await expect(
        c.readRecords({
          object: 'Accounts;DROP',
          fields: [],
          selection: { mode: 'full', boundary: new Date() },
          pageSize: 10,
        }),
      ).rejects.toThrow(/Invalid API name/);
      await expect(
        c.readRecords({
          object: 'Accounts',
          fields: [],
          selection: { mode: 'ids', ids: ['a b'] },
          pageSize: 10,
        }),
      ).rejects.toThrow(/Invalid record id/);
      await expect(
        c.readRecords({
          object: 'Accounts',
          fields: [],
          selection: { mode: 'full', boundary: new Date() },
          pageSize: 10,
          position: '-1',
        }),
      ).rejects.toThrow(/Invalid read position/);
      expect(fake.requests.length).toBe(before);
    });
  });

  describe('retries, rate limits and re-authentication', () => {
    it('retries 429 honouring Retry-After, then succeeds', async () => {
      const c = await connector();
      fake.fail({ match: /^GET \/Accounts$/, status: 429, headers: { 'retry-after': '7' } });
      const page = await c.readRecords({
        object: 'Accounts',
        fields: ['name'],
        selection: { mode: 'full', boundary: new Date('2030-01-01Z') },
        pageSize: 50,
      });
      expect(page.records.length).toBe(16);
      expect(delays).toEqual([7000]);
    });

    it('retries 5xx with backoff and gives up after maxRetries', async () => {
      const c = await connector({ maxRetries: 2 });
      fake.fail({ match: /^GET \/Accounts$/, status: 503, times: 5 });
      const err = await c
        .readRecords({
          object: 'Accounts',
          fields: ['name'],
          selection: { mode: 'full', boundary: new Date() },
          pageSize: 10,
        })
        .catch((e: unknown) => e);
      expect(isConnectorError(err, 'server_error')).toBe(true);
      expect((err as { details: { attempts: number } }).details.attempts).toBe(3);
      expect(delays).toHaveLength(2);
    });

    it('does not retry permanent 4xx errors', async () => {
      const c = await connector();
      fake.fail({ match: /^GET \/Accounts$/, status: 403, times: 5 });
      const err = await c
        .readRecords({
          object: 'Accounts',
          fields: ['name'],
          selection: { mode: 'full', boundary: new Date() },
          pageSize: 10,
        })
        .catch((e: unknown) => e);
      expect(isConnectorError(err, 'forbidden')).toBe(true);
      expect(delays).toEqual([]);
    });

    it('re-authenticates once when the access token is rejected (refresh grant first)', async () => {
      const c = await connector();
      await c.testConnection();
      fake.expireTokens();
      await expect(c.testConnection()).resolves.toMatchObject({ ok: true });
      expect(fake.passwordGrants).toBe(1);
      expect(fake.refreshGrants).toBe(1);
    });

    it('concurrent reads share one token grant (single-flight)', async () => {
      const c = await connector();
      await Promise.all([c.testConnection(), c.testConnection(), c.testConnection()]);
      expect(fake.passwordGrants).toBe(1);
    });
  });
});
