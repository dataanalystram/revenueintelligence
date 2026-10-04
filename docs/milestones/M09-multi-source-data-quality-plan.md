# Milestone 9 — Multi-source data quality and subscription validation (PLAN)

> **Status: PLAN FOR INDEPENDENT ARCHITECTURE REVIEW.** No code, no
> migrations, no Chargebee, S3 or warehouse work. M9 is split into five
> phases (M9A–M9E), each with its own plan approval, Definition of Done and
> gate. A phase starts only after the previous gate passes and the owner
> approves.
>
> Baseline: `main` @ `375fadb` (M8 merged). PR #13 (tech debt 43, test-only)
> is open and does not affect this plan. **LIVE SUGAR VERIFICATION: PENDING**
> (unchanged by M9).

## 0. Objective

Prove that the M8 architecture works for source systems that are
fundamentally different from Sugar, without redesigning anything per source.
The architecture under test is:

`ConnectorKind → SourceConnection → connector port → schema discovery →
profiling → versioned mapping → authority → canonical ingestion →
provenance/coverage`

M9 also adds one reusable capability: **source data profiling** before a
mapping is published. Profiling suggests technical interpretations. It never
decides business meaning; operator confirmation stays mandatory for
semantics and authoritative mappings (ADR 0020).

Success means:

- Account, Person, Product, Subscription and Eligibility stay source-neutral;
- every source-specific behaviour lives in an adapter or a mapping;
- the safety properties (authority, coverage, provenance, explicit unknown)
  hold for a billing system (Chargebee), files (S3) and tables (warehouse).

### Roadmap deviation (owner decision required)

The approved roadmap (`docs/product/roadmap.md`) defines M9 as "Remaining
system read connector": Sugar pipeline context for suppression, or Gainsight
health and usage. This plan redefines M9 as multi-source data quality and
subscription validation, per the owner's instruction of 2026-10-04.

- **Decision needed (D1):** confirm the redefinition. The former M9 scope
  (suppression context, CS/usage context) moves to a later milestone that
  will reuse the M9 profiling and source contracts. The roadmap and
  `docs/milestones/README.md` would be updated when M9A starts. This plan
  does not edit them.

## 1. Invariants carried forward (non-negotiable)

1. One ingestion architecture: every source uses the M8 port, mapping,
   authority and single writers. No per-source ingestion path, table or
   canonical column.
2. The domain stays pure (`domain-is-pure`). Profiling detection logic is
   pure domain code; I/O lives in `sources`; vendor code lives only in
   adapter modules (dependency-cruiser rules extended per new adapter).
3. Adapters are read-only, enforced by a transport or query guard and proved
   at connector level (the same proof as the M8 closure).
4. Tenant isolation (ADR 0008): every new table has `tenant_id`, forced RLS,
   composite tenant keys and adversarial raw-SQL tests (the M8 closure
   pattern). The app role is never weakened.
5. Secrets only through SecretProvider. Configuration stores credential
   names, never values. The recursive secret-like-key CHECK applies to every
   new JSON document.
6. Never invent customer schemas, field names or picklist values: unknown is
   `tbc` in configuration. Chargebee, S3 and warehouse fixtures are
   synthetic.
7. Deterministic code decides. Profiling suggestions are advisory.
   Consequential mapping entries require a recorded human confirmation.
8. `unknown` is never coerced to a definite state. Coverage is never claimed
   without a full-read proof.
9. No PII in logs, metrics or profile documents beyond the controlled
   exceptions in §6.

## 2. Phase split and gates

| Phase | Scope                                    | Depends on                  | External access                                              | Gate                               |
| ----- | ---------------------------------------- | --------------------------- | ------------------------------------------------------------ | ---------------------------------- |
| M9A   | Source data profiling foundation         | M8                          | none                                                         | Profiling gate (§13.1)             |
| M9B   | Chargebee reference adapter (mock first) | M9A                         | Chargebee **test site** with synthetic data (live gate only) | Chargebee gate + live gate (§13.2) |
| M9C   | S3 / file source                         | M9A (M9B recommended first) | none for CI (S3-compatible container); optional AWS sandbox  | File-source gate (§13.3)           |
| M9D   | Warehouse / table source                 | M9A                         | none for CI (PostgreSQL container)                           | Warehouse gate (§13.4)             |
| M9E   | Canonical architecture review            | M9B, M9C, M9D               | none                                                         | Review gate (§13.5)                |

Order: M9A → M9B → M9C and M9D (either order, or in parallel only with
explicit approval) → M9E. In addition, an **interim canonical check** runs at
the end of M9B with the M9E checklist, so a canonical problem found by
Chargebee is not carried into M9C/M9D.

Each phase follows the project discipline: inspect → plan → implement →
test → verify (including a fresh clone) → commit → PR → independent review →
stop. Each phase has its own milestone record
(`docs/milestones/M09A-…md` … `M09E-…md`) and its own ADR(s) (§16).

## 3. Architecture proposal

```
                 ┌──────────────── adapter edge (per kind) ────────────────┐
 source system → │ transport guard → vendor client → Zod boundary → port   │
                 └──────────────────────────────┬──────────────────────────┘
                                                │ SourceConnector (M8 port, + §4 additions)
   sources module (generic)                     ▼
   ┌───────────────────────────────────────────────────────────────────────────┐
   │ SchemaSnapshotsService  → snapshot (metadata only, hashed)          [M8]  │
   │ SourceProfilingService  → profile run → profile document + findings [M9A] │
   │ SourceMappingsService   → validate(schema + profile) → publish      [M8+] │
   │ MappingPreviewService   → ≤20 masked records, nothing persisted     [M8]  │
   │ SourceAuthorityService  → one connection or nobody per fact         [M8]  │
   │ SourceSyncService       → read → map → single writers → coverage    [M8]  │
   │                           + run-quality profile (mapped fields)     [M9A] │
   └───────────────────────────────────────────────────────────────────────────┘
        │ pure functions                          │ canonical observations only
        ▼                                         ▼
   domain/source-profile.ts (detectors,     ContextIngestionService /
   accumulators, findings, drift)  [M9A]    SubscriptionIngestionService [M6/M7]
```

- **New pure domain module** `domain/source-profile.ts`:
  - value classifiers, field accumulators, interpretation suggestions;
  - finding rules and drift comparison;
  - no I/O, no vendor types; property-tested.
- **New generic service** `sources/application/source-profiling.service.ts`:
  - drives profile runs through the port;
  - persists profile documents;
  - feeds findings to mapping validation.
- **New adapters**, each its own module behind the M8 rules
  (`business-code-uses-source-port`, `core-never-depends-on-sources`,
  `sources-never-imports-concrete-adapters`), registered by the composition
  roots:
  - `modules/chargebee` (M9B);
  - `modules/objectstore` (M9C, kind `s3_files`);
  - `modules/warehouse` (M9D, kind `warehouse_postgres` as the reference
    dialect).
- **No change** to the canonical entities, the single writers, the
  eligibility evaluator or the authority fact set. If any phase finds that
  such a change is needed, it stops and raises it for M9E instead of making
  it.

## 4. Port additions (generic, backward compatible)

M9 changes the M8 port as little as possible. Each addition is generic and
optional, and Sugar keeps working unchanged.

| Addition                                                                                    | Why                                                                                                                                                                                                                                                   | Phase |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `ReadRequest.purpose: 'sync' \| 'preview' \| 'profile'`                                     | Profiling must read fields that are not mapped yet. M8's rule "the adapter reads only mapped fields" becomes "only mapped fields for `sync`; only fields selected in the profile request for `profile`". Adapters log the purpose code, never values. | M9A   |
| `ObjectCapabilities.fullReadProof: 'count' \| 'double_enumeration' \| 'manifest' \| 'none'` | M8 coverage needs `countRecords` before and after the read (`countOrRefuse`). Chargebee's list API probably has no count endpoint (to verify). Files can use a manifest; warehouses can count. See §8.6.                                              | M9B   |
| `SourceField.nested?: 'array' \| 'object'` (metadata)                                       | Lets an adapter declare that a field is natively structured (Chargebee `subscription_items`, JSON files) so the profiler and validator treat it as a structure, not a string.                                                                         | M9A   |
| `SourceSchema` objects with `classification: 'derived'`                                     | An adapter may expose a flattened child object (`SubscriptionItems` from `Subscription.subscription_items[]`) with a stable composite id. Declared, never invented by the platform.                                                                   | M9B   |

