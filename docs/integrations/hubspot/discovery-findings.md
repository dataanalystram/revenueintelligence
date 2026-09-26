# HubSpot discovery findings (Milestone 3)

Status legend:

- **Live**: observed against the developer test account on 2026-09-26 (see
  below).
- **Documented**: stated in HubSpot's documentation or changelog.
- **Reported**: community reports only, not authoritative.

## Live evidence (2026-09-26)

Run against the HubSpot developer test account with its read-only Service
Key, through the production path: tenant `hstest`, integration `read_only`,
token resolved via the SecretProvider, and `portalId` verified. Full report:
[discovery-report.json](discovery-report.json). It holds schema, counts and
record ids, no field values; it was checked not to contain the key.

| Check                | Result                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account              | `149338734`, type `DEVELOPER_TEST`, data hosting `eu1`. Matches `HUBSPOT_TEST_PORTAL_ID`; non-test accounts are refused                                                                                                                                                                                                                                                                           |
| Authentication       | Service Key accepted as a bearer token; an invalid token gets 401 (`pnpm test:live`)                                                                                                                                                                                                                                                                                                              |
| Contacts             | Readable: 6 read in 3 pages of 2 with HubSpot cursors (pagination verified, more pages exist); 402 properties, 0 custom                                                                                                                                                                                                                                                                           |
| Companies            | Readable: 6 read in 3 pages of 2 (pagination verified); 247 properties, 3 custom                                                                                                                                                                                                                                                                                                                  |
| Leads                | **Readable with real records**: 3 Leads (created by hand in the test account) read in 2 pages of 2 via HubSpot's cursor (pagination verified); 132 Lead properties                                                                                                                                                                                                                                |
| Schemas / properties | Readable for all three objects; the default properties the connector relies on exist (`email`, `firstname`, `lastname`, `jobtitle`, `name`, `domain`)                                                                                                                                                                                                                                             |
| Association labels   | Readable in all six directions (below)                                                                                                                                                                                                                                                                                                                                                            |
| Record associations  | Lead → Contact and Lead → Company: 3 of 3 Leads linked; each link carries a labelled and an unlabelled type (578 Primary + 608; 580 Primary + 610). Contact → Lead and Company → Lead read on exactly the linked contact and company: 3 associations each (579 + 609; 581 + 611); **all 3 forward links confirmed in reverse**. Contacts → Companies: 6 checked, 4 with (types 1, 279), 2 without |
| Missing scopes       | **None**: HubSpot returned no 403 for any call                                                                                                                                                                                                                                                                                                                                                    |
| 404                  | A non-existent contact id returns 404, mapped to "not found"                                                                                                                                                                                                                                                                                                                                      |
| Writes               | **None**: only `GET`, and `POST` to association batch **read**. The transport refuses anything else before sending                                                                                                                                                                                                                                                                                |
| Legacy (v1–v4) calls | **None**: every call used a date-based version (list below)                                                                                                                                                                                                                                                                                                                                       |

