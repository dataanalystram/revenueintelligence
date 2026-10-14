# Milestone 10B — Generic SourceReference + EvidenceLink: implementation plan

- Status: **PROPOSED PLAN (2026-10-14).** No schema, migration or code change has been made for M10B.
  Implementation follows `BUILD → TEST → VERIFY → MUTATION PROOF → FRESH CLONE → RUNTIME → DOCKER → INDEPENDENT
REVIEW → USER APPROVAL → MERGE`, on a fresh branch.
- Every open question (§22) carries a **recommended default**. Owner instruction (2026-10-14): building all M10
  sub-milestones is approved and the recommended defaults apply **unless the owner overrides them**; each is marked
  `DEFAULT`.
- Parent: [M10 plan](M10-canonical-architecture-implementation-plan.md) (approved, revision 3: D1–D6, F1–F5), §7,
  §8, §14, §15 (M10B), §16, §18. Predecessors: [M10A1](M10A1-security-foundation.md) (closed; ADR 0026) and
  [M10A2](M10A2-canonical-versioning-governance.md) (implementation in review, PR #2; ADR 0027).
- Candidate input: [E5 — Source reference, provenance and history](../architecture/canonical-v1/05-source-reference-and-provenance.md),
  ADR 0014 (identity, references, provenance), ADR 0017 (subscription line identity), ADR 0016 (product model
  versioning).
- Base: branch `m10a2-impl` at `1e41f16` (M10A2 implementation; CI run `38510972857` green on that head, run
  `38510222639` green on the last code head `c9d4856`), because M10B depends on M10A2. This plan's PR targets
  `integration` and **stacks on PR #2**; it becomes a plain diff once PR #2 is merged. `main` stays untouched.
- Two acceptance sections apply: `Canonical / business correctness` (§17) and `Security & Data Governance` (§18).
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made. M10B builds technical foundations only.
- Canonical version after M10B: **`0.2`** (M10 plan §15.0) — the first MINOR that adds canonical structure.
- ADR: following the M10A1/M10A2 pattern, **no ADR is drafted with this plan**. ADR 0028 (generic source references,
  evidence links, canonical `0.2`) is written during implementation (Q23).

## 0. What exists today (`IMPLEMENTED TODAY`, from inspection of `m10a2-impl` `1e41f16`)

| Area                         | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Company / person references  | `company_external_refs`, `person_external_refs`: PK `(tenant_id, system, object_type, external_id)`, FK to the entity `(tenant_id, id)`, states `active` / `deleted` / `merged` (+ `retired` for companies, M9B, with `retired_at` / `retired_by_run_id` → `tenant_sync_checkpoints`), first/last seen, source created/updated, `deleted_at`, `field_hash`, `last_change_id` (no FK). Written only by `ContextIngestionService` (ADR 0014 §4). |
| M9B retirement               | `ContextIngestionService.retireAbsentWithin` retires company references absent from an **accepted, proven, full** run with no uncertainty, inside the completion transaction (`SourceSyncService` 4d). Seen-but-rejected keys and protected children are excluded; a later read after the retirement time reactivates the same reference.                                                                                                      |
| Subscription line references | Inline triple `source_system` / `source_object_type` / `source_record_id` on `tenant_subscriptions`, unique per tenant; line identity **is** the source line (ADR 0017). `record_state` `active` / `deleted`.                                                                                                                                                                                                                                  |
| Product references           | **Declared**, not observed: each product in an immutable `tenant_product_models` document carries `externalRefs[] {system, objectType, id}` (≤ 20, unique per version). The mapping engine resolves a line's source product id through the model (`productStatus`), producing `productRef = kind:object:id`. No reference table; product identity is the tenant-scoped key (`tenant_products (tenant_id, key)`, D3).                           |
| Change records               | `tenant_context_changes`: append-only; `entity_kind` CHECK `company` / `person` / `subscription`; `entity_id uuid NOT NULL`; M10A2 columns `origin`, `derivation`, `canonical_version`, `schema_snapshot_hash`, `transforms`; change-type / cause CHECKs widened to the E5 sets; exempt from the polymorphic-FK guard (historical log, ADR 0027).                                                                                              |
| Entity index (M10A2)         | `tenant_entity_index` kinds `company`, `person`, `product` (by key), `subscription`; trigger-maintained by `lip_entity_indexer`; `lip_app` `SELECT` only; `tenant_value_history` is its only consumer.                                                                                                                                                                                                                                         |
| Evidence                     | **None.** Eligibility snapshots freeze their inputs (model / evaluator / facts hashes); nothing links a derived record to its evidence. No derived canonical entity exists yet (Signal is M10G).                                                                                                                                                                                                                                               |
| Canonical versions (M10A2)   | `canonical_model_versions` = `0.1` (`current`, ADR 0027); explicit adoption (`canonical adopt`, forward / previous-MINOR rollback, dry run); new tenants adopt `current` at provisioning; writers fail closed without an adoption (`canonical_version_unknown`).                                                                                                                                                                               |
| Security (M10A1 + M10A2)     | Capability catalogue `POLICY_VERSION = 2` (29 capabilities); `AuthorizedContext<C>`; S2 static test; hash-chained `tenant_audit_events`; closed audit actions / reason codes / target kinds (DB CHECKs equal code); privilege manifest (views included); classification manifest (every column); `SECURITY_DEFINER_FUNCTIONS` allow-list; integrity verification CLI `security integrity-verify`.                                              |
| Migration conventions        | One Prisma migration per concern, dev/staging down-script refusing while data exists, `migrations.int.spec.ts` (up / rerun / down-refusal / exact restore / re-apply), backfill before RLS on a new table. Latest: `20261215130000_m10a2_entity_index_history_lifecycle_integrity`.                                                                                                                                                            |

## 1. Scope

In scope (M10 plan §8, §15 M10B, refined by inspection):

1. **Generic source-reference store** `tenant_source_references` for every **non-legacy** entity kind, anchored in
   the entity index, products by key (D3). In M10B its only kind is `product`; later sub-milestones add their kinds.
2. **Product references as a declared projection** of the product model, maintained by product-model publication
   and **backfilled** from each tenant's latest published model (Q3, Q5, Q6).
3. **Shared source-reference lifecycle rules** (`active` / `retired` / `deleted` / `merged`, reactivation, retirement
   only on accepted proven full runs, seen-but-rejected protection) as one pure domain module used by the generic
   service **and** the existing company/person path (behaviour-identical, Q9).
4. **`SourceReferenceService`** — the single writer of the generic store.
5. **Immutable evidence links** `tenant_evidence_links` (link sets, supersession, roles) and the
   **`EvidenceLinkWriter`** (single writer).
6. **Read-only `source_reference_index` view** over all reference stores (no copy, no write path).
7. **Provenance read model** answering E5's questions ("where did this value come from", "what evidence supported
   it") with a CLI.
8. **Change-record widening** for key-identified entities (`entity_key`, entity kind `product`).
9. **Canonical `0.2`** published by the migration, with the explicit adoption path from M10A2.
10. **Security integration**: policy v3, audit vocabulary, manifests, schema guard, integrity checks.

Out of scope: see §21.

## 2. Generic source-reference store

### 2.1 `tenant_source_references` (tenant-owned, forced RLS)

| Column                                                                    | Type / rule                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `id`                                                         | PK `(tenant_id, id)`; `id` uuid                                                                                                                                                                                                                                                                             |
| `system`                                                                  | FK → `connector_kinds(kind)`                                                                                                                                                                                                                                                                                |
| `connection_id`                                                           | uuid NULL; composite FK `(tenant_id, connection_id)` → `tenant_source_connections`; recorded, not part of the key (Q10)                                                                                                                                                                                     |
| `object_type`                                                             | text, CHECK `^[A-Za-z0-9_]{1,100}$` (identifier only, as `ProductExternalRefSchema`)                                                                                                                                                                                                                        |
| `external_id`                                                             | text, CHECK `^[A-Za-z0-9_.:-]{1,255}$` (identifier only; never a value)                                                                                                                                                                                                                                     |
| —                                                                         | **unique `(tenant_id, system, object_type, external_id)`** — one source reference resolves to exactly one canonical record (E5 §1), same key as the legacy stores                                                                                                                                           |
| `entity_kind`                                                             | closed CHECK = code catalogue `GENERIC_REFERENCE_KINDS` (M10B: `product`); named CHECK `tenant_source_references_not_legacy_kind` refuses `company`, `person`, `subscription` (Q2)                                                                                                                          |
| `entity_id` / `entity_key`                                                | exactly one (CHECK); `entity_key` iff `entity_kind = 'product'`; composite FKs `(tenant_id, entity_kind, entity_id)` / `(tenant_id, entity_kind, entity_key)` → `tenant_entity_index`, `ON DELETE RESTRICT`                                                                                                 |
| `origin`                                                                  | `observed` (a source read returned it) / `declared` (a published configuration document declares it)                                                                                                                                                                                                        |
| `declared_in_model_version`                                               | int NULL; FK `(tenant_id, declared_in_model_version)` → `tenant_product_models`; CHECK `(origin = 'declared') = (declared_in_model_version IS NOT NULL)`                                                                                                                                                    |
| `state`                                                                   | `active` / `retired` / `deleted` / `merged`                                                                                                                                                                                                                                                                 |
| `merged_into_external_id`                                                 | NOT NULL iff `state = 'merged'`                                                                                                                                                                                                                                                                             |
| `first_seen_at`, `last_seen_at`, `source_created_at`, `source_updated_at` | timestamptz (as the legacy stores)                                                                                                                                                                                                                                                                          |
| `deleted_at`                                                              | NOT NULL iff `state = 'deleted'`                                                                                                                                                                                                                                                                            |
| `retired_at`, `retired_by_run_id`, `retired_by_model_version`             | **retirement gate CHECK** (named `tenant_source_references_retirement_gate`): `state = 'retired'` ⇔ `retired_at` set **and** exactly one of (`origin = 'observed'` and `retired_by_run_id` → `tenant_sync_checkpoints`) or (`origin = 'declared'` and `retired_by_model_version` → `tenant_product_models`) |
| `field_hash`                                                              | 64 hex NULL (idempotency; no values)                                                                                                                                                                                                                                                                        |
| `last_change_id`                                                          | uuid NULL; composite FK → `tenant_context_changes (tenant_id, id)`                                                                                                                                                                                                                                          |
| `created_at`, `updated_at`                                                | timestamptz                                                                                                                                                                                                                                                                                                 |

- **Indexes:** `(tenant_id, entity_kind, entity_id)`, `(tenant_id, entity_kind, entity_key)`, partial
  `(tenant_id, system, object_type) WHERE state = 'active'`.
- **Privileges (`lip_app`):** `SELECT, INSERT, UPDATE`; **no `DELETE`** (references are state-changed, never deleted;
  E5 §2).
- **Triggers:** tenant-id immutability (M10A1 pattern); **identity immutability** — `system`, `object_type`,
  `external_id`, `origin`, `entity_kind` never change; `entity_id` / `entity_key` change only when
  `NEW.state = 'merged'` (re-pointed to the survivor, ADR 0014 §5) or `origin = 'declared'` (re-declared to another
  product key by a later model version, Q6); `updated_at` maintenance.
- **No secret-bearing column.** `object_type` / `external_id` are pattern-checked identifiers; source coordinates
  contain identifiers only, never values (M10 §15 M10B).

### 2.2 Legacy stores stay authoritative (M10 §8, Q2)

- `company_external_refs`, `person_external_refs` and the inline subscription triple are **not** copied. Copying
  would create two sources of truth; the M9B retirement semantics and tests stay exactly as they are.
- The generic store refuses their kinds by named CHECK, and integrity verification flags any `(system,
object_type, external_id)` present in more than one store (`source_reference_ambiguous`, §11).

### 2.3 Product references (D3)

- **Product identity is unchanged:** the tenant-scoped key. Product Model versions stay immutable and are **not**
  referenced by a reference's identity; `declared_in_model_version` records which version last declared it (audit
  trail), so a reference survives model versions exactly as subscriptions do.
