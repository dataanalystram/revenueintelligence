import { z } from 'zod';
import { Secret } from '../../../platform/secrets';
import { HubSpotError } from '../errors';
import type { HubSpotConfig } from '../hubspot.config';

/**
 * Scopes requested on install (ADR 0010, 0011): HubSpot's baseline `oauth`
 * scope plus read-only CRM scopes. `oauth` is part of every HubSpot app's
 * required scopes (HubSpot added it to this app on upload, and every official
 * 2026.03 app template lists it); the consent URL must request all of the
 * app's required scopes. No write scope is ever requested; unit tests fail if
 * one is added or if this list drifts from hubspot-app/.
 */
export const HUBSPOT_OAUTH_BASELINE_SCOPE = 'oauth';
export const HUBSPOT_OAUTH_SCOPES = [
  HUBSPOT_OAUTH_BASELINE_SCOPE,
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
  'crm.objects.leads.read',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
] as const;

/**
 * The only OAuth requests the platform makes (separate from the CRM transport,
 * whose read-only guard is unchanged); anything else is refused:
 *
 * - POST to the date-versioned token endpoint (authorization-code exchange and
 *   refresh);
 * - POST to exactly HubSpot's current refresh-token revoke endpoint, used only
 *   to give back a grant the platform refused because it was issued for the
 *   wrong HubSpot account (ADR 0011). `2026-03` is the current documented
 *   version (verified 2026-09-27; no 2026-09 revoke endpoint is documented).
 */
const TOKEN_PATH = /^\/oauth\/\d{4}-(0[1-9]|1[0-2])\/token$/;
export const HUBSPOT_OAUTH_REVOKE_PATH = '/oauth/2026-03/token/revoke';

export function assertOAuthRequest(method: string, path: string): void {
  if (method === 'POST' && (TOKEN_PATH.test(path) || path === HUBSPOT_OAUTH_REVOKE_PATH)) return;
  throw new HubSpotError(
    'unsupported_endpoint',
    `Refusing ${method} ${path}: not an allowed OAuth endpoint`,
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

  /**
   * Revokes a refresh token HubSpot has just issued. Called from exactly one
   * place: the install callback, when the grant belongs to a different HubSpot
   * account than the tenant's, so the refused grant does not stay valid at
   * HubSpot (ADR 0011). Not a general revocation feature.
   */
  async revokeRefreshToken(input: {
    refreshToken: Secret;
    clientId: string;
    clientSecret: Secret;
  }): Promise<void> {
    const response = await this.post(HUBSPOT_OAUTH_REVOKE_PATH, {
      token: input.refreshToken.reveal(),
      client_id: input.clientId,
      client_secret: input.clientSecret.reveal(),
    });
    const json = await readJson(response); // also releases the connection
    if (!response.ok) {
      const { code, correlationId } = errorCode(json);
      throw new HubSpotError(
        response.status >= 500
          ? 'server_error'
          : response.status === 429
            ? 'rate_limited'
            : 'bad_request',
        `HubSpot OAuth revoke returned ${response.status}${code ? ` (${code})` : ''}`,
        {
          status: response.status,
          path: HUBSPOT_OAUTH_REVOKE_PATH,
          ...(code ? { category: code } : {}),
          ...(correlationId ? { correlationId } : {}),
        },
      );
    }
  }

  private async post(path: string, form: Record<string, string>): Promise<Response> {
    assertOAuthRequest('POST', path);
    try {
      return await this.fetchFn(`${this.config.baseUrl}${path}`, {
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
  }

  private async token(
    form: Record<string, string>,
    rejectedKind: 'bad_request' | 'reauthorization_required',
  ): Promise<OAuthTokens> {
    const path = `/oauth/${this.config.oauth.apiVersion}/token`;
    const response = await this.post(path, form);
    const json = await readJson(response);
    if (!response.ok) {
      const { code, correlationId } = errorCode(json);
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
          ...(correlationId ? { correlationId } : {}),
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

/** HubSpot's error code and correlation id from an OAuth error body (never the body itself). */
function errorCode(json: unknown): { code?: string; correlationId?: string } {
  const body = HsOAuthErrorSchema.safeParse(json);
  if (!body.success) return {};
  const code = body.data.error ?? body.data.subCategory ?? body.data.category;
  return {
    ...(code ? { code } : {}),
    ...(body.data.correlationId ? { correlationId: body.data.correlationId } : {}),
  };
}
