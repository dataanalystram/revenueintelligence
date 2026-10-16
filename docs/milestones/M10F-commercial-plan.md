# Milestone 10F — Commercial: Price/Offer, Contract, Entitlement, line commercial references (canonical `0.6`, module `commercial`): implementation plan

- Status: **PROPOSED PLAN (2026-10-16).** No schema, migration or code change has been made for M10F.
  Implementation follows `BUILD → TEST → VERIFY → MUTATION PROOF → FRESH CLONE → RUNTIME → DOCKER → INDEPENDENT
REVIEW → USER APPROVAL → MERGE`, on a fresh branch from `integration`.
- Every open question (§27) carries a **recommended default**. Owner instruction (2026-10-14): building all M10
  sub-milestones is approved and the recommended defaults apply **unless the owner overrides them**; each is marked
  `DEFAULT`.
- Parent: [M10 plan](M10-canonical-architecture-implementation-plan.md) (approved, revision 3: D1–D6, F1–F5), §2
  (Commercial row: `tenant_price_offers`, `tenant_contracts`, `tenant_contract_links`, `tenant_entitlements`), §3
  (`tenant_subscriptions` additive columns), §4 (AccountContext and Commercial before Signal / Opportunity), §5 row 7
  (`m10f_commercial`), §6 (entitlements stay informational), §10 (value-history fields "Subscription `contract_id`",
  "Contract status / dates"), §15.0 and §15 (M10F), §16 (financial category floor), §17 (module `commercial`), §18
  (scope rule F2: line → contract and contract → contract are **direct** composite FKs).