- **Declared projection (Q3).** For every product in the latest published model, each `externalRefs[]` entry is a
  `declared` row `(system, objectType, id) → (product, key)`. It is written **only** by the product-model publish
  path (`ProductCatalogueService.publish` → `SourceReferenceService.applyDeclaredProductReferences`) in the publish
  transaction:

  | Model change between published versions | Reference effect                                                                                         | Change record            |
  | --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------ |
  | ref newly declared                      | insert `active`, `declared_in_model_version = v`                                                         | `ref_added`              |
  | ref still declared, same key            | **no write** (`declared_in_model_version` keeps the version that introduced it; no churn)                | none                     |
  | ref removed from the model              | `retired`, `retired_by_model_version = v` (explicit declaration, never inference from absence in a read) | `retired`                |
  | removed ref declared again              | same row → `active`, retirement columns cleared, `declared_in_model_version = v`                         | `reactivated`            |
  | ref moved to another product key        | same row re-pointed (`entity_key`), `declared_in_model_version = v`                                      | `updated` (`entity_key`) |

- **Resolution is unchanged in M10B (Q3):** the mapping engine keeps resolving product ids through the model
  document. The projection is for provenance, the view and later consumers; an integrity check proves projection ↔
  model parity (§11). Switching resolution to the store is a later decision with its own equivalence proof.
