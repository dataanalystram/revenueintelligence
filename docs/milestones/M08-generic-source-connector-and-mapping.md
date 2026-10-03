# Milestone 8 — Generic source connector and versioned mapping foundation, with SugarCRM as the first reference adapter

- Status: **M8 IMPLEMENTATION COMPLETE — pending independent review**
  (plan approved at `a8b61fb`; see [implementation record](#implementation-record-m8)).
  **LIVE SUGAR VERIFICATION: PENDING.** M9 not started; not merged to `main`.
- Base: `main` at `e0e3fe7` (M0–M7 complete).
- Approved design: [canonical extension and source mapping](../architecture/canonical-extension-and-source-mapping.md)
  (`e4fec65`, passed independent review).
- Sugar evidence (sanitized, now in this repository): branch
  `planning/m8-sugar-evidence`, commit `e2fe7d9` (cut from `e4fec65`; 19
  files; no raw data, credentials or S3 details):
  [local evidence](../discovery/sugarcrm-local-evidence.md),
  [platform alignment](../discovery/sugarcrm-platform-alignment.md) and the 16
  synthetic fixtures in `fixtures/sugarcrm/sanitized/` (links resolve once the
  branch is brought in, §47 step 0). Verdict **B**: the M7 canonical contract
  holds; Sugar is suitable as the first reference adapter; Sugar is **not**
  proven to be the subscription-state authority.
- Plan revision: refreshed against that evidence (see
  [evidence refresh](#evidence-refresh-changes-from-521fbc6)); the first
  version was `521fbc6`.
- Inputs: ADR [0008](../adr/0008-tenant-isolation.md), [0010](../adr/0010-crm-connector-port-and-oauth.md),
  [0013](../adr/0013-event-processing-on-bullmq.md), [0014](../adr/0014-canonical-identity-references-provenance.md),
  [0016](../adr/0016-product-model-versioning.md)–[0018](../adr/0018-eligibility-and-whitespace.md);
  the [roadmap](../product/roadmap.md); technical debt #22–#28.

## Evidence refresh (changes from `521fbc6`)

The plan was first written from a verbal summary. It has now been checked
line by line against the two discovery documents and all 16 fixtures on
`planning/m8-sugar-evidence` (`e2fe7d9`). Legend used below: **CONFIRMED**
(the evidence supports the plan as written), **CHANGED** (the plan changed
because of the evidence), **LIVE** (`REQUIRES LIVE SUGAR VERIFICATION`),
**BUSINESS** (requires Juniper business confirmation).

| #   | Assumption                                                       | Result                  | Evidence (sanitized) and consequence                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Accounts.id` is the account identity                            | CONFIRMED               | 36,035 rows, 0 duplicate ids; 99.2–99.5% of opportunities/lines resolve to it (§20)                                                                                                                                                                                                                                                                                                                                                |
| 2   | `Contacts.id` is the person identity; Users are not people       | CONFIRMED, refined      | 59 duplicate ids of 153,946 (0.04%), 10% of contacts have no account; the historical code keyed people by `email1`, which M6 forbids (email is not identity); Users (491) are internal staff (§21)                                                                                                                                                                                                                                 |
| 3   | Product catalogue `id` is product identity; `name` unsuitable    | CONFIRMED               | 1,203 rows, 0 duplicate ids, 106 duplicate-name rows (8.8%); 60% inactive, 9% retired; `type_name` holds a literal `'NULL'` string (§19)                                                                                                                                                                                                                                                                                           |
| 4   | One RLI = one canonical subscription line                        | CONFIRMED, refined      | `RevenueLineItems.id` 15 duplicates of 255,684 (export-level); **but an RLI is not necessarily a holding**: RLIs carry pipeline stages (`sales_stage` 94.8% populated: Closed Won, Closed Lost, Pending Cancellation, Closed Won Credited, …), so line existence ≠ ownership claim → new holding-qualification filter (§8) and BUSINESS gate on `subscription_lines` authority (§15)                                               |
| 5   | RLI → Account/Opportunity/Product relationships                  | CONFIRMED, refined      | RLI→Account 99.5% match / 0.5% null / 110 orphans; RLI→Opportunity 100% / <0.01% orphans; Opportunity→Account 99.2% / 0.8% null / 0% orphan; RLI→Product 96.5% / 2.1% null / **1.4% orphan (3,536 ids absent from the catalogue)** → orphan vs. unmodelled distinction (§23)                                                                                                                                                       |
| 6   | State stored as explicit `unknown`                               | CONFIRMED               | RLI `status` 99.5% null, populated values are lead-qualification values; `sales_stage` is a MEDIUM candidate only → BUSINESS before any value map (§16)                                                                                                                                                                                                                                                                            |
| 7   | No renewal deduplication                                         | CONFIRMED               | `renewal_rli_id` 33.6% populated, `renewal` flag 35.1% true, opportunity `renewal_parent_id` 34.2%: two mechanisms coexist, neither authoritative → renewal fields `ignored` (`semantics_unconfirmed`) in M8 (§18)                                                                                                                                                                                                                 |
| 8   | Recurring vs one-time decided by an explicit product ignore list | CONFIRMED, refined      | `recurring_one_off_c` has three overlapping values + 4% null; product `renewable`/`service` are MEDIUM; none is authoritative → they are **report hints only**, never mapping logic (§19); fixtures 15/16                                                                                                                                                                                                                          |
| 9   | Orphan product/account lines block coverage                      | **CHANGED**             | with 1.4% orphan products and 110 orphan accounts, blocking would keep coverage unknown forever; and silently skipping would risk false whitespace → **source orphans skip, but mark the account's ownership incomplete** (per-account ownership gaps, §23)                                                                                                                                                                        |
| 10  | Multiple lines per account/product                               | CONFIRMED               | 88.7% of accounts with lines have 2+; fixtures 02, 03                                                                                                                                                                                                                                                                                                                                                                              |
| 11  | Invalid dates follow `reject_record`                             | **CHANGED**             | dropping a real line risks false whitespace; a line with an invalid or conflicting term pair is **ingested with empty terms and state `unknown`**, counted `invalid_period` (§17); fixture 13                                                                                                                                                                                                                                      |
| 12  | Full-read proof by keyset on `id`                                | **CHANGED**             | historical code used offset pagination ordered by `date_modified`, stop on short page; keyset by id is not evidenced → full-read proof = bounded set + count reconciliation, keyset only if LIVE proves it (§23)                                                                                                                                                                                                                   |
| 13  | 16 scenarios cover M8 tests                                      | **CHANGED**             | fixtures contain RLI rows (plus one opportunity row) only: no Account, Contact, product catalogue, Users, schema-metadata, pipeline-stage (e.g. Closed Lost) or multi-page fixtures; README/CSV mismatches (06 "cancellation date" and 15/16 `renewable` columns are absent) → M8 adds companion synthetic fixtures (§28)                                                                                                          |
| 14  | Planned transforms                                               | CONFIRMED, one addition | date-only values (`2026-01-01`) need the declared time zone (already planned); boolean `True`/`False` strings need declared sets (planned); literal `'NULL'` needs sentinel null handling (planned); **added: one declarative holding filter** (field ∈ confirmed values, §8) — not a transform language                                                                                                                           |
| 15  | Sugar capabilities                                               | **CHANGED**             | evidenced historically: OAuth password grant (client `sugar`, empty secret), `/ping`, `GET /{Module}/fields`, list with `max_num`/`offset`, `filter[date_modified][$gt]`. **Not** evidenced: refresh-token grant, `readRecord`, keyset/`$gt` on id, counts, rate limits, deleted-record visibility, current API version (`v11_20` is only a placeholder) → all LIVE (§30); `readRecord` is not needed by sync and becomes optional |

Decisions that go beyond the approved design (`e4fec65`) and need explicit
approval in the plan review:

1. **Holding filter** (§8): the approved design allows no conditions in
   mappings. The evidence (RLIs include lost and open deals) needs exactly one
   declarative membership test per subscription object. It is confined to one
   field and one value set, confirmed per value, and validated against the
   snapshot's enum options; without it, Sugar cannot be authoritative for
   `subscription_lines`.
2. **Per-account ownership gaps** (§23): a small extension of M7 coverage
   (tech debt #22 anticipated per-account coverage) with a new reason code and
   an evaluator version bump, so unattributable lines cannot create false
   whitespace.

Disagreement recorded: the alignment report (§6) suggests mapping product
`active_status`/`renewable` to `TenantProduct.active`/`family` as `core`
entries. This plan keeps the approved rule instead: **the connector never
writes the product model** (ADR 0016; the model is authoritative and
human-published). Those fields feed only the operator report and draft export
(§19).

Formatting finding: the three Markdown evidence files fail the repository's
`prettier --check` (CI lint job). Step 0 keeps the evidence byte-for-byte and
adds `docs/discovery/` and `fixtures/sugarcrm/sanitized/` to
`.prettierignore`, instead of reformatting evidence.

---

## 0. Objective

Build the reusable foundation that lets the platform connect to a source,
inspect its schema, publish a governed mapping, read records, map them to
canonical facts written through the **existing** canonical writers, and keep
provenance and coverage — with SugarCRM as the first adapter, mock-first.

```
Source connection → describe schema (snapshot) → versioned mapping (validate, preview, publish)
  → read records (full / incremental) → mapping engine (pure) → canonical observations
  → ContextIngestionService (accounts, people) · SubscriptionIngestionService (lines)
  → provenance (connection + mapping version) → coverage (platform decision, by authority)
```

The intelligence layer (products, eligibility, later signals) never sees a
Sugar object name. Sugar knowledge lives in one connector module and in
tenant configuration.

**Completion is split** (§30): `IMPLEMENTATION COMPLETE` (mock Sugar,
deterministic CI) and `LIVE SUGAR VERIFIED` (a separate, recorded gate).

---

## 1. Boundary

```
SOURCE-SPECIFIC            Sugar modules, REST API, auth, pagination, metadata, quirks
        ↓                  (module `sugar`, the only code that knows Sugar)
CONNECTOR ADAPTER          implements the generic SourceConnector port; emits SourceRecords
        ↓                  (generic: object, id, modifiedAt, deleted?, field values by API name)
VERSIONED MAPPING          tenant data, validated against a schema snapshot; pure engine in `domain`
        ↓
CANONICAL OBSERVATIONS     company/person SourceObservation (M6), SubscriptionObservation (M7)
        ↓
EXISTING WRITERS           ContextIngestionService, SubscriptionIngestionService (unchanged contracts)
```

Dependency rules (new, mutation-proven):

- `sugar` is imported only by composition roots and the CLI (as `hubspot`
  is today);
- the new `sources` module never imports a connector module, only the port
  and the adapter registry;
- `products`, `context` and `domain` never import `sources` or `sugar`;
- the mapping engine is pure (`domain`, under `domain-is-pure`).

---

## 2. Connector-kind catalogue

### Today

`ExternalSystemSchema = z.enum(['hubspot','sugar','gainsight_cs','gainsight_px'])`
(plus `import` for subscriptions, `MappedSystem`, `LeadSourceSystem`), mirrored
by database CHECK lists on ~10 tables (`company_external_refs`,
`person_external_refs`, `tenant_context_changes`, `tenant_source_relationships`,
`tenant_sync_checkpoints`, `tenant_subscriptions`, `tenant_dead_letters`,
`tenant_field_mappings`, …).

### M8

- **Code**: `domain/connector-kinds.ts` declares the catalogue as a
  constant list (`hubspot`, `sugar`, `gainsight_cs`, `gainsight_px`,
  `import`), each with its capabilities summary. `ExternalSystemSchema` is
  derived from it (same name, same values — **no rename**: `sugar` stays
  `sugar`, so no stored data changes). A new kind is one entry plus its
  adapter module, reviewed like any code.
- **Database**: a platform reference table `connector_kinds (kind PK,
display_name, has_adapter)` seeded by migration; the app role may only
  `SELECT` it. Every `system` / `source_system` column gets a FK to it, and the
  duplicated CHECK lists are dropped. Adding a kind later = one `INSERT`
  migration + adapter, instead of rewriting ten CHECK constraints.
- **Adapter registration**: `SOURCE_ADAPTERS` (Nest multi-provider) maps kind
  → adapter factory. Startup fails if a connection references a kind with no
  registered adapter in a process that syncs (same guard style as the M7
  merge participants).
- **Not catalogue kinds**: `jev` and other write targets in
  `tenant_integrations` / `tenant_credential_refs` stay as they are (they are
  integrations, not sources); untouched in M8.

### Required changes to M3–M7 code (minimal)

| Area                                               | Change                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `domain/external-ref.ts`                           | `ExternalSystemSchema` derived from the catalogue (values unchanged)                  |
| `domain/subscription.ts`                           | `SubscriptionSourceSystemSchema` = catalogue (drops the ad-hoc `import` union)        |
| `domain/product-model.ts`                          | product `externalRefs.system` = catalogue (values unchanged)                          |
| `tenancy/config/field-mappings.ts`, `MappedSystem` | removed with the legacy table (§33)                                                   |
| `tenancy/config/lead-source-mappings.ts`           | unchanged (lead channels; a separate concern)                                         |
| M6 HubSpot pipeline                                | unchanged behaviour; its writes gain `source_connection_id` in provenance             |
| M7 CSV import                                      | unchanged behaviour; its runs and provenance gain the tenant's `import` connection id |
| Product model publish                              | `basedOnVersion` becomes required (§14)                                               |

No rewrite of the HubSpot connector into the new mapping model in M8: its
code-level mapping keeps working and is registered as a connection with
implicit (code) mapping. Moving HubSpot onto versioned mappings is deferred
until a second CRM tenant needs it.

---

## 3. Source connection

`tenant_source_connections`:

| Column            | Notes                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `id` | tenant-leading key; tenant immutable (trigger); forced RLS                                                                                                          |
| `kind`            | FK `connector_kinds`                                                                                                                                                |
| `label`           | operator text                                                                                                                                                       |
| `status`          | `enabled` \| `disabled`                                                                                                                                             |
| `config`          | jsonb validated by the adapter's **non-secret** config schema (e.g. instance URL, API version, platform name); size-capped; a CHECK refuses keys named like secrets |
| `credential_name` | the logical secret name registered in `tenant_credential_refs`; values only via `SecretProvider`                                                                    |
| `mapping_mode`    | `versioned` (Sugar) \| `code` (HubSpot, `import`)                                                                                                                   |
| `last_test`       | outcome code + time of the last `testConnection` (no payload)                                                                                                       |
| timestamps        |                                                                                                                                                                     |

Unique `(tenant_id, kind)` in M8 (one connection per kind). Provisioning
creates the `import` connection; the migration backfills `import` for every
tenant and `hubspot` for tenants with a configured HubSpot integration.

---

## 4. Generic connector port (`domain/source-connector.ts`)

```ts
interface SourceConnector {
  capabilities(): ConnectorCapabilities;
  testConnection(): Promise<ConnectionTestResult>; // identity, permissions, API version; no records
  describeSchema(): Promise<SourceSchema>; // objects, fields, relationships, per-object capabilities
  readRecords(req: ReadRequest): Promise<SourcePage>; // one page; keyset or cursor; mapped fields only
  readRecord(object: string, id: string): Promise<SourceRecord | undefined>;
}
```

- `ConnectorCapabilities` / per-object capabilities: `pagination`
  (`keyset` \| `cursor` \| `offset`), `incremental` (with the change field),
  `deleteVisibility` (`none` \| `flag` \| `deleted_feed`), `relationshipsInMetadata`,
  `totalCount`, `maxPageSize`, `rateLimit`. Capabilities are **per object** and
  may depend on connection config (a warehouse table only has `incremental`
  when the connection declares a change column — see §40).
- `ReadRequest`: object, fields (from the published mapping only), mode
  (`full` \| `since`), checkpoint token, page size. The adapter never reads
  unmapped fields.
- `SourceRecord`: `{object, id, modifiedAt?, deleted?, values: Record<apiName,
unknown>}`. Values are validated by the adapter's Zod schemas at the
  boundary; the mapping engine validates them again against the snapshot types.
- `previewRecords` is not a port method: preview is `readRecords` with a small
  limit, run by the preview service, masked, never persisted (§35).
- **Coverage is not in the port.** The platform decides completeness (§23).

The existing `CrmReader` (M3–M6) is untouched; HubSpot does not implement the
new port in M8.

---

## 5. SugarCRM reference adapter (module `sugar`)

### Historical code: what is reused

| Old piece (Python/aiohttp → CSV → S3/Gainsight)                          | Treatment                                                                                                                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module and field names, relationship fields, which ids are stable        | **Reusable knowledge** → schema expectations, fixtures, ADR evidence                                                                                     |
| OAuth2 password/refresh flow against `/oauth2/token`, platform parameter | **Rewrite** in TypeScript behind `SecretProvider`; live-verified                                                                                         |
| `date_modified` filter for changed records                               | **Port the idea**, replace rolling 7/14/90-day windows with a checkpointed watermark (§24)                                                               |
| Offset pagination (`offset` / `max_num`, stop on short page)             | **Port the knowledge**: offset is the evidenced mechanism; full-read proof adds a bounded set and count reconciliation (§23); keyset only if live-proven |
| Transformations to CSV columns, S3 upload, Gainsight load                | **Do not reuse** (replaced by mapping + canonical writers)                                                                                               |
| Ad-hoc retries and sleeps                                                | **Do not reuse**; use the platform HTTP retry/backoff and rate limiter pattern (M3)                                                                      |
| Hard-coded business rules (e.g. "Closed Won ⇒ active")                   | **Do not reuse**; never inferred (§16)                                                                                                                   |

### Sugar-specific concerns

Status per concern: **H** = shown by historical code only (not current
certainty), **D** = current official docs (not tenant-verified), **LIVE** =
`REQUIRES LIVE SUGAR VERIFICATION`.

| Concern              | Plan                                                                                                                                                                                                              | Evidence status                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Authentication       | OAuth2 password grant (historically client id `sugar`, empty secret) with refresh; prefer the `refresh_token` grant if the tenant allows it; credentials only via `SecretProvider`; refresh single-flight (as M4) | H + D; refresh-token grant, token lifetime and platform parameter: **LIVE**     |
| API version          | connection config (`apiVersion`), never hard-coded; historical `v11_20` is a placeholder                                                                                                                          | **LIVE**                                                                        |
| Connection test      | `GET /ping` with the bearer token                                                                                                                                                                                 | H; **LIVE**                                                                     |
| Schema metadata      | `GET /{Module}/fields` (historical); the newer metadata endpoint only if the live tenant needs it                                                                                                                 | H + D; response shape: **LIVE**                                                 |
| List reads           | `GET /{Module}` with `fields=` (mapped only), `filter`, `order_by`, `max_num`, `offset`; stop on a short or empty page                                                                                            | H + D; **LIVE** for the current tenant                                          |
| Full-read proof      | bounded set `date_modified <= runStart`, order `date_modified asc, id asc`, plus start/end count reconciliation (§23); keyset (`$gt` on `date_modified`+`id` with `$or`) only if proven                           | counts, `$or`, ordering stability: **LIVE**                                     |
| Incremental          | `filter[date_modified][$gte] = watermark − overlap` (historical used `$gt` with rolling windows; replaced, §24)                                                                                                   | H + D; timestamp precision/time zone of `date_modified`: **LIVE**               |
| Single-record read   | `GET /{Module}/{id}`, optional capability; the sync does not depend on it                                                                                                                                         | D only; **LIVE**                                                                |
| Relationships        | link fields `account_id`, `opportunity_id`, `product_template_id`, contact `account_id`                                                                                                                           | data evidence (join rates); field names on the live API: **LIVE**               |
| Custom fields        | `_c` fields appear in metadata and are mappable; none is assumed (e.g. `juniper_id_c`, `subscription_urn_c` are 100% null in the evidence)                                                                        | **LIVE**                                                                        |
| Delete visibility    | capability `none` until proven; the fixture shape `deleted = True` is supported if the API returns such rows (§25)                                                                                                | export showed 0 deleted rows (cannot tell absence from API filtering): **LIVE** |
| Retries, rate limits | platform backoff with `Retry-After`, per-connection limiter; 429/5xx retried, other 4xx permanent (historical code retried only 401)                                                                              | thresholds: **LIVE**                                                            |
| Schema drift         | pre-flight schema diff against the mapping's snapshot (§12)                                                                                                                                                       | platform (no live dependency)                                                   |
| Read-only            | transport guard: only `GET` and the token `POST`; anything else throws before sending                                                                                                                             | proof against the live tenant: **LIVE**                                         |

Module API names (`Accounts`, `Contacts`, `Opportunities`, `RevenueLineItems`,
and the product catalogue — `ProductCatalog` in the historical extract,
`ProductTemplates` in standard Sugar) are taken from the evidence and
confirmed live; outside the `sugar` module they appear only in fixtures and
tenant configuration.

## 6. Sugar evidence the plan relies on (and nothing better)

All figures are aggregate counts from the sanitized evidence (§5, §6, §9,
§11, §15 of the local evidence report).

| Evidence                                                                                                | Consequence in M8                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Accounts.id`: 0 duplicates; Opportunity→Account 99.2%, RLI→Account 99.5%                               | identity for `account`                                                                                                                     |
| `Contacts.id`: 0.04% duplicate ids; Contact→Account 90% / 10% null                                      | identity for `person`; nullable company link                                                                                               |
| Product catalogue `id` unique; `name` 8.8% duplicates; `type_name` literal `'NULL'`                     | product references by id only; name refused as identity; `'NULL'` declared as a null sentinel                                              |
| `RevenueLineItems.id`: 0.006% duplicate ids (export)                                                    | identity for `subscription`; duplicates within a run are idempotent and counted                                                            |
| RLI→Opportunity 100%; RLI→Account 99.5% / 0.5% null / 110 orphans                                       | `subscription.account` from `account_id`, optional confirmed fallback via the opportunity's account (§22)                                  |
| RLI→Product 96.5% / 2.1% null / 1.4% orphan                                                             | null and orphan product references skip the line **and** mark the account's ownership incomplete (§23)                                     |
| RLI `status` 99.5% null/mis-populated; `sales_stage` 94.8% populated with pipeline and post-sale values | `subscription.state` = explicit `unknown`; `sales_stage` usable only for the holding filter and only after business confirmation (§8, §16) |
| `service_*` dates 33.5% null; `revenue_*_c` 8.6% null; `date_support_*` 100% null; the pairs disagree   | dates only by confirmed mapping, else empty (§17)                                                                                          |
| Renewal links ~34% (two mechanisms)                                                                     | no deduplication; renewal fields ignored in M8 (§18)                                                                                       |
| 88.7% of accounts with lines have 2+ lines                                                              | multiple lines per account/product (M7)                                                                                                    |
| `juniper_id_c`, `subscription_urn_c` 100% null                                                          | no cross-system id assumed; `alsoReferences` stays an open question (§20)                                                                  |
| 0 rows with `deleted = True` in the export                                                              | delete visibility unknown (§25)                                                                                                            |

## 7. Versioned mapping model

### Document (one per source connection, immutable when published)

```json
{
  "objects": [
    {
      "source": "Accounts",
      "entity": "account",
      "identity": { "field": "id" },
      "fields": [{ "source": "name", "kind": "ignored", "reason": "not_authoritative" }]
    },
    {
      "source": "RevenueLineItems",
      "entity": "subscription",
      "identity": { "field": "id" },
      "holdingFilter": {
        "field": "sales_stage",
        "in": ["<values Juniper confirms denote a holding>"],
        "confirmation": { "by": "<operator>", "note": "<business confirmation>" }
      },
      "relationships": [
        {
          "target": "subscription.account",
          "field": "account_id",
          "object": "Accounts",
          "fallbackVia": {
            "field": "opportunity_id",
            "object": "Opportunities",
            "targetField": "account_id"
          }
        },
        {
          "target": "subscription.product",
          "field": "product_template_id",
          "productReference": true
        }
      ],
      "fields": [
        {
          "kind": "core",
          "target": "subscription.state",
          "explicit": "unknown",
          "reason": "no_reliable_source_state"
        },
        {
          "kind": "core",
          "target": "subscription.startsAt",
          "source": "service_start_date",
          "transforms": { "parse": { "type": "date", "timeZone": "UTC" } },
          "confirmation": { "by": "<operator>", "note": "<meaning confirmed with owner>" }
        }
      ]
    }
  ],
  "productReferences": {
    "object": "ProductTemplates",
    "ignored": [{ "id": "<source id>", "reason": "non_subscription_product" }]
  }
}
```

(Illustrative only; field names come from the discovery evidence and the
snapshot, not from this plan. No `holdingFilter` values are known yet.)

- Entry `kind` is a discriminated union: `identity`, `core`, `relationship`,
  `ignored` in M8. **`attribute` is reserved**: the schema has the slot, the
  validator refuses it with `attribute_mappings_not_enabled` until the
  attribute registry exists — no redesign later.
- `entity` and `target` come from code catalogues (`account`, `person`,
  `subscription`; `account.name`, `account.domains`, `person.email`, …,
  `subscription.state|startsAt|endsAt|quantity`, `subscription.account`,
  `subscription.product`, `person.primaryCompany`). Unknown targets are
  refused; there are no free paths.
- `source` fields and objects are validated against the schema snapshot.
- Objects the snapshot classifies as platform-internal principals (e.g. Sugar
  `Users`) cannot be mapped to `person` or `account` (§21).

### Persistence

`tenant_source_mapping_versions`: `(tenant_id, connection_id, version)` key;
`base_version`, `document` (jsonb, size-capped), `content_hash`,
`schema_snapshot_hash` (FK to the snapshot), `authority_version` validated
against, `effective_from`, `published_by`, `published_at`, `validation`
(codes and counts). Immutable (trigger), forced RLS. Drafts are files (CLI);
stored drafts are M14.

`tenant_field_mappings` is retired in the same milestone (§33).

---

## 8. Mapping kinds (M8 subset)

| Kind                                                 | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`                                           | exactly one per mapped object; the field must be an id/unique field in the snapshot or explicitly confirmed; transforms limited to null handling + trim; name-like fields refused; optional `alsoReferences` (a field holding another connection's id, e.g. a HubSpot company id stored in Sugar) adds a second external reference to the same canonical record, conflicts recorded as identity conflicts (M6), never merged            |
| `core`                                               | target in the entity's catalogue; type-compatible after transforms; enum targets need a complete value map with an unmapped policy; `explicit: unknown` (only for targets with an `unknown` value) or `explicit: null` (optional targets) states "no source" deliberately                                                                                                                                                               |
| `relationship`                                       | target in the catalogue; the field references a mapped object (or the product reference set); optional single-hop `fallbackVia` declared and confirmed; no multi-hop, no joins                                                                                                                                                                                                                                                          |
| `holdingFilter` (object option, `subscription` only) | **added from evidence**: one declarative membership test on the line object's own field (`field ∈ values` or `∉`), values validated against the snapshot's enum options, confirmation required; records outside it are `filtered_out` (counted, never ingested, never tombstone others). It exists because a Sugar RLI can be an open, lost or credited deal rather than a holding. One field, one set: no expressions, no combinations |
| `ignored`                                            | explicit, with a reason code; unmapped fields are reported as "not reviewed" (informational)                                                                                                                                                                                                                                                                                                                                            |

---

## 9. Closed transformation set

Fixed order, each optional: **null handling** (empty/whitespace/declared
sentinels → empty) → **normalise** (trim, collapse whitespace, case fold) →
**parse** (`date`/`datetime` with a format from a closed list and a declared
time zone for zone-less values; `number` with decimal separator; `boolean` with
declared true/false sets) → **value map** (source code → canonical code, with
an unmapped policy `unknown` \| `reject_record` \| `empty`). No expressions,
regex capture, arithmetic, conditionals or JavaScript. Anything more is adapter
code. The engine is pure and property-tested.

---

## 10. Mapping validation (publish-blocking unless marked warning)

| Code                                             | Meaning                                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity_missing`                               | a mapped object has no identity entry                                                                                                                                                                                   |
| `identity_unsuitable`                            | identity field not unique/id and not confirmed, or name-like (e.g. product name)                                                                                                                                        |
| `invalid_target` / `invalid_entity`              | not in the code catalogue                                                                                                                                                                                               |
| `duplicate_target`                               | two entries write the same target for one object                                                                                                                                                                        |
| `unknown_source_object` / `unknown_source_field` | not in the schema snapshot                                                                                                                                                                                              |
| `unsupported_source_type`                        | source type cannot reach the target type with the allowed transforms                                                                                                                                                    |
| `missing_relationship_target`                    | relationship points at an object not mapped with identity                                                                                                                                                               |
| `product_reference_required`                     | a `subscription` object without `subscription.product`                                                                                                                                                                  |
| `required_target_unstated`                       | `subscription.state`, `subscription.account`, `subscription.product` neither mapped nor explicitly stated                                                                                                               |
| `invalid_enum_map`                               | value map codes not in the canonical enum                                                                                                                                                                               |
| `unconfirmed_consequential_entry`                | identity, state value map, dates or `fallbackVia` without a recorded confirmation                                                                                                                                       |
| `authority_conflict`                             | the entry writes a fact its connection is not authoritative for (§15)                                                                                                                                                   |
| `schema_snapshot_stale`                          | the document was validated against a snapshot that is not the latest                                                                                                                                                    |
| `attribute_mappings_not_enabled`                 | reserved kind used                                                                                                                                                                                                      |
| `holding_filter_unconfirmed`                     | a `holdingFilter` without a recorded confirmation, or values not in the field's enum options                                                                                                                            |
| `holding_filter_required`                        | publishing a `subscription` object whose connection is (or is being made) authoritative for `subscription_lines` without a confirmed `holdingFilter` or an explicit, confirmed statement that every record is a holding |

Preview (records read, nothing written) adds data-quality codes with counts:
`unmapped_source_enum_value`, `invalid_date`, `duplicate_external_id`,
`orphan_reference`, `unknown_product_reference`, `relationship_conflict`,
`missing_reference` (skipped lines, §23), `filtered_out`, `invalid_period`,
`ownership_gap` (accounts marked incomplete).

---

## 11. Schema snapshots

`tenant_source_schema_snapshots`: `(tenant_id, connection_id, hash)`,
`captured_at`, `source_version`, `document` (normalised metadata, size-capped),
immutable, forced RLS. Content: objects (API name, label, classification,
per-object capabilities: change field, delete visibility, pagination), fields
(API name, label, description, source type, generic type, required/nullable,
enum options value/label/active, relationship target, id/unique indicators,
stable field id where present). **Never** record values, counts per value,
defaults or formula bodies.

---

## 12. Schema drift

- Detected by diffing a newly captured snapshot against the mapping version's
  snapshot: mapped field removed, type changed, enum option removed or added,
  relationship target changed, mapped object removed.
- The published mapping stays immutable; `source:report` and `sync:status`
  list drift with codes; the next publish requires revalidation against the
  new snapshot (`schema_snapshot_stale`).
- **Runtime**: every sync run starts with `describeSchema` (cheap metadata
  call) and compares the **mapped** surface only:
  - mapped field/object removed or type changed → the run **refuses to start**
    (`schema_drift`), checkpoint `failed`, nothing written, coverage unchanged;
  - new enum option on a mapped enum → run proceeds; affected records follow
    the entry's unmapped policy and are counted (`unmapped_source_enum_value`);
  - unmapped surface changes → reported only;
  - drift appearing mid-run (a page whose records lack a mapped field) → the
    page fails validation at the adapter boundary, the job retries, then the run
    fails with `schema_drift`. Nothing is reinterpreted.

---

## 13. Mapping publication concurrency

`MappingService.publish(ctx, connectionId, document, {expectedBaseVersion,
actor})`: `expectedBaseVersion` is a **required** parameter (the type has no
optional form; `0` for the first). Per-(tenant, connection) advisory lock;
if the latest version ≠ expected → `ConcurrentPublishError` (A loads v3, B
publishes v4, A's publish from v3 is refused). The CLI requires `--based-on`.
Same for authority declarations.

## 14. Product model publication hardening

`ProductCatalogueService.publish` gains a required `basedOnVersion` (`0` for
the first version). Existing lock and versioning unchanged. CLI
`product:model publish` refuses without `--based-on`. Tests: missing base
version refused; stale base refused; concurrent publishes from the same base →
exactly one wins. Runtime script 60, the operations guide and the M7 tests
update accordingly.

---

## 15. Source authority (minimal fact granularity)

### Recommendation: five facts

| Fact                 | Covers                                                                                                | Why it is separate                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `account_profile`    | account name, domains (later `customerStatus`)                                                        | HubSpot already writes these; Sugar must not overwrite them by accident                                                  |
| `person_profile`     | person email, names, job title, primary company link                                                  | same reason, for people                                                                                                  |
| `subscription_lines` | which source records are **holdings** (the holding filter), each line's account and product, quantity | Sugar evidence supports identity and relationships; holding qualification is BUSINESS; it decides ownership **coverage** |
| `subscription_state` | `subscription.state`                                                                                  | Sugar evidence does not support it                                                                                       |
| `subscription_terms` | `startsAt`, `endsAt`                                                                                  | Sugar date fields are candidates needing confirmation                                                                    |

**Re-evaluated against the evidence: the five facts remain the minimal
correct set.**

- Not too coarse: the evidence separates exactly along these lines. Sugar is
  strong for line identity and relationships, ambiguous for terms (two
  disagreeing date pairs), and unsupported for state. These are three facts.
  It does not separate start from end dates (same candidate pairs, same
  confirmation), so `subscription_terms` stays one fact.
- Not too fine: account and person profiles cannot merge into the line facts
  (different sources already write them: HubSpot today). Product identity and
  renewal linkage are not facts: the product model governs products, and
  renewal links are ignored in M8.
- Sharpened: `subscription_lines` explicitly includes **holding
  qualification**. Sugar cannot be made authoritative for it until Juniper
  confirms which RLIs are holdings (`holding_filter_required`). This is a
  business gate, not a precedence rule.

**Identity is not an authority fact**: every source keeps its own external
references (M6), and references from several systems coexist. Product
identity is governed by the product model's `externalRefs`.

`tenant_source_authority_versions`: versioned per tenant (required base
version), `{fact → connection | unassigned}` plus optional corroborating
connections (recorded, never write). Defaults after migration:
`account_profile`, `person_profile` → the HubSpot connection where one exists;
`subscription_lines`, `subscription_terms` → the `import` connection where an
M7 full import completed (preserving M7 coverage); `subscription_state` →
`import` likewise; everything else unassigned.

Enforcement: at mapping publish (`authority_conflict`) and in the pipeline
(a non-authoritative connection's value for a fact is dropped and the field
written as unknown/null for lines it creates, never overwriting an
authoritative value). **No precedence chains, voting or per-field merging.**

Known limitation (accepted): combining state from source B with lines from
source A requires correlating lines across sources — deferred to M9 with
evidence. Until then an unassigned fact stays unknown/null.

---

## 16. Unknown subscription state

- Mapping states `subscription.state` as `explicit: unknown` (or maps a
  source state field only with a confirmed value map, from the line object
  itself — never from the opportunity's sales stage, revenue, existence or end
  dates). The adapter never derives state.
- `sales_stage` (94.8% populated; pipeline and post-sale values) may be used
  for the holding filter (§8) or, if Juniper confirms a mapping and assigns
  `subscription_state` to Sugar, for a confirmed value map. Neither is
  configured by default; e.g. `Pending Cancellation` (fixture 06) has no
  agreed canonical meaning.
- M7 handles this today (verified against the code):
  - **ownership**: a line in state `unknown` in force at `asOf` makes the
    product's ownership `unknown` (`subscription_state_unknown`), never owned or
    not owned;
  - **coverage**: unaffected by state (it is about lines being complete);
  - **eligibility**: the product itself is `unknown`; products whose
    requirements or exclusions involve it become `unknown`; precedence fail >
    unknown > eligible holds;
  - **whitespace**: such products land in `unknown`, never `eligible_whitespace`;
  - **explainability**: checks cite the line ids and the reason code.
- Products with **no** line, under complete `subscription_lines` coverage,
  are `not_owned` — correct only if the owner assigns `subscription_lines`
  authority to Sugar. Until assigned, coverage stays unknown and everything is
  `unknown` (§23).
- A mutation proof removes the explicit-unknown handling (e.g. defaults state
  to `active`) and shows the tests fail.

## 17. Subscription dates

Evidence: two candidate pairs (`service_start_date`/`service_end_date`,
33.5% null; `revenue_start_date_c`/`revenue_end_date_c`, 8.6% null) that
disagree in population, `date_support_*` unused (100% null), and opportunity
`date_closed` is a deal date that must not become `startsAt`.

- Date entries are consequential: publish requires a recorded confirmation per
  entry (which pair, and that it means the service term); otherwise the mapping
  states `explicit: null` and canonical dates stay empty. Choosing between the
  pairs is a **BUSINESS** decision.
- Values are date-only in the evidence (`2026-01-01`): the mapping declares the
  time zone (e.g. `Europe/London` or `UTC`, BUSINESS) and whether an end date
  is inclusive (the canonical end is exclusive, so an inclusive source end date
  is converted to the next day's start by the declared rule, never guessed).
- **Changed from `521fbc6`**: an unparseable date or an end before its start
  (fixture 13) does not drop the line. The line is ingested with **both terms
  empty and state `unknown`**, counted `invalid_period`, so it can only make
  ownership `unknown`, never cause false whitespace. Dropping it could hide a
  real holding.
- Provenance records the mapping version, so later corrections are traceable.

## 18. Renewals

Evidence: RLI `renewal_rli_id` (33.6%), `renewal` flag (35.1% true) and
opportunity `renewal_parent_id` (34.2%) coexist; none is confirmed
authoritative (BUSINESS). In M8 these fields are mapped as `ignored` with
reason `semantics_unconfirmed`; fixtures 04 and 05 prove two lines result.

One canonical line per source line (RLI). No deduplication, merging or
"latest wins" across RLIs, even with identical account, product and dates.
Overlaps and renewals are M7's multiple-line semantics (ownership is "any
line qualifies"). If business semantics later prove duplication, that is a
new evidence-based rule, not a heuristic.

## 19. Product mapping

- The Sugar product catalogue is a **source reference set only**. The
  connector never creates or edits product model entries.
- Lines resolve products through the published product model's
  `externalRefs` (`{system: sugar, objectType: <catalogue module>, id}`); names
  are never used.
- Operator assistance: `source:report --products` lists source product ids
  referenced by lines but absent from the model (ids and labels from metadata
  only; labels are catalogue vocabulary), and can write a **draft** product
  model file with those ids as `externalRefs` for an operator to edit and
  publish through `product:model publish --based-on` (human-reviewed, never
  automatic).
- Source products that are not subscription products (services, one-off
  items) are listed in the mapping's `productReferences.ignored` with a reason;
  their lines are skipped (`non_subscription_product`), counted, and do not
  block coverage or create ownership gaps (the exclusion is declared).
- Evidence: 1,203 catalogue rows, 60% inactive and 9% retired; `renewable`
  (37% true), `service` and RLI `recurring_one_off_c` (Recurring / Non
  Recurring / One Off / null) are MEDIUM-confidence hints. The report shows
  them per product to help the operator decide; **none is mapping logic** and
  none writes the product model. Fixtures 15 (one-off) and 16 (recurring) test
  both outcomes: ignored product → skipped; modelled product → ingested.
- The catalogue is read in every full sync (small: ~1,200 rows) so the
  pipeline can tell a **source orphan** (id absent from Sugar's catalogue) from
  an **unmodelled product** (present in Sugar, absent from the product model
  and not ignored) (§23).

## 20. Account identity

Sugar `Accounts.id` → external reference `sugar/Accounts/<id>` through the
M6 writer (`ContextIngestionService.ingest`, company observation). No second
mechanism. Without `account_profile` authority, Sugar writes only the
reference (the company row may have a null name, as M6 allows). Cross-system linking (the same account in HubSpot) happens only through a validated
`alsoReferences` identity field if one exists, or later identity resolution
(M11); never by name or domain. The evidence shows no populated cross-system
id (`juniper_id_c`, `subscription_urn_c` are 100% null on RLIs; account-level
fields were not profiled), so Sugar accounts are expected to become separate
canonical companies until identity resolution — documented, not a defect.

## 21. Contacts and people

Sugar `Contacts.id` → person external reference through the M6 writer.
Profile fields and the account link only with `person_profile` authority;
otherwise reference only. The `Users` module (internal staff) is classified
`internal_principal` in the snapshot and cannot be mapped to `person` (§7).
For Juniper, Contacts ingestion is **off by default** (object not mapped)
until authority is decided; the capability is built and tested with fixtures.
Evidence: 10% of contacts have no account (company link stays empty, BUSINESS
to decide whether they are orphans or unconverted leads); 0.04% duplicate ids
are idempotent; the historical integration keyed people by `email1`, which M6
forbids, so email is mapped (with authority) as a profile field only.

## 22. Relationships in M8

| Relationship                | Use                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RLI → Account               | `subscription.account` (primary)                                                                                                                                       |
| RLI → Opportunity → Account | optional confirmed `fallbackVia` when RLI `account_id` is empty; Opportunities are read only for this, in one batched call per page; not ingested as canonical records |
| RLI → Product               | `subscription.product` through product references                                                                                                                      |
| Contact → Account           | `person.primaryCompany` (only with `person_profile` authority)                                                                                                         |
| Opportunity → Account       | only as the fallback hop above                                                                                                                                         |

When primary and fallback both exist and differ: primary wins and
`relationship_conflict` is counted. Evidence supports the fallback's value:
RLI→Opportunity resolves 100% and Opportunity→Account 99.2% with 0% orphans,
so most of the 1,295 account-less RLIs can be attributed; whether the
opportunity's account is the right owner for its lines is BUSINESS (the
fallback needs confirmation). Fixture 09 (an opportunity whose account does not
exist) proves the fallback fails safely (`orphan_reference`). Activities and timelines are out of scope.

---

## 23. Coverage

Coverage stays tenant-level (M7, debt #22) at its root, with one
evidence-driven refinement per account.

> **Tenant coverage known** when the latest completed **full** sync of the
> connection authoritative for `subscription_lines`, under a published mapping
> version, finished without blocking errors and passed the full-read proof.

### Run lifecycle (checkpoint `kind = subscription`, `mode = backfill`, `source_connection_id`)

```
pre-flight: authority assigned? holding filter confirmed? mapping published? schema drift? → refuse or start
→ count(bounded set) at start
→ accounts full read (references) → product catalogue full read (ids only)
→ lines full read, page by page (bounded set, ordered)
→ per line: holding filter → map → classify:
     filtered_out | skip (declared) | skip + ownership gap | ingest (possibly as unknown) | reject (blocking)
→ count(bounded set) at end; reconcile with records seen
→ tombstone pass for this connection's lines not seen (only if the proof passed, §25)
→ replace this connection's ownership gaps with the run's set
→ completed (coverage known) | failed (coverage and gaps unchanged)
```

### Classification (changed from `521fbc6`)

| Line condition                                                       | Example (fixture)          | Outcome                                                          | Blocks coverage?                                          | Ownership gap?                               |
| -------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| outside the holding filter                                           | (new fixture: Closed Lost) | `filtered_out`                                                   | no                                                        | no                                           |
| product declared non-subscription                                    | 15 (if ignored)            | skip `non_subscription_product`                                  | no                                                        | no                                           |
| product id null                                                      | 12                         | skip `missing_product_reference`                                 | no                                                        | **yes**, for the line's account              |
| product id absent from Sugar's catalogue (source orphan)             | 10                         | skip `orphan_product_reference`                                  | no                                                        | **yes**                                      |
| product in Sugar's catalogue, not in the model, not ignored          | (new fixture)              | reject `unmodelled_product_reference`                            | **yes** (configuration gap: fix the model or ignore list) | —                                            |
| account id null and no fallback                                      | (new fixture)              | skip `missing_account_reference`                                 | no                                                        | no (no account to mark; tenant-level count)  |
| account id absent from Sugar's accounts (source orphan), no fallback | 09 via fallback            | skip `orphan_account_reference`                                  | no                                                        | no (tenant-level count)                      |
| account present in Sugar but not ingested in this run                | —                          | reject `unresolved_account_reference`                            | **yes** (platform defect)                                 | —                                            |
| invalid/conflicting term                                             | 13                         | ingest with empty terms, state `unknown`, count `invalid_period` | no                                                        | no (the line itself makes ownership unknown) |
| unmapped enum value                                                  | 07 (`status` value)        | per entry policy; state stays `unknown`                          | no                                                        | no                                           |
| schema drift                                                         | (new fixture)              | run refused                                                      | **yes**                                                   | —                                            |

### Per-account ownership gaps (new)

A skipped line whose account resolved but whose product cannot be known means
"this account holds something we cannot attribute". Treating that account as
fully covered could show a product it owns as eligible whitespace. So:

- the full sync records `(account, source line, reason)` in
  `tenant_ownership_gaps` (tenant-owned, forced RLS; replaced per completed
  full run of the connection; never evidence, only derived state);
- `EligibilityService.load` treats an account with an open gap as
  `coverage: 'unknown'` with a new reason `ownership_incomplete` (instead of
  `ownership_not_loaded`), so every product is `unknown` for that account and
  the explanation says why;
- this changes M7 only in the service's coverage input and one reason code:
  **no Subscription shape change**; `EVALUATOR_VERSION` becomes 2 (old
  snapshots replay as `evaluator_changed`, as designed). ADR 0018 note.
  **Decision for the plan review** (alternative: reuse `ownership_not_loaded`
  without an evaluator bump, at the cost of a less precise explanation).

Lines with no attributable account cannot mark any account; they are counted
per run and listed in the report (accepted residual risk, BUSINESS
awareness).

### Full-read proof

A source never declares itself complete. With offset pagination (the
evidenced mechanism), records modified during the run leave the bounded set
(`date_modified <= runStart`) and can shift later records to earlier offsets.
The run is therefore only accepted as complete when `count(bounded set)` at
start = at end = records read; otherwise it fails with `unstable_read` and is
retried. If the live tenant offers no count endpoint, keyset paging (`$gt` on
`date_modified`+`id`) must be proven instead; if neither exists, coverage
cannot be certified from Sugar (**LIVE**, new potential blocker for real use,
not for implementation). The fake Sugar implements both so the mechanism is
proven either way.

M7's CSV import continues to set coverage for tenants whose authority is the
`import` connection.

## 24. Incremental sync

- Checkpoint `mode = incremental`, watermark `(high_watermark timestamp,
last id)` from the last **completed** run; window = `watermark − overlap`
  (default 10 minutes, configurable per connection) to absorb clock skew and
  late commits.
- Order `date_modified asc, id asc`; resume within a run from the stored
  cursor; advance the watermark only at run completion.
- Idempotency and ordering come from the existing writers: `sourceUpdatedAt =
date_modified`, field hashes, `decideApply` (older → stale, equal hash →
  unchanged), so overlap re-reads and duplicate deliveries are no-ops.
- Incremental runs never establish coverage and cannot see deletions
  (unless delete visibility is proven); a scheduled full sync (configurable,
  e.g. weekly) does both.
- No rolling 7/14/90-day windows (historical delta scripts), no CDC. The
  historical filter was `$gt` on a zone-less timestamp; the platform uses
  `$gte` with overlap and the decision rules above, and the precision and time
  zone of `date_modified` are **LIVE**.

## 25. Deletion and tombstones

- Delete visibility in the current Sugar API is **unverified** → capability
  `none` until the live gate proves a mechanism. Evidence: 0 of 255,684 RLIs
  had `deleted = True` in the export, which cannot distinguish "no deletions"
  from "the API omits deleted records by default" (**LIVE**). If the API returns
  rows with `deleted = True` (fixture 14 shape), the adapter maps them to
  `presence: absent` (capability `flag`).
- Safe fallback (designed, not guessed): the **full sync tombstone pass** — a
  line of this connection not seen in a completed full run is tombstoned
  through the writer (`presence: absent`, as M7 CSV full imports do). Never in
  incremental runs, never after a failed run.
- Accounts/people are not tombstoned by Sugar in M8 (they may be referenced
  by other systems; M6 lifecycle rules apply to their own sources).

## 26. Provenance

Reuse `tenant_context_changes`. M8 adds two nullable columns:
`source_connection_id` (FK) and `mapping_version` (int). Every mapped write
records: connection, source object (`source_object_type`), source record id,
mapping version, `source_updated_at`, changed canonical field names, cause
(`backfill` / `reconciliation` for incremental), checkpoint id and correlation
id. Values are never recorded or logged. Checkpoints gain
`source_connection_id` and `mapping_version`.

## 27. Data quality

Per run, counts by stable code on the checkpoint (new jsonb `quality` column,
codes → counts): `duplicate_external_id`, `orphan_reference`,
`unknown_product_reference` (renamed `unmodelled_product_reference`),
`orphan_product_reference`, `missing_product_reference`,
`orphan_account_reference`, `missing_account_reference`, `filtered_out`,
`invalid_period`, `ownership_gap`, `unstable_read`,
`unmapped_source_enum_value`, `invalid_date`, `relationship_conflict`,
`schema_drift`, `coverage_incomplete`. Exposed by `sync:status` and
`source:report`. No profiling or dashboards.

## 28. Synthetic fixtures

### Discovery fixtures (evidence, kept verbatim)

`fixtures/sugarcrm/sanitized/01–16` (from `planning/m8-sugar-evidence`):
RLI-shaped rows (fixture 09 is one opportunity row), synthetic `FIX-…` ids.
They are **not edited**: they are evidence. Two README/CSV mismatches are
recorded, not fixed: fixture 06 has no cancellation-date column, and fixtures
15/16 have no `renewable` column (`renewable` is a catalogue field). The
companion catalogue fixture carries those values instead.

### Companion fixtures (M8-authored, synthetic, `apps/api/test/fixtures/sugar/`)

Needed because the discovery set has no: Account, Contact, product catalogue,
Users, schema-metadata (`/{Module}/fields`) responses, pipeline stages other
than Closed Won/Pending Cancellation, multi-page sets, deleted-record feeds,
drift variants or authority conflicts. Companion files reference the same
`FIX-` ids (e.g. `FIX-ACC-001`, `FIX-PROD-001`), add `FIX-ACC-*`/`FIX-PROD-*`
rows the scenarios need (but **no** `FIX-PROD-DOES-NOT-EXIST` and **no**
`FIX-ACC-DOES-NOT-EXIST`, so the orphans stay orphans), and add: a Closed Lost
RLI, an open-pipeline RLI, an unmodelled product, an account-less RLI with and
without a usable opportunity, a Users row, schema metadata v1/v2 (field removed,
type changed, enum option added), and 1,000+ generated lines for pagination
and count-reconciliation tests (generated by a seeded function, not committed
as data).

### Fixture-to-test matrix

Columns: extraction (adapter against the fake), mapping validation, canonical
ingestion, unknown-state behaviour, coverage, provenance, expected
failure/warning, live verification needed. "Default mapping" = state
`explicit: unknown`, dates confirmed to the `service_*` pair (test
configuration only; the real choice is BUSINESS), holding filter = Closed Won
(test configuration only).

| #   | Fixture                                             | Extraction                                               | Mapping validation                                      | Canonical ingestion                                                                                                                     | Unknown state                                                         | Coverage                                                  | Provenance                                                                                  | Expected failure / warning                                                        | Live?                             |
| --- | --------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| 01  | normal case                                         | 1 RLI page; fields limited to mapped                     | passes                                                  | company ref + 1 line, terms 2026-01-01→2027-01-01 (inclusive end converted)                                                             | state `unknown` → product ownership `unknown`; eligibility `unknown`  | contributes; run completes                                | 1 `created` row: connection, `RevenueLineItems`, `FIX-RLI-001`, mapping v1, `date_modified` | none                                                                              | no                                |
| 02  | several products                                    | 3 lines, one page                                        | passes                                                  | 3 lines, 3 products; line C (Non Recurring, no dates) ingested with empty terms if its product is modelled                              | all 3 `unknown`                                                       | contributes                                               | 3 rows                                                                                      | none (or `non_subscription_product` skip if FIX-PROD-012 is ignored in a variant) | no                                |
| 03  | multiple lines same product                         | 2 lines                                                  | passes                                                  | 2 lines, same product, quantities 5 and 3 kept separately                                                                               | `unknown`                                                             | contributes                                               | 2 rows                                                                                      | none                                                                              | no                                |
| 04  | renewal                                             | 2 lines (2 opportunities)                                | renewal fields `ignored` (`semantics_unconfirmed`)      | 2 lines, no collapse                                                                                                                    | `unknown`                                                             | contributes                                               | 2 rows                                                                                      | none                                                                              | no                                |
| 05  | expired + active renewal                            | 2 lines                                                  | passes                                                  | 2 lines; with a test variant mapping state `active` (authority assigned) ownership is `owned` via the in-force line only                | default `unknown`; variant proves "any line in force"                 | contributes                                               | 2 rows                                                                                      | none                                                                              | no                                |
| 06  | cancelled (Pending Cancellation)                    | 1 line                                                   | passes; value map for `sales_stage` absent by default   | 1 line                                                                                                                                  | `unknown` (no agreed meaning)                                         | with holding filter = Closed Won: `filtered_out`          | none if filtered                                                                            | `filtered_out` counted                                                            | no (BUSINESS)                     |
| 07  | unknown status                                      | 1 line; `status` value unrecognised, `sales_stage` blank | `status` mapped only in a variant with policy `unknown` | 1 line (if filter allows blank, variant)                                                                                                | `unknown`; `unmapped_source_enum_value` counted in the variant        | contributes                                               | 1 row                                                                                       | warning count                                                                     | no                                |
| 08  | future-dated line                                   | 1 line                                                   | passes                                                  | 1 line, terms in 2027–2028                                                                                                              | not in force before start; `unknown` once in force (state unknown)    | contributes                                               | 1 row                                                                                       | none                                                                              | no                                |
| 09  | orphan opportunity                                  | opportunity read only for fallback                       | `fallbackVia` confirmed                                 | an RLI relying on the fallback is skipped                                                                                               | n/a                                                                   | not blocked; tenant-level `orphan_account_reference`      | none                                                                                        | `orphan_account_reference`                                                        | no                                |
| 10  | orphan product                                      | 1 line; catalogue lacks the id                           | passes                                                  | skipped                                                                                                                                 | account FIX-ACC-009 → `ownership_incomplete` (all products `unknown`) | not blocked; gap recorded                                 | none for the line                                                                           | `orphan_product_reference`, `ownership_gap`                                       | no                                |
| 11  | duplicate source line                               | same id twice (dates differ by one day)                  | passes                                                  | 1 line; second observation newer `date_modified`, same values → unchanged                                                               | `unknown`                                                             | contributes                                               | 1 `created` row only                                                                        | `duplicate_external_id` counted                                                   | export artefact vs API: **LIVE**  |
| 12  | missing product id                                  | 1 line, empty `product_template_id`                      | passes                                                  | skipped                                                                                                                                 | account FIX-ACC-011 → `ownership_incomplete`                          | not blocked; gap recorded                                 | none                                                                                        | `missing_product_reference`, `ownership_gap`                                      | no                                |
| 13  | conflicting dates                                   | 1 line, end before start                                 | passes                                                  | line ingested, terms empty, state `unknown`                                                                                             | `unknown`                                                             | contributes                                               | 1 row (changed fields exclude terms)                                                        | `invalid_period` counted                                                          | no                                |
| 14  | deleted / tombstoned                                | 1 line with `deleted = True`                             | passes                                                  | with capability `flag`: `presence: absent` → tombstoned (or not created); with `none`: tombstoned by the next full-run pass when absent | n/a                                                                   | contributes                                               | `state_changed` row (`recordState`)                                                         | none                                                                              | delete visibility: **LIVE**       |
| 15  | one-time product line                               | 1 line, One Off, no dates                                | passes                                                  | variant A (product ignored): skipped `non_subscription_product`; variant B (product modelled): ingested, empty terms                    | B: `unknown`                                                          | not blocked in A; no gap                                  | B: 1 row                                                                                    | A: skip count                                                                     | no (BUSINESS for the ignore list) |
| 16  | recurring product line                              | 1 line, Recurring                                        | passes                                                  | 1 line                                                                                                                                  | `unknown`                                                             | contributes                                               | 1 row                                                                                       | none                                                                              | no                                |
| C1  | Closed Lost RLI (companion)                         | 1 line                                                   | passes                                                  | `filtered_out`                                                                                                                          | n/a                                                                   | not blocked                                               | none                                                                                        | `filtered_out`                                                                    | BUSINESS                          |
| C2  | unmodelled product (companion)                      | 1 line                                                   | passes                                                  | rejected                                                                                                                                | n/a                                                                   | **run fails**, coverage unchanged                         | none                                                                                        | `unmodelled_product_reference`                                                    | no                                |
| C3  | schema drift v2 (companion)                         | describe at run start                                    | `schema_snapshot_stale` at publish                      | none                                                                                                                                    | n/a                                                                   | **run refused**                                           | none                                                                                        | `schema_drift`                                                                    | no                                |
| C4  | 1,000+ lines with mid-run modifications (generated) | multi-page offset + count reconciliation                 | passes                                                  | all lines                                                                                                                               | `unknown`                                                             | count mismatch → `unstable_read`, run fails; retry passes | idempotent                                                                                  | `unstable_read`                                                                   | counts/keyset: **LIVE**           |
| C5  | Users row (companion)                               | schema classifies `Users` as internal                    | mapping `Users → person` refused                        | none                                                                                                                                    | n/a                                                                   | n/a                                                       | none                                                                                        | `invalid_entity`                                                                  | no                                |

## 29. Mock-first adapter

`test/support/fake-sugar.ts`: a deterministic HTTP fake (like
`fake-hubspot.ts`) implementing the Sugar endpoints the adapter uses (token,
metadata, list with filter/order/keyset and offset, get by id), seeded from
the fixtures, with fault injection (429 with `Retry-After`, 5xx, timeouts,
page interruption, schema change between calls, field disappearing mid-run).
The real adapter runs against it in integration and runtime tests, so the
code under test is the production adapter, not a stub. Its responses are built
from the discovery fixtures plus the companion fixtures (§28); its endpoint
shapes follow the historical client and current docs and are re-checked at the
live gate.

## 30. Live Sugar verification gate (separate from completion)

Recorded in `docs/integrations/sugar/live-verification.md`, run only with
Juniper-approved read-only credentials. Every item below is
`REQUIRES LIVE SUGAR VERIFICATION`; none may be treated as certain because
the historical code did it.

| Item                                                                                               | Why it is not proven locally                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| API version in use (`v11_20` is a placeholder)                                                     | not a real tenant value                                                                 |
| Auth flow: password grant still permitted; refresh-token grant; token lifetime; platform parameter | historical code re-authenticated with the password; refresh-token grant never exercised |
| `/ping` connection test                                                                            | historical only                                                                         |
| `GET /{Module}/fields` (or metadata) response shape                                                | historical shape, current docs not tenant-verified                                      |
| Module and field API names on the live tenant (incl. the product catalogue module)                 | export names may differ from API names                                                  |
| Permissions per module (least privilege, read only)                                                | never checked                                                                           |
| List reads with `fields`, `filter`, `order_by`, `max_num`/`offset`                                 | historical only                                                                         |
| Count endpoint (full-read proof) or keyset with `$or`/`$gt` on `date_modified`+`id`                | never exercised                                                                         |
| `date_modified` precision, time zone and update-on-every-change                                    | historical used zone-less `$gt`                                                         |
| `GET /{Module}/{id}`                                                                               | not in historical code                                                                  |
| Rate limits, `Retry-After`, 5xx behaviour                                                          | not documented in the evidence                                                          |
| Delete visibility (`deleted = True` rows, filters)                                                 | 0 deleted rows in the export                                                            |
| Duplicate ids returned by the API (vs export artefacts)                                            | 15 duplicate RLI ids in the export                                                      |
| Current schema and custom fields (`juniper_id_c`, `subscription_urn_c` dead tenant-wide?)          | export window only                                                                      |
| Live counts vs a full run (accounts, lines, products)                                              | export may have been truncated (e.g. Notes at exactly 50,000)                           |
| Read-only proof (transport guard counters)                                                         | needs the live tenant                                                                   |

M8 may be reported **IMPLEMENTATION COMPLETE** without it; the record then
states **LIVE SUGAR VERIFICATION PENDING**, and no tenant may enable a real
Sugar connection until the gate passes.

Separate **BUSINESS** gate (Juniper, not a data question): which RLIs are
holdings (holding filter); which date pair is the service term and its time
zone/inclusive end; whether any field means "active"; renewal semantics;
which products are non-subscription; whether contacts without accounts are
orphans; whether the opportunity's account may stand in for a line's missing
account; who is authoritative for `subscription_lines`, `subscription_terms`
and `subscription_state`.

## 31. Future UI readiness

Services (not CLI strings) return typed results the M14 workspace can call:
`SourceConnections.create/test/list`, `SchemaSnapshots.capture/get/diff`,
`MappingTargets.list(entity)`, `Mappings.validate/preview/publish(expectedBaseVersion)/show/diff`,
`Authority.validate/publish(expectedBaseVersion)/show`,
`Sync.start(full|incremental)/status`, `SourceReport.get` (drift, quality,
coverage, unknown products). Every result carries codes, paths and counts.

## 32. CLI (thin, over the services)

`sources:list` · `sources:test --connection` · `sources:schema --connection
[--capture --execute] [--diff]` · `mappings:validate --file` ·
`mappings:preview --file [--limit]` · `mappings:publish --file --based-on N
--execute` · `mappings:show [--version]` · `authority:show` ·
`authority:publish --file --based-on N --execute` · `sync:full` /
`sync:incremental --connection [--execute]` (enqueue on the worker) ·
`sync:status` · `source:report [--products]`. Writes are dry runs unless
`--execute`. JSON output with ids, codes, counts, hashes.

## 33. Legacy `tenant_field_mappings`

- **Consumers**: `TenantConfigService.list/save/deleteFieldMapping`, the
  repository, the template `fieldMappings` key and provisioning; no runtime
  business consumer.
- **Content**: Juniper's template holds 10 Sugar **Leads** rows (7 `tbc`
  outbound, 2 `tbc` bidirectional, 1 `proposed` bidirectional) — write-path
  intent for the future lead handover (M15), not inbound mappings. They are
  **not** converted into inbound mapping versions. Their content (fields,
  directions, notes) moves verbatim to
  `docs/integrations/sugar/lead-handover-field-intent.md` as an M15 input.
- **Migration**: `CLI tenants:export-legacy-field-mappings` writes every
  tenant's rows to a JSON file (operator step, recorded); the migration
  refuses if any row has `status = confirmed` (none expected), otherwise drops
  the table; the code, schema and template key are removed in the same commit.
- **Down-script** (dev/staging): recreates the table with its constraints and
  RLS; data is restored from the export with a generated restore script. It
  refuses if the table name is in use.

## 34. Tenant isolation

Every new table (`tenant_source_connections`, `tenant_source_schema_snapshots`,
`tenant_source_mapping_versions`, `tenant_source_authority_versions`) has
`tenant_id NOT NULL`, tenant-leading keys, composite tenant FKs (a mapping
cannot reference another tenant's connection or snapshot), forced RLS and the
tenant-immutable trigger; the schema guard enforces it. `connector_kinds` is
platform data (no tenant, read-only to the app role). Tests: cross-tenant
read/write refused per table, RLS mutation tests, sync of tenant A never reads
B's connection or secrets, provenance and checkpoints isolated.

## 35. Security

`SecretProvider` only (credential names in connections, values never stored
or logged); mapping documents, snapshots and config refuse secret-like keys;
snapshots metadata-only; preview ≤ 20 records, mapped fields only, masked
(identity values hashed, strings truncated), never persisted or logged;
errors carry codes and ids, never values; read-only transport guard; Sugar
least privilege (read on the mapped modules and metadata only), documented
for the customer.

## 36. Reliability

Reuse the M6 platform: BullMQ `lip-bulk` jobs (`source.sync`) on the worker,
checkpoints with resume after worker restart, stalled-job recovery,
deterministic job ids (one active run per connection and kind — unique
`active_key`), retries with backoff and `Retry-After`, per-connection rate
limiter, adapter timeouts, dead letters for permanent page failures,
duplicate/out-of-order safety from `decideApply`, schema check per run and per
page. A partial full load never completes and never tombstones. No new
processing system.

## 37. Performance

Pages of 100–200 records; mapped fields only; accounts referenced by a page
resolved with one query; product resolution from the cached indexed model;
opportunity fallbacks fetched in one batched call per page; writes through
the existing writers (one transaction per record, as M6/M7; a page-level
batch is a later optimisation if measurements need it). No per-product or
per-field API calls.

## 38. Observability

Metrics (labels: tenant id, connection kind, object, code — no values):
`lip_source_requests`, `lip_source_rate_limited`, `lip_source_pages`,
`lip_source_records{outcome=mapped|ignored|skipped|rejected}`,
`lip_source_mapping_errors{code}`, `lip_source_checkpoint_progress`,
`lip_source_coverage{state}`, `lip_source_retries`. Logs: run lifecycle with
ids, counts and codes.

## 39. Mutation and failure proofs

Each broken deliberately, the guarding test must fail for the stated reason,
then pass after restore:

mapping-version immutability trigger · required base version (mapping,
authority, product model) · schema-snapshot mismatch at publish and at run
start · forced RLS on each new table · authority enforcement (non-authoritative
value written) · unknown-state preservation (state defaulted to `active`) ·
product name accepted as identity · duplicate external id handling · checkpoint
resume idempotency · watermark overlap (overlap removed ⇒ a late record is
missed) · provenance mapping version (column not written) · adapter
registration guard · secret isolation (another tenant's credential name) ·
coverage gate (a failed or partial run marks coverage known) · tombstone pass
in an incremental run · read-only transport guard · single-writer rule (a
mapping path writing tables directly) · `sugar` imported by business code ·
holding filter ignored (a Closed Lost line ingested) · ownership gap ignored
(an account with an orphan-product line evaluated as covered) · invalid period
dropping the line instead of ingesting it as unknown · count reconciliation
removed (an unstable read marks coverage known) · orphan vs unmodelled
classification swapped.

## 40. Second-customer portability

| Customer B source | What is needed                                                                                                                                                                                                                                         | Core change?                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Salesforce        | kind `salesforce` (one row + catalogue entry), adapter (OAuth, `describe`, SOQL keyset, `SystemModstamp`, `queryAll` deletes), connection, mapping (Account → account, an asset/subscription object → subscription, Product2 ids → product references) | no                                                                                                                                                                                                                                                                        |
| Snowflake         | kind `snowflake`, adapter (tables as objects, `INFORMATION_SCHEMA` metadata, keyset by declared key), connection config declaring the key and an optional change column per table                                                                      | no — **design adjustment made**: capabilities are per object and may come from connection config, and relationships may be **declared in the mapping** when the source has no relationship metadata (validated by preview orphan checks, flagged `declared` not `source`) |
| Intercom, Pendo   | account/person identity only in M8 terms; their events are signals (M10)                                                                                                                                                                               | no                                                                                                                                                                                                                                                                        |

Product, Subscription and Eligibility core are untouched: everything
source-specific is adapter code, catalogue entries and tenant configuration.

## 41. Out of scope

Attribute registry and `attribute` mappings; `registered_attribute`
eligibility; M9 (second source); Gainsight, Chargebee, NetSuite and warehouse
connectors; moving HubSpot onto versioned mappings; signals; opportunity
candidates; qualification; priority; routing; frontend; AI mapping
suggestions; CRM writes; generic ETL; transform language; field precedence;
GDPR deletion; timeline/activity ingestion; several connections of one kind.

## 42. Migrations

| #   | Name                                     | Up                                                                                                                                                                                                                                                                                                                                                                                                                                      | Down (dev/staging) / refusal                                                                                                                                                                                           |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `m8_connector_kinds_and_connections`     | create `connector_kinds` (seeded); replace system CHECK lists with FKs on all source-system columns; create `tenant_source_connections` (RLS, tenant trigger); add `source_connection_id`, `mapping_version` to `tenant_context_changes` and `tenant_sync_checkpoints`, `quality` to checkpoints; backfill `import` (all tenants) and `hubspot` (configured tenants) connections; set `source_connection_id` on existing M7 import runs | refuses if any connection beyond the backfilled ones exists, any provenance/checkpoint row references a connection or mapping version, or any kind outside the original five is used; restores the CHECK lists exactly |
| 2   | `m8_schema_snapshots_mappings_authority` | create snapshots, mapping versions, authority versions (immutable triggers, RLS, composite tenant FKs); create `tenant_ownership_gaps` (tenant-owned, RLS, composite FKs to companies and connections; rows replaced per completed full run); seed the default authority version per tenant (§15)                                                                                                                                       | refuses if any snapshot, mapping version, authority version beyond the seeded one, or ownership gap exists                                                                                                             |
| 3   | `m8_retire_tenant_field_mappings`        | refuse if any `confirmed` row; drop `tenant_field_mappings`                                                                                                                                                                                                                                                                                                                                                                             | recreates the table, constraints and RLS (data via the export restore script); refuses if the name is taken                                                                                                            |

All three run with the migration (owner) role; the app role stays
non-privileged; the migrations spec gains upgrade (M7 → M8 with data),
down-script and refusal tests, as in M6/M7.

## 43. ADRs

- **0019 Source connectors**: connector-kind catalogue, source connections,
  the generic port and capabilities, schema snapshots and drift.
- **0020 Versioned source mapping and authority**: mapping document, entry
  kinds, closed transforms, validation, publication with required base
  version, authority facts, coverage by authority, provenance additions,
  retirement of `tenant_field_mappings`.
- **0021 SugarCRM reference adapter**: evidence (and its limits), identity and
  relationship choices, unknown state, dates, renewals, pagination,
  incremental, deletes, the live verification gate.

Product-model base-version hardening is a note in ADR 0016 (no new ADR).

## 44. Test strategy

- **Unit**: catalogue; mapping document schema and validator (every code);
  transform engine; mapping engine (record → observation); authority checks;
  drift diff; Sugar adapter request building and response validation.
- **Property** (`fast-check`, seeded): the mapping engine is deterministic
  and total (never throws on any record, only returns observation/skip/reject);
  transforms are idempotent where declared (normalise); value maps never emit a
  code outside the target enum; identity entries never change the identity
  value beyond trim; a mapping that validates never produces an
  `invalid_target` at run time.
- **Integration (Testcontainers + fake Sugar)**: connection CRUD and isolation;
  snapshot capture and drift; mapping publish/immutability/concurrency;
  authority; full sync to coverage; skips vs blocking; tombstone pass;
  incremental with overlap, out-of-order and duplicates; resume after worker
  restart; schema drift refusal; provenance contents; legacy migration.
- **Migration**: M7 → M8 upgrade with data; down-scripts and refusals.
- **Runtime** (`scripts/verify-runtime.d/70-source-connectors.sh`): real
  worker + CLI against the fake Sugar: connect, test, schema, publish mapping,
  full sync, eligibility shows `unknown` from unknown state, incremental,
  drift refusal, no values/secrets in logs, read-only counters.
- **Docker**: the sources CLI inside the image.
- **Fresh clone** and **CI**: all of the above without live Sugar.
- **Mutation/failure**: §39.

## 45. Acceptance criteria

1. The connector-kind catalogue replaces the closed source enums and CHECK
   lists with no data change; adding a kind is one catalogue entry + migration
   row + adapter.
2. Source connections are tenant-isolated (forced RLS, immutable tenant) and
   hold no secrets.
3. The Sugar adapter implements the generic port against the deterministic
   fake; no Sugar name appears outside the `sugar` module, fixtures and tenant
   configuration (dependency rules).
4. Schema snapshots are metadata-only; drift is detected at publish and run
   start.
5. Mapping versions are immutable, validated, previewable and published only
   with the required base version; the same holds for authority and (hardened)
   product models.
6. Canonical writes go only through `ContextIngestionService` and
   `SubscriptionIngestionService`.
7. Unknown Sugar state is preserved as `unknown` end to end (ownership,
   eligibility, whitespace).
8. Coverage becomes known only from a completed full sync of the
   `subscription_lines` authority that passed the full-read proof; declared
   skips never block, blocking errors never complete; accounts with
   unattributable lines are `ownership_incomplete`; non-holdings are filtered
   only by a confirmed holding filter.
9. Provenance identifies connection, source object/record and mapping version.
   9a. Every one of the 16 discovery fixtures and the companion fixtures has its
   matrix row (§28) implemented as a passing test.
10. `tenant_field_mappings` is retired with its intent preserved for M15.
11. All gates green: verify, runtime (script 70), Docker, fresh clone, CI,
    mutation proofs.
12. Live Sugar verification is either passed and recorded, or explicitly
    recorded as pending.
13. M9 not started.

## 46. Stop conditions

Stop and report if: Sugar needs a material change to the M7 Subscription
shape; authority needs a precedence engine; Sugar logic must enter core;
the mapping needs scripting or the connector becomes generic ETL; a canonical
writer would be bypassed; tenant isolation cannot be preserved; a core safety
mechanism can only be designed from live Sugar behaviour. None is triggered
by this plan.

## 47. Sequence

The suggested order is adjusted: pure mapping logic before persistence (as
M7 did), and the legacy table retired early (it removes `MappedSystem`
before the catalogue refactor touches the same files).

1. **Step 0**: bring the sanitized evidence into the M8 implementation branch
   with a clean merge of `planning/m8-sugar-evidence` (`e2fe7d9`, one commit
   on `e4fec65`, no discovery-repository history) — or a cherry-pick of that
   single commit — and nothing else: no raw data, no discovery history. In the
   same step add `docs/discovery/` and `fixtures/sugarcrm/sanitized/` to
   `.prettierignore` (the evidence fails `prettier --check`; it is kept
   byte-for-byte), and confirm with `git diff --stat` that only those 19 files
   and the ignore entries changed. Then ADRs 0019–0021 (draft).
2. Product model base-version hardening (small, independent).
3. Legacy `tenant_field_mappings` export, intent document, migration 3.
4. Connector-kind catalogue and source connections (migration 1).
5. Pure core in `domain`: generic port types, mapping document schema,
   validator, transform and mapping engine, authority types (unit + property
   tests, mutation proofs).
6. Fake Sugar + Sugar adapter (contract tests against the fake).
7. Schema snapshots, mapping versions, authority (migration 2) and services.
8. Mapping pipeline into the existing writers + preview.
9. Full sync with coverage and tombstone pass; then incremental sync.
10. Provenance/quality columns wired, CLI, metrics, runtime script 70, Docker.
11. Final gates: verify, runtime, Docker, fresh clone, CI, record, PR; live
    gate when credentials exist.

## Risks

| Risk                                                                              | Mitigation                                                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Catalogue refactor touches many M3–M7 files and constraints                       | values unchanged; FK swap in one migration; existing suites and mutation proofs as net                       |
| Sugar keyset ordering or counts behave differently live                           | offset fallback; coverage requires the live gate before real use                                             |
| Product references missing from the model block coverage forever                  | operator report + draft export; explicit ignore list for non-subscription products                           |
| Owner assigns `subscription_lines` to Sugar while state stays unknown             | correct but mostly `unknown` eligibility; documented as expected, not a defect                               |
| Separate canonical companies for Sugar and HubSpot accounts                       | `alsoReferences` if a cross-id field exists; otherwise M11 identity resolution; documented                   |
| Delete visibility unavailable                                                     | full-run tombstone pass; scheduled full syncs                                                                |
| Evidence branch merged with formatting or extra history                           | step 0: single-commit merge or cherry-pick, `.prettierignore`, diff-stat check                               |
| Holding qualification never confirmed by Juniper                                  | Sugar cannot be authoritative for `subscription_lines`; coverage stays unknown (safe); BUSINESS gate tracked |
| Many accounts marked `ownership_incomplete` (3.5% of lines lack a usable product) | expected and safe; the report lists them so data owners can fix the source                                   |
| Sugar offers neither counts nor keyset paging                                     | coverage cannot be certified from Sugar; detected at the live gate before any real use                       |

## Open questions

1. Who is authoritative for `subscription_lines`, `subscription_state` and
   `subscription_terms` for Juniper (owner decision; Sugar evidence supports
   lines only).
2. Does Sugar hold a HubSpot company id (or another shared id) on Accounts for
   `alsoReferences`?
3. Which Sugar date fields mean service start/end, if any (owner confirmation)?
4. Which Sugar products are non-subscription items (for the ignore list)?
5. The current Sugar API version, auth flow and delete visibility (live gate).
6. Should Contacts be ingested for Juniper at all while HubSpot owns people?
7. Full-sync cadence for tombstones and coverage refresh.
8. Which `sales_stage` values denote a holding (holding filter), and does
   `Pending Cancellation` or `Closed Won Credited` count? (BUSINESS, new)
9. Is an inclusive source end date the convention, and which time zone do the
   date-only values use? (BUSINESS, new)
10. Plan-review decision: new reason `ownership_incomplete` with
    `EVALUATOR_VERSION` 2, or reuse `ownership_not_loaded` (new).
11. Does the live API return duplicate ids (export showed 15 duplicate RLI
    ids), and does it expose a count endpoint? (LIVE, new)

## Confirmation

(Planning-stage confirmation, kept for the record.) Planning only (refreshed against the sanitized evidence on
`planning/m8-sugar-evidence` @ `e2fe7d9`). No code, dependency, Prisma schema,
migration or connector was added, and the evidence branch was read, not
merged. **M8 implementation has NOT started.** M9 has not started.

---

## Implementation record (M8)

**Status: M8 IMPLEMENTATION COMPLETE — pending independent review.**
**LIVE SUGAR VERIFICATION: PENDING** (`docs/integrations/sugar/live-verification.md`).
M9 not started. Not merged to `main`.

Branch `claude/blissful-mendel-urbh4r`; ancestry: production `main`
`e0e3fe7`, canonical mapping architecture `e4fec65`, sanitized Sugar evidence
`e2fe7d9` (merged once as `972a8cf`, no discovery-repo history, no raw data),
approved plan `a8b61fb`.

### What was built (by plan section)

| Plan §                     | As built                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 Catalogue                | `domain/connector-kinds.ts` + `connector_kinds` (seeded, forced RLS, SELECT-only for `lip_app`); FKs replace the CHECK lists on 7 source-system columns; values unchanged; HubSpot unaffected                                       |
| 3 Connections              | `tenant_source_connections` (one per kind, forced RLS, tenant trigger, secret-like-key CHECK, credential name FK); `import` at provisioning/backfill, `hubspot` when enabled                                                        |
| 4 Port                     | `SourceConnector` (`capabilities`, `testConnection`, `describeSchema`, `readRecords`, optional `countRecords`/`readRecord`); `SourceAdapterFactory`, `SOURCE_ADAPTERS`                                                              |
| 5 Sugar adapter            | `modules/sugar`: read-only transport guard, OAuth password + refresh (single-flight), SecretProvider JSON bundle, limiter, retries with Retry-After, metadata normalisation, bounded offset reads, count, mid-run drift; mock-first |
| 7–10 Mapping               | immutable `tenant_source_mapping_versions`; document schema (identity/core/relationship/ignored; `attribute` refused); closed transforms; validator codes; holding filter `{field, operator: in                                     | not_in, values, confirmation}` |
| 11–12 Snapshots/drift      | immutable metadata-only snapshots; mapped-surface drift; run refused before writes; mid-run drift fails the run                                                                                                                     |
| 13–14 Concurrency          | `expectedBaseVersion` required (mapping, authority) and `basedOnVersion` required (product model); advisory locks; `concurrent_publish`                                                                                             |
| 15 Authority               | five facts, versioned, one connection or none, composite FKs; holding gate; `cross_source_unsupported`; v1 seeded                                                                                                                   |
| 16–18 State/dates/renewals | explicit unknown; never inferred; invalid period keeps the line (empty terms, unknown); renewals ignored                                                                                                                            |
| 19 Products                | external references only; catalogue phase first; unmodelled fails before lines; product model never changed                                                                                                                         |
| 23 Coverage                | authority-based; full-read proof (start/end count = read); per-account ownership gaps; `ownership_incomplete`, evaluator v2                                                                                                         |
| 24–25 Incremental/deletes  | watermark − configurable overlap; advance on success only; tombstones only in full runs                                                                                                                                             |
| 26–27 Provenance/quality   | `source_connection_id` + `mapping_version` on provenance and runs (FK to the mapping version); quality codes on the run                                                                                                             |
| 32 CLI                     | `sources:*`, `mappings:*`, `authority:*`, `sync:*`, `source:report` (+ `sources:configure`, see deviations)                                                                                                                         |
| 33 Legacy                  | 10 Juniper Leads rows preserved verbatim (M15 input), migration refuses unsafe data, table retired                                                                                                                                  |

### Deviations and additions (reviewed against the plan)

1. `source.sync` on a dedicated queue `lip-sources` instead of `lip-bulk`
   (no module cycle; same platform semantics).
2. `sources:configure` CLI added (operator face of the planned
   `SourceConnections.create`); it registers the credential name.
3. Authority v1 assigns subscription facts to `import` for **every** tenant
   (plan: where an M7 full import completed) so later CSV imports keep
   establishing coverage exactly as in M7.
4. Unmodelled products detected at catalogue level (per the M8 instruction
   "validate the catalogue before line processing").
5. Port gained optional `countRecords()` (full-read proof).
6. Full runs restart (not resume mid-read) after a transient failure.

### Evidence

Commands run from the repository root on the branch head (results in the
scratch logs of the implementing session; counts reproduced here verbatim).

| Gate                                                           | Command                                 | Result                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, typecheck, boundaries, unit, integration         | `pnpm verify`                           | exit 0 — Prettier clean; `no dependency violations found (289 modules, 1219 dependencies cruised)`; unit **47 files, 650 tests passed**; integration **20 files, 309 tests passed**                                                                                                                                                                                                       |
| Runtime (real processes, compose PostgreSQL/Redis, fake Sugar) | `pnpm verify:runtime`                   | exit 0 — `== Summary: 133 passed, 0 failed` (incl. `70-source-connectors.sh`; a first run failed 1 check because the script's read-only pattern included the API version prefix the fake does not log — script fixed, product unchanged)                                                                                                                                                  |
| Docker image                                                   | `pnpm verify:docker`                    | exit 0 — `== Summary: 19 passed, 0 failed` (incl. 3 M8 checks; a first run failed the M6 context-processor check once, cause unproven, tech debt 41)                                                                                                                                                                                                                                      |
| Fresh clone (install, verify, runtime, Docker)                 | clone of the branch at the reviewed SHA | at `4518f63`: HEAD matched; `pnpm install --frozen-lockfile` exit 0; `pnpm verify` exit 0 (unit 47/650, integration 20/309); `pnpm verify:runtime` exit 0 (133 passed, 0 failed); `pnpm verify:docker` exit 0 on the first attempt (19 passed, 0 failed); resources before/after: 0 app processes, 0 containers, 0 volumes, 0 compose networks, 0 images, 0 testcontainers; clone removed |

#### Mutation and failure proofs (32 of 32 failed for the stated reason, all passed after restore)

Each mechanism was broken in place, the guarding test(s) run, then the code
restored and the same tests re-run.

| Mechanism broken                                        | Guarding test under mutation                                                                                          | After restore |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------- |
| Mapping versions immutable (trigger)                    | fails: published mapping versions, snapshots and authority versions are immutable 303ms                               | passes        |
| Required base version (mapping)                         | fails: mapping and authority publication require the base version and refuse a stale one 318ms                        | passes        |
| Required base version (authority)                       | fails: mapping and authority publication require the base version and refuse a stale one 347ms                        | passes        |
| Required base version (product model)                   | fails: publication requires the base version                                                                          | passes        |
| Stale base refused (mapping concurrency)                | fails: mapping and authority publication require the base version and refuse a stale one 294ms                        | passes        |
| Schema snapshot mismatch at publish (stale)             | fails: refuses a document validated against a snapshot that is not the latest 9ms                                     | passes        |
| Schema drift checked at run start                       | fails: schema drift on the mapped surface refuses the run before any write 948ms                                      | passes        |
| Forced RLS on the new M8 tables                         | fails: every table has row-level security enabled and forced 10ms                                                     | passes        |
| Authority enforced at publish (state/terms/profiles)    | fails: a mapped state needs authority, a confirmation and a complete value map into canonical states 15ms             | passes        |
| Authority enforced in the pipeline (terms dropped)      | fails: terms from a connection that is not (or no longer) their authority are dropped 9ms                             | passes        |
| Unknown state preserved (never active by default)       | fails: ingests one line per holding RLI with state unknown (never active from Closed Won) 25ms                        | passes        |
| Product name refused as identity                        | fails: refuses a name as identity, confirmed or not 7ms                                                               | passes        |
| Duplicate external ids counted                          | fails: completes with stable quality counts (codes and counts only) 12ms                                              | passes        |
| Transient failure keeps the run resumable               | fails: a transient failure mid-read leaves the run running                                                            | passes        |
| Watermark overlap applied                               | fails: an incremental run reads from the watermark minus the overlap and advances it only on success 1002ms           | passes        |
| Provenance records the mapping version                  | fails: provenance names the connection, object, record, mapping version, source time and run 28ms                     | passes        |
| Adapter registration guard                              | fails: a kind without a registered adapter cannot be configured or synchronised 193ms                                 | passes        |
| Coverage gate: only completed runs                      | fails: unstable read: a record modified during the read fails the run (unstable_read) 7285ms                          | passes        |
| Incremental runs never tombstone (mode dispatch)        | fails: only the full-run tombstone pass deletes                                                                       | passes        |
| Read-only transport guard                               | fails: lets only GET and the OAuth token POST through 20ms                                                            | passes        |
| Single-writer rule (direct canonical write)             | fails: never writes canonical tables or provenance directly 8ms                                                       | passes        |
| sugar imported by business code (dependency rule)       | fails: x 1 dependency violations (1 errors, 0 warnings). 289 modules, 1220 dependencies cruised.; error business-code | passes        |
| Holding filter applied                                  | fails: completes with stable quality counts (codes and counts only) 13ms                                              | passes        |
| Ownership gap makes the account ownership_incomplete    | fails: establishes coverage                                                                                           | passes        |
| Invalid period keeps the holding (not dropped)          | fails: ingests one line per holding RLI with state unknown (never active from Closed Won) 30ms                        | passes        |
| Count reconciliation (full-read proof)                  | fails: unstable read: a record modified during the read fails the run (unstable_read) 7458ms                          | passes        |
| Orphan vs unmodelled classification                     | fails: 10 orphan product: skipped, and the whole account becomes an ownership gap 8ms                                 | passes        |
| Holding gate on lines authority                         | fails: a connection becomes authoritative for lines only with confirmed holdings 269ms                                | passes        |
| ownership_incomplete distinct from ownership_not_loaded | fails: an account with an ownership gap is unknown with ownership_incomplete (M8), distinct from not loaded 9ms       | passes        |
| Connection config refuses secret-like keys (CHECK)      | fails: refuses connection config with a top-level secret-like key 34ms                                                | passes        |
| Connector kind FK on source-system columns              | fails: refuses an unknown connector kind on every source-system column (foreign key) 26ms                             | passes        |
| connector_kinds read-only for the app role              | fails: the app role can use every table except the migration history and read-only reference data 26ms                | passes        |

Not mutated at M8 level: secret isolation rests on the M2 key derivation
(`tenant.<slug>.<system>.<name>`) and its database CHECK (proved in M2); M8
proves behaviourally that a second tenant using the same credential name gets
its own key and fails closed (`auth_failed`, no grant at the source).

#### Fixture-to-test matrix (as built)

| #             | Fixture                                                           | Where proved                                             | Outcome                                                                   |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| 01            | normal case                                                       | engine spec; sync int; runtime 70                        | 1 line, inclusive end → 2027-01-01, state `unknown`                       |
| 02–05, 08, 16 | several/same products, renewal, expired+active, future, recurring | engine spec; sync int                                    | one line per RLI, no collapse, state `unknown`                            |
| 06            | Pending Cancellation                                              | engine; sync int                                         | `filtered_out` (TEST filter Closed Won)                                   |
| 07            | blank stage / unknown status                                      | engine (in/not_in, mapped-status variant)                | `filtered_out`; variant: `unknown` + `unmapped_source_enum_value`         |
| 09            | orphan opportunity                                                | engine; sync int (C: RLI via FIX-OPP-011)                | `orphan_account_reference`                                                |
| 10            | orphan product                                                    | engine; sync int; runtime 70                             | skipped, gap for FIX-ACC-009 → `ownership_incomplete`                     |
| 11            | duplicate source line                                             | engine; sync int                                         | 1 line, `duplicate_external_id` 1                                         |
| 12            | missing product id                                                | engine; sync int; runtime 70                             | skipped, gap for FIX-ACC-011                                              |
| 13            | conflicting dates                                                 | engine; sync int                                         | line kept, terms empty, `unknown`, `invalid_period`                       |
| 14            | deleted                                                           | engine (flag → absent); adapter spec (hidden by default) | absence / tombstone only in full runs                                     |
| 15            | one-off product                                                   | engine (ignored vs modelled)                             | skip `non_subscription_product` / ingested, empty terms                   |
| C1            | Closed Lost, open pipeline                                        | engine; sync int                                         | `filtered_out`                                                            |
| C2            | unmodelled product                                                | sync int                                                 | run fails `unmodelled_product_reference` before any line; model unchanged |
| C3            | drift (field removed; enum added/removed; type/relationship)      | drift spec; sync int (start and mid-run)                 | `schema_drift`, nothing written                                           |
| C4            | 1,000+ lines, modification mid-read                               | adapter spec; sync int                                   | pagination + count proof; `unstable_read`; retry passes                   |
| C5            | Users                                                             | validator spec; adapter spec                             | `internal_principal`; mapping to person refused (`invalid_entity`)        |

### Security

- Credentials: one SecretProvider secret per connection (credential name
  only in the database; FK to `tenant_credential_refs`; key derived from the
  tenant slug); never logged, never echoed in errors (adapter spec).
- No secrets in configuration: recursive secret-like-key CHECK on connection
  config, snapshot and mapping documents (migrations spec; mutation proven).
- Read-only Sugar transport guard (unit, mutation, runtime fake request log).
- Preview: ≤ 20 records, mapped fields only, hashed references, nothing
  persisted or logged.
- No PII in logs/metrics: metric labels are codes (enforced by
  `MetricsService`); runtime 70 greps CLI output and worker logs for fixture
  names and the fixture password.
- Repository scan: no credentials; the only secret-shaped values are the fake
  Sugar's synthetic fixture credentials in test code.

### Known limitations and technical debt

Technical-debt items 29–40 (`docs/tech-debt.md`); items 22 and 26 resolved.
The live and business gates are recorded in
`docs/integrations/sugar/live-verification.md`.

### Confirmation

M8 implementation only. **M9 has NOT been started.** No live Sugar call was
made; **LIVE SUGAR VERIFICATION: PENDING**. Not merged to `main`.
