# Milestone 10 — Canonical Architecture Implementation: plan (for review)

- Status: **PLAN — FOR OWNER REVIEW.** No schema, migration or code change is made until this plan is approved.
- Input: the approved [Canonical Architecture v1 Candidate](../architecture/canonical-v1/CANDIDATE.md) (M9E, E12 `PASS
— CANONICAL ARCHITECTURE V1 CANDIDATE APPROVED`) and [ADR 0025](../adr/0025-canonical-architecture-v1-candidate.md).
- Base: `main` after the M9E closure.
- Not in scope: M9C (file/S3) and M9D (warehouse/table), which remain future pressure tests before the v1.0 freeze;
  freezing Canonical v1.0; writes to customer systems.
- Labels:
  - `IMPLEMENTED TODAY`: code, schema and tests on `main`;
  - `APPROVED CANONICAL TARGET`: approved in the candidate, **not built**.

## 0. Scope boundary: what M10 builds and what it does not

M10 builds the **canonical data foundation**:

- tables and constraints;
- domain schemas;
- single writers;
- registries;
- source references and provenance;
- mapping targets for source-provided data;
- operator/API entry for human-entered records;
- read models;
- versioning and adoption.

It does **not** build the **intelligence engines** that later consume that data:

- signal derivation definitions and their evaluator;
- opportunity candidate generation and suppression decisions;
- qualification;
- prioritisation and routing;
- recommendation generators;
- writes to customer systems (M15 approval gates);
- outcome measurement.

The roadmap's former "M10 — Signal model and ingestion" and the data-model half of "M11 — Opportunity candidates"
are absorbed into this M10. Their engine halves move to later milestones (see §16, roadmap renumbering proposal).

## 1. Current schema and components that can be reused (`IMPLEMENTED TODAY`)

| Component                                                                                                                       | Reuse in M10                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `companies` (Account), `persons`, `tenant_subscriptions`, `tenant_product_models` / `tenant_products`                           | kept; additive columns only (hierarchy, line commercial references)                                                     |
| `company_external_refs`, `person_external_refs` (incl. M9B `retired` state)                                                     | kept unchanged; the new generic source-reference store covers **new** entities                                          |
| `tenant_context_changes` (change log, field names only)                                                                         | widened in place (nullable columns + widened CHECKs) — becomes the universal change record                              |
| `ContextIngestionService` / `SubscriptionIngestionService` single writers; `decideApply` ordering; merge participants           | pattern for every new single writer; merge participants extended for hierarchy, affiliation, contexts, extension values |
| Versioned-document pattern (product model, mapping, authority, schema snapshot): immutable, hashed, base version                | reused for one generic **governed registry** store (extension, signal types, metrics, action types, context types)      |
| Mapping document, validator, engine, closed transform set, run guards, seen-but-rejected, proofs, coverage tiers                | extended with new targets / entity kinds; guarantees unchanged                                                          |
| `tenant_source_authority_versions`                                                                                              | additive authority facts (e.g. `account_hierarchy`)                                                                     |
| M9A profiling (field stats, drift, findings)                                                                                    | input to field intelligence                                                                                             |
| `tenant_ownership_gaps`, `tenant_identity_conflicts`, `tenant_dead_letters`                                                     | kept; data-quality records complement them                                                                              |
| Tenancy: `TenantDatabase.transaction`, forced RLS, schema-guard test, adversarial RLS tests, rollback down-scripts with refusal | mandatory for every new table                                                                                           |
| Test infrastructure: Testcontainers, fakes (Sugar, Chargebee, HubSpot), runtime/Docker scripts, mutation harness pattern        | extended per sub-milestone                                                                                              |

`DOMAIN-ONLY` schemas to be replaced (unused, unpersisted): M1 `Signal` (vendor-bound), `LeadCandidate` / `Lead`
(person-required), `QualificationDecision`, `SalesOutcome`. Their removal deletes their own unit tests together with
the code; that removes tests of removed code and is not a weakening of any guarantee. It is recorded per
sub-milestone.

## 2. New tables actually required (`APPROVED CANONICAL TARGET` → proposed physical names)

All are tenant-owned with forced RLS, `tenant_id` first in every key, and composite tenant foreign keys.

