# Milestone 9B — Chargebee reference adapter (detailed plan, for review)

- Status: **PLANNING ONLY — revision 2** (independent plan review: `PASS WITH REQUIRED PLAN CHANGES —
IMPLEMENTATION MUST WAIT`; no architectural redesign). No Chargebee code, no migrations, no fixtures, no
  production-code change. M9B implementation has **not** started.
- Revision 2 changes: timestamp units promoted to documented evidence (F18; V1 resolved), the documented GET
  concurrency limit added (F16, §20), scenarios CB35 (parent structurally rejected) and CB36 (repeated pagination
  offset) with tests and mutations C21–C22, non-progress detection in pagination (§17). B1–B11 and every approved
  design choice are unchanged.
- **Revision 3 — approved correction from the live gate (owner approval, 2026-10-08).** The TEST site showed that
  Chargebee **reuses a deleted subscription's id**, so a list with `include_deleted=true` can hold two records with
  one id (V5/V7). Approved change: Chargebee subscriptions and customers are read **live records only**
  (`include_deleted` is never sent; a `deleted: true` entry is dropped by the adapter). `deleted: true` is no longer
  deletion evidence for Chargebee. A deleted subscription is absent and is retired only by the next **accepted full
  run** under §18 (double enumeration passed + operator acceptance + M9A protections); G4 keeps retiring removed
  children of observed parents; all seen-but-rejected and failure protections are unchanged. Superseded below:
  §17 pass 1 `include_deleted=true`; §18 "Explicit deletion" (for Chargebee); §19 rows for deleted
  customer/subscription; G5 for Chargebee (`deleteVisibility: none`); CB20/CB21 expected results; C17 (now: the
  live-only filter removed / `include_deleted` requested again). Recorded in the
  [M9B record](M09B-chargebee-reference-adapter.md#approved-correction-live-records-only).
- **Revision 4 — governed customer source-reference retirement (owner approval after live M08, 2026-10-09).**
  Supersedes Revision 3's "customer references are never retired from absence". A Chargebee customer reference
  absent from a successful, double-enumerated and operator-accepted full read becomes `retired` (explicit
  reference state; row kept; retiring run recorded); the canonical company is never deleted, changed or made
  inactive; no whitespace follows; incremental, partial, failed, unstable or unaccepted runs and seen-but-rejected
  customers never retire; line retirement stays separate (§18, G4). One additional migration
  (`20261116120000_m9b_reference_retirement`, with down-script) — a deviation from "one M9B migration", approved
  with this change. Recorded in the
  [M9B record](M09B-chargebee-reference-adapter.md#governed-correction-customer-source-reference-retirement).
- Predecessors: [M9 master plan](M09-multi-source-data-quality-plan.md) §10 (approved; this plan refines it with
  API evidence), [M9A record](M09A-source-data-profiling.md) (**CLOSED**: merge `dfcb352`, closure record
  `a8c61ee`).
- **LIVE SUGAR VERIFICATION: PENDING.** **LIVE CHARGEBEE VERIFICATION: NOT STARTED** (a status of its own).
- Out of scope: S3/file (M9C), warehouse (M9D), signals, opportunities, cross-source line matching.

## 0. Summary of recommendations

| Question                 | Recommendation                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical shape          | Customer → Account; **Item → Product** (through governed Product Model `externalRefs`); **subscription item → subscription line**. Item price stays source pricing context. No canonical change, no vendor field.                                                                                                                                                            |
| Product identity (§6)    | **Item**, not item price, not a composite. Monthly/annual, currency and price-variant prices of one item are one product.                                                                                                                                                                                                                                                    |
| Line identity (§7)       | Chargebee has **no subscription-item identifier**. Recommended: `<subscription_id>:<item_id>` (stable across price, period, currency and quantity changes), **conditional** on test-site proof that an item appears at most once per subscription; otherwise fall back to `<subscription_id>:<item_price_id>`. A repeated key always fails closed (`duplicate_external_id`). |
| Status map (§8)          | `active→active`, `in_trial→trial`, `non_renewing→active`, `cancelled→cancelled`; `future`, `paused`, `transferred` and anything else → `unknown`. Chargebee has no `expired` status; M9B never produces `expired` and never infers state from dates. Lives in the versioned mapping's value map, not in code.                                                                |
| Terms (§9)               | `startsAt ← current_term_start`, `endsAt ← current_term_end` (Unix seconds, generic `unix_seconds` parse format). Trial, cancellation, next-billing, pause and activation dates are profiled and declared `ignored` (never collapsed into one "renewal date").                                                                                                               |
| Completeness proof (§12) | The list API returns **no total count** and has **no count endpoint**; exports carry no row count. Proof method: **`double_enumeration` → `stable_snapshot`**. Never `externally_grounded`.                                                                                                                                                                                  |
| Authority (§13)          | Chargebee may hold `subscription_lines` + `subscription_state` + `subscription_terms` **together**, per tenant, only with an accepted `stable_snapshot` proof (`proof_acceptances`). No split with Sugar. Default for the TEST tenant: Chargebee holds nothing until the live gate passes.                                                                                   |
| Tombstones (§18)         | Full runs: only after a passed double enumeration **and** an operator acceptance for the connection, under all M9A protections. Explicit `deleted=true` records are deletion evidence on any run. Incremental runs: **parent-scoped child reconciliation** (new generic capability, decision B4) so a removed add-on does not stay "owned" until the next full run.          |
| Cross-source matching    | **Deferred** (no shared immutable key exists; heuristics forbidden).                                                                                                                                                                                                                                                                                                         |

## 1. Evidence base (exact sources)

**Network note.** This environment's network policy blocks `chargebee.com` and its subdomains (`apidocs.chargebee.com`,
`api-static-site.chargebee.com`: proxy CONNECT refused, 403). The evidence below therefore comes from:

1. **Chargebee's official Node SDK `chargebee@3.34.0`** from the npm registry (published by Chargebee,
   `repository: github.com/chargebee/chargebee-node`, modified 2026-09-24). Its TypeScript resource types are
   generated from Chargebee's API specification. Read as data in an isolated scratch directory; nothing was
   executed. Files: `types/resources/{Subscription,Item,ItemPrice,Customer,Export,Event}.d.ts`,
   `cjs/environment.js`, `cjs/RequestWrapper.js`. Marked **[SDK]**.
2. **Official Chargebee documentation pages, read through web-search extracts** (the pages themselves could not be
   opened here): List subscriptions (`apidocs.chargebee.com/docs/api/subscriptions/list-subscriptions`, API v2,
   Product Catalog 2.0), List operations (`apidocs.chargebee.com/docs/api/list-ops`), Delete a subscription,
   Cancel a subscription, API keys (`chargebee.com/docs/billing/2.0/site-configuration/api_keys`), API limits
   (`chargebee.com/docs/billing/2.0/kb/platform/what-are-the-chargebee-api-limits`), subscription statuses
   (`chargebee.com/docs/billing/1.0/subscriptions/subscriptions`), Product Catalog 2.0
   (`chargebee.com/docs/billing/2.0/product-catalog/product-catalog`), Error handling and rate limits
   (`apidocs.chargebee.com/docs/api/error-handling`), Getting started (`apidocs.chargebee.com/docs/api/getting-started`,
   regional mirror `apidocs.au.chargebee.com/docs/api/getting-started.md`), the Events reference
   (`apidocs.chargebee.com/docs/api/events`) and the knowledge-base article "Error: should be in valid date format
   via API" (`chargebee.com/docs/billing/2.0/kb/getting-started/error-should-be-in-valid-date-format-via-api`).
   Marked **[DOCS]**.
3. Anything else is marked **[VERIFY]**: it must be proven on a Chargebee test site (§20) before code relies on
   it, and the fake must be corrected to match.

**API version used throughout: Chargebee API v2** (`https://<site>.chargebee.com/api/v2`, [SDK]
`environment.js`: `hostSuffix '.chargebee.com'`, `apiPath '/api/v2'`), **Product Catalog 2.0** (items and item
prices). Before implementation, the owner should allow `apidocs.chargebee.com` in the environment's network
settings, so the implementer can re-check this list against the live reference (decision B10).

