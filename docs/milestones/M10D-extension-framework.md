# M10D — Extension framework foundation (record)

- Status: **implementation in review.** PR #60 (`m10d-impl` → `integration`, draft), not merged. Final CI run and
  mutation proofs VM1–VM27 to be recorded (see [Evidence](#evidence) and [Mutation proofs](#mutation-proofs));
  independent review, owner approval and merge open (see [Remaining](#remaining)).
- Plan: [M10D plan](M10D-extension-framework-plan.md) (plan PR #59, merge `5344d2e`); owner instruction of
  2026-10-14: the `DEFAULT` answers Q1–Q34 apply unless overridden.
- ADR: [0030 Extension framework and canonical 0.4](../adr/0030-extension-framework.md)
- Base: `integration` at `5344d2e` (M10 sequence, after M10C `ce9b052`); `main` untouched.
- Canonical version after M10D: **`0.4`** (`current`; `0.1`–`0.3` `supported`); module `extension` available at
  `0.4`, disabled by default.
- These are engineering controls. **No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.**

## Scope delivered

| Area                 | Delivered                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extension registry   | registry kind `extension` (fields, objects, relationships; one key namespace, `src_` reserved); classification required, object ≥ field, credential-like words refused; X1–X5 incl. stored-value narrowing probes, R-X6; 2 MiB guardrail (Q3)          |
| Value storage        | `tenant_extension_values` (13 types, typed CHECK `tenant_extension_values_typed`, money minor + ISO 4217, integer scale 0, JSON depth / size / secret-key CHECKs), `tenant_extension_value_items` (replace-on-change, `DELETE` on items only)          |
| Custom objects       | `tenant_custom_records` (entity-index kind `custom_record`, generic reference kind `custom_record`, natural key ≤ 3 fields, lifecycle, records-per-object guardrail); product parents operator-only                                                    |
| Custom relationships | `tenant_custom_relationships` (both ends in the entity index; cardinality by writer lock + guard trigger, REPEATABLE READ refused; authoritative removal ends, absence never ends)                                                                     |
| Writers              | `ExtensionValueWriter`, `CustomRecordWriter`, `CustomRelationshipWriter`: typed parsing, secret-like refusal, guardrails, restricted withheld, `ext:<key>` change tokens, opt-in value history, sticky operator values                                 |
| Mapping              | entry kinds `attribute` (un-reserved), `custom_object`, `custom_relationship`, `capture`; Q14 single owner connection; limits 1,000 fields / 1 MiB (existing hashes unchanged, Q4); source-sync extension writes in their own transactions             |
| Capture              | `sources extension-capture-draft`: registry additions (`internal` / `operational`, uses `[display]`), sensitive fields refused; mapping publish never writes the registry                                                                              |
| Use enforcement      | `ExtensionUseGuard` on every reader; dependency-cruiser boundary (no extension input to products / identity); `not_evidence_of` floor; `EvidenceRelation.fact` and `EvidenceLinkWriter` refusal                                                        |
| Merge                | `ExtensionMergeParticipant` (company and person ports, runs regardless of gate state): loser-only copied, equal skipped, differing → `extension_value_conflict`; record parents re-pointed; references follow lineage                                  |
| Read models / CLI    | `ExtensionReadModel` (batch loading, lineage in one batch), `ExtensionReadModel.records` / `.record` (keyset pagination); `extension registry / values / value / records / record / relationship` (JSON, exit 2 on refusal, audited confidential flag) |
| Canonical `0.4`      | catalogue with optional hash members (`0.1`–`0.3` hashes unchanged), explicit adoption, `modulesStranded` on rollback (Q19), new tenants at `0.4` with the module disabled, writers / publishes / commands gated                                       |
| Security / integrity | policy v5 (`data.extension.read`), audit vocabulary, `human_override_active` reason code, R-DP-EXT data-policy check, manifests (`classifiedBy: 'registry'`), eight integrity checks; `insertContextChange` moved to tenancy                           |
| Migration / rollback | `20270112120000_m10d_extension_framework` (no backfill) and its down-script (refusal branches, exact M10C restore, re-apply)                                                                                                                           |
| Runtime              | `scripts/verify-runtime.d/89-extension-framework.sh` (V25)                                                                                                                                                                                             |

## Definition of done

| Item                                                                      | State                                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Migration + down-script (up / rerun / down-refusal / restore / re-apply)  | done (V24, `migrations-m10d.int.spec.ts`)                                              |
| V1–V24 tests                                                              | done (see [Tests](#tests)); V9 unit + runtime only (deviation D15)                     |
| V25 runtime script `89-extension-framework.sh`                            | done (CI runtime job)                                                                  |
| Format, lint, typecheck, boundaries, unit, integration, runtime, docker   | CI — final run `38743598001` (see [Evidence](#evidence))                               |
| ADR 0030, this record, README status, tech-debt entries                   | done; tech debt #82–#88 added (`docs/tech-debt.md`)                                    |
| Mutation proofs VM1–VM27                                                  | done: 27 proofs, all killed or held (see [Mutation proofs](#mutation-proofs))          |
| Fresh-clone run                                                           | CI (every job checks out fresh); local fresh clone not possible (no Docker in sandbox) |
| E4 candidate note; `canonical-extension-and-source-mapping.md` superseded | open                                                                                   |
| Independent review, owner approval, merge                                 | review PASS WITH FINDINGS (see [Review](#review)); owner approval and merge **open**   |

## Plan vs actual (deviations)

| #   | Deviation                                               | Why                                                                                                                                                                              |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | No left-prefix text index on `value_text`               | an expression / partial index is not expressible in the Prisma schema without schema-guard drift; typed indexes for the other types (tech debt #85)                              |
| D2  | Source-sync extension writes in separate transactions   | the canonical ingestion transaction of a record commits first; a failed extension write does not roll it back                                                                    |
| D3  | Closed module gate skips writes, counted, no audit      | the run counts skipped extension writes; no per-record audit event (tech debt #84)                                                                                               |
| D4  | Merge participant runs regardless of gate state         | a merge never strands values or records on a loser, even below `0.4` or with the module disabled                                                                                 |
| D5  | JSON `null` = explicit empty                            | a `null` clears; an absent key changes nothing                                                                                                                                   |
| D6  | Custom-record product parents operator-only             | no mapping entry sets a `product` parent                                                                                                                                         |
| D7  | Capture drafts `internal` / `operational` / `[display]` | narrower than the plan's display / analytics; the operator widens a definition in the registry dry run                                                                           |
| D8  | Q14 owner check without cross-connection locking        | **resolved by #83 hardening (PR #110):** owner table `tenant_custom_object_owners` (PK `(tenant, object_key)`) claimed in the publish transaction; writer owner check; see below |
| D9  | `insertContextChange` moved to tenancy                  | the extension module writes change records without importing `context` infrastructure (boundary rule)                                                                            |
| D10 | Capture draft on the sources CLI                        | `sources extension-capture-draft` (script `extension:capture-draft`) reads the source schema snapshot                                                                            |
| D11 | Record CLI shape                                        | `records list / show`, `record create / update / retire / reactivate`, repeatable `--set`, `--clear`, no date flags                                                              |
| D12 | CLI `--file` caps raised                                | canonical-registry CLI 8 MiB (registry ceiling), mapping-source CLI 4 MiB (indented 1 MiB mapping document); fixed in `9ad1797`                                                  |
| D13 | `human_override_active` added                           | the plan said "reused", but it was not in `AUDIT_REASON_CODES`                                                                                                                   |
| D14 | Guardrail counts include retired definitions            | keys never disappear                                                                                                                                                             |
| D15 | V9 (capture) has no integration spec                    | covered by unit tests (capture draft, captured keys, `sensitive_by_name` refusal) and runtime script 89, which runs the real CLI against a real schema snapshot                  |

Q4 limits as built: 1,000 fields per object, 1 MiB mapping document, existing mapping hashes unchanged; extension
registry cap 2 MiB (database ceiling 8 MiB); mapping-source CLI file cap 4 MiB; canonical-registry CLI file cap 8 MiB.

## Tests

All paths under `apps/api/`.

| Suite                                                | Covers                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| unit specs (domain, registry, mapping, CLI args)     | V1 registry validation / X1–X4 / R-X6; V2 value parsing; Q4 mapping limits and pinned hashes (V23); V17 catalogue; V21 policy v5 (S1) and `canonical.human_entry` scope (S2); X5 narrowings                                                                                                                  |
| `test/extension/extension-values.int.spec.ts`        | V4 / V13 database-level tests as the app role (typed CHECK, scale / currency / identity guards, no DELETE; cross-tenant targets, references, fields, record parents and relationship ends refused, RLS and entity index hold; commit `57da078`), V5 writer, V10 operator paths, V12 value history, V18 gates |
| `test/extension/custom-records.int.spec.ts`          | V7 custom objects (identity, parent, lifecycle, guardrail)                                                                                                                                                                                                                                                   |
| `test/extension/custom-relationships.int.spec.ts`    | V8 cardinality (writer + trigger, concurrent sessions, REPEATABLE READ refused), endpoints, removal                                                                                                                                                                                                          |
| `test/extension/extension-merge.int.spec.ts`         | V11 merge participant (company and person)                                                                                                                                                                                                                                                                   |
| `test/extension/extension-read-model.int.spec.ts`    | V14 use guard / `not_evidence_of`, V16 privacy scan, V19 batch loading and lineage                                                                                                                                                                                                                           |
| `test/governance/extension-governance.int.spec.ts`   | V3 publish end to end (X2 / X4 / X5 / R-X6, guardrails, credential-like), R-DP-EXT, V15 DDL-capture event trigger test, V18 adoption / `modulesStranded`, V20 integrity                                                                                                                                      |
| `test/tenancy/migrations-m10d.int.spec.ts`           | V17 catalogue / hash pins, V22 schema guard, V15, V24 migration up / rerun / down-refusals / exact restore / re-apply                                                                                                                                                                                        |
| `test/sources/extension-sync.int.spec.ts`            | V6 source attribute sync, V7 / V8 source custom objects and relationships                                                                                                                                                                                                                                    |
| `scripts/verify-runtime.d/89-extension-framework.sh` | V25 runtime: adopt `0.4`, enable module, publish registry, operator set / show / release, record create / list, capture draft (also the V9 witness, D15), no values in logs                                                                                                                                  |

## Bugs the tests caught

| Bug                                                                                                                               | Found by                   | Fix       |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------- |
| X5 missed a fixed `currency` added or changed on a money field (stored values in another currency stayed and failed to re-parse)  | V3 governance tests        | `2f3bb39` |
| CLI `--file` caps below the registry / mapping caps (1 MiB file vs 2 MiB registry, and vs a 1 MiB mapping document once indented) | Q3 / Q4 governance tests   | `9ad1797` |
| Read model resolved reference lineage one target at a time (N+1)                                                                  | V19 read-model query count | `b4b1e51` |
| Governance tests declared custom-object fields weaker than the object (the registry rightly refused them)                         | V3 / runtime capture-draft | `0e8f96f` |

## Load evidence

Measured during implementation at the database / read-model level (not CI):

| Probe                                        | Result                      |
| -------------------------------------------- | --------------------------- |
| Shape                                        | 500 fields × 1,000 accounts |
| Insert of 500,000 values                     | 55 s                        |
| Batch read of 100 targets (read-model query) | 341 ms                      |
| X5 narrowing / R-X6 tightening probes        | ≤ 9 ms each                 |

A full writer-path load test (writers, change records, value history and audit at that volume) was not run;
deferred as tech debt #82. Partitioning stays deferred (Q30, tech debt #86).

## Evidence

CI on PR #60 (GitHub Actions, workflow `CI`; jobs: lint/typecheck/boundaries/unit, integration (Testcontainers),
runtime, docker):

| Run           | Head      | Result                                                                                                                                                                                             |
| ------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `38688781224` | `5189657` | **all four jobs ✅** (phase-1 head: schema, migration, down-script, manifests, registry kind); jobs lint `116269635246`, integration `116269635314`, runtime `116269635257`, docker `116269635075` |
| `38698286584` | `6a98f06` | **all four jobs ✅** (phase-2 head: writers, mapping kinds, merge, read models, CLI, X5, integrity, unit tests)                                                                                    |
| `38743598001` | `33e7756` | **all four jobs ✅** (phase-3 head: V1–V25 incl. V4/V13 database tests, V6–V8 source sync, M1 race test, review fixes, runtime script 89, this record)                                             |

**Fresh-clone run.** Every CI job checks the branch out fresh and runs `pnpm install --frozen-lockfile` and the full
verification. A local fresh clone was not run: the sandbox has no Docker.

## Mutation proofs

Plan §22: break → the named test fails for that reason → restore → green. Each mutation ran on its own throwaway
PR against `m10d-impl` (PRs #61–#91, closed unmerged); run ids are GitHub Actions runs.

**Summary.** 27 proofs. 24 mutations were killed by the existing tests; VM24 is a positive control and held (the
database refuses with the writer checks off). VM16 and the capability half of VM17 survived the existing tests and
are killed by the test patch landed in `f26336d` (capture draft refuses `sensitive_by_name`; the writer refuses a
context without `canonical.human_entry`). The control run #91 showed both patches green on unmutated code.

| VM      | Mutation                                                                                                          | Guarding test(s) that failed                                                                                                                                     | PR      | Run                       | Result                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------- | ------------------------------------------------------------------ |
| VM1     | Typed CHECK `tenant_extension_values_typed` removed from the migration                                            | `migrations-m10d.int.spec.ts` V22 closed-set / typed CHECKs                                                                                                      | 61      | 38739322449               | killed                                                             |
| VM2     | Parser ignores the configured array-items guardrail                                                               | `extension-values.int.spec.ts` V5 / V2 guardrails; unit `extension-values.spec.ts` V2 array                                                                      | 62      | 38739328039               | killed                                                             |
| VM3     | Parser ignores the configured JSON size / depth guardrails                                                        | `extension-values.int.spec.ts` V5 / V2 guardrails; unit V2 json                                                                                                  | 63      | 38739332798               | killed                                                             |
| VM4     | Fields-per-target guardrail never fires                                                                           | `extension-governance.int.spec.ts` V3 guardrails; unit `extension.spec.ts` guardrails                                                                            | 64      | 38739340025               | killed                                                             |
| VM5     | Use guard always allows                                                                                           | `extension-read-model.int.spec.ts` V19 / V14 (two tests); unit use guard (two tests)                                                                             | 65      | 38739344239               | killed                                                             |
| VM6     | Value target FK without `tenant_id`                                                                               | `migrations-m10d.int.spec.ts` V22 composite FKs                                                                                                                  | 66      | 38739349944               | killed                                                             |
| VM7     | Reference-value FK without `tenant_id`                                                                            | `migrations-m10d.int.spec.ts` V22 composite FKs                                                                                                                  | 67      | 38739353802               | killed                                                             |
| VM8     | Relationship `to` end FK without `tenant_id`                                                                      | `migrations-m10d.int.spec.ts` V22 composite FKs                                                                                                                  | 68      | 38739359635               | killed                                                             |
| VM9     | `classification_required` check removed                                                                           | `extension-governance.int.spec.ts` V3 Q12 / classification; unit control 8                                                                                       | 69      | 38739365084               | killed                                                             |
| VM10    | R-X6 sensitivity-rank clause disabled                                                                             | unit X2 / R-X6; `extension-governance.int.spec.ts` V3 R-X6                                                                                                       | 70      | 38739462424               | killed                                                             |
| VM11    | Secret-like refusals removed from the parser                                                                      | unit V2 secret-like; `extension-values.int.spec.ts` V5 / V16 secret-like                                                                                         | 71      | 38739467341               | killed                                                             |
| VM12    | Q12 credential-like definition check removed                                                                      | unit `extension.spec.ts` Q12 credential-like                                                                                                                     | 72      | 38739473650               | killed                                                             |
| VM13    | Restricted values stored (source and operator)                                                                    | `extension-values.int.spec.ts` V5 / V16 restricted                                                                                                               | 73      | 38739478705               | killed                                                             |
| VM14    | R-X2 (value / item type change) disabled                                                                          | unit X2; `extension-governance.int.spec.ts` V3 X1–X4 (rerun with a corrected filter)                                                                             | 74 / 88 | 38739485213 / 38740129593 | killed                                                             |
| VM15    | X5 never probes stored values                                                                                     | `extension-governance.int.spec.ts` V3 X5                                                                                                                         | 75      | 38739488926               | killed                                                             |
| VM16    | Capture draft drops the `sensitive_by_name` refusal                                                               | none at first; unit `extension-values.spec.ts` capture draft (Q20) with the patch                                                                                | 76 / 89 | 38739493877 / 38740136055 | survived → killed by test patch `f26336d`                          |
| VM17    | `assertAuthorized(canonical.human_entry)` removed from the value writer (round 1 also removed the operator audit) | audit half: `extension-values.int.spec.ts` V10 one audit event per call; capability half: none at first, then V10 "needs canonical.human_entry …" with the patch | 77 / 90 | 38739499380 / 38740144077 | audit killed; capability survived → killed by test patch `f26336d` |
| VM18    | Sticky-human branch disabled in `observeSource`                                                                   | `extension-values.int.spec.ts` V10 sticky / disagreement                                                                                                         | 78      | 38739513936               | killed                                                             |
| VM19    | Absence / failed run / missing field clears a value (three readings)                                              | failed and absence: `extension-sync.int.spec.ts` V6; missing: unit `source-mapping-extension.spec.ts` engine                                                     | 79      | 38740428924               | killed (all three)                                                 |
| VM20    | Merge overwrites the survivor's differing value (no conflict)                                                     | `extension-merge.int.spec.ts` V11 company merge                                                                                                                  | 80      | 38740607482               | killed                                                             |
| VM21    | Relationship guard trigger not created                                                                            | `custom-relationships.int.spec.ts` V8 adversarial (two tests); `migrations-m10d.int.spec.ts` V22 trigger list                                                    | 81      | 38739806320               | killed                                                             |
| VM22    | `GRANT DELETE` on values                                                                                          | `migrations-m10d.int.spec.ts` V22 grant matrix                                                                                                                   | 82      | 38739810569               | killed                                                             |
| VM23    | Module / 0.4 gate always `ok`                                                                                     | `extension-governance.int.spec.ts` V18; `extension-values.int.spec.ts` V18                                                                                       | 83      | 38739817181               | killed                                                             |
| VM24    | Positive control: writer validation off (field checks, reference check, one_to_one checks)                        | expected green: V22 and V8 adversarial green; the database still refused the one_to_one second edge (the writer surfaced raw `P2002`)                            | 84      | 38740606713               | control held                                                       |
| VM25    | 0.3 catalogue reads the current lists                                                                             | unit `canonical.spec.ts` V1 hashes; `migrations-m10d.int.spec.ts` V17                                                                                            | 85      | 38739825026               | killed                                                             |
| VM26    | Down-script drops the extension-values refusal                                                                    | `migrations-m10d.int.spec.ts` V24                                                                                                                                | 86      | 38739831048               | killed                                                             |
| VM27    | Integrity check `extension_value_restricted` never matches                                                        | `extension-governance.int.spec.ts` V20                                                                                                                           | 87      | 38739835526               | killed                                                             |
| control | No mutation; `7101756` plus both test patches                                                                     | none (patches green on real code)                                                                                                                                | 91      | 38740195289               | patches green                                                      |

## Review

Independent review of `f26336d`: **PASS WITH FINDINGS** — no blockers, two majors, eight minors.

| Finding                                                                            | Severity | Resolution                                                                                                    |
| ---------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| M1 merge × extension-writer race (values stranded on a loser, or the merge aborts) | major    | fixed: writers and the merge participant lock targets before reading (`63e4b91`)                              |
| M2 record claimed V4 / V13 coverage that was not in the branch                     | major    | fixed: V4 / V13 database-level tests landed (`57da078`); record corrected; V9 recorded as deviation D15       |
| m1 Q14 single-owner check without a cross-connection lock (D8, #83)                | minor    | **fixed (#83 hardening, PR #110, `a620ff9`):** structural owner table + claim in publish + writer owner check |
| m2 `CustomRecordReadModel` named in the docs but not in the code                   | minor    | fixed: docs name `ExtensionReadModel.records` / `.record`                                                     |
| m3 capture draft ran without a capability or audit event                           | minor    | fixed: `config.mapping.draft` via `authorizeOperator`, one counts-only audit event                            |
| m4 one_to_one replace ended the old edge, then rejected                            | minor    | fixed: the taken-target check runs first; the old edge stays (test in V8)                                     |
| m5 extension sync opens a transaction per relationship statement                   | minor    | deferred (#87)                                                                                                |
| m6 guard trigger does not check relationship ends against the definition           | minor    | deferred (#88)                                                                                                |
| m7 unknown source role silently became the declared role                           | minor    | fixed: counted as `custom_relationship_role_unmapped` (edge keeps the declared role, plan §5.3)               |
| m8 release refused on a retired field                                              | minor    | fixed: release (clears the override, writes no value) allowed on a retired field                              |

## Tech debt #83 hardening (Q14 single owner, PR #110)

Design in ADR 0030, addendum "tech debt #83". Migration `20270126120000_m10d_custom_object_owner` adds
`tenant_custom_object_owners` (primary key `(tenant_id, object_key)`, composite same-tenant RESTRICT FKs, state CHECK,
guard trigger, forced RLS, no DELETE grant, backfill that refuses two existing owners, refusing down-script).
`SourceMappingsService.publish` claims owner rows in ascending `object_key` order inside the publish transaction (a
concurrent claimer hits the primary key → `custom_object_owned_by_other_connection`); retire / a version that no
longer maps an object releases (`connection_id = NULL`); `CustomRecordWriter` reads the owner row `FOR SHARE` and
rejects a non-owner source write (`object_not_owned`).

**Deviation.** Release sets `connection_id = NULL` on the single row instead of `ended_at` + a partial unique index on
active rows: a partial unique index is not expressible in the Prisma schema without schema-guard drift (same reason as
D1). Claim history is in the `mapping.publish` / `mapping.retire` audit details.

**Tests.** `test/sources/custom-object-owner.int.spec.ts` (control, race, release / audit, no deadlock, stale writer
× 2 orders, integrity `custom_object_owner_drift`),
`test/tenancy/migrations-m10d-owner.int.spec.ts` (schema guard, raw SQL as the app role, migration on M10E data,
down-script), `test/extension/custom-records.int.spec.ts` "tech debt #83 (Q14)".

| Run           | Head      | Result                                                                                                                          |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `38821831803` | `4614146` | race test only, on unfixed code: **failed as intended** (both concurrent publications committed)                                |
| `38823851901` | `a620ff9` | **all four jobs ✅** (fix); integration 51 files / 775 tests incl. every extension, custom-\*, owner, m10c–m10e migration suite |

| VM  | Mutation (throwaway branch off `a620ff9`)                        | Guarding test that failed                                                                                                                                                  | PR  | Run           | Result |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------- | ------ |
| VM1 | publish skips owner rows (no claim / release)                    | `custom-object-owner` control, race (2 fulfilled), release / audit, no deadlock                                                                                            | 111 | `38824469658` | killed |
| VM2 | primary key `(tenant_id, object_key)` dropped (non-unique index) | `custom-object-owner` race (2 fulfilled); `migrations-m10d-owner` "one owner per (tenant, object)"                                                                         | 112 | `38824471823` | killed |
| VM3 | claim sort removed (document order)                              | `custom-object-owner` no deadlock (loser got `P2034` deadlock instead of the Q14 refusal)                                                                                  | 113 | `38824476583` | killed |
| VM4 | `CustomRecordWriter` owner check removed                         | `custom-records` "tech debt #83 (Q14)" (non-owner write `created`)                                                                                                         | 114 | `38824480175` | killed |
| VM5 | writer owner row read without `FOR SHARE` (off `4f740b1`)        | `custom-object-owner` "stale writer" writer first: the retire committed while the owner write was in flight; release first: the stale owner write finished without waiting | 118 | `38830363220` | killed |

All five PRs closed unmerged and their branches deleted (verified with `git ls-remote`). No survivors.

**Independent re-review (PR #110 at `c8bcd91`): PASS WITH FINDINGS — no Major.** All six acceptance criteria met
(race reproduced with two independent sessions; PK-enforced single owner on every path; sound lock order, no deadlock
path; VM1–VM4 meaningful; migration / down-script / Prisma parity correct; not closed on app validation alone).
Findings and resolution:

| Finding                                                                         | Severity | Resolution                                                                                                                                        |
| ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1 writer `FOR SHARE` (stale-writer guarantee) untested; that mutation survived | minor    | **fixed (`7fc3001`):** two barrier tests ("stale writer", both orders, waits proven in `pg_locks`); VM5 (`FOR SHARE` removed) killed              |
| m2 no runtime parity check between held owner rows and published mappings       | minor    | **fixed (`4f740b1`):** integrity check 32 `custom_object_owner_drift` (down-script's two queries), clean → pass, planted drift reported both ways |
| n1 lock-wait count was cluster-wide                                             | nit      | fixed (`7fc3001`): scoped to the test's own sessions (`pg_blocking_pids`)                                                                         |
| n2 FK violation during claim escaped as a raw DB error                          | nit      | fixed (`4f740b1`): mapped to `mapping_invalid` / `invalid_entity` (no test: unreachable after validation in the same transaction)                 |
| n3 guard trigger is not an authorization boundary                               | nit      | fixed: ADR 0030 addendum §1 sentence                                                                                                              |
| n4 `plantCustomObjectOwners` interpolated SQL / replica mode                    | nit      | not changed (test-only, inputs sanitised / DB-generated); left as is                                                                              |
| n5 writer does not compare `provenance.mappingVersion` with the owner's version | nit      | not changed: same pre-#83 semantics for every entity, not a Q14 issue                                                                             |

Final CI for the re-review head is recorded on PR #110 (all four jobs).

## Known gaps / judgment calls

- Full writer-path load test not run (#82).
- Q14 single owner: **resolved** by the #83 hardening (PR #110) — the database enforces one owner per custom object; see "Tech debt #83 hardening".
- Extension sync reads the relationship registry once per statement (#87); the guard trigger does not check relationship ends against the definition (#88).
- A run with the module gate closed counts skipped writes but writes no per-record audit (#84).
- Live Sugar / Chargebee regression: not run (no approved secrets in this environment).

## Rollback caveat

The dev/staging down-script refuses while any M10D data class exists, **including any adoption of `0.4`**. Because
new tenants adopt `0.4` at provisioning, any database that provisioned a tenant or adopted `0.4` after M10D cannot be
rolled back by the down-script. Production is forward-fix only; tenant-level rollback is adoption back to `0.3`
(data kept and readable, writes refused, `modulesStranded: ['extension']` listed).

## Remaining

- Tech debt #83 (review m1): **resolved** by PR #110 (fixed, not accepted as debt); Ram approves the `main` merge as usual.
- E4 candidate note and the `canonical-extension-and-source-mapping.md` superseded note (plan §23).
- Tech debt #82–#88; integrity worker job (#65, inherited); data-quality store (M10L) for per-record rejections.