| Area                            | Tables                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versioning                      | `canonical_model_versions` (**global** reference data, like `connector_kinds`); `tenant_canonical_adoptions`; `tenant_canonical_migration_runs`                                                                          |
| Registries                      | `tenant_registry_versions` (kind: `extension` / `signal_type` / `metric` / `action_type` / `context_type`; immutable versions); projections `tenant_registry_entries` (current definitions, used as foreign-key targets) |
| References / evidence / history | `tenant_source_references` (generic, for new entities); `tenant_evidence_links` (immutable); `tenant_value_history` (append-only)                                                                                        |
| Hierarchy / affiliation         | `tenant_person_affiliations` (hierarchy itself is a column on `companies`)                                                                                                                                               |
| Account Context                 | `tenant_account_contexts`; `tenant_account_context_persons`; `tenant_account_context_products`                                                                                                                           |
| Commercial                      | `tenant_price_offers`; `tenant_contracts`; `tenant_entitlements`                                                                                                                                                         |
| Signal                          | `tenant_signals` (immutable, supersession)                                                                                                                                                                               |
| Opportunity                     | `tenant_opportunities`; `tenant_opportunity_lines`; `tenant_opportunity_contacts`                                                                                                                                        |
| Decision chain                  | `tenant_recommendations`; `tenant_recommendation_events` (immutable); `tenant_actions`; `tenant_action_outcomes`                                                                                                         |
| Value                           | `tenant_goals`; `tenant_metric_observations` (MetricDefinition lives in the registry + projection)                                                                                                                       |
| Engagement                      | `tenant_activities`; `tenant_activity_participants`; `tenant_activity_links`; `tenant_content_references`; `tenant_support_cases`                                                                                        |
| Extension                       | `tenant_extension_values`; `tenant_extension_value_items`; `tenant_custom_records`; `tenant_custom_relationships` (definitions in the registry + projection)                                                             |
| Data quality                    | `tenant_rejected_observations`; `tenant_field_metadata`                                                                                                                                                                  |

No `customer_products` table: CustomerProduct stays a **derived view** (owner decision 8). No `business_outcomes`
table (the customer value outcome is the Goal).

## 3. Existing tables that need additive changes

| Table                              | Additive change                                                                                                                                                                              | Notes                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `companies`                        | `parent_company_id uuid NULL` (canonical name `parent_account_id`), composite FK `(tenant_id, parent_company_id)` → `companies`, CHECK `parent_company_id <> id`, index                      | Account hierarchy **does not exist today**. Cycle prevention: §5/§M10C. Depth: configurable guardrail            |
| `tenant_subscriptions`             | `agreement_ref_system`, `agreement_ref_object_type`, `agreement_ref_external_id` (all-or-none CHECK); `contract_id`; `price_offer_id`; `context_id`; `supersedes_line_id` — all nullable     | Line identity unchanged; `agreement_ref` is an attribute, not an identity or reference row                       |
| `tenant_context_changes`           | `origin`, `derivation` (jsonb: key, version, inputs hash), `actor`, `canonical_version`, `schema_snapshot_hash`, `transforms` (text[]); widened `entity_kind`, `change_type`, `cause` CHECKs | Existing rows keep NULL = "pre-M10 record"; no backfill of invented values                                       |
| `tenant_source_authority_versions` | `account_hierarchy_connection_id` (and later facts per module, e.g. `opportunity_connection_id`)                                                                                             | Immutable versions: a new authority version is published to use a new fact                                       |
| `tenant_source_mapping_versions`   | `lifecycle_state` (`published` / `superseded` / `retired`), `canonical_version_min`; plus `tenant_source_mapping_drafts` (new, mutable) for `draft` / `validated`                            | Existing rows: `published` for the latest per connection, `superseded` for earlier ones (deterministic backfill) |
| `tenant_identity_conflicts`        | widened `kind` / `entity_kind` CHECKs (extension value conflicts, hierarchy conflicts)                                                                                                       |                                                                                                                  |
| `connector_kinds`                  | none                                                                                                                                                                                         |                                                                                                                  |

## 4. Dependency analysis and order

Observed dependencies (from the repository and the candidate):

- Every new entity needs the widened change record, a source-reference store and (for some fields) value history
  **before** its single writer exists. So these are the foundation.
- Signal type, metric, action type, context type and extension definitions all use one governed-registry pattern.
  Build it once, early.
- Several entities carry optional references (`context_id`, `contract_id`, `price_offer_id`). Building
  **AccountContext and Commercial before Signal / Opportunity** gives those foreign keys from day one, instead of
  later nullable retrofits.
- Opportunity evidence cites Signals (EvidenceLink, polymorphic: no hard FK dependency), but Opportunity
  `source_native` ingestion and Recommendation targets need Opportunity before Recommendation.
- Goal links to Opportunity and Contract, so Value comes after them. Activity links to Opportunity and SupportCase,
  so Engagement comes after Opportunity.
