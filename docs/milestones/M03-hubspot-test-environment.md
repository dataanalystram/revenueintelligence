# Milestone 3: HubSpot developer/test environment and read-only discovery

## Scope

Prove the platform can authenticate to a HubSpot developer test account and
perform read-only discovery of the objects and metadata the Juniper
integration will need, tenant-scoped and without writing to any HubSpot
account.

Out of scope, as instructed:

- writes to Juniper or any HubSpot account
- creating Leads
- webhooks (M5)
- OAuth install (M4/M16)
- Sugar, Gainsight, Jev, SLA/routing
- frontend

## What was built

| Area                 | Implementation                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector module     | `src/modules/hubspot` (public API in `index.ts`), registered in the worker; ADR 0009                                                                                                                                                                                                      |
| API version          | `2026-09` for CRM objects, properties and associations; `2026-03` for the Account Information API (latest documented). The transport refuses any non-date-versioned (v1–v4) path                                                                                                          |
| Authentication       | Generic bearer credential: tenant credential `hubspot.access_token` → `TENANT_<SLUG>_HUBSPOT_ACCESS_TOKEN` via the SecretProvider. For the developer test account it holds a read-only **Service Key** (no legacy private app); Juniper will use a projects-based app with OAuth (M4/M16) |
| Tenant-scoped config | `HubSpotConnector.forTenant(ctx)`: integration must be enabled; only the tenant's own token; per-tenant rate budget. `connect(ctx)` also verifies the token's account equals the tenant's `portalId`                                                                                      |
| Reads                | Contacts, Companies, Leads (list with cursor paging, get by id); CRM properties; association labels; record associations (batch read with per-record paging); account details                                                                                                             |
| Read-only guarantee  | Transport refuses everything except GET and POST to the association batch-read path, before sending                                                                                                                                                                                       |
| Error handling       | 401, 403 (+ `requiredGranularScopes`), 404, 400, 429 (`DAILY` not retried; burst honours `Retry-After`), 5xx, timeout, network, invalid payload; bounded jittered retries of transient failures only                                                                                      |
| Validation           | Zod schemas for every HubSpot response; issue paths only in errors (no values)                                                                                                                                                                                                            |
| Read models          | `ExternalPersonSnapshot`, `ExternalCompanySnapshot`, `ExternalLeadSnapshot`, `ExternalFieldDefinition`, `ExternalAssociation[Type]` in `domain` (vendor-neutral; customer fields stay in `attributes`)                                                                                    |
| Discovery            | `HubSpotDiscoveryService` + `hubspot:discover` CLI: account, per-object records (pagination proof) and properties, association labels (6 directions), association samples, Lead availability, missing scopes. Refuses non-test accounts                                                   |
| Setup                | `hubspot:configure` CLI: read-only access + credential reference; prints the variable name, never the token. Read-write is not offered                                                                                                                                                    |
| Live suite           | `pnpm test:live` (`test/live/hubspot.live.spec.ts`): fails with zero test files; skips with the missing variable names                                                                                                                                                                    |
| Runtime verification | `scripts/verify-runtime.d/20-hubspot.sh`: 8 checks against a local fake HubSpot, including "read requests only"                                                                                                                                                                           |

Reused from the paused M3 work (stash, inspected file by file):

- **Kept:** the read-model schemas, the process-level config (with API version
  `2026-09`), error classification, retry and Retry-After parsing, the rate
  limiter, and the Zod schemas.
- **Replaced or added:** the single-record association schema was replaced by
  the batch read, because the date-based API reads record associations in
  batch. Error-body scopes, tenant binding, the client, reader, discovery,
  CLIs and all tests were written against the final M2 architecture.

## Definition of Done

