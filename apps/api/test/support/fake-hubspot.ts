/**
 * A local fake of the HubSpot API endpoints the connector reads, for tests and
 * runtime verification. It reproduces HubSpot's documented response shapes and
 * error classes (401, 403 MISSING_SCOPES, 404, 429 with policyName, 5xx) and
 * supports one-off fault injection. It is NOT evidence of how the real HubSpot
 * API behaves: that comes from the live discovery run against a test account.
 *
 * It also fakes HubSpot's OAuth app flow (M4): the consent page
 * (`GET /oauth/authorize`, the generic consent page; answered with the redirect HubSpot sends
 * after the user consents) and the date-versioned token endpoint
 * (`POST /oauth/{YYYY-MM}/token`: authorization-code exchange and refresh).
 * Codes are single-use; refresh calls are counted, and can be delayed, so
 * tests can prove that concurrent processes refresh only once.
 *
 * Self-contained (node: built-ins only, no TypeScript-only runtime syntax) so
 * Node can run it directly:
 *   node apps/api/test/support/fake-hubspot.ts --port 0 --token <t> --portal-id 123
 */
import { randomBytes } from 'node:crypto';
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
  /**
   * Further types on the same link (live, labelled and unlabelled lead types
   * were both seen). They share the link's `category`, as in today's data.
   */
  alsoTypes?: readonly { typeId: number; label: string | null }[];
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
  /** Further condition on the request (e.g. only a later page). */
  when?: (entry: FakeRequestLog) => boolean;
}

export interface FakeRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | undefined;
}

export interface FakeOAuthApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Lifetime of issued access tokens (HubSpot: 1800 s). */
  accessTokenTtlSeconds?: number;
  /** Delay before answering a refresh (widens race windows in concurrency tests). */
  refreshDelayMs?: number;
  /** Issue a new refresh token on every refresh (HubSpot may or may not; both are handled). */
  rotateRefreshTokens?: boolean;
  /**
   * The account the user picks on the consent page (required when the fake
   * has accounts on more than one portal; a different one than the tenant's
   * simulates installing into the wrong account).
   */
  consentPortalId?: number;
}

export interface FakeHubSpotOptions {
  accounts: Record<string, FakeAccount>;
  oauth?: FakeOAuthApp;
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

/** HubSpot-defined reverse association type ids and labels (seen live 2026-09-26). */
const REVERSE_TYPES: Record<number, [number, string | null]> = {
  578: [579, 'Lead with Primary Contact'],
  608: [609, null],
  580: [581, 'Lead with Primary Company'],
  610: [611, null],
  1: [2, 'Contact with Primary Company'],
  279: [280, null],
};

export class FakeHubSpot {
  readonly requests: FakeRequestLog[] = [];
  private readonly faults: FakeFault[] = [];
  /** OAuth: authorization code → the account it grants and the redirect it was issued for. */
  private readonly codes = new Map<string, { portalId: number; redirectUri: string }>();
  /** OAuth: refresh token → account portal id. */
  private readonly refreshTokens = new Map<string, number>();
  /** OAuth calls received, by grant type. */
  readonly oauthCalls = { authorizationCode: 0, refreshToken: 0, revoke: 0 };
  /** Successful CRM search calls served. */
  searchCalls = 0;
  private reverseHidden: ((a: FakeAssociation) => boolean) | undefined;
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

  /** OAuth: issues an authorization code directly (tests that skip the consent page). */
  issueCode(portalId: number, redirectUri = this.options.oauth?.redirectUri ?? ''): string {
    const code = `code-${randomBytes(12).toString('hex')}`;
    this.codes.set(code, { portalId, redirectUri });
    return code;
  }

  /** OAuth: changes the fake app's behaviour (e.g. refresh-token rotation) mid-test. */
  configureOAuth(patch: Partial<FakeOAuthApp>): void {
    if (!this.options.oauth) throw new Error('OAuth not enabled on this fake');
    Object.assign(this.options.oauth, patch);
  }

  /** The account portal id when every configured account is the same portal. */
  private onlyPortalId(): number | undefined {
    const ids = new Set(Object.values(this.options.accounts).map((a) => a.portalId));
    return ids.size === 1 ? [...ids][0] : undefined;
  }

  /** OAuth: this access token stops working (401), e.g. revoked by the user. */
  revokeAccessToken(token: string): void {
    delete this.options.accounts[token];
  }

  /** OAuth: whether this refresh token still works (not revoked, not replaced). */
  isRefreshTokenActive(token: string): boolean {
    return this.refreshTokens.has(token);
  }

  /** OAuth: how many refresh tokens currently work, per account. */
  activeRefreshTokens(portalId: number): number {
    return [...this.refreshTokens.values()].filter((p) => p === portalId).length;
  }

