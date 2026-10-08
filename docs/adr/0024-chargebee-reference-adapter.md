# ADR 0024: Chargebee reference adapter, double-enumeration proof and parent-scoped child reconciliation (Milestone 9B)

- Status: implemented against the deterministic fake; awaiting independent implementation review and
  LIVE CHARGEBEE VERIFICATION (V2–V12, PENDING)
- Date: 2026-10-08
- Plan: [M09B plan](../milestones/M09B-chargebee-reference-adapter-plan.md) (approved at `ba72e91`), decisions
  B1–B11
- Amends: ADR 0019 (new connector kind), ADR 0020 (Unix-seconds parse), ADR 0023 (a second structural proof
  method, generic child-set reconciliation)

## Context

Chargebee is the second versioned source and the first that **cannot count**: its list API returns pages and
an opaque `next_offset`, never a total. M8/M9A proved a full read only by counting (`count`, externally
grounded). Chargebee subscription items have no id of their own and live inside a subscription, so removed
add-ons would stay "owned" until the next full run, and an item can only be identified relative to its
parent.

## Decision

1. **Connector kind `chargebee`** (versioned mapping, external references, adapter shipped). The one M9B
   migration seeds it and widens the integration/credential system CHECKs by exactly that value, so the
   read-only API key can be registered as a credential **name** (value in the `SecretProvider`). A Chargebee
   integration can never be `read_write` (database CHECK).
2. **Adapter** (`modules/chargebee`): API v2, Product Catalog 2.0 only. Five declared objects: `Customers`,
   `Items`, `ItemPrices`, `Subscriptions` and the derived `SubscriptionItems` child set (one row per
   subscription item, `item_id` resolved through Chargebee's own item-price catalogue; Product = Chargebee
   Item). GET only, to four allowlisted list endpoints; at most one request in flight per connection; a
   configurable per-minute budget below the site limit; bounded retries honouring `Retry-After`. Every
   payload is Zod-validated; undeclared attributes (cards, payment sources, personal fields) are dropped
   unread. A structurally invalid entry becomes a **rejection row** carrying only its readable parent key and
   account reference.
3. **Line identity is a mapping choice.** The adapter exposes two identity candidates:
   `line_key_item_price` (`<subscription_id>:<item_price_id>`, the approved fallback) and `line_key_item`
   (`<subscription_id>:<item_id>`, only once V3 proves an item cannot repeat). The published mapping version
   names one; switching is a new governed mapping version, never a runtime switch. Repeated keys fail closed.
4. **`double_enumeration` proof (G2).** An object that cannot count declares
   `fullReadProof: double_enumeration`: the bounded selection is listed twice and the membership sets must be
   identical (for a child set, the parent keys). Mismatch → `unstable_read` (no proof, no tombstone,
   coverage unchanged). Tier `stable_snapshot` — **never** `externally_grounded`; tombstones additionally need
   an operator acceptance on the authority version, which never promotes the tier. Absence stays `unknown`;
   Chargebee alone produces no whitespace.
5. **Generic Unix-seconds parse (G3):** `{ type: 'timestamp', format: 'unix_seconds' }`, UTC by definition;
   integers in 2000-01-01..2100-01-01 only (milliseconds are `invalid_date`).
6. **Parent-scoped child reconciliation (G4).** An object may declare `childOf { object, parentKeyField }`.
   A parent observed in the run with a **complete, accepted** child set retires its active lines absent from
   that set — on any run. A parent's set is **uncertain** (no retirement, and its existing lines are also
   shielded from the full-run tombstone pass) when the parent was rejected, any child was rejected or
   protected, a child key repeated, the parent was split across pages, or a child had no usable parent key.
   A deleted parent retires only its own explicitly deleted rows. A failed read never reaches reconciliation.
7. **Pagination safety:** positions are opaque; a repeated position or an identical consecutive page is
   `pagination_stalled` (sync and profiling) — the run fails with no proof, no coverage change and no
   tombstones.
8. **Incremental reads are gated (B8/V12):** `incrementalReads: false` unless the connection is configured
   `incrementalLines: verified` after the live gate proves that an item change moves the parent's
   `updated_at`. Until then Chargebee subscription lines are synchronised by full runs only.
9. **Settle window:** `sync.settleMinutes` keeps the run boundary behind the run start for eventually
   consistent list reads.

## Consequences

- Sugar keeps `count → externally_grounded`, CSV keeps `operator_full_file → stable_snapshot`; the new
  capability fields are optional with no defaults, so existing snapshot hashes are unchanged.
- Deleting a Chargebee customer retires its reference but not its lines (M8 reference semantics); a
  subscription's own `deleted=true` is the deletion evidence. Cancellation is never deletion evidence.
- Live behaviour (V2–V12) is unproven; M9B cannot close on the fake alone.