- **Observed product references** (a catalogue sync recording `last_seen_at`) are **not** added in M10B (Q4).

### 2.4 Shared lifecycle rules (Q9)

- New pure module `domain/canonical/source-reference.ts`: `decideReferenceObservation` (newer → apply; older →
  stale no-op; same time and hash → unchanged; tombstone not revived by an observation older than its deletion
  time), `decideRetirement` (only for an **accepted, proven, full** run with no uncertainty; never for keys seen in
  the run, seen-but-rejected keys, or protected keys; never for `declared` rows), `decideReactivation` (only by a read
  made **after** the retirement / deletion time; same row, no duplicate), `decideMerge` (terminal for the merged
  reference; lineage kept).
- `ContextIngestionService` calls the same functions for company/person references. **The existing stores, SQL and
  M9B tests are unchanged**; a table-driven equivalence test proves the extracted rules decide exactly as the
  pre-M10B code did. If any M9B/M6 test has to change, work stops and it is reported.

### 2.5 `SourceReferenceService` (single writer of the generic store)

| Method                                       | Capability                     | Notes                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe(tx, ctx, observation)`              | `canonical.source_sync`        | upsert under row lock; lifecycle via §2.4; one change record per real change; refuses legacy kinds (`reference_kind_not_generic`) and a triple already bound to another entity (`reference_identity_conflict`, never silently re-pointed) |
| `retireAbsentWithin(tx, ctx, run)`           | `canonical.source_sync`        | called only from the sync completion transaction, with the run's acceptance, proof, seen and protected sets (M9B contract)                                                                                                                |
| `applyDeclaredProductReferences(tx, ctx, v)` | `config.product_model.publish` | called only by product-model publish; §2.3 table                                                                                                                                                                                          |
| `merge(tx, ctx, from, survivor)`             | `canonical.source_sync`        | for merge participants of later entity kinds; re-points, `merged`, change record                                                                                                                                                          |

- **Canonical version gate:** `observe`, `retireAbsentWithin` and `merge` require the tenant's adopted version
  ≥ `0.2` (`canonical_version_too_low`). `applyDeclaredProductReferences` runs for every tenant (Q7).
- **Module gate:** each future generic kind is checked with `ModuleGate.require` for its module; `product` is core.
- In M10B, `observe` / `retireAbsentWithin` / `merge` have **no production caller** (no new entity kind is ingested
  until M10C+). They are exercised by integration tests through a test harness on `product` triples that are not
  declared (§19 V6–V8).

## 3. Evidence links

### 3.1 `tenant_evidence_links` (tenant-owned, forced RLS, append-only by privilege **and** trigger)

| Column                                         | Type / rule                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `id`                              | PK `(tenant_id, id)`                                                                                                                      |
| `link_set_id`, `ordinal`                       | uuid, smallint 0–999; unique `(tenant_id, link_set_id, ordinal)`. A link set is everything one write of one subject cites                 |
| `subject_kind`, `subject_id`, `subject_key`    | the derived record; exactly one of id/key; composite FKs → `tenant_entity_index`, `ON DELETE RESTRICT`                                    |
| `evidence_type`                                | closed: `entity` / `change_record` / `eligibility_snapshot` (Q11)                                                                         |
| `evidence_kind`, `evidence_id`, `evidence_key` | for `entity`: exactly one of id/key; composite FKs → `tenant_entity_index`, `ON DELETE RESTRICT`                                          |
| `evidence_change_id`                           | for `change_record`: composite FK → `tenant_context_changes (tenant_id, id)` (single known kind → direct FK, F2)                          |
| `evidence_snapshot_id`                         | for `eligibility_snapshot`: composite FK → `tenant_eligibility_snapshots (tenant_id, id)` (direct FK, F2)                                 |
| —                                              | CHECK: exactly the column group of `evidence_type` is set, all others NULL; CHECK: an `entity` link never cites its own subject           |
| `role`                                         | closed CHECK = code catalogue `EVIDENCE_ROLES`: `supports`, `contradicts`, `derived_from`, `context` (Q12)                                |
| `weight`                                       | numeric(5,4) NULL, CHECK 0–1 (Q15)                                                                                                        |
| `origin`                                       | `source_provided` / `deterministic` / `ai_derived` / `human` (the change-record vocabulary minus `migration`)                             |
| `derivation`                                   | jsonb `{key, version, inputs_hash}`; CHECK required iff `origin` in (`deterministic`, `ai_derived`) — same rule as change records         |
| `supersedes_link_set_id`                       | uuid NULL: the earlier set of the **same subject** this set replaces (Q14); validated by the writer, re-checked by integrity verification |
| `change_id`                                    | uuid NULL; composite FK → `tenant_context_changes`: the change record of the subject write that produced the set, when there is one       |
| `canonical_version`                            | FK → `canonical_model_versions`                                                                                                           |
| `actor_kind`, `actor_id`, `actor_assurance`    | as M10A1 (CHECKs reused)                                                                                                                  |
| `correlation_id`, `created_at`                 | uuid, timestamptz                                                                                                                         |

- **Indexes:** `(tenant_id, subject_kind, subject_id)`, `(tenant_id, subject_kind, subject_key)`,
  `(tenant_id, evidence_kind, evidence_id)` (reverse lookup: "what cites this"), `(tenant_id, evidence_change_id)`,
  `(tenant_id, link_set_id)`.
- **Immutability (M10 §8):** `lip_app` holds `SELECT, INSERT` only; the `app_refuse_change` trigger refuses
  `UPDATE` / `DELETE` from any role. A future corrective migration must drop and re-create the trigger explicitly in
  DDL, with its ADR and audit record — never silently.
- **Supersession, not update:** a re-derivation writes a new set with `supersedes_link_set_id`; the old set stays.
  "Current evidence" of a subject = the newest set not superseded (read model).

### 3.2 `EvidenceLinkWriter` (single writer)

- `write(tx, ctx: AuthorizedContext<'canonical.evidence.link'>, set)`; one call = one link set, one transaction with
  the subject write.
- **Layer 1 validation** (precise errors, not the security boundary, M10 §18): relation allowed by the code
  catalogue `EVIDENCE_RELATIONS` (subject kind → allowed evidence types/kinds/roles; `evidence_relation_not_allowed`);
  subject and evidence exist in the tenant and are not `merged` (`evidence_target_not_allowed`); module of each kind
  enabled (`ModuleGate`); set size 1–200 with unique ordinals (`evidence_set_invalid`); `derivation` present for
  derived origins; `supersedes_link_set_id` names an existing set of the same subject; adopted canonical version
  ≥ `0.2`.
- **Relation catalogue in M10B (Q13):** empty for production (no derived entity exists yet). The first relations
  arrive with Signal (M10G: signal → activity / metric observation / subscription / change record) and Opportunity
  (M10H: opportunity → signals / eligibility snapshot). Tests construct the writer with a test catalogue; database
  properties are proven with raw SQL as the app role on existing kinds.
- No `allowed` audit event per link set (canonical data, like sync record writes; Q17); denials and failures are
  audited through the M10A1 mechanisms.

## 4. `source_reference_index` view

- `CREATE VIEW source_reference_index WITH (security_invoker = true)` — union of:

  | Store                      | `entity_kind`  | `entity_id` / `entity_key` | `state`        | `origin`   |
  | -------------------------- | -------------- | -------------------------- | -------------- | ---------- |
  | `company_external_refs`    | `company`      | `company_id`               | as stored      | `observed` |
  | `person_external_refs`     | `person`       | `person_id`                | as stored      | `observed` |
  | `tenant_subscriptions`     | `subscription` | `id`                       | `record_state` | `observed` |
  | `tenant_source_references` | as stored      | as stored                  | as stored      | as stored  |

  plus `store`, `system`, `object_type`, `external_id`, `first_seen_at`, `last_seen_at`, `source_updated_at`,
  `retired_at`.

- Read-only: `lip_app` `SELECT` only (default DML revoked, as M10A2 did for `tenant_source_mapping_states`); RLS of
  the underlying tables applies (security invoker). No write path.

## 5. Provenance read model

- `ProvenanceQueryService` (read-only; `AuthorizedContext<'data.provenance.read'>`):
  - `references(kind, id | key)` — every source reference of the entity, from the view;
  - `field(kind, id | key, field)` — the latest change record that names the field: source triple, cause, run
    (`checkpoint_id`), connection, mapping version, `schema_snapshot_hash`, `transforms`, `origin`, `derivation`,
    actor, `canonical_version`; plus its value-history rows (**values only where `values_recorded`**, i.e. as the
    M10A2 restricted-history rule already decided — the read model never reads values from the canonical row);
  - `evidence(kind, id | key)` — current and superseded link sets of a subject; `citedBy(...)` — reverse lookup.
- CLI: `provenance show --tenant <slug> --kind <k> (--id <uuid> | --key <key>) [--field <f>] --actor <id>`; output
  is identifiers, codes and timestamps (plus recorded non-sensitive history values). Each call writes one
  `provenance.read` audit event (`allowed`; counts only). No HTTP endpoint in M10B (Q18).

## 6. Change-record widening

- `tenant_context_changes` gains `entity_key text NULL`; `entity_id` becomes nullable; CHECK
  `(entity_kind = 'product') = (entity_key IS NOT NULL)` and exactly one of `entity_id` / `entity_key`; `entity_kind`
  CHECK widened with `product` (`CHANGE_ENTITY_KINDS`). Existing rows are untouched (all have `entity_id`).
- **Product reference changes (Q8):** `entity_kind = 'product'`, `entity_key`, `change_type` per §2.3,
  `changed_fields = ['source_reference']`, source triple = the reference, `cause = 'human'`, `origin = 'human'`,
  actor = the publishing operator, `adapter = 'product-model'`, `adapter_version` = the model version,
  `canonical_version` = the tenant's adopted version.
  _Implementation note (M10B record D1, ADR 0028): the adapter is named `product_model` — the existing adapter
  CHECK `^[a-z0-9_]{1,32}$` refuses `product-model`._
- The backfill (§8) writes **no** change records: a migration must not fabricate provenance; the model version row
  (`declared_in_model_version`) is the provenance of a backfilled row, and `last_change_id` stays NULL.
- The table stays append-only and stays exempt from the polymorphic-FK guard (ADR 0027 D2).

## 7. Canonical version `0.2` and the adoption path from M10A2

- **Catalogue:** `CANONICAL_VERSIONS` = `0.1` (`supported`, ADR 0027), `0.2` (`current`, ADR 0028). The migration
  inserts `0.2` and moves `0.1` to `supported` in one statement order the one-current trigger accepts (Q20).
- **Catalogue hash (Q19):** `canonicalCatalogueHash` gains optional members `changeEntityKinds`,
  `genericReferenceKinds`, `evidenceTypes`, `evidenceRoles`, hashed only when present, so the stored `0.1` hash is
  reproduced unchanged (test) and `0.2`'s hash covers the new vocabulary.
- **`0.2` means:** the generic store, evidence links and the widened change record exist **and** the tenant may
  write observed generic references and evidence links. Entity-index kinds and modules are unchanged (references and
  provenance are core, M10 §17).
- **Adoption (explicit, M10A2 Q2 — Q21):** existing tenants stay on `0.1` until the operator adopts:
  `canonical adopt --tenant <slug> --version 0.2 --expected-current 0.1` (dry run: lists what `0.2` enables, rewrites
  nothing) then `--execute` (capability `config.canonical.adopt`, one audit event). New tenants adopt `0.2` at
  provisioning (`current`).
- **Rollback:** `0.2 → 0.1` (previous MINOR) stays allowed. Data is kept and stays readable; writers refuse new
  observed references and evidence links with `canonical_version_too_low` (audited), mirroring F4 for modules.
- **What is not gated:** the declared product-reference projection and its backfill exist for every tenant (Q7);
  they mirror a `0.1` structure (the product model) and change no behaviour. Provenance reads work at any version.

## 8. Migration

One forward migration (M10 §5 row 3), with a down-script and the standard migration tests:

**`20261229120000_m10b_source_references_evidence`**

1. `tenant_context_changes`: `entity_key`, `entity_id` nullable, exactly-one CHECK, `entity_kind` CHECK + `product`.
2. `tenant_source_references` (§2.1) with constraints and triggers.
3. **Backfill (before RLS is enabled on the new table, M8 pattern):** for each tenant with a published product
   model, from the **highest** version (the version the `tenant_products` projection reflects), one `declared`,
   `active` row per `products[].externalRefs[]` entry → `(product, key)`, `declared_in_model_version` = that
   version, `first_seen_at` / `last_seen_at` = the version's `published_at`. Counts asserted inside the migration
   (`RAISE EXCEPTION` on mismatch, M9A parity pattern): rows per tenant = `jsonb_array_elements` count of the
   document; every row's key present in `tenant_products` (the index FK enforces it); every `system` a
   `connector_kinds` kind (FK). Legacy company/person references and subscription triples are **not** copied (Q2);
   the migration asserts the view's per-store counts equal the store counts.
4. `tenant_evidence_links` (§3.1) with constraints, `app_refuse_change` trigger.
5. `source_reference_index` view (§4).
6. `canonical_model_versions`: insert `0.2` (`current`, `catalogue_hash`, `adr = '0028'`); `0.1` → `supported`.
7. Audit CHECKs widened (§13); forced RLS, tenant policies, tenant-id immutability triggers; privileges
   (`REVOKE ALL` then the manifest grants; view `SELECT` only).

- Additive only: new tables, a view, a nullable column, a relaxed NOT NULL guarded by a CHECK, widened CHECKs,
  triggers, grants on new objects only. No column or table renamed or dropped; no existing row rewritten (the backfill
  inserts into a new table only; the `0.1` status change is platform reference data).
- **Down-script** (dev/staging): refuses while any non-backfill data exists — an `observed` reference, a reference
  with `last_change_id` set or not `active`, any evidence link, any change record with `entity_kind = 'product'`, any
  adoption of `0.2` (including new tenants provisioned at `0.2`); otherwise drops the new objects, restores the
  CHECKs, `entity_id NOT NULL`, the `0.1` `current` row and the M10A2 privilege matrix exactly. Prisma schema updated;
  the drift test stays green.

## 9. Backward compatibility

- Ingestion, mapping resolution, eligibility, ownership, whitespace, coverage tiers, snapshots and every CLI behave
  exactly as before. Additions: product-model publish also maintains the declared projection and writes product
  reference change records; adoption offers `0.2`; new tenants start at `0.2`.
- Company/person references and the M9B retirement / reactivation path are unchanged (stores, SQL, tests); only the
  pure decision functions move (Q9, equivalence-tested).
- `ON DELETE RESTRICT` from source references and evidence links: a product key cannot be deleted while referenced
  (products are never deleted, K4); companies/persons/subscriptions gain no new referrers from production code in
  M10B. The existing M2 physical-delete paths (`PrismaCompanyRepository.delete`, `PrismaPersonRepository.delete`) are
  re-inspected; **if a legitimate path breaks, work stops and it is reported** (M10A2 Q15 pattern, Q24).

## 10. Tenant isolation

- Both tables: `tenant_id` first in every key, forced RLS on `app_current_tenant()`, tenant-scoped unique keys,
  composite FKs, tenant-id immutability trigger; schema guard covers them automatically.
- **Polymorphic sets** (`entity`, `subject`, `evidence`) reference the entity index through composite FKs that
  include `tenant_id` (M10 §18 layer 2): a cross-tenant reference is impossible even with raw SQL as the app role,
  by id and by product key.
- Direct single-kind references (`evidence_change_id`, `evidence_snapshot_id`, `last_change_id`, `connection_id`,
  `retired_by_*`, `declared_in_model_version`) are composite `(tenant_id, x)` FKs (F2).
- The view is `security_invoker`: a tenant sees only its own rows from every store.

## 11. Integrity verification (extends M10A2 §11)

New checks in `security integrity-verify` (read-only; findings never repaired):

| Code                               | Check                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `declared_reference_drift`         | active `declared` product references = the `externalRefs` of the latest published model (both directions, same key)           |
| `source_reference_ambiguous`       | no `(system, object_type, external_id)` in more than one store (view)                                                         |
| `source_reference_change_mismatch` | `last_change_id` names a change record of the same triple and entity                                                          |
| `evidence_relation_unknown`        | every link's (subject kind, evidence type/kind, role) is in `EVIDENCE_RELATIONS` (catches raw-SQL writes that bypass layer 1) |
| `evidence_supersession_invalid`    | `supersedes_link_set_id` names an existing set of the same subject                                                            |
| `source_reference_index_parity`    | view row count per store = store row count                                                                                    |

Entity-anchored orphans remain impossible by FK (M10A2 D3); an orphan planted by the owner with constraints disabled
is caught by the existing index checks.

## 12. Building on M10A1 / M10A2

| Primitive                           | Use in M10B                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthorizedContext<C>` / S2         | every new write method (`SourceReferenceService.*`, `EvidenceLinkWriter.write`) and the provenance read take their typed context; S2 list extended                                 |
| Policy (`POLICY_VERSION` 2 → **3**) | two new capabilities (§13); exhaustive S1 test updated                                                                                                                             |
| Audit trail                         | `provenance.read` allowed events; denials and failures via `operation.denied` / `@AuditFailures`; product-model publish event details gain reference-transition counts             |
| Append-only                         | evidence links: `SELECT, INSERT` + `app_refuse_change`                                                                                                                             |
| Privilege manifest                  | both tables and the view entered; references without `DELETE`                                                                                                                      |
| Classification manifest             | every new column classified (mirroring `company_external_refs`: identifiers `internal` / `operational`, `canonical_lifecycle`, history `none`; `derivation` / `weight` `internal`) |
| Data-subject map                    | no new subject link in M10B (`product` is not personal); evidence links inherit their subject's link when personal kinds become subjects (M10K)                                    |
| Entity index (A2)                   | anchor for every polymorphic set; no new kinds                                                                                                                                     |
| Canonical versions / adoption (A2)  | `0.2` row, catalogue hash, adoption gate in writers (`CanonicalVersionReader`)                                                                                                     |
| Module gate (A2)                    | called for each kind's module; no-op for core kinds                                                                                                                                |
| Value history (A2)                  | read by the provenance model; nothing new recorded                                                                                                                                 |
| Integrity verification (A2)         | six new checks (§11)                                                                                                                                                               |
| Secret-like refusal (A1)            | source coordinates are pattern-checked identifiers (DB CHECK + Zod); `derivation` keys pattern-checked; free text appears nowhere                                                  |

