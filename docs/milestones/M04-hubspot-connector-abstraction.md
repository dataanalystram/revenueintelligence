# Milestone 4: HubSpot connector abstraction and OAuth architecture

## Scope

Approved by the owner on 2026-09-27, with decisions (a) and (A):

- a vendor-neutral CRM read interface (`CrmReader`) with canonical object
  kinds, HubSpot behind it, tenant-scoped connector lookup;
- a static-token source (the Service Key, unchanged) and an OAuth token source;
- **(a)** OAuth refresh tokens encrypted (AES-256-GCM) in a tenant-scoped
  PostgreSQL table, behind a cloud-neutral store interface;
- **(A)** the complete OAuth architecture, tested against a local fake
  HubSpot OAuth server; the first real install and the public callback URL are
  M5;
- OAuth state single-use across restarts, instances and concurrent callbacks;
  one refresh per tenant across processes;
- a dependency-boundary rule so business code cannot import HubSpot;
- technical-debt items 8 and 9.

Out of scope, as instructed: HubSpot writes and write scopes, webhooks, the
public tunnel, queues/idempotency, Sugar, Gainsight, Jev, routing/SLA,
frontend/admin UI, Juniper credentials, a Key Vault dependency.

Design record: [ADR 0010](../adr/0010-crm-connector-port-and-oauth.md), which
also lists the HubSpot OAuth facts checked before any OAuth code was written.

## What was built

| Area                 | Implementation                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRM port             | `domain/crm-reader.ts` (`CrmReader`, kinds `person`/`company`/`lead`), `domain/connector-error.ts` (`ConnectorError`), `modules/crm` (`CrmConnector`, `CRM_CONNECTOR`)                                                         |
| HubSpot adapter      | `HubSpotCrmReader` (only kind → object mapping); `HubSpotConnector implements CrmConnector`, provided as `CRM_CONNECTOR`; `HubSpotError extends ConnectorError`                                                                |
| Boundary             | dependency-cruiser rule `business-code-uses-crm-port`: only the HubSpot module, `app.module.ts`, `worker.module.ts` and the CLI may import `modules/hubspot`                                                                   |
| Discovery            | Reads only through `CrmReader`; report unchanged plus `readThrough: { port: 'CrmReader', … }`                                                                                                                                  |
| Token sources        | Tenant setting `hubspot.auth: static_token \| oauth` (absent = static). Static: tenant credential via SecretProvider (M3). OAuth: `HubSpotOAuthService.accessToken`, per request                                               |
| Encrypted grants     | `TenantOAuthGrantStore` interface → `EncryptedDatabaseOAuthGrantStore`; table `tenant_oauth_tokens` (forced RLS, `v1:` CHECK); `TokenCipher` AES-256-GCM, AAD = tenant, system, column; key `PLATFORM_TOKEN_ENCRYPTION_KEY`    |
| Single-use state     | `OAuthStateService`: HMAC-signed, tenant-bound, 10 min, nonce hash in `tenant_oauth_states` (forced RLS), atomic `DELETE … RETURNING` redemption                                                                               |
| Install / callback   | `hubspot:install-url` CLI; `GET /oauth/hubspot/callback` (API): state → code exchange at `POST /oauth/2026-09/token` → `hub_id` must equal `portalId` → store. `no-store`, `no-referrer`; request logs drop query strings      |
| Refresh              | Process cache → shared encrypted access token → `pg_advisory_xact_lock` per tenant, re-read, refresh once, save. Rotated refresh tokens replace the old one. Rejected grant → `reauthorization_required`                       |
| Read-only            | CRM transport guard unchanged. The OAuth client allows exactly `POST /oauth/{YYYY-MM}/token`. Scopes: five `*.read` scopes; a unit test fails on any other                                                                     |
| CLI                  | `hubspot:configure --auth oauth`, `hubspot:install-url`                                                                                                                                                                        |
| Fake HubSpot         | Consent page (`GET /oauth/{portalId}/authorize` → redirect with code and state), token endpoint (code exchange, refresh; single-use codes; counted, delayable refreshes; optional rotation); prints paths and grant types only |
| Technical debt 8, 9  | Unknown association categories map to `other`; `test/live/hubspot-crm.live.spec.ts` runs the live account through the full tenant path and `CrmReader`                                                                         |
| Runtime verification | `scripts/verify-runtime.d/30-hubspot-oauth.sh`: 15 checks with a second API process configured for OAuth                                                                                                                       |

## Definition of Done

