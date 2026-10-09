# Milestone 10 — Canonical Architecture + Security/Data Governance Implementation: plan

- Status: **PLAN, REVISION 2. Approved in principle (2026-10-09), with decisions D1–D6 and the security & data
  governance amendment (§0a).** This revision applies them. **M10A1 does not start until the owner approves this
  revision.** No schema, migration or code change has been made for M10.
- Input: the approved [Canonical Architecture v1 Candidate](../architecture/canonical-v1/CANDIDATE.md) (M9E, E12 `PASS
— CANONICAL ARCHITECTURE V1 CANDIDATE APPROVED`) and [ADR 0025](../adr/0025-canonical-architecture-v1-candidate.md).
- Base: `main` after the M9E closure (`19a0044`).
- Not in scope:
  - M9C (file/S3) and M9D (warehouse/table), which remain future pressure tests before the v1.0 freeze;
  - freezing Canonical v1.0;
  - writes to customer systems;
  - any claim of SOC 2, HIPAA or other compliance. M10 builds the **technical foundations** for later enterprise
    hardening and SOC 2 readiness. It certifies nothing.
- Labels:
  - `IMPLEMENTED TODAY`: code, schema and tests on `main`;
  - `APPROVED CANONICAL TARGET`: approved in the candidate, **not built**.

## 0. Scope boundary: what M10 builds and what it does not

M10 builds the **canonical data foundation together with its security and data-governance foundation**:

- tables and constraints;
- domain schemas;
- single writers with authorization boundaries;
- registries;
- source references, provenance and evidence;
- mapping targets for source-provided data;
- operator/API entry for human-entered records;
- read models;
- versioning, tenant adoption and module enablement;
- data classification, retention metadata, audit events and integrity verification.

Security is part of every sub-milestone's acceptance (§15). It is not a later retrofit.

It does **not** build the **intelligence engines** that later consume that data (D6):

- signal derivation definitions and their evaluator;
- opportunity candidate generation and suppression decisions;
- recommendation generation;
- qualification;
- prioritisation and routing;
- writes to customer systems;
- outcome measurement.

They move to M11 and later (§19).

## 0a. Owner decisions (2026-10-09) and how this revision applies them

| #   | Decision                                                                                                                                                                                                                                                                     | Applied in                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| D1  | Canonical versions are `0.x` during implementation and validation. `1.0` is reserved exclusively for the later Canonical v1.0 freeze gate                                                                                                                                    | §7, M10A2                             |
| D2  | Polymorphic references: defense in depth (writer validation **plus** database enforcement **plus** periodic integrity verification). Cross-tenant references impossible even if the application is bypassed; mutation/adversarial tests prove the protection is load-bearing | §18, M10A2, every later sub-milestone |
| D3  | Product SourceReference: the generic store with a product-key representation, no dedicated product reference table. Product Model versioning and product identity unchanged                                                                                                  | §8, §18, M10B                         |
| D4  | Roadmap renumbered. New M10 = **Canonical Architecture + Security/Data Governance Implementation**; former M10/M11 engine work moves after it; references updated consistently                                                                                               | §19                                   |
| D5  | Module enablement is **not** stored on the canonical adoption record. A separate tenant-scoped, auditable module-enablement mechanism. Changing a module never implies a canonical version change                                                                            | §17, M10A2                            |
| D6  | Engines stay out of M10                                                                                                                                                                                                                                                      | §0                                    |
| SG  | Security & data governance throughout: every sub-milestone has two acceptance sections, `Canonical / business correctness` and `Security & Data Governance`                                                                                                                  | §16, §15                              |

## 1. Current schema and components that can be reused (`IMPLEMENTED TODAY`)

| Component                                                                                                             | Reuse in M10                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `companies` (Account), `persons`, `tenant_subscriptions`, `tenant_product_models` / `tenant_products`                 | kept; additive columns only (hierarchy, line commercial references)                                                             |
| `company_external_refs`, `person_external_refs` (incl. M9B `retired` state)                                           | kept unchanged; the new generic source-reference store covers **new** entities                                                  |
| `tenant_context_changes` (change log, field names only)                                                               | widened in place (nullable columns + widened CHECKs); becomes the universal change record                                       |
| `ContextIngestionService` / `SubscriptionIngestionService` single writers; `decideApply` ordering; merge participants | pattern for every new single writer; merge participants extended for hierarchy, affiliation, contexts, extension values         |
| Versioned-document pattern (product model, mapping, authority, schema snapshot): immutable, hashed, base version      | reused for one generic **governed registry** store (extension, signal types, metrics, action types, context types, data policy) |
| Mapping document, validator, engine, closed transform set, run guards, seen-but-rejected, proofs, coverage tiers      | extended with new targets / entity kinds; guarantees unchanged                                                                  |
| `tenant_source_authority_versions`                                                                                    | additive authority facts (e.g. `account_hierarchy`)                                                                             |
| M9A profiling (field stats, drift, findings, privacy detectors)                                                       | input to field intelligence; detectors reused for value classification and secret-like detection                                |
| `tenant_ownership_gaps`, `tenant_identity_conflicts`, `tenant_dead_letters`                                           | kept; data-quality records complement them                                                                                      |
| `tenant_flow_settings` (per-tenant flow mode, versioned)                                                              | precedent for per-tenant settings; module enablement gets its own table with an audit trail (§17)                               |

Security foundations that exist today and are kept (`IMPLEMENTED TODAY`):

- **Tenant isolation** (ADR 0008): forced RLS on every table, `app_current_tenant()`, `TenantDatabase.transaction`.
  The schema-guard integration test already asserts:
  - RLS enabled and forced everywhere;
  - `NOT NULL tenant_id` plus a tenant policy;
  - tenant-scoped unique constraints;
  - foreign keys between tenant tables include `tenant_id`;
  - the app role cannot bypass RLS;
  - exactly one owner function, `SECURITY DEFINER` with a fixed `search_path`.
- **Least-privilege roles:** owner (DDL, migrations) / `lip_app` (DML only) / runtime login role. A role guard
  refuses superuser, `BYPASSRLS` or non-`lip_app` roles at start-up and on readiness checks.
- **Secrets:**
  - the `SecretProvider` (ADR 0003);
  - `tenant_credential_refs` holds only secret **names**, with a CHECK forcing the `tenant.<slug>` prefix;
  - OAuth grants are encrypted with the platform token cipher (format `v1`, one key, no key identifier).