`double_enumeration` and `manifest` are new full-read proofs. They need
their own ADR text (§8.6) and mutation proofs, because they gate tombstones
and coverage.

## 5. Source profiling — data model (M9A)

### 5.1 Tables (planned; created by the M9A migration)

**`tenant_source_profile_runs`** (lifecycle, mutable until terminal)

- Identity: `tenant_id`, `id`, `connection_id` (composite FK to the
  connection), `schema_snapshot_hash` (composite FK to the snapshot).
- Lifecycle: `status` (`requested` → `running` → `completed` | `failed` |
  `abandoned`), `requested_by`, `correlation_id`, `started_at`,
  `finished_at`, `error_code`.
- What it covered: `objects` (the requested objects and selected fields,
  names only), `sampling` (method, limits, rows read, estimated population,
  coverage ratio).
- Forced RLS; tenant trigger; one active run per connection (advisory lock,
  as for sync runs).

**`tenant_source_profiles`** (immutable after insert; refuse-change trigger)

- Identity and links: `tenant_id`, `run_id`, `connection_id`, `object`,
  `schema_snapshot_hash`, `previous_profile_id` (the drift baseline,
  nullable).
- Content: `document` (JSONB, §5.2), `content_hash`.
- Checks: `octet_length(document) ≤ 1 MiB` (planning value, to confirm);
  recursive secret-like-key CHECK; forced RLS.
- One row per (run, object).

**`tenant_source_profile_findings`** (immutable; acknowledgements live
elsewhere)

- Identity: `tenant_id`, `profile_id`, `code`, `severity`, `object`, `field`
  (nullable).
- Evidence: `evidence` (JSONB, counts and ratios only).
- `consequential` (true when a published or draft mapping uses the field
  consequentially, recomputed at validation time; stored as of creation).

Acknowledgements are **not** a mutable column on findings. They are recorded
in the mapping version's `validation` document at publish time (operator,
reason code, finding ids). This keeps findings immutable and binds each
acknowledgement to the mapping that relied on it (§9).

### 5.2 Profile document (per object)

```jsonc
{
  "v": 1,
  "object": "Subscriptions",
  "sampling": {
    "method": "full|recent|systematic|head",
    "rowsRead": 0,
    "populationEstimate": 0,
    "coverage": 0.0,
    "bounded": true,
  },
  "fields": {
    "<fieldName>": {
      "declared": { "type": "enum", "sourceType": "…", "required": false, "nested": null },
      "counts": { "present": 0, "null": 0, "emptyString": 0, "whitespaceOnly": 0 },
      "nullRatio": 0.0,
      "distinct": { "value": 0, "method": "exact|estimate", "capped": false },
      "cardinalityClass": "constant|low|medium|high|unique",
      "observedTypes": {
        "boolean": 0,
        "integer": 0,
        "decimal": 0,
        "date": 0,
        "timestamp": 0,
        "string": 0,
        "json_array": 0,
        "json_object": 0,
        "array": 0,
        "object": 0,
      },
      "representations": {
        "boolean.native": 0,
        "boolean.token_yes_no": 0,
        "date.iso": 0,
        "date.dmy": 0,
        "list.json": 0,
        "list.delimited.comma": 0,
        "json.encoded_string": 0,
      },
      "parseFailures": {
        "malformed_json": 0,
        "invalid_date": 0,
        "ambiguous_date": 0,
        "number_locale": 0,
      },
      "length": { "min": 0, "p50": 0, "p95": 0, "max": 0 },
      "rangeBuckets": { "kind": "year|magnitude", "buckets": { "2025": 0 } },
      "categorical": {
        "values": [{ "value": "active", "count": 0 }],
        "suppressed": false,
        "reason": null,
      },
      "list": {
        "elements": { "min": 0, "max": 0, "p50": 0 },
        "delimiter": ",",
        "elementTypes": {},
        "elementCategorical": { "values": [], "suppressed": true },
      },
      "json": { "topLevelKeys": ["values"], "maxDepth": 2 },
      "suggestions": [
        {
          "interpretation": "multi_select",
          "confidence": "high|medium|low",
          "evidence": ["list.delimited.comma=0.98", "elementCardinality=low"],
        },
      ],
    },
  },
}
```

- **No raw values** are stored, except `categorical.values` under the
  safe-category rule (§6.3) and JSON **key names** (schema-like; they pass the
  secret-like-key check, or are replaced by a count).
- Exact minimum and maximum values are **not** stored. Ranges are coarse
  buckets: dates by year, or by month when the span is under two years;
  numbers by order of magnitude. Exact extremes can be PII (birth dates) or
  commercially sensitive (amounts).
- `length` statistics are lengths, never content.

### 5.3 Profile lifecycle

1. **Request.** The operator (CLI/API) requests a profile for a connection,
   objects and fields, and a sampling method. Fields default to the
   snapshot's fields of the requested objects **minus the sensitive
   exclusions** (§6.2). `internal_principal` objects need an explicit
   opt-in.
2. **Validate.**
   - The connection is enabled.
   - The snapshot is the connection's latest; a stale snapshot is refused
     (`schema_snapshot_stale`), as at mapping publish.
   - The requested fields exist in the snapshot.
   - The row limit is within the configured maximum. **D2:** the maximum has
     no default; it is configured per connection, planning suggestion 50,000
     rows.
3. **Run** on the `lip-sources` queue (job `source.profile`), one active run
   per connection.
   - Bounded reads use the `profile` purpose.
   - Values are folded into in-memory accumulators per page and discarded at
     once. Nothing is persisted per record.
4. **Complete.**
   - One immutable profile document per object, plus its findings.
   - Drift is computed against the previous completed profile of the same
     object and connection (§8).
5. **Fail or abandon.**
   - The run is terminal with a code; nothing partial is published as a
     profile.
   - Transient failures retry like sync jobs; exhausted failures dead-letter
     through the M6 recorder.
6. **Supersede.** A newer completed profile becomes the baseline. Older ones
   stay for audit.
   - **D3, retention:** keep the last N per object and delete the older
     ones. A purge needs a privileged, audited path, as for tech debt 23;
     planning suggestion N = 10.

A **run-quality profile** (§8.3) is produced by every sync run as a
by-product, over **mapped fields only**. It reuses the same accumulators and
is stored with the same document schema, with `sampling.method = "sync"`.

## 6. Sampling and privacy strategy

### 6.1 Sampling methods (recorded in every document)

| Method       | How                                                        | When                                                  | Bias recorded                |
| ------------ | ---------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| `full`       | Bounded full read under a boundary (like a full sync)      | Default when the population is ≤ the row limit        | none (`coverage = 1`)        |
| `systematic` | Every k-th page by offset/cursor, k = ⌈population / limit⌉ | Offset-paginated sources with a count                 | page-cluster bias noted      |
| `recent`     | Newest records first by the change field                   | Sources without a count or offset                     | recency bias noted           |
| `head`       | The first N records in source order                        | Last resort; refused for consequential-field findings | `head_sample_biased` finding |

- Distinct counts are exact up to a cap (planning value 10,000), then a
  HyperLogLog estimate (`method = "estimate"`). The sketch is never persisted.
- Every finding carries the sampling method and coverage, so a reviewer can
  see when a "0 nulls" result comes from 2% of the data.

### 6.2 Field exclusion and sensitivity classification

Before a profile run, every requested field is classified:

- **Excluded by default:**
  - name patterns: `password`, `secret`, `token`, `card`, `iban`,
    `account_number`, `ssn`, `tax_id`, `dob`, `birth`;
  - payment-like objects declared by the adapter: Chargebee payment
    sources, cards, transactions, invoices.

  An excluded field cannot be profiled. Lifting the exclusion is an explicit
  per-field opt-in, recorded on the run with the operator.