## 2. Verified API facts

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| F1  | Auth is HTTP Basic with the API key as the username and an empty password.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | [SDK] `RequestWrapper.js`: `'Basic ' + base64(apiKey + ':')`                                                                  |
| F2  | API key types: full-access, publishable, **read-only** (sub-types _All_ and _Restricted_; Restricted can grant read on transactional data — Subscriptions, Customers, Events… — and on the product catalog — Item Families, Items, Item Prices). Test and live keys are separate. A key's rights cannot be changed after creation.                                                                                                                                                                                                                                                                                                                                                                                                           | [DOCS] API keys                                                                                                               |
| F3  | `GET /api/v2/subscriptions` returns `{ list: [{ subscription, customer, card? }], next_offset? }`. **No total count.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | [SDK] `Subscription.ListResponse`                                                                                             |
| F4  | List params: `limit` (1–100, default 10), `offset` (= previous `next_offset`, an opaque string), `include_deleted` (default false), filters (`status`, `customer_id`, `item_id`, `item_price_id`, `created_at`, `updated_at`, `cancelled_at`, `next_billing_at`, `business_entity_id`, …), `sort_by[asc                                                                                                                                                                                                                                                                                                                                                                                                                                      | desc]`with attribute`created_at`or`updated_at`; default order `created_at` ascending.                                         | [SDK] `ListInputParam`; [DOCS] List subscriptions |
| F5  | List operations are **eventually consistent**; a list may not reflect a recent write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [DOCS] List subscriptions / list ops                                                                                          |
| F6  | Subscription `status`: `future`, `in_trial`, `active`, `non_renewing`, `paused`, `cancelled`, `transferred` (the last tied to Multiple Business Entities). There is **no `expired` status**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [SDK] `Subscription.status`; [DOCS] statuses                                                                                  |
| F7  | Subscription fields used here: `id`, `customer_id`, `status`, `start_date`, `trial_start`, `trial_end`, `current_term_start`, `current_term_end`, `next_billing_at`, `started_at`, `activated_at`, `cancelled_at`, `cancel_reason`, `pause_date`, `resume_date`, `created_at`, `updated_at`, `resource_version`, `deleted`, `decommissioned`, `business_entity_id`, `contract_term`, `subscription_items[]`. Timestamps are numbers.                                                                                                                                                                                                                                                                                                         | [SDK] `Subscription`                                                                                                          |
| F8  | `subscription_items[]` entries have **no identifier of their own**: `item_price_id`, `item_type` (`plan`/`addon`/`charge`), `quantity`, `quantity_in_decimal`, `unit_price`, `amount`, `current_term_start/end`, `next_billing_at`, `billing_period(_unit)`, `trial_end`, `billing_cycles`, `charge_once`, `charge_on_event`, … **No `item_id`.**                                                                                                                                                                                                                                                                                                                                                                                            | [SDK] `Subscription.SubscriptionItem`                                                                                         |
| F9  | A subscription has exactly one `plan` item and any number of `addon`/`charge` items.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [DOCS] data catalog `subscription_items`; [VERIFY] repeats                                                                    |
| F10 | `Item`: `id`, `name`, `type` (`plan`/`addon`/`charge`), `status` (`active`/`archived`/`deleted`), `item_family_id`, `updated_at`, `resource_version`, `deleted`, `metered`, `archived_at`, `business_entity_id`. List filters include `status`, `type`, `updated_at`; **no `include_deleted` parameter**.                                                                                                                                                                                                                                                                                                                                                                                                                                    | [SDK] `Item`                                                                                                                  |
| F11 | `ItemPrice`: `id`, `item_id`, `item_family_id`, `item_type`, `status`, `currency_code`, `period`, `period_unit`, `price_variant_id`, `pricing_model`, `price`, `created_at`, `updated_at`, `deleted`. List filters include `item_id`, `currency_code`, `period_unit`, `price_variant_id`, `status`, `updated_at`.                                                                                                                                                                                                                                                                                                                                                                                                                            | [SDK] `ItemPrice`                                                                                                             |
| F12 | `Customer`: `id`, `first_name`, `last_name`, `email`, `phone`, `company`, `created_at`, `updated_at`, `resource_version`, `deleted`, `business_entity_id`, `meta_data`, custom fields `cf_*`. List supports `include_deleted`, `updated_at`, `sort_by`. **No standard external-reference field.**                                                                                                                                                                                                                                                                                                                                                                                                                                            | [SDK] `Customer`                                                                                                              |
| F13 | Deleting a subscription is permanent (scheduled, completed "after a few minutes"), deletes its invoices and changes reports; deleted records remain listable with `include_deleted=true` (`deleted: true`). Cancelling keeps the record (`status = cancelled`). Retention of deleted records for listing is **undocumented** [VERIFY].                                                                                                                                                                                                                                                                                                                                                                                                       | [DOCS] Delete / Cancel a subscription, restore article                                                                        |
| F14 | Exports (`/exports/...`) are asynchronous jobs (`status: in_process/completed/failed`) producing a download; the export object carries **no row count or manifest**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [SDK] `Export`                                                                                                                |
| F15 | Events exist for `subscription_deleted`, `subscription_cancelled`, `subscription_changed`, `subscription_renewed`, `subscription_paused`, `subscription_resumed`, `subscription_reactivated`, `customer_deleted`, `item_deleted`, `item_price_deleted`; `GET /events` filters by `occurred_at` and `event_type`.                                                                                                                                                                                                                                                                                                                                                                                                                             | [SDK] `core.d.ts`, `Event`                                                                                                    |
| F16 | Rate limits: test site **150 requests/minute**; live sites by plan (Starter 150, Performance 1000, Enterprise 3500 per minute). **Concurrent-request limit: 50 GET requests (100 POST) in flight at any instant.** Breaching either the per-minute or the concurrency limit returns **429**. On a test site, all requests are blocked until traffic falls back within limits. On a live site the account is flagged and GETs may be blocked.                                                                                                                                                                                                                                                                                                 | [DOCS] API limits; Error handling and rate limits (concurrency 50 GET / 100 POST)                                             |
| F17 | The official SDK retries 429 using `Retry-After` and retries 500/502/503/504 with exponential backoff (opt-in).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [SDK] `RequestWrapper.js` (behavioural hint, not a contract)                                                                  |
| F18 | **Chargebee API timestamps used by M9B are Unix epoch timestamps in UTC seconds** (`created_at`, `updated_at`, `start_date`, `started_at`, `activated_at`, `trial_start`, `trial_end`, `current_term_start`, `current_term_end`, `next_billing_at`, `cancelled_at`, `pause_date`, `resume_date`, `archived_at`, and the `created_at`/`updated_at` list filters). The API reference types these as "timestamp(UTC) in seconds"; the Getting started guide states that all timestamps are Unix epoch seconds; a millisecond value or a date string is rejected ("should be in valid date format"). **Exception:** `resource_version` is a millisecond timestamp. M9B never uses it as a time or a filter, only as a per-record ordering value. | [DOCS] Getting started; Subscriptions and Events reference ("timestamp(UTC) in seconds"); KB "should be in valid date format" |

**Verification items** (each test-site item blocks the code path that depends on it; none is resolved by
assumption):

| #   | Item                                                                                                                               | Status                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| V1  | Timestamp units                                                                                                                    | **Resolved by documentation (F18)**: UTC Unix seconds; not a live-gate item |
| V2  | `next_offset` behaviour: a continuation token stable for a fixed filter and sort, never repeating (cursor vs positional semantics) | Test site                                                                   |
| V3  | Whether the same item, or the same item price, can appear twice in one subscription                                                | Test site                                                                   |
| V4  | `current_term_end` of a cancelled and of a `non_renewing` subscription                                                             | Test site                                                                   |
| V5  | `include_deleted` retention window for deleted records                                                                             | Test site                                                                   |
| V6  | Whether Item / ItemPrice lists return `status=deleted` records                                                                     | Test site                                                                   |
| V7  | Id immutability and length limits (and the `:` separator)                                                                          | Test site                                                                   |
| V8  | Read-only _Restricted_ key behaviour on every endpoint used (including the 403 shape)                                              | Test site                                                                   |
| V9  | Eventual-consistency lag observed on list endpoints                                                                                | Test site                                                                   |
| V10 | Meaning and behaviour of the `decommissioned` flag                                                                                 | Test site                                                                   |
| V11 | Product Catalog 1.0 detection                                                                                                      | Test site                                                                   |
| V12 | Whether a subscription-item change moves the parent subscription's `updated_at`                                                    | Test site                                                                   |