- Predecessors: [M10A1](M10A1-security-foundation.md) (ADR 0026), [M10A2](M10A2-canonical-versioning-governance.md)
  (ADR 0027), [M10B](M10B-source-reference-evidence-link.md) (ADR 0028), [M10C](M10C-account-hierarchy-affiliation.md)
  (ADR 0029), [M10D](M10D-extension-framework.md) (ADR 0030, incl. hardening #83, PR #110),
  [M10E](M10E-account-context.md) (ADR 0031, incl. hardening #90, PR #115).
- Candidate input (the only source of entity fields in this plan):
  [E3 §4 Subscription (line), §4.1 `agreement_ref`, §4.2 line ↔ Contract cardinality, §13 Commercial module, §14
  relationship matrix](../architecture/canonical-v1/03-entity-specifications.md);
  [E1 inventory rows 27–29](../architecture/canonical-v1/01-inventory.md);
  [E2 promotion rule (Commercial)](../architecture/canonical-v1/02-classification-and-promotion-rule.md);
  [E4 extension targets and categories](../architecture/canonical-v1/04-extension-framework.md);
  [E5 §4 history policies (Contract status / dates)](../architecture/canonical-v1/05-source-reference-and-provenance.md);
  [E8 pressure-test matrix](../architecture/canonical-v1/08-pressure-test-matrix.md) (Chargebee ItemPrice →
  Price/Offer, Subscription → Contract header + `agreement_ref`; Salesforce PricebookEntry / Contract / Asset; Stripe
  Price / Subscription); [E11 consistency check](../architecture/canonical-v1/09-e11-consistency-check.md) items 4–5;
  [CANDIDATE](../architecture/canonical-v1/CANDIDATE.md).
- Source evidence in the repository (no other source field is referenced): the Chargebee reference adapter
  (`apps/api/src/modules/chargebee`, ADR 0024) declares `ItemPrices` (`id`, `item_id`, `item_type`, `status`,
  `currency_code`, `period`, `period_unit`, `price_variant_id`, `pricing_model`, `updated_at`), `Subscriptions`
  (`id`, `customer_id`, `status` ∈ `future` / `in_trial` / `active` / `non_renewing` / `paused` / `cancelled` /
  `transferred`, `start_date`, `current_term_start`, `current_term_end`, …) and `SubscriptionItems`
  (`subscription_id`, `item_price_id`, …). **It does not declare an item-price amount** (Q9). HubSpot and SugarCRM
  carry no commercial header today; E3 §4.1 names a Sugar RLI's opportunity id as the example of a grouping that must
  **not** become an `agreement_ref`.
- Base: `integration` at `bb2ce79` (merge of PR #115, M10E hardening #90; includes M10E PR #93, M10D hardening #83
  PR #110). `main` stays untouched. This plan's PR targets `integration`.
- Two acceptance sections apply: `Canonical / business correctness` (§22) and `Security & Data Governance` (§23).
- No SOC 2, GDPR, HIPAA, ISO 27001, PCI or legal-retention claim is made. M10F builds technical foundations only.
  Invoices and payments stay out (E8: payment-sensitive, source-specific).
- Canonical version after M10F: **`0.6`** (M10 plan §15.0). Module `commercial` becomes **available** at `0.6` and
  stays **disabled by default** for every tenant.
- **No customer schema is invented.** No price offer, contract, entitlement, currency list, status map or source
  field is seeded. The Chargebee mapping is a TEST configuration fixture over the declared fields above; unknown
  source semantics stay `tbc` (CLAUDE.md).
- ADR: following the M10A1–M10E pattern, **no ADR is drafted with this plan**. ADR **0032** (Commercial module,
  canonical `0.6`) is written during implementation (Q28).

## 0. What exists today (`IMPLEMENTED TODAY`, from inspection of `integration` `bb2ce79`)

| Area                 | Fact                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commercial storage   | **None.** No price-offer, contract or entitlement table; `tenant_subscriptions` has no `agreement_ref_*`, `contract_id`, `price_offer_id` or `supersedes_line_id`. Chargebee item prices exist only inside the line key `<subscription_id>:<item_price_id>`; the header status is copied to each line (E8).                                                |
| Subscriptions        | `tenant_subscriptions` PK `(tenant_id, id)`, unique `(tenant_id, source_system, source_object_type, source_record_id)`, composite FKs to `companies`, `tenant_products (tenant_id, key)`, `connector_kinds`, and (M10E) `tenant_account_contexts` via `context_id`; deferred line ↔ context same-account guard on both tables (M10E D2).                   |
| Modules              | `canonical_modules` row `commercial`: `available = false`, `minimum_canonical_version NULL`, `depends_on []`. `opportunities` and `value` already declare `depends_on ['commercial']`. `account_context` available at `0.5`, `extension` at `0.4`.                                                                                                         |
| Canonical versions   | `0.1`–`0.4` `supported`, `0.5` `current` (ADR 0031); frozen `_0_1` / `_0_3` / `_0_4` catalogue lists reproduce stored hashes.                                                                                                                                                                                                                              |
| Registry kinds       | `data_policy`, `extension`, `context_type` available; `signal_type`, `metric`, `action_type` reserved. No commercial registry kind exists or is planned (§2).                                                                                                                                                                                              |
| Entity index         | kinds `company`, `person`, `product`, `subscription`, `person_affiliation`, `custom_record`, `account_context`.                                                                                                                                                                                                                                            |
| Authority (ADR 0020) | required `account_profile`, `person_profile`, `subscription_lines`, `subscription_state`, `subscription_terms`; optional `account_hierarchy` (M10C), `account_context` (M10E).                                                                                                                                                                             |
| Value history        | fields `company.{name,parent_company_id}`, `person_affiliation.*`, `subscription.{state,starts_at,ends_at,product_key,quantity,context_id}`, `account_context.{owner_ref,status}`. `decideValueHistory` records values unless `isSensitiveForHistory` (restricted, or category `personal` / `communication` / `security`).                                 |
| Classification       | categories include `financial` and `commercial`; category floor `financial → confidential`; line `starts_at` / `quantity` are `internal` / `commercial`; M10E `renewal_date` is `confidential` / `financial`.                                                                                                                                              |
| Security             | `POLICY_VERSION = 7`; capabilities include `canonical.source_sync`, `canonical.human_entry`, `data.account_context.read`, `data.account_context.read_confidential` (held **only** by explicit grant: `GRANTABLE_CAPABILITIES`, `tenant_capability_grants`, CHECK `capability IN ('data.account_context.read_confidential')`), `security.capability.grant`. |
| Runtime              | `scripts/verify-runtime.d/` ends at `90-account-context.sh`.                                                                                                                                                                                                                                                                                               |
| Latest migration     | `20270126130000_m10e_h90_confidential_read_grants`.                                                                                                                                                                                                                                                                                                        |

## 1. Scope

1. Tables `tenant_price_offers`, `tenant_contracts` (with the three Contract → Contract links), `tenant_entitlements`,
   and `tenant_subscriptions` columns `agreement_ref_system`, `agreement_ref_object_type`,
   `agreement_ref_external_id`, `contract_id`, `price_offer_id`, `supersedes_line_id` — §3.
2. Structural invariants in the database (composite tenant FKs, deferred same-account / same-product guards, acyclic
   contract graph and line lineage, money pairs) — §3, §4.
3. Writers: `PriceOfferWriter`, `ContractWriter` (incl. links), `EntitlementWriter`, and line commercial references in
   the single line writer path — §5.
4. Mapping blocks `priceOffer`, `contract`, `entitlement`; line targets `subscription.agreement` (human-confirmed)
   and `subscription.priceOfferRef`; resolution `agreement_ref → Contract source reference → contract_id` — §6.
5. Classification (financial / confidential), declared value-free history for financial columns, and capability-gated
   confidential reads (`data.commercial.read_confidential` by explicit grant) — §7, §16.
6. Module gate `commercial`, canonical `0.6`, policy v8, adoption / rollback behaviour — §11, §16.
7. Merge participants, read models, CLI, integrity checks, runtime script `91-commercial.sh`.

## 1.1 Non-goals

- **Ownership, eligibility, whitespace and coverage are untouched.** Price offers never affect ownership; entitlements
  never affect eligibility in M10 (a later evaluator version decides, M10 §6). Enforced structurally by a
  dependency-cruiser boundary (§13), not only by tests.
- No Order (E3 §13: `DEFERRED`, extension), no invoices, payments, credit notes, discounts or coupons (no canonical
  field exists for them; E8 marks invoices / payments payment-sensitive).
- No tiered / volume price **tiers** (only the `pricing_model` code); no usage rating; no currency conversion; no ARR /
  MRR or contract-value derivation (value estimates belong to later milestones).
- No renewal-window **signals** (E3 §13 says they derive from Contract; Signals are M10G / M11).
- No contract merge and no automatic contract inference from lines (a contract exists only from a mapping or an
  operator command).
- No line-level many-to-many to contracts (E3 §4.2 conclusion).
- No new registry kind (§2).
- No live write to any source. Chargebee is read-only on the TEST site.
- No context-level or role-based permission model (M15); only the explicit-grant confidential read (§16).

## 2. Registry kinds

`DEFAULT` **none added** (Q3). Pricing model, billing period unit, contract status and entitlement status are small,
vendor-neutral canonical vocabularies fixed by E3 §13; they are closed column enums in the canonical catalogue (frozen
per version), not tenant-published registry entries. Tenant-specific vocabulary (contract tier, order type, …) stays an
extension field (E2: "contract tier" stays extension). A source status reaches a canonical status only through the
mapping's closed `valueMap` transform (ADR 0020).

## 3. Schema (one migration, §12)

All new tables tenant-owned, `tenant_id` first in every key, **forced RLS** with the tenant policy, tenant-id
immutability trigger, entity-index triggers, privileges from the manifest (SELECT / INSERT / UPDATE only; **no
DELETE**). Every relation is a **direct composite tenant FK** (F2) except polymorphic targets (source references,
evidence, extension values), which use the entity index.

### 3.1 `tenant_price_offers` (entity kind `price_offer`)

`(tenant_id, id uuid, product_key, currency, billing_period, billing_period_unit, pricing_model, list_amount_minor,
status, record_state, created_at, updated_at, last_change_id)`

- PK `(tenant_id, id)`; composite FK `(tenant_id, product_key) → tenant_products (tenant_id, key)`;
- identity: platform UUID plus source references (E3 §13); **no natural key** (Q5);
- CHECKs: `currency ~ '^[A-Z]{3}$'` (ISO 4217 shape, not a list); `billing_period IS NULL OR billing_period > 0`;
  `billing_period_unit IN ('day','week','month','year')` or NULL, and `billing_period` / `billing_period_unit` both or
  neither; `pricing_model IN ('flat','per_unit','tiered','volume','usage')` or NULL (Q8); `list_amount_minor bigint`
  `>= 0` or NULL; `status IN ('active','retired')`; `record_state = 'active'`;
- identity guard trigger: `product_key` immutable once any line references the offer (Q10).

### 3.2 `tenant_contracts` (entity kind `contract`)

`(tenant_id, id uuid, company_id, context_id, starts_at, ends_at, renewal_date date, auto_renew boolean, status,
total_value_minor, total_value_currency, renews_contract_id, amends_contract_id, parent_contract_id, record_state,
created_at, updated_at, last_change_id)`

- PK `(tenant_id, id)`; composite FKs `(tenant_id, company_id) → companies`; `(tenant_id, context_id) →
tenant_account_contexts` (nullable; module `account_context` must be enabled to set it, Q13);
- **Contract → Contract links as columns** (Q6): three nullable composite self-FKs
  `(tenant_id, renews_contract_id)`, `(tenant_id, amends_contract_id)`, `(tenant_id, parent_contract_id) →
tenant_contracts (tenant_id, id)`. One column per kind makes "0..1 each" (E3 §14) structural; CHECKs that none
  equals `id`;
- CHECKs: `status IN ('draft','active','expired','terminated','unknown')` (E3 §13); `ends_at IS NULL OR starts_at
IS NULL OR ends_at >= starts_at`; money pair `(total_value_minor IS NULL) = (total_value_currency IS NULL)`,
  `total_value_minor >= 0`, currency shape as §3.1; `record_state = 'active'` (no contract merge, Q14);
- **acyclic link graph** (Q7): a constraint trigger refuses any insert / update of a link column that would close a
  cycle over the **union** of the three link kinds (walk ceiling 64, M10C pattern), serialised by the tenant advisory
  lock `('contract-graph', tenant)`; REPEATABLE READ / SERIALIZABLE refused in the guard (M10C / M10E pattern);
- **same-account links** (Q12): deferred constraint trigger: a linked contract's `company_id` equals this contract's;
  fires on both ends (a company merge re-points every contract in one transaction);
- **context same-account**: deferred guard (both tables) that `context_id`'s company equals `company_id` (M10E D2
  pattern).

### 3.3 `tenant_entitlements` (entity kind `entitlement`)

`(tenant_id, id uuid, company_id, product_key, quantity, status, starts_at, ends_at, record_state, created_at,
updated_at, last_change_id)` — E3 §13 fields only.

- PK `(tenant_id, id)`; composite FKs to `companies` and `tenant_products (tenant_id, key)`;
- CHECKs: `quantity IS NULL OR quantity >= 0`; `status IN ('active','inactive','expired','unknown')` (Q15);
  `ends_at >= starts_at` when both set; `record_state = 'active'`.
- **Informational only**: no reader in products / eligibility (boundary rule §13).

### 3.4 `tenant_subscriptions` additive columns (Core `agreement_ref`, module references)

- `agreement_ref_system` (FK `connector_kinds (kind)`), `agreement_ref_object_type`, `agreement_ref_external_id`:
  **all-or-none CHECK** (M10 §3); lengths bounded like the line `source_*` columns. An attribute, never an identity,
  never a source-reference row (E3 §4.1). `agreement_ref` is **Core** (CANDIDATE: "Subscription line
  (+ `agreement_ref`)"), so it is written at canonical ≥ `0.6` **without** the module (Q2).
- `contract_id`: composite FK `(tenant_id, contract_id) → tenant_contracts`; **deferred same-account guard** on both
  tables (line `company_id` = contract `company_id`).
- `price_offer_id`: composite FK `(tenant_id, price_offer_id) → tenant_price_offers`; **deferred same-product guard**
  on both tables (line `product_key` = offer `product_key`, Q10).
- `supersedes_line_id`: composite self-FK `(tenant_id, supersedes_line_id) → tenant_subscriptions (tenant_id, id)`;
  CHECK `<> id`; deferred same-account guard; acyclic trigger (walk ceiling 64) under the advisory lock
  `('line-lineage', tenant)` (Q11).
- Indexes `(tenant_id, contract_id)`, `(tenant_id, price_offer_id)`, `(tenant_id, agreement_ref_system,
agreement_ref_object_type, agreement_ref_external_id)` (resolution, §6.3).

### 3.5 Widened catalogues

- `tenant_entity_index` kinds + `price_offer`, `contract`, `entitlement`; `tenant_source_references.entity_kind` +
  the same three;
- `tenant_context_changes.entity_kind` + `price_offer`, `contract`, `entitlement`; change **types not widened**
  (catalogue hash; links and line references are field changes of existing types);
- `tenant_value_history_field_valid` + the §9 fields;
- `tenant_identity_conflicts.kind` + `contract_reference_unresolved`, `price_offer_reference_unresolved`,
  `contract_company_mismatch`, `price_offer_product_mismatch`, `contract_link_cycle_refused`,
  `contract_link_cross_account`, `contract_duplicate_source`, `commercial_human_override_disagrees`;
- M10D extension target CHECKs + `price_offer`, `contract`, `entitlement` (E4 lists `contract` as a target; Q21);
- `tenant_capability_grants.capability` CHECK + `data.commercial.read_confidential` (§16);
- audit capability / action CHECKs widened (policy v8).

## 4. Structural invariants and concurrency (lessons from M10D #83 and M10E #90)

Every invariant below is held **by the database**, with the writer check as the friendly first line; each has a
two-session concurrency test where a race is possible.

| Invariant                                    | Database mechanism                                                                         | Race test (two independent sessions)                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| tenant of every relation                     | composite FKs including `tenant_id`                                                        | — (adversarial raw SQL as app role)                                                     |
| line ↔ contract same account                 | deferred constraint trigger on `tenant_subscriptions` **and** `tenant_contracts`           | contract re-pointed to another account while a line is assigned to it                   |
| line ↔ price offer same product              | deferred trigger on both tables; offer `product_key` immutable once referenced             | offer product changed while a line is assigned                                          |
| contract graph acyclic (union of 3 kinds)    | constraint trigger + advisory lock `('contract-graph', tenant)`; RR / SERIALIZABLE refused | A `renews` B and B `renews` A committed concurrently → exactly one refused              |
| contract links same account                  | deferred trigger, both ends                                                                | link created while the target's account is merged away                                  |
| line lineage acyclic                         | constraint trigger + advisory lock `('line-lineage', tenant)`                              | two lines superseding each other concurrently → one refused                             |
| 0..1 contract / offer / predecessor per line | single column (structural)                                                                 | —                                                                                       |
| 0..1 of each contract link                   | single column per kind (structural)                                                        | —                                                                                       |
| money pair, currency shape, amount ≥ 0       | CHECKs                                                                                     | —                                                                                       |
| one source reference → one record            | M10B unique source-reference key (existing)                                                | two syncs creating the same Chargebee subscription header → one contract, one `created` |
| no DELETE                                    | privilege manifest (REVOKE), schema guard                                                  | —                                                                                       |

**Lock order (Q16)**, used by every writer, the resolution pass and the merge participants, documented in ADR 0032 and
asserted by a deadlock test: (1) tenant advisory locks in the fixed order `contract-graph` → `line-lineage`; (2)
contract rows by ascending `id` (`FOR UPDATE`); (3) price-offer rows by ascending `id`; (4) line rows by ascending
`id`. Company merge (M10C participant order) takes the same order after its own company locks. No writer takes a
contract lock after holding a line lock.

## 5. Writers

All writers: gate = adopted ≥ `0.6` **and** module `commercial` enabled (`canonical_version_too_low` /
`module_disabled`, both audited); change record per write; source reference via the generic store (M10B); secret-like
refusal (M10A1) on every string; source writes need `canonical.source_sync` plus the authority fact (§6.4); operator
writes need `canonical.human_entry` and write one audit event with a code-token reason (tech debt #79). Values never
appear in audit details, logs, metrics or errors.

### 5.1 `PriceOfferWriter` (single writer of price offers)

Upsert by source reference or by id (operator). Validates product key exists (any status; a retired product keeps its
offers), currency shape, period pair, closed codes. `status = 'retired'` never touches lines (they keep
`price_offer_id`; new assignments to a retired offer refused).

### 5.2 `ContractWriter` (single writer of contracts and their links)

Upsert by source reference or id. Links (`renews` / `amends` / `parent`) set from mapping references (§6.2) or the
operator `contract link` command; a cycle or cross-account link is refused with a conflict row
(`contract_link_cycle_refused` / `contract_link_cross_account`) and the contract is written without that link.
`context_id` only when module `account_context` is enabled (else counted `context_assignment_skipped`). Status changes
never cascade to lines (a `terminated` contract keeps its lines; ownership still reads only lines and terms).

### 5.3 `EntitlementWriter`

Upsert by source reference or id; E3 fields only; informational.

### 5.4 Line commercial references (in the existing single line-writer path)

- `agreement_ref_*` written by `SubscriptionLineWriter` from the confirmed mapping target (Core; module-independent;
  canonical ≥ `0.6`); included in the line `field_hash` **only** when the mapping uses the target (existing mappings
  keep identical hashes — V4).
- `contract_id` / `price_offer_id` / `supersedes_line_id` set by a commercial line-reference step owned by the
  commercial module (M10E D11 pattern: `products` does not import `commercial`), after the line write in the same
  transaction; value history on `contract_id` / `price_offer_id`. Module disabled ⇒ the line is written exactly as
  today and the step counts `commercial_reference_skipped`.
- `supersedes_line_id` only when the source states it (mapping target `subscription.supersedesRef`) or the operator
  sets it; **no deterministic inference rule in M10F** (E3 allows one; deferred, Q11).

### 5.5 Human vs source (Q17)

Operator values win and are sticky until `commercial release` (M10C / M10D Q16 / M10E Q14 pattern, held attributes =
human change records newer than the last release); disagreement recorded as `commercial_human_override_disagrees`.

## 6. Mapping, sync and authority

### 6.1 Entity blocks

Routed like M10E `accountContext` (D12): `MappingEntitySchema` unchanged; new blocks `priceOffer`, `contract`,
`entitlement` (canonical `0.6` mapping catalogue, `canonical_version_min = 0.6`), publish refused below `0.6` or with
the module disabled (`disabledModuleTargets`). Closed transforms unchanged.

- `priceOffer`: `.product` (via the product reference set), `.currency`, `.billingPeriod`, `.billingPeriodUnit`
  (`valueMap`), `.pricingModel` (`valueMap`), `.listAmountMinor`, `.status` (`valueMap`).
- `contract`: `.account` (account source reference), `.context` (context source reference), `.startsAt`, `.endsAt`,
  `.renewalDate`, `.autoRenew`, `.status` (`valueMap`; unmapped → `unknown`), `.totalValueMinor`,
  `.totalValueCurrency`, `.renewsRef` / `.amendsRef` / `.parentRef` (source ids of contracts from the same connection).
- `entitlement`: `.account`, `.product`, `.quantity`, `.status` (`valueMap`; unmapped → `unknown`), `.startsAt`,
  `.endsAt`.

### 6.2 Line targets

- **`subscription.agreement`** (E3 §4.1): maps a source field naming the header record; the entry must carry
  `confirmation: { semantics: 'agreement_header', confirmedBy }` (human confirmation recorded in the mapping version
  and its audit event). Publish **refuses** (`agreement_ref_deal_grouping`) when the field relates to an object, or the
  field / object name matches the closed deal / opportunity token list (`opportunit`, `deal`, `pipeline`, `quote`).
  The token list is a guardrail, not proof; the human confirmation is the control (Q4). The value stored is
  `(connector kind of the connection, related object type, external id)`.
- `subscription.priceOfferRef`: source id of a price offer from the same connection.
- `subscription.supersedesRef`: source id of a line from the same connection (only when the source states lineage).

### 6.3 Resolution `agreement_ref → contract_id` (Q1)

- With the module enabled, the commercial line-reference step resolves `agreement_ref` through
  `tenant_source_references` (entity kind `contract`, same system / object type / external id) to `contract_id`; value
  history records each change (renewal moving a line to another contract, E3 §4.2).
- Unresolved (contract not yet synced) → `contract_id NULL`, conflict `contract_reference_unresolved`; the contract
  sync's **re-resolution pass** (after contracts are written, same run) resolves waiting lines by the §3.4 index, under
  the §4 lock order.
- `agreement_ref` is **never** used as identity, never creates a contract and never creates a source-reference row
  (V12).
- Sync order: accounts → people → contexts (M10E) → **price offers → contracts → lines → entitlements**.

### 6.4 Authority (ADR 0020)

`DEFAULT` three new **optional** facts `price_offer`, `contract`, `entitlement` (frozen in the `0.6` catalogue;
existing authority documents and hashes unchanged, as M10C / M10E). Line `agreement_ref`, `priceOfferRef` and
`supersedesRef` follow `subscription_lines` (as M10E `contextRef`). The writer gate still applies; the fact is decided
by the sync run (M10E D13).

### 6.5 Chargebee TEST mapping example (fixture only)

Over declared fields only: `ItemPrices` → `priceOffer` (`item_id` → product via the existing product reference set;
`currency_code` → `.currency`; `period` / `period_unit` → billing period; `pricing_model` → `.pricingModel` via a TEST
`valueMap`; `status` → `.status`); `Subscriptions` → `contract` (`customer_id` → account; `status` via a TEST
`valueMap` over the seven declared codes; `start_date` → `.startsAt`; `current_term_end` → `.endsAt`);
`SubscriptionItems.subscription_id` → `subscription.agreement` (confirmed); `SubscriptionItems.item_price_id` →
`subscription.priceOfferRef`. No renewal date, auto-renew, total value or list amount is mapped (no declared source
field; `next_billing_at` is billing, not renewal, and is deliberately not mapped).

## 7. Classification (M10A1 / M10 §16)

| Column(s)                                                                         | Sensitivity    | Category      | History (§9)    |
| --------------------------------------------------------------------------------- | -------------- | ------------- | --------------- |
| `price_offers.list_amount_minor`                                                  | `confidential` | `financial`   | `value_free`    |
| `contracts.total_value_minor`, `contracts.total_value_currency`                   | `confidential` | `financial`   | `value_free`    |
| `contracts.renewal_date` (as M10E `renewal_date`)                                 | `confidential` | `financial`   | `value_free`    |
| `price_offers.currency`, `billing_period*`, `pricing_model`, `status`             | `internal`     | `commercial`  | `full` (status) |
| `contracts.starts_at`, `ends_at`, `auto_renew`, `status` (parity with line terms) | `internal`     | `commercial`  | `full`          |
| `entitlements.quantity`, `status`, `starts_at`, `ends_at`                         | `internal`     | `commercial`  | `full`          |
| line `agreement_ref_*`                                                            | `internal`     | `commercial`  | change log      |
| ids, FKs, `record_state`, timestamps                                              | `internal`     | `operational` | —               |

- The schema guard asserts every new column is in the manifest and that every `financial` column is at least
  `confidential` (mutation VM1).
- Extension fields on `price_offer` / `contract` / `entitlement` targets follow the M10D field classification.

## 8. Merge participants

- **Company merge** (`CommercialMergeParticipant`, runs regardless of the gate, M10D / M10E pattern): contracts and
  entitlements re-pointed to the survivor in the §4 lock order; lines are re-pointed by the existing participant in
  the same transaction (deferred guards make the order irrelevant); contract links stay valid (both ends move).
- **Person merge**: no commercial person references.
- **Product key retirement**: price offers and entitlements kept; new ones on a retired key allowed only by the source
  (history), operator create refused.
- **Duplicate contract from two sources** (two source references naming what a human says is one agreement): no merge
  in M10F; `contract_duplicate_source` conflict (Q14).

## 9. Change records and value history

- Existing change types only; entity kinds `price_offer`, `contract`, `entitlement`.
- Value-history fields (M10 §10 "Subscription `contract_id`", "Contract status / dates"):
  `subscription.contract_id`, `subscription.price_offer_id`, `contract.status`, `contract.starts_at`,
  `contract.ends_at`, `contract.renewal_date`, `price_offer.status`, `price_offer.list_amount_minor`,
  `entitlement.status`, `entitlement.starts_at`, `entitlement.ends_at`.
- **Declared history policy honoured (Q18):** `decideValueHistory` additionally returns a **value-free** row when the
  column's manifest `history` is `value_free`, so `renewal_date` and `list_amount_minor` changes are recorded
  (who / when / change id) **without values**. A regression test asserts the decision for every existing value-history
  field is unchanged. `isSensitiveForHistory` is **not** widened in M10F; the existing M10D / M10E gap for
  registry-classified extension fields is tracked as tech debt **#94** (added with this plan).

## 10. Read models and CLI

- `CommercialReadModel`: `priceOffersForProducts(keys)`, `contractsForAccounts(ids, { scope? })`,
  `contract(id)` (with links and line ids), `linesForContract(id)`, `entitlementsForAccounts(ids)`; batch ≤ 500;
  one audit event per call (identifiers and counts). Confidential columns (`list_amount_minor`, `total_value_*`,
  `renewal_date`) are **withheld** unless `includeConfidential` and the caller holds
  `data.commercial.read_confidential` (§16); every result carries the column classification so a later role model can
  hide more.
- CLI `commercial`: `price-offer list|show|write|retire`, `contract list|show|write|link|unlink|retire`,
  `entitlement list|show|write`, `line assign-contract|assign-price-offer|set-supersedes`, `release`;
  `--include-confidential` on reads. Reads need `data.commercial.read`; writes `canonical.human_entry`.

## 11. Canonical version `0.6` and module `commercial`

- `CANONICAL_VERSIONS`: `0.1`–`0.5` `supported`, `0.6` `current` (ADR 0032); migration inserts `0.6` and moves `0.5`
  to `supported` in the order the one-current trigger accepts.
- **Catalogue hash:** `0.6` = `0.5` catalogue + entity kinds `price_offer`, `contract`, `entitlement` (index, change,
  generic reference), mapping blocks `priceOffer` / `contract` / `entitlement`, line targets `subscription.agreement` /
  `.priceOfferRef` / `.supersedesRef`, authority facts `price_offer` / `contract` / `entitlement`, extension targets,
  closed vocabularies (§2). Frozen `_0_5` lists so the **stored `0.1`–`0.5` hashes are reproduced unchanged** (V2).
- `CANONICAL_VERSION_FEATURES['0.6']` = `agreement_ref`, `price_offer`, `contract`, `contract_links`, `entitlement`,
  `line_commercial_refs`.
- Module row: `available = true`, `minimum_canonical_version = '0.6'`, `entity_kinds = ['price_offer', 'contract',
'entitlement']`, `depends_on []` (unchanged; `context_id` on a contract additionally needs `account_context`
  enabled at write, Q13). Disabled by default.
- **Gating (Q2):** commercial writers, mapping blocks, line commercial references and operator commands need adopted
  ≥ `0.6` **and** module enabled; `subscription.agreement` needs only ≥ `0.6` (Core).
- **Adoption:** explicit `canonical adopt --version 0.6 --expected-current 0.5`; dry run lists
  `modulesNewlyAvailable: ['commercial']`; new tenants adopt `0.6` at provisioning (module disabled).
- **Rollback `0.6 → 0.5`** with the module enabled: data kept and readable; writes refused; dry run lists
  `modulesStranded: ['commercial']`; stored `agreement_ref` kept, mappings with `canonical_version_min = 0.6` follow
  the existing M10A2 rule (Q19).
- **Disable** after use: reads allowed, writes refused, line references kept (no silent nulling) (Q20).

## 12. Migration / rollback

One forward migration **`20270202120000_m10f_commercial`** (after `20270126130000`):

1. tables §3.1–3.3 with constraints, indexes, guard / acyclic / immutability triggers;
   `tenant_subscriptions` columns §3.4 + FKs + guards; owner functions added to the schema guard's explicit
   allow-list with fixed `search_path` (M10 §14);
2. kind CHECKs widened (§3.5); authority-document schema accepts the optional facts;
3. `canonical_modules` `commercial` available at `0.6`; `canonical_model_versions` insert `0.6`, `0.5` → `supported`;
4. audit capability / action CHECKs and `tenant_capability_grants` capability CHECK widened (policy v8); forced RLS,
   tenant policy, tenant-id immutability; privileges (`REVOKE ALL`, then manifest grants; no DELETE).

- **No backfill**: no price offer, contract, entitlement or line reference is invented; existing lines get NULLs.
- **Down-script** (dev / staging) refuses while any commercial row, non-null line commercial column, new-kind change /
  conflict / value-history / source-reference / entity-index / extension row, `data.commercial.read_confidential`
  grant, `commercial` module setting or event, or adoption of `0.6` exists; otherwise restores the M10E + #90 state
  exactly (CHECKs, module row, `0.5` `current`, privilege matrix). Production: forward-fix only. Same rollback caveat
  as M10E (new tenants adopt `0.6` at provisioning).
- Migration tests in `migrations-m10f.int.spec.ts` (tech debt #72): up, idempotent rerun, down refusal per data class,
  exact restore, re-apply; Prisma drift test green.

## 13. Backward compatibility and boundaries

- Module disabled (default) and no mapping using a `0.6` target ⇒ every existing flow (sync, eligibility, hierarchy,
  extension, account context, adoption) is byte-for-byte unchanged: same change records, eligibility snapshots,
  mapping hashes, line `field_hash` (V4).
- **Boundary rule (dependency-cruiser):** `products` (ownership, eligibility, whitespace, coverage) must not import
  `commercial`, and no eligibility query reads `tenant_price_offers` / `tenant_entitlements` / `contract_id` /
  `price_offer_id` (static SQL scan in the boundary test). This makes "price offers never affect ownership" and
  "entitlements never affect eligibility" structural (VM10, VM11).

## 14. Tenant isolation

Composite FKs on every relation (offer → product; contract → company, context, contract ×3; entitlement → company,
product; line → contract, offer, line); forced RLS on all three tables; adversarial raw SQL as the app role cannot
create a cross-tenant link of any kind; grants are tenant-scoped (#90 table).

## 15. Integrity verification (extends M10A2–M10E; CLI only, tech debt #65)

`commercial_line_contract_company_mismatch`, `commercial_line_price_offer_product_mismatch`,
`commercial_contract_link_cycle`, `commercial_contract_link_cross_account`, `commercial_line_lineage_cycle`,
`commercial_agreement_contract_drift` (module enabled, `agreement_ref` resolvable, no human hold, and `contract_id`
differs from the resolution).

## 16. Permissions (policy v8)

- No new write capability: `canonical.source_sync` (+ authority facts), `canonical.human_entry` (scope widened to M10F
  commands), `config.mapping.publish`, `config.module.change` unchanged.
- New `data.commercial.read` (`operator`, by kind; one audit event per read).
- New **`data.commercial.read_confidential`** (Q22): held by **no actor kind**; added to `GRANTABLE_CAPABILITIES` and
  the `tenant_capability_grants` CHECK; held only through an explicit tenant-scoped grant by a different operator id
  (`security grant`, #90 path, same guard trigger and version rule). `includeConfidential` without it → refused and
  audited `denied` under that capability; with it → audited `allowed` under it with the released column keys only. It
  also gates `--include-confidential` on extension values whose target is `price_offer` / `contract` /
  `entitlement` (lesson of #90 re-review m2: no bypass through `data.extension.read`). Not a two-person control (same
  limitation as #93).
- Audit actions: `commercial.price_offer.write`, `commercial.contract.write`, `commercial.contract.link`,
  `commercial.entitlement.write`, `commercial.line.reference`, `commercial.release`, `commercial.read`.

## 17. Performance

Indexes per §3.4 and `(tenant_id, company_id)` / `(tenant_id, product_key)` on the new tables; resolution and read
models batch. Load evidence: 10k contracts × 100k lines × 5k offers (recorded, not a gate).

## 18. Risks

- Deal / opportunity groupings mapped as agreements → confirmation + token guardrail; the remaining risk (a mis-named
  field confirmed by a human) is recorded in ADR 0032.
- Contract graph deadlocks → single lock order (§4) and a deadlock test.
- Amounts leaking through history, logs or audit → value-free declared history, value-free audit details, log
  scanning in runtime script 91.
- Line ↔ contract account mismatch after a company merge → deferred guards on both tables + integrity check.
- Chargebee amount not available → list amount stays NULL from Chargebee until the adapter declares it (Q9).

## 19. Implementation phases

| Phase                  | Content                                                                                                                                                                                                                                                                                                                                                        | Exit                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1 — Schema & catalogue | migration `20270202120000_m10f_commercial` + down-script; Prisma models; tables, FKs, CHECKs, guard / acyclic / immutability triggers, owner-function allow-list; classification manifest; catalogue `0.6` + frozen `_0_5` lists; module row; policy v8 capabilities, `GRANTABLE_CAPABILITIES`, audit CHECKs; value-history fields + declared-policy honouring | schema guard, drift, migration spec, V1–V3, V25–V27, V31 green |
| 2 — Services           | `PriceOfferWriter`, `ContractWriter`, `EntitlementWriter`, line commercial-reference step; mapping blocks + line targets + confirmation / deal refusal; resolution + re-resolution pass; authority facts; merge participant; read models with the confidential gate; CLI; integrity checks; dependency-cruiser boundary                                        | V4–V24, V28–V30, V32–V34 green                                 |
| 3 — Proof & record     | concurrency / deadlock tests; runtime script `91-commercial.sh`; mutation proofs VM1–VM18 (throwaway branches, CI); ADR 0032; record `M10F-commercial.md`; README / milestones status; tech-debt entries; live Chargebee TEST read where possible; independent review                                                                                          | DoD §24                                                        |

## 20. Tests (V\*)

| #   | Test                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Canonical `0.6` catalogue: features, kinds, mapping blocks, line targets, authority facts; `0.6` `current`, `0.5` `supported`.                                              |
| V2  | Stored `0.1`–`0.5` catalogue hashes reproduced unchanged.                                                                                                                   |
| V3  | Module catalogue = code (schema guard): `commercial` available at `0.6`, entity kinds `price_offer` / `contract` / `entitlement`, `depends_on []`.                          |
| V4  | Module disabled and no `0.6` target ⇒ zero behavioural change (sync, eligibility, mapping hash, line `field_hash`, change records).                                         |
| V5  | Below `0.6` → `canonical_version_too_low`; disabled → `module_disabled`; both audited; `subscription.agreement` works with the module disabled at `0.6`.                    |
| V6  | Price offer write / validation (currency shape, period pair, closed codes, product exists); retired offer refuses new line assignments.                                     |
| V7  | Contract write / validation (status, dates, money pair); status change never cascades to lines.                                                                             |
| V8  | E3 §4.2 renewal, same line continues: `contract_id` moves, value history keeps the earlier contract, `renews` link set.                                                     |
| V9  | E3 §4.2 renewal with new lines, amendment in place, amendment as new contract (`amends`), replacement (`supersedes_line_id`), co-terming / `parent`.                        |
| V10 | Contract link cycle refused (union of kinds) incl. **two-session race**; cross-account link refused with conflict.                                                          |
| V11 | Line ↔ contract same account; line ↔ offer same product (writer + deferred guards; raw SQL refused).                                                                        |
| V12 | `agreement_ref`: all-or-none CHECK; never identity, never creates a contract or source-reference row; groups lines with the module off.                                     |
| V13 | `subscription.agreement` publish requires confirmation; deal / opportunity grouping refused (`agreement_ref_deal_grouping`).                                                |
| V14 | Resolution: resolved, unresolved conflict, late contract resolved by the re-resolution pass in the same run.                                                                |
| V15 | Price offers never affect ownership; entitlements never affect eligibility (snapshots identical with and without them).                                                     |
| V16 | Authority: source write without the `price_offer` / `contract` / `entitlement` fact refused.                                                                                |
| V17 | Human override sticky until release; disagreement recorded.                                                                                                                 |
| V18 | Value history on the §9 fields; `renewal_date` / `list_amount_minor` value-free; every pre-existing field's decision unchanged.                                             |
| V19 | Company merge re-points contracts, entitlements and lines in one transaction; links stay valid; deadlock test with a concurrent contract write.                             |
| V20 | Read model: confidential columns withheld by default; `includeConfidential` without grant refused + `denied` audit; with grant `allowed` audit, released keys only; revoke. |
| V21 | Extension values on commercial targets: `--include-confidential` needs `data.commercial.read_confidential` (no bypass via `data.extension.read`).                           |
| V22 | Cross-tenant offer / contract / link / entitlement / line reference impossible (raw SQL as app role); grants tenant-scoped.                                                 |
| V23 | Forced RLS + tenant policy on the three tables (schema guard).                                                                                                              |
| V24 | Secret-like values refused in every commercial string; no amount, date or currency in logs, metrics, errors or audit details.                                               |
| V25 | Classification manifest covers every new column; every `financial` column ≥ `confidential`.                                                                                 |
| V26 | Adoption `0.5 → 0.6` dry run / apply; rollback `0.6 → 0.5` with the module enabled (data readable, writes refused, stranded listed).                                        |
| V27 | Module disable after use: reads allowed, writes refused, line references kept.                                                                                              |
| V28 | Chargebee TEST mapping fixture (declared fields only): offers, contracts, confirmed `agreement_ref`, lines resolved.                                                        |
| V29 | Integrity checks (§15) detect seeded faults.                                                                                                                                |
| V30 | Migration: up, rerun, down refusal per data class, exact restore, re-apply; drift test.                                                                                     |
| V31 | Privileges: no DELETE on the three tables; no DDL by the app role; owner functions on the allow-list.                                                                       |
| V32 | Line lineage: self / cycle refused incl. two-session race; same account.                                                                                                    |
| V33 | Contract `context_id`: needs module `account_context`; same-account guard.                                                                                                  |
| V34 | Concurrent source syncs of the same header → one contract (source-reference uniqueness).                                                                                    |

## 21. Mutation proofs (VM\*)

| #    | Mutation (each must turn a named test red)                                       |
| ---- | -------------------------------------------------------------------------------- |
| VM1  | Classify `list_amount_minor` as `internal` / no `financial` (V25, schema guard). |
| VM2  | Drop `tenant_id` from the contract → contract link FK (V22).                     |
| VM3  | Drop `tenant_id` from the line → contract FK (V22).                              |
| VM4  | Remove the line ↔ contract same-account guard (V11).                             |
| VM5  | Remove the line ↔ offer same-product guard (V11).                                |
| VM6  | Remove the contract-graph advisory lock (V10 race).                              |
| VM7  | Check cycles per link kind instead of the union (V10).                           |
| VM8  | Remove the module gate in a writer (V5).                                         |
| VM9  | Skip the refusal audit event (V5).                                               |
| VM10 | Let eligibility read `price_offer_id` (V15, boundary test).                      |
| VM11 | Let eligibility read entitlements (V15, boundary test).                          |
| VM12 | Resolve `agreement_ref` by creating a contract when unresolved (V12, V14).       |
| VM13 | Accept `subscription.agreement` without confirmation (V13).                      |
| VM14 | Read model releases confidential columns without the grant check (V20).          |
| VM15 | Extension read model skips the commercial confidential check (V21).              |
| VM16 | `decideValueHistory` ignores the declared `value_free` policy (V18).             |
| VM17 | Use the live (unfrozen) lists in the `0.5` hash (V2).                            |
| VM18 | Remove `FORCE ROW LEVEL SECURITY` on `tenant_contracts` (V23).                   |

## 22. Acceptance — Canonical / business correctness

Product ≠ Price/Offer ≠ Subscription line ≠ Contract ≠ Entitlement; E3 §4.2 scenarios (renewal, amendment,
replacement, co-terming); 0..1 contract / offer / predecessor per line with history; acyclic same-account contract
links; `agreement_ref` never identity or reference row; price offers never affect ownership; entitlements never
affect eligibility; module disabled ⇒ no change; stored hashes unchanged.

## 23. Acceptance — Security & Data Governance

Financial classification (amounts, prices and contract values `financial` ≥ `confidential`); confidential reads only
with an explicit grant, denials audited; nothing commercial in logs, metrics or audit details; provenance for every
fact (source reference or human actor, change record, value history for status / dates); forced RLS and composite
tenant FKs; structural invariants with race tests; read-only live Chargebee verification using only the two approved
environment secrets, no writes.

## 24. Done criteria

- V1–V34 green; VM1–VM18 recorded with the failing test each; CI green on the PR head (four jobs).
- Runtime script **`91-commercial.sh`** (new tenant at `0.6`, module disabled refusal, adoption dry run, module enable,
  operator offer / contract / link / line assignment, cycle refusal exit 2, confidential redaction / denial / grant /
  revoke, integrity zero findings, app-role refusals, rollback `0.6 → 0.5` stranded, no amount / renewal date probe in
  any log, output, stderr or audit detail); README row in `scripts/verify-runtime.d/README.md`.
- Fresh clone, Docker per the standard gates; migration down / up evidence.
- Record `M10F-commercial.md`, ADR 0032, README / milestones status, tech-debt entries for deferrals.
- Live: Chargebee TEST-site read of `ItemPrices` / `Subscriptions` with the approved read-only key where available;
  otherwise recorded as not run (M9B precedent).
- Independent review passed; merge into `integration` (merge to `main` needs Ram's approval).

## 25. Evidence plan

| Evidence                       | Where                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| CI run on the PR head (4 jobs) | record § Evidence (run id, head SHA)                                                                   |
| Race / deadlock tests          | int specs named in the record; on unfixed code each race test first shown failing (M10D #83 precedent) |
| Mutation proofs                | throwaway branches `mut/m10f-vmN`, PRs closed unmerged, run ids in the record                          |
| Migration round trip           | `migrations-m10f.int.spec.ts` output in CI                                                             |
| Runtime                        | `91-commercial.sh` in the CI runtime job (one rerun allowed for the known SIGTERM flake)               |
| Live Chargebee                 | read-only log of endpoints and counts only, no values                                                  |

## 26. Building on predecessors

M10A1 actor / audit / classification / secret refusal; M10A2 modules, entity index, value history, adoption; M10B
generic source references (resolution target); M10C acyclic trigger + advisory lock + override pattern; M10D frozen
lists, extension targets, #83 structural single-owner lesson; M10E deferred two-table guards, module-owned line step,
#90 explicit-grant confidential reads.

## 27. Open questions and decisions for the owner

Each answer marked `DEFAULT` is what implementation proceeds with unless the owner overrides it.

| #   | Question                                                            | Recommended answer (`DEFAULT`)                                                                                                                                                          |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | One migration / one PR?                                             | `DEFAULT` yes (M10 §5 row 7), staged commits per §19 phase.                                                                                                                             |
| Q2  | Is `agreement_ref` gated by the module?                             | `DEFAULT` no: Core at ≥ `0.6` (CANDIDATE); `contract_id` / `price_offer_id` / `supersedes_line_id` and all commercial entities need the module.                                         |
| Q3  | New registry kind?                                                  | `DEFAULT` none; closed canonical enums from E3 §13; tenant vocabulary stays extension.                                                                                                  |
| Q4  | How is "human-confirmed agreement" enforced?                        | `DEFAULT` mandatory `confirmation` on the `subscription.agreement` entry + closed deal / opportunity token refusal; the token list is a guardrail, the confirmation is the control.     |
| Q5  | Price offer / contract identity                                     | `DEFAULT` platform UUID + generic source references; no natural key.                                                                                                                    |
| Q6  | Contract links: link table or columns?                              | `DEFAULT` three self-FK columns (0..1 each structural); refines M10 §2 `tenant_contract_links` (§28).                                                                                   |
| Q7  | Acyclicity scope                                                    | `DEFAULT` acyclic over the union of `renews` / `amends` / `parent`, advisory-locked trigger, RR / SERIALIZABLE refused.                                                                 |
| Q8  | Pricing model / period vocabulary                                   | `DEFAULT` `flat` / `per_unit` / `tiered` / `volume` / `usage` (E3) and `day` / `week` / `month` / `year`; both nullable; source codes via `valueMap` only.                              |
| Q9  | List amount from Chargebee                                          | `DEFAULT` not in M10F: the adapter declares no amount field; column nullable; declaring one is a separate adapter change with its own live gate (tech-debt entry at implementation).    |
| Q10 | Line ↔ offer product consistency                                    | `DEFAULT` must match (deferred guard on both tables); offer `product_key` immutable once referenced.                                                                                    |
| Q11 | `supersedes_line_id` source                                         | `DEFAULT` source-stated or operator only; no deterministic inference rule in M10F; same account; acyclic.                                                                               |
| Q12 | Cross-account contract links (master agreement at a parent account) | `DEFAULT` refused (same account), conflict `contract_link_cross_account` for review; revisit with M10C hierarchy when a tenant needs it.                                                |
| Q13 | Contract `context_id`                                               | `DEFAULT` optional, only with module `account_context` enabled, same-account guard; `commercial.depends_on` stays `[]`.                                                                 |
| Q14 | Duplicate contracts from two sources                                | `DEFAULT` no contract merge in M10F; `contract_duplicate_source` conflict.                                                                                                              |
| Q15 | Entitlement status vocabulary                                       | `DEFAULT` `active` / `inactive` / `expired` / `unknown`; informational only.                                                                                                            |
| Q16 | Lock order                                                          | `DEFAULT` `contract-graph` → `line-lineage` advisory locks, then contracts, offers, lines by ascending id; asserted by a deadlock test.                                                 |
| Q17 | Operator vs source                                                  | `DEFAULT` human wins, sticky until `release`; disagreement recorded.                                                                                                                    |
| Q18 | History of financial values                                         | `DEFAULT` declared `value_free` honoured by `decideValueHistory` (renewal date, list amount): recorded without values; `isSensitiveForHistory` unchanged; #94 tracks the extension gap. |
| Q19 | Rollback `0.6 → 0.5` with module on                                 | `DEFAULT` allowed; data kept and readable; writes refused; `modulesStranded`; stored `agreement_ref` kept.                                                                              |
| Q20 | Disable after use                                                   | `DEFAULT` reads allowed, writes refused, line references kept.                                                                                                                          |
| Q21 | Extension targets                                                   | `DEFAULT` `price_offer`, `contract`, `entitlement` become extension targets at `0.6`.                                                                                                   |
| Q22 | Confidential commercial reads                                       | `DEFAULT` new grant-only `data.commercial.read_confidential` (no actor kind; `tenant_capability_grants`, #90 path); not reusing `data.account_context.read_confidential`.               |
| Q23 | Ordinary read capability                                            | `DEFAULT` `data.commercial.read` (operator), one audit event per call; policy v8.                                                                                                       |
| Q24 | Authority                                                           | `DEFAULT` optional facts `price_offer`, `contract`, `entitlement`; line references follow `subscription_lines`.                                                                         |
| Q25 | Change vocabulary                                                   | `DEFAULT` change types unchanged; entity kinds `price_offer`, `contract`, `entitlement`.                                                                                                |
| Q26 | Live verification                                                   | `DEFAULT` read-only Chargebee TEST read with the two approved environment secrets where available; otherwise recorded as not run.                                                       |
| Q27 | Ownership / eligibility isolation                                   | `DEFAULT` structural: dependency-cruiser + SQL scan boundary, plus snapshot-equality tests.                                                                                             |
| Q28 | ADR timing                                                          | `DEFAULT` ADR 0032 written during implementation.                                                                                                                                       |

## 28. Conflicts / refinements against the approved M10 plan (recorded, not silent)

- M10 §2 names `tenant_contract_links`; this plan uses three self-FK columns on `tenant_contracts` (Q6) because E3
  §14 fixes 0..1 per kind, which a column enforces structurally.
- Policy version bumps to v8 for `data.commercial.read` and the grant-only `data.commercial.read_confidential`.
- New optional authority facts (M10 does not list them); existing documents and hashes unchanged.
- `supersedes_line_id` inference rule (E3 §4 allows a deterministic rule) deferred (Q11).
- Value history adds `price_offer_id`, offer status / list amount and entitlement status / dates beyond M10 §10
  ("Contract status / dates", "Subscription `contract_id`"); financial ones value-free.

## 29. Tech-debt interactions

#15 (restricted values never stored; no commercial column is `restricted`), #65 (integrity checks CLI only), #71
(three more module-owned entity kinds), #72 (separate migration spec), #79 (code-token reasons), #93 (grant ids
asserted until M15; applies to the new grant too), **#94** (added with this plan: confidential non-personal extension
values with history are recorded with values), #91 (context-side guard re-read; not repeated in the new guards).

## 30. Baseline at plan time (2026-10-16)

Documentation-only change: this plan, `docs/tech-debt.md` #94 and the README / milestones status. No code, schema or
migration change. `prettier --check` on the changed files; the CI run on the PR head is the evidence. Code baseline:
`integration` at `bb2ce79` (M10E hardening #90 merge, PR #115).
