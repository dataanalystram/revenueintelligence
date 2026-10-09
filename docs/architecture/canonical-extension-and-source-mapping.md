# Canonical extension and source mapping (pre-M8 design gate)

- Status: **design for review** (documentation only). No code, schema,
  migration or connector exists for anything described here.
- Date: 2026-10-02. Base: `main` at `e0e3fe7` (M0–M7 complete; M8 not
  started).
- Scope: how the platform stays strongly canonical while tenants add governed
  business context and map their own source schemas, before Subscription
  Source Discovery is turned into an M8 connector design.
- Inputs: [architecture](../architecture.md), ADR
  [0007](../adr/0007-canonical-domain-model.md) (canonical domain),
  [0008](../adr/0008-tenant-isolation.md) (tenant isolation),
  [0012](../adr/0012-revenue-opportunity-intelligence-direction.md) (declarative
  per-tenant rules, no rules engine),
  [0014](../adr/0014-canonical-identity-references-provenance.md) (identity,
  references, provenance), [0016](../adr/0016-product-model-versioning.md)–[0018](../adr/0018-eligibility-and-whitespace.md)
  (product model, subscriptions, eligibility), the
  [roadmap](../product/roadmap.md) (Subscription Source Discovery gate, M8,
  M15) and technical debt #15, #17, #23, #26.

## Summary of the recommendation

```
Stable canonical core (code)          Account, Person, Product, Subscription, Signal, Opportunity, Outcome
        +                             and their first-class fields; changes need code, migration, ADR
Governed tenant attribute registry    a versioned, immutable per-tenant document of AttributeDefinitions
(data, versioned)                     (closed type set, closed usage flags, keys are identities)
        +                             values in one typed table, constrained by the registry
Versioned source mapping              per source connection: immutable mapping versions that map
(data, versioned)                     source objects/fields to canonical identity, core fields,
                                      registered attributes or relationships, via a closed set of transforms
        +                             published with a mandatory base version (optimistic concurrency)
Source authority (data, minimal)      one authoritative source per business fact; precedence deferred
```

It reuses the patterns M7 proved (immutable versions with a content hash,
keys as identities, validation before publish, frozen evidence) and adds no
expression language, scripting, generic EAV or ETL.

---

## 1. Canonical core vs tenant extension attributes

### What is first-class canonical (code, schema, ADR)

| Entity                       | First-class fields (today or planned)                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Account                      | platform id, name, domains, `customerStatus`, record state / merge lineage, external references                                 |
| Person                       | platform id, emails, names, job title, primary company, roles, external references                                              |
| Product                      | key, name, description, family, status, availability window, external references (ADR 0016)                                     |
| Subscription                 | id, account, product key, `state`, `startsAt`, `endsAt`, `quantity`, source reference, tombstone and ordering fields (ADR 0017) |
| Signal, Opportunity, Outcome | data model built in M10 (canonical v1 candidate), engines in M11–M14 (ADR 0012); same rule                                      |
| Everywhere                   | provenance, source references, tenant id, timestamps                                                                            |

### What is a tenant extension attribute

Business context that a tenant legitimately has but the platform's own logic
does not depend on: for example a region, a school type, an organisation size
band, a contract tier, an industry. These are **examples, not requirements**;
none is assumed for any tenant.

### Decision criteria

A concept becomes (or stays) **first-class canonical** when **any** holds:

1. Platform code (not only tenant configuration) must interpret it: identity,
   ownership, eligibility built-ins, SLA, routing, suppression, attribution.
2. It defines an entity's identity, lifecycle or relationships.
3. It is needed by most tenants with the **same meaning** (cross-tenant
   semantic stability), not merely the same label.
4. A wrong value would cause a consequential action (a write, a routing
   decision, an ownership claim) without a human in between.

A concept is a **tenant extension attribute** when **all** hold:

1. Only tenant-configured logic reads it (a registered eligibility condition,
   a segment, a display, a future signal definition).
