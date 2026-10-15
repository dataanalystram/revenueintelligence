# M10C — Account hierarchy + Person–Account affiliation (record)

- Status: **implementation complete, ready for independent review.** PR #32 (`m10c-impl` → `integration`), not
  merged. Mutation proofs VM1–VM21 recorded (see [Mutation proofs](#mutation-proofs)); independent review
  (`review-milestone`), owner approval and merge open (see [Remaining](#remaining)).
- Plan: [M10C plan](M10C-account-hierarchy-affiliation-plan.md) (plan PR #31, merge `598ab9c`); owner instruction of
  2026-10-14: the `DEFAULT` answers Q1–Q24 apply unless overridden.
- ADR: [0029 Account hierarchy, person–account affiliation and canonical 0.3](../adr/0029-account-hierarchy-person-affiliation.md)
- Base: `integration` at `598ab9c` (M10 sequence, after M10B); `main` untouched.
- Canonical version after M10C: **`0.3`** (`current`; `0.1`, `0.2` `supported`).
- These are engineering controls. **No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.**

## Scope delivered

| Area                 | Delivered                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hierarchy schema     | `companies.parent_company_id` (same-tenant composite `RESTRICT` FK, `companies_parent_not_self`, index) and `parent_company_origin`; `companies_hierarchy_guard` trigger (per-tenant lock, merged parent / cycle / 64-step ceiling refused) |
| Depth guardrail      | `CANONICAL_HIERARCHY_MAX_DEPTH` (1–50, default 10, start-up refusal); writer counts parent depth + 1 + subtree height                                                                                                                       |
| Authority / mapping  | authority fact `account_hierarchy` (`account_hierarchy_connection_id`, existing hashes unchanged); mapping targets `account.parent` (consequential, confirmed) and `person.affiliation`; `canonical_version_min` `0.3` publish gates        |
| Hierarchy writer     | `AccountHierarchyWriter`: source observations (second pass, unresolved issue, explicit clear vs absent, disappearance never unparents), operator `set` / `clear` / `release` (sticky human origin), refusals as interim issues              |
| Affiliation table    | `tenant_person_affiliations` (forced RLS, composite `RESTRICT` FKs, lifecycle CHECKs, one active row per pair, immutable endpoints / origin, terminal ended / merged, no `DELETE`, entity-index kind `person_affiliation`)                  |
| Affiliation writer   | `PersonAffiliationWriter`: projection of company links and `person.affiliation` (authoritative removal / stated end only), late-company creation, operator `add` / `end`; primary derived from `persons.company_id`                         |
| Merge                | `AccountHierarchyMergeParticipant` and the affiliation company participant (always wired); new `PersonMergeParticipant` port (`PERSON_MERGE_PARTICIPANTS`) invoked by the person merge                                                      |
| History / changes    | `company.parent_company_id` full value history; value-free history for affiliation status / period / role codes; change entity kind `person_affiliation`                                                                                    |
| Read model / views   | `AccountStructureReadModel` (ancestors, root, depth, bounded descendants, affiliations with derived `isPrimary`; audited); views `account_hierarchy_paths`, `person_affiliation_index` (`security_invoker`, `SELECT` only)                  |
| CLI                  | `account:hierarchy show / set / clear / release`, `person:affiliations`, `person:affiliation add / end` (JSON, identifiers / codes / dates only; exit 2 on refusal)                                                                         |
| Canonical `0.3`      | catalogue with optional hash members (`0.1` / `0.2` hashes unchanged), explicit adoption with dry-run features, new tenants at `0.3`, writers / operator entry / publishes gated (`canonical_version_too_low`)                              |
| Security / integrity | policy v4 (`canonical.human_entry` → `operator`, `data.account_structure.read`), audit vocabulary, six interim issue kinds, manifests, data-subject link, six integrity checks                                                              |
| Migration / rollback | `20270105120000_m10c_account_hierarchy_affiliation` (no backfill) and its down-script (ten refusal branches, exact M10B restore)                                                                                                            |
| Runtime              | `scripts/verify-runtime.d/88-account-hierarchy-affiliation.sh` (V22)                                                                                                                                                                        |

## Definition of done

| Item                                                                       | State                                                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Migration + down-script (up / rerun / down-refusal / restore / re-apply)   | done (V21, CI integration)                                                                                |
| V1–V21 tests                                                               | done (see [Tests](#tests)); VM11 retirement test and V19 self-parent CHECK assertion added after VM1–VM11 |
| V22 runtime script `88-account-hierarchy-affiliation.sh`                   | done (CI runtime job)                                                                                     |
| Format, lint, typecheck, boundaries, unit, integration, runtime, docker    | CI (see [Evidence](#evidence))                                                                            |
| ADR 0029, this record, README status, E3 candidate note, tech-debt entries | done; tech debt #74–#79 added, #72 updated (`docs/tech-debt.md`)                                          |
| Mutation proofs VM1–VM21                                                   | done (see [Mutation proofs](#mutation-proofs)); one test gap found (VM11) and closed                      |
| Fresh-clone run                                                            | CI (see [Evidence](#evidence)); local fresh clone not possible (sandbox memory, no Docker)                |
| Independent review, owner approval, merge                                  | **open**                                                                                                  |

## Plan vs actual (deviations)

| #   | Deviation                                          | Why                                                                                                                                                                                                                 |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | One active row per pair by trigger + per-pair lock | the partial unique index `… WHERE status = 'active'` is not expressible in the Prisma schema without schema-guard drift; `app_person_affiliation_guard` refuses a second active row (`affiliation_active_exists`)   |
| D2  | `app_tenant_advisory_key(uuid, text, text)`        | new `IMMUTABLE` invoker SQL helper with the same key as `advisoryLockKey`, so trigger and writer share one lock (V19 asserts equality)                                                                              |
| D3  | Operator reason is a code token                    | `^[a-z][a-z0-9_]{1,63}$`, audit details only; the plan's bounded secret-scanned text is not supported (a code carries no personal data or secret; tech debt #79)                                                    |
| D4  | `person.affiliation` as a relationship on person   | natural key (person, company); id-bearing affiliation objects not mapped and no production `person_affiliation` reference writer (no connector supplies them; tech debt #75)                                        |
| D5  | Group roll-up deferred                             | the read model is structural only; derived group ownership belongs to the products module (Q23; tech debt #74)                                                                                                      |
| D6  | Operator refusals not logged to stdout             | returned (exit 2) and audited `failed`; logging them broke the CLI's JSON output (found by runtime script 88, run `38666973882`; fixed in `24a3a5f`). Source refusals are recorded as issues and logged (code only) |
| D7  | Merge inheritance that would cycle is skipped      | a parentless survivor does not inherit a loser parent that descends from it; `hierarchy_cycle_refused` names both ids (case not covered by the plan)                                                                |
| D8  | Extra read-only views                              | `account_hierarchy_paths`, `person_affiliation_index` (`security_invoker`, `SELECT` only, classified)                                                                                                               |
| D9  | No issue for source vs human affiliation           | a source observation leaves a human row untouched but records no issue (plan §3.2; tech debt #76)                                                                                                                   |
| D10 | M10C migration cases in their own suite            | `migrations-m10c.int.spec.ts`, helpers in `test/support/migrations.ts` (tech debt #72, partly addressed)                                                                                                            |
| D11 | VM7, VM8, VM11 split into two variants each        | the plan's wording fits two code paths each (writer vs pure rule, runtime vs static check, retirement vs absence)                                                                                                   |

## Tests

All paths under `apps/api/`.

| #   | Where (test name)                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | `src/modules/domain/canonical/account-structure.spec.ts` (`decideParentChange` incl. subtree height and human override, property test over random forests, affiliation decisions, period / role codes)                                   |
| V2  | `test/context/account-hierarchy.int.spec.ts` › V2 (self-parent / origin CHECKs, composite FK, merged parent, 64-step ceiling)                                                                                                            |
| V3  | `account-hierarchy.int` › V3 (direct and long cycles by raw SQL; two concurrent sessions crossing, three rounds; concurrent operator writes)                                                                                             |
| V4  | `account-hierarchy.int` › V4; `src/platform/config/load-config.spec.ts` (default 10, bounded 1–50)                                                                                                                                       |
| V5  | `account-hierarchy.int` › V5 (second pass, unresolved issue, explicit clear vs absent, tombstones, retirement never unparents (VM11), disabled below 0.3); `test/sources/account-structure-sync.int.spec.ts` › V5 (Sugar run end to end) |
| V6  | `account-hierarchy.int` › V6 (set / clear / release, one audit event each, sticky human origin, capability and reason-code refusals)                                                                                                     |
| V7  | `account-hierarchy.int` › V7 (full history rows, `relationship_changed` provenance, history parity)                                                                                                                                      |
| V8  | `account-hierarchy.int` › V8 (children, survivor-under-loser, cycle-on-merge, depth overshoot, lineage); `test/context/person-affiliations.int.spec.ts` › V8 (company and person merge participants)                                     |
| V9  | `person-affiliations.int` › V9 (link projection, `person.affiliation`, authoritative removal, absence ends nothing, human rows, renewal, derived primary, late company, operator add / end)                                              |
| V10 | `person-affiliations.int` › V10 (one active row per pair, CHECKs, terminal states, immutable endpoints / origin, no `DELETE`, entity index)                                                                                              |
| V11 | `account-hierarchy.int` › V11; `person-affiliations.int` › V11 (raw SQL as the app role)                                                                                                                                                 |
| V12 | `account-hierarchy.int` › V12 (ancestors / root / depth / descendants, bounded truncation, audited reads, view); `person-affiliations.int` › V12. Group ownership not built (D5)                                                         |
| V13 | `person-affiliations.int` › V13 (no name, email or role label in history, issues, change records, audit details, logs)                                                                                                                   |
| V14 | `canonical.spec.ts`, `version-features.spec.ts` (unit); `test/tenancy/migrations-m10c.int.spec.ts` › V14; `test/governance/account-structure-governance.int.spec.ts` › V14 / V15 (dry run, `1.0`)                                        |
| V15 | `account-hierarchy.int` › V15; `person-affiliations.int` › V15; `account-structure-sync.int` › V15 / V16; `account-structure-governance.int` (reference gated below 0.3)                                                                 |
| V16 | `account-structure-sync.int` › "V16: the new authority column; existing versions keep their hash…"                                                                                                                                       |
| V17 | `account-structure-governance.int` › V17 (clean tenant; six planted findings; security event; nothing repaired)                                                                                                                          |
| V18 | `security.spec.ts` (policy v4 pins), `src/modules/tenancy/security/authorized-writes.spec.ts` (S2: `canonical.human_entry` only on the M10C operator methods)                                                                            |
| V19 | `migrations-m10c.int` › V19 (privileges incl. views, classification, data-subject link, composite FKs, CHECKs = code incl. `companies_parent_not_self`, allow-list, lock key)                                                            |
| V20 | `account-structure-sync.int` › V20 (fake Sugar at 0.2 and 0.3: identical accounts, references, lines, run quality); existing M6–M10B suites green with new tenants at 0.3 (`218f596`, `9254316`)                                         |
| V21 | `migrations-m10c.int` › V21 (no backfill, rerun, ten down-script refusals, exact M10B restore, re-apply); `migrations.int` rollback chain                                                                                                |
| V22 | `scripts/verify-runtime.d/88-account-hierarchy-affiliation.sh`                                                                                                                                                                           |

Q22 (`ON DELETE RESTRICT`): `account-hierarchy.int` › "Q22: physical deletes under ON DELETE RESTRICT".

## Q22 findings

The M2 physical-delete paths (`PrismaCompanyRepository.delete`, `PrismaPersonRepository.delete`) are called only
from the isolation test; no production path deletes a company or person. A company with children or affiliations
refuses deletion with `InvalidReferenceError`; an unreferenced company can still be deleted. A person with an
affiliation refuses deletion with the **raw** foreign-key error (not translated; tech debt #77). Ingested companies
were already undeletable since M10A2. No legitimate path breaks, so work did not stop (plan §9).

## Known gaps / judgment calls

- V12 group ownership roll-up is not built (D5, tech debt #74).
- No production `person_affiliation` reference writer (D4, tech debt #75); `affiliation_reference_parity` is tested
  with references written through `SourceReferenceService.observe` directly.
- V20: the explicit 0.2 / 0.3 parity test uses the Sugar fake; the Chargebee suites run unchanged with new tenants
  at 0.3 but there is no separate Chargebee 0.2 / 0.3 parity test.
- Reference retirement is exercised by the VM11 test through `retireAbsentWithin` (HubSpot companies); the Sugar
  sync test's "disappearance" step does not reach retirement, because only Chargebee declares
  `referenceRetirement: 'accepted_full_read'`.
- VM18: if the trigger fires under the operator writer (writer validation broken), the operator receives a raw
  Prisma error (`P2039`), not a `GovernanceError` (tech debt #78).
- Live Sugar / Chargebee regression: not run (no approved secrets in this environment).

## Rollback caveat

The dev/staging down-script refuses while any M10C data class exists: a parent or parent origin, an affiliation, a
`person_affiliation` reference or change record, M10C value-history rows or conflict kinds, an authority version
naming a hierarchy connection, **any adoption of `0.3`**, and audit events using the M10C vocabulary. Because new
tenants adopt `0.3` at provisioning, any database that provisioned a tenant or adopted `0.3` after M10C cannot be
rolled back by the down-script. Production is forward-fix only; tenant-level rollback is adoption back to `0.2`
(parents and affiliations kept and readable, writes refused, nothing unparented).

## Evidence

CI on PR #32 (GitHub Actions, workflow `CI`; jobs: lint/typecheck/boundaries/unit, integration (Testcontainers),
runtime, docker):

| Run           | Head      | Result                                                                                                                                                                                                     |
| ------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `38652844575` | `dfcd87f` | **all four jobs ✅** (phase-1 head: schema, migration, down-script, manifests; attempt 2); jobs lint `116159847133`, integration `116159813409`, runtime `116159811037`, docker `116159847783`             |
| `38661523274` | `9254316` | **all four jobs ✅** (phase-2 head: writers, merge participants, CLI, integrity, unit tests); jobs lint `116183656685`, integration `116183656395`, runtime `116183656803`, docker `116183656666`          |
| `38666973882` | `43100e9` | lint / unit, integration, docker ✅; runtime ❌ only on the script-88 operator check (refusal warning on CLI stdout) → fixed in `24a3a5f` (D6)                                                             |
| `38668037349` | `24a3a5f` | **all four jobs ✅** (phase-3a tests and runtime script 88; the reviewed head of the mutation proofs); jobs lint `116204365577`, integration `116204365216`, runtime `116204365539`, docker `116204365488` |

The phase-3c commits (VM11 test, V19 self-parent assertion, ADR 0029, this record, README / tech-debt / E3 notes)
are verified by the final run listed in the PR #32 description.

**Fresh-clone run.** Every CI job checks the branch out fresh and runs `pnpm install --frozen-lockfile` and the full
verification, so the final run in the PR description is recorded as the fresh-clone run. A local fresh clone was
not run: the sandbox has no Docker and not enough memory for a full install, typecheck and integration run.

## Mutation proofs

Plan §19: break → the named test fails for that reason → restore → green.

**How they ran (CI).** Each mutation was applied on its own throwaway branch `mut/m10c-vmN` cut from `m10c-impl`
`24a3a5f`, with `.github/workflows/ci.yml` replaced — on that branch only — by a "Mutation proof" workflow that runs
`pnpm install --frozen-lockfile` and then only the guarding tests (`vitest run <spec> -t "<describe>"`, unit config
or the Testcontainers integration config; every guard step `if: always()`). Each branch had a throwaway draft PR into
`integration`. **Restore / green:** the unmutated head is the restore; the full CI run `38668037349` on `24a3a5f` is
green, and the VM11 test was run on the unmutated head first (PR #57). No mutation was ever committed to
`m10c-impl`. PRs #33–#58 were closed unmerged and every `mut/m10c-*` branch deleted.

| #             | Mutation                                                                                    | Guarding test(s)                         | PR / run / job                     | Failing assertion                                                                                                                                                       | Result                |
| ------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| VM1           | `companies_hierarchy_guard` trigger dropped                                                 | V3; V19                                  | #33 `38668814376` / `116206808272` | V3 cycles: promise resolved instead of rejecting; V3 crossing sessions: `expected 'ok' to be 'hierarchy_cycle'`; V19 trigger list mismatch                              | killed                |
| VM2           | advisory lock removed from the trigger                                                      | V3 (concurrent)                          | #35 `38668817063` / `116206817034` | V3 "two concurrent sessions crossing": `expected 'ok' to be 'hierarchy_cycle'` (other V3 tests green, as expected)                                                      | killed                |
| VM3           | parent FK single-column (`REFERENCES companies(id)`)                                        | V11; V19                                 | #37 `38668819556` / `116206825839` | V11 cross-tenant UPDATE resolved instead of `23503`; V19 FK definition mismatch                                                                                         | killed                |
| VM4           | affiliation company FK single-column                                                        | V11; V19                                 | #39 `38668824501` / `116206842233` | V11 cross-tenant INSERT resolved instead of `23503`; V19 composite-FK mismatch                                                                                          | killed                |
| VM5           | `companies_parent_not_self` CHECK dropped                                                   | V2                                       | #41 `38668824749` / `116206843049` | V2 self-parent UPDATE resolved. V19 stayed green then (not required by the plan); a V19 definition assertion was added in phase 3c as a second guard                    | killed                |
| VM6           | writer ignores the depth guardrail                                                          | V4                                       | #43 `38668828735` / `116206856449` | V4 default 10: the depth-11 child was parented; V4 configured guardrail: resolved instead of rejecting                                                                  | killed                |
| VM7           | writer ignores subtree height                                                               | V4 (V1 stays green: pure rule unchanged) | #45 `38668833328` / `116206873203` | V4 configured guardrail counting subtree height: resolved instead of `hierarchy_depth_exceeded`                                                                         | killed                |
| VM7b          | `decideParentChange` drops subtree height                                                   | V1 unit; V4                              | #47 `38668836018` / `116206879434` | V1 "counts the parent depth and the child subtree height…" and the property test (`expected 2 ≤ 1`); V4 configured guardrail                                            | killed                |
| VM8           | operator `set` / `clear` / `release` skip the runtime capability assert                     | V6 (V18 stays green: static check)       | #49 `38668839008` / `116206888937` | V6 "needs canonical.human_entry": a source-sync context's `set` resolved and wrote                                                                                      | killed                |
| VM8b          | `set` typed and asserted for `canonical.source_sync`                                        | V18 unit; V6                             | #51 `38668840631` / `116206893599` | V18 "canonical.human_entry is accepted only by the M10C operator methods"; V6 all three tests (`InvalidAuthorizedContextError`)                                         | killed                |
| VM9           | operator `set` / `clear` skip `audit.record`                                                | V6                                       | #52 `38668848383` / `116206920319` | V6 set / clear / release: `expected length 4, got 3`; V6 reason code: 8 events, expected 9                                                                              | killed                |
| VM10          | source write ignores the `account_hierarchy` authority                                      | V5 (sync)                                | #54 `38668848432` / `116206919855` | after the authority is lost the parent was still written (expected null)                                                                                                | killed                |
| VM11          | `retireAbsentWithin` unparents the children of a company whose reference it retires         | V5                                       | #55 `38668851974` / `116206930077` | **survived — test gap**: no M10C test drove reference retirement with a parented child (the Sugar run never retires)                                                    | survived → test added |
| VM11 test     | the new V5 retirement test on the unmutated head                                            | V5                                       | #57 `38669248938` / `116208189673` | green (4/4), as required                                                                                                                                                | green                 |
| VM11 re-proof | the new V5 retirement test with the VM11 mutation                                           | V5                                       | #58 `38669252315` / `116208202065` | "retiring a parent reference … never unparents its children (VM11)": `parent_company_id: null`. Test committed to `m10c-impl` in phase 3c                               | killed after fix      |
| VM11b         | an absent parent value treated as an explicit clear (ingestion)                             | V5 (writer); V5 (sync)                   | #56 `38668856389` / `116206943663` | V5 "explicit clear unparents…; an absent value … change nothing": expected the parent, got null; sync V5 likewise                                                       | killed                |
| VM12          | sticky-human rule removed from `decideParentChange`                                         | V6; V1 unit                              | #34 `38668815835` / `116206812944` | V6 source disagreement applied; V1 "a human value is sticky…": `{outcome:'apply'}` ≠ `{outcome:'human_override'}`                                                       | killed                |
| VM13          | `AccountHierarchyMergeParticipant` removed from `COMPANY_MERGE_PARTICIPANTS`                | V8                                       | #36 `38668818538` / `116206822060` | all three V8 hierarchy merge tests                                                                                                                                      | killed                |
| VM14          | a person observation without company links ends every active source affiliation             | V9                                       | #38 `38668825591` / `116206845531` | V9 "absence never ends…": `expected [] to deeply equal [Array(1)]`                                                                                                      | killed                |
| VM15          | `GRANT DELETE ON tenant_person_affiliations TO lip_app`                                     | V10; V19                                 | #40 `38668824219` / `116206841082` | V10 app-role DELETE resolved instead of rejecting; V19 privileges `[ …(6) ]` ≠ `[ …(5) ]`                                                                               | killed                |
| VM16          | affiliation value history records values                                                    | V13                                      | #42 `38668828126` / `116206853981` | V13 `history.every(h => !h.values_recorded && h.old_value === null…)` false                                                                                             | killed                |
| VM17          | `0.3` gate skipped (`accountStructureEnabled` always true, `requireAccountStructure` no-op) | V15 (three entry points)                 | #44 `38668830873` / `116206863666` | hierarchy V15 operator write resolved; affiliation V15 `[{…},{…}]` ≠ `[]`; V5 below 0.3 parent written                                                                  | killed                |
| VM18          | writer validation disabled entirely — **positive control**                                  | V3, V11 stay green                       | #46 `38668834038` / `116206872919` | **all database-level V3 / V11 tests green as planned** (trigger and FKs refuse alone); one writer test red: the operator gets raw Prisma `P2039`, not `hierarchy_cycle` | as planned            |
| VM19          | integrity ignores a planted cycle                                                           | V17                                      | #48 `38668838355` / `116206886857` | V17 findings missing the cycle                                                                                                                                          | killed                |
| VM20          | `0.2` catalogue also gets the `0.3` hash members                                            | V14 unit; V14 integration                | #50 `38668842212` / `116206899223` | `0.2: expected '1f080b98…' to be 'db7c0fc2…'` (unit and integration)                                                                                                    | killed                |
| VM21          | down-script refusal on affiliations removed                                                 | V21                                      | #53 `38668845859` / `116206910800` | V21 affiliation plant: promise resolved `[ …(30) ]` instead of rejecting                                                                                                | killed                |

Notes: VM7 and VM8 show the layering — a writer-only mutation leaves the pure-rule unit test (V1) green and a
runtime-only mutation leaves the static test (V18) green; the integration tests kill both, and the variants VM7b /
VM8b show V1 and V18 kill what they are built for. VM14 used the most direct reading of "ended on non-authoritative
absence". VM17 has three guards because the gate has three entry points. VM18's single red test sits inside the V3
describe but asserts the writer's own refusal code; the database refused (tech debt #78 records the optional
translation).

## Remaining

- Independent review (`review-milestone`), owner approval, merge to `integration`.
- Group roll-up (#74); id-bearing affiliations and the production reference writer (#75); affiliation disagreement
  issue (#76); person delete translation (#77); trigger-error translation (#78); free-text reasons (#79).
- Integrity worker job (tech debt #65, inherited); data-quality store (M10L) to take over the interim issue kinds.
