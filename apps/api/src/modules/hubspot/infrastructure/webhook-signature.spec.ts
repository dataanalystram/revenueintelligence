import { describe, expect, it } from 'vitest';
import { hubspotV3Signature, legacyHeaders } from '../../../../test/support/hubspot-webhooks';
import {
  WEBHOOK_MAX_AGE_MS,
  WEBHOOK_MAX_FUTURE_SKEW_MS,
  externalRequestUri,
  signatureV3,
  signedUri,
  verifySignatureV3,
} from './webhook-signature';

const SECRET = 'app-client-secret-for-tests';
const TARGET = 'https://public.example.test/webhooks/hubspot';
const NOW = 1_790_000_000_000;
const BODY = Buffer.from('[{"eventId":1,"portalId":5005,"propertyValue":"x"}]');

function check(over: Partial<Parameters<typeof verifySignatureV3>[0]> = {}) {
  const timestamp = String(NOW);
  return verifySignatureV3({
    clientSecret: SECRET,
    method: 'POST',
    uri: TARGET,
    rawBody: BODY,
    signature: hubspotV3Signature({ secret: SECRET, uri: TARGET, body: BODY, timestamp }),
    timestamp,
    now: NOW,
    ...over,
  });
}

describe('HubSpot webhook signature v3 (ADR 0011)', () => {
  it('matches an independent implementation of the documented algorithm', () => {
    const uri = `${TARGET}?a=%3A%2F%3F%40%21%24%27%28%29%2A%2C%3B&b=%20`;
    expect(
      signatureV3({ clientSecret: SECRET, method: 'POST', uri, rawBody: BODY, timestamp: '17' }),
    ).toBe(hubspotV3Signature({ secret: SECRET, uri, body: BODY, timestamp: '17' }));
  });

  it('accepts a valid signature', () => {
    expect(check()).toEqual({ ok: true });
  });

  it('is computed over the exact raw bytes: a re-serialised body does not verify', () => {
    const raw = Buffer.from('[ {"eventId": 1,\n "portalId":5005, "name":"caf\\u00e9"} ]');
    const timestamp = String(NOW);
    const signature = hubspotV3Signature({ secret: SECRET, uri: TARGET, body: raw, timestamp });
    expect(check({ rawBody: raw, signature, timestamp })).toEqual({ ok: true });
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))));
    expect(check({ rawBody: reserialised, signature, timestamp })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a changed body, method, URI, timestamp or secret', () => {
    const bad = { ok: false, reason: 'signature_mismatch' };
    expect(check({ rawBody: Buffer.from('[]') })).toEqual(bad);
    expect(check({ method: 'PUT' })).toEqual(bad);
    expect(check({ uri: 'https://attacker.example/webhooks/hubspot' })).toEqual(bad);
    expect(check({ uri: `${TARGET}?x=1` })).toEqual(bad);
    expect(check({ clientSecret: 'another-secret' })).toEqual(bad);
    const timestamp = String(NOW - 1);
    expect(
      check({
        timestamp,
        signature: hubspotV3Signature({
          secret: SECRET,
          uri: TARGET,
          body: BODY,
          timestamp: String(NOW),
        }),
      }),
    ).toEqual(bad);
  });

  it('rejects stale timestamps (older than 5 minutes), accepts the boundary', () => {
    const at = (t: number) => {
      const timestamp = String(t);
      return check({
        timestamp,
        signature: hubspotV3Signature({ secret: SECRET, uri: TARGET, body: BODY, timestamp }),
      });
    };
    expect(at(NOW - WEBHOOK_MAX_AGE_MS)).toEqual({ ok: true });
    expect(at(NOW - WEBHOOK_MAX_AGE_MS - 1)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(at(NOW - 24 * 3_600_000)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(at(NOW + WEBHOOK_MAX_FUTURE_SKEW_MS)).toEqual({ ok: true });
    expect(at(NOW + WEBHOOK_MAX_FUTURE_SKEW_MS + 1)).toEqual({
      ok: false,
      reason: 'future_timestamp',
    });
    expect(at(NOW + 3_600_000)).toEqual({ ok: false, reason: 'future_timestamp' });
  });

  it('refuses missing or malformed signatures and timestamps', () => {
    expect(check({ signature: undefined })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(check({ timestamp: undefined })).toEqual({ ok: false, reason: 'missing_timestamp' });
    expect(check({ timestamp: '17e11' })).toEqual({ ok: false, reason: 'malformed_timestamp' });
    expect(check({ timestamp: '-1' })).toEqual({ ok: false, reason: 'malformed_timestamp' });
    for (const signature of [
      '',
      'abc',
      `${'A'.repeat(43)}`,
      `${'A'.repeat(42)}==`,
      `${'A'.repeat(43)}=\n`,
    ]) {
      expect(check({ signature }), JSON.stringify(signature)).toEqual({
        ok: false,
        reason: 'malformed_signature',
      });
    }
  });

  it('never accepts v1 or v2 signatures, even correct ones', () => {
    for (const version of ['v1', 'v2'] as const) {
      const legacy = legacyHeaders(version, { secret: SECRET, uri: TARGET, body: BODY.toString() });
      expect(check({ signature: legacy['x-hubspot-signature'] }).ok).toBe(false);
    }
  });

  it('decodes exactly the characters HubSpot lists, in path and query', () => {
    expect(signedUri('https://h/p%3Aa?x=%2F%3F%40%21%24%27%28%29%2A%2C%3B&y=%20%26')).toBe(
      "https://h/p:a?x=/?@!$'()*,;&y=%20%26",
    );
    expect(signedUri('https://h/p?x=%2f%3a')).toBe('https://h/p?x=/:');
  });

  it('reconstructs the external URI from the configured target, never from the request host', () => {
    expect(externalRequestUri(TARGET, '/webhooks/hubspot')).toBe(TARGET);
    expect(externalRequestUri(TARGET, '/webhooks/hubspot?a=1&b=%3A')).toBe(`${TARGET}?a=1&b=%3A`);
    // A tunnel or proxy that rewrites the local path does not change the signed URI.
    expect(externalRequestUri('https://x.example/hooks/in', '/webhooks/hubspot')).toBe(
      'https://x.example/hooks/in',
    );
  });
});