- Extension custom relationships target any entity polymorphically. The framework can come early; later entities
  automatically become targets through their entity-kind registration.
- Data-quality records and field intelligence attach to mapping runs and extension fields. They come after Extension.
  Interim behaviour (counters, gaps, seen-but-rejected) is already safe.

**Recommended order:** A, B, C, D, E, F, G, H, I, J, K, L, M (§15). It differs from the suggested list in five ways:

- foundation is split into versioning/registries/history (A) and references/evidence (B);
- hierarchy moves to C, after its provenance prerequisites;
- AccountContext (E) and Commercial (F) move **before** Signal/Opportunity;
- data quality / field intelligence becomes its own sub-milestone (L);
- migration/adoption hardening stays last (M).

## 5. Migration sequence

One forward migration per sub-milestone (two at most), each with a down-script for dev/staging that **refuses while
data exists** (existing pattern), and each with migration tests: up, idempotent rerun, down-refusal, exact restore,
re-apply.

| #   | Migration (indicative name)                    | Content                                                                                                                                                                                                                |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `m10a_canonical_versioning_registries_history` | `canonical_model_versions` seed; `tenant_canonical_adoptions`; `tenant_registry_versions` / entries; `tenant_value_history`; change-record widening; mapping lifecycle columns + drafts table + deterministic backfill |
| 2   | `m10b_source_references_evidence`              | `tenant_source_references`; `tenant_evidence_links` (+ immutability trigger)                                                                                                                                           |
| 3   | `m10c_account_hierarchy_affiliation`           | `companies.parent_company_id` + FK + CHECK + cycle trigger; `tenant_person_affiliations`; authority column                                                                                                             |
| 4   | `m10d_extension_framework`                     | extension values / items / custom records / custom relationships                                                                                                                                                       |
| 5   | `m10e_account_context`                         | contexts + members + products; `tenant_subscriptions.context_id`                                                                                                                                                       |
| 6   | `m10f_commercial`                              | price offers, contracts (+ links), entitlements; line `agreement_ref_*`, `contract_id`, `price_offer_id`, `supersedes_line_id`                                                                                         |
| 7   | `m10g_signals`                                 | `tenant_signals`                                                                                                                                                                                                       |
| 8   | `m10h_opportunities`                           | opportunities, lines, contacts                                                                                                                                                                                         |
| 9   | `m10i_decision_chain`                          | recommendations, events, actions, action outcomes                                                                                                                                                                      |
| 10  | `m10j_value`                                   | goals, metric observations                                                                                                                                                                                             |
| 11  | `m10k_engagement`                              | activities, participants, links, content references, support cases                                                                                                                                                     |
| 12  | `m10l_data_quality`                            | rejected observations, field metadata                                                                                                                                                                                  |
| 13  | `m10m_migration_runs`                          | `tenant_canonical_migration_runs` (if not already in A)                                                                                                                                                                |

All migrations are **additive**: new tables, nullable columns, widened CHECKs. None renames or drops an existing
column or table. `companies` stays `companies`.

## 6. Backward compatibility strategy

- **Additive only.**
  - Existing writers, readers, mappings, product models, authority versions, snapshots and APIs keep working
    unchanged after each migration.
  - New columns are nullable with no behavioural default.
- **Existing write paths:** the context and subscription writers start filling the new change-record columns
  (`origin = source_provided`, `canonical_version`, `schema_snapshot_hash`, `transforms`). Nothing else in their
  behaviour changes. A regression test proves identical canonical results on the Sugar and Chargebee fakes before and
  after.
- **Mapping documents:** new entity kinds and targets are additive in the validator. Existing published mappings
  validate identically, which a test asserts. No republish is required, except for the documented M9B
  `referenceRetirement` re-capture rule.
- **Module enablement:** each optional module is **off per tenant** until enabled (adoption record lists modules).
  Core code never requires module data.
- **Domain-only M1 schemas:** removed only in the sub-milestone that replaces them (G, H, I), together with their own
  unit tests, recorded in the record.
- **Eligibility / ownership / whitespace / coverage:** untouched. A regression suite runs unchanged in every
  sub-milestone. Entitlements stay informational (no evaluator change in M10).

## 7. Tenant migration and adoption strategy

- **Canonical version labels before the freeze.** `0.x`, so nothing implies v1.0:
  - `0.1` = the model implemented today (recorded as the baseline for every existing tenant in migration 1);
  - each sub-milestone that adds canonical structure publishes the next MINOR (`0.2`, `0.3`, …);
  - `1.0` is reserved for the freeze after M9C/M9D.
