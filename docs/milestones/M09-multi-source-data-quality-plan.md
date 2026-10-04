# Milestone 9 — Multi-source data quality and subscription validation (PLAN)

> **Status: PLAN FOR INDEPENDENT ARCHITECTURE REVIEW.** No code, no
> migrations, no Chargebee, S3 or warehouse work. M9 is split into five
> phases (M9A–M9E), each with its own plan approval, Definition of Done and
> gate. A phase starts only after the previous gate passes and the owner
> approves.
>
> **Revision 2 (2026-10-04)** incorporates the independent architecture
> review (verdict **PASS WITH REQUIRED PLAN CHANGES**): D2, D4, D5 and D6
> are modified and the non-blocking refinements are added. The changed
> sections are listed in §24.
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
   domain/profiling/ (classifiers,          ContextIngestionService /
   accumulators, findings, drift)  [M9A]    SubscriptionIngestionService [M6/M7]
```

- **New pure domain folder** `domain/profiling/`, exported through the
  domain index and covered by `domain-is-pure` unchanged. Planned files:
  - `classifiers.ts`: per-value classification (§7.1);
  - `accumulators.ts`: per-field accumulators with an associative merge;
  - `suggestions.ts`: interpretation suggestions (§7.2);
  - `findings.ts` and `drift.ts`: finding rules and drift comparison (§8);
  - `privacy.ts`: sensitivity classification and the safe-category gate (§6).

  No I/O and no vendor types; property-tested.

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

| Addition                                                                                    | Why                                                                                                                                                                                                                                                                           | Phase |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `ReadRequest.purpose: 'sync' \| 'preview' \| 'profile'`                                     | Profiling must read fields that are not mapped yet. M8's rule "the adapter reads only mapped fields" becomes "only mapped fields for `sync`; only fields selected in the profile request for `profile`". Adapters log the purpose code, never values.                         | M9A   |
| `ObjectCapabilities.fullReadProof: 'count' \| 'manifest' \| 'double_enumeration' \| 'none'` | M8 coverage needs `countRecords` before and after the read (`countOrRefuse`). Chargebee's list API probably has no count endpoint (to verify). Files can use a manifest; warehouses can count. The methods are **not** equal-strength: each maps to a guarantee tier (§10.6). | M9B   |
| `SourceField.nested?: 'array' \| 'object'` (metadata)                                       | Lets an adapter declare that a field is natively structured (Chargebee `subscription_items`, JSON files) so the profiler and validator treat it as a structure, not a string.                                                                                                 | M9A   |
| `SourceSchema` objects with `classification: 'derived'`                                     | An adapter may expose a flattened child object (`SubscriptionItems` from `Subscription.subscription_items[]`) with a stable composite id. Declared, never invented by the platform.                                                                                           | M9B   |

`double_enumeration` and `manifest` are new full-read proofs. They need
their own ADR text (§10.6) and mutation proofs, because they gate tombstones
and coverage.

**Sugar regression assertion.** The port additions are optional, but "Sugar
keeps working" must be proved, not assumed. An M9A test asserts that Sugar's
effective behaviour is unchanged:

- `capabilities()` and the per-object capabilities derived from
  `describeSchema` (pagination, change field, delete visibility, count,
  page size) equal the M8 values;
- the effective full-read proof is `count`, tier `externally_grounded`;
- `sync` reads still request exactly the mapped fields.

The Sugar adapter suite, the M8 sync suite and runtime script 70 pass
unchanged.

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
   - The row limit is within bounds (**D2**, bounded configuration):
     - **required per connection:** `profile.maxRows` must be set in the
       connection configuration before profiling is allowed. There is no
       implicit default; a request on a connection without it is refused
       (`profile_limit_unset`);
     - **platform minimum:** 1,000 rows per object (planning value). A lower
       configured value is refused at configuration time, because smaller
       samples make the findings unreliable;
     - **platform maximum (hard safety ceiling):** 250,000 rows per object
       per run (planning value), enforced in code whatever the
       configuration says. Raising it is a code change with an ADR note;
     - **suggested planning value:** 50,000 rows;
     - **effective limit:** the lower of the request and the connection
       value. A request above the connection value, or a connection value
       outside [minimum, maximum], is **refused**
       (`profile_limit_out_of_range`), never silently clamped;
     - **companion ceilings** (planning values, also enforced in code):
       ≤ 500 profiled fields per object, ≤ 60 minutes wall-clock per run.
       Reaching either fails the run `profile_limit_reached`, and nothing
       partial is published.
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

The gate is compound, so it gets **exact boundary tests** for each condition
on its own and in combination (§14):

- distinct count 50 passes, 51 suppresses (an undeclared field);
- distinct/present 0.05 passes, just above suppresses;
- value length 64 passes, 65 suppresses;
- one value failing a PII or identifier detector suppresses the **whole**
  field, not just that value;
- a sensitive or excluded field suppresses even when every other condition
  passes;
- a declared enum passes the cardinality condition but still suppresses on
  any other failing condition.

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

### 8.2 Classification of findings and drift (D4)

Every finding and drift code has exactly one classification:

- **A: advisory.** Reported (finding, metric, report). It never blocks
  publish or a run. On a consequential field it may need a recorded
  acknowledgement at publish (§9), which is a human decision, not a block on
  the data path.
- **E: blocking because an existing M8/M9 mechanism already fails closed.**
  M9 adds no new guard, and the existing mechanism is named and covered by a
  test.
- **B: blocking by default because no other safety mechanism exists.** New
  M9 guard; fails closed.

Two families are kept apart:

- **Structural drift** can invalidate identity or mapping semantics. It is
  E or B.
- **Business-quality drift** (null ratios, categories, cardinality, volumes)
  describes data quality. It is A unless an operator promotes it (opt-in
  below).

**Why some structural changes need new guards.** M8 handles a bad row row by
row: a rejected row is counted and is not added to the run's holdings. The
full-run tombstone pass would then remove the existing line of every such
row. So a field that silently stops carrying identity or comparable values
is **not** safe in M8 unless the schema itself changed. M9's B guards run
**before any write** (a pre-write check on the first page of each mapped
object) and again **before the tombstone pass and coverage** (the run's
run-quality profile, §8.3). A run that trips them fails without tombstones
and without establishing coverage. Writes already made are idempotent
upserts of rows that passed.

#### Structural drift (identity and mapping semantics)

| Code                                                                                                        | Trigger                                                                                                                                                                                                                          | Class | Mechanism                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mapped_object_removed`, `mapped_field_removed`, `mapped_field_type_changed`, `relationship_target_changed` | Schema (metadata) change on the mapped surface                                                                                                                                                                                   | E     | M8 schema drift check at run start; nothing written (existing tests)                                                                                                                                                                                        |
| `enum_option_removed` (used in a value map or holding filter)                                               | A mapped enum option disappears from the schema                                                                                                                                                                                  | E     | M8 schema drift (blocking when used)                                                                                                                                                                                                                        |
| `identity_field_absent`                                                                                     | Data-level disappearance of an identity field: the record id field or a mapping identity/reference field (account, product, parent) is declared but empty or null in any record of the read                                      | **B** | New pre-write and pre-tombstone guard; fails closed. Identity disappearance must never reach the tombstone pass                                                                                                                                             |
| `profile_drift_type_incompatible`                                                                           | The observed dominant type of a consequential mapped field changes to an incompatible one (date → non-date text; number → text with letters; scalar → array or object; boolean → free text) while the declared type is unchanged | **B** | New guard. M8 refuses only _declared_ type changes (`mapped_field_type_changed`, and `unsupported_source_type` at publish); observed changes under an unchanged declared type (CSV/JSON strings, free-text fields holding dates) are caught by nothing else |
| `profile_drift_representation` (consequential field whose mapping depends on representation)                | A new representation ≥ 1% on a field with an explicit date format, a value map or list parsing (e.g. ISO dates become D/M/Y)                                                                                                     | **B** | New guard: the declared format would misread or reject the values                                                                                                                                                                                           |
| `profile_drift_new_category` on a **holding-filter** field                                                  | A new value appears on the field a holding filter tests                                                                                                                                                                          | **B** | New guard. With an `in` filter a new value silently makes a real holding a non-holding, and the full run would tombstone it                                                                                                                                 |
| `profile_drift_type_compatible`                                                                             | A compatible change (integer → decimal; ISO date → ISO timestamp)                                                                                                                                                                | A     | —                                                                                                                                                                                                                                                           |
| `identifier_not_unique` on a line identity                                                                  | Duplicate source ids appear                                                                                                                                                                                                      | E     | M8 counts `duplicate_external_id` and the single writer keeps one row per source id (fixture 11). Blocking here would change M8 behaviour                                                                                                                   |
| `undeclared_field_in_data`, `field_absent_in_data` (not identity)                                           | Files and JSON: a column appears or a declared field is never present                                                                                                                                                            | A     | Mapped-surface removals are covered by M8 schema drift (E row above); identity absence by `identity_field_absent`                                                                                                                                           |

