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

| Object              | Endpoint                | Notes                                                                                                                                                                                                     |
| ------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Customers`         | `GET /customers`        | accounts; `include_deleted=true`; full reads bounded by `created_at[before]` + `sort_by[asc]=created_at`; only `id`, `company`, timestamps, `deleted`, `business_entity_id` declared (no personal fields) |
| `Items`             | `GET /items`            | product catalogue (Product = Item); unbounded, double-enumerated                                                                                                                                          |
| `ItemPrices`        | `GET /item_prices`      | price points; the item-price → item join only                                                                                                                                                             |
| `Subscriptions`     | `GET /subscriptions`    | parents; `include_deleted=true`                                                                                                                                                                           |
| `SubscriptionItems` | (from `/subscriptions`) | derived child set: one row per `subscription_items[]` entry; parent fields denormalised; `card` and payment data dropped unread                                                                           |

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

Cancellation, expiry, explicit deletion and inferred disappearance stay separate: `deleted=true` on a
subscription → its lines `absent` on any run (CB21, C17); `cancelled` is a state, never deletion evidence;
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

## V2–V12 (live gate)

| #   | Status                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | **DOC-CONFIRMED** (F18); live: every timestamp observed is integer UTC seconds; `resource_version` is milliseconds                                                                                                                                                                                                                                                                                         |
| V2  | **LIVE-OBSERVED (baseline, quiescent site):** `next_offset` is an opaque JSON array of two strings; distinct per page, identical on a second pass, replaying an offset returns the same page; order follows `sort_by[asc]=created_at`. Behaviour under concurrent writes (CB28): PENDING                                                                                                                   |
| V3  | **LIVE-RESOLVED** (owner, confirmed by read): same item + same item price twice → `400 duplicate_entry`; same item + different item prices → allowed (one live subscription holds it). `<subscription_id>:<item_id>` is **not** safe; the line identity stays `<subscription_id>:<item_price_id>`                                                                                                          |
| V4  | **LIVE-CONFIRMED (baseline):** `non_renewing` keeps a future `current_term_end` (`cancelled_at` = term end); immediate `cancelled` keeps `current_term_end` = `cancelled_at` (one cancelled subscription that never started has no term). Connector terms match the raw values for every written line                                                                                                      |
| V5  | **PARTLY RESOLVED — contradiction found:** deleted subscriptions **are** returned by List with `include_deleted=true` (`deleted: true`); single Retrieve returns `404 resource_not_found`. A deleted copy was still listed ~25 min after deletion although the docs say "permanently deleted after a few minutes" — retention window unknown. **Chargebee reuses a deleted subscription's id** (see below) |
| V6  | PENDING (M09/M10) — `include_deleted=true` is accepted on `/items` and `/item_prices`; no archived/deleted catalogue record exists yet                                                                                                                                                                                                                                                                     |
| V7  | **PARTLY RESOLVED:** ids ≤ 40 chars, charset `[A-Za-z0-9_.@-]`, never `:` (the separator is safe). **Ids are not unique over time:** a deleted subscription's id was reused by a new subscription (docs: item/item price ids are reusable after deletion too)                                                                                                                                              |
| V8  | **NOT AS SPECIFIED:** Key B (intended without catalogue scope) returned **200** on `/items`, `/item_prices` and `/item_families`; the 403 shape could not be observed. Owner action required                                                                                                                                                                                                               |
| V9  | PENDING (needs a mutation)                                                                                                                                                                                                                                                                                                                                                                                 |
| V10 | PENDING — `decommissioned` is `false` on all 23 subscription records; no decommissioned record to observe                                                                                                                                                                                                                                                                                                  |
| V11 | Live site is PC 2.0 (`/items` 200). PC 1.0 detection cannot be observed on this site: remains fake-only                                                                                                                                                                                                                                                                                                    |
| V12 | PENDING (M01/M02); incremental line sync stays **disabled** (refused live: `incremental_not_supported`)                                                                                                                                                                                                                                                                                                    |

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
