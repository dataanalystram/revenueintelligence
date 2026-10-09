# Product catalogue, subscriptions and eligibility operations (Milestone 7)

How to publish a tenant's product model, load subscription lines, check
ownership coverage, and evaluate eligibility and whitespace, with evidence
that can be replayed later. Design:
[ADR 0016](../adr/0016-product-model-versioning.md) (product model),
[ADR 0017](../adr/0017-subscriptions-and-ownership.md) (subscriptions,
ownership, account merge),
[ADR 0018](../adr/0018-eligibility-and-whitespace.md) (eligibility,
whitespace, snapshots).

Every command takes `--tenant <slug>`. Commands that write are **dry runs
unless `--execute`** is given. Output is JSON with keys, ids, codes, counts
and hashes only: never company names or other record values. All commands
run from `apps/api` after `pnpm --filter @lip/api build`, with
`DATABASE_URL` pointing at the application role.

> **No real customer data yet.** Juniper's products, rules and subscription
> source are `tbc` (Subscription Source Discovery gate, before M8). The files
> in `apps/api/config/examples/` are fictional and exist for the runtime
> checks and this guide. Never publish them to a real tenant.

## 1. Product model

The model is a JSON document: `products`, `relationships` (`requires` with
`anyOf`, `excludes`, `replaces`, `includes`), `conditions`
(`account_attribute`), `ownership.ownedStates` and `lifecycle`
(reactivations). Example: `config/examples/product-model.example.json`.

```bash
pnpm product:model validate --tenant <slug> --file model.json            # report only
pnpm product:model publish  --tenant <slug> --file model.json            # dry run
pnpm product:model publish  --tenant <slug> --file model.json --based-on <version> --execute \
     [--effective-from 2026-11-01T00:00:00Z] [--actor <operator-id>]
pnpm product:model show     --tenant <slug> [--version N]
pnpm product:model diff     --tenant <slug> --from 1 --to 2
```

- A published version is **immutable** (database trigger). A correction is a
  new version. `effectiveFrom` cannot be in the past and never precedes the
  previous version.
- Exit code **2** means the document was refused; `errors[]` lists each
  problem with a stable `code` and a JSON `path`. Nothing was written.
- **Keys are identities (K1–K4).** A key can never disappear
  (`product_key_removed`): retire it instead (`"status": "retired"`). A retired
  product's name and family are frozen; bringing it back needs
  `"lifecycle": [{"key": "<key>", "action": "reactivate"}]`. Renaming an active
  product needs `"renamedFrom": "<previous name>"`. A new product needs a new
  key.
- `--based-on <version>` is **required** to publish (M8): the latest version
  the document was prepared against (`0` for the first; `product:model show`
  prints it). If someone else published meanwhile you get `concurrent_publish`
  instead of overwriting their change. Re-validate against the new latest
  version and publish again.
- `tenant_products` is a read-only projection of the latest version; rows are
  never deleted.

## 2. Subscription lines (CSV import)

Until a connector exists (M8), lines arrive only through the CSV import.
Columns (header required, any order): `record_id, account, product, state,
starts_at, ends_at, quantity, source_updated_at`, optional `presence`
(`present` | `absent`). Example: `config/examples/subscriptions.example.csv`.

| Column                | Rules                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `record_id`           | the line's id in the source, unique in the file (`[A-Za-z0-9_.:-]`, ≤ 255)                           |
| `account`             | a platform company id or an external reference `system:objectType:id` (e.g. `hubspot:companies:123`) |
| `product`             | a product key, or `system:objectType:id` matching a product's `externalRefs` in the model in force   |
| `state`               | `active`, `trial`, `expired`, `cancelled` or `unknown` (map source vocabularies first; never guess)  |
| `starts_at`/`ends_at` | ISO-8601 **with an offset** (`Z` or `±hh:mm`); empty = open. A date without a zone is refused        |
| `quantity`            | positive integer or empty                                                                            |
| `source_updated_at`   | when the source last changed the line (orders updates); empty if unknown                             |