2. Its meaning or value set is tenant-specific (one tenant's "contract tier"
   is not another's).
3. It is a scalar fact about one canonical entity (no relationships, no
   lists of records, no nested objects).
4. Missing it is safe: logic that reads it treats absence as `unknown`.

Anything that fails both tests (a relationship, a list, a time series, an
event) is neither: it is a canonical entity of a later milestone (Signal,
Opportunity) or out of scope.

---

## 2. Attribute registry

### Shape

The registry is **one versioned document per tenant**, exactly like the M7
product model: immutable published versions, a SHA-256 content hash,
`effectiveFrom`, publisher, validation before publish, and keys that are
identities. A correction is a new version.

Minimal `AttributeDefinition`:

| Field              | Decision                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`              | **Kept.** `^[a-z][a-z0-9_]{0,62}$`. The identity. Never reused, never removed (K1–K4 analogues below)                                                                               |
| `entity`           | **Kept.** `account` only at first. `person` added when a real requirement appears. Never Subscription or Product (they have their own models)                                       |
| `displayName`      | **Kept.** Renames declared (`renamedFrom`), as for products                                                                                                                         |
| `description`      | **Kept.** The approved business meaning (see §12). Required, not optional                                                                                                           |
| `dataType`         | **Kept.** Closed set: `string`, `number`, `boolean`, `date`, `datetime`, `enum`. No arrays, objects, money or units (a currency is a separate attribute or a later canonical field) |
| `allowedValues`    | **Kept, enum only.** `{code, label, status: active\|retired}`. Codes are identities: never removed, only retired                                                                    |
| `constraints`      | **Kept, minimal.** `string`: max length; `number`: integer flag, min, max. Nothing else                                                                                             |
| `sensitivity`      | **Kept.** `internal` \| `confidential` \| `personal`. `personal` cannot be marked usable for eligibility or segmentation without a later privacy ADR                                |
| `allowedUses`      | **Kept, replacing the two booleans.** Closed set: `display`, `segmentation`, `eligibility`, `signal_input`, `analytics`. Every consumer checks its own use                          |
| `notEvidenceOf`    | **Added.** Closed set of canonical facts this attribute must never be used to infer (e.g. `subscription_ownership`, `account_identity`)                                             |
| `status`           | **Kept as `active` \| `retired`.** Retired: no new values written, existing values readable, references in published models stay valid                                              |
| `owner`            | **Kept as optional free text** (who on the tenant side answers questions about it). Governance only; never read by logic                                                            |
| `nullable`         | **Dropped.** Every attribute is optional; absence is `unknown` (§3). A "required" attribute is a mapping data-quality rule (§16), not a type property                               |
| `source_authority` | **Moved out** to source authority (§11). Meaning and authority are different questions                                                                                              |
| `version`          | **Moved to the document.** Definitions are versioned together, as product models are                                                                                                |
| `usable_for_*`     | **Replaced** by `allowedUses`                                                                                                                                                       |

### Cross-version rules (as K1–K4 for products)

- **A1** a key never disappears (retire it);
- **A2** a retired attribute's `entity` and `dataType` are frozen; reactivation is declared;
- **A3** `dataType` never changes for a key (a new type means a new key, plus
  a promotion-style migration if values must move);
- **A4** enum codes never disappear (retire them); a label change is free;
  a code change is a new code plus a retirement.

### Limits

At most 200 attributes per tenant, 500 enum values per attribute. These are
deliberate: a tenant needing more is building a data warehouse.

---

## 3. Attribute values: persistence

### Options compared

| Concern          | A. Untyped EAV rows | B. Validated JSONB on the entity                    | C. Typed value rows governed by the registry (recommended)                                 |
| ---------------- | ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Type safety      | none (text)         | application-only; DB sees `jsonb`                   | typed columns + CHECK "exactly one column for the definition's type"; FK to the definition |
| Indexes          | poor                | expression index per key (DDL per tenant attribute) | one composite index per typed column; no per-attribute DDL                                 |
| RLS              | easy                | inherited from the entity                           | easy: tenant-owned table, forced RLS, tenant keys                                          |
| Queryability     | joins on strings    | good per entity, poor across entities               | good for "accounts where X" and for batch loading (M12)                                    |
| Eligibility      | parse at read       | one read per entity                                 | one read per account (or per page of accounts): `WHERE company_id = ANY(...)`              |
| Schema evolution | free (too free)     | free; old keys linger silently                      | governed by registry versions; FK prevents orphans                                         |
| Auditability     | weak                | whole-blob updates hide which key changed           | per-value provenance rows (M6 `tenant_context_changes`), per-value source ref              |
| Performance      | poor at scale       | good reads, write amplification on large blobs      | good; rows are small, writes are per value                                                 |
| Null semantics   | ambiguous           | missing key vs JSON null easily confused            | **no row = unknown**; a row with `value_state = empty` = the source says empty             |
| History          | none                | none (unless a history table)                       | provenance per change; snapshots freeze values                                             |
| Migration cost   | low                 | low now, high when promoting (§4)                   | moderate now; promotion is a mechanical copy                                               |

### Recommendation: Option C

One table, `tenant_attribute_values`, for the current value of each
(account, attribute):

- keys: `(tenant_id, entity, entity_id, attribute_key)` unique;
- `value_text`, `value_number` (numeric), `value_bool`, `value_date`,
  `value_ts`, `value_enum` (the code); a CHECK ensures exactly the column
  matching the definition's type is set, or none when `value_state = empty`;
- `value_state`: `present` \| `empty`;
- source reference (system, object, record, field), `source_updated_at`,
  `observed_at`, field hash, `last_change_id` — the same ordering and
  idempotency fields as M6 references and M7 subscriptions;
- `registry_version` that validated the value;
- forced RLS, tenant-scoped keys and FKs (schema guard applies).

A value is written **only** by the single context writer path of its entity
(M6 for accounts), with `decideApply` ordering and a provenance row
(`entity_kind = account_attribute`, changed field = the attribute key, no
values). Account merge moves values through the merge-participant port, as
subscriptions do, with conflict rules (§22).

This is "EAV" only in shape. It is **not** an unrestricted metadata bag:
every row's key must exist in the tenant's registry, its type is enforced by
the database, and every consumer must check `allowedUses`.

---

## 4. Promotion to a canonical field

Example: `region` starts as an attribute in several tenants and later becomes
platform-wide.

1. **Decide and specify** (ADR): the canonical field, its type, its canonical
   value set, and per tenant the attribute it absorbs (`promotedFrom`), with a
   value translation where enum codes differ (declared per tenant, reviewed).
2. **Add the field** (migration) and backfill it from the attribute values in
   the same migration, writing one provenance row per account
   (`change_type = promoted`, cause `migration`). The migration counts rows
   before and after and refuses to lose any (as the M7 legacy migration did).
3. **Mark the definition** `status = promoted` in a new registry version
   (`promotedTo: "account.region"`). A promoted attribute is read-only: no new
   values, and its key resolves to the canonical field.
4. **Mappings keep working**: the mapping compiler resolves a target
   `attribute:region` to `core:account.region` when the attribute is
   promoted. No tenant reconfiguration; the next mapping version may rewrite
   the target explicitly, and validation warns until it does.
5. **Eligibility keeps working**: product models referencing the attribute
   key resolve it to the canonical field (the canonical attribute list in
   code gains the field; evaluator version bump). Existing snapshots replay
   from their frozen inputs, which already hold the value, so they are
   unaffected.
6. **No double storage**: after the backfill, attribute rows for a promoted
   key stop receiving writes. They remain as history for a defined window
   (retention policy, tech debt #15/#17), then are tombstoned; they are never
   read by logic again.

---

## 5. Source schema discovery: connector capabilities

### Generic contract (vendor-neutral port, `domain`)

| Capability                                                                        | Generic?                     | Notes                                                                                                              |
| --------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `testConnection()`                                                                | yes                          | account identity, granted scopes/permissions, API version; no record data                                          |
| `describeSchema()`                                                                | yes                          | objects, fields, relationships in one call (or paged); returns metadata only (§6)                                  |
| `readRecords(object, page, {fields, since?})`                                     | yes                          | paged, cursor-based, field-limited to **mapped fields only**; `since` only when the capability says so             |
| `readRecord(object, id)`                                                          | yes                          | read-back for event-driven sources (as M6 does)                                                                    |
| `capabilities()`                                                                  | yes                          | declares: incremental reads, delete visibility, change timestamps, events/webhooks, max page size, rate limits     |
| `previewRecords()`                                                                | **restricted**               | only for mapping preview (§9): a few records, mapped fields only, masked by sensitivity, never persisted or logged |
| `discoverObjects` / `describeObject` / `describeFields` / `discoverRelationships` | folded into `describeSchema` | one schema snapshot keeps them consistent                                                                          |
| `reportCoverage()`                                                                | **no**                       | coverage is the platform's judgement (a completed full read under a published mapping, M7 §5), not the source's    |

### Source-specific (adapter)

Authentication and token handling, vendor payload schemas (Zod at the
boundary), pagination and query languages, rate limiting, vendor type → generic
type mapping, relationship encoding (lookups, junction objects, association
APIs), vendor quirks, and any transformation that needs vendor knowledge
(e.g. joining a junction object to produce a subscription line). The existing
`CrmReader` (M3–M6) stays as the CRM specialization used by context
processing; the new generic contract sits alongside it and HubSpot can
implement both.

### Source connections

`ExternalSystem` is a **closed enum** today (`hubspot`, `sugar`,
`gainsight_cs`, `gainsight_px`). It becomes the **connector kind catalogue**:
one value per adapter module in code (a new kind ships with its adapter, which
is legitimate per-source code). A tenant configures **source connections**
`(tenant, connection id, kind, label, status)`; mappings, authority and schema
snapshots hang off the connection. One connection per kind per tenant at
first; several (e.g. two Salesforce orgs) is deferred.

---

## 6. Source field metadata (schema snapshot)

Captured per connection as an immutable, hashed **schema snapshot** (what
`describeSchema()` returned, normalised):

| Captured when available                                                                            | Why                                        |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| object/table API name and label                                                                    | mapping targets and UI                     |
| field API name, label, description                                                                 | mapping and business context               |
| source type and generic type (string, number, boolean, date, datetime, enum, reference, id, other) | type compatibility checks                  |
| nullable / required (as the source declares)                                                       | data-quality rules                         |
| picklist/enum values (value, label, active)                                                        | value maps; unknown-value detection        |
| relationships (field → target object, cardinality)                                                 | relationship mappings, identity validation |
| uniqueness / external-id / primary-key indicators                                                  | identity safeguards (§15)                  |
| read-only/computed flags                                                                           | informational                              |
| change-timestamp and delete-visibility capability per object                                       | incremental reads, tombstones, coverage    |
| stable source identifiers (field ids where the source has them)                                    | detecting renames versus new fields        |
| source schema/API version                                                                          | drift detection                            |

**Not captured**: record values, row counts per value, distributions,
samples, default values that may contain data, formulas' contents beyond a
flag. Data profiling is out of scope; preview (§9) is ephemeral.

A mapping version records the schema snapshot hash it was validated against;
a new snapshot that changes a mapped field (removed, type changed, picklist
value removed) is reported as **drift** and blocks the next publish until the
mapping is revalidated.

---

## 7. Mapping definition

A **mapping version** is one immutable document per source connection.

### Object mappings

`sourceObject → canonicalEntity`, where `canonicalEntity` comes from a code
list: `account`, `person`, `subscription`, `product_reference` (later
`signal_source`, …). One source object may feed one canonical entity; a
canonical entity may be fed by several source objects only through adapter
logic (e.g. a junction), never by mapping composition.

### Field mapping entry kinds

| Kind           | Target                                                                                                                                        | Validation                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`     | the canonical entity's external reference (`system/objectType/id`)                                                                            | §15 safeguards; exactly one per mapped object                                                                                                  |
| `core`         | a canonical target from the **code catalogue** for that entity (e.g. `subscription.state`, `subscription.startsAt`, `account.customerStatus`) | target exists; type compatible after transforms; enum targets need a complete value map                                                        |
| `attribute`    | a registered `AttributeDefinition` key for that entity                                                                                        | key exists and is active in the registry version in force; type compatible; enum value map to registry codes                                   |
| `relationship` | a canonical relationship from the code catalogue (e.g. `subscription.account`, `subscription.product`, `person.primaryCompany`)               | source field is a reference (or declared lookup) to an object mapped with an `identity` entry, or to product external refs                     |
| `ignored`      | none                                                                                                                                          | explicit, with a reason code (`not_needed`, `sensitive`, `duplicate_of`, `unknown_meaning`); unmapped ≠ ignored: unmapped means "not reviewed" |

Targets are **typed references into catalogues**, never free string paths:
`{kind: "core", target: "subscription.state"}` is validated against a code
enum; `{kind: "attribute", key: "region"}` against the registry. A source
field is referenced as `{object, field, fieldId?}` and validated against the
schema snapshot.

### Relationship to what exists

- `tenant_field_mappings` (M2, mutable rows, all `tbc`) is **superseded** by
  mapping versions. M8 migrates its rows (status `tbc` → no entry; `proposed`
  → a draft; `confirmed` → none exist) and drops the table, with the same
  count-checked approach as the M7 legacy migration. Its outbound direction
  belongs to the write milestone (M16) and is not carried over now.
- `tenant_lead_source_mappings` (M2) stays: it is lead-channel classification,
  a different concern. It may later become a value map, but not now.
- Product `externalRefs` (M7) remain the product identity mapping;
  `product_reference` mapping entries resolve through them.

---

## 8. Mapping transformations (closed set)

Applied in a fixed order per entry, each optional, each declarative:

1. **null handling**: treat `""`, whitespace, or a declared list of sentinel
   strings (≤ 10) as empty;
2. **normalise**: trim, collapse whitespace, case fold (`lower`/`upper`);
3. **parse**: `date` / `datetime` with a declared format from a closed list
   (ISO 8601, `YYYY-MM-DD`, epoch seconds/millis) and a **declared time zone**
   for zone-less values (never guessed); `number` with a declared decimal
   separator; `boolean` with declared true/false value sets;
4. **value map**: source code → canonical code (core enum or registry enum),
   with an explicit policy for unmapped values: `unknown` (core targets that
   have `unknown`), `reject_record`, or `empty`.

Nothing else: no expressions, concatenation, arithmetic, conditionals,
lookups, regex capture or JavaScript. A need beyond this belongs in the
adapter (code, tests, review), not in tenant configuration.

---

## 9. Mapping versioning

```
draft (file now; stored draft in M10A2)
  → validate  (structure, catalogues, registry, schema snapshot, authority, identity safeguards)
  → preview   (dry run: counts, data-quality report, a few masked sample transformations; nothing written)
  → publish   (atomic, with expectedBaseVersion; immutable version)
  → in force  (selected by effectiveFrom, as product models)
```

A published mapping version stores: tenant, source connection, version,
`baseVersion`, content hash, schema snapshot hash, registry version it was
validated against, `effectiveFrom`, published by/at, and the validation
report summary (codes and counts only). A database trigger refuses UPDATE and
DELETE, as for product models. Every ingested value and provenance row
records the mapping version that produced it.

---

## 10. Optimistic concurrency (mandatory)

Applying technical debt #26: publishing a mapping version (and an attribute
registry version) **requires** `expectedBaseVersion` — the version the draft
was prepared against (`0` for the first). The service refuses a publish
without it, and returns `concurrent_publish` when another version was
published meanwhile. Publication is also serialised per (tenant, connection)
by an advisory lock, as in M7. The CLI passes it explicitly (`--based-on` is
**required** for these documents, not optional as it is for M7 product
models). M8 should also make it required for product models so all three
behave the same; that is a one-line behaviour change and a test, not a
redesign.