**Endpoints and versions actually used** (from the report's `endpointsUsed`):

```
GET  /account-info/2026-09/details
GET  /crm/objects/2026-09/{contacts,companies,leads}          (3 + 3 + 2 calls)
GET  /crm/properties/2026-09/{contacts,companies,leads}
GET  /crm/associations/2026-09/{leads,contacts,companies}/{…}/labels   (6 directions)
POST /crm/associations/2026-09/{leads→contacts, leads→companies, contacts→companies,
                                 contacts→leads, companies→leads}/batch/read
```

The live run changed two assumptions:

1. **The Account Information API answers at `2026-09`.** The connector first
   used `2026-03`, the latest version found in HubSpot's docs, and probed
   `2026-09`: both returned 200 (asserted by `pnpm test:live`, which reads account
   info at both versions and checks the portal id). The default is now `2026-09`, so all
   connector calls use the current version.
2. **A record with no associations is reported per record inside a 207.** It
   comes back as `OBJECT_NOT_FOUND` / `crm.associations.NO_ASSOCIATIONS_FOUND`
   with `context.fromObjectId`. The connector now reports these as "without
   associations" rather than as failures, and the fake reproduces the shape.

## Platform and API

| Finding                                                                                                                                                                                                                                                               | Status     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Date-based API versions: `2026-03` was the first, `2026-09` is GA since 8 Sep 2026. Each version gets 18 months of support; releases come in March and September.                                                                                                     | Documented |
| CRM paths: `/crm/objects/{v}/{type}`, `/crm/properties/{v}/{type}`, `/crm/associations/{v}/{from}/{to}/labels`                                                                                                                                                        | Documented |
| Record associations: `POST /crm/associations/{v}/{from}/{to}/batch/read` with `{inputs:[{id, after?}]}`, up to 500 associations per id per page                                                                                                                       | Documented |
| Account details: `/account-info/2026-09/details` (live; `2026-03` documented and also live, per `pnpm test:live`). `accountType` is one of `STANDARD`, `DEVELOPER_TEST`, `SANDBOX`, `APP_DEVELOPER`. `/account-info/v3/details` is legacy (end of support 1 Sep 2027) | Live       |
| Legacy apps and v1–v3 APIs go unsupported from September 2027                                                                                                                                                                                                         | Documented |
| From `2026-09`, admin-configured validation rules are enforced on CRM **writes** (relevant when writes are approved)                                                                                                                                                  | Documented |
| Exact 2026-09 paths and response shapes as the connector uses them                                                                                                                                                                                                    | Live       |

## Historical API usage vs the connector's endpoints

HubSpot's API-version export for the test account's Service Key
([evidence/service-key-api-versions-export.csv](evidence/service-key-api-versions-export.csv))
shows 14 older v3/v4 endpoints called before this connector existed. Eight of
them are **writes**: deletes, creates, batch upserts, property creation and
association writes. The v3 endpoints end support on 1 Sep 2027 and the v4 ones
on 1 Mar 2027.

| Historical call (export)                                                                | Kind  | Milestone 3 connector                                               |
| --------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| `GET /account-info/v3/details`                                                          | read  | `GET /account-info/2026-09/details`                                 |
| `GET /crm/v3/objects/companies`                                                         | read  | `GET /crm/objects/2026-09/companies` (and contacts, leads, `/{id}`) |
| `GET /crm/v3/properties/{objectType}/{propertyName}`                                    | read  | `GET /crm/properties/2026-09/{objectType}` (list)                   |
| `GET /crm/objects/v4/{contacts,deals}/{id}/associations/{toObjectType}`                 | read  | `POST /crm/associations/2026-09/{from}/{to}/batch/read`             |
| (none)                                                                                  | read  | `GET /crm/associations/2026-09/{from}/{to}/labels`                  |
| `POST /crm/v3/objects/{objectType}/search`                                              | read¹ | not used                                                            |
| `DELETE /crm/v3/objects/companies/{id}`                                                 | write | refused by the transport                                            |
| `POST /crm/v3/objects/companies`, `…/companies/batch/upsert`                            | write | refused                                                             |
| `POST /crm/v3/objects/contacts/batch/upsert`, `POST /crm/objects/v3/deals/batch/create` | write | refused                                                             |
| `POST /crm/v3/properties/{objectType}`                                                  | write | refused                                                             |
| `PUT /crm/objects/v4/{contacts,deals}/{id}/associations/default/{type}/{id}`            | write | refused                                                             |

¹ Search reads data, but through POST; the connector does not need it in M3.

How this is enforced, not just intended:

- The transport refuses every non-date-versioned path (`unsupported_endpoint`)
  and every method or path outside the read allow-list
  (`read_only_violation`), before a request is sent.
- A unit test sends each export endpoint, plus the same writes on `2026-09`
  paths, and asserts each is refused with no request made.
- With the date-version guard removed, the five legacy GET reads from the
  export get through and fail the test (mutation U8).
- Discovery reports `endpointsUsed`: every method and path it called, with
  ids templated. The live report (above) confirms that only these date-based
  reads were made.

**No v3/v4 endpoint is used by Milestone 3.** The one former v3 dependency
(account details) moved to the date-based Account Information API.

## Does the test environment expose the Lead object?

- **Live: yes, with real records.** Three test Leads were created by hand in
  the HubSpot UI; the connector never writes. The read-only Service Key read
  all three through the production path, in 2 pages of 2 using HubSpot's
  cursor, plus 132 Lead properties. The report holds their ids only: no Lead
  names or other field values.
- **Documented:** Leads (`0-136`, path `leads`) require **Sales Hub
  Professional or Enterprise**. The developer test account's Enterprise trial
  provides them.
- **Juniper dependency:** Juniper's own account must have Sales Hub Pro or
  Enterprise for the Leads-based design. To be confirmed with Juniper (M16).

## Lead ↔ Contact ↔ Company associations

**Live** (association labels endpoint, all HubSpot-defined):

| From → to         | Type ids and labels                                                                   |
| ----------------- | ------------------------------------------------------------------------------------- |
| Lead → Contact    | **578** Primary, **608** (unlabelled)                                                 |
| Contact → Lead    | **579** "Lead with Primary Contact", **609** (unlabelled)                             |
| Lead → Company    | **580** Primary, **610** (unlabelled)                                                 |
| Company → Lead    | **581** "Lead with Primary Company", **611** (unlabelled)                             |
| Contact → Company | **1** Primary, **279** (unlabelled), **931** "Billing Contact"                        |
| Company → Contact | **2** "Contact with Primary Company", **280** (unlabelled), **930** "Billing Contact" |

- **Documented:** a Lead must be associated with an existing Contact, and
  can be associated with Companies. The live types confirm primary and
  unlabelled associations in both directions.
- **Live, record level:**
  - All 3 Leads are linked to a Contact and to a Company. Each link carries
    two types at once: the labelled type and its unlabelled companion
    (578 Primary + 608 to the contact; 580 Primary + 610 to the company).
  - Reading in reverse, on exactly that contact and that company, returns the
    same 3 Leads, again with both types (579 "Lead with Primary Contact" +
    609; 581 "Lead with Primary Company" + 611). 3 of 3 forward links are
    confirmed in reverse.
  - Real Contact → Company associations were also read (types 1 and 279).
  - Consequence for later milestones: code that interprets a link must look
    for the type it needs among all of the link's types, not assume one.
- **Juniper dependency:** custom (user-defined) association labels are
  subscription-dependent. Juniper's labels, if any, appear in their
  discovery run (M16).

## Lead create/update webhooks on the current app model

- **Documented:** webhook subscriptions are configured on the app. In the
  current developer platform they live in the project's webhook configuration.
  HubSpot's webhook guide lists contacts, companies, deals, tickets, products,
  line items and conversations as supported objects. Leads are not in that
  list.
- **Reported:** a HubSpot Community thread describes a project webhook with an
  `object.creation` subscription for leads that **did not fire**.
- **Conclusion: not confirmed.** Lead creation and update webhooks are not
  reliably supported. M5 must test a lead subscription on the test account.
  Until one is proven, the design must not depend on lead webhooks. The
  fallbacks are:
  - Contact and Company webhooks, plus reading the associated Leads
  - or incremental polling of Leads by last-modified date
  - or HubSpot workflow webhooks configured in Juniper's account
- A read-only discovery cannot answer this: creating a subscription and a
  test Lead are writes to the test account, which belong to M5.

## Scopes Juniper will eventually need

| Scope                         | Purpose                                      | Milestone | Status                                               |
| ----------------------------- | -------------------------------------------- | --------- | ---------------------------------------------------- |
| `crm.objects.contacts.read`   | Read contacts                                | M3, M16   | Documented                                           |
| `crm.objects.companies.read`  | Read companies                               | M3, M16   | Documented                                           |
| `crm.objects.leads.read`      | Read leads                                   | M3, M16   | Documented                                           |
| `crm.schemas.contacts.read`   | Contact properties                           | M3, M16   | Documented                                           |
| `crm.schemas.companies.read`  | Company properties                           | M3, M16   | Documented                                           |
| `crm.schemas.leads.read`      | Lead properties                              | M3, M16   | Live: Lead properties readable with the key's scopes |
| `crm.objects.owners.read`     | Map HubSpot owners for routing/SLA           | M14, M16  | Documented; not requested yet                        |
| `crm.objects.leads.write`     | Create intelligence-sourced Leads (ADR 0006) | M16+      | Needs explicit production-write approval             |
| `crm.objects.contacts.write`  | Write back status/outcome fields             | M19       | Needs explicit approval                              |
| `crm.objects.companies.write` | Write back account-level outcomes            | M19       | Needs explicit approval                              |

The M3 Service Key has only read scopes: HubSpot reported **no missing scope**
for any call in the live run. HubSpot does not expose a key's granted scopes
through these APIs; the scopes above are the ones the calls require. Write
scopes are listed so Juniper can plan, not requested.

## What may depend on Juniper's subscription

| Area               | Dependency                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Leads object       | Sales Hub Professional or Enterprise                                                                         |
| API rate limits    | Burst limit per 10 s and daily limit vary by tier and app type (documented range: 100–190 requests per 10 s) |
| Association labels | Custom labels depend on tier                                                                                 |
| Custom objects     | Enterprise only                                                                                              |
| Sandboxes          | Standard sandbox accounts need Enterprise                                                                    |
| Data hosting       | EU or NA hosting is reported in `dataHostingLocation`; the API host stays `api.hubapi.com`                   |
| Write validation   | Admin-configured validation rules apply to writes from `2026-09`                                             |

The connector's defaults stay below the lowest documented burst limit
(`HUBSPOT_REQUESTS_PER_10S=90`). The value must be confirmed against Juniper's
tier.

## Sources

- HubSpot changelog: [Fall 2026 Spotlight](https://developers.hubspot.com/changelog/fall-2026-spotlight),
  [Introducing date-based API versioning](https://developers.hubspot.com/changelog/introducing-date-based-api-versioning),
  [CRM API write validation enforcement](https://developers.hubspot.com/changelog/crm-api-write-validation-enforcement),
  [Legacy APIs and apps: what's going unsupported and when](https://developers.hubspot.com/changelog/legacy-apis-and-legacy-apps-whats-going-unsupported-and-when)
- HubSpot docs: [2026-09 API reference](https://developers.hubspot.com/docs/api-reference/latest/overview),
  [Leads API](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/leads/guide),
  [Associate records](https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide),
  [Webhooks guide](https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide),
  [Authentication overview](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview),
  [Service keys](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys),
  [Account information API](https://developers.hubspot.com/docs/api-reference/latest/account/account-information/guide),
  [Account types](https://developers.hubspot.com/docs/getting-started/account-types)
- HubSpot Community: [Project webhook for leads creation not triggering](https://community.hubspot.com/t5/APIs-Integrations/Project-webhook-for-leads-creation-not-triggering/m-p/1241645),
  [Lead to primary company association](https://community.hubspot.com/t5/CRM/Lead-to-Primary-Company-Association-Creating-leads-via-the-API/m-p/1065159)

The HubSpot documentation host is blocked by this environment's network
policy. Documented findings were gathered through web search result summaries;
the live section above is first-hand.