- **Profiled as `sensitive`:** shape and counts only, never categorical
  values even at low cardinality.
  - name patterns: `email`, `phone`, `name`, `address`, `street`, `postcode`,
    `zip`, `city`, `ip`, `url`;
  - fields where value detectors find emails, phone numbers,
    Luhn-valid card-like numbers or IBAN-like strings above a small threshold.

  A detector hit on a field not declared sensitive raises
  `sensitive_values_detected` and suppresses that field's categorical values
  retroactively, before the document is written.

- **Normal:** everything else.

### 6.3 Safe-category rule (the only raw values persisted)

A field's distinct values may be stored (with counts) only when **all** of
these hold:

- the field is normal (not sensitive or excluded);
- the source declares it as an enum, or its observed distinct count is
  ≤ 50 (planning value) with distinct/present ≤ 0.05;
- every value has ≤ 64 characters and fails the PII detectors;
- every value fails the identifier detectors (UUID, long digit runs, mixed
  alphanumeric ids).

Otherwise `categorical.suppressed = true` with a reason code. Values that
pass are source vocabulary: picklists such as statuses. They are needed for
value maps, and the M8 snapshot already stores declared enum options.

### 6.4 Elsewhere

- **Preview:** unchanged from M8 (≤ 20 records, mapped fields only,
  references hashed, nothing persisted). Profiling adds no record-level
  preview.
- **Logs and metrics:** codes, counts and names only. Metrics labels:
  connection kind, object (lower-cased), finding code. Never field values;
  field names only where already logged by M8.
- **Raw records:** never written to disk, queues or dead letters. Profile
  jobs carry ids only.

## 7. Type and shape detection rules (pure, deterministic)

### 7.1 Per-value classification (first match wins)

1. `null` / `undefined` → **null**.
2. String `""` → **empty_string**. A string of only whitespace →
   **whitespace_only**. These are counted separately from null, never merged.
3. Native JSON types from the adapter:
   - boolean → `boolean.native`;
   - integer number → `integer`;
   - non-integer number → `decimal`;
   - array → `array`, with elements classified recursively to depth 1;
   - object → `object` (keys recorded).
4. A string, trimmed:
   1. starts with `[` or `{`:
      - parses as JSON → `json_array` / `json_object`
        (`json.encoded_string`);
      - otherwise → `parseFailures.malformed_json`, counted and then
        classified as `string`.
   2. A boolean token, case-insensitive: `true/false`, `yes/no`, `y/n`,
      `t/f` → `boolean.token_*`. `1/0` are **integers** that also count as
      boolean-candidate evidence (§7.2), never booleans on their own.
   3. Integer regex `^[+-]?\d+$` → `integer`. Leading zeros on more than one
      digit → `string.leading_zero` (codes such as postcodes and SKUs are not
      numbers).
   4. Decimal `^[+-]?\d+\.\d+$` → `decimal`. `^\d{1,3}(\.\d{3})*,\d+$` →
      `parseFailures.number_locale` (comma decimal, ambiguous).
   5. ISO-8601 date `YYYY-MM-DD` → `date.iso`. With time → `timestamp.iso`,
      recording `offset | Z | naive`. Unix seconds or milliseconds are
      recognised **only** when the source declares the field as a timestamp
      (Chargebee), never guessed from bare integers.
   6. Other date shapes `D/M/Y`, `M/D/Y`, `D.M.Y`:
      - a component > 12 resolves the order → `date.dmy` / `date.mdy`;
      - otherwise → `parseFailures.ambiguous_date`;
      - impossible dates (`2025-02-30`) → `parseFailures.invalid_date`.
   7. Delimited list: contains `,`, `;` or `|`, splits into ≥ 2 non-empty
      tokens, every token ≤ 64 characters with no internal spaces beyond
      one, and fewer than 30% of tokens empty →
      `list.delimited.<delimiter>`. When several delimiters qualify, the most
      consistent one wins and `ambiguous_delimiter` is recorded.
   8. Otherwise → `string` (or `text` when longer than 255 characters).

### 7.2 Field-level interpretation suggestions

| Suggestion                   | Rule (over non-null, non-empty values)                                                                 | Confidence                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `boolean`                    | ≥ 99% of values are boolean tokens or native booleans, or exactly the two integers {0,1}; ≥ 2 distinct | high if one representation, medium if mixed (`mixed_representation`) |
| `single_select`              | declared enum, or low cardinality (≤ 50 distinct, ratio ≤ 0.05), scalar values                         | high if declared, medium if inferred                                 |
| `multi_select`               | ≥ 95% list-shaped (native array, JSON array or delimited) with element cardinality ≤ 50                | high if native/JSON, medium if delimited                             |
| `json_array` / `json_object` | ≥ 95% JSON-encoded of one kind and not multi-select                                                    | high                                                                 |
| `date` / `timestamp`         | ≥ 99% parse as one date shape; ambiguous shapes never reach high                                       | high if ISO, medium if resolved D/M or M/D, low if any ambiguity     |
| `integer` / `decimal`        | ≥ 99% numeric; leading-zero values exclude the suggestion                                              | high or medium                                                       |
| `identifier`                 | distinct/present ≥ 0.99, or declared `id`/`unique`, or identifier pattern                              | high                                                                 |
| `free_text`                  | high cardinality, long strings                                                                         | medium                                                               |

A suggestion is **technical**: "this field looks like a multi-select of
short codes". It never says what the codes mean, never selects a canonical
target and never writes a mapping.

### 7.3 Required examples (fixtures and property tests)

| Input values                                           | Classification                                       | Suggestion                                                                |
| ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `["luc","ra","ars"]` (native array)                    | `array`, elements `string`, element cardinality low  | `multi_select` (high)                                                     |
| `"[\"luc\",\"ra\",\"ars\"]"`                           | `json_array` via `json.encoded_string`               | `multi_select` (high)                                                     |
| `"luc,ra,ars"`                                         | `list.delimited.comma`                               | `multi_select` (medium)                                                   |
| `{"values":["luc","ra"]}` (native or encoded)          | `object` / `json_object`, keys `[values]`            | `json_object` (high); the nested list is reported, not flattened          |
| `true / false / 1 / 0 / yes / no` in one field         | boolean native + tokens + integers                   | `boolean` (medium) + `mixed_representation`                               |
| `2025-01-31`, `31/01/2025`, `01/02/2025`, `2025-02-30` | `date.iso`, `date.dmy` (31 > 12), ambiguous, invalid | `date` (low) + `mixed_representation` + `ambiguous_date` + `invalid_date` |
| `""` versus `null`                                     | `empty_string` versus `null`, counted separately     | finding `empty_string_vs_null` when both occur                            |
| `"{bad json"`                                          | `malformed_json`, then string                        | finding `malformed_json`                                                  |

## 8. Findings, drift and run quality

### 8.1 Quality finding model

A finding has:

- `code` (closed set, below);
- `severity`: `info`, `warning`, or `review_required` (needs acknowledgement
  if consequential, §9);
- scope (object, field);
- evidence (counts, ratios, sampling method and coverage);
- `consequential` (computed against the mapping under validation).

Initial codes:

- **Nulls and empties:** `high_null_ratio`, `required_but_null`,
  `empty_string_vs_null`.
- **Type and representation:** `mixed_type`, `mixed_representation`,
  `malformed_json`, `invalid_date`, `ambiguous_date`, `number_locale`,
  `ambiguous_delimiter`, `leading_zero_numeric`.
- **Schema versus data:** `declared_type_mismatch` (declared integer,
  observed strings), `value_not_in_declared_enum`,
  `field_absent_in_data` (declared, never present),
  `undeclared_field_in_data` (files and JSON only).
- **Identifiers:** `identifier_not_unique` (a declared id or identity field
  with duplicates), `high_cardinality_identifier` (informational:
  categorical values suppressed).
- **Privacy and sampling:** `sensitive_values_detected`,
  `head_sample_biased`, `low_coverage_sample`.
- **Drift (§8.2):** `profile_drift_*`.

### 8.2 Profile drift model