---

## 11. Source authority

Mapping says how a field translates; **authority** says whose value counts.

### Level: the business fact

A closed code catalogue of facts the platform consumes, e.g.:

- `subscription_ownership` (lines, states, terms);
- `account_customer_status`;
- `account_attribute:<key>` (one per registered attribute);
- later: `financial_validation`, `product_usage`, `marketing_engagement`
  (inputs to signals, M11).

Per tenant, a versioned **authority declaration** (part of the same document
family, mandatory base version) assigns each consumed fact exactly **one
authoritative source connection**, plus optional `corroborating` connections
that are recorded but never write the fact.

Rules now:

- A mapping version may write a fact only from its fact's authoritative
  connection; validation refuses otherwise.
- Ownership coverage (M7 §5) becomes "a completed full read of the
  authoritative connection for `subscription_ownership`", a natural extension
  of the tenant-level rule.
- No precedence, merging, freshness voting or per-record arbitration. If
  discovery shows split authority (e.g. one system for contract state, another
  for financial validation), each half is a **different fact**. Field-level
  precedence between two sources for the **same** fact is deferred until
  evidence requires it.

This expresses "Sugar is authoritative for contract state, NetSuite validates
finance, Gainsight supplies usage, HubSpot supplies engagement" without naming
any of them in code.

