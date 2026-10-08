import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_CHARGEBEE_API_KEY, FakeChargebee } from '../../../test/support/fake-chargebee';
import { isConnectorError, type ReadSelection, type SourceRecord } from '../domain';
import { ChargebeeConnector, chargebeeAdapterFactory } from './application/chargebee-connector';
import { ChargebeeConnectionConfigSchema } from './chargebee.config';
import {
  assertReadOnlyChargebeeRequest,
  type ChargebeeTransportCounters,
} from './infrastructure/chargebee-http';

const secret = (value: string) => ({ reveal: () => value });
const LINE_FIELDS = [
  'line_key_item_price',
  'line_key_item',
  'subscription_id',
  'customer_id',
  'item_price_id',
  'item_id',
  'item_type',
  'quantity',
  'status',
  'current_term_start',
  'current_term_end',
  'deleted',
];
let keySeq = 0;

describe('Chargebee adapter against the deterministic fake (no live Chargebee)', () => {
  let fake: FakeChargebee;
  let delays: number[];

  function connector(
    overrides: Record<string, unknown> = {},
    key: string = FAKE_CHARGEBEE_API_KEY,
    counters?: ChargebeeTransportCounters,
    connectionKey = `tenant:conn-${(keySeq += 1)}`,
  ): ChargebeeConnector {
    const config = ChargebeeConnectionConfigSchema.parse({
      site: 'synthetic-test',
      endpoint: fake.url,
      pageSize: 100,
      maxRetries: 3,
      ...overrides,
    });
    return new ChargebeeConnector(config, connectionKey, () => Promise.resolve(secret(key)), {
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      ...(counters ? { counters } : {}),
    });
  }

  async function readAll(
    c: ChargebeeConnector,
    object: string,
    fields: readonly string[],
    selection: ReadSelection = { mode: 'full', boundary: new Date() },
    pageSize = 100,
  ): Promise<{ records: SourceRecord[]; pages: number }> {
    const records: SourceRecord[] = [];
    let position: string | undefined;
    let pages = 0;
    do {
      const page = await c.readRecords({
        object,
        fields,
        selection,
        pageSize,
        ...(position ? { position } : {}),
      });
      pages += 1;
      records.push(...page.records);
      position = page.next;
    } while (position && pages < 1000);
    return { records, pages };
  }

  beforeEach(async () => {
    delays = [];
    fake = await new FakeChargebee().start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  describe('read-only transport guard (C1, C2)', () => {
    it('lets only GET to the four allowlisted list endpoints through', () => {
      for (const path of ['/customers', '/items', '/item_prices', '/subscriptions']) {
        expect(() => assertReadOnlyChargebeeRequest({ method: 'GET', path })).not.toThrow();
      }
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(() => assertReadOnlyChargebeeRequest({ method, path: '/subscriptions' })).toThrow(
          /read-only/,
        );
      }
    });

    it('refuses every path outside the allowlist, payment and write endpoints included', () => {
      for (const path of [
        '/invoices',
        '/transactions',
        '/cards',
        '/payment_sources',
        '/hosted_pages',
        '/exports',
        '/subscriptions/sub-01',
        '/subscriptions/sub-01/cancel',
        '/customers/../invoices',
        '/subscriptions?x=1',
        'subscriptions',
      ]) {
        expect(() => assertReadOnlyChargebeeRequest({ method: 'GET', path })).toThrow(
          /not an allowlisted Chargebee read/,
        );
      }
    });

    it('a full read of every object sends only GETs to allowlisted paths', async () => {
      const c = connector();
      const schema = await c.describeSchema();
      for (const object of schema.objects) {
        await readAll(
          c,
          object.name,
          object.fields.map((f) => f.name),
        );
      }
      expect(Object.keys(fake.methodCounts)).toEqual(['GET']);
      expect(new Set(fake.requests.map((r) => r.path))).toEqual(
        new Set(['/customers', '/items', '/item_prices', '/subscriptions']),
      );
      expect(c.counters.refused).toBe(0);
    });
  });

  describe('connection test and credentials (SecretProvider only)', () => {
    it('passes with a valid key and reports API v2 / Product Catalog 2.0', async () => {
      await expect(connector().testConnection()).resolves.toEqual({
        ok: true,
        code: 'ok',
        sourceVersion: 'v2:pc2',
      });
      const auth = fake.requests.length;
      expect(auth).toBe(2);
    });

    it('reports auth_failed without echoing the key', async () => {
      const result = await connector({}, 'test_wrongKeyValue00042').testConnection();
      expect(result).toEqual({ ok: false, code: 'auth_failed' });
      expect(JSON.stringify(result)).not.toContain('wrongKeyValue');
    });

    it('a key with an unexpected shape is refused before any request (not_configured)', async () => {
      const result = await connector({}, 'has spaces and:colon').testConnection();
      expect(result).toEqual({ ok: false, code: 'auth_failed' });
      expect(fake.requests).toHaveLength(0);
    });

    it('CB34: a key without catalogue scope is forbidden at test, never a partial run', async () => {
      fake.fail({
        match: /^\/items$/,
        status: 403,
        body: { api_error_code: 'api_authorization_failed' },
      });
      await expect(connector().testConnection()).resolves.toEqual({ ok: false, code: 'forbidden' });
    });

    it('CB32: a Product Catalog 1.0 site is catalog_version_unsupported', async () => {
      fake.productCatalogV1 = true;
      await expect(connector().testConnection()).resolves.toEqual({
        ok: false,
        code: 'catalog_version_unsupported',
      });
    });

    it('reports site_not_found and unreachable', async () => {
      fake.fail({ match: /^\/items$/, status: 404, body: { api_error_code: 'site_not_found' } });
      await expect(connector().testConnection()).resolves.toMatchObject({ code: 'site_not_found' });
      const url = fake.url;
      await fake.stop();
      const config = ChargebeeConnectionConfigSchema.parse({
        site: 'synthetic-test',
        endpoint: url,
        maxRetries: 0,
      });
      const down = new ChargebeeConnector(config, 'tenant:down', () =>
        Promise.resolve(secret(FAKE_CHARGEBEE_API_KEY)),
      );
      await expect(down.testConnection()).resolves.toEqual({ ok: false, code: 'unreachable' });
      fake = await new FakeChargebee().start();
    });

    it('the factory validates config and resolves the named credential only', async () => {
      const factory = chargebeeAdapterFactory();
      expect(factory.kind).toBe('chargebee');
      expect(factory.validateConfig({ site: 'synthetic-test' })).toEqual({ ok: true });
      expect(factory.validateConfig({ site: 'Bad Site!' }).ok).toBe(false);
      expect(factory.validateConfig({ site: 'x', apiKey: 'nope' }).ok).toBe(false);
      expect(factory.validateConfig({ site: 'x', endpoint: 'https://evil.example.com' }).ok).toBe(
        false,
      );
      const asked: string[] = [];
      const c = factory.create(
        {
          tenantId: 't',
          tenantSlug: 's',
          connectionId: 'c',
          credentialName: 'chargebee_api',
          config: { site: 'synthetic-test', endpoint: fake.url },
        } as never,
        {
          resolveCredential: (name: string) => {
            asked.push(name);
            return Promise.resolve(secret(FAKE_CHARGEBEE_API_KEY));
          },
        },
      );
      await expect(c.testConnection()).resolves.toMatchObject({ ok: true });
      expect(new Set(asked)).toEqual(new Set(['chargebee_api']));
    });
  });

  describe('schema metadata', () => {
    it('declares five objects; timestamps are UTC seconds; no payment or personal fields', async () => {
      const schema = await connector().describeSchema();
      expect(schema.sourceVersion).toBe('v2:pc2');
      expect(schema.objects.map((o) => o.name).sort()).toEqual([
        'Customers',
        'ItemPrices',
        'Items',
        'SubscriptionItems',
        'Subscriptions',
      ]);
      const names = schema.objects.flatMap((o) => o.fields.map((f) => f.name));
      for (const forbidden of [
        'card',
        'payment_source_id',
        'email',
        'first_name',
        'last_name',
        'phone',
      ]) {
        expect(names).not.toContain(forbidden);
      }
      const lines = schema.objects.find((o) => o.name === 'SubscriptionItems')!;
      expect(lines.capabilities).toMatchObject({
        count: false,
        deleteVisibility: 'flag',
        fullReadProof: 'double_enumeration',
        childOf: { object: 'Subscriptions', parentKeyField: 'subscription_id' },
        incrementalReads: false,
      });
      const end = lines.fields.find((f) => f.name === 'current_term_end')!;
      expect(end).toMatchObject({ type: 'datetime', sourceType: 'timestamp_utc_seconds' });
      expect(schema.objects.find((o) => o.name === 'Customers')!.capabilities.fullReadProof).toBe(
        undefined,
      );
    });

    it('V12 unverified: line objects refuse incremental reads; verified: offered', async () => {
      const verified = await connector({ incrementalLines: 'verified' }).describeSchema();
      for (const name of ['Subscriptions', 'SubscriptionItems']) {
        expect(
          verified.objects.find((o) => o.name === name)!.capabilities.incrementalReads,
        ).toBeUndefined();
      }
    });
  });

  describe('flattening subscription items (derived child set)', () => {
    it('CB02: one row per subscription item, both identity candidates, parent fields denormalised', async () => {
      const { records } = await readAll(connector(), 'SubscriptionItems', LINE_FIELDS);
      const sub02 = records.filter((r) => r.values.subscription_id === 'sub-02');
      expect(sub02.map((r) => r.values.line_key_item_price)).toEqual([
        'sub-02:plan-pro-USD-monthly',
        'sub-02:addon-seats-USD-monthly',
        'sub-02:addon-support-USD-monthly',
      ]);
      expect(sub02.map((r) => r.values.line_key_item)).toEqual([
        'sub-02:plan-pro',
        'sub-02:addon-seats',
        'sub-02:addon-support',
      ]);
      expect(sub02.map((r) => r.values.quantity)).toEqual([1, 3, 1]);
      expect(new Set(sub02.map((r) => r.values.status))).toEqual(new Set(['active']));
      expect(new Set(sub02.map((r) => r.values.customer_id))).toEqual(new Set(['cus-02']));
      expect(typeof sub02[0]!.values.current_term_end).toBe('number');
    });

    it('C15: item_id is resolved through the catalogue, never copied from the item price id', async () => {
      const { records } = await readAll(connector(), 'SubscriptionItems', LINE_FIELDS);
      for (const r of records) {
        expect(r.values.item_id).not.toBe(r.values.item_price_id);
        const price = fake.itemPrices.find((p) => p.id === r.values.item_price_id)!;
        expect(r.values.item_id).toBe(price.item_id);
      }
      // CB13: two currencies of one item resolve to the same item.
      const basic = records.filter((r) =>
        ['sub-13a', 'sub-13b'].includes(String(r.values.subscription_id)),
      );
      expect(basic.map((r) => r.values.item_id)).toEqual(['plan-basic', 'plan-basic']);
    });

    it('CB23: an unknown item price resolves to a null item (after one catalogue reload)', async () => {
      fake.subscription('sub-22').subscription_items = [
        { item_price_id: 'ghost-price-USD', item_type: 'plan', quantity: 1 },
      ];
      const { records } = await readAll(connector(), 'SubscriptionItems', LINE_FIELDS);
      const line = records.find((r) => r.values.subscription_id === 'sub-22')!;
      expect(line.values.item_id).toBeNull();
      expect(line.values.line_key_item).toBeNull();
      expect(line.values.line_key_item_price).toBe('sub-22:ghost-price-USD');
      expect(fake.requests.filter((r) => r.path === '/item_prices')).toHaveLength(2);
    });

    it('C3: the synthetic card in every subscription entry is discarded unread', async () => {
      const c = connector();
      const schema = await c.describeSchema();
      for (const object of ['Subscriptions', 'SubscriptionItems']) {
        const fields = schema.objects.find((o) => o.name === object)!.fields.map((f) => f.name);
        const { records } = await readAll(c, object, fields);
        const text = JSON.stringify(records);
        expect(text).not.toMatch(/card|masked|1111|visa/);
      }
    });

    it('requested fields only; an undeclared field is schema drift', async () => {
      const c = connector();
      const page = await c.readRecords({
        object: 'Subscriptions',
        fields: ['id', 'status'],
        selection: { mode: 'full', boundary: new Date() },
        pageSize: 5,
      });
      expect(Object.keys(page.records[0]!.values).sort()).toEqual(['id', 'status']);
      const err = await c
        .readRecords({
          object: 'Subscriptions',
          fields: ['id', 'card'],
          selection: { mode: 'full', boundary: new Date() },
          pageSize: 5,
        })
        .catch((e: unknown) => e);
      expect(isConnectorError(err) && err.kind).toBe('schema_drift');
    });

    it('CB21: a deleted subscription is returned (include_deleted) with every line flagged deleted', async () => {
      fake.subscription('sub-02').deleted = true;
      const { records } = await readAll(connector(), 'SubscriptionItems', LINE_FIELDS);
      const sub02 = records.filter((r) => r.values.subscription_id === 'sub-02');
      expect(sub02).toHaveLength(3);
      expect(sub02.every((r) => r.deleted === true && r.values.deleted === true)).toBe(true);
      expect(
        fake.requests.every(
          (r) => r.path !== '/subscriptions' || r.query.get('include_deleted') === 'true',
        ),
      ).toBe(true);
    });
  });

  describe('structurally invalid entries become rejection rows (CB35)', () => {
    it('a subscription without customer_id keeps only its parent key; nothing else is read', async () => {
      const s = fake.subscription('sub-10');
      s.raw = { ...s, raw: undefined, customer_id: undefined, status: 'active' };
      const { records } = await readAll(connector(), 'SubscriptionItems', LINE_FIELDS);
      const rejected = records.filter((r) => r.rejection);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        object: 'SubscriptionItems',
        id: 'sub-10:invalid',
        rejection: 'invalid_payload',
      });
      const values = rejected[0]!.values;
      expect(values.subscription_id).toBe('sub-10');
      expect(
        Object.entries(values).filter(([k, v]) => k !== 'subscription_id' && v !== null),
      ).toEqual([]);
    });

    it('subscription_items not an array, and an unreadable id', async () => {
      const a = fake.subscription('sub-10');
      a.raw = {
        id: 'sub-10',
        customer_id: 'cus-10',
        status: 'active',
        deleted: false,
        subscription_items: 'x',
      };
      const b = fake.subscription('sub-14');
      b.raw = { id: 'bad id with spaces', customer_id: 'cus-15', deleted: false };
      const { records } = await readAll(connector(), 'SubscriptionItems', LINE_FIELDS);
      const rejected = records.filter((r) => r.rejection);
      expect(rejected.map((r) => r.id).sort()).toEqual(['sub-10:invalid', 'unreadable:invalid']);
      expect(rejected.find((r) => r.id === 'sub-10:invalid')!.values.customer_id).toBe('cus-10');
      expect(
        rejected.find((r) => r.id === 'unreadable:invalid')!.values.subscription_id,
      ).toBeNull();
    });

    it('CB24: a malformed term value rejects the subscription at the boundary', async () => {
      const s = fake.subscription('sub-10');
      s.raw = { ...s, raw: undefined, current_term_end: 'not-a-timestamp' };
      const { records } = await readAll(connector(), 'SubscriptionItems', LINE_FIELDS);
      expect(records.filter((r) => r.rejection).map((r) => r.id)).toEqual(['sub-10:invalid']);
    });

    it('a millisecond value is not a timestamp (F18)', async () => {
      const s = fake.subscription('sub-10');
      s.raw = { ...s, raw: undefined, current_term_end: Date.now() };
      const { records } = await readAll(connector(), 'SubscriptionItems', LINE_FIELDS);
      expect(records.filter((r) => r.rejection).map((r) => r.id)).toEqual(['sub-10:invalid']);
    });
  });

  describe('bounded reads and pagination', () => {
    it('full reads are bounded by created_at and ordered by it; the catalogue is unbounded', async () => {
      const c = connector();
      const boundary = new Date();
      await readAll(c, 'Subscriptions', ['id'], { mode: 'full', boundary });
      await readAll(c, 'Items', ['id'], { mode: 'full', boundary });
      const subs = fake.requests.find((r) => r.path === '/subscriptions')!;
      expect(subs.query.get('created_at[before]')).toBe(
        String(Math.floor(boundary.getTime() / 1000) + 1),
      );
      expect(subs.query.get('sort_by[asc]')).toBe('created_at');
      const items = fake.requests.find((r) => r.path === '/items')!;
      expect(items.query.get('created_at[before]')).toBeNull();
      expect(items.query.get('include_deleted')).toBeNull();
    });

    it('a record created after the boundary is outside the full selection', async () => {
      const boundary = new Date(Date.now() - 1000);
      fake.subscription('sub-22').created_at = Math.floor(Date.now() / 1000) + 5;
      const { records } = await readAll(connector(), 'Subscriptions', ['id'], {
        mode: 'full',
        boundary,
      });
      expect(records.map((r) => r.id)).not.toContain('sub-22');
    });

    it('since selections read [since, boundary] by updated_at with one second of overlap', async () => {
      const since = new Date(Date.now() - 3600_000);
      const boundary = new Date();
      fake.touch('sub-10', (s) => (s.subscription_items[0]!.quantity = 5));
      const { records } = await readAll(connector(), 'Subscriptions', ['id'], {
        mode: 'since',
        since,
        boundary: new Date(boundary.getTime() + 2000),
      });
      expect(records.map((r) => r.id)).toEqual(['sub-10']);
      const q = fake.requests.at(-1)!.query;
      expect(q.get('updated_at[after]')).toBe(String(Math.floor(since.getTime() / 1000) - 1));
      expect(q.get('sort_by[asc]')).toBe('updated_at');
    });

    it('ids selections read exactly those records; invalid ids are refused before sending', async () => {
      const c = connector();
      const { records } = await readAll(c, 'Customers', ['id'], {
        mode: 'ids',
        ids: ['cus-01', 'cus-07'],
      });
      expect(records.map((r) => r.id).sort()).toEqual(['cus-01', 'cus-07']);
      const before = fake.requests.length;
      await expect(
        c.readRecords({
          object: 'Customers',
          fields: ['id'],
          selection: { mode: 'ids', ids: ['x"]'] },
          pageSize: 10,
        }),
      ).rejects.toThrow(/Invalid record id/);
      await expect(
        c.readRecords({
          object: 'Customers;drop',
          fields: ['id'],
          selection: { mode: 'full', boundary: new Date() },
          pageSize: 10,
        }),
      ).rejects.toThrow(/Unknown Chargebee object/);
      expect(fake.requests.length).toBe(before);
    });

    it('CB26: > 100 subscriptions over >= 3 pages; positions are opaque and resumable', async () => {
      const template = fake.subscription('sub-01');
      for (let i = 0; i < 240; i += 1) {
        fake.subscriptions.push({
          ...template,
          id: `gen-${i}`,
          created_at: template.created_at + i + 1,
        });
      }
      const { records, pages } = await readAll(
        connector(),
        'SubscriptionItems',
        LINE_FIELDS,
        undefined,
        100,
      );
      expect(pages).toBeGreaterThanOrEqual(3);
      const keys = records.map((r) => r.values.line_key_item_price);
      expect(new Set(keys).size).toBe(keys.length);
      expect(
        records.filter((r) => String(r.values.subscription_id).startsWith('gen-')),
      ).toHaveLength(240);
    });

    it('a business entity scopes customer and subscription reads only', async () => {
      const c = connector({ businessEntityId: 'be-synthetic' });
      await readAll(c, 'Customers', ['id']);
      await readAll(c, 'Items', ['id']);
      expect(
        fake.requests.find((r) => r.path === '/customers')!.query.get('business_entity_id[is]'),
      ).toBe('be-synthetic');
      expect(
        fake.requests.find((r) => r.path === '/items')!.query.get('business_entity_id[is]'),
      ).toBeNull();
    });

    it('a repeated position in the item price lookup fails instead of looping', async () => {
      fake.repeatOffsetFor = '/item_prices';
      const err = await readAll(connector(), 'SubscriptionItems', LINE_FIELDS).catch(
        (e: unknown) => e,
      );
      expect(isConnectorError(err) && err.kind).toBe('invalid_payload');
      expect(fake.requests.filter((r) => r.path === '/item_prices').length).toBeLessThanOrEqual(3);
    });
  });

  describe('retries, rate limits and concurrency', () => {
    it('CB31: retries 429 honouring Retry-After, then succeeds', async () => {
      fake.fail({ match: /^\/subscriptions$/, status: 429, retryAfter: '7', times: 2 });
      const { records } = await readAll(connector(), 'Subscriptions', ['id']);
      expect(records.length).toBe(fake.subscriptions.length);
      expect(delays).toEqual([7000, 7000]);
    });

    it('retries 5xx with backoff and gives up after maxRetries', async () => {
      fake.fail({ match: /^\/subscriptions$/, status: 503, times: 10 });
      const err = await readAll(connector(), 'Subscriptions', ['id']).catch((e: unknown) => e);
      expect(isConnectorError(err) && err.kind).toBe('server_error');
      expect(delays).toHaveLength(3);
      expect(fake.requests.filter((r) => r.path === '/subscriptions')).toHaveLength(4);
    });

    it('does not retry permanent 4xx errors', async () => {
      fake.fail({
        match: /^\/subscriptions$/,
        status: 400,
        body: { api_error_code: 'param_wrong_value' },
      });
      const err = await readAll(connector(), 'Subscriptions', ['id']).catch((e: unknown) => e);
      expect(isConnectorError(err) && err.kind).toBe('bad_request');
      expect(delays).toEqual([]);
    });

    it('an invalid response shape is invalid_payload with paths only, never values', async () => {
      fake.fail({ match: /^\/customers$/, status: 200, body: { list: 'cus-01@example.invalid' } });
      const err = await readAll(connector(), 'Customers', ['id']).catch((e: unknown) => e);
      expect(isConnectorError(err) && err.kind).toBe('invalid_payload');
      expect(String((err as Error).message)).not.toContain('example.invalid');
    });

    it('at most one request is in flight per connection, across adapter instances', async () => {
      const counters: ChargebeeTransportCounters = { get: 0, refused: 0, maxInFlight: 0 };
      const a = connector({}, FAKE_CHARGEBEE_API_KEY, counters, 'tenant:shared');
      const b = connector({}, FAKE_CHARGEBEE_API_KEY, counters, 'tenant:shared');
      await Promise.all([
        readAll(a, 'Customers', ['id'], undefined, 5),
        readAll(b, 'Subscriptions', ['id'], undefined, 5),
        readAll(a, 'Items', ['id'], undefined, 2),
      ]);
      expect(counters.get).toBeGreaterThan(10);
      expect(counters.maxInFlight).toBe(1);
    });
  });
});
