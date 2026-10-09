# Canonical Architecture v1 Candidate — E6: Versioning and migration (M9E-F, M9E-G)

Part of the [Canonical Architecture v1 Candidate](CANDIDATE.md). Status: **candidate for review**. Everything here is
`PROPOSED FOR V1 CANDIDATE` unless labelled. Today there is **no canonical model version**; the schema evolves by
migration plus ADR (`IMPLEMENTED TODAY`).

## 1. What is versioned, and by whom

| Artifact                                                 | Versioned by                                       | Today                                 |
| -------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| **Canonical model** (core + modules)                     | platform (`MAJOR.MINOR`, e.g. `1.0`, `1.1`, `2.0`) | not present                           |
| Entity definition                                        | platform, integer per entity within the model      | not present                           |
| Tenant extension registry                                | tenant (immutable versions, base version)          | not present (designed in E4)          |
| Product model                                            | tenant (immutable versions, K1–K4)                 | `IMPLEMENTED TODAY`                   |
| Source schema snapshot                                   | captured per connection (hash)                     | `IMPLEMENTED TODAY`                   |
| Mapping version                                          | tenant per connection (immutable, base version)    | `IMPLEMENTED TODAY` (published only)  |
| Authority version                                        | tenant (immutable)                                 | `IMPLEMENTED TODAY`                   |
| Signal type / metric / action-type registries            | tenant (immutable versions)                        | not present                           |
| Derivations (signal definitions, evaluators, generators) | platform/tenant `key + version`                    | evaluator version `IMPLEMENTED TODAY` |
| Adapter                                                  | code constant                                      | `IMPLEMENTED TODAY`                   |

## 2. Canonical model version semantics

- **MINOR (additive, compatible):**
  - a new optional module;
  - a new entity in a module;
  - a new **optional** field;
  - a new relationship;
  - a new value in an **open** code set (signal types, action types);
  - a new mapping target;
  - widening a constraint.
  - Existing mappings, rules and data stay valid without change.
- **MAJOR (breaking):**
  - removing or renaming a field or entity;
  - changing a field's meaning, type or identity rule;
  - making an optional field required;
  - narrowing a constraint;
  - removing a value from a **closed** canonical enum (for example `SubscriptionState`);
  - adding a value to a closed enum that existing logic must interpret (a new ownable state).
  - These need a migration plan, a compatibility window and tenant adoption.
- **Not a canonical version change:**
  - a tenant custom field, object or relationship (extension registry version);
  - a new product, product relationship or product model version;
  - a new mapping version, new connection or new connector kind;
  - a new adapter version;
  - a new tenant signal type or metric definition (registry data);
  - a new derivation version (versioned separately and cited in provenance);
  - data-quality policy changes.
- A genuinely new reusable business concept that passes the promotion test justifies a version change:
  - **MINOR** if added as an optional module or field;
  - **MAJOR** only if existing semantics change.

## 3. Compatibility

- Every mapping version, registry version and derivation declares `canonical_version_min` (the version it was
  validated against).
- The platform supports the **current MAJOR and the previous MAJOR** for at least one deprecation window, proposed as
  6 months or two MINOR releases, whichever is longer.
- **Deprecation:** deprecated fields and targets stay readable and writable during the window. Validation warns
  (`deprecated_target`) and publish refuses **new** usage after the window opens.
- **Tenant adoption:** an adoption record per tenant `(tenant, canonical_version, adopted_at, adopted_by, migration
run)`.
  - A tenant runs exactly one canonical version at a time.
  - New tenants start on the current version.
  - MINOR versions are adopted automatically, since they are additive. A tenant enables a new module explicitly.
  - MAJOR versions are adopted through the migration framework (§5).
- **Historical interpretation:** every change record carries `canonical_version` (E5).
  - Immutable records (signals, observations, snapshots, versioned documents) are always interpreted by the version
    they were written under.
  - Eligibility snapshots already replay from frozen inputs (`IMPLEMENTED TODAY`).

