/**
 * A deterministic local fake of the Chargebee API v2 list endpoints the
 * Chargebee adapter uses (M9B plan §21), for tests and runtime verification.
 * Shapes follow Chargebee's official SDK types and API reference (Product
 * Catalog 2.0); they are NOT evidence of how a real site behaves
 * (LIVE CHARGEBEE VERIFICATION: see the M9B record, V2-V12).
 *
 * Endpoints (under /api/v2): GET /customers, /items, /item_prices,
 * /subscriptions with `limit`, opaque `offset`, `include_deleted`,
 * `created_at[before]`, `updated_at[after|before]`, `sort_by[asc]`, `id[in]`.
 * HTTP Basic with the API key as username. Any other method is answered 405
 * and counted (tests prove the adapter never writes); any other path 404.
 * All data is synthetic. Every list entry of `/subscriptions` also carries a
 * synthetic `card` object, so tests can prove the adapter drops it unread.
 *
 * Fault injection: status / Retry-After per path, a Product Catalog 1.0 site,
 * a repeated `next_offset`, malformed subscription entries, and a hook after
 * each list page (inserts between enumeration passes).
 *
 * Self-contained (node: built-ins only, erasable type syntax only):
 *   node apps/api/test/support/fake-chargebee.ts --port 0
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** Synthetic fake key (not a credential of any real site). */
export const FAKE_CHARGEBEE_API_KEY = 'test_fakeChargebeeReadOnlyKey0001';

export interface FakeCbCustomer {
  id: string;
  company?: string;
  first_name?: string;
  email?: string;
  created_at: number;
  updated_at: number;
  resource_version: number;
  deleted: boolean;
}
export interface FakeCbItem {
  id: string;
  name: string;
  type: 'plan' | 'addon' | 'charge';
  status: 'active' | 'archived' | 'deleted';
  item_family_id?: string;
  updated_at: number;
}
export interface FakeCbItemPrice {
  id: string;
  item_id: string;
  item_type: 'plan' | 'addon' | 'charge';
  status: 'active' | 'archived' | 'deleted';
  currency_code: string;
  period?: number;
  period_unit?: string;
  pricing_model: string;
  updated_at: number;
}
export interface FakeCbSubscriptionItem {
  item_price_id: string;
  item_type: string;
  quantity?: number;
}
export interface FakeCbSubscription {
  id: string;
  customer_id: string;
  status: string;
  started_at?: number;
  current_term_start?: number;
  current_term_end?: number;
  trial_end?: number;
  cancelled_at?: number;
  next_billing_at?: number;
  created_at: number;
  updated_at: number;
  resource_version: number;
  deleted: boolean;
  subscription_items: FakeCbSubscriptionItem[];
  /** Raw replacement of the whole entry (malformed-payload scenarios). */
  raw?: unknown;
}

export interface FakeCbFault {
  /** Matches the resource path, e.g. `/subscriptions`. */
  match: RegExp;
  status: number;
  body?: unknown;
  retryAfter?: string;
  times?: number;
}

export interface FakeCbRequest {
  method: string;
  path: string;
  query: URLSearchParams;
}

const DAY = 86_400;

/** Seconds, relative to now (terms must be in force at evaluation time). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The default synthetic dataset (CB scenarios; ids are synthetic). Items:
 * two plans, two add-ons, a one-off charge, an ignored legacy add-on.
 */
