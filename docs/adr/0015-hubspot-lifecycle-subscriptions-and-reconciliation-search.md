# ADR 0015: HubSpot lifecycle subscriptions and reconciliation search (Milestone 6)

- Status: accepted
- Date: 2026-10-01

## Context

M6 keeps canonical context current from HubSpot (plan:
[M06](../milestones/M06-event-processing-canonical-context.md)). Two
HubSpot capabilities are added, both read-only:

1. lifecycle webhook subscriptions (deletion, restore, merge, association
   change) on top of M5's creation and property-change subscriptions;
2. a reconciliation read that lists records changed since a watermark,
   using HubSpot's CRM search endpoint (a `POST` that reads).

The approved plan made the search endpoint and version a **hard
precondition (Gate 1)**: no search code, allow-list entry, request builder
or fixture before the exact path is verified and recorded here. If the
version remained unclear, the documented `2026-03` endpoint is used;
`2026-09` is never assumed.

## Gate 1 evidence: CRM search endpoint and version

- **Date**: 2026-10-01.
- **Method of verification**: web search over HubSpot's official developer
  documentation. A direct fetch of `developers.hubspot.com` is blocked by
  this environment's network egress policy (`EGRESS_BLOCKED`). The table
  below is the documentation as indexed by search, quoted from result titles
  and summaries. (This record first said no HubSpot credentials existed in
  the container; that was wrong: the test account's static token is
  provided to the live suite. The live confirmation below was added once
  this was noticed, after the code was written from the documentation.)

