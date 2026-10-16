# M10E — AccountContext (record)

- Status: **implementation passed independent review (PASS WITH FINDINGS) and is merged into `integration`** via
  PR #93 (`m10e-impl` → `integration`). The merge to `main` needs Ram's approval; owner question m4 (tech debt #90)
  is open for that merge (see [Remaining](#remaining)).
- Plan: [M10E plan](M10E-account-context-plan.md) (plan PR #92, merge `ee0b3ae`); owner instruction of 2026-10-14:
  the recommended `DEFAULT` answers Q1–Q26 apply unless overridden.
- ADR: [0031 AccountContext and canonical 0.5](../adr/0031-account-context.md)
- Base: `integration` at `ee0b3ae` (after M10D `c6fd540`); `main` untouched.
- Canonical version after M10E: **`0.5`** (`current`; `0.1`–`0.4` `supported`); module `account_context` available
  at `0.5`, disabled by default.
- These are engineering controls. **No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.**

## Scope delivered

| Area                  | Delivered                                                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context type registry | registry kind `context_type` (≤ 6 ordered dimensions `product_key` / `code` / `string` / `extension_ref`, closed member roles, `allow_products`); classification required and floored; R-C1–R-C4, R-C6 plus generic R-K / R-X1 / R-X3 / R-X4                      |
| Schema                | `tenant_account_contexts`, `tenant_account_context_persons`, `tenant_account_context_products`, `tenant_subscriptions.context_id`, `tenant_source_authority_versions.account_context_connection_id`; forced RLS, composite same-tenant FKs, S/I/U grants only     |
| Guards                | context guard (active type on insert, identity immutable, `merged` terminal, natural-key uniqueness by advisory lock + EXISTS, REPEATABLE READ refused); deferred line ↔ context same-account guard on both tables; dimensions / `owner_ref` CHECKs               |
| Writers               | `AccountContextWriter` (source observe, operator write / retire / reactivate / release / line assign; Q14 hold until release), `AccountContextMembershipWriter` (persons, explicit products); change records and value history; lock-until-stable (review M1)     |
| Mapping / sync        | mapping entity `account_context` (`accountContext` block), target `subscription.contextRef`, authority fact `account_context`; `AccountContextSourceSync` after accounts / people; unresolved references as issues; counters codes only                           |
| Merge                 | `AccountContextMergeParticipant` (company and person ports, runs regardless of the gate): re-point, natural-key collision merges contexts (members, products, lines move; issue)                                                                                  |
| Read model / CLI      | `AccountContextReadModel` (batch ≤ 500 accounts, scope filter, one audit event per call, confidential values withheld unless `includeConfidential`); `account-context` CLI (list / show / write / retire / reactivate / release / member / product / line-assign) |
| Canonical `0.5`       | catalogue 0.5 (0.1–0.4 hashes from frozen lists), policy v6 (`data.account_context.read`), module `account_context`, Q19 gate on extension values, reference values and relationship ends naming `account_context` (review M2)                                    |
| Integrity             | five checks: `account_context_company_mismatch`, `_natural_key_drift`, `_type_mismatch`, `_dangling_merge`, `_member_role_unknown`                                                                                                                                |
| Migration / rollback  | `20270119120000_m10e_account_context` (no backfill) and its down-script (refusal per data class, exact M10D restore, re-apply)                                                                                                                                    |
| Runtime               | `scripts/verify-runtime.d/90-account-context.sh`                                                                                                                                                                                                                  |

## Definition of done

| Item                                                                     | State                                                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Migration + down-script (up / rerun / down-refusal / restore / re-apply) | done (V29, `migrations-m10e.int.spec.ts`)                                              |
| V1–V30 tests                                                             | done (see [Tests](#tests))                                                             |
| Runtime script `90-account-context.sh`                                   | done (CI runtime job)                                                                  |
| Format, lint, typecheck, boundaries, unit, integration, runtime, docker  | CI — final run `38801290645` (see [Evidence](#evidence))                               |
| ADR 0031, this record, README status, tech-debt entries                  | done; tech debt #89–#92 added (`docs/tech-debt.md`)                                    |
| Mutation proofs VM1–VM16                                                 | done: 16 of 16 killed (see [Mutation proofs](#mutation-proofs))                        |
| Fresh-clone run                                                          | CI (every job checks out fresh); local fresh clone not possible (no Docker in sandbox) |
| Independent review, merge into `integration`                             | review PASS WITH FINDINGS (see [Review](#review)); merged into `integration` (PR #93)  |
| Merge to `main`                                                          | **open: needs Ram's approval** (owner question m4 / #90)                               |

## Plan and ADR vs actual (deviations)

| #   | Deviation                                                                     | Why                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Natural-key uniqueness is a guard trigger + advisory lock, not a unique index | a partial unique index drifts against the Prisma schema (M10C pattern); the guard refuses REPEATABLE READ; V7 holds both the check and the lock (two-session race) |
| D2  | Line ↔ context guard is a deferred constraint trigger on both tables          | a company merge re-points lines and contexts in one transaction, in either order                                                                                   |
| D3  | Context type entries project `codes = member_roles`                           | the generic R-X3 keeps a role from disappearing                                                                                                                    |
| D4  | R-C1 also covers a changed `extension_field` of an `extension_ref` dimension  | re-pointing a dimension changes its meaning                                                                                                                        |
| D5  | Dimension values string / number / boolean; absent optional omitted           | the natural-key hash treats an absent dimension as null                                                                                                            |
| D6  | Membership re-add reactivates the row (Q10)                                   | primary key (context, person, role); the ended period survives in change records (deterministic membership entity id)                                              |
| D7  | Q14 hold without a column                                                     | held attributes = human change records newer than the last release change, per attribute                                                                           |
| D8  | Merge moves are insert + end; extension values on a merged-away context stay  | identity columns are immutable; readers follow lineage (tech debt #92)                                                                                             |
| D9  | Merge participant runs regardless of the gate                                 | a merge never strands contexts on a loser (M10D pattern)                                                                                                           |
| D10 | Operator refusals use reason `validation_failed` (code in the message)        | no new audit reason codes; the audit CHECK is unchanged                                                                                                            |
| D11 | Line assignment lives in `AccountContextWriter`                               | `context` must not import `products`; single writer of `context_id`                                                                                                |
| D12 | `accountContext` mapping block; `MappingEntitySchema` unchanged               | routed like M10D custom objects; no stored mapping hash changes                                                                                                    |
| D13 | Authority fact decided by the sync run, not re-checked in the writer          | as M10C / M10D; the writer gate still applies                                                                                                                      |
| D14 | Absence never clears (line reference, persons, deleted records)               | clearing a line's context is operator-only (`line-assign --clear-context`)                                                                                         |
| D15 | Confidential masking in the read model                                        | every reader gets the `withheld` list, not only the CLI                                                                                                            |
| D16 | Loser record after a merge collision keeps its reference only (review m1)     | two source records never alternate their values on one context                                                                                                     |

## Tests

All paths under `apps/api/`.

| Suite                                                    | Covers                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit specs                                               | `canonical.spec.ts` V1 / V2 hashes; `account-context.spec.ts` V6 rules, document validation, natural-key hash (every dimension matters), stored type parse; `account-context.rules.spec.ts` dimension / owner / Q14 / merge planning rules; `source-mapping-account-context.spec.ts` mapping rules                                      |
| `test/tenancy/migrations-m10e.int.spec.ts`               | V1, V2, V3; V22 (forced RLS, policy, triggers, CHECKs, guard functions, composite FKs); V30 (S/I/U only, DELETE / TRUNCATE / DDL refused); V24; V21 (cross-tenant persons, products, lines, context type); line guard ×3; V29 (up / rerun, down refusals incl. relationship ends and `reference_to`, exact restore, re-apply, no drift) |
| `test/governance/account-context-governance.int.spec.ts` | V5 (operator entry points refused + audited at 0.4 / module off), V6 (publish rules), V25 (adoption / rollback dry run and apply), review M2 gate on relationship ends and reference values                                                                                                                                             |
| `test/sources/account-context-sync.int.spec.ts`          | V4 (module disabled = no behavioural change), V14 / V16 publish gates, V15 run (contexts, natural keys, products, `contextRef`, issues, idempotency), V20 read model, V16 authority + module disabled after use, V28 integrity checks with planted faults                                                                               |
| `test/context/account-context.int.spec.ts`               | V7 (two regions, segment dimension, DB guard, two-session natural-key race), V8, V9, V10, V11, V12, V13, V17, V18, V19 (company / person merge, collision, loser reference, review M1 two-session merge vs operator write), V23, V26, V27                                                                                               |
| `scripts/verify-runtime.d/90-account-context.sh`         | runtime: real CLI processes against the real database (adoption, module enable, publish, write / member / retire / reactivate / release, withheld reads, integrity, no DELETE, rollback to 0.4 and back, no confidential probe in logs)                                                                                                 |

## Bugs the tests caught

| Bug                                                                                                                                                                   | Found by              | Fix       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------- |
| Stored `context_type` entries carry projection keys (`kind`, `codes`) that the strict schema refused, so stored types were invisible to writer, publish and integrity | runtime script 90     | `f36cb3a` |
| After a merge collision, re-observing the loser's source record tried to re-bind its reference to the survivor (`reference_identity_conflict`)                        | V19                   | `26da394` |
| Context-addressed writers locked the account of a stale read (review M1)                                                                                              | review; V19 race test | `775c7f4` |
| The raised `account_context_natural_key_exists` reached the operator as a 500 instead of a refusal (review n3)                                                        | review                | `775c7f4` |

## Evidence

CI on PR #93 (GitHub Actions, workflow `CI`; jobs: lint/typecheck/boundaries/unit, integration (Testcontainers),
runtime, docker):

| Run           | Head      | Result                                                                                                   |
| ------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `38760872546` | `d61b441` | **all four jobs ✅** (phase-1 head: schema, migration, down-script, domain, registry kind)               |
| `38790526370` | `26da394` | **all four jobs ✅** (phase-3 head: V-tests, fix 26da394; 49 integration files, 758 tests)               |
| `38798632025` | `1ea6662` | **all four jobs ✅** (review fixes M1, M2, m1, n2, n3)                                                   |
| `38801290645` | `e326549` | **all four jobs ✅** (final code head: V7 segment + natural-key race tests, ADR 0031, status, tech debt) |

This record was added in a docs-only commit on top of `e326549`; its CI run (all four jobs green) is named in the
merge commit of PR #93.

**Fresh-clone run.** Every CI job checks the branch out fresh and runs `pnpm install --frozen-lockfile` and the full
verification. A local fresh clone was not run: the sandbox has no Docker.

## Mutation proofs

Plan §19: break → the named test fails for that reason → restore. Each mutation ran on its own throwaway branch
(`mut/m10e-vmN`, cut from `26da394`) with a workflow that ran only the guarding tests; draft PRs #94–#109 were closed
unmerged and every branch deleted.

**Summary.** 16 of 16 killed; no survivors, no positive controls. VM7 is guarded by **V7** (the raw-SQL duplicate
insert lives there; V8 goes through the writers and never reaches the guard), so the plan table now reads "(V7)".
VM8 was killed by the unit natural-key test; V7 now also sets the optional `segment` dimension, so the integration
test guards it too. The two-session race test added to V7 covers removing only the advisory lock, which no VM ran.

| VM   | Mutation                                                        | Guarding test(s) that failed                                                        | PR  | Run           | Result           |
| ---- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --- | ------------- | ---------------- |
| VM1  | Membership → person FK without `tenant_id`                      | `migrations-m10e` V21 / V22 composite FKs; V21 raw SQL cross-tenant person          | 102 | `38794016335` | killed           |
| VM2  | Line → context FK without `tenant_id`                           | `migrations-m10e` V21 / V22 composite FKs; V21 raw SQL cross-tenant context (23503) | 103 | `38794020602` | killed           |
| VM3  | Module gate removed from the operator gate                      | `account-context-governance` V5                                                     | 104 | `38794826426` | killed           |
| VM4  | Refusal audit skipped (`retire`)                                | `account-context-governance` V5                                                     | 105 | `38794828178` | killed           |
| VM5  | Line / context same-account guard triggers not created          | `account-context` V10 / V11; `migrations-m10e` line guard ×3                        | 106 | `38794035656` | killed           |
| VM6  | Retirement cascades to lines                                    | `account-context` V11                                                               | 107 | `38794041008` | killed           |
| VM7  | Natural-key guard (advisory lock + EXISTS) removed              | `account-context` **V7** (V8 stays green, see above)                                | 108 | `38794047221` | killed           |
| VM8  | Natural-key hash drops the last dimension                       | unit `account-context.spec.ts` natural key (now also V7 segment case)               | 109 | `38794051026` | killed (by unit) |
| VM9  | R-C1 disabled                                                   | unit V6 R-C1; `account-context-governance` V6                                       | 94  | `38793890670` | killed           |
| VM10 | Unclassified dimension accepted                                 | unit V6 document; `account-context-governance` V6 (V24 static, correctly green)     | 95  | `38793897965` | killed           |
| VM11 | Secret-like refusal on dimension values removed                 | unit `validateDimensions`; `account-context` V23                                    | 96  | `38793901447` | killed           |
| VM12 | 0.4 hash uses the live kind lists                               | unit `canonical.spec.ts` V1; `migrations-m10e` V1 / V2                              | 97  | `38793905873` | killed           |
| VM13 | `FORCE ROW LEVEL SECURITY` skipped on `tenant_account_contexts` | `migrations-m10e` V22                                                               | 98  | `38793910512` | killed           |
| VM14 | Authority-fact checks skipped in source sync                    | `account-context-sync` V16                                                          | 99  | `38793915269` | killed           |
| VM15 | Read model ignores the scope filter                             | `account-context-sync` V20                                                          | 100 | `38793921519` | killed           |
| VM16 | Merge participant leaves loser contexts on the loser account    | `account-context` V19 (deferred line guard aborts the merge)                        | 101 | `38793926652` | killed           |

VM3 / VM4 first runs (`38794024770`, `38794029997`) matched no test (an unescaped `+` in the `-t` filter) and were
re-run with an escaped filter; the table shows the valid runs.

## Review

Independent review of `26da394`: **PASS WITH FINDINGS** — no blockers, three majors, five minors, three nits.

| Finding                                                                                 | Severity | Resolution                                                                                        |
| --------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| M1 context-addressed writers lock the account of a stale read (M10C M2 / M10D M1 class) | major    | fixed `775c7f4`: lock until stable at all four sites; two-session test in V19                     |
| M2 Q19 gate missed relationship ends and reference values naming `account_context`      | major    | fixed `836522a`, `869defa`, `1ea6662`: publish, writers and down-script; governance and V29 tests |
| M3 DoD documentation missing; ADR 0031 stale                                            | major    | fixed: this record, README / milestones status, tech debt #89–#92, ADR 0031 corrected             |
| m1 attribute flapping after a merge collision                                           | minor    | fixed `775c7f4`: the loser's record observes its reference only (D16)                             |
| m2 no DB rule for new members / products on a merged or retired context                 | minor    | deferred (#89)                                                                                    |
| m3 no concurrency coverage                                                              | minor    | fixed: merge vs operator write (`775c7f4`) and the two-session natural-key race in V7             |
| m4 `includeConfidential` needs only `data.account_context.read`                         | minor    | **fixed** (hardening #90, PR #115): `data.account_context.read_confidential` (below)              |
| m5 context-side line guard re-reads the context row                                     | minor    | deferred (#91)                                                                                    |
| n1 ADR: no DELETE on product memberships either                                         | nit      | fixed (ADR 0031 §2)                                                                               |
| n2 merged-context refusal could name the survivor                                       | nit      | fixed `775c7f4`                                                                                   |
| n3 raised natural-key error mapped to a refusal                                         | nit      | fixed `775c7f4`                                                                                   |

### Hardening #90 (m4, owner decision: fix)

Branch `m10e-h90`, PR #115 into `integration`. Policy v7 adds `data.account_context.read_confidential` (no actor kind
holds it) and `security.capability.grant` (operator). An operator holds the confidential read only through an
explicit, tenant-scoped grant by another operator (`tenant_capability_grants`, migration `20270126130000`; `security
grant|revoke`). `includeConfidential` without it is refused and audited as `denied` with that capability; with it the
read is audited under that capability with the released keys only. Ordinary reads unchanged. Tests: policy /
authorizer unit (`security.spec.ts`, `write-authorizer-grants.spec.ts`, S2 static guard), integration
(`account-context-confidential.int.spec.ts`: default redaction, refusal + denied audit, success + allowed audit,
revoke, tenant isolation of contexts and grants, grant rules, adversarial), migration round trip
(`migrations-h90.int.spec.ts`), runtime script 90. Mutation proofs (CI, throwaway branches, PRs closed unmerged): **VM1**
the read model skips the extra capability check → the refusal test fails (run 38825269777, PR #116); **VM2** the
WriteAuthorizer allows a grantable capability without the grant lookup → the authorizer unit tests and the refusal
test fail (run 38825272654, PR #117). ADR 0031 addendum.

## Known gaps / judgment calls

- The database does not refuse new members or products on a merged or retired context; the writers do (#89).
- Confidential reads need `data.account_context.read_confidential` (explicit tenant grant; #90 resolved). Operator
  ids stay asserted until M15, so the grant is an audited two-person control, not proof of identity.
- Extension values on a merged-away context are not moved; readers follow lineage (#92).
- Inherited: integrity worker job (#65), evidence partitioning (#71), migration suite timing (#72).
- Live Gainsight / Salesforce context sources: not run (synthetic fixtures only).

## Rollback caveat

The dev/staging down-script refuses while any M10E data class exists, **including any adoption of `0.5`**. New
tenants adopt `0.5` at provisioning, so a database that provisioned a tenant after M10E cannot be rolled back by the
down-script. Production is forward-fix only; tenant-level rollback is adoption back to `0.4` (data kept and readable,
writes refused, `modulesStranded: ['account_context']` listed).

## Remaining

- Tech debt #90 resolved by hardening PR #115 (owner approval still needed before `main`).
- Tech debt #89, #91, #92; inherited #65, #71, #72.