## 4. Mapping lifecycle (owner brief §20)

| State        | Meaning                                                                                                           | Mutability                                      | Today                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| `draft`      | stored draft (currently files); may be edited                                                                     | mutable                                         | files only                          |
| `validated`  | validated against a schema snapshot, authority version, registry version and canonical version; preview available | immutable content (a new edit returns to draft) | validation exists, state not stored |
| `published`  | in force for the connection (exactly one per connection)                                                          | immutable                                       | `IMPLEMENTED TODAY`                 |
| `superseded` | replaced by a newer published version; kept for provenance/replay                                                 | immutable                                       | implicit (latest wins)              |
| `retired`    | connection disabled/removed or canonical version no longer supported; cannot be republished                       | immutable                                       | not present                         |

- A published mapping is never mutated silently (`IMPLEMENTED TODAY`).
- Republishing requires the base version (`IMPLEMENTED TODAY`).
- When the canonical version changes, mapping compatibility is re-validated:
  - MINOR keeps mappings valid;
  - MAJOR produces mapping migration proposals (§5) that a human reviews and publishes as new versions. The old
    version stays `published` until then, within the compatibility window.

## 5. Canonical migration framework

```
current canonical version
  → migration plan (ADR + declarative steps)
  → preview (dry run on a tenant copy / shadow tables; no customer data changed)
  → impact analysis (affected entities, rows, mappings, registries, rules, derivations, snapshots, reports)
  → human approval (per tenant for MAJOR; platform-level for MINOR)
  → execution (batched, idempotent, resumable; change records with cause `migration`)
  → verification (invariants: row counts, hashes, referential checks, rule replay on samples)
  → publish (tenant adoption record moves to the new version)
  → audit (plan, approvals, preview results, verification evidence retained)
```

| Step         | Requirement                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan         | declarative steps (add field, backfill from X, promote extension key, split entity, map values); each step has a reverse step or is declared irreversible with a snapshot requirement                                                                                                                                                                                                                                     |
| Preview      | runs on a copy; produces the impact report; **never** writes customer data                                                                                                                                                                                                                                                                                                                                                |
| Impact       | counts per entity; mappings needing new versions (with generated proposals); rules/derivations needing version bumps; snapshots unaffected (frozen); reports/integrations affected                                                                                                                                                                                                                                        |
| Approval     | named approver, base version, timestamp; MAJOR requires per-tenant approval                                                                                                                                                                                                                                                                                                                                               |
| Execution    | per tenant inside `TenantDatabase` transactions (RLS); batched; checkpointed; resumable; no cross-tenant batch                                                                                                                                                                                                                                                                                                            |
| Verification | before/after counts (no loss, as the M7 legacy migration), hash comparisons, foreign-key and uniqueness checks, replay of a sample of eligibility/derivations under the new version with expected equality or a declared difference                                                                                                                                                                                       |
| Rollback     | **schema:** production policy stays forward-fix (down-scripts are dev/staging only, `IMPLEMENTED TODAY`). **Tenant data:** reversible steps run in reverse; irreversible steps restore from the pre-migration tenant snapshot taken by the plan. **Adoption:** the tenant's adoption record can return to the previous version while it is within the compatibility window, because the previous MAJOR is still supported |
| Audit        | migration run record (plan id, tenant, steps, counts, approvals, verification results), change records per touched row                                                                                                                                                                                                                                                                                                    |

A canonical change can never silently rewrite customer data. Every rewrite is planned, previewed, approved, logged
and verified.

## 6. Versioning of this candidate

- This document set is **Canonical Architecture v1 Candidate**. It is not v1.0.
- It becomes eligible for the **v1.0 freeze** only after:
  - M9C (file/S3) and M9D (warehouse/table) pressure-test it;
  - the relocated M9 plan §13.5 gate passes (owner decision 4).
- Changes found by M9C and M9D are applied as candidate revisions (`v1 candidate r2`, …) before the freeze.
