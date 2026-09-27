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
| API version          | `2026-09` for every call: CRM objects, properties, associations and the Account Information API (confirmed live). The transport refuses any non-date-versioned (v1–v4) path                                                                                                               |
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

| Item                                         | Status                                                           |
| -------------------------------------------- | ---------------------------------------------------------------- |
| Current HubSpot app/project setup documented | ✅ `docs/integrations/hubspot/setup.md`                          |
| Authentication for the test environment      | ✅ fake and **live** (Service Key accepted; invalid token → 401) |
| Secret-provider integration                  | ✅ tenant credential → SecretProvider (integration tests)        |
| Tenant-scoped HubSpot config                 | ✅ enabled check, own token only, portalId check                 |
| Read Contacts / Companies / Leads            | ✅ fake and **live** (Leads available, 0 records in the account) |
| Read properties / associations               | ✅ fake and **live**                                             |
| Pagination                                   | ✅ objects and associations                                      |
| 401/403, 404, 429, 5xx/retry behaviour       | ✅ unit + integration                                            |
| Zod validation at the boundary               | ✅                                                               |
| Vendor-neutral read models                   | ✅                                                               |
| Discovery findings documented                | ✅ `discovery-findings.md` with live evidence                    |
| HubSpot test-account evidence                | ✅ `discovery-report.json`, `pnpm test:live` 6/6                 |

## Evidence

From a fresh clone of `f906ad8` (the last code change; the final commit only
adds this evidence and a one-line fallback fix in `verify-runtime.sh`):

```
pnpm verify
  format, lint, typecheck: clean
  depcruise: no dependency violations found (156 modules, 532 dependencies cruised)
  unit:        Test Files 25 passed (25)   Tests 343 passed (343)
  integration: Test Files  9 passed (9)    Tests 107 passed (107)
pnpm verify:runtime  → Summary: 47 passed, 0 failed   (39 core + 8 HubSpot)
pnpm test:live       → Test Files 1 passed (1)  Tests 6 passed (6)   (developer test account)
pnpm verify:docker   → Summary: 12 passed, 0 failed; cleanup verified
resources before/after: app_procs=0 lip_containers=0 all_containers=0 volumes=0
                        compose_networks=0 lip_images=0 testcontainers=0
GitHub CI on f906ad8: all 4 jobs passed
```

`hubspot:discover --tenant hstest` (live, production path):

```
Account                149338734 (DEVELOPER_TEST)
API version            2026-09
contacts               6 read; 402 properties
companies              6 read; 247 properties
leads                  0 read; 132 properties
Leads object           available: Leads object readable (0 record(s) read, 132 properties)
Missing scopes         none reported
```

With no test files, the live config exits 1 ("No test files found").
Without credentials, the suite skips and names the missing variables.

## Mutation evidence

Each mechanism was broken on its own, and each file was restored and checked
with `cmp` afterwards.