- **Adoption is explicit and auditable.** `tenant_canonical_adoptions (tenant, version, adopted_at, adopted_by,
modules_enabled, migration_run_id)`. MINOR adoption plus module enablement is an operator action (CLI), with a
  change record (`cause = migration`).
- New tenants start on the latest version with no optional modules enabled.
- No tenant data is rewritten by adoption in M10. The structures are additive. Backfills, such as hierarchy from a
  source, happen through normal mapped sync runs, never by a migration that invents data.

## 8. Source-reference and provenance migration strategy

- Existing `company_external_refs` / `person_external_refs` stay authoritative for accounts and persons. Their M9B
  `retired` semantics and tests are unchanged. No data copy into the generic table, because that would create two
  sources of truth.
- `tenant_source_references` is used by every **new** entity kind:
  - contexts, contracts, price offers, entitlements, signals (source-provided), opportunities, lines, activities,
    cases, goals, custom records;
  - products, via an `entity_key` column (product key) with an exactly-one-of CHECK against `entity_id`.
    **Decision requested.**
- The same lifecycle (`active` / `retired` / `deleted` / `merged`), reactivation and accepted-full-run rules are
  implemented once in a shared reference service and reused.
- A read-only `source_reference_index` (security-invoker view) unions the three reference stores for provenance
  queries, with no write path.
- Change records: widened in place (§3). Every new single writer writes one change record per write. EvidenceLink
  rows are immutable (trigger refuses UPDATE/DELETE for the app role).

## 9. Extension-layer physical design options

