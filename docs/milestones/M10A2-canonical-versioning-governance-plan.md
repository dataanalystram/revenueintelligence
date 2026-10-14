# Milestone 10A2 — Canonical Versioning & Governance Foundation: implementation plan

- Status: **PROPOSED PLAN (2026-10-14), awaiting owner approval.** No schema, migration or code change has been
  made for M10A2. Implementation starts only after approval, on a fresh branch, following `BUILD → TEST → VERIFY →
MUTATION PROOF → FRESH CLONE → RUNTIME → DOCKER → INDEPENDENT REVIEW → USER APPROVAL → MERGE`.
- Every open question (§22) carries a **recommended default**. Owner instruction of 2026-10-14: the defaults are
  what implementation proceeds with **unless the owner overrides them**; each one is marked `DEFAULT`.
- Parent: [M10 plan](M10-canonical-architecture-implementation-plan.md) (approved, revision 3: D1–D6, F1–F5), §7,
  §10, §12, §14, §15 (M10A2), §16, §17, §18. Predecessor: [M10A1](M10A1-security-foundation.md) (closed; ADR 0026).
- Base: `main` after the M10A1 closure record (`e6ea612`). Integration branch for the M10 sequence: `integration`
  (owner instruction 2026-10-14); `main` stays untouched until the owner merges.
- Two acceptance sections apply: `Canonical / business correctness` (§17) and `Security & Data Governance` (§18).
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made. M10A2 builds technical foundations only.
- Canonical version after M10A2: **`0.1` (baseline recorded)**. M10A2 adds platform governance structure, not
  canonical business structure, so it publishes no new MINOR (M10 plan §15.0).
- ADR: following the M10A1 pattern (ADR 0026 was written during implementation, not at plan stage), **no ADR is
  drafted with this plan**. ADR 0027 (canonical versioning, module enablement, governed registries, entity index,
  value history, mapping lifecycle) is written during implementation.

## 0. What exists today (`IMPLEMENTED TODAY`, from inspection of `main` `e6ea612`)

| Area                       | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canonical version          | **None.** The schema evolves by migration + ADR. No `canonical_version` anywhere; no adoption record (E6 §1 "not present").                                                                                                                                                                                                                                                                                                                                  |
| Modules                    | **None.** `tenant_flow_settings` (per-tenant flow mode, `version` for optimistic concurrency) is the only per-tenant setting precedent; it has no history table.                                                                                                                                                                                                                                                                                             |
| Registries                 | **None** generic. Versioned-document precedents: `tenant_product_models` (immutable, `content_hash`, `published_by`), `tenant_source_mapping_versions` and `tenant_source_authority_versions` (immutable, `base_version`, advisory-lock serialised publish, ADR 0020 §11).                                                                                                                                                                                    |
| Mapping lifecycle          | Only **published** versions exist. "Current" = highest version per connection (`SourcesRepository.latestMapping`, used by sync, report, snapshot capture and authority checks). Drafts live in files; validation exists but its result is not stored. No `superseded` / `retired` state.                                                                                                                                                                   |
| Change record              | `tenant_context_changes`: entity kind CHECK `company` / `person` / `subscription`; change type CHECK `created`, `updated`, `state_changed`, `merged`, `ref_added`, `relationship_changed`; cause CHECK `webhook`, `backfill`, `reconciliation`, `replay`, `resync`, `import`; changed field **names** only; source triple; connection + mapping version (M8); actor kind/id/assurance (M10A1, NULL before). Append-only for `lip_app` (privilege + trigger, M10A1 Q4). |
| Value history              | **None.** The classification manifest (M10A1) already records a `history` policy per column (`full` / `value_free` / `none`); today **no column is `full`**, eight are `value_free` (e.g. `companies.name`), the rest `none`.                                                                                                                                                                                                                                 |
| Polymorphic references     | **None** yet. Every FK between tenant tables includes `tenant_id` (schema guard). `companies` / `persons`: PK `id`, unique `(tenant_id, id)`; `tenant_products`: PK `(tenant_id, key)`; `tenant_subscriptions`: id with tenant-scoped keys.                                                                                                                                                                                                                  |
| Physical deletes           | `PrismaCompanyRepository.delete` / `PrismaPersonRepository.delete` exist (M2 identity repositories; company delete refused while persons reference it). Canonical ingestion state-changes records instead of deleting.                                                                                                                                                                                                                                      |
| Security (M10A1)           | `SecurityActor`; closed catalogue of 22 capabilities, `POLICY_VERSION = 1`; `WriteAuthorizer` → `AuthorizedContext<C>` (branded; dependency-cruiser rule); S2 static test over 20 services; `tenant_audit_events` hash chain (fail closed; denials in own transaction; `failed` via `@AuditFailures`); closed `AUDIT_ACTIONS` / reason codes / target kinds with DB CHECKs equal to the code (schema guard); security events catalogue.                         |
| Manifests (M10A1)          | `PRIVILEGE_MANIFEST` (exact per-table matrix, schema guard S9); `CLASSIFICATION_MANIFEST` (every column, floors, `tbc` with reason/owner; S10); `SECURITY_DEFINER_FUNCTIONS = ['app_route_oauth_account']` (owned by NOLOGIN `lip_webhook_router`); data-subject map from `subject` links. Schema guard treats `tenants` and `connector_kinds` as platform tables; `connector_kinds` is read-only for `lip_app`, RLS forced with a `USING (true)` read policy and a "DB equals code catalogue" test. |
| Retention                  | `RETENTION_CLASSES` and `RETENTION_DEFAULTS` (code); `AUDIT_PURGE_EXECUTION_APPROVED = false`; `RetentionPolicyProvider` returns platform defaults — M10A1 deferred "tenant data policy drives retention" to M10A2.                                                                                                                                                                                                                                           |
| Migration conventions      | One Prisma migration per concern plus a dev/staging down-script in `prisma/rollback/` that refuses while data exists and restores the previous schema exactly; `migrations.int.spec.ts` tests up / rerun / down-refusal / exact restore / re-apply; backfills run before RLS is enabled on a new table (M8 pattern). Latest: `20261201120000_m10a1_security_foundation`.                                                                                     |

## 1. Scope

In scope (M10 plan §15 M10A2, refined by inspection):

1. **Canonical model versions** — `MAJOR.MINOR`, `0.x` during implementation (D1); `1.0` refused by the database.
2. **Tenant canonical adoption** — explicit, append-only, audited; baseline `0.1` for every existing tenant.
3. **Module enablement** — global catalogue, tenant current state, append-only history, separate from adoption (D5,
   F4, M10 §17).