| #   | Source (official HubSpot documentation)                                                                                                                            | Observed                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [Search objects, under the **latest** (2026-09) API reference](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/search/search-objects) | Page title: **`POST /crm/objects/2026-03/{objectType}/search`**. The current ("latest") reference still documents search at version `2026-03`                                                               |
| 2   | [CRM Search API, latest](https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm)                                                              | "CRM search endpoints are constructed using the following format: `/crm/objects/2026-03/{object}/search`"                                                                                                   |
| 3   | [Search the CRM, 2026-03](https://developers.hubspot.com/docs/api-reference/2026-03/crm/search-the-crm)                                                            | Same format; limits: 10 000 results per query (paging beyond returns 400), up to 200 objects per page, 5 requests/s per account, ≤ 5 filter groups / 6 filters each / 18 total, query ≤ 3 000 characters    |
| 4   | [Search contacts, 2026-03](https://developers.hubspot.com/docs/api-reference/2026-03/crm/objects/contacts/search/search-contacts)                                  | `POST /crm/objects/2026-03/contacts/search`; body fields `after`, `filterGroups`, `limit`, `properties`, `sorts`, `query`; scope `crm.objects.contacts.read`; default properties include `lastmodifieddate` |
| 5   | [Search API guide](https://developers.hubspot.com/docs/api-reference/search/guide) and the 2026-03 search page                                                     | Companies: `hs_lastmodifieddate` updates whenever any property changes and can be used to filter and sort; contacts: `lastmodifieddate`. Sort objects are `{propertyName, direction: ASCENDING/DESCENDING}` |
| 6   | Search results describing a `2026-09` search path                                                                                                                  | Only search-engine summaries extrapolating the pattern; no official page titled with a `2026-09` search path was found                                                                                      |

**Gate 1 decision**: the verified endpoint is version **`2026-03`**:

- `POST /crm/objects/2026-03/contacts/search` — scope
  `crm.objects.contacts.read` (already granted);
- `POST /crm/objects/2026-03/companies/search` — scope
  `crm.objects.companies.read` (already granted).

This matches the M5 finding that some HubSpot endpoints (OAuth revoke) were
not re-versioned in `2026-09`. All other reads stay on the existing
`2026-09` paths. If HubSpot later documents a `2026-09` search path, moving
to it is a separate, evidenced change to this ADR and the allow-list.

**Confirmed live** (2026-10-01, read-only, developer test account
149338734, static token, `pnpm test:live`):

- `test/live/hubspot-crm.live.spec.ts` "Gate 1 (ADR 0015): the verified
  2026-03 search answers for contacts and companies": both searches return
  results, a `total` and oldest-first ordering through the exact allow-list
  and body validator;
- `test/live/context.live.spec.ts`: backfill (36 companies, 103 contacts)
  and a reconciliation over `POST /crm/objects/2026-03/{contacts|companies}/search`
  complete with no failures and no dead letters, the state hash is unchanged
  by a second backfill and by the reconciliation, and every recorded request
  was a `GET` or an allow-listed read `POST`;
- three consecutive runs: 14/14 tests passed; no token or email address in
  the output.

That live run also found two defects, fixed before review: record reads did
not request `jobtitle` (HubSpot returns only default properties unless asked,
while search requested it, so reconciliation and webhooks disagreed), and a
person created concurrently with its company could stay unlinked. See the
M6 record.

## Decision: reconciliation search

- **Allow-list** (transport guard, `http-client.ts`): exactly
  `^/crm/objects/2026-03/(contacts|companies)/search$`. No generic POST
  exception; no other object types or versions.
- **Request body** is validated by the guard before sending. Allowed keys
  only: `filterGroups`, `sorts`, `properties`, `limit`, `after`. Filters use
  `GTE` / `LTE` / `EQ` on the allowed modification property; `limit` 1–200;
  property names from a fixed allow-list. Anything else is refused as a
  non-read request.
- **Watermark**: per tenant and object kind, in HubSpot source time (the
  modification property above), never local time. Each run starts at
  `watermark − lookback` (10 minutes, search-index lag); the overlap is
  absorbed by idempotent apply. When a window reaches 10 000 results, the
  next window starts at the last processed timestamp (records at that exact
  timestamp are re-read, not skipped).
- **Rate**: a dedicated limiter keeps search at ≤ 3 requests/s per HubSpot
  account (documented burst limit 5/s; search responses carry no rate-limit
  headers).

## Lifecycle subscriptions (research)

Sources: HubSpot documentation via web search, 2026-10-01
([configure webhooks](https://developers.hubspot.com/docs/apps/developer-platform/add-features/configure-webhooks),
[working with webhooks](https://developers.hubspot.com/docs/platform/working-with-webhooks),
[generic webhook subscriptions](https://developers.hubspot.com/docs/guides/webhooks/create-generic-webhook-subscriptions),
[new subscription types](https://developers.hubspot.com/changelog/new-subscription-types-for-webhooks),
[webhooks v3 guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide)).

| Event                      | Objects used     | Identifiers                                                                                                                                                  | Scope (documented)                                        | M6                                                             |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------- |
| `object.deletion`          | contact, company | `objectId`, `objectTypeId`                                                                                                                                   | `crm.objects.contacts.read`, `crm.objects.companies.read` | yes                                                            |
| `object.restore`           | contact, company | `objectId`, `objectTypeId`                                                                                                                                   | object read scopes                                        | yes                                                            |
| `object.merge`             | contact, company | `primaryObjectId`, `mergedObjectIds[]`, `newObjectId`, `numberOfPropertiesMoved`, `objectTypeId`                                                             | object read scopes                                        | yes (company merge kept only if the CLI accepts it on upload)  |
| `object.associationChange` | contact, company | `fromObjectId`, `fromObjectTypeId`, `toObjectId`, `toObjectTypeId`, `associationTypeId`, `associationCategory`, `associationRemoved`, `isPrimaryAssociation` | object read scopes                                        | yes, contact↔company only; other pairs classified `irrelevant` |
| `contact.privacyDeletion`  | —                | —                                                                                                                                                            | —                                                         | **no**: out of scope for M6 (technical-debt item 15)           |

Documented caveats: association-change events fire for both sides of an
association; user-defined association labels are not covered by generic
subscriptions; deleted records can be restored within 90 days.

None of these subscriptions needs a new scope. The app renderer's exact
scope check (`oauth` + five CRM read scopes) is unchanged and must still
pass after the subscriptions are added; if HubSpot's upload asks for any
other scope, work stops and is reported.

## Consequences

- The only new HTTP method/path the connector may use is the exact search
  path above, with a validated read-only body.
- The app definition gains read-only lifecycle subscriptions; it must be
  re-uploaded to the test account (manual step by the owner).
- Privacy/GDPR erasure stays out of M6 (future privacy and data-retention
  ADR).