| Guarantee                           | Mutation                                              | Checks that failed                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Read-only transport                 | Guard returns early for every method                  | The 5 read-only guard tests (POST/PUT/PATCH/DELETE, write-like batch paths)                                                        |
| Read-only at runtime                | Guard bypassed **and** property reads sent as POST    | Runtime "the connector made read requests only" (fake saw `POST /crm/properties/2026-09/{contacts,companies,leads}`) and discovery |
| Only transient failures retried     | `retryable` always true                               | 401, 403, 404, daily-429, invalid-payload tests (retried when they must not be), read-only tests (`retryable` false)               |
| Daily limit not retried             | `DAILY` treated as retryable                          | "429 daily limit → not retried"                                                                                                    |
| Zod at the boundary                 | Schema validation bypassed                            | "missing a required field → invalid_payload"; association paging (id normalisation lost)                                           |
| Token never leaks                   | Token appended to HTTP error messages                 | "401 → … no token in the error", "never writes the token to logs or errors"                                                        |
| Paging cannot loop                  | Repeated-cursor check removed                         | "refuses a paging cursor that does not advance"                                                                                    |
| No legacy (v1–v4) calls (U8)        | Date-version guard removed from `send()`              | The 5 legacy GET reads from the API-version export are sent; their "refuses … before any request is sent" tests fail               |
| No path traversal to legacy (U9)    | Dot-segment/encoding/URL-normalisation checks removed | "refuses legacy (non date-based) read paths" (`/crm/objects/2026-09/../../v3/...` would pass)                                      |
| Disabled integration enforced       | `isEnabled` check skipped                             | "HubSpot disabled → integration_disabled", "disabling HubSpot takes effect immediately"                                            |
| Tenant isolation of tokens          | Connector falls back to the last token it resolved    | "each tenant reads with its own token only…" (B was served A's token)                                                              |
| Token belongs to configured account | `portalId` comparison skipped                         | "a token for a different account … → account_mismatch"                                                                             |
| Production accounts refused         | Account-type check skipped                            | "refuses a production (STANDARD) account unless explicitly allowed"                                                                |

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
  (later `2026-09`, after the live run proved it)
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

## Live validation (2026-09-26)

Run in a session with the owner-configured environment:
`TENANT_HSTEST_HUBSPOT_ACCESS_TOKEN` (read-only Service Key, never printed or
logged), `HUBSPOT_TEST_PORTAL_ID`, and network access to `api.hubapi.com`.
Presence was checked by name only.

- **`pnpm test:live`: 5/5 passed.** Authenticates against the expected test
  account (portal id matches, type `DEVELOPER_TEST`); reads Contacts and
  Companies with pagination; reads Leads; 404 for a missing record; 401 for an
  invalid token.
- **Discovery via the production path:** `hubspot:configure` (read-only) then
  `hubspot:discover` against tenant `hstest`. Account `149338734` matched.
  - Contacts: 6 read, 402 properties. Companies: 6 read, 247 properties.
  - Leads: available, 0 records, 132 properties.
  - Association labels in six directions.
  - Contact → Company associations: 4 with, 2 without.
  - No missing scopes.
  - Only date-based `GET`, plus `POST …/batch/read`.

  Details and the endpoint list are in `discovery-findings.md`; the full
  report is in `discovery-report.json`.

What the live run changed:

1. **Account info moved to `2026-09`.** It was on `2026-03`; `2026-09`
   answered live, so every call now uses `2026-09`.
2. **"No associations" is not a failure.** HubSpot reports it per record in
   a 207 (`crm.associations.NO_ASSOCIATIONS_FOUND`, `context.fromObjectId`).
   The connector now counts these separately. The schema accepts the live
   shape, including numeric ids, and the fake reproduces it.
3. **Confirmed association type ids** (578/608 lead↔contact, 580/610
   lead↔company, and their reverses) replaced the fake's placeholder.

## Final review round

A fresh-context review of `e540c64..31f3d4c` returned **PASS WITH NITS**,
with three should-fix items, all fixed:

1. **`..` or `%2e` segments could smuggle a legacy path past the date-version
   guard**, because URL normalisation happened after the check. For example,
   `getAccount('2026-09/../../account-info/v3')`. Fix:
   - the guard now requires plain path segments and that URL normalisation
     leaves the path unchanged;
   - `getAccount` validates its version as `YYYY-MM`;
   - traversal tests added; mutation U9 fails them.
2. **The evidence block was stale.** Refreshed above; U8 and U9 are in the
   mutation table.
3. **The "`2026-03` answered live" claim was not in committed evidence.**
   `pnpm test:live` now reads account info at `2026-09` and `2026-03` and
   checks the portal id (6/6 live).

Nits fixed:

- The export has eight writes (it said nine).
- A unit test covers the discovery probe when the versions differ, and when
  a version does not answer.
- An empty `fromObjectId` falls back to `ids`.
- `NO_ASSOCIATIONS_FOUND` for an id that wasn't requested stays a failure.

A last fresh-context review of `31f3d4c..f906ad8` returned **PASS WITH NITS**
with no should-fix items:

- The path guard held against every bypass tried: `..`, `%2e`, `%2F`,
  backslashes, Unicode dots, trailing slash or newline, `//`, `?` and `#`.
- Every path the connector sends still passes.

Nits fixed in the final commit:

- A shutdown probe fallback could yield `0\n0`.
- This evidence block, and the live count (6/6), were stale.

Nits left:

- The requested-id filter spans the whole call, not each 1,000-id batch.
- An error entry mixing requested and unrequested ids is kept as a failure
  (fails safe).

## CI: intermittent Redis recovery

On `31f3d4c`, CI's runtime job failed once at "Redis back → readiness
recovers": readiness stayed 503 for 30 s after Redis restarted.

- It passed on the one permitted re-run of the same commit, in the fresh-clone
  run of the same commit, and in every earlier CI and local run.
- The runner's logs are not retrievable, so the cause is **unknown**. It is
  not claimed as a flake.
- The diff does not touch Redis or that check.

Changes, so a recurrence can be diagnosed and does not hide other checks:

- The check records `compose start` output, the readiness body, the Redis
  container state and logs, and the API log tail.
- CI uploads `/tmp/lip-verify.*` as an artifact when the job fails.
- Two probes in the shutdown section no longer abort the run under `set -e`.

Mutation: with Redis deliberately left stopped, the run completes with 45
passed and 2 failed ("Redis back …" and "expected open connections before
shutdown"). The diagnostics are in the log and no process remains. Before the
fix, the same fault aborted the run after "worker PID is the node process".
Tracked as technical-debt item 10.

## Lead-record closure (live)

The last live-evidence gap was that the test account held no Leads. The owner
created three test Leads by hand in the HubSpot UI, each linked to an existing
test Contact and test Company. The connector did not write anything.

Discovery gained one read-only capability. It now samples the reverse
directions (Contact → Lead, Company → Lead), which it did not sample before.
It reads them on exactly the contacts and companies that the sampled Leads
link to. A reciprocity check confirms each forward link reads back in
reverse. The test fake now matches the live data: it serves reverse
associations with HubSpot's paired type ids, and its Lead links carry both
the labelled and the unlabelled type. Live, both types were seen across the
links; the report aggregates types, so "every link carries both" is the
fake's modelling choice, not a live observation. Tests cover:

- Lead pagination;
- both reverse directions;
- reciprocity, including a forward link that is missing in reverse (fake
  switch `hideReverse`: counted 2 of 3, not 3 of 3).

Mutations:

- **Reciprocity count forced to 0:** the discovery test fails.
- **Reverse samples taken from the generic contact/company sample:** the
  discovery test fails.
- **Reciprocity count inflated (`confirmed = forward.length`):** the
  non-reciprocal test fails (`confirmed` expected 2, received 3). Before
  that test existed, this mutation passed. The independent review found the
  gap.

Live result (`hubspot:discover --tenant hstest`, production path):

```
leads      3 read; 132 properties       pages of 2: pagesRead 2, paginationVerified true
leads→contacts     checked 3, with 3, associations 3   types 578 Primary + 608
leads→companies    checked 3, with 3, associations 3   types 580 Primary + 610
contacts→leads     checked 1 (the linked contact), associations 3   types 579 "Lead with Primary Contact" + 609   reciprocal 3/3
companies→leads    checked 1 (the linked company), associations 3   types 581 "Lead with Primary Company" + 611   reciprocal 3/3
missing scopes     none;   methods: GET, POST (batch read only);   non-date-versioned paths: 0
report: no Service Key, no Lead names ("M3 Test Lead"), no email values; Lead records hold counts and ids only
```

`pnpm test:live`: 6/6.

## Open questions

1. **Lead webhooks:** not confirmed on the current app model (community
   reports say they do not fire). To be tested in M5; the design must not
   depend on them until then. Service Keys cannot receive webhooks; M5 needs
   the projects-based app.
2. **Juniper-dependent:** Sales Hub tier (Leads object), rate-limit tier and
   custom association labels. These are answered by Juniper's discovery run
   at M16.