export function defaultDataset(now = nowSeconds()) {
  const t0 = now - 400 * DAY;
  const items: FakeCbItem[] = [
    { id: 'plan-basic', name: 'Basic', type: 'plan', status: 'active', updated_at: t0 },
    { id: 'plan-pro', name: 'Pro', type: 'plan', status: 'active', updated_at: t0 },
    { id: 'addon-seats', name: 'Seats', type: 'addon', status: 'active', updated_at: t0 },
    { id: 'addon-support', name: 'Support', type: 'addon', status: 'active', updated_at: t0 },
    { id: 'charge-setup', name: 'Setup', type: 'charge', status: 'active', updated_at: t0 },
    { id: 'addon-legacy', name: 'Legacy', type: 'addon', status: 'archived', updated_at: t0 },
  ];
  const price = (
    id: string,
    item: FakeCbItem,
    currency: string,
    unit: string | undefined,
  ): FakeCbItemPrice => ({
    id,
    item_id: item.id,
    item_type: item.type,
    status: 'active',
    currency_code: currency,
    ...(unit ? { period: 1, period_unit: unit } : {}),
    pricing_model: unit ? 'per_unit' : 'flat_fee',
    updated_at: t0,
  });
  const [basic, pro, seats, support, setup, legacy] = items as [
    FakeCbItem,
    FakeCbItem,
    FakeCbItem,
    FakeCbItem,
    FakeCbItem,
    FakeCbItem,
  ];
  const itemPrices: FakeCbItemPrice[] = [
    price('plan-basic-USD-monthly', basic, 'USD', 'month'),
    price('plan-basic-USD-yearly', basic, 'USD', 'year'),
    price('plan-basic-EUR-monthly', basic, 'EUR', 'month'),
    price('plan-pro-USD-monthly', pro, 'USD', 'month'),
    price('addon-seats-USD-monthly', seats, 'USD', 'month'),
    price('addon-support-USD-monthly', support, 'USD', 'month'),
    price('charge-setup-USD', setup, 'USD', undefined),
    price('addon-legacy-USD-monthly', legacy, 'USD', 'month'),
  ];
  const customers: FakeCbCustomer[] = [];
  const subscriptions: FakeCbSubscription[] = [];
  const customer = (id: string, offsetDays: number): FakeCbCustomer => {
    const c: FakeCbCustomer = {
      id,
      company: `Synthetic Co ${id}`,
      first_name: 'Synthetic',
      email: `${id}@example.invalid`,
      created_at: t0 + offsetDays * DAY,
      updated_at: t0 + offsetDays * DAY,
      resource_version: (t0 + offsetDays * DAY) * 1000,
      deleted: false,
    };
    customers.push(c);
    return c;
  };
  const sub = (
    id: string,
    customerId: string,
    status: string,
    lines: Array<[string, string, number?]>,
    extra: Partial<FakeCbSubscription> = {},
  ): void => {
    const created = t0 + (subscriptions.length + 1) * DAY;
    subscriptions.push({
      id,
      customer_id: customerId,
      status,
      started_at: now - 100 * DAY,
      current_term_start: now - 10 * DAY,
      current_term_end: now + 20 * DAY,
      next_billing_at: now + 20 * DAY,
      created_at: created,
      updated_at: created,
      resource_version: created * 1000,
      deleted: false,
      subscription_items: lines.map(([priceId, type, quantity]) => ({
        item_price_id: priceId,
        item_type: type,
        ...(quantity !== undefined ? { quantity } : {}),
      })),
      ...extra,
    });
  };
  for (let i = 1; i <= 23; i += 1) customer(`cus-${String(i).padStart(2, '0')}`, i);
  sub('sub-01', 'cus-01', 'active', [['plan-basic-USD-monthly', 'plan', 1]]); // CB01
  sub('sub-02', 'cus-02', 'active', [
    ['plan-pro-USD-monthly', 'plan', 1],
    ['addon-seats-USD-monthly', 'addon', 3],
    ['addon-support-USD-monthly', 'addon', 1],
  ]); // CB02
  sub('sub-03a', 'cus-03', 'active', [['plan-basic-USD-monthly', 'plan', 1]]); // CB03
  sub('sub-03b', 'cus-03', 'active', [['plan-basic-USD-monthly', 'plan', 1]]); // CB03
  sub('sub-04', 'cus-04', 'in_trial', [['plan-pro-USD-monthly', 'plan', 1]], {
    trial_end: now + 10 * DAY,
  }); // CB04
  sub('sub-05', 'cus-05', 'future', [['plan-basic-USD-monthly', 'plan', 1]], {
    current_term_start: now + 5 * DAY,
    current_term_end: now + 35 * DAY,
  }); // CB05
  sub('sub-06', 'cus-06', 'non_renewing', [['plan-basic-USD-monthly', 'plan', 1]]); // CB06
  sub('sub-07', 'cus-07', 'cancelled', [['plan-basic-USD-monthly', 'plan', 1]], {
    cancelled_at: now - 5 * DAY,
    current_term_start: now - 35 * DAY,
    current_term_end: now - 5 * DAY,
  }); // CB07
  sub('sub-08', 'cus-08', 'paused', [['plan-basic-USD-monthly', 'plan', 1]]); // CB08
  sub('sub-09', 'cus-09', 'transferred', [['plan-basic-USD-monthly', 'plan', 1]]); // CB09
  sub('sub-10', 'cus-10', 'active', [['plan-basic-USD-monthly', 'plan', 1]]); // CB10/11/12
  sub('sub-13a', 'cus-13', 'active', [['plan-basic-USD-monthly', 'plan', 1]]); // CB13 USD
  sub('sub-13b', 'cus-14', 'active', [['plan-basic-EUR-monthly', 'plan', 1]]); // CB13 EUR
  sub('sub-14', 'cus-15', 'active', [['plan-basic-USD-monthly', 'plan', 1]]); // CB14 upgrade
  sub('sub-15', 'cus-16', 'active', [
    ['plan-basic-USD-monthly', 'plan', 1],
    ['addon-seats-USD-monthly', 'addon', 2],
  ]); // CB15 add-on removal
  sub('sub-16', 'cus-17', 'active', [
    ['plan-basic-USD-monthly', 'plan', 1],
    ['charge-setup-USD', 'charge', 1],
  ]); // CB16
  sub('sub-18', 'cus-18', 'active', [
    ['plan-basic-USD-monthly', 'plan', 1],
    ['addon-legacy-USD-monthly', 'addon', 1],
  ]); // CB18
  sub('sub-19', 'cus-404', 'active', [['plan-basic-USD-monthly', 'plan', 1]]); // CB19
  sub('sub-22', 'cus-22', 'active', [['plan-pro-USD-monthly', 'plan', 1]]); // CB22
  return { customers, items, itemPrices, subscriptions };
}