A profile is compared with its baseline: the previous completed profile of
the same connection, object and sampling family (`sync` profiles compare
with `sync` profiles). Drift codes:

| Code                              | Trigger (planning thresholds; configurable per connection)               |
| --------------------------------- | ------------------------------------------------------------------------ |
| `profile_drift_null_ratio`        | absolute change ≥ 0.10                                                   |
| `profile_drift_type_distribution` | the dominant observed type changes, or a new type ≥ 1%                   |
| `profile_drift_representation`    | a new representation ≥ 1% (e.g. a JSON array becomes a delimited string) |
| `profile_drift_new_category`      | a new categorical value appears (safe-category fields only)              |
| `profile_drift_category_vanished` | a previously frequent value (≥ 5%) disappears                            |
| `profile_drift_cardinality`       | cardinality class changes (low → high)                                   |
| `profile_drift_row_count`         | population change ≥ 20% between full profiles                            |
| `profile_drift_parse_failures`    | parse failure ratio up by ≥ 0.01                                         |

- Schema drift (M8, metadata) and profile drift (M9, data) are separate.
  Schema drift on the mapped surface still blocks runs (M8).
- **Profile drift never blocks a sync run by default.** It produces findings
  and metrics.
- **D4:** an operator may promote specific drift codes to **run-blocking**
  for consequential fields (for example `profile_drift_new_category` on the
  mapped state field). The rule is recorded in the mapping version, so a new
  unmapped state value stops the run before writes instead of silently
  becoming `unknown`. Default: not blocking. A new state value already
  becomes `unknown` safely by the M8 `unmapped: unknown` policy.

### 8.3 Run-quality profile

Every sync run accumulates a mapped-fields-only profile from the values it
already reads. There are no extra reads. It is stored with
`sampling.method = "sync"`, compared with the previous sync profile, and
summarised in the run's `quality` alongside the M8 counters. This is how drift
is caught in production without separate profiling jobs.

## 9. Integration with schema snapshots and versioned mapping

- **Snapshots stay metadata-only** (M8 contract). A profile references the
  snapshot hash it ran under. Schema-versus-data findings compare the
  snapshot's declared metadata with observed data.
- **Mapping validation gains profile-aware checks.** The validator stays
  pure, and the profile is an input.
  1. **D5 (recommended):** publishing a versioned mapping requires a
     completed profile for the mapping's snapshot. The profile must cover
     every object the mapping reads and every field used **consequentially**:
     identity, holding filter, state, terms, product and account references.
     Missing → `profile_required`. The alternative is a warning only; the
     owner decides.
  2. For each consequential entry, open `review_required` findings on its
     field must be acknowledged in the publish request: finding id, reason
     code, actor. Missing → `finding_unacknowledged`. Acknowledgements are
     stored in `tenant_source_mapping_versions.validation`.
  3. **Value maps** (state, holding filter): observed categorical values that
     are neither mapped nor declared → `observed_value_unmapped` (warning).
     The M8 `unmapped: unknown` policy keeps runtime safety.
  4. **Holding filter:** a filter value never observed → `filter_value_unobserved`
     (warning); a filter field with `mixed_type` → `review_required`.
  5. **Dates:** a date entry whose field has `ambiguous_date` or
     `mixed_representation` cannot use an implicit format; the mapping must
     declare the format explicitly (new `parse_date.format` option, closed
     set: `iso`, `dmy`, `mdy`, `unix_s`, `unix_ms`).
  6. **Identity:** an identity field with `identifier_not_unique` is refused
     (`identity_unsuitable`, existing code), with the profile as evidence.
- **No new canonical targets.** Multi-select and JSON fields can be
  `ignored` (with a reason) or, for native structures, flattened **by the
  adapter** into a declared derived object (§4). The pre-M8 attribute
  registry (design gate `e4fec65`) stays deferred; profiling is its future
  input, not its implementation.
- **Transform additions** limited to what a canonical target needs:
  - explicit date formats (above);
  - `boolean_tokens` (declared true and false token sets) **only if** a
    canonical boolean target exists. None does in M9, so this is deferred.

### 9.1 Preview and publish workflow

1. `sources:schema --capture` → snapshot (M8).
2. `sources:profile-run --objects … [--fields …] --sampling full|recent|…` →
   profile run (M9A).
3. `sources:profile-show` / `sources:profile-findings`: documents and
   findings (aggregates only).
4. Optional: `sources:mapping-draft --from-profile`. Writes a **draft**
   mapping file with suggestions as comments and every consequential entry
   left as `explicit: unknown`/`null` for the operator to fill. It never
   publishes, as with the M8 product draft.
5. `sources:mappings-validate --file` → schema + profile checks (§9).
6. `sources:mappings-preview` → ≤ 20 masked records (M8).
7. `sources:mappings-publish --based-on N --ack <finding>:<reason> …`
   (consequential confirmations as in M8, plus acknowledgements).
8. Authority (M8) → sync (M8) → run-quality profile and drift (M9A).

## 10. M9B — Chargebee reference adapter (mock first)

### 10.1 Scope

- **Kind:** `chargebee` (`versioned` mapping mode, external references).
- **Module** `modules/chargebee`:
  - the adapter implements the port; read-only transport guard
    (GET only);
  - credentials (an API key) via SecretProvider by credential name;
  - Zod validation at the boundary;
  - a deterministic fake Chargebee for CI (`test/support/fake-chargebee.ts`).
- **No separate ingestion:** customers become companies through
  `ContextIngestionService`, and subscription items become lines through
  `SubscriptionIngestionService`, with provenance, coverage and gaps exactly
  as in M8.

### 10.2 Chargebee facts to verify on the test site

The design relies on these facts, all marked **REQUIRES CHARGEBEE TEST-SITE
VERIFICATION**. None is assumed in code without a test proving the fake
matches the test site.

- **API:** API v2; HTTP Basic with the API key as username. A
  **read-only** API key type is available. The read-only key is the target
  credential; a full-access key is refused if detectable.
- **Product Catalog 2.0:** `items` (types plan, addon, charge),
  `item_prices`, `subscriptions[].subscription_items[]` (item price id, item
  type, quantity). Product Catalog 1.0 sites (`plans`/`addons`) are
  **out of scope** and refused with `catalog_version_unsupported`.
- **Subscription status vocabulary:** `future`, `in_trial`, `active`,
  `non_renewing`, `paused`, `cancelled`, possibly `transferred`.
- **Term and lifecycle fields** are Unix-second timestamps:
  `current_term_start`, `current_term_end`, `started_at`, `activated_at`,
  `cancelled_at`, `trial_start/end`, `next_billing_at`,
  `cancel_schedule_created_at`(?), `deleted`.
- **List API:**
  - pagination by `offset` token (`next_offset`), limit ≤ 100;
  - filters such as `updated_at[after]` and `sort_by[asc]=updated_at`;
  - `include_deleted=true` returns deleted records flagged `deleted`;
  - **no count endpoint** (assumed; this drives §10.6).
- **Rate limits:** site-specific; `429` with retry guidance.
- Responses carry whole objects. The API has no field selection, so
  **minimisation happens at the boundary** (§10.8).

### 10.3 Object model and mapping (TEST mapping only; business confirmation required)

| Chargebee                           | Port object (declared by the adapter)                                     | Canonical                                                 | Notes                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `customer`                          | `Customers` (record)                                                      | Account (company external ref `chargebee/Customers/<id>`) | Identity = customer id. Cross-system linking to the HubSpot company only through a validated identity field or later identity resolution (as M8 §20).                                      |
| `item` (+ `item_price`)             | `Items` (reference), `ItemPrices` (reference)                             | Product (via product-model `externalRefs`)                | Lines reference item prices; the adapter exposes `item_id` on each line so products resolve by **item** id (decision D7: item vs item price).                                              |
| `subscription`                      | `Subscriptions` (record)                                                  | — (parent)                                                | Not a canonical line by itself.                                                                                                                                                            |
| `subscription.subscription_items[]` | `SubscriptionItems` (**derived**, id `<subscription_id>:<item_price_id>`) | Subscription line                                         | Flattened by the adapter. Parent fields the mapping may need (status, term dates, customer id, `updated_at`, `deleted`) are denormalised onto each item record and declared in the schema. |

