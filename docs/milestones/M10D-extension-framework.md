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

| Area                 | Delivered                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension registry   | registry kind `extension` (fields, objects, relationships; one key namespace, `src_` reserved); classification required, object ≥ field, credential-like words refused; X1–X5 incl. stored-value narrowing probes, R-X6; 2 MiB guardrail (Q3) |
| Value storage        | `tenant_extension_values` (13 types, typed CHECK `tenant_extension_values_typed`, money minor + ISO 4217, integer scale 0, JSON depth / size / secret-key CHECKs), `tenant_extension_value_items` (replace-on-change, `DELETE` on items only) |
| Custom objects       | `tenant_custom_records` (entity-index kind `custom_record`, generic reference kind `custom_record`, natural key ≤ 3 fields, lifecycle, records-per-object guardrail); product parents operator-only                                           |
| Custom relationships | `tenant_custom_relationships` (both ends in the entity index; cardinality by writer lock + guard trigger, REPEATABLE READ refused; authoritative removal ends, absence never ends)                                                            |
| Writers              | `ExtensionValueWriter`, `CustomRecordWriter`, `CustomRelationshipWriter`: typed parsing, secret-like refusal, guardrails, restricted withheld, `ext:<key>` change tokens, opt-in value history, sticky operator values                        |
| Mapping              | entry kinds `attribute` (un-reserved), `custom_object`, `custom_relationship`, `capture`; Q14 single owner connection; limits 1,000 fields / 1 MiB (existing hashes unchanged, Q4); source-sync extension writes in their own transactions    |
| Capture              | `sources extension-capture-draft`: registry additions (`internal` / `operational`, uses `[display]`), sensitive fields refused; mapping publish never writes the registry                                                                     |
| Use enforcement      | `ExtensionUseGuard` on every reader; dependency-cruiser boundary (no extension input to products / identity); `not_evidence_of` floor; `EvidenceRelation.fact` and `EvidenceLinkWriter` refusal                                               |
| Merge                | `ExtensionMergeParticipant` (company and person ports, runs regardless of gate state): loser-only copied, equal skipped, differing → `extension_value_conflict`; record parents re-pointed; references follow lineage                         |
| Read models / CLI    | `ExtensionReadModel` (batch loading, lineage in one batch), `CustomRecordReadModel` (keyset pagination); `extension registry / values / value / records / record / relationship` (JSON, exit 2 on refusal, audited confidential flag)         |
| Canonical `0.4`      | catalogue with optional hash members (`0.1`–`0.3` hashes unchanged), explicit adoption, `modulesStranded` on rollback (Q19), new tenants at `0.4` with the module disabled, writers / publishes / commands gated                              |
| Security / integrity | policy v5 (`data.extension.read`), audit vocabulary, `human_override_active` reason code, R-DP-EXT data-policy check, manifests (`classifiedBy: 'registry'`), eight integrity checks; `insertContextChange` moved to tenancy                  |
| Migration / rollback | `20270112120000_m10d_extension_framework` (no backfill) and its down-script (refusal branches, exact M10C restore, re-apply)                                                                                                                  |
| Runtime              | `scripts/verify-runtime.d/89-extension-framework.sh` (V25)                                                                                                                                                                                    |

## Definition of done

