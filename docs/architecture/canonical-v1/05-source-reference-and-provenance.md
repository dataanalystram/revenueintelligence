# Canonical Architecture v1 Candidate — E5: Source reference, provenance and history (M9E-E)

Part of the [Canonical Architecture v1 Candidate](CANDIDATE.md). Status: **candidate for review**.

## 1. Source identity vs canonical identity

```
Canonical record (platform UUID, tenant)  ◄──resolves── Source reference ──names──► System object id
```

- A canonical record's identity is its platform UUID. It **never** depends on a vendor id (ADR 0007 §4, ADR 0014):
  `IMPLEMENTED TODAY` for accounts, persons and subscription lines.
- A **source reference** is `(tenant, system = connector kind, connection?, object_type, external_id)` → `(entity
kind, record id)`.
  - One source reference resolves to exactly one canonical record.
  - One canonical record may have many source references, from several systems or a merged duplicate.

### Today (`IMPLEMENTED TODAY`)

- `company_external_refs` and `person_external_refs`:
  - primary key `(tenant_id, system, object_type, external_id)`;
  - states `active` / `deleted` / `merged`, plus `retired` for companies (M9B);
  - first/last seen times, source created/updated times;
  - field hash and last change id.
- Subscription lines carry their source triple inline (unique).
- Product ids resolve through the mapping's product reference set.

### Proposed (`PROPOSED FOR V1 CANDIDATE`)

- **One logical source-reference model for every canonical, module and custom record.**
- The existing tables stay as they are (no migration for its own sake).
- New entities (module entities, custom records, products, contracts, activities, opportunities) use **one generic
  source-reference store** keyed `(tenant_id, system, object_type, external_id)`, with `(entity_kind, record_id)`
  and the same lifecycle columns.
- Subscription lines keep their inline triple: line identity is the source line by design (ADR 0017).
- The connection id is recorded when the tenant has several connections of one kind. Today this is limited to one per
  kind (`@@unique([tenantId, kind])`).

## 2. Source-reference lifecycle

| State     | Meaning                                                                                                           | Set by                                                                                     | Effect on the canonical record                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `active`  | the source currently returns the record                                                                           | any successful observation                                                                 | none                                                                                                                               |
| `retired` | absent from a successful, **proven, operator-accepted full read** of a source that declares `referenceRetirement` | full-run completion (M9B governed correction; `IMPLEMENTED TODAY` for Chargebee customers) | **none** — the canonical record stays as it is; retired references still count for record state (no inferred deletion)             |
| `deleted` | the source explicitly says the record was deleted (webhook, deleted flag, tombstone feed)                         | lifecycle event / explicit deletion signal                                                 | when **every** reference of the record is `deleted`, the record becomes `inactive` (`IMPLEMENTED TODAY`); never physically deleted |
| `merged`  | the source merged the record into another record                                                                  | merge event                                                                                | lineage kept; follows the survivor                                                                                                 |

- **Reactivation:** a later observation, read after the retirement or deletion time, sets the reference to `active`
  again on the **same** canonical record, with no duplicate (M9B R-restore, R12). A read made before that time cannot
  undo it.
- **No inference from absence** outside a proven, accepted full run (M9A/M9B guarantees). Incremental, failed,
  unstable and unaccepted runs never retire.
- **Seen-but-rejected** records and records referenced by other observations in the same run are protected.

## 3. Provenance: one reusable pattern

### Today (`IMPLEMENTED TODAY`)

`tenant_context_changes` records one row per canonical change:

- entity kind (`company` / `person` / `subscription`) and id;
- change type and **changed field names only** (no values);
- source system, object and record; source updated time;
- cause (`webhook` / `backfill` / `reconciliation` / `replay` / `resync` / `import`);
- checkpoint (run) id and correlation id;
- adapter and adapter version;
- source connection id and mapping version.

Eligibility snapshots freeze inputs plus model, evaluator and facts hashes.

### Proposed: the Change Record (one shape for every entity)

The existing table is widened, keeping its name and rows:

