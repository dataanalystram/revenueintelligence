import { createHmac, timingSafeEqual } from 'node:crypto';

/** HubSpot: reject a request whose timestamp is older than 5 minutes. */
export const WEBHOOK_MAX_AGE_MS = 5 * 60_000;
/** Tolerated clock difference for timestamps in the future; anything later is refused. */
export const WEBHOOK_MAX_FUTURE_SKEW_MS = 60_000;

export const SIGNATURE_V3_HEADER = 'x-hubspot-signature-v3';
export const TIMESTAMP_HEADER = 'x-hubspot-request-timestamp';

export type SignatureFailure =
  /** No v3 signature (v1/v2 signatures are never accepted). */
  | 'missing_signature'
  | 'malformed_signature'
  | 'missing_timestamp'
  | 'malformed_timestamp'
  | 'stale_timestamp'
  | 'future_timestamp'
  | 'signature_mismatch';

export type SignatureCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: SignatureFailure };

/** HubSpot decodes these percent-encoded characters before signing the URI. */
const DECODED: Record<string, string> = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
};

/**
 * The URI as HubSpot signs it: URL-encoded `: / ? @ ! $ ' ( ) * , ;` are
 * decoded. The `?` that starts the query string is already literal, so only
 * encoded characters inside path and query change.
 */
export function signedUri(uri: string): string {
  return uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => DECODED[m.toUpperCase()]!);
}

/**
 * The external URI HubSpot called: the configured target URL (scheme, host,
 * path) plus the query string of the request as received. The Host header is
 * never used: a client controls it, and behind a tunnel or proxy it is not
 * the public host anyway.
 */
export function externalRequestUri(targetUrl: string, originalUrl: string): string {
  const target = new URL(targetUrl);
  const q = originalUrl.indexOf('?');
  return `${target.origin}${target.pathname}${q >= 0 ? originalUrl.slice(q) : ''}`;
}

/**
 * Signature v3: base64 HMAC-SHA256, keyed with the app's client secret, of
 * method + URI + raw request body + timestamp. The body is the exact bytes
 * received, never a re-serialised JSON value.
 */
export function signatureV3(input: {
  clientSecret: string;
  method: string;
  uri: string;
  rawBody: Buffer;
  timestamp: string;
}): string {
  return createHmac('sha256', input.clientSecret)
    .update(`${input.method}${signedUri(input.uri)}`, 'utf8')
    .update(input.rawBody)
    .update(input.timestamp, 'utf8')
    .digest('base64');
}

const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;
const TIMESTAMP = /^[0-9]{1,16}$/;

/** Verifies a HubSpot v3 signature and its timestamp freshness (constant-time compare). */
export function verifySignatureV3(input: {
  clientSecret: string;
  method: string;
  uri: string;
  rawBody: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  now: number;
}): SignatureCheck {
  if (input.signature === undefined) return { ok: false, reason: 'missing_signature' };
  if (!BASE64_SHA256.test(input.signature)) return { ok: false, reason: 'malformed_signature' };
  if (input.timestamp === undefined) return { ok: false, reason: 'missing_timestamp' };
  if (!TIMESTAMP.test(input.timestamp)) return { ok: false, reason: 'malformed_timestamp' };
  const sentAt = Number(input.timestamp);
  if (input.now - sentAt > WEBHOOK_MAX_AGE_MS) return { ok: false, reason: 'stale_timestamp' };
  if (sentAt - input.now > WEBHOOK_MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'future_timestamp' };
  }
  const expected = Buffer.from(signatureV3({ ...input, timestamp: input.timestamp }), 'base64');
  const given = Buffer.from(input.signature, 'base64');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}
