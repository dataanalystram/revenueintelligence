# ADR 0010: CRM connector port, HubSpot OAuth and encrypted token storage (Milestone 4)

- Status: accepted
- Date: 2026-09-27

## Context

Milestone 3 gave the platform a read-only HubSpot connector authenticated by a
static bearer token (the test account's Service Key). Two gaps remained:

1. Business code would have depended on `HubSpotReader`, a vendor class, and on
   HubSpot object names.
2. Juniper and later customers install a projects-based HubSpot app through
   OAuth. The platform must obtain, store and refresh each tenant's tokens
   itself; nobody copies tokens by hand. The existing `SecretProvider` can only
   read secrets, so a place to _write_ per-tenant tokens is needed.

The owner chose (a) an encrypted tenant-scoped PostgreSQL table and (A) the
complete OAuth architecture tested against a local fake, with the first real
install in M5 (public callback URL). The owner also required that OAuth state
is single-use across restarts, instances and concurrent callbacks, and that
only one refresh per tenant reaches HubSpot across processes.

## HubSpot OAuth facts relied on (checked 2026-09-27)

From HubSpot's developer documentation (web search; direct page fetch was
blocked by the sandbox network policy):

| Item                                                                          | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent page                                                                  | `https://app.hubspot.com/oauth/authorize`, or account-specific `https://app.hubspot.com/oauth/{accountId}/authorize`. A browser page, not an API: it is not versioned **M5 update**: the platform now uses `https://<account host>/oauth/authorize` (generic path, host per account region, tenant setting `uiDomain`), as on HubSpot's own link for the deployed app (ADR 0011).                                                                                                                   |
| Consent parameters                                                            | `client_id`, `redirect_uri`, `scope` (space-separated), `state` (HubSpot returns it unchanged); optional scopes exist but are not used                                                                                                                                                                                                                                                                                                                                                              |
| Token endpoint                                                                | `POST https://api.hubapi.com/oauth/2026-09/token` (also `2026-03`). **Date-versioned.** Form-encoded; all parameters in the body                                                                                                                                                                                                                                                                                                                                                                    |
| Code exchange                                                                 | `grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code`                                                                                                                                                                                                                                                                                                                                                                                                               |
| Refresh                                                                       | `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Token response                                                                | `token_type`, `access_token`, `refresh_token`, `expires_in` (1800 s observed in docs), `hub_id`, `scopes`                                                                                                                                                                                                                                                                                                                                                                                           |
| Other endpoints                                                               | `POST /oauth/2026-09/token/introspect` and `/token/revoke` exist; not used in M4 **M5 update**: the revoke path documented by HubSpot is `/oauth/2026-03/token/revoke`; a 2026-09 revoke path was not confirmed (ADR 0011).                                                                                                                                                                                                                                                                         |
| Legacy                                                                        | `/oauth/v1/token` is deprecated and remains until 16 February 2027. **Not used**                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Refresh rotation                                                              | The documentation reviewed does not say whether a refresh returns a new refresh token. The implementation handles both: a returned refresh token replaces the stored one, under the same lock. To confirm on the first real install (M5) **M5 update (live, test account 149338734)**: a refresh returned a refresh token that was **not rotated** (same token). Not a general guarantee: the handling of both cases stays.                                                                         |
| Scopes                                                                        | Granular CRM scopes. Requested: `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.leads.read`, `crm.schemas.contacts.read`, `crm.schemas.companies.read`. **No write scope**; a unit test fails if one is added. Whether the legacy `oauth` scope is still required for projects-based apps is to be confirmed at M5 **M5 update**: the baseline `oauth` scope is required. HubSpot added it on upload, every official template lists it, and it is now requested (ADR 0011). |
| **No legacy OAuth endpoint is needed.** The general date-version guard of the |
| CRM transport is unchanged; the OAuth client has its own exact allow-list     |
| (`POST /oauth/{YYYY-MM}/token` only).                                         |

## Decision

### 1. Vendor-neutral CRM port

- `domain/crm-reader.ts`: `CrmReader` (read-only), canonical kinds
  `person | company | lead`, `CrmAccount`, `CrmSnapshotFor`. Pure (domain rule).
- `domain/connector-error.ts`: `ConnectorError` (`kind`, `retryable`);
  `HubSpotError` extends it, so business code never needs a vendor error class.
- `modules/crm`: `CrmConnector { forTenant(ctx): Promise<CrmReader> }` and the
  DI token `CRM_CONNECTOR`. HubSpotModule provides it.
- `HubSpotCrmReader`: the only kind → HubSpot object mapping
  (person → contacts, company → companies, lead → leads).
- **Boundary rule** `business-code-uses-crm-port` (dependency-cruiser): only the
  HubSpot module, the composition roots (`app.module.ts`, `worker.module.ts`)
  and the CLI may import `modules/hubspot`.
- Discovery reads only through `CrmReader`. Its report keeps HubSpot names (it
  is a HubSpot diagnostic) and records `readThrough: { port: 'CrmReader', … }`.

### 2. Token sources

The tenant's HubSpot settings gain `auth: 'static_token' | 'oauth'` (absent means
`static_token`, so existing tenants are unchanged):

- `static_token`: the tenant credential `hubspot.access_token` from the
  SecretProvider (M3 behaviour, e.g. a Service Key).
- `oauth`: `HubSpotOAuthService.accessToken(ctx, portalId)`, called per request
  so a token that expires mid-read is refreshed transparently.

Either way the connector verifies the token's account equals the tenant's
`portalId` before returning a reader.

### 3. Encrypted grant storage (cloud-neutral)

- Interface `TenantOAuthGrantStore` (`get`, `put`, `delete`, `withLockedGrant`);
  DI token `TENANT_OAUTH_GRANT_STORE`. A Key Vault-backed store can replace
  the implementation without changing callers.
- Implementation `EncryptedDatabaseOAuthGrantStore`: table
  `tenant_oauth_tokens` (`tenant_id`, forced RLS, tenant-immutable trigger,
  primary key `(tenant_id, system)`), reached only through
  `TenantDatabase.transaction`.
- **AES-256-GCM**, random 96-bit IV, format `v1:` + base64url(iv | ciphertext |
  tag). Associated data `tenant_oauth_tokens|<tenantId>|<system>|<column>`: a
  ciphertext copied to another tenant's row, or to the other column, fails to
  decrypt.
- Key: SecretProvider key `platform.token_encryption_key`
  (env `PLATFORM_TOKEN_ENCRYPTION_KEY`, 32 bytes base64), loaded lazily so
  static-token processes need no key. HKDF-SHA256 derives separate keys for
  encryption and for state signing.
- A CHECK constraint accepts only the `v1:` format in the token columns, so a
  plaintext token cannot be stored even by mistake. Storage errors are replaced
  by a code-only message, because PostgreSQL's "Failing row contains …" would
  echo the row.

**Access tokens are stored too, encrypted, with their expiry.** The owner
required both "access tokens memory-only unless justified" and "only one
refresh call reaches HubSpot across processes". The second requires the fresh
access token to be shared: otherwise every process that needs a token must
refresh on its own. The owner chose to store it encrypted, under the same key
and rules as the refresh token (asked and answered 2026-09-27). Processes still
cache it in memory; it lives at most `expires_in` (about 30 minutes).

### 4. Single-use OAuth state

`OAuthStateService`:

- **Issue**: 32 random bytes (nonce); state =
  base64url(`{v, t: tenantId, s: system, n: nonce, e: expiry}`) + `.` +
  HMAC-SHA256. The SHA-256 of the nonce is stored in `tenant_oauth_states`
  (tenant-scoped, forced RLS) with a 10-minute expiry. The tenant's expired
  states are purged on issue.
- **Redeem**: verify the HMAC (constant time; tamper detection) → parse →
  system and expiry → tenant context from the signed tenant id → one atomic
  `DELETE … WHERE nonce_hash = … AND expires_at > now RETURNING`. PostgreSQL
  lets exactly one transaction delete the row, so the state works once across
  restarts, API instances and concurrent callbacks.
- The callback redeems the state **before** exchanging the code; a refused
  install still consumes it.

### 5. Install and callback

- `hubspot:install-url --tenant <slug>` (CLI; there is no admin UI yet) prints
  `…/oauth/{portalId}/authorize?client_id&redirect_uri&scope&state`.
- `GET /oauth/hubspot/callback` (API process, per ADR 0002): validates the
  query, redeems the state, exchanges the code, **requires `hub_id` to equal the
  tenant's configured `portalId`** (otherwise 409 and nothing is stored), then
  stores the grant. Responses never echo the code or state, and carry
  `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Request logs never contain query strings: the pino-http request serializer
  keeps only the path (it would otherwise log the one-time code).