---

## 12. Business context

Meaning lives in three places, each for its own question:

| Question                                                                  | Where                                                                                                                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| What does this **canonical attribute** mean, and what may it be used for? | `AttributeDefinition`: `description`, `allowedUses`, `notEvidenceOf`, `sensitivity`, `owner`                                                    |
| What does this **source field** mean in this tenant's system?             | a **field annotation** in the mapping version: `{object, field, description, role, notEvidenceOf}`, allowed on any field including ignored ones |
| Which source counts for this fact?                                        | authority declaration (§11)                                                                                                                     |

`role` is a closed set: `identity`, `ownership`, `commercial_context`,
`segmentation`, `engagement`, `usage`, `informational`. The example
`first_year_revenue_c` becomes an annotation with role `commercial_context`,
`notEvidenceOf: [subscription_ownership]`, and, if the tenant wants it in the
platform, a registered `number` attribute with `allowedUses: [analytics]`.
Annotations are versioned with the mapping (they change with the source), so
agents, rules and operators read the approved meaning of the version in
force, not free text from logs.

---

## 13. Eligibility integration

M7 keeps its closed canonical attribute (`customer_status`). A later
milestone (not M8) adds one condition type:

```json
{
  "id": "tier-gold-only",
  "type": "registered_attribute",
  "attribute": "contract_tier",
  "op": "in",
  "values": ["gold", "platinum"],
  "appliesTo": { "products": ["premium"] }
}
```