## 13. Permissions (policy v3)

| Capability                                | Covers                                                                | Granted to (v3)         |
| ----------------------------------------- | --------------------------------------------------------------------- | ----------------------- |
| `canonical.evidence.link`                 | evidence link set writes                                              | `system`                |
| `data.provenance.read`                    | provenance read model / CLI                                           | `operator`              |
| (existing) `canonical.source_sync`        | observed generic references, retirement in the sync completion, merge | `source_sync`, `system` |
| (existing) `config.product_model.publish` | declared product references (inside product-model publish)            | `operator`              |
| (existing) `config.canonical.adopt`       | adoption of `0.2` and rollback                                        | `operator`              |

- `human_user` and `ai` still hold nothing; `canonical.human_entry` stays reserved (operator-entered references and
  evidence arrive with M15).
- **Audit actions added:** `provenance.read`, `evidence.link` (denials / failures only), `source_reference.observe`
  (denials / failures only). **Reason codes added:** `reference_kind_not_generic`, `reference_identity_conflict`,
  `evidence_relation_not_allowed`, `evidence_target_not_allowed`, `evidence_set_invalid`. **Target kinds added:**
  `source_reference`, `evidence_link_set`, `provenance`. DB CHECKs widened to equal the code (schema guard).

## 14. Performance and indexing

