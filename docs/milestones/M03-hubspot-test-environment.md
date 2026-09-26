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

| Area                 | Implementation                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector module     | `src/modules/hubspot` (public API in `index.ts`), registered in the worker; ADR 0009                                                                                                                                                    |
| API version          | `2026-09` (latest GA), `HUBSPOT_API_VERSION`; base URL must be https, or http only for a loopback fake                                                                                                                                  |
| Authentication       | Static access token of a private app in the test account, as tenant credential `hubspot.access_token` → `TENANT_<SLUG>_HUBSPOT_ACCESS_TOKEN` via the SecretProvider                                                                     |
| Tenant-scoped config | `HubSpotConnector.forTenant(ctx)`: integration must be enabled; only the tenant's own token; per-tenant rate budget. `connect(ctx)` also verifies the token's account equals the tenant's `portalId`                                    |
| Reads                | Contacts, Companies, Leads (list with cursor paging, get by id); CRM properties; association labels; record associations (batch read with per-record paging); account details                                                           |
| Read-only guarantee  | Transport refuses everything except GET and POST to the association batch-read path, before sending                                                                                                                                     |
| Error handling       | 401, 403 (+ `requiredGranularScopes`), 404, 400, 429 (`DAILY` not retried; burst honours `Retry-After`), 5xx, timeout, network, invalid payload; bounded jittered retries of transient failures only                                    |
| Validation           | Zod schemas for every HubSpot response; issue paths only in errors (no values)                                                                                                                                                          |
| Read models          | `ExternalPersonSnapshot`, `ExternalCompanySnapshot`, `ExternalLeadSnapshot`, `ExternalFieldDefinition`, `ExternalAssociation[Type]` in `domain` (vendor-neutral; customer fields stay in `attributes`)                                  |
| Discovery            | `HubSpotDiscoveryService` + `hubspot:discover` CLI: account, per-object records (pagination proof) and properties, association labels (6 directions), association samples, Lead availability, missing scopes. Refuses non-test accounts |
| Setup                | `hubspot:configure` CLI: read-only access + credential reference; prints the variable name, never the token. Read-write is not offered                                                                                                  |
| Live suite           | `pnpm test:live` (`test/live/hubspot.live.spec.ts`): fails with zero test files; skips with the missing variable names                                                                                                                  |
| Runtime verification | `scripts/verify-runtime.d/20-hubspot.sh`: 8 checks against a local fake HubSpot, including "read requests only"                                                                                                                         |

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
