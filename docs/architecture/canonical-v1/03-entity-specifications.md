# Canonical Architecture v1 Candidate — E3: Entity specifications and relationship matrix (M9E-C)

Part of the [Canonical Architecture v1 Candidate](CANDIDATE.md). Status: **candidate for review**. Field lists are
**logical** (architecture), not table designs; a physical design is made by the milestone that implements each entity.
Every label states what exists today.

## 0. Conventions that apply to every entity

- **Identity.** Every canonical record has a platform UUID (`id`) and a `tenant_id`. Source ids are never canonical
  identity; they are **source references** (E5). Natural/business keys exist only where stated (product key, metric
  key, signal type code).
- **Tenant isolation.** Every table is tenant-owned with forced RLS, tenant-scoped unique keys and composite tenant
  foreign keys (ADR 0008; schema-guard test). Cross-tenant references are impossible by construction.
- **Provenance.** Every write of a canonical record produces a change record (E5) through the entity's **single
  writer**; derived records also carry `origin`, `derivation` and evidence links.
- **Lifecycle vs reference lifecycle.** A record's canonical state is never inferred only from source-reference
  absence (M9B rule): references may be `retired` while the record stays `active`.
- **Deletion.** Ingestion never physically deletes canonical rows. Physical deletion happens only through a governed
  erasure/retention process (tech debt #15/#17), which is out of scope for v1.
- **Version.** Each entity carries its **entity definition version** within the canonical model version (E6). The
  initial definition version of every v1 entity is `1`.
- **Extension.** Every core and module entity can carry extension values and be the target of custom relationships
  (E4).

## Terminology mapping (owner decision 3)

| Architecture term | Code / schema today (`IMPLEMENTED TODAY`)                                                    | Rule                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Account           | `Company`, `CompanyId`, table `companies`, `company_external_refs`, mapping entity `account` | The architecture and new APIs say **Account**; the `companies` table is unchanged; no rename migration        |
| Person            | `Person`, table `persons`, `person_external_refs`                                            | unchanged                                                                                                     |
| Product           | `ProductKey`, `tenant_product_models`, `tenant_products`                                     | unchanged                                                                                                     |
| Subscription      | `SubscriptionObservation`, table `tenant_subscriptions` (one row = one line)                 | "Subscription" in the architecture means the **line**; the header is a Contract/Agreement (Commercial module) |
| Source reference  | `ExternalRef`, `*_external_refs`, line `source_*` columns                                    | generalised by E5                                                                                             |
| Change record     | `tenant_context_changes`                                                                     | generalised by E5                                                                                             |

---

## 1. Account — Core

- **Status:** `IMPLEMENTED TODAY`, except `parent_account_id` (`PROPOSED FOR V1 CANDIDATE`).
- **Purpose:** an organisation the tenant sells to, serves or prospects: a business, school, MAT or public body.
  - A stable business noun.
  - It is **not** a source representation (HubSpot Company, Salesforce Account, Chargebee Customer and Sugar Account
    all map to it).
- **Identity:** a platform UUID. Source ids are references only.
  - Domains are attributes, not identity (ADR 0014).
  - Merges keep lineage (`merged_into_id`).
- **Required fields:** `id`, `tenant_id`, `record_state`, timestamps.
- **Optional fields:**
  - `name`, which is never a placeholder;
  - `domains[]`;
  - `customer_status` (`prospect` / `customer` / `former_customer` / `unknown`);
  - `parent_account_id` (proposed);
  - `owner_ref` (deferred shape, a pointer to an internal user).
- **Lifecycle:** `active` → `inactive` (every source reference source-`deleted`) → `active` (a reference is restored),
  plus `merged` (terminal, with lineage).
  - Reference retirement never changes the record state (M9B).
  - Can it exist before a source mapping? **Yes**: created by import or by an operator.
- **Hierarchy (proposed):**
  - `parent_account_id` is a nullable reference to an Account of the same tenant.
  - Cycles are refused.
  - Depth is at most 10.
  - A merged account cannot be a parent: children are re-pointed to the survivor through the merge-participant port.
  - Which source may set the parent is a new authority fact, `account_hierarchy` (one authoritative source, as for
    other facts).
  - Parent changes are recorded with value history.
  - Retiring, inactivating or merging a parent never cascades to children.
  - Roll-ups (group ownership, group ARR) are **derived** views.
  - Hierarchy is **not** modelled through AccountContext (owner decision 9).
- **Relationships:**
  - parent (0..1) / children (0..n);
  - persons (0..n);
  - subscriptions (0..n);
  - contexts (0..n);
  - signals, opportunities, recommendations, goals, activities, contracts (0..n each).
- **Provenance:** change records per write (`IMPLEMENTED TODAY`, field names only); value history for `name`,
  `customer_status` and `parent_account_id` (proposed, E5).
- **Retention:** indefinite while the tenant is active; erasure is a governed process.
- **Source mapping expectations:**
  - mapping entity `account`;
  - identity entry to a source reference;
  - core targets `account.name`, `account.domain` (`IMPLEMENTED TODAY`);
  - proposed additional targets: `account.parent`, `account.customerStatus` (with authority).

## 2. Person — Core

- **Status:** `IMPLEMENTED TODAY`.
- **Purpose:** a human at an account: contact, user, champion, sponsor or participant. A stable noun.
- **Identity:** a platform UUID. Emails are optional and **not** identity (ADR 0014).
- **Required fields:** `id`, `tenant_id`, `record_state`.
- **Optional fields:**
  - emails;
  - names;
  - job title;
  - primary account (`company_id`);
  - `roles[]` (closed buying-role set; a candidate to become a governed code set in v1.1);
  - extension values.
- **Lifecycle:** as Account (`active` / `inactive` / `merged`).
- **Relationships:**
  - primary account (0..1);
  - additional account affiliations (0..n), source-observed today through `tenant_source_relationships`, specified as
    **Person–Account affiliation** with role and period (proposed; needed for champions moving companies);
  - context memberships (0..n);
  - activity participations (0..n);
  - signals (0..n);
  - opportunity contact roles (0..n).
- **Signals of movement** (champion departed): a Signal derived from affiliation end dates or source evidence; never
  inferred from email absence alone.
- **Privacy:** personal data. Erasure is governed (tech debt #15). Person fields are excluded from AI use unless an
  allowed use permits it.

## 3. Product — Core

- **Status:** `IMPLEMENTED TODAY` (versioned product model, ADR 0016). Product source references are
  `PROPOSED FOR V1 CANDIDATE`.
- **Purpose:** something the tenant sells and whose ownership matters. A stable noun; Chargebee Item, Salesforce
  Product2 and HubSpot products map to it.
- **Identity:** the tenant **product key**, never reused, never changing meaning (K1–K4).
- **Required fields:** `key`, `name`, `status` (`active` / `retired`).
- **Optional fields:** `family`, `description`, availability window, ownership policy, relationships (`requires`,
  `excludes`, `replaces`, `includes`), account conditions.
- **Lifecycle:** immutable model versions; a product is retired, never removed.
- **Source mapping:**
  - Today, source product ids resolve to keys through the mapping's product reference set.
  - Proposed: a Product source reference (`system`, `objectType`, `externalId` → `product_key`) so several sources can
    name the same product.
  - Item price → Price/Offer (Commercial module), never Product.
- **History:** product model versions (`IMPLEMENTED TODAY`).

## 4. Subscription (line) — Core

- **Status:** `IMPLEMENTED TODAY` (ADR 0017). `agreement_ref` and `context_id` are
  `PROPOSED FOR V1 CANDIDATE`.
- **Purpose:** a time-bound commercial holding of a product by an account; the fact ownership is derived from. A
  stable noun.
  - One canonical record per source **line**: Chargebee SubscriptionItem, Stripe SubscriptionItem, Salesforce
    contract/asset line, Sugar RLI, file or warehouse row.
- **Identity:** a platform UUID plus a unique source line reference `(system, object, record id)`.
  - Chargebee line key `<subscription_id>:<item_price_id>` (V3, live-resolved).
- **Required fields:** account, product key, canonical `state` (`active` / `trial` / `expired` / `cancelled` /
  `unknown`), source reference, `record_state`.
- **Optional fields:**
  - `starts_at`, `ends_at`, `quantity`;
  - `agreement_ref` (proposed): the source subscription/contract header key, so lines of one agreement can be grouped
    without a header entity;
  - `context_id` (proposed, only with the Account Context module);
  - `price_offer_id` (proposed, only with the Commercial module).
- **Lifecycle:**
  - `record_state` is `active` / `deleted` (tombstone, kept).
  - Retirement happens only on an accepted full run, or by G4 parent-scoped reconciliation.
  - The canonical `state` comes only from the mapped value map; `unknown` never counts as owned.
- **Unchanged guarantees:**
  - seen-but-rejected protection;
  - full-read proof;
  - coverage tiers;
  - one authoritative source per fact;
  - single writer.
- **History:** proposed value history for `state`, terms, product key and quantity (today, the change log records
  field names only).

## 5. CustomerProduct — Derived view (owner decision 8)

- **Status:** `PROPOSED FOR V1 CANDIDATE` as a **named derived view only**. Nothing is persisted.
- **Definition:** for (account[, context], product, as-of): the ownership result already computed by the M7 evaluator
  (`owned` / `not_owned` / `unknown`), with the contributing lines, coverage tier and model version.
  - The existing ownership derivation **is** the CustomerProduct view.
- **Not stored**, because it has no identity or lifecycle independent of its inputs. A stored copy would duplicate
  truth and break the derived-ownership guarantee.
  - Eligibility snapshots already freeze it when a decision depends on it.
- **When it may become first-class:** only if a source provides holdings with their own identity and lifecycle that
  are not subscriptions. Example: a perpetual licence, or an installed asset with serial number and support status.
  - That is the **Entitlement / Asset** concept (Commercial module).
  - Entitlements would feed the derivation as an additional fact type, under a new evaluator version.
  - CustomerProduct itself stays derived.

## 6. Signal — Core (vendor-neutral; owner decision 6)

- **Status:** `PROPOSED FOR V1 CANDIDATE`. The M1 schema (`domain/signals.ts`, vendor-bound kinds) is `DOMAIN-ONLY`
  and is to be replaced in M10. Nothing persists it today.
- **Purpose:** a time-stamped piece of evidence relevant to a business decision: usage drop, champion departed,
  sentiment decline, support escalation, contract expiry approaching, budget threshold, product interest, engagement
  change.
- **Identity:** a platform UUID.
  - De-duplication key `(tenant, signal_type, subject, source event id | derivation key + window)`.
- **Required fields:**
  - `signal_type`: a code from the governed **Signal Type catalogue**;
  - `subject`: at least one of account or person (account resolved when known);
  - `observed_at`;
  - `origin` (`source_provided` / `deterministic` / `ai_derived` / `human`);
  - `status`.
- **Optional fields:**
  - context, product, subscription, opportunity, activity references;
  - `polarity` (`risk` / `opportunity` / `neutral`);
  - `severity` (`low` / `medium` / `high` / `critical`);
  - `strength` (0–1);
  - `effective_from` / `effective_to`;
  - `value` (typed, with unit);
  - `summary` (sensitivity-tagged);
  - `derivation` (definition key + version + inputs hash) when not `source_provided`;
  - `confidence` for `ai_derived`.
- **Signal Type catalogue:**
  - Platform generic types: `usage_change`, `engagement_change`, `sentiment_change`, `support_escalation`,
    `champion_change`, `contract_milestone`, `budget_threshold`, `product_interest`, `adoption_milestone`,
    `risk_indicator`, `expansion_indicator`.
  - Plus tenant-defined codes in a versioned registry (as the product model).
  - Each type declares allowed subjects, polarity default and value type.
  - **No vendor in a type.** Vendor and system live in provenance.
- **Lifecycle:** `active` → `superseded` (a newer signal with the same de-dup key) / `expired` (after
  `effective_to`) / `retracted` (source deletion or human correction).
  - Signals are **immutable**: a change is a new signal that supersedes the old one, so history is complete by
    construction.
- **Rules:**
  - Raw activity is not a signal.
  - Derivations are versioned.
  - AI-derived and human signals are always distinguishable by `origin`.
  - A signal never writes canonical facts.
- **Mapping:**
  - source-provided signals: a mapping entity `signal` with value maps to signal types (for example Staircase or
    Gainsight scores and alerts);
  - derived signals: produced by signal definitions (M10), never by mappings.

## 7. Opportunity — Core (owner decision 7)

- **Status:** `PROPOSED FOR V1 CANDIDATE`. M1 LeadCandidate (person-required) is `DOMAIN-ONLY`, superseded and not
  migrated.
- **Purpose:** a potential commercial opportunity, whether recorded in a CRM or identified by the platform.
- **Scope (exactly one level):**
  - `account`;
  - `account_product` (account + product key);
  - `context_product` (AccountContext + product key; needs the module).
  - An optional **Person context** on any level, through contact roles (0..n persons with role). It is never required.
- **Origin:** `source_native` (CRM opportunity/deal through a mapping), `platform_derived` (whitespace, signals),
  `human`, or `recommendation_acceptance`.
  - A platform-derived opportunity may later be **linked** to a source-native one (`linked_source_opportunity_id`);
    they are not merged blindly.
- **Identity:**
  - a platform UUID;
  - the source reference for `source_native`;
  - the equivalence key `(tenant, scope, account, product?, context?)` for platform-derived suppression (ADR 0006
    rules, re-based on Account × Product).
- **Required fields:** scope, account, origin, `status`, `opened_at`.
- **Optional fields:**
  - product, context, contact roles;
  - `stage_code` (source stage as data) mapped to canonical `status`;
  - `amount` (money + currency);
  - `close_date`;
  - `type` (`new_business` / `expansion` / `renewal` / `cross_sell` / `upsell` / `unclassified`);
  - `owner_ref`;
  - evidence links (signals, eligibility snapshot);
  - `lines[]`: Opportunity line = product, quantity, amount (for multi-product deals).
- **Canonical status:** `open` / `won` / `lost` / `abandoned` / `suppressed` / `unknown`.
  - The source stage is preserved as a code with value history.
  - Stage changes are never rejected; a backwards transition is recorded with a warning (ADR 0007 rule kept).
- **Lifecycle:** status transitions are recorded in value history.
  - A `suppressed` platform opportunity records its suppression reason (duplicate, already owned, already pursued,
    cool-off).
- **Relationships:** account (1), product (0..1), context (0..1), persons (0..n), signals (0..n via evidence),
  recommendations (0..n), outcome (0..1), lines (0..n).

## 8. Recommendation and decision events — Core

- **Status:** `PROPOSED FOR V1 CANDIDATE`. M1 QualificationDecision / HumanOverride are `DOMAIN-ONLY` and absorbed.
- **Purpose:** a proposed action or decision with rationale and evidence: contact account, schedule EBR, offer
  Product B, engage sponsor, investigate churn risk, open expansion opportunity.
- **Identity:** a platform UUID. De-duplication by `(tenant, action_type, target, generator, window)`.
- **Required fields:**
  - `action_type` (governed code);
  - `target` (account / context / person / opportunity);
  - `generator` (`rule` / `ai` / `human`, with key + version);
  - `status`;
  - `created_at`;
  - evidence links (≥ 1 for `rule` and `ai`).
- **Optional fields:** rationale (sensitivity-tagged), priority, due window, `expires_at`, related opportunity,
  recommended product, assignee (`owner_ref`).
- **Lifecycle:** `proposed` → `accepted` | `dismissed` | `expired` | `superseded`, and `accepted` → `executed`
  | `expired`.
  - Every transition is a **Recommendation event** (the DECISION record): actor (user / system), reason code, time,
    optional feedback code.
  - "Human decision wins" (M1 rule): a later automated proposal never overrides an active human decision on the same
    target and type.
- **Feedback:** reason codes on events (for example `not_relevant`, `already_done`, `wrong_timing`). A separate
  Feedback entity is **not** needed in v1.
- **Never** collapses raw facts into recommendations: a recommendation cites signals and opportunities, not raw
  records.

## 9. Action and Outcome — Module "Action & Outcome"

- **Status:** `PROPOSED FOR V1 CANDIDATE` (specification only). Implemented with M15/M16.
- **Action:** an execution of an accepted recommendation, or a human action (task created, email sent, CRM write
  under approval).
  - Fields: type, target, executor, `status` (`pending` / `succeeded` / `failed` / `cancelled`), external reference
    (the created CRM task), time, approval reference.
  - Writes to customer systems stay behind approval gates (ADR 0004/0012).
- **Outcome:** what happened.
  - Fields: subject (opportunity / recommendation / action), `outcome_type` (ADR 0012 vocabulary: accepted, worked,
    ignored, rejected/disqualified, converted, won, lost, expired, superseded), value (money), time, source reference
    or human entry.
  - Feeds learning (measurement, M16).

## 10. AccountContext — Module "Account Context" (owner decision 10)

- **Status:** `PROPOSED FOR V1 CANDIDATE`.
- **Purpose:** a managed business context **within** one account, for example:
  - Account + Product + Region;
  - Account + Business Unit;
  - Account + Workspace;
  - Account + Programme;
  - Account + Service / Contract context;
  - Account + CSM engagement.
  - It answers "within this account, which context are we managing?". Hierarchy answers "which account sits under
    which".
- **Identity:**
  - a platform UUID, plus a context natural key `(account_id, context_type, dimension values)`, unique per tenant;
  - source references (for example a Gainsight Relationship id).
- **Required fields:** account, `context_type` (tenant-governed code with a declared dimension schema), name, `status`
  (`active` / `inactive` / `retired`).
- **Optional fields:**
  - dimensions: product key, region code, business-unit code, workspace id and so on, declared per context type as
    typed values (canonical product key, or extension-registered fields);
  - `owner_ref` (CSM);
  - renewal date (or a reference to a Contract);
  - extension values.
- **Associations:**
  - products (via dimension or membership);
  - subscriptions (`context_id` on the line, or a membership rule);
  - persons (context contacts with role);
  - goals, metric observations (health), signals, opportunities, recommendations, activities, contracts.
- **Pressure scenario:** the same account and product in two regions gives two contexts, each with its own CSM,
  health metric, goals, renewal date, signals and opportunity. Account-level views aggregate them, as a derived view.
- **Optional by design:** if the module is off, every associated entity uses its account-level scope and nothing
  changes.
- **Lifecycle and retirement:**
  - Context retirement never retires the account or its subscriptions.
  - Source-reference lifecycle is as E5.

## 11. Goal, MetricDefinition, MetricObservation — Module "Value"

- **Status:** `PROPOSED FOR V1 CANDIDATE`.
- **Goal:** why the customer bought, or what outcome they expect.
  - **Identity:** a platform UUID plus source references.
  - **Scope:** account, context, or account + product.
  - **Required fields:** scope, title, `status` (`draft` / `active` / `at_risk` / `achieved` / `missed` /
    `abandoned`), origin (`human` / `source_provided` / `ai_suggested`; AI-suggested goals require human confirmation
    before `active`).
  - **Optional fields:**
    - outcome statement and category (replacing a separate BusinessOutcome);
    - target: metric definition + target value + direction + time window;
    - `owner_ref`;
    - evidence;
    - linked opportunity or renewal.
  - **History:** status and target changes are recorded in value history.
- **MetricDefinition:** how something is measured.
  - Lives in a versioned tenant registry (pattern of the product model).
  - Fields: `key` (identity), name, unit, value type, aggregation (`sum` / `avg` / `last` / `max`), good direction
    (`up` / `down`), allowed subject types (account / context / product-within-account / person), cadence, sensitivity.
  - Platform-provided generic definitions (for example `active_users`, `health_score`, `seat_utilisation`) plus
    tenant definitions.
- **MetricObservation:** an immutable measured value.
  - Fields: metric key + definition version, subject, value, period (`period_start` / `period_end`) or instant,
    `observed_at`, provenance (source or derivation).
  - Corrections are new observations that supersede old ones.
  - Retention follows a declared policy (time series can be large; roll-ups are derived).
  - Health scores, usage and adoption are observations; a "health status" is a derived Signal.

## 12. Activity (Interaction / Conversation) — Module "Engagement" (owner decision 11)

- **Status:** `PROPOSED FOR V1 CANDIDATE`.
- **Purpose:** one reusable record for something that happened between people or with an account:
  - types: `meeting`, `call`, `email`, `calendar_event`, `message`, `support_interaction`, `timeline_activity`,
    `marketing_touch`, `product_event` (raw engagement event).
  - Conversation = an Activity whose `content` includes a transcript reference. No separate entity.
- **Identity:** a platform UUID plus a source reference (message id, call id, event id).
  - Threads are grouped by `thread_ref`.
- **Required fields:** `activity_type`, `occurred_at` (or `started_at`), origin system (provenance), `status`
  (`active` / `retracted`).
- **Optional fields:**
  - `started_at`, `ended_at`, `duration`;
  - `channel`;
  - `direction` (`inbound` / `outbound` / `internal`);
  - account / context / opportunity / support case links;
  - participants;
  - `summary` (sensitivity-tagged);
  - content references (transcript, recording, body): pointers into a governed content store with retention and
    sensitivity, **off by default**;
  - metadata as extension values.
- **Activity participant:** activity, role (`organizer` / `attendee` / `from` / `to` / `cc` / `speaker`), and
  resolution: a Person, an internal user, or an unresolved address (stored hashed or masked under privacy policy).
  - Account links derived from participant domains are **derived links** with provenance and confidence. Ambiguity
    goes to review, never silent attribution.
- **Interpretation chain:** Activity → (signal definition or AI extraction, versioned) → Signal → Opportunity /
  Recommendation. An Activity never directly creates an opportunity.
- **Support case** (same module, specification only): a ticket with identity, `status` (`open` / `pending` /
  `solved` / `closed`), priority, account / person / product, opened and closed time, and source references.
  - Its interactions are Activities of type `support_interaction`.
  - Escalation, reopen and SLA breach become Signals.

## 13. Price/Offer, Contract/Agreement, Entitlement/Asset — Module "Commercial"

- **Status:** `PROPOSED FOR V1 CANDIDATE` (Price/Offer and Contract specified; Entitlement specification only). Order
  is `DEFERRED` (extension).
- **Price/Offer:** a priced, purchasable variant of a product.
  - Fields: product key, currency, billing period/frequency, pricing model (`flat` / `per_unit` / `tiered` /
    `volume` / `usage`), list amount (minor units), status.
  - Source references: Chargebee ItemPrice, Stripe Price, Salesforce PricebookEntry.
  - Identity: a platform UUID plus source references.
  - Used for value estimates and upgrade paths, **never for ownership** (ownership stays product-level).
- **Contract/Agreement:** a commercial agreement grouping subscription lines.
  - Fields: account, optional context, start/end, renewal date, auto-renew, status (`draft` / `active` / `expired` /
    `terminated` / `unknown`), total value, source references (Salesforce Contract, Chargebee/Stripe subscription
    header, CLM record).
  - Lines reference it through `agreement_ref` → `contract_id` resolution.
  - Renewal-window signals derive from it.
- **Entitlement/Asset:** a right to use a product independent of a subscription: perpetual licence, installed asset,
  bundled entitlement.
  - Fields: account, product key, quantity, status, start/end, source references.
  - Feeds ownership derivation **only** through a later evaluator version, with explicit product-model ownership
    policy. Until then it is informational.

---

## 14. Relationship matrix

Cardinality is read as "one row-entity relates to N column-entities". `—` means no direct relationship (only through
another entity).

| From \ To                                       | Cardinality and rule                                                                                                             | Status                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Account → Account (parent)                      | many-to-one (0..1 parent; 0..n children); acyclic; depth ≤ 10; same tenant                                                       | `PROPOSED FOR V1 CANDIDATE`                                          |
| Account → Person                                | one-to-many as primary account (0..n persons have it as primary); many-to-many through Person–Account affiliation (role, period) | primary `IMPLEMENTED TODAY`; affiliation `PROPOSED FOR V1 CANDIDATE` |
| Account → AccountContext                        | one-to-many (a context belongs to exactly one account)                                                                           | `PROPOSED FOR V1 CANDIDATE`                                          |
| Account → Product                               | many-to-many, **derived** (CustomerProduct view via subscriptions/entitlements); never stored                                    | `IMPLEMENTED TODAY` (derived)                                        |
| Account → Subscription                          | one-to-many (a line has exactly one account)                                                                                     | `IMPLEMENTED TODAY`                                                  |
| Account → Opportunity                           | one-to-many (exactly one account per opportunity)                                                                                | `PROPOSED FOR V1 CANDIDATE`                                          |
| Account → Signal                                | one-to-many (0..1 account per signal; person-only signals resolve the account when known)                                        | `PROPOSED FOR V1 CANDIDATE`                                          |
| Account → Recommendation                        | one-to-many (target account, directly or via context/person/opportunity)                                                         | `PROPOSED FOR V1 CANDIDATE`                                          |
| Account → Goal                                  | one-to-many (goal scope account, or account+product)                                                                             | `PROPOSED FOR V1 CANDIDATE`                                          |
| Account → Activity                              | many-to-many (an activity may involve several accounts; links carry derived/source origin)                                       | `PROPOSED FOR V1 CANDIDATE`                                          |
| Account → Contract                              | one-to-many                                                                                                                      | `PROPOSED FOR V1 CANDIDATE`                                          |
| AccountContext → Product                        | many-to-many (dimension product key, or several products in a programme context)                                                 | `PROPOSED FOR V1 CANDIDATE`                                          |
| AccountContext → Person                         | many-to-many (context contacts with role)                                                                                        | `PROPOSED FOR V1 CANDIDATE`                                          |
| AccountContext → Goal                           | one-to-many                                                                                                                      | `PROPOSED FOR V1 CANDIDATE`                                          |
| AccountContext → Signal                         | one-to-many (0..1 context per signal)                                                                                            | `PROPOSED FOR V1 CANDIDATE`                                          |
| AccountContext → Opportunity                    | one-to-many (scope `context_product`)                                                                                            | `PROPOSED FOR V1 CANDIDATE`                                          |
| AccountContext → Recommendation                 | one-to-many                                                                                                                      | `PROPOSED FOR V1 CANDIDATE`                                          |
| AccountContext → Subscription                   | one-to-many (`context_id` on the line, optional) — a line belongs to at most one context                                         | `PROPOSED FOR V1 CANDIDATE`                                          |
| Product → Price/Offer                           | one-to-many                                                                                                                      | `PROPOSED FOR V1 CANDIDATE`                                          |
| Product → Subscription                          | one-to-many (a line has exactly one product key)                                                                                 | `IMPLEMENTED TODAY`                                                  |
| Product → Product                               | many-to-many typed (`requires` / `excludes` / `replaces` / `includes`) inside the product model                                  | `IMPLEMENTED TODAY`                                                  |
| Product → Signal                                | one-to-many (0..1 product per signal)                                                                                            | `PROPOSED FOR V1 CANDIDATE`                                          |
| Product → Opportunity                           | one-to-many as scope product; many-to-many through opportunity lines                                                             | `PROPOSED FOR V1 CANDIDATE`                                          |
| Subscription → Contract                         | many-to-one (0..1 contract per line, via `agreement_ref`)                                                                        | `PROPOSED FOR V1 CANDIDATE`                                          |
| Subscription → Price/Offer                      | many-to-one (0..1)                                                                                                               | `PROPOSED FOR V1 CANDIDATE`                                          |
| Signal → Opportunity / Recommendation           | many-to-many through **evidence links** (one signal supports many decisions; one decision cites many signals)                    | `PROPOSED FOR V1 CANDIDATE`                                          |
| Activity → Signal                               | many-to-many through evidence links (derivations)                                                                                | `PROPOSED FOR V1 CANDIDATE`                                          |
| Activity → Person                               | many-to-many through participants                                                                                                | `PROPOSED FOR V1 CANDIDATE`                                          |
| Opportunity → Recommendation                    | one-to-many                                                                                                                      | `PROPOSED FOR V1 CANDIDATE`                                          |
| Recommendation → Action                         | one-to-many (retries / several actions)                                                                                          | `PROPOSED FOR V1 CANDIDATE`                                          |
| Opportunity / Recommendation / Action → Outcome | one-to-many over time (latest outcome is the projection)                                                                         | `PROPOSED FOR V1 CANDIDATE`                                          |
| Goal → MetricDefinition                         | many-to-one (target metric)                                                                                                      | `PROPOSED FOR V1 CANDIDATE`                                          |
| MetricDefinition → MetricObservation            | one-to-many                                                                                                                      | `PROPOSED FOR V1 CANDIDATE`                                          |
| Any entity → custom record                      | many-to-many through governed custom relationships (E4)                                                                          | `PROPOSED FOR V1 CANDIDATE`                                          |
| Any entity → source reference                   | one-to-many (one record, many source references; one source reference resolves to exactly one record)                            | partly `IMPLEMENTED TODAY` (E5)                                      |
