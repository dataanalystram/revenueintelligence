# Milestone 5: HubSpot webhook receiver and first real app install

- Status: **in progress**: local build and proofs done; blocked on a public
  HTTPS tunnel (see [Tunnel spike](#tunnel-spike)) before the real install
- Decisions: [ADR 0011](../adr/0011-hubspot-webhooks-and-routing.md)
- Setup: [integrations/hubspot/setup.md §7](../integrations/hubspot/setup.md#7-milestone-5-the-projects-based-app)

## Scope

In scope:

- `POST /webhooks/hubspot`: signature v3 over the raw body and the configured
  public URL, timestamp freshness, body limit, Zod validation, app id check.
- Routing by HubSpot account to the one tenant holding an OAuth grant.
- Tenant-scoped webhook receipts (identifiers only), atomic de-duplication.
- Revoking a grant refused because it was issued for the wrong account.
- The projects-based app definition (`hubspot-app/`), uploaded and installed
  for real in the developer test account; live evidence.

Not in scope (M6 onwards): processing events, CRM reads triggered by events,
queues, qualification, routing of Leads, any CRM write, Sugar, Gainsight,
Jev/AI, SLA, frontend. No Juniper credentials.

## Definition of Done

| #   | Item                                                                                                     | State                                                 |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | HubSpot documentation verified; docs, community reports and live behaviour recorded separately           | done (ADR 0011); live column pending                  |
| 2   | Webhook intake with every security requirement, unit + integration + runtime tested                      | done                                                  |
| 3   | Routing only to active tenants with a grant; unknown/ambiguous never guessed; static tenant coexists     | done (local)                                          |
| 4   | Receipts: forced RLS, identifiers only, atomic de-duplication                                            | done (local)                                          |
| 5   | Wrong-account revoke: only in the mismatch branch, exact endpoint, grant never stored                    | done (local; live revoke optional, needs 2nd account) |
| 6   | Every required mutation makes a check fail for the right reason                                          | done (22 mutations below)                             |
| 7   | Public HTTPS tunnel: bounded spike with preservation proof                                               | **blocked** (network policy)                          |
| 8   | App uploaded, real OAuth install, encrypted grant, OAuth CrmReader reads                                 | pending (manual steps, setup §7)                      |
| 9   | Real refresh and rotation, old refresh token behaviour, granted scopes, `oauth` scope needed or not      | pending                                               |
| 10  | Live Contact, Company and Lead webhooks (Journal probe if Leads do not deliver); real v3 signature       | pending                                               |
| 11  | Live URI reconstruction, payload shape (safe metadata), batching/retry, duplicate recorded once, routing | pending                                               |
| 12  | `hstest` unchanged and coexisting; zero CRM writes                                                       | pending (live)                                        |
| 13  | `pnpm verify`, runtime, Docker, fresh clone, CI on the final commit, independent review                  | pending (final gate)                                  |

## What was built

| Area           | Files                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw body       | `src/platform/http/raw-body.ts` (1 MiB, 413), registered for `/webhooks` in `src/bootstrap.ts`                                                                                                                                           |
| Signature      | `src/modules/hubspot/infrastructure/webhook-signature.ts` (v3 only, 5 min / 60 s window, canonical base64, constant time, URI from configuration)                                                                                        |
| Payload        | `src/modules/hubspot/infrastructure/webhook-events.ts` (Zod, ≤ 100 events, identifiers only, stable delivery key)                                                                                                                        |
| Intake         | `src/modules/hubspot/application/hubspot-webhook.service.ts`, `api/hubspot-webhook.controller.ts`                                                                                                                                        |
| Routing        | `src/modules/tenancy/infrastructure/oauth-account-router.ts`; migration `20260928120000_webhook_receipts_and_routing` (`lip_webhook_router`, `app_route_oauth_account`)                                                                  |
| Receipts       | `tenant_webhook_receipts` (same migration), `infrastructure/webhook-receipt.repository.ts`, CLI `hubspot:webhook-report`                                                                                                                 |
| Revoke         | `infrastructure/oauth-client.ts` (`revokeRefreshToken`, exact allow-list), `application/hubspot-oauth.service.ts` (`revokeRefusedGrant`, mismatch branch only)                                                                           |
| Config         | `HUBSPOT_APP_ID`, `HUBSPOT_WEBHOOK_TARGET_URL` (`hubspot.config.ts`, `.env.example`)                                                                                                                                                     |
| App definition | `hubspot-app/template/**`, `hubspot-app/render.mjs` (host never committed; `build/` git-ignored)                                                                                                                                         |
| Test support   | `test/support/hubspot-webhooks.ts` (independent v3 signer, event builder, standalone sender), fake HubSpot revoke endpoint                                                                                                               |
| Tests          | `webhook-signature.spec.ts`, `webhook-events.spec.ts`, `raw-body.spec.ts`, `hubspot-app.spec.ts`, `oauth-client.spec.ts` (revoke), `test/hubspot/webhooks.int.spec.ts`, revoke cases in `oauth*.int.spec.ts`, schema guard (router role) |
| Runtime        | `scripts/verify-runtime.d/40-hubspot-webhooks.sh` (23 checks)                                                                                                                                                                            |

## Evidence (local)

### Tests and runtime

```text
$ pnpm verify        # format, lint, typecheck, boundaries, unit, integration
All matched files use Prettier code style!
✔ no dependency violations found (189 modules, 695 dependencies cruised)
 Test Files  33 passed (33)
      Tests  393 passed (393)
 Test Files  12 passed (12)
      Tests  171 passed (171)
$ pnpm verify:runtime
== Extra: 40-hubspot-webhooks.sh
  PASS  signed batch → 200, 3 events stored
  PASS  the same delivery replayed → 200, recorded once (duplicates 3)
  PASS  HubSpot retry (attempt 1) of an event → counted on the same receipt
  PASS  10 concurrent deliveries of one event → exactly 1 receipt (deliveries = 10)
  PASS  stale timestamp (6 min old) → 401
  PASS  future timestamp (+5 min) → 401
  PASS  signed for the Host header the client sent, not the configured URL → 401
  PASS  signed for the configured URL, arbitrary Host header → 200 (Host never trusted)
  PASS  v1/v2 signatures (no v3) → 401
  PASS  signed with another secret → 401
  PASS  events for another app id → 403
  PASS  unknown HubSpot account → 200, acknowledged, never guessed (unroutable 1)
  PASS  body over 1 MiB → 413
  PASS  receipts: 4 for rtwebhook, none for the static tenant, identifiers only
  PASS  app role with no tenant set sees no receipts (RLS)
  PASS  routing function answers for the app role; grants stay invisible to it
  PASS  hubspot:webhook-report: counts, types, attempts; no values
  PASS  API log: outcomes recorded; no body, value, signature or secret
  PASS  webhooks caused no HubSpot call (no CRM reads, no writes)
== Summary: 85 passed, 0 failed
```

The first integration run failed every delivery with 401: the test client
(superagent) JSON-encoded the `Buffer` body, so the bytes sent were not the
bytes signed. The verifier was right; the test now sends the exact string.
This is also a live demonstration that a re-serialised body fails
verification.

### Mutations

Harness: back up, apply exact replacements (each anchor asserted to occur
once), confirm the `MUTATION` markers, run the named checks, restore, confirm
byte-identical. All 22 restored identical; no marker left in `src/`,
`prisma/` or `dist/` (dist rebuilt afterwards).

| #    | Mutation                                                | Failed check(s)                                                                                                  |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| W1   | Signature verification removed                          | wrong signature/secret/body → got 200; stale/future; Host; v1/v2 (4 integration tests)                           |
| W2   | Stale timestamps accepted                               | unit "rejects stale timestamps"; integration "stale … → 401" (got 200)                                           |
| W3   | Future-timestamp protection removed                     | unit (future boundary); integration "future-dated → 401" (got 200)                                               |
| W4   | De-duplication removed (unstable delivery key)          | unit "same key for every attempt"; integration replay, 20 concurrent (20 rows), same event twice                 |
| W4b  | De-duplication not atomic (no `ON CONFLICT`)            | integration replay/concurrent/batch → 500 (unique violation)                                                     |
| W5   | Arbitrary Host header trusted for the signed URI        | integration "the Host header is never trusted"                                                                   |
| W6   | App id check removed                                    | integration "events for another app → 403"                                                                       |
| W7   | Routing without a grant (by configured portalId)        | integration: first batch (5005 now ambiguous), mixed batch, routing function returns grant holders only          |
| W8   | Ambiguous routing allowed (`LIMIT 1`)                   | integration "ambiguous: never guessed" and "the router: unknown, ambiguous, malformed ids"                       |
| W9   | Property values kept by the parser and written          | unit "identifiers only"; integration first batch (database CHECK refuses the value → 500)                        |
| W9b  | Same, with the database constraint also removed         | integration "identifiers only" (value found in the table dump)                                                   |
| W10  | Webhook body stored (constraint removed)                | integration "identifiers only" (body found in the table dump)                                                    |
| W11  | RLS removed from `tenant_webhook_receipts`              | integration "receipts are visible only inside their own tenant transaction"                                      |
| W11b | Same, schema guard                                      | `migrations.int.spec.ts` "every table has row-level security enabled and forced" (`['tenant_webhook_receipts']`) |
| W12  | v1/v2 signatures accepted                               | integration "v1 and v2 signatures are never accepted"                                                            |
| W13  | OAuth allow-list widened (`/oauth/*`)                   | unit "allows exactly POST to the token endpoint and to the one revoke endpoint"                                  |
| W14  | Revoke outside the wrong-account branch (after success) | callback "completes an install" (revoke 0), "no other refusal revokes", 5 refresh tests (grant revoked)          |
| W15  | Raw body not used (re-serialised JSON verified)         | integration "verifies the exact raw bytes" (got 401)                                                             |
| W15b | Raw-body middleware removed                             | integration accepted deliveries → 500 (fail closed: no raw body)                                                 |
| W16  | Body size limit removed                                 | unit "refuses a body over the limit" (got 200); integration "over the limit → 413" (got 401)                     |
| W17  | Webhook body logged                                     | runtime "API log: … no body, value, signature or secret" (84 passed, 1 failed)                                   |
| W18  | v3 signature header not redacted in request logs        | runtime, same check (84 passed, 1 failed)                                                                        |

## Tunnel spike

Bounded spike in the Claude Code cloud environment, 2026-09-27, against a
local echo server (records method, raw URL, headers, body hash).

| Step                          | Result                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install                       | OK: `cloudflared version 2026.9.3 (built 2026-09-24-16:07 UTC)`, downloaded from GitHub releases                                                                        |
| DNS                           | Resolves: `api.trycloudflare.com` (2606:4700::6810:e784, …), `region1.v2.argotunnel.com`, `region2.v2.argotunnel.com`                                                   |
| Command                       | `cloudflared tunnel --no-autoupdate --url http://localhost:18777`                                                                                                       |
| Failure                       | `Requesting new quick Tunnel on trycloudflare.com...` → `quick tunnel provisioning failed with status 403`, exit 1                                                      |
| Cause                         | The environment's egress proxy refuses the host: `curl https://api.trycloudflare.com/` → `CONNECT tunnel failed, response 403` (proxy 403 = organisation egress policy) |
| Edge port                     | Direct TCP to `region1.v2.argotunnel.com:7844` fails (cloudflared's edge connection uses port 7844, not the HTTPS proxy)                                                |
| cloudflared connected         | no                                                                                                                                                                      |
| Hostname issued               | no                                                                                                                                                                      |
| Public URL reached the API    | not tested (no hostname)                                                                                                                                                |
| Method/headers/body/path kept | not tested (no hostname)                                                                                                                                                |
| ngrok                         | Also refused by policy: `bin.equinox.io`, `connect.ngrok-agent.com`, `api.ngrok.com` → `CONNECT tunnel failed, response 403`. Would also need `NGROK_AUTHTOKEN`         |

Preservation proof is therefore still owed and will be run through whichever
tunnel becomes available (same echo-server procedure, then the API).

## Live findings

### 1. HubSpot upload validation: `config.permittedUrls` is required (2026-09-28)

First real `hs project upload` (local Mac, ngrok; HubSpot CLI authenticated to
the developer account; project `lip-lead-intelligence-dev`) failed:

```text
Project validation failed:

Encountered the following errors for build/src/app/app-hsmeta.json:
- Missing required field: 'config.permittedUrls'
```

Not a tunnel issue: a template/schema gap.

- **Where the rule lives**: the CLI does not ship the schema. `@hubspot/cli`
  8.15.0 → `@hubspot/project-parsing-lib` 0.23.3 fetches it per account from
  HubSpot at upload time (`project-components-external/project-schemas/v3/{platformVersion}`).
  developers.hubspot.com is blocked from the cloud session, so the schema was
  confirmed from HubSpot's own repositories and packages.
- **Structure**: every official app template in
  [HubSpot/hubspot-project-components](https://github.com/HubSpot/hubspot-project-components)
  (commit `233e986`, 2026-09-08) declares
  `"permittedUrls": {"fetch": ["https://api.hubapi.com"], "iframe": [], "img": []}`.
  That covers 2025.2, 2026.03, 2026.09 and 2027.03-beta, and each of
  static-private, oauth-private and oauth-marketplace. HubSpot's typings
  (`@hubspot/ui-extensions-dev-server` 2.2.2,
  `UnifiedAppComponent.config.permittedUrls`) define exactly
  `{ fetch: string[]; iframe: string[]; img: string[] }`.
- **Meaning**: the allow-list for UI extensions (cards, settings pages):
  URLs they may call with `hubspot.fetch`, load in iframes or use as images.
  HubSpot's template guidance (`2026.03/defaultFiles/AGENTS.md`): entries are
  fully qualified HTTPS URLs, not `localhost`. The dev server flattens all
  three lists into the extension's allowed URLs. No example uses wildcards,
  and nothing documents them.
- **For this app**: no UI extensions, so the lists have no effect. OAuth
  redirect URLs stay in `auth.redirectUrls`, and the webhook target stays in
  `webhooks-hsmeta.json` `settings.targetUrl`. The tunnel host is not added.
- **Fix**: static `permittedUrls` identical to HubSpot's oauth-private
  template. `render.mjs` now validates the rendered project against an
  allow-list:
  - `permittedUrls` is exactly that value;
  - redirect URLs and the target URL are exactly the two environment URLs,
    on one host;
  - that host appears exactly twice;
  - scopes are `crm.*.read` only;
  - distribution is private, auth is OAuth.

  Substituted values are JSON-escaped.

- **Mutation proofs** (`hubspot-app.spec.ts`; each failed, each restored byte-identical):

  | #   | Mutation                                  | Failed test(s)                                                                                     |
  | --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
  | P1  | `permittedUrls` removed from the template | "declares config.permittedUrls…", render, generated app, "never commits a public host", allow-list |
  | P2  | tunnel host rendered into `fetch`         | "declares…", render refuses, generated app, allow-list                                             |
  | P3  | placeholder values not JSON-escaped       | "extra URLs cannot be injected…"                                                                   |
  | P4  | `permittedUrls` allow-list check removed  | "a template that widens permittedUrls… is refused"                                                 |
  | P5  | host-occurrence check removed             | same (host added to the description)                                                               |
  | P6  | write scopes allowed                      | same (`crm.objects.contacts.write`)                                                                |

- **Not proven**: whether HubSpot would also accept an empty `fetch` list. No
  official example has one, so the template default was kept rather than guessed.
- **Gates after the fix**: `pnpm verify` passes (unit 33 files / 397 tests,
  integration 12 files / 171 tests). `pnpm verify:runtime` passes (85 passed,
  0 failed).
- **Also observed**: HubSpot did not report the missing `oauth` scope or the
  optional `support` block (both present in the official template) as errors.

### 2. OAuth consent: login loop before the consent page (2026-09-28)

After a successful upload, the URL from `hubspot:install-url` opened HubSpot
but looped on sign-in, so the callback was never reached. Comparing it with
the install link HubSpot generated for the deployed app:

| Item   | Ours (before)                        | HubSpot's link                       |
| ------ | ------------------------------------ | ------------------------------------ |
| Host   | `app.hubspot.com`                    | the EU host of this account          |
| Path   | `/oauth/{portalId}/authorize`        | `/oauth/authorize`                   |
| Scopes | 5 CRM read scopes                    | `oauth` + the same 5 CRM read scopes |
| Other  | `client_id`, `redirect_uri`, `state` | `client_id`, `redirect_uri`          |

Evidence (web search unavailable; the docs site is blocked from the cloud
session):

- **Account region, live**: HubSpot's Account Information API, read with the
  Service Key, reports account 149338734 as `dataHostingLocation: "eu1"`
  (committed `docs/integrations/hubspot/discovery-report.json`).
- **`oauth` scope, live and official**: the upload output stated that HubSpot
  added `oauth` to the app's required scopes. Every official 2026.03 app
  template (hubspot-project-components `233e986`) lists `"oauth"` first in
  `requiredScopes`.
- **How HubSpot builds the URL**: `@hubspot/cli` 8.15.0 (`lib/app/urls.js`
  `getOauthAppInstallUrl`) puts the app's `requiredScopes` into `scope`, so
  the consent URL must request all of the app's required scopes. The CLI
  builds `https://app.hubspot.com/oauth/{accountId}/authorize`: its origin
  helper (`@hubspot/local-dev-lib` 5.11.0 `getHubSpotWebsiteOrigin`) only
  distinguishes HubSpot's QA environment, not data-hosting regions. The
  deployed app's own link, by contrast, is region-specific with the generic
  path.

Root cause (best supported, not proven by an isolated live A/B test):

- Our URL did not request the app's full required scope set (`oauth`
  missing).
- It sent an EU-hosted account to the global host, with an account-specific
  path that differs from HubSpot's own link for this app.

Fix (all three aligned with HubSpot's own link):

- `oauth` added to `HUBSPOT_OAUTH_SCOPES` and to the app template, so the
  file matches the deployed app instead of relying on HubSpot's silent
  addition. No other scope.
- The consent host is per tenant: a new integration setting `uiDomain`, set
  with `hubspot:configure --ui-domain`, accepting only
  `app[-<region>].hubspot.com`. It defaults to `app.hubspot.com`.
- The path is `/oauth/authorize`.
- The process-level `HUBSPOT_OAUTH_AUTHORIZE_BASE_URL` is now a loopback-only
  test override.
- Unchanged: the signed, single-use, tenant-bound state with a 10-minute
  expiry; the exact `redirect_uri`; the hub_id check after the exchange (with
  revoke on mismatch); read-only access.

Mutation proofs (each failed, each restored byte-identical):

| #   | Mutation                                  | Failed test(s)                                                                                                                |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Q1  | baseline `oauth` dropped                  | consent-url, oauth-client and app-definition scope tests; callback install tests (the fake refuses a consent without `oauth`) |
| Q2  | region ignored (always `app.hubspot.com`) | "opens on the account's regional HubSpot host…"                                                                               |
| Q3  | old portal-specific path                  | consent-url host/path tests; callback install tests (the fake serves only `/oauth/authorize`)                                 |
| Q4  | any `uiDomain` accepted                   | tenancy settings "validate formats"                                                                                           |
| Q5  | authorize override not loopback-only      | "the fake override is honoured only for a loopback test server"                                                               |
| Q6  | write scope added to the consent URL      | "carries exactly client_id, the exact redirect_uri, the scopes and the state"; callback spec (fake refuses non-read scopes)   |

Gates after the fix: `pnpm verify` passes (unit 34 files / 401 tests,
integration 12 files / 171 tests). `pnpm verify:runtime` passes (86 passed,
0 failed; includes the new `--ui-domain` check).

Retry: re-upload the app (its file now lists `oauth`, which matches what
HubSpot deployed), then reconfigure `hsoauth` with
`--ui-domain app-eu1.hubspot.com` and issue a new install URL.

## Open questions

1. **Tunnel**: allow `api.trycloudflare.com` in the environment's network
   access (and confirm outbound port 7844 to `*.v2.argotunnel.com` is
   permitted), or allow ngrok's hosts and set `NGROK_AUTHTOKEN`, or run the
   tunnel and API on a local machine (setup §7).
2. **Revoke version**: `POST /oauth/2026-03/token/revoke` is the path HubSpot's
   changelog and blog quote. A "2026-09" OAuth token page exists but could not
   be read here, and no source quotes `2026-09/token/revoke`. Kept at
   `2026-03` (GA, documented); switch if the 2026-09 page documents it.
3. **`oauth` scope**: resolved. HubSpot added it on upload, and it is now
   requested (live finding 2). Whether the consent succeeds is confirmed on
   the next install attempt.
4. **Leads object type in webhook subscriptions**: `lead` is used; the upload
   validates it.
5. **Webhooks Journal**: probed only if Lead webhooks do not deliver. It needs
   the extra scope `developer.webhooks_journal.read` (app re-upload) and uses
   non-date-versioned `v4` paths (the documented exception).