  /** OAuth: every refresh token stops working (the user uninstalled the app). */
  revokeRefreshTokens(): void {
    this.refreshTokens.clear();
  }

  /** Fails the next matching request(s) with the given response. */
  fail(fault: FakeFault): void {
    this.faults.push({ ...fault, times: fault.times ?? 1 });
  }

  /**
   * Makes the stored associations `pick` selects unreadable in reverse (a
   * non-reciprocal link, for testing reciprocity checks); `undefined` resets.
   */
  hideReverse(pick: ((a: FakeAssociation) => boolean) | undefined): void {
    this.reverseHidden = pick;
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

    const fault = this.faults.find(
      (f) => f.match.test(`${method} ${url.pathname}`) && (!f.when || f.when(entry)),
    );
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

    if (/^\/oauth\//.test(url.pathname)) return this.oauthRoute(method, url, raw, res);

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
    // Date-based versions only: legacy paths such as /account-info/v3/details
    // are deliberately not served, so any use of them fails tests.
    if (method === 'GET' && /^\/account-info\/\d{4}-\d{2}\/details$/.test(p)) {
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
    // CRM search: only the version verified at Gate 1 (ADR 0015) is served, so a
    // 2026-09 search path (unverified) fails tests.
    m = /^\/crm\/objects\/2026-03\/(contacts|companies)\/search$/.exec(p);
    if (method === 'POST' && m) return this.search(m[1]!, body, account, res);
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

  /**
   * OAuth endpoints. Only the date-versioned token path is served, so a legacy
   * `/oauth/v1/token` call fails tests.
   */
  private oauthRoute(method: string, url: URL, raw: string, res: ServerResponse): void {
    const app = this.options.oauth;
    if (!app) return this.send(res, 404, { status: 'error', message: 'OAuth not enabled' });
    if (method === 'GET' && url.pathname === '/oauth/authorize') {
      // HubSpot's generic consent page (the form HubSpot generates for a
      // deployed projects app). The user picks the account on this page.
      const q = url.searchParams;
      const scopes = (q.get('scope') ?? '').split(' ').filter(Boolean);
      if (
        q.get('client_id') !== app.clientId ||
        q.get('redirect_uri') !== app.redirectUri ||
        !q.get('state') ||
        !scopes.includes('oauth') ||
        scopes.some((scope) => scope !== 'oauth' && !scope.endsWith('.read'))
      ) {
        return this.send(res, 400, { status: 'error', message: 'Invalid authorize request' });
      }
      const chosen = app.consentPortalId ?? this.onlyPortalId();
      if (chosen === undefined) {
        return this.send(res, 400, { status: 'error', message: 'No account selected' });
      }
      const code = this.issueCode(chosen, app.redirectUri);
      const location = new URL(app.redirectUri);
      location.searchParams.set('code', code);
      location.searchParams.set('state', q.get('state')!);
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }
    if (method === 'POST' && url.pathname === '/oauth/2026-03/token/revoke') {
      // HubSpot's date-versioned refresh-token revoke (form: token, client_id, client_secret).
      this.oauthCalls.revoke += 1;
      const form = new URLSearchParams(raw);
      if (
        form.get('client_id') !== app.clientId ||
        form.get('client_secret') !== app.clientSecret
      ) {
        return this.send(res, 401, { status: 'error', message: 'Invalid client credentials' });
      }
      if (!this.refreshTokens.delete(form.get('token') ?? '')) {
        return this.send(res, 400, { status: 'BAD_REQUEST', message: 'Invalid token' });
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'POST' || !/^\/oauth\/\d{4}-(0[1-9]|1[0-2])\/token$/.test(url.pathname)) {
      return this.send(res, 404, { status: 'error', message: 'Not found' });
    }
    const form = new URLSearchParams(raw);
    const bad = (message: string, status = 400): void =>
      this.send(res, status, { status: 'BAD_REQUEST', message, error: 'invalid_grant' });
    if (form.get('client_id') !== app.clientId || form.get('client_secret') !== app.clientSecret) {
      return bad('Invalid client credentials', 401);
    }
    const grantType = form.get('grant_type');
    let portalId: number;
    let refreshToken: string | undefined;
    if (grantType === 'authorization_code') {
      this.oauthCalls.authorizationCode += 1;
      const issued = this.codes.get(form.get('code') ?? '');
      if (!issued || issued.redirectUri !== form.get('redirect_uri')) {
        return bad('Invalid or already used authorization code');
      }
      this.codes.delete(form.get('code')!); // single-use
      portalId = issued.portalId;
      refreshToken = `refresh-${randomBytes(16).toString('hex')}`;
      this.refreshTokens.set(refreshToken, portalId);
    } else if (grantType === 'refresh_token') {
      this.oauthCalls.refreshToken += 1;
      const current = form.get('refresh_token') ?? '';
      const owner = this.refreshTokens.get(current);
      if (owner === undefined) return bad('Invalid refresh token');
      portalId = owner;
      if (app.rotateRefreshTokens) {
        this.refreshTokens.delete(current);
        refreshToken = `refresh-${randomBytes(16).toString('hex')}`;
        this.refreshTokens.set(refreshToken, portalId);
      }
    } else {
      return bad('Unsupported grant_type');
    }
    const template = Object.values(this.options.accounts).find((a) => a.portalId === portalId);
    const accessToken = `access-${randomBytes(16).toString('hex')}`;
    this.options.accounts[accessToken] = template
      ? { ...template, scopes: [...template.scopes] }
      : { portalId, accountType: 'DEVELOPER_TEST', scopes: ALL_READ_SCOPES, leadsEnabled: true };
    const answer = (): void =>
      this.send(res, 200, {
        token_type: 'bearer',
        access_token: accessToken,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        expires_in: app.accessTokenTtlSeconds ?? 1800,
        hub_id: portalId,
        scopes: ALL_READ_SCOPES.slice(0, 5),
      });
    if (grantType === 'refresh_token' && app.refreshDelayMs) {
      setTimeout(answer, app.refreshDelayMs);
      return;
    }
    answer();
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

  /**
   * `POST /crm/objects/2026-03/{type}/search` with one GTE/LTE filter on the
   * modification property, ascending sort and an offset cursor, as HubSpot
   * documents it (10,000-result window; offsets beyond it are a 400).
   */
  private search(type: string, body: unknown, account: FakeAccount, res: ServerResponse): void {
    if (this.denied(type, OBJECT_SCOPE[type], account, res)) return;
    const b = body as {
      filterGroups?: { filters?: { propertyName: string; operator: string; value: string }[] }[];
      sorts?: { propertyName: string; direction: string }[];
      limit?: number;
      after?: string;
      properties?: string[];
    };
    const modified = type === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate';
    const filters = b?.filterGroups?.[0]?.filters ?? [];
    const limit = Math.min(Number(b?.limit ?? 10), 200);
    const offset = b?.after === undefined ? 0 : Number(b.after);
    if (
      filters.some((f) => f.propertyName !== modified) ||
      (b?.sorts ?? []).some((x) => x.propertyName !== modified) ||
      !Number.isInteger(offset) ||
      offset + limit > 10_000
    ) {
      return this.send(res, 400, {
        status: 'error',
        message: 'Invalid search request',
        category: 'VALIDATION_ERROR',
      });
    }
    this.searchCalls += 1;
    const time = (r: FakeRecord): number => Date.parse(r.updatedAt ?? '2026-09-02T09:00:00.000Z');
    const matches = (this.options.records?.[type as 'contacts'] ?? [])
      .filter((r) =>
        filters.every((f) =>
          f.operator === 'GTE'
            ? time(r) >= Number(f.value)
            : f.operator === 'LTE'
              ? time(r) <= Number(f.value)
              : time(r) === Number(f.value),
        ),
      )
      .sort((x, y) => time(x) - time(y) || Number(x.id) - Number(y.id));
    const slice = matches.slice(offset, offset + limit);
    const next = offset + limit < matches.length ? String(offset + limit) : undefined;
    this.send(res, 200, {
      total: matches.length,
      results: slice.map((r) => this.object(r)),
      ...(next ? { paging: { next: { after: next } } } : {}),
    });
  }

  /** Test helper: creates or replaces a record (e.g. a change made in HubSpot). */
  upsertRecord(type: 'contacts' | 'companies' | 'leads', record: FakeRecord): void {
    const records = (this.options.records ??= {});
    const list = (records[type] ??= []);
    const i = list.findIndex((r) => r.id === record.id);
    if (i >= 0) list[i] = record;
    else list.push(record);
  }

  /** Test helper: the record disappears (deleted or merged away in HubSpot). */
  removeRecord(type: 'contacts' | 'companies' | 'leads', id: string): void {
    const list = this.options.records?.[type] ?? [];
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) list.splice(i, 1);
  }

  /** Test helper: replaces every association between two object types. */
  setAssociations(fromType: string, toType: string, links: FakeAssociation[]): void {
    const all = (this.options.associations ??= []);
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const a = all[i]!;
      if (
        (a.fromType === fromType && a.toType === toType) ||
        (a.fromType === toType && a.toType === fromType)
      ) {
        all.splice(i, 1);
      }
    }
    all.push(...links);
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
    const seen = new Map<number, { category: string; typeId: number; label: string | null }>();
    for (const a of this.links(from, to)) {
      for (const t of types(a)) seen.set(t.typeId, { category: a.category, ...t });
    }
    this.send(res, 200, { results: [...seen.values()] });
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
    // Per-input errors come back in a 207 Multi-Status, in the shape seen live
    // on 2026-09-26: a record with no associations is a NO_ASSOCIATIONS_FOUND
    // error with `context.fromObjectId`. Unknown ids are reported likewise.
    const errors: unknown[] = [];
    const known = new Set((this.options.records?.[from as 'contacts'] ?? []).map((r) => r.id));
    const unknown = inputs.filter((input) => !known.has(input.id)).map((input) => input.id);
    for (const input of inputs.filter((i) => known.has(i.id))) {
      const links = this.links(from, to).filter((a) => a.fromId === input.id);
      if (links.length === 0) {
        errors.push({
          status: 'error',
          category: 'OBJECT_NOT_FOUND',
          subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND',
          message: `No ${to} is associated with ${from} ${input.id}.`,
          context: { fromObjectId: [input.id], fromObjectType: [from], toObjectType: [to] },
        });
        continue;
      }
      const start = input.after ? Number(input.after) : 0;
      const slice = links.slice(start, start + pageSize);
      results.push({
        from: { id: input.id },
        to: slice.map((a) => ({
          toObjectId: Number(a.toId),
          associationTypes: types(a).map((t) => ({ category: a.category, ...t })),
        })),
        ...(start + pageSize < links.length
          ? { paging: { next: { after: String(start + pageSize) } } }
          : {}),
      });
    }
    if (unknown.length) {
      errors.push({
        status: 'error',
        category: 'OBJECT_NOT_FOUND',
        message: 'Records not found',
        context: { fromObjectId: unknown },
      });
    }
    this.send(res, errors.length ? 207 : 200, {
      status: 'COMPLETE',
      results,
      ...(errors.length ? { numErrors: errors.length, errors } : {}),
      startedAt: '2026-09-26T00:00:00Z',
      completedAt: '2026-09-26T00:00:01Z',
    });
  }

  /**
   * Associations from one object type to another. As in HubSpot, every stored
   * association can also be read in reverse, with HubSpot's paired type id and
   * label (as discovered live on the test account).
   */
  private links(from: string, to: string): FakeAssociation[] {
    const all = this.options.associations ?? [];
    const forward = all.filter((a) => a.fromType === from && a.toType === to);
    const reverse = all
      .filter((a) => a.fromType === to && a.toType === from && !this.reverseHidden?.(a))
      .map((a) => {
        const [first, ...rest] = types(a).map((t) => {
          const [typeId, label] = REVERSE_TYPES[t.typeId] ?? [t.typeId, t.label];
          return { typeId, label };
        });
        return {
          fromType: from,
          fromId: a.toId,
          toType: to,
          toId: a.fromId,
          category: a.category,
          ...first!,
          alsoTypes: rest,
        };
      });
    return [...forward, ...reverse];
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

function types(a: FakeAssociation): { typeId: number; label: string | null }[] {
  return [{ typeId: a.typeId, label: a.label }, ...(a.alsoTypes ?? [])];
}

/**
 * A small, deterministic data set: 5 contacts, 3 companies, 3 leads with
 * associations. Association type ids 1 and 279 (contact to company), 580 + 610
 * (lead to company) and 578 + 608 (lead to contact) match the ids and labels
 * the live discovery of the test account reported on 2026-09-26 (both the
 * labelled and the unlabelled lead types were seen; each fake link has both).
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
        typeId: 578,
        category: 'HUBSPOT_DEFINED' as const,
        label: 'Primary',
        alsoTypes: [{ typeId: 608, label: null }],
      },
      {
        fromType: 'leads',
        fromId: l.id,
        toType: 'companies',
        toId: companies[i]!.id,
        typeId: 580,
        category: 'HUBSPOT_DEFINED' as const,
        label: 'Primary',
        alsoTypes: [{ typeId: 610, label: null }],
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
    ...(args.includes('--oauth-client-id')
      ? {
          oauth: {
            clientId: arg('oauth-client-id', ''),
            clientSecret: arg('oauth-client-secret', ''),
            redirectUri: arg('oauth-redirect-uri', ''),
            accessTokenTtlSeconds: Number(arg('access-ttl', '1800')),
            refreshDelayMs: Number(arg('refresh-delay-ms', '0')),
            ...(args.includes('--consent-portal-id')
              ? { consentPortalId: Number(arg('consent-portal-id', '0')) }
              : {}),
          },
        }
      : {}),
    // Paths only (plus the OAuth grant type): never codes, tokens or secrets.
    onRequest: (r) => {
      const grant =
        typeof r.body === 'string' && r.path.startsWith('/oauth/')
          ? ` grant=${new URLSearchParams(r.body).get('grant_type') ?? '-'}`
          : '';
      process.stdout.write(`request ${r.method} ${r.path}${grant}\n`);
    },
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
