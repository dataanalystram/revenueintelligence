import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CRM_CONNECTOR, type CrmConnector } from '../../src/modules/crm';
import {
  HUBSPOT_OAUTH_SCOPES,
  HubSpotConnector,
  HubSpotError,
  HubSpotOAuthService,
} from '../../src/modules/hubspot';
import {
  OAuthStateError,
  OAuthStateService,
  TENANT_OAUTH_GRANT_STORE,
  TenantDatabase,
  tenantClient,
  type TenantContext,
  type TenantOAuthGrantStore,
} from '../../src/modules/tenancy';
import { TokenCipher, TokenDecryptionError } from '../../src/platform/crypto';
import { EnvSecretProvider, Secret } from '../../src/platform/secrets';
import { startInfrastructure, withAdmin, type TestInfrastructure } from '../support/containers';
import { ALL_READ_SCOPES, FakeHubSpot, sampleData } from '../support/fake-hubspot';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/**
 * HubSpot OAuth end to end (ADR 0010) against PostgreSQL (forced RLS) and the
 * fake HubSpot OAuth server: install URL, callback, single-use state, account
 * validation, encrypted grant storage, tenant isolation and access-token
 * refresh serialised across independent service instances.
 */
describe('HubSpot OAuth (tenant-scoped, encrypted, single-use state)', () => {
  let infra: TestInfrastructure;
  let h: TenancyHarness;
  /** A second, independent application instance (own pool, own caches): another process. */
  let h2: TenancyHarness;
  let fake: FakeHubSpot;
  /** Revokes the wrong-account install tests caused (the only legitimate ones). */
  let mismatchRevokes = 0;
  const envSet = new Map<string, string | undefined>();

  const STATIC_TOKEN = 'service-key-for-static-tenant';
  const APP = {
    clientId: 'fake-client-id-0001',
    clientSecret: 'fake-client-secret-value',
    redirectUri: 'http://127.0.0.1:65000/oauth/hubspot/callback',
  };
  const ENCRYPTION_KEY = randomBytes(32).toString('base64');

  function setEnv(name: string, value: string): void {
    if (!envSet.has(name)) envSet.set(name, process.env[name]);
    process.env[name] = value;
  }

  const oauth = (x: TenancyHarness = h) => x.app.get(HubSpotOAuthService);
  const states = (x: TenancyHarness = h) => x.app.get(OAuthStateService);
  const grants = (x: TenancyHarness = h) =>
    x.app.get<TenantOAuthGrantStore>(TENANT_OAUTH_GRANT_STORE);
  const connector = (x: TenancyHarness = h) => x.app.get(HubSpotConnector);

  async function configureOAuth(ctx: TenantContext, portalId: string): Promise<void> {
    await h.config.configureIntegration(ctx, 'hubspot', {
      access: 'read_only',
      settings: { portalId, auth: 'oauth' },
    });
  }

  /** Walks the install exactly as a browser would: install URL → consent redirect → callback. */
  async function install(ctx: TenantContext) {
    const { url } = await oauth().installUrl(ctx);
    // On HubSpot's generic consent page the admin picks the account: the tenant's own.
    const integration = await h.config.getIntegration(ctx, 'hubspot');
    fake.configureOAuth({ consentPortalId: Number(integration.settings.portalId) });
    const consent = await fetch(url, { redirect: 'manual' });
    expect(consent.status).toBe(302);
    const back = new URL(consent.headers.get('location')!);
    const code = back.searchParams.get('code')!;
    const state = back.searchParams.get('state')!;
    return { code, state, done: await oauth().completeInstall({ code, state }) };
  }

  async function rejection(p: Promise<unknown>): Promise<unknown> {
    return await p.then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e,
    );
  }

  async function hubspotRejection(p: Promise<unknown>): Promise<HubSpotError> {
    const err = await rejection(p);
    expect(err).toBeInstanceOf(HubSpotError);
    return err as HubSpotError;
  }

  async function tokenRow(ctx: TenantContext) {
    return await withAdmin(infra.adminUrl, async (db) => {
      const { rows } = await db.query<{
        account_id: string;
        refresh_token_enc: string;
        access_token_enc: string | null;
        access_token_expires_at: Date | null;
      }>('SELECT * FROM tenant_oauth_tokens WHERE tenant_id = $1', [ctx.tenantId]);
      return rows[0];
    });
  }

  /** Makes the stored access token look expired (as the owner, bypassing RLS) and clears caches. */
  async function expireAccessToken(ctx: TenantContext): Promise<void> {
    await withAdmin(infra.adminUrl, (db) =>
      db.query(
        "UPDATE tenant_oauth_tokens SET access_token_expires_at = now() - interval '1 minute' WHERE tenant_id = $1",
        [ctx.tenantId],
      ),
    );
    oauth(h).clearCache();
    oauth(h2).clearCache();
  }

  beforeAll(async () => {
    fake = await new FakeHubSpot({
      accounts: {
        [STATIC_TOKEN]: {
          portalId: 1001,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
        // Templates for the accounts OAuth installs grant access to.
        'unused-template-3003': {
          portalId: 3003,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
        'unused-template-4004': {
          portalId: 4004,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
      },
      oauth: { ...APP, refreshDelayMs: 300 },
      ...sampleData(),
    }).start();
    setEnv('HUBSPOT_API_BASE_URL', fake.url);
    setEnv('HUBSPOT_OAUTH_AUTHORIZE_BASE_URL', `${fake.url}/oauth`);
    setEnv('HUBSPOT_APP_CLIENT_ID', APP.clientId);
    setEnv('HUBSPOT_APP_REDIRECT_URI', APP.redirectUri);
    setEnv('HUBSPOT_APP_CLIENT_SECRET', APP.clientSecret);
    setEnv('PLATFORM_TOKEN_ENCRYPTION_KEY', ENCRYPTION_KEY);
    setEnv('HUBSPOT_MAX_RETRIES', '0');
    infra = await startInfrastructure();
    h = await startTenancy(infra.config);
    h2 = await startTenancy(infra.config);
  });

  afterEach(() => {
    fake.requests.length = 0;
  });

  afterAll(async () => {
    for (const [name, previous] of envSet) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    await h2?.close();
    await h?.close();
    await infra?.stop();
    await fake?.stop();
  });

  describe('install URL', () => {
    it('targets the tenant’s configured account with read-only scopes and a signed state', async () => {
      const t = await provisionTenant(h, 'oaurl');
      await configureOAuth(t, '3003');
      const { url, expiresAt } = await oauth().installUrl(t);
      const u = new URL(url);
      // HubSpot's generic consent path (as on the deployed app's page); the account is
      // enforced after the code exchange, not by the path.
      expect(`${u.origin}${u.pathname}`).toBe(`${fake.url}/oauth/authorize`);
      expect([...u.searchParams.keys()].sort()).toEqual([
        'client_id',
        'redirect_uri',
        'scope',
        'state',
      ]);
      expect(u.searchParams.get('client_id')).toBe(APP.clientId);
      expect(u.searchParams.get('redirect_uri')).toBe(APP.redirectUri);
      expect(u.searchParams.get('scope')!.split(' ')).toEqual([...HUBSPOT_OAUTH_SCOPES]);
      expect(u.searchParams.get('scope')!.split(' ')[0]).toBe('oauth');
      expect(u.searchParams.get('scope')).not.toMatch(/write/);
      expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
      expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(url).not.toContain(APP.clientSecret);
    });

    it('is refused for a tenant not configured for OAuth', async () => {
      const t = await provisionTenant(h, 'oanotoauth');
      await h.config.configureIntegration(t, 'hubspot', {
        access: 'read_only',
        settings: { portalId: '3003' },
      });
      expect((await hubspotRejection(oauth().installUrl(t))).kind).toBe('not_configured');
    });
  });

  describe('fake install (callback)', () => {
    it('exchanges the code, checks the account, stores the grant encrypted, and reads through CrmReader', async () => {
      const t = await provisionTenant(h, 'oainst');
      await configureOAuth(t, '3003');
      const { done } = await install(t);
      expect(done).toEqual({ tenantId: t.tenantId, tenantSlug: t.tenantSlug, accountId: '3003' });

      // Stored: ciphertext only, bound to this tenant.
      const row = (await tokenRow(t))!;
      const grant = (await grants().get(t, 'hubspot'))!;
      const refresh = grant.refreshToken.reveal();
      const access = grant.accessToken!.token.reveal();
      expect(refresh).toMatch(/^refresh-/);
      expect(row.account_id).toBe('3003');
      expect(row.refresh_token_enc).toMatch(/^v1:[A-Za-z0-9_-]{38,}$/);
      expect(row.access_token_enc).toMatch(/^v1:[A-Za-z0-9_-]{38,}$/);
      const everything = JSON.stringify(row);
      expect(everything).not.toContain(refresh);
      expect(everything).not.toContain(access);
      // Not merely encoded: the decoded payload does not contain the token either.
      for (const enc of [row.refresh_token_enc, row.access_token_enc!]) {
        const decoded = Buffer.from(enc.slice(3), 'base64url').toString('latin1');
        expect(decoded).not.toContain(refresh);
        expect(decoded).not.toContain(access);
      }
      expect(JSON.stringify(grant)).not.toContain(refresh); // Secret redacts on serialisation

      // Reads go through the vendor-neutral port with the OAuth access token.
      const crm = await h.app.get<CrmConnector>(CRM_CONNECTOR).forTenant(t);
      await expect(crm.getAccount()).resolves.toMatchObject({
        system: 'hubspot',
        accountId: '3003',
      });
      const page = await crm.listRecords('person', { limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${access}`);
    });

    it('a code for a different HubSpot account is rejected and nothing is stored', async () => {
      const t = await provisionTenant(h, 'oamism');
      await configureOAuth(t, '3003');
      const { state } = await states().issue(t, 'hubspot');
      const code = fake.issueCode(4004); // the user installed into another account
      const revokesBefore = fake.oauthCalls.revoke;
      const err = await hubspotRejection(oauth().completeInstall({ code, state }));
      expect(err.kind).toBe('account_mismatch');
      expect(err.message).toMatch(/nothing was stored and the grant was revoked/);
      expect(await tokenRow(t)).toBeUndefined();
      await expect(grants().get(t, 'hubspot')).resolves.toBeUndefined();
      // The refused grant was given back to HubSpot: exactly one revoke, and no
      // refresh token for the foreign account remains valid.
      expect(fake.oauthCalls.revoke - revokesBefore).toBe(1);
      mismatchRevokes += 1;
      expect(fake.activeRefreshTokens(4004)).toBe(0);
    });

    it('if HubSpot refuses the revoke, the install is still refused and nothing is stored', async () => {
      const t = await provisionTenant(h, 'oamisrv');
      await configureOAuth(t, '3003');
      const { state } = await states().issue(t, 'hubspot');
      const code = fake.issueCode(4004);
      fake.fail({ match: /^POST \/oauth\/2026-03\/token\/revoke$/, status: 503 });
      const err = await hubspotRejection(oauth().completeInstall({ code, state }));
      // Attempted once (the injected fault answered it, so the fake's counter is unchanged).
      expect(fake.requests.filter((r) => r.path === '/oauth/2026-03/token/revoke')).toHaveLength(1);
      expect(err.kind).toBe('account_mismatch');
      expect(err.message).toMatch(/nothing was stored and the grant was NOT revoked/);
      expect(await tokenRow(t)).toBeUndefined();
    });

    it('the tenant-bound state installs only into the tenant it was issued for', async () => {
      const a = await provisionTenant(h, 'oabinda');
      const b = await provisionTenant(h, 'oabindb');
      await configureOAuth(a, '3003');
      await configureOAuth(b, '3003');
      const { done } = await install(a);
      expect(done.tenantId).toBe(a.tenantId);
      expect(await tokenRow(b)).toBeUndefined();
    });
  });

  describe('single-use state', () => {
    it('a redeemed state cannot be replayed (the code is not even exchanged again)', async () => {
      const t = await provisionTenant(h, 'oareplay');
      await configureOAuth(t, '3003');
      const { state } = await install(t);
      const exchanges = fake.oauthCalls.authorizationCode;
      const code = fake.issueCode(3003);
      const err = await hubspotRejection(oauth().completeInstall({ code, state }));
      expect(err.kind).toBe('bad_request');
      expect(err.details.category).toBe('oauth_state_unknown_or_used');
      expect(fake.oauthCalls.authorizationCode).toBe(exchanges);
    });

    it('concurrent redemptions from two independent instances: exactly one succeeds', async () => {
      const t = await provisionTenant(h, 'oarace');
      await configureOAuth(t, '3003');
      const { state } = await states().issue(t, 'hubspot');
      const attempts = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) => states(i % 2 ? h2 : h).redeem(state, 'hubspot')),
      );
      const won = attempts.filter((a) => a.status === 'fulfilled');
      const lost = attempts.filter((a) => a.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(11);
      for (const l of lost) {
        expect(l.reason).toBeInstanceOf(OAuthStateError);
        expect((l.reason as OAuthStateError).reason).toBe('unknown_or_used');
      }
    });

    it('survives a restart: a state issued by one instance is redeemable once by another', async () => {
      const t = await provisionTenant(h, 'oarestart');
      await configureOAuth(t, '3003');
      const { state } = await states(h).issue(t, 'hubspot');
      const other = await startTenancy(infra.config); // a freshly started process
      try {
        await expect(
          other.app.get(OAuthStateService).redeem(state, 'hubspot'),
        ).resolves.toMatchObject({
          tenantId: t.tenantId,
        });
        const again = await rejection(other.app.get(OAuthStateService).redeem(state, 'hubspot'));
        expect((again as OAuthStateError).reason).toBe('unknown_or_used');
      } finally {
        await other.close();
      }
    });

    it('a tampered state is rejected before anything is looked up', async () => {
      const t = await provisionTenant(h, 'oatamper');
      const other = await provisionTenant(h, 'oatamper2');
      const { state } = await states().issue(t, 'hubspot');
      const [payload, sig] = state.split('.') as [string, string];
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { t: string };
      // Same signature, payload re-pointed at another tenant.
      const forged = Buffer.from(JSON.stringify({ ...claims, t: other.tenantId })).toString(
        'base64url',
      );
      const flipped = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
      for (const bad of [`${forged}.${sig}`, `${flipped}.${sig}`, `${payload}.${'A'.repeat(43)}`]) {
        expect(((await rejection(states().redeem(bad, 'hubspot'))) as OAuthStateError).reason).toBe(
          'bad_signature',
        );
      }
      expect(
        ((await rejection(states().redeem('not-a-state', 'hubspot'))) as OAuthStateError).reason,
      ).toBe('malformed');
      // The genuine state is still redeemable once.
      await expect(states().redeem(state, 'hubspot')).resolves.toMatchObject({
        tenantId: t.tenantId,
      });
    });

    it('an expired state is rejected', async () => {
      const t = await provisionTenant(h, 'oaexpired');
      const { state } = await states().issue(t, 'hubspot', new Date(Date.now() - 11 * 60_000));
      expect(((await rejection(states().redeem(state, 'hubspot'))) as OAuthStateError).reason).toBe(
        'expired',
      );
    });
  });

  describe('encryption at rest', () => {
    it('only the platform key decrypts; the wrong key fails', async () => {
      const t = await provisionTenant(h, 'oakey');
      await configureOAuth(t, '3003');
      await install(t);
      const row = (await tokenRow(t))!;
      const aad = `tenant_oauth_tokens|${t.tenantId}|hubspot|refresh_token`;
      const right = new TokenCipher(new Secret(ENCRYPTION_KEY));
      expect(right.decrypt(row.refresh_token_enc, aad).reveal()).toMatch(/^refresh-/);
      const wrong = new TokenCipher(new Secret(randomBytes(32).toString('base64')));
      expect(() => wrong.decrypt(row.refresh_token_enc, aad)).toThrow(TokenDecryptionError);
    });

    it('tampered ciphertext is detected and the token is not used', async () => {
      const t = await provisionTenant(h, 'oatampct');
      await configureOAuth(t, '3003');
      await install(t);
      const row = (await tokenRow(t))!;
      const body = row.access_token_enc!;
      const i = body.length - 10;
      const tampered = `${body.slice(0, i)}${body[i] === 'A' ? 'B' : 'A'}${body.slice(i + 1)}`;
      await withAdmin(infra.adminUrl, (db) =>
        db.query('UPDATE tenant_oauth_tokens SET access_token_enc = $2 WHERE tenant_id = $1', [
          t.tenantId,
          tampered,
        ]),
      );
      oauth().clearCache();
      await expect(grants().get(t, 'hubspot')).rejects.toBeInstanceOf(TokenDecryptionError);
      const before = fake.requests.length;
      const err = await hubspotRejection(connector().forTenant(t));
      expect(err.kind).toBe('not_configured');
      expect(err.message).toMatch(/could not be decrypted/);
      expect(fake.requests).toHaveLength(before); // nothing was sent to HubSpot
    });

    it('the database refuses a plaintext token', async () => {
      const t = await provisionTenant(h, 'oaplain');
      const err = await rejection(
        withAdmin(infra.adminUrl, (db) =>
          db.query(
            "INSERT INTO tenant_oauth_tokens (tenant_id, system, account_id, refresh_token_enc, updated_at) VALUES ($1, 'hubspot', '3003', 'refresh-plaintext-token-value-0123456789', now())",
            [t.tenantId],
          ),
        ),
      );
      expect(String(err)).toMatch(/tenant_oauth_tokens_refresh_encrypted/);
    });
  });

  describe('tenant isolation', () => {
    it('RLS: a tenant transaction sees only its own grant and states', async () => {
      const a = await provisionTenant(h, 'oarlsa');
      const b = await provisionTenant(h, 'oarlsb');
      await configureOAuth(a, '3003');
      await configureOAuth(b, '4004');
      await install(a);
      await install(b);
      await states().issue(b, 'hubspot');
      const seen = await h.app.get(TenantDatabase).transaction(a, async (tx) => {
        const db = tenantClient(tx);
        const tokens = await db.$queryRaw<
          { tenant_id: string }[]
        >`SELECT tenant_id::text FROM tenant_oauth_tokens`;
        const pending = await db.$queryRaw<
          { tenant_id: string }[]
        >`SELECT tenant_id::text FROM tenant_oauth_states`;
        return { tokens, pending };
      });
      expect(seen.tokens.map((r) => r.tenant_id)).toEqual([a.tenantId]);
      expect(seen.pending.every((r) => r.tenant_id === a.tenantId)).toBe(true);
      const forced = await withAdmin(
        infra.adminUrl,
        async (db) =>
          (
            await db.query<{
              relname: string;
              relrowsecurity: boolean;
              relforcerowsecurity: boolean;
            }>(
              "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('tenant_oauth_tokens', 'tenant_oauth_states') ORDER BY relname",
            )
          ).rows,
      );
      expect(forced).toEqual([
        { relname: 'tenant_oauth_states', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'tenant_oauth_tokens', relrowsecurity: true, relforcerowsecurity: true },
      ]);
    });

    it("tenant A cannot use tenant B's token, even if B's ciphertext is copied into A's row", async () => {
      const a = await provisionTenant(h, 'oacopya');
      const b = await provisionTenant(h, 'oacopyb');
      await configureOAuth(a, '4004');
      await configureOAuth(b, '4004');
      await expect(grants().get(a, 'hubspot')).resolves.toBeUndefined(); // A has nothing of its own
      await install(b);
      await expect(grants().get(a, 'hubspot')).resolves.toBeUndefined(); // B's grant is invisible to A
      expect((await hubspotRejection(connector().forTenant(a))).kind).toBe(
        'reauthorization_required',
      );

      // An attacker with database write access copies B's encrypted row into A.
      await withAdmin(infra.adminUrl, (db) =>
        db.query(
          `INSERT INTO tenant_oauth_tokens (tenant_id, system, account_id, refresh_token_enc, access_token_enc, access_token_expires_at, updated_at)
           SELECT $1, system, account_id, refresh_token_enc, access_token_enc, access_token_expires_at, now()
             FROM tenant_oauth_tokens WHERE tenant_id = $2`,
          [a.tenantId, b.tenantId],
        ),
      );
      oauth().clearCache();
      await expect(grants().get(a, 'hubspot')).rejects.toBeInstanceOf(TokenDecryptionError);
      const before = fake.requests.length;
      expect((await hubspotRejection(connector().forTenant(a))).kind).toBe('not_configured');
      expect(fake.requests).toHaveLength(before);
    });
  });

  describe('access-token refresh', () => {
    it('an expired access token is refreshed once and the new one is stored encrypted', async () => {
      const t = await provisionTenant(h, 'oarefresh');
      await configureOAuth(t, '3003');
      await install(t);
      const firstAccess = (await grants().get(t, 'hubspot'))!.accessToken!.token.reveal();
      await expireAccessToken(t);
      const refreshes = fake.oauthCalls.refreshToken;
      const token = await oauth().accessToken(t, '3003');
      expect(fake.oauthCalls.refreshToken).toBe(refreshes + 1);
      expect(token.reveal()).not.toBe(firstAccess);
      const stored = (await grants().get(t, 'hubspot'))!;
      expect(stored.accessToken!.token.reveal()).toBe(token.reveal());
      expect(stored.accessToken!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
      // Fresh now: no further refresh.
      await oauth().accessToken(t, '3003');
      expect(fake.oauthCalls.refreshToken).toBe(refreshes + 1);
    });

    it('concurrent requests from two independent instances cause exactly one refresh at HubSpot', async () => {
      const t = await provisionTenant(h, 'oalock');
      await configureOAuth(t, '3003');
      await install(t);
      await expireAccessToken(t);
      const refreshes = fake.oauthCalls.refreshToken;
      const tokens = await Promise.all(
        Array.from({ length: 10 }, (_, i) => oauth(i % 2 ? h2 : h).accessToken(t, '3003')),
      );
      expect(fake.oauthCalls.refreshToken - refreshes).toBe(1);
      expect(new Set(tokens.map((x) => x.reveal())).size).toBe(1);
    });

    it('a rotated refresh token replaces the old one', async () => {
      const t = await provisionTenant(h, 'oarotate');
      await configureOAuth(t, '3003');
      await install(t);
      const oldRefresh = (await grants().get(t, 'hubspot'))!.refreshToken.reveal();
      fake.configureOAuth({ rotateRefreshTokens: true });
      try {
        await expireAccessToken(t);
        await oauth().accessToken(t, '3003');
        const newRefresh = (await grants().get(t, 'hubspot'))!.refreshToken.reveal();
        expect(newRefresh).not.toBe(oldRefresh);
        await expireAccessToken(t);
        await expect(oauth().accessToken(t, '3003')).resolves.toBeInstanceOf(Secret); // the new one works
      } finally {
        fake.configureOAuth({ rotateRefreshTokens: false });
      }
    });

    it('refresh evidence: the expire hook forces exactly one real refresh; outcomes hold facts, never tokens', async () => {
      const t = await provisionTenant(h, 'oaevidence');
      await configureOAuth(t, '3003');
      await install(t);
      const before = (await grants().get(t, 'hubspot'))!;
      const refreshesBefore = fake.oauthCalls.refreshToken;
      const outcomesBefore = oauth().refreshOutcomes().length;

      // Without rotation (the fake then returns no refresh_token on refresh).
      await expect(oauth().expireStoredAccessToken(t)).resolves.toBe(true);
      expect(fake.oauthCalls.refreshToken).toBe(refreshesBefore); // expiring calls nobody
      const token = await oauth().accessToken(t, '3003');
      expect(fake.oauthCalls.refreshToken).toBe(refreshesBefore + 1);
      const after = (await grants().get(t, 'hubspot'))!;
      expect(token.reveal()).not.toBe(before.accessToken!.token.reveal());
      expect(after.refreshToken.reveal()).toBe(before.refreshToken.reveal());
      const plain = oauth().refreshOutcomes().slice(outcomesBefore);
      expect(plain).toHaveLength(1);
      expect(plain[0]).toMatchObject({ refreshTokenReturned: false, refreshTokenRotated: false });

      // With rotation.
      fake.configureOAuth({ rotateRefreshTokens: true });
      try {
        await oauth().expireStoredAccessToken(t);
        await oauth().accessToken(t, '3003');
      } finally {
        fake.configureOAuth({ rotateRefreshTokens: false });
      }
      const rotated = oauth().refreshOutcomes().at(-1)!;
      expect(rotated).toMatchObject({ refreshTokenReturned: true, refreshTokenRotated: true });
      const latest = (await grants().get(t, 'hubspot'))!;
      expect(latest.refreshToken.reveal()).not.toBe(before.refreshToken.reveal());

      // Facts only: no token in the outcomes.
      const json = JSON.stringify(oauth().refreshOutcomes());
      for (const secret of [
        before.refreshToken.reveal(),
        latest.refreshToken.reveal(),
        token.reveal(),
        latest.accessToken!.token.reveal(),
      ]) {
        expect(json).not.toContain(secret);
      }
    });

    it('the expire hook on a tenant without a grant changes nothing and calls nobody', async () => {
      const t = await provisionTenant(h, 'oaexpirenone');
      await configureOAuth(t, '3003');
      const calls = fake.oauthCalls.refreshToken;
      await expect(oauth().expireStoredAccessToken(t)).resolves.toBe(false);
      expect(fake.oauthCalls.refreshToken).toBe(calls);
      expect(await tokenRow(t)).toBeUndefined();
    });

    it('a revoked grant → reauthorization_required, never a silent failure', async () => {
      const t = await provisionTenant(h, 'oarevoked');
      await configureOAuth(t, '3003');
      await install(t);
      await expireAccessToken(t);
      fake.revokeRefreshTokens();
      const err = await hubspotRejection(oauth().accessToken(t, '3003'));
      expect(err.kind).toBe('reauthorization_required');
      expect(err.message).not.toMatch(/refresh-/);
    });
  });

  describe('refresh within one process, and 401 recovery', () => {
    it('20 concurrent callers in one process share one locked refresh (one pooled connection)', async () => {
      const t = await provisionTenant(h, 'oaflight');
      await configureOAuth(t, '3003');
      await install(t);
      await expireAccessToken(t);
      const spy = vi.spyOn(grants(h), 'withLockedGrant');
      const refreshes = fake.oauthCalls.refreshToken;
      try {
        const tokens = await Promise.all(
          Array.from({ length: 20 }, () => oauth(h).accessToken(t, '3003')),
        );
        expect(spy).toHaveBeenCalledTimes(1);
        expect(fake.oauthCalls.refreshToken - refreshes).toBe(1);
        expect(new Set(tokens.map((x) => x.reveal())).size).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('after a reinstall handled by another process, a 401 makes this process pick up the new grant', async () => {
      const t = await provisionTenant(h, 'oareinst');
      await configureOAuth(t, '3003');
      await install(t);
      const crm = await connector(h).forTenant(t); // h now caches the first access token
      await crm.listRecords('person', { limit: 1 });
      const first = fake.requests.at(-1)!.authorization!.slice('Bearer '.length);

      // The customer reinstalls; the callback runs in another API instance (h2).
      const { url } = await oauth(h2).installUrl(t);
      const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
      await oauth(h2).completeInstall({
        code: back.searchParams.get('code')!,
        state: back.searchParams.get('state')!,
      });
      fake.revokeAccessToken(first); // HubSpot revoked the old grant's token
      const refreshes = fake.oauthCalls.refreshToken;

      await expect(crm.listRecords('person', { limit: 1 })).resolves.toBeDefined();
      const second = fake.requests.at(-1)!.authorization!.slice('Bearer '.length);
      expect(second).not.toBe(first);
      expect(second).toBe((await grants().get(t, 'hubspot'))!.accessToken!.token.reveal());
      expect(fake.oauthCalls.refreshToken).toBe(refreshes); // the stored new token was reused
    });

    it('a revoked access token with a valid refresh token → 401, one refresh, success', async () => {
      const t = await provisionTenant(h, 'oarevacc');
      await configureOAuth(t, '3003');
      await install(t);
      const crm = await connector(h).forTenant(t);
      await crm.listRecords('company', { limit: 1 });
      fake.revokeAccessToken(fake.requests.at(-1)!.authorization!.slice('Bearer '.length));
      const refreshes = fake.oauthCalls.refreshToken;
      await expect(crm.listRecords('company', { limit: 1 })).resolves.toBeDefined();
      expect(fake.oauthCalls.refreshToken - refreshes).toBe(1);
    });

    it('after a failed shared refresh, the next caller refreshes and succeeds', async () => {
      const t = await provisionTenant(h, 'oarefail');
      await configureOAuth(t, '3003');
      await install(t);
      await expireAccessToken(t);
      fake.fail({
        match: /^POST \/oauth\/2026-09\/token$/,
        status: 503,
        body: { message: 'down' },
      });
      const failed = await hubspotRejection(oauth(h).accessToken(t, '3003'));
      expect(failed.kind).toBe('server_error');
      await expect(oauth(h).accessToken(t, '3003')).resolves.toBeInstanceOf(Secret);
    });

    it('both tokens revoked → reauthorization_required after one re-authentication attempt', async () => {
      const t = await provisionTenant(h, 'oarevall');
      await configureOAuth(t, '3003');
      await install(t);
      const crm = await connector(h).forTenant(t);
      await crm.listRecords('lead', { limit: 1 });
      fake.revokeAccessToken(fake.requests.at(-1)!.authorization!.slice('Bearer '.length));
      fake.revokeRefreshTokens();
      const err = await hubspotRejection(crm.listRecords('lead', { limit: 1 }));
      expect(err.kind).toBe('reauthorization_required');
    });
  });

  describe('static Service Key tenants are unchanged', () => {
    it('reads with the tenant credential, and never touches OAuth', async () => {
      const t = await provisionTenant(h, 'oastatic');
      await h.config.configureIntegration(t, 'hubspot', {
        access: 'read_only',
        settings: { portalId: '1001' },
      });
      await h.credentials.register(t, 'hubspot', 'access_token');
      setEnv(
        EnvSecretProvider.toEnvName(`tenant.${t.tenantSlug}.hubspot.access_token`),
        STATIC_TOKEN,
      );
      const crm = await h.app.get<CrmConnector>(CRM_CONNECTOR).forTenant(t);
      await expect(crm.getAccount()).resolves.toMatchObject({ accountId: '1001' });
      expect(fake.requests.every((r) => r.authorization === `Bearer ${STATIC_TOKEN}`)).toBe(true);
      expect(fake.requests.some((r) => r.path.startsWith('/oauth/'))).toBe(false);
      expect(await tokenRow(t)).toBeUndefined();
    });
  });

  describe('read-only', () => {
    it('only CRM reads and the OAuth token endpoint were ever called', async () => {
      const t = await provisionTenant(h, 'oareadonly');
      await configureOAuth(t, '3003');
      await install(t);
      const crm = await connector().forTenant(t);
      await crm.listRecords('lead', { limit: 2 });
      await crm.readAssociations('lead', ['301'], 'person');
      await expireAccessToken(t);
      await crm.listFieldDefinitions('company');
      for (const r of fake.requests) {
        const ok =
          (r.method === 'GET' &&
            /^\/(crm\/(objects|properties|associations)|account-info)\/\d{4}-\d{2}\//.test(
              r.path,
            )) ||
          (r.method === 'POST' &&
            /^\/crm\/associations\/\d{4}-\d{2}\/\w+\/\w+\/batch\/read$/.test(r.path)) ||
          (r.method === 'POST' && r.path === '/oauth/2026-09/token') ||
          // Only ever for a refused wrong-account install (counted by those tests).
          (r.method === 'POST' && r.path === '/oauth/2026-03/token/revoke') ||
          (r.method === 'GET' && r.path === '/oauth/authorize');
        expect(ok, `${r.method} ${r.path}`).toBe(true);
      }
      expect(fake.requests.some((r) => r.path === '/oauth/2026-09/token')).toBe(true);
      // Installs, refreshes, reinstalls and revoked grants never caused a revoke:
      // only the wrong-account installs did, once each.
      // (oauthCalls is cumulative over the whole file; the request log is reset per test.)
      expect(fake.oauthCalls.revoke).toBe(mismatchRevokes);
    });
  });
});
