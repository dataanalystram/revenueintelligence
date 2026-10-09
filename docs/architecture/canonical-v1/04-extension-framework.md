# Canonical Architecture v1 Candidate — E4: Extension framework (M9E-D)

Part of the [Canonical Architecture v1 Candidate](CANDIDATE.md). Status: **candidate for review**. Everything in this
document is `PROPOSED FOR V1 CANDIDATE` unless stated otherwise. **Nothing is implemented today:** the mapping entry
kind `attribute` is reserved and refused by the validator.

This framework **replaces** the narrow pre-M8 design (`docs/architecture/canonical-extension-and-source-mapping.md`
§2–§4: account-only scalar attributes, ≤ 200, no custom objects) per owner decision 2. It **keeps** the design's
governance:

- immutable versioned registry with a content hash;
- keys as identities;
- validation before publish;
- typed storage;
- single writers;
- allowed uses;
- `notEvidenceOf`;
- no expression language, scripting or inference engine.

## 1. Goals and non-goals

- **Goals:**
  - tenants keep any business data they need without canonical schema changes;
  - one tenant with 500+ custom fields does not affect any other tenant or the canonical core;
  - every value is typed, attributable and governed.
- **Non-goals:**
  - no physical column per source field;
  - no per-tenant DDL;
  - no query or expression language in configuration;
  - no automatic promotion to canonical;
  - no inference engine.

## 2. The Extension Registry (one versioned document per tenant)

The pattern is the M7 product model:

- immutable published versions, `base_version` (optimistic concurrency), SHA-256 content hash, publisher, effective
  time;
- validation before publish;
- a correction is a new version.

The registry contains three kinds of definition.

### 2.1 Custom field definition

| Property                      | Rule                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                         | identity, `^[a-z][a-z0-9_]{0,62}$`, unique per (tenant, target); never reused or removed (retire)                                                                                                                                                                          |
| `target`                      | the entity it extends: any core or module entity (`account`, `person`, `subscription`, `opportunity`, `signal`, `account_context`, `goal`, `activity`, `contract`, …) **or** a custom object definition                                                                    |
| `display_name`, `description` | required; the approved business meaning                                                                                                                                                                                                                                    |
| `value_type`                  | closed set: `string`, `text`, `number`, `integer`, `boolean`, `date`, `datetime`, `money` (amount + currency), `enum`, `multi_enum` (multi-select), `array` (of one scalar type), `json` (structured, with optional schema), `reference` (to a canonical or custom record) |
| `allowed_values`              | for `enum` / `multi_enum`: `{code, label, status: active\|retired}`; codes never removed                                                                                                                                                                                   |
| `constraints`                 | per type: max length; numeric min/max/integer; array max items; JSON max bytes and optional JSON Schema subset (types, required, enum, bounded depth); no regex execution beyond a bounded safe subset. Upper bounds come from the platform guardrails (§2.4)              |
| `sensitivity`                 | **Revised in M10A1 (candidate revision R1, below):** `public` \| `internal` \| `confidential` \| `restricted`, plus one or more `categories`; `restricted` values are never stored in clear without a policy decision                                                      |
| `categories`                  | **Added in M10A1 (R1):** one or more of `personal`, `financial`, `communication`, `operational`, `commercial`, `security`; category floors apply (below)                                                                                                                   |
| `allowed_uses`                | closed set: `display`, `segmentation`, `eligibility`, `signal_input`, `analytics`, `ai_context`; every consumer checks its own use                                                                                                                                         |
| `not_evidence_of`             | canonical facts this field must never be used to infer (e.g. `subscription_ownership`, `account_identity`)                                                                                                                                                                 |
| `status`                      | `active` \| `retired` \| `promoted` (resolved to a canonical field after promotion)                                                                                                                                                                                        |
| `origin`                      | `tenant_defined` \| `source_captured` (§5)                                                                                                                                                                                                                                 |
| `history`                     | `current_only` (default) \| `value_history`                                                                                                                                                                                                                                |

Cross-version rules (the analogue of K1–K4 / A1–A4):

- **X1** a key never disappears;
- **X2** `value_type` never changes for a key (a new type needs a new key plus a migration);
- **X3** enum codes never disappear;
- **X4** `target` never changes;
- **X5** narrowing a constraint is allowed only when no existing value violates it, which the publish validation
  checks.

### 2.2 Custom object definition

| Property                      | Rule                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `key`                         | identity (as fields), unique per tenant; must not shadow a canonical or module entity name                                   |
| `display_name`, `description` | required                                                                                                                     |
| `record_identity`             | how records are identified: platform UUID always; optional natural key over ≤ 3 of its own fields; source references allowed |
| `fields`                      | custom field definitions with `target = this object` (same type system)                                                      |
| `parent`                      | optional required link to a canonical entity (e.g. every record belongs to an Account) — enforced                            |
| `lifecycle`                   | closed: `active` / `inactive` / `retired` record states; optional tenant status field (`enum`) for business status           |
| `sensitivity`, `allowed_uses` | object-level defaults; fields may only be stricter                                                                           |
| `status`                      | `active` \| `retired` \| `promoted`                                                                                          |

