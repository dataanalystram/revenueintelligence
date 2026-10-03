# Source connectors — operations guide (Milestone 8)

Generic source connectors (ADRs 0019–0021): a tenant connects a source (Sugar
today), captures its schema, publishes a versioned mapping, assigns source
authority, and synchronises. Canonical facts are written only through the M6
context writer and the M7 subscription writer. **LIVE SUGAR VERIFICATION:
PENDING** — see `docs/integrations/sugar/live-verification.md`; no real Sugar
connection may be enabled until that gate passes.

All commands are tenant-scoped, print JSON (ids, codes, counts, hashes — never
record values or credentials) and are dry runs unless `--execute`.
`--connection` takes the connection id or its kind.

## 1. Credentials (SecretProvider only)

```sh
pnpm --filter @lip/api tenant:credentials ...   # register the name (existing M2 flow)
```

Register one credential name for kind `sugar` (e.g. `sugar_api`). Its value —
set by the operator in the SecretProvider (env: `TENANT_<SLUG>_SUGAR_SUGAR_API`,
Key Vault in production) — is a JSON bundle
`{"clientId", "clientSecret", "username", "password"}`. The connection stores
only the name; configuration refuses secret-like keys.

## 2. Connection

```sh
pnpm --filter @lip/api sources:configure --tenant <slug> --kind sugar --label "Sugar" \
  --file sugar-connection.json --credential sugar_api --status disabled --execute
pnpm --filter @lip/api sources:test   --tenant <slug> --connection sugar
pnpm --filter @lip/api sources:list   --tenant <slug>
```

`sugar-connection.json` (non-secret): `instanceUrl` (https), `apiVersion`,
`modules`, `referenceModules` (product catalogue), optional `platform`,
`countSupported`, `pageSize`, `rateLimit`, and `sync.overlapMinutes` (required
for incremental runs; no production default). Values marked LIVE are
confirmed at the live gate. Every tenant also has platform-created `import`
and (when HubSpot is enabled) `hubspot` connections (code-mapped).

## 3. Schema snapshot and drift

```sh
pnpm --filter @lip/api sources:schema --tenant <slug> --connection sugar --capture --execute
pnpm --filter @lip/api sources:schema --tenant <slug> --connection sugar          # latest
pnpm --filter @lip/api sources:schema --tenant <slug> --connection sugar --diff   # drift vs mapping
```

Snapshots are metadata only, immutable and hashed. A run refuses on blocking
drift of the mapped surface (`schema_drift`); new enum options are reported.

## 4. Mapping (versioned, immutable)

```sh
pnpm --filter @lip/api mappings:validate --tenant <slug> --connection sugar --file mapping.json
pnpm --filter @lip/api mappings:preview  --tenant <slug> --connection sugar --file mapping.json --limit 20
pnpm --filter @lip/api mappings:publish  --tenant <slug> --connection sugar --file mapping.json \
  --based-on <latest version, 0 first> [--validated-against <snapshot hash>] --execute
pnpm --filter @lip/api mappings:show     --tenant <slug> --connection sugar [--version N]
```

Preview reads at most 20 records, maps them in memory and returns masked
output (hashed references, codes and dates); nothing is persisted or logged.
A stale `--based-on` is refused (`concurrent_publish`).

Governance order for a new source: (1) publish a mapping whose subscription
object has a **confirmed holding filter** (or confirmed all-holdings
statement) and states terms/state explicitly (`null`/`unknown`); (2) publish
authority assigning `subscription_lines` (and, if confirmed, `subscription_terms`)
to the connection; (3) publish the next mapping version with the confirmed
date mapping. Profile, state and term mappings are refused until the
connection holds that fact (`authority_conflict`).

## 5. Authority

```sh
pnpm --filter @lip/api authority:show    --tenant <slug>
pnpm --filter @lip/api authority:publish --tenant <slug> --file authority.json --based-on <version> --execute
```

`authority.json`: `{"facts": {"account_profile": <id|null>, "person_profile": …,
"subscription_lines": …, "subscription_state": …, "subscription_terms": …}}`.
Refusals: `holding_filter_required`, `cross_source_unsupported` (state/terms
must come from the lines' connection or nobody), `authority_not_supported`
(e.g. HubSpot for subscriptions). Version 1 (migration/provisioning) assigns
subscription facts to `import` (M7 behaviour) and, for existing tenants,
profiles to HubSpot.

## 6. Synchronisation

```sh
pnpm --filter @lip/api sync:full        --tenant <slug> --connection sugar --execute
pnpm --filter @lip/api sync:incremental --tenant <slug> --connection sugar --execute
pnpm --filter @lip/api sync:status      --tenant <slug> --connection sugar
pnpm --filter @lip/api source:report    --tenant <slug> --connection sugar [--drift] [--products]
```

Runs are processed by the worker on queue `lip-sources` (same BullMQ
platform, retries with backoff honouring `Retry-After`, dead letters). One
active run per connection.

- **Full run**: drift check → accounts → product catalogue (an unmodelled
  catalogue product fails the run before any line) → lines in a bounded,
  ordered read with start/end count reconciliation (`unstable_read`
  otherwise) → tombstone pass → ownership gaps replaced → completed. Only a
  completed full run of the `subscription_lines` authority under its latest
  mapping establishes coverage.
- **Incremental run**: window `watermark − overlap` to the run start; never
  tombstones, never establishes coverage, only adds ownership gaps; the
  watermark advances only on completion.
- **Ownership gaps**: accounts with a holding line whose product is missing
  or not in the source catalogue are `ownership_incomplete` in eligibility:
  no not-owned inference, no eligible whitespace.

Quality codes on the run (`sync:status`): `filtered_out`,
`orphan_product_reference`, `missing_product_reference`,
`orphan_account_reference`, `missing_account_reference`, `invalid_period`,
`invalid_date`, `duplicate_external_id`, `unmapped_source_enum_value`,
`relationship_conflict`, `ownership_gap`, `tombstoned`, drift codes.
Failure codes: `schema_drift`, `unstable_read`, `unmodelled_product_reference`,
`not_authoritative_for_lines`, `holding_filter_required`, `source_<kind>`,
`retries_exhausted`.

## 7. Metrics

`lip_source_runs{kind,mode,outcome}`, `lip_source_pages{kind,object}`,
`lip_source_records{kind,object,outcome}`, `lip_source_mapping_errors{code}`.
Labels are codes only.

## 8. Rollback (development/staging)

Down-scripts in `apps/api/prisma/rollback/` (newest first):
`20261020130000_m8_schema_snapshots_mappings_authority.down.sql`,
`20261020120000_m8_connector_kinds_and_connections.down.sql`,
`20261020110000_m8_retire_tenant_field_mappings.down.sql`. Each refuses when it
would lose published configuration, run linkage or data.
