# Milestone 8 — Generic source connector and versioned mapping foundation, with SugarCRM as the first reference adapter

- Status: **implementation plan for review**. No M8 code, dependency, schema,
  migration or connector exists.
- Base: `main` at `e0e3fe7` (M0–M7 complete).
- Approved design: [canonical extension and source mapping](../architecture/canonical-extension-and-source-mapping.md)
  (`e4fec65`, passed independent review).
- Sugar evidence: local historical-code discovery (`1f51cde`) and platform
  alignment (`6488cde`), held outside this repository. Verdict: the M7
  canonical contract holds; Sugar is suitable as the first reference adapter;
  Sugar is **not** proven to be the sole subscription-state authority.
- Inputs: ADR [0008](../adr/0008-tenant-isolation.md), [0010](../adr/0010-crm-connector-port-and-oauth.md),
  [0013](../adr/0013-event-processing-on-bullmq.md), [0014](../adr/0014-canonical-identity-references-provenance.md),
  [0016](../adr/0016-product-model-versioning.md)–[0018](../adr/0018-eligibility-and-whitespace.md);
  the [roadmap](../product/roadmap.md); technical debt #22–#28.

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

| Old piece (Python/aiohttp → CSV → S3/Gainsight)                          | Treatment                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Module and field names, relationship fields, which ids are stable        | **Reusable knowledge** → schema expectations, fixtures, ADR evidence                       |
| OAuth2 password/refresh flow against `/oauth2/token`, platform parameter | **Rewrite** in TypeScript behind `SecretProvider`; live-verified                           |
| `date_modified` filter for changed records                               | **Port the idea**, replace rolling 7/14/90-day windows with a checkpointed watermark (§24) |
| Offset pagination (`offset` / `max_num` / `next_offset`)                 | **Rewrite** as keyset by `id` where supported (full-read proof), offset only as fallback   |
| Transformations to CSV columns, S3 upload, Gainsight load                | **Do not reuse** (replaced by mapping + canonical writers)                                 |
| Ad-hoc retries and sleeps                                                | **Do not reuse**; use the platform HTTP retry/backoff and rate limiter pattern (M3)        |
| Hard-coded business rules (e.g. "Closed Won ⇒ active")                   | **Do not reuse**; never inferred (§16)                                                     |

### Sugar-specific concerns

| Concern              | Plan                                                                                                                                                                 | Live gate?    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Authentication       | OAuth2 password grant + refresh with client id/secret, username/password or a service user, all via `SecretProvider`; token cached per process; refresh lock (as M4) | yes           |
| Module reads         | `GET /rest/{v}/{Module}` with `fields=` (mapped only), `filter`, `order_by`, `max_num`; `GET /{Module}/{id}` for read-back                                           | yes           |
| Schema metadata      | `GET /rest/{v}/metadata?type_filter=modules` (fields, types, options, links) normalised into the snapshot                                                            | yes           |
| Pagination           | keyset `order_by=id:asc` with `filter id $gt last` (stable full read); fallback `offset/next_offset`                                                                 | yes           |
| Incremental          | `filter date_modified $gte (watermark − overlap)`, `order_by=date_modified:asc,id:asc`                                                                               | yes           |
| Relationships        | link fields (`account_id`, `opportunity_id`, `product_template_id`, contact `account_id`) as declared relationships; link metadata where present                     | partly        |
| Custom fields        | `_c` fields appear in metadata; mappable like any field; no assumption about any specific one                                                                        | yes           |
| Delete visibility    | unknown for the current API (§25); capability `none` until proven                                                                                                    | **yes**       |
| Retries, rate limits | platform backoff with `Retry-After`; per-connection limiter; 429/5xx retried, 4xx (except 429) permanent                                                             | yes           |
| Schema drift         | pre-flight `describeSchema` diff against the mapping's snapshot (§12)                                                                                                | no (platform) |
| Read-only            | transport guard: only `GET` and the token `POST` are allowed; anything else throws before sending (as the HubSpot guard, mutation-proven)                            | proof live    |

Exact module API names (e.g. the product catalogue module, standardly
`ProductTemplates`; line items `RevenueLineItems`) are taken from the
discovery evidence and confirmed at the live gate; the platform code never
hard-codes them outside the `sugar` module and fixtures.

---

## 6. Sugar evidence the plan relies on (and nothing better)