Examples:

- `order` with lines (until promoted);
- `school_inspection`;
- `implementation_project`;
- `license_pool`;
- a warehouse table of renewal forecasts.

### 2.3 Custom relationship definition

| Property            | Rule                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `key`               | identity                                                                                                                   |
| `from`, `to`        | custom object ↔ canonical/module entity, or custom ↔ custom (no canonical ↔ canonical — those are canonical relationships) |
| `cardinality`       | `one_to_one` \| `many_to_one` \| `many_to_many`                                                                            |
| `role`              | optional code (e.g. `implementation_for`, `sponsor`)                                                                       |
| `required`          | whether `from` must have one                                                                                               |
| `on_target_retired` | always `keep` (no cascades); a reference to a merged canonical record follows merge lineage                                |

### 2.4 Guardrails (configurable platform limits, not canonical-model constraints)

| Limit                           | v1 value                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| custom fields per target entity | 1,000                                                                    |
| custom object definitions       | 100                                                                      |
| fields per custom object        | 300                                                                      |
| custom relationship definitions | 300                                                                      |
| enum values per field           | 1,000                                                                    |
| array items per value           | 500                                                                      |
| JSON value size                 | 64 KiB                                                                   |
| custom records per object       | 10 M (beyond that the data belongs in a warehouse source read on demand) |

These values are **default platform guardrails**, not canonical semantics:

- they live in platform configuration (per deployment, optionally per tenant tier), not in the canonical model or the
  registry schema;
- changing a guardrail is an operational decision with a capacity review; it is **never** a canonical version change
  and never requires a registry or mapping migration;
- the canonical model only requires that limits exist and are enforced, so one tenant cannot degrade another.

Guardrails are validated at registry publish and at write time. Exceeding one is a refused publish or a rejected
observation (E7), never silent truncation.

## 3. Value storage (logical design; physical design by the implementing milestone)

Options compared for the v1 scope (owner decision 2 widens the old "Option C"):

| Concern                | Typed value rows (scalar) + typed collection rows + JSONB for `json` only (**recommended**) | One JSONB document per entity           | Per-tenant DDL columns   |
| ---------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------ |
| Type safety            | DB-enforced per value type; `json` validated by schema subset                               | application only                        | DB-enforced              |
| 500+ fields per tenant | rows; no DDL                                                                                | one large document; write amplification | DDL per field (rejected) |
| Query / segmentation   | indexed typed columns per type                                                              | expression indexes per key              | good                     |
| Provenance per value   | per row (source reference, run, mapping version)                                            | per document                            | per column, awkward      |
| History                | per row (value history opt-in)                                                              | whole-document snapshots                | none                     |
| Isolation              | tenant-owned table, forced RLS                                                              | inherited                               | per-tenant schema drift  |
| Promotion              | mechanical copy                                                                             | extraction                              | rename                   |

Recommended logical stores:

- **Extension values** (scalar and `money` / `reference`). One row per (entity, record, field key):
  - one typed column for the definition's type, with a CHECK that exactly the column matching the type is set;
  - `value_state` (`present` / `empty`);
  - source reference, `observed_at`, `source_updated_at`, field hash;
  - `registry_version`, `last_change_id`.
  - **No row = unknown.**
- **Extension collection items** (`multi_enum`, `array`). One row per item, with an ordinal, belonging to a value
  row:
  - multi-select is a set of enum codes (order ignored);
  - array keeps order.
  - Items are indexed for "accounts having code X".
- **Extension JSON values** (`json`). A JSONB column on the value row, validated against the definition's schema
  subset, size-capped.
  - Paths inside JSON are **not** queryable by tenant configuration in v1 (no expression language). Promotion to
    typed fields is the route.
- **Custom records.** One row per record:
  - object key, record state;
  - optional parent canonical id;
  - natural key hash;
  - source references (E5).
  - Fields are stored as extension values targeting the custom record.
- **Custom relationship instances.** One row per edge: relationship key, from (kind, id), to (kind, id), state,
  provenance.

All stores:

- tenant-owned;
- forced RLS;
- tenant-scoped keys and composite foreign keys to the registry version and target;
- written **only** by the entity's single writer (canonical entities) or the custom-record writer (custom objects);
- every write produces a change record (E5);
- merge of a canonical record moves extension values through the merge-participant port (survivor keeps its value;
  differing values become an identity conflict, never silently overwritten).

## 4. Mapping into the extension layer

New mapping entry kinds:

- `attribute` (unreserved): source field → custom field;
- `custom_object`: source object → custom object definition;
- `custom_relationship`: source reference field → relationship.

The closed transform set (ADR 0020) applies. Collections and JSON use the representation rules of E7. Consequential
uses need confirmations:

- `eligibility`;
- `signal_input`;
- `ai_context` for `personal` fields.

Publishing a mapping that writes to a field validates the field's current registry version.

## 5. Source-specific attribute capture

For source attributes the tenant wants **kept but not yet interpreted**:

