/**
 * A deterministic local fake of the SugarCRM REST endpoints the Sugar adapter
 * uses (M8, plan §29), for tests and runtime verification. Built from the
 * sanitized discovery fixtures (fixtures/sugarcrm/sanitized, verbatim) and the
 * synthetic companion fixtures (test/fixtures/sugar). Its endpoint shapes
 * follow the historical client and current documentation; they are NOT
 * evidence of how the customer's Sugar behaves (LIVE SUGAR VERIFICATION:
 * PENDING).
 *
 * Endpoints (under /rest/{version}): POST /oauth2/token (password and
 * refresh grants), GET /ping, GET /{Module}/fields, GET /{Module} (filter,
 * order_by, max_num, offset, fields), GET /{Module}/count, GET /{Module}/{id}.
 * Any other method is answered 405 and counted, so tests can prove the
 * adapter never writes. Fault injection: status/Retry-After/delays, schema
 * variants, a field disappearing mid-run, records modified during a read.
 *
 * Self-contained (node: built-ins only, no TypeScript-only runtime syntax) so
 * Node can run it directly:
 *   node apps/api/test/support/fake-sugar.ts --port 0 --version v11_20
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

export type FakeValue = string | number | boolean | null;
export type FakeSugarRecord = Record<string, FakeValue>;

export interface FakeSugarFault {
  /** Matches `${method} ${pathname}` (pathname below /rest/{version}). */
  match: RegExp;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  /** How many matching requests to fail (default 1). */
  times?: number;
  when?: (entry: FakeSugarRequestLog) => boolean;
}

export interface FakeSugarRequestLog {
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | undefined;
}

export interface FakeSugarCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface FakeSugarOptions {
  version?: string;
  credentials?: FakeSugarCredentials;
  /** Access-token lifetime in seconds. */
  tokenLifetimeSeconds?: number;
  /** Include the unmodelled-product companion line (C2). */
  includeUnmodelledProduct?: boolean;
  /** Serve rows flagged `deleted` (Sugar hides them by default; LIVE). */
  serveDeleted?: boolean;
  /** Extra generated lines (C4 pagination), seeded. */
  generatedLines?: number;
  /** Disable the count endpoint (404), as a tenant without it would. */
  countEndpoint?: boolean;
}

export const FAKE_SUGAR_CREDENTIALS: FakeSugarCredentials = {
  clientId: 'sugar',
  clientSecret: '',
  username: 'fixture-reader',
  password: 'fixture-only-password',
};

/** Runs from apps/api (tests) or the repository root (runtime scripts). */
const API_DIR = existsSync(resolve(process.cwd(), 'test/fixtures/sugar'))
  ? process.cwd()
  : resolve(process.cwd(), 'apps/api');
const DISCOVERY = resolve(API_DIR, '../../fixtures/sugarcrm/sanitized');
const COMPANION = resolve(API_DIR, 'test/fixtures/sugar');

function readCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, 'utf8');
  if (text.includes('"')) throw new Error(`quoted CSV not supported: ${path}`);
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = (header ?? '').split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    if (cells.length !== columns.length) throw new Error(`ragged row in ${path}`);
    const row: Record<string, string> = {};
    columns.forEach((c, i) => {
      row[c] = cells[i] ?? '';
    });
    return row;
  });
}

/** CSV fixture row → the value types Sugar's API returns (LIVE: exact types). */
function apiRecord(row: Record<string, string>): FakeSugarRecord {
  const out: FakeSugarRecord = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === 'True' || v === 'False') out[k] = v === 'True';
    else if (k === 'date_modified' || k === 'date_entered')
      out[k] = v ? `${v}T00:00:00+00:00` : null;
    else out[k] = v === '' ? null : v;
  }
  return out;
}