- Every index leads with `tenant_id`. Reference lookups are single unique-key probes, as today.
- Declared projection writes happen only at product-model publish (configuration rate; ≤ 20 refs per product).
- Evidence links: batched per set; three FK probes per row (index / change record / snapshot, at most one non-NULL
  group); reverse-lookup index for "cited by". High-volume growth arrives with Signal (M10G); time-range
  partitioning stays `DEFERRED` (M10 §13).
- The view is not materialised; provenance queries filter by entity, which the store indexes serve.

## 15. Rollback / forward-fix

- Production: forward-fix. Tenant-level rollback = adoption back to `0.1` (data kept, writes refused).
- Dev/staging: the down-script (§8). Security controls (immutability trigger, FKs, CHECKs) are never relaxed to get
  green.

## 16. Risks

| Risk                                                             | Mitigation                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Extracting lifecycle rules regresses M9B retirement/reactivation | pure functions only, stores untouched; equivalence test; full M9B suite unchanged; stop and report (Q9)    |
| Declared projection drifts from the model                        | written only in the publish transaction; property test over publish sequences; integrity check (§11)       |
| Two sources of truth for product references (model + projection) | resolution keeps reading the model in M10B; projection is derived and parity-checked (Q3)                  |
| Writers with no production caller are "dead code" until M10C+    | integration tests through a harness; first real caller named per kind in later plans                       |
| `entity_id` NOT NULL relaxed on the change record                | guarded by the exactly-one CHECK; regression proves existing writers unchanged                             |
| Cross-store ambiguity cannot be a DB constraint (three tables)   | generic kinds disjoint by CHECK; ambiguity is an integrity finding                                         |
| `RESTRICT` blocks a legitimate delete path                       | inspection first; stop and report (Q24)                                                                    |
| Stacked on unmerged PR #2                                        | PR stacks explicitly; rebased after PR #2 merges; no implementation before M10A2 merges into `integration` |
| Scope creep into Signal / Opportunity                            | relation catalogue empty in production; no derived entity tables                                           |

