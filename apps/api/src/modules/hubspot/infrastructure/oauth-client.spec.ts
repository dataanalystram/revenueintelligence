import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_READ_SCOPES, FakeHubSpot } from '../../../../test/support/fake-hubspot';
import { Secret } from '../../../platform/secrets';
import { HubSpotError } from '../errors';
import { loadHubSpotConfig } from '../hubspot.config';
import { assertReadOnlyRequest } from './http-client';
import { HUBSPOT_OAUTH_SCOPES, HubSpotOAuthClient, assertOAuthRequest } from './oauth-client';

const APP = {
  clientId: 'client-id-0001',
  clientSecret: 'client-secret-value',
  redirectUri: 'http://127.0.0.1:9/cb',
};

describe('HubSpot OAuth client (ADR 0010)', () => {
  let fake: FakeHubSpot;
  let client: HubSpotOAuthClient;

  beforeEach(async () => {
    fake = await new FakeHubSpot({
      accounts: {
        tpl: {
          portalId: 77,
          accountType: 'DEVELOPER_TEST',
          scopes: ALL_READ_SCOPES,
          leadsEnabled: true,
        },
      },
      oauth: { ...APP },
    }).start();
    client = new HubSpotOAuthClient(loadHubSpotConfig({ HUBSPOT_API_BASE_URL: fake.url }));
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('requests read-only scopes only', () => {
    expect(HUBSPOT_OAUTH_SCOPES.length).toBeGreaterThan(0);
    for (const scope of HUBSPOT_OAUTH_SCOPES)
      expect(scope).toMatch(/^crm\.(objects|schemas)\.\w+\.read$/);
  });

  it('allows exactly POST to the date-versioned token endpoint and to the one revoke endpoint', () => {
    expect(() => assertOAuthRequest('POST', '/oauth/2026-09/token')).not.toThrow();
    expect(() => assertOAuthRequest('POST', '/oauth/2026-03/token/revoke')).not.toThrow();
    for (const [method, path] of [
      ['POST', '/oauth/v1/token'],
      ['POST', '/oauth/v3/token'],
      ['POST', '/oauth/2026-09/token/revoke'],
      ['POST', '/oauth/2025-09/token/revoke'],
      ['GET', '/oauth/2026-03/token/revoke'],
      ['DELETE', '/oauth/2026-03/token/revoke'],
      ['POST', '/oauth/2026-03/token/revoke/extra'],
      ['POST', '/oauth/2026-03/token/revoke?token=x'],
      ['DELETE', '/oauth/v1/refresh-tokens/abc'],
      ['POST', '/oauth/v1/refresh-tokens/abc'],
      ['POST', '/oauth/2026-09/token/introspect'],
      ['GET', '/oauth/2026-09/token'],
      ['POST', '/oauth/2026-09/../v1/token'],
      ['POST', '/crm/objects/2026-09/contacts'],
    ] as const) {
      expect(() => assertOAuthRequest(method, path), `${method} ${path}`).toThrow(HubSpotError);
    }
  });

  it('the CRM transport still refuses the OAuth endpoint (its guard is not widened)', () => {
    expect(() => assertReadOnlyRequest({ method: 'POST', path: '/oauth/2026-09/token' })).toThrow(
      /read-only/,
    );
  });

  it('exchanges a code (form-encoded, all parameters in the body) and returns the account', async () => {
    const code = fake.issueCode(77, APP.redirectUri);
    const tokens = await client.exchangeCode({
      code: new Secret(code),
      clientId: APP.clientId,
      clientSecret: new Secret(APP.clientSecret),
      redirectUri: APP.redirectUri,
    });
    expect(tokens.accountId).toBe('77');
    expect(tokens.expiresInSeconds).toBe(1800);
    expect(tokens.refreshToken?.reveal()).toMatch(/^refresh-/);
    const req = fake.requests.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/oauth/2026-09/token');
    expect(req.query).toEqual({}); // nothing sensitive in the URL
    expect(new URLSearchParams(req.body as string).get('grant_type')).toBe('authorization_code');
  });

  it('a used code is rejected as bad_request; errors never contain the code or secrets', async () => {
    const code = fake.issueCode(77, APP.redirectUri);
    const input = {
      code: new Secret(code),
      clientId: APP.clientId,
      clientSecret: new Secret(APP.clientSecret),
      redirectUri: APP.redirectUri,
    };
    await client.exchangeCode(input);
    const err = await client.exchangeCode(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubSpotError);
    expect((err as HubSpotError).kind).toBe('bad_request');
    const text = `${String(err)} ${JSON.stringify((err as HubSpotError).details)}`;
    expect(text).not.toContain(code);
    expect(text).not.toContain(APP.clientSecret);
  });

  it('a rejected refresh token → reauthorization_required (never retried)', async () => {
    const err = await client
      .refresh({
        refreshToken: new Secret('refresh-unknown'),
        clientId: APP.clientId,
        clientSecret: new Secret(APP.clientSecret),
      })
      .catch((e: unknown) => e);
    expect((err as HubSpotError).kind).toBe('reauthorization_required');
    expect(String(err)).not.toContain('refresh-unknown');
    expect(fake.oauthCalls.refreshToken).toBe(1);
  });

  it('5xx and malformed responses are classified without echoing the body', async () => {
    fake.fail({ match: /^POST \/oauth\//, status: 503, body: { message: 'down' } });
    const down = await client
      .refresh({
        refreshToken: new Secret('r'),
        clientId: APP.clientId,
        clientSecret: new Secret(APP.clientSecret),
      })
      .catch((e: unknown) => e);
    expect((down as HubSpotError).kind).toBe('server_error');
    fake.fail({
      match: /^POST \/oauth\//,
      status: 200,
      body: { access_token: 'leaky-access-token' },
    });
    const bad = await client
      .refresh({
        refreshToken: new Secret('r'),
        clientId: APP.clientId,
        clientSecret: new Secret(APP.clientSecret),
      })
      .catch((e: unknown) => e);
    expect((bad as HubSpotError).kind).toBe('invalid_payload');
    expect(String(bad)).not.toContain('leaky-access-token');
  });

  it('revokes a refresh token: POST to exactly the revoke endpoint, form body, nothing in the URL', async () => {
    const tokens = await client.exchangeCode({
      code: new Secret(fake.issueCode(77, APP.redirectUri)),
      clientId: APP.clientId,
      clientSecret: new Secret(APP.clientSecret),
      redirectUri: APP.redirectUri,
    });
    const refreshToken = tokens.refreshToken!;
    expect(fake.isRefreshTokenActive(refreshToken.reveal())).toBe(true);
    await client.revokeRefreshToken({
      refreshToken,
      clientId: APP.clientId,
      clientSecret: new Secret(APP.clientSecret),
    });
    expect(fake.isRefreshTokenActive(refreshToken.reveal())).toBe(false);
    const req = fake.requests.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/oauth/2026-03/token/revoke');
    expect(req.query).toEqual({});
    const form = new URLSearchParams(req.body as string);
    expect([...form.keys()].sort()).toEqual(['client_id', 'client_secret', 'token']);
    expect(fake.oauthCalls.revoke).toBe(1);
  });

  it('a failed revoke is classified; the error never contains the token or secret', async () => {
    const err = await client
      .revokeRefreshToken({
        refreshToken: new Secret('refresh-never-issued'),
        clientId: APP.clientId,
        clientSecret: new Secret(APP.clientSecret),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubSpotError);
    expect((err as HubSpotError).kind).toBe('bad_request');
    expect((err as HubSpotError).details.status).toBe(400);
    expect(String(err) + JSON.stringify(err)).not.toMatch(
      /refresh-never-issued|client-secret-value/,
    );
  });
});