## 3. Architecture (generic platform, Chargebee at the edge)

**Unchanged:** canonical Subscription (`state`, `startsAt`, `endsAt`, `quantity`), Account, Product Model, ADR 0017
ownership/eligibility, M8 authority, M9A profiling and coverage tiers. No `chargebee_*` field anywhere outside the
adapter module and provenance.

**New, adapter-local** (`apps/api/src/modules/chargebee/`):

- the adapter;
- Zod boundary schemas;
- a GET-only transport with an endpoint allowlist;
- flattening of `subscription_items` into the derived object;
- the item-price → item lookup;
- rate limiting.

**Generic additions M9B needs** (source-neutral, each with tests and mutation proofs; implementation-time, after
plan approval):

| G#  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| G1  | Connector-kind entry `chargebee` (`versioned`, external references, adapter) and its seed migration (one `INSERT` into `connector_kinds`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | ADR 0019 rule for a new kind. The **only** migration M9B needs.                                       |
| G2  | **Double-enumeration full-read proof** in the generic sync: today `countOrRefuse` refuses any line object without `count` and the proof is hard-coded to `count` (`source-sync.service.ts`). Objects declaring `fullReadProof: 'double_enumeration'` run the §12 algorithm and record `runProof('double_enumeration')` (tier `stable_snapshot` from `TIER_OF`, already present).                                                                                                                                                                                                                                                   | Chargebee has no count (F3, F14).                                                                     |
| G3  | Generic date transform format **`unix_seconds`** (integer seconds → instant; range-checked 2000-01-01..2100-01-01, else `invalid_date` rejection). Profiling: the covering-profile date rule accepts an integer field mapped with `unix_seconds` when the profile shows integers only (otherwise `date_format_required`).                                                                                                                                                                                                                                                                                                          | Today only `iso_date`/`iso_datetime` exist.                                                           |
| G4  | **Parent-scoped child reconciliation** (decision B4): a derived object may declare `childOf: { object, parentKeyField, completeChildSet: true }`. When a run observes a parent record (accepted, not deleted), active lines of that parent whose keys are absent from the observed child set become `absent` (tombstone), unless any child of that parent was rejected (then the parent's lines are protected and get a gap). A parent that is itself rejected, for any reason (structural, mapping, validation, not only account/product lookup), **never** triggers reconciliation: its existing children stay protected (CB35). | Incremental runs never tombstone; without G4 a removed add-on stays an "owned" line until a full run. |
| G5  | `ObjectCapabilities.deleteVisibility: 'flag'` honoured on full and incremental reads (already modelled; the engine maps `deleted` → `absent`); the adapter passes `include_deleted=true` only where declared.                                                                                                                                                                                                                                                                                                                                                                                                                      | Explicit deletion evidence (F13).                                                                     |

## 4. Source objects (port declaration)

The adapter declares five objects. Nested Chargebee JSON never leaves the adapter. Every value is a scalar.
Undeclared fields are dropped at the boundary (minimisation, M9 §10.8). `card` objects in list responses are
discarded unread (F3).

| Object              | Class                | Source                                                | Identity       | Capabilities (declared)                                                                                                                                                        | Fields (scalar)                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | -------------------- | ----------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Customers`         | record               | `GET /customers`                                      | `id`           | `pagination: cursor`, `changeField: updated_at`, `deleteVisibility: flag`, `count: false`, `maxPageSize: 100`                                                                  | `id`, `company`, `created_at`, `updated_at`, `resource_version`, `deleted`, `business_entity_id`; optional operator-declared reference fields `cf_*` (decision B6). **Not declared:** names, email, phone, addresses, payment data.                                                                                                                                                                       |
| `Items`             | reference            | `GET /items`                                          | `id`           | `cursor`, `updated_at`, `deleteVisibility: none` until V6 proves otherwise                                                                                                     | `id`, `name`, `type`, `status`, `item_family_id`, `metered`, `updated_at`, `archived_at`                                                                                                                                                                                                                                                                                                                  |
| `ItemPrices`        | reference            | `GET /item_prices`                                    | `id`           | as `Items`                                                                                                                                                                     | `id`, `item_id`, `item_type`, `status`, `currency_code`, `period`, `period_unit`, `price_variant_id`, `pricing_model`, `updated_at`                                                                                                                                                                                                                                                                       |
| `Subscriptions`     | record               | `GET /subscriptions`                                  | `id`           | `cursor`, `updated_at`, `flag`; **not mapped to a canonical entity** (profiling and parent only)                                                                               | `id`, `customer_id`, `status`, `start_date`, `started_at`, `activated_at`, `trial_start`, `trial_end`, `current_term_start`, `current_term_end`, `next_billing_at`, `cancelled_at`, `cancel_reason`, `pause_date`, `resume_date`, `created_at`, `updated_at`, `resource_version`, `deleted`, `decommissioned`, `business_entity_id`, `item_count` (derived)                                               |
| `SubscriptionItems` | record (**derived**) | flattened from `subscriptions[].subscription_items[]` | `line_id` (§7) | `cursor` (the parent's), `updated_at` (the parent's), `flag` (the parent's `deleted`), `childOf: Subscriptions.subscription_id` (G4), `fullReadProof: double_enumeration` (G2) | `line_id`, `subscription_id`, `customer_id`, `item_price_id`, `item_id` (resolved through `ItemPrices`; null when unknown), `item_type`, `quantity`, `quantity_in_decimal`, `item_current_term_start`, `item_current_term_end`, and parent fields denormalised: `status`, `current_term_start`, `current_term_end`, `started_at`, `cancelled_at`, `trial_end`, `next_billing_at`, `updated_at`, `deleted` |

- **Why `item_id` is resolved by the adapter.**
  - Subscription items carry only `item_price_id` (F8).
  - The lookup is a pure join on Chargebee's own catalogue: `ItemPrices.item_id`. It is read in the
    catalogue phase of every run and held in memory for that run.
  - It is not business logic. An unknown item price yields `item_id = null`, the line is rejected
    `missing_product_reference`, and the M9A seen-but-rejected protection plus a gap apply.
- **Prices and amounts are not declared** (`unit_price`, `amount`, `mrr`, `arr`). They are pricing and financial
  context with no canonical target, and minimisation applies. They can be added later only with a reason.

## 5. Canonical mapping hypothesis (reviewed)

| Chargebee         | Canonical                                                                                | Verdict                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Customer          | Account (company external ref `chargebee/Customers/<id>`)                                | **Holds.** Identity is Chargebee's customer id; no claim that it equals a CRM id (§14).                               |
| Item              | Product (via Product Model `externalRefs`: `{system: chargebee, objectType: Items, id}`) | **Holds** (§6).                                                                                                       |
| Item price        | — (pricing context: currency, period, variant)                                           | **Not a product.** Profiled; used only to resolve `item_id`.                                                          |
| Subscription      | — (parent of lines)                                                                      | **Not a line.** One subscription with a plan and two add-ons is three product lines (ADR 0017: one product per line). |
| Subscription item | Subscription line                                                                        | **Holds**, with the identity of §7.                                                                                   |
| Item family       | — (grouping)                                                                             | Not mapped. A future product-grouping signal, not identity.                                                           |

Vendor-native ids (`subscription_id`, `item_price_id`, `customer_id`) appear only as source record ids (provenance:
`{system, objectType, recordId}`) and in profiles. They never appear as canonical fields.

## 6. Product identity decision (CRITICAL)

**Recommendation: canonical Product identity = Chargebee Item** (`Items.id`, mapped explicitly in the governed
Product Model). Not Item Price, not a composite.

**Evidence:**

- Product Catalog 2.0 moved currency and billing frequency **into prices of one plan** ("define a single plan and
  build multiple price points with currencies and billing frequencies"; [DOCS] Product Catalog 2.0). An item
  price is therefore a price point of a product, not a product.
- An item price carries `item_id`, `currency_code`, `period`/`period_unit` and `price_variant_id` (F11). These
  are exactly the dimensions that must not split a product.

**Business consequences:**

| Case                                             | With Item identity                                                                                              | With Item-price identity (rejected)                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Monthly vs annual price of "Pro"                 | One product "Pro"; ownership unchanged by billing frequency                                                     | Two products; a customer moving monthly→annual "loses" one and "gains" another |
| USD/EUR/GBP prices                               | One product                                                                                                     | One product per currency                                                       |
| Price variants (`price_variant_id`, segment/geo) | One product                                                                                                     | One product per variant                                                        |
| Legacy/archived price points                     | Still the same product; archived prices keep resolving                                                          | Legacy price = separate product that nobody can buy any more                   |
| Editions (Starter / Pro / Enterprise)            | Distinct products **if** modelled as distinct Items (Chargebee's normal way: separate plan items)               | Distinct per price as well                                                     |
| Add-ons / usage (metered) items                  | Each add-on item is its own product; metered items are products whose lines carry no fixed quantity             | Same, multiplied by prices                                                     |
| One-off `charge` items                           | Products only if the Product Model declares them; otherwise `productReferences.ignored` or holding filter (§10) | Same                                                                           |

**Risk and guard.** If a tenant genuinely sells editions as **prices** of one item, which is unusual, Item
identity would merge them.

- The guard is governance, not code. Items map only to Product Model entries the operator declares.
- Profiling of `ItemPrices` shows each item's price variants and periods (`price_variant_id`, `period_unit`
  categories), so the reviewer sees the structure before publishing.
- A composite identity is **not** offered in M9B (decision B1 records this).

## 7. Subscription-line identity

**There is no stronger identifier.**

- `subscription_items[]` entries have no id (F8).
- Chargebee's subscription object has no per-item immutable key.
- Ids are never built from names.

Candidates:

| Event                                     | `<subscription_id>:<item_price_id>` (master-plan default)         | `<subscription_id>:<item_id>` (**recommended**)                             |
| ----------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Renewal (term advances)                   | stable                                                            | stable                                                                      |
| Quantity change                           | stable                                                            | stable                                                                      |
| Price point change (same item, new price) | **new line + old line** (old tombstoned only by a full run or G4) | **stable** (same line updated)                                              |
| Monthly → annual (same item)              | new line                                                          | stable                                                                      |
| Upgrade/downgrade to another plan item    | new line (correct: other product)                                 | new line (correct)                                                          |
| Add-on removed                            | line must disappear (G4 / full run)                               | same                                                                        |
| Cancellation → reactivation               | stable (same subscription)                                        | stable                                                                      |
| New subscription for the same product     | separate line (no collapse)                                       | separate line                                                               |
| Same item twice in one subscription       | distinct if the prices differ                                     | **collision → `duplicate_external_id`**, the line is rejected (fail closed) |

**Recommendation:**

- Use `line_id = <subscription_id>:<item_id>`, **provided** V3 proves on the test site that an item cannot appear
  twice in one subscription.
- If V3 shows it can, use `<subscription_id>:<item_price_id>`. Price-point changes then rely on G4 to retire the
  old line in the same run.
- In both cases a key repeated within one parent is counted `duplicate_external_id`. The line is rejected, so
  M9A protection applies: no tombstone, and a gap on the account.

Separator `:` is safe if V7 confirms Chargebee ids exclude it. Otherwise the adapter uses a length-prefixed form;
the reviewed choice is recorded in the adapter and fixture README.

## 8. Subscription state mapping

The mapping is a closed value map in the **versioned mapping document** (TEST configuration; a business decision
per tenant). It is not code. `unmapped: unknown`. Raw status stays in the profile (safe-category values) and the
source record; it is never a canonical field.

| Chargebee `status`    | Canonical   | Reason                                                                                                                                                        |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`              | `active`    | Charged and in service.                                                                                                                                       |
| `in_trial`            | `trial`     | Trial period.                                                                                                                                                 |
| `non_renewing`        | `active`    | In service until the end of the current term (F6). The end date carries the fact (`endsAt = current_term_end`).                                               |
| `cancelled`           | `cancelled` | Ended. An `endsAt` still in the future evaluates as `unknown` (`subscription_state_conflict`, existing M7 rule), never owned.                                 |
| `future`              | `unknown`   | Not yet started. `active` with a future `startsAt` is the master-plan alternative; **recommended `unknown`** so no date is used to infer state (decision B3). |
| `paused`              | `unknown`   | Service suspended; no canonical "paused" (decision B3).                                                                                                       |
| `transferred`         | `unknown`   | Moved to another business entity (MBE). Neither cancelled nor owned here.                                                                                     |
| any other / new value | `unknown`   | `observed_value_unmapped` at validation (M9A); a new category at runtime is drift.                                                                            |

**`expired` is never produced.** Chargebee has no such status (F6). A subscription that ends becomes `cancelled`,
and M9B never derives `expired` from dates. A deleted record (`deleted = true`) is **not** a state: it is
deletion evidence (§17).

## 9. Subscription terms

| Chargebee field (UTC Unix seconds, F18)    | Canonical / treatment                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `current_term_start`                       | **`startsAt`** (`unix_seconds`, G3)                                             |
| `current_term_end`                         | **`endsAt`** (`unix_seconds`); exclusive boundary [VERIFY V4]                   |
| `start_date`, `started_at`, `activated_at` | profiled, `ignored` (`reason: term_pair_confirmed_elsewhere`)                   |
| `trial_start`, `trial_end`                 | profiled, `ignored`: state `trial` already says it; no trial dates in canonical |
| `cancelled_at`                             | profiled, `ignored`; state `cancelled` carries the fact                         |
| `next_billing_at`                          | profiled, `ignored`: billing schedule, not a term                               |
| `pause_date`, `resume_date`                | profiled, `ignored`                                                             |
| item-level `current_term_start/end`        | profiled; not mapped in M9B (decision B5: item terms vs subscription terms)     |

**Why the current term.**

- Ownership asks "is this in force now?" The current term is the period Chargebee bills as in force.
- An active line whose term ended without a newer read goes out of force: stale reads fail safe instead of
  extending ownership.
- **No "renewal date"** is synthesised. Absent or invalid values stay absent (`invalid_date` is a rejected value
  under M9A seen-but-rejected protection, never a guessed date).
- **V4 matters.** If a cancelled subscription keeps a future `current_term_end`, the existing M7 rule returns
  `unknown` (`subscription_state_conflict`), which is safe. The live gate records which case Chargebee exhibits.

## 10. Multi-item subscriptions

- Each `subscription_items[]` entry is its own `SubscriptionItems` record and canonical line. A plan plus two
  add-ons gives three lines; add-on products stay separate products.
- `quantity` maps to canonical `quantity`, which must be a positive integer.
  - `quantity > 1` is one line with that quantity, never several lines.
  - `quantity_in_decimal` and metered items without a quantity leave `quantity` absent.
  - A non-integer quantity is rejected `invalid_quantity` (protected and counted).
- Repeated items follow §7 (V3).
- **Holding filter.** `item_type` is denormalised on the line. TEST mapping: `in (plan, addon)`, with a **reviewed
  domain** (M9A) classifying `plan` and `addon` as holding, `charge` as non-holding, and `null` as non-holding.
- **Charge items.** One-off charges (`charge_once`) are not holdings unless the tenant's Product Model says
  otherwise (decision B2).

## 11. Profiling integration (M9A, no Chargebee-specific engine)

1. Run `sources schema --capture` to snapshot the five declared objects (`describeSchema`).
2. Run `sources profile-run --objects Customers,Items,ItemPrices,Subscriptions,SubscriptionItems --sampling full`
   (or `systematic`; `recent` is allowed because `changeField` is declared, and `head` is refused).
   - The adapter serves `purpose: 'profile'` reads exactly as sync reads: exactly the selected fields, `card`
     discarded.
3. **Covering profile** before publication: `SubscriptionItems` (identity, references, `status`, `item_type`,
   terms, quantity), `Customers` and `Items`.
   - Expected findings: Unix-second integers on date fields (accepted with `unix_seconds`, G3),
     `identifier_not_unique` if V3 fails (the declared-identity two-tier rule from M9A), and `status`
     categories.
4. **Reviewed holding domain** for `item_type` (§10), against the snapshot.
5. **Drift.** Run-quality profiles on every sync. New `status` values, new `item_type` values, and changes in the
   share of null `item_id` (unknown item prices) are findings. A new holding-filter value is
   `holding_filter_value_unreviewed` (B class, fail-closed per record).
6. **Privacy.** `Customers.company` is free text. No M9A sensitive-name rule matches it, but the safe-category
   gate suppresses its values (high cardinality). Emails, names and phones are never declared. Field names come from
   the adapter's declared list; the M9A schema-name guard still applies.

## 12. Completeness proof and coverage tier (CRITICAL)

**API evidence:**

- The subscriptions list response has `list` and `next_offset` only (F3); Items, ItemPrices and Customers have
  the same shape.
- There is no count endpoint for subscriptions in the SDK resource surface, and no `count` attribute on any list
  response.
- Exports are asynchronous and carry no row count or manifest (F14).
- Events (F15) describe changes, not a population total.

**Conclusion:** no independently asserted count exists, so `externally_grounded` is **impossible** for Chargebee
in M9B.

**Method: `double_enumeration` → `stable_snapshot`** (G2), for `SubscriptionItems` (and, through it,
`Subscriptions`):

1. Fix `boundary = now − settle` (settle = 5 minutes for eventual consistency, F5; configurable 1–60 minutes).
2. **Pass 1** (processing): list subscriptions `created_at[before]=boundary`, `include_deleted=true`,
   `sort_by[asc]=created_at`, `limit=100`, every page to exhaustion. Records are processed (lines, protections,
   gaps). Collect `S1` = the set of subscription ids, and `L1` = the set of line keys.
3. **Pass 2** (verification): the same filter and order, from the first page, to exhaustion. Collect `S2` and
   `L2`. Content is not re-processed.
4. **Pass condition:** both traversals exhausted (no `next_offset`), no id repeated within a pass, `S1 = S2` and
   `L1 = L2`.
   - Membership stability is what completeness needs.
   - A record **updated** between passes does not fail the proof. Its content is corrected by the next run.
   - A record created, deleted or moved under the boundary between passes does fail it.
5. **Pass** → `proof {method: double_enumeration, tier: stable_snapshot, outcome: passed}`.
6. **Fail** → `unstable_read`: no coverage change, no tombstones, no gap replacement (M8/M9A behaviour). Lines
   written in pass 1 stay; they are presence evidence.

**Coverage semantics (unchanged from M9A, ADR 0023):**

- `double_enumeration` requires an operator acceptance on the authority version (`requiresAcceptance` is already
  true for it).
- Coverage tier is `stable_snapshot` at most.
- Positive ownership is usable. Every `not_owned` becomes `unknown` (`coverage_tier_insufficient`), and there is
  **no whitespace**.
- An acceptance can never promote the tier.

**Cost:** two passes cost ⌈n/100⌉ × 2 requests. At 150/minute on a test site, 10,000 subscriptions take about
2.7 minutes of request budget. The rate limiter keeps concurrency at 1 per connection.

Rejected alternatives:

- a single traversal (weaker than M8 and blind to concurrent change);
- events-based reconciliation (vendor-specific; deferred);
- export comparison (asynchronous, no count; no stronger guarantee).

## 13. Authority recommendation

- Under the M8 model, `subscription_state` and `subscription_terms` must come from the connection holding
  `subscription_lines`, or stay unassigned (`cross_source_unsupported`). **Chargebee may hold all three together,
  or none.**
- Split ownership (Sugar lines + Chargebee state/terms) is **not possible**: no shared line key exists (§23).
- Holding `subscription_lines` needs:
  - a published Chargebee mapping with a covering profile;
  - a passed `double_enumeration` full run;
  - an **acceptance** in `proof_acceptances` (`tier: stable_snapshot`, connection, reason, actor);
  - the live gate (§20) passed for that connection's site.
- **Per tenant, exclusive.** Moving `subscription_lines` from Sugar to Chargebee is an operator authority version
  (M8). Sugar lines then stop counting as ownership facts. Nothing is matched or merged.
- **TEST tenant default:** Chargebee is profiled and mapped but holds **no** authority until the live gate passes
  (decision B7).

## 14. Customer and account identity

- Identity: `Customers.id` → company external reference `chargebee/Customers/<id>`. It is never assumed equal to
  a CRM account id.
- Chargebee has no standard external-reference field (F12). If a tenant stores a CRM id in a custom field
  (`cf_*`), the operator may declare it (decision B6). It is then profiled, and identity resolution is a separate
  approved design (deferred). M9B matches nothing.
- Email or domain: not declared (privacy). They are never used for matching.

| Case                                              | Behaviour                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Subscription references an unknown customer       | Line `orphan_account_reference` (M8). With an existing line, M9A protection keeps it and adds a gap (`account_reference_orphaned`). |
| Customer deleted (`deleted: true`)                | Company external reference `absent` (M6 semantics). Its lines then reference an orphan, as above.                                   |
| Duplicate custom reference value across customers | Profiling `identifier_not_unique` finding on the declared field. No identity effect in M9B.                                         |
| Customer missing `company`                        | Company created with no name value (M8 behaviour); a profile finding records the null ratio.                                        |

## 15. Product mapping safety

- Items resolve only through Product Model `externalRefs` (`system: chargebee`, `objectType: Items`).
- The M8 catalogue phase runs before any line: an item referenced by a line with no Product Model entry and not
  in `productReferences.ignored` fails the run **before writes** (`unmodelled_product_reference`).
- Products are **never auto-created** from Chargebee.
- Ignored items (for example a one-off setup charge) give `non_subscription_product` skips with provenance and no
  gap.
- An unknown item price (no `item_id`) is `missing_product_reference`: a rejected record, protected, with a gap.

## 16. Adapter and port implementation

- **`capabilities()`:** `{ kind: 'chargebee', readOnly: true, singleRecordRead: false }`.
- **`testConnection()`:**
  - `GET /items?limit=1` and `GET /subscriptions?limit=1` with the configured site and key;
  - codes only: `ok`, `auth_failed`, `forbidden`, `site_not_found`, `rate_limited`,
    `catalog_version_unsupported` (Product Catalog 1.0 detected, V11), `unreachable`;
  - full-access key detection (if verifiable, V8) yields `key_not_read_only` and refuses.
- **`describeSchema()`:** the five objects of §4 with declared fields and capabilities. Enum options come from
  the API's documented vocabularies (`status`, `item_type`), marked `active`. `sourceVersion: 'v2/pc2'`.
- **`readRecords(request)`:**
  - per object, with `purpose` honoured;
  - `fields` limits the projection after Zod parsing;
  - `selection`:
    - `full` → `created_at[before]` plus `sort_by[asc]=created_at`;
    - `since` → `updated_at[after]=since` plus `updated_at[before]=boundary` plus `sort_by[asc]=updated_at`;
    - `ids` → `id[in]` (≤ 100 per call);
  - `position` = `next_offset`, passed through opaque;
  - `pageSize` ≤ 100;
  - `SubscriptionItems` pages are produced from subscription pages: a page boundary never splits one
    subscription's items.
- **`countRecords`:** **not implemented** (no evidence of a count).
- **`readRecord`:** **not implemented**. Retrieve-after-write is not needed for synchronisation; reconsider only
  for repairs.
- **Transport:**
  - GET only;
  - allowlisted paths `/api/v2/{customers,items,item_prices,subscriptions}` plus `limit=1` probes;
  - every other path, including invoices, transactions, cards, payment sources and hosted pages, is refused
    inside the process (connector-level test per denied family).
- **Errors:**
  - 429 and 5xx: retryable `ConnectorError`, honouring `Retry-After`;
  - 401/403: `auth_failed`/`forbidden`, permanent;
  - 404 on the site: `site_not_found`;
  - Zod failure: the record is rejected (`record_rejected`), or the run fails if structural (M9A B guards).

## 17. Pagination and checkpoints

- **Ordering.**
  - Full reads: `sort_by[asc]=created_at` (stable under updates).
  - Incremental: `sort_by[asc]=updated_at` (F4).
  - `next_offset` is opaque and never parsed. V2 verifies it is a continuation cursor.
- **Incremental window.**
  - `updated_at[after] = checkpoint − overlap` (overlap ≥ 10 minutes, the existing `sync.overlapMinutes`).
  - `updated_at[before] = boundary` (run cutoff), with `boundary = run start − settle` (F5).
  - Timestamps are UTC Unix seconds (F18). Ties at a second are covered by the overlap, and upserts are
    idempotent.
  - `resource_version` (a millisecond timestamp, F18) is profiled as a per-record ordering value only. Stale
    writes are guarded generically by `sourceUpdatedAt` (seconds); `resource_version` is never a time filter.
- **Checkpoint:**
  - the high watermark is the run boundary (M8), not the last record's `updated_at`;
  - per-page progress is saved with the opaque position (M8 `saveProgress`);
  - a retried job restarts from the saved position; idempotent writes make replays safe.
- **Duplicate page protection:** a key seen twice in one pass is counted (`duplicate_external_id`). In
  double-enumeration passes, a repeated id fails the proof.
- **Non-progress detection (CB36).** The reader keeps the set of `next_offset` tokens returned in the current
  traversal. A token equal to one already used in that traversal, or a page that returns the same first and last
  record ids as the previous page, is **non-progress**:
  - the read stops at once with `pagination_stalled` (a permanent, non-retryable connector error), never a loop;
  - the run fails: no proof, no coverage change, no tombstones, no gap replacement;
  - lines already written stay (presence evidence only), exactly as for any failed run.
  - The generic `MAX_PAGES` ceiling (M8) remains the backstop.
- **V12.** If changing a subscription item does not move the subscription's `updated_at`, incremental runs would
  miss item changes. The live gate verifies this. If it fails, incremental reads for Chargebee are disabled and
  only full runs establish lines (decision B8).

## 18. Full read and deletion (tombstones)

A line may be tombstoned **only** when all of the following hold:

1. The run is a full run and **every** object's read completed (exhausted, no failure).
2. The double enumeration passed (§12).
3. The active authority version has an **acceptance** for this connection's `stable_snapshot` proof.
4. The line key is in neither `holdingIds` nor `seenButRejected` (M9A §9).
5. No B guard tripped (M9A A4), and no unattributable rejection occurred.

Otherwise:

- the run completes (or fails) with **zero** tombstones;
- coverage is unchanged, and stays `none` without an acceptance;
- gaps are replaced only on a fully completed run.

A partial or failed read never creates deletion evidence.

Also allowed on any run, including incremental:

- ~~**Explicit deletion:** a record returned with `deleted: true` (`include_deleted=true`) → `absent`.~~
  **Superseded by revision 3** for Chargebee: live records only; a deleted subscription is retired by the next
  accepted full run.
- **Parent-scoped child reconciliation (G4):** an observed, accepted subscription whose child set lacks a
  previously active line key → that line `absent`. This is suppressed when any child of that parent was rejected
  in the run, and it **never runs for a parent that was itself rejected** for any reason (structural, mapping or
  validation): that parent's existing children stay protected, with no retirement or tombstone (CB35).

**Still forbidden:** absence-based whitespace. Under `stable_snapshot`, a tombstoned line removes positive
evidence only. Absence remains `unknown`.

## 19. Deleted, cancelled, expired, paused, non-renewing, trial

| Chargebee situation                                                | Representation                                         | Canonical effect                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Subscription deleted                                               | `deleted: true` with `include_deleted`; absent without | Lines `absent` (tombstone). **Not** a cancellation.                                                                                 |
| Subscription disappears without deleted flag (retention ended, V5) | missing from full listing                              | Tombstone only under §18 conditions.                                                                                                |
| Cancelled                                                          | `status: cancelled`, `cancelled_at`                    | State `cancelled`; the line stays (history), not owned.                                                                             |
| Scheduled cancellation                                             | `status: non_renewing`                                 | `active` until `current_term_end`.                                                                                                  |
| "Expired" (term ended, no renewal)                                 | becomes `cancelled` in Chargebee                       | `cancelled`; never synthesised as `expired`.                                                                                        |
| Paused                                                             | `status: paused`, `pause_date`/`resume_date`           | `unknown` (B3).                                                                                                                     |
| Trial                                                              | `status: in_trial`, `trial_start/end`                  | `trial`.                                                                                                                            |
| Trial ended → cancelled (trial end action)                         | `status: cancelled`                                    | `cancelled`.                                                                                                                        |
| Item archived/deleted in catalogue                                 | `Items.status`                                         | Existing lines keep resolving to the product. A deleted item without a Product Model entry fails the catalogue phase before writes. |

## 20. Authentication and security

- **Credential:** one Chargebee **read-only** API key (_Restricted_: Subscriptions, Customers and product
  catalogue read; or _All_), via `SecretProvider` under the connection's credential name.
  - Chargebee supports **only API keys** for this server-to-server use (F1, F2); there is no OAuth path for site
    data in M9B.
  - The owner creates the key in the test site's dashboard and sets the environment variable. **The key is never
    pasted in chat, logged, committed, or included in findings or profiles.**
- **Configuration (non-secret):**
  - `site` (subdomain; validated `^[a-z0-9-]{1,63}$`; test sites conventionally end `-test`, which the gate records);
  - `businessEntityId` (optional; MBE scoping);
  - `rateLimitPerMinute` (default 100, ≤ site limit);
- **Rate and concurrency limits** (F16):
  - Chargebee documents 150 requests/minute on test sites (plan-based on live sites) and a **concurrent-request
    limit of 50 GET requests** (100 POST).
  - The M9B design keeps **at most 1 concurrent Chargebee request per connection**: the reader is sequential and
    a per-connection limiter serialises calls. It also keeps the per-minute rate below `rateLimitPerMinute`.
  - The design therefore stays well below the documented concurrency limit. No architectural change follows from
    it.
  - A 429 (either limit) is retryable: honour `Retry-After`, back off exponentially, and never raise concurrency.
  - `settleMinutes`, `sync.overlapMinutes`, `profile.maxRows`.
- **Isolation:**
  - one connection per (tenant, kind) (M8);
  - the site is part of the connection config, so two tenants can never share a key (one secret per tenant
    credential name);
  - RLS on everything stored.
- **Least privilege:**
  - read-only key;
  - endpoint allowlist (§16);
  - `card` and payment objects dropped unread;
  - personal fields undeclared.
- **No production writes.** The adapter has no write path. The transport refuses non-GET methods.

## 21. Synthetic scenarios (fake Chargebee and test site)

All data is synthetic (no customer data). It is created on a Chargebee **test site** by the owner or under
supervision, and mirrored deterministically in `test/support/fake-chargebee.ts`.

| #    | Scenario                                                                                                                                                                                                                                                                               | Expected                                                                                                                                                                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CB01 | Customer with one active subscription, one plan item                                                                                                                                                                                                                                   | 1 company ref; 1 line `active`; terms from `current_term_*`                                                                                                                                                                                                                                                                            |
| CB02 | Plan + 2 add-ons in one subscription                                                                                                                                                                                                                                                   | 3 lines; products by item id                                                                                                                                                                                                                                                                                                           |
| CB03 | Two subscriptions, same customer, same item                                                                                                                                                                                                                                            | 2 lines (no collapse)                                                                                                                                                                                                                                                                                                                  |
| CB04 | `in_trial`                                                                                                                                                                                                                                                                             | `trial`                                                                                                                                                                                                                                                                                                                                |
| CB05 | `future` start                                                                                                                                                                                                                                                                         | `unknown` (B3 default)                                                                                                                                                                                                                                                                                                                 |
| CB06 | `non_renewing`                                                                                                                                                                                                                                                                         | `active` until `current_term_end`                                                                                                                                                                                                                                                                                                      |
| CB07 | `cancelled` (immediate)                                                                                                                                                                                                                                                                | `cancelled`; never owned (V4 recorded)                                                                                                                                                                                                                                                                                                 |
| CB08 | `paused`                                                                                                                                                                                                                                                                               | `unknown`; never whitespace                                                                                                                                                                                                                                                                                                            |
| CB09 | Unlisted status (`transferred` on MBE, or synthetic in the fake)                                                                                                                                                                                                                       | `unknown`; `observed_value_unmapped`; drift finding                                                                                                                                                                                                                                                                                    |
| CB10 | Renewal (term advanced)                                                                                                                                                                                                                                                                | same line updated; no new line                                                                                                                                                                                                                                                                                                         |
| CB11 | Quantity 1 → 5                                                                                                                                                                                                                                                                         | same line; `quantity = 5`                                                                                                                                                                                                                                                                                                              |
| CB12 | Price change monthly → annual, same item                                                                                                                                                                                                                                               | same line (item identity) or old line retired by G4 (fallback identity)                                                                                                                                                                                                                                                                |
| CB13 | Item with USD and EUR prices on two customers                                                                                                                                                                                                                                          | one product; two lines                                                                                                                                                                                                                                                                                                                 |
| CB14 | Upgrade plan item A → B                                                                                                                                                                                                                                                                | line A retired (G4), line B created                                                                                                                                                                                                                                                                                                    |
| CB15 | Add-on removed                                                                                                                                                                                                                                                                         | add-on line retired by G4 on an incremental run                                                                                                                                                                                                                                                                                        |
| CB16 | One-off `charge` item                                                                                                                                                                                                                                                                  | non-holding (reviewed domain); `filtered_out`, tombstonable                                                                                                                                                                                                                                                                            |
| CB17 | Item with no Product Model entry                                                                                                                                                                                                                                                       | run fails before writes (`unmodelled_product_reference`)                                                                                                                                                                                                                                                                               |
| CB18 | Item in `productReferences.ignored`                                                                                                                                                                                                                                                    | `non_subscription_product`; no gap                                                                                                                                                                                                                                                                                                     |
| CB19 | Subscription referencing a missing customer                                                                                                                                                                                                                                            | `orphan_account_reference`; existing line protected + gap                                                                                                                                                                                                                                                                              |
| CB20 | Customer deleted                                                                                                                                                                                                                                                                       | company ref `absent`; its lines orphaned → protected + gap                                                                                                                                                                                                                                                                             |
| CB21 | Subscription deleted (`include_deleted`)                                                                                                                                                                                                                                               | lines `absent` on any run                                                                                                                                                                                                                                                                                                              |
| CB22 | Subscription cancelled then reactivated                                                                                                                                                                                                                                                | same line: `cancelled` → `active`                                                                                                                                                                                                                                                                                                      |
| CB23 | Unknown item price id on a line (catalogue drift)                                                                                                                                                                                                                                      | `missing_product_reference`; protected + gap                                                                                                                                                                                                                                                                                           |
| CB24 | Malformed value (`current_term_end` not an integer) in the fake                                                                                                                                                                                                                        | `invalid_date` rejection; protected                                                                                                                                                                                                                                                                                                    |
| CB25 | Same item twice in one subscription (if V3 allows)                                                                                                                                                                                                                                     | `duplicate_external_id`; line rejected, protected                                                                                                                                                                                                                                                                                      |
| CB26 | > 100 subscriptions (pagination; ≥ 3 pages)                                                                                                                                                                                                                                            | all lines; positions resume after a forced retry                                                                                                                                                                                                                                                                                       |
| CB27 | Incremental run after an update                                                                                                                                                                                                                                                        | only changed lines; overlap; no absence-based tombstone                                                                                                                                                                                                                                                                                |
| CB28 | Subscription created between passes (fake; on the test site by timed action)                                                                                                                                                                                                           | `unstable_read`; coverage unchanged; no tombstones                                                                                                                                                                                                                                                                                     |
| CB29 | Stable full run with acceptance                                                                                                                                                                                                                                                        | `proof {double_enumeration, stable_snapshot, passed}`; tombstones allowed; absence `unknown`; no whitespace                                                                                                                                                                                                                            |
| CB30 | Stable full run **without** acceptance                                                                                                                                                                                                                                                 | lines written; coverage `none` (`proof_not_accepted`); zero tombstones                                                                                                                                                                                                                                                                 |
| CB31 | 429 storm mid-read                                                                                                                                                                                                                                                                     | retries honour `Retry-After`; run completes; idempotent                                                                                                                                                                                                                                                                                |
| CB32 | Product Catalog 1.0 site (fake)                                                                                                                                                                                                                                                        | `catalog_version_unsupported`                                                                                                                                                                                                                                                                                                          |
| CB33 | Profile drift: new `status` or `item_type` value                                                                                                                                                                                                                                       | drift finding; `holding_filter_value_unreviewed` for `item_type`                                                                                                                                                                                                                                                                       |
| CB34 | Restricted read-only key lacking catalogue scope                                                                                                                                                                                                                                       | `forbidden` at test; never a partial run                                                                                                                                                                                                                                                                                               |
| CB35 | **Parent structurally rejected**: a subscription record fails the boundary schema or a mapping rule for a reason unrelated to account/product lookup (e.g. `customer_id` absent, `subscription_items` not an array, `status` field missing), on a parent that already has active lines | the parent is rejected (`record_rejected`, counted); **child reconciliation (G4) does not run** for it; its existing children stay active and protected (seen-but-rejected keys; gap on the account when attributable, else the run fails as unattributable per M9A); **no child retirement or tombstone** on full or incremental runs |
| CB36 | **Repeated pagination offset**: the source returns the same `next_offset` on consecutive page requests (fake; not reproducible on demand on a test site)                                                                                                                               | non-progress detected on the first repeat (`pagination_stalled`); the read stops (no infinite loop, bounded request count); the run fails: **no proof, no coverage change, no tombstones**, no gap replacement; already-written lines remain                                                                                           |

## 22. Live verification gate (separate from fake tests)

- **Prerequisites:**
  - the owner provides a Chargebee **test site** (synthetic data only) and a read-only key via `SecretProvider`;
  - the owner allows `<site>.chargebee.com` in the environment's network settings.
- **The gate runs:**
  - `testConnection`, schema capture and profile run;
  - mapping publication with acknowledgements;
  - a full run (double enumeration);
  - an incremental run after scripted changes;
  - the scenarios runnable on a test site (CB01–CB23, CB25–CB31, CB33, CB34). CB24, CB32, CB35 and CB36
    need conditions a real site cannot produce on demand (malformed values, a Product Catalog 1.0 site, a
    structurally invalid parent, a repeated offset) and run on the fake only.
- **It records** (sanitised: no values, no names, no ids beyond counts):
  - site type (test);
  - API version (`v2`) and catalogue version (2.0);
  - objects exercised;
  - V2–V12 outcomes (V1 is documented: F18);
  - the proof method observed and pass/fail;
  - pagination evidence (pages, offset behaviour);
  - rate-limit behaviour (429 count, `Retry-After` honoured);
  - eventual-consistency lag observed.
- **Status `LIVE CHARGEBEE VERIFICATION`:** PENDING until this is done. M9B cannot be closed on fake tests alone
  (§26).

## 23. Testing plan

- **Unit:**
  - Zod boundary schemas (every object; unknown fields dropped; `card` discarded);
  - flattening (line ids, denormalised parent fields, `item_id` resolution, page boundaries);
  - status and term mapping through the generic engine with the TEST mapping;
  - `unix_seconds` transform (G3);
  - double-enumeration comparator (G2);
  - child-set reconciliation (G4), including a structurally rejected parent (CB35);
  - non-progress detection on a repeated `next_offset` (CB36);
  - transport allowlist and GET-only.
- **Adapter contract tests:** the shared port contract suite (M8) run against the fake.
- **Integration** (real PostgreSQL, RLS, app role):
  - sync full/incremental;
  - profiling;
  - mapping publication with a covering profile;
  - authority with acceptance;
  - coverage tier;
  - seen-but-rejected;
  - reviewed domain;
  - pagination and resume;
  - deletion and tombstones;
  - G4;
  - CB01–CB36 on the fake.
- **Runtime:** `scripts/verify-runtime.d/80-chargebee.sh` (real CLIs and worker against the fake; no values in
  output or logs). **Docker:** image checks for the Chargebee CLI paths.
- **Mutation proofs** (each must fail the named test for the right reason):

| #   | Mutation                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------- |
| C1  | Transport allows POST                                                                                       |
| C2  | Allowlist admits `/invoices`                                                                                |
| C3  | `card` kept in records                                                                                      |
| C4  | Pass 2 skipped (proof always passes)                                                                        |
| C5  | Id-set comparison ignores an inserted record                                                                |
| C6  | Proof recorded as `count` (tier promoted)                                                                   |
| C7  | Tombstones without acceptance                                                                               |
| C8  | Tombstones on an `unstable_read` run                                                                        |
| C9  | G4 ignores a rejected sibling (tombstones a protected line)                                                 |
| C10 | G4 runs on a parent that was itself rejected                                                                |
| C11 | Line id built from `item_price_id` when configured for item (identity drift)                                |
| C12 | Duplicate key not detected                                                                                  |
| C13 | Unknown status mapped to `active`                                                                           |
| C14 | `unix_seconds` accepts milliseconds (range check removed)                                                   |
| C15 | `item_id` resolution falls back to the item price id                                                        |
| C16 | Incremental window without overlap                                                                          |
| C17 | `deleted: true` treated as cancelled                                                                        |
| C18 | Product auto-created from an unmodelled item                                                                |
| C19 | Settle window removed (boundary = now)                                                                      |
| C20 | Read-only key check bypassed (if V8 makes it detectable)                                                    |
| C21 | G4 runs for a structurally rejected parent (CB35: a protected child is retired)                             |
| C22 | Non-progress detection removed (CB36: the reader loops until `MAX_PAGES`, or a repeated offset is accepted) |

## 24. Regression assertions

Each item below is an explicit test, not "suite green":

- **Sugar:**
  - `git diff` of `modules/sugar` empty;
  - the M8/M9A Sugar integration and runtime 70/75 unchanged;
  - Sugar full runs still use `count` (`proof.method = count`, `externally_grounded`).
- **CSV import:** still `operator_full_file` → `stable_snapshot`.
- **M9A profiling:**
  - the privacy, schema-name and limit tests unchanged;
  - the profiling engine has no Chargebee import (dependency rule `profiling-is-advisory`, plus a new rule:
    `modules/chargebee` imported only through its index, and no domain import of it).
- **Coverage tiers:**
  - no `double_enumeration` run yields `externally_grounded` (C6);
  - eligibility v3 snapshots replay unchanged.
- **Product Model:** no auto-created products (C18).
- **Source authority:** the split assignment Sugar lines / Chargebee state is still refused
  (`cross_source_unsupported`).

## 25. Cross-source matching

**Deferred.**

- No shared immutable identifier between Sugar RLIs and Chargebee subscription items is known. Sugar's candidate
  ids are 100% null (M8 evidence), and Chargebee has no standard external-reference field (F12).
- No matching by account name, product name, dates or fuzzy similarity.
- Recorded as a future capability with revisit triggers (M9 §10.7). Profiling of a declared `cf_*` reference
  field (B6) is the evidence path.

## 26. Definition of Done (M9B)

M9B is complete only when all of the following hold:

- this plan is approved;
- implementation is finished (adapter, G1–G5);
- `pnpm verify` is green;
- `pnpm verify:runtime` is green (including `80-chargebee.sh`);
- `pnpm verify:docker` is green;
- the fresh clone is green at the exact SHA;
- every mutation proof C1–C22 fails for the right reason and is restored green;
- CB01–CB36 are green on the fake;
- **real Chargebee test-site verification is completed** (§22, V2–V12 recorded; V1 documented, F18);
- an independent implementation review has passed.

Fake-adapter tests alone never close M9B.

## 27. Risks

| Risk                                                                                                | Mitigation                                                                                                           |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No count → coverage at most `stable_snapshot`; no whitespace from Chargebee                         | Accepted by design (ADR 0023); positive ownership still usable                                                       |
| V3: an item may repeat within a subscription                                                        | Fallback identity (§7) + G4; repeats fail closed                                                                     |
| V12: item changes may not move `updated_at`                                                         | Full-run-only mode (B8)                                                                                              |
| Eventual consistency (F5) causes missed writes                                                      | Settle window + overlap; double enumeration catches membership changes                                               |
| High-churn sites fail double enumeration often                                                      | Runs fail safe (no tombstones); `created_at[before]` boundary limits churn to deletions; scheduling at quiet hours   |
| Rate limits (test 150/min; live plan-based; live breach flags the account) and concurrency (50 GET) | Per-connection limiter below the site limit; one concurrent request (well below 50); backoff honouring `Retry-After` |
| Deleted-record retention (V5) → silent disappearance                                                | Disappearance is handled only by §18 conditions                                                                      |
| MBE sites (`transferred`, `business_entity_id`)                                                     | `businessEntityId` scoping; `transferred → unknown`                                                                  |
| Docs unreachable from this environment                                                              | SDK-derived evidence; re-check with docs access before implementation (B10)                                          |
| Product Catalog 1.0 sites                                                                           | Refused (`catalog_version_unsupported`)                                                                              |

## 28. Deferred scope

- Cross-source line matching (§25).
- Events-API reconciliation.
- Exports.
- Webhooks (push).
- Item-level terms (B5).
- Metered usage.
- Invoices, payments and revenue figures (MRR/ARR).
- Contract terms (`contract_term`).
- Product Catalog 1.0.
- Multi-site tenants.
- Composite product identity.
- Live production sites (only test sites in M9B).

## 29. Open decisions requiring owner approval

| #   | Decision                                                                                                                                | Recommendation                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| B1  | Product identity = Item (no item-price or composite products)                                                                           | Approve                                                            |
| B2  | `charge` items are non-holdings by default (reviewed domain), products only if modelled                                                 | Approve                                                            |
| B3  | `future`, `paused`, `transferred` → `unknown`                                                                                           | Approve (`future → active` + future `startsAt` is the alternative) |
| B4  | Generic parent-scoped child reconciliation (G4) in M9B                                                                                  | Approve (otherwise B8 full-run-only)                               |
| B5  | Terms from subscription `current_term_*`, not item-level terms                                                                          | Approve                                                            |
| B6  | Allow operator-declared `cf_*` customer reference fields (profiled only; no identity effect)                                            | Approve, empty by default                                          |
| B7  | TEST tenant: Chargebee holds no authority until the live gate passes; afterwards all three facts or none                                | Approve                                                            |
| B8  | If V12 fails: Chargebee incremental reads disabled (full runs only)                                                                     | Approve as contingency                                             |
| B9  | Line identity `<subscription_id>:<item_id>` if V3 holds, else `<subscription_id>:<item_price_id>`                                       | Approve                                                            |
| B10 | Allow `apidocs.chargebee.com` (and later the test site host) in the environment's network settings for implementation and the live gate | Required                                                           |
| B11 | The owner provides a Chargebee test site with synthetic data and a read-only key (variable name agreed at implementation)               | Required for the live gate                                         |

## 30. Confirmation

Planning only. No Chargebee implementation, no migrations, no fixtures and no production-code change were made.
S3/file, warehouse, signals and opportunities have not started. **M9B implementation has NOT started. LIVE SUGAR
VERIFICATION remains PENDING.**
