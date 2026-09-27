import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/bootstrap';
import { HubSpotOAuthService } from '../../src/modules/hubspot';
import { OAuthStateService, type TenantContext } from '../../src/modules/tenancy';
import { startInfrastructure, withAdmin, type TestInfrastructure } from '../support/containers';
import { ALL_READ_SCOPES, FakeHubSpot, sampleData } from '../support/fake-hubspot';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/** GET /oauth/hubspot/callback through the real API process (HTTP, filters, logging). */
describe('HubSpot OAuth callback endpoint (API process)', () => {
  let infra: TestInfrastructure;
  let fake: FakeHubSpot;
  let app: INestApplication;
  let http: App;
  let h: TenancyHarness;
  const saved = new Map<string, string | undefined>();
  const APP = {
    clientId: 'fake-client-id-0002',
    clientSecret: 'fake-client-secret-0002',
    redirectUri: 'http://127.0.0.1:65001/oauth/hubspot/callback',
  };

  function setEnv(name: string, value: string): void {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  async function oauthTenant(prefix: string, portalId = '3003'): Promise<TenantContext> {
    const t = await provisionTenant(h, prefix);
    await h.config.configureIntegration(t, 'hubspot', {
      access: 'read_only',
      settings: { portalId, auth: 'oauth' },
    });
    return t;
  }

  /** The callback query HubSpot would send after consent, for a real install link. */
  async function consent(t: TenantContext): Promise<string> {
    const { url } = await h.app.get(HubSpotOAuthService).installUrl(t);
    const res = await fetch(url, { redirect: 'manual' });
    return new URL(res.headers.get('location')!).search;
  }

  async function storedGrants(t: TenantContext): Promise<number> {
    return await withAdmin(infra.adminUrl, async (db) => {
      const { rows } = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM tenant_oauth_tokens WHERE tenant_id = $1',
        [t.tenantId],
      );
      return Number(rows[0]!.n);
    });
  }

  beforeAll(async () => {
    fake = await new FakeHubSpot({
      accounts: {
        tpl3003: {
          portalId: 3003,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
      },
      oauth: { ...APP },
      ...sampleData(),
    }).start();
    setEnv('HUBSPOT_API_BASE_URL', fake.url);
    setEnv('HUBSPOT_OAUTH_AUTHORIZE_BASE_URL', `${fake.url}/oauth`);
    setEnv('HUBSPOT_APP_CLIENT_ID', APP.clientId);
    setEnv('HUBSPOT_APP_REDIRECT_URI', APP.redirectUri);
    setEnv('HUBSPOT_APP_CLIENT_SECRET', APP.clientSecret);
    setEnv('PLATFORM_TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    infra = await startInfrastructure();
    app = await createApiApp(infra.config);
    await app.init();
    http = app.getHttpServer() as App;
    h = await startTenancy(infra.config);
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

  it('completes an install: 200, not cacheable, no referrer, and never echoes the code or state', async () => {
    const t = await oauthTenant('cbok');
    const query = await consent(t);
    const res = await request(http).get(`/oauth/hubspot/callback${query}`).expect(200);
    expect(res.body).toEqual({ status: 'installed', tenant: t.tenantSlug, accountId: '3003' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const params = new URLSearchParams(query);
    expect(res.text).not.toContain(params.get('code')!);
    expect(res.text).not.toContain(params.get('state')!);
    expect(await storedGrants(t)).toBe(1);
    expect(fake.oauthCalls.revoke).toBe(0); // a successful install never revokes anything
  });

  it('replaying the same callback is refused (single-use state)', async () => {
    const t = await oauthTenant('cbreplay');
    const query = await consent(t);
    await request(http).get(`/oauth/hubspot/callback${query}`).expect(200);
    const again = await request(http).get(`/oauth/hubspot/callback${query}`).expect(400);
    expect(again.body).toEqual({ status: 'error', reason: 'invalid_state' });
  });

  it('a forged or malformed state is refused before any HubSpot call', async () => {
    const before = fake.oauthCalls.authorizationCode;
    const forged = `${Buffer.from('{"v":1}').toString('base64url')}.${'A'.repeat(43)}`;
    const res = await request(http)
      .get('/oauth/hubspot/callback')
      .query({ code: 'code-abc', state: forged })
      .expect(400);
    expect(res.body).toEqual({ status: 'error', reason: 'invalid_state' });
    await request(http)
      .get('/oauth/hubspot/callback')
      .query({ code: 'x', state: 'nope' })
      .expect(400);
    await request(http).get('/oauth/hubspot/callback').expect(400);
    expect(fake.oauthCalls.authorizationCode).toBe(before);
  });

  it('a user who declines consent gets a clear refusal, and nothing is stored', async () => {
    const t = await oauthTenant('cbdeny');
    const { state } = await h.app.get(OAuthStateService).issue(t, 'hubspot');
    const res = await request(http)
      .get('/oauth/hubspot/callback')
      .query({ error: 'access_denied', state })
      .expect(400);
    expect(res.body).toEqual({ status: 'error', reason: 'authorization_not_granted' });
    expect(await storedGrants(t)).toBe(0);
  });

  it('a malformed token response from HubSpot → 502 (upstream fault), nothing stored', async () => {
    const t = await oauthTenant('cbbadresp');
    const query = await consent(t);
    fake.fail({ match: /^POST \/oauth\//, status: 200, body: { unexpected: true } });
    const res = await request(http).get(`/oauth/hubspot/callback${query}`).expect(502);
    expect(res.body).toEqual({ status: 'error', reason: 'hubspot_unavailable' });
    expect(await storedGrants(t)).toBe(0);
  });

  it('a callback for a suspended tenant → 409 tenant_not_ready (not 500), nothing stored', async () => {
    const t = await oauthTenant('cbsusp');
    const query = await consent(t);
    await h.registry.suspend(t.tenantId);
    const res = await request(http).get(`/oauth/hubspot/callback${query}`).expect(409);
    expect(res.body).toEqual({ status: 'error', reason: 'tenant_not_ready' });
    expect(await storedGrants(t)).toBe(0);
  });

  it('an install into a different HubSpot account → 409, nothing stored, the grant revoked', async () => {
    const t = await oauthTenant('cbmism');
    const { state } = await h.app.get(OAuthStateService).issue(t, 'hubspot');
    const revokes = fake.oauthCalls.revoke;
    const res = await request(http)
      .get('/oauth/hubspot/callback')
      .query({ code: fake.issueCode(4004, APP.redirectUri), state })
      .expect(409);
    expect(res.body).toEqual({ status: 'error', reason: 'account_mismatch' });
    expect(await storedGrants(t)).toBe(0);
    expect(fake.oauthCalls.revoke - revokes).toBe(1);
    expect(fake.activeRefreshTokens(4004)).toBe(0);
  });

  it('no other refusal revokes anything (declined, bad state, bad response, suspended)', () => {
    // Runs last: every earlier refusal in this file happened before the grant check.
    expect(fake.requests.filter((r) => r.path === '/oauth/2026-03/token/revoke')).toHaveLength(1);
  });
});