## 17. Acceptance — Canonical / business correctness

- Generic lifecycle: active / retired / deleted / merged; reactivation without duplicates only by a later read;
  retirement only on accepted proven full runs; seen-but-rejected protection; incremental, failed, unstable and
  unaccepted runs never retire.
- Declared product references: backfill equals the latest model; publish transitions of §2.3; a reference survives
  a new model version unchanged; resolution and canonical results unchanged.
- Evidence links: relation catalogue, sets, supersession, current-evidence read.
- Provenance read model answers the E5 §3 questions for company fields and product references.
- Canonical `0.2` published; `0.1` supported; adoption forward / rollback; new tenants at `0.2`; module settings
  untouched by adoption.
- M9B retirement tests unchanged and green; full M6–M10A2 suites unchanged; identical canonical results on the Sugar
  and Chargebee fakes.
- Migration up / rerun / down-refusal / exact restore / re-apply.

## 18. Acceptance — Security & Data Governance

- Tenant isolation (RLS plus composite FKs) on both tables and the view.
- **No cross-tenant evidence link or source reference, proved with raw SQL as the app role** (by id and by product
  key; entity, change-record and snapshot evidence).
- Immutable evidence (privilege plus trigger); provenance tamper protection: evidence and change records cannot be
  updated or deleted by the app role; references cannot be deleted.
- Retirement gate enforced by the database (named CHECK) as well as the service.
- Every new write path authorized through `AuthorizedContext`; denials audited; provenance reads audited.
- Source coordinates contain identifiers only (pattern CHECKs); no values in logs, change records or audit details.
- Privilege, classification and audit-vocabulary manifests equal the database (schema guard).
- `1.0` still refused; no compliance claim.

## 19. Tests and mutation proofs

