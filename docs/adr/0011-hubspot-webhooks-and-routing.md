# ADR 0011: HubSpot webhook intake, account routing and wrong-account revoke (Milestone 5)

- Status: accepted
- Date: 2026-09-28

## Context

Milestone 5 receives HubSpot webhooks from the projects-based app (ADR 0010)
and performs its first real install. The owner decided:

1. **Public HTTPS** in development: a Cloudflare Quick Tunnel first (bounded
   spike), then ngrok, then instructions for a local-machine tunnel. No
   temporary production hosting. The random hostname is never committed.
2. **Revoke** only when HubSpot has just issued a grant, the returned account
   differs from the tenant's configured account and the platform rejects it.
   Exact current endpoint only; the mismatched grant is never stored; no
   generic revocation feature.
3. **Leads**: test Lead push webhooks; if they do not deliver, no workaround
   and no CRM polling. Probe the read-only Webhooks Journal and record
   documented and live behaviour separately.

M5 records receipts only. Processing (queues, CRM reads, qualification) is
Milestone 6 onwards.

## HubSpot facts relied on (checked 2026-09-27/28)

Web search only (the sandbox blocks direct fetches of developers.hubspot.com).
**Docs** = HubSpot documentation, changelog or developer blog; **community** =
HubSpot Community reports; **live** = observed against the test account (M5
evidence, recorded in the milestone record once collected).

