/**
 * A local fake of the HubSpot API endpoints the connector reads, for tests and
 * runtime verification. It reproduces HubSpot's documented response shapes and
 * error classes (401, 403 MISSING_SCOPES, 404, 429 with policyName, 5xx) and
 * supports one-off fault injection. It is NOT evidence of how the real HubSpot
 * API behaves: that comes from the live discovery run against a test account.
 *
 * Self-contained (node: built-ins only, no TypeScript-only runtime syntax) so
 * Node can run it directly:
 *   node apps/api/test/support/fake-hubspot.ts --port 0 --token <t> --portal-id 123
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
}

export interface FakeAssociation {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  typeId: number;
  category: 'HUBSPOT_DEFINED' | 'USER_DEFINED' | 'INTEGRATOR_DEFINED';
  label: string | null;
}

export interface FakeAccount {
  portalId: number;
  accountType: string;
  scopes: string[];
  /** false: the Leads object is not part of this account's subscription. */
  leadsEnabled: boolean;
}

export interface FakeFault {
  /** Matches `${method} ${pathname}`. */
  match: RegExp;
  status: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Send the status and headers, then stall this long before the body. */
  stallBodyMs?: number;
  /** How many matching requests to fail (default 1). */
  times?: number;
}

export interface FakeRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | undefined;
}

export interface FakeHubSpotOptions {
  accounts: Record<string, FakeAccount>;
  /** Called for every request received (the standalone mode prints them). */
  onRequest?: (entry: FakeRequestLog) => void;
  records?: Partial<Record<'contacts' | 'companies' | 'leads', FakeRecord[]>>;
  associations?: FakeAssociation[];
}

export const ALL_READ_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
  'crm.objects.leads.read',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
  'crm.schemas.leads.read',
];

const OBJECT_SCOPE: Record<string, string> = {
  contacts: 'crm.objects.contacts.read',
  companies: 'crm.objects.companies.read',
  leads: 'crm.objects.leads.read',
};
const SCHEMA_SCOPE: Record<string, string> = {
  contacts: 'crm.schemas.contacts.read',
  companies: 'crm.schemas.companies.read',
  leads: 'crm.schemas.leads.read',
};

const PROPERTIES: Record<
  string,
  { name: string; type: string; custom?: boolean; options?: string[] }[]
> = {
  contacts: [
    { name: 'email', type: 'string' },
    { name: 'firstname', type: 'string' },
    { name: 'lastname', type: 'string' },
    { name: 'jobtitle', type: 'string' },
    { name: 'lifecyclestage', type: 'enumeration', options: ['lead', 'customer'] },
    { name: 'fake_custom_field', type: 'string', custom: true },
  ],
  companies: [
    { name: 'name', type: 'string' },
    { name: 'domain', type: 'string' },
  ],
  leads: [
    { name: 'hs_pipeline_stage', type: 'enumeration', options: ['new', 'attempting'] },
    { name: 'fake_lead_field', type: 'string', custom: true },
  ],
};

export class FakeHubSpot {
  readonly requests: FakeRequestLog[] = [];
  private readonly faults: FakeFault[] = [];
  private server: Server | undefined;
  private readonly options: FakeHubSpotOptions;

  constructor(options: FakeHubSpotOptions) {
    this.options = options;
  }

