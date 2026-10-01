import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/bootstrap';
import { HubSpotOAuthService, WebhookReceiptRepository } from '../../src/modules/hubspot';
import {
  OAuthAccountRouter,
  OAuthStateService,
  TenantDatabase,
  tenantClient,
  type TenantContext,
} from '../../src/modules/tenancy';
import { WEBHOOK_MAX_BODY_BYTES } from '../../src/platform/http';
import {
  APP_LOGIN,
  startInfrastructure,
  withAdmin,
  withCredentials,
  type TestInfrastructure,
} from '../support/containers';
import { ALL_READ_SCOPES, FakeHubSpot, sampleData } from '../support/fake-hubspot';
import { legacyHeaders, signedHeaders, webhookEvent } from '../support/hubspot-webhooks';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/**
 * POST /webhooks/hubspot through the real API process (raw-body middleware,
 * filters, database with the non-privileged app role). ADR 0011.
 */
describe('HubSpot webhook intake (API process)', () => {
  let infra: TestInfrastructure;
  let fake: FakeHubSpot;
  let app: INestApplication;
  let http: App;
  let h: TenancyHarness;
  const saved = new Map<string, string | undefined>();
  const TARGET = 'https://lip-public.example.test/webhooks/hubspot';
  const APP_ID = 22_222;
  const APP = {
    clientId: 'fake-client-id-0005',
    clientSecret: 'fake-client-secret-0005',
    redirectUri: 'https://lip-public.example.test/oauth/hubspot/callback',
  };
  const VALUE_MARKER = 'value-marker-7f3a@example.com';

  let ok: TenantContext; // OAuth grant on 5005, eligible
  let staticTenant: TenantContext; // same account 5005, static token, no grant
  let amb1: TenantContext; // both hold a grant on 6006 → ambiguous
  let amb2: TenantContext;
  let disabled: TenantContext; // grant on 8008, integration disabled
  let suspended: TenantContext; // grant on 9009, tenant suspended

  function setEnv(name: string, value: string | undefined): void {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async function installed(prefix: string, portalId: number): Promise<TenantContext> {
    const t = await provisionTenant(h, prefix);
    await h.config.configureIntegration(t, 'hubspot', {
      access: 'read_only',
      settings: { portalId: String(portalId), auth: 'oauth' },
    });
    const { state } = await h.app.get(OAuthStateService).issue(t, 'hubspot');
    await h.app.get(HubSpotOAuthService).completeInstall({ code: fake.issueCode(portalId), state });
    return t;
  }

  /** A signed delivery; `sign` overrides what the signature is computed over. */
  function deliver(
    body: string | Buffer,
    opts: {
      path?: string;
      timestamp?: number;
      signUri?: string;
      host?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const path = opts.path ?? '/webhooks/hubspot';
    const query = path.includes('?') ? path.slice(path.indexOf('?')) : '';
    const headers = opts.headers ?? {
      ...signedHeaders({
        secret: APP.clientSecret,
        uri: opts.signUri ?? `${TARGET}${query}`,
        body,
        ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
      }),
    };
    let req = request(http).post(path).set(headers);
    if (opts.host) req = req.set('host', opts.host);
    // A string is sent as is (superagent would JSON-encode a Buffer with a JSON content type).
    return req.send(Buffer.isBuffer(body) ? body.toString('utf8') : body);
  }

  const json = (events: unknown[]) => JSON.stringify(events);

  async function receipts(t: TenantContext) {
    return await withAdmin(infra.adminUrl, async (db) => {
      const { rows } = await db.query<Record<string, unknown>>(
        'SELECT * FROM tenant_webhook_receipts WHERE tenant_id = $1 ORDER BY received_at, event_id',
        [t.tenantId],
      );
      return rows;
    });
  }

  async function totalReceipts(): Promise<number> {
    return await withAdmin(infra.adminUrl, async (db) => {
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tenant_webhook_receipts',
      );
      return rows[0]!.n;
    });
  }

  beforeAll(async () => {
    const template = (portalId: number) => ({
      portalId,
      accountType: 'DEVELOPER_TEST',
      scopes: ALL_READ_SCOPES,
      leadsEnabled: true,
    });
    fake = await new FakeHubSpot({
      accounts: {
        t5005: template(5005),
        t6006: template(6006),
        t8008: template(8008),
        t9009: template(9009),
      },
      oauth: { ...APP },
      ...sampleData(),
    }).start();
    setEnv('HUBSPOT_API_BASE_URL', fake.url);
    setEnv('HUBSPOT_OAUTH_AUTHORIZE_BASE_URL', `${fake.url}/oauth`);
    setEnv('HUBSPOT_APP_CLIENT_ID', APP.clientId);
    setEnv('HUBSPOT_APP_REDIRECT_URI', APP.redirectUri);
    setEnv('HUBSPOT_APP_CLIENT_SECRET', APP.clientSecret);
    setEnv('HUBSPOT_APP_ID', String(APP_ID));
    setEnv('HUBSPOT_WEBHOOK_TARGET_URL', TARGET);
    setEnv('PLATFORM_TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    infra = await startInfrastructure();
    app = await createApiApp(infra.config);
    await app.init();
    // Listening once: supertest otherwise starts a listener per request (20 concurrent ones below).
    await app.listen(0, '127.0.0.1');
    http = app.getHttpServer() as App;
    h = await startTenancy(infra.config);

    ok = await installed('whok', 5005);
    staticTenant = await provisionTenant(h, 'whstatic');
    await h.config.configureIntegration(staticTenant, 'hubspot', {
      access: 'read_only',
      settings: { portalId: '5005' },
    });
    amb1 = await installed('whamba', 6006);
    amb2 = await installed('whambb', 6006);
    disabled = await installed('whdis', 8008);
    await h.config.configureIntegration(disabled, 'hubspot', {
      access: 'disabled',
      settings: { portalId: '8008', auth: 'oauth' },
    });
    suspended = await installed('whsusp', 9009);
    await h.registry.suspend(suspended.tenantId);
  });

  afterAll(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await h?.close();
    await app?.close();
    await infra?.stop();
    await fake?.stop();
  });

  describe('accepted deliveries', () => {
    it('records one receipt per event, identifiers only: no property value, no body', async () => {
      const events = [
        webhookEvent({ subscriptionType: 'object.creation', objectTypeId: '0-1' }),
        webhookEvent({
          subscriptionType: 'object.propertyChange',
          objectTypeId: '0-2',
          propertyName: 'name',
          propertyValue: VALUE_MARKER,
        }),
        webhookEvent({ subscriptionType: 'object.creation', objectTypeId: '0-136' }),
      ];
      const res = await deliver(json(events)).expect(200);
      expect(res.body).toEqual({
        status: 'accepted',
        events: 3,
        stored: 3,
        duplicates: 0,
        unroutable: 0,
      });
      expect(res.headers['cache-control']).toBe('no-store');
      const rows = await receipts(ok);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => [r.subscription_type, r.object_type_id])).toEqual([
        ['object.creation', '0-1'],
        ['object.propertyChange', '0-2'],
        ['object.creation', '0-136'],
      ]);
      expect(rows[1]).toMatchObject({
        system: 'hubspot',
        account_id: '5005',
        app_id: String(APP_ID),
        event_id: String(events[1]!.eventId),
        property_name: 'name',
        change_source: 'CRM_UI',
        first_attempt_number: 0,
        deliveries: 1,
      });
      // Nothing but identifiers anywhere in the table.
      const dump = await withAdmin(infra.adminUrl, (db) =>
        db.query<{ t: string }>(
          'SELECT tenant_webhook_receipts::text AS t FROM tenant_webhook_receipts',
        ),
      );
      const all = dump.rows.map((r) => r.t).join('\n');
      expect(all).not.toContain(VALUE_MARKER);
      expect(all).not.toContain('userId');
      expect(all).not.toContain('CREATED'); // changeFlag is not kept either
    });

    it('verifies the exact raw bytes: whitespace and escapes as sent are accepted', async () => {
      const event = webhookEvent({ subscriptionType: 'object.creation' });
      const raw = `[\n  {"eventId": ${String(event.eventId)}, "subscriptionId": 4100001,\t"portalId": 5005, "appId": ${APP_ID},
        "occurredAt": ${String(event.occurredAt)}, "subscriptionType": "object.creation", "attemptNumber": 0,
        "objectId": 123, "objectTypeId": "0-1", "note": "caf\\u00e9 é"}\n]`;
      const res = await deliver(raw).expect(200);
      expect(res.body).toMatchObject({ stored: 1 });
    });

    it('a query string on the delivery URL is part of the signed URI', async () => {
      const body = json([webhookEvent()]);
      await deliver(body, { path: '/webhooks/hubspot?source=hs%3Atest' }).expect(200);
      // Signed without the query: refused.
      await deliver(json([webhookEvent()]), {
        path: '/webhooks/hubspot?source=hs%3Atest',
        signUri: TARGET,
      }).expect(401);
    });
  });

  describe('de-duplication', () => {
    it('a replayed delivery is recorded once; the redelivery is counted on the same row', async () => {
      const event = webhookEvent();
      const body = json([event]);
      await deliver(body).expect(200);
      const again = await deliver(body).expect(200);
      expect(again.body).toMatchObject({ stored: 0, duplicates: 1 });
      // HubSpot's retry: same event, higher attempt number.
      const retry = await deliver(json([{ ...event, attemptNumber: 2 }])).expect(200);
      expect(retry.body).toMatchObject({ stored: 0, duplicates: 1 });
      const rows = (await receipts(ok)).filter((r) => r.event_id === String(event.eventId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        deliveries: 3,
        first_attempt_number: 0,
        last_attempt_number: 2,
      });
    });

    it('20 concurrent deliveries of the same event leave exactly one receipt', async () => {
      const event = webhookEvent();
      const body = json([event]);
      const results = await Promise.all(Array.from({ length: 20 }, () => deliver(body)));
      expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
      expect(results.reduce((n, r) => n + (r.body as { stored: number }).stored, 0)).toBe(1);
      const rows = (await receipts(ok)).filter((r) => r.event_id === String(event.eventId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deliveries).toBe(20);
    });

    it('the same event twice in one batch is one receipt', async () => {
      const event = webhookEvent();
      const res = await deliver(json([event, event])).expect(200);
      expect(res.body).toMatchObject({ stored: 1, duplicates: 1 });
    });
  });

  describe('signature and freshness', () => {
    it('a wrong signature, secret or body → 401, nothing stored', async () => {
      const before = await totalReceipts();
      const body = json([webhookEvent()]);
      const headers = signedHeaders({ secret: 'not-the-secret', uri: TARGET, body });
      const res = await deliver(body, { headers }).expect(401);
      expect(res.body).toEqual({ status: 'error', reason: 'invalid_signature' });
      const good = signedHeaders({ secret: APP.clientSecret, uri: TARGET, body });
      await deliver(json([webhookEvent()]), { headers: good }).expect(401); // other body
      await deliver(body, { headers: { 'content-type': 'application/json' } }).expect(401);
      expect(await totalReceipts()).toBe(before);
    });

    it('stale (> 5 min) and future-dated (> 60 s) timestamps → 401', async () => {
      const before = await totalReceipts();
      await deliver(json([webhookEvent()]), { timestamp: Date.now() - 5 * 60_000 - 5_000 }).expect(
        401,
      );
      await deliver(json([webhookEvent()]), { timestamp: Date.now() + 5 * 60_000 }).expect(401);
      await deliver(json([webhookEvent()]), { timestamp: Date.now() + 90_000 }).expect(401);
      expect(await totalReceipts()).toBe(before);
      await deliver(json([webhookEvent()]), { timestamp: Date.now() - 60_000 }).expect(200);
    });

    it('v1 and v2 signatures are never accepted, even when correct', async () => {
      const body = json([webhookEvent()]);
      for (const version of ['v1', 'v2'] as const) {
        const headers = legacyHeaders(version, { secret: APP.clientSecret, uri: TARGET, body });
        await deliver(body, { headers }).expect(401);
      }
    });

    it('the Host header is never trusted for the signed URI', async () => {
      // Signed for the host the attacker sent: refused.
      const body = json([webhookEvent()]);
      await deliver(body, {
        host: 'attacker.example',
        signUri: 'https://attacker.example/webhooks/hubspot',
      }).expect(401);
      // Signed for the configured public URL: accepted whatever Host says (tunnels rewrite it).
      await deliver(json([webhookEvent()]), { host: 'attacker.example' }).expect(200);
      await deliver(json([webhookEvent()]), { host: '127.0.0.1:1234' }).expect(200);
    });
  });

  describe('payload', () => {
    it('invalid JSON or an invalid batch → 400 (after the signature check)', async () => {
      for (const body of ['not json', '{}', '[]', json([webhookEvent({ portalId: 'x' })])]) {
        const res = await deliver(body).expect(400);
        expect(res.body).toEqual({ status: 'error', reason: 'invalid_payload' });
      }
    });

    it('events for another app → 403, nothing stored', async () => {
      const before = await totalReceipts();
      const res = await deliver(json([webhookEvent(), webhookEvent({ appId: 99_999 })])).expect(
        403,
      );
      expect(res.body).toEqual({ status: 'error', reason: 'app_mismatch' });
      expect(await totalReceipts()).toBe(before);
    });

    it('a body over the limit → 413, before it is buffered or verified', async () => {
      const res = await request(http)
        .post('/webhooks/hubspot')
        .set('content-type', 'application/json')
        .send(' '.repeat(WEBHOOK_MAX_BODY_BYTES + 1))
        .expect(413);
      expect(res.body).toEqual({ status: 'error', reason: 'payload_too_large' });
    });
  });

  describe('routing', () => {
    it('an unknown account is acknowledged but never guessed: nothing stored', async () => {
      const before = await totalReceipts();
      const res = await deliver(json([webhookEvent({ portalId: 7007 })])).expect(200);
      expect(res.body).toMatchObject({ events: 1, stored: 0, unroutable: 1 });
      expect(await totalReceipts()).toBe(before);
    });

    it('an account granted to two tenants is ambiguous: never guessed, nothing stored', async () => {
      const res = await deliver(json([webhookEvent({ portalId: 6006 })])).expect(200);
      expect(res.body).toMatchObject({ stored: 0, unroutable: 1 });
      expect(await receipts(amb1)).toHaveLength(0);
      expect(await receipts(amb2)).toHaveLength(0);
    });

    it('a tenant with a grant but a disabled integration, or a suspended tenant, gets nothing', async () => {
      const res = await deliver(
        json([webhookEvent({ portalId: 8008 }), webhookEvent({ portalId: 9009 })]),
      ).expect(200);
      expect(res.body).toMatchObject({ events: 2, stored: 0, unroutable: 2 });
      expect(await receipts(disabled)).toHaveLength(0);
      await withAdmin(infra.adminUrl, async (db) => {
        const { rows } = await db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM tenant_webhook_receipts WHERE tenant_id = $1',
          [suspended.tenantId],
        );
        expect(rows[0]!.n).toBe(0);
      });
    });

    it('a mixed batch is split by account: routed events stored, the rest unroutable', async () => {
      const res = await deliver(
        json([webhookEvent(), webhookEvent({ portalId: 7007 }), webhookEvent()]),
      ).expect(200);
      expect(res.body).toMatchObject({ events: 3, stored: 2, unroutable: 1 });
    });

    it('the static-token tenant on the same account never receives events (coexistence)', async () => {
      expect(await receipts(staticTenant)).toHaveLength(0);
      const route = await h.app.get(OAuthAccountRouter).route('hubspot', '5005');
      expect(route.kind === 'routed' && route.ctx.tenantId).toBe(ok.tenantId);
    });

    it('the router: unknown, ambiguous, malformed ids', async () => {
      const router = h.app.get(OAuthAccountRouter);
      await expect(router.route('hubspot', '7007')).resolves.toEqual({ kind: 'unknown' });
      await expect(router.route('hubspot', '6006')).resolves.toEqual({ kind: 'ambiguous' });
      await expect(router.route('hubspot', "5005' OR '1'='1")).resolves.toEqual({
        kind: 'unknown',
      });
      await expect(router.route('hubspot', '9009')).resolves.toEqual({ kind: 'unknown' });
    });
  });

  describe('isolation (forced RLS)', () => {
    it('receipts are visible only inside their own tenant transaction', async () => {
      const db = h.app.get(TenantDatabase);
      const seen = async (t: TenantContext) =>
        db.transaction(t, (tx) =>
          tenantClient(tx).tenantWebhookReceipt.findMany({ select: { tenantId: true } }),
        );
      const own = await seen(ok);
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((r) => r.tenantId === ok.tenantId)).toBe(true);
      expect(await seen(staticTenant)).toEqual([]);
      // The app role with no tenant set sees nothing at all.
      const appUrl = withCredentials(infra.adminUrl, APP_LOGIN.user, APP_LOGIN.password);
      await withAdmin(appUrl, async (c) => {
        const { rows } = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM tenant_webhook_receipts',
        );
        expect(rows[0]!.n).toBe(0);
        // …and cannot write a receipt for a tenant outside a tenant transaction.
        await expect(
          c.query(
            `INSERT INTO tenant_webhook_receipts (tenant_id, system, delivery_key, event_id, subscription_id,
               account_id, app_id, subscription_type, occurred_at, first_attempt_number, last_attempt_number)
             VALUES ($1, 'hubspot', repeat('a', 64), '1', '1', '5005', '1', 'object.creation', now(), 0, 0)`,
            [ok.tenantId],
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });

    it('the routing function returns tenant ids only; the app role still cannot read grants', async () => {
      const appUrl = withCredentials(infra.adminUrl, APP_LOGIN.user, APP_LOGIN.password);
      await withAdmin(appUrl, async (c) => {
        const routed = await c.query<Record<string, unknown>>(
          "SELECT * FROM app_route_oauth_account('hubspot', '5005')",
        );
        expect(routed.rows).toEqual([{ tenant_id: ok.tenantId }]);
        const grants = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM tenant_oauth_tokens',
        );
        expect(grants.rows[0]!.n).toBe(0);
        await expect(c.query('SET ROLE lip_webhook_router')).rejects.toThrow(/permission denied/);
      });
    });

    it('the database refuses a receipt column holding a value instead of an identifier', async () => {
      await withAdmin(infra.adminUrl, async (c) => {
        await expect(
          c.query(
            `INSERT INTO tenant_webhook_receipts (tenant_id, system, delivery_key, event_id, subscription_id,
               account_id, app_id, subscription_type, property_name, occurred_at, first_attempt_number, last_attempt_number)
             VALUES ($1, 'hubspot', repeat('b', 64), '1', '1', '5005', '1', 'object.propertyChange',
                     $2, now(), 0, 0)`,
            [ok.tenantId, VALUE_MARKER],
          ),
        ).rejects.toThrow(/tenant_webhook_receipts_property_name_format/);
      });
    });
  });

  describe('reporting', () => {
    it('summarises receipts as safe metadata', async () => {
      const summary = await h.app.get(WebhookReceiptRepository).summary(ok);
      expect(summary.receipts).toBeGreaterThan(5);
      expect(summary.redelivered).toBeGreaterThanOrEqual(2);
      expect(summary.totalDeliveries).toBeGreaterThan(summary.receipts);
      expect(summary.maxAttemptNumber).toBe(2);
      expect(summary.byType).toEqual(
        expect.arrayContaining([
          {
            subscriptionType: 'object.creation',
            objectTypeId: '0-136',
            propertyName: null,
            receipts: 1,
          },
          {
            subscriptionType: 'object.propertyChange',
            objectTypeId: '0-2',
            propertyName: 'name',
            receipts: 1,
          },
        ]),
      );
    });

    it('lists recent receipts as metadata only (ids, types, attempts, times)', async () => {
      const rows = await h.app.get(WebhookReceiptRepository).recent(ok, 5);
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([
          'changeSource',
          'deliveries',
          'eventId',
          'firstAttemptNumber',
          'lastAttemptNumber',
          'lastReceivedAt',
          'objectId',
          'objectTypeId',
          'occurredAt',
          'propertyName',
          'receivedAt',
          'subscriptionId',
          'subscriptionType',
        ]);
      }
      // Newest first.
      const times = rows.map((r) => r.receivedAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      expect(JSON.stringify(rows)).not.toContain(VALUE_MARKER);
      // Tenant-scoped: the static tenant has none.
      await expect(h.app.get(WebhookReceiptRepository).recent(staticTenant, 5)).resolves.toEqual(
        [],
      );
    });
  });

  it('webhook intake made no HubSpot API call (no CRM reads in reaction to events)', () => {
    // Every request the fake saw came from installing the test tenants.
    expect(fake.requests.every((r) => r.path.startsWith('/oauth/'))).toBe(true);
    expect(fake.oauthCalls.revoke).toBe(0);
  });
});

describe('HubSpot webhook intake without configuration', () => {
  it('answers 503 not_configured and verifies nothing', async () => {
    const saved = {
      id: process.env.HUBSPOT_APP_ID,
      url: process.env.HUBSPOT_WEBHOOK_TARGET_URL,
    };
    delete process.env.HUBSPOT_APP_ID;
    delete process.env.HUBSPOT_WEBHOOK_TARGET_URL;
    const infra = await startInfrastructure();
    const app = await createApiApp(infra.config);
    try {
      await app.init();
      const res = await request(app.getHttpServer() as App)
        .post('/webhooks/hubspot')
        .set('content-type', 'application/json')
        .send('[]')
        .expect(503);
      expect(res.body).toEqual({ status: 'error', reason: 'not_configured' });
    } finally {
      await app.close();
      await infra.stop();
      if (saved.id !== undefined) process.env.HUBSPOT_APP_ID = saved.id;
      if (saved.url !== undefined) process.env.HUBSPOT_WEBHOOK_TARGET_URL = saved.url;
    }
  });
});