| Field                                                | Purpose                                                                                      | Today           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------- |
| `entity_kind`, `entity_id`                           | any canonical, module, custom record or extension value                                      | 3 kinds (CHECK) |
| `change_type`                                        | + `retired`, `reactivated`, `promoted`, `migrated`, `superseded`, `retracted`                | partial         |
| `changed_fields`                                     | field names / extension keys                                                                 | ✔               |
| source system / object / record, `source_updated_at` | where it came from                                                                           | ✔               |
| `cause`                                              | + `migration`, `derivation`, `human`, `ai`                                                   | partial         |
| run (`checkpoint_id`), `correlation_id`              | which sync run / job                                                                         | ✔               |
| `source_connection_id`, `mapping_version`            | which connection and mapping version                                                         | ✔               |
| **`schema_snapshot_hash`**                           | which source schema the mapping was validated against (today derivable via mapping version)  | proposed        |
| **`transforms`**                                     | ordered transform ids applied per changed field (closed set, ADR 0020) — names, never values | proposed        |
| **`origin`**                                         | `source_provided` / `deterministic` / `ai_derived` / `human` / `migration`                   | proposed        |
| **`derivation`**                                     | definition key + version + inputs hash (derived records)                                     | proposed        |
| **`actor`**                                          | human principal or system component (+ version)                                              | proposed        |
| **`canonical_version`**                              | canonical model version the write conformed to (E6)                                          | proposed        |

**Rule:** a field is never duplicated per entity. Every entity uses this one record, written by its single writer.

### Proposed: Evidence link

`(tenant, from_kind, from_id, to_kind, to_id, role, weight?, created_by_derivation)` links a derived record to what
supports it:

- signal → activity, metric observation, subscription, change record;
- opportunity → signals, eligibility snapshot;
- recommendation → signals, opportunity.

Evidence links are immutable. A superseding derivation creates new links. This is what answers "what evidence
supported this signal?".

### Questions the model answers

| Question                                       | Where                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Where did this value come from?                | change record of the latest write of the field (source system / object / record) |
| Which sync run / mapping / schema / transform? | `checkpoint_id`, `mapping_version`, `schema_snapshot_hash`, `transforms`         |
| Source-provided or derived?                    | `origin`                                                                         |
| Which algorithm / rule / version?              | `derivation` (key + version + inputs hash)                                       |
| What evidence supported the signal?            | evidence links                                                                   |
| Who decided?                                   | recommendation events (`actor`) and change records (`actor`)                     |

## 4. History: current state vs historical sequence

Each entity declares a **history policy** in its definition:

| Policy                       | Meaning                                                                                                                                 | Applies to (v1)                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `immutable`                  | records are never updated; changes are new records that supersede                                                                       | Signal, MetricObservation, Evidence link, Recommendation event, ActionOutcome, Change record, all versioned registries/documents, eligibility snapshots                                                                                                   |
| `projection + value history` | current row is a projection; selected fields keep an append-only value history (old value, new value, effective time, change record id) | Subscription (`state`, terms, product, quantity), Opportunity (`status`, `stage_code`, amount, close date), AccountContext (`owner_ref`, status), Goal (status, target), Account (`parent_account_id`, `customer_status`, name), Contract (status, dates) |
| `projection + change log`    | current row + change records naming fields (no values)                                                                                  | everything else (`IMPLEMENTED TODAY` for accounts/persons/lines)                                                                                                                                                                                          |

- Value history stores values. It is therefore tenant-scoped, forced-RLS and governed by retention (tech debt #17)
  and sensitivity: a `personal` or `restricted` field's history follows the field's policy.
- **Bitemporal modelling** (valid time vs transaction time across all entities) is `DEFERRED`. v1 records the
  effective time from the source (`source_updated_at`) and the transaction time (`ingested_at`). That covers the
  brief's examples (subscription changed product, reference retired, context owner changed, signal severity changed
  by supersession, goal metric changed, opportunity stage changed).

## 5. Preserved guarantees (must survive every later change)

- one identity mechanism (references);
- one provenance table pattern;
- one writer per entity;
- reference lifecycle separate from record lifecycle;
- no inferred deletion from absence;
- retirement only on accepted proven full runs;
- seen-but-rejected protection;
- reactivation without duplication;
- tenant isolation of every reference, change record, evidence link and history row.