- A mapping entry `capture` creates (or reuses) a custom field with `origin = source_captured`.
  - Key: `src_<connection_kind>_<object>_<field>` (normalised, collision-checked).
  - `allowed_uses`: `[display, analytics]` only.
  - `sensitivity`: inherited from profiling (`sensitive_by_name` / `sensitive_by_value` → `restricted`, which is
    **not** stored without policy).
- Captured attributes are clearly source-specific: they never feed eligibility, signals or AI until a human annotates
  them, which publishes a registry version that changes `allowed_uses` and adds a description.
- This keeps unmapped information without silently creating business meaning, and without adding canonical columns.

## 6. Field intelligence metadata (supports the Data Intelligence Console)

The metadata is built in M10 (M10L); the console views come with the operator workspace (M15).

A **field metadata record** per (connection, source object, source field) and per (custom field). Logical fields:

| Metadata                         | Meaning (kept separate on purpose)                                                                      | Source of truth                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `first_seen_at`, `last_seen_at`  | the field existed in the source schema / a read                                                         | schema snapshots, sync reads                                     |
| `last_populated_at`              | the latest read in which at least one record had a non-empty value                                      | sync/profiling accumulators                                      |
| `last_value_changed_at`          | the latest time any record's value for the field changed (field hash per record)                        | single writers (value hash change)                               |
| `population_ratio`               | share of records with a non-empty value at the last profile                                             | M9A profile (`IMPLEMENTED TODAY` per run)                        |
| `declared_type`, `observed_type` | what the schema says vs what values look like                                                           | snapshot / M9A classifiers (`IMPLEMENTED TODAY` per run)         |
| `drift_status`                   | `none` / `type_drift` / `option_drift` (enum options changed) / `representation_drift` / `removed`      | M9A drift (`IMPLEMENTED TODAY` between profiles) + snapshot diff |
| `mapping_status`                 | `mapped_core` / `mapped_extension` / `captured` / `ignored` / `unmapped`                                | published mapping version                                        |
| `usage_status`                   | which consumers read it: product-model condition, signal definition, report, AI context (with versions) | registry `allowed_uses` + consumer declarations                  |
| `sensitivity`                    | detected / declared sensitivity                                                                         | M9A detectors + registry                                         |
| `freshness_status`               | derived: `fresh` / `stable` / `stale` / `unknown` per declared expectation                              | derived from the above                                           |

The separation is deliberate:

- "not changed recently" (`last_value_changed_at`) ≠ "stale" (no read or population within the expected cadence) ≠
  "bad data" (rejections / parse failures).
- A field can be **stable** (populated, read every run, values unchanged) and healthy.
- `freshness_status` needs a declared expected cadence per field. Without one it is `unknown`, never `stale`.

## 7. Promotion from extension to canonical

The promotion test is E2 §1. The mechanical path:

1. ADR, plus canonical version bump (E6).
2. Migration that creates the canonical field or entity and copies values from the custom field or object, one change
   record each (`change_type = promoted`, cause `migration`). Row counts are verified before and after; no value may
   be lost.
3. A new registry version marks the field or object `promoted`, with `promotedTo`.
4. Mappings keep working: `attribute:<key>` resolves to the canonical target until the next mapping version rewrites
   it, and validation warns.
5. Rules referencing the key (eligibility conditions, signal definitions) resolve to the canonical field under a new
   evaluator version. Snapshots replay from frozen inputs.
6. No double storage: extension rows stop receiving writes and are retained per policy.

## 8. Governance and safety

- Registry publish is human-confirmed: who and why, with a base version.
- AI may **suggest** definitions and mappings. It never publishes them.
- Every consumer enforces `allowed_uses` and `not_evidence_of`. A custom field can never become evidence of ownership
  or identity.
- Sensitive and restricted values follow E7 (retention policy-gated).
- Isolation: per-tenant registries; no cross-tenant definitions. Platform-provided generic definitions (for example
  metric definitions) are copied into a tenant registry on adoption, never shared mutable state.

## Candidate revision R1 (M10A1, 2026-10-09): sensitivity plus category

Owner decision F3 (M10 plan §16.1), applied in M10A1 (plan §9). Stricter, never weaker; no semantic loss:

- `sensitivity` is exactly one of `public`, `internal`, `confidential`, `restricted`.
- `categories` is one or more of `personal`, `financial`, `communication`, `operational`, `commercial`, `security`.
- The candidate's `personal` sensitivity becomes category `personal` at sensitivity `confidential` or stricter.
- Floors: `personal`, `financial`, `security`, `communication` → at least `confidential`; communication content →
  `restricted`; `operational` and `commercial` have no floor beyond the default `internal`.
- Credentials and secrets are not a category: a value detected as a credential is refused, never stored.
- An unknown classification is `tbc` and is treated as `restricted` until classified (owner decision Q6).
- Implemented today for the platform's own columns only: `apps/api/src/modules/domain/security/classification.ts`
  (vocabulary, floors) and `apps/api/src/modules/tenancy/security/classification-manifest.ts` (one entry per
  column, enforced by the schema guard). Extension fields adopt the same vocabulary when the registry is built (A2+).