| Item                                         | Status                                                      |
| -------------------------------------------- | ----------------------------------------------------------- |
| Current HubSpot app/project setup documented | ✅ `docs/integrations/hubspot/setup.md`                     |
| Authentication for the test environment      | ✅ implemented and tested against the fake; ⛔ live pending |
| Secret-provider integration                  | ✅ tenant credential → SecretProvider (integration tests)   |
| Tenant-scoped HubSpot config                 | ✅ enabled check, own token only, portalId check            |
| Read Contacts / Companies / Leads            | ✅ fake; ⛔ live pending                                    |
| Read properties / associations               | ✅ fake; ⛔ live pending                                    |
| Pagination                                   | ✅ objects and associations                                 |
| 401/403, 404, 429, 5xx/retry behaviour       | ✅ unit + integration                                       |
| Zod validation at the boundary               | ✅                                                          |
| Vendor-neutral read models                   | ✅                                                          |
| Discovery findings documented                | ✅ `discovery-findings.md` (research); ⛔ live run pending  |
| HubSpot test-account evidence                | ⛔ **blocked**: test-account token and network access       |

## Evidence (local, before commit)

```
pnpm verify
  format, lint, typecheck: clean
  depcruise: no dependency violations found (155 modules, 521 dependencies cruised)
  unit:        Test Files 24 passed (24)   Tests 317 passed (317)
  integration: Test Files  9 passed (9)    Tests 107 passed (107)

pnpm verify:runtime  → Summary: 47 passed, 0 failed   (39 core + 8 HubSpot)

pnpm test:live       → 1 skipped: "HubSpot live tests: SKIPPED, missing
                        TENANT_HSTEST_HUBSPOT_ACCESS_TOKEN and HUBSPOT_TEST_PORTAL_ID"
vitest (live config) with no test files → "No test files found, exiting with code 1"
```

The live HubSpot API is not reachable from this environment. The egress proxy
denies `api.hubapi.com`, and no test-account token exists yet.

## Mutation evidence

Each mechanism was broken on its own, and each file was restored and checked
with `cmp` afterwards.