- **Privacy rule:** no raw source values in run records, findings, logs or gaps, test-enforced. Profiles store no
  samples. Raw rejected-value retention is off (tech debt #15).
- **Audit precedent:** M9A's append-only audit of privileged profile purges.

Not present today (built by M10, or explicitly left for later):

- user identity and roles (the CLI operator is the only human actor);
- a general audit-event store;
- field-level data classification;
- retention-policy metadata;
- key identifiers / key rotation for encrypted values;
- data-subject export/erasure hooks.

`DOMAIN-ONLY` schemas to be replaced (unused, unpersisted): M1 `Signal` (vendor-bound), `LeadCandidate` / `Lead`
(person-required), `QualificationDecision`, `SalesOutcome`. Their removal deletes their own unit tests together with
the code. That removes tests of removed code and does not weaken any guarantee. It is recorded per sub-milestone.

## 2. New tables actually required (`APPROVED CANONICAL TARGET` → proposed physical names)

All are tenant-owned with forced RLS, `tenant_id` first in every key, and composite tenant foreign keys, unless
marked **global**.

| Area                            | Tables                                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security & governance           | `tenant_audit_events` (append-only); `tenant_entity_index` (polymorphic reference anchor, §18); `tenant_integrity_runs` (verification results)                                                                                           |
| Versioning                      | `canonical_model_versions` (**global** reference data, like `connector_kinds`); `tenant_canonical_adoptions`; `tenant_canonical_migration_runs`                                                                                          |
| Modules                         | `canonical_modules` (**global** catalogue); `tenant_module_settings` (current state); `tenant_module_setting_events` (append-only) — §17                                                                                                 |
| Registries                      | `tenant_registry_versions` (kind: `extension` / `signal_type` / `metric` / `action_type` / `context_type` / `data_policy`; immutable versions); projections `tenant_registry_entries` (current definitions, used as foreign-key targets) |
| References / evidence / history | `tenant_source_references` (generic, for new entities and products); `tenant_evidence_links` (immutable); `tenant_value_history` (append-only)                                                                                           |
| Hierarchy / affiliation         | `tenant_person_affiliations` (hierarchy itself is a column on `companies`)                                                                                                                                                               |
| Account Context                 | `tenant_account_contexts`; `tenant_account_context_persons`; `tenant_account_context_products`                                                                                                                                           |
| Commercial                      | `tenant_price_offers`; `tenant_contracts`; `tenant_contract_links`; `tenant_entitlements`                                                                                                                                                |
| Signal                          | `tenant_signals` (immutable, supersession)                                                                                                                                                                                               |
| Opportunity                     | `tenant_opportunities`; `tenant_opportunity_lines`; `tenant_opportunity_contacts`                                                                                                                                                        |
| Decision chain                  | `tenant_recommendations`; `tenant_recommendation_events` (immutable); `tenant_actions`; `tenant_action_events` (immutable); `tenant_action_outcomes` (immutable)                                                                         |
| Value                           | `tenant_goals`; `tenant_metric_observations` (MetricDefinition lives in the registry + projection)                                                                                                                                       |
| Engagement                      | `tenant_activities`; `tenant_activity_participants`; `tenant_activity_links`; `tenant_content_references`; `tenant_support_cases`                                                                                                        |
| Extension                       | `tenant_extension_values`; `tenant_extension_value_items`; `tenant_custom_records`; `tenant_custom_relationships` (definitions in the registry + projection)                                                                             |
| Data quality                    | `tenant_rejected_observations`; `tenant_field_metadata`                                                                                                                                                                                  |

- No `customer_products` table: CustomerProduct stays a **derived view** (owner decision 8).
- No `business_outcomes` table: the customer value outcome is the Goal.
- No per-tenant tables or columns anywhere.

## 3. Existing tables that need additive changes

| Table                                                                                 | Additive change                                                                                                                                                                                               | Notes                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `companies`                                                                           | `parent_company_id uuid NULL` (canonical name `parent_account_id`), composite FK `(tenant_id, parent_company_id)` → `companies`, CHECK `parent_company_id <> id`, index                                       | Account hierarchy **does not exist today**. Cycle prevention: M10C. Depth: configurable guardrail                |
| `tenant_subscriptions`                                                                | `agreement_ref_system`, `agreement_ref_object_type`, `agreement_ref_external_id` (all-or-none CHECK); `contract_id`; `price_offer_id`; `context_id`; `supersedes_line_id`; all nullable                       | Line identity unchanged; `agreement_ref` is an attribute, not an identity or reference row                       |
| `tenant_context_changes`                                                              | `origin`, `derivation` (jsonb: key, version, inputs hash), `actor_kind`, `actor_id`, `canonical_version`, `schema_snapshot_hash`, `transforms` (text[]); widened `entity_kind`, `change_type`, `cause` CHECKs | Existing rows keep NULL = "pre-M10 record"; no backfill of invented values                                       |
| `tenant_source_authority_versions`                                                    | `account_hierarchy_connection_id` (and later facts per module, e.g. `opportunity_connection_id`)                                                                                                              | Immutable versions: a new authority version is published to use a new fact                                       |
| `tenant_source_mapping_versions`                                                      | `lifecycle_state` (`published` / `superseded` / `retired`), `canonical_version_min`; plus `tenant_source_mapping_drafts` (new, mutable) for `draft` / `validated`                                             | Existing rows: `published` for the latest per connection, `superseded` for earlier ones (deterministic backfill) |
| `tenant_identity_conflicts`                                                           | widened `kind` / `entity_kind` CHECKs (extension value conflicts, hierarchy conflicts)                                                                                                                        |                                                                                                                  |
| Entity tables (`companies`, `persons`, `tenant_products`, and every new entity table) | entity-index triggers (§18); no column change                                                                                                                                                                 | Existing rows are indexed by the M10A2 migration (deterministic backfill, counted and verified)                  |
| `connector_kinds`                                                                     | none                                                                                                                                                                                                          |                                                                                                                  |

Code (no schema): the token cipher gains a key-identified format (`v2:<key-id>:…`) that can still read `v1` (M10A1,
§16). This enables key rotation later without a data migration.

## 4. Dependency analysis and order

Observed dependencies (from the repository and the candidate):

- **Security primitives come first.** These are actor attribution, write authorization, audit events, data
  classification and secret-like value refusal. Every later table and writer must use them from day one; a
  retrofit would mean touching every writer twice. Hence M10A1.
- Every new entity needs the widened change record, the entity index (for polymorphic integrity), a source-reference
  store and, for some fields, value history **before** its single writer exists.
- Signal type, metric, action type, context type, extension and data-policy definitions all use one governed-registry
  pattern. Build it once, early (M10A2).
- Module enablement must exist before the first optional module (AccountContext, M10E). It is built with adoption in
  M10A2 but stored separately (D5).
- Several entities carry optional references (`context_id`, `contract_id`, `price_offer_id`). Building
  **AccountContext and Commercial before Signal / Opportunity** gives those foreign keys from day one, instead of
  later nullable retrofits.
- Opportunity evidence cites Signals through EvidenceLink. That reference is polymorphic and anchored by the entity
  index, so there is no hard FK dependency. `source_native` Opportunity ingestion and Recommendation targets need
  Opportunity before Recommendation.
- Goal links to Opportunity and Contract, so Value comes after them. Activity links to Opportunity and SupportCase,
  so Engagement comes after Opportunity.
- Extension custom relationships target any entity polymorphically. The framework can come early. Later entities
  become targets through their entity-index registration.
- Data-quality records and field intelligence attach to mapping runs and extension fields, so they come after
  Extension. Interim behaviour (counters, gaps, seen-but-rejected) is already safe.

**Recommended order:** A1, A2, B, C, D, E, F, G, H, I, J, K, L, M (§15). Compared with the owner's suggested list:

- the foundation is split into **security & governance primitives (A1)**, versioning/registries/modules/history (A2),
  and references/evidence (B);
- hierarchy moves to C, after its provenance prerequisites;
- AccountContext (E) and Commercial (F) move **before** Signal/Opportunity;
- data quality / field intelligence becomes its own sub-milestone (L);
- migration/adoption hardening stays last (M).

## 5. Migration sequence

Each sub-milestone has one forward migration, two at most. Each has a dev/staging down-script that **refuses while
data exists** (existing pattern). Each has migration tests: up, idempotent rerun, down-refusal, exact restore,
re-apply.

| #   | Migration (indicative name)                   | Content                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `m10a1_security_governance_foundation`        | `tenant_audit_events` (append-only: trigger + privileges); change-record actor columns; privilege manifest applied (REVOKE UPDATE/DELETE on append-only tables)                                                                                                                                        |
| 2   | `m10a2_versioning_modules_registries_history` | `canonical_model_versions` seed (`0.1`); `tenant_canonical_adoptions`; `canonical_modules`; `tenant_module_settings` / events; registries; `tenant_value_history`; `tenant_entity_index` + triggers + backfill; `tenant_integrity_runs`; change-record widening; mapping lifecycle + drafts + backfill |
| 3   | `m10b_source_references_evidence`             | `tenant_source_references` (entity-index FKs, product key); `tenant_evidence_links` (+ immutability)                                                                                                                                                                                                   |
| 4   | `m10c_account_hierarchy_affiliation`          | `companies.parent_company_id` + FK + CHECK + cycle trigger; `tenant_person_affiliations`; authority column                                                                                                                                                                                             |
| 5   | `m10d_extension_framework`                    | extension values / items / custom records / custom relationships (entity-index FKs)                                                                                                                                                                                                                    |
| 6   | `m10e_account_context`                        | contexts + members + products; `tenant_subscriptions.context_id`                                                                                                                                                                                                                                       |
| 7   | `m10f_commercial`                             | price offers, contracts (+ links), entitlements; line `agreement_ref_*`, `contract_id`, `price_offer_id`, `supersedes_line_id`                                                                                                                                                                         |
| 8   | `m10g_signals`                                | `tenant_signals`                                                                                                                                                                                                                                                                                       |
| 9   | `m10h_opportunities`                          | opportunities, lines, contacts                                                                                                                                                                                                                                                                         |
| 10  | `m10i_decision_chain`                         | recommendations, events, actions, action events, action outcomes                                                                                                                                                                                                                                       |
| 11  | `m10j_value`                                  | goals, metric observations                                                                                                                                                                                                                                                                             |
| 12  | `m10k_engagement`                             | activities, participants, links, content references, support cases                                                                                                                                                                                                                                     |
| 13  | `m10l_data_quality`                           | rejected observations, field metadata                                                                                                                                                                                                                                                                  |
| 14  | `m10m_migration_runs`                         | `tenant_canonical_migration_runs` and approval records                                                                                                                                                                                                                                                 |

- All migrations are **additive**: new tables, nullable columns, widened CHECKs, triggers, privilege
  tightening (REVOKE only).
- None renames or drops an existing column or table. `companies` stays `companies`.
- No migration grants the app role a new privilege beyond DML on the new tables. Append-only tables get INSERT and
  SELECT only.

## 6. Backward compatibility strategy

- **Additive only.**
  - Existing writers, readers, mappings, product models, authority versions, snapshots and APIs keep working
    unchanged after each migration.
  - New columns are nullable with no behavioural default.
- **Existing write paths:** the context and subscription writers start filling the new change-record columns
  (`origin = source_provided`, `actor_kind = source_sync`, `canonical_version`, `schema_snapshot_hash`,
  `transforms`). Nothing else in their behaviour changes. A regression test proves identical canonical results on the
  Sugar and Chargebee fakes before and after.
- **Mapping documents:** new entity kinds and targets are additive in the validator. Existing published mappings
  validate identically, which a test asserts. No republish is required, except for the documented M9B
  `referenceRetirement` re-capture rule.
- **Modules:** every optional module is **disabled per tenant** until enabled through the module-enablement mechanism
  (§17). Core code never requires module data.
- **Token cipher:** `v2` writes, `v1` still reads. Existing stored grants stay valid without re-encryption.
- **Domain-only M1 schemas:** removed only in the sub-milestone that replaces them (G, H, I), together with their own
  unit tests, recorded in the record.
- **Eligibility / ownership / whitespace / coverage:** untouched. A regression suite runs unchanged in every
  sub-milestone. Entitlements stay informational (no evaluator change in M10).

## 7. Tenant canonical-version adoption strategy

- **Canonical version labels (D1).** `0.x` during implementation and validation:
  - `0.1` = the model implemented today, recorded as the baseline adoption for every existing tenant in migration 2;
  - each sub-milestone that adds canonical structure publishes the next MINOR (`0.2`, `0.3`, …);
  - **`1.0` is reserved exclusively for the Canonical v1.0 freeze gate** (after M9C/M9D and the relocated M9 §13.5
    gate). A CHECK refuses any `canonical_model_versions` row with MAJOR ≥ 1 until a freeze migration explicitly lifts
    it, with its ADR. A test proves the CHECK refuses `1.0`.
- **Adoption is explicit and auditable.** `tenant_canonical_adoptions (tenant, version, adopted_at, actor,
previous_version, migration_run_id, reason)` is append-only; the current version is the latest row. Adoption is an
  operator action (CLI) requiring the capability `config.canonical.adopt`, and it writes an audit event.
- **Adoption is separate from module enablement (D5).** The adoption record contains no module list (§17).
- New tenants start on the latest `0.x` with no optional modules enabled.
- No tenant data is rewritten by adoption in M10. The structures are additive. Backfills, such as hierarchy from a
  source, happen through normal mapped sync runs, never by a migration that invents data.

## 8. Source-reference and provenance migration strategy

- Existing `company_external_refs` / `person_external_refs` stay authoritative for accounts and persons. Their M9B
  `retired` semantics and tests are unchanged. No data is copied into the generic table, because that would create
  two sources of truth.
- `tenant_source_references` is used by every **new** entity kind:
  - contexts, contracts, price offers, entitlements, signals (source-provided), opportunities, lines, activities,
    cases, goals and custom records, through `(entity_kind, entity_id)`;
  - **products, through the product key (D3):**
    - `(entity_kind = 'product', entity_key = product_key)`, with an exactly-one-of CHECK against `entity_id`;
    - enforced by a composite FK to the entity index, whose product rows mirror `tenant_products (tenant_id, key)`.
  - Product identity stays the tenant-scoped product key. Product Model versions stay immutable and are not
    referenced by source references, so a product reference survives model versions exactly as subscriptions do
    today.
- The same lifecycle (`active` / `retired` / `deleted` / `merged`), reactivation and accepted-full-run rules are
  implemented once in a shared reference service and reused. Every lifecycle transition writes a change record and,
  where privileged, an audit event.
- A read-only `source_reference_index` (security-invoker view) unions the three reference stores for provenance
  queries. It has no write path.
- Change records are widened in place (§3). Every new single writer writes one change record per write.
- EvidenceLink rows are immutable. The app role has no UPDATE/DELETE privilege on them, and a trigger refuses
  UPDATE/DELETE from any role except during an audited migration.

## 9. Extension-layer physical design options

| Option                                                                                                                                                                    | Assessment                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Typed value rows + collection item rows + JSONB column for `json` only; definitions in the governed registry with a projection table (recommended; approved in E4)** | DB-enforced types (CHECK: exactly the column for the field's type); indexable per type `(tenant_id, field_id, value_<type>)`; per-value provenance and optional value history; per-field classification; promotion is a mechanical copy; no per-tenant DDL; FK from value → projected field definition; target anchored in the entity index (§18) |
| B. One JSONB document per (entity, record)                                                                                                                                | Simple writes; weak types; expression indexes per key (DDL-like); whole-document write amplification; per-value provenance and per-field classification lost; rejected as the main store                                                                                                                                                          |
| C. Per-tenant generated columns / per-tenant tables                                                                                                                       | Violates "no per-tenant DDL", schema-guard simplicity and least privilege (the app role would need DDL); rejected                                                                                                                                                                                                                                 |

Details for A:

- `tenant_extension_values (tenant_id, id, target_kind, target_id, target_key, field_id → tenant_registry_entries,
value_text, value_number numeric, value_bool, value_date, value_ts, value_money_minor, value_currency, value_enum,
value_ref_kind, value_ref_id, value_json jsonb, value_state, sensitivity, source triple, observed_at,
source_updated_at, field_hash, registry_version, last_change_id)`.
  - Unique key: `(tenant_id, target_kind, target_id, field_id)`.
  - `(tenant_id, target_kind, target_id|target_key)` and `(tenant_id, value_ref_kind, value_ref_id)` are composite
    FKs to the entity index (§18).
  - Multi-select and arrays: `tenant_extension_value_items (tenant_id, value_id, ordinal, item_text | item_number |
item_enum)`.
- `tenant_custom_records (tenant_id, id, object_id, parent_kind, parent_id, natural_key_hash, record_state, …)`.
  Custom records are entity-index kind `custom_record`, a single kind, so no per-tenant DDL is needed.
- `tenant_custom_relationships (tenant_id, id, rel_def_id, from_kind, from_id, to_kind, to_id, state, …)`, both ends
  anchored in the entity index.
- Guardrails (fields per target, objects, items, JSON size, records) are read from platform configuration and enforced
  at registry publish and write time.
- Secrets can never be extension values (§16 control 7).

## 10. History / value-history strategy

- **One append-only table**, `tenant_value_history`:
  - columns `(tenant_id, id, entity_kind, entity_id, field, old_value jsonb, new_value jsonb, effective_at,
change_id → tenant_context_changes, actor_kind, recorded_at)`;
  - written by the single writer in the **same transaction** as the projection update, only for fields whose entity
    definition declares `value_history`;
  - the app role has INSERT and SELECT only; a trigger refuses UPDATE/DELETE.
- **Immutable entities** need no value history; corrections supersede. They are signals, metric observations,
  evidence links, recommendation and action events, action outcomes and registry versions. Immutability is enforced in
  the database by privileges plus a trigger.
- **Restricted history rules** (owner amendment; data policy, §16 control 12):
  - `restricted` fields never write value history unless the tenant's data policy explicitly allows it for that
    field;
  - `personal` fields (data category) write value history only under the field's retention class;
  - when history is suppressed, the history row records that a change happened (field, actor, time, change id)
    **without** old or new values;
  - this is enforced in the writer helper and verified by a test that scans `tenant_value_history` for values of
    restricted fields;
  - retention purges of history are audited.
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
  - state machines (Recommendation, Action, Goal, Opportunity status);
  - de-duplication keys;
  - guardrail enforcement;
  - classification and secret-like detection.
- **Integration (Testcontainers, app role, forced RLS):**
  - every new table is in the schema guard;
  - adversarial cross-tenant tests per table, **including polymorphic links attempted with raw SQL as the app role**,
    bypassing the writer (§18);
  - single-writer static scan extended, plus a behavioural test per new writer;
  - authorization: every writer refuses a missing or insufficient capability;
  - privilege manifest: the app role's privileges per table equal the manifest (append-only tables: no
    UPDATE/DELETE);
  - classification completeness: every column of every tenant table is classified;
  - audit completeness: every privileged operation writes exactly one audit event;
  - migrations up / rerun / down-refusal / exact restore / re-apply;
  - merge participants (hierarchy re-pointing, affiliation, contexts, extension values);
  - mapping validation for new targets;
  - provenance completeness: every required change-record field is present, test-enforced.
- **Regression (unchanged, every sub-milestone):**
  - the full M7–M9B suites (product model, eligibility, whitespace, coverage tiers, reviewed domain,
    seen-but-rejected, authority, proofs, retirement/reactivation, G4);
  - the Sugar regression;
  - the Chargebee fake suite;
  - identical canonical output on the fakes before and after.
- **Mutation proofs:** break the mechanism, run the guarding test, show it fails for the right reason, restore, rerun
  green. Mechanisms per sub-milestone are listed in §15. Security mechanisms always included:
  - entity-index FK and triggers (polymorphic cross-tenant);
  - append-only privileges and triggers;
  - authorization checks;
  - audit emission;
  - classification guard;
  - restricted-history suppression;
  - raw-retention-off.
- **Runtime and Docker:** new runtime checks per sub-milestone (CLI for adoption, module enablement, registry
  publish, integrity verification, read models); Docker image checks.
- **Fresh clone:** before each sub-milestone is reported complete.
- **Live:** where a live source exists (Chargebee TEST site for commercial references and contracts). Live Sugar
  stays pending.

## 12. Rollback / forward-fix strategy

- **Production:** forward-fix (existing policy). Each sub-milestone is an independent PR. A defect is fixed by a
  follow-up migration or by disabling the module for the tenant (§17), never by dropping tables with data.
- **Dev/staging:** down-scripts per migration, refusing while dependent data exists, with exact schema restore
  (tested). Down-scripts also restore the previous privilege manifest.
- **Data:** no destructive data migration in M10. Adoption never rewrites data, so tenant-level rollback means
  disabling modules or returning the adoption record to the previous `0.x` MINOR within the compatibility window
  (both audited).
- **Security controls are never rolled back to get green.** A failing integrity check or privilege guard is fixed
  forward.
- **Feature isolation:** module settings per tenant. New ingestion targets only take effect through a newly published
  mapping version, so not publishing one is itself a kill switch.

## 13. Performance and indexing

- Every index leads with `tenant_id`.
- Partial indexes for "current / active" rows, for example open opportunities and active signals by account and
  time.
- **Hierarchy:** index `(tenant_id, parent_company_id)`. Roll-ups use recursive CTEs bounded by the depth guardrail.
  The cycle check on write is bounded by the same guardrail.
- **Entity index (§18):**
  - one narrow row per entity: `(tenant_id, kind, entity_id | entity_key)`, with a primary key plus a unique key per
    form;
  - written by trigger on entity insert, which costs one extra index insert per entity;
  - entity deletes are rare: canonical entities are state-changed, not deleted;
  - polymorphic FK checks are single index probes.
- **High-volume tables:** `tenant_signals`, `tenant_metric_observations`, `tenant_activities`, `tenant_value_history`,
  `tenant_extension_values`, `tenant_audit_events`.
  - Primary keys and indexes are designed to allow later range partitioning by time.
  - Partitioning itself is `DEFERRED` until volume evidence exists.
  - Retention guardrails are configurable (data policy).
- **Extension:** one composite index per typed value column (`tenant_id, field_id, value_x`) plus an items index.
  Batch loading by `target_id = ANY($1)` (no N+1 in read models).
- **Immutability triggers:** row-level and cheap. Evidence-link writes are batched per derivation.
- **Value history:** written only for declared fields, which bounds write amplification.
- **Integrity verification:** runs per tenant, in batches, off-peak, and is read-only.

## 14. Multi-tenant isolation constraints

- Every new table: `tenant_id`, forced RLS policy on `app_current_tenant()`, tenant-scoped unique keys, composite
  `(tenant_id, x)` foreign keys. The existing schema-guard test enforces it for every new table automatically.
- Global tables: only `canonical_model_versions` and `canonical_modules` (reference data, no tenant content), like
  `connector_kinds`. The app role can read them, never write them (existing guard pattern).
- **Polymorphic references** (evidence links, extension targets and reference values, custom relationships, activity
  links, recommendation targets, generic source references) are **database-enforced** through composite FKs to the
  tenant-scoped entity index. A cross-tenant reference is impossible even with raw SQL as the app role (§18).
- Registries, mappings, module settings and extension definitions are per tenant. Platform generic definitions are
  copied into a tenant registry on adoption; there is no shared mutable state.
- The non-privileged app role is unchanged: no new role privileges and no `BYPASSRLS`. Append-only tables lose
  UPDATE/DELETE.
- The schema guard's "exactly one owner function" assertion becomes an **explicit allow-list** of owner
  functions. Each new `SECURITY DEFINER` trigger function is added deliberately, with a fixed `search_path`; it is
  not relaxed to "any".
- Jobs (BullMQ) keep carrying tenant context. New processors use `TenantDatabase.transaction`. The integrity job runs
  per tenant and never batches across tenants.

## 15. Proposed sub-milestones

Each sub-milestone is its own plan approval, PR, verification (`pnpm verify`, runtime, Docker, fresh clone),
independent review and closure. Each has **two acceptance sections**, `Canonical / business correctness` and
`Security & Data Governance`; both must pass.

**Unchanged in every one:**

- tenant isolation;
- Product Model versioning and relationships;
- subscription line identity;
- derived ownership, eligibility, whitespace and coverage tiers;
- reviewed-domain semantics;
- seen-but-rejected protection;
- source authority;
- completeness proof and `stable_snapshot`;
- historical retirement/reactivation;
- M9B source-reference semantics;
- raw rejected-value persistence disabled (tech debt #15 unresolved).

### 15.0 Revised sub-milestone table

| #     | Sub-milestone                                                                                                                                                                               | Canonical version after     | Depends on |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------- |
| M10A1 | Security & governance foundation: actor, write authorization, audit events, classification, secret-like refusal, privilege manifest, key-identified cipher                                  | `0.1` (no canonical change) | —          |
| M10A2 | Canonical versioning + adoption, module enablement, governed registries (incl. data policy), entity index, value history, change-record widening, mapping lifecycle, integrity verification | `0.1` baseline recorded     | A1         |
| M10B  | Generic SourceReference (incl. product key) + EvidenceLink                                                                                                                                  | `0.2`                       | A2         |
| M10C  | Account hierarchy + Person–Account affiliation                                                                                                                                              | `0.3`                       | B          |
| M10D  | Extension framework                                                                                                                                                                         | `0.4`                       | B          |
| M10E  | AccountContext                                                                                                                                                                              | `0.5`                       | C, D       |
| M10F  | Commercial: Price/Offer, Contract, Entitlement, line commercial references                                                                                                                  | `0.6`                       | E          |
| M10G  | Vendor-neutral Signal + Signal Type Registry                                                                                                                                                | `0.7`                       | F          |
| M10H  | Opportunity + lines + contact roles                                                                                                                                                         | `0.8`                       | G          |
| M10I  | Recommendation, decision events, Action, ActionOutcome                                                                                                                                      | `0.9`                       | H          |
| M10J  | Value: Goal, MetricDefinition, MetricObservation                                                                                                                                            | `0.10`                      | I          |
| M10K  | Engagement: Activity, ActivityParticipant, ContentReference, SupportCase                                                                                                                    | `0.11`                      | H          |
| M10L  | Data quality: rejected observations + field intelligence                                                                                                                                    | `0.12`                      | D          |
| M10M  | Migration framework and adoption hardening; canonical implementation record                                                                                                                 | `0.12` (no new structure)   | all        |

Every entity area from M10E onward is gated by its module key (§17): `account_context`, `commercial`, `signals`,
`opportunities`, `decision_chain`, `value`, `engagement`; M10D and M10L by `extension` and `data_quality`. Version
labels are indicative. Each sub-milestone that adds canonical structure publishes the next MINOR when it
closes. None publishes `1.0`.

### M10A1 — Security & governance foundation

- **Objective:** the security primitives every later writer and table uses. No canonical entity is added.
- **Schema:**
  - `tenant_audit_events (tenant_id, id, occurred_at, actor_kind, actor_id, capability, action, target_kind,
target_id, outcome (allowed/denied), request_id, details jsonb)`;
    - append-only: INSERT/SELECT only for the app role, plus a refuse-UPDATE/DELETE trigger;
    - `details` is validated against a closed per-action schema that carries identifiers, codes and counts, never
      values;
  - change-record `actor_kind` / `actor_id` columns;
  - REVOKE UPDATE/DELETE on existing append-only tables where the code already never updates them (verified by
    inspection first; e.g. profile purge audit).
- **Code:**
  - `Actor` (kinds: `source_sync`, `system`, `operator`, `human_user` (reserved), `ai` (reserved)) and a
    `WriteContext {tenant, actor, capability}` required by every single writer and configuration service;
  - a `WriteAuthorizer` port with a closed capability catalogue (`canonical.source_sync`, `canonical.human_entry`,
    `config.registry.publish`, `config.mapping.publish`, `config.module.change`, `config.canonical.adopt`,
    `migration.execute`, `data.purge`, …);
    - default policy: platform sync runs hold `canonical.source_sync`; the CLI operator holds the configuration
      capabilities;
    - user roles arrive with the operator workspace (M15) through the same port;
  - `AuditService`: one event per privileged operation, **denials included**;
  - data classification domain (§16): sensitivity levels, data categories, retention classes, history policies;
    a platform **classification manifest** covering every column of every existing tenant table;
  - secret-like value detector, reusing the M9A detectors plus credential patterns (API keys, bearer/JWT tokens,
    private-key blocks, connection strings with passwords). Writers of free-text canonical fields refuse matches
    with reason `secret_like_value` and log no value;
  - token cipher `v2:<key-id>:…` with a keyring read from the `SecretProvider` (current key + previous keys for
    decryption); `v1` still decrypts;
  - security event observability: metrics and structured log events (codes only) for authorization denials,
    audit-write failures, secret-like refusals and RLS/role guard failures.
- **Migration:** additive; privileges tightened only (REVOKE).
- **Canonical / business correctness:**
  - existing ingestion writes identical canonical results (regression on the fakes);
  - existing CLIs work with an operator actor;
  - change records carry actor attribution.
- **Security & Data Governance:**
  - every privileged operation (configuration, publish, purge, adoption, module change, migration) is authorized
    through the port **and** writes an audit event, including denials;
  - audit events are immutable for the app role (privilege and trigger);
  - the classification guard fails when any tenant-table column lacks a classification;
  - the privilege guard fails when the app role holds UPDATE/DELETE on an append-only table;
  - secrets are never stored as canonical values: secret-like values are refused in free-text fields;
  - key-identified encryption is ready for rotation, proved by a rotation test (encrypt with key 1, rotate, decrypt
    with the keyring, re-encrypt with key 2);
  - connector credential isolation unchanged: credential refs stay name-only with the tenant-prefix CHECK, and a test
    asserts no new table has a secret-bearing column;
  - no claim of compliance.
- **Mutation proofs:**
  - remove the authorizer call from a writer → the authorization test fails;
  - drop the audit trigger or grant UPDATE → the immutability test fails;
  - add an unclassified column → the classification guard fails;
  - disable the secret detector → the secret-refusal test fails;
  - make the cipher ignore the key id → the rotation test fails.
- **Gates:** `pnpm verify`, runtime, Docker, fresh clone, mutation proofs, independent review.

### M10A2 — Versioning, adoption, module enablement, registries, entity index, history, mapping lifecycle

- **Objective:** the platform foundation every later entity uses. No business entity yet.
- **Schema:**
  - `canonical_model_versions` (seed `0.1`; CHECK refuses MAJOR ≥ 1);
  - `tenant_canonical_adoptions` (append-only; every existing tenant adopts `0.1`);
  - `canonical_modules`, `tenant_module_settings`, `tenant_module_setting_events` (§17);
  - `tenant_registry_versions` / `tenant_registry_entries`, including kind `data_policy`;
  - `tenant_entity_index` + per-entity triggers on `companies`, `persons`, `tenant_products` + backfill (§18);
  - `tenant_integrity_runs`;
  - `tenant_value_history`;
  - `tenant_context_changes` widened;
  - mapping `lifecycle_state` + `canonical_version_min` + drafts table.
- **Code:**
  - domain:
    - canonical version, module catalogue and registry document schemas (cross-version rules);
    - data-policy document (retention per class, history policy per class, `raw_retention: false` forced, since a
      schema literal cannot be set true until the privacy decision);
    - change-record origin/derivation types;
  - services:
    - adoption;
    - module enablement (§17);
    - registry publish (base version, hash, human confirmation);
    - value-history writer helper with restricted-history suppression;
    - mapping draft/validate/publish/supersede/retire;
    - integrity verification job (§18) with CLI;
  - existing writers fill the new change-record columns.
- **Migration:** deterministic backfill of mapping lifecycle states, adoption baseline rows and entity-index rows
  (counts verified equal to source tables). No other data change.
- **Canonical / business correctness:**
  - registry rules (property);
  - mapping lifecycle transitions (published mappings never mutated);
  - change-record completeness;
  - module disabled ⇒ zero behavioural change;
  - regression: identical canonical results on the fakes;
  - migration up/down/refusal.
- **Security & Data Governance:**
  - tenant registry isolation (adversarial: tenant B cannot read, reference or publish over tenant A's registry);
  - published registry, mapping and adoption versions immutable and audited;
  - actor attribution on every version, adoption and module change;
  - privileged change audit for adoption, module change, registry publish and mapping publish/retire;
  - restricted-history policy enforced (a restricted field produces a value-free history row);
  - `1.0` refused by the database;
  - entity index unwritable by the app role (no DML privilege; triggers are `SECURITY DEFINER` with fixed
    `search_path`, added to the owner-function allow-list);
  - integrity verification finds a planted orphan (with constraints disabled by the owner in a test database) and
    raises a security event.
- **Mutation proofs:**
  - registry key rules;
  - mapping immutability;
  - adoption audit;
  - module audit;
  - `1.0` CHECK;
  - entity-index trigger removed → the backfill/consistency test fails;
  - restricted-history suppression removed → the history scan test fails.
- **Gates:** standard.

### M10B — Generic SourceReference + EvidenceLink

- **Objective:** one reusable reference service (lifecycle, reactivation, accepted-full-run retirement) and immutable
  evidence links for all new entities.
- **Schema:**
  - `tenant_source_references` (`entity_kind`, `entity_id` | `entity_key` for products, composite FKs to the entity
    index; D3);
  - `tenant_evidence_links` (subject and evidence both anchored in the entity index; append-only);
  - read-only `source_reference_index` view.
- **Code:**
  - a shared `SourceReferenceService` reusing the M9B retirement rules;
  - EvidenceLink writer;
  - provenance query read model ("where did this value come from").
- **Migration:** additive. Existing company/person refs untouched.
- **Canonical / business correctness:**
  - lifecycle (active/retired/deleted/merged, reactivation without duplicates);
  - retirement only on accepted proven full runs;
  - seen-but-rejected protection for the generic store;
  - product references by key survive a new Product Model version;
  - M9B retirement tests unchanged and green.
- **Security & Data Governance:**
  - tenant isolation (RLS plus composite FKs);
  - immutable evidence (privilege plus trigger);
  - **no cross-tenant evidence links or source references, proved with raw SQL as the app role**;
  - provenance tamper protection: evidence and change records cannot be updated or deleted by the app role;
  - lifecycle changes audited (retire/reactivate/merge write change records; operator-initiated ones write audit
    events);
  - source coordinates contain identifiers only, never values.
- **Mutation proofs:**
  - drop the entity-index FK → the cross-tenant evidence test fails;
  - grant UPDATE → the immutability test fails;
  - retirement gate;
  - reactivation.
- **Gates:** standard.

### M10C — Account hierarchy + Person–Account affiliation

- **Objective:** canonical `parent_account_id` (`companies.parent_company_id`), which **does not exist today**, and
  `tenant_person_affiliations`.
- **Schema:**
  - nullable parent column, composite same-tenant FK, `CHECK (parent <> id)`;
  - cycle prevention: a `BEFORE INSERT/UPDATE` trigger walking ancestors (bounded), plus the writer under a
    per-tenant advisory lock for the hierarchy;
  - affiliation table;
  - authority column `account_hierarchy_connection_id`.
- **Code:**
  - the Account single writer handles parent changes (value history; source authority `account_hierarchy`);
  - mapping target `account.parent` (relationship to account, human-confirmed);
  - person affiliation target;
  - depth guardrail from configuration;
  - merge participant re-points children to the survivor;
  - roll-up read model (derived).
- **Migration:** additive. No hierarchy is invented; it arrives only from mapped sources or operator entry.
- **Canonical / business correctness:**
  - optional parent;
  - no cycles (property test plus trigger);
  - guardrail refusal recorded as a data-quality issue;
  - value history on parent change;
  - source disappearance never deletes or unparents the canonical Account (the parent is kept until an
    authoritative source changes it);
  - merge re-pointing;
  - not modelled via AccountContext (no context code involved).
- **Security & Data Governance:**
  - same-tenant parent enforced by the composite FK: **a cross-tenant hierarchy is impossible**, proved with raw SQL
    as the app role;
  - authorization on hierarchy changes: source writes need `canonical.source_sync` plus the hierarchy authority;
    operator edits need `canonical.human_entry` and write an audit event;
  - affiliation changes produce change records and value history;
  - affiliations are classified (`personal` category).
- **Mutation proofs:**
  - cycle trigger;
  - same-tenant FK;
  - guardrail;
  - authorization check on operator hierarchy edits.
- **Gates:** standard.

### M10D — Extension framework foundation

- **Objective:** governed tenant extension: custom fields (scalar, enum, money, reference, multi-select, array,
  JSON), custom objects/records, custom relationships, source attribute capture.
- **Schema:** extension values / items / custom records / custom relationships (targets and reference values
  anchored in the entity index); definitions in the registry (kind `extension`) plus projection.
- **Code:**
  - registry validation (types, constraints, guardrails, classification, `allowed_uses`, `not_evidence_of`);
  - extension value writer (typed, provenance, optional value history);
  - custom record writer;
  - mapping entry kinds `attribute`, `custom_object`, `custom_relationship` and `capture` (the validator un-reserves
    `attribute`);
  - merge participant for values;
  - read models with batch loading.
- **Canonical / business correctness:**
  - every value type round-trips, with DB CHECK enforcement;
  - a tenant with 500+ fields needs no DDL;
  - guardrails;
  - `allowed_uses` enforced (cannot feed eligibility/ownership);
  - registry X1–X5.
- **Security & Data Governance:**
  - **field sensitivity classification required** on every field definition: publish refuses an unclassified field;
    a field may only be stricter than its object;
  - custom-object tenant isolation (RLS plus entity-index FKs; adversarial raw SQL);
  - no per-tenant DDL (the app role has no DDL privilege; a test asserts no DDL on publish);
  - restricted fields are not stored while raw retention is off, and their history follows the restricted-history
    rule;
  - typed-value validation in the writer and the database;
  - JSON depth/size and array length limits enforced;
  - **no secrets stored as extension data:**
    - field definitions whose name or type indicates a credential are refused;
    - secret-like values are refused at write time;
  - captured source attributes follow E4 §5: `sensitive_by_name` / `sensitive_by_value` are not stored.
- **Mutation proofs:**
  - type CHECK;
  - guardrail;
  - allowed-use enforcement;
  - polymorphic tenant FK;
  - classification-required publish;
  - secret-like refusal.
- **Gates:** standard.

### M10E — AccountContext

- **Objective:** the optional business-context module, separate from hierarchy.
- **Schema:** contexts + persons + products; context type registry entries; `tenant_subscriptions.context_id`
  (0..1).
- **Code:**
  - AccountContext writer (natural key, dimensions validated against the context type);
  - mapping entity `account_context`;
  - source references via the generic store;
  - module enablement check (`account_context`).
- **Canonical / business correctness:**
  - optional (module disabled ⇒ zero behavioural change, regression);
  - two contexts for the same account and product in different regions;
  - 0..1 context per line;
  - retirement never cascades to account/lines.
- **Security & Data Governance:**
  - context membership tenant enforcement: persons, products and lines in a context belong to the same tenant
    (composite FKs; adversarial);
  - future context-level permission compatibility: every context row carries a stable id usable as a future
    authorization scope, and read models take an optional scope filter (no permission model yet);
  - writers refuse when the module is disabled, and the refusal is audited;
  - context dimension values are classified.
- **Mutation proofs:** cross-tenant membership; module-disabled refusal.
- **Gates:** standard.

### M10F — Commercial: Price/Offer, Contract, Entitlement, line commercial references

- **Objective:** keep Product ≠ Price/Offer ≠ Subscription line ≠ Contract ≠ Entitlement.
- **Schema:**
  - price offers;
  - contracts (+ `renews` / `amends` / `parent` links);
  - entitlements (informational);
  - line columns `agreement_ref_*`, `contract_id`, `price_offer_id`, `supersedes_line_id`.
- **Code:**
  - writers;
  - mapping target `subscription.agreement` (human-confirmed; confirmation refuses deal/opportunity groupings);
  - resolution of `agreement_ref` → Contract source reference → `contract_id`, with value history;
  - Chargebee mapping example: ItemPrice → Price/Offer, Subscription header → Contract (TEST configuration only).
- **Canonical / business correctness:**
  - renewal, amendment, replacement and co-terming scenarios (E3 §4.2);
  - `agreement_ref` never used as identity or reference row;
  - price offers never affect ownership;
  - entitlements never affect eligibility in M10.
- **Security & Data Governance:**
  - financial-data classification: amounts, prices, discounts and contract values carry data category `financial`
    with minimum sensitivity `confidential`;
  - restricted-access compatibility: commercial read models carry the classification so a later role model can hide
    them, and nothing commercial is written to logs, metrics or audit details;
  - provenance for price/contract/entitlement facts: every fact has a source reference or a human actor, a change
    record and value history for status/dates;
  - read-only live verification on the Chargebee TEST site uses only the two approved environment secrets; no
    writes.
- **Mutation proofs:** classification guard on a financial column; contract-link tenant FK.
- **Gates:** standard plus a live Chargebee TEST-site read where possible.

### M10G — Vendor-neutral Signal + Signal Type Registry

- **Objective:** replace the `DOMAIN-ONLY` vendor-bound M1 Signal.
- **Schema:** `tenant_signals` (immutable; supersession; unique de-duplication key); signal types in the registry
  (platform generic definitions copied on adoption).
- **Code:**
  - Signal domain schema (origin, derivation, polarity, severity, strength, effective period);
  - Signal writer;
  - mapping entity `signal` for source-provided signals;
  - derivation **interface** only (the definitions engine comes in M11);
  - evidence links;
  - remove the M1 `signals.ts` and its tests.
- **Canonical / business correctness:**
  - no vendor in types;
  - a new type is a registry version only (no migration, no canonical version);
  - immutability;
  - de-duplication;
  - a signal never writes canonical facts.
- **Security & Data Governance:**
  - origin classification is mandatory and closed: `source` / `deterministic` / `ai` / `human`, stored and
    queryable;
  - derivation key + version is required for `deterministic` and `ai` origins (CHECK);
  - evidence is required where applicable: at least one EvidenceLink for `deterministic` and `ai` signals, in the
    same transaction;
  - no sensitive source value copied unnecessarily into a Signal:
    - the payload carries codes, numbers and references;
    - free text is refused unless the signal type declares a classified summary field;
    - secret-like and restricted values are refused;
  - signals are immutable for the app role (privilege plus trigger).
- **Mutation proofs:**
  - immutability;
  - de-duplication;
  - vendor-neutral validator;
  - evidence-required check;
  - derivation-version CHECK.
- **Gates:** standard.

### M10H — Opportunity + Opportunity lines + contact roles

- **Objective:** scopes `account` / `account_product` / `context_product`; Person optional; lines vendor-neutral.
- **Schema:** opportunities, lines, contacts; a unique partial equivalence key for open platform-derived
  opportunities.
- **Code:**
  - writer;
  - mapping entity `opportunity` (`source_native`) with stage value maps;
  - operator/API creation (`human`, or `platform_derived` via an explicit call; no generation engine);
  - link `platform_derived` → `source_native`;
  - remove M1 `LeadCandidate` / `Lead`.
- **Canonical / business correctness:**
  - Account-only, Account+Product, Context+Product;
  - no Person required;
  - multiple lines;
  - one source record is never counted as both an opportunity line and a subscription line without disjoint filters;
  - status value history.
- **Security & Data Governance:**
  - access/audit model:
    - every create/update records the actor;
    - human creation, stage override and linking write audit events;
    - read models carry the classification for a later role model;
  - evidence/provenance: `platform_derived` opportunities require at least one EvidenceLink; `source_native` ones
    require a source reference;
  - tenant-scoped contacts and lines: composite FKs to same-tenant persons, products and price offers
    (adversarial);
  - amounts classified `financial`.
- **Mutation proofs:** contact cross-tenant FK; evidence-required check; audit emission on human stage override.
- **Gates:** standard.

### M10I — Recommendation, decision events, Action, ActionOutcome

- **Objective:** the DECISION / ACTION / ACTION OUTCOME records of the reasoning chain. No customer-system writes.
- **Schema:** recommendations, recommendation events (immutable), actions, action events (immutable), action outcomes
  (immutable); action type registry.
- **Code:**
  - writers;
  - state machines;
  - the "human decision wins" rule;
  - evidence links (at least one for rule/AI generators);
  - remove M1 `QualificationDecision` / `SalesOutcome`.
- **Canonical / business correctness:**
  - lifecycle transitions;
  - human-wins;
  - ActionOutcome ≠ Goal (no shared table or type).
- **Security & Data Governance:**
  - recommendation and executable action are distinct: a Recommendation can never execute anything; an Action is a
    separate record with its own type and state;
  - authorization requirements for future actions:
    - every action type declares the capability required to approve and to execute it;
    - M10 stores and validates these declarations;
    - an `execute` transition is refused in M10 for any action type that targets a customer system (no executor
      exists until the commercial-actions milestone, M16);
  - actor identity on every event (`human_user` / `operator` / `system` / `ai`); a human decision is attributable to
    a human actor;
  - immutable action/outcome audit trail: events and outcomes are append-only (privilege plus trigger), and every
    privileged transition writes an audit event.
- **Mutation proofs:**
  - execute-refusal;
  - event immutability;
  - human-wins;
  - capability declaration required.
- **Gates:** standard.

### M10J — Value: Goal, MetricDefinition, MetricObservation

- **Schema:** goals; metric observations; metric definitions in the registry.
- **Code:**
  - writers;
  - mapping entity `metric_observation` (source-provided health/usage);
  - AI-suggested goals need human confirmation before `active`.
- **Canonical / business correctness:**
  - goal scopes;
  - immutable observations with supersession;
  - no BusinessOutcome entity;
  - health as an observation or signal only.
- **Security & Data Governance:**
  - sensitivity classification on every metric definition and goal field;
  - metric-source provenance: every observation has a source reference or an actor plus derivation version;
  - restricted-value history rules: observations of restricted metrics are immutable rows under the retention class,
    and goal history follows the restricted-history rule;
  - AI-suggested goals carry origin `ai` and cannot become `active` without a human actor (audit event).
- **Mutation proofs:** the human-confirmation gate; observation immutability; classification-required metric
  definition.
- **Gates:** standard.

### M10K — Engagement: Activity, ActivityParticipant, ContentReference, SupportCase

- **Schema:** activities, participants, links, content references (content store **disabled by default**), support
  cases.
- **Code:**
  - writers;
  - mapping entities `activity` / `support_case`;
  - participant resolution (Person / internal user / unresolved, masked);
  - derived account links with confidence, and review on ambiguity.
- **Canonical / business correctness:**
  - no vendor objects;
  - content never in core rows;
  - an Activity never creates an Opportunity directly.
- **Security & Data Governance:**
  - transcript/email/content sensitivity: content is category `communication_content`, minimum sensitivity
    `restricted`;
  - **ContentReference instead of blind content copying:**
    - core rows hold a classified summary at most;
    - full content is reachable only through a ContentReference (source coordinates, or a governed store that is
      **off by default**);
  - retention controls: the content-retention class comes from the data policy; purges are audited;
  - access control: content resolution requires a dedicated capability (`content.read`), and every resolution writes
    an audit event (restricted content audit);
  - unresolved participants are stored masked (no raw email address in core rows);
  - explicit raw-content retention policy: off unless the data policy enables it, which requires the privacy decision
    (tech debt #15) first.
- **Mutation proofs:**
  - content-store-off;
  - capability check on content resolution;
  - audit emission;
  - masked participant.
- **Gates:** standard plus privacy mutation (content-off).

### M10L — Data quality: rejected observations + field intelligence

- **Schema:** `tenant_rejected_observations`, `tenant_field_metadata`.
- **Code:**
  - dispositions (normalize / transform / hold / reject) in the mapping engine;
  - the rejected-observation writer: reference, reason, safe diagnostics, non-sensitive candidate with TTL, source
    coordinates only, raw retention **off**;
  - field metadata updated by runs and profiles (last seen / populated / changed, drift, mapping and usage status).
- **Canonical / business correctness:**
  - resolution lifecycle;
  - candidate TTL purge;
  - "unchanged ≠ stale".
- **Security & Data Governance:**
  - raw rejected values remain disabled by default:
    - the data-policy schema forces `raw_retention: false`;
    - no column exists for a raw value;
  - safe diagnostic metadata only: a closed diagnostic schema; the E7 §5 trace becomes executable tests (no raw value
    persisted in any table, log, metric or audit event);
  - privacy/retention enforcement: candidates omitted for personal/restricted/free-text fields and detector hits;
    TTL purge is audited;
  - field metadata carries classification and redacted field names (M9A rules);
  - tech debt #15 stays unresolved and is recorded as such.
- **Mutation proofs:**
  - candidate-for-restricted-field;
  - TTL purge;
  - raw-value scan;
  - diagnostic schema.
- **Gates:** standard plus privacy mutation proofs.

### M10M — Migration framework and adoption hardening

- **Objective:**
  - canonical migration preview / impact / approval / execution / verification / audit as tooling;
  - adoption CLI;
  - end-to-end adoption of the latest `0.x` by existing tenants;
  - full regression, integrity verification and performance check;
  - the canonical implementation record.
- **Canonical / business correctness:**
  - preview never writes customer data;
  - impact report counts;
  - verification invariants (counts, hashes, FKs, rule replay samples);
  - resumable execution.
- **Security & Data Governance:**
  - tenant-scoped migrations: every execution step runs in `TenantDatabase.transaction` for one tenant; no
    cross-tenant batch (asserted);
  - privileged approval/audit: `migration.execute` capability, named approver, base version; every step and approval
    is audited;
  - no cross-tenant migration: a migration run is bound to one tenant, enforced by FK plus a check;
  - integrity verification before and after (entity index, FKs, classification, privilege manifest);
  - forward-fix production strategy confirmed;
  - data export/deletion hooks: the **data-subject map** (§16 control 17) is complete for every table, test-enforced;
    there is no export/erasure feature yet;
  - security posture summary recorded in the record (controls, evidence, known gaps) **without any compliance
    claim**.
- **Gates:**
  - full verification and fresh clone;
  - independent review;
  - a canonical implementation record;
  - **no v1.0 freeze** (that still requires M9C/M9D).

## 16. Security & data governance architecture (cross-cutting)

Each control has a mechanism, a sub-milestone and a test. "Today" is the state on `main`.

| #   | Control                                                                                       | Mechanism                                                                                                                                                                                                             | Built in                   | Today                                            |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------ |
| 1   | Strict tenant isolation                                                                       | `TenantDatabase.transaction`, `app_current_tenant()`, tenant-scoped everything                                                                                                                                        | all                        | `IMPLEMENTED TODAY`                              |
| 2   | Forced RLS                                                                                    | every new table; schema guard                                                                                                                                                                                         | all                        | `IMPLEMENTED TODAY` (guard)                      |
| 3   | Tenant-scoped uniqueness and foreign references                                               | composite keys; schema guard; polymorphic refs via entity index (§18)                                                                                                                                                 | all; index in A2           | guard today; polymorphic in A2                   |
| 4   | Authorization boundaries for writes                                                           | `WriteContext` + `WriteAuthorizer` capability catalogue; static test that every writer authorizes                                                                                                                     | A1, then all               | not present (CLI operator only)                  |
| 5   | Least-privilege database/runtime roles                                                        | `lip_app` unchanged; privilege manifest (append-only tables INSERT/SELECT only); role guard; `SECURITY DEFINER` allow-list                                                                                            | A1, A2                     | roles and guard `IMPLEMENTED TODAY`              |
| 6   | Connector credential isolation                                                                | name-only credential refs with tenant-prefix CHECK; `SecretProvider`; credentials never in mappings, registries or canonical rows                                                                                     | kept; asserted A1          | `IMPLEMENTED TODAY`                              |
| 7   | Secrets never stored as canonical/extension values                                            | secret-like detector in writers; credential-like extension field definitions refused; capture drops `sensitive_by_name`                                                                                               | A1, D                      | not present                                      |
| 8   | Field/data classification                                                                     | classification manifest for every tenant-table column (guard); extension fields classified at definition; metric/signal/context types classified                                                                      | A1, D, G, J                | not present                                      |
| 9   | Sensitivity levels                                                                            | `public` / `internal` / `confidential` / `restricted`, plus data category `none` / `personal` / `financial` / `communication_content` (§16.1)                                                                         | A1                         | not present                                      |
| 10  | PII/restricted-field handling                                                                 | category `personal` → minimum `confidential`; restricted values not stored while raw retention is off; masking in core rows; detectors                                                                                | A1, D, K, L                | privacy rule for logs/profiles today             |
| 11  | Retention-policy metadata                                                                     | retention class per classified field; tenant data policy (registry kind `data_policy`); TTL guardrails; audited purges                                                                                                | A1, A2                     | M9A profile retention only                       |
| 12  | Restricted history rules                                                                      | value-free history rows for restricted fields; policy-gated personal history                                                                                                                                          | A2                         | not present                                      |
| 13  | Audit events for privileged/configuration changes                                             | `tenant_audit_events`, append-only, denials included                                                                                                                                                                  | A1, then all               | M9A purge audit only                             |
| 14  | Immutable provenance/evidence                                                                 | privileges + triggers on evidence, events, observations, signals, history, registry versions                                                                                                                          | A2, B, G, I, J             | product model / mapping versions immutable today |
| 15  | Source/mapping/migration auditability                                                         | change record (origin, actor, versions, transforms); mapping lifecycle audit; migration runs + approvals                                                                                                              | A2, M                      | partial (mapping versions immutable)             |
| 16  | Secure treatment of communication content; explicit raw-content retention policy              | ContentReference; content store off by default; `content.read` capability + audit; data policy `raw_retention: false` until the privacy decision                                                                      | K, L                       | not present                                      |
| 17  | Future data export/deletion hooks                                                             | **data-subject map**: per table, the columns linking a row to a Person/Account and the export/erasure action (`export`, `erase`, `pseudonymise`, `retain_legal`); test: every table with `personal` columns is mapped | A1 (map), M (completeness) | not present                                      |
| 18  | Future key/secret rotation                                                                    | key-identified cipher `v2:<key-id>` + keyring from `SecretProvider`; DB role password rotation already documented; credential refs indirect (rotate the secret, not the row)                                          | A1                         | single key, no key id                            |
| 19  | Security/event observability                                                                  | metrics + structured events (codes only): authorization denials, audit failures, secret-like refusals, integrity failures, guard failures                                                                             | A1, A2                     | logs/metrics exist, no security events           |
| 20  | No cross-tenant leakage through polymorphic relations, registries, mappings or extension data | entity-index composite FKs; tenant-scoped registries/mappings; adversarial raw-SQL tests; integrity verification                                                                                                      | A2, B, D, all              | not applicable yet                               |

### 16.1 Classification vocabulary

- **Sensitivity level** (owner amendment): `public`, `internal`, `confidential`, `restricted`.
- **Data category** (orthogonal): `none`, `personal`, `financial`, `communication_content`. `credential` is never
  stored, so it is a refusal reason, not a category.
- **Minimums:**
  - `personal` → `confidential`;
  - `financial` → `confidential`;
  - `communication_content` → `restricted`.
- **Candidate clarification:**
  - the candidate's E4 sensitivity list (`internal | confidential | personal | restricted`) becomes level + category;
  - the candidate's `personal` is category `personal` at level `confidential` (or stricter);
  - this is applied to E4 as a documented candidate revision in M10A1 (no semantic loss; stricter, not weaker).
- **Per classified column:** `retention_class`, `history_policy` (`full` / `value_free` / `none`) and
  `subject_link` (for control 17).
- **Unknown classifications are `tbc`.** A `tbc` column is treated as `restricted` until classified, never as public.

### 16.2 What M10 does not claim

- M10 does not claim SOC 2, HIPAA, ISO 27001 or GDPR compliance.
- It provides the technical foundations those programmes need:
  - isolation;
  - least privilege;
  - audit;
  - classification;
  - retention metadata;
  - provenance;
  - rotation readiness;
  - subject mapping.
- Policies, processes, evidence collection, user access management (M15) and the privacy decision (tech debt #15)
  remain outside M10.

## 17. Module enablement (separate from canonical adoption; D5)

- **Purpose:** turn optional canonical modules on or off per tenant. Examples: AccountContext enabled; Goals enabled;
  Engagement disabled.
- **Separate lifecycles:**
  - adoption = which canonical **model version** the tenant runs (rare, migration-driven);
  - module enablement = which optional **capabilities** the tenant uses (operational, reversible).
  - Changing a module **never** creates, changes or implies a canonical version, and adoption never changes a
    module setting.

**Global catalogue: `canonical_modules`** (reference data; app role read-only; equals the code catalogue, test):

- columns `module_key`, `title`, `minimum_canonical_version`, `depends_on text[]`, `config_schema_version`;
- initial keys: `account_context`, `commercial`, `signals`, `opportunities`, `decision_chain`, `value`, `engagement`,
  `extension`, `data_quality`;
- core (Account, hierarchy, Person, affiliation, Product, Subscription line, references, provenance) is **not** a
  module and cannot be disabled.

**Current state: `tenant_module_settings`** (tenant-owned, forced RLS):

- `(tenant_id, module_key → canonical_modules, enabled boolean, config jsonb, version int, updated_at, updated_by_kind,
updated_by_id)`;
- primary key `(tenant_id, module_key)`;
- `config` is validated against the module's config schema (for example engagement content store `off`);
- secret-like values are refused in `config`.

**History: `tenant_module_setting_events`** (append-only; INSERT/SELECT only plus trigger):

- `(tenant_id, id, module_key, from_enabled, to_enabled, from_config_hash, to_config_hash, base_version, actor_kind,
actor_id, reason, occurred_at, audit_event_id)`.

**Rules:**

1. Changing a setting requires the capability `config.module.change` and the current `version` as base version
   (optimistic concurrency). A stale base is refused.
2. Enabling requires the tenant's adopted canonical version ≥ the module's `minimum_canonical_version`, and every
   module in `depends_on` enabled.
3. Disabling is refused while an enabled module depends on it.
4. Disabling **never deletes data**:
   - writers and mapping publication refuse new writes for the module, with the reason `module_disabled`;
   - existing data stays readable to operators and keeps its retention;
   - re-enabling resumes without migration.
5. Mapping versions targeting a disabled module's entities fail validation, and a published one is not executed for
   those entries. The run records the skipped entries as a gap. Nothing is silently dropped.
6. Every change writes one setting event **and** one audit event in the same transaction.
7. New tenants: all optional modules disabled. Existing tenants: all disabled at M10A2 (no behaviour change).

**Tests:**

- enable/disable round trip;
- base-version conflict;
- dependency refusal;
- minimum-version refusal;
- disabled ⇒ writer refusal + audit;
- disabled ⇒ zero behavioural change on the regression suite;
- adoption record unchanged by module changes (and vice versa);
- cross-tenant isolation (adversarial).

**Mutation proofs:** remove the module check from a writer → the disabled-refusal test fails; skip the event write →
the audit test fails.

## 18. Polymorphic reference integrity (final approach; D2)

Defense in depth, three layers. The **database layer alone** makes cross-tenant references impossible.

### Layer 1 — writer/application validation

The single writer validates every polymorphic target, inside the tenant transaction, before writing. It checks:

- the kind is allowed for the relation;
- the target exists, belongs to the tenant and is in an allowed state (for example not `merged` for new links);
- the target's module is enabled.

This gives precise error messages. It is **not** the security boundary.

### Layer 2 — database enforcement: the tenant entity index

- **`tenant_entity_index`:**
  - columns `(tenant_id, kind, entity_id uuid NULL, entity_key text NULL, created_at)`;
  - `kind` is a closed CHECK set equal to the code catalogue of canonical entity kinds plus `custom_record`;
  - CHECK: `entity_key IS NOT NULL` iff `kind = 'product'`; otherwise `entity_id IS NOT NULL`;
  - unique `(tenant_id, kind, entity_id)` and unique `(tenant_id, kind, entity_key)`;
  - forced RLS.
- **Maintained only by triggers:**
  - every entity table has `AFTER INSERT` (add) and `BEFORE DELETE` (remove) triggers;
  - the triggers call owner-owned `SECURITY DEFINER` functions with a fixed `search_path`;
  - the functions copy `NEW.tenant_id`, so the index row's tenant always equals the entity's tenant;
  - `tenant_products` rows map to `(kind = 'product', entity_key = key)`, preserving product identity by key (D3).
- **The app role has no INSERT/UPDATE/DELETE privilege on the index.** It cannot forge, move or remove entries.
  Disabling triggers needs table ownership or superuser, which the app role does not have.
- **Every polymorphic reference column set** `(tenant_id, x_kind, x_id, x_key)` carries:
  - two composite foreign keys, `(tenant_id, x_kind, x_id)` → index `(tenant_id, kind, entity_id)` and
    `(tenant_id, x_kind, x_key)` → index `(tenant_id, kind, entity_key)`, both `ON DELETE RESTRICT`;
  - an exactly-one-of CHECK on `x_id` / `x_key`.
- **Why this is safe:**
  - FK checks include `tenant_id`, so a reference from a tenant-A row to a tenant-B entity has no matching index
    row. The database refuses it regardless of application code, RLS settings or raw SQL.
  - FK checks are not affected by RLS visibility, so they cannot be hidden by a policy.
  - `ON DELETE RESTRICT` prevents dangling references when an entity row is deleted. Canonical entities are normally
    state-changed, not deleted.
- **Why not plain triggers that look up targets:** a lookup trigger can race with a concurrent delete unless it locks
  correctly, and the delete side needs its own triggers too. A declarative FK has neither problem. Triggers are used
  only to maintain the index, which the app role cannot write directly.
- **Why not one FK column per target kind (exclusive arc):**
  - it is safe, but it widens every polymorphic table as kinds are added;
  - the index gives the same declarative guarantee with one column pair;
  - exclusive arcs remain acceptable for small fixed sets and may be used where a relation allows only one or two
    kinds (for example AccountContext → account).
- **Adding a canonical entity kind** happens only in a canonical MINOR migration. It extends the CHECK set and
  attaches the triggers. A schema-guard test asserts that every table listed in the kind catalogue has both triggers,
  and that no polymorphic column set exists without its FKs.
- **Custom records** use one kind (`custom_record`), so tenants add custom objects without DDL.

### Layer 3 — periodic integrity verification

A per-tenant job (CLI and scheduled; read-only; batched) verifies:

- index ↔ entity tables in both directions (no orphan, no missing row);
- tenant equality between index rows and entity rows;
- no polymorphic row without a matching index row (with constraints in place this should be impossible, so it
  detects tampering by privileged roles or a broken migration);
- the privilege manifest and owner-function allow-list.

Results go to `tenant_integrity_runs`. Any finding raises a security event and a non-zero exit. A finding is never
auto-repaired; repair is a planned, audited, forward-fix operation.

### Tests that prove the protection is load-bearing

- **Adversarial:** as the app role, with raw SQL that bypasses the writer, attempt to:
  - insert a polymorphic row in tenant A that references a tenant-B entity (by id, and by product key) → refused by
    the FK;
  - insert, update or delete an index row directly → permission denied;
  - delete a referenced entity → refused (`RESTRICT`).
- **Mutation:**
  - in a test database, drop the composite FK → the cross-tenant insert test **fails** (the insert succeeds); restore
    → green;
  - grant INSERT on the index to the app role → the forge test fails;
  - drop an entity-index trigger → the index-consistency test and the integrity job both fail;
  - disable the writer validation alone → the adversarial test still passes, because the database refuses. This
    proves the database layer, not the writer, is the boundary;
  - plant an orphan with the owner role → integrity verification reports it.

## 19. Roadmap renumbering impact (D4)

New numbering, from M10 onward:

| New     | Milestone                                                                                                                            | Was                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **M10** | **Canonical Architecture + Security/Data Governance Implementation**                                                                 | new; absorbs the data halves of old M10 and old M11 |
| M11     | Signal derivation and ingestion engine (definitions, evaluator, de-duplication over time)                                            | old M10 (engine half)                               |
| M12     | Opportunity candidate generation / whitespace / suppression (shadow)                                                                 | old M11 (engine half)                               |
| M13     | Rules-based qualification and evidence                                                                                               | old M12                                             |
| M14     | Prioritisation + routing (shadow)                                                                                                    | old M13                                             |
| M15     | Minimal operator workspace: review / explanation / override (incl. user identity and roles, and the Data Intelligence Console views) | old M14                                             |
| M16     | Commercial actions under approval                                                                                                    | old M15                                             |
| M17     | Outcomes / attribution / measurement                                                                                                 | old M16                                             |
| M18     | Juniper pilot                                                                                                                        | old M17                                             |

- **Updated now (living documents):**
  - `docs/milestones/README.md`;
  - `docs/product/roadmap.md` (roadmap block, overview, milestone sections, and both mapping tables);
  - the product charter's roadmap references;
  - `docs/architecture/canonical-extension-and-source-mapping.md`;
  - `docs/operations/product-eligibility.md`;
  - the candidate (E2, E3, E4, E7, CANDIDATE diagrams) and ADR 0025.
- **Not rewritten (historical):**
  - closed milestone records M0–M9E;
  - accepted ADRs other than 0025;
  - discovery notes.
  - They keep the numbering of their date. The roadmap's renumbering table translates them.
- **Pre-existing stale references (not changed by this plan):**
  - some files still use the **original** M6–M21 numbering, which was already replaced on 2026-10-01:
    `docs/credentials.md`, `docs/architecture.md`, `apps/api/src/modules/README.md`, code comments in
    `apps/api/src/modules/tenancy/config/*.ts`, `apps/api/config/tenant-templates/juniper.json`;
  - this plan makes no code change, so they stay as they are and are translated by the roadmap's original-plan
    mapping table;
  - each is corrected when a sub-milestone next touches the file.
- **Not milestone numbers:** "live mutations M09/M10" are Chargebee live-mutation labels from M9B. They are unaffected.

## 20. Decisions requested before M10A1

1. **A1/A2 split:** security & governance primitives (A1) before versioning/modules/registries (A2). Recommended,
   because every later writer needs the actor, authorizer, audit and classification from the start.
2. **Entity index** (§18) as the database mechanism for all polymorphic references, with exclusive arcs allowed for
   one- or two-kind relations. Recommended.
3. **Classification vocabulary** (§16.1): four sensitivity levels plus an orthogonal data category, with the
   candidate's `personal` mapped to category `personal` at minimum `confidential`. Recommended.
4. **Module disable semantics** (§17): data retained and readable; new writes refused; mapping entries skipped as
   recorded gaps. Recommended.
5. **Retention defaults** (TTL values per retention class): `tbc`, supplied by the owner. Until supplied, the
   existing guardrail defaults apply (for example 30 days for rejected-observation candidates) and no class defaults
   to "retain forever" for personal or restricted data.

## 21. Open items (unchanged, separate)

- tech debt #15 (privacy decision), #62, #63, #64;
- live Chargebee mutations M09/M10 not run;
- V6, V9, V10, V11;
- Chargebee incremental sync disabled;
- live Sugar verification pending.
