# Milestone 9B — Chargebee reference adapter (implementation record)

- Status: **FAKE IMPLEMENTATION COMPLETE — awaiting independent implementation review.**
  **LIVE CHARGEBEE VERIFICATION: PENDING** (V2–V12; the owner's test site is not yet provisioned).
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

_Filled in below after the gates ran._