const encodeOffset = (i: number) => Buffer.from(JSON.stringify({ i }), 'utf8').toString('base64');
function decodeOffset(offset: string | null): number {
  if (!offset) return 0;
  try {
    const value = JSON.parse(Buffer.from(offset, 'base64').toString('utf8')) as { i?: unknown };
    return typeof value.i === 'number' && value.i >= 0 ? value.i : -1;
  } catch {
    return -1;
  }
}

export class FakeChargebee {
  customers: FakeCbCustomer[];
  items: FakeCbItem[];
  itemPrices: FakeCbItemPrice[];
  subscriptions: FakeCbSubscription[];
  readonly requests: FakeCbRequest[] = [];
  readonly faults: FakeCbFault[] = [];
  readonly methodCounts: Record<string, number> = {};
  apiKey: string;
  /** Product Catalog 1.0 site: `/items` answers 400 configuration_incompatible. */
  productCatalogV1 = false;
  /** Answer every list page of this path with the same `next_offset` (non-progress). */
  repeatOffsetFor: string | undefined;
  /** Return deleted records even without `include_deleted` (defensive-filter tests). */
  alwaysIncludeDeleted = false;
  /** Called after each list page is served (e.g. insert a record between passes). */
  afterListPage: ((path: string, offset: number) => void) | undefined;
  private server: Server | undefined;

  constructor(options: { apiKey?: string } = {}) {
    const data = defaultDataset();
    this.customers = data.customers;
    this.items = data.items;
    this.itemPrices = data.itemPrices;
    this.subscriptions = data.subscriptions;
    this.apiKey = options.apiKey ?? FAKE_CHARGEBEE_API_KEY;
  }