- **Why a line is the item, not the subscription:** canonical Subscription
  is one product per line (ADR 0017). A Chargebee subscription with a plan
  and two addons is three lines, which is what product-level ownership
  needs.
- **Composite id stability.** The id is stable only while the same item price
  appears once per subscription. Duplicate item prices within one
  subscription (if Chargebee allows them; to verify) raise
  `duplicate_external_id` and fail the line's proof. The id is never
  invented beyond what the adapter declares.
- **Denormalisation** keeps the M8 holding filter rule: a direct field on the
  mapped object (ADR 0020 §7; tech debt 33). The parent `status` becomes a
  direct field of `SubscriptionItems`. This is an adapter-edge shape, not a
  relational filter in the platform.

### 10.4 State, terms, renewal and cancellation (operator-confirmed value maps)

Planning **suggestions** for the TEST mapping. Every row is a business
decision for each tenant, and none is a code default.

| Chargebee status                  | Suggested canonical state                            | Reasoning / caveat                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`                          | `active`                                             |                                                                                                                                                                            |
| `in_trial`                        | `trial`                                              |                                                                                                                                                                            |
| `non_renewing`                    | `active`                                             | Still in force until `current_term_end`; ends at the term end. The end date carries the fact (no new canonical field).                                                     |
| `future`                          | `active` with `startsAt` in the future, or `unknown` | The M7 evaluator already treats a line with `startsAt > asOf` as not in force (verified: `eligibility.ts` checks `startsAt ≤ t`). Either choice is safe; business decides. |
| `paused`                          | `unknown` (suggested)                                | No canonical "paused". Mapping to `active` or `cancelled` is a business decision; `unknown` makes ownership unknown, never false whitespace.                               |
| `cancelled`                       | `cancelled`                                          |                                                                                                                                                                            |
| `transferred`, any unlisted value | `unknown` via `unmapped: unknown`                    | Plus `observed_value_unmapped` at validation and `profile_drift_new_category` at runtime.                                                                                  |

- **Terms:** `startsAt` ← `current_term_start`; `endsAt` ←
  `current_term_end`.
  - Both are instants (Unix seconds, `parse_date.format = unix_s`). There is
    no time-zone declaration and no inclusive-end conversion, **if** the test
    site confirms that `current_term_end` is the exclusive boundary
    (verify).
  - Alternatively `started_at`/`cancelled_at`; choosing the pair is a
    business decision recorded as a confirmation, as in M8 §17.
- **Renewal:** one line per subscription item. A renewal in Chargebee keeps
  the same subscription and advances the term, so the line updates and no
  new line is created. Separate renewal subscriptions stay separate lines
  (M8 §18, no collapse).
- **Cancellation:**
  - `cancelled` with `cancelled_at` → state `cancelled`, `endsAt` per the
    confirmed pair.
  - A scheduled cancellation (`non_renewing`) stays `active` until the term
    end.
  - **Deleted** subscriptions (`deleted=true` via `include_deleted`) →
    tombstone (`presence: absent`). This needs `deleteVisibility: 'flag'`,
    proven on the test site.
- **Multiple subscriptions and items** per customer → multiple lines;
  ownership is "any line qualifies" (M7).

### 10.5 Authority question (explicit answer)

**Can Chargebee safely become authoritative for `subscription_state` and
`subscription_terms` with the existing authority model, without changing
canonical Subscription?**

**Yes, if and only if Chargebee also holds `subscription_lines` for that
tenant.** In that case:

- No canonical change is needed. Every Chargebee concept used above maps to
  the existing fields `state`, `startsAt`, `endsAt` and `quantity`, or stays
  in the source as `ignored` with a reason (`auto_collection`, billing
  period, prices).
- The M8 validator already enforces the condition: `subscription_state` and
  `subscription_terms` must come from the `subscription_lines` connection or
  stay unassigned (`cross_source_unsupported`, ADR 0020 §10).
- Coverage follows the `subscription_lines` authority (Chargebee). Lines
  from other sources stop counting as ownership facts once authority moves.
  This is the M8 rule, with an explicit operator step and an authority
  version.

**Not possible without new design:** Sugar holds the lines (deal/RLI view)
while Chargebee holds state and terms (billing view). That requires knowing
which Chargebee item line corresponds to which Sugar RLI, which is
cross-source line matching (§10.7).

Two more prerequisites:

1. A **full-read proof** for Chargebee (§10.6), because `subscription_lines`
   authority needs coverage.
2. A confirmed **holding filter**, if not every subscription item is a
   holding. For example, `charge` items may be one-off, so the holding
   filter can be `item_type in (plan, addon)`. Alternatively they go in
   `productReferences.ignored`. This is a business decision.

### 10.6 Full-read proof without a count (architectural decision D6)

M8 refuses to establish coverage unless the source counts the bounded set
before and after the read. If Chargebee has no count endpoint, three options:

| Option                                    | How                                                                                                                                                                                                                                                                                             | Pros / cons                                                                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `double_enumeration` (recommended)** | Under a fixed boundary (`updated_at < boundary`), enumerate the record ids twice. Pass 1 reads full records. Pass 2 reads ids only, if the API can (otherwise full records again, discarded). The proof holds when both id sets are equal and both list traversals ended with no `next_offset`. | Port-neutral and reusable (files, other APIs). Doubles reads, acceptable at expected scale (to verify). Does not catch records hidden by the API itself; the same limit applies to a count. |
| B. Trust exhaustion                       | One traversal; the list ending counts as complete.                                                                                                                                                                                                                                              | Cannot detect records inserted or moved during the read. Rejected: weaker than M8.                                                                                                          |
| C. Event-log reconciliation               | Use Chargebee's events API to prove no change during the read.                                                                                                                                                                                                                                  | Vendor-specific and complex; deferred.                                                                                                                                                      |

- **Recommendation:** add `fullReadProof: 'double_enumeration'` as a generic
  capability, with ADR text and a mutation proof: a record inserted between
  passes makes the run `unstable_read`.
- If neither count nor double enumeration is proven on the test site,
  Chargebee **cannot** hold `subscription_lines`, and therefore not
  state/terms either. It can still be profiled and preview-mapped.

### 10.7 Cross-source matching decision

**Deferred** (tech debt 32 stays open). Reasons:

- The §10.5 answer gives a safe path without it: one source holds all three
  subscription facts per tenant.
- Matching Sugar RLIs to Chargebee items needs evidence of a shared key.
  The Sugar evidence shows candidate ids (`subscription_urn_c`,
  `juniper_id_c`) **100% null** on RLIs; any Chargebee-side key is unknown.
  Without a key it would be a heuristic match (account + product + dates),
  which the project forbids for consequential facts.
- Billing and CRM lines legitimately differ (an RLI may become several
  items, or be invoiced elsewhere), so 1:1 matching is not a given.

**Revisit triggers:**

- a populated, validated cross-system id is found (profiling can detect one:
  `identifier`-like field, high fill rate, matching value shapes across
  connections; detection only);
- the owner requires Sugar lines with Chargebee state.

Either trigger starts its own design gate. M9 does not match.

### 10.8 Security specific to Chargebee

- GET-only transport guard, proved at connector level as in the M8 closure:
  POST, PUT, PATCH and DELETE never leave the process.
- The adapter never calls payment, card, transaction, invoice, credit-note
  or hosted-page endpoints. An endpoint allowlist is enforced in the guard
  (path patterns), with a test per denied family.
- **Boundary minimisation:** responses are parsed with Zod schemas that keep
  only declared fields. Everything else is dropped before the record leaves
  the adapter, including customer contact details not in the schema and
  billing addresses.
- **API key:** one SecretProvider secret per connection; never logged or
  echoed; `testConnection` returns codes only. Expected config:
  `site` (subdomain), `apiVersion`, `catalogVersion = 2`, rate limit,
  retries. All non-secret, with the secret-like-key CHECK.

### 10.9 Chargebee test strategy

- **CI (always):** deterministic fake Chargebee mirroring the verified API
  shapes, with fault injection:
  - 429 and `Retry-After`;
  - 5xx;
  - malformed payloads;
  - offset expiry;
  - mid-read inserts, for the double-enumeration proof;
  - deleted records;
  - a Product Catalog 1.0 site.

  Adapter unit/contract tests, sync integration tests on real PostgreSQL
  with RLS, a runtime script (`80-chargebee.sh`) and Docker checks.

- **Live gate (separate from completion, as M8 §30):** a Chargebee **test
  site** populated with synthetic data. Read-only API key via SecretProvider
  (the owner sets the variable; never pasted in chat). It verifies §10.2,
  records sanitised evidence (shapes, codes, counts; no values) and runs the
  synthetic scenarios end to end. **LIVE CHARGEBEE VERIFICATION** is a status
  of its own, like Sugar's.

### 10.10 Synthetic Chargebee scenarios (fake and test site)

| #    | Scenario                                                         | Expected                                                                                                   |
| ---- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CB01 | Customer, one active subscription, one plan item                 | 1 company ref, 1 line `active`, terms from the confirmed pair                                              |
| CB02 | One subscription: plan + 2 addons                                | 3 lines, one per item; products resolved by item id                                                        |
| CB03 | Two subscriptions, same customer, same item                      | 2 lines (no collapse)                                                                                      |
| CB04 | `in_trial`                                                       | `trial`                                                                                                    |
| CB05 | `future` start                                                   | per D-mapping: `active` + future `startsAt` (not in force) or `unknown`                                    |
| CB06 | `non_renewing`                                                   | `active` until `current_term_end`; not in force after                                                      |
| CB07 | `cancelled` with `cancelled_at`                                  | `cancelled`                                                                                                |
| CB08 | `paused`                                                         | `unknown` (TEST mapping); ownership unknown, never whitespace                                              |
| CB09 | Unlisted status value (`transferred` or synthetic)               | `unknown`; `observed_value_unmapped` at validation; drift finding at runtime                               |
| CB10 | Renewal (term advanced on the same subscription)                 | Same line updated; provenance shows a new change; no new line                                              |
| CB11 | Item price for an item missing from the product model            | Run fails before writes (`unmodelled_product_reference`, M8)                                               |
| CB12 | Item listed as ignored (`charge` one-off)                        | Line skipped `non_subscription_product`; no gap                                                            |
| CB13 | Subscription referencing a deleted or missing customer           | Line skipped `orphan_account_reference` and counted (no account, so no gap), as M8 does for source orphans |
| CB14 | Deleted subscription (`include_deleted`)                         | Tombstone on a full run (if `deleteVisibility: flag` proven)                                               |
| CB15 | Record inserted between enumeration passes                       | `unstable_read`; coverage unchanged                                                                        |
| CB16 | 429 storm mid-read                                               | Retries honour guidance; run resumes; idempotent                                                           |
| CB17 | Product Catalog 1.0 site                                         | `catalog_version_unsupported` at connection test                                                           |
| CB18 | Incremental run after an update                                  | Watermark minus overlap; only changed lines; no tombstones                                                 |
| CB19 | Malformed JSON body / unexpected field type                      | Zod rejection → `record_rejected` counted or run failed per M8 rules                                       |
| CB20 | Item price whose item type changes (addon → charge) between runs | Drift finding; holding filter applies on the next full run                                                 |
| CB21 | Customer with only cancelled subscriptions                       | Company ref; lines `cancelled`; products `not_owned` under coverage                                        |
| CB22 | Duplicate item price within one subscription (if possible)       | `duplicate_external_id`; proof fails for that line                                                         |

## 11. M9C — S3 / file source

### 11.1 Shape

- **Kind:** `s3_files`, `versioned` mapping, external references true. A
  file is not a system of record, but its rows name the customer's system
  ids. **D8:** confirm whether file rows should create external references
  under the kind `s3_files`, or under a declared upstream system name.
  Default: `s3_files`.
- **Configuration** (non-secret):
  - `bucket`, `region`;
  - `objects[]`: each with `name` (the port object), `prefix`, `pattern`
    (glob), `format` (`csv` | `jsonl` | `json`), CSV dialect (delimiter,
    quote, header, encoding: UTF-8 only), `idColumn`, optional
    `changeColumn`, `mode` (`snapshot` | `incremental`) and the completeness
    convention (`manifest` | `success_marker` | `none`);
  - `auth.roleArn` + `auth.externalId` (AssumeRole, **preferred**), or
    `auth.credentialName` (access keys in SecretProvider, **fallback**,
    flagged by a finding).
- **Read-only:** only `ListObjectsV2`, `GetObject`, `HeadObject` and
  (AssumeRole) `sts:AssumeRole`. A command allowlist wraps the SDK client
  and refuses any other command, proved at connector level. The documented
  IAM policy is read-only on the prefix.

### 11.2 Port mapping

- **`describeSchema`:**
  - CSV: header plus the first N rows; types `string` (CSV has no types),
    so profiling supplies observed types. JSON/JSONL: keys and native types.
  - The declared field set is the union across the sampled newest files;
    differing headers raise `file_schema_variant`.
- **`readRecords`:** a cursor of (file key, version, row offset).
  - **Snapshot mode:** read the files of the latest **complete** snapshot.
  - **Incremental mode:** read files newer than the watermark
    (`LastModified`), never already-ingested file versions.
- **Full-read proof:**
  - `manifest`: a manifest declares files and row counts; parsed rows must
    equal the declared counts;
  - `success_marker`: a marker object completes the snapshot prefix, and the
    proof is files listed before and after reading being identical
    (double enumeration);
  - `none`: no coverage, so **no tombstones**. Rows ingest, but the source
    cannot hold `subscription_lines`.
- **Deletes:** only snapshot mode with a proven complete snapshot allows the
  M8 full-run tombstone pass. Incremental mode never tombstones unless a
  declared deletion-file convention is added later (deferred).

### 11.3 File identity, duplicates and replays

- **File ledger** `tenant_source_files` (forced RLS, planned migration):
  - identity: `connection_id`, `key`, `version_id` or ETag, `size`,
    `last_modified`, `sha256` (computed while streaming);
  - processing: `status` (`seen`, `ingested`, `rejected`), `rows`,
    `malformed_rows`, `run_id`.
- **Replays:** a file version already `ingested` is skipped
  (`file_already_ingested`).
- **Duplicates:** the same `sha256` under a different key raises
  `duplicate_file_content` and is skipped unless the operator allows it.
- **Rewrites:** the same key with new content is a new version. Snapshot
  mode follows the snapshot rule; incremental mode applies it as an update.
  Writes are idempotent anyway through the single writers' field hash.

### 11.4 Malformed rows and schema drift

- **Malformed rows** (wrong column count, encoding errors, unparseable JSON
  lines) are counted with file key and row number. Contents are **never**
  stored. A malformed ratio above the configured threshold (**D9**, no
  default) fails the file (`malformed_rows_exceeded`), and coverage is not
  established. Below the threshold, rows are skipped, counted and
  `record_rejected`.
- **Changing columns:** new header or keys versus the snapshot →
  `schema_drift` (M8 semantics: blocking if on the mapped surface,
  informational otherwise). Profiling flags `undeclared_field_in_data` and
  `field_absent_in_data`.
- **Parquet:** deferred, with typed schemas. The design keeps format behind a
  `FileFormatReader` seam inside the adapter.

### 11.5 Relationship to the M7 `import` kind

The M7 operator CSV import (kind `import`, code-mapped) stays unchanged in
M9. `s3_files` is the generic, versioned, customer-provided file source.
Retiring or converging `import` is deferred and recorded in M9E.

### 11.6 Testing

S3-compatible server in Testcontainers (MinIO) with:

- synthetic CSV and JSON files covering malformed rows, BOM, quoted
  delimiters and header changes;
- duplicate and replayed files, and snapshots with and without manifest or
  marker;
- AssumeRole through an injected credential provider. A real AWS STS test is
  an optional live gate with an owner-provided sandbox role, never
  required for CI.

## 12. M9D — Warehouse / table source

- **Kind:** `warehouse_postgres` (reference dialect). **D10:** confirm
  PostgreSQL as the reference. Reasons:
  - it is testable in CI with Testcontainers at no cost;
  - it has standard `information_schema`;
  - it implies nothing about Juniper's stack (no Synapse assumption).

  Snowflake, BigQuery, Databricks, Fabric/Synapse and others are later
  **dialects** behind the same adapter contract.

- **Source pattern:** `schema → table/view → columns/types → profile → map →
sync`.
  - Config: host, port, database, schema, `objects[]`, TLS mode (`verify-full`
    required), credential name.
  - Each object declares `table|view`, `keyColumns`, optional
    `changeColumn` and an optional soft-delete column.
- **Query guard:** the adapter never executes caller-supplied SQL.
  - It builds parameterised `SELECT` statements from the discovered catalogue,
    with identifiers quoted from catalogue names only.
  - The session runs as a read-only user in a read-only transaction
    (`SET TRANSACTION READ ONLY`) with `statement_timeout`.
  - A guard refuses any statement not produced by the builder.
  - Proved by a test: a write attempt through the adapter fails before the
    driver.
- **Port mapping:**
  - **Discovery:** `information_schema.columns`; types map to the generic
    `SourceFieldType`, with the native type kept in `sourceType`.
  - **Pagination:** keyset on `keyColumns`.
  - **Incremental:** `changeColumn > since - overlap AND changeColumn <