### 6. Refresh across processes

`accessToken(ctx)`: process cache → shared encrypted token → otherwise
`withLockedGrant`, which in one tenant transaction takes
`pg_advisory_xact_lock(hashtextextended('oauth-grant:hubspot:<tenantId>', 0))`
(the same pattern as the tenant-configuration lock), **re-reads** the grant (a
previous holder's refresh is visible), refreshes only if still expired, and
saves the new tokens. The lock is transaction-scoped: released on commit,
rollback or a crashed process. A rejected refresh token maps to
`reauthorization_required` (the tenant must reinstall), never a silent failure.

- **Timing budget.** The transaction timeout runs from when the transaction
  opens, so it must cover a waiter's worst case: lock wait 20 s + the OAuth
  HTTP timeout (at most 20 s, `HUBSPOT_OAUTH_MAX_TIMEOUT_MS`) + 10 s for the
  save ≤ the locked transaction's 50 s. A unit test enforces the inequality, so
  HubSpot can never issue new tokens after the transaction has rolled back (a
  rotated refresh token would otherwise be lost).
- **In-process single flight.** Concurrent callers in one process share one
  pending refresh, so they do not each hold a pooled connection while waiting
  for the advisory lock.
- **401 recovery.** For OAuth tenants the transport calls `invalidate` when
  HubSpot rejects an access token with 401 (revoked, or replaced by a reinstall
  handled in another process), then retries the request once with a freshly
  provided token: the stored grant is read again, and refreshed if the stored
  access token is the rejected one. A second 401 is returned as `unauthorized`.
- The token is obtained once per request, outside the transport's retry loop,
  so a failed refresh is never retried by the transport.

## Consequences

- Every new tenant-owned table (two added) is covered by the schema guard.
- `PLATFORM_TOKEN_ENCRYPTION_KEY` becomes a critical secret for OAuth tenants:
  losing or changing it makes stored grants unreadable (reinstall). Key
  rotation (a key id in the format) is a follow-up before production.
- Refresh holds one database connection for the duration of one HTTP call, per
  tenant and process, about every 30 minutes. Acceptable at the expected scale.
- The API process now loads the HubSpot module (for the callback): a malformed
  `HUBSPOT_*` or `HUBSPOT_OAUTH_*` variable stops the API from starting, as it
  already did for the worker.
- The state is redeemed before the code exchange, so a HubSpot outage during
  the callback burns that install link: the admin requests a new one
  (`hubspot:install-url`).
- Tokens for a tenant installed into the wrong account are never stored; the
  unused grant is not revoked at HubSpot (revocation would add an endpoint; to
  decide in M5).
- The first real install, refresh-token rotation and the `oauth` scope question
  are confirmed at M5, together with webhooks and the public callback URL.
