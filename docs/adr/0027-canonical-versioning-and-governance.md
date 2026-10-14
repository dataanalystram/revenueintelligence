# ADR 0027: Canonical versioning and governance — adoption, modules, governed registries, entity index, value history, mapping lifecycle, integrity (Milestone 10A2)

- Status: **implemented, in review** (PR #2 `m10a2-impl` → `integration`; not merged)
- Date: 2026-10-14
- Plan: [M10A2 plan](../milestones/M10A2-canonical-versioning-governance-plan.md) (owner defaults Q1–Q21 apply)
- Record: [M10A2 record](../milestones/M10A2-canonical-versioning-governance.md)
- Builds on: ADR 0020 (versioned source mapping and authority), ADR 0026 (security foundation)
- Candidate: revises E6 (versioning and migration) as candidate revision R2 (explicit adoption; mapping-lifecycle
  storage)
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.

## Context

Before M10A2 the canonical schema evolved by migration plus ADR with no recorded canonical version; tenants had no
module settings; there was no generic store for governed documents (data policy, signal types, metrics, …); no
polymorphic reference anchor; no value history; and a mapping was "published" only implicitly (latest version
wins). The M10 plan (D1–D6, F1–F5) requires all of these before the first canonical business entity (M10B).

## Decision

1. **Canonical model versions.** `canonical_model_versions` holds `MAJOR.MINOR` labels compared numerically
   (`0.10 > 0.9`). During implementation only `0.x` exists; `1.0` is refused by the named CHECK
   `canonical_model_versions_pre_freeze`. M10A2 publishes `0.1` only (status `current`); a trigger keeps exactly
   one `current` version.
2. **Explicit tenant adoption.** `tenant_canonical_adoptions` is an append-only chain per tenant (privilege +
   trigger). Every existing tenant gets a `baseline` `0.1` row written by the migration (actor
   `system:migration:m10a2`, no audit event — a migration must not forge hash-chain entries, Q4). New tenants adopt
   the current version inside `TenantRegistryService.provision`, covered by the `tenant.provision` audit event
   (`new_tenant`). Adoption is explicit for every version during `0.x` (Q2): forward to any `current` / `supported`
   newer version, backward only to the immediately previous MINOR (`rollback`), with an expected-current guard and a
   dry run. Writers read the adopted version and fail closed (`canonical_version_unknown`) without one (Q19).
3. **Modules are independent of adoption.** A global `canonical_modules` catalogue (nine modules, all unavailable
   in M10A2, Q16), tenant current state with optimistic version, and an append-only setting-event history.
   Dependencies, required-by, minimum canonical version and availability are enforced; `ModuleGate` refuses writes
   for a disabled module (audited `denied`, `module_disabled`). Adoption never changes module settings and a module
   change never touches the adoption chain.
4. **Governed registries.** One generic, immutable versioned store for six kinds; only `data_policy` has a document
   schema in M10A2 (others refused `registry_kind_not_available`, Q8). Publication needs the base version and the
   content hash printed by the dry run (Q11); a projection of current entries follows each publication. The data
   policy has its own capability (`config.data_policy.publish`, Q9), refuses raw retention and enabling disabled
   classes, and bounds `days` (Q10). `RetentionPolicyProvider` resolves `policy ?? product default`; the
   audit-purge report reads `security_audit` retention from it (`tenantRetention`). Purge execution stays disabled.
5. **Tenant entity index.** `tenant_entity_index` (`company`, `person`, `product` by key, `subscription`, Q12) is
   maintained only by `SECURITY DEFINER` triggers owned by the NOLOGIN role `lip_entity_indexer` (Q13), which has
   rights on the index only (an RLS policy scoped to that role allows its insert/delete); identity updates are
   refused; the app role can read but never write it. Polymorphic columns reference the index by `(tenant_id, id)`
   or `(tenant_id, key)`, so a cross-tenant reference is impossible even with raw SQL.
   There is **no FK between the index and the entity tables**: tenant equality of an index row with its entity comes
   from the index trigger copying `NEW.tenant_id`, which the entity insert already passed under RLS.
6. **Value history.** One append-only table, written by the single writers in the same transaction as the
   projection and change record, for six fields: `company.name` and `subscription.state`, `starts_at`,
   `ends_at`, `product_key`, `quantity` (Q14 as amended at review: `company.customer_status` has no value history
   and keeps manifest history `none`); anchored in the index with `ON DELETE RESTRICT` (Q15). Columns classified sensitive produce value-free rows unless the data policy allows values.
7. **Richer change records.** Origin, derivation, canonical version, schema snapshot hash and the transforms
   **declared** by the mapping field (ADR 0020 closed set); change-type and cause CHECKs widened to the E5 sets
   (Q18).
8. **Mapping lifecycle (Q5, Q6).** Mapping version rows stay immutable (M10A1). State lives in the append-only
   `tenant_source_mapping_lifecycle` (`published → superseded | retired`, `superseded → retired`; nothing leaves
   `retired`; dense `seq`; at most one `published` per connection — all enforced by a trigger), read through the
   security-invoker view `tenant_source_mapping_states`. Drafts (`draft → validated`) live in the mutable
   `tenant_source_mapping_drafts`; any edit returns a draft to `draft` (trigger); publication is refused
   (`mapping_not_validated`) unless the draft's validation stamp (snapshot, authority, adopted version) is still
   current. Sync reads the **published** version; with none (e.g. after retirement) it is refused
   `mapping_not_published`. The legacy `mappings-publish --file` path is kept (validate + publish in one
   transaction). The lifecycle is backfilled as "latest wins".
9. **Integrity verification.** Per-tenant, read-only checks (orphans, missing index rows,
   adoption/module/lifecycle consistency, privilege manifest, missing audit references); with `--execute` the run
   is recorded (append-only) with one audit event; findings raise a security event and are never repaired. The CLI
   exists; the worker job and automatic schedule are deferred (see Consequences).
10. **Audit references without foreign keys.** The five `audit_event_id` columns of the new tables (adoptions,
    module setting events, registry versions, mapping lifecycle, integrity runs) carry **no FK** to
    `tenant_audit_events`: an FK would block the (approved-later) audit purge. The pointer is written in the same
    transaction as the audit event, and integrity check `audit_reference_missing` flags a dangling pointer. A purge
    anchor exempts only rows whose own timestamp (`adopted_at`, `occurred_at`, `published_at`, `started_at`) is before
    the latest anchor's cutoff plus a 5-minute skew tolerance; newer rows are still checked.
11. **Security integration.** Policy v2 (seven new capabilities, `source_sync` cannot adopt), new audit actions and
    reason codes, every new write through `AuthorizedContext`, classification and privilege manifests (views
    included) cover every new table, view and column; the schema guard asserts them.

## Consequences

- M10B can publish `0.2` and its first entity on top of adoption, modules, index and history.
- There is no dedicated tenant-mismatch check: under RLS it could never fire. A cross-tenant index row planted by the
  owner (bypassing the trigger) surfaces as an `entity_index_orphan` in the tenant that holds the index row only;
  the other tenant stays clean. Recorded as a deviation.
- `tenant_context_changes` predates the index; its entity columns are a historical log that outlives physical
  deletes and are exempt from the polymorphic-FK guard (with actor columns, which name an actor, not an entity).
- Deferred: the integrity worker job (the automatic schedule is off until M10M anyway); mutation proofs VM1–VM22;
  audit purge execution (tech debt #15).