- **Publish-time checks** (product model validation, against the registry
  version in force at the model's `effectiveFrom`): the key exists, is
  `active`, has `allowedUses ⊇ {eligibility}`, entity `account`, sensitivity
  not `personal`; the operator fits the type (`enum`: `in`/`not_in` with codes
  from `allowedValues`; `number`: `lt`/`lte`/`gt`/`gte`/`between`;
  `boolean`: `is`; `date`/`datetime`: `before`/`on_or_after` an absolute
  instant). No paths, no expressions.
- **Evaluation**: the account facts gain `attributes: { key: typed value |
empty }` loaded in the same repeatable-read transaction (one query; batched
  for M12). No row → `unknown` (`attribute_missing`); `empty` → `unknown`
  too unless the condition says otherwise later. Precedence stays
  fail > unknown > eligible.
- **Retirement**: a registry version cannot retire an attribute (or an enum
  code) referenced by a product model version that is in force or scheduled;
  validation names the model and rule. Retiring after the model moves on is
  allowed; old model versions stay replayable.
- **Changed enum values**: codes never disappear (A4), so a rule cannot point
  at a vanished code; a rule referencing a retired code gets a warning.
- **Snapshots**: the frozen input includes the attribute values used and the
  registry version and hash; replay never re-reads the registry or values.
- **Compatibility**: `EVALUATOR_VERSION` increments; old snapshots keep their
  evaluator version and replay reports `evaluator_changed` honestly (M7
  behaviour).

---

## 14. Facts, signals, opportunities

An attribute is a **fact about an account**. It is never a signal by being
mapped. A signal (M11) is a **derived, time-stamped observation** produced by a
signal definition from facts and events (e.g. "contract tier changed to gold
this week"). Opportunities (M12) combine eligibility, signals and suppression.
The registry's `allowedUses: signal_input` is the only bridge: a signal
definition may read an attribute only if that use is allowed.

```
FACT (canonical field or registered attribute)
  → DERIVED SIGNAL (M11 definition, versioned)
    → OPPORTUNITY (M12, cites eligibility snapshot + signals)
```

---

## 15. Identity safeguards

Identity mapping produces **external references** (M6), never attribute
values. Safeguards at validation and preview:

1. The source field must be declared unique/ID/external-ID by the schema
   snapshot, **or** the publisher confirms it explicitly (recorded, with the
   reason) and preview shows zero duplicates and zero empties among the
   records read.
2. Allowed transforms: null handling and trim only. No case folding, value
   maps or parsing (identity must be preserved exactly).
3. Descriptive fields (name, domain, email, phone) are refused as identity
   for accounts; cross-system matching on them belongs to identity resolution
   (M12), which records conflicts and never auto-merges across systems (M6
   rule).
4. Changing the identity field of an object in a new mapping version requires
   an explicit `identityChange` acknowledgement, a preview of how many
   references would be re-keyed, and is refused while that object's data is
   referenced by subscriptions or snapshots unless a migration plan is
   declared (deferred; refuse by default).
5. Internal customer numbers are just another identity field of their source;
   they become references, not merge keys.

---

## 16. Data quality (only what ingestion needs)

Validation and preview report stable codes with counts (never values):

- `unmapped_required_target` (a canonical target the entity needs, e.g.
  subscription state or account relationship);
- `unknown_enum_value` (source values outside the value map), with the policy
  applied;
- `duplicate_identity`, `empty_identity`;
- `unresolved_relationship` (orphan: the referenced record is unknown);
- `missing_product_mapping` (no product external ref matches);
- `invalid_value` (unparseable date, number, boolean), `ambiguous_timezone`;
- `schema_drift` (mapped field removed or changed);
- `authority_conflict` (mapping writes a fact its connection is not
  authoritative for);
- `coverage_incomplete` (no completed full read under this mapping version).

Runs record these counts on their checkpoint. There are no dashboards,
anomaly detection or profiling.

---

## 17. Future self-service UI readiness

Backend contracts (services, not HTTP yet) the M15 workspace can call
directly, each returning structured results:

| UI step                         | Contract                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- |
| connect, test                   | `SourceConnections.create/test` → identity, permissions, capabilities     |
| discover, review objects/fields | `SchemaSnapshots.capture/get/diff`                                        |
| describe business meaning       | draft mapping: field annotations                                          |
| map identity, core fields       | draft mapping entries; catalogue lookups (`MappingTargets.list(entity)`)  |
| create extension attributes     | draft registry; `AttributeRegistry.validate/publish(expectedBaseVersion)` |
| map values/enums                | value maps with unknown-value report                                      |
| define authority                | `Authority.validate/publish(expectedBaseVersion)`                         |
| validate, preview impact        | `Mappings.validate/preview` → codes, counts, masked samples, drift        |
| publish                         | `Mappings.publish(expectedBaseVersion)` → version, hash                   |
| observe coverage/errors         | run checkpoints, data-quality counts, coverage per fact                   |

Every result is a typed structure with codes and paths; nothing needs to be
reconstructed from logs. Stored drafts are M10A2; per-user editing is M15.

---

## 18. Mapping suggestions (later, not this gate)

Suggestions may use field names, labels, descriptions, types, relationships,
annotations and the tenant's previously approved mappings. They are drafts:
the same validation applies, and **identity entries, product mappings,
subscription state value maps and authority declarations** always need an
explicit human confirmation recorded on the published version
(`confirmedBy`, per entry). No AI is implemented in this gate, and a
suggestion is never applied automatically.

---

## 19. Security and privacy

- **Tenant isolation**: every new table (registry versions, attribute values,
  connections, schema snapshots, mapping versions, authority versions) is
  tenant-owned with forced RLS, tenant-scoped keys and FKs; the schema guard
  test enforces it; the app role stays non-privileged.
- **No record values in metadata**: schema snapshots hold metadata only;
  picklist values are allowed (they are vocabulary, not records) but default
  values and formula bodies are not stored.
- **Preview** is ephemeral, limited (≤ 20 records), mapped fields only, masked
  for `confidential`/`personal` attributes and identity fields (show shape,
  not value), never persisted and never logged.
- **Secrets**: connection credentials only through `SecretProvider`; never in
  schema snapshots, mapping documents, annotations or logs.
- **Sensitivity**: `personal` attributes are not usable for eligibility,
  segmentation or signals until a privacy ADR (tech debt #15) defines lawful
  use and erasure; their values are excluded from snapshots' human-readable
  output.
- **Permissions** (enforced when M15 adds user identity; CLI operator until
  then): view mappings; edit drafts; publish (separate permission). A
  publisher cannot approve their own identity/authority confirmations once
  roles exist (four-eyes for consequential entries; deferred to M15).
- **Audit**: immutable versions with publisher, hash and base version;
  per-value provenance; no deletion paths (retention via the privacy and
  data-retention work, tech debt #15, #17, #23).

---

## 20. Portability test

| Concern              | Customer A (Juniper)                                                               | Customer B                                                 | Same platform code?                         |
| -------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| Canonical core       | Account, Person, Product, Subscription, …                                          | same                                                       | yes                                         |
| Attribute registry   | `school_type` (enum), `contract_tier` (enum)                                       | `region` (enum), `industry` (enum), `customer_tier` (enum) | yes (data only)                             |
| Mapping model        | versions per connection: Sugar, Chargebee, NetSuite, HubSpot, Gainsight, warehouse | Salesforce, Snowflake, Intercom, Pendo                     | yes (data only)                             |
| Connector interfaces | generic port + CRM specialization                                                  | same                                                       | yes                                         |
| Adapters             | Sugar, Chargebee, NetSuite, HubSpot (exists), Gainsight, warehouse                 | Salesforce, Snowflake, Intercom, Pendo                     | **no — adapters are per source (expected)** |
| Connector kinds      | catalogue values for its sources                                                   | catalogue values for its sources                           | catalogue grows with adapters               |
| Authority            | e.g. contract state from the system discovery picks                                | e.g. ownership from Salesforce or Snowflake                | yes (data only)                             |
| Eligibility          | product model + optional `registered_attribute` conditions                         | same                                                       | yes                                         |

No core code is forked per customer. What varies: adapters (code per
vendor, shared by every tenant using that vendor), connector kind values,
and tenant configuration (registry, mappings, authority, product model).
Today's closed `ExternalSystem` enum and the M2 `MappedSystem` enum must
become the connector-kind catalogue for this to hold (§5); without that
change Customer B could not be onboarded, so it is a required M8 change.

---

## 21. Over-engineering check

| Risk             | Why we are not building it                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| MDM platform     | No golden-record survivorship across sources: one authoritative source per fact; identity resolution stays M12 with conflicts, not auto-merge |
| iPaaS            | No arbitrary flows, triggers or destinations; read-only ingestion into a fixed canonical model; writes are M16 and per-target                 |
| Generic ETL      | Closed transform set; no joins, expressions or scripting in configuration; complex shaping lives in adapters                                  |
| Ontology engine  | The canonical model is code; the registry holds scalar account (later person) attributes only, no classes, inheritance or relations           |
| Rules engine     | Eligibility gains one typed condition; signals have their own versioned definitions; no general predicate language                            |
| Unrestricted EAV | Every value row is typed, FK-bound to a registered definition, used only where `allowedUses` permits, with provenance                         |

If a requirement pushes past any of these lines, it needs an ADR.

---

## 22. Compatibility with M0–M7

| Existing concept                         | Integration                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical Company/Person (M1/M2/M6)      | Unchanged; attributes reference canonical ids; first-class fields stay columns                                                                                                                                                    |
| External references (M6)                 | The only target of `identity` mapping entries; reference keys use the connector kind                                                                                                                                              |
| Provenance (M6 `tenant_context_changes`) | New `entity_kind` values (`account_attribute`); add the mapping version to provenance (one nullable column in M8)                                                                                                                 |
| Single writers (M6, M7)                  | Attribute values are written by the account's single writer; subscriptions by `SubscriptionIngestionService`; mappings produce canonical observations, not direct writes                                                          |
| Account merge (M6/M7 participant port)   | Attribute values get a merge participant: the survivor keeps its value; the loser's value is moved only where the survivor has none; differing values are recorded as an identity conflict for review, never silently overwritten |
| Product model (M7)                       | Unchanged until the eligibility milestone adds `registered_attribute`; product `externalRefs` remain product identity                                                                                                             |
| Subscriptions (M7)                       | Unchanged; the canonical observation contract is the mapping output for `subscription`; `source.system` becomes the connector kind                                                                                                |
| Eligibility and snapshots (M7)           | Extended later (§13); frozen inputs make old snapshots immune                                                                                                                                                                     |
| Tenancy and config (M2)                  | `tenant_field_mappings` superseded and migrated in M8 (§7); template stays free of mappings and attributes (`tbc`)                                                                                                                |
| CSV import (M7)                          | Remains the fixture/operator path; a CSV "connection" can later use the same mapping model instead of fixed columns                                                                                                               |
| Signals/opportunities (M11–M14)          | Read attributes only via `allowedUses`; never via mappings                                                                                                                                                                        |

No competing concept is introduced: there is one identity mechanism
(references), one provenance table, one writer per entity, one versioning
pattern.

---

## 23. Sequence

| When                                                                                                        | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Designed now** (this document)                                                                            | Canonical-vs-extension criteria; registry, value persistence and promotion design; connector capability contract; schema snapshot; mapping model, transforms, versioning, mandatory base version; authority by fact; identity safeguards; data-quality codes                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Implemented in M8**                                                                                       | Connector-kind catalogue replacing the closed enums, and source connections; the generic connector port (`testConnection`, `describeSchema`, `readRecords`, `readRecord`, `capabilities`) with the M8 adapter (mock first); schema snapshots; mapping versions (file drafts, validate, preview, publish with **required** base version) limited to the entry kinds M8 needs (`identity`, `core`, `relationship`, `ignored`) for `account`, `subscription` and `product_reference`; the closed transform set; authority declaration for `subscription_ownership` (single source); mapping version in provenance; migration retiring `tenant_field_mappings`; base version required for product model publish too |
| **Deferred to the first real attribute** (when discovery or a tenant shows a needed attribute; earliest M9) | Attribute registry, `tenant_attribute_values`, `attribute` mapping entries, merge participant for values, field annotations beyond what M8 needs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Deferred to the eligibility extension** (with the first attribute-based rule)                             | `registered_attribute` condition, evaluator version bump, snapshot inclusion of attributes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Deferred to M15** (stored drafts: M10A2)                                                                  | Stored drafts, per-user editing, roles and four-eyes confirmation, UI flows, masked preview in the UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Deferred to multi-customer evidence**                                                                     | Several connections of the same kind; field-level precedence for one fact across sources; promotion of any attribute to canonical; mapping suggestions/AI; per-source or per-account coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

This keeps M8 focused on the subscription source while laying the
connection, schema, mapping and authority foundations every later connector
needs, and avoids building the attribute registry before a real attribute
exists.

---

## Risks

| Risk                                                               | Mitigation                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| The registry becomes a dumping ground for every source field       | Mapping-first: a field enters only via a published attribute with a description and allowed uses; limits; `ignored` with reasons |
| Tenants encode business logic in value maps                        | Value maps only translate codes; no conditions; unmapped-value policy explicit                                                   |
| A descriptive field mapped as identity corrupts account references | §15 safeguards, preview duplicate check, refusal of descriptive fields, explicit identity-change ack                             |
| Split authority discovered for the same fact                       | Model it as separate facts now; field-level precedence needs evidence and an ADR                                                 |
| Schema drift silently breaks ingestion                             | Schema snapshot hash on each mapping version; drift blocks publish and is reported per run                                       |
| Replacing the closed `ExternalSystem` enum touches M3–M7 code      | Mechanical change in M8 with the existing tests and mutation proofs as the safety net                                            |
| Over-building before requirements                                  | Registry and attribute values deferred until a real attribute exists; M8 implements only what the subscription source needs      |

## Open questions

1. Which source(s) hold Juniper's subscription truth, and is authority split
   (Subscription Source Discovery).
2. Whether any Juniper attribute (e.g. a school type or contract tier) is
   needed for M8/M9 eligibility, which decides when the registry is built.
3. Whether `customer_status` must itself become a mapped core field with
   authority (likely yes when a source supplies it).
4. Whether a warehouse source counts as a connection (same model) or as a
   bulk import path (CSV-like); assumed the former.
5. The privacy ADR's rules for `personal` attributes (tech debt #15).
6. Whether four-eyes publishing is required by the customer before M15.

## Confirmation

This is documentation only. No code, Prisma schema, migration, connector or
customer-specific field was added, and **M8 implementation has not started**.