/** A small deterministic PRNG (mulberry32) for generated pages. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The default dataset: discovery fixtures + companions (+ optional C2/C4). */
export function fixtureDataset(options: FakeSugarOptions = {}): Map<string, FakeSugarRecord[]> {
  const data = new Map<string, FakeSugarRecord[]>();
  const lines: FakeSugarRecord[] = [];
  const opportunities: FakeSugarRecord[] = [];
  for (let i = 1; i <= 16; i += 1) {
    const no = String(i).padStart(2, '0');
    const file = readdirFixture(no);
    const rows = readCsv(resolve(DISCOVERY, file)).map(apiRecord);
    if (no === '09') opportunities.push(...rows);
    else lines.push(...rows);
  }
  lines.push(...readCsv(resolve(COMPANION, 'rli_companion.csv')).map(apiRecord));
  if (options.includeUnmodelledProduct) {
    lines.push(...readCsv(resolve(COMPANION, 'rli_unmodelled_product.csv')).map(apiRecord));
  }
  const random = prng(20261003);
  for (let n = 0; n < (options.generatedLines ?? 0); n += 1) {
    const day = 1 + Math.floor(random() * 28);
    lines.push({
      id: `FIX-RLI-G${String(n).padStart(5, '0')}`,
      name: `Generated Line ${n}`,
      account_id: `FIX-ACC-${String(1 + (n % 15)).padStart(3, '0')}`,
      opportunity_id: 'FIX-OPP-001',
      product_template_id: 'FIX-PROD-001',
      quantity: '1',
      sales_stage: 'Closed Won',
      status: null,
      renewal: false,
      renewal_rli_id: null,
      recurring_one_off_c: 'Recurring',
      service: true,
      service_start_date: '2026-01-01',
      service_end_date: '2026-12-31',
      date_closed: '2025-12-01',
      date_entered: '2025-12-01T00:00:00+00:00',
      date_modified: `2025-11-${String(day).padStart(2, '0')}T${String(n % 24).padStart(2, '0')}:00:00+00:00`,
      deleted: false,
      mrr_c: '10.00',
    });
  }
  opportunities.push(...readCsv(resolve(COMPANION, 'opportunities.csv')).map(apiRecord));
  data.set('RevenueLineItems', lines);
  data.set('Opportunities', opportunities);
  data.set('Accounts', readCsv(resolve(COMPANION, 'accounts.csv')).map(apiRecord));
  data.set('ProductTemplates', readCsv(resolve(COMPANION, 'product_templates.csv')).map(apiRecord));
  data.set('Users', readCsv(resolve(COMPANION, 'users.csv')).map(apiRecord));
  data.set('Contacts', []);
  return data;
}

function readdirFixture(no: string): string {
  const names = [
    '01_normal_case.csv',
    '02_several_products.csv',
    '03_multiple_lines_same_product.csv',
    '04_renewal.csv',
    '05_expired_plus_active_renewal.csv',
    '06_cancelled.csv',
    '07_unknown_status.csv',
    '08_future_dated_line.csv',
    '09_orphan_opportunity.csv',
    '10_orphan_product.csv',
    '11_duplicate_source_line.csv',
    '12_missing_product_id.csv',
    '13_conflicting_dates.csv',
    '14_deleted_tombstoned_record.csv',
    '15_one_time_product_line.csv',
    '16_recurring_product_line.csv',
  ];
  const name = names.find((n) => n.startsWith(`${no}_`));
  if (!name) throw new Error(`no fixture ${no}`);
  return name;
}

type FieldsDoc = Record<string, { fields: Record<string, Record<string, unknown>> }>;

export class FakeSugar {
  readonly version: string;
  readonly data: Map<string, FakeSugarRecord[]>;
  readonly requests: FakeSugarRequestLog[] = [];
  readonly faults: FakeSugarFault[] = [];
  /** Counts by method; anything but GET and the token POST is a write attempt. */
  readonly methodCounts: Record<string, number> = {};
  fields: FieldsDoc;
  credentials: FakeSugarCredentials;
  tokenLifetimeSeconds: number;
  serveDeleted: boolean;
  countEndpoint: boolean;
  passwordGrants = 0;
  refreshGrants = 0;
  /** Called once per request with the method and path (never tokens, bodies or values). */
  onRequest: ((method: string, path: string) => void) | undefined;
  /** Called after each list page is served (e.g. modify a record mid-read). */
  afterListPage: ((module: string, offset: number) => void) | undefined;
  /** Fields omitted from list responses (drift mid-run). */
  readonly droppedFields = new Set<string>();
  private server: Server | undefined;
  private readonly tokens = new Map<string, number>();
  private readonly refreshTokens = new Set<string>();
  private tokenSeq = 0;

  constructor(options: FakeSugarOptions = {}) {
    this.version = options.version ?? 'v11_20';
    this.credentials = options.credentials ?? FAKE_SUGAR_CREDENTIALS;
    this.tokenLifetimeSeconds = options.tokenLifetimeSeconds ?? 3600;
    this.serveDeleted = options.serveDeleted ?? false;
    this.countEndpoint = options.countEndpoint ?? true;
    this.data = fixtureDataset(options);
    this.fields = JSON.parse(
      readFileSync(resolve(COMPANION, 'fields-v1.json'), 'utf8'),
    ) as FieldsDoc;
  }

