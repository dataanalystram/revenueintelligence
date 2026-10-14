# M10A2 — Canonical Versioning & Governance Foundation (record)

- Status: **implementation in review.** PR #2 (`m10a2-impl` → `integration`), not merged. Mutation proofs VM1–VM22,
  the fresh-clone run and the independent review are still open (see [Remaining](#remaining)).
- Plan: [M10A2 plan](M10A2-canonical-versioning-governance-plan.md); owner instruction of 2026-10-14: the `DEFAULT`
  answers Q1–Q21 apply unless overridden.
- ADR: [0027 Canonical versioning and governance](../adr/0027-canonical-versioning-and-governance.md)
- Base: `integration` (M10 sequence); `main` untouched.
- Canonical version after M10A2: **`0.1`** (baseline recorded; no new MINOR, Q21).
- These are engineering controls. **No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.**

## Scope delivered

| Area                    | Delivered                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical versions      | `canonical_model_versions` (`0.1` current), numeric ordering, `1.0` refused by `canonical_model_versions_pre_freeze`, one-current-version trigger                                                       |
| Adoption                | append-only `tenant_canonical_adoptions`; `baseline` rows by the migration; `new_tenant` at provisioning; forward / previous-MINOR rollback with dry run; `canonical adopt` / `canonical history` CLIs  |
| Modules                 | nine-module catalogue (all unavailable, Q16), tenant state + append-only setting events, dependency / required-by / minimum-version rules, `ModuleGate`; `canonical modules` / `canonical module`       |
| Registries, data policy | generic immutable registry store + projection; `data_policy` schema; hash-confirmed publish (Q11); `RetentionPolicyProvider`; audit-purge report reads the policy; `registry-show` / `registry-publish` |
| Entity index            | trigger-maintained `tenant_entity_index` (`lip_entity_indexer`, SECURITY DEFINER, fixed `search_path`); polymorphic composite FKs                                                                       |
| Value history           | append-only, same transaction, seven fields (Q14), restricted-history suppression, `ON DELETE RESTRICT` anchor                                                                                          |
| Change records          | origin, derivation, canonical version, snapshot hash, declared transforms; widened CHECKs                                                                                                               |
| Mapping lifecycle       | append-only lifecycle + `tenant_source_mapping_states` view + mutable drafts; draft → validated → published → superseded → retired; sync refused without a published version; draft/states/retire CLIs  |
| Integrity verification  | read-only checks, recorded runs (`--execute`), security event, never repaired; `security integrity-verify`                                                                                              |
| Security                | policy v2 (seven capabilities), audit actions and reason codes, manifests (classification, privilege — views included), schema-guard extensions                                                         |

## Definition of done

| Item                                                                    | State                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Two migrations + down-scripts (up / rerun / down-refusal / restore)     | done (V22, CI integration)                                                    |
| V1–V22 tests                                                            | done (V15 added in this round; restricted history: unit only, see deviations) |
| V23 runtime script `86-canonical-governance.sh`                         | done (CI runtime job)                                                         |
| Format, lint, typecheck, boundaries, unit, integration, runtime, docker | CI (see [Evidence](#evidence))                                                |
| ADR 0027, this record, README status, E6 R2 note, tech-debt entries     | done                                                                          |
| Mutation proofs VM1–VM22                                                | **open**                                                                      |
| Fresh-clone run, independent review, owner approval, merge              | **open**                                                                      |

## Plan vs actual (deviations)

| #   | Plan                                                         | Actual                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `audit_event_id` columns reference `tenant_audit_events`     | **No FK** on the five `audit_event_id` columns (adoptions, module setting events, registry versions, mapping lifecycle, integrity runs): an FK blocks the audit purge (M10A1 purge execution tests failed). Pointer written in the same transaction; integrity check `audit_reference_missing` added, exempt when a purge anchored the chain |
| D2  | Polymorphic-FK guard covers every `<p>_kind` + `<p>_id` pair | Exemptions: actor columns (`actor`, `updated_by` — name a security actor, not an entity) and `tenant_context_changes.entity` (M6 historical log that outlives physical deletes; ADR 0027)                                                                                                                                                    |
| D3  | Integrity detects a planted tenant mismatch                  | The composite FK makes a pure mismatch impossible; a mismatch planted by the owner (test DB) shows as **orphan + missing index row**, which V17 asserts                                                                                                                                                                                      |
| D4  | New-tenant adoption at provisioning                          | Implemented inside `TenantRegistryService.provision`, covered by the `tenant.provision` audit event (no separate adoption event)                                                                                                                                                                                                             |
| D5  | One `current` canonical version                              | Enforced by a trigger (not only by seed data)                                                                                                                                                                                                                                                                                                |
| D6  | Index maintained by `lip_entity_indexer`                     | Forced RLS on the index needed an RLS policy scoped to `lip_entity_indexer` for its insert/delete (owner-of-function insert under RLS)                                                                                                                                                                                                       |
| D7  | Change records carry transforms                              | Transforms recorded are those **declared** by the mapping field (ADR 0020 closed set), not inferred per value                                                                                                                                                                                                                                |
| D8  | Mapping draft errors                                         | Sync with no published version (after retirement) is refused with the existing `mapping_not_published` code (no new code)                                                                                                                                                                                                                    |
| D9  | V12 restricted history at integration level                  | Restricted-history suppression (sensitive field → value-free row unless the policy allows values) is proven by unit tests only; at integration level V13 scans every value-history row for sensitive values                                                                                                                                  |
| D10 | VM19 must fail V17                                           | Re-planned as a positive control (the composite FK independently guarantees tenant equality, D3); to be recorded with the mutation proofs                                                                                                                                                                                                    |
| D11 | Classification / privilege manifests cover tables            | Also cover the view `tenant_source_mapping_states`; the privilege guard (runtime check and schema guard) now inspects views (`relkind IN ('r','v')`)                                                                                                                                                                                         |
| D12 | Integrity verification: CLI + worker job (Q17)               | CLI only; the worker job is deferred (tech debt #65) — the automatic schedule is off until M10M anyway                                                                                                                                                                                                                                       |
| D13 | Runtime V23: draft → publish → retire → sync refused         | Runtime script 86 retires the published mapping of script 70's Sugar tenant and proves sync refused; the full draft → validate → publish path runs in V15 (integration, fake Sugar), not at runtime                                                                                                                                          |

## Tests

| #                          | Where                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| V1, V8, V9 (unit), V19     | `src/modules/domain/canonical/*.spec.ts`, `src/modules/domain/security/*.spec.ts`, `authorized-writes.spec.ts` |
| V2, V3, V10, V16, V20, V22 | `test/tenancy/migrations.int.spec.ts`                                                                          |
| V3–V14, V17, V18           | `test/governance/governance.int.spec.ts`                                                                       |
| V15                        | `test/governance/mapping-lifecycle.int.spec.ts` (fake Sugar)                                                   |
| V21                        | existing Sugar / Chargebee / M6–M10A1 integration suites (unchanged)                                           |
| V23                        | `scripts/verify-runtime.d/86-canonical-governance.sh`                                                          |

## Evidence

CI on PR #2 (GitHub Actions, workflow `CI`; jobs: lint/typecheck/boundaries/unit, integration (Testcontainers),
runtime, docker):

| Run           | Head      | Result                                                                                                   |
| ------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `38504805023` | `2d4f9a5` | failure (lint escape, schema guard, protection seed, M10A1 audit-purge execution)                        |
| `38506523129` | `3575b0c` | integration ✅, runtime ✅, docker ✅; unit ❌ (privilege manifest lacked the view) — fixed in `3f19b62` |
| _final_       | _see PR_  | recorded in the PR body                                                                                  |

## Remaining

- Mutation proofs VM1–VM22 (plan §19), recorded with failing output.
- Fresh-clone run; independent review; owner approval; merge to `integration`.
- Integrity worker job (tech debt #65).
