import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

/**
 * Test-side HubSpot webhook sender. The signature is computed here
 * independently of the production verifier, straight from HubSpot's
 * description: base64(HMAC-SHA256(clientSecret, method + uri + body + timestamp)),
 * with URL-encoded `: / ? @ ! $ ' ( ) * , ;` in the URI decoded first.
 */
export function hubspotV3Signature(input: {
  secret: string;
  method?: string;
  uri: string;
  body: string | Buffer;
  timestamp: string;
}): string {
  const decoded = input.uri.replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (m) =>
    decodeURIComponent(m),
  );
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, 'utf8');
  const source = Buffer.concat([
    Buffer.from(`${input.method ?? 'POST'}${decoded}`, 'utf8'),
    body,
    Buffer.from(input.timestamp, 'utf8'),
  ]);
  return createHmac('sha256', input.secret).update(source).digest('base64');
}

/** Headers HubSpot sends with a v3-signed delivery. */
export function signedHeaders(input: {
  secret: string;
  uri: string;
  body: string | Buffer;
  timestamp?: number;
  method?: string;
}): Record<string, string> {
  const timestamp = String(input.timestamp ?? Date.now());
  return {
    'content-type': 'application/json',
    'x-hubspot-request-timestamp': timestamp,
    'x-hubspot-signature-v3': hubspotV3Signature({ ...input, timestamp }),
  };
}

/** Legacy v1 (sha256 hex of secret + body) and v2 (secret + method + uri + body) headers. */
export function legacyHeaders(
  version: 'v1' | 'v2',
  input: { secret: string; uri: string; body: string; method?: string },
): Record<string, string> {
  const source =
    version === 'v1'
      ? `${input.secret}${input.body}`
      : `${input.secret}${input.method ?? 'POST'}${input.uri}${input.body}`;
  return {
    'content-type': 'application/json',
    'x-hubspot-signature': createHash('sha256').update(source).digest('hex'),
    'x-hubspot-signature-version': version,
  };
}

let nextEventId = 1_000_000;

/** One webhook event in HubSpot's documented shape (generic object subscriptions). */
export function webhookEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  nextEventId += 1;
  return {
    eventId: nextEventId,
    subscriptionId: 4_100_001,
    portalId: 5005,
    appId: 22_222,
    occurredAt: Date.now() - 1_000,
    subscriptionType: 'object.creation',
    attemptNumber: 0,
    objectId: 90_000 + nextEventId,
    objectTypeId: '0-1',
    changeFlag: 'CREATED',
    changeSource: 'CRM_UI',
    sourceId: 'userId:1',
    ...over,
  };
}

// Standalone sender, for runtime verification. The client secret comes from
// the WEBHOOK_CLIENT_SECRET environment variable (never an argument).
//   node test/support/hubspot-webhooks.ts --url <local endpoint> --target <configured public URL>
//        --body-file <json> [--timestamp-offset-ms N] [--sign-uri <uri>] [--host <Host header>]
if (process.argv[1]?.endsWith('hubspot-webhooks.ts')) {
  const args = process.argv.slice(2);
  const arg = (name: string, fallback?: string): string => {
    const i = args.indexOf(`--${name}`);
    const value = i >= 0 ? args[i + 1] : fallback;
    if (value === undefined) throw new Error(`--${name} is required`);
    return value;
  };
  const secret = process.env.WEBHOOK_CLIENT_SECRET;
  if (!secret) throw new Error('WEBHOOK_CLIENT_SECRET is not set');
  const body = readFileSync(arg('body-file'));
  const target = arg('target');
  const local = new URL(arg('url'));
  const signUri = arg('sign-uri', `${target}${local.search}`);
  const headers: Record<string, string> = signedHeaders({
    secret,
    uri: signUri,
    body,
    timestamp: Date.now() + Number(arg('timestamp-offset-ms', '0')),
  });
  if (args.includes('--host')) headers.host = arg('host');
  // node:http rather than fetch, so the Host header can be set to anything.
  const req = request(local, { method: 'POST', headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      process.stdout.write(`${res.statusCode} ${Buffer.concat(chunks).toString('utf8')}\n`);
    });
  });
  req.end(body);
}