```bash
pnpm subscriptions:import --tenant <slug> --file lines.csv --source <name> --mode full          # dry run
pnpm subscriptions:import --tenant <slug> --file lines.csv --source <name> --mode full --execute
pnpm subscriptions:import --tenant <slug> --cancel <checkpointId> --execute                       # stuck run
pnpm subscriptions:show   --tenant <slug> --company <id|system:objectType:id>
```

- **`--source`** names the export (e.g. `billing_export`). A **full** import
  tombstones that source's lines missing from the file (kept for audit, never
  deleted); other sources are untouched. `legacy_company_product` (lines
  migrated from M2) is reserved.
- The **whole file is validated first** (UTF-8, ≤ 10 MiB, ≤ 100,000 rows).
  Any malformed row → exit 2 with row numbers and codes, nothing written, no
  run recorded. Errors never echo values.
- Accounts and products are resolved per line. An unresolved one is rejected
  (`unknown_account`, `unknown_product`) and reported by row. In **full** mode
  any rejection marks the run `failed`: no tombstones, coverage unchanged
  (fix the data and rerun). Lines already written remain valid facts.
- Re-importing the same file is a no-op (`unchanged`). Older
  `source_updated_at` values are ignored (`stale`).
- A run killed midway stays `running` and blocks the next import
  (`a subscription import is already running`). Find its id with
  `subscriptions:coverage` and cancel it. Coverage never changes because of a
  killed run.

## 3. Ownership coverage

```bash
pnpm subscriptions:coverage --tenant <slug>
```

Until a **full** load has completed for the tenant, ownership is `unknown`:
every eligibility answer is `unknown` (`ownership_not_loaded`) and whitespace
shows no eligible products. "No lines" is never read as "owns nothing".
Coverage is per tenant for now (provisional until the Subscription Source
Discovery gate).

## 4. Eligibility and whitespace

```bash
pnpm eligibility:evaluate   --tenant <slug> --company <ref> --product <key> [--as-of ISO]
pnpm eligibility:evaluate   --tenant <slug> --company <ref> --product <key> --record --purpose <code> --execute
pnpm eligibility:whitespace --tenant <slug> --company <ref> [--as-of ISO]
pnpm eligibility:replay     --tenant <slug> --snapshot <id>
```

- `status` is `eligible`, `ineligible` or `unknown`; every check is listed
  with its outcome, reason code, rule id and the facts it read
  (subscription ids, product keys). Precedence: any `fail` → ineligible,
  otherwise any `unknown` → unknown.
- A merged-away company is evaluated as its survivor; the answer shows
  `requestedCompanyId` and `evaluatedCompanyId`.
- `--record` (with `--execute`) stores an append-only **snapshot**: model
  version and hash, evaluator version, frozen input facts, facts hash, status,
  checks, `asOf`, purpose and correlation id. `eligibility:replay`
  re-evaluates the frozen facts against the stored model version; `reason`
  must be `reproduced` (exit 3 otherwise). Later subscription or model changes
  never alter a snapshot.
- Whitespace groups every catalogue product: `owned`, `eligible_whitespace`,
  `ineligible_whitespace`, `unknown`. "Currently being pursued" is not
  considered until M12 (opportunity candidate generation; renumbered 2026-10-09).

## 5. Health and invariants

```bash
pnpm products:report --tenant <slug>
```

Shows model versions, coverage, line counts by state, and the invariant
`noActiveLinesOnMergedCompanies`. Exit **3** means a non-deleted line sits on
a merged company: a defect (the merge participant should have moved it).
Report it; do not repair by hand.

## 6. Account merges

Nothing to run. When M6 merges two companies, the subscription lines of the
merged-away company move to the survivor **in the same transaction** (same
rows, one `merged` provenance row each). A cross-system merge that M6 refuses
moves nothing. Every process that can merge (worker, context CLI) refuses to
start if the subscription merge participant is not registered.

## 7. Rollback

- **Bad model version:** publish a corrected version (versions are never
  edited or deleted).
- **Bad import:** re-import the correct file in full mode (tombstones the
  lines that should not exist, restores lines that reappear).
- **Schema (dev/staging only):** `prisma/rollback/20261010130000_*.down.sql`
  then `20261010120000_*.down.sql`. Each refuses when it would lose data
  (snapshots, published models, non-legacy lines or their provenance).
  Production rollback is forward-only.
