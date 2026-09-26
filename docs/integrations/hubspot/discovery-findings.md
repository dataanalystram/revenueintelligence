# HubSpot discovery findings (Milestone 3)

Status legend:

- **Documented**: stated in HubSpot's documentation or changelog.
- **Reported**: community reports only, not authoritative.
- **Pending live**: to be confirmed by `hubspot:discover` against the
  developer test account, which is blocked on the test-account token and
  network access (see setup.md).

No finding here comes from a live HubSpot account yet. The connector's
behaviour is proven against a local fake that reproduces HubSpot's documented
shapes. That proves our handling, not HubSpot's behaviour.

## Platform and API

| Finding                                                                                                                                                           | Status       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Date-based API versions: `2026-03` was the first, `2026-09` is GA since 8 Sep 2026. Each version gets 18 months of support; releases come in March and September. | Documented   |
| CRM paths: `/crm/objects/{v}/{type}`, `/crm/properties/{v}/{type}`, `/crm/associations/{v}/{from}/{to}/labels`                                                    | Documented   |
| Record associations: `POST /crm/associations/{v}/{from}/{to}/batch/read` with `{inputs:[{id, after?}]}`, up to 500 associations per id per page                   | Documented   |
| Account details: `/account-info/v3/details`; `accountType` is one of `STANDARD`, `DEVELOPER_TEST`, `SANDBOX`, `APP_DEVELOPER`                                     | Documented   |
| Legacy apps and v1–v3 APIs go unsupported from September 2027                                                                                                     | Documented   |
| From `2026-09`, admin-configured validation rules are enforced on CRM **writes** (relevant when writes are approved)                                              | Documented   |
| Exact 2026-09 paths and response shapes as the connector uses them                                                                                                | Pending live |

## Does the test environment expose the Lead object?

- **Documented:** Leads (`0-136`, path `leads`) require **Sales Hub
  Professional or Enterprise**. A developer test account includes a 90-day
  Sales Hub Enterprise trial, so Leads should be available there.
- **Pending live:** discovery reports `leadObject.available` and, if not
  available, the exact cause:
  - `missing_scopes`, with the scope HubSpot requires, or
  - `forbidden`/`not_found`, meaning the Leads object is not in the account's
    subscription.
- **Juniper dependency:** Juniper's own account must have Sales Hub Pro or
  Enterprise for the Leads-based design. To be confirmed with Juniper (M16).

## Lead ↔ Contact ↔ Company associations

- **Documented:** a Lead must be associated with an existing Contact, and
  can be associated with Companies.
- **Reported** (HubSpot Community, output of the labels endpoint):
  lead-to-company types are `lead_to_primary_company` (type id **580**) and
  `lead_to_company` (**610**).
- **Documented:** Contact → Company uses type **1** (Primary) and **279**
  (unlabelled).
- **Pending live:** discovery lists every association type in both directions
  (lead↔contact, lead↔company, contact↔company) and samples real records. The
  lead-to-contact type id is not yet confirmed; the fake uses an illustrative
  placeholder.
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

| Scope                         | Purpose                                      | Milestone | Status                                         |
| ----------------------------- | -------------------------------------------- | --------- | ---------------------------------------------- |
| `crm.objects.contacts.read`   | Read contacts                                | M3, M16   | Documented                                     |
| `crm.objects.companies.read`  | Read companies                               | M3, M16   | Documented                                     |
| `crm.objects.leads.read`      | Read leads                                   | M3, M16   | Documented                                     |
| `crm.schemas.contacts.read`   | Contact properties                           | M3, M16   | Documented                                     |
| `crm.schemas.companies.read`  | Company properties                           | M3, M16   | Documented                                     |
| `crm.schemas.leads.read`      | Lead properties                              | M3, M16   | Pending live (discovery reports the real name) |
| `crm.objects.owners.read`     | Map HubSpot owners for routing/SLA           | M14, M16  | Documented; not requested yet                  |
| `crm.objects.leads.write`     | Create intelligence-sourced Leads (ADR 0006) | M16+      | Needs explicit production-write approval       |
| `crm.objects.contacts.write`  | Write back status/outcome fields             | M19       | Needs explicit approval                        |
| `crm.objects.companies.write` | Write back account-level outcomes            | M19       | Needs explicit approval                        |

The M3 app gets only the read scopes. Write scopes are listed so Juniper can
plan, not requested.

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
  [Account types](https://developers.hubspot.com/docs/getting-started/account-types)
- HubSpot Community: [Project webhook for leads creation not triggering](https://community.hubspot.com/t5/APIs-Integrations/Project-webhook-for-leads-creation-not-triggering/m-p/1241645),
  [Lead to primary company association](https://community.hubspot.com/t5/CRM/Lead-to-Primary-Company-Association-Creating-leads-via-the-API/m-p/1065159)

The HubSpot documentation host is blocked by this environment's network
policy. Findings were gathered through web search result summaries and should
be re-read at the source when access allows.