| Item                                                      | Status                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Vendor-neutral `CrmReader` with canonical kinds           | ✅ unit (mapping, every method), integration, **live** through `CRM_CONNECTOR`                  |
| HubSpot behind the interface; tenant-scoped lookup        | ✅ `CRM_CONNECTOR` → `HubSpotConnector.forTenant`                                               |
| Static Service Key tenant unchanged                       | ✅ M3 connector tests unchanged in behaviour; live 10/10; static tenant test in the OAuth suite |
| OAuth token source, install URL, callback, portal check   | ✅ integration (fake) + HTTP-level callback tests + runtime                                     |
| Encrypted refresh-token persistence (RLS, key via secret) | ✅ integration + unit + runtime; DB refuses plaintext                                           |
| Single-use state (restart, instances, concurrency)        | ✅ integration (12 concurrent redemptions from 2 instances; new instance after restart)         |
| Refresh once across processes                             | ✅ integration (2 instances, 10 calls → 1 refresh) + runtime (3 processes → 1 refresh)          |
| Boundary enforcement                                      | ✅ dependency-cruiser rule, mutation-tested                                                     |
| Technical debt 8 and 9                                    | ✅                                                                                              |
| Read-only                                                 | ✅ guards unchanged; OAuth allow-list exact; read-only scopes; fake request logs                |
| Critical checks proven to fail                            | ✅ 12 required mutations + 2 runtime mutations + schema guard (below)                           |
| ADR and milestone record                                  | ✅ ADR 0010, this file                                                                          |

## Evidence

See "Final evidence" at the end (fresh clone, CI).

Local gates on the working tree before commit:

```
pnpm verify
  format, lint, typecheck: clean
  depcruise: no dependency violations found (174 modules, 631 dependencies cruised)
  unit:        Test Files 28 passed (28)   Tests 363 passed (363)
  integration: Test Files 11 passed (11)   Tests 134 passed (134)
pnpm verify:runtime → Summary: 62 passed, 0 failed   (39 core + 8 HubSpot + 15 OAuth)
pnpm test:live      → Test Files 2 passed (2)   Tests 10 passed (10)
```

Runtime OAuth checks (second API process, fake HubSpot with OAuth):

```
PASS  fake HubSpot (with OAuth) started
PASS  second API process (OAuth app configured) ready
PASS  provision tenant 'rtoauth'
PASS  hubspot:configure --auth oauth: read-only, no token variable to set
PASS  hubspot:install-url: account-specific consent URL, read-only scopes, no secret
PASS  callback with a forged state → 400, before any HubSpot call
PASS  consent → callback (real HTTP): installed, no-store, no-referrer
PASS  replaying the same callback → 400 (single-use state)
PASS  grant stored encrypted (v1 ciphertext), no token in the row
PASS  app role with no tenant set sees no OAuth grants (RLS)
PASS  hubspot:discover for the OAuth tenant reads through the CrmReader port
PASS  3 concurrent processes, expired token → exactly 1 refresh call at HubSpot
PASS  no token, code or client secret in any log; callback logged without its query
PASS  only CRM reads and the date-versioned OAuth token endpoint were called
PASS  second API process and fake HubSpot stopped
```

Live discovery through the port (`hubspot:discover --tenant hstest`, production
path, account `149338734`, DEVELOPER_TEST), identical to M3 apart from the new
`readThrough` block:

```
readThrough     port CrmReader, system hubspot, contacts→person, companies→company, leads→lead
contacts        6 read, 3 pages, pagination verified; 402 properties
companies       6 read, 3 pages, pagination verified; 247 properties
leads           3 read, 2 pages, pagination verified; 132 properties
leads→contacts  3/3 (types 578, 608)     leads→companies 3/3 (580, 610)
contacts→leads  reciprocal 3/3 (579, 609) companies→leads reciprocal 3/3 (581, 611)
missing scopes  none;  methods GET, POST (batch read only);  non-date-versioned paths: 0
report: no Service Key, no Lead names, no email values
```

## Mutation evidence

Each mechanism was broken in the source, the named tests run, and the file
restored byte-for-byte (`scratchpad/mutate.py`; every restore verified
identical, 0 markers left). Every mutation failed for the intended reason:

| #   | Mechanism broken                                  | Failed test(s) and reason                                                                                                                   |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | State signature validation skipped                | "a tampered state is rejected…": expected `bad_signature`, received `unknown_or_used` (the forged state got past the signature)             |
| M2  | State reuse protection removed (row not consumed) | OAuth replay test, and the HTTP replay test: expected `invalid_state`, received `code_rejected` (the replayed state was accepted)           |
| M3  | Concurrent redemption allowed (check-then-act)    | "concurrent redemptions from two independent instances": expected 1 winner, got **12**                                                      |
| M4  | Portal/account validation removed                 | Wrong-account install tests (service and HTTP 409): the grant was stored                                                                    |
| M5  | Refresh-token encryption removed (encoding only)  | Stored-grant test (decoded payload contains the token), wrong-key, tampering, cross-tenant copy                                             |
| M6  | Wrong encryption key accepted (key ignored)       | "only the platform key decrypts": the wrong key decrypted                                                                                   |
| M7  | Ciphertext tampering not detected (tag unchecked) | "tampered ciphertext is detected…": the tampered grant was returned                                                                         |
| M8  | RLS removed from `tenant_oauth_tokens`            | "RLS: a tenant transaction sees only its own grant": another tenant's row was visible. M8b: schema guard also fails (`tenant_oauth_tokens`) |
| M9  | Tenant not bound in the ciphertext (AAD)          | "tenant A cannot use tenant B's token…": B's copied ciphertext decrypted for A                                                              |
| M10 | Cross-process refresh lock removed                | "…two independent instances cause exactly one refresh": expected 1, got **10**                                                              |
| M11 | Business code imports the HubSpot module          | dependency-cruiser: `error business-code-uses-crm-port: src/modules/identity/index.ts → src/modules/hubspot/index.ts`                       |
| M12 | Read-only HTTP guard weakened (any POST)          | Read-only guard tests (POST to objects, write-like batch paths, 2026-09 writes) and "CRM transport still refuses the OAuth endpoint"        |