| Guarantee                           | Mutation                                           | Checks that failed                                                                                                                 |
| ----------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Read-only transport                 | Guard returns early for every method               | The 5 read-only guard tests (POST/PUT/PATCH/DELETE, write-like batch paths)                                                        |
| Read-only at runtime                | Guard bypassed **and** property reads sent as POST | Runtime "the connector made read requests only" (fake saw `POST /crm/properties/2026-09/{contacts,companies,leads}`) and discovery |
| Only transient failures retried     | `retryable` always true                            | 401, 403, 404, daily-429, invalid-payload tests (retried when they must not be), read-only tests (`retryable` false)               |
| Daily limit not retried             | `DAILY` treated as retryable                       | "429 daily limit → not retried"                                                                                                    |
| Zod at the boundary                 | Schema validation bypassed                         | "missing a required field → invalid_payload"; association paging (id normalisation lost)                                           |
| Token never leaks                   | Token appended to HTTP error messages              | "401 → … no token in the error", "never writes the token to logs or errors"                                                        |
| Paging cannot loop                  | Repeated-cursor check removed                      | "refuses a paging cursor that does not advance"                                                                                    |
| Disabled integration enforced       | `isEnabled` check skipped                          | "HubSpot disabled → integration_disabled", "disabling HubSpot takes effect immediately"                                            |
| Tenant isolation of tokens          | Connector falls back to the last token it resolved | "each tenant reads with its own token only…" (B was served A's token)                                                              |
| Token belongs to configured account | `portalId` comparison skipped                      | "a token for a different account … → account_mismatch"                                                                             |
| Production accounts refused         | Account-type check skipped                         | "refuses a production (STANDARD) account unless explicitly allowed"                                                                |

Invalid mutation seen and discarded: the first runtime read-only mutation
did not apply the POST change, because Prettier had re-wrapped the target
lines. Only the guard was bypassed, so the check correctly passed. It was
redone with the edit confirmed (`grep -c MUTATION` = 1 per file).

## Independent review

A fresh-context review of `d2c77bb..eaf604b` returned **PASS WITH NITS**: no
blockers and two should-fix items, both fixed.

1. **Per-record errors in a 207 batch association response were silently
   dropped.** `readAssociations` now returns `{ associations, failures }`, and
   discovery reports the failures per sample. The fake returns 207 with
   per-input errors for unknown ids, and a unit test covers it.
2. **`forTenant()` returned a reader without checking the token's account.**
   It now verifies `portalId` before returning, the same as `connect()`. Tests
   cover `forTenant` refusing a token for the wrong account, and refusing a
   tenant with no `portalId` before any request.

Nits fixed:

- The report is described accurately (it includes sampled record ids).
- The live Leads test no longer accepts a 400.
- A test covers a response body that stalls after the headers (timeout).
- The Node engine is now `>=22.18.0`, which the directly-run TypeScript fake
  needs.
- A `\u2014` escape introduced by a scripted `package.json` edit is removed.

Mutation evidence for the two fixes:

| Mutation                                              | Checks that failed                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Per-record 207 failures ignored                       | "returns per-record failures from a 207 multi-status batch read, never dropping them"                                   |
| `forTenant` builds a reader without the account check | "a token for a different account … → account_mismatch", "no configured account id → not_configured, before any request" |

While re-verifying, a runtime run failed because `free_port` gave the API the
port it had just given Redis: ports picked before anything binds them can
repeat. This predates M3. `free_port` now excludes ports already chosen in the
run, in both verification scripts. Proof: with a stubbed port picker that
returns 5000, 5000, 5001, the second pick is 5001; with the exclusion removed,
it is 5000 again.

A second fresh-context review, of only this follow-up (`eaf604b..e3852e1`),
returned **PASS WITH NITS** with two should-fix items, both fixed:

1. **"No credential registered" passed for the wrong reason.** The new
   `portalId` guard fired first. The test now configures a `portalId` and
   asserts the "access token" message. Mutation: with the credential-error
   mapping removed, it and the other credential tests fail with the raw
   `RecordNotFoundError`/`SecretNotFoundError`.
2. **`free_port` could loop forever if `node` printed nothing.** It now fails
   fast on a non-numeric result and gives up after 20 attempts. Its callers
   assign before `export`, so `set -e` stops the script. A stubbed failing
   `node` returns exit 1; before the fix it hung.

Nits fixed:

- The 207 error `context` is parsed leniently: unknown keys are ignored and a
  non-array `ids` becomes empty.
- Repeated per-record failures across paging rounds are reported once.
- An overridden Redis port is excluded from the PostgreSQL port pick.

Nits recorded as technical debt (items 8 and 9): the closed
association-category enum, and the live suite not exercising the tenant path.

## Service Key and API-version update

After the first review, the owner created a read-only **Service Key** for the
developer test account and supplied HubSpot's API-version export for it
(`docs/integrations/hubspot/evidence/service-key-api-versions-export.csv`).
It shows older v3/v4 calls, many of them writes. Changes:

- **Setup and ADR 0009:**
  - Service Key for this read-only discovery; no new legacy private app.
  - The credential stays generic (`hubspot.access_token`).
  - Long term: Service Key or static token for isolated test and internal
    integrations; projects-based app with OAuth for Juniper and future
    customers.
- **Account details** moved from `/account-info/v3/details` (in the export,
  end of support 1 Sep 2027) to the date-based `/account-info/2026-03/details`
  (`HUBSPOT_ACCOUNT_INFO_API_VERSION`). Discovery probes whether `2026-09`
  answers too.
- **The transport refuses any non-date-versioned path** (`unsupported_endpoint`).
  M3 now has no v3/v4 dependency at all.
- **Tests:**
  - Every endpoint in the export, and the same writes on `2026-09`, is
    refused with no request sent.
  - Mutation U8: with the guard removed, the five legacy GET reads fail these
    tests.
- **Discovery reports `endpointsUsed`**, and the fake no longer serves legacy
  paths.
- **Findings:** a historical-versus-current comparison is in
  `discovery-findings.md`.

## Open questions / blocked

1. **Blocked on the user (not Juniper):**
   - A HubSpot developer test account and an app token, stored as
     `TENANT_HSTEST_HUBSPOT_ACCESS_TOKEN`, plus `HUBSPOT_TEST_PORTAL_ID`.
   - Network access to `api.hubapi.com`.

   With both, run setup.md §5. The discovery report and `pnpm test:live`
   become the test-account evidence.

2. **Lead webhooks:** not confirmed on the current app model (community
   reports say they do not fire). To be tested in M5; the design must not
   depend on them until then.
3. **`crm.schemas.leads.read`:** the exact scope name is confirmed by
   discovery's `requiredGranularScopes`.
4. **Juniper-dependent:** Sales Hub tier (Leads object), rate-limit tier,
   custom association labels. These are answered by their discovery run at M16.