  get url(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('fake Chargebee is not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => {
      try {
        this.handle(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r));
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }

  fail(fault: FakeCbFault): void {
    this.faults.push({ times: 1, ...fault });
  }

  subscription(id: string): FakeCbSubscription {
    const s = this.subscriptions.find((x) => x.id === id);
    if (!s) throw new Error(`no fake subscription ${id}`);
    return s;
  }

  /** Applies a change to a subscription and moves its `updated_at` (V12 assumed in the fake). */
  touch(id: string, change: (s: FakeCbSubscription) => void): void {
    const s = this.subscription(id);
    change(s);
    s.updated_at = Math.max(s.updated_at + 1, nowSeconds());
    s.resource_version = s.updated_at * 1000 + 1;
  }

  private send(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    this.methodCounts[method] = (this.methodCounts[method] ?? 0) + 1;
    if (!url.pathname.startsWith('/api/v2/'))
      return this.send(res, 404, { api_error_code: 'resource_not_found' });
    const path = url.pathname.slice('/api/v2'.length);
    this.requests.push({ method, path, query: url.searchParams });
    if (method !== 'GET') return this.send(res, 405, { api_error_code: 'method_not_allowed' });
    const auth = req.headers.authorization ?? '';
    const expected = `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`;
    if (auth !== expected) {
      return this.send(res, 401, { api_error_code: 'api_authentication_failed' });
    }
    const fault = this.faults.find((f) => (f.times ?? 1) > 0 && f.match.test(path));
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      return this.send(
        res,
        fault.status,
        fault.body ?? { api_error_code: 'fault' },
        fault.retryAfter ? { 'retry-after': fault.retryAfter } : {},
      );
    }
    if (this.productCatalogV1 && (path === '/items' || path === '/item_prices')) {
      return this.send(res, 400, { api_error_code: 'configuration_incompatible' });
    }
    switch (path) {
      case '/customers':
        return this.list(res, path, url.searchParams, this.customers, (c) => ({
          customer: c,
        }));
      case '/items':
        return this.list(res, path, url.searchParams, this.items, (i) => ({ item: i }));
      case '/item_prices':
        return this.list(res, path, url.searchParams, this.itemPrices, (p) => ({
          item_price: p,
        }));
      case '/subscriptions':
        return this.list(res, path, url.searchParams, this.subscriptions, (s) => {
          const { raw, ...rest } = s;
          return {
            subscription: raw ?? rest,
            customer: this.customers.find((c) => c.id === s.customer_id) ?? null,
            // Synthetic payment data the adapter must never read.
            card: { status: 'valid', masked_number: '************1111', card_type: 'visa' },
          };
        });
      default:
        return this.send(res, 404, { api_error_code: 'resource_not_found' });
    }
  }

  private list<
    T extends { id: string; created_at?: number; updated_at: number; deleted?: boolean },
  >(
    res: ServerResponse,
    path: string,
    q: URLSearchParams,
    rows: T[],
    wrap: (row: T) => unknown,
  ): void {
    const limit = Number(q.get('limit') ?? '10');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return this.send(res, 400, { api_error_code: 'param_wrong_value' });
    }
    const offset = decodeOffset(q.get('offset'));
    if (offset < 0) return this.send(res, 400, { api_error_code: 'param_wrong_value' });
    let out = rows.filter(
      (r) => this.alwaysIncludeDeleted || q.get('include_deleted') === 'true' || !r.deleted,
    );
    const createdBefore = q.get('created_at[before]');
    if (createdBefore) out = out.filter((r) => (r.created_at ?? 0) < Number(createdBefore));
    const updatedAfter = q.get('updated_at[after]');
    if (updatedAfter) out = out.filter((r) => r.updated_at > Number(updatedAfter));
    const updatedBefore = q.get('updated_at[before]');
    if (updatedBefore) out = out.filter((r) => r.updated_at < Number(updatedBefore));
    const ids = q.get('id[in]');
    if (ids) {
      const wanted = JSON.parse(ids) as string[];
      out = out.filter((r) => wanted.includes(r.id));
    }
    const sort = q.get('sort_by[asc]');
    if (sort === 'updated_at') {
      out = [...out].sort((a, b) => a.updated_at - b.updated_at || a.id.localeCompare(b.id));
    } else if (sort === 'created_at') {
      out = [...out].sort(
        (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.id.localeCompare(b.id),
      );
    }
    const page = out.slice(offset, offset + limit);
    const more = offset + page.length < out.length;
    const nextOffset =
      this.repeatOffsetFor === path
        ? encodeOffset(Math.max(offset, 1))
        : more
          ? encodeOffset(offset + page.length)
          : undefined;
    this.send(res, 200, {
      list: page.map(wrap),
      ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
    });
    this.afterListPage?.(path, offset);
  }
}

// Standalone: `node apps/api/test/support/fake-chargebee.ts --port 0`
if (process.argv[1]?.endsWith('fake-chargebee.ts')) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const fake = new FakeChargebee();
  // Paths only: proves read-only behaviour in runtime checks.
  void fake.start(Number(arg('port') ?? 0)).then(() => {
    process.stdout.write(`fake Chargebee listening on ${fake.url}\n`);
  });
  const stop = (): void => {
    for (const r of fake.requests) process.stdout.write(`request ${r.method} ${r.path}\n`);
    void fake.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