| Option                                                                                                                                                                    | Assessment                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Typed value rows + collection item rows + JSONB column for `json` only; definitions in the governed registry with a projection table (recommended; approved in E4)** | DB-enforced types (CHECK: exactly the column for the field's type); indexable per type `(tenant_id, field_id, value_<type>)`; per-value provenance and optional value history; promotion is a mechanical copy; no per-tenant DDL; FK from value → projected field definition |
| B. One JSONB document per (entity, record)                                                                                                                                | Simple writes; weak types; expression indexes per key (DDL-like); whole-document write amplification; per-value provenance lost; rejected as the main store                                                                                                                  |
| C. Per-tenant generated columns / per-tenant tables                                                                                                                       | Violates "no per-tenant DDL" and schema-guard simplicity; rejected                                                                                                                                                                                                           |

Details for A:

- `tenant_extension_values (tenant_id, id, target_kind, target_id, field_id → tenant_registry_entries, value_text,
value_number numeric, value_bool, value_date, value_ts, value_money_minor, value_currency, value_enum,
value_ref_kind, value_ref_id, value_json jsonb, value_state, source triple, observed_at, source_updated_at,
field_hash, registry_version, last_change_id)`.
  - Unique key: `(tenant_id, target_kind, target_id, field_id)`.
  - Multi-select and arrays: `tenant_extension_value_items (tenant_id, value_id, ordinal, item_text | item_number |
item_enum)`.
- `tenant_custom_records (tenant_id, id, object_id, parent_kind, parent_id, natural_key_hash, record_state, …)`.
- `tenant_custom_relationships (tenant_id, id, rel_def_id, from_kind, from_id, to_kind, to_id, state, …)`.
- Polymorphic targets (`target_kind`, `target_id`) cannot carry ordinary foreign keys. **Decision requested:**
  validate them in the single writer inside the tenant transaction, plus a nightly integrity check (recommended); or
  add per-kind deferred trigger checks.
- Guardrails (fields per target, objects, items, JSON size, records) are read from platform configuration and enforced
  at registry publish and write time.

## 10. History / value-history strategy

- **One append-only table**, `tenant_value_history`:
  - columns `(tenant_id, id, entity_kind, entity_id, field, old_value jsonb, new_value jsonb, effective_at,
change_id → tenant_context_changes, recorded_at)`;
  - written by the single writer in the **same transaction** as the projection update, only for fields whose entity
    definition declares `value_history`.
- **Immutable entities** (signals, metric observations, evidence links, recommendation events, action outcomes,
  registry versions) need no value history. Corrections supersede. Immutability is DB-enforced: a trigger, plus no
  UPDATE in the app role's write paths.
- **Sensitivity:** fields marked `personal` / `restricted` do not write value history unless a policy allows it.
  Retention is a configurable guardrail. Tech debt #15/#17 stays open.
- **Initial value-history fields:**
  - Account `parent_account_id` / `customer_status` / `name`;
  - Subscription `state` / terms / product key / quantity / `contract_id`;
  - Opportunity `status` / `stage_code` / amount / close date;
  - AccountContext owner / status;
  - Goal status / target;
  - Contract status / dates.
- Bitemporal modelling stays `DEFERRED`.

## 11. Test strategy

Per sub-milestone (mandatory):

- **Unit / property:**
  - domain schemas and invariants;
  - registry cross-version rules (X1–X5; K-style key rules);
  - cycle detection (property test over random hierarchies);
  - state machines (Recommendation, Goal, Opportunity status);
  - de-duplication keys;
  - guardrail enforcement.
- **Integration (Testcontainers, app role, forced RLS):**
  - every new table is in the schema guard;
  - adversarial cross-tenant tests per table, including polymorphic links;
  - single-writer static scan extended plus a behavioural test per new writer;
  - migrations up / rerun / down-refusal / exact restore / re-apply;
  - merge participants (hierarchy re-pointing, affiliation, contexts, extension values);
  - mapping validation for new targets;
  - provenance completeness: every required change-record field present, test-enforced.
- **Regression (unchanged, every sub-milestone):**
  - the full M7–M9B suites (product model, eligibility, whitespace, coverage tiers, reviewed domain,
    seen-but-rejected, authority, proofs, retirement/reactivation, G4);
  - the Sugar regression;
  - the Chargebee fake suite;
  - identical canonical output on the fakes before and after.
- **Mutation proofs:** break the mechanism, run the guarding test, restore, rerun green:
  - cycle prevention;
  - same-tenant parent;
  - immutability triggers;
  - evidence-link immutability;
  - registry key rules;
  - guardrails;
  - raw-retention-off;
  - reference retirement only on accepted full runs, for new entities;
  - adoption audit;
  - polymorphic-target tenant check.
- **Runtime and Docker:** new runtime checks per sub-milestone (CLI for adoption, registry publish, read models);
  Docker image checks.
- **Fresh clone:** before each sub-milestone is reported complete.
- **Live:** where a live source exists (Chargebee TEST site for commercial references and contracts). Live Sugar
  stays pending.

## 12. Rollback / forward-fix strategy

- **Production:** forward-fix (existing policy). Each sub-milestone is an independent PR. A defect is fixed by a
  follow-up migration or by disabling the module per tenant (adoption record), never by dropping tables with data.
- **Dev/staging:** down-scripts per migration, refusing while dependent data exists, with exact schema restore
  (tested).
- **Data:** no destructive data migration in M10. Adoption never rewrites data, so tenant-level rollback means
  disabling modules or returning the adoption record to the previous MINOR within the compatibility window.
- **Feature isolation:** module flags per tenant. New ingestion targets only take effect through a newly published
  mapping version, so not publishing one is itself a kill switch.

## 13. Performance and indexing

- Every index leads with `tenant_id`.
- Partial indexes for "current / active" rows, for example open opportunities and active signals by account and
  time.
- **Hierarchy:** index `(tenant_id, parent_company_id)`. Roll-ups use recursive CTEs bounded by the depth guardrail.
  Cycle check on write is bounded by the same guardrail.
- **High-volume tables:** `tenant_signals`, `tenant_metric_observations`, `tenant_activities`, `tenant_value_history`,
  `tenant_extension_values`.
  - Primary keys and indexes are designed to allow later range partitioning by time.
  - Partitioning itself is `DEFERRED` until volume evidence exists.
  - Retention guardrails are configurable.
- **Extension:** one composite index per typed value column (`tenant_id, field_id, value_x`) plus an items index.
  Batch loading by `target_id = ANY($1)` (no N+1 in read models).
- **Immutability triggers:** row-level and cheap. Evidence-link writes are batched per derivation.
- **Value history:** written only for declared fields, which bounds write amplification.

## 14. Multi-tenant isolation constraints

- Every new table: `tenant_id`, forced RLS policy `tenant_id = current_setting(...)`, tenant-scoped unique keys,
  composite `(tenant_id, x)` foreign keys. The schema-guard test enforces it.
- Global tables: only `canonical_model_versions` (reference data, no tenant content), like `connector_kinds`.
- Polymorphic references (evidence links, extension targets, custom relationships, activity links) are validated
  inside the tenant transaction against same-tenant rows. Adversarial tests attempt cross-tenant ids.
- Registries are per tenant. Platform generic definitions are copied into a tenant registry on adoption; there is no
  shared mutable state.
- The non-privileged app role is unchanged. No new role privileges, and no `BYPASSRLS`.
- Jobs (BullMQ) keep carrying tenant context. New processors use `TenantDatabase.transaction`.

## 15. Proposed sub-milestones

Each sub-milestone is its own plan approval, PR, verification (`pnpm verify`, runtime, Docker, fresh clone),
independent review and closure. **Unchanged in every one:**

- tenant isolation;
- Product Model versioning and relationships;
- subscription line identity;
- derived ownership, eligibility, whitespace and coverage tiers;
- reviewed-domain semantics;
- seen-but-rejected protection;
- source authority;
- completeness proof and `stable_snapshot`;
- historical retirement/reactivation;
- M9B source-reference semantics.

### M10A — Canonical versioning, governed registries, change-record widening, value history, mapping lifecycle

- **Objective:** the platform foundation every later entity uses. No business entity yet.
- **Schema:**
  - `canonical_model_versions` (seed `0.1` baseline);
  - `tenant_canonical_adoptions` (every existing tenant adopts `0.1`);
  - `tenant_registry_versions` / `tenant_registry_entries`;
  - `tenant_value_history`;
  - `tenant_context_changes` widened;
  - mapping `lifecycle_state` + `canonical_version_min` + drafts table.
- **Code:**
  - domain: canonical version and registry document schemas (cross-version rules), change-record origin/derivation
    types;
  - services: adoption, registry publish (base version, hash, human confirmation), value-history writer helper,
    mapping draft/validate/publish/supersede/retire;
  - existing writers fill new change-record columns.
- **Migration:** deterministic backfill of mapping lifecycle states; adoption baseline rows. No other data change.
- **Tests:**
  - registry rules (property);
  - adoption audit;
  - mapping lifecycle transitions (published mappings never mutated);
  - change-record completeness;
  - regression: identical canonical results on the fakes;
  - migration up/down/refusal.
- **Unchanged:** all existing behaviour; existing mappings validate identically.
- **Gates:** `pnpm verify`, runtime, Docker, fresh clone, mutation proofs (registry key rules, mapping immutability,
  adoption audit), independent review.

### M10B — Generic SourceReference + EvidenceLink

- **Objective:** one reusable reference service (lifecycle, reactivation, accepted-full-run retirement) and immutable
  evidence links for all new entities.
- **Schema:** `tenant_source_references` (with `entity_key` for products, pending decision), `tenant_evidence_links`
  (immutability trigger), read-only `source_reference_index` view.
- **Code:**
  - a shared `SourceReferenceService` reusing the M9B retirement rules;
  - EvidenceLink writer;
  - provenance query read model ("where did this value come from").
- **Migration:** additive. Existing company/person refs untouched.
- **Tests:**
  - lifecycle (active/retired/deleted/merged, reactivation without duplicates);
  - retirement only on accepted proven full runs;
  - seen-but-rejected protection for the generic store;
  - immutability;
  - adversarial cross-tenant tests;
  - M9B retirement tests unchanged and green.
- **Unchanged:** M9B Chargebee customer retirement; company/person reference semantics.
- **Gates:** as A, plus mutation proofs (immutability, retirement gate, reactivation).

### M10C — Account hierarchy + Person–Account affiliation

- **Objective:** canonical `parent_account_id` (`companies.parent_company_id`), which **does not exist today**, and
  `tenant_person_affiliations`.
- **Schema:**
  - nullable parent column, composite FK, `CHECK (parent <> id)`;
  - cycle prevention: a `BEFORE INSERT/UPDATE` trigger walking ancestors (bounded), plus the writer under a
    per-tenant advisory lock for the hierarchy;
  - affiliation table;
  - authority column `account_hierarchy_connection_id`.
- **Code:**
  - Account single writer handles parent changes (value history; source authority `account_hierarchy`);
  - mapping target `account.parent` (relationship to account, human-confirmed);
  - person affiliation target;
  - depth guardrail from configuration;
  - merge participant re-points children to the survivor;
  - roll-up read model (derived).
- **Migration:** additive. No hierarchy is invented; it arrives only from mapped sources or operator entry.
- **Tests:**
  - same tenant only;
  - no cycles (property test plus trigger mutation);
  - optional parent;
  - guardrail refusal recorded as a data-quality issue;
  - value history on parent change;
  - source disappearance never deletes or unparents the canonical Account (parent kept until an authoritative
    source changes it);
  - merge re-pointing;
  - not modelled via AccountContext (no context code involved).
- **Unchanged:** account identity, references, record states, merge lineage.
- **Gates:** standard plus mutation proofs (cycle trigger, same-tenant FK, guardrail).

### M10D — Extension framework foundation

- **Objective:** governed tenant extension: custom fields (scalar, enum, money, reference, multi-select, array,
  JSON), custom objects/records, custom relationships, source attribute capture.
- **Schema:** extension values / items / custom records / custom relationships; definitions in the registry (kind
  `extension`) plus projection.
- **Code:**
  - registry validation (types, constraints, guardrails, sensitivity, `allowed_uses`, `not_evidence_of`);
  - extension value writer (typed, provenance, optional value history);
  - custom record writer;
  - mapping entry kinds `attribute`, `custom_object`, `custom_relationship`, `capture` (the validator un-reserves
    `attribute`);
  - merge participant for values;
  - read models with batch loading.
- **Tests:**
  - every value type round-trips, with DB CHECK enforcement;
  - a tenant with 500+ fields needs no DDL;
  - guardrails;
  - `allowed_uses` enforced (cannot feed eligibility/ownership);
  - restricted values not stored while raw retention is off;
  - cross-tenant polymorphic attempts;
  - registry X1–X5.
- **Unchanged:** canonical tables and columns (no per-field columns); eligibility (no `registered_attribute` condition
  in M10).
- **Gates:** standard plus mutation proofs (type CHECK, guardrail, allowed-use enforcement, polymorphic tenant check).

### M10E — AccountContext

- **Objective:** the optional business-context module, separate from hierarchy.
- **Schema:** contexts + persons + products; context type registry entries; `tenant_subscriptions.context_id`
  (0..1).
- **Code:**
  - AccountContext writer (natural key, dimensions validated against context type);
  - mapping entity `account_context`;
  - source references via the generic store;
  - module enablement check.
- **Tests:**
  - optional (module off ⇒ zero behavioural change, regression);
  - two contexts for the same account and product in different regions;
  - 0..1 context per line;
  - retirement never cascades to account/lines.
- **Unchanged:** account-level behaviour for tenants without the module.
- **Gates:** standard.

### M10F — Commercial: Price/Offer, Contract, Entitlement, line commercial references

- **Objective:** keep Product ≠ Price/Offer ≠ Subscription line ≠ Contract ≠ Entitlement.
- **Schema:**
  - price offers;
  - contracts (+ `renews` / `amends` / `parent`);
  - entitlements (informational);
  - line columns `agreement_ref_*`, `contract_id`, `price_offer_id`, `supersedes_line_id`.
- **Code:**
  - writers;
  - mapping target `subscription.agreement` (human-confirmed; refuses deal/opportunity groupings by confirmation);
  - resolution of `agreement_ref` → Contract source reference → `contract_id`, with value history;
  - Chargebee mapping example: ItemPrice → Price/Offer, Subscription header → Contract (TEST configuration only).
- **Tests:**
  - renewal, amendment, replacement and co-terming scenarios (E3 §4.2);
  - `agreement_ref` never used as identity or reference row;
  - price offers never affect ownership;
  - entitlements never affect eligibility in M10.
- **Unchanged:** line identity, ownership derivation, Chargebee/Sugar ingestion results.
- **Gates:** standard plus live Chargebee TEST-site read where possible.

### M10G — Vendor-neutral Signal + Signal Type Registry

- **Objective:** replace the `DOMAIN-ONLY` vendor-bound M1 Signal.
- **Schema:** `tenant_signals` (immutable; supersession; de-duplication key unique); signal types in the registry
  (platform generic definitions copied on adoption).
- **Code:**
  - Signal domain schema (origin, derivation, polarity, severity, strength, effective period);
  - Signal writer;
  - mapping entity `signal` for source-provided signals;
  - derivation **interface** only (definitions engine later);
  - evidence links;
  - remove the M1 `signals.ts` and its tests.
- **Tests:**
  - no vendor in types;
  - a new type is a registry version only (no migration);
  - immutability;
  - de-duplication;
  - origin distinguishable;
  - a signal never writes canonical facts.
- **Gates:** standard plus mutation proofs (immutability, de-duplication, vendor-neutral validator).

### M10H — Opportunity + Opportunity lines + contact roles

- **Objective:** scopes `account` / `account_product` / `context_product`; Person optional; lines vendor-neutral.
- **Schema:** opportunities, lines, contacts; unique partial equivalence key for open platform-derived opportunities.
- **Code:**
  - writer;
  - mapping entity `opportunity` (`source_native`) with stage value maps;
  - operator/API creation (`human`, `platform_derived` via an explicit call; no generation engine);
  - link `platform_derived` → `source_native`;
  - remove M1 `LeadCandidate` / `Lead`.
- **Tests:**
  - Account-only, Account+Product, Context+Product;
  - no Person required;
  - multiple lines;
  - one source record never counted as both opportunity line and subscription line without disjoint filters;
  - status value history.
- **Gates:** standard.

### M10I — Recommendation, decision events, Action, ActionOutcome

- **Objective:** the DECISION / ACTION / ACTION OUTCOME records of the reasoning chain. No customer-system writes.
- **Schema:** recommendations, events (immutable), actions, action outcomes; action type registry.
- **Code:**
  - writers;
  - state machine;
  - "human decision wins" rule;
  - evidence links (≥ 1 for rule/AI generators);
  - remove M1 `QualificationDecision` / `SalesOutcome`.
- **Tests:**
  - lifecycle transitions;
  - human-wins;
  - immutability of events and outcomes;
  - ActionOutcome ≠ Goal (no shared table or type).
- **Gates:** standard.

### M10J — Value: Goal, MetricDefinition, MetricObservation

- **Schema:** goals; metric observations; metric definitions in the registry.
- **Code:**
  - writers;
  - mapping entity `metric_observation` (source-provided health/usage);
  - AI-suggested goals need human confirmation before `active`.
- **Tests:**
  - goal scopes;
  - immutable observations with supersession;
  - no BusinessOutcome entity;
  - health as an observation or signal only.
- **Gates:** standard.

### M10K — Engagement: Activity, ActivityParticipant, ContentReference, SupportCase

- **Schema:** activities, participants, links, content references (store **disabled by default**), support cases.
- **Code:**
  - writers;
  - mapping entities `activity` / `support_case`;
  - participant resolution (Person / internal user / unresolved, masked);
  - derived account links with confidence and review on ambiguity.
- **Tests:**
  - no vendor objects;
  - content never in core rows;
  - content store off by default;
  - an Activity never creates an Opportunity directly.
- **Gates:** standard plus privacy mutation (content-off).

### M10L — Data quality: rejected observations + field intelligence

- **Schema:** `tenant_rejected_observations`, `tenant_field_metadata`.
- **Code:**
  - dispositions (normalize / transform / hold / reject) in the mapping engine;
  - the rejected-observation writer (reference, reason, safe diagnostics, non-sensitive candidate with TTL, source
    coordinates only, raw retention **off**);
  - field metadata updated by runs and profiles (last seen / populated / changed, drift, mapping and usage status).
- **Tests:**
  - the E7 §5 trace as executable tests (no raw value persisted anywhere);
  - candidate TTL purge;
  - resolution lifecycle;
  - "unchanged ≠ stale".
- **Gates:** standard plus privacy mutation proofs.

### M10M — Migration framework and adoption hardening

- **Objective:** canonical migration preview / impact / approval / execution / verification / audit as tooling;
  adoption CLI; end-to-end adoption of the latest `0.x` by existing tenants; full regression and performance check.
- **Gates:**
  - full verification and fresh clone;
  - independent review;
  - a canonical v1 implementation record;
  - **no v1.0 freeze** (that still requires M9C/M9D).

## 16. Decisions requested before M10A

1. **Version labels:** use `0.x` for implemented canonical versions until the v1.0 freeze (recommended), so nothing
   implies v1.0.
2. **Polymorphic references:** validate in the single writer plus a nightly integrity check (recommended), or use
   deferred trigger checks per kind.
3. **Product source references:** the generic store with an `entity_key` column (recommended), or a dedicated product
   reference table.
4. **Roadmap renumbering:** M10 = Canonical Architecture Implementation. The former M10 (signal ingestion) and M11
   (candidate model) data halves are absorbed. Their engine halves (signal derivation definitions; candidate
   generation and suppression) become the next milestones after M10. M12–M17 shift accordingly. On approval, the
   roadmap (`docs/milestones/README.md`, `docs/product/roadmap.md`) is updated, together with the candidate's
   references that use the old numbering: "signal definitions (M10)" in E3 §6 and "Data Intelligence Console (M10)"
   in E4 §6 and E7 §3. The console is not part of this M10; its data (field metadata, rejected observations) is
   built in M10L.
5. **Module enablement:** per tenant, recorded on the adoption record (recommended).
6. **Engines out of M10** (recommended): derivation, generation, qualification and routing engines are not built in
   M10.

## 17. Open items (unchanged, separate)

- tech debt #15 (privacy decision), #62, #63, #64;
- live Chargebee mutations M09/M10 not run (the roadmap's M10 name does not affect these Chargebee mutation labels);
- V6, V9, V10, V11;
- Chargebee incremental sync disabled;
- live Sugar verification pending.