Mutations added for the independent-review fixes (same procedure):

| #   | Mechanism broken                                          | Failed test(s) and reason                                                                                          |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| M13 | In-process single-flight refresh removed                  | "20 concurrent callers in one process share one locked refresh": `withLockedGrant` called **20** times, expected 1 |
| M14 | 401 re-authentication hook removed                        | Reinstall-in-another-process, revoked-access-token and both-revoked tests: stale token → `unauthorized`            |
| M15 | Signature compared as decoded bytes                       | A non-canonical spelling of the signature (same bytes) verified                                                    |
| M16 | Refresh transaction timeout below lock wait + HTTP + save | Timing-budget test: `expected 50000 to be less than or equal to 30000`                                             |
| M10 | (re-run after single-flight) lock removed                 | Still caught: two instances → **2** refreshes, expected 1                                                          |

Runtime mutations (one `pnpm verify:runtime`, both restored and rebuilt after):

| Broken                                 | Runtime check that failed                                                       | Evidence                                              |
| -------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| R1: refresh lock removed               | "3 concurrent processes, expired token → exactly 1 refresh call at HubSpot"     | `refresh calls at HubSpot: before=0 after=3`          |
| R2: query-string log scrubbing removed | "no token, code or client secret in any log; callback logged without its query" | the API log contained `/oauth/hubspot/callback?code=` |

Result: `Summary: 60 passed, 2 failed`, exactly these two. The work directory
of that run (it held fake codes) was deleted.

## Independent review

A fresh-context review of `b87bf6e..4f7a913` returned **PASS WITH NITS**. It
confirmed all eight owner requirements in code (no plaintext tokens, RLS,
single-use state, one refresh across processes, read-only, static tenants
unchanged, boundary, scope) and found three should-fix items, all fixed:

1. **Refresh transaction could time out after HubSpot issued new tokens**
   (lock wait 25 s + HTTP 20 s > transaction 30 s; a rotated refresh token
   could be lost). Fixed: 20 s + 20 s + 10 s ≤ 50 s, enforced by a unit test
   (M16).
2. **Concurrent refreshes in one process could exhaust the connection pool.**
   Fixed: one pending refresh per tenant per process (M13).
3. **Stale in-process token after a reinstall or revocation**, never evicted on 401. Fixed: a 401 invalidates the cached token and retries once with the
   stored or refreshed one (M14).

Nits, all fixed: the transport no longer retries a failing token provider;
a malformed HubSpot token response is 502 (not 400); lock timeouts (503) and
inactive tenants (409) no longer surface as 500 in the callback; only the
canonical signature spelling verifies (M15); ADR and runbook note that the API
now loads the HubSpot module and that a failed callback burns the install link.

A second fresh-context review of the fix commit (`4f7a913..7decfb8`) returned
**PASS WITH NITS**. It confirmed the four fixes and asked for one test, which
exposed a real bug:

- **Suspended tenant at the callback** returned `400 invalid_state`, because
  state redemption turned every tenant-context error into "unknown or used".
  Now only a missing tenant or malformed id does; a suspended tenant gets
  `409 tenant_not_ready`. The new test failed before the fix (400) and passes
  after.
- Nits fixed: the rejected-token mark is a SHA-256 digest, never the token; it
  is cleared only when a refresh produced a different token, and a rejected
  token is never cached (closes a narrow race where a pending refresh could
  re-cache a just-rejected token); a test proves a caller succeeds after a
  failed shared refresh.
- Mutations M1, M2, M3 and M14 re-run after these changes: still caught.

## Open questions (for M5)

1. Does HubSpot rotate refresh tokens on refresh? Both cases are handled and
   tested; confirm on the first real install.
2. Does a projects-based app still need the legacy `oauth` scope? Not requested
   now (read-only CRM scopes only).
3. Revoke a grant installed into the wrong account (`/oauth/2026-09/token/revoke`)?
   Technical-debt item 12.
4. Key rotation for `PLATFORM_TOKEN_ENCRYPTION_KEY` (technical-debt item 11)
   before production.