#### Business-quality drift and findings

| Code                                                                                                                                                                                                                                                                                                            | Trigger (planning thresholds; configurable per connection)                | Class                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile_drift_null_ratio`                                                                                                                                                                                                                                                                                      | absolute change ≥ 0.10 (non-identity fields; identity is the B row above) | A. Null dates give empty terms, and a null state gives `unknown` (M8 fails safe)                                                                                                                         |
| `profile_drift_new_category` on a **state** (value-mapped) field                                                                                                                                                                                                                                                | a new categorical value appears                                           | A. M8 `unmapped: unknown` makes the line `unknown`; opt-in blocking available                                                                                                                            |
| `profile_drift_new_category` (other fields)                                                                                                                                                                                                                                                                     | a new categorical value appears (safe-category fields only)               | A                                                                                                                                                                                                        |
| `profile_drift_category_vanished`                                                                                                                                                                                                                                                                               | a previously frequent value (≥ 5%) disappears                             | A                                                                                                                                                                                                        |
| `profile_drift_cardinality`                                                                                                                                                                                                                                                                                     | cardinality class changes (low → high)                                    | A                                                                                                                                                                                                        |
| `profile_drift_row_count`                                                                                                                                                                                                                                                                                       | population change ≥ 20% between full profiles                             | A. Coverage relies on the full-read proof, not on volume                                                                                                                                                 |
| `profile_drift_parse_failures` (non-consequential field)                                                                                                                                                                                                                                                        | parse failure ratio up by ≥ 0.01                                          | A                                                                                                                                                                                                        |
| `profile_drift_type_distribution` (non-consequential field)                                                                                                                                                                                                                                                     | the dominant observed type changes, or a new type ≥ 1%                    | A                                                                                                                                                                                                        |
| `high_null_ratio`, `required_but_null`, `empty_string_vs_null`, `mixed_type`, `mixed_representation`, `malformed_json`, `invalid_date`, `ambiguous_date`, `number_locale`, `ambiguous_delimiter`, `leading_zero_numeric`, `declared_type_mismatch`, `value_not_in_declared_enum`, `high_cardinality_identifier` | profile findings at publish                                               | A, with acknowledgement when consequential (§9). Where a mapping depends on the field, §9 adds the publish-time rules (explicit date formats; identity uniqueness via existing `identity_unsuitable`, E) |
| `sensitive_values_detected`, `head_sample_biased`, `low_coverage_sample`                                                                                                                                                                                                                                        | privacy and sampling                                                      | A for the data path; privacy suppression is always applied before storage                                                                                                                                |

- **Opt-in promotion:** an operator may promote specific **A** codes to
  run-blocking for consequential fields, for example
  `profile_drift_new_category` on the mapped state field, so a new state
  value stops the run before writes instead of becoming `unknown`. The rule
  is recorded in the mapping version. Default: not blocking.
- **No demotion:** **E** and **B** classifications cannot be switched off by
  configuration.
- Schema drift (M8, metadata) and profile drift (M9, data) stay separate
  mechanisms. The E rows reuse M8's; the B rows are the only new blocking
  guards.

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
  1. **D5: a covering profile is required for consequential mapped
     fields.** Publishing a versioned mapping requires a completed profile
     for the mapping's snapshot. It must cover every object the mapping
     reads values from and every field whose **values** a consequential
     entry uses: identity, holding filter, state, terms, product and account
     references. Missing → `profile_required`.
     - **Exempt** (no profile needed for them):
       - entries of kind `ignored`;
       - entries stated as `explicit: unknown` or `explicit: null`;
       - entries that do not depend on source field values: declarations
         such as `productReferences.ignored`, a declared time zone or date
         format, or an all-holdings declaration.
     - **Emergency override, for profiling infrastructure outages only:**
       - It applies only to `profile_required`, and only when the latest
         profile run for that snapshot ended `failed` or `abandoned` with an
         infrastructure error code, or the profiling queue is unavailable.
         It cannot be used when a completed covering profile exists.
       - It requires an **authenticated operator** principal. The M9A plan
         must name the mechanism (authenticated API admin or CLI operator
         identity). If the CLI cannot prove identity, the override is
         API-only. A free-text actor name is not accepted.
       - It requires a **reason** (non-empty, bounded text, no secrets,
         checked).
       - It is **recorded** in the mapping version's `validation` document
         as `profileOverride {actor, reason, at, failedRunId?}`.
       - It is **never silent**: a warning log, metric
         `lip_profile_override_total{kind}`, and a flag on the version in
         `sources:report` and `mappings-show` until a covering profile
         completes.
       - It **grants no authority**: authority publication stays a separate,
         unchanged step.
       - It **bypasses nothing else**: every other schema, mapping,
         confirmation and finding-acknowledgement check runs as usual.
       - When a covering profile later completes, its findings are evaluated
         against that version and listed as `post_override_review_required`.
         The version stays published.
  2. For each consequential entry, open `review_required` findings on its
     field must be acknowledged in the publish request: finding id, reason
     code, actor. Missing → `finding_unacknowledged`. Acknowledgements are
     stored in `tenant_source_mapping_versions.validation`. The emergency
     override never replaces an acknowledgement.
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
   (consequential confirmations as in M8, plus acknowledgements). Only during
   a profiling outage: `--profile-override "<reason>"` by an authenticated
   operator (§9 item 1).
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

1. A **full-read proof** for Chargebee strong enough for coverage (§10.6),
   because `subscription_lines` authority needs coverage. With
   `double_enumeration` (tier `stable_snapshot`) that also requires the
   explicit acceptance and live-gate evidence in §10.6.
2. A confirmed **holding filter**, if not every subscription item is a
   holding. For example, `charge` items may be one-off, so the holding
   filter can be `item_type in (plan, addon)`. Alternatively they go in
   `productReferences.ignored`. This is a business decision.

### 10.6 Full-read proof methods and guarantee tiers (D6)

M8 refuses to establish coverage unless the source counts the bounded set
before and after the read. Chargebee may have no count endpoint. Files may
have a manifest or only a marker. The methods are **not** equal-strength
completeness guarantees, so each maps to a **guarantee tier** that the system
records and explains:

| Tier                  | Methods                                                                                                                                                               | What it proves                                                                                                                        | What it does **not** prove                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `externally_grounded` | `count` (M8: an independent source count before and after equals the records read); `manifest` (the producer declares files and row counts; parsed rows equal them)   | The read matches a total the source or producer **asserts** independently of the enumeration                                          | That the asserted total is itself correct (it is still the source's assertion)                                                                                                                |
| `stable_snapshot`     | `double_enumeration` (ids listed twice under a fixed boundary, identical sets, both traversals exhausted); file `success_marker` with identical before/after listings | The enumeration was **stable and exhausted** during the read: nothing was inserted, removed or moved under the boundary while reading | That the source exposed **every** record. API-side scoping (key permissions, sites, filters, soft-hidden records) would be invisible to both passes. It never claims independent completeness |
| `none`                | `none`                                                                                                                                                                | Nothing about completeness                                                                                                            | —                                                                                                                                                                                             |

**Rules (fail safe; never false whitespace or unsafe tombstones):**

- **`externally_grounded`:** may establish `subscription_lines` coverage and
  enable the full-run tombstone pass, exactly as M8 does with `count`.
- **`stable_snapshot`:** does **not** establish coverage by itself. It may
  establish coverage and enable tombstones for a connection only when all
  three hold:
  1. the adapter declares it for the object;
  2. the live gate recorded evidence that the list returns the full
     population for the configured credential, for example a one-off
     reconciliation against an operator-provided total;
  3. the authority version that assigns `subscription_lines` records an
     **explicit operator acceptance** of the `stable_snapshot` tier for that
     connection, with a reason.

  Otherwise the run may ingest, but coverage stays `unknown` and no
  tombstones run.

- **`none`:** never establishes coverage and never tombstones. The source
  cannot hold `subscription_lines`.
- A run whose proof fails (`unstable_read`, count or manifest mismatch,
  listing changed) establishes nothing and tombstones nothing (M8
  behaviour).

**Explainability:**

- Every run records `proof {method, tier, outcome}` in its quality document.
- The coverage explanation surfaced through eligibility checks and
  `sources:report` names the proof method and tier behind the current
  coverage, and the acceptance where the tier is `stable_snapshot`.
- **M9E evidence** lists the method and tier used per connection kind
  (§13.5).

**Chargebee:**

- Options considered:
  - `double_enumeration` (planned);
  - trusting a single exhausted traversal: rejected, weaker than M8 and
    unable to detect changes during the read;
  - events-API reconciliation: vendor-specific, deferred.
- The double-enumeration mutation proof: a record inserted between passes
  makes the run `unstable_read`.
- If Chargebee proves neither `count` nor an accepted `stable_snapshot`, it
  **cannot** hold `subscription_lines`, and therefore not state or terms
  either. It can still be profiled and preview-mapped.

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
  - `manifest` (tier `externally_grounded`): a manifest declares files and
    row counts; parsed rows must equal the declared counts;
  - `success_marker` (tier `stable_snapshot`): a marker object completes the
    snapshot prefix, and the proof is the file listing being identical
    before and after reading. Coverage and tombstones follow the
    `stable_snapshot` rules (§10.6);
  - `none` (tier `none`): no coverage, so **no tombstones**. Rows ingest, but
    the source cannot hold `subscription_lines`.
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
  stored.
- **Threshold (D9, ratio plus absolute counts; configured per object, no
  defaults).** A file fails (`malformed_rows_exceeded`, coverage not
  established) when either:
  - the ratio exceeds `maxRatio` **and** the count reaches `minCount`, so a
    single bad row in a tiny file does not fail it on ratio alone; or
  - the count reaches `maxCount` whatever the ratio, so a huge file cannot
    hide thousands of bad rows behind a small ratio.

  Planning values: `maxRatio` 0.1%, `minCount` 5, `maxCount` 1,000.

- Below the threshold, malformed rows are skipped, counted and reported as
  `record_rejected`. A skipped row's existing line is protected by the same
  pre-tombstone rule as other rejected rows (§8.2): a snapshot with any
  skipped rows does not tombstone the lines those rows would have carried.
  If a row cannot be attributed to a line, the run does not tombstone that
  object at all.
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
  changes, and the Sugar regression assertion (§4) passes.
- Every B guard in §8.2 has a test that fails closed (before writes, and
  before the tombstone pass and coverage).
- The D2 bounds and the D5 exemptions and override behave as specified,
  including refusal and audit tests.
- Adversarial RLS tests on the three new tables.
- `pnpm verify`, runtime (new script `75-profiling.sh`), Docker and a fresh
  clone are green. Independent review passes.

### 13.2 M9B — Chargebee gate

- Scenarios CB01–CB22 pass against the fake.
- The connector-level read-only proof covers methods and denied endpoint
  families.
- The double-enumeration proof works with a mutation proof, is recorded as
  tier `stable_snapshot`, and cannot establish coverage without the §10.6
  acceptance and live-gate evidence.
- Authority with Chargebee holding all three facts behaves as in §10.5, and
  a split assignment is refused.
- Interim canonical check (§13.5 checklist) passes.
- **LIVE CHARGEBEE VERIFICATION** is separate: PENDING until the test-site
  evidence is recorded.

### 13.3 M9C — file-source gate

- Snapshot and incremental modes, ledger, replay and duplicate handling,
  malformed thresholds and file schema drift pass on MinIO.
- The command allowlist proof passes, and AssumeRole is the preferred path.
- No tombstones without a proven complete snapshot (mutation proof). Proof
  tiers are recorded per run.
- The tech debt 31 scale check (§19) is in place before any file source may
  hold `subscription_lines`.

### 13.4 M9D — warehouse gate

- Discovery, profile, map and sync work on PostgreSQL: keyset, incremental,
  count proof, soft deletes.
- The query guard proof passes, and the read-only session is verified.
- Dialect contract tests pass.
- The tech debt 31 scale check (§19) is in place before any warehouse
  source may hold `subscription_lines`.

### 13.5 M9E — canonical architecture review gate

An **independent** reviewer, not the implementer, answers each question with
evidence:

| Question                                                                         | Evidence required                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Did Account / Person / Product / Subscription / Eligibility stay source-neutral? | `git diff 375fadb..HEAD -- apps/api/src/modules/domain/{company,person,product,subscription,eligibility}.ts` and the canonical Prisma models: no source-specific fields or enum values.                                                                                                                                                                                                                                                                        |
| Did source-specific behaviour stay at connector/mapping edges?                   | dependency-cruiser rules (extended per adapter) green; grep for `chargebee`, `s3`, `warehouse` outside adapter modules, catalogue entries and configuration finds nothing.                                                                                                                                                                                                                                                                                     |
| Is the canonical vocabulary business-neutral? (**manual review**, not only grep) | The reviewer lists every canonical field, enum value and code added or changed since `375fadb` and checks each name is business-neutral: no vendor terms (`item_price`, `rli`, `sugar_*`, `chargebee_*`) and no billing-system states (`non_renewing`, `paused`, `in_trial`) in canonical enums. `SubscriptionState` is unchanged. Each item carries a written rationale.                                                                                      |
| Were custom canonical columns avoided?                                           | Migrations since `375fadb` add no column to canonical tables (`companies`, `persons`, `tenant_subscriptions`, products), only source, profile and ledger tables.                                                                                                                                                                                                                                                                                               |
| Did authority, coverage, provenance and unknown semantics stay safe?             | The authority fact set is unchanged; `cross_source_unsupported` is still enforced; each new full-read proof has a mutation test; **the proof method and guarantee tier used per connection kind are listed**, and no `stable_snapshot` or `none` tier established coverage without the §10.6 conditions; provenance rows from each new kind carry connection and mapping version; `unknown` scenarios (CB08, CB09, file `none` proof) never yield `not_owned`. |
| Do all four sources go through the same single writers?                          | The behavioural single-writer test (M8 closure) runs per new kind.                                                                                                                                                                                                                                                                                                                                                                                             |
| Is profiling advisory?                                                           | Tests prove no suggestion ever writes a mapping or authority version.                                                                                                                                                                                                                                                                                                                                                                                          |

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
  - the safe-category gate, with exact boundary tests per condition and in
    combination (§6.3);
  - sensitive detectors (Luhn, email, phone, IBAN).
- **Integration (real PostgreSQL, app role, RLS):**
  - profile runs end to end on the Sugar fake (no Sugar change) and later on
    each new fake;
  - mapping validation with profiles;
  - acknowledgement persistence;
  - adversarial RLS for every new table;
  - the behavioural single-writer test per kind;
  - the Sugar regression assertion (§4);
  - the §8.2 B guards (identity absence, incompatible type,
    representation, holding-filter category) before writes and before the
    tombstone pass;
  - D2 bounds; D5 exemptions, override audit and refusals; proof-tier
    recording and coverage rules.
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

| Mechanism broken                                                  | Expected failing test                              |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| Safe-category rule bypassed (values stored for a sensitive field) | privacy scan of profile documents                  |
| Sensitive detector disabled                                       | `sensitive_values_detected` test; privacy scan     |
| Empty string counted as null                                      | `empty_string_vs_null` classifier test             |
| JSON-encoded array classified as plain string                     | §7.3 examples                                      |
| `1/0` treated as boolean without the two-value rule               | boolean suggestion boundary test                   |
| Ambiguous dates reported as high-confidence `date`                | date suggestion test                               |
| Profile requirement skipped at publish (if D5 approved)           | mapping publish integration test                   |
| Acknowledgement not required for consequential findings           | publish integration test                           |
| Profile documents mutable                                         | immutability test (refuse-change trigger)          |
| RLS removed / permissive policy on profile tables                 | adversarial RLS spec                               |
| `profile` purpose reads unselected fields                         | adapter contract test (requested fields only)      |
| Chargebee guard allows POST, or a payment endpoint                | connector-level read-only proof                    |
| Chargebee boundary keeps undeclared fields                        | boundary minimisation test                         |
| Double enumeration ignores a mid-read insert                      | CB15                                               |
| Split authority (Sugar lines, Chargebee state) accepted           | authority validation test                          |
| Unmapped Chargebee status becomes `active`                        | CB09                                               |
| File replay ingested twice                                        | ledger test                                        |
| Tombstones in incremental or unproven file snapshots              | file tombstone test                                |
| Malformed threshold ignored                                       | malformed rows test                                |
| S3 client allows `PutObject`                                      | command allowlist proof                            |
| Warehouse guard allows a non-builder statement / write            | query guard proof                                  |
| Canonical column added for a source (M9E)                         | M9E evidence check (migration diff)                |
| Safe-category gate off by one (51 distinct / 65 characters pass)  | safe-category boundary tests                       |
| `identity_field_absent` guard removed                             | identity-absence test (no tombstones, no coverage) |
| Incompatible observed type change not blocking                    | type-incompatibility guard test                    |
| New holding-filter category not blocking                          | holding-filter drift test                          |
| Profile row ceiling not enforced (or values silently clamped)     | D2 bounds test                                     |
| Profile override accepted without authenticated actor or reason   | override refusal test                              |
| Override used to skip finding acknowledgements or grant authority | override scope test                                |
| Exempt entries (ignored/explicit) still demand a profile          | D5 exemption test                                  |
| `stable_snapshot` establishes coverage without acceptance         | proof-tier coverage test                           |
| Proof tier missing from coverage explanation                      | coverage explanation test                          |
| Malformed `maxCount` ignored for large files                      | malformed threshold test                           |
| Scale check bypassed for large `subscription_lines` sources       | authority scale-check test                         |
| Sugar effective capabilities changed by the port additions        | Sugar regression assertion                         |

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
  - 0023 full-read proof methods and guarantee tiers (`externally_grounded`,
    `stable_snapshot`, `none`; coverage and tombstone rules; explainability);
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
- **Explicit scale check (tech debt 31) before large M9C/M9D
  `subscription_lines` authority.**
  - Publishing an authority version that gives `subscription_lines` to a
    file or warehouse connection first estimates the line population, from
    the latest full profile, count or manifest.
  - It refuses (`scale_requires_streamed_tombstones`) when the estimate
    exceeds a configured ceiling. Planning value: 1,000,000 lines, or an
    estimated in-memory seen-id set above 256 MiB.
  - The refusal holds until tech debt 31 is resolved. The check and its
    estimate are recorded in the authority version.

## 20. Risks

| Risk                                                                                          | Mitigation                                                                                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| M9 grows into one uncontrolled milestone                                                      | Five gated phases with separate plans, records, PRs and reviews                                              |
| Profiling stores PII                                                                          | Aggregates-only model, exclusion lists, detectors, safe-category rule, privacy-scan test, RLS                |
| Operators treat suggestions as decisions                                                      | Suggestions never write mappings; consequential entries need confirmations and acknowledgements              |
| Chargebee facts differ from assumptions (count, deleted flag, read-only key, catalog version) | Mock first; every assumption listed (§10.2) and verified at the live gate before any reliance                |
| No full-read proof for Chargebee                                                              | D6 double enumeration; otherwise Chargebee cannot hold lines (stated explicitly)                             |
| A weaker proof is mistaken for completeness                                                   | Guarantee tiers (§10.6); `stable_snapshot` needs acceptance and evidence; tier shown in explanations and M9E |
| Silent identity or type breakage removes real lines at the tombstone pass                     | §8.2 B guards before writes and before the tombstone pass                                                    |
| Owner wants Sugar lines with Chargebee state                                                  | Explicitly unsupported without matching (§10.7); separate design gate                                        |
| Composite item ids unstable                                                                   | Declared by the adapter, verified on the test site; duplicate ids fail the proof                             |
| File sources without completeness markers                                                     | `none` proof means no coverage and no tombstones; cannot hold lines                                          |
| Warehouse network access into customer estates                                                | Out of M9 scope beyond TLS + read-only user; documented per customer                                         |
| Port additions break Sugar                                                                    | Backward-compatible optional fields; the Sugar suite and runtime 70 must stay green in every phase           |
| Roadmap confusion (old M9 versus new M9)                                                      | D1 owner decision; roadmap updated when M9A starts                                                           |

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
- Run-blocking defaults for **business-quality** drift. D4 keeps those
  opt-in; structural drift is E/B per §8.2.
- Compound and composite-key detection in profiling (e.g. a pair of columns
  that is unique together). Future profiling work; M9 detects single-field
  identifiers only.
- Retiring or converging the M7 `import` kind.
- The former roadmap M9 scope (Sugar pipeline suppression context,
  Gainsight health/usage) → later milestone (D1).
- Any write to Chargebee, S3, a warehouse or any customer system.

## 22. Decisions (status after the independent architecture review)

| #   | Decision                                                                              | Review outcome                    | Plan wording now                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Redefine roadmap M9 as this plan; move the old M9 scope later                         | **APPROVE**                       | Roadmap and README updated when M9A starts                                                                                                                                                       |
| D2  | Profile row limit                                                                     | **MODIFY**                        | Required per connection; platform minimum 1,000; hard ceiling 250,000 per object per run; planning value 50,000; out-of-range refused, never clamped (§5.3)                                      |
| D3  | Profile retention (last N per object; purge path)                                     | **APPROVE**                       | N = 10; privileged audited purge                                                                                                                                                                 |
| D4  | Drift and finding classification                                                      | **MODIFY**                        | Every code is A / E / B (§8.2); identity disappearance and incompatible observed type changes fail closed; business-quality drift advisory with opt-in promotion; no demotion of E/B             |
| D5  | Covering profile before publish                                                       | **MODIFY**                        | Required for consequential value-dependent entries; ignored/explicit/value-independent entries exempt; audited, authenticated, non-silent emergency override for profiling outages only (§9)     |
| D6  | Full-read proof without count                                                         | **MODIFY**                        | Guarantee tiers `externally_grounded` / `stable_snapshot` / `none`; `double_enumeration` = `stable_snapshot`, coverage only with evidence and explicit acceptance; tier always explained (§10.6) |
| D7  | Chargebee product identity: item id versus item price id                              | **VERIFY LIVE FIRST**             | Item id stays the **proposal only**. Decided after test-site evidence on the item ↔ item-price structure (multiple prices per item, currencies, periods); nothing is locked in code before then  |
| D8  | External reference system for file rows: `s3_files` versus a declared upstream system | **APPROVE**                       | `s3_files` by default                                                                                                                                                                            |
| D9  | Malformed-row threshold for files                                                     | **APPROVE WITH MINOR REFINEMENT** | Ratio **and** absolute counts (`maxRatio`, `minCount`, `maxCount`), configured per object, no defaults; planning 0.1% / 5 / 1,000 (§11.4)                                                        |
| D10 | Warehouse reference dialect: PostgreSQL                                               | **APPROVE**                       | First cloud dialect only after a customer confirms their stack                                                                                                                                   |
| D11 | Chargebee test site and read-only key (owner-provided, via SecretProvider)            | **APPROVE**                       | Needed for the M9B live gate (and for D7)                                                                                                                                                        |

## 23. Confirmation

Planning only. No code, migrations, adapters or fixtures were created. **M9
implementation has NOT started.** **LIVE SUGAR VERIFICATION: PENDING.** The
next step is independent re-review of this revision, then approval of the
detailed M9A plan.

## 24. Revision 2 change log (independent architecture review)

| Section  | Change                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Header   | Revision note                                                                                                                                |
| §3       | Pure logic organised under `domain/profiling/`                                                                                               |
| §4       | Proof methods are not equal-strength (tiers); Sugar regression assertion; fixed the §10.6 reference                                          |
| §5.3     | **D2** bounded row limits (required, minimum, hard ceiling, planning value, refusal instead of clamping, companion ceilings)                 |
| §6.3     | Exact boundary tests for the compound safe-category gate                                                                                     |
| §8.2     | **D4** rewritten: A / E / B classification of every finding and drift code; structural versus business-quality drift; new fail-closed guards |
| §9, §9.1 | **D5** exemptions and the audited emergency override                                                                                         |
| §10.5    | Coverage prerequisite tied to proof tiers                                                                                                    |
| §10.6    | **D6** rewritten: guarantee tiers, coverage and tombstone rules, explainability                                                              |
| §11.2    | File proofs mapped to tiers                                                                                                                  |
| §11.4    | **D9** ratio plus absolute-count malformed thresholds; pre-tombstone protection for skipped rows                                             |
| §13      | Gates updated (B guards, D2/D5 tests, tiers, tech debt 31 check, M9E manual vocabulary review, tier evidence)                                |
| §14, §15 | New tests and mutation proofs                                                                                                                |
| §16      | ADR 0023 retitled to proof methods and guarantee tiers                                                                                       |
| §19      | Explicit tech debt 31 scale check before large `subscription_lines` authority                                                                |
| §20, §21 | New risks; composite-key detection deferred; drift defaults clarified                                                                        |
| §22      | Decision table with review outcomes                                                                                                          |
