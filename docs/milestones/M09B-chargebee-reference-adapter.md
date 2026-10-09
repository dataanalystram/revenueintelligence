# Milestone 9B — Chargebee reference adapter (implementation record)

- Status: **FAKE IMPLEMENTATION COMPLETE — awaiting independent implementation review.**
  **LIVE CHARGEBEE VERIFICATION: IN PROGRESS** — baseline read done on the TEST site; **blocked** on the
  reused-subscription-id contradiction (see [Live baseline](#live-baseline-test-site)) and on Key B. Independent
  implementation review: **not yet done**.
  **M9B is NOT closed**: it cannot close on the fake alone (plan §26).
- **LIVE SUGAR VERIFICATION: PENDING** (unchanged).
- Not started: M9C (S3/files), M9D (warehouse), signals, opportunities, cross-source matching.
- Plan: [M09B detailed plan](M09B-chargebee-reference-adapter-plan.md), approved at
  `ba72e9108dcd253833c8ae4afa8d4f678f9c9f15` (`PASS — M9B PLAN APPROVED FOR IMPLEMENTATION`).
- Branch: `claude/blissful-mendel-urbh4r`. Implementation SHA: see [Evidence](#evidence).
- ADR: [0024 Chargebee reference adapter](../adr/0024-chargebee-reference-adapter.md).

## Scope delivered

| Plan item                    | As built                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 connector kind            | `chargebee` in `CONNECTOR_KIND_CATALOGUE` and migration `20261115120000_m9b_chargebee_connector_kind` (+ down-script)                                                                                                                                                                                      |
| G2 double enumeration        | `ObjectCapabilities.fullReadProof: 'double_enumeration'`; `provenRead` lists the bounded set twice and compares membership; tier `stable_snapshot`; tombstones need `proof_acceptances`                                                                                                                    |
| G3 Unix seconds              | Parse rule `{ type: 'timestamp', format: 'unix_seconds' }` (UTC, 2000–2100 only); B-guard value rule (integer); profile rule (only `timestamp.unix_s` / integers)                                                                                                                                          |
| G4 child reconciliation      | `ObjectCapabilities.childOf`; per-parent child sets in the sync run; retirement only for complete, accepted sets; uncertain sets shield their parent's lines from every retirement                                                                                                                         |
| G5 deletion / rejection rows | `SourceRecord.rejection: 'invalid_payload'` (structurally invalid entries); `deleted=true` → `absent` for exactly that record                                                                                                                                                                              |
| Pagination safety            | `pagination_stalled` on a repeated position or an identical consecutive page (sync **and** profiling); `page_limit_exceeded` ceiling unchanged                                                                                                                                                             |
| Settle window                | `sync.settleMinutes` (0–60): run boundary = run start − settle                                                                                                                                                                                                                                             |
| Incremental gating (B8/V12)  | `incrementalReads: false` on line objects unless `incrementalLines: verified`; `start()` refuses `incremental_not_supported`                                                                                                                                                                               |
| Adapter                      | `src/modules/chargebee/`: config (strict; loopback-only `endpoint` for test doubles), GET-only allowlisted transport, 1 request in flight per connection, per-minute limiter, `Retry-After`, Zod boundary schemas, five declared objects, flattening, item-price → item resolution, `testConnection` codes |
| Fake Chargebee               | `test/support/fake-chargebee.ts` (deterministic synthetic dataset; faults, PC 1.0 mode, repeated offsets, between-pass hook, synthetic `card` in every subscription entry, 405 for non-GET; standalone mode for runtime)                                                                                   |
| TEST mapping                 | `test/fixtures/chargebee/mapping.test.json` (+ README): identity `line_key_item_price`, Product = Item, reviewed `item_type` domain, versioned status map, Unix-seconds terms                                                                                                                              |
| Runtime / Docker             | `scripts/verify-runtime.d/80-chargebee.sh`; M9B checks in `scripts/verify-docker.sh`                                                                                                                                                                                                                       |

## Migrations

One migration, `apps/api/prisma/migrations/20261115120000_m9b_chargebee_connector_kind/migration.sql`
(down-script `apps/api/prisma/rollback/20261115120000_m9b_chargebee_connector_kind.down.sql`):

| Object                   | Change                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connector_kinds`        | `INSERT ('chargebee', 'Chargebee', has_adapter = true)`                                                                                                         |
| `tenant_credential_refs` | `tenant_credential_refs_system_valid` widened by exactly `'chargebee'` (the read-only API key is registered by **name**; the value stays in the SecretProvider) |
| `tenant_integrations`    | `tenant_integrations_system_valid` widened by `'chargebee'`; new `tenant_integrations_chargebee_read_only`: a Chargebee integration can never be `read_write`   |

No table, column, RLS policy or grant change; Prisma models unchanged (no schema drift). The down-script
refuses (and changes nothing) while any connection, external reference, line, checkpoint, context change,
integration or credential reference names `chargebee`; otherwise it restores the exact M9A schema and
reference data, and M9B re-applies (tested in `migrations.int.spec.ts`).

## Source objects and API evidence

API v2, Product Catalog 2.0, HTTP Basic with the read-only key as username. Evidence: Chargebee's official SDK
types (`chargebee@3.34.0`) and the API reference / error-handling pages (plan §2, F1–F18); `chargebee.com` is
not reachable from this environment's network policy, so nothing here is live evidence.

| Object              | Endpoint                | Notes                                                                                                                                                                                                                       |
| ------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Customers`         | `GET /customers`        | accounts; live records only (no `include_deleted`); full reads bounded by `created_at[before]` + `sort_by[asc]=created_at`; only `id`, `company`, timestamps, `deleted`, `business_entity_id` declared (no personal fields) |
| `Items`             | `GET /items`            | product catalogue (Product = Item); unbounded, double-enumerated                                                                                                                                                            |
| `ItemPrices`        | `GET /item_prices`      | price points; the item-price → item join only                                                                                                                                                                               |
| `Subscriptions`     | `GET /subscriptions`    | parents; live records only (no `include_deleted`)                                                                                                                                                                           |
| `SubscriptionItems` | (from `/subscriptions`) | derived child set: one row per `subscription_items[]` entry; parent fields denormalised; `card` and payment data dropped unread                                                                                             |

## Exact implementations

### Product and line identity

- **Product = Chargebee Item.** `item_id` is resolved through Chargebee's own `item_prices.item_id` (loaded
  once per run; re-read once when a subscription names an unknown price; still unknown → `null` →
  `missing_product_reference`, protected with a gap). Never a fallback to the price id (C15).
- **Line identity is the mapping's choice** (decision B9): the adapter exposes `line_key_item_price`
  (`<subscription_id>:<item_price_id>`) and `line_key_item` (`<subscription_id>:<item_id>`, null when the item
  is unknown). V3 is unproven, so the TEST mapping uses the **approved fallback** `line_key_item_price`.
  Switching to `line_key_item` is a new, governed mapping version (C11 test shows the published version decides
  the keys); the platform never switches identity at run time.
- **Duplicate keys fail closed** (C12/CB25): a key repeated within a child set protects every occurrence,
  writes none of them and makes the parent uncertain.

### Coverage proof

`provenRead`: `count` when the object can count (Sugar, unchanged); otherwise `double_enumeration` when
declared — pass 1 reads all fields and processes pages; pass 2 reads only the membership key (for a child set,
the parent key); the two key sets must be identical (C4/C5). A mismatch, or a key appearing twice in one pass,
is `unstable_read` (no proof, no tombstone, coverage unchanged, CB28). The run's proof is
`{ double_enumeration, stable_snapshot, passed }` — **never** `externally_grounded` (C6). Tombstones need an
operator acceptance (`proof_acceptances`) on the authority version (C7, CB29/CB30); an acceptance never
promotes the tier. Absence is `unknown`; Chargebee alone produces no eligible whitespace.

### Status and terms

Versioned value map in the mapping (`active→active`, `in_trial→trial`, `non_renewing→active`,
`cancelled→cancelled`, `future|paused|transferred→unknown`, unmapped → `unknown` with
`unmapped_source_enum_value`); never inferred from dates (CB04–CB09, C13). Terms:
`startsAt ← current_term_start`, `endsAt ← current_term_end` through the generic Unix-seconds parse (C14).
`resource_version` (milliseconds) is never a time. No "renewal date" is mapped (`next_billing_at` ignored).

### Parent-scoped child reconciliation (G4)

A parent's child set is built from the rows of one page (Chargebee returns a subscription with all its items).
After every read and guard succeeded, for each parent observed in the run whose set is complete and accepted,
active lines `<parent>:*` absent from the set are retired (`child_retired`), on full and incremental runs.
The set is **uncertain** — no retirement, and the parent's existing lines are added to the protection set so
the full-run tombstone pass cannot retire them either (`child_set_protected`) — when:

- the parent was structurally rejected (rejection row; its lines are protected with a gap, CB35/C10/C21);
- any child was rejected or protected (missing/orphan product or account, unreviewed holding value, invalid
  observation; C9, CB23);
- a child key repeated (C12);
- the parent was split across pages;
- a child had no usable parent key (the whole object is then uncertain, and full-run tombstones of that object
  are suppressed).

A deleted parent retires only its own explicitly deleted rows. A failed read or pagination failure never
reaches reconciliation. `seenButRejected` is preserved and honoured by G4 (`mayTombstone`).

### Deletions

Cancellation, expiry and deletion stay separate. **Live-gate correction:** Chargebee is read live-records-only, so a
deleted subscription is absent and its lines are retired by the next accepted full run (CB21, C17/C17b); `cancelled` is a state, never deletion evidence;
disappearance → full-run tombstone only under §18 (double enumeration passed, acceptance, not protected); a
deleted customer retires its reference only (see Deviations).

### Pagination, rate limiting, security

Opaque `next_offset`; repeated position or identical consecutive page → `pagination_stalled` (sync and
profiling; CB36/C22): the run fails with no proof, no coverage change, no tombstones, after two list requests.
GET only to four allowlisted list endpoints (C1/C2); one request in flight per connection; per-minute limiter
(default 100, below the test-site 150); `Retry-After` honoured on 429/5xx (CB31). Key via `SecretProvider`
only (`TENANT_<SLUG>_CHARGEBEE_<CREDENTIAL_NAME>`), never in config, logs, profiles or findings. No write
operation exists.

## Deviations and interpretations (for the reviewer)

1. **Migration widened beyond the plan's "one INSERT".** The credential and integration system CHECKs had to
   admit `chargebee`, or the read-only key could not be registered with the SecretProvider; a Chargebee
   integration is additionally constrained to `disabled`/`read_only`. Still one migration.
2. **`IntegrationSystemSchema` gains `chargebee`** (settings: an empty strict object; the site lives on the
   source connection).
3. **CB20 (customer deleted):** the reference is retired, but the lines stay active on the canonical company
   (M8 reference semantics: `knownRefs` includes retired references) — not "orphaned → protected + gap" as the
   plan expected. Changing this would change Sugar behaviour; left for the reviewer (tech debt #57).
4. **CB24 (malformed term):** rejected at the adapter boundary (rejection row, `record_rejected`, protected
   with a gap) instead of the generic `invalid_date` transform — the same fail-closed outcome.
5. **CB19:** a never-seen customer gives `orphan_account_reference` with no line; the "existing line
   protected + gap" case is proven by moving an existing subscription to an unknown customer.
6. **Incremental CB35:** a window holding only a rejected parent trips the M9A identity guard and fails the run
   (fail-closed); with other changes in the window the run completes without retirement.
7. **Uncertain child sets also shield the full-run tombstone pass** (not only G4): an old line of a parent with
   a rejected/protected/duplicated child is never tombstoned by the same run (C9b).
8. **`SOURCE_VERSION` is `v2:pc2`** (the snapshot table's format CHECK has no `/`).
9. **C20** (read-only key check) is not implementable without a write attempt: N/A pending V8.
10. **Incremental scenarios on the fake** (CB15, CB27, incremental CB35) run with `incrementalLines: verified`,
    i.e. assuming V12; production stays full-run-only until V12 is proven.

## Technical debt

Register items #55–#61 ([tech-debt.md](../tech-debt.md)).

## Evidence

Sanitized: counts and codes only. All data is synthetic (fake Chargebee); no customer names, emails,
Chargebee ids of a real site, API keys or subscription values are recorded.

- **Implementation SHA:** `07b52f5579fc71be3e963b06ed2bdb3da145c128` (43 files, +4,832 / −77 against the
  approved plan `ba72e91`). This record's evidence is added in a docs-only follow-up commit.
- **Migration:** `20261115120000_m9b_chargebee_connector_kind` (+ down-script).

### Gates (working tree, before commit; code identical to `07b52f5`)

| Gate                        | Command                                                                                                        | Result                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static + all tests          | `pnpm verify`                                                                                                  | exit 0 — format, lint, typecheck, depcheck (330 modules, 1,400 deps, 0 violations); unit **61 files / 878 tests**; integration **25 files / 449 tests** |
| Runtime                     | `pnpm verify:runtime`                                                                                          | **163 passed, 0 failed** (incl. 13 checks of `80-chargebee.sh`)                                                                                         |
| Docker                      | `LIP_DOCKERFILE=… LIP_DOCKER_BUILD_ARGS="--network host --build-context ca=…" pnpm verify:docker` (sandbox CA) | **27 passed, 0 failed** (incl. 4 M9B checks)                                                                                                            |
| Sugar module unchanged      | `git diff ba72e91 -- apps/api/src/modules/sugar`                                                               | 0 lines                                                                                                                                                 |
| No Chargebee import in core | `grep -rl chargebee src/modules/{domain,sources,products}`                                                     | only `domain/connector-kinds.ts` (catalogue data); dependency rules enforce the rest                                                                    |

The first runtime run reported **162 passed, 1 failed**: the M8 check in `70-source-connectors.sh` hard-coded
5 connector kinds. M9B intentionally adds the sixth; the expected count was updated to 6 (the RLS half of the
check is unchanged) and the rerun was green. No retry hid a flake.

New/changed suites: adapter unit `chargebee-connector.spec.ts` **34 tests**; `chargebee-sync.int.spec.ts`
**34 tests** (CB01–CB36 + profiling + publication); `migrations.int.spec.ts` **57 tests** (M9B describe plus
newest-first down-script order in two M8/M9A tests); domain unit additions (timestamp transform, coverage
acceptance, Unix-seconds profile rule).

### Regression

- Sugar: module diff empty; every M8/M9A Sugar integration test passes; `count → externally_grounded` asserted
  in `protection.int.spec.ts` (unchanged) and runtime 75 (`count:externally_grounded:passed`).
- CSV: `operator_full_file → stable_snapshot` asserted in `protection.int.spec.ts` and runtime 60 (unchanged).
- Chargebee: `double_enumeration → stable_snapshot` (CB29, runtime 80); never `externally_grounded` (C6).
- M9A profiling/privacy: all M9A tests pass; Chargebee profiles hold no key, customer value or payment data
  (integration + runtime 80).
- Product Model: no auto-created products (CB17/C18). Authority: Chargebee holds lines, state and terms
  together; acceptance required for tombstones (CB29/CB30).

### Fake CB01–CB36

All applicable scenarios pass on the fake (`test/chargebee/chargebee-sync.int.spec.ts`, plus the adapter unit
suite for CB02/CB13/CB21/CB23/CB24/CB26/CB31/CB32/CB34 at transport level):

| #         | Result on the fake                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CB01–CB09 | PASS (one line; plan + 2 add-ons; no collapse; trial/unknown/active/cancelled/unknown/unknown; unlisted status → unknown + unmapped)                            |
| CB10–CB11 | PASS (renewal and quantity update the same line)                                                                                                                |
| CB12      | PASS (fallback identity: old price line retired by G4, new line created)                                                                                        |
| CB13      | PASS (USD/EUR → one product, two lines)                                                                                                                         |
| CB14–CB15 | PASS (upgrade: A retired by G4; add-on removed: retired by G4 on an incremental run, V12 assumed)                                                               |
| CB16–CB18 | PASS (charge filtered out; unmodelled item fails before writes; ignored item: no line, no gap)                                                                  |
| CB19      | PASS (see deviation 5)                                                                                                                                          |
| CB20      | PASS with deviation 3 (reference retired; lines kept on the canonical company)                                                                                  |
| CB21–CB23 | PASS (deletion only for the deleted subscription; cancelled → active same line; unknown price protected with a gap, nothing retired)                            |
| CB24      | PASS with deviation 4 (boundary rejection, protected)                                                                                                           |
| CB25      | PASS (repeated key fails closed under both identities)                                                                                                          |
| CB26      | PASS (240 extra subscriptions, ≥ 3 pages per pass, a transient 503 retried)                                                                                     |
| CB27      | PASS (only changes, overlap ≥ 10 min, no absence tombstone; V12 assumed)                                                                                        |
| CB28–CB30 | PASS (between-pass insert → `unstable_read`; accepted: tombstones allowed, absence unknown, no whitespace; not accepted: `proof_not_accepted`, zero tombstones) |
| CB31–CB34 | PASS (429 storm honoured; PC 1.0 → `catalog_version_unsupported`; drift findings; 403 → `forbidden`, no partial run)                                            |
| CB35      | PASS (full and incremental; unattributable parent fails the run before tombstones)                                                                              |
| CB36      | PASS (sync and profiling: `pagination_stalled` after 2 list requests; no proof, coverage and tombstones unchanged)                                              |

### Mutation proofs (C1–C22)

Harness: break one mechanism, run the named test (must fail for the stated reason), restore, rerun green.
Every mutation below **failed as expected** and every restore was green (`Tests 1 passed`, exit 0).

| #    | Mutation                                               | Killing test                                                                           | Failure observed                                          |
| ---- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| C1   | Transport allows POST                                  | unit `lets only GET to the four allowlisted list endpoints through`                    | expected the guard to throw                               |
| C2   | Allowlist admits `/invoices`                           | unit `refuses every path outside the allowlist…`                                       | expected the guard to throw                               |
| C3   | `card` kept in records                                 | unit `C3: the synthetic card … is discarded unread`                                    | records matched `/card/masked/…/`                         |
| C4   | Pass 2 skipped                                         | int `CB28/C4/C5/C8 … unstable_read`                                                    | run not `failed/unstable_read`                            |
| C5   | Set comparison ignores an inserted record              | int `CB28/C4/C5/C8`                                                                    | run not `failed/unstable_read`                            |
| C6   | Proof recorded as `count`                              | int `CB29: a stable full run …`                                                        | proof `{method: count}` ≠ `double_enumeration`            |
| C7   | Tombstones without acceptance                          | int `CB30/C7`                                                                          | `tombstones_not_accepted` missing (tombstoned)            |
| C8   | Enumeration mismatch tolerated                         | int `CB28/C4/C5/C8`                                                                    | run not `failed/unstable_read`                            |
| C9   | G4 ignores a protected sibling                         | int `CB23: an unknown item price …`                                                    | `child_reconciliation_skipped` missing (old line retired) |
| C9b  | Uncertain set does not shield the full-run tombstone   | int `CB23: an unknown item price …`                                                    | old add-on line no longer active                          |
| C10  | G4 runs on a rejected parent                           | int `full run: a rejected parent never reconciles …`                                   | `child_retired` = 3                                       |
| C11  | Item line id built from the item price id              | unit `CB02: one row per subscription item …`                                           | `line_key_item` = price ids                               |
| C12  | Duplicate key not detected                             | int `CB25/C12`                                                                         | `duplicate_external_id` 1 ≠ 2                             |
| C13  | Unknown status → `active`                              | int `CB09/C13`                                                                         | state `active` ≠ `unknown`                                |
| C14  | Unix seconds accept milliseconds                       | unit `M9B: Unix seconds (UTC) parse … milliseconds are invalid_date`                   | ms parsed `ok: true`                                      |
| C15  | `item_id` falls back to the price id                   | unit `CB23: an unknown item price resolves to a null item`                             | `ghost-price-USD` ≠ null                                  |
| C16  | Incremental window without overlap                     | int `CB27/C16`                                                                         | `updated_at[after]` above watermark − 10 min              |
| C17  | `deleted: true` treated as cancelled                   | int `CB21/C17`                                                                         | lines not `deleted` (state rewritten)                     |
| C18  | Unmodelled item accepted (refusal removed)             | int `CB17/C18`                                                                         | run not `failed/unmodelled_product_reference`             |
| C19  | Settle window removed                                  | int `C19: the settle window …`                                                         | just-created subscription written                         |
| C20  | Read-only key check bypassed                           | **N/A** — not implementable without a write attempt; conditional on V8 (tech debt #61) | —                                                         |
| C21  | G4 retires a protected child of a rejected parent      | int `full run: a rejected parent never reconciles …`                                   | `child_retired` = 3                                       |
| C22  | Non-progress detection removed (sync)                  | int `CB36/C22`                                                                         | run not `failed/pagination_stalled`                       |
| C22b | Non-progress detection removed (profiling)             | int `a repeated next_offset fails a profile run …`                                     | profile run not `failed/pagination_stalled`               |
| X1   | Migration lets a Chargebee integration be `read_write` | int `the M9B down-script refuses …`                                                    | UPDATE to `read_write` resolved instead of rejecting      |

**Runtime proof:** with the adapter temporarily also reading `GET /invoices` (allowlist widened), runtime
reported **162 passed, 1 failed** — exactly `only GETs to the four allowlisted list endpoints reached the fake`;
restored, then green.

### Fresh clone

Fresh `git clone` of `claude/blissful-mendel-urbh4r`, HEAD `07b52f5579fc71be3e963b06ed2bdb3da145c128` (matches
the implementation SHA), `pnpm install --frozen-lockfile` exit 0, then:

| Step                  | Result                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| `pnpm verify`         | exit 0 — unit 61 files / 878 tests; integration 25 files / 449 tests          |
| `pnpm verify:runtime` | **163 passed, 0 failed**                                                      |
| `pnpm verify:docker`  | **27 passed, 0 failed** (first attempt)                                       |
| Resources after       | 0 app processes, 0 containers, 0 volumes, 0 networks, 0 images; clone removed |

## Approved correction: live records only

Approved by the owner after the live baseline (reused subscription id, V5/V7). Implemented in the adapter only:

- `include_deleted` is never sent (Customers, Subscriptions, SubscriptionItems); any `deleted: true` entry the API
  still returns is dropped by the adapter, so it can neither collide with a live record of a reused id nor act as
  deletion evidence. `deleteVisibility` is `none` for the three objects.
- A deleted subscription is **absent**: its lines are retired only by the next full run whose double enumeration
  passed **and** whose proof is accepted, under every M9A protection (seen-but-rejected, gaps, B guards,
  unattributable refusal). Without an acceptance: `tombstones_not_accepted`, lines stay. G4 keeps retiring removed
  children of subscriptions that are read. No account deletion is inferred from absence.
- Plan revision 3, ADR 0024 amendment; tech-debt #57 (deleted-customer reference) is superseded: customer
  references are never retired from absence.

Tests (fake): CB20 (customer and its subscription deleted → lines retired by the accepted full run, reference kept),
CB21 split into "never retired without acceptance" and "retired by the next accepted full run (not cancelled)",
new **V5/V7 id-reuse** scenario (deleted copy with the live id on another page, returned even unrequested, page size
10: proof passed, no duplicate, S02 lines ingested, rerun 0 changes), adapter unit tests (no `include_deleted` ever
sent; deleted entries dropped; reused id yields one live set). Mutations C17 (live-only filter removed → V5/V7
scenario fails) and C17b (`include_deleted` requested → unit test fails) replace the old C17.

Also fixed: a brittle assertion in two tests matched the regex `1111` anywhere in a dump (random UUIDs/hashes/
timestamps could contain it); it now matches the card markers only (`masked_number`, `card_type`, `****1111`,
`visa`). Observed once as a failure of the default-dataset test during this correction; not a product defect.

### Verification of the correction

| Gate                             | Result                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chargebee unit suite             | 35/35                                                                                                                                                                                    |
| Chargebee integration            | 36/36 (CB01–CB36 + id reuse + profiling + publication)                                                                                                                                   |
| Mutations (all, rerun)           | 25/25 killed for the stated reason, every restore green (C20 N/A)                                                                                                                        |
| `pnpm verify` / runtime / Docker | verify exit 0 (unit 61 files / 879 tests; integration 25 files / 451 tests; depcheck 0 violations); runtime **163 passed, 0 failed**; Docker **27 passed, 0 failed** (code of `015910a`) |

### Fresh clone of the correction (`015910a`)

| Run | verify                   | runtime                                                                    | Docker | Resources after         |
| --- | ------------------------ | -------------------------------------------------------------------------- | ------ | ----------------------- |
| 1   | exit 0 (879 + 451 tests) | **162 passed, 1 failed** — M6 `context worker stops gracefully on SIGTERM` | 27/0   | all zero; clone removed |
| 2   | exit 0 (879 + 451 tests) | **163 passed, 0 failed**                                                   | 27/0   | all zero; clone removed |

Run 1's failure is in the M6 context-worker shutdown check (exit within 15 s **and** `Application shut down
cleanly` in the worker log), which no M9B change touches. It is **not explained**: the runtime script deletes its
work directory, so the worker log was lost. It did not reproduce in two working-tree runtime reruns (163/0 each) nor
in fresh-clone run 2. It has never failed in any earlier recorded runtime run. Tracked as tech debt #62 (keep the
logs of a failed runtime check; investigate the shutdown timing). Not used to claim green on its own: run 2 is the
green fresh-clone evidence and run 1 is disclosed here.

### Live rerun (fresh environment, 2026-10-08 ~20:40Z)

| Check                     | Observed                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key A full run (page 100) | completed; `double_enumeration / stable_snapshot / passed`; rerun 0 changes                                                                              |
| Lines                     | **24 of 25** expected written (the 25th is the ignored Legacy item, no gap); every written line matches status map, terms, quantity and resolved product |
| S02 (reused id)           | **3/3 lines ingested** correctly; no `duplicate_external_id`; no gaps                                                                                    |
| S09                       | `paused → unknown`                                                                                                                                       |
| Page size 10              | **completed**, proof passed, 24 lines, 0 duplicates, S02 3 lines; rerun passed — no false `unstable_read`                                                |
| Coverage / whitespace     | `stable_snapshot` (accepted); S01 account: eligible whitespace 0                                                                                         |
| Incremental               | refused (`incremental_not_supported`)                                                                                                                    |

### V8 — Key B rerun after a confirmed fresh environment load

The container (and its environment) restarted at 19:54Z after the owner updated the secret.

| Endpoint (Key B) | Result                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/customers`     | 200                                                                                                                        |
| `/subscriptions` | 200                                                                                                                        |
| `/items`         | **403** `api_authorization_failed` (body keys: `api_error_code`, `error_code`, `error_msg`, `http_status_code`, `message`) |
| `/item_prices`   | **403** `api_authorization_failed` (same shape)                                                                            |
| `/item_families` | **200** — still readable (not used by the connector)                                                                       |

Connector with Key B on a tenant that already holds an accepted Key A run: `testConnection` → `forbidden`; full run
→ **failed `source_forbidden`** before any line write (catalogue first); lines identical before/after (24 active),
0 records changed, 0 tombstones, coverage unchanged (same proof run). Neither key appears in any report, log or file
(asserted and scanned).

## Live mutation M01 — S02 Seats quantity 3 → 5 (2026-10-08)

Executed by the owner's setup agent (HTTP 200; no other record reported changed). Verified independently through the
connector with a fresh full pipeline run (Key A, `test/live/chargebee-baseline.live.spec.ts`), sanitized:

| Check                 | Observed                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S02 accepted          | yes — 3 lines written, no rejection, no `duplicate_external_id`, no gap                                                                                           |
| Seats line            | quantity **5**; identity unchanged — key `<subscription_id>:<item_price_id>` with the same item price (the mutation changed quantity only; 3 S02 lines as before) |
| Product resolution    | unchanged — each S02 line resolves to the item of its item price (plan, 2 add-ons)                                                                                |
| Other S02 lines       | plan quantity 1, Support add-on quantity 1; state `active`; terms equal the raw `current_term_*`                                                                  |
| Status / terms        | `active`; terms unchanged and equal to the raw values                                                                                                             |
| Whole tenant          | 24 active lines (same as the pre-M01 baseline), by state active 17 / unknown 3 / trial 2 / cancelled 2 (unchanged), no gaps, no deletion                          |
| Double read           | page 100 and page 10 both `double_enumeration / stable_snapshot / passed`; rerun 0 changes                                                                        |
| Coverage / whitespace | `stable_snapshot` (accepted); S01 account eligible whitespace 0                                                                                                   |
| Key B                 | still `forbidden` / `source_forbidden`, no change                                                                                                                 |

**V12 evidence (parent Subscription S02):**

- `updated_at`: before `1791486525` (owner, and **independently read** by this connector's probe before M01) → after
  `1791494001` (owner, immediately after the call) → `1791494007` when read here (6 s later: S02 was updated once more
  after the mutation call; not visible from a read which attribute changed).
- `resource_version` (milliseconds): before `1791486525252` (owner) → after `1791494001827` (owner) →
  `1791494007579` when read here.
- Subscription items carry no `updated_at` / `resource_version` of their own (owner; confirmed by the probe's field
  list).

**V12 status: LIVE CONFIRMED for a subscription-item quantity change** — changing a nested item moves the parent's
`updated_at` and `resource_version`. Not yet observed for an item **removal** (M02), a **price-point change** (M03)
or a plan **change** (M04). Incremental line sync stays **disabled**: the plan (B8) enables it per connection
(`incrementalLines: verified`) only once V12 is proven; recommendation: decide after M02–M04 confirm the same
behaviour for removals and replacements, which are what G4 relies on in incremental runs.

## Live mutation M02 — S02 Support add-on removed (2026-10-08)

**Source side (owner's setup agent):** HTTP 200; S02 before: Pro plan 1, Seats 5, Support 1 → after: Pro plan 1,
Seats 5. **Live Chargebee mutation behaviour (setup API, not connector reads):** `update_for_items` merges item
lists by default — omitting Support did not remove it; `quantity=0` was rejected; `remove_items` did not remove it in
this test; the removal succeeded only with `replace_items_list=true` and the reduced item list.

**Connector verification** (`test/live/chargebee-baseline.live.spec.ts`, test "M02", Key A, sanitized). To prove G4
needs a canonical Support line to exist first, run 1 **replays S02's pre-M02 child set** (the live data plus the
removed Support line, its key fingerprint proven identical to the post-M01 evidence); run 2 reads the live site
unchanged:

| Check                    | Observed                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live S02                 | 2 subscription items; Support absent                                                                                                                                                                                                                                                          |
| Run 1 (replayed pre-M02) | completed, proof passed; S02 3 active lines (Pro 1, Seats 5, Support 1)                                                                                                                                                                                                                       |
| Run 2 (live)             | completed; proof `double_enumeration / stable_snapshot / passed`; quality `child_retired: 1`, no `tombstoned`, no `child_reconciliation_skipped`, no rejection                                                                                                                                |
| G4 evidence              | S02 was observed with a complete, accepted child set (2 accepted rows on one page, no rejected/protected/duplicate child, not split) and its active Support line was absent from it → retired by `reconcileChildren` (`child_retired`), before and independent of the full-run tombstone pass |
| S02 after                | **2 active lines**: Pro (qty 1) and Seats (qty **5**); Support `record_state = deleted` (state left `active`, not rewritten)                                                                                                                                                                  |
| Identities / products    | Pro and Seats keys and resolved products identical to the post-M01 evidence                                                                                                                                                                                                                   |
| Unrelated lines          | active 24 → 23; the only retired key is Support; diff against the post-M01 fingerprints: 1 removed (Support), 0 added, 0 changed                                                                                                                                                              |
| Status / terms           | `active`; terms equal the raw `current_term_*`                                                                                                                                                                                                                                                |
| Gaps / protection        | no ownership gap; no seen-but-rejected; reviewed-domain filter unchanged (`non_subscription_product` 1 = the ignored Legacy item)                                                                                                                                                             |
| Coverage / whitespace    | `stable_snapshot` from run 2; S02 account eligible whitespace 0; S01 account 0                                                                                                                                                                                                                |
| Page size 10             | completed, proof passed, S02 2 lines                                                                                                                                                                                                                                                          |
| Key B                    | `forbidden` / `source_forbidden`, no change                                                                                                                                                                                                                                                   |

**V12 removal (parent S02):** `updated_at` `1791494007` → `1791494493`; `resource_version` `1791494007579` →
`1791494493303`. Both "before" values were read by this connector in the M01 verification; both "after" values read
now (identical to the setup agent's). **V12 REMOVAL LIVE CONFIRMED.** Incremental line sync stays disabled until
M03 (price replacement) and M04 (plan replacement) are verified.

## Live mutation M03 — S10 price replacement, Basic monthly USD → Basic yearly USD (2026-10-08)

**Source side (owner's setup agent):** HTTP 200 with `replace_items_list=true`; quantity 1, status `active`; the item
(product) is the same Basic item before and after; no other checked subscription changed.

**Connector verification** (generic replay check in `test/live/chargebee-baseline.live.spec.ts`, Key A, sanitized):
run 1 replays S10's pre-M03 item list (Basic monthly USD, qty 1 — its line key fingerprint is the one in the post-M02
evidence), run 2 reads the live site unchanged.

| Check                        | Observed                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live S10                     | 1 item: Basic **yearly** USD, qty 1                                                                                                                                |
| Run 1 (replayed pre-M03)     | completed, proof passed; S10 1 active line = `<subscription_id>:<monthly price>`                                                                                   |
| Run 2 (live)                 | completed; proof `double_enumeration / stable_snapshot / passed`; `child_retired: 1`; no rejection, no uncertain set, no tombstone pass involvement                |
| Old line                     | `<subscription_id>:<monthly price>` → `record_state = deleted` (G4), state left `active`                                                                           |
| New line                     | `<subscription_id>:<yearly price>` created, `active`, qty 1                                                                                                        |
| Identities                   | the two keys share the subscription part and differ **only** in the item-price part (fingerprints of both keys equal the hashes of the expected identity strings)  |
| Product                      | both lines resolve to the **same Basic item** (identical product key = the item's fingerprint)                                                                     |
| Status / terms               | `active`; terms equal the raw `current_term_*` (term after the change)                                                                                             |
| Unrelated lines              | changed keys: exactly the two S10 keys; active lines 23 → 23; diff against the post-M02 fingerprints: 1 removed (old monthly line), 1 added (yearly line), 0 other |
| Gaps / coverage / whitespace | no gap; `stable_snapshot` from run 2; S10 account eligible whitespace 0; S01 account 0                                                                             |
| Page size 10 / Key B         | proof passed / `forbidden`, `source_forbidden`, no change                                                                                                          |

**V12 price replacement (parent S10):** `updated_at` `1791486548` (owner, before) → `1791495211` (owner, after the call)
→ `1791495217` read here; `resource_version` `1791486548362` → `1791495211332` → `1791495217509`. As in M01, S10 was
updated once more ~6 s after the call (not visible from a read which attribute). The "before" values are the owner's
(this connector had not recorded S10's parent before M03); the "after" values were read independently and are
later than the "before". **V12 PRICE REPLACEMENT LIVE CONFIRMED.** Incremental line sync stays disabled until M04.

## Live mutation M04 — S12 plan replacement, Basic monthly USD → Pro monthly USD (2026-10-08)

**Source side (owner's setup agent):** HTTP 200 via `update_for_items` with `replace_items_list=true`; quantity 1,
status `active`; product Basic → Pro; no unrelated record modified. **Live Chargebee mutation behaviour (setup API,
not connector reads):** `trial_end=0` had to be supplied explicitly, otherwise the Pro price's default trial would have
moved the subscription into a trial.

**Connector verification** (generic replay check, Key A, sanitized): run 1 replays S12's pre-M04 item list (Basic
monthly USD, qty 1 — key fingerprint identical to the post-M03 evidence), run 2 reads the live site unchanged.

| Check                                              | Observed                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live S12                                           | 1 item: Pro monthly USD, qty 1, `active`                                                                                                                                                                     |
| Run 2 (live)                                       | completed; proof `double_enumeration / stable_snapshot / passed`; `child_retired: 1`; no rejection or uncertain set                                                                                          |
| Old line `<subscription_id>:<Basic monthly price>` | resolves to the Basic item; retired by G4 (`record_state = deleted`, state left `active`)                                                                                                                    |
| New line `<subscription_id>:<Pro monthly price>`   | resolves to the Pro item; created through the normal ingest path, `active`, qty 1                                                                                                                            |
| Identities                                         | key fingerprints equal the hashes of the two expected identity strings; they differ only in the item-price part                                                                                              |
| Ownership (S12 account)                            | owned products before: {Basic} → after: {Pro}; eligible whitespace 0 before and after                                                                                                                        |
| Status / terms                                     | `active`; terms equal the raw `current_term_*`                                                                                                                                                               |
| Unrelated lines                                    | changed keys: exactly the two S12 keys; active 23 → 23; diff vs post-M03 fingerprints: 1 removed, 1 added, 0 other                                                                                           |
| Gaps / coverage                                    | no gap; `stable_snapshot` from run 2                                                                                                                                                                         |
| Page size 10 / Key B                               | proof passed / `forbidden`, `source_forbidden`, no change                                                                                                                                                    |
| Incremental window probe (read-only)               | `updated_at[after]` + `sort_by[asc]=updated_at` accepted by the live API; window since before M02 returned exactly S02, S10, S12 (the three mutated parents), ordered by `updated_at`, all inside the window |

**V12 plan replacement (parent S12):** `updated_at` `1791486576` (owner) → `1791495611` (owner, after the call) →
`1791495617` read here; `resource_version` `1791486576495` → `1791495611107` → `1791495617217` (again one further update
~6 s after the call). **V12 PLAN REPLACEMENT LIVE CONFIRMED.**

## Live mutation M05 — S15 immediate cancellation (2026-10-08)

**Source side (owner's setup agent):** HTTP 200 via `cancel_for_items` with `end_of_term=false`; status
`active → cancelled`; `cancelled_at` set; `current_term_start` unchanged; `current_term_end` moved to the cancellation
instant; item unchanged (Basic monthly USD, qty 1); no unrelated record modified.

**Connector verification** (generic replay check, Key A, sanitized): run 1 replays S15's pre-M05 parent fields
(`status: active`, no `cancelled_at`, the original term end); run 2 reads the live site.

| Check                        | Observed                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live S15 (raw read)          | `cancelled`, `deleted: false`, 1 item; `current_term_end` = `cancelled_at`; `current_term_start` unchanged                                                                                                                                                                                                                                                         |
| Run 2 (live)                 | completed; proof `double_enumeration / stable_snapshot / passed`; **no** `child_retired`, no tombstone, no rejection                                                                                                                                                                                                                                               |
| Line                         | same key `<subscription_id>:<Basic monthly price>` (fingerprint unchanged), `record_state` **active** (not deleted), state `active` → **`cancelled`**, qty 1, product unchanged (Basic)                                                                                                                                                                            |
| Terms                        | start unchanged; end = the cancellation instant (equal to the raw values)                                                                                                                                                                                                                                                                                          |
| State conflict               | S15's line evaluated **alone** with the platform's ownership rule: `unknown` / `coverage_tier_insufficient` (the stable-snapshot rule: absence of ownership is never concluded) — **not** `subscription_state_conflict`, because the term is no longer running. The account-level evaluation of Basic stays `owned` through the account's other subscription (S01) |
| Unrelated lines              | changed keys: only the S15 line's state; active 23 → 23; by state active 15 / unknown 3 / trial 2 / cancelled 3                                                                                                                                                                                                                                                    |
| Gaps / coverage / whitespace | no gap; `stable_snapshot` from run 2; eligible whitespace 0 (S15 account and S01 account)                                                                                                                                                                                                                                                                          |
| Page size 10 / Key B         | proof passed / `forbidden`, `source_forbidden`, no change                                                                                                                                                                                                                                                                                                          |
| Incremental window probe     | since just before M05: exactly S15 returned                                                                                                                                                                                                                                                                                                                        |

**Parent timestamps:** `updated_at` `1791486578` (owner) → `1791496087` (owner; read here identically);
`resource_version` `1791486578529` → `1791496087034` (read here identically). Additional live evidence that an
API-driven **status** change moves the parent's `updated_at` and `resource_version`. Incremental decision unchanged
(disabled).

## Live mutation M06 — S15 reactivation (2026-10-08)

**Source side (owner's setup agent):** `POST /subscriptions/{id}/reactivate` HTTP 200; status `cancelled → active`; same
subscription id, no new subscription; `cancelled_at` cleared; a new current term (start and end) created; item list
unchanged (Basic monthly USD, qty 1); no unrelated record changed. **Live environment dependency (not a connector
defect):** the first M06 attempt returned 404 because the site-level **Allow Reactivation** setting was disabled; with it
enabled the documented endpoint worked.

**Connector verification** (generic replay check, Key A, sanitized): run 1 replays S15's pre-M06 cancelled state
(`cancelled`, `cancelled_at` and term end at the cancellation instant); run 2 reads the live site.

| Check                            | Observed                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live S15 (raw read)              | `active`, `cancelled_at` absent, new term start/end, 1 item (Basic monthly USD, qty 1); exactly **one** S15 record even with `include_deleted=true`; 20 live subscriptions (unchanged) |
| Run 2 (live)                     | completed; proof `double_enumeration / stable_snapshot / passed`; no `child_retired`, no tombstone, no rejection                                                                       |
| Line                             | same key (fingerprint unchanged), `record_state` active, state `cancelled` → **`active`**, qty 1, product unchanged (Basic)                                                            |
| Terms                            | equal the raw new term start/end                                                                                                                                                       |
| Isolated ownership of S15's line | `owned` / `ok` (was `unknown` / `coverage_tier_insufficient` when cancelled)                                                                                                           |
| Unrelated lines                  | changed keys: only the S15 line's state; active 23 → 23; by state active 16 / unknown 3 / trial 2 / cancelled 2                                                                        |
| Gaps / coverage / whitespace     | no gap; `stable_snapshot` from run 2; eligible whitespace 0 (S15 account and S01 account)                                                                                              |
| Page size 10 / Key B             | proof passed / `forbidden`, `source_forbidden`, no change                                                                                                                              |
| Incremental window probe         | since just before M06: exactly S15 returned                                                                                                                                            |

**Parent timestamps:** `updated_at` `1791496087` → `1791497253`; `resource_version` `1791496087034` →
`1791497253412`. Both "before" values were read by this connector in the M05 verification; both "after" values read
now (identical to the owner's). Further live evidence that API-driven status transitions move the parent's
`updated_at` and `resource_version`. Incremental sync remains disabled.

## Live mutation M07 — S04 subscription deletion; safe full-run retirement (2026-10-09)

**Source side (owner's setup agent):** DELETE HTTP 200; deletion is asynchronous. Before: `active`, Basic monthly qty 1.
After it settled: single-record GET → `404 resource_not_found` (also with `include_deleted=true`); normal LIST → S04
absent; LIST with `include_deleted=true` → S04 present with `deleted: true`, status still `active`, `updated_at` and
`resource_version` advanced; no replacement S04.

**Connector verification** (live spec test "M07", Key A, sanitized). The pre-M07 S04 record is replayed from the deleted
list row as **test replay data only** (`deleted` forced false); every request the connector sent was intercepted.

| Step                                                                                                                           | Observed                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source (read here)                                                                                                             | one deleted S04 row in the `include_deleted` list, no live record with that id, absent from the normal list, single GET 404 with and without `include_deleted`, deleted row status `active`, 1 item                                                                                                             |
| Run 1 — replayed pre-M07 state, **no acceptance**                                                                              | completed, proof passed; S04 line `<subscription_id>:<Basic monthly price>` active, qty 1                                                                                                                                                                                                                       |
| Run 2 — live read, **no acceptance**                                                                                           | completed, proof passed; S04 absent from the read; **nothing changed** (S04 line still active); `tombstones_not_accepted: 1`; coverage `proof_not_accepted`                                                                                                                                                     |
| Run 3 — acceptance published; **accepted** full run (double enumeration passed); S03 made structurally invalid in the same run | S04 line → `record_state = deleted` (state left `active`); quality `tombstoned: 1`, **no `child_retired`**; S03: `record_rejected: 1`, `seen_but_rejected: 1`, `tombstones_suppressed: 1`, gap `observation_rejected` on its account, S03's line **unchanged** (protected); changed keys: **only** the S04 line |
| Run 4 — clean accepted rerun                                                                                                   | no change (S04 retired **exactly once**); S03 normal again; gaps cleared; coverage `stable_snapshot`                                                                                                                                                                                                            |
| Connector requests (24)                                                                                                        | **none** carried `include_deleted`                                                                                                                                                                                                                                                                              |
| Whitespace (S04 account)                                                                                                       | owned products unchanged through the account's other subscription; eligible whitespace 0                                                                                                                                                                                                                        |
| Whole tenant (normal live spec run)                                                                                            | 19 live subscriptions, 22 active lines (was 23 after M06): the diff against the post-M06 fingerprints is exactly the S04 line removed, nothing added or changed; page size 10 proof passed; Key B `forbidden` / `source_forbidden`, no change                                                                   |

**Deletion-path classification:** the accepted **full-run absence (tombstone) pass** (`tombstoned`), gated by a passed
double enumeration **and** an operator acceptance — not child reconciliation (no `child_retired`; S04 was not observed,
so no child set existed), not cancellation (state unchanged), not explicit `deleted=true` processing (never requested,
never read).

**V5 final: LIVE RESOLVED.** Deleted subscriptions are visible only through LIST with `include_deleted=true` (with
`deleted: true`, status unchanged); single-record GET returns 404 even with `include_deleted`; deletion is asynchronous;
retention of deleted list rows is undocumented and not depended on; deleted/live id reuse is possible (S02). The approved
live-records-only design (absence retired only by an accepted full run) is confirmed correct.

## V12 final decision and incremental-sync assessment

**V12: LIVE CONFIRMED for API-driven subscription-item changes** — quantity change (M01), item removal (M02), price
replacement within an item (M03) and plan/product replacement (M04) each moved the parent's `updated_at` and
`resource_version`. **Not covered:** changes Chargebee applies by itself over time (trial end, scheduled
cancellation at term end, `future` → `active`, scheduled changes, renewals); whether those move `updated_at` is not
observed.

Assessment of the existing incremental algorithm against the live evidence (no code changed):

| Concern                                            | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nested quantity / removal / price / product change | Parent `updated_at` moves (M01–M04) → the parent re-enters the window; its complete child set is re-read in one record; G4 retires removed children, new children are ingested (as proven on full runs)                                                                                                                                                                                                        |
| Checkpoint                                         | the run boundary (`run start − settleMinutes`) stored as `highWatermark`; next window `since = last completed run's highWatermark − overlapMinutes`; within a run, resume via the opaque position                                                                                                                                                                                                              |
| Ordering / ties                                    | `sort_by[asc]=updated_at` with `updated_at[after]=since−1` / `[before]=boundary+1` (seconds, widened). A compound `(updated_at, id)` checkpoint is **not** required: windows overlap, writes are idempotent (field-hash), and the continuation token is a two-part value (V2) consistent with keyset paging; records updated during the read have `updated_at` > boundary and are picked up by the next window |
| Pagination                                         | `pagination_stalled` and page ceiling apply; a parent split across pages makes its set uncertain (no retirement)                                                                                                                                                                                                                                                                                               |
| Overlap / replay                                   | re-reading a parent is idempotent (rerun 0 changes, live)                                                                                                                                                                                                                                                                                                                                                      |
| Duplicates / seen-but-rejected                     | duplicate keys fail closed; G4 honours `mayTombstone`; incremental runs never run the tombstone pass; gaps are only added                                                                                                                                                                                                                                                                                      |
| Deletion                                           | **full-run only**: reads are live-records-only, so a deleted subscription never appears in a window; it is retired by the next accepted full run                                                                                                                                                                                                                                                               |
| Coverage                                           | only full (`backfill`) runs carry a proof; incremental runs neither establish nor raise coverage                                                                                                                                                                                                                                                                                                               |

**Recommendation (not enabled):**

1. Incremental Subscription/SubscriptionItem reads are **architecturally safe to enable per connection** for the
   API-driven changes above, **provided** periodic accepted full runs continue.
2. Checkpoint: the existing run boundary/`highWatermark` (seconds); no new checkpoint type.
3. `updated_at` + source id are **not** both required for checkpointing (reasons above); ordering by `updated_at`
   with the opaque continuation token is sufficient.
4. Overlap/lookback: `overlapMinutes ≥ 10` and `settleMinutes ≥ 1` (an asynchronous follow-up update ~6 s after each
   mutation was observed; V9 lag otherwise unmeasured).
5. Periodic accepted full runs remain **required** — for deletions, completeness/coverage proof, and to bound
   staleness from time-driven transitions that V12 has not covered (recommend at least daily).
6. Work before enabling: **no code change**. Required: (a) set `incrementalLines: "verified"` in the connection
   config, re-capture the snapshot and publish a new mapping version (governed; the snapshot hash changes);
   (b) set `sync.settleMinutes` / `sync.overlapMinutes` as above; (c) an operational schedule for periodic full runs —
   **the platform has no scheduler today** (runs are started by the CLI/worker on request), so this is operational
   or follow-up work; (d) owner decision on the time-driven-transition gap (accept bounded staleness until the next
   full run, or verify on the test site, e.g. a trial ending).

## V2–V12 (live gate)

| #   | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | **DOC-CONFIRMED** (F18); live: every timestamp observed is integer UTC seconds; `resource_version` is milliseconds                                                                                                                                                                                                                                                                                                                                         |
| V2  | **LIVE-OBSERVED (baseline, quiescent site):** `next_offset` is an opaque JSON array of two strings; distinct per page, identical on a second pass, replaying an offset returns the same page; order follows `sort_by[asc]=created_at`. Behaviour under concurrent writes (CB28): PENDING                                                                                                                                                                   |
| V3  | **LIVE-RESOLVED** (owner, confirmed by read): same item + same item price twice → `400 duplicate_entry`; same item + different item prices → allowed (one live subscription holds it). `<subscription_id>:<item_id>` is **not** safe; the line identity stays `<subscription_id>:<item_price_id>`                                                                                                                                                          |
| V4  | **LIVE-CONFIRMED (baseline):** `non_renewing` keeps a future `current_term_end` (`cancelled_at` = term end); immediate `cancelled` keeps `current_term_end` = `cancelled_at` (one cancelled subscription that never started has no term). Connector terms match the raw values for every written line                                                                                                                                                      |
| V5  | **LIVE RESOLVED (M07):** deleted subscriptions appear only in LIST with `include_deleted=true` (`deleted: true`, status unchanged); single GET 404 even with `include_deleted`; deletion asynchronous; retention undocumented; id reuse possible. Approved design (live-records-only; absence retired by an accepted full run) confirmed                                                                                                                   |
| V6  | PENDING (M09/M10) — `include_deleted=true` is accepted on `/items` and `/item_prices`; no archived/deleted catalogue record exists yet                                                                                                                                                                                                                                                                                                                     |
| V7  | **PARTLY RESOLVED:** ids ≤ 40 chars, charset `[A-Za-z0-9_.@-]`, never `:` (the separator is safe). **Ids are not unique over time:** a deleted subscription's id was reused by a new subscription (docs: item/item price ids are reusable after deletion too)                                                                                                                                                                                              |
| V8  | **LIVE-RESOLVED for the connector (rerun):** Items/ItemPrices 403 `api_authorization_failed`; connector fails safely (`forbidden` / `source_forbidden`, no writes, no coverage change). Item Families still 200 with this key. Superseded first observation — **NOT AS SPECIFIED:** Key B (intended without catalogue scope) returned **200** on `/items`, `/item_prices` and `/item_families`; the 403 shape could not be observed. Owner action required |
| V9  | PENDING (needs a mutation)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| V10 | PENDING — `decommissioned` is `false` on all 23 subscription records; no decommissioned record to observe                                                                                                                                                                                                                                                                                                                                                  |
| V11 | Live site is PC 2.0 (`/items` 200). PC 1.0 detection cannot be observed on this site: remains fake-only                                                                                                                                                                                                                                                                                                                                                    |
| V12 | **LIVE CONFIRMED for API-driven item changes** (quantity M01, removal M02, price replacement M03, plan replacement M04). Time-driven transitions not observed. Incremental line sync **remains disabled**; enabling is config/governance + periodic full runs (see the V12 decision)                                                                                                                                                                       |

## Live baseline (TEST site)

Run 2026-10-08 against the owner's Chargebee **TEST** site (PC 2.0, USD + EUR, synthetic data), read-only, Key A
via `TENANT_CBLIVE_CHARGEBEE_CHARGEBEE_API` (Key B via `…_NOCATALOG`). Specs: `test/live/chargebee-probe.live.spec.ts`
(raw, sanitized) and `test/live/chargebee-baseline.live.spec.ts` (whole pipeline on a local PostgreSQL); both skip
without `CHARGEBEE_LIVE_SITE` and the secrets. Sanitized: counts, codes and states only; no ids, names or values.
Neither report contains either key (asserted). Product model and the ignored Legacy item are TEST configuration
derived from the site's own catalogue at run time.

| Check                       | Observed                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testConnection` (Key A)    | `ok`, `sourceVersion v2:pc2`                                                                                                                                                                                                    |
| Schema discovery            | 5 objects; SubscriptionItems = double-enumerated child set of Subscriptions; line objects full-run only                                                                                                                         |
| Objects (raw)               | Customers 17 (0 deleted); Items 16 (plan 6, addon 8, charge 2; all active); ItemPrices 27 (USD 9, EUR 18; all resolve to an item); Subscriptions 23 records with `include_deleted` (20 live + 3 deleted), 33 subscription items |
| Subscription statuses (raw) | active 13, in_trial 3, future 2, non_renewing 2, cancelled 2, paused 1; `decommissioned` false everywhere                                                                                                                       |
| M9A profile                 | completed (Customers, Items, SubscriptionItems); findings: `high_cardinality_identifier` 3, `high_null_ratio` 4, `sensitive_values_detected` 12                                                                                 |
| Covering-profile validation | v1 and v2 valid (warning `field_not_reviewed` only); published with acknowledgements; authority with lines/state/terms + acceptance                                                                                             |
| Full run (page size 100)    | completed; proof `double_enumeration / stable_snapshot / passed`; rerun: 0 changes, proof passed again                                                                                                                          |
| Lines                       | 25 non-charge lines expected from live subscriptions; **21 written** (all `<subscription_id>:<item_price_id>`); 1 Legacy line `non_subscription_product` (ignored, no gap); **3 S02 lines not written** (see contradiction)     |
| Status mapping              | every written line matches the versioned map: active 14, unknown 3 (future 2, **paused S09 → `unknown`**), trial 2, cancelled 2; `non_renewing → active`                                                                        |
| Terms / quantity / product  | every written line: terms equal the raw `current_term_*` (seconds → instant), quantity equal, product = the item resolved from its item price                                                                                   |
| Coverage                    | known, `stable_snapshot`, method `double_enumeration`, accepted in authority v2 — never `externally_grounded`                                                                                                                   |
| Whitespace (S01 account)    | owned 1, eligible whitespace **0**, unknown 14                                                                                                                                                                                  |
| Gaps / protection           | `observation_rejected` 3 (the S02 keys), `seen_but_rejected` 3                                                                                                                                                                  |
| Incremental                 | refused: `incremental_not_supported`                                                                                                                                                                                            |
| Key B                       | `testConnection` **ok**; full run **completed** with the same proof and no change (21 → 21 active, 0 tombstones) — the catalogue was readable                                                                                   |
| Full run (page size 10)     | **failed `unstable_read`** (S02's two records fall on different pages); 11 lines written before the failure (positive observations only), no proof, no tombstone                                                                |

### Contradiction: reused subscription id (blocks M01)

The setup deleted S02 and recreated it **with the same id**. With `include_deleted=true` the list returns two
records with one id (one `deleted: true`, one live, same customer and item prices). The implementation assumes an
id identifies one record within a read:

1. **Child-set keys collide** → every S02 line key repeats → `duplicate_external_id` ×6, all protected, S02 never
   ingested (fail-closed, but the account's ownership is incomplete forever while the deleted copy is listed).
2. **Double enumeration** keys a child set by parent id → when the two records fall on different pages the read
   is `unstable_read` on **every** run.
3. **Latent safety risk:** if the deleted copy is processed after the live one on different pages (e.g. an
   `updated_at`-ordered read), its rows would emit `absent` for the **live** line keys — deletion evidence applied to
   a different record. Today only ordering and duplicate detection prevent it.

**Required correction (not implemented; needs approval):** stop treating `deleted: true` list records as deletion
evidence for subscriptions and customers — read without `include_deleted` (live records only; ids unique) and
retire disappeared records only under the already-approved full-run rules (double enumeration passed + acceptance +
M9A protections) and G4 for children of observed parents. Consequence: CB21 changes from "absent on any run" to
"absent on the next accepted full run"; the plan's explicit-deletion path for Chargebee subscriptions/customers is
withdrawn. This also removes the dependence on an undocumented retention window (V5). Alternative (more code, still
needs approval): keep `include_deleted` but make deletion evidence conditional on no live record with the same id in
the same complete read and on the deleted record being newer than the stored line.

### Rerun after the owner recreated Key B (2026-10-08T19:48Z)

- Key B (`…_NOCATALOG`, as seen by this session): `/customers` 200, `/subscriptions` 200, **`/items` 200,
  `/item_prices` 200, `/item_families` 200** — still not refused. Two explanations, not distinguishable from here
  without exposing key material: (a) the session still holds the previous value (environment secrets are loaded
  when a session starts); (b) the disabled permission ("plans/addons") is the Product Catalog **1.0** resource
  and does not govern PC 2.0 Item Families / Items / Item Prices. V8 remains open; the negative-permission run was
  not repeated because the precondition (catalogue denied) does not hold.
- V5: the deleted S02 copy is still listed with `include_deleted=true` **40 minutes** after its deletion (3 deleted
  records, 23 records / 22 unique ids). The documented "permanently deleted after a few minutes" does not describe
  list visibility; the retention window remains unknown.

### Key B (V8)

Key B was expected to lack catalogue scope but read Items, ItemPrices and Item Families (200). The negative-
permission scenario (CB34) could not be exercised. Owner action: recreate Key B as a **Restricted read-only** key
with only Customers and Subscriptions, or confirm the site does not allow excluding the catalogue.

## External setup still required (owner)

See the [owner sandbox checklist](#owner-sandbox-checklist) below; nothing in it is needed by the fake tests.

## Owner sandbox checklist

Minimal setup that lets the live gate (plan §22) prove V2–V12 and run the live-runnable scenarios. Synthetic
data only: no real people, companies, emails or cards. **Never paste an API key into chat.**

### 1. Site

- A Chargebee **test site** (not live), **Product Catalog 2.0** (default for new sites).
- **Multi-currency** enabled with **USD** (base) and **EUR** (CB13).
- No Multiple Business Entities needed (CB09 `transferred` stays fake-only unless the site already has MBE).
- Tell us the **site subdomain** only (the `<site>` in `https://<site>.chargebee.com`) — not a secret.

### 2. Product catalogue (one item family, e.g. `M9B Test Family`)

| Item (type)            | Item prices to create                                                                 | Purpose                |
| ---------------------- | ------------------------------------------------------------------------------------- | ---------------------- |
| `M9B Basic` (plan)     | monthly USD; yearly USD; monthly EUR                                                  | CB01, CB03, CB12, CB13 |
| `M9B Pro` (plan)       | monthly USD (with a trial period allowed)                                             | CB02, CB04, CB14       |
| `M9B Seats` (add-on)   | monthly USD, **per-unit** (quantity); a second price point monthly USD `M9B Seats v2` | CB02, CB11, V3         |
| `M9B Support` (add-on) | monthly USD, flat fee                                                                 | CB02, CB15             |
| `M9B Setup` (charge)   | one-time USD                                                                          | CB16                   |
| `M9B Legacy` (add-on)  | monthly USD — **archive the item after** S18 below is created                         | CB18, V6               |
| `M9B Temp` (add-on)    | monthly USD — never used; **delete** it after our first full run (we will say when)   | V6                     |

### 3. Customers and subscriptions (Chargebee-generated ids are fine)

Twelve customers named `M9B Test Customer 01`…`12`, company `M9B Test Co NN`, email omitted or
`noreply+NN@example.com`, **no payment method** (test sites allow subscriptions without cards; use "offline"
/ invoice collection where asked).

| Sub | Customer | Items (quantity)                                     | Status to reach                               | Proves                |
| --- | -------- | ---------------------------------------------------- | --------------------------------------------- | --------------------- |
| S01 | 01       | Basic monthly USD (1)                                | active                                        | CB01                  |
| S02 | 02       | Pro monthly (1) + Seats (3) + Support (1)            | active                                        | CB02, CB11, CB15, V12 |
| S03 | 03       | Basic monthly (1)                                    | active                                        | CB03                  |
| S04 | 03       | Basic monthly (1)                                    | active (second sub, same customer, same item) | CB03                  |
| S05 | 04       | Pro monthly (1) with a trial                         | in_trial                                      | CB04                  |
| S06 | 05       | Basic monthly (1), start date ~2 weeks ahead         | future                                        | CB05                  |
| S07 | 06       | Basic monthly (1), cancel **at end of term**         | non_renewing                                  | CB06, V4              |
| S08 | 07       | Basic monthly (1), cancel **immediately**            | cancelled                                     | CB07, V4              |
| S09 | 08       | Basic monthly (1), **pause** now                     | paused                                        | CB08                  |
| S10 | 09       | Basic monthly (1)                                    | active                                        | CB10, CB12            |
| S11 | 10       | Basic monthly **EUR** (1)                            | active                                        | CB13                  |
| S12 | 11       | Basic monthly (1)                                    | active                                        | CB14                  |
| S13 | 12       | Basic monthly (1) + Setup charge (1)                 | active                                        | CB16                  |
| S14 | 12       | Basic monthly (1) + Legacy (1) — then archive Legacy | active                                        | CB18                  |
| S15 | 01       | Basic monthly (1)                                    | active (will be cancelled, then reactivated)  | CB22                  |

**V3 attempt (record the outcome, screenshots not needed):** on S02, try to add `M9B Seats` a second time with
the same price point, and separately with `M9B Seats v2`. Tell us which, if any, Chargebee accepts.

### 4. Changes after our first full run (we will ask for each step, one at a time)

1. S02: Seats quantity 3 → 5 (CB11, V12); remove Support (CB15, V12).
2. S10: change price point Basic monthly → Basic yearly (CB12); advance/renew its term if the test site's
   time-machine allows (CB10, V4).
3. S12: change plan Basic → Pro (CB14).
4. S15: cancel immediately, then (after our next run) reactivate (CB22).
5. Delete **subscription S04** (CB21, V5); delete **customer 08** together with its subscription S09 (CB20,
   V5).
6. Delete the unused item price/item `M9B Temp` (V6).
7. Optional (CB28): create one more subscription while we run a full sync, when we say "now".

CB19 (subscription of a missing customer), CB23 (unknown item price), CB24, CB32, CB35, CB36 and CB09 (without
MBE) cannot be produced on a real site and stay fake-only. CB26 needs no extra data: the live connection uses
`pageSize: 10` (≥ 3 pages). CB31 (429) is observed only; we will not deliberately exceed the site limit.

### 5. API keys (read-only, Restricted)

Settings → Configure Chargebee → API Keys → Add API Key → **Read-Only Key → Restricted**:

- **Key A** (main): read access to **Customers**, **Subscriptions**, **Item Families**, **Items**, **Item Prices**
  — nothing else (no invoices, transactions, payment sources, events, exports).
- **Key B** (CB34, V8): read access to **Customers** and **Subscriptions** only (no product catalogue).

### 6. Where the keys go (never in chat)

Add them in this cloud environment's settings (environment menu in the session title bar → Edit) as
**environment secrets / variables**, for the live tenant slug `cblive`:

| Variable                                      | Value |
| --------------------------------------------- | ----- |
| `TENANT_CBLIVE_CHARGEBEE_CHARGEBEE_API`       | Key A |
| `TENANT_CBLIVE_CHARGEBEE_CHARGEBEE_NOCATALOG` | Key B |

They resolve through the `EnvSecretProvider` as `tenant.cblive.chargebee.chargebee_api` and
`tenant.cblive.chargebee.chargebee_nocatalog`.

### 7. Network

Allow `<site>.chargebee.com` under the environment's **Network access → Allowed domains** (keep "Allow package
managers" ticked); see https://code.claude.com/docs/en/cloud-environments#network-access. A new session picks
up secret and network changes.