boundary`.
  - **Count:** `count(*)` with the same predicate.
  - **Deletes:** soft-delete column → `flag`; otherwise `none`, and only the
    full-run tombstone pass with a proven count.
- **Dialect seam:** the dialect is internal to the adapter. It owns
  quoting, type mapping, keyset syntax, count and the read-only session
  setup. The contract tests run once per dialect.
- **Network:** customer warehouses are reached over TLS, from an
  allowlisted egress path. Private-link or VPC peering needs are documented
  per customer, outside M9.

## 13. Gates (Definition of Done per phase)

### 13.1 M9A — profiling gate

- The pure detectors pass §7.3 examples and property tests (§14).
- Profile runs persist only aggregates. A test scans stored documents and
  logs for seeded sensitive values (emails, card-like numbers, names from
  fixtures) and finds none.
- Mapping validation uses profiles (§9) with mutation proofs.
- Run-quality profiles and drift work on the Sugar fake with no Sugar code
  changes.
- Adversarial RLS tests on the three new tables.
- `pnpm verify`, runtime (new script `75-profiling.sh`), Docker and a fresh
  clone are green. Independent review passes.

### 13.2 M9B — Chargebee gate

- Scenarios CB01–CB22 pass against the fake.
- The connector-level read-only proof covers methods and denied endpoint
  families.
- The double-enumeration proof works, with a mutation proof (or D6 resolved
  otherwise).
- Authority with Chargebee holding all three facts behaves as in §10.5, and
  a split assignment is refused.
- Interim canonical check (§13.5 checklist) passes.
- **LIVE CHARGEBEE VERIFICATION** is separate: PENDING until the test-site
  evidence is recorded.

### 13.3 M9C — file-source gate

- Snapshot and incremental modes, ledger, replay and duplicate handling,
  malformed thresholds and file schema drift pass on MinIO.
- The command allowlist proof passes, and AssumeRole is the preferred path.
- No tombstones without a proven complete snapshot (mutation proof).

### 13.4 M9D — warehouse gate

- Discovery, profile, map and sync work on PostgreSQL: keyset, incremental,
  count proof, soft deletes.
- The query guard proof passes, and the read-only session is verified.
- Dialect contract tests pass.

### 13.5 M9E — canonical architecture review gate

An **independent** reviewer, not the implementer, answers each question with
evidence:

| Question                                                                         | Evidence required                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Did Account / Person / Product / Subscription / Eligibility stay source-neutral? | `git diff 375fadb..HEAD -- apps/api/src/modules/domain/{company,person,product,subscription,eligibility}.ts` and the canonical Prisma models: no source-specific fields or enum values.                                                                                                |
| Did source-specific behaviour stay at connector/mapping edges?                   | dependency-cruiser rules (extended per adapter) green; grep for `chargebee`, `s3`, `warehouse` outside adapter modules, catalogue entries and configuration finds nothing.                                                                                                             |
| Were custom canonical columns avoided?                                           | Migrations since `375fadb` add no column to canonical tables (`companies`, `persons`, `tenant_subscriptions`, products), only source, profile and ledger tables.                                                                                                                       |
| Did authority, coverage, provenance and unknown semantics stay safe?             | The authority fact set is unchanged; `cross_source_unsupported` is still enforced; each new full-read proof has a mutation test; provenance rows from each new kind carry connection and mapping version; `unknown` scenarios (CB08, CB09, file `none` proof) never yield `not_owned`. |
| Do all four sources go through the same single writers?                          | The behavioural single-writer test (M8 closure) runs per new kind.                                                                                                                                                                                                                     |
| Is profiling advisory?                                                           | Tests prove no suggestion ever writes a mapping or authority version.                                                                                                                                                                                                                  |

The outcome is recorded in `M09E-…md`. A "fail" on any row returns the
offending phase to design. M9 completes only when M9E passes.

## 14. Testing strategy

- **Pure (unit/property):**
  - classifiers over generated values (fast-check): JSON-encoded versus
    native versus delimited, boolean tokens, date shapes including impossible
    dates, number locales, empty versus null, whitespace;
  - accumulator merge associativity (pages in any order give the same
    profile);
  - suggestion thresholds at their boundaries;
  - drift rules;
  - safe-category suppression;
  - sensitive detectors (Luhn, email, phone, IBAN).
- **Integration (real PostgreSQL, app role, RLS):**
  - profile runs end to end on the Sugar fake (no Sugar change) and later on
    each new fake;
  - mapping validation with profiles;
  - acknowledgement persistence;
  - adversarial RLS for every new table;
  - the behavioural single-writer test per kind.
- **Contract tests per adapter:** the same port contract suite (schema
  normalisation, pagination, selection modes, read-only guard, error
  classification) runs against the Sugar, Chargebee, file and warehouse
  fakes.
- **Runtime scripts:** `75-profiling.sh`, `80-chargebee.sh`,
  `85-s3-files.sh`, `90-warehouse.sh`. Real CLIs, a dedicated worker, fakes
  or containers, and output scanned for values and secrets.
- **Docker:** each new processor registered (using the wait-based check
  from the M8 closure) and each CLI working inside the image.
- **Fresh clone** per phase, as always.

## 15. Mutation and failure tests (each must fail for the stated reason)

| Mechanism broken                                                  | Expected failing test                          |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| Safe-category rule bypassed (values stored for a sensitive field) | privacy scan of profile documents              |
| Sensitive detector disabled                                       | `sensitive_values_detected` test; privacy scan |
| Empty string counted as null                                      | `empty_string_vs_null` classifier test         |
| JSON-encoded array classified as plain string                     | §7.3 examples                                  |
| `1/0` treated as boolean without the two-value rule               | boolean suggestion boundary test               |
| Ambiguous dates reported as high-confidence `date`                | date suggestion test                           |
| Profile requirement skipped at publish (if D5 approved)           | mapping publish integration test               |
| Acknowledgement not required for consequential findings           | publish integration test                       |
| Profile documents mutable                                         | immutability test (refuse-change trigger)      |
| RLS removed / permissive policy on profile tables                 | adversarial RLS spec                           |
| `profile` purpose reads unselected fields                         | adapter contract test (requested fields only)  |
| Chargebee guard allows POST, or a payment endpoint                | connector-level read-only proof                |
| Chargebee boundary keeps undeclared fields                        | boundary minimisation test                     |
| Double enumeration ignores a mid-read insert                      | CB15                                           |
| Split authority (Sugar lines, Chargebee state) accepted           | authority validation test                      |
| Unmapped Chargebee status becomes `active`                        | CB09                                           |
| File replay ingested twice                                        | ledger test                                    |
| Tombstones in incremental or unproven file snapshots              | file tombstone test                            |
| Malformed threshold ignored                                       | malformed rows test                            |
| S3 client allows `PutObject`                                      | command allowlist proof                        |
| Warehouse guard allows a non-builder statement / write            | query guard proof                              |
| Canonical column added for a source (M9E)                         | M9E evidence check (migration diff)            |

## 16. Migrations and ADRs (planned only; none created now)

- **M9A migration:** `tenant_source_profile_runs`,
  `tenant_source_profiles`, `tenant_source_profile_findings`. All with
  `tenant_id`, forced RLS, composite tenant FKs to connections and snapshots,
  immutability triggers on profiles and findings, size and secret-like-key
  CHECKs. Down-script refuses when data exists.
- **M9B migration:** `connector_kinds` row `chargebee`, nothing else
  (catalogue parity test).
- **M9C migration:** `connector_kinds` row `s3_files`;
  `tenant_source_files` ledger.
- **M9D migration:** `connector_kinds` row `warehouse_postgres`.
- **ADRs:**
  - 0022 source data profiling (privacy, detection, findings, drift,
    advisory status);
  - 0023 full-read proofs beyond count (`double_enumeration`, `manifest`);
  - 0024 Chargebee reference adapter (incl. the authority answer and the
    matching deferral);
  - 0025 file/object-store source;
  - 0026 warehouse/table source and the dialect seam;
  - an ADR 0020 "as built (M9)" note for the port additions.

## 17. Security and RLS requirements (all phases)

- Every new table: `tenant_id`, forced RLS policy `tenant_isolation`,
  composite tenant keys, tenant-immutability trigger, adversarial raw-SQL
  tests (SELECT/INSERT/UPDATE/DELETE/FK hijack) and schema-guard coverage.
- Profile, finding and ledger documents carry no secrets or raw record values
  beyond §6.3. Enforced by CHECK plus a privacy-scan test.
- **Credentials:**
  - Chargebee API key, S3 fallback access keys and warehouse password via
    SecretProvider (credential names in config only).
  - AssumeRole uses a platform base identity plus a per-tenant role ARN and
    external id (non-secret).
  - The owner sets variables; nothing is requested in chat.
- **Read-only enforcement per adapter**, proved at connector level:
  - HTTP method + endpoint allowlist (Chargebee);
  - SDK command allowlist (S3);
  - statement builder + read-only transaction (warehouse).
- No production writes to any customer system. No live connection is
  enabled for real customer data without its live gate and business
  confirmation.

## 18. Observability requirements

- **Metrics** (labels are codes only):
  - `lip_profile_runs{kind,status}`;
  - `lip_profile_findings{kind,object,code}`;
  - `lip_profile_drift{kind,code}`;
  - `lip_profile_rows{kind}`;
  - `lip_source_files{kind,status}`;
  - `lip_source_records{kind,object,outcome}` (existing) for new kinds;
  - `lip_full_read_proof{kind,method,outcome}`.
- **Logs:** run ids, correlation ids, codes and counts only. A runtime script
  scans for fixture values and secrets per phase.
- **Reports:** `sources:report` gains a profile summary (latest profile age,
  open findings by severity, drift since last run) per connection.

## 19. Performance considerations

- **Profiling cost:**
  - one pass, O(rows × profiled fields), constant memory per field;
  - exact distinct sets are capped (10k), then HLL;
  - length and quantile statistics use a fixed-size sketch;
  - row limit per run (D2).
- **Reads:**
  - profiles use the connector's own rate limiter and retries;
  - `double_enumeration` doubles list traversals. Acceptable at billing
    scale (tens of thousands of subscriptions; to verify per customer),
    documented as a cost.
- **Run-quality profiles** add CPU only (values are already in memory).
- **Files:** streaming parse (no whole-file buffering), SHA-256 computed while
  streaming, bounded concurrency per connection.
- **Warehouse:** keyset pagination with indexed key columns, count queries
  timed out by `statement_timeout`, page size bounded by
  `maxPageSize ≤ 1000`.
- **Carried constraints:**
  - tech debt 31 (in-memory seen ids for tombstones) and 37 (per-process
    rate limiter) apply to every new source;
  - large file or warehouse sources may need the streamed tombstone pass
    (tech debt 31) before they can hold `subscription_lines` at
    multi-million scale.

## 20. Risks

| Risk                                                                                          | Mitigation                                                                                         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| M9 grows into one uncontrolled milestone                                                      | Five gated phases with separate plans, records, PRs and reviews                                    |
| Profiling stores PII                                                                          | Aggregates-only model, exclusion lists, detectors, safe-category rule, privacy-scan test, RLS      |
| Operators treat suggestions as decisions                                                      | Suggestions never write mappings; consequential entries need confirmations and acknowledgements    |
| Chargebee facts differ from assumptions (count, deleted flag, read-only key, catalog version) | Mock first; every assumption listed (§10.2) and verified at the live gate before any reliance      |
| No full-read proof for Chargebee                                                              | D6 double enumeration; otherwise Chargebee cannot hold lines (stated explicitly)                   |
| Owner wants Sugar lines with Chargebee state                                                  | Explicitly unsupported without matching (§10.7); separate design gate                              |
| Composite item ids unstable                                                                   | Declared by the adapter, verified on the test site; duplicate ids fail the proof                   |
| File sources without completeness markers                                                     | `none` proof means no coverage and no tombstones; cannot hold lines                                |
| Warehouse network access into customer estates                                                | Out of M9 scope beyond TLS + read-only user; documented per customer                               |
| Port additions break Sugar                                                                    | Backward-compatible optional fields; the Sugar suite and runtime 70 must stay green in every phase |
| Roadmap confusion (old M9 versus new M9)                                                      | D1 owner decision; roadmap updated when M9A starts                                                 |

## 21. Deferred scope (explicit)

- Cross-source line matching (tech debt 32) and identity resolution across
  systems (M11 territory).
- Tenant attribute registry and canonical targets for multi-select/JSON data
  (design gate `e4fec65`).
- Parquet, Avro and compressed archives; deletion-file conventions for
  incremental files.
- Additional warehouse dialects (Snowflake, BigQuery, Databricks,
  Fabric/Synapse).
- Chargebee Product Catalog 1.0, the events API, webhooks and real-time
  sync.
- Run-blocking drift rules by default (D4 keeps them opt-in).
- Retiring or converging the M7 `import` kind.
- The former roadmap M9 scope (Sugar pipeline suppression context,
  Gainsight health/usage) → later milestone (D1).
- Any write to Chargebee, S3, a warehouse or any customer system.

## 22. Decisions requested from the owner / reviewer

| #   | Decision                                                                              | Recommendation                                                    |
| --- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| D1  | Redefine roadmap M9 as this plan; move the old M9 scope later                         | Approve                                                           |
| D2  | Profile row limit per connection (no default)                                         | Configure per connection; suggest 50,000                          |
| D3  | Profile retention (last N per object; purge path)                                     | N = 10; privileged audited purge                                  |
| D4  | Drift never blocks sync by default; opt-in blocking per consequential field           | Approve                                                           |
| D5  | Publishing a versioned mapping requires a covering profile                            | Approve (stronger than warnings)                                  |
| D6  | Full-read proof without count: `double_enumeration`                                   | Approve, subject to test-site verification                        |
| D7  | Chargebee product identity: item id (versus item price id)                            | Item id (product = item; price is commercial detail)              |
| D8  | External reference system for file rows: `s3_files` versus a declared upstream system | `s3_files` by default                                             |
| D9  | Malformed-row threshold for files (no default)                                        | Per object configuration; suggest 0.1%                            |
| D10 | Warehouse reference dialect: PostgreSQL                                               | Approve; first cloud dialect only after a customer confirms stack |
| D11 | Chargebee test site and read-only key (owner-provided, via SecretProvider)            | Needed only for the M9B live gate                                 |

## 23. Confirmation

Planning only. No code, migrations, adapters or fixtures were created. **M9
implementation has NOT started.** **LIVE SUGAR VERIFICATION: PENDING.** The
next step is independent architecture review of this plan, then owner
decisions D1–D11, then the M9A plan approval.