| #   | Test                                                                                                                                                                                                                                                                                | Level                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| V1  | lifecycle decision functions: observation ordering, tombstones, retirement eligibility, reactivation only after the retirement/deletion time, merge; property tests; equivalence table with the pre-M10B company/person behaviour                                                   | unit (property)           |
| V2  | generic store constraints: exactly-one entity form, `not_legacy_kind`, retirement gate (observed without run / declared without model version refused), merged / deleted column rules, identity immutability, no `DELETE`                                                           | integration               |
| V3  | backfill: declared rows = latest model `externalRefs` per tenant (counts, keys, versions); tenant without a model → none; no company/person/subscription row copied; view per-store parity                                                                                          | integration (migration)   |
| V4  | product-model publish: add → `ref_added`; remove → `retired` (`retired_by_model_version`); re-add → `reactivated` same row; move → re-pointed `updated`; projection = model after random publish sequences                                                                          | integration + property    |
| V5  | reference survives a model version (no write, no change record); line resolution and eligibility results identical                                                                                                                                                                  | integration               |
| V6  | `observe`: insert, newer / stale / unchanged, tombstone not revived by an older read, reactivation by a later read, one change record per real change, identity conflict refused                                                                                                    | integration               |
| V7  | `retireAbsentWithin`: only accepted proven full runs with no uncertainty; seen-but-rejected and protected keys never retired; incremental / failed / unstable / unaccepted runs never retire; declared rows never                                                                   | integration               |
| V8  | `merge`: re-point to survivor, `merged`, lineage, change record; identity columns otherwise immutable                                                                                                                                                                               | integration               |
| V9  | `EvidenceLinkWriter`: relation catalogue, merged target refused, set limits / ordinals, derivation rule, supersession of the same subject only, version gate, module gate; denial audited                                                                                           | integration               |
| V10 | evidence immutability: app role `UPDATE` / `DELETE` → permission denied; owner `UPDATE` / `DELETE` → trigger refuses; supersession keeps the old set                                                                                                                                | integration               |
| V11 | adversarial (app role, raw SQL, writer bypassed): tenant-A reference to a tenant-B product key / entity id refused; tenant-A evidence citing tenant-B entity / change record / snapshot refused; RLS hides B's rows                                                                 | integration (adversarial) |
| V12 | view: `security_invoker` set, app-role DML denied, union per store correct, tenant sees only its rows                                                                                                                                                                               | integration               |
| V13 | provenance: E5 questions answered for a company field (triple, run, mapping version, snapshot hash, transforms, origin, actor, canonical version); value-free history shows no values; capability required; one audit event; no values in logs                                      | integration               |
| V14 | canonical catalogue: table = code; exactly one `current` (`0.2`); `0.1` `supported`; stored `0.1` hash reproduced; `0.2` hash = code; `1.0` still refused                                                                                                                           | unit + integration        |
| V15 | adoption path: 0.1 tenant dry run lists `0.2` effects and writes nothing; at `0.1` observed references and evidence refused (`canonical_version_too_low`, audited); after adoption accepted; rollback keeps data and refuses writes; new tenant at `0.2`; module settings unchanged | integration               |
| V16 | change records: `entity_key` / exactly-one CHECK; product reference changes carry key, `human` origin/cause, actor, version; pre-M10B rows unchanged                                                                                                                                | integration               |
| V17 | integrity: clean tenant passes; planted (owner, test DB) declared drift, cross-store ambiguity, unknown relation, invalid supersession, change mismatch → findings + security event; nothing repaired                                                                               | integration               |
| V18 | S1/S2 extended: policy v3 exhaustive; every new write method / read takes `AuthorizedContext`                                                                                                                                                                                       | unit                      |
| V19 | schema guard: privilege matrix (incl. view), classification, polymorphic FKs present for `entity` / `subject` / `evidence`, direct composite FKs, kind / role / evidence-type / audit CHECKs equal code                                                                             | integration               |
| V20 | M9B / M6 suites unchanged and green (retirement, reactivation, merge, tombstones)                                                                                                                                                                                                   | integration (regression)  |
| V21 | regression: identical canonical results on the Sugar and Chargebee fakes; M7 eligibility / whitespace / coverage; M10A1–A2 suites                                                                                                                                                   | integration (regression)  |
| V22 | migration up / rerun / down-refusal (each refusal condition) / exact restore / re-apply                                                                                                                                                                                             | integration (migration)   |
| V23 | runtime `87-source-references-evidence.sh`: backfilled references visible; model republish → `retired` / `reactivated`; `provenance show`; adopt `0.2` dry run + execute; no values in logs                                                                                         | runtime                   |

Mutation proofs (break → the named test fails for that reason → restore → green; harness refuses a dirty tree):

