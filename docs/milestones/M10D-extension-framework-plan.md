# Milestone 10D — Extension framework foundation: implementation plan

- Status: **PROPOSED PLAN (2026-10-15).** No schema, migration or code change has been made for M10D.
  Implementation follows `BUILD → TEST → VERIFY → MUTATION PROOF → FRESH CLONE → RUNTIME → DOCKER → INDEPENDENT
REVIEW → USER APPROVAL → MERGE`, on a fresh branch from `integration`.
- Every open question (§25) carries a **recommended default**. Owner instruction (2026-10-14): building all M10
  sub-milestones is approved and the recommended defaults apply **unless the owner overrides them**; each is marked
  `DEFAULT`.
- Parent: [M10 plan](M10-canonical-architecture-implementation-plan.md) (approved, revision 3: D1–D6, F1–F5), §2
  (Extension row), §3, §4, §5 row 5, §9 (option A, approved in E4), §10, §13, §14, §15 (M10D), §16 controls 7, 8 and
  20, §17 (module `extension`), §18. Predecessors: [M10A1](M10A1-security-foundation.md) (ADR 0026),
  [M10A2](M10A2-canonical-versioning-governance.md) (ADR 0027), [M10B](M10B-source-reference-evidence-link.md) (ADR
  0028), [M10C](M10C-account-hierarchy-affiliation.md) (ADR 0029, merged into `integration` as `ce9b052`, PR #32).
- Candidate input: [E4 — Extension framework](../architecture/canonical-v1/04-extension-framework.md) (registry,
  definitions, X1–X5, guardrails, value storage, mapping, capture, promotion, revision R1);
  [E7 — Data quality and structured values](../architecture/canonical-v1/07-data-quality-and-structured-values.md)
  (collections and JSON representation); [E5](../architecture/canonical-v1/05-source-reference-and-provenance.md)
  (provenance); [CANDIDATE](../architecture/canonical-v1/CANDIDATE.md); ADR 0020 (mapping, authority, closed
  transforms), ADR 0023 (record-level safety), ADR 0025, ADR 0027 (registry, modules, value history).
- Base: `integration` at `ce9b052` (M10C merge; includes M10B `e23dfd4` and M10A2 `506839f`). `main` stays
  untouched. This plan's PR targets `integration`.
- Two acceptance sections apply: `Canonical / business correctness` (§20) and `Security & Data Governance` (§21).
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made. M10D builds technical foundations only.
- Canonical version after M10D: **`0.4`** (M10 plan §15.0). Module `extension` becomes **available** at `0.4`.
- ADR: following the M10A1–M10C pattern, **no ADR is drafted with this plan**. ADR **0030** (extension framework,
  module `extension`, canonical `0.4`) is written during implementation (Q33).

## 0. What exists today (`IMPLEMENTED TODAY`, from inspection of `integration` `ce9b052`)

| Area                        | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension storage           | **None.** No `tenant_extension_*`, `tenant_custom_records` or `tenant_custom_relationships` table, no writer, no read model.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Governed registry (M10A2)   | `tenant_registry_versions` (PK `(tenant_id, kind, version)`, immutable, `base_version`, `content_hash`, `document_schema_version`, `canonical_version_min`, actor, `audit_event_id`) and projection `tenant_registry_entries` (PK `(tenant_id, id)`, unique `(tenant_id, kind, key)`, `status` `active` / `retired` / `promoted`, `definition` jsonb, `introduced_in`, `last_changed_in`, **`sensitivity`, `categories[]` columns already present and unused**).                                                             |
| Registry code               | `REGISTRY_KINDS` includes `extension`; `AVAILABLE_REGISTRY_KINDS = ['data_policy']`, so `extension` is refused `registry_kind_not_available`. `RegistryService.publishKind`: base-version check, reviewed content hash, `refuseSecretLike` on the document, generic rules R-K (key `^[a-z][a-z0-9_]{0,62}$`), R-X1 (key never disappears), R-X3 (`codes` never disappear), R-X4 (`kind` / `target` never change); advisory lock per (tenant, kind); one audit event. `REGISTRY_DOCUMENT_MAX_BYTES = 256 KiB` for every kind. |
| Modules (M10A2)             | `canonical_modules` / `CANONICAL_MODULES`: all nine keys **unavailable**, `extension` included (`minimumCanonicalVersion NULL`, `entityKinds []`). `ModuleGate.require(tx, actx, key)` refuses `module_disabled` (audited, security event). `disabledModuleTargets` hook exists for mapping validation. Adoption **never changes** module settings and does not look at enabled modules on rollback.                                                                                                                         |
| Mapping (ADR 0020)          | `FieldEntrySchema` includes a loose `{ kind: 'attribute' }` entry; the validator refuses it `attribute_mappings_not_enabled` ("attribute mappings need the attribute registry"). `MappingEntitySchema` = `account` / `person` / `subscription`. `MAPPING_LIMITS`: `documentBytes` 256 KiB, `objects` 20, **`fieldsPerObject` 300**. Closed transform set `nullValues` / `normalise` / `parse` / `valueMap`. No `custom_object`, `custom_relationship` or `capture` kinds.                                                    |
| Entity index                | `tenant_entity_index` kinds `company`, `person`, `product` (key-identified), `subscription`, `person_affiliation`; maintained by the generic `app_entity_index_add(kind)` / `app_entity_index_remove(kind)` trigger functions owned by `lip_entity_indexer`. Polymorphic FKs follow the evidence-link pattern: two nullable FKs `(tenant_id, kind, entity_id)` / `(tenant_id, kind, entity_key)` → index.                                                                                                                    |
| Change records              | `CHANGE_ENTITY_KINDS` = `company`, `person`, `subscription`, `product`, `person_affiliation`; `CHANGE_TYPES` (12, part of every version's catalogue hash, so **not** widened); CHECK `tenant_context_changes_fields_format` = `^([A-Za-z][A-Za-z0-9_]{0,63}(,\|$))*$` (an `ext:<key>` token does not pass today).                                                                                                                                                                                                            |
| Value history               | Closed catalogue `VALUE_HISTORY_FIELDS` keyed by table column; DB CHECK `tenant_value_history_field_valid` = explicit `(entity_kind, field)` list; classification read from the platform manifest; restricted-history rule (personal / communication / security / restricted / `tbc` → value-free unless a published data policy allows values). Value-history rows FK to the entity index.                                                                                                                                  |
| Classification (M10A1, R1)  | `SENSITIVITIES` `public` / `internal` / `confidential` / `restricted`; `DATA_CATEGORIES` with floors (`personal`, `financial`, `security`, `communication` ≥ `confidential`); `tbc` = restricted; a `personal` column needs a subject link. The classification manifest covers every column of every tenant table (schema guard).                                                                                                                                                                                            |
| Secret-like refusal (M10A1) | `findSecretLike` / `findSecretLikeInJson` (explicit patterns: PEM keys, JWT, bearer, AWS, Stripe, Slack, GitHub, HubSpot PAT, Chargebee key, Google key, URL credentials, credential assignments); `WriteAuthorizer.refuseSecretLike` (audited denial).                                                                                                                                                                                                                                                                      |
| Profiling (M9A)             | Field sensitivity `normal` / `sensitive_by_name` / `sensitive_by_value` / `excluded_opt_in` (`domain/profiling/privacy.ts`); profile-aware mapping validation (`validateMappingProfiles`).                                                                                                                                                                                                                                                                                                                                   |
| Identity conflicts          | `tenant_identity_conflicts` kinds: `shared_email`, `merge_across_systems`, `ambiguous_primary_company`, five `hierarchy_*`, `affiliation_endpoint_unresolved`; `entity_kind` `company` / `person`.                                                                                                                                                                                                                                                                                                                           |
| Merge                       | Ports `CompanyMergeParticipant` (`COMPANY_MERGE_PARTICIPANTS`) and, since M10C, `PersonMergeParticipant` (`PERSON_MERGE_PARTICIPANTS`), both inside the merge transaction.                                                                                                                                                                                                                                                                                                                                                   |
| Canonical versions          | `0.1`, `0.2` `supported`, `0.3` `current` (ADR 0029). Catalogue hash with optional members hashed only when present (`canonicalCatalogueFor`). `CANONICAL_VERSION_FEATURES['0.3']` = `account_hierarchy`, `person_affiliations`, `hierarchy_operator_entry`.                                                                                                                                                                                                                                                                 |
| Security                    | `POLICY_VERSION = 4` (32 capabilities). `canonical.human_entry` granted to `operator`, honoured only by the M10C hierarchy / affiliation commands; `config.registry.publish` (`operator`) exists for non-`data_policy` kinds. Owner-function allow-list `SECURITY_DEFINER_FUNCTIONS`; `security integrity-verify` (M10A2 + M10B + six M10C checks).                                                                                                                                                                          |
| Config                      | `config.schema.ts`: `CANONICAL_HIERARCHY_MAX_DEPTH` (Zod, start-up refusal). No extension guardrails.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Dependencies                | No JSON Schema library (no Ajv); Zod 4 is the validation library.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Latest migration / runtime  | `20270105120000_m10c_account_hierarchy_affiliation`; runtime scripts up to `scripts/verify-runtime.d/88-account-hierarchy-affiliation.sh`.                                                                                                                                                                                                                                                                                                                                                                                   |

## 1. Scope

In scope (M10 plan §2, §5 row 5, §9 option A, §15 M10D, refined by inspection):

1. **Extension registry document** (registry kind `extension` becomes available): custom field, custom object and
   custom relationship definitions; publish validation (types, constraints, guardrails, classification,
   `allowed_uses`, `not_evidence_of`); cross-version rules X1–X5 plus R-X6 (classification never weakens).
2. **Typed value storage** (option A): `tenant_extension_values`, `tenant_extension_value_items`, with DB CHECKs per
   value type; targets and reference values anchored in the entity index.
3. **Custom objects and relationships:** `tenant_custom_records` (entity-index kind `custom_record`),
   `tenant_custom_relationships` (both ends in the entity index).
4. **Single writers:** `ExtensionValueWriter`, `CustomRecordWriter`, `CustomRelationshipWriter` — typed validation,
   secret-like refusal, guardrails, provenance, change records, optional value history.
5. **Mapping entry kinds** `attribute` (un-reserved), `custom_object`, `custom_relationship`, `capture`.
6. **Use enforcement:** `allowed_uses` and `not_evidence_of` checked by an `ExtensionUseGuard` every reader passes
   through; extension data can never feed ownership, identity or (in M10D) eligibility.
7. **Merge participants** for extension values and custom-record parents (company and person merges).
8. **Read models with batch loading** and operator CLI (show, set / clear / release, records, relationships).
9. **Canonical `0.4`** with the explicit adoption path; module `extension` available at `0.4`; entity-index kind
   `custom_record`; generic reference kind `custom_record`; change entity kinds `custom_record`,
   `custom_relationship`.
10. **Security integration:** classification required on every definition, no per-tenant DDL, no secrets as
    extension data, restricted values not stored, policy v5, audit vocabulary, manifests, schema guard, integrity
    checks.

Out of scope: see §24.

## 2. Extension registry (kind `extension`)

### 2.1 Document

One versioned document per tenant (registry kind `extension`, the M10A2 store): `{ schema_version: 1, fields: [...],
objects: [...], relationships: [...] }`. Publish = dry run (`registry dry-run --kind extension`) → reviewed content
hash → `registry publish --kind extension --expected-base <n> --expected-hash <h>` (existing flow, existing
capability `config.registry.publish`, Q17). Each definition becomes one projected `tenant_registry_entries` row
(`kind = 'extension'`); `definition.kind` ∈ `field` / `custom_object` / `custom_relationship`, so R-X4 already forbids
changing a definition's kind or target. **One key namespace per tenant** for all extension definitions (Q2).

### 2.2 Custom field definition

| Property                      | Rule (E4 §2.1, R1)                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                         | R-K; unique in the tenant's extension namespace (Q2); never removed (X1); `src_` prefix reserved for `origin = source_captured`                                                                                                                               |
| `target`                      | `account`, `person`, `subscription`, `product`, `person_affiliation`, or `custom_object:<key>` (Q31); never changes (X4)                                                                                                                                      |
| `display_name`, `description` | required; 1–200 / 1–2,000 chars; secret-scanned                                                                                                                                                                                                               |
| `value_type`                  | closed: `string`, `text`, `number`, `integer`, `boolean`, `date`, `datetime`, `money`, `enum`, `multi_enum`, `array`, `json`, `reference` (Q6); never changes (X2)                                                                                            |
| `allowed_values`              | `enum` / `multi_enum` only: `{code (^[a-z0-9_]{1,64}$), label, status active\|retired}`; codes never removed (X3, via R-X3 on `codes`)                                                                                                                        |
| `constraints`                 | per type: `max_length` (≤ guardrail), `min` / `max`, `max_items`, `item_type` (array: `string` / `number` / `integer` / `date` / `enum`), `json_schema` (subset, Q8), `reference_to` (target kinds), `currency` (optional fixed ISO 4217 code, Q7). No regex. |
| `sensitivity`, `categories`   | **required** (control 8): R1 vocabulary and floors; a field on a custom object is never weaker than the object; never weaker than in a previous version (R-X6, Q11)                                                                                           |
| `allowed_uses`                | closed: `display`, `segmentation`, `eligibility`, `signal_input`, `analytics`, `ai_context`; `eligibility` / `signal_input`, and `ai_context` on a `personal` field, need a recorded `confirmation {by, note}` (E4 §4)                                        |
| `not_evidence_of`             | closed fact codes; the platform floor `account_identity`, `person_identity`, `subscription_ownership` is always added and cannot be removed (Q21)                                                                                                             |
| `status`                      | `active` / `retired`; `promoted` refused in M10D (Q28)                                                                                                                                                                                                        |
| `origin`                      | `tenant_defined` / `source_captured` (§5.4)                                                                                                                                                                                                                   |
| `history`                     | `current_only` (default) / `value_history` (§9)                                                                                                                                                                                                               |

### 2.3 Custom object definition

E4 §2.2: `key` (must not shadow a canonical or module entity name: the platform list of `ENTITY_INDEX_KINDS`,
`MODULE_KEYS` and the M10 §2 entity names is reserved), `display_name`, `description`, `record_identity` (platform
UUID always; optional `natural_key` over ≤ 3 of its own `string` / `integer` / `date` / `enum` fields; source references
allowed, Q15), `parent` (optional `{ kind: account|person|subscription|product, required: boolean }`, enforced by the
writer and integrity check), `lifecycle` (record states `active` / `inactive` / `retired`, optional tenant status
`enum` field), object-level `sensitivity` / `categories` / `allowed_uses` (fields may only be stricter), `status`.
Fields of a custom object are custom field definitions with `target = custom_object:<key>`.

### 2.4 Custom relationship definition

E4 §2.3: `key`, `from` / `to` (custom object ↔ canonical target, or custom ↔ custom; canonical ↔ canonical refused
`canonical_relationship_not_extension`), `cardinality` (`one_to_one` / `many_to_one` / `many_to_many`), optional `role`
code, `required`, `on_target_retired` = `keep` (the only value). Classification as for fields (defaults to the stricter
end's object classification).

### 2.5 Cross-version rules

| Rule | Check                                                                                                                                                                                                      | Where                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| X1   | a key never disappears                                                                                                                                                                                     | generic R-X1 (existing)        |
| X2   | `value_type` (and `item_type`) never changes for a key                                                                                                                                                     | new extension rule `R-X2`      |
| X3   | enum codes never disappear (retire instead)                                                                                                                                                                | generic R-X3 on `codes`        |
| X4   | `target` / `kind` / `from` / `to` never change                                                                                                                                                             | R-X4 (extended to `from`/`to`) |
| X5   | narrowing a constraint (`max_length`, `min`/`max`, `max_items`, enum code retirement, JSON schema, `reference_to`, cardinality, a fixed `currency` added or changed) only when no stored value violates it | publish-time DB check (`R-X5`) |
| R-X6 | `sensitivity` / `categories` never become weaker; tightening to `restricted` refused while stored values exist (Q10, Q11)                                                                                  | publish-time DB check          |

X5 / R-X6 checks run inside the publish transaction under the registry advisory lock, as bounded `EXISTS` probes on
the typed indexes (no full-table read into memory). A violation refuses the publish (`registry_rule_violation`, rule +
key; no value in the message).

### 2.6 Classification and credential refusal (controls 7, 8)

- Publish refuses a field, object or relationship without `sensitivity` and at least one category
  (`classification_required`); category floors and object ≥ field are validated (`classificationProblems` reused).
- **Credential-like definitions refused** (`credential_like_definition`): a key, display name or description
  containing a token of the closed list `password`, `passwd`, `secret`, `api_key`, `apikey`, `access_token`,
  `refresh_token`, `client_secret`, `private_key`, `credential`, `token` (as a whole underscore-delimited word) is
  refused; there is no secret value type (Q12). The whole document still passes `refuseSecretLike`.
- Projected entries fill the existing `sensitivity` / `categories` columns of `tenant_registry_entries`.

### 2.7 Guardrails (platform configuration, not canonical semantics)

`EXTENSION_MAX_FIELDS_PER_TARGET` (1,000), `EXTENSION_MAX_OBJECTS` (100), `EXTENSION_MAX_FIELDS_PER_OBJECT` (300),
`EXTENSION_MAX_RELATIONSHIPS` (300), `EXTENSION_MAX_ENUM_VALUES` (1,000), `EXTENSION_MAX_ARRAY_ITEMS` (500),
`EXTENSION_MAX_JSON_BYTES` (65,536), `EXTENSION_MAX_JSON_DEPTH` (8), `EXTENSION_MAX_RECORDS_PER_OBJECT` (10,000,000),
`EXTENSION_REGISTRY_MAX_BYTES` (2 MiB, Q3) — E4 §2.4 defaults; Zod-validated with bounded ranges; an out-of-range
value refuses start-up (as `CANONICAL_HIERARCHY_MAX_DEPTH`). Enforced at publish (definition counts, constraint upper
bounds) and at write time (items, JSON size / depth, records per object). Exceeding one is a refused publish or a
rejected observation, **never truncation**. Per-tenant / per-tier overrides deferred (Q5). Changing a guardrail is
never a canonical version change.

## 3. Value storage (option A)

### 3.1 `tenant_extension_values` (tenant-owned, forced RLS)

| Column                                                  | Type / rule                                                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `id`                                       | PK `(tenant_id, id)`                                                                                                                                                                                      |
| `target_kind`                                           | CHECK ∈ extension target kinds (`company`, `person`, `subscription`, `product`, `person_affiliation`, `custom_record`)                                                                                    |
| `target_id` / `target_key`                              | exactly one set (`target_key` iff `product`, D3); composite FKs `(tenant_id, target_kind, target_id)` / `(tenant_id, target_kind, target_key)` → `tenant_entity_index`, `ON DELETE RESTRICT`              |
| `field_registry_kind`, `field_id`                       | `field_registry_kind text NOT NULL CHECK (= 'extension')`; composite FK `(tenant_id, field_registry_kind, field_id)` → `tenant_registry_entries (tenant_id, kind, id)` (new unique key on the projection) |
| `value_type`                                            | copied from the definition at write; CHECK closed set; immutable (trigger)                                                                                                                                |
| `value_state`                                           | `present` / `empty` (explicit empty). **No row = unknown.**                                                                                                                                               |
| `value_text`                                            | `string` ≤ 1,000 chars, `text` ≤ 32,768 chars (Q9)                                                                                                                                                        |
| `value_number numeric`                                  | `number`; `integer` with CHECK `value_number = trunc(value_number)`                                                                                                                                       |
| `value_bool`, `value_date date`, `value_ts timestamptz` | `boolean`, `date`, `datetime`                                                                                                                                                                             |
| `value_money_minor bigint`, `value_currency char(3)`    | `money` (Q7): both or neither; currency CHECK `^[A-Z]{3}$`                                                                                                                                                |
| `value_enum text`                                       | `enum` code `^[a-z0-9_]{1,64}$`                                                                                                                                                                           |
| `value_item_count smallint`                             | `multi_enum` / `array`: number of item rows (parity: integrity check)                                                                                                                                     |
| `value_json jsonb`                                      | `json`; CHECK `octet_length(value_json::text) <= 65536` (DB ceiling; guardrail may be lower) and `app_jsonb_depth(value_json) <= 16` (immutable invoker SQL function; ceiling above the config cap)       |
| `value_ref_kind`, `value_ref_id` / `value_ref_key`      | `reference`; composite FKs → `tenant_entity_index` (as target); exactly one of id / key                                                                                                                   |
| CHECK `tenant_extension_values_typed`                   | when `present`: **exactly** the column(s) of `value_type` set and every other value column NULL; when `empty`: all NULL                                                                                   |
| `origin`                                                | `source_provided` / `human` / `migration`                                                                                                                                                                 |
| `source_connection_id`, source triple                   | nullable; all-or-none CHECK; composite FK → `tenant_source_connections`                                                                                                                                   |
| `observed_at`, `source_updated_at`                      | timestamptz                                                                                                                                                                                               |
| `field_hash`                                            | 64 hex (idempotency; no values)                                                                                                                                                                           |
| `registry_version`                                      | FK `(tenant_id, field_registry_kind, registry_version)` → `tenant_registry_versions`                                                                                                                      |
| `released_at`                                           | timestamptz NULL (human override released, §4.3)                                                                                                                                                          |
| `last_change_id`, `created_at`, `updated_at`            | FK → `tenant_context_changes`; timestamps                                                                                                                                                                 |

- **Uniques:** `(tenant_id, target_kind, target_id, field_id)` and `(tenant_id, target_kind, target_key, field_id)`.
- **Indexes (M10 §13):** one per typed column `(tenant_id, field_id, value_x)` for `text` (left-prefix, `string`
  only), `number`, `bool`, `date`, `ts`, `money`, `enum`, `ref`; `(tenant_id, target_kind, target_id)` for batch
  loading. No index on `value_json` (paths not queryable, E4 §3).
- **Privileges (`lip_app`):** `SELECT, INSERT, UPDATE`; **no `DELETE`** (explicit empty instead).
- **Triggers:** tenant-id immutability; identity immutability (`target_*`, `field_id`, `value_type` never change);
  `updated_at`.
- **Sensitivity is not copied to the row** (the M10 §9 column list names one): it is read from the registry entry by
  FK, and R-X6 makes it monotonic, so no stale copy can exist (§26).

### 3.2 `tenant_extension_value_items`

`(tenant_id, value_id, ordinal)` PK; composite FK `(tenant_id, value_id)` → values `ON DELETE RESTRICT`;
`item_type` CHECK; `item_text` (≤ 1,000) / `item_number` / `item_date` / `item_enum` — exactly one by type (CHECK);
partial-free uniqueness for `multi_enum` (set semantics) enforced by the writer and integrity check
`extension_items_parity`. Index `(tenant_id, item_enum)` and `(tenant_id, value_id)` ("accounts having code X").
**Replace-on-change**: the writer deletes and re-inserts a value's items in the same transaction, so `lip_app` gets
`SELECT, INSERT, DELETE` on this table only (Q26); the history of a collection lives in value history.

### 3.3 `tenant_custom_records`

`(tenant_id, id)` PK; `object_registry_kind` / `object_id` (FK to the projection, definition kind `custom_object`,
writer-checked); `parent_kind` / `parent_id` / `parent_key` (entity-index FKs, NULL unless the object declares a parent;
required parent enforced by the writer and integrity check `custom_record_parent_missing`); `natural_key_hash` (64 hex,
NULL; unique `(tenant_id, object_id, natural_key_hash)`); `record_state` `active` / `inactive` / `retired` / `merged`;
`merged_into_id` (FK to itself, NOT NULL iff `merged`); `origin`; `field_hash`; `last_change_id`; timestamps.
Entity-index trigger kind **`custom_record`** (generic functions, allow-list unchanged). No `DELETE`. Record count per
object checked at create against the guardrail.

### 3.4 `tenant_custom_relationships`

`(tenant_id, id)` PK; `rel_registry_kind` / `rel_def_id` (FK to projection); `from_kind` / `from_id` / `from_key` and
`to_kind` / `to_id` / `to_key` (entity-index FKs, exactly one of id / key per end); `role_code`; `state` `active` /
`ended`; `ended_at`, `end_reason` (`source_removed`, `operator`, `endpoint_merged`); `origin`; source triple;
`last_change_id`; timestamps. One active edge per (definition, from, to) and the cardinality rule are enforced by the
writer under a per-(tenant, definition, from) advisory lock **and** a guard trigger (lock-then-read, READ COMMITTED /
SERIALIZABLE only, the M10C D1 / D13 pattern; Q27). No `DELETE`. Not indexed in the entity index (Q25).

## 4. Writers

### 4.1 `ExtensionValueWriter` (single writer of values and items)

| Method                                            | Capability              | Notes                                                                                                                                                    |
| ------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe(actx, tx, target, values[], provenance)` | `canonical.source_sync` | from `ContextIngestionService`, `SubscriptionIngestionService` and `CustomRecordWriter` only, after their own authority decision (Q13); batch per target |
| `set` / `clear` / `release(actx, tx, input)`      | `canonical.human_entry` | operator; reason code token (M10C D3); one audit event per call                                                                                          |
| `onCompanyMerged` / `onPersonMerged`              | merge's                 | §7                                                                                                                                                       |

Layer-1 checks, in order: adopted ≥ `0.4` (`canonical_version_too_low`) → module `extension` enabled
(`ModuleGate.require`) → field exists, `active`, target matches (`extension_field_unknown` / `_retired` /
`_target_mismatch`) → target exists and is not `merged` → effective sensitivity `restricted` → **not stored**, counted
`restricted_value_withheld` (Q10) → type parse and constraints (`extension_value_invalid:<reason>`) → guardrails →
`assertNotSecretLike` on `string` / `text` / array text items, `findSecretLikeInJson` on `json` (refusal audited; never
stored) → reference target exists in the tenant, is of an allowed kind and not `merged` → field hash → write.
Idempotent: an unchanged hash writes nothing. Source disappearance, an unmapped field, or a failed / partial /
unaccepted run **never** clears a value; only an explicit empty source value (`explicit` / null-value transform result)
sets `value_state = 'empty'`.

### 4.2 `CustomRecordWriter` / `CustomRelationshipWriter`

- Records: resolve by generic source reference kind `custom_record` (source id), else natural key hash, else create;
  parent resolved through the parent's existing reference store (unresolved → record kept without parent only when the
  parent is optional, else the record is rejected and an open `custom_record_parent_unresolved` issue recorded);
  fields written through `ExtensionValueWriter.observe` in the same transaction; state transitions `active` ↔
  `inactive`, → `retired` (terminal except operator reactivation, audited).
- Relationships: endpoints resolved by reference; unresolved → open `custom_relationship_endpoint_unresolved`
  issue, retried next observation (no pending store, M10C Q6 pattern); authoritative removal → `ended`
  (`source_removed`); absence never ends an edge.
- Authority: a custom object is written by exactly **one** connection — the one whose published mapping maps it;
  a second connection's mapping that maps the same object is refused at publish
  (`custom_object_owned_by_other_connection`, Q14). Relationships follow the owner of their `from` custom object.

### 4.3 Human entry and source values (Q16)

Operator `set` / `clear` writes `origin = 'human'`, which is **sticky**: a later source value that differs is not
applied and records an open `extension_human_override_disagrees` issue (identifiers + field key, no values) — closing
for extensions the gap M10C left for affiliations (tech debt #76). `release` sets `released_at` and lets the next
authoritative source value apply.

### 4.4 Data-quality issues (interim store)

`tenant_identity_conflicts.kind` widened with `extension_value_conflict` (merge), `extension_human_override_disagrees`,
`extension_reference_unresolved`, `custom_record_parent_unresolved`, `custom_relationship_endpoint_unresolved`;
`entity_kind` widened with `subscription`, `product`, `person_affiliation`, `custom_record`. Per-record type rejections
are **not** issues: they are counted per (field key, reason code) in the run report and as
`lip_extension_value_rejected_total{reason}`; the rejected-observation store is M10L (Q7 of M10C pattern; §26).

## 5. Mapping entry kinds

### 5.1 `attribute` (un-reserved)

`{ kind: 'attribute', field: <extension key>, source: <ApiName>, transforms?, confirmation? }` on an object mapping of
entity `account` / `person` / `subscription` or a `custom_object`. Validation: tenant adopted ≥ `0.4` and module
enabled (`canonical_version_min = 0.4` on the mapping version); field exists in the **current** published extension
registry, `active`, target = the object's entity; source field exists in the snapshot; declared source type parses to
the value type through the closed transforms (`valueMap` required for `enum` / `multi_enum` into allowed codes);
consequential uses (`eligibility`, `signal_input`, `ai_context` + `personal`) need a recorded `confirmation`
(`unconfirmed_consequential_entry`); profile-aware: a field profiled `sensitive_by_value` mapped to a field below
`confidential` is refused (`attribute_classification_below_profile`). The refusal code
`attribute_mappings_not_enabled` remains for tenants below `0.4`.

### 5.2 `custom_object`

New object-mapping entity `custom_object:<key>` (`MappingEntitySchema` widened by pattern): `identity` (source id field,
confirmed), optional `naturalKey` fields, optional `parent` relationship (to an `account` / `person` / `subscription`
reference field), `fields: [attribute | ignored | capture]`, optional `recordState` mapping (value map into
`active` / `inactive` / `retired`). Holding filters do not apply (no ownership semantics).

### 5.3 `custom_relationship`

Relationship entry `{ target: 'custom_relationship:<key>', field, object, confirmation? }` on the `from` object's
mapping; `role` from a value map into the definition's role code only.

### 5.4 `capture`

`{ kind: 'capture', source: <ApiName> }`. The captured field must already exist in the published registry with
`origin = source_captured`, key `src_<connection_kind>_<object>_<field>` (normalised to the key pattern; > 63 chars →
truncated plus an 8-hex hash suffix; collision-checked) and `allowed_uses ⊆ {display, analytics}` (E4 §5). **Mapping
publish never publishes registry entries** (Q20): `extension capture-draft --connection <id>` prints the registry
additions for the operator's dry run / publish. A source field profiled `sensitive_by_name` or `sensitive_by_value`
(or, without a covering profile, matching the M9A sensitive-name detector) is refused `capture_sensitive_refused` — it
is not stored (E4 §5, M10 §15 M10D).

### 5.5 Limits (Q4)

`MAPPING_LIMITS.fieldsPerObject` 300 → **1,000** and `documentBytes` 256 KiB → **1 MiB** (limits only widen:
existing published mappings validate and hash identically, test). `canonical_version_min` of a mapping using any new
kind = `0.4`.

## 6. Use enforcement (`allowed_uses`, `not_evidence_of`)

- `ExtensionUseGuard.require(use, fieldKeys)` — every reader of extension values names its use; fields lacking it are
  filtered out (read models) or refused (`extension_use_not_allowed`) when a consumer requests them explicitly.
- **No consumer in M10D reads extension values for eligibility, ownership, whitespace, coverage or identity**: the M7
  evaluator, ownership derivation and identity resolution have no extension input, and a dependency-cruiser rule
  forbids `products` / identity code from importing the extension read model (boundary test, Q21).
- `not_evidence_of` floor (`account_identity`, `person_identity`, `subscription_ownership`) is always present; the
  `EvidenceLinkWriter` refuses a `custom_record` evidence entry whose object lists the link's relation fact (no
  production relation exists yet — unit-tested on the writer, #71).

## 7. Merge participants

- `ExtensionMergeParticipant` implements `CompanyMergeParticipant` and `PersonMergeParticipant` (wired in the
  composition root, always): for each loser value — survivor has none → copy to the survivor (origin kept, change record
  with the merge's provenance, value history if enabled); survivor has the same hash → nothing; survivor differs →
  survivor keeps its value and an open `extension_value_conflict` issue names both ids and the field key (**never
  silently overwritten**, E4 §3). Loser rows are kept (lineage; merged rows are read-only).
- Custom records whose `parent` is the loser are **re-pointed** to the survivor (change record).
- Reference values and custom relationships pointing at the loser are **not rewritten**: readers follow
  `merged_into_id` lineage (E4 §2.3 "follows merge lineage"; Q22).

## 8. Read models and CLI

- `ExtensionReadModel.valuesFor(actx, use, targets[], fieldKeys?)`: batch loads by `target_id = ANY($1)` /
  `target_key = ANY($1)` (no N+1, M10 §13), items in one query, merge lineage resolved for references, use-filtered.
- `CustomRecordReadModel` (implemented as `ExtensionReadModel.records` / `.record`, record D-m2): records of an object (keyset pagination), record with fields and relationships.
- Capability `data.extension.read` (`operator`); one audit event per read call (identifiers, counts; Q29).
- CLI (JSON, identifiers / codes / dates; field values printed only for `public` / `internal` fields unless
  `--include-confidential`, which is audited; exit 2 on refusal): `extension registry show`, `extension capture-draft`,
  `extension values show --target <kind>:<id>`, `extension value set / clear / release`, `extension records list /
show`, `extension record create / update / retire / reactivate`, `extension relationship add / end`.

## 9. Change records and value history

- One change record per writer call per target (`entity_kind` = the target's kind; custom records `custom_record`;
  edges `custom_relationship`), existing change types only (`created`, `updated`, `state_changed`,
  `relationship_changed`, `merged`) — **`CHANGE_TYPES` is not widened** because it is part of every version's
  catalogue hash (Q24). `changed_fields` carries `ext:<key>` tokens: the `tenant_context_changes_fields_format` CHECK
  is widened to accept `ext:[a-z][a-z0-9_]{0,62}` alongside the existing token pattern.
- `CHANGE_ENTITY_KINDS` gains `custom_record`, `custom_relationship` (DB CHECK equals code).
- **Value history** only for fields declaring `history: value_history`: `entity_kind` = target kind, `field =
'ext:<key>'`; `tenant_value_history_field_valid` widened with an alternative `field ~ '^ext:[a-z][a-z0-9_]{0,62}$'
AND entity_kind IN (<extension target kinds>)`. Classification comes from the registry entry instead of the
  manifest; the restricted-history rule applies unchanged (personal / communication / security → value-free unless a
  published data policy allows the key; the data-policy `value_history.allow` list accepts `ext:<key>` entries
  validated against the current registry, Q23).

## 10. Canonical version `0.4` and module `extension`

- **Catalogue:** `CANONICAL_VERSIONS` = `0.1`, `0.2`, `0.3` (`supported`), `0.4` (`current`, ADR 0030). The migration
  inserts `0.4` and moves `0.3` to `supported` in the order the one-current trigger accepts.
- **Catalogue hash:** `0.4` = the `0.3` catalogue with `entityKinds` + `custom_record`, `changeEntityKinds` +
  `custom_record` / `custom_relationship`, `genericReferenceKinds` + `custom_record`, and new optional members
  `extensionValueTypes`, `extensionTargets`, `extensionAllowedUses`, `mappingEntryKinds` (`attribute`,
  `custom_object`, `custom_relationship`, `capture`). Frozen `_0_3` lists are introduced for the kinds lists, so stored
  `0.1`–`0.3` hashes are reproduced unchanged (test).
- `CANONICAL_VERSION_FEATURES['0.4']` = `extension_registry`, `extension_values`, `custom_objects`,
  `custom_relationships`, `source_attribute_capture`.
- **Module `extension`:** `canonical_modules` row becomes `available = true`, `minimum_canonical_version = '0.4'`,
  `entity_kinds = ['custom_record']` (catalogue = code, schema guard). Disabled by default for every tenant.
- **Gating (Q18):** writers, registry publish of kind `extension`, mapping publish with the new kinds and operator
  commands require adopted ≥ `0.4` **and** module enabled. Below `0.4` → `canonical_version_too_low`; module disabled →
  `module_disabled`; both audited.
- **Adoption:** explicit (`canonical adopt --version 0.4 --expected-current 0.3`; dry run lists the features and
  `modulesNewlyAvailable: ['extension']`); new tenants adopt `0.4` at provisioning (module still disabled).
  **Rollback `0.4 → 0.3`** is allowed with the module enabled (adoption never changes module settings, M10 §17): data
  kept and readable, writes refused; the dry run lists `modulesStranded: ['extension']` (Q19).

## 11. Migration

One forward migration (M10 §5 row 5), down-script, standard migration tests:

**`20270112120000_m10d_extension_framework`** (timestamp after `20270105120000`)

1. `tenant_registry_entries`: unique `(tenant_id, kind, id)` (FK target for the typed stores).
2. `app_jsonb_depth(jsonb)` (`IMMUTABLE`, `SECURITY INVOKER`, fixed `search_path`).
3. `tenant_extension_values`, `tenant_extension_value_items`, `tenant_custom_records`, `tenant_custom_relationships`
   with constraints, indexes, triggers (immutability, guard, entity index for `custom_record`).
4. Kind CHECKs widened: `tenant_entity_index` (+ `custom_record`), `tenant_source_references` (+ `custom_record`),
   `tenant_context_changes.entity_kind` (+ `custom_record`, `custom_relationship`), `changed_fields` format (+ `ext:`),
   `tenant_value_history_field_valid` (+ extension alternative), `tenant_identity_conflicts` kind / entity kind (§4.4).
5. `canonical_modules`: `extension` available at `0.4`; `canonical_model_versions`: insert `0.4` (`current`,
   `catalogue_hash`, `adr = '0030'`), `0.3` → `supported`.
6. Audit CHECKs widened (§16); forced RLS, tenant policy, tenant-id immutability; privileges (`REVOKE ALL` then the
   manifest grants).

- **No backfill**: no extension definition or value is invented; the existing (unused) `sensitivity` / `categories`
  columns of `tenant_registry_entries` stay NULL for `data_policy`. Additive only.
- **Down-script** (dev/staging) refuses while any extension registry version, value, item, custom record or
  relationship exists, any change record / conflict / value-history row uses a new kind or `ext:` token, any tenant
  has `extension` enabled or a setting event for it, or any tenant adopted `0.4`; otherwise drops the new objects and
  restores CHECKs, the module row, the `0.3` `current` row and the M10C privilege matrix exactly. Prisma schema
  updated; drift test green.

## 12. Backward compatibility

- Every behaviour is unchanged for tenants below `0.4` or with the module disabled, and for mappings without the new
  entry kinds: ingestion, mapping, eligibility, ownership, whitespace, coverage tiers, snapshots, retirement, hierarchy,
  affiliation, provenance, CLI.
- Existing mappings validate identically (limits only widen); no republish. Existing registry `data_policy` versions
  unchanged; the `data_policy` document cap stays 256 KiB.
- `CHANGE_TYPES`, `MODULE_KEYS` and existing catalogue members are untouched.

## 13. Tenant isolation

- Targets, reference values, record parents and both relationship ends use composite FKs to the tenant-scoped entity
  index; field / object / relationship definitions use composite FKs to the tenant's registry projection; a
  cross-tenant reference is impossible with raw SQL as the app role (no matching row).
- Every new table: `tenant_id` first in every key, forced RLS, tenant-id immutability; the schema guard covers them.
- **No per-tenant DDL:** the app role has no DDL privilege (privilege manifest); a test captures DDL with an event
  trigger in the test database and asserts publishing a 600-field registry and writing values issue none.
- Guardrails are per tenant and bounded so one tenant's 1,000 fields cannot degrade another (E4 §2.4).

## 14. Integrity verification (extends M10A2 / M10B / M10C)

| Code                              | Check                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `extension_value_type_mismatch`   | each value's `value_type` equals its field definition's current `value_type`                                    |
| `extension_value_restricted`      | no stored value belongs to a field whose effective sensitivity is `restricted`                                  |
| `extension_value_target_kind`     | each value's target kind matches its field's `target`                                                           |
| `extension_items_parity`          | `value_item_count` = item rows; `multi_enum` items unique; codes ∈ the field's codes                            |
| `extension_value_secret_like`     | sampled re-scan of text / JSON values finds no secret-like pattern (bounded per run)                            |
| `custom_record_parent_missing`    | records of an object with a required parent have one                                                            |
| `custom_relationship_cardinality` | no definition's cardinality violated by active edges                                                            |
| `extension_history_parity`        | for history-enabled fields, the current value hash equals the latest value-history row's (when values recorded) |

Read-only; findings raise a security event and a non-zero exit; nothing is repaired.

## 15. Building on M10A1 / M10A2 / M10B / M10C

| Primitive                           | Use in M10D                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthorizedContext<C>` / S2         | every new write method takes its typed context first; S2 list extended                                                                       |
| Policy (`POLICY_VERSION` 4 → **5**) | §16                                                                                                                                          |
| Audit trail                         | publishes, operator writes, denials, refusals (secret-like, restricted), reads                                                               |
| Secret-like detector                | definitions (document) and every text / JSON value                                                                                           |
| Classification                      | per-definition (registry); static manifest for the new tables' columns (value columns `restricted` with a `registry`-classified marker, Q34) |
| Registry / modules                  | kind `extension` available; module `extension` available at `0.4`; `ModuleGate`                                                              |
| Entity index                        | kind `custom_record`; targets / references / relationship ends                                                                               |
| Value history / data policy         | `ext:<key>` fields; data policy allow list accepts extension keys                                                                            |
| Generic source references (B)       | kind `custom_record`                                                                                                                         |
| Merge ports (C)                     | `ExtensionMergeParticipant` on both ports                                                                                                    |
| Integrity verification              | eight new checks (§14)                                                                                                                       |

## 16. Permissions (policy v5)

| Capability                           | Covers                                                                       | Granted to (v5)         |
| ------------------------------------ | ---------------------------------------------------------------------------- | ----------------------- |
| `config.registry.publish` (existing) | extension registry dry run / publish                                         | `operator`              |
| `config.mapping.publish` (existing)  | mappings with the new entry kinds                                            | `operator`              |
| `config.module.change` (existing)    | enabling / disabling `extension`                                             | `operator`              |
| `canonical.source_sync` (existing)   | source value / record / relationship writes                                  | `source_sync`, `system` |
| `canonical.human_entry` (existing)   | operator value set / clear / release, record and relationship commands (Q17) | `operator`              |
| `data.extension.read` (new)          | extension read models / CLI                                                  | `operator`              |
| `config.canonical.adopt` (existing)  | adoption of `0.4` and rollback                                               | `operator`              |

- `canonical.human_entry` is honoured by the M10C commands and the M10D extension operator commands only (S2 test).
- **Audit actions added:** `extension.value.set`, `extension.value.clear`, `extension.value.release`,
  `extension.record.create`, `extension.record.update`, `extension.record.retire`, `extension.record.reactivate`,
  `extension.relationship.add`, `extension.relationship.end`, `extension.read`. **Reason codes added:**
  `extension_field_unknown`, `extension_field_retired`, `extension_value_invalid`, `extension_use_not_allowed`,
  `restricted_value_withheld`, `classification_required`, `credential_like_definition`, `extension_guardrail_exceeded`,
  `human_override_active` (reused). **Target kinds added:** `extension_value`, `custom_record`, `custom_relationship`.
  DB CHECKs equal the code (schema guard).

## 17. Performance and indexing

- Batch loading by `target_id = ANY($1)`; one composite index per typed column plus the items index (M10 §13).
- Writes per target are one batch (one change record, one `INSERT … ON CONFLICT` per changed field, items
  replace-on-change); unchanged hashes write nothing.
- X5 / R-X6 publish checks are bounded `EXISTS` probes on typed indexes.
- Partitioning `tenant_extension_values` by time is deferred (M10 §13); keys are partition-ready (Q30). A 500-field ×
  1,000-account load test (500k values) is recorded as evidence, not a gate.

## 18. Rollback / forward-fix

- Production: forward-fix; tenant rollback = adoption back to `0.3` (data kept, writes refused) and/or module disable.
- Dev/staging: the down-script (§11). CHECKs, FKs and guards are never relaxed to get green.

## 19. Risks

| Risk                                                        | Mitigation                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Extension data used as evidence of ownership / identity     | no consumer path (boundary rule), `not_evidence_of` floor, use guard; tests V14                                |
| Secrets or credentials stored as extension data             | credential-like definitions refused; secret-like values refused at write; integrity re-scan                    |
| Restricted / sensitive values stored while #15 is open      | restricted never stored; capture refuses sensitive fields; value-free history                                  |
| Registry or mapping document caps block 500+ fields         | extension cap 2 MiB (Q3), mapping 1,000 fields / 1 MiB (Q4); 1,000-field publish test                          |
| Write amplification / table growth                          | hash idempotency, history opt-in, guardrails, partition-ready keys                                             |
| Classification drift (field loosened after values stored)   | R-X6 (never weaker); tightening to restricted refused while values exist                                       |
| Polymorphic FK bypass across tenants                        | entity-index composite FKs; adversarial raw-SQL tests                                                          |
| Two connections writing one custom object                   | single owner connection enforced at mapping publish (Q14)                                                      |
| Silent overwrite on merge                                   | survivor keeps value; conflict issue (Q22)                                                                     |
| Scope size (four tables, four mapping kinds, three writers) | one PR but staged commits; if review finds it too large, `custom_relationship` + `capture` split to M10D2 (Q1) |
| Catalogue hash of earlier versions changes                  | frozen `_0_3` lists; V17 reproduces stored hashes                                                              |

## 20. Acceptance — Canonical / business correctness

- Every value type round-trips through the writer and the database, with the typed CHECK refusing every wrong column
  combination; `empty` vs unknown (no row) distinguished.
- A tenant with 500+ (test: 1,000) fields on one target and 100 custom objects needs no DDL; publish and writes work.
- Guardrails enforced at publish and write; refusal, never truncation.
- `allowed_uses` enforced; extension data cannot feed eligibility, ownership, whitespace, coverage or identity.
- Registry X1–X5 and R-X6 enforced (X5 against stored values).
- Source disappearance never clears values or ends records / edges; explicit empty clears; human override sticky
  until release.
- Merge: loser-only values copied; differing values → conflict issue; record parents re-pointed; references follow
  lineage.
- Custom records: identity by reference / natural key; required parent enforced; lifecycle states.
- Canonical `0.4` published; `0.1`–`0.3` `supported`; adoption forward / rollback; module gate; new tenants at `0.4`.
- Full M6–M10C suites unchanged; identical canonical results on the Sugar and Chargebee fakes.
- Migration up / rerun / down-refusal / exact restore / re-apply.

## 21. Acceptance — Security & Data Governance

- **Field sensitivity classification required:** publish refuses an unclassified definition; a field never weaker than
  its object; R-X6.
- **Custom-object tenant isolation:** RLS plus entity-index FKs; adversarial raw SQL as the app role cannot target,
  reference, parent or relate across tenants, nor forge an entity-index row.
- **No per-tenant DDL:** the app role has no DDL privilege; publish / write issue no DDL (event-trigger test).
- Restricted values not stored; restricted / personal history follows the restricted-history rule.
- Typed-value validation in the writer **and** the database; JSON size / depth and array length limits enforced.
- **No secrets as extension data:** credential-like definitions refused; secret-like values refused (audited).
- Capture refuses `sensitive_by_name` / `sensitive_by_value` fields.
- Operator writes need `canonical.human_entry` and write one audit event; reads need `data.extension.read` and are
  audited; denials audited.
- Privilege, classification, audit-vocabulary and data-subject manifests equal the database; owner-function allow-list
  unchanged.
- `1.0` still refused; no compliance claim.

## 22. Tests and mutation proofs

| #   | Test                                                                                                                                                                                                                                                | Level                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| V1  | pure registry validation: every definition kind, types, constraints, classification floors, object ≥ field, credential-like refusal, consequential-use confirmations, guardrail counts; property test of X1–X4 / R-X6 over random version sequences | unit (property)           |
| V2  | pure value parsing per type (13 types, money exponents, integer scale, JSON schema subset, depth / size, array / multi-enum items, references) incl. secret-like refusal                                                                            | unit (property)           |
| V3  | registry publish end to end: dry run hash, base version, X5 against stored values, R-X6 tightening to restricted refused with values, 1,000-field document within the 2 MiB cap, `promoted` refused                                                 | integration               |
| V4  | schema: typed CHECK refuses every wrong column combination (raw SQL as app role), JSON ceiling, integer scale, currency format, identity immutability, no `DELETE` on values / records / edges, items replace                                       | integration               |
| V5  | writer: layer-1 order, idempotent hash, explicit empty vs absent, restricted withheld (no row, counter), guardrails, reference target checks, change record and `ext:` tokens                                                                       | integration               |
| V6  | source attribute sync: `attribute` entries on account / person / subscription; authority = target profile fact; `canonical_version_min` 0.4; module disabled refused; disappearance / failed run never clears                                       | integration               |
| V7  | custom objects: `custom_object` mapping, identity by reference and natural key, parent required / optional / unresolved, lifecycle, records-per-object guardrail, single owner connection at publish                                                | integration               |
| V8  | custom relationships: cardinality (writer + guard trigger, two concurrent sessions), unresolved endpoints, authoritative removal ends, absence never ends, REPEATABLE READ refused                                                                  | integration (adversarial) |
| V9  | capture: registry draft generation, key derivation / truncation / collision, uses limited to display / analytics, sensitive_by_name / sensitive_by_value refused, mapping publish never writes the registry                                         | integration               |
| V10 | operator CLI: set / clear / release, records, relationships; capability required; one audit event; sticky human override + disagreement issue                                                                                                       | integration               |
| V11 | merge: loser-only copied, equal skipped, differing → conflict issue, record parent re-pointed, references follow lineage (company and person ports)                                                                                                 | integration               |
| V12 | value history: opt-in only, `ext:` field, full for non-sensitive, value-free for personal unless data policy allows the key, data-policy validation of extension keys                                                                               | integration               |
| V13 | adversarial (app role, raw SQL): cross-tenant target, reference value, record parent, relationship ends, field FK to another tenant's registry entry, forged entity-index row → refused / denied                                                    | integration (adversarial) |
| V14 | use enforcement: read models filter by use; explicit request refused; dependency-cruiser rule (no extension import from products / identity); M7 eligibility unchanged with extension data present; evidence `not_evidence_of`                      | unit + integration        |
| V15 | no DDL: event-trigger capture during a 600-field publish and value writes; app role has no `CREATE` on schema                                                                                                                                       | integration               |
| V16 | privacy: no extension values in logs, audit details, issues, run reports, security events (scan); CLI prints confidential values only with the audited flag                                                                                         | integration               |
| V17 | canonical catalogue: table = code; one `current` (`0.4`); stored `0.1`–`0.3` hashes reproduced; module row = code; `1.0` refused                                                                                                                    | unit + integration        |
| V18 | adoption / module: below `0.4` refused (audited); module disabled refused; adoption dry run; rollback with module enabled keeps data, refuses writes, lists stranded module; new tenant at `0.4`, module disabled                                   | integration               |
| V19 | read models: batch loading (query count bounded, no N+1), lineage resolution, pagination, capability + audit                                                                                                                                        | integration               |
| V20 | integrity: clean tenant passes; planted (owner, test DB) type mismatch, restricted value, target-kind mismatch, items mismatch, secret-like value, missing parent, cardinality violation, history mismatch → findings                               | integration               |
| V21 | S1 / S2: policy v5 exhaustive; `canonical.human_entry` accepted only by M10C / M10D operator methods                                                                                                                                                | unit                      |
| V22 | schema guard: privilege matrix, classification manifest (incl. registry-classified marker), data-subject map, entity-index FKs, kind / audit / conflict / history CHECKs equal code, allow-list unchanged                                           | integration               |
| V23 | regression: M6–M10C suites unchanged; mapping limits widened without hash change; identical canonical results on Sugar and Chargebee fakes                                                                                                          | integration (regression)  |
| V24 | migration up / rerun / down-refusal (each condition) / exact restore / re-apply; no-backfill assertion (own suite `migrations-m10d.int.spec.ts`, #72)                                                                                               | integration (migration)   |
| V25 | runtime `89-extension-framework.sh`: adopt `0.4`, enable module, publish registry, operator set / show / release, record create / list, capture draft; no values in logs                                                                            | runtime                   |

Mutation proofs (break → the named test fails for that reason → restore → green; harness refuses a dirty tree):

| #    | Mutation                                                                       | Must fail          |
| ---- | ------------------------------------------------------------------------------ | ------------------ |
| VM1  | drop the typed CHECK `tenant_extension_values_typed`                           | V4, V22            |
| VM2  | writer ignores the array-items guardrail                                       | V5                 |
| VM3  | writer ignores the JSON size / depth guardrail                                 | V2, V5             |
| VM4  | registry publish ignores the fields-per-target guardrail                       | V1, V3             |
| VM5  | use guard returns every field regardless of use                                | V14                |
| VM6  | drop `tenant_id` from the target entity-index FK                               | V13, V22           |
| VM7  | drop `tenant_id` from the reference-value FK                                   | V13, V22           |
| VM8  | drop `tenant_id` from a relationship-end FK                                    | V13, V22           |
| VM9  | publish accepts a definition without classification                            | V1, V3             |
| VM10 | publish allows weakening sensitivity (R-X6 off)                                | V1, V3             |
| VM11 | writer skips the secret-like check                                             | V2, V5             |
| VM12 | credential-like definition check removed                                       | V1                 |
| VM13 | restricted values stored                                                       | V5, V20            |
| VM14 | X2 off (value type change accepted)                                            | V1, V3             |
| VM15 | X5 off (narrowing ignores stored values)                                       | V3                 |
| VM16 | capture accepts a `sensitive_by_name` field                                    | V9                 |
| VM17 | operator command skips the capability check / the audit event                  | V10, V21           |
| VM18 | source value overrides a sticky human value                                    | V10                |
| VM19 | absence / failed run clears a value                                            | V6                 |
| VM20 | merge participant overwrites a differing survivor value                        | V11                |
| VM21 | relationship guard trigger dropped (writer check kept: concurrent sessions)    | V8                 |
| VM22 | `GRANT DELETE ON tenant_extension_values TO lip_app`                           | V4, V22            |
| VM23 | writers skip the `0.4` / module gate                                           | V18                |
| VM24 | writer validation disabled entirely (positive control: database still refuses) | V4, V13 stay green |
| VM25 | catalogue hash always includes the new members (changes `0.3`'s hash)          | V17                |
| VM26 | down-script refusal on extension values removed                                | V24                |
| VM27 | integrity ignores a planted restricted value                                   | V20                |

## 23. Definition of Done and evidence

| Item                                                                                                                                                                             | Evidence                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Migration + down-script; V24                                                                                                                                                     | CI integration job                                                                                           |
| V1–V24                                                                                                                                                                           | CI (unit; integration with Testcontainers as the app role)                                                   |
| V25 runtime script                                                                                                                                                               | CI runtime job                                                                                               |
| Format, lint, typecheck, boundaries, unit, integration, runtime, docker                                                                                                          | **GitHub Actions run IDs** (workflow `CI`, all four jobs green on the reviewed head), recorded in the record |
| Mutation proofs VM1–VM27                                                                                                                                                         | recorded with the failing output (command, failing assertion, restore, green rerun)                          |
| Fresh-clone run                                                                                                                                                                  | recorded (Docker-capable machine or CI); the sandbox has no Docker                                           |
| ADR 0030; record `docs/milestones/M10D-extension-framework.md`; README status; E4 candidate note; `canonical-extension-and-source-mapping.md` superseded note; tech-debt entries | in the PR                                                                                                    |
| Independent review, PR to `integration`, owner approval, merge                                                                                                                   | PR and review record                                                                                         |

## 24. Out of scope

- Promotion from extension to canonical (E4 §7; needs an ADR and a canonical MINOR) — `promoted` refused (Q28).
- Extension inputs to eligibility, signals, AI context or any evaluator (each needs its own evaluator version; M11 /
  later); M10D only records the declared uses.
- Field intelligence metadata and the rejected-observation store (M10L); console views (M15).
- Querying JSON paths from tenant configuration (E4 §3: no expression language).
- Per-tenant / per-tier guardrail overrides (Q5); time partitioning (Q30).
- Extension targets on module entities not yet built (AccountContext and later: they join when their MINOR registers
  them); `custom_relationship` entity-index kind (Q25).
- New connectors or adapter work; HTTP endpoints / UI (M15); integrity worker job (#65).
- Raw value retention (#15); purge / erasure execution for extension values (data-subject map only); any compliance
  claim; publishing `1.0`.

## 25. Open questions and decisions for the owner

Each answer marked `DEFAULT` is what implementation proceeds with unless the owner overrides it.

| #   | Question                                                 | Recommended answer (`DEFAULT`)                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | One migration / one PR?                                  | `DEFAULT` yes (M10 §5 row 5), staged commits; if independent review finds it too large, `custom_relationship` + `capture` split into M10D2 without a new canonical version.                                                                            |
| Q2  | Key namespace                                            | `DEFAULT` one namespace per tenant for all extension definitions (stricter than E4's per-target uniqueness; fits the registry's unique `(tenant, kind, key)`); `src_` reserved for captured fields.                                                    |
| Q3  | Registry document cap for `extension`                    | `DEFAULT` `EXTENSION_REGISTRY_MAX_BYTES` 2 MiB (range 256 KiB–8 MiB); `data_policy` keeps 256 KiB.                                                                                                                                                     |
| Q4  | Mapping limits (300 fields / 256 KiB) vs 500+ attributes | `DEFAULT` raise `fieldsPerObject` to 1,000 and `documentBytes` to 1 MiB globally; existing mappings validate and hash identically.                                                                                                                     |
| Q5  | Guardrail source                                         | `DEFAULT` platform configuration with E4 §2.4 defaults, Zod-validated, start-up refusal; per-tenant / tier overrides deferred.                                                                                                                         |
| Q6  | Value types in M10D                                      | `DEFAULT` the full E4 closed set (13 types); `integer` stored in `value_number` with a scale-0 CHECK.                                                                                                                                                  |
| Q7  | Money representation                                     | `DEFAULT` `value_money_minor bigint` + ISO 4217 `value_currency`; exponent from a closed in-code ISO 4217 table; unknown currency or non-integral minor amount rejected; optional fixed currency per field.                                            |
| Q8  | JSON schema subset                                       | `DEFAULT` in-house Zod-based validator, no new dependency: `type`, `properties`, `required`, `items`, `enum`, `maxLength`, `minimum`, `maximum`, `maxItems`; no `pattern` / `$ref`; depth ≤ 8 (DB ceiling 16), ≤ 64 KiB.                               |
| Q9  | `string` vs `text` limits                                | `DEFAULT` `string` ≤ 1,000 chars (indexed), `text` ≤ 32,768 chars (not indexed); both secret-scanned.                                                                                                                                                  |
| Q10 | Restricted fields                                        | `DEFAULT` definitions allowed; values never stored (no row, counted `restricted_value_withheld`) while #15 is open; tightening a field to `restricted` refused while values exist.                                                                     |
| Q11 | Classification evolution                                 | `DEFAULT` R-X6: sensitivity and categories may only become stricter; a looser classification needs a new key.                                                                                                                                          |
| Q12 | Credential-like definitions                              | `DEFAULT` closed token list on key / display name / description (whole-word); no secret value type; values secret-scanned with the M10A1 detector.                                                                                                     |
| Q13 | Authority for source attribute values                    | `DEFAULT` the target's existing fact (`account` → `account_profile`, `person` → `person_profile`, `subscription` → `subscription_lines`); no new authority column.                                                                                     |
| Q14 | Authority for custom objects / relationships             | `DEFAULT` single owner connection per custom object (the one whose published mapping maps it; a second is refused at publish); relationships follow their `from` object's owner; no authority column.                                                  |
| Q15 | Custom record identity                                   | `DEFAULT` platform UUID; generic source reference kind `custom_record` for the source id; optional natural key (≤ 3 own fields) hashed and unique per object.                                                                                          |
| Q16 | Operator value vs later source value                     | `DEFAULT` human wins and is sticky until `release`; disagreement recorded as `extension_human_override_disagrees` (unlike affiliations, #76).                                                                                                          |
| Q17 | Capabilities                                             | `DEFAULT` registry via existing `config.registry.publish`; operator writes via `canonical.human_entry` (scope widened to M10D commands); new `data.extension.read` (`operator`); policy v5.                                                            |
| Q18 | Gating                                                   | `DEFAULT` adopted ≥ `0.4` **and** module `extension` enabled for writers, registry publish of kind `extension`, mapping publish with new kinds and operator commands.                                                                                  |
| Q19 | Rollback `0.4 → 0.3` with the module enabled             | `DEFAULT` allowed (adoption never changes modules); data kept and readable; writes refused; dry run lists `modulesStranded`.                                                                                                                           |
| Q20 | Capture field creation                                   | `DEFAULT` mapping publish never publishes registry entries; `extension capture-draft` generates the additions for the operator's registry dry run; key `src_<kind>_<object>_<field>`, truncated + 8-hex hash beyond 63 chars.                          |
| Q21 | `allowed_uses` in M10D                                   | `DEFAULT` full vocabulary recorded; consequential uses need confirmation; no consumer reads extension values for eligibility / ownership / identity (boundary rule); `not_evidence_of` floor always present.                                           |
| Q22 | Merge                                                    | `DEFAULT` survivor keeps its value; loser-only values copied; differing → `extension_value_conflict`; loser rows kept; record parents re-pointed; references / edges follow lineage at read time.                                                      |
| Q23 | Value history for extension fields                       | `DEFAULT` opt-in per field (`history: value_history`); field token `ext:<key>`; sensitive → value-free unless the data policy allows the key.                                                                                                          |
| Q24 | Change-record vocabulary                                 | `DEFAULT` existing change types only (catalogue-hashed); `changed_fields` CHECK widened for `ext:<key>`; change entity kinds `custom_record`, `custom_relationship`.                                                                                   |
| Q25 | Entity-index kinds                                       | `DEFAULT` `custom_record` only; extension values and custom relationships are not indexed.                                                                                                                                                             |
| Q26 | Collection items                                         | `DEFAULT` replace-on-change; `DELETE` granted on `tenant_extension_value_items` only.                                                                                                                                                                  |
| Q27 | Relationship cardinality                                 | `DEFAULT` writer under a per-(tenant, definition, from) lock **plus** a guard trigger (M10C D1 / D13 pattern; REPEATABLE READ refused); integrity check.                                                                                               |
| Q28 | Promotion                                                | `DEFAULT` `promoted` refused at publish in M10D; promotion needs an ADR and a canonical MINOR.                                                                                                                                                         |
| Q29 | Read audit                                               | `DEFAULT` one audit event per read call (identifiers, counts); confidential values printed by the CLI only with an audited flag.                                                                                                                       |
| Q30 | Partitioning                                             | `DEFAULT` deferred; keys partition-ready; load test recorded as evidence.                                                                                                                                                                              |
| Q31 | Targets at `0.4`                                         | `DEFAULT` `account`, `person`, `subscription`, `product`, `person_affiliation`, custom objects; later module entities join when their MINOR registers them.                                                                                            |
| Q32 | Writes to inactive / merged targets                      | `DEFAULT` inactive accepted; merged refused (merge participant moves values instead).                                                                                                                                                                  |
| Q33 | ADR timing                                               | `DEFAULT` ADR 0030 written during implementation.                                                                                                                                                                                                      |
| Q34 | Static classification of value columns                   | `DEFAULT` the manifest classifies the typed value columns `restricted` (strictest) with an additive `classifiedBy: 'registry'` marker; per-row classification comes from the registry entry; data-subject map links values whose target is a `person`. |

## 26. Conflicts / refinements against the approved M10 plan (recorded, not silent)

- **No `sensitivity` column on value rows** (M10 §9 lists one): sensitivity is read from the registry entry by FK and
  R-X6 makes it monotonic, so a copy could only go stale.
- **`field_id` FK carries `field_registry_kind`** so the FK proves the entry is an extension definition (M10 §9 names a
  plain FK to `tenant_registry_entries`).
- **Document and mapping caps raised** (Q3, Q4): the M10A2 256 KiB registry cap and the ADR 0020 300-fields / 256 KiB
  mapping limits cannot hold the E4 guardrails ("500+ fields").
- **`integer` in `value_number`** and `value_item_count` / `released_at` columns beyond the M10 §9 column list.
- **Change types not widened**; `changed_fields` CHECK widened instead (catalogue-hash constraint, M10B Q19 pattern).
- **Per-record type rejections are counters, not issues**: the rejected-observation store is M10L (M10 §4 "interim
  behaviour is already safe").
- **`canonical.human_entry` scope widened** from the M10C commands to the M10D operator commands (Q17).
- **Rollback with an enabled module** (Q19): the M10A2 adoption rules do not consider modules; M10D is the first
  available module, so the behaviour is stated here instead of changing adoption.

## 27. Tech-debt interactions and inherited open items (unchanged unless stated)

- **#15** (privacy / raw retention): restricted extension values are not stored; capture refuses sensitive fields.
  Unchanged.
- **#65** (integrity worker job): the eight new checks run from the CLI only. Unchanged.
- **#71** (no production evidence relations / module kinds): `custom_record` becomes the first module-owned entity kind
  (`EVIDENCE_KIND_MODULES` gains `custom_record → extension`, so the writer's module gate is exercised for the first
  time); still no production relation. Partially addressed.
- **#72** (migration suite timeout): M10D migration cases go in `migrations-m10d.int.spec.ts`. Not worsened.
- **#76** (no issue for source vs human affiliation disagreement): not fixed for affiliations; M10D's extension override
  records `extension_human_override_disagrees` from the start, so the gap is not repeated.
- **#79** (operator reason is a code token): M10D operator commands use the same code-token reason. Unchanged.
- **#49** (sensitive-name substring matches): capture refusal reuses the detector and inherits its false positives
  (conservative: a falsely flagged field is refused, never stored). Unchanged.
- **#74, #75, #77, #78, #80, #81** (M10C deferrals): untouched by M10D.
- Authenticated operator identity (M15): assurance stays `asserted`. Live Chargebee mutations M09/M10 not run;
  Chargebee incremental sync disabled; live Sugar verification pending.

## 28. Baseline at plan time (2026-10-15)

- Documentation-only change: this plan, the README status row and the delivery-plan status line. No code, schema or
  migration change.
- `prettier --check` on the changed files; the CI run on the PR head is the evidence. Code baseline: `integration`
  at `ce9b052` (M10C merge, PR #32).