| Item                   | Source                         | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App definition         | docs                           | Projects: `hsproject.json` (`platformVersion` `2026.03`, the current version since 30 March 2026), `src/app/app-hsmeta.json` (`type: app`, `config.distribution: private`, `config.auth.type: oauth`, `redirectUrls`, `requiredScopes`/`optionalScopes`/`conditionallyRequiredScopes`), `src/app/webhooks/*-hsmeta.json` (`type: webhooks`). Uploaded with `hs project upload`                                                                                                                                               |
| `config.permittedUrls` | live + official templates      | **Required** by the 2026.03 upload validation ("Missing required field: 'config.permittedUrls'"). `{fetch: string[], iframe: string[], img: string[]}`: the UI-extension allow-list (hubspot.fetch / iframes / images), fully qualified HTTPS URLs. Not for OAuth redirect or webhook URLs. Set to HubSpot's template default `{"fetch": ["https://api.hubapi.com"], "iframe": [], "img": []}` (the app has no UI extensions)                                                                                                |
| OAuth consent URL      | live + HubSpot CLI + templates | The consent URL must request all of the app's required scopes, which include the baseline `oauth` scope (added by HubSpot on upload; listed first in every official template). The host is the account's region host (HubSpot's link for this EU account uses the EU host; Account Info reports `dataHostingLocation: eu1` and a `uiDomain`). The path is the generic `/oauth/authorize` used on the deployed app's link. Platform: tenant setting `uiDomain` (`app[-<region>].hubspot.com` only; default `app.hubspot.com`) |
| Private distribution   | docs                           | Installable only in allowlisted accounts (up to 10), added on the app's Distribution tab                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Webhook config         | docs                           | `settings.targetUrl` (HTTPS), `settings.maxConcurrentRequests`; `subscriptions.crmObjects[]` of `{subscriptionType, objectType, propertyName?, active}`; types `object.creation`, `object.deletion`, `object.merge`, `object.propertyChange`, `object.associationChange`                                                                                                                                                                                                                                                     |
| Payload                | docs                           | JSON array (batched, up to 100 events) of `eventId`, `subscriptionId`, `portalId`, `appId`, `occurredAt` (ms), `subscriptionType`, `attemptNumber`, `objectId`, `objectTypeId` (generic subscriptions), `propertyName`/`propertyValue` (property changes), `changeSource`, `sourceId`                                                                                                                                                                                                                                        |
| Uniqueness             | docs                           | `eventId` is **not guaranteed unique**; HubSpot may send the same notification more than once (at-least-once)                                                                                                                                                                                                                                                                                                                                                                                                                |
| Delivery               | docs                           | Respond within 5 s with 2xx; otherwise HubSpot retries up to 10 times over 24 hours (randomised backoff)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Signature v3           | docs                           | Headers `X-HubSpot-Signature-v3`, `X-HubSpot-Request-Timestamp` (ms). Base64 HMAC-SHA256 keyed with the app's client secret over `method + URI + body + timestamp`. Decode URL-encoded `: / ? @ ! $ ' ( ) * , ;` in the URI (except the `?` starting the query). Reject timestamps older than 5 minutes                                                                                                                                                                                                                      |
| Leads webhooks         | docs                           | Leads are supported by generic object subscriptions                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Leads webhooks         | community                      | January 2026 thread "Project webhook for leads creation not triggering" (unresolved): the test event works, real Lead creation does not deliver. **To be verified live**                                                                                                                                                                                                                                                                                                                                                     |
| Leads webhooks         | live (M5)                      | On test account 149338734 (platform 2026.03) Lead `object.creation` and `object.propertyChange` (`hs_pipeline_stage`) **delivered** (2026-10-01). Proven for this account only, not in general                                                                                                                                                                                                                                                                                                                               |
| Webhooks Journal       | docs                           | `GET /webhooks-journal/journal/v4/earliest`, `/latest`, `/offset/{offset}/next` return `{url, expiresAt, currentOffset}` pointing to a file; scope `developer.webhooks_journal.read`; about 3 days of history. **Not date-versioned** (v4 path): the only exception to the date-based rule, and only if the Journal probe is needed **Not implemented**: Lead push delivered live, so the fallback was not needed and its scope was not added. A possible future resilience/diagnostic option                                |
| Revoke                 | docs                           | `POST /oauth/2026-03/token/revoke`, form body `token`, `client_id`, `client_secret` (v1 `DELETE /oauth/v1/refresh-tokens/{token}` is deprecated, removed 16 February 2027). A page "Manage OAuth access tokens with the 2026-09 API" exists but could not be read; no source quotes a `2026-09/token/revoke` path. ADR 0010 listed `/oauth/2026-09/token/revoke` from a search snippet; not confirmed                                                                                                                        |
| Refresh tokens         | docs                           | Do not expire; valid until the app is uninstalled or the token revoked. A revoked refresh token is final. **Live (M5)**: a refresh returned a refresh token, not rotated                                                                                                                                                                                                                                                                                                                                                     |
| Access after revoke    | community                      | An access token issued before a revoke stays valid until it expires (≤ 30 min)                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Decision

### 1. Intake: `POST /webhooks/hubspot` (API process)

- **Raw body.** All `/webhooks` routes get their body as the exact bytes
  received (`rawRequestBody`, registered in `bootstrap.ts` before any JSON
  parser), limited to **1 MiB**; larger bodies get 413 before they are
  buffered. Signatures are computed over these bytes, never over re-serialised
  JSON.
- **Signature v3 only**, constant-time compare of the decoded HMAC (the
  signature must be canonical base64 of 32 bytes). v1/v2 headers are never
  accepted, even when correct. Timestamps older than **5 minutes** or more than
  **60 seconds** in the future are refused.
- **URI reconstruction** from `HUBSPOT_WEBHOOK_TARGET_URL` (scheme, host,
  path) plus the query string as received. The `Host` header is never used: a
  client controls it, and behind a tunnel it is not the public host anyway.
- **Zod** validation after the signature check; unknown fields
  (`propertyValue`, `sourceId`, `changeFlag`, …) are dropped by the parser.
  Every event must carry `HUBSPOT_APP_ID` (403 otherwise).
- **Responses**: 200 with counts, 400 invalid payload, 401 invalid signature
  (the specific reason is logged, not returned), 403 app mismatch, 413 too
  large, 503 not configured. 5xx (database down) lets HubSpot retry.

### 2. Routing by HubSpot account

A webhook arrives before any tenant is known, and forced RLS hides every
grant from the app role. Instead of weakening RLS, a narrow database function
`app_route_oauth_account(system, account_id)` answers exactly one question.

- It is `SECURITY DEFINER`, owned by a dedicated `NOLOGIN` role
  `lip_webhook_router` that may read only `tenant_oauth_tokens(tenant_id,
system, account_id)` and `tenants(id, status)` — never a token column — with
  a fixed `search_path`. Only `lip_app` may execute it; `lip_app` cannot
  become the router role.
- It returns at most two tenant ids: only **active tenants holding an OAuth
  grant for exactly this account**. 0 = unknown, 2 = ambiguous. Neither is
  ever guessed; their events are acknowledged (200, so HubSpot does not retry
  them for 24 hours) and logged as unroutable with the account id and count.
- The routed tenant must still have HubSpot enabled, in `oauth` mode and
  configured for that account; otherwise the events are unroutable
  (`tenant_not_eligible`).
- A tenant using a static token (e.g. `hstest`, the Service Key tenant on the
  same test account) holds no grant, so it is never a routing target. The two
  coexist.

### 3. Receipts: `tenant_webhook_receipts`

- One row per event, **identifiers only**: event id, subscription id,
  account id, app id, subscription type, object type id, object id, property
  name, change source, occurred-at, first/last attempt number, delivery
  count, received-at. CHECK constraints keep every column to an identifier
  format, so a property value or a body cannot be stored even by mistake.
  Webhook bodies are never stored and never logged.
- **De-duplication is atomic**: the key is SHA-256 over the event's identity
  (account, app, subscription, event id, type, object type, object, property,
  occurred-at; not the attempt number), and each event is one
  `INSERT … ON CONFLICT (tenant_id, system, delivery_key) DO UPDATE` that
  only increments the delivery counter. Concurrent deliveries of one event
  leave exactly one row. This does not rely on `eventId` being unique.
- Forced RLS, `tenant_id` in the key, tenant-immutable trigger (ADR 0008).
- `hubspot:webhook-report --tenant <slug>` prints counts, types, attempt
  numbers and times.

### 4. Wrong-account revoke

`HubSpotOAuthService.completeInstall` compares HubSpot's `hub_id` with the
tenant's configured account **before storing anything**. On a mismatch it
revokes the refresh token HubSpot just issued (`POST /oauth/2026-03/token/revoke`,
form body), then refuses the install (409 `account_mismatch`). A failed revoke
is logged (never the token) and named in the refusal; the install is refused
either way.

- The OAuth client's allow-list is exact: `POST /oauth/{YYYY-MM}/token` and
  `POST /oauth/2026-03/token/revoke`, nothing else.
- `revokeRefreshToken` is not exported from the HubSpot module, and its only
  caller is the private `revokeRefusedGrant` in the mismatch branch. Tests
  assert zero revokes for successful installs, refreshes, reinstalls,
  declined consent and bad states.

### 5. App definition (`hubspot-app/`)

The template under `hubspot-app/template/` holds `{{HUBSPOT_APP_REDIRECT_URI}}`
and `{{HUBSPOT_WEBHOOK_TARGET_URL}}` placeholders (and a static `permittedUrls`, required by HubSpot); `hubspot-app/render.mjs`
fills them in from the environment into the git-ignored `hubspot-app/build/`
for `hs project upload`. A unit test keeps the app's required scopes identical
to the install URL's scopes (`HUBSPOT_OAUTH_SCOPES`, read-only) and its
subscriptions to confirmed properties only.

## Consequences

- The app role's privileges and RLS are unchanged; routing adds one role,
  one function and two `FOR SELECT TO lip_webhook_router` policies. The schema
  guard test pins the router's privileges.
- Unroutable events are acknowledged, not stored (there is no tenant to store
  them for). They are visible in logs only. If needed later, a platform-level
  unroutable-event counter can be added without tenant data.
- A tunnel hostname change means: update `HUBSPOT_APP_REDIRECT_URI` and
  `HUBSPOT_WEBHOOK_TARGET_URL`, re-render, re-upload the app. Deliveries
  signed for the old URL fail verification (by design).
- Changing the dedup identity later would treat already-seen events as new
  once; acceptable for receipts.