4. **Governed versioned registries** — one generic store for `data_policy`, `signal_type`, `metric`, `action_type`,
   `context_type`, `extension` (immutable versions + a projection of current entries).
5. **Data policy** — the first registry kind with a full document schema; drives `RetentionPolicyProvider` and the
   restricted-history rule (F5, M10 §16.3).
6. **Tenant entity index** — the polymorphic reference anchor (D2, F2, M10 §18), maintained only by triggers.
7. **Value history** — one append-only table, written by single writers in the same transaction, with
   restricted-history suppression (M10 §10, control 12).
8. **Richer change records** — origin, derivation, canonical version, schema snapshot hash, transforms; widened
   change-type and cause CHECKs (E5 §3).
9. **Mapping lifecycle** — `draft → validated → published → superseded → retired`; published content immutable
   (E6 §4).
10. **Integrity verification** — per-tenant, read-only verification with recorded runs and security events (M10
    §18 layer 3).
11. **Security integration** — new capabilities (policy v2), audit actions, reason codes, security events, manifest
    entries, schema-guard extensions.

Out of scope: any canonical business entity (M10B onward); generic source references and evidence links (M10B);
document schemas for `signal_type` / `metric` / `action_type` / `context_type` / `extension` (their sub-milestones:
G, J, I, E, D); the canonical migration framework, migration runs and `migration.execute` (M10M); authenticated
users and roles (M15); export/erasure features; enabling audit purge execution (tech debt #15); publishing canonical
`0.2` or later; scheduled (automatic) integrity runs (§22 Q17).

## 2. Canonical model versions

- **Global reference table `canonical_model_versions`** (platform table like `connector_kinds`; no tenant content):

  | Column              | Type / rule                                                                                                                 |
  | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
  | `version`           | text, PK; CHECK `^(0\|[1-9][0-9]{0,2})\.(0\|[1-9][0-9]{0,3})$`                                                               |
  | `major`, `minor`    | smallint NOT NULL; CHECK `version = major \|\| '.' \|\| minor`; unique `(major, minor)`                                        |
  | `status`            | `current` / `supported` / `deprecated` / `unsupported`; partial unique index: exactly one `current`                          |
  | `released_at`       | timestamptz                                                                                                                 |
  | `catalogue_hash`    | sha256 of the code catalogue of the version (entity kinds, module keys, change-record vocabulary) — ties DB row to code      |
  | `adr`               | text, the ADR that introduced the version (pattern-checked identifier, e.g. `0027`)                                          |

- **Freeze guard (D1):** named CHECK `canonical_model_versions_pre_freeze` = `major < 1`. Only a future freeze
  migration with its ADR may drop it. A test inserts `1.0` as the owner and expects the CHECK by name.
- **Seed:** `0.1`, `current`, `adr = '0027'`. M10A2 publishes nothing else.
- **Ordering:** always numeric `(major, minor)`, never lexical (`0.10 > 0.9`); domain helper `compareCanonicalVersion`
  plus a property test.
- **Code catalogue** `CANONICAL_VERSIONS` (`domain/canonical/versions.ts`, pure) equals the table (schema-guard test,
  same pattern as connector kinds). App role: `SELECT` only.
- **Compatibility fields used from now on:** `canonical_version_min` on registry versions and mapping versions (the
  version they were validated against, E6 §3); `canonical_version` on change records (the version the write conformed
  to).

## 3. Tenant canonical adoption

- **`tenant_canonical_adoptions`** (tenant-owned, forced RLS, append-only by privilege **and** trigger):

  | Column                                      | Type / rule                                                                                       |
  | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
  | `tenant_id`, `id`                           | PK `(tenant_id, id)`                                                                              |
  | `seq`                                       | int; unique `(tenant_id, seq)`; dense per tenant (assigned under a per-tenant advisory lock)      |
  | `version`                                   | FK → `canonical_model_versions(version)`                                                          |
  | `previous_version`                          | nullable FK; NULL only for `seq = 1`                                                              |
  | `reason`                                    | closed: `baseline` / `new_tenant` / `operator_adoption` / `rollback`                              |
  | `adopted_at`                                | timestamptz                                                                                       |
  | `actor_kind`, `actor_id`, `actor_assurance` | as M10A1 (CHECKs reused)                                                                          |
  | `correlation_id`                            | uuid                                                                                              |
  | `audit_event_id`                            | FK `(tenant_id, audit_event_id)` → `tenant_audit_events`; NULL **only** when `reason = 'baseline'` |
  | `migration_run_id`                          | uuid NULL, reserved for M10M (no FK until that table exists)                                      |

- **Current version** = row with the highest `seq`. A read helper `CanonicalVersionReader.current(tx)` is used by
  writers (cached per transaction).
- **Adoption is explicit (Q2):** `CanonicalAdoptionService.adopt(AuthorizedContext<'config.canonical.adopt'>,
target, expectedCurrent)`; CLI `canonical adopt --tenant <slug> --version 0.x --expected-current 0.y [--execute]
--actor <id>`. Dry run reports the impact (modules newly available, registries/mappings whose
  `canonical_version_min` is above the target) and changes nothing.
- **Rules:** target must exist and be `current` or `supported`; forward to any supported newer `0.x`; backward only to
  the immediately previous MINOR with reason `rollback` (Q3); stale `expectedCurrent` → `stale_base_version`; target
  `major ≥ 1` impossible (no such row can exist). Adoption **never** rewrites tenant data and **never** changes a
  module setting (and vice versa; test).
- **Baseline (migration, Q4):** one `baseline` row per existing tenant at `0.1`, actor `system` /
  `system:migration:m10a2` / `system`, no audit event (the hash chain is computed in application code; a migration
  must not forge chain entries). Integrity verification accepts a missing audit event only for `baseline` rows.
- **New tenants:** `TenantDatabase.provision` writes `seq 1` at the `current` version with reason `new_tenant`
  inside the provisioning transaction; the existing `tenant.provision` audit event covers it (its details gain
  `canonicalVersion`).
- **Superseded candidate text:** E6 §3 says MINOR versions are adopted automatically; the approved M10 plan §7 makes
  adoption explicit. M10A2 applies M10 §7 and records candidate revision **R2** in E6 (adoption explicit for every
  version during `0.x`) — Q2.

## 4. Module enablement (M10 §17, D5, F4)

- **`canonical_modules`** (global, `SELECT` only for `lip_app`, equals the code catalogue `CANONICAL_MODULES`):
  `module_key` PK (closed CHECK), `title`, `available boolean`, `minimum_canonical_version` (FK, NULL while not
  available; CHECK `available = (minimum_canonical_version IS NOT NULL)`), `depends_on text[]` (each element a module
  key; validated by trigger and by the code-catalogue test), `config_schema_version int`.
- **Seed:** the nine keys `account_context`, `commercial`, `signals`, `opportunities`, `decision_chain`, `value`,
  `engagement`, `extension`, `data_quality`, **all `available = false`** (Q16). Each later sub-milestone's migration
  makes its module available at the MINOR it publishes. Core (Account, hierarchy, Person, affiliation, Product,
  Subscription line, references, provenance) is not a module.
- **`tenant_module_settings`** (tenant-owned): PK `(tenant_id, module_key)`, FK → `canonical_modules`; `enabled`,
  `config jsonb` (DB CHECKs: ≤ 4 KB, `NOT app_jsonb_has_secret_like_key(config)`; writer: per-module Zod schema +
  secret-like value scan), `version int` (optimistic concurrency), `updated_at`, `updated_by_kind`, `updated_by_id`,
  `updated_by_assurance`. Privileges `SELECT, INSERT, UPDATE` (no DELETE: F4 "never physically deletes").
- **`tenant_module_setting_events`** (append-only, privilege + trigger): `(tenant_id, id, seq, module_key,
from_enabled, to_enabled, from_config_hash, to_config_hash, base_version, actor_*, reason_code, occurred_at,
audit_event_id NOT NULL)`; unique `(tenant_id, module_key, seq)`.
- **Rules (M10 §17, unchanged):** base version required; enable needs `available`, adopted version ≥ minimum, and
  every `depends_on` enabled; disable refused while an enabled module depends on it; disable never deletes data,
  writers refuse with `module_disabled` (audited), re-enable needs no migration; mapping publication for a disabled
  module refused; each change writes one setting event **and** one audit event in the same transaction; all optional
  modules disabled for existing and new tenants.
- **Gate API for later writers:** `ModuleGate.require(tx, authCtx, moduleKey)` → throws `ModuleDisabledError`
  (audited `denied`, reason `module_disabled`). M10A2 delivers and tests it; first real caller is M10D/M10E.
- **Mapping hook:** the mapping validator receives the tenant's enabled module set and refuses entries whose target
  entity kind belongs to a disabled module (`module_disabled`); for already published versions the run records a
  governed gap. With no module entity kinds yet this is exercised by a unit test with a synthetic catalogue.

## 5. Governed versioned registries

- **`tenant_registry_versions`** (append-only, privilege + trigger): PK `(tenant_id, kind, version)`;
  `kind` closed CHECK = code catalogue (`data_policy`, `signal_type`, `metric`, `action_type`, `context_type`,
  `extension`); `base_version`; `document jsonb` (≤ 256 KB; `NOT app_jsonb_has_secret_like_key`);
  `document_schema_version int`; `content_hash` (sha256 of canonical JSON; unique `(tenant_id, kind, content_hash,
version)` not required — duplicates allowed but publish of identical content refused as `no_change`);
  `canonical_version_min` FK; `effective_from`; `published_at`; actor columns; `correlation_id`;
  `audit_event_id NOT NULL`.
- **`tenant_registry_entries`** (projection; `SELECT, INSERT, UPDATE`, no DELETE — X1 keys never disappear): PK
  `(tenant_id, id uuid)`; unique `(tenant_id, kind, key)`; `status` (`active` / `retired` / `promoted`);
  `definition jsonb`; `introduced_in`, `last_changed_in` (FKs to the version row); `sensitivity`, `categories`
  (F3 vocabulary, nullable for kinds that classify nothing, CHECK floors as in M10A1). Later tables FK to `(tenant_id,
id)` — the "projection as FK target" of M10 §2.
- **Publish** (`RegistryService.publish(AuthorizedContext<'config.registry.publish' | 'config.data_policy.publish'>,
kind, document, expectedBaseVersion, expectedContentHash)`): per-tenant-and-kind advisory lock; base version check
  (`stale_base_version`); document validated by the kind's schema; generic cross-version rules **R-X1** key never
  disappears, **R-X3** codes never disappear, **R-X4** a key's kind/target never changes, **R-K** keys match
  `^[a-z][a-z0-9_]{0,62}$`; secret-like scan of every string (A1 rule for configuration: refused, audited `denied`);
  `canonical_version_min` ≤ tenant's adopted version; version row + projection upsert + audit event in one
  transaction. **Human confirmation (Q11):** `expectedContentHash` must equal the hash shown by the dry run
  (`registry publish … ` without `--execute` prints it), so what is published is exactly what the operator reviewed.
- **Kinds available in M10A2 (Q8):** only `data_policy` has a document schema. Publishing any other kind is refused
  `registry_kind_not_available` until its sub-milestone registers the schema. Platform-generic definitions copied on
  adoption (M10 §14) arrive with those kinds.

## 6. Data policy (registry kind `data_policy`, F5)

- **Document v1** (Zod, `domain/canonical/data-policy.ts`, pure):

  ```
  { schema: 1,
    retention: { <retention class>: { days: int } },     // only classes whose default is `days`
    raw_retention: false,                                 // literal false; schema cannot express true
    value_history: { allow: [ { entity_kind, field, days } ] } }  // sensitive fields whose values may be kept
  ```

- **Rules:** classes whose product default is `disabled` (`raw_rejected_value`, `raw_communication_content`) cannot
  appear (structural); `sensitive_value_history` is enabled only through explicit `value_history.allow` entries, each
  naming a field present in the classification manifest and in the value-history field catalogue; day bounds (Q10)
  1–3650, `security_audit` ≥ 90; absent classes use the product default.
- **No invented rows:** no tenant gets a policy by migration. Absence = platform defaults (`RETENTION_DEFAULTS`).
- **Consumers:** `RetentionPolicyProvider` now resolves `published policy ?? defaults` per tenant (A1 deferral
  closed); the value-history writer reads `value_history.allow`. **Audit purge execution stays disabled**
  (`AUDIT_PURGE_EXECUTION_APPROVED = false`, tech debt #15) whatever the policy says (test).
- **Capability (Q9):** `config.data_policy.publish` (separate from `config.registry.publish`, so a later role model
  can give retention decisions to a data-protection role). The product defaults are not SOC 2, GDPR, HIPAA or legal
  retention claims.

## 7. Tenant entity index (D2, F2, M10 §18)

- **`tenant_entity_index`**: `(tenant_id, kind, entity_id uuid NULL, entity_key text NULL, created_at)`; `kind`
  closed CHECK = code catalogue `ENTITY_INDEX_KINDS`; CHECK `(entity_key IS NOT NULL) = (kind = 'product')` and
  exactly one of `entity_id` / `entity_key`; unique `(tenant_id, kind, entity_id)` and `(tenant_id, kind,
entity_key)`; forced RLS (`tenant_id = app_current_tenant()`); tenant-id immutability trigger.
- **Kinds in M10A2 (Q12):** `company` (`companies.id`), `person` (`persons.id`), `product` (`tenant_products.key`, D3),
  `subscription` (`tenant_subscriptions.id`). Later MINOR migrations extend the CHECK and attach triggers.
- **Maintained only by triggers:** `AFTER INSERT` → `app_entity_index_add()`; `BEFORE DELETE` →
  `app_entity_index_remove()`; `BEFORE UPDATE OF id / key` → refused (identity columns of indexed tables are
  immutable). Functions: `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, copying `NEW.tenant_id`, owned by
  a **dedicated NOLOGIN role `lip_entity_indexer`** (Q13; `NOSUPERUSER NOBYPASSRLS NOINHERIT`, `SELECT, INSERT,
DELETE` on the index only, a tenant-scoped RLS policy for that role, `lip_app` cannot become it) — the same pattern
  as `lip_webhook_router`. Added to `SECURITY_DEFINER_FUNCTIONS`.
- **`lip_app` holds `SELECT` only** on the index (privilege manifest). It cannot forge, move or remove entries;
  disabling triggers needs ownership.
- **Backfill:** in the migration, before RLS is enabled on the index: one row per existing company, person, product
  and subscription; counts asserted equal per tenant and kind inside the migration (`RAISE EXCEPTION` on mismatch, the
  M9A parity-check pattern).
- **Consumers in M10A2:** value history (§8) is the first polymorphic column set; M10B onward add evidence links,
  source references, extension targets, etc. Every polymorphic column set gets two composite FKs `(tenant_id,
x_kind, x_id)` / `(tenant_id, x_kind, x_key)` → index, `ON DELETE RESTRICT`, plus an exactly-one-of CHECK.
  Single-kind relations keep ordinary composite FKs (F2).
- **Schema guard additions:** every table named in `ENTITY_INDEX_KINDS` has the three triggers; no column set named
  `*_kind` + `*_id` exists without both FKs; the index kind CHECK equals the code catalogue.

## 8. Value history

- **`tenant_value_history`** (append-only, privilege + trigger): `(tenant_id, id, entity_kind, entity_id, entity_key,
field, values_recorded boolean, old_value jsonb, new_value jsonb, effective_at, recorded_at, change_id,
retention_class, policy_version NULL, actor_*)`; FK `(tenant_id, change_id)` → `tenant_context_changes`; composite
  FKs to the entity index (`ON DELETE RESTRICT`, Q15); CHECK `values_recorded OR (old_value IS NULL AND new_value IS
NULL)`; CHECK `policy_version IS NULL OR values_recorded`; values ≤ 4 KB each; `field` in a closed per-kind
  catalogue (code + CHECK). Index `(tenant_id, entity_kind, entity_id, effective_at)`.
- **Writer helper** `ValueHistoryRecorder.record(tx, authCtx, changes[])`, called by the single writer in the same
  transaction as the projection update and change record. Decision per field:
  1. field not in the value-history catalogue → nothing;
  2. column classified `sensitive` (sensitivity `restricted` or `tbc`, or a category in `personal`, `communication`,
     `security`) and not allowed by the published data policy → **value-free row** (`values_recorded = false`; field,
     actor, time, change id kept);
  3. otherwise → full row (`retention_class = canonical_lifecycle`; for policy-allowed sensitive fields,
     `sensitive_value_history` and `policy_version` set).
- **Initial fields (Q14):** `company.name`, `company.customer_status`; `subscription.state`, `starts_at`, `ends_at`,
  `product_key`, `quantity`. Their manifest `history` changes to `full` (`companies.name` from `value_free`: it is
  `internal` / `commercial`, not sensitive under F3). Persons: none in M10A2 (all personal). M10C adds
  `parent_account_id`, later sub-milestones their own fields.
- **Writers wired in M10A2:** `ContextIngestionService` (company) and `SubscriptionIngestionService` /
  `SubscriptionImportService` (lines). Canonical results unchanged; only history rows are added (regression test).

## 9. Richer change records (E5 §3)

- **New nullable columns on `tenant_context_changes`:** `origin` (`source_provided` / `deterministic` /
  `ai_derived` / `human` / `migration`), `derivation jsonb` (`{key, version, inputs_hash}`; CHECK required iff origin
  in `deterministic`, `ai_derived`), `canonical_version` (FK → `canonical_model_versions`), `schema_snapshot_hash`
  (64 hex), `transforms text[]` (closed format `field:transform_id`, transform ids from the ADR 0020 closed set).
- **Widened CHECKs (Q18):** change type + `retired`, `reactivated`, `promoted`, `migrated`, `superseded`,
  `retracted`; cause + `migration`, `derivation`, `human`, `ai`. Entity kind is widened by each sub-milestone with its
  entity (unchanged in M10A2).
- **Existing writers fill them** for every new row: sync/webhook/reconciliation/import → `origin =
source_provided`; `canonical_version` from the adoption reader (Q19: missing adoption → fail closed,
  `canonical_version_unknown`); `schema_snapshot_hash` from the mapping version for versioned connections;
  `transforms` from the mapping engine's applied-transform trace (names only). Pre-M10A2 rows keep NULL (no invented
  backfill). The table stays append-only.

## 10. Mapping lifecycle (E6 §4)

- **Published content stays immutable** (M10A1 privileges + M8 trigger; unchanged). Because version rows cannot be
  updated, state is **not** a mutable column on them (Q5 — deviation from the M10 plan §3 wording, same intent):
  - **`tenant_source_mapping_drafts`** (mutable working copies; DML): `(tenant_id, connection_id, id, state draft |
validated, document, content_hash, version int, validated_snapshot_hash, validated_authority_version,
validated_canonical_version, validation jsonb (codes + counts), updated_by_*, updated_at)`. Any edit returns
    the draft to `draft` (trigger clears the validation stamp when `document` changes). Secret-like scan on save.
  - **`tenant_source_mapping_lifecycle`** (append-only, privilege + trigger): `(tenant_id, connection_id, version,
seq, state published | superseded | retired, occurred_at, actor_*, reason_code, audit_event_id)`; FK to the
    version row. A `BEFORE INSERT` trigger enforces legal transitions (`∅ → published`, `published → superseded |
retired`, `superseded → retired`; nothing from `retired`) and at most one `published` per connection (under the
    existing per-connection advisory lock; integrity verification re-checks).
  - **`tenant_source_mapping_states`** — security-invoker view: current state per version.
  - **`tenant_source_mapping_versions.canonical_version_min`** — new nullable column (Q7: NULL on pre-M10A2 rows,
    interpreted as `0.1`; no UPDATE of immutable rows).
- **Transitions:** `draft → validated` (validate against latest snapshot, current authority, adopted canonical
  version; stores the stamp); `validated → published` (draft content hash and stamp still current, else
  `mapping_not_validated`); publishing writes the version row, the new version's `published` event and the previous
  version's `superseded` event in one transaction with one audit event; `retire` (capability
  `config.mapping.retire`; reasons `connection_disabled`, `canonical_version_unsupported`, `operator_retired`).
- **Compatibility (Q6):** `sources mapping publish --file … --execute` keeps working as "validate + publish" in one
  transaction (no draft row; same checks), so runtime scripts, fixtures and docs stay valid.
- **Consumers:** `latestMapping` is replaced by `publishedMapping` in sync, report, snapshot capture and authority
  checks; a connection whose latest version is retired has **no** published mapping → sync refused
  `no_published_mapping`.
- **Backfill:** per connection, the highest version gets `published`, earlier ones `superseded` (deterministic;
  actor `system:migration:m10a2`; counts asserted in the migration).

## 11. Integrity verification (M10 §18 layer 3)

- **`tenant_integrity_runs`** (append-only; one row per completed run): `(tenant_id, id, started_at, finished_at,
outcome passed | findings | failed, checks jsonb (check code → counts), findings jsonb (codes + identifiers, ≤ 16
KB, capped list), actor_*, correlation_id, audit_event_id)`.
- **Checks in M10A2:** entity index ↔ entity tables both directions, per kind (no orphan, no missing row, tenant
  equality); value history rows have index rows; adoption chain dense, versions exist, only `baseline` rows without
  audit events; module settings equal the last setting event; registry projection keys equal the union of version
  keys (X1) and point at existing versions; at most one published mapping per connection and state chains legal;
  privilege manifest and SECURITY DEFINER allow-list (reusing `PrivilegeManifestCheck`); optionally the audit chain
  (reusing `audit-verify`).
- **Execution:** `security integrity-verify --tenant <slug> [--execute] --actor <id>` (capability
  `security.integrity.run`; dry run = read-only report, `--execute` also records the run) and a worker job processor
  enqueued by the CLI. Per tenant, batched, read-only on canonical data; never across tenants. Any finding → non-zero
  exit, security event `integrity_violation_detected` (codes only). **Never auto-repaired** (forward-fix only).
  Automatic schedule: configurable, **off by default** until M10M (Q17).

## 12. Building on M10A1 security

| M10A1 primitive                         | Use in M10A2                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthorizedContext<C>` / S2 static test | every new service write takes its typed context: `CanonicalAdoptionService`, `ModuleSettingsService`, `RegistryService`, `MappingDraftService`, `SourceMappingsService.retire`, `IntegrityVerificationService.record`; S2 list extended     |
| Policy (`POLICY_VERSION` 1 → **2**)     | new capabilities (§13); exhaustive S1 test updated                                                                                                                                                                                          |
| Audit trail                             | one `allowed` event per operation in the same transaction; denials and `failed` via the existing mechanisms (`@AuditFailures`); new closed actions / reason codes / target kinds with DB CHECKs equal to the code                           |
| Append-only                             | adoptions, module setting events, registry versions, mapping lifecycle, value history, integrity runs: `SELECT, INSERT` + `app_refuse_change` trigger                                                                                       |
| Privilege manifest                      | every new table entered; index `SELECT` only; global tables `SELECT` only                                                                                                                                                                   |
| Classification manifest                 | every new column classified (floors; no `tbc` expected except new operator-id columns, which reuse the M10A1 `OPERATOR_ID_TBC` reason); value-history value columns `confidential`, categories `commercial`, `financial`, `personal`, subject link `person`/`erase` (data-subject map) |
| Secret-like refusal                     | module config, registry documents, mapping drafts (refused, audited `denied`)                                                                                                                                                               |
| Security events                         | new codes `integrity_violation_detected`, `integrity_run_completed`, `module_disabled_write_refused`                                                                                                                                        |
| RLS / tenant isolation                  | every new tenant table: `tenant_id` first, forced RLS, tenant-scoped keys, composite FKs, tenant-id immutability trigger; global tables in the schema guard's platform list with read-only policies                                         |
| Retention                               | `RetentionPolicyProvider` reads the data policy; purge execution still disabled                                                                                                                                                            |

## 13. Permissions (policy v2)

| Capability                    | Covers                                                    | Granted to (v2) |
| ----------------------------- | --------------------------------------------------------- | --------------- |
| `config.canonical.adopt`      | canonical adoption (incl. rollback)                       | `operator`      |
| `config.module.change`        | module enable / disable / configure                       | `operator`      |
| `config.registry.publish`     | registry publish (all kinds except `data_policy`)         | `operator`      |
| `config.data_policy.publish`  | data policy publish                                       | `operator`      |
| `config.mapping.draft`        | mapping draft save / validate / discard                   | `operator`      |
| `config.mapping.retire`       | mapping version retire                                    | `operator`      |
| `security.integrity.run`      | integrity verification (record a run)                     | `operator`, `system` |

- `config.mapping.publish` keeps covering publish. `migration.execute` stays out (M10M). `human_user` / `ai` still
  hold nothing. Provisioning keeps `config.tenant.provision` (it writes the `new_tenant` adoption).
- **Audit actions added:** `canonical.adopt`, `module.enable`, `module.disable`, `module.configure`,
  `registry.publish`, `data_policy.publish`, `mapping.draft.save`, `mapping.draft.validate`, `mapping.draft.discard`,
  `mapping.retire`, `integrity.verify`. **Reason codes added:** `module_not_available`, `module_dependency_missing`,
  `module_required_by_other`, `module_disabled`, `canonical_version_too_low`, `canonical_version_not_supported`,
  `canonical_version_unknown`, `registry_kind_not_available`, `registry_rule_violation`, `expected_hash_mismatch`,
  `mapping_not_validated`, `no_published_mapping`, `no_change`. **Target kinds added:** `canonical_version`,
  `module`, `registry`, `data_policy`, `mapping_draft`, `integrity_run`.

## 14. Migrations

Two forward migrations (M10 §5 allows two), each with a down-script and the standard migration tests:

1. **`20261215120000_m10a2_canonical_versions_modules_registries`**: `canonical_model_versions` (+ seed `0.1`,
   freeze CHECK), `tenant_canonical_adoptions` (+ baseline backfill, count asserted), `canonical_modules` (+ seed,
   all unavailable), `tenant_module_settings`, `tenant_module_setting_events`, `tenant_registry_versions`,
   `tenant_registry_entries`; widened audit CHECKs; privileges.
2. **`20261215130000_m10a2_entity_index_history_lifecycle_integrity`**: role `lip_entity_indexer`, functions,
   `tenant_entity_index` (+ backfill before RLS, counts asserted), triggers on `companies`, `persons`,
   `tenant_products`, `tenant_subscriptions`; `tenant_value_history`; change-record columns and widened CHECKs;
   `tenant_source_mapping_drafts`, `tenant_source_mapping_lifecycle` (+ backfill), `tenant_source_mapping_states`
   view, `canonical_version_min` column; `tenant_integrity_runs`; privileges.

- Additive only: new tables, nullable columns, widened CHECKs, triggers, a NOLOGIN role, REVOKE/GRANT only on new
  objects. No column or table renamed or dropped; no existing row rewritten (backfills insert into new tables only).
- **Down-scripts** (dev/staging): refuse while any non-backfill row exists (operator adoptions, module settings,
  registry versions, value history, drafts, non-backfill lifecycle events, integrity runs, change records with the
  new columns set); otherwise restore the M10A1 schema and privilege matrix exactly and drop the role. Prisma schema
  updated; the drift test stays green.

## 15. Backward compatibility

- Existing ingestion, CLIs, mappings, authority, product models, eligibility, coverage and snapshots behave exactly
  as before, except: change records carry the new columns; value history rows appear for the seven fields; mapping
  "current" is read through the lifecycle (identical result after the backfill).
- All modules disabled ⇒ zero behavioural change (regression suite).
- `sources mapping publish --file` unchanged for callers (Q6). Runtime scripts gain new checks; none removed.
- Existing physical-delete paths (M2 identity repositories): deleting a company/person/subscription removes its index
  row; a delete is refused (`RESTRICT`) only when value history references it. Inspection before implementation;
  **if a legitimate path breaks, work stops and it is reported** (the M10A1 Q4 pattern).

## 16. Tenant isolation (M10 §14)

- New tenant tables: `tenant_id` first in every key, forced RLS, composite FKs, tenant-id immutability trigger;
  schema guard covers them automatically.
- Global tables `canonical_model_versions`, `canonical_modules`: no tenant content; `SELECT` only for `lip_app`;
  added to the guard's platform-table list with a read-only-for-app assertion.
- Adversarial tests as the app role with raw SQL, bypassing writers: tenant B cannot read, insert, reference or
  publish over tenant A's adoptions, module settings, registry versions/entries, value history, drafts, lifecycle,
  integrity runs; a value-history row in tenant A referencing a tenant-B entity (by id and by product key) is refused
  by the FK; direct DML on the index is `permission denied`.

## 17. Acceptance — Canonical / business correctness

- `0.1` recorded as every existing tenant's baseline; new tenants adopt the current version at provisioning.
- Version ordering numeric; adoption forward/rollback rules; adoption never changes modules or data.
- Module enable/disable rules of M10 §17 (via a test-only availability toggle, Q16); disabled ⇒ zero behavioural
  change.
- Registry publish rules (base version, hash confirmation, X1/X3/X4/K, kind availability); data policy schema;
  `RetentionPolicyProvider` resolution.
- Mapping lifecycle transitions; published content never mutated; backfilled states equal "latest wins"; retired
  mapping ⇒ sync refused; legacy publish path unchanged.
- Change records carry origin, canonical version, snapshot hash, transforms; value history recorded for the seven
  fields in the same transaction; identical canonical results on the Sugar and Chargebee fakes (regression); full
  M6–M10A1 suites unchanged.
- Migrations: up / rerun / down-refusal / exact restore / re-apply.

## 18. Acceptance — Security & Data Governance

- `1.0` refused by the database (named CHECK).
- Every adoption, module change, registry/data-policy publish, mapping draft/validate/publish/retire and recorded
  integrity run is authorized through `AuthorizedContext` and writes exactly one `allowed` audit event in its
  transaction; denials and failures recorded as in M10A1.
- Adoptions, module events, registry versions, lifecycle events, value history and integrity runs immutable for the
  app role (privilege + trigger); privilege matrix equals the manifest; classification manifest covers every new
  column.
- Entity index unwritable by the app role; triggers `SECURITY DEFINER` with fixed `search_path`, owned by
  `lip_entity_indexer`, in the allow-list; cross-tenant polymorphic references impossible with raw SQL.
- Restricted history enforced: a sensitive field produces a value-free row unless the data policy allows it.
- Secret-like values refused in module config, registry documents and mapping drafts.
- Integrity verification finds a planted orphan and a planted tenant mismatch and raises a security event.
- No compliance claim in code, docs or the record.

## 19. Tests and mutation proofs

| #   | Test                                                                                                                       | Level                    |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| V1  | version label/regex, numeric ordering (`0.10 > 0.9`), catalogue equals table                                               | unit (property) + guard  |
| V2  | owner insert of `1.0` refused by `canonical_model_versions_pre_freeze`                                                     | integration              |
| V3  | baseline: one `0.1` row per existing tenant, counts equal; new tenant gets `new_tenant` row                                | integration (migration)  |
| V4  | adoption: forward, rollback to previous MINOR only, stale expected-current, unsupported target; one audit event; dry run writes nothing | integration   |
| V5  | adoption and module settings independent (each unchanged by the other)                                                     | integration              |
| V6  | modules: enable/disable round trip, base-version conflict, dependency, required-by, minimum version, not available; one setting event + one audit event | integration |
| V7  | `ModuleGate`: disabled ⇒ refusal audited `denied` (`module_disabled`); disabled ⇒ zero behaviour change (regression)       | integration              |
| V8  | registry: base version, expected hash, X1/X3/X4/K rules, unavailable kinds refused, projection consistent                   | unit (property) + integration |
| V9  | data policy: schema (no raw retention, no disabled classes, bounds), provider resolution, purge still disabled             | unit + integration       |
| V10 | entity index: backfill counts; insert/delete keep it consistent; identity update refused; app-role DML denied             | integration              |
| V11 | adversarial cross-tenant value history (id and product key) refused by FK; all new tables isolated                         | integration (adversarial)|
| V12 | value history: same transaction (rollback removes both); seven fields recorded; sensitive field value-free; policy allow → values | integration       |
| V13 | scan: no value of a sensitive field in `tenant_value_history` across the fakes                                             | integration              |
| V14 | change records: new columns filled for every new row; NULL on old rows; missing adoption ⇒ fail closed                     | integration              |
| V15 | mapping lifecycle: draft → validated → published → superseded → retired; edit returns to draft; illegal transitions refused by trigger; one published per connection; retired ⇒ sync refused; legacy publish path | integration |
| V16 | lifecycle backfill equals "latest wins" on M10A1-state data                                                                | integration (migration)  |
| V17 | integrity: clean tenant passes; planted orphan, missing index row and tenant mismatch (owner, test DB) detected; event emitted; nothing repaired | integration |
| V18 | secret-like refusal in module config, registry documents, drafts                                                           | integration              |
| V19 | S1/S2 extended (policy v2 exhaustive; new write methods take `AuthorizedContext`)                                          | unit                     |
| V20 | schema guard: privilege matrix, classification, definer allow-list, `lip_entity_indexer` powerless, index triggers present, polymorphic FKs present, audit/kind CHECKs equal code | integration |
| V21 | regression: identical canonical results on Sugar/Chargebee fakes; M6–M10A1 suites unchanged                                | integration              |
| V22 | migrations up / rerun / down-refusal / exact restore / re-apply (both)                                                     | integration              |
| V23 | runtime `86-canonical-governance.sh`: adopt dry run, module refusal (not available), data-policy publish with hash, draft → publish → retire → sync refused, integrity run clean, no values in logs | runtime |

Mutation proofs (break → named test fails for that reason → restore → green; harness refuses a dirty tree, M10A1
lesson):

| #    | Mutation                                                                | Must fail      |
| ---- | ----------------------------------------------------------------------- | -------------- |
| VM1  | drop the pre-freeze CHECK                                               | V2             |
| VM2  | lexical version comparison                                              | V1             |
| VM3  | adoption without its audit event                                        | V4             |
| VM4  | `GRANT UPDATE ON tenant_canonical_adoptions TO lip_app`                 | V20, append-only test |
| VM5  | module change skips the setting event                                   | V6             |
| VM6  | remove the module dependency rule                                       | V6             |
| VM7  | remove the check from `ModuleGate`                                      | V7             |
| VM8  | disable registry rule X1                                                | V8             |
| VM9  | skip the expected-hash comparison                                       | V8             |
| VM10 | data policy accepts `raw_retention: true`                               | V9             |
| VM11 | drop an entity-index trigger                                            | V10, V17       |
| VM12 | `GRANT INSERT ON tenant_entity_index TO lip_app`                        | V10, V20       |
| VM13 | drop the value-history → index composite FK                             | V11            |
| VM14 | disable writer validation only (positive control: database still refuses) | V11 stays green |
| VM15 | remove restricted-history suppression                                   | V12, V13       |
| VM16 | writer leaves `canonical_version` NULL                                  | V14            |
| VM17 | remove the lifecycle transition trigger                                 | V15            |
| VM18 | sync reads the latest version instead of the published one              | V15            |
| VM19 | integrity check ignores tenant equality                                 | V17            |
| VM20 | grant `config.canonical.adopt` to `source_sync`                         | V19 (S1)       |
| VM21 | remove the identity-update refusal trigger                              | V10            |
| VM22 | widen the index kind CHECK in the database only                         | V20            |

## 20. Verification and evidence plan

- `pnpm verify` (format, lint, typecheck, dependency-cruiser, unit, integration with Testcontainers as the app role).
- `pnpm verify:runtime` with the new `86-canonical-governance.sh`; all existing scripts green.
- `pnpm verify:docker` (images unchanged apart from code; migrate image applies both migrations).
- Live: Chargebee TEST-site read-only regression with the two approved secrets if available (canonical results
  identical; change records carry the new columns); otherwise recorded as not run. Live Sugar stays pending.
- Mutation proofs VM1–VM22 recorded with the failing output.
- **Fresh-clone run** before reporting completion. Independent review (`review-milestone`), PR to `integration`,
  CI green, merge only on approval.
- Record `docs/milestones/M10A2-canonical-versioning-governance.md`; ADR 0027; candidate revision R2 in E6
  (explicit adoption) and the mapping-lifecycle storage note.

## 21. Risks

| Risk                                                                                         | Mitigation                                                                                                     |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Scope is the largest M10 sub-milestone (11 areas, ~11 tables)                                 | two migrations by concern; Q1 offers a split into A2a/A2b; evidence per area                                   |
| Entity-index triggers add one insert per entity write and a delete hook                       | narrow table; single index probes; measured on the fakes; partitioning deferred                                |
| `RESTRICT` from value history breaks an existing physical-delete path                         | inspection first; stop and report (Q15)                                                                        |
| Replacing `latestMapping` touches sync, report, snapshots, authority                          | one repository method; backfill makes results identical; V15/V16/V21                                           |
| SECURITY DEFINER functions widen the attack surface                                           | dedicated powerless role, fixed `search_path`, allow-list guard, VM11/VM12                                     |
| Change-record writers now depend on the adoption row                                          | baseline + provisioning guarantee it; fail closed; integrity check                                             |
| Audit volume and chain-lock contention grow (M10A1 m-e)                                       | new operations are configuration-rate, not per record; no per-record audit added                               |
| Module enablement cannot be exercised end to end before a module exists                       | test-only availability toggle in test databases (owner); production catalogue unchanged                        |
| Hidden scope creep into M10B (references/evidence)                                            | index consumers in A2 limited to value history; no reference/evidence tables                                   |

## 22. Open questions and decisions for the owner

Each answer marked `DEFAULT` is what implementation proceeds with unless the owner overrides it.

| #   | Question                                                                                     | Recommended answer (`DEFAULT`)                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | One sub-milestone or split?                                                                  | `DEFAULT` one sub-milestone, two migrations (§14), one PR. Split into A2a (versions/adoption/modules/registries/data policy) and A2b (index/history/change records/lifecycle/integrity) only if review finds the diff unreviewable. |
| Q2  | Adoption explicit or automatic for MINOR versions (E6 §3 vs M10 §7)?                         | `DEFAULT` explicit for every version during `0.x` (M10 §7, newer and approved); E6 §3 revised as candidate revision R2.                                                                                             |
| Q3  | Adoption direction                                                                            | `DEFAULT` forward to any `current`/`supported` newer `0.x`; backward only to the immediately previous MINOR with reason `rollback`; both audited.                                                                     |
| Q4  | Baseline adoption rows without audit events?                                                 | `DEFAULT` yes: migration writes `baseline` rows with actor `system:migration:m10a2` and no audit event (a migration must not forge hash-chain entries); integrity accepts this only for `baseline`.                  |
| Q5  | Mapping lifecycle storage (version rows are append-only since M10A1)                          | `DEFAULT` immutable version rows + append-only `tenant_source_mapping_lifecycle` + view + mutable `tenant_source_mapping_drafts`. Rejected: a mutable `lifecycle_state` column (would need a column-level UPDATE grant on an append-only table). |
| Q6  | Keep the legacy `publish --file` path?                                                        | `DEFAULT` yes, as validate + publish in one transaction with identical checks; drafts are optional.                                                                                                                 |
| Q7  | `canonical_version_min` on existing mapping versions                                          | `DEFAULT` NULL on pre-M10A2 rows, interpreted as `0.1`; no update of immutable rows.                                                                                                                                |
| Q8  | Registry kinds in M10A2                                                                       | `DEFAULT` all six in the kind CHECK; only `data_policy` has a document schema; others refused `registry_kind_not_available` until their sub-milestone.                                                              |
| Q9  | Separate capability for data policy?                                                         | `DEFAULT` yes: `config.data_policy.publish` (operator).                                                                                                                                                             |
| Q10 | Data-policy bounds                                                                            | `DEFAULT` 1–3650 days per `days` class, `security_audit` ≥ 90; disabled classes cannot be enabled; `raw_retention` literal `false`; no policy row invented (absence = product defaults).                            |
| Q11 | Human confirmation for registry/data-policy publish                                           | `DEFAULT` `--expected-hash` equal to the content hash printed by the dry run, plus base version.                                                                                                                    |
| Q12 | Entity-index kinds in M10A2                                                                   | `DEFAULT` `company`, `person`, `product` (by key), **and `subscription`** (lines are evidence targets in E5 §3).                                                                                                    |
| Q13 | Owner of the SECURITY DEFINER index functions                                                 | `DEFAULT` dedicated NOLOGIN `lip_entity_indexer` with rights on the index only (the `lip_webhook_router` pattern), not the schema owner.                                                                             |
| Q14 | Which fields get value history in M10A2?                                                      | `DEFAULT` `company.name`, `company.customer_status`, `subscription.state`, `starts_at`, `ends_at`, `product_key`, `quantity`; their manifest history becomes `full`; no person fields.                              |
| Q15 | Value history anchored in the index with `ON DELETE RESTRICT`?                                | `DEFAULT` yes; an entity with history cannot be physically deleted; inspect existing delete paths first and stop and report if a legitimate one breaks.                                                             |
| Q16 | How to test module enablement with no module available                                        | `DEFAULT` seed all nine unavailable; tests make one available through an owner-only toggle in the test database; no permanent test module in the catalogue.                                                        |
| Q17 | Integrity verification scheduling                                                             | `DEFAULT` CLI + worker job now; automatic schedule configurable and off until M10M; findings never auto-repaired.                                                                                                   |
| Q18 | Change-record CHECK widening                                                                  | `DEFAULT` widen change type and cause to the full E5 sets now; widen entity kind per sub-milestone with its entity.                                                                                                |
| Q19 | Writers when a tenant has no adoption row                                                     | `DEFAULT` fail closed (`canonical_version_unknown`); baseline and provisioning make it impossible in normal operation.                                                                                              |
| Q20 | Capability set and policy version                                                             | `DEFAULT` the seven capabilities of §13, `POLICY_VERSION = 2`; `migration.execute` deferred to M10M.                                                                                                                |
| Q21 | Canonical version published by M10A2                                                          | `DEFAULT` none beyond the `0.1` baseline (M10 §15.0); `0.2` is published by M10B.                                                                                                                                  |

## 23. Open items inherited from M10A1 (unchanged unless stated)

- Tech debt #15 (privacy/retention policy) — **audit purge execution stays disabled**; M10A2's data policy does not
  enable it. #17 (retention per table) is partly addressed by the data policy's retention metadata, not closed.
- Tech debt #62, #63, #64.
- Authenticated operator identity (M15): operator assurance stays `asserted`; the nine operator-id `tbc` columns stay
  `restricted`; new operator-id columns in M10A2 reuse the same `tbc` reason.
- Security events `audit_write_failed`, `credential_resolution_failed`, `token_decrypt_failed` emitted but not
  directly asserted (M10A2 adds no further unasserted events; each new event gets a test).
- Accepted minor findings m1 (profile-purge / `installUrl` audit not atomic), m4 (A1 record-level branch not
  applicable today), m-e (webhook intake takes the chain lock per batch), m-f (purge pre-verification window).
- `RetentionPolicyProvider` reading the tenant data policy — **closed by M10A2** (§6).
- Live Chargebee mutations M09/M10 not run; V6, V9, V10, V11; Chargebee incremental sync disabled; live Sugar
  verification pending.

## 24. Baseline at plan time (2026-10-14, sandbox)

Recorded honestly; the authoritative baseline for `e6ea612` remains the M10A1 closure evidence (`pnpm verify` unit
959/959, integration 497/497; runtime 175/175; Docker 29/29; CI green).

| Step                                   | Command / action                                                    | Outcome                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tooling                                | `node -v`, `pnpm -v`                                                | Node `v22.23.3`, pnpm `10.33.0`                                                                                                                                                                                                 |
| Docker                                 | `which docker`                                                      | **not available** → integration tests (Testcontainers), `verify:runtime` and `verify:docker` cannot run in this sandbox                                                                                                       |
| Local PostgreSQL                       | `initdb` + `pg_ctl start` (PostgreSQL 17.11 binaries)               | **started** on `127.0.0.1:55432` as a non-root user                                                                                                                                                                             |
| Dependencies                           | `pnpm install --frozen-lockfile`                                    | see the PR description for the final outcome; the first attempts were killed at the 115 s tool limit and a background attempt stalled at ~25 % of downloads, and the sandbox restarted during the install (clone re-created) |
| `pnpm verify` (format/lint/typecheck/boundaries/unit) | as available                                            | see the PR description                                                                                                                                                                                                          |