  get url(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('fake HubSpot is not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  /** Fails the next matching request(s) with the given response. */
  fail(fault: FakeFault): void {
    this.faults.push({ ...fault, times: fault.times ?? 1 });
  }

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const method = req.method ?? 'GET';
    const entry: FakeRequestLog = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: req.headers.authorization,
    };
    this.requests.push(entry);
    this.options.onRequest?.(entry);

    const fault = this.faults.find((f) => f.match.test(`${method} ${url.pathname}`));
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.times <= 0) this.faults.splice(this.faults.indexOf(fault), 1);
      if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      if (fault.stallBodyMs && !res.destroyed) {
        res.writeHead(fault.status, { 'content-type': 'application/json', ...fault.headers });
        res.flushHeaders();
        await new Promise((r) => setTimeout(r, fault.stallBodyMs));
      }
      if (!res.destroyed) {
        if (!res.headersSent) {
          res.writeHead(fault.status, { 'content-type': 'application/json', ...fault.headers });
        }
        res.end(
          fault.rawBody ??
            JSON.stringify(fault.body ?? { status: 'error', message: 'injected fault' }),
        );
      }
      return;
    }

    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const account = token ? this.options.accounts[token] : undefined;
    if (!account) {
      return this.send(res, 401, {
        status: 'error',
        message: 'Authentication credentials not found.',
        category: 'INVALID_AUTHENTICATION',
        correlationId: 'fake-401',
      });
    }
    try {
      return this.route(method, url, body, account, res);
    } catch (err) {
      return this.send(res, 500, {
        status: 'error',
        message: String(err),
        category: 'INTERNAL_ERROR',
      });
    }
  }

  private route(
    method: string,
    url: URL,
    body: unknown,
    account: FakeAccount,
    res: ServerResponse,
  ): void {
    const p = url.pathname;
    if (method === 'GET' && p === '/account-info/v3/details') {
      return this.send(res, 200, {
        portalId: account.portalId,
        accountType: account.accountType,
        timeZone: 'Europe/London',
        companyCurrency: 'GBP',
        dataHostingLocation: 'eu1',
        uiDomain: 'app-eu1.hubspot.com',
      });
    }
    let m = /^\/crm\/objects\/[\w-]+\/(\w+)$/.exec(p);
    if (method === 'GET' && m) return this.listObjects(m[1]!, url, account, res);
    m = /^\/crm\/objects\/[\w-]+\/(\w+)\/(\w+)$/.exec(p);
    if (method === 'GET' && m) return this.getObject(m[1]!, m[2]!, account, res);
    m = /^\/crm\/properties\/[\w-]+\/(\w+)$/.exec(p);
    if (method === 'GET' && m) return this.listProperties(m[1]!, account, res);
    m = /^\/crm\/associations\/[\w-]+\/(\w+)\/(\w+)\/labels$/.exec(p);
    if (method === 'GET' && m) return this.labels(m[1]!, m[2]!, account, res);
    m = /^\/crm\/associations\/[\w-]+\/(\w+)\/(\w+)\/batch\/read$/.exec(p);
    if (method === 'POST' && m) return this.batchRead(m[1]!, m[2]!, body, account, res);
    return this.send(res, 404, {
      status: 'error',
      message: 'Not found',
      category: 'OBJECT_NOT_FOUND',
    });
  }

  private denied(
    type: string,
    scope: string | undefined,
    account: FakeAccount,
    res: ServerResponse,
  ): boolean {
    if (!scope) {
      this.send(res, 400, {
        status: 'error',
        message: `Unknown object type ${type}`,
        category: 'VALIDATION_ERROR',
      });
      return true;
    }
    if (!account.scopes.includes(scope)) {
      this.send(res, 403, {
        status: 'error',
        message: "This app hasn't been granted all required scopes to make this call.",
        category: 'MISSING_SCOPES',
        correlationId: 'fake-403',
        errors: [{ message: 'missing scopes', context: { requiredGranularScopes: [scope] } }],
      });
      return true;
    }
    if (type === 'leads' && !account.leadsEnabled) {
      this.send(res, 403, {
        status: 'error',
        message: 'Leads are not available for this account',
        category: 'FORBIDDEN',
      });
      return true;
    }
    return false;
  }

  private listObjects(type: string, url: URL, account: FakeAccount, res: ServerResponse): void {
    if (this.denied(type, OBJECT_SCOPE[type], account, res)) return;
    const all = this.options.records?.[type as 'contacts'] ?? [];
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 10), 100);
    const after = url.searchParams.get('after');
    const start = after ? Number(Buffer.from(after, 'base64url').toString('utf8')) : 0;
    if (!Number.isInteger(start) || start < 0) {
      return this.send(res, 400, {
        status: 'error',
        message: 'Invalid after',
        category: 'VALIDATION_ERROR',
      });
    }
    const slice = all.slice(start, start + limit);
    const next =
      start + limit < all.length
        ? Buffer.from(String(start + limit)).toString('base64url')
        : undefined;
    this.send(res, 200, {
      results: slice.map((r) => this.object(r)),
      ...(next ? { paging: { next: { after: next, link: `?after=${next}` } } } : {}),
    });
  }

  private getObject(type: string, id: string, account: FakeAccount, res: ServerResponse): void {
    if (this.denied(type, OBJECT_SCOPE[type], account, res)) return;
    const record = (this.options.records?.[type as 'contacts'] ?? []).find((r) => r.id === id);
    if (!record) {
      return this.send(res, 404, {
        status: 'error',
        message: 'Object not found',
        category: 'OBJECT_NOT_FOUND',
      });
    }
    this.send(res, 200, this.object(record));
  }

  private object(r: FakeRecord): unknown {
    return {
      id: r.id,
      properties: r.properties,
      createdAt: r.createdAt ?? '2026-09-01T09:00:00.000Z',
      updatedAt: r.updatedAt ?? '2026-09-02T09:00:00.000Z',
      archived: false,
    };
  }

  private listProperties(type: string, account: FakeAccount, res: ServerResponse): void {
    if (this.denied(type, SCHEMA_SCOPE[type], account, res)) return;
    this.send(res, 200, {
      results: (PROPERTIES[type] ?? []).map((p) => ({
        name: p.name,
        label: p.name,
        type: p.type,
        fieldType: p.type === 'enumeration' ? 'select' : 'text',
        groupName: `${type}information`,
        options: (p.options ?? []).map((o, i) => ({
          value: o,
          label: o,
          displayOrder: i,
          hidden: false,
        })),
        hubspotDefined: !p.custom,
        modificationMetadata: {
          readOnlyValue: false,
          archivable: true,
          readOnlyDefinition: !p.custom,
        },
      })),
    });
  }

  private labels(from: string, to: string, account: FakeAccount, res: ServerResponse): void {
    if (
      this.denied(from, OBJECT_SCOPE[from], account, res) ||
      this.denied(to, OBJECT_SCOPE[to], account, res)
    )
      return;
    const seen = new Map<number, FakeAssociation>();
    for (const a of this.options.associations ?? []) {
      if (a.fromType === from && a.toType === to) seen.set(a.typeId, a);
    }
    this.send(res, 200, {
      results: [...seen.values()].map((a) => ({
        category: a.category,
        typeId: a.typeId,
        label: a.label,
      })),
    });
  }

  private batchRead(
    from: string,
    to: string,
    body: unknown,
    account: FakeAccount,
    res: ServerResponse,
  ): void {
    if (
      this.denied(from, OBJECT_SCOPE[from], account, res) ||
      this.denied(to, OBJECT_SCOPE[to], account, res)
    )
      return;
    const inputs = (body as { inputs?: { id: string; after?: string }[] } | undefined)?.inputs;
    if (!Array.isArray(inputs)) {
      return this.send(res, 400, {
        status: 'error',
        message: 'inputs required',
        category: 'VALIDATION_ERROR',
      });
    }
    const pageSize = 2;
    const results = [];
    // Inputs that are not records of `from` are reported per input, with the
    // whole response returned as 207 Multi-Status (as HubSpot batch APIs do).
    const known = new Set((this.options.records?.[from as 'contacts'] ?? []).map((r) => r.id));
    const unknown = inputs.filter((input) => !known.has(input.id)).map((input) => input.id);
    for (const input of inputs.filter((i) => known.has(i.id))) {
      const links = (this.options.associations ?? []).filter(
        (a) => a.fromType === from && a.toType === to && a.fromId === input.id,
      );
      if (links.length === 0) continue;
      const start = input.after ? Number(input.after) : 0;
      const slice = links.slice(start, start + pageSize);
      results.push({
        from: { id: input.id },
        to: slice.map((a) => ({
          toObjectId: Number(a.toId),
          associationTypes: [{ category: a.category, typeId: a.typeId, label: a.label }],
        })),
        ...(start + pageSize < links.length
          ? { paging: { next: { after: String(start + pageSize) } } }
          : {}),
      });
    }
    const errors = unknown.length
      ? [
          {
            status: 'error',
            category: 'OBJECT_NOT_FOUND',
            message: 'Records not found',
            context: { ids: unknown },
          },
        ]
      : undefined;
    this.send(res, errors ? 207 : 200, {
      status: 'COMPLETE',
      results,
      ...(errors ? { numErrors: errors.length, errors } : {}),
      startedAt: '2026-09-26T00:00:00Z',
      completedAt: '2026-09-26T00:00:01Z',
    });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

/**
 * A small, deterministic data set: 5 contacts, 3 companies, 3 leads with
 * associations. Association type ids 1 and 279 (contact to company) and 580
 * (lead to primary company) are HubSpot's published ids; 90001 is an
 * illustrative placeholder for lead to contact, whose id live discovery reports.
 */
export function sampleData(): Pick<FakeHubSpotOptions, 'records' | 'associations'> {
  const contacts = [1, 2, 3, 4, 5].map((n) => ({
    id: String(100 + n),
    properties: {
      email: n === 5 ? 'not-an-email' : `Person${n}@School${n}.example`,
      firstname: `First${n}`,
      lastname: `Last${n}`,
      jobtitle: n === 1 ? 'Head of IT' : null,
      fake_custom_field: 'x',
    },
  }));
  const companies = [1, 2, 3].map((n) => ({
    id: String(200 + n),
    properties: { name: `School ${n}`, domain: `School${n}.Example` },
  }));
  const leads = [1, 2, 3].map((n) => ({
    id: String(300 + n),
    properties: { hs_pipeline_stage: 'new' },
  }));
  const associations: FakeAssociation[] = [
    ...leads.flatMap((l, i) => [
      {
        fromType: 'leads',
        fromId: l.id,
        toType: 'contacts',
        toId: contacts[i]!.id,
        typeId: 90001,
        category: 'HUBSPOT_DEFINED' as const,
        label: null,
      },
      {
        fromType: 'leads',
        fromId: l.id,
        toType: 'companies',
        toId: companies[i]!.id,
        typeId: 580,
        category: 'HUBSPOT_DEFINED' as const,
        label: 'Primary',
      },
    ]),
    ...contacts.slice(0, 3).map((c, i) => ({
      fromType: 'contacts',
      fromId: c.id,
      toType: 'companies',
      toId: companies[i]!.id,
      typeId: 1,
      category: 'HUBSPOT_DEFINED' as const,
      label: 'Primary',
    })),
    // Contact 101 has three companies, to exercise association paging (fake page size 2).
    {
      fromType: 'contacts',
      fromId: '101',
      toType: 'companies',
      toId: '202',
      typeId: 279,
      category: 'HUBSPOT_DEFINED',
      label: null,
    },
    {
      fromType: 'contacts',
      fromId: '101',
      toType: 'companies',
      toId: '203',
      typeId: 279,
      category: 'HUBSPOT_DEFINED',
      label: null,
    },
  ];
  return { records: { contacts, companies, leads }, associations };
}

// Standalone mode, for runtime verification.
if (process.argv[1]?.endsWith('fake-hubspot.ts')) {
  const args = process.argv.slice(2);
  const arg = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
  };
  const fake = new FakeHubSpot({
    accounts: {
      [arg('token', 'fake-token')]: {
        portalId: Number(arg('portal-id', '123456')),
        accountType: arg('account-type', 'DEVELOPER_TEST'),
        scopes: ALL_READ_SCOPES,
        leadsEnabled: true,
      },
    },
    ...sampleData(),
    onRequest: (r) => process.stdout.write(`request ${r.method} ${r.path}\n`),
  });
  void fake.start(Number(arg('port', '0'))).then(() => {
    process.stdout.write(`fake HubSpot listening on ${fake.url}\n`);
  });
  const stop = (): void => {
    void fake.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
