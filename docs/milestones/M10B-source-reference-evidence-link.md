# M10B — Generic SourceReference + EvidenceLink (record)

- Status: **implementation complete, ready for independent review.** PR #5 (`m10b-impl` → `integration`), not
  merged. Mutation proofs VM1–VM23 recorded (see [Mutation proofs](#mutation-proofs)); independent review
  (`review-milestone`), owner approval and merge open (see [Remaining](#remaining)).
- Plan: [M10B plan](M10B-source-reference-evidence-link-plan.md); owner instruction of 2026-10-14: the `DEFAULT`
  answers Q1–Q24 apply unless overridden.
- ADR: [0028 Generic source references, evidence links, provenance and canonical 0.2](../adr/0028-generic-source-references-evidence-links.md)
- Base: `integration` (M10 sequence, after M10A2); `main` untouched.
- Canonical version after M10B: **`0.2`** (`current`; `0.1` `supported`).
- These are engineering controls. **No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.**

## Scope delivered

| Area                  | Delivered                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic store         | `tenant_source_references` (kind `product` by key), index FKs by id and key, lifecycle + named retirement gate and not-legacy-kind CHECKs, identity-immutability trigger, no `DELETE` for `lip_app`       |
| Lifecycle rules       | pure domain `decideReferenceObservation` / `decideReactivation` / `decideRetirement` / `decideMerge`, shared with the company/person path (equivalence grid against the legacy rule)                      |
| Single writer         | `SourceReferenceService` (`observe`, `retireAbsentWithin`, `merge`, `applyDeclaredProductReferences`), `(actx, tx, input)`                                                                                |
| Declared product refs | projection inside product-model publish (add / retire / reactivate / re-point, change records, adapter `product_model`); migration backfill from each tenant's latest model (no change records)           |
| Evidence links        | append-only `tenant_evidence_links` (privilege + `app_refuse_change` trigger), link sets with supersession, `EvidenceLinkWriter` (relation catalogue, set rules, derivation, targets, module + 0.2 gates) |
| View                  | `source_reference_index` (`security_invoker`, `SELECT` only) over company / person / subscription / generic stores                                                                                        |
| Provenance            | `ProvenanceQueryService.show` + CLI `provenance show` (references, field change + value-free-aware history, current / superseded evidence, cited-by; one `provenance.read` audit event)                   |
| Change records        | `entity_key`, nullable `entity_id`, exactly-one / key-only-for-products CHECKs, kind `product`                                                                                                            |
| Canonical `0.2`       | catalogue with optional hash members (0.1 hash unchanged), explicit adoption with dry-run feature list, new tenants at `0.2`, writers gated (`canonical_version_too_low`)                                 |
| Security / integrity  | policy v3 (`canonical.evidence.link`, `data.provenance.read`), audit vocabulary, manifests, six integrity checks                                                                                          |
| Runtime               | `scripts/verify-runtime.d/87-source-references-evidence.sh` (V23)                                                                                                                                         |

## Definition of done

| Item                                                                     | State                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Migration + down-script (up / rerun / down-refusal / restore / re-apply) | done (V22, CI integration)                                                                 |
| V1–V22 tests                                                             | done (see [Tests](#tests)); V13 value-free / capability test added after VM18/VM19         |
| V23 runtime script `87-source-references-evidence.sh`                    | done (CI runtime job, 7/7 checks)                                                          |
| Format, lint, typecheck, boundaries, unit, integration, runtime, docker  | CI (see [Evidence](#evidence))                                                             |
| ADR 0028, this record, README status, plan §6 adapter note               | done                                                                                       |
| Mutation proofs VM1–VM23                                                 | done (see [Mutation proofs](#mutation-proofs)); two test gaps found (VM18, VM19) and fixed |
| Fresh-clone run                                                          | CI (see [Evidence](#evidence)); local fresh clone not possible (sandbox memory, no Docker) |
| Independent review, owner approval, merge                                | **open**                                                                                   |

## Plan vs actual (deviations)

| #   | Deviation                                | Why                                                                                                                                                                      |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Adapter name `product_model`             | the change-record adapter CHECK is `^[a-z0-9_]{1,32}$`; the plan's `product-model` is refused (found by CI, fixed in `05fda75`); plan §6 carries a note                  |
| D2  | Plain index instead of the partial index | `(tenant_id, system, object_type, state)` instead of `(tenant_id, system, object_type) WHERE state = 'active'` — expressible in the Prisma schema, no schema-guard drift |
| D3  | No separate `link_set_id` index          | the unique `(tenant_id, link_set_id, ordinal)` index serves set lookups                                                                                                  |
| D4  | Extra change-record index                | `(tenant_id, entity_kind, entity_key, ingested_at)` for key-identified history reads (provenance, integrity)                                                             |
| D5  | Signatures `(actx, tx, input)`           | S2 requires `AuthorizedContext` first on every write; the plan wrote `(tx, ctx, …)`                                                                                      |
| D6  | Merge semantics                          | `decideMerge` returns `merge` for a reference merged into a different survivor (re-points lineage), as the legacy merge path does; `refused` only for self-merge         |
| D7  | S22 test edit                            | `secret-ingestion.int.spec.ts` actor assertion scoped to `entity_kind <> 'product'` (`c52bd44`): product-model publish now writes operator product-reference changes     |
| D8  | Provenance API shape                     | one `show(actx, query)` returning references + field + evidence + cited-by, one audit event per call; classified as a write in S2 (it writes the audit event)            |
| D9  | Dry-run feature codes                    | `observed_generic_source_references`, `evidence_links`, `key_identified_change_records`; publish audit details gain `referencesAdded/Retired/Reactivated/Repointed`      |
| D10 | VM7 split (VM7 / VM7b)                   | the service acceptance check is backed by the same check in `decideRetirement`; the single-layer mutation is masked (defence in depth), so VM7b removes both             |

## Tests

| #       | Where (test name)                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1      | `src/modules/domain/canonical/source-reference.spec.ts` (lifecycle, legacy equivalence grid, property tests)                                                           |
| V2      | `source-references.int` › "V2: generic store constraints…", "V2: the database retirement gate…", "V2: identity columns are immutable…"                                 |
| V3      | `migrations.int` › M10B › "V3: declared rows equal the latest model per tenant…"                                                                                       |
| V4, V5  | `source-references.int` › "add → ref_added; remove → retired; re-add → reactivated…", "property: after a random publish sequence…"                                     |
| V6      | `source-references.int` › "insert, unchanged, newer, stale, tombstone…", "refuses an identity conflict…"                                                               |
| V7      | `source-references.int` › "retires only on accepted proven full runs…"                                                                                                 |
| V8      | `source-references.int` › "re-points to the survivor…"                                                                                                                 |
| V9      | `evidence-provenance.int` › "writes a valid set of the test catalogue…"; `evidence.spec.ts` (unit)                                                                     |
| V10     | `evidence-provenance.int` › "app role UPDATE / DELETE denied; owner UPDATE / DELETE refused by the trigger"                                                            |
| V11     | `source-references.int` › "raw SQL as the app role cannot bind a reference to another tenant…"; `evidence-provenance.int` › "refuses citing or naming another tenant…" |
| V12     | `source-references.int` › "V12: security_invoker view…" (+ RLS part of the V11 references test)                                                                        |
| V13     | `evidence-provenance.int` › "answers the E5 questions…", "value-free history rows never carry values; show refuses a context without data.provenance.read" (`3c3c248`) |
| V14     | `canonical.spec.ts`, `version-features.spec.ts` (unit); `migrations.int` › "V1: canonical_model_versions equals the code catalogue…"                                   |
| V15     | `source-references.int` › "at 0.1 observe / retire / merge are refused…"; `evidence-provenance.int` › "V15: at 0.1 the writer refuses…"                                |
| V16     | `source-references.int` › "exactly one of entity_id / entity_key…" (+ change-record asserts in the V4 test)                                                            |
| V17     | `evidence-provenance.int` › "a clean tenant passes; planted drift, ambiguity, change mismatch, unknown relation and invalid supersession…"                             |
| V18     | `security.spec.ts` (S1, `data.provenance.read` / `canonical.evidence.link` pinned in `3c3c248`), `authorized-writes.spec.ts` (S2); capability denials in the V13 test  |
| V19     | `migrations.int` schema guard (privilege matrix incl. the view, tenant-composite FKs, closed-set CHECKs), `manifests.spec.ts`                                          |
| V20–V21 | existing M6 / M7 / M8 / M9B / M10A1 / M10A2 integration suites, unchanged and green                                                                                    |
| V22     | `migrations.int` › M10B › "V22: the down-script refuses each M10B-only data class…"                                                                                    |
| V23     | `scripts/verify-runtime.d/87-source-references-evidence.sh`                                                                                                            |

## Known gaps / judgment calls

- `source_reference_index_parity` cannot be planted (the view is a union of the stores): V17 asserts it is present
  with zero findings.
- The writer's module gate is not exercised: `EVIDENCE_KIND_MODULES` is empty in M10B (no module-owned kind).
- V11 eligibility-snapshot evidence: only the FK refusal of a non-existent snapshot id (no cross-tenant snapshot is
  planted).
- V1, V14, V18 (unit), V19 (schema guard) and V20/V21 (regressions) are covered by existing or phase-2 suites, not
  new files.
- `migrations.int.spec.ts` now takes ~180 s for the file (was ~168 s); individual tests, not the file, are timed, so
  it does not fail, but it is close to the known 180 s hook-timeout flake zone.
- Live Chargebee TEST-site regression: not run (no approved secrets in this environment); live Sugar stays pending.

## Rollback caveat

The dev/staging down-script refuses while any M10B-only data class exists: observed references, references changed
after the backfill, evidence links, product change records, **any adoption of `0.2`**, and audit events using M10B
capabilities or actions. Because new tenants adopt `0.2` at provisioning and an explicit adoption writes a `0.2`
row, any database that provisioned a tenant or adopted `0.2` after M10B cannot be rolled back by the down-script.
Production is forward-fix only; tenant-level rollback is adoption back to `0.1` (data kept, writes refused).

## Evidence

CI on PR #5 (GitHub Actions, workflow `CI`; jobs: lint/typecheck/boundaries/unit, integration (Testcontainers),
runtime, docker):

| Run           | Head      | Result                                                                                                                                                                                                                         |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `38589719929` | (phase 2) | first attempt: integration hit the 180 s hook timeout and runtime "worker ran its shutdown hooks" failed once; both passed on re-run (flake)                                                                                   |
| `38594575948` | `c52bd44` | **all four jobs ✅** (phase-2 code head)                                                                                                                                                                                       |
| `38601508500` | `6802cd8` | **all four jobs ✅** (phase-3a tests; integration 566/566; runtime incl. script 87, 7/7)                                                                                                                                       |
| `38605952336` | `3c3c248` | **all four jobs ✅** after the VM18/VM19 test-gap fix (integration 567/567, 32 files; runtime 193 passed incl. script 87); jobs lint `115996754763`, integration `115996754752`, runtime `115996754686`, docker `115996754810` |
| FINAL_RUN     | FINAL_SHA | FINAL_RESULT                                                                                                                                                                                                                   |

**Fresh-clone run.** Every CI job checks the branch out fresh and runs `pnpm install --frozen-lockfile` and the full
verification, so the final run above is recorded as the fresh-clone run. A local fresh clone was not run: the
sandbox has no Docker and not enough memory for a full install, typecheck and integration run.

## Mutation proofs

Plan §19: break → the named test fails for that reason → restore → green.

**How they ran (CI).** Each mutation was applied by a script (exact replacement / dropped line / appended grant,
each required to match exactly once) on its own throwaway branch `mut/m10b-vmN` cut from `m10b-impl` `6802cd8`
(VM18–VM20 re-proofs from `3c3c248`), with the workflow replaced — on that branch only — by a targeted workflow
that runs `pnpm install --frozen-lockfile` and then only the guarding tests (`vitest run <spec> -t "<name>"`, unit
config or the Testcontainers integration config). Each branch had a throwaway draft PR into `m10b-impl` (CI runs
on `pull_request` only). **Restore / green:** the unmutated head is the restore; a control branch
`mut/m10b-control` (PR #6, run `38604266711`, job `115991010178`) ran every guard filter on the unmutated head —
all 24 guard steps green, each filter matching ≥ 1 test — and the full CI runs on `6802cd8` / the final head are
green. No mutation was ever committed to `m10b-impl`. PRs #6–#30 were closed unmerged and every `mut/m10b-*`
branch deleted.

| #    | Mutation                                                                                       | Guarding test(s)                    | PR / run / job                                                                    | Failing assertion                                                                                                                                                                                                           | Result           |
| ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| VM1  | reference → index FKs (by key and id) dropped                                                  | V11 references                      | #7 `38604272760` / `115991030156`                                                 | A naming B's key: "promise resolved `Result{ command: 'INSERT' }` instead of rejecting"                                                                                                                                     | killed           |
| VM2  | evidence subject → index FKs dropped                                                           | V11 evidence                        | #8 `38604276680` / `115991043526`                                                 | subject B: "promise resolved `Result{ command: 'INSERT' }` instead of rejecting"                                                                                                                                            | killed           |
| VM3  | evidence entity → index FKs dropped                                                            | V11 evidence                        | #9 `38604281191` / `115991058503`                                                 | evidence company B: "promise resolved `Result{ command: 'INSERT' }` instead of rejecting"                                                                                                                                   | killed           |
| VM4  | `evidence_change_id` FK single-column (unique index on `tenant_context_changes.id` added)      | V11 evidence; V19 tenant-FK guard   | #10 `38604288575` / `115991084019`                                                | V11: change record B "promise resolved … instead of rejecting"; V19 "foreign keys … include tenant_id": `expected [ Array(1) ] to deeply equal []`                                                                          | killed           |
| VM5  | `GRANT UPDATE, DELETE ON tenant_evidence_links TO lip_app`                                     | V10; V19 privilege matrix           | #11 `38604292436` / `115991095796`                                                | V10: expected `/permission denied/` but got "UPDATE on tenant_evidence_links is no…" (trigger); matrix ≠ manifest                                                                                                           | killed           |
| VM6  | `app_refuse_change` trigger on evidence links dropped                                          | V10 (owner path)                    | #12 `38604298072` / `115991114124`                                                | owner UPDATE "promise resolved `[]` instead of rejecting"                                                                                                                                                                   | killed           |
| VM7  | retirement-gate CHECK dropped + service acceptance check removed                               | V2 DB gate; V7                      | #13 `38604302952` / `115991130374`                                                | V2: "promise resolved `[]` instead of rejecting"; **V7 stayed green — masked by `decideRetirement`'s own acceptance check** (defence in depth, D10)                                                                         | killed (V2)      |
| VM7b | VM7 + `decideRetirement` acceptance condition removed                                          | V1 unit; V7; V2                     | #30 `38606197788` / `115997611864`                                                | unit "never for a run that is not accepted": `{ retire: true }` ≠ `{ retire: false, … }`; V7 `expected 2 to be +0`; V2 "promise resolved `[]`"                                                                              | killed           |
| VM8  | seen-but-rejected protection removed from `decideRetirement`                                   | V1 unit; V7                         | #14 `38604306156` / `115991141319`                                                | unit `{ retire: true }` ≠ `{ retire: false, reason: 'rejected' }`; V7 `expected 3 to be 2`                                                                                                                                  | killed           |
| VM9  | reactivation accepts a read older than the retirement / deletion time                          | V1 unit; V6                         | #15 `38604311145` / `115991159481`                                                | unit: legacy grid `[ …(5) ] ≠ []`, `'restore'` ≠ `'stale'`, `true` ≠ `false`; V6: `expected 'restore' to be 'stale'`                                                                                                        | killed           |
| VM10 | `not_legacy_kind` CHECK dropped                                                                | V2 constraints                      | #16 `38604316289` / `115991176030`                                                | named-CHECK lookup: `Cannot read properties of undefined (reading 'def')` (the kind CHECK still refuses legacy kinds)                                                                                                       | killed           |
| VM11 | identity-immutability trigger dropped                                                          | V2 identity; V8                     | #17 `38604320227` / `115991188861`                                                | identity UPDATE "promise resolved `[]` instead of rejecting"                                                                                                                                                                | killed           |
| VM12 | product-model publish skips the projection                                                     | V4; V17                             | #18 `38604325347` / `115991205627`                                                | V4: `expected [] to deeply equal [ [ 'pt-1', 'core', … ] … ]`; V17 clean tenant: `expected 'findings' to be 'passed'`                                                                                                       | killed           |
| VM13 | projection deletes removed references (DELETE granted) instead of retiring                     | V4; V19 privilege matrix            | #19 `38604330788` / `115991223662`                                                | V4: `expected undefined to match object { state: 'retired', … }`; matrix ≠ manifest                                                                                                                                         | killed           |
| VM14 | writer skips the relation catalogue                                                            | V9 unit + integration               | #20 `38604339234` / `115991255034`                                                | unit "production catalogue is empty": `[] ≠ [ …(4) ]`; V9 relation outside catalogue "promise resolved … instead of rejecting"                                                                                              | killed           |
| VM15 | writer validation disabled entirely (set validation + subject liveness) — **positive control** | V11 evidence stays green; V9 sanity | #21 `38604341463` / `115991262486`                                                | **V11 green as planned** (database refuses whatever the writer does); V9 fails (sanity: "promise resolved … instead of rejecting")                                                                                          | as planned       |
| VM16 | writers skip the 0.2 adoption gate                                                             | V15 references; V15 evidence        | #22 `38604344745` / `115991270725`                                                | observe at 0.1 "promise resolved `{ decision: 'create', … }` instead of rejecting"; writer at 0.1 "promise resolved … instead of rejecting"                                                                                 | killed           |
| VM17 | view without `security_invoker`                                                                | V12                                 | #23 `38604350108` / `115991289825`                                                | `reloptions` is `null` (assertion `toContain('security_invoker=true')` fails)                                                                                                                                               | killed           |
| VM18 | provenance `show` without the capability check                                                 | V13                                 | #24 first `38604355360` / `115991307753`; re-proof `38605961994` / `115996788221` | **first run survived — test gap** (capability only checked via the authorizer). Fixed in `3c3c248`; re-proof: foreign-capability `show` "promise resolved `{ …(4) }` instead of rejecting"                                  | killed after fix |
| VM19 | provenance returns values for value-free history rows                                          | V13                                 | #25 first `38604360145` / `115991327535`; re-proof `38605964201` / `115996796798` | **first run survived — test gap** (no catalogued field is sensitive, loop vacuous). Fixed in `3c3c248`; re-proof: `expected { …(5) } to not have property "oldValue"`                                                       | killed after fix |
| VM20 | `data.provenance.read` granted to `source_sync`                                                | V18 S1 unit; V13                    | #26 first `38604363694` / `115991339917`; re-proof `38605963228` / `115996792394` | first run: V13 failed but S1 unit stayed green (not pinned) → pinned in `3c3c248`; re-proof: S1 `[ 'operator', 'source_sync' ] ≠ [ 'operator' ]`; V13 `authz(TEST_RUN)` "resolved `AuthorizedContext` instead of rejecting" | killed           |
| VM21 | catalogue hash always includes the 0.2 members                                                 | V14 unit; V14 integration           | #27 `38604369048` / `115991355952`                                                | unit "stored 0.1 catalogue hash is reproduced": `'db7c0fc2…'` ≠ `'2fd4f7e5…'`; integration catalogue rows ≠ code                                                                                                            | killed           |
| VM22 | integrity ignores declared drift                                                               | V17                                 | #28 `38604373358` / `115991370615`                                                | findings `[ … ]` ≠ `ArrayContaining{ declared_reference_drift … }`                                                                                                                                                          | killed           |
| VM23 | down-script refusal on evidence links removed                                                  | V22                                 | #29 `38604378610` / `115991389510`                                                | evidence-links refusal: "promise resolved `[ …(17) ]` instead of rejecting"                                                                                                                                                 | killed           |

Notes: VM5 shows defence in depth (the append-only trigger still refused the app-role UPDATE; V10 fails because it
asserts the privilege layer). VM10's kind CHECK `IN ('product')` still refuses legacy kinds; the guard fails because
it asserts the named CHECK. VM7 is recorded with the masked first attempt and the full VM7b.

## Remaining

- Independent review (`review-milestone`), owner approval, merge to `integration`.
- Integrity worker job (tech debt #65, inherited).
- First production evidence relations (M10G / M10H); module-owned evidence kinds; evidence partitioning (deferred).
