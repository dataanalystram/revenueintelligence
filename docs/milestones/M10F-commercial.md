# M10F — Commercial: Price/Offer, Contract, Entitlement, line commercial references (record)

- Status: **in review** — implementation complete on PR #121 (`m10f-impl` → `integration`, draft, not merged);
  V1–V34 green in CI, mutation proofs VM1–VM18 (+ VM7b, VM9b) recorded, **independent review pending**. The merge into
  `integration` follows the review; the merge to `main` needs Ram's approval.
- Plan: [M10F plan](M10F-commercial-plan.md) (plan PR #120, merged into `integration` as `6a634f7`); owner instruction
  of 2026-10-14: the recommended `DEFAULT` answers Q1–Q28 apply unless overridden.
- ADR: [0032 Commercial and canonical 0.6](../adr/0032-commercial.md)
- Base: `integration` at `6a634f7`; `main` untouched.
- Canonical version after M10F: **`0.6`** (`current`; `0.1`–`0.5` `supported`); module `commercial` available at
  `0.6`, disabled by default; policy v8.
- These are engineering controls. **No SOC 2, GDPR, HIPAA, ISO 27001, PCI or legal-retention claim is made.**

## Scope delivered

| Area                 | Delivered                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema               | `tenant_price_offers`, `tenant_contracts` (links `renews` / `amends` / `parent` as self-FK columns), `tenant_entitlements`; line `agreement_ref_*` (all-or-none), `contract_id`, `price_offer_id`, `supersedes_line_id`; authority connection columns; forced RLS, composite tenant FKs, S/I/U only                                                              |
| Guards               | union-acyclic contract graph under `contract-graph` lock; deferred same-account link, line ↔ contract and line ↔ offer (same product) guards on both tables; offer product immutable once referenced; line lineage acyclic / same account under `line-lineage` lock; RR / SERIALIZABLE refused; `tenant_account_contexts_contract_guard`                         |
| Writers              | `PriceOfferWriter`, `ContractWriter` (links, conflicts), `EntitlementWriter`, `CommercialLineReferenceStep`, `CommercialMergeParticipant`; operator hold until `release` (Q17); change records and value history (financial fields value-free)                                                                                                                   |
| Mapping / sync       | blocks `priceOffer` / `contract` / `entitlement`, line targets `subscription.agreement` (agreement-header confirmation, deal-grouping refusal), `.priceOfferRef`, `.supersedesRef`; authority facts `price_offer` / `contract` / `entitlement`; `CommercialSourceSync` with the second resolution pass; `LineAfterWrite` port; `contract_duplicate_source` (Q14) |
| Read model / CLI     | `CommercialReadModel` (`data.commercial.read`, one audit event per call, confidential columns withheld); `includeConfidential` only with the grant-only `data.commercial.read_confidential`; CLI `commercial` (price-offer / contract / entitlement / line / release)                                                                                            |
| Extension            | `price_offer`, `contract`, `entitlement` extension targets gated 0.6 + module; confidential extension values on commercial targets need `data.commercial.read_confidential`                                                                                                                                                                                      |
| Canonical `0.6`      | catalogue 0.6 (0.1–0.5 hashes from frozen lists), module `commercial`, policy v8, `GRANTABLE_CAPABILITIES` + `data.commercial.read_confidential`                                                                                                                                                                                                                 |
| Integrity            | six checks: `commercial_line_contract_company_mismatch`, `_line_price_offer_product_mismatch`, `_contract_link_cycle`, `_contract_link_cross_account`, `_line_lineage_cycle`, `_agreement_contract_drift`                                                                                                                                                        |
| Boundary             | dependency-cruiser `commercial-never-feeds-ownership-or-eligibility` + static scan; eligibility snapshot equality                                                                                                                                                                                                                                                |
| Migration / rollback | `20270202120000_m10f_commercial` (no backfill) and its down-script (17 refusals, exact restore, re-apply, no Prisma drift)                                                                                                                                                                                                                                       |
| Runtime              | `scripts/verify-runtime.d/91-commercial.sh` (10 checks)                                                                                                                                                                                                                                                                                                          |

## Definition of done (plan §24)

| Item                                                                 | State                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| V1–V34 green                                                         | done (see [V coverage](#v-coverage))                                                                       |
| VM1–VM18 recorded with the failing test each                         | done: 18 of 18 killed, plus VM7b and VM9b (see [Mutation proofs](#mutation-proofs))                        |
| CI green on the PR head (four jobs)                                  | done for the code head `61bf033` (run `38879788433`); this record's commits have their own run (see below) |
| Runtime script `91-commercial.sh` + README row                       | done (CI runtime job, 10/10 PASS)                                                                          |
| Fresh clone, Docker, migration down / up                             | CI (every job checks out fresh; Docker job green); migration round trip in `migrations-m10f` V30           |
| ADR 0032, this record, README / milestones status, tech-debt entries | done; tech debt #95–#99 added                                                                              |
| Live Chargebee TEST read (Q26)                                       | **not run** (see [Live Chargebee](#live-chargebee-q26)); M9B precedent                                     |
| Independent review, merge into `integration`                         | **open**                                                                                                   |
| Merge to `main`                                                      | **open: needs Ram's approval**                                                                             |

## Plan and ADR vs actual (deviations)

| #   | Deviation                                                                                                                       | Why                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Contract links are three self-FK columns, not `tenant_contract_links` (Q6)                                                      | E3 §14 fixes 0..1 per kind; a column per kind makes it structural (recorded in plan §28)                                                         |
| D2  | Line-lineage account guard serialises on the `line-lineage` advisory lock instead of re-reading the predecessor `FOR SHARE`     | crossing predecessor writes deadlocked (40P01) instead of resolving to `line_lineage_cycle`; fixed in phase 2a (`4397142`)                       |
| D3  | Lock order: identity locks (`company-canonical`, source-reference triple) first, then `contract-graph` → `line-lineage` → rows  | every writer, the line step and the merge share the account lock; every contract write takes `contract-graph` (per-tenant serialisation, #98)    |
| D4  | Agreement confirmation is a new union member of the relationship `confirmation` field                                           | existing documents parse to the same value, hashes unchanged; an M8 `{by, note}` confirmation does not count                                     |
| D5  | Deal-grouping refusal by token list on field / `relatesTo` / header object, or header mapped as non-contract                    | a plain `relatesTo` cannot be refused: Chargebee `SubscriptionItems.subscription_id → Subscriptions` is the plan's own header example            |
| D6  | Empty / malformed references never clear (line agreement / offer / predecessor, contract link fields)                           | M10E absence-never-clears; clearing is operator-only                                                                                             |
| D7  | Second pass after contracts, before lines; same-run lines resolve inline; company-mismatch lines re-run and stay refused        | plan §6.3 wording; one transaction per waiting line                                                                                              |
| D8  | Unknown contract / entitlement account → `contract_reference_unresolved` (rejected `account_unknown`)                           | no dedicated conflict kind exists                                                                                                                |
| D9  | `contract_duplicate_source` is a heuristic (same account, identical term, other source system); no auto-resolve                 | no detection signal beyond the mapping; nothing merged (Q14; #97)                                                                                |
| D10 | `contract retire` = operator write `status: terminated`                                                                         | E3 §13 has no `retired` contract status                                                                                                          |
| D11 | Extension targets `price_offer` / `contract` / `entitlement` enabled in phase 2b (gated 0.6 + module)                           | phase 1 deferred definitions; needed for a real V21 test (Q21)                                                                                   |
| D12 | `withheld` names only confidential attributes holding a value                                                                   | M10E behaviour; reveals presence, not value (#90 trade-off)                                                                                      |
| D13 | Entitlement reads refuse `includeConfidential` without the grant although no entitlement column is confidential                 | the flag never means something weaker on one entity                                                                                              |
| D14 | Released keys are entity-qualified (`contract.totalValueMinor`)                                                                 | one call can span entities; M10E used bare keys                                                                                                  |
| D15 | Drift check skipped with the module disabled, for cross-account resolutions and for lines with an unreleased human `contractId` | those are a disabled module, the refused `contract_company_mismatch` case and an operator override — not drift                                   |
| D16 | Chargebee fixture maps `started_at` → `startsAt` (plan said `start_date`)                                                       | the fake emits `started_at`; both are declared — swap if the live read shows otherwise                                                           |
| D17 | No Chargebee amount (Q9)                                                                                                        | the adapter declares no item-price amount (#96)                                                                                                  |
| D18 | Source-path gate refusals counted on the run, not audited; authority fact decided by the run, not re-checked in the writers     | M10E pattern (D13 there); operator refusals audited                                                                                              |
| D19 | Context same-account mismatch from a source is a skip (`contextSkipped: context_mismatch`), not a conflict                      | no conflict kind exists for it                                                                                                                   |
| D20 | Runtime script 91 has no sync leg and scans no metrics                                                                          | sync leg needs a second fake / worker / publish flow (covered by integration specs); metrics are in-process OpenTelemetry with no exporter (#99) |
| D21 | Phase-1 handoff had no M10F migration spec and no test updates                                                                  | found in phase 1; expectations rewritten for 0.6 / policy v8, `migrations-m10f.int.spec.ts` written in phase 2a                                  |

## V coverage

All paths under `apps/api/`. Integration suites run in the CI integration job (Testcontainers); at `61bf033`: 60 files /
844 tests.

| V   | Evidence                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | unit `canonical.spec.ts` (0.6 current, 0.1–0.5 supported; catalogue kinds / blocks / targets / facts); int `migrations.int.spec.ts` V1 catalogue = code                           |
| V2  | unit `canonical.spec.ts` V1 hashes from frozen lists; int `migrations-m10e` V1 pinned hash (VM17)                                                                                 |
| V3  | int `migrations-m10f` module row (`commercial` available at 0.6); `migrations-m10d` / `-m10e` module catalogue rows; unit modules                                                 |
| V4  | int `commercial-sync` V4 (0.6 module off vs 0.5: quality, lines incl. `field_hash`, change records, mapping hashes identical)                                                     |
| V5  | int `commercial-writers` V5 (version / module refusals audited; Core `agreement_ref` without the module); `commercial-sync` publish refusals (VM8, VM9)                           |
| V6  | int `commercial-writers` V6 (offer validation, retired offer refusal)                                                                                                             |
| V7  | int `commercial-writers` V7 / V8 / V14 / V18 (contract validation; status change never cascades)                                                                                  |
| V8  | int `commercial-writers` renewal scenario (contract moves, history keeps the earlier one, `renews` set); `commercial-sync` full run                                               |
| V9  | int `commercial-scenarios` (5 tests: renewal with new lines, amendment in place, amendment as new contract, replacement, co-terming / `parent`)                                   |
| V10 | int `migrations-m10f` V10 union cycle + two-session race (VM6, VM7); `commercial-writers` V10 / Q7 / Q12 conflicts and operator codes (VM7b)                                      |
| V11 | int `migrations-m10f` V11 deferred guards (VM4, VM5); `commercial-writers` V11; `commercial-sync` mismatch conflicts                                                              |
| V12 | int `commercial-sync` agreement-only mapping (no contract, no source-reference row); `migrations-m10f` all-or-none CHECK; `commercial-sync` V14 unresolved never creates (VM12)   |
| V13 | unit `source-mapping-commercial.spec.ts` V13; int `commercial-sync` V5 / V13 / V16 publish refusals (VM13)                                                                        |
| V14 | int `commercial-sync` V14 late contract resolved by the second pass; `commercial-writers` V14 (VM12)                                                                              |
| V15 | int `commercial-sync` V16 / V15 / V27 eligibility snapshot equality; unit `commercial-boundary.spec.ts` (VM10, VM11)                                                              |
| V16 | unit `source-mapping-commercial.spec.ts` authority; int `commercial-sync` V16 (publish and sync)                                                                                  |
| V17 | int `commercial-writers` V17 / Q17 hold and release, disagreement recorded                                                                                                        |
| V18 | int `commercial-writers` V18 (value-free renewal date / list amount); unit `canonical.spec.ts` value-history catalogue and the declared `value_free` decision (VM16)              |
| V19 | int `commercial-writers` V19 merge; `commercial-read` V19 race (merge ‖ source / operator contract writes ‖ line assignment ‖ source line step, 3 rounds, no 40P01)               |
| V20 | int `commercial-read` V20 (default withholding on 7 reads, 13 refusals, granted release with released keys, revoke, tenant-scoped grants, batch bound) (VM14)                     |
| V21 | int `commercial-read` V21 (registry gate, denial without / with the wrong grant, release with the commercial grant) (VM15)                                                        |
| V22 | int `migrations-m10f` V22 composite FKs + cross-tenant raw SQL as app role (VM2, VM3); `commercial-read` tenant-scoped grants                                                     |
| V23 | int `migrations-m10f` V23 forced RLS / policy / tenant-id immutability (VM18)                                                                                                     |
| V24 | int `commercial-read` V24 (secret-like refusals, no amount in errors / audit / history); runtime `91-commercial.sh` check 10 (logs, CLI output / stderr, every persisted surface) |
| V25 | unit `commercial-classification.spec.ts`; int `migrations-m10f` V25 (VM1)                                                                                                         |
| V26 | int `commercial-read` V26 / V27 (rollback 0.6 → 0.5 with module on, stranded, writes refused audited, re-adopt); runtime 91 checks 2, 9 (VM9b)                                    |
| V27 | int `commercial-read` V26 / V27; `commercial-sync` V27 (module disabled after use: reads ok, writes refused, references kept)                                                     |
| V28 | int `chargebee-commercial` V28 (fixture: 7 offers, 7-code status map, sub-02's three lines resolved, quiet second run)                                                            |
| V29 | int `commercial-read` V29 (six checks clean = 0; seeded faults detected with exact refs; nothing repaired); runtime 91 check 7                                                    |
| V30 | int `migrations-m10f` V30 (up without backfill, rerun no-op, 17 down refusals, exact restore, re-apply, `prisma diff` "No difference detected")                                   |
| V31 | int `migrations-m10f` V31 (no DELETE, 42501; no DDL; owner functions); runtime 91 check 8                                                                                         |
| V32 | int `migrations-m10f` V32 lineage + two-session race; `commercial-writers` V32 crossing predecessors                                                                              |
| V33 | int `commercial-read` V33 (context needs module `account_context`, audited denial; other account's context refused)                                                               |
| V34 | int `commercial-writers` V34 (concurrent header syncs → one contract)                                                                                                             |

## Mutation proofs

Plan §21: break → the named test fails for that reason → restore. Each mutation ran on its own throwaway branch
`mut/m10f-vmN`, cut from `ffcf2b9`, with a "Mutation proof" workflow that ran only the guarding tests; draft PRs
#122–#141 into `integration` were closed unmerged and every branch deleted.

**Summary.** 20 of 20 killed (VM1–VM18 plus the extra variants VM7b and VM9b); no survivors, no test patch needed.
Defence in depth: VM6 / VM7 mutate only the database guard and are killed by raw-SQL `migrations-m10f` tests (the
writer layer still refuses); VM7b mutates only the app check and is killed by the writer V10 test. VM16 was killed by
three integration tests while the unit value-history tests stayed green; a unit case for the declared `value_free`
branch was added with this record (`canonical.spec.ts`), and was shown failing locally against the VM16 mutant.

| VM   | Mutation                                                                    | Guarding test(s) that failed                                                               | PR  | Run / job                      | Result |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --- | ------------------------------ | ------ |
| VM1  | `list_amount_minor` classified commercial / internal                        | unit `commercial-classification`; int `migrations-m10f` V25                                | 122 | `38878081338` / `116897876087` | killed |
| VM2  | contract → contract link FK without `tenant_id`                             | int `migrations-m10f` V22 catalogue + cross-tenant raw SQL                                 | 123 | `38878081590` / `116897876953` | killed |
| VM3  | line → contract FK without `tenant_id`                                      | int `migrations-m10f` V22 catalogue + cross-tenant raw SQL (23503)                         | 124 | `38878085997` / `116897891405` | killed |
| VM4  | line ↔ contract same-account guards not created                             | int `migrations-m10f` V11                                                                  | 125 | `38878090578` / `116897907424` | killed |
| VM5  | line ↔ offer same-product guards not created                                | int `migrations-m10f` V11 / Q10                                                            | 126 | `38878094349` / `116897919228` | killed |
| VM6  | `contract-graph` advisory lock removed from the graph guard                 | int `migrations-m10f` V10 two-session race (both crossing links committed)                 | 127 | `38878099805` / `116897936855` | killed |
| VM7  | cycle walk per link kind instead of the union                               | int `migrations-m10f` V10 / Q7 union cycle                                                 | 128 | `38878101669` / `116897943356` | killed |
| VM7b | `ContractWriter` checks cycles on the proposed kind's graph only            | int `commercial-writers` V10 / Q7 / Q12 (DB guard threw instead of a recorded conflict)    | 129 | `38878107353` / `116897961359` | killed |
| VM8  | module gate removed from `requireCommercial`                                | int `commercial-writers` V5                                                                | 130 | `38878112225` / `116897975810` | killed |
| VM9  | module refusal thrown directly (no denied audit)                            | int `commercial-writers` V5 (no `module_disabled` denied event)                            | 131 | `38878115157` / `116897984613` | killed |
| VM9b | `@AuditFailures` removed from `ContractWriter.write`                        | int `commercial-read` V26 / V27 (no `failed` event)                                        | 132 | `38878120015` / `116898000648` | killed |
| VM10 | eligibility facts filter on `price_offer_id`                                | unit `commercial-boundary` static scan; int `commercial-sync` V16 / V15 / V27 snapshot     | 133 | `38878211791` / `116898295607` | killed |
| VM11 | eligibility facts include entitlements                                      | unit `commercial-boundary` static scan; int `commercial-sync` V16 / V15 / V27 snapshot     | 134 | `38878214419` / `116898304313` | killed |
| VM12 | unresolved `agreement_ref` creates a contract                               | int `commercial-sync` V14 / V6 / V8 / V11, V14 second pass, Q14; `commercial-writers` V7 … | 135 | `38878218822` / `116898318543` | killed |
| VM13 | `subscription.agreement` accepted without the agreement-header confirmation | unit `source-mapping-commercial` V13; int `commercial-sync` V5 / V13 / V16                 | 136 | `38878224169` / `116898336181` | killed |
| VM14 | read model releases confidential columns without the grant check            | int `commercial-read` V20 refusal, granted, tenant-scoped                                  | 137 | `38878228530` / `116898350969` | killed |
| VM15 | extension read model skips the commercial confidential check                | int `commercial-read` V21                                                                  | 138 | `38878232125` / `116898362529` | killed |
| VM16 | `decideValueHistory` ignores `value_free`                                   | int `commercial-writers` V6, V7 / V8 / V14 / V18; `commercial-read` V24 (unit now too)     | 139 | `38878236856` / `116898377753` | killed |
| VM17 | 0.5 hash uses the live lists                                                | unit `canonical.spec.ts` V1; int `migrations-m10e` V1; `migrations.int.spec.ts` V1         | 140 | `38878242804` / `116898396112` | killed |
| VM18 | `FORCE ROW LEVEL SECURITY` skipped on `tenant_contracts`                    | int `migrations-m10f` V23                                                                  | 141 | `38878247506` / `116898412002` | killed |

VM2 / VM3 needed a helper unique index on `tenant_contracts(id)` so the single-column FK could exist (as M10E VM2).
VM8 / VM9 act in the shared operator gate `requireCommercial` (the M10E VM3 / VM4 pattern).

## Evidence

CI on PR #121 (GitHub Actions, workflow `CI`; jobs: lint/typecheck/boundaries/unit, integration (Testcontainers),
runtime, docker). Phase heads:

| Phase                                       | Run           | Head      | Result                                                                                                                                           |
| ------------------------------------------- | ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — schema, migration, catalogue 0.6        | `38850021145` | `27fd313` | **all four jobs ✅** (after fix rounds `38846002610`, `38846345542`, `38848278167`)                                                              |
| 2a — authority facts                        | `38852258665` | `25e9ad1` | **all four jobs ✅**                                                                                                                             |
| 2a — writers, migration spec                | `38856601069` | `a52d72e` | **all four jobs ✅** (after `38854486887` failed; `38853960992`, `38855737386`, `38856098816` cancelled by newer pushes)                         |
| 2b-1 — mapping, sync                        | `38864510940` | `380605e` | **all four jobs ✅** (after `38862862730` failed)                                                                                                |
| 2b-2 — read model, CLI, integrity, boundary | `38874993383` | `ffcf2b9` | **all four jobs ✅** (59 files / 839 integration tests; after `38871170845`, `38872935849` failed on denial coalescing; `38870621594` cancelled) |
| 3a — runtime 91, V9 scenarios, V19 line leg | `38879788433` | `61bf033` | **all four jobs ✅** first push (verify `116903481267`, docker `116903481579`, integration `116903481600` 60 / 844, runtime `116903481788`)      |

This record, ADR 0032, the status lines, the tech-debt rows and the `value_free` unit test were added on top of
`61bf033`; their CI run is named on PR #121.

**Fresh-clone run.** Every CI job checks the branch out fresh and runs `pnpm install --frozen-lockfile` and the full
verification. A local fresh clone was not run: the sandbox has no Docker.

## Live Chargebee (Q26)

**Not run.** `.github/workflows/ci.yml` references no secrets (no `secrets.*`, no `CHARGEBEE_*`), and the repository
secrets API is not reachable with this integration ("Resource not accessible by integration"); per the brief no
credentials were added. Recorded as not run, as in M9B; `test:live` is the place for it once the two approved
read-only TEST environment secrets exist (tech debt #95). Commercial sync is covered by the Chargebee fake (V28).

## Bugs the tests caught

| Bug                                                                                                                       | Found by                   | Fix       |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------- |
| Extension `ENTITY_TABLE` lacked the commercial kinds (TS2739)                                                             | CI docker / typecheck      | `bf6ea4a` |
| Crossing predecessor writes deadlocked (40P01) in the line-lineage account guard instead of refusing `line_lineage_cycle` | two-session race (V32)     | `4397142` |
| V20 refusal count off: the WriteAuthorizer coalesces repeated denials of one actor within its window                      | `commercial-read` V20 (CI) | `ffcf2b9` |

## Known gaps / judgment calls

- Live Chargebee commercial read not run (#95); no Chargebee amount field (#96).
- `contract_duplicate_source` is a heuristic and never auto-resolves (#97).
- Contract writes are serialised per tenant by `contract-graph`; not load-tested (#98).
- Runtime script 91 has no sync leg and no metrics-exporter scan (#99).
- Grants of `data.commercial.read_confidential` are made by and to asserted operator ids until M15 (#93 applies).
- Inherited: #15, #65 (integrity CLI only), #71, #72, #79, #94 (not widened).

## Rollback caveat

The dev/staging down-script refuses while any M10F data class exists, **including any adoption of `0.6`**. New
tenants adopt `0.6` at provisioning, so a database that provisioned a tenant after M10F cannot be rolled back by the
down-script. Production is forward-fix only; tenant-level rollback is adoption back to `0.5` (data kept and readable,
writes refused, `modulesStranded: ['commercial']` listed).

## Remaining

- Independent review of PR #121; then merge into `integration` (merge to `main` needs Ram's approval).
- Tech debt #95–#99; inherited #65, #71, #72, #93.
