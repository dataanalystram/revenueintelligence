# SugarCRM ↔ Platform Architecture Alignment (pre-M8)

Status: ARCHITECTURE ALIGNMENT ONLY. No code, schema, migration or connector
implemented. M8 implementation remains NOT STARTED.

Repo reviewed: `Garethtasktest`, commit `e4fec65` ("Docs: pre-M8 canonical
extension and source mapping architecture (design gate)"), checked out
detached and read-only. `main` is at `e0e3fe7` (M7 close); `e4fec65` is the
newer design-gate commit on top of it and is the tip this report evaluates
against. No file was changed, committed, or pushed in that repo.

Evidence base (not regenerated, cited as prior fact): `sugarcrm-local-evidence.md`
(this repo, branch `spike/sugarcrm-local-discovery`, commit `1f51cde`) and the
16 synthetic fixtures at `fixtures/sugarcrm/sanitized/`.

---

## 1. Real canonical model (as it exists at e4fec65)

Source: `apps/api/prisma/schema.prisma` (667 lines), ADRs 0007/0008/0014/0016/0017/0018,
`docs/architecture/canonical-extension-and-source-mapping.md`.

- **Account/Company** — model `Company` (schema.prisma:370–395): `id`, `tenantId`,
  `name` (nullable, ADR 0014 — never a placeholder), `domains[]`, `customerStatus`
  (default `unknown`), `recordState` (`active`/`inactive`/`merged`),
  `mergedIntoId`, timestamps. Relations: `subscriptions`, `externalRefs`, `persons`.
- **External references** — model `CompanyExternalRef` (397–420) and
  `PersonExternalRef` (451–472): composite PK `(tenantId, system, objectType,
  externalId)`, `state` (`active|deleted|merged`), `mergedIntoExternalId`,
  `sourceCreatedAt`/`sourceUpdatedAt`, `fieldHash`, `lastChangeId`. This is the
  single identity mechanism (ADR 0014); `system` is today the closed
  `ExternalSystem` enum (`hubspot`, `sugar`, `gainsight_cs`, `gainsight_px`).
- **Person** — model `Person` (422–449): `primaryEmail` nullable and **not
  unique** ("email is not identity", line 425), `additionalEmails[]`,
  `firstName`/`lastName`/`jobTitle`, `companyId` nullable, `roles[]`,
  `recordState`/`mergedIntoId` (merge lineage, same pattern as Company).
- **Product / Product Model** — `TenantProduct` (230–248, ADR 0016): `key`
  (identity), `name`, `description`, `active`, `family`, `modelVersion`.
  `TenantProductModel` (252–267): immutable versioned document (`version`,
  `document` JSON, `contentHash`, `effectiveFrom`), never updated/deleted.
- **Subscription** — `TenantSubscription` (270–303, ADR 0017): `id`,
  `companyId`, `productKey`, `state` (`active|trial|expired|cancelled|unknown`),
  `startsAt`/`endsAt`, `quantity`, `sourceSystem`/`sourceObjectType`/
  `sourceRecordId` (unique together per tenant, line 299), `recordState`
  (`active|deleted` — source tombstone), `sourceUpdatedAt`, `observedAt`,
  `fieldHash`, `firstSeenAt`/`lastSeenAt`, `lastChangeId`. **`state` already
  has an explicit `unknown` member** — this is the single most important fact
  for the Sugar state-gap assessment (§8 below).
- **Coverage** — not a stored field; per M7 §5 (referenced from the
  canonical-extension doc, line 226/401) coverage is "a completed full read
  under a published mapping" — a platform judgement derived from sync
  checkpoints (`TenantSyncCheckpoint`, 592–631), not a source-reported value.
- **Provenance** — `TenantContextChange` (480–508): append-only, one row per
  real canonical change, `entityKind` (`company|person`), `changeType`
  (`created|updated|state_changed|merged|ref_added|relationship_changed`),
  `sourceSystem`/`sourceObjectType`/`sourceRecordId`, `cause`
  (`webhook|backfill|reconciliation|replay|resync`), `adapter`/`adapterVersion`,
  `correlationId`. Field **names** only, never values (line 479).
- **Eligibility / Eligibility snapshots** — `TenantEligibilitySnapshot`
  (635–668, ADR 0018): `requestedCompanyId` vs `evaluatedCompanyId` (merge
  lineage resolved), `productKey`, `asOf`/`evaluatedAt`, `status`
  (`eligible|ineligible|unknown`), `ownership` (`owned|not_owned|unknown`),
  `modelVersion`/`modelHash`/`evaluatorVersion`/`factsHash`, frozen `result`
  JSON. Append-only, reproducible from frozen inputs.
- **Whitespace** — not yet implemented as a stored entity at e4fec65; it is
  referenced only as a forward milestone concept in ADR 0018 / the roadmap,
  derivable from eligibility + subscription ownership. No schema gap for
  Sugar today because nothing ingests into it yet.
- **Merge behaviour** — `Company.mergedIntoId`/`mergedFrom`, `Person.mergedIntoId`/
  `mergedFrom` (self-relations); `CompanyExternalRef.state = 'merged'` +
  `mergedIntoExternalId`. Canonical-extension doc §22 (line 651): subscriptions
  get a "merge participant" — survivor keeps, loser's value moves only where
  survivor has none, conflicts recorded, never silently overwritten.
- **Tenancy/RLS** — every table above carries `tenantId`, forced Postgres RLS
  (schema header, schema.prisma:3–10), composite unique/FK constraints
  including `tenantId`, enforced by a "schema-guard" CI test. `Tenant` (27–61)
  is the only table without `tenant_id`.
- **Connector/mapping architecture (design, not yet built)** — the
  canonical-extension doc (`docs/architecture/canonical-extension-and-source-mapping.md`)
  specifies: a generic vendor-neutral connector port (`testConnection`,
  `describeSchema`, `readRecords`, `readRecord`, `capabilities`, restricted
  `previewRecords`; §5), immutable hashed schema snapshots (§6), versioned
  mapping documents with entry kinds `identity|core|attribute|relationship|ignored`
  (§7–9), mandatory optimistic-concurrency base version (§10), source
  authority **per business fact** (§11), identity safeguards refusing
  descriptive-field identity (§15), and a closed data-quality code list (§16).
  This is design only — none of it exists as code/schema at e4fec65.

---

## 2. Sugar-evidence → canonical-target mapping table

| Sugar evidence field | Canonical target | Fit |
|---|---|---|
| `Accounts.id` | `Company` via `CompanyExternalRef(system='sugar', objectType='Accounts', externalId=id)` | **EXACT FIT** — strong unique PK (0 dup observed), matches the external-reference model exactly as designed |
| `Contacts.id` | `Person` via `PersonExternalRef(system='sugar', objectType='Contacts', externalId=id)` | **EXACT FIT** — same mechanism |
| `Contacts.account_id` | `Person.companyId` (resolved through `CompanyExternalRef`) | **GOOD FIT** — 90.0% match, 10% null (acceptable: `companyId` is nullable), 0% orphan |
| `ProductCatalogue.id` | `TenantProduct.key` origin, via product `externalRefs` (ADR 0016) | **GOOD FIT** — unique PK, 0 dup; needs a mapping-time decision on how `key` is derived (see §6) |
| `ProductCatalogue.name` | *(not used for identity)* | **DOES NOT FIT as identity** — 8.8% duplicate name rate (prior finding); identity safeguards (§15 of canonical-extension doc) explicitly refuse descriptive fields as identity, so this is not a gap, it is the architecture working as intended |
| `RevenueLineItems.id` | `TenantSubscription.sourceRecordId` (with `sourceSystem='sugar'`, `sourceObjectType='RevenueLineItems'`) | **EXACT FIT** — this is precisely the `(sourceSystem, sourceObjectType, sourceRecordId)` unique key the Subscription model already has (line 299); 15 dup of 255,684 (<0.01%) needs dedupe-on-load, a mapping/adapter concern, not a canonical gap |
| `RLI.account_id` | `TenantSubscription.companyId` via identity resolution | **GOOD FIT** — 99.5% match, 0.5% null, <0.1% orphan |
| `RLI.opportunity_id` | *(no canonical Opportunity entity yet — M11, not built)* | **REQUIRES MAPPING** — carried as context/relationship only until Opportunity milestone exists; not a Subscription field today |
| `RLI.product_template_id`/`product_id` | `TenantSubscription.productKey` via product external ref | **PARTIAL FIT** — 96.5% match; 1.4% orphan and 2.1% null need `missing_product_mapping`/`unresolved_relationship` data-quality codes (§16 of the design doc), not a schema change |
| `RLI.service_start_date`/`revenue_start_date_c` | `TenantSubscription.startsAt` | **REQUIRES BUSINESS CONFIRMATION** — two candidate date fields exist (`service_start_date` vs `revenue_start_date_c`); which is canonical "startsAt" is a mapping decision, not a canonical gap |
| `RLI.service_end_date`/`date_support_expires` | `TenantSubscription.endsAt` | **REQUIRES BUSINESS CONFIRMATION** — same ambiguity; also `13_conflicting_dates.csv` fixture shows end-before-start needs an `invalid_value` data-quality check |
| `RLI.sales_stage`/`status` | `TenantSubscription.state` | **REQUIRES BUSINESS CONFIRMATION / LIVE VERIFICATION** — ~99.5% null/mis-populated per prior finding; see §8 below. Falls back to `unknown`, which the model already supports |
| `RLI.renewal_parent_id` chain vs new-Opportunity-per-renewal | *(no canonical renewal concept — see §9)* | **REQUIRES BUSINESS CONFIRMATION** — two competing mechanisms, ~34% each, no proven authority; M7 does not need to resolve this at ingestion (§9 below) |
| `RLI.deleted` (tombstone) | `TenantSubscription.recordState = 'deleted'` | **EXACT FIT** — the model already has a tombstone field for exactly this |
| `RLI.quantity`/similar | `TenantSubscription.quantity` | **GOOD FIT** (not independently profiled in prior evidence; assumed present per schema, flagged for live verification) |
| `RLI.date_modified` | `TenantSubscription.sourceUpdatedAt` | **EXACT FIT** |
| Users (`assigned_user_id`, etc.) | *(not Person — internal actor only)* | **DOES NOT FIT as Person** — confirmed internal-only per prior finding; correctly excluded |

No schema change is proposed anywhere in this table; every PARTIAL/REQUIRES
row is a mapping-time or business-confirmation matter under the design in
`canonical-extension-and-source-mapping.md` §7–16, not a canonical-model gap.

---

## 3. M7 contract check

**M7 CANONICAL CONTRACT HOLDS.**

Checked against real Sugar evidence:
- Multiple Subscription lines per account/product: `TenantSubscription` has no
  uniqueness constraint tying one company+product to a single row — only
  `(tenantId, sourceSystem, sourceObjectType, sourceRecordId)` is unique
  (line 299). Sugar's 88.7%-of-accounts-have-2+-lines finding and the "same
  product, multiple RLIs" fixture (`03_multiple_lines_same_product.csv`) are
  both directly representable with zero schema change.
- Source-line identity: already the exact `(sourceSystem, sourceObjectType,
  sourceRecordId)` triple Sugar's RLI.id needs.
- Derived ownership: ADR 0017 ("Ownership is derived, never stored", line
  269 comment) — ownership is computed from subscriptions at read time, so
  Sugar supplying ambiguous/competing renewal chains does not corrupt a
  stored ownership value; there is none to corrupt.
- Unknown state: `state` enum already includes `unknown` (line 276) — this is
  not a Sugar-specific accommodation, it already exists for exactly this kind
  of source-quality gap.
- Completeness/coverage gating: defined at the mapping level (per-fact,
  per-connection "completed full read"), independent of any one source's
  internal data quality.
- Canonical Product key, provenance, external references: all exist and are
  source-agnostic by construction (`system` is a column value, not a type).

No M7 field, constraint, or migration needs to change because Sugar names
things differently. The only real finding against M7 is evidentiary, not
structural: Sugar is **not proven** as the authority for `state` — but M7
already has the `unknown` escape valve for exactly this case, so this is a
data/authority question (§8, §10), not an M7 defect.

---

## 4. Account identity fit

Sugar `Accounts.id` fits the real M6 external-reference model
(`CompanyExternalRef`) with no change: `system='sugar'`, `objectType='Accounts'`
(Sugar's own module name — the model stores the source's own object-type
string, not a normalised one), `externalId=Accounts.id`, resolving to one
`Company.id`. The **only** code-level change required is replacing the closed
`ExternalSystem` enum value set with the connector-kind catalogue so `'sugar'`
is a legal value — this is already an **acknowledged, planned M8 change**
(canonical-extension doc §5, §20, line 623: "Today's closed `ExternalSystem`
enum… must become the connector-kind catalogue… without that change Customer
B could not be onboarded, so it is a required M8 change"). It is required
regardless of Sugar specifically — any second source forces it. It is not a
Sugar-specific redesign.

The <0.04% duplicate `Accounts.id` rate found in Sugar data is a dedupe-on-load
concern for the adapter/mapping layer (`duplicate_identity` data-quality code,
§16 of the design doc already anticipates this), not a change to
`CompanyExternalRef`'s primary-key shape.

---

## 5. Contact/Person fit

Sugar `Contacts` map to `Person` cleanly: `PersonExternalRef(system='sugar',
objectType='Contacts', externalId=Contacts.id)` → `Person.id`, with
`Contacts.account_id` resolving to `Person.companyId` through the Account's
own external ref (90.0% match, 10% null — both representable since
`companyId` is nullable). `Person.primaryEmail` being nullable and explicitly
**not unique** (schema.prisma:425, ADR 0014) means Sugar's email data quality
(not independently profiled, but known from CRM data generally to contain
duplicates/blanks) needs no special handling — the model already assumes
email is not identity.

Sugar **Users** are correctly excluded from Person per the prior discovery
finding (confirmed internal-only) and this is already consistent with how
the canonical model treats `Person` as customer-side identity — nothing in
`Person`'s shape invites treating `assigned_user_id`/`created_by` as Persons.
No M6 Person model change needed.

---

## 6. Product fit

`ProductCatalogue.id` → `TenantProduct` via the existing product
`externalRefs` mechanism (ADR 0016, referenced at canonical-extension doc
line 319: "Product `externalRefs` (M7) remain the product identity mapping").
`ProductCatalogue.name` is correctly **UNSUITABLE** as identity (8.8% dup,
prior finding) and the identity-safeguards rule (§15 of the design doc, point
3) already refuses descriptive fields as account/product identity — so Sugar's
known name-duplication problem is pre-empted by existing architecture, not a
new risk requiring a product-identity redesign. `active_status`/`status`/
`renewable` fields on `ProductCatalogue` map to `TenantProduct.active`/
`family` as `core` mapping entries (REQUIRES MAPPING, not business
confirmation — these look like straightforward boolean/enum translations).
No Product identity change proposed or needed.

---

## 7. RLI → Subscription fit (field-by-field)

Using the real `TenantSubscription` fields (schema.prisma:270–303):

| Canonical field | Classification |
|---|---|
| `sourceRecordId` (= RLI.id) | AVAILABLE FROM SUGAR |
| `sourceSystem` / `sourceObjectType` | AVAILABLE FROM SUGAR (constants once connector-kind catalogue exists) |
| `companyId` (via account_id) | AVAILABLE FROM SUGAR (99.5% join) |
| `productKey` (via product_template_id) | AVAILABLE FROM SUGAR, with 1.4% orphan / 2.1% null needing `missing_product_mapping` handling — DERIVABLE SAFELY for the resolvable 96.5%, MISSING for the rest |
| `state` | BUSINESS CONFIRMATION REQUIRED + LIVE API VERIFICATION REQUIRED — ~99.5% null/mis-populated in the sanitized evidence; whether a healthier field exists in the live tenant (vs. the historical export) is unverified. Safe fallback: ingest as `unknown` (see §8) |
| `startsAt` / `endsAt` | BUSINESS CONFIRMATION REQUIRED — multiple candidate source fields (`service_start_date` vs `revenue_start_date_c`, `service_end_date` vs `date_support_expires`); which is canonical is a Juniper business decision, not a technical gap |
| `quantity` | DERIVABLE SAFELY if a quantity-like field is confirmed present (not independently profiled by prior discovery; flagged LIVE VERIFICATION REQUIRED for exact field name) |
| `sourceUpdatedAt` (= RLI.date_modified) | AVAILABLE FROM SUGAR |
| `recordState` (tombstone, = RLI.deleted) | AVAILABLE FROM SUGAR — fixture `14_deleted_tombstoned_record.csv` demonstrates exactly this shape |
| `fieldHash` / `lastChangeId` / `observedAt` / `firstSeenAt` / `lastSeenAt` | DERIVABLE SAFELY — computed by the ingestion pipeline itself, not sourced from Sugar at all |

---

## 8. State-gap assessment

Given RLI.status ~99.5% null/mis-populated: **M8 can safely ingest Sugar RLI
rows with `Subscription.state = 'unknown'`.** This is not a workaround bolted
on for Sugar — `state`'s enum already includes `unknown` as a first-class
member (schema.prisma:276) and the canonical-extension doc's authority model
(§11) is explicitly designed for exactly this situation: `subscription_ownership`
is a business fact with **one authoritative source**; if Sugar is not that
source (or not authoritative for `state` specifically), the mapping simply
does not write a confirmed state from Sugar, and the row carries `unknown`
until an authoritative source is configured. Eligibility/coverage semantics
already treat `unknown` safely: ADR 0018 / canonical-extension §13 states "no
row → unknown... empty → unknown... precedence stays fail > unknown >
eligible" — an unknown-state subscription cannot silently grant eligibility,
it can only ever be conservative. No eligibility-gating code needs to change;
this is existing, tested M7 behaviour being exercised by a source with poor
state data, exactly as designed.

---

## 9. Renewal-gap assessment

The two competing renewal mechanisms (`renewal_parent_id` chain vs. new
Opportunity-per-renewal, ~34% each) do **not** require M7 to understand
renewal mechanics at ingestion time. `TenantSubscription` has no renewal
concept at all — each RLI becomes one independent source-fact row keyed by
its own `sourceRecordId`. Per the stated principle ("source lines remain
source facts; do not collapse/dedupe renewal lines unless business semantics
prove duplication") and per ADR 0017's "ownership is derived, never stored":
both a renewal chain and a fresh-Opportunity pattern simply produce multiple
Subscription rows for the same company/product, which `TenantSubscription`
already supports with no uniqueness conflict (§3 above). The renewal
fixtures (`04_renewal.csv`, `05_expired_plus_active_renewal.csv`) are
representable today: each RLI ingests as its own row; whichever is "current"
is a question for ownership-derivation logic to answer at read time, not for
ingestion to resolve by collapsing rows. **The current Subscription model
already handles this safely** — no code change identified.

---

## 10. Source-authority fit

"Sugar strong for identity/product/line, not proven for subscription-state
authority" maps directly onto the approved authority architecture (§11 of the
design doc): authority is declared **per business fact**, not per source as a
whole. A tenant configuration such as "Sugar authoritative for
`subscription_ownership` (lines, states, terms)" could in principle be
declared, but the prior evidence (99.5% null state) argues against declaring
Sugar authoritative for the `state` portion of that fact specifically today —
this is exactly the kind of split the design doc anticipates (§11: "if
discovery shows split authority... each half is a different fact"). A
configuration like "Sugar authoritative for commercial line facts (lines,
dates, product, quantity), another future source authoritative for
subscription state" is representable **without core redesign**, but it would
currently require treating `subscription_ownership` state as a separate fact
from the rest of the line (field-level precedence within one fact is
explicitly deferred per §11: "Field-level precedence between two sources for
the **same** fact is deferred until evidence requires it"). This report does
not decide what the other source is; it only confirms the mechanism can
express the split once the authority-per-fact granularity needed is confirmed
during M8 design (an open question already listed in the design doc, item 1).

---

## 11. Connector architecture fit

Real interfaces found: `domain/crm-reader.ts` (`CrmReader`, kinds
`person|company|lead`), `modules/crm` (`CrmConnector.forTenant`, DI token
`CRM_CONNECTOR`), `HubSpotCrmReader` (ADR 0010). This is **HubSpot-specific
plumbing** (OAuth token lifecycle, HubSpot object-name mapping) wrapped
behind a thin vendor-neutral `CrmReader` port that only covers
person/company/lead reads for context processing (M3–M6 purpose).

The canonical-extension doc (§5) is explicit that Sugar should **not** try to
squeeze into `CrmReader` as its primary contract: "The existing `CrmReader`
(M3–M6) stays as the CRM specialization used by context processing; the new
generic contract sits alongside it and HubSpot can implement both." The
generic connector port (`testConnection`, `describeSchema`, `readRecords`,
`readRecord`, `capabilities`, restricted `previewRecords`) is designed for
subscription-source connectors like Sugar and does not yet exist in code —
it is a documented M8 deliverable. Reusable from HubSpot's build: the
`ConnectorError`/retryable pattern, the OAuth grant-store pattern (ADR 0010
§3–6, AES-256-GCM, advisory-lock single-flight refresh) if/when Sugar uses
OAuth, and the dependency-cruiser boundary-rule pattern
(`business-code-uses-crm-port`) extended to a Sugar-equivalent rule. Sugar
should implement the new generic connector port, not the existing `CrmReader`
specialization — it is a subscription-line source, not a context-processing
identity source in the M3–M6 sense (though its Account/Contact reads do also
feed identity via the generic port's `identity` mapping entries, §7 of the
design doc).

---

## 12. Historical Sugar code reuse classification

| Old code area | Classification | Why |
|---|---|---|
| OAuth2 password-grant auth | PORT-REWRITE | Current docs prefer `refresh_token` grant; old client re-authenticates with password every time — works but not best practice, and the real connector-kind/generic-port design expects a capability-declared auth flow, not vendor-specific inline logic in the adapter's hot path |
| Pagination (`max_num`/`offset`, stop on short page) | REUSE KNOWLEDGE | Matches `readRecords(object, page, {fields, since})`'s expected shape directly; the offset-pagination mechanics can be ported largely as-is into the adapter |
| `date_modified` incremental filter | REUSE KNOWLEDGE | Matches `capabilities()`'s "incremental reads" and `since` parameter exactly |
| Schema discovery (`/{module}/fields`) | REUSE KNOWLEDGE | Direct precedent for `describeSchema()`; needs re-validation against current API version live, but the call shape is known |
| Metadata discovery generally | REUSE KNOWLEDGE | Same reasoning |
| Relationship reads (polymorphic `parent_id`/`parent_type`, direct FKs on Notes) | PORT-REWRITE | Old code never joins these into subscription lines in the connector-port sense; the junction/relationship-encoding logic needs to be written against the new `relationship` mapping-entry kind (§7 of design doc), using the old code only as a reference for which fields exist |
| Delta/incremental sync orchestration (`sync_orchestrator.py`) | DO NOT REUSE | Tightly coupled to CSV+S3+Gainsight output, not the platform's checkpoint model (`TenantSyncCheckpoint`); the *concept* (date-filtered delta) is reusable knowledge, the code is not |
| CSV generation (`csv_generator.py` / `enhanced_csv_safe_writer.py`) | DO NOT REUSE | The design doc's ingestion path is connector → mapping → canonical Subscription rows directly; there is no CSV intermediate in the target architecture (CSV import exists only as a separate operator/fixture path, §22 line 656) |
| S3 upload (`s3_uploader.py`/`custom_s3_uploader.py`) | DO NOT REUSE | No S3/file-drop step in the target pipeline at all |
| Gainsight field mappings (YAML) | DO NOT REUSE as code, REUSE KNOWLEDGE as a field-naming reference | The YAML declarative-mapping *idea* is philosophically aligned with the new mapping-version model (both are declarative, versioned-ish config), but the implementation (Pydantic YAML loader, Gainsight-specific targets) does not fit the new mapping-entry/catalogue/transform model (§7–8) and should not be ported as code |
| Config-driven field-mapping pattern generally | REUSE KNOWLEDGE | Validates that Sugar's field set is stable enough for declarative mapping — directly supports confidence in the new mapping-version design, even though the old YAML schema itself isn't reused |

---

## 13. Fixture suitability for M8 adapter tests

The 16 synthetic fixtures (branch `spike/sugarcrm-local-discovery`, commit
`1f51cde`, `fixtures/sugarcrm/sanitized/`) are well-suited as a starting set
for future adapter/mapping/ingestion tests, mapped against what they'd
exercise:

- **Connector extraction / basic mapping**: `01_normal_case.csv` (clean
  single-line case), `02_several_products.csv` (multiple products per
  account), `03_multiple_lines_same_product.csv` (tests the "no 1:1
  constraint" Subscription design directly, §3 above).
- **Subscription ingestion edge cases**: `08_future_dated_line.csv`,
  `13_conflicting_dates.csv` (exercises `invalid_value` data-quality code),
  `11_duplicate_source_line.csv` (exercises dedupe-on-load / the
  `(sourceSystem, sourceObjectType, sourceRecordId)` unique constraint,
  line 299), `14_deleted_tombstoned_record.csv` (exercises `recordState`).
- **Unknown state**: `07_unknown_status.csv` directly exercises §8 above.
- **Renewals**: `04_renewal.csv`, `05_expired_plus_active_renewal.csv`
  directly exercise §9 above.
- **Missing product / orphans**: `10_orphan_product.csv`,
  `12_missing_product_id.csv` (exercise `missing_product_mapping`/
  `unresolved_relationship`), `09_orphan_opportunity.csv` (exercises
  `unresolved_relationship` for the account-less-opportunity case, relevant
  once/if Opportunity becomes canonical).
- **Coverage/eligibility inputs**: `15_one_time_product_line.csv`,
  `16_recurring_product_line.csv` distinguish one-off vs recurring
  commercial lines — useful for whatever `quantity`/billing-cadence mapping
  decision is eventually confirmed, though neither canonical Subscription nor
  eligibility currently has a first-class "recurring" concept, so these two
  are presently only structurally useful (they don't map to an existing
  field) until that's decided.
- **Not covered by the fixture set**: multi-account identity-conflict
  scenarios (shared email across systems, M11 concern), schema-drift
  scenarios, and authority-conflict scenarios (§11) — these would need new
  fixtures once the mapping/authority model is actually built in M8/M9.

No real data is referenced or needed; fixture IDs already use the synthetic
`FIX-<entity>-<nn>` convention.

---

## 14. M8 architecture implications

**Generic, buildable now (source-agnostic, per the design doc's own M8
scope):**
- Connector-kind catalogue replacing the closed `ExternalSystem`/`MappedSystem`
  enums, and source connections (tenant, connection id, kind, label, status).
- The generic connector port (`testConnection`, `describeSchema`,
  `readRecords`, `readRecord`, `capabilities`) with a mock/reference adapter.
- Schema snapshots (immutable, hashed, metadata-only).
- Mapping versions limited to `identity|core|relationship|ignored` entry
  kinds for `account`, `subscription`, `product_reference`, with the closed
  transform set and mandatory base version.
- Authority declaration for `subscription_ownership` (single source, no
  precedence).
- Mapping version recorded in provenance; migration retiring
  `tenant_field_mappings`.

**Sugar-specific, implementable from existing evidence now:**
- Account/Contact/RLI/ProductCatalogue object mappings and `identity` entries
  (Accounts.id, Contacts.id, ProductCatalogue.id, RLI.id) — identity shape is
  proven by prior join-rate evidence.
- `relationship` entries for account_id/opportunity_id/product_template_id
  — join rates are proven (99.2–100%, with known orphan/null rates to codify
  as data-quality codes).
- Tombstone (`deleted`) → `recordState` mapping.
- `core` mapping skeletons for `startsAt`/`endsAt`/`quantity` fields, pending
  the specific source-field choice (§7).

**Must stay behind a live-verification gate** (per the discovery evidence
report's own flags, now re-confirmed against the real architecture):
- Current Sugar API version support (`v11_20` assumption), `/ping`
  connectivity-test endpoint, exact `describeSchema`-equivalent shape on the
  live tenant, refresh-token-grant availability, rate-limit/retry semantics.
- Whether a cleaner `state`-equivalent field exists on the live tenant beyond
  what the historical/sanitized evidence showed.
- Exact `quantity` field name/presence on RLI.

**Must stay behind a Juniper-business-confirmation gate:**
- Which date fields are canonical `startsAt`/`endsAt` (multiple candidates).
- Whether Sugar is declared authoritative for `subscription_ownership` at all,
  or only for the commercial-line portion of it, pending resolution of the
  renewal-mechanism ambiguity and the state-null problem.
- Whether/how the two renewal mechanisms should influence ownership-derivation
  logic (a read-time concern, not an ingestion-time one, per §9).
- Value-map policy for `sales_stage`/`status` → canonical `state` enum, if/when
  a usable source field is confirmed.

---

## 15. No-rework assessment

**If M8 uses Sugar as the first reference adapter, core infrastructure would
not need redesign later for a Salesforce + Snowflake customer.** Grounded in
the real architecture: the generic connector port (§5 of the design doc) is
explicitly vendor-neutral — `describeSchema`/`readRecords`/`capabilities`
have no Sugar-specific shape baked in; Sugar's offset-pagination and
`date_modified` filter happen to fit the port well, but the port itself is
defined by capability declaration (`capabilities()` says whether incremental
reads, deletes, webhooks are supported), not by assuming any one vendor's
pagination style. The portability table in the design doc (§20) states this
directly: "No core code is forked per customer. What varies: adapters... and
tenant configuration." The mapping model (object/field mappings, transforms,
authority) is entirely data per connection, not code. The one structural
change required for Sugar — replacing the closed `ExternalSystem` enum with a
connector-kind catalogue — is required for **any** second source, not
something Sugar specifically forces; it was already an acknowledged,
planned, generic M8 change before this alignment review, independent of
which source comes first. No Sugar-specific field names, picklist values, or
quirks leak into the canonical model or the generic port under this design.

---

## Explicit verdicts

- **Does M7 require changes?** **NO.** Every real Sugar finding (multi-line
  accounts, null state, renewal ambiguity, orphan products) is already
  representable by the existing `TenantSubscription`/`Company`/`TenantProduct`
  shape, including the pre-existing `unknown` state value and the absence of
  a stored-ownership field. M7 contract holds.
- **Is Sugar suitable as M8's first reference adapter?** **YES.** Its
  identity fields (Account.id, Contact.id, Product.id, RLI.id) are strong and
  match the external-reference model exactly; its pagination/incremental-read
  pattern matches the generic connector port's expected shape; its known data
  problems (null state, renewal ambiguity, product orphans) are exactly the
  cases the design doc's `unknown`-state and data-quality-code machinery was
  built to absorb, not cases that break it.
- **Is Sugar proven as sole subscription authority?** **NO.** Identity,
  product and line-level facts are strong; `state` (subscription_ownership's
  state component) is unproven — ~99.5% null/mis-populated in the evidence
  reviewed, and no live-tenant verification has resolved whether a healthier
  field exists. Authority for `state` specifically should not be declared for
  Sugar without either live verification turning up a usable field or an
  explicit Juniper business decision to accept `unknown` indefinitely for that
  component.

## Biggest canonical-model gap found

**None that requires a schema or ADR change.** The closest thing to a gap is
not in the canonical model itself but in the *design doc's own open
question* (§ "Open questions", item 1): authority is currently declared at
the whole-fact level (`subscription_ownership` as one fact), but Sugar's
evidence suggests a split is likely (strong for lines/product/dates, unproven
for state) — finer-grained authority (field-level precedence within one
fact) is explicitly deferred in the design doc "until evidence requires it."
This review's evidence arguably is that trigger, but resolving it is a scope
decision for M8 design, not a defect to fix now.

## Final recommendation

Proceed to M8 design treating Sugar as the first reference connector/adapter,
building the generic connector port, schema snapshot, and mapping-version
machinery exactly as scoped in `canonical-extension-and-source-mapping.md`
§23 ("Implemented in M8" row). Do not declare Sugar authoritative for
`subscription_ownership` as a whole fact until either (a) live API
verification finds a usable state-equivalent field, or (b) Juniper
explicitly confirms acceptance of `unknown` state for Sugar-sourced lines
pending a future state-authoritative source. Treat the renewal-mechanism
ambiguity as a read-time/ownership-derivation concern, not an ingestion
blocker. No M7 rework, no canonical schema change, and no premature
attribute-registry build-out are needed to start M8 with Sugar.
