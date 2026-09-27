import { describe, expect, it } from 'vitest';
import {
  OAUTH_GRANT_LOCKED_TRANSACTION_MS,
  OAUTH_GRANT_LOCK_WAIT_MS,
  OAUTH_GRANT_SAVE_MARGIN_MS,
} from '../../tenancy';
import { HUBSPOT_OAUTH_MAX_TIMEOUT_MS, loadHubSpotConfig } from '../hubspot.config';

describe('refresh lock timing budget (ADR 0010)', () => {
  it('a waiter can wait for the lock, refresh and save before its transaction times out', () => {
    // The transaction timeout runs from when the transaction opens.
    expect(
      OAUTH_GRANT_LOCK_WAIT_MS + HUBSPOT_OAUTH_MAX_TIMEOUT_MS + OAUTH_GRANT_SAVE_MARGIN_MS,
    ).toBeLessThanOrEqual(OAUTH_GRANT_LOCKED_TRANSACTION_MS);
  });

  it('the OAuth HTTP timeout cannot be configured above the budgeted maximum', () => {
    expect(() =>
      loadHubSpotConfig({ HUBSPOT_OAUTH_TIMEOUT_MS: String(HUBSPOT_OAUTH_MAX_TIMEOUT_MS + 1) }),
    ).toThrow(/HUBSPOT_OAUTH_TIMEOUT_MS/);
    expect(loadHubSpotConfig({}).oauth.timeoutMs).toBeLessThanOrEqual(HUBSPOT_OAUTH_MAX_TIMEOUT_MS);
  });
});
