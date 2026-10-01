import { describe, expect, it } from 'vitest';
import { loadHubSpotConfig } from '../hubspot.config';
import { HUBSPOT_OAUTH_SCOPES } from '../infrastructure/oauth-client';
import { DEFAULT_HUBSPOT_UI_DOMAIN, hubspotConsentUrl } from './hubspot-oauth.service';

const INPUT = {
  testAuthorizeBaseUrl: undefined,
  clientId: 'client-id-1234',
  redirectUri: 'https://tunnel.example/oauth/hubspot/callback',
  state: 'payload.signature',
};

describe('HubSpot OAuth consent URL (ADR 0010, 0011)', () => {
  it("opens on the account's regional HubSpot host, HubSpot's generic consent path", () => {
    const eu = new URL(hubspotConsentUrl({ ...INPUT, uiDomain: 'app-eu1.hubspot.com' }));
    expect(`${eu.origin}${eu.pathname}`).toBe('https://app-eu1.hubspot.com/oauth/authorize');
    const na = new URL(hubspotConsentUrl({ ...INPUT, uiDomain: DEFAULT_HUBSPOT_UI_DOMAIN }));
    expect(`${na.origin}${na.pathname}`).toBe('https://app.hubspot.com/oauth/authorize');
  });

  it('carries exactly client_id, the exact redirect_uri, the scopes and the state', () => {
    const u = new URL(hubspotConsentUrl({ ...INPUT, uiDomain: 'app-eu1.hubspot.com' }));
    expect([...u.searchParams.keys()].sort()).toEqual([
      'client_id',
      'redirect_uri',
      'scope',
      'state',
    ]);
    expect(u.searchParams.get('client_id')).toBe(INPUT.clientId);
    expect(u.searchParams.get('redirect_uri')).toBe(INPUT.redirectUri);
    expect(u.searchParams.get('state')).toBe(INPUT.state);
    expect(u.searchParams.get('scope')!.split(' ')).toEqual([...HUBSPOT_OAUTH_SCOPES]);
  });

  it("requests HubSpot's baseline oauth scope plus CRM read scopes only (never a write scope)", () => {
    expect(HUBSPOT_OAUTH_SCOPES[0]).toBe('oauth');
    expect(HUBSPOT_OAUTH_SCOPES.filter((s) => s === 'oauth')).toHaveLength(1);
    expect(HUBSPOT_OAUTH_SCOPES).toEqual([
      'oauth',
      'crm.objects.contacts.read',
      'crm.objects.companies.read',
      'crm.objects.leads.read',
      'crm.schemas.contacts.read',
      'crm.schemas.companies.read',
    ]);
    for (const scope of HUBSPOT_OAUTH_SCOPES.filter((s) => s !== 'oauth')) {
      expect(scope).toMatch(/^crm\.(objects|schemas)\.\w+\.read$/);
    }
  });

  it('the fake override is honoured only for a loopback test server', () => {
    const u = new URL(
      hubspotConsentUrl({
        ...INPUT,
        uiDomain: 'app-eu1.hubspot.com',
        testAuthorizeBaseUrl: 'http://127.0.0.1:9/oauth',
      }),
    );
    expect(`${u.origin}${u.pathname}`).toBe('http://127.0.0.1:9/oauth/authorize');
    expect(loadHubSpotConfig({}).oauth.authorizeBaseUrl).toBeUndefined();
    for (const bad of [
      'https://app.hubspot.com/oauth',
      'https://evil.example/oauth',
      'http://evil.example/oauth',
    ]) {
      expect(() => loadHubSpotConfig({ HUBSPOT_OAUTH_AUTHORIZE_BASE_URL: bad }), bad).toThrow(
        /HUBSPOT_OAUTH_AUTHORIZE_BASE_URL/,
      );
    }
  });
});
