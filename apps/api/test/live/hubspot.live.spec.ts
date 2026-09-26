import { describe, expect, it } from 'vitest';
import {
  HubSpotError,
  HubSpotReader,
  TEST_ACCOUNT_TYPES,
  loadHubSpotConfig,
} from '../../src/modules/hubspot';
import { HubSpotHttpClient } from '../../src/modules/hubspot/infrastructure/http-client';
import { SlidingWindowRateLimiter } from '../../src/modules/hubspot/infrastructure/rate-limiter';
import { EnvSecretProvider, Secret } from '../../src/platform/secrets';

/**
 * Read-only checks against a real HubSpot DEVELOPER TEST (or sandbox) account.
 * Never point these at a customer's production account.
 *
 * Required environment (see docs/integrations/hubspot/setup.md):
 *   TENANT_HSTEST_HUBSPOT_ACCESS_TOKEN  static access token of the test app
 *   HUBSPOT_TEST_PORTAL_ID              the test account's id (guards against a wrong token)
 */
const TOKEN_VAR = EnvSecretProvider.toEnvName('tenant.hstest.hubspot.access_token');
const PORTAL_VAR = 'HUBSPOT_TEST_PORTAL_ID';
const missing = [TOKEN_VAR, PORTAL_VAR].filter((name) => !process.env[name]);

if (missing.length > 0) {
  describe(`HubSpot live tests: SKIPPED, missing ${missing.join(' and ')}`, () => {
    it.skip('requires a HubSpot developer test account token (docs/integrations/hubspot/setup.md)', () => {});
  });
} else {
  describe('HubSpot live (read-only, developer test account)', () => {
    const config = loadHubSpotConfig();
    const http = new HubSpotHttpClient(config, new SlidingWindowRateLimiter(config.requestsPer10s));
    const reader = new HubSpotReader(http, config, {
      tenantKey: 'live',
      token: new Secret(process.env[TOKEN_VAR]!),
    });

    it('authenticates against the expected test account', async () => {
      const account = await reader.getAccount();
      expect(account.portalId).toBe(process.env[PORTAL_VAR]);
      expect(TEST_ACCOUNT_TYPES).toContain(account.accountType);
    });

    it('reads contacts and companies with pagination', async () => {
      for (const type of ['contacts', 'companies'] as const) {
        const first = await reader.listRecords(type, { limit: 1 });
        if (first.nextCursor) {
          const second = await reader.listRecords(type, { limit: 1, after: first.nextCursor });
          expect(second.items[0]?.ref.id).not.toBe(first.items[0]?.ref.id);
        }
        const props = await reader.listProperties(type);
        expect(props.length).toBeGreaterThan(0);
      }
    });

    it('reads the Leads object, or reports exactly why not', async () => {
      try {
        await reader.listRecords('leads', { limit: 1 });
        await reader.listProperties('leads');
      } catch (err) {
        expect(err).toBeInstanceOf(HubSpotError);
        expect(['forbidden', 'not_found', 'bad_request']).toContain((err as HubSpotError).kind);
      }
    });

    it('404 for a record that does not exist', async () => {
      await expect(reader.getRecord('contacts', '1')).resolves.toBeUndefined();
    });

    it('401 for an invalid token', async () => {
      const bad = new HubSpotReader(http, config, {
        tenantKey: 'live-bad',
        token: new Secret('invalid-token'),
      });
      await expect(bad.getAccount()).rejects.toMatchObject({ kind: 'unauthorized' });
    });
  });
}