  get url(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('fake Sugar is not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r));
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }

  fail(fault: FakeSugarFault): void {
    this.faults.push({ times: 1, ...fault });
  }

  /** Schema variants (C3): remove a field, change its type, add an enum option. */
  removeField(module: string, field: string): void {
    delete this.fields[module]!.fields[field];
  }

  setFieldType(module: string, field: string, type: string): void {
    this.fields[module]!.fields[field]!.type = type;
  }

  addEnumOption(module: string, field: string, value: string): void {
    const def = this.fields[module]!.fields[field]!;
    def.options = { ...(def.options as Record<string, string>), [value]: value };
  }

  upsert(module: string, record: FakeSugarRecord): void {
    const rows = this.data.get(module) ?? [];
    const i = rows.findIndex((r) => r.id === record.id);
    if (i >= 0) rows[i] = { ...rows[i], ...record };
    else rows.push(record);
    this.data.set(module, rows);
  }

  remove(module: string, id: string): void {
    this.data.set(
      module,
      (this.data.get(module) ?? []).filter((r) => r.id !== id),
    );
  }

  /** Requests the adapter made, excluding the token endpoint. */
  apiRequests(): FakeSugarRequestLog[] {
    return this.requests.filter((r) => r.path !== '/oauth2/token');
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    this.methodCounts[method] = (this.methodCounts[method] ?? 0) + 1;
    const prefix = `/rest/${this.version}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return this.send(res, 404, { error: 'not_found' });
    const path = url.pathname.slice(prefix.length);
    const token = req.headers['oauth-token'];
    const entry: FakeSugarRequestLog = {
      method,
      path,
      query: url.searchParams,
      token: typeof token === 'string' ? token : undefined,
    };
    this.requests.push(entry);
    this.onRequest?.(method, path);

    const fault = this.faults.find(
      (f) => (f.times ?? 1) > 0 && f.match.test(`${method} ${path}`) && (!f.when || f.when(entry)),
    );
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      return this.send(res, fault.status, fault.body ?? { error: 'fault' }, fault.headers);
    }

    if (method === 'POST' && path === '/oauth2/token') return this.token(req, res);
    if (method !== 'GET') return this.send(res, 405, { error: 'method_not_allowed' });

    const expiry = entry.token ? this.tokens.get(entry.token) : undefined;
    if (!expiry || expiry < Date.now()) return this.send(res, 401, { error: 'invalid_grant' });

    if (path === '/ping') return this.send(res, 200, 'pong');
    const fieldsMatch = /^\/([A-Za-z]+)\/fields$/.exec(path);
    if (fieldsMatch) {
      const doc = this.fields[fieldsMatch[1]!];
      return doc ? this.send(res, 200, doc) : this.send(res, 404, { error: 'no_module' });
    }
    const countMatch = /^\/([A-Za-z]+)\/count$/.exec(path);
    if (countMatch) {
      if (!this.countEndpoint) return this.send(res, 404, { error: 'not_found' });
      const rows = this.select(countMatch[1]!, url.searchParams);
      return rows ? this.send(res, 200, { record_count: rows.length }) : this.send(res, 404, {});
    }
    const listMatch = /^\/([A-Za-z]+)$/.exec(path);
    if (listMatch) return this.list(listMatch[1]!, url.searchParams, res);
    const oneMatch = /^\/([A-Za-z]+)\/([A-Za-z0-9_-]+)$/.exec(path);
    if (oneMatch) {
      const row = (this.data.get(oneMatch[1]!) ?? []).find(
        (r) => r.id === oneMatch[2] && (this.serveDeleted || r.deleted !== true),
      );
      return row
        ? this.send(res, 200, this.project(row, url.searchParams.get('fields')))
        : this.send(res, 404, { error: 'not_found' });
    }
    return this.send(res, 404, { error: 'not_found' });
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, string>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
    } catch {
      return this.send(res, 400, { error: 'invalid_request' });
    }
    const c = this.credentials;
    if (body.client_id !== c.clientId || (body.client_secret ?? '') !== c.clientSecret) {
      return this.send(res, 401, { error: 'invalid_client' });
    }
    if (body.grant_type === 'password') {
      if (body.username !== c.username || body.password !== c.password) {
        return this.send(res, 401, { error: 'invalid_grant' });
      }
      this.passwordGrants += 1;
    } else if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token || !this.refreshTokens.has(body.refresh_token)) {
        return this.send(res, 401, { error: 'invalid_grant' });
      }
      this.refreshTokens.delete(body.refresh_token);
      this.refreshGrants += 1;
    } else {
      return this.send(res, 400, { error: 'unsupported_grant_type' });
    }
    this.tokenSeq += 1;
    const access = `fake-access-${this.tokenSeq}`;
    const refresh = `fake-refresh-${this.tokenSeq}`;
    this.tokens.set(access, Date.now() + this.tokenLifetimeSeconds * 1000);
    this.refreshTokens.add(refresh);
    return this.send(res, 200, {
      access_token: access,
      expires_in: this.tokenLifetimeSeconds,
      token_type: 'bearer',
      refresh_token: refresh,
    });
  }

  /** Expires every issued access token (forces re-authentication). */
  expireTokens(): void {
    for (const key of this.tokens.keys()) this.tokens.set(key, 0);
  }

  /** Applies the filter syntax the adapter sends; undefined for an unknown module. */
  private select(module: string, q: URLSearchParams): FakeSugarRecord[] | undefined {
    const rows = this.data.get(module);
    if (!rows) return undefined;
    let out = rows.filter((r) => this.serveDeleted || r.deleted !== true);
    for (const [key, value] of q.entries()) {
      const m = /^filter\[\d+\]\[([a-z_]+)\]\[(\$lte|\$gte|\$in)\](\[\])?$/.exec(key);
      if (!m) continue;
      const [, field, op] = m;
      if (op === '$in') continue;
      out = out.filter((r) => {
        const v = r[field!];
        if (typeof v !== 'string') return false;
        const t = Date.parse(v);
        const bound = Date.parse(value);
        return op === '$lte' ? t <= bound : t >= bound;
      });
    }
    const ids = q.getAll('filter[0][id][$in][]');
    if (ids.length > 0) out = out.filter((r) => ids.includes(String(r.id)));
    return out;
  }

  private project(row: FakeSugarRecord, fields: string | null): Record<string, unknown> {
    const wanted = fields ? fields.split(',') : Object.keys(row);
    const out: Record<string, unknown> = { _module: 'fake', _acl: { fields: {} } };
    for (const f of wanted) {
      if (this.droppedFields.has(f)) continue;
      if (f in row) out[f] = row[f];
      else out[f] = null;
    }
    out.id = row.id;
    return out;
  }

  private list(module: string, q: URLSearchParams, res: ServerResponse): void {
    const rows = this.select(module, q);
    if (!rows) return this.send(res, 404, { error: 'no_module' });
    const sorted = [...rows].sort((a, b) => {
      const ta = Date.parse(String(a.date_modified ?? '')) || 0;
      const tb = Date.parse(String(b.date_modified ?? '')) || 0;
      return ta !== tb ? ta - tb : String(a.id).localeCompare(String(b.id));
    });
    const max = Math.min(Number(q.get('max_num') ?? 20), 1000);
    const offset = Number(q.get('offset') ?? 0);
    const page = sorted.slice(offset, offset + max);
    const next = offset + page.length < sorted.length ? offset + page.length : -1;
    this.send(res, 200, {
      next_offset: next,
      records: page.map((r) => this.project(r, q.get('fields'))),
    });
    this.afterListPage?.(module, offset);
  }
}

// Standalone: `node apps/api/test/support/fake-sugar.ts --port 0`
if (process.argv[1]?.endsWith('fake-sugar.ts')) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const fake = new FakeSugar({
    version: arg('version') ?? 'v11_20',
    ...(arg('generated') ? { generatedLines: Number(arg('generated')) } : {}),
    ...(process.argv.includes('--unmodelled') ? { includeUnmodelledProduct: true } : {}),
  });
  // M9A runtime variant (75-profiling.sh): one existing holding line carries a pipeline
  // value outside the reviewed domain, and one new line does too (synthetic values).
  if (arg('variant') === 'unreviewed-stage') {
    const lines = fake.data.get('RevenueLineItems') ?? [];
    const base = lines.find((r) => r.id === 'FIX-RLI-001');
    if (base) {
      fake.upsert('RevenueLineItems', { ...base, sales_stage: 'Renewal Pending' });
      fake.upsert('RevenueLineItems', {
        ...base,
        id: 'FIX-RLI-NEWSTAGE',
        sales_stage: 'Renewal Pending',
      });
    }
  }
  // Methods and paths only: proves read-only behaviour in runtime checks.
  fake.onRequest = (method, path) => process.stdout.write(`request ${method} ${path}\n`);
  void fake.start(Number(arg('port') ?? 0)).then(() => {
    process.stdout.write(`fake Sugar listening on ${fake.url}\n`);
  });
  const stop = (): void => {
    void fake.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