| Evidence                                      | Consequence in M8                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Account.id strong                             | identity for `account`                                                                                                                       |
| Contact.id strong                             | identity for `person`                                                                                                                        |
| Product catalogue id strong; name unsuitable  | product references by id only; name refused as identity (validator rule, mutation-proven)                                                    |
| RLI.id strong source-line id                  | identity for `subscription` (one canonical line per RLI)                                                                                     |
| RLI→Opportunity 100%, RLI→Account ~99.5%      | `subscription.account` from `account_id`, with an optional declared one-hop fallback via the opportunity's account (§22); conflicts reported |
| RLI→Product ~96.5%                            | lines without a product reference are **skipped with a reason**, never guessed (§23)                                                         |
| RLI state ~99.5% null/mis-populated           | `subscription.state` mapped as **explicit unknown** (§16)                                                                                    |
| Multiple RLI lines per account/product normal | kept as separate lines (M7 supports it)                                                                                                      |
| Renewal semantics ambiguous                   | no deduplication or collapsing (§18); dates only when confirmed (§17)                                                                        |

---

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
snapshot, not from this plan.)

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

| Kind           | Rules                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`     | exactly one per mapped object; the field must be an id/unique field in the snapshot or explicitly confirmed; transforms limited to null handling + trim; name-like fields refused; optional `alsoReferences` (a field holding another connection's id, e.g. a HubSpot company id stored in Sugar) adds a second external reference to the same canonical record, conflicts recorded as identity conflicts (M6), never merged |
| `core`         | target in the entity's catalogue; type-compatible after transforms; enum targets need a complete value map with an unmapped policy; `explicit: unknown` (only for targets with an `unknown` value) or `explicit: null` (optional targets) states "no source" deliberately                                                                                                                                                    |
| `relationship` | target in the catalogue; the field references a mapped object (or the product reference set); optional single-hop `fallbackVia` declared and confirmed; no multi-hop, no joins                                                                                                                                                                                                                                               |
| `ignored`      | explicit, with a reason code; unmapped fields are reported as "not reviewed" (informational)                                                                                                                                                                                                                                                                                                                                 |

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

| Code                                             | Meaning                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `identity_missing`                               | a mapped object has no identity entry                                                                     |
| `identity_unsuitable`                            | identity field not unique/id and not confirmed, or name-like (e.g. product name)                          |
| `invalid_target` / `invalid_entity`              | not in the code catalogue                                                                                 |
| `duplicate_target`                               | two entries write the same target for one object                                                          |
| `unknown_source_object` / `unknown_source_field` | not in the schema snapshot                                                                                |
| `unsupported_source_type`                        | source type cannot reach the target type with the allowed transforms                                      |
| `missing_relationship_target`                    | relationship points at an object not mapped with identity                                                 |
| `product_reference_required`                     | a `subscription` object without `subscription.product`                                                    |
| `required_target_unstated`                       | `subscription.state`, `subscription.account`, `subscription.product` neither mapped nor explicitly stated |
| `invalid_enum_map`                               | value map codes not in the canonical enum                                                                 |
| `unconfirmed_consequential_entry`                | identity, state value map, dates or `fallbackVia` without a recorded confirmation                         |
| `authority_conflict`                             | the entry writes a fact its connection is not authoritative for (§15)                                     |
| `schema_snapshot_stale`                          | the document was validated against a snapshot that is not the latest                                      |
| `attribute_mappings_not_enabled`                 | reserved kind used                                                                                        |

Preview (records read, nothing written) adds data-quality codes with counts:
`unmapped_source_enum_value`, `invalid_date`, `duplicate_external_id`,
`orphan_reference`, `unknown_product_reference`, `relationship_conflict`,
`missing_reference` (skipped lines, §23).

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

| Fact                 | Covers                                                | Why it is separate                                                      |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `account_profile`    | account name, domains (later `customerStatus`)        | HubSpot already writes these; Sugar must not overwrite them by accident |
| `person_profile`     | person email, names, job title, primary company link  | same reason, for people                                                 |
| `subscription_lines` | a line's existence, its account and product, quantity | Sugar evidence supports it; it decides ownership **coverage**           |
| `subscription_state` | `subscription.state`                                  | Sugar evidence does not support it                                      |
| `subscription_terms` | `startsAt`, `endsAt`                                  | Sugar date fields are candidates needing confirmation                   |

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

Date entries are consequential: publish requires a recorded confirmation
(who, note) per date entry; otherwise the mapping states `explicit: null`
and the canonical dates stay empty (an open-ended line). Parsing uses the
declared format and time zone; invalid dates follow the entry policy
(`reject_record` by default) and are counted. Provenance records the mapping
version, so a later corrected mapping is distinguishable.

## 18. Renewals

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
  block coverage.

## 20. Account identity

Sugar `Accounts.id` → external reference `sugar/Accounts/<id>` through the
M6 writer (`ContextIngestionService.ingest`, company observation). No second
mechanism. Without `account_profile` authority, Sugar writes only the
reference (the company row may have a null name, as M6 allows). Cross-system
linking (the same account in HubSpot) happens only through a validated
`alsoReferences` identity field if one exists, or later identity resolution
(M11); never by name or domain.

## 21. Contacts and people

Sugar `Contacts.id` → person external reference through the M6 writer.
Profile fields and the account link only with `person_profile` authority;
otherwise reference only. The `Users` module (internal staff) is classified
`internal_principal` in the snapshot and cannot be mapped to `person` (§7).
For Juniper, Contacts ingestion is **off by default** (object not mapped)
until authority is decided; the capability is built and tested with fixtures.

## 22. Relationships in M8

| Relationship                | Use                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RLI → Account               | `subscription.account` (primary)                                                                                                                                       |
| RLI → Opportunity → Account | optional confirmed `fallbackVia` when RLI `account_id` is empty; Opportunities are read only for this, in one batched call per page; not ingested as canonical records |
| RLI → Product               | `subscription.product` through product references                                                                                                                      |
| Contact → Account           | `person.primaryCompany` (only with `person_profile` authority)                                                                                                         |
| Opportunity → Account       | only as the fallback hop above                                                                                                                                         |

When primary and fallback both exist and differ: primary wins and
`relationship_conflict` is counted. Activities and timelines are out of scope.

---

## 23. Coverage

Coverage stays tenant-level (M7, debt #22) but its source becomes explicit:

> **known** when the latest completed **full** sync of the connection that is
> authoritative for `subscription_lines`, under a published mapping version,
> finished without blocking errors.

Run lifecycle (checkpoint `kind = subscription`, `mode = backfill`,
`source_connection_id`):

```
pre-flight (authority assigned? mapping published? schema drift?) → refuse or start
→ accounts full read (references) → lines full read, page by page (keyset by id)
→ per line: map → skip (declared reasons) | reject (blocking) | ingest via the single writer
→ tombstone pass for lines of this connection not seen in the run (§25)
→ completed (coverage known) | failed (coverage unchanged)
```

- **Skips (do not block coverage)**: `missing_product_reference` (the source
  line has no product), `non_subscription_product` (declared ignored),
  `missing_account_reference` (the source line has no account and no fallback).
  The source itself says there is nothing to attribute; counted and reported.
- **Blocking (run fails, coverage unchanged, lines written so far stay valid)**:
  `unknown_product_reference` (a product id the model does not know and the
  mapping does not ignore), `unresolved_account_reference` (an account id that
  was not ingested), invalid values under `reject_record`, schema drift.
- A source never declares itself complete; completeness = the platform read
  every page to the end under one run (keyset until an empty page) and, when
  the adapter offers `totalCount`, the counts agree. Whether Sugar's keyset
  ordering and counts hold live is a live-gate item; the mock proves the
  mechanism.
- M7's CSV import continues to set coverage for tenants whose authority is the
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
- No rolling 7/14/90-day windows, no CDC.

## 25. Deletion and tombstones

- Delete visibility in the current Sugar API is **unverified** → capability
  `none` until the live gate proves a mechanism (e.g. a deleted-records filter).
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
`unknown_product_reference`, `missing_product_reference`,
`unmapped_source_enum_value`, `invalid_date`, `relationship_conflict`,
`schema_drift`, `coverage_incomplete`. Exposed by `sync:status` and
`source:report`. No profiling or dashboards.

## 28. Synthetic fixtures

The 16 sanitized Sugar scenarios become synthetic fixtures in
`apps/api/test/fixtures/sugar/` (generic names, invented ids, no Juniper rows),
with the discovery summary in `docs/integrations/sugar/discovery.md`. **These
artefacts are not in this repository yet**; importing them is step 0 (§47).
Test matrix (each scenario mapped to at least one case):

| Case                             | Expected                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| normal account + line            | company reference + one line, state `unknown`                                             |
| multiple product lines           | one canonical line per RLI                                                                |
| renewal (two RLIs, same product) | two lines; ownership via "any line"                                                       |
| expired + renewal                | two lines; terms only if dates confirmed                                                  |
| unknown state                    | `unknown` preserved; eligibility `unknown`                                                |
| missing product                  | skipped `missing_product_reference`; coverage not blocked                                 |
| unknown product id               | blocking `unknown_product_reference`; coverage unchanged                                  |
| orphan account                   | skipped or fallback via opportunity; conflict counted                                     |
| duplicate source line            | same RLI id twice → one line (idempotent), `duplicate_external_id` counted if in one page |
| invalid dates                    | `reject_record` (blocking) or `empty` per policy                                          |
| one-time item                    | `non_subscription_product` skip when ignored; ingested when it is a catalogue product     |
| recurring item                   | normal line                                                                               |
| deleted line                     | tombstoned by the full-run pass (and by a delete feed only if proven)                     |

## 29. Mock-first adapter

`test/support/fake-sugar.ts`: a deterministic HTTP fake (like
`fake-hubspot.ts`) implementing the Sugar endpoints the adapter uses (token,
metadata, list with filter/order/keyset and offset, get by id), seeded from
the fixtures, with fault injection (429 with `Retry-After`, 5xx, timeouts,
page interruption, schema change between calls, field disappearing mid-run).
The real adapter runs against it in integration and runtime tests, so the
code under test is the production adapter, not a stub.

## 30. Live Sugar verification gate (separate from completion)

Recorded in `docs/integrations/sugar/live-verification.md`, run only with
Juniper-approved read-only credentials:

current auth flow and token lifetime · API version · granted permissions per
module · metadata endpoint shape · `readRecord` · keyset ordering by id and
`$gt` filters · offset fallback · `totalCount`/count endpoint · rate limits
and `Retry-After` · delete visibility · current schema and custom fields ·
`date_modified` filter and ordering · live counts (accounts, lines, products)
vs. a full run · **read-only proof** (transport guard counters: only GET and
token POST).

M8 may be reported **IMPLEMENTATION COMPLETE** without it; the record then
states **LIVE SUGAR VERIFICATION PENDING**, and no tenant may enable a real
Sugar connection until the gate passes.

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
mapping path writing tables directly) · `sugar` imported by business code.

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
| 2   | `m8_schema_snapshots_mappings_authority` | create snapshots, mapping versions, authority versions (immutable triggers, RLS, composite tenant FKs); seed the default authority version per tenant (§15)                                                                                                                                                                                                                                                                             | refuses if any snapshot, mapping version, or authority version beyond the seeded one exists                                                                                                                            |
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
   `subscription_lines` authority; skips never block, blocking errors never
   complete.
9. Provenance identifies connection, source object/record and mapping version.
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

1. **Step 0**: import the sanitized Sugar discovery summary and the 16
   synthetic scenarios into the repository (`docs/integrations/sugar/`,
   `test/fixtures/sugar/`); ADRs 0019–0021 (draft).
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

| Risk                                                                  | Mitigation                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Catalogue refactor touches many M3–M7 files and constraints           | values unchanged; FK swap in one migration; existing suites and mutation proofs as net     |
| Sugar keyset ordering or counts behave differently live               | offset fallback; coverage requires the live gate before real use                           |
| Product references missing from the model block coverage forever      | operator report + draft export; explicit ignore list for non-subscription products         |
| Owner assigns `subscription_lines` to Sugar while state stays unknown | correct but mostly `unknown` eligibility; documented as expected, not a defect             |
| Separate canonical companies for Sugar and HubSpot accounts           | `alsoReferences` if a cross-id field exists; otherwise M11 identity resolution; documented |
| Delete visibility unavailable                                         | full-run tombstone pass; scheduled full syncs                                              |
| Discovery artefacts not in the repo                                   | step 0 precondition; plan uses only the stated evidence                                    |

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

## Confirmation

Planning only. No code, dependency, Prisma schema, migration or connector was
added. **M8 implementation has NOT started.** M9 has not started.