| #    | Mutation                                                                          | Must fail        |
| ---- | --------------------------------------------------------------------------------- | ---------------- |
| VM1  | drop the reference → entity-index composite FK                                    | V11              |
| VM2  | drop the evidence `subject` → index FK                                            | V11              |
| VM3  | drop the evidence `evidence` → index FK                                           | V11              |
| VM4  | drop the tenant from the `evidence_change_id` FK (single-column FK)               | V11, V19         |
| VM5  | `GRANT UPDATE, DELETE ON tenant_evidence_links TO lip_app`                        | V10, V19         |
| VM6  | drop the `app_refuse_change` trigger on evidence links                            | V10 (owner path) |
| VM7  | drop the retirement-gate CHECK and let the service retire on an unaccepted run    | V7, V2           |
| VM8  | remove seen-but-rejected protection from `decideRetirement`                       | V7, V1           |
| VM9  | reactivation accepts a read older than the retirement time                        | V1, V6           |
| VM10 | drop `not_legacy_kind`                                                            | V2               |
| VM11 | drop the identity-immutability trigger                                            | V2, V8           |
| VM12 | product-model publish skips the projection                                        | V4, V17          |
| VM13 | projection deletes removed references (with `DELETE` granted) instead of retiring | V4, V19          |
| VM14 | writer skips the relation catalogue                                               | V9               |
| VM15 | writer validation disabled entirely (positive control: database still refuses)    | V11 stays green  |
| VM16 | writers skip the `0.2` adoption gate                                              | V15              |
| VM17 | view created without `security_invoker`                                           | V12, V19         |
| VM18 | provenance read without the capability check                                      | V13              |
| VM19 | provenance returns values for value-free history rows (reads the canonical row)   | V13              |
| VM20 | grant `data.provenance.read` to `source_sync`                                     | V18 (S1)         |
| VM21 | catalogue hash always includes the new members (changes `0.1`'s hash)             | V14              |
| VM22 | integrity ignores declared drift                                                  | V17              |
| VM23 | down-script refusal on evidence links removed                                     | V22              |

## 20. Definition of Done and evidence

| Item                                                                                                                                                                                  | Evidence                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Migration + down-script; V22                                                                                                                                                          | CI integration job                                                                                           |
| V1–V22                                                                                                                                                                                | CI (unit job; integration job with Testcontainers as the app role)                                           |
| V23 runtime script                                                                                                                                                                    | CI runtime job                                                                                               |
| Format, lint, typecheck, boundaries, unit, integration, runtime, docker                                                                                                               | **GitHub Actions run IDs** (workflow `CI`, all four jobs green on the reviewed head), recorded in the record |
| Mutation proofs VM1–VM23                                                                                                                                                              | recorded with the failing output (command, failing assertion, restore, green rerun)                          |
| Fresh-clone run                                                                                                                                                                       | recorded (Docker-capable machine or CI); the sandbox has no Docker                                           |
| ADR 0028; record `docs/milestones/M10B-source-reference-evidence-link.md`; README status; E5 candidate note (declared product references, evidence endpoint types); tech-debt entries | in the PR                                                                                                    |
| Independent review (`review-milestone`), PR to `integration`, owner approval, merge                                                                                                   | PR and review record                                                                                         |

- The sandbox used for planning has no Docker; integration, runtime and Docker evidence is taken from **CI runs on
  the PR head** (run IDs per head, failures included, as the M10A2 record does). Live Chargebee TEST-site read-only
  regression runs if the approved secrets are available; otherwise recorded as not run. Live Sugar stays pending.

## 21. Out of scope

- Any derived canonical entity (Signal, Opportunity, Recommendation, …) and therefore any production evidence
  relation (M10G onward).
- Copying `company_external_refs` / `person_external_refs` or subscription triples into the generic store (Q2).
- Switching product-id resolution from the model document to the store (Q3); observed product-catalogue references
  (Q4).
- New entity-index kinds; account hierarchy and affiliation (M10C); extension values (M10D).
- Operator-initiated reference lifecycle actions (manual retire / reactivate / merge) and HTTP provenance endpoints
  (M15 operator workspace; Q18).
- Multi-connection-per-kind reference keys (Q10).
- Automatic integrity schedule and worker job (M10M; tech debt #65).
- Raw value retention, audit purge execution (tech debt #15); any compliance claim; publishing `1.0`.

## 22. Open questions and decisions for the owner

Each answer marked `DEFAULT` is what implementation proceeds with unless the owner overrides it.

| #   | Question                                                                              | Recommended answer (`DEFAULT`)                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | One migration / one PR?                                                               | `DEFAULT` yes: one migration (M10 §5 row 3), one implementation PR to `integration`.                                                                                                                                                |
| Q2  | Backfill company/person references (and subscription triples) into the generic store? | `DEFAULT` no (M10 §8: two sources of truth). They are surfaced by the `source_reference_index` view; the generic store refuses their kinds by named CHECK.                                                                          |
| Q3  | How do product references enter the generic store?                                    | `DEFAULT` as a **declared projection** of the product model, written only by product-model publish, backfilled from each tenant's latest published model. Resolution keeps reading the model in M10B; parity is an integrity check. |
| Q4  | Observed product references (catalogue sync `last_seen_at`)?                          | `DEFAULT` not in M10B; revisit when a catalogue object is synced.                                                                                                                                                                   |
| Q5  | A ref removed from a newer model version                                              | `DEFAULT` `retired` with `retired_by_model_version` (explicit declaration, not inference from absence); re-declaring reactivates the same row; never deleted.                                                                       |
| Q6  | A ref moved to another product key across versions                                    | `DEFAULT` same row re-pointed with an `updated` change record (declared rows only); observed rows re-point only through merge.                                                                                                      |
| Q7  | Maintain the declared projection for tenants still on `0.1`?                          | `DEFAULT` yes (core; mirrors a `0.1` structure; no behaviour change). The `0.2` gate applies to observed generic references and evidence links.                                                                                     |
| Q8  | Change records for key-identified products                                            | `DEFAULT` add `entity_key`, relax `entity_id` under an exactly-one CHECK, widen `entity_kind` with `product`; publish changes use `cause`/`origin` `human`; the backfill writes none.                                               |
| Q9  | Shared lifecycle implementation                                                       | `DEFAULT` extract the pure decision rules into `domain/canonical/source-reference.ts`, used by both paths; legacy stores and SQL untouched; equivalence test; stop and report if any M9B/M6 test must change.                       |
| Q10 | Connection in the reference key?                                                      | `DEFAULT` no: key `(tenant, system, object_type, external_id)` as the legacy stores (one connection per kind today); `connection_id` recorded nullable.                                                                             |
| Q11 | Evidence endpoint types                                                               | `DEFAULT` `entity` (entity index), `change_record` and `eligibility_snapshot` (direct composite FKs, F2); more types only by a later MINOR.                                                                                         |
| Q12 | Evidence roles                                                                        | `DEFAULT` closed `supports`, `contradicts`, `derived_from`, `context`; extended only by a canonical MINOR.                                                                                                                          |
| Q13 | Relation catalogue and DB subject-kind constraint in M10B                             | `DEFAULT` catalogue empty for production; no DB subject-kind CHECK beyond the index (writer = layer 1, FK = boundary, integrity `evidence_relation_unknown` = layer 3); tests inject a catalogue.                                   |
| Q14 | Supersession model                                                                    | `DEFAULT` immutable link sets with `supersedes_link_set_id` (same subject); no updates; "current" = newest unsuperseded set.                                                                                                        |
| Q15 | Weight                                                                                | `DEFAULT` optional `numeric(5,4)` in 0–1; no semantics enforced beyond range.                                                                                                                                                       |
| Q16 | Capabilities                                                                          | `DEFAULT` `canonical.evidence.link` (`system`), `data.provenance.read` (`operator`); `POLICY_VERSION = 3`; existing capabilities cover observed and declared references.                                                            |
| Q17 | Audit of evidence writes                                                              | `DEFAULT` no `allowed` event per link set (canonical data, like sync writes); denials and failures audited; provenance reads audited.                                                                                               |
| Q18 | Provenance surface                                                                    | `DEFAULT` service + CLI only; HTTP / UI with M15.                                                                                                                                                                                   |
| Q19 | Catalogue hash for `0.2`                                                              | `DEFAULT` optional new members hashed only when present, so the stored `0.1` hash is reproduced unchanged.                                                                                                                          |
| Q20 | Status of `0.1` after `0.2`                                                           | `DEFAULT` `supported` (rollback to `0.1` stays possible).                                                                                                                                                                           |
| Q21 | Do existing tenants adopt `0.2` automatically?                                        | `DEFAULT` no: explicit operator adoption (M10A2 Q2); new tenants start at `0.2`.                                                                                                                                                    |
| Q22 | Cross-store triple ambiguity                                                          | `DEFAULT` integrity finding (`source_reference_ambiguous`), not a constraint; generic kinds are disjoint from legacy kinds by CHECK.                                                                                                |
| Q23 | ADR timing                                                                            | `DEFAULT` ADR 0028 written during implementation (M10A1/M10A2 pattern).                                                                                                                                                             |
| Q24 | `ON DELETE RESTRICT` from references and evidence                                     | `DEFAULT` yes (M10A2 Q15); inspect existing physical-delete paths first; stop and report if a legitimate one breaks.                                                                                                                |

## 23. Open items inherited (unchanged unless stated)

- M10A2 still open on PR #2: mutation proofs VM1–VM22, fresh-clone run, independent review, merge. **M10B
  implementation starts only after M10A2 is merged into `integration`.**
- Tech debt #15 (privacy / retention; audit purge execution disabled), #62, #63, #64, #65 (integrity worker job).
- Authenticated operator identity (M15): assurance stays `asserted`.
- Live Chargebee mutations M09/M10 not run; Chargebee incremental sync disabled; live Sugar verification pending.

## 24. Baseline at plan time (2026-10-14)

- Documentation-only change: this plan and the README status line. No code, schema or migration change.
- `prettier --check` on the changed files (recorded in the PR). Full `pnpm verify`, integration, runtime and Docker
  are not re-run for a documentation-only diff; the CI run on the PR head is the evidence. The authoritative code
  baseline is PR #2's CI: run `38510222639` (head `c9d4856`, all four jobs green) and run `38510972857` (head
  `1e41f16`, green).
