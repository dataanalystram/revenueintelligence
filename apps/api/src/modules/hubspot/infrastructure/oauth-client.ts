import { z } from 'zod';
import { Secret } from '../../../platform/secrets';
import { HubSpotError } from '../errors';
import type { HubSpotConfig } from '../hubspot.config';

/**
 * Read-only CRM scopes requested on install (ADR 0010). No write scope is ever
 * requested; a unit test fails if one is added.
 */
export const HUBSPOT_OAUTH_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
  'crm.objects.leads.read',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
] as const;

/**
 * The only OAuth request the platform makes: POST to the date-versioned token
 * endpoint (authorization-code exchange and refresh). Separate from the CRM
 * transport, whose read-only guard is unchanged. Anything else is refused.
 */
const TOKEN_PATH = /^\/oauth\/\d{4}-(0[1-9]|1[0-2])\/token$/;

export function assertOAuthTokenRequest(method: string, path: string): void {
  if (method === 'POST' && TOKEN_PATH.test(path)) return;
  throw new HubSpotError(
    'unsupported_endpoint',
    `Refusing ${method} ${path}: not the OAuth token endpoint`,
    {
      path,
    },
  );
}

const HsTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
  hub_id: z
    .union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)])
    .transform(String)
    .optional(),
  scopes: z.array(z.string()).optional(),
});

const HsOAuthErrorSchema = z
  .object({
    error: z.string().optional(),
    category: z.string().optional(),
    subCategory: z.string().optional(),
    correlationId: z.string().optional(),
  })
  .loose();

export interface OAuthTokens {
  readonly accessToken: Secret;
  /** HubSpot may or may not return a new refresh token on refresh. */
  readonly refreshToken: Secret | undefined;
  readonly expiresInSeconds: number;
  /** The account the grant belongs to (HubSpot `hub_id`). */
  readonly accountId: string | undefined;
  readonly scopes: readonly string[];
}

export interface OAuthClientDeps {
  readonly fetch?: typeof fetch;
}

/**
 * Client for HubSpot's date-versioned OAuth token endpoint
 * (`POST /oauth/{HUBSPOT_OAUTH_API_VERSION}/token`, form-encoded, all
 * parameters in the body). Tokens and the client secret are only ever held in
 * Secret; errors carry HubSpot's error codes, never response bodies or tokens.
 * No automatic retries: an authorization code is single-use, and a failed
 * refresh is retried by the next caller.
 */
export class HubSpotOAuthClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly config: HubSpotConfig,
    deps: OAuthClientDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? globalThis.fetch;
  }

  exchangeCode(input: {
    code: Secret;
    clientId: string;
    clientSecret: Secret;
    redirectUri: string;
  }): Promise<OAuthTokens> {
    return this.token(
      {
        grant_type: 'authorization_code',
        client_id: input.clientId,
        client_secret: input.clientSecret.reveal(),
        redirect_uri: input.redirectUri,
        code: input.code.reveal(),
      },
      'bad_request',
    );
  }

  refresh(input: {
    refreshToken: Secret;
    clientId: string;
    clientSecret: Secret;
  }): Promise<OAuthTokens> {
    return this.token(
      {
        grant_type: 'refresh_token',
        client_id: input.clientId,
        client_secret: input.clientSecret.reveal(),
        refresh_token: input.refreshToken.reveal(),
      },
      // A rejected refresh token means the grant is gone: the tenant must reinstall.
      'reauthorization_required',
    );
  }

  private async token(
    form: Record<string, string>,
    rejectedKind: 'bad_request' | 'reauthorization_required',
  ): Promise<OAuthTokens> {
    const path = `/oauth/${this.config.oauth.apiVersion}/token`;
    assertOAuthTokenRequest('POST', path);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(this.config.oauth.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new HubSpotError(
        timedOut ? 'timeout' : 'network',
        timedOut
          ? 'HubSpot OAuth request timed out'
          : 'HubSpot OAuth request failed before a response',
        { path },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(await response.text());
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const body = HsOAuthErrorSchema.safeParse(json);
      const code = body.success
        ? (body.data.error ?? body.data.subCategory ?? body.data.category)
        : undefined;
      const kind =
        response.status >= 500
          ? 'server_error'
          : response.status === 429
            ? 'rate_limited'
            : response.status === 400 || response.status === 401
              ? rejectedKind
              : 'bad_request';
      throw new HubSpotError(
        kind,
        `HubSpot OAuth returned ${response.status}${code ? ` (${code})` : ''}`,
        {
          status: response.status,
          path,
          ...(code ? { category: code } : {}),
          ...(body.success && body.data.correlationId
            ? { correlationId: body.data.correlationId }
            : {}),
        },
      );
    }
    const parsed = HsTokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
      throw new HubSpotError(
        'invalid_payload',
        `Unexpected HubSpot OAuth response shape (${issues})`,
        {
          status: response.status,
          path,
        },
      );
    }
    const t = parsed.data;
    return {
      accessToken: new Secret(t.access_token),
      refreshToken: t.refresh_token ? new Secret(t.refresh_token) : undefined,
      expiresInSeconds: t.expires_in,
      accountId: t.hub_id,
      scopes: t.scopes ?? [],
    };
  }
}