| Item                                                                      | State                                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Migration + down-script (up / rerun / down-refusal / restore / re-apply)  | done (V24, `migrations-m10d.int.spec.ts`)                                              |
| V1–V24 tests                                                              | done (see [Tests](#tests))                                                             |
| V25 runtime script `89-extension-framework.sh`                            | done (CI runtime job)                                                                  |
| Format, lint, typecheck, boundaries, unit, integration, runtime, docker   | CI — final run `TBD-CI` (see [Evidence](#evidence))                                    |
| ADR 0030, this record, README status, tech-debt entries                   | done; tech debt #82–#86 added (`docs/tech-debt.md`)                                    |
| Mutation proofs VM1–VM27                                                  | `TBD-VM` (see [Mutation proofs](#mutation-proofs))                                     |
| Fresh-clone run                                                           | CI (every job checks out fresh); local fresh clone not possible (no Docker in sandbox) |
| E4 candidate note; `canonical-extension-and-source-mapping.md` superseded | open                                                                                   |
| Independent review, owner approval, merge                                 | **open**                                                                               |

## Plan vs actual (deviations)

| #   | Deviation                                               | Why                                                                                                                                                 |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | No left-prefix text index on `value_text`               | an expression / partial index is not expressible in the Prisma schema without schema-guard drift; typed indexes for the other types (tech debt #85) |
| D2  | Source-sync extension writes in separate transactions   | the canonical ingestion transaction of a record commits first; a failed extension write does not roll it back                                       |
| D3  | Closed module gate skips writes, counted, no audit      | the run counts skipped extension writes; no per-record audit event (tech debt #84)                                                                  |
| D4  | Merge participant runs regardless of gate state         | a merge never strands values or records on a loser, even below `0.4` or with the module disabled                                                    |
| D5  | JSON `null` = explicit empty                            | a `null` clears; an absent key changes nothing                                                                                                      |
| D6  | Custom-record product parents operator-only             | no mapping entry sets a `product` parent                                                                                                            |
| D7  | Capture drafts `internal` / `operational` / `[display]` | narrower than the plan's display / analytics; the operator widens a definition in the registry dry run                                              |
| D8  | Q14 owner check without cross-connection locking        | publish reads the other published mappings; two concurrent publishes for one object can both pass (tech debt #83)                                   |
| D9  | `insertContextChange` moved to tenancy                  | the extension module writes change records without importing `context` infrastructure (boundary rule)                                               |
| D10 | Capture draft on the sources CLI                        | `sources extension-capture-draft` (script `extension:capture-draft`) reads the source schema snapshot                                               |
| D11 | Record CLI shape                                        | `records list / show`, `record create / update / retire / reactivate`, repeatable `--set`, `--clear`, no date flags                                 |
| D12 | CLI `--file` caps raised                                | canonical-registry CLI 8 MiB (registry ceiling), mapping-source CLI 4 MiB (indented 1 MiB mapping document); fixed in `9ad1797`                     |
| D13 | `human_override_active` added                           | the plan said "reused", but it was not in `AUDIT_REASON_CODES`                                                                                      |
| D14 | Guardrail counts include retired definitions            | keys never disappear                                                                                                                                |

Q4 limits as built: 1,000 fields per object, 1 MiB mapping document, existing mapping hashes unchanged; extension
registry cap 2 MiB (database ceiling 8 MiB); mapping-source CLI file cap 4 MiB; canonical-registry CLI file cap 8 MiB.

## Tests

All paths under `apps/api/`.

| Suite                                                | Covers                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit specs (domain, registry, mapping, CLI args)     | V1 registry validation / X1–X4 / R-X6; V2 value parsing; Q4 mapping limits and pinned hashes (V23); V17 catalogue; V21 policy v5 (S1) and `canonical.human_entry` scope (S2); X5 narrowings |
| `test/extension/extension-values.int.spec.ts`        | V4 schema CHECKs, V5 writer, V10 operator CLI paths, V12 value history, V18 gates                                                                                                           |
| `test/extension/custom-records.int.spec.ts`          | V7 custom objects (identity, parent, lifecycle, guardrail)                                                                                                                                  |
| `test/extension/custom-relationships.int.spec.ts`    | V8 cardinality (writer + trigger, concurrent sessions, REPEATABLE READ refused), endpoints, removal                                                                                         |
| `test/extension/extension-merge.int.spec.ts`         | V11 merge participant (company and person)                                                                                                                                                  |
| `test/extension/extension-read-model.int.spec.ts`    | V14 use guard / `not_evidence_of`, V16 privacy scan, V19 batch loading and lineage                                                                                                          |
| `test/governance/extension-governance.int.spec.ts`   | V3 publish end to end (X2 / X4 / X5 / R-X6, guardrails, credential-like), R-DP-EXT, V15 DDL-capture event trigger test, V18 adoption / `modulesStranded`, V20 integrity                     |
| `test/tenancy/migrations-m10d.int.spec.ts`           | V17 catalogue / hash pins, V22 schema guard, V15, V24 migration up / rerun / down-refusals / exact restore / re-apply                                                                       |
| `test/sources/extension-sync.int.spec.ts`            | V6 source attribute sync, V7 / V8 source custom objects and relationships                                                                                                                   |
| `scripts/verify-runtime.d/89-extension-framework.sh` | V25 runtime: adopt `0.4`, enable module, publish registry, operator set / show / release, record create / list, capture draft, no values in logs                                            |

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
| `TBD-CI`      | `TBD-CI`  | final head (phase-3 tests, runtime script 89, this record)                                                                                                                                         |

**Fresh-clone run.** Every CI job checks the branch out fresh and runs `pnpm install --frozen-lockfile` and the full
verification. A local fresh clone was not run: the sandbox has no Docker.

## Mutation proofs

Plan §22: break → the named test fails for that reason → restore → green.

`TBD-VM` — table VM1–VM27 (mutation, guarding tests, PR / run / job, failing assertion, result) to be recorded.

## Review

`TBD` — independent review not yet run.

## Known gaps / judgment calls

- Full writer-path load test not run (#82).
- Q14 owner check is not serialised across connections (#83).
- A run with the module gate closed counts skipped writes but writes no per-record audit (#84).
- Live Sugar / Chargebee regression: not run (no approved secrets in this environment).

## Rollback caveat

The dev/staging down-script refuses while any M10D data class exists, **including any adoption of `0.4`**. Because
new tenants adopt `0.4` at provisioning, any database that provisioned a tenant or adopted `0.4` after M10D cannot be
rolled back by the down-script. Production is forward-fix only; tenant-level rollback is adoption back to `0.3`
(data kept and readable, writes refused, `modulesStranded: ['extension']` listed).

## Remaining

- Final CI run (`TBD-CI`), mutation proofs VM1–VM27 (`TBD-VM`), independent review, owner approval, merge to
  `integration`.
- E4 candidate note and the `canonical-extension-and-source-mapping.md` superseded note (plan §23).
- Tech debt #82–#86; integrity worker job (#65, inherited); data-quality store (M10L) for per-record rejections.
