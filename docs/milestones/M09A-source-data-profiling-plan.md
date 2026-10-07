# Milestone 9A — Source data profiling foundation (DETAILED PLAN)

> **Status: PLAN FOR INDEPENDENT REVIEW.** No code, no migrations, no
> production changes. M9A implementation has not started.
>
> - **Parent plan:** `docs/milestones/M09-multi-source-data-quality-plan.md`
>   (revision 3, verdict **PASS — M9 PLAN APPROVED**). This document details
>   M9A only. Where it refines the parent plan, the refinement is marked
>   **[refines M9 §x]**, with a reason.
> - **Baseline:** `main` @ `f0cee24`.
> - **Revision 2 (2026-10-07):** after the independent review (**PASS WITH
>   REQUIRED PLAN CHANGES**), A2 now classifies `operator_full_file` (M7 CSV
>   `import_full`) as `stable_snapshot`, not `externally_grounded` (§11.1,
>   §11.2, §11.3, §11.5, §12, §13, §17). Two non-blocking notes were added
>   (§14.5, §19).
> - **LIVE SUGAR VERIFICATION: PENDING** (unchanged).

## 0. Purpose and scope

M9A builds a reusable, vendor-neutral **profiling capability** between schema
discovery and mapping publication. It also builds the three safety mechanisms
the master plan places in M9A:

- the seen-but-rejected protection set;
- reviewed holding-filter domains;
- the structural coverage tier.

It must serve future sources without redesign:

- CRMs: Sugar, Salesforce, HubSpot;
- billing: Chargebee;
- files: S3 CSV/JSON;
- warehouses: PostgreSQL, Snowflake, BigQuery, Databricks, Fabric/Synapse.

Nothing in M9A is designed around Chargebee.

**In scope:**

- profiling: pure logic, service, persistence, queue, CLI;
- profile-aware mapping validation;
- run-quality profiles and drift guards;
- `seenButRejectedIds`;
- `reviewedDomain`;
- `coverageTier` through coverage and eligibility;
- the M9A migration;
- tests, mutation proofs, runtime script, Docker checks, fresh clone.

**Out of scope:**

- any new adapter: Chargebee (M9B), files (M9C), warehouse (M9D);
- the `double_enumeration` and `manifest` executors (M9B, M9C);
- canonical entity changes;
- authority fact changes;
- the attribute registry.

## 1. Architecture

### 1.1 Modules and files

| Location                                                         | Kind                       | Content                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/domain/profiling/`                                  | pure domain (new folder)   | `classifiers.ts` (§4), `accumulators.ts` (§3.3), `suggestions.ts` (§4.3), `privacy.ts` (§5), `findings.ts` (§8), `drift.ts` (§8), `document.ts` (Zod schema of the profile document, §3), `index.ts` (public surface) |
| `src/modules/domain/holding-domain.ts`                           | pure domain (new)          | `reviewedDomain` schema and runtime classification (§10)                                                                                                                                                              |
| `src/modules/domain/coverage.ts`                                 | pure domain (new)          | `CoverageTier`, `ProofMetadata`, `SubscriptionCoverage`, tier derivation (§11)                                                                                                                                        |
| `src/modules/domain/eligibility.ts`                              | pure domain (changed)      | `OwnershipInput` and `EligibilityResult` gain `coverageTier`; `deriveOwnership` tier rule; `EVALUATOR_VERSION = 3` (§11)                                                                                              |
| `src/modules/domain/source-mapping.ts`                           | pure domain (changed)      | Profile-aware validation inputs (§7); `reviewedDomain` validation (§10); explicit `parse_date.format` (master §9)                                                                                                     |
| `src/modules/domain/source-mapping-engine.ts`                    | pure domain (changed)      | Holding filter evaluated through `reviewedDomain`; new outcome `unreviewed_holding_value` (§10)                                                                                                                       |
| `src/modules/domain/source-connector.ts`                         | pure domain (changed)      | `ReadRequest.purpose`, `SourceField.nested` (optional, backward compatible)                                                                                                                                           |
| `src/modules/sources/application/source-profiling.service.ts`    | application (new)          | Request validation, run lifecycle, reads through the port, accumulation, persistence, findings, drift baseline                                                                                                        |
| `src/modules/sources/application/source-profiling.processor.ts`  | application (new)          | `source.profile` job handler on `lip-sources`                                                                                                                                                                         |
| `src/modules/sources/infrastructure/profiles.repository.ts`      | infrastructure (new)       | The four profile tables (§2), raw SQL only through `tenantClient(tx)`                                                                                                                                                 |
| `src/modules/sources/application/source-sync.service.ts`         | application (changed)      | Run-quality accumulators, B guards (§8), `seenButRejectedIds` (§9), proof metadata (§11)                                                                                                                              |
| `src/modules/sources/application/source-mappings.service.ts`     | application (changed)      | Loads the covering profile and passes it to the pure validator (§7); records acknowledgements and override attempts                                                                                                   |
| `src/modules/sources/application/source-authority.service.ts`    | application (changed)      | Proof-tier acceptances on authority versions (§11.4)                                                                                                                                                                  |
| `src/modules/products/infrastructure/subscription-runs.store.ts` | infrastructure (changed)   | `coverage()` returns `coverageTier` and `proof` (§11)                                                                                                                                                                 |
| `src/modules/products/application/eligibility.service.ts`        | application (changed)      | Passes the tier into `OwnershipInput`                                                                                                                                                                                 |
| `src/cli/sources.ts`                                             | CLI (changed)              | Profile commands (§1.4)                                                                                                                                                                                               |
| `scripts/verify-runtime.d/75-profiling.sh`                       | runtime verification (new) | §13.5                                                                                                                                                                                                                 |

### 1.2 Boundaries and dependency rules

- `domain/profiling/*`, `holding-domain.ts` and `coverage.ts` are covered by
  `domain-is-pure`: they import only the domain, `zod` and `node:crypto`.
- No vendor type or name appears in them. A test greps them for connector
  kind names.
- The profiling service reaches sources **only** through the
  `SourceConnector` port, via the existing adapter registry. It never
  imports an adapter (`sources-never-imports-concrete-adapters`, M8
  closure).
- `products` keeps not importing `sources` (`core-never-depends-on-sources`).
  The coverage tier reaches `products` through the shared domain types and
  the existing tables. `subscription-runs.store.ts` already reads
  checkpoints and authority versions.
- **New dependency-cruiser rule** `profiling-is-advisory`:
  `src/modules/domain/profiling/` must not import `source-authority.ts`,
  `source-mapping-engine.ts` or `eligibility.ts`. Suggestions can then never
  reach authority, ingestion or eligibility code directly. Proved by a
  mutation (§13.7).
- The single-writer rule is unchanged. Profiling writes only profile tables;
  the static scan and the behavioural single-writer test still pass.

### 1.3 Queue and job flow

- **Queue:** the existing `lip-sources`. **Job:** `source.profile`, payload
  `{v: 1, tenantId, runId, correlationId}`. The job carries ids only, never
  values.
- **Handler:** the existing sources processor dispatches by job name (one
  registration, so the Docker processor check is unchanged).
- **Concurrency:** at most one active profile run per connection (advisory
  lock on `(tenant, connection, 'profile')`), independent of sync runs.

  A profile run and a sync run may overlap. Both are read-only towards the
  source, and they share the per-connection rate limiter (tech debt 37
  applies).

- **Retries and failures:** a transient error retries like `source.sync`
  (backoff, `Retry-After`). An exhausted job marks the run `failed` and
  dead-letters through the M6 recorder.

  A retried attempt **restarts** the profile from the first page. The
  accumulators are rebuilt from scratch, so a profile is never a mix of
  attempts.

### 1.4 CLI and API surface

CLI only, in the same thin style as M8. There is no new HTTP API in M9A
(decision A1 explains the override consequence).

| Command                                                                                                                                                                | Effect                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sources profile-run --tenant T --kind K --objects A[,B] [--fields …] --sampling full\|systematic\|recent\|head [--max-rows N] [--include-excluded f1,f2] [--execute]` | Validates (dry run by default); `--execute` creates the run and enqueues `source.profile`                        |
| `sources profile-status --tenant T --kind K [--run ID]`                                                                                                                | Run lifecycle and counters                                                                                       |
| `sources profile-show --tenant T --kind K --object A [--profile ID]`                                                                                                   | The profile document (aggregates only)                                                                           |
| `sources profile-findings --tenant T --kind K [--object A] [--severity …]`                                                                                             | Findings with ids, codes and evidence                                                                            |
| `sources profile-drift --tenant T --kind K --object A`                                                                                                                 | Drift findings against the baseline                                                                              |
| `sources mappings-draft --tenant T --kind K --from-profile [--out file]`                                                                                               | Writes a **draft** mapping file. It never publishes, and consequential entries are left `explicit: unknown/null` |
| `sources mappings-publish … --ack <findingId>:<reasonCode> …`                                                                                                          | Existing publish, plus acknowledgements (§7.4)                                                                   |
| `sources profile-purge --tenant T --kind K --object A --keep 10` (owner credentials only)                                                                              | Privileged retention purge (§2.4)                                                                                |

Output contains ids, codes, counts and safe-category values only. The
runtime script scans it for fixture values and secrets.

### 1.5 Runtime lifecycle

1. `schema --capture`: snapshot (M8).
2. `profile-run`: validation (§6.2) → run `requested` → job → `running`.
3. Pages are read with purpose `profile` and folded into accumulators, then
   values are discarded.
4. Per object: the privacy pass runs (§5.5), then the document is built,
   findings computed and drift compared.
5. One transaction inserts the profiles and findings and marks the run
   `completed`.
6. Mapping validate/publish uses the covering profile (§7).
7. Every sync run:
   - builds run-quality accumulators over mapped fields;
   - applies the B guards before writes and before tombstones (§8);
   - fills `seenButRejectedIds` (§9);
   - records `proof` (§11);
   - stores the run-quality profile (`sampling.method = "sync"`) in the same
     completion transaction.

## 2. Persistence model (planned; created by the M9A migration, §15)

Every table follows ADR 0008:

- `tenant_id uuid NOT NULL` as the leading key column;
- `ENABLE` and `FORCE ROW LEVEL SECURITY`;
- policy `tenant_isolation` (`USING`/`WITH CHECK tenant_id =
app_current_tenant()`);
- composite tenant foreign keys;
- the tenant-immutability trigger `app_prevent_tenant_change` on mutable
  tables;
- default grants to `lip_app` as for other tenant tables, with
  schema-guard coverage.

### 2.1 `tenant_source_profile_runs` (mutable until terminal)

**Columns**

| Column                                    | Type            | Notes                                                                                                                                          |
| ----------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `id`                         | uuid, uuid      | PK `(tenant_id, id)`                                                                                                                           |
| `connection_id`                           | uuid            | FK `(tenant_id, connection_id)` → `tenant_source_connections`                                                                                  |
| `schema_snapshot_hash`                    | text            | FK `(tenant_id, connection_id, schema_snapshot_hash)` → `tenant_source_schema_snapshots`                                                       |
| `status`                                  | text            | CHECK in (`requested`, `running`, `completed`, `failed`, `abandoned`)                                                                          |
| `request`                                 | jsonb           | Objects, selected field names, excluded-field opt-ins (names + actor), sampling method, `maxRows`. Names only; secret-like-key CHECK; ≤ 64 KiB |
| `sampling`                                | jsonb, nullable | Rows read, population estimate, coverage ratio, per object. Set on completion                                                                  |
| `error_code`                              | text, nullable  | CHECK `^[a-z0-9_]{1,64}$`; required when `failed`/`abandoned`                                                                                  |
| `requested_by`, `correlation_id`          | text, uuid      | Actor format as M8 (`^[A-Za-z0-9_.:@-]{1,128}$`)                                                                                               |
| `created_at`, `started_at`, `finished_at` | timestamptz     | CHECK: terminal ⇔ `finished_at` set                                                                                                            |

**Rules and indexes**

- **State machine:** forward-only transitions, enforced in the repository
  and by a trigger. `requested → running → completed|failed|abandoned`,
  plus `requested → abandoned`. A terminal row is immutable
  (`app_refuse_change` once terminal).
- **Indexes:** `(tenant_id, connection_id, created_at DESC)`; a partial
  unique index `(tenant_id, connection_id) WHERE status IN ('requested',
'running')` (one active run per connection).

### 2.2 `tenant_source_profiles` (immutable)

**Columns**

| Column                    | Type           | Notes                                                                                                   |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `id`         | uuid, uuid     | PK `(tenant_id, id)`                                                                                    |
| `run_id`                  | uuid, nullable | FK `(tenant_id, run_id)` → profile runs. Null for run-quality profiles from sync runs                   |
| `sync_run_id`             | uuid, nullable | FK `(tenant_id, sync_run_id)` → `tenant_sync_checkpoints`. CHECK: exactly one of `run_id`/`sync_run_id` |
| `connection_id`, `object` | uuid, text     | FK to the connection; `object` matches the M8 object-name format                                        |
| `schema_snapshot_hash`    | text           | FK to the snapshot                                                                                      |
| `sampling_family`         | text           | CHECK in (`profile`, `sync`): drift compares within a family                                            |
| `previous_profile_id`     | uuid, nullable | FK to the same table: the drift baseline (same connection, object, family)                              |
| `document`                | jsonb          | §3. CHECK `octet_length(document::text) ≤ 1048576` and `NOT app_jsonb_has_secret_like_key(document)`    |
| `document_version`        | int            | CHECK `= 1` initially                                                                                   |
| `content_hash`            | text           | SHA-256 of the stable JSON of `document` (CHECK `^[0-9a-f]{64}$`)                                       |
| `created_at`              | timestamptz    |                                                                                                         |

**Rules and indexes**

- **Immutability:** `app_refuse_change('source profiles are immutable')` on
  UPDATE and DELETE, except the privileged purge (§2.4).
- **Indexes:** `(tenant_id, connection_id, object, sampling_family,
created_at DESC)` (baseline lookup); `(tenant_id, run_id)`;
  `(tenant_id, sync_run_id)`.
- **Uniqueness:** `(tenant_id, run_id, object)` and
  `(tenant_id, sync_run_id, object)` (partial unique indexes).

### 2.3 `tenant_source_profile_findings` (immutable)

**Columns**

| Column            | Type            | Notes                                                                                                                                                  |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant_id`, `id` | uuid, uuid      | PK                                                                                                                                                     |
| `profile_id`      | uuid            | FK `(tenant_id, profile_id)` → profiles                                                                                                                |
| `code`            | text            | CHECK against the closed code list (§8), mirrored in code with a parity test                                                                           |
| `class`           | text            | CHECK in (`advisory`, `existing_fail_closed`, `m9a_fail_closed`)                                                                                       |
| `severity`        | text            | CHECK in (`info`, `warning`, `review_required`)                                                                                                        |
| `object`, `field` | text, text null | Names only                                                                                                                                             |
| `evidence`        | jsonb           | Counts, ratios, sampling method and coverage, baseline profile id. ≤ 4 KiB; secret-like-key CHECK; never raw values except safe-category values (§5.4) |
| `created_at`      | timestamptz     |                                                                                                                                                        |

**Rules and indexes**

- Immutable (refuse-change trigger; the purge cascades in the same
  privileged transaction).
- **Indexes:** `(tenant_id, profile_id)`; `(tenant_id, code)`.
- **Limit:** ≤ 2,000 findings per profile, enforced in the service. Beyond
  that, one `findings_truncated` finding carries the count.
- **No acknowledgement column.** Acknowledgements live in the mapping
  version's `validation` document (§7.4), so findings stay immutable.

### 2.4 `tenant_source_profile_purges` (append-only audit; supports approved D3)

**Columns**

| Column                                         | Notes                |
| ---------------------------------------------- | -------------------- |
| `tenant_id`, `id`                              | PK                   |
| `connection_id`, `object`                      | FK to the connection |
| `kept`, `deleted_profiles`, `deleted_findings` | integers ≥ 0         |
| `actor`, `correlation_id`, `created_at`        | Actor format as M8   |

**Retention (D3: keep the last N = 10 per (connection, object, family)).**
Purging is the only deletion path, and it is privileged:

- It runs only from `sources profile-purge` with **owner (migration)
  credentials**, never the app role.
- It sets the transaction-local `lip.profile_purge = 'on'`. The
  refuse-change trigger allows DELETE only when that setting is on **and**
  `session_user` is not `lip_app`.
- It deletes profiles older than the N newest, with their findings, and
  writes one audit row in the same transaction.
- A profile still referenced as `previous_profile_id` by a kept profile, or
  as the covering profile of a published mapping version, is never deleted
  (`profile_referenced`, the purge skips it).
- Forced RLS applies (owner sessions set the tenant).

### 2.5 Changes to existing tables

| Table                              | Change                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_ownership_gaps`            | Reason CHECK extended with `observation_rejected`, `holding_filter_value_unreviewed`, `account_reference_orphaned` (§9, §10)                                                                                                                                                                                                                    |
| `tenant_source_authority_versions` | New column `proof_acceptances jsonb NOT NULL DEFAULT '[]'`: array of `{connectionId, tier: "stable_snapshot", reason, actor, at}`; CHECK shape, ≤ 16 entries, secret-like-key CHECK. Content hash **unchanged when empty** (hash parity with M8's SQL seed); when non-empty, the hash appends the stable JSON of the sorted acceptances (§11.4) |
| `tenant_sync_checkpoints`          | No column change. `quality` JSON gains `proof`, `seen_but_rejected`, `tombstones_suppressed` and B-guard codes (existing ≤ 16 KiB CHECK; size test)                                                                                                                                                                                             |
| `tenant_source_mapping_versions`   | No column change. `document` gains `reviewedDomain` and date formats; `validation` gains `acknowledgements`, `coveringProfileIds` and, if ever enabled, `profileOverride` (existing size CHECKs)                                                                                                                                                |
| `tenant_eligibility_snapshots`     | No column change. Frozen input (in `result`) and `factsHash` include `coverageTier`; `evaluator_version = 3`                                                                                                                                                                                                                                    |

## 3. Profile document schema (version 1)

### 3.1 Object level

```jsonc
{
  "v": 1,
  "object": "<port object name>",
  "connectionKind": "<kind>", // catalogue value, for display only
  "schemaSnapshotHash": "<sha256>",
  "sampling": {
    "method": "full|systematic|recent|head|sync",
    "rowsRead": 0,
    "populationEstimate": 0, // from countRecords when available, else null
    "coverage": 0.0, // rowsRead / populationEstimate, null when unknown
    "bounded": true, // the run hit maxRows before exhausting the population
    "stride": null, // systematic: k
    "orderedBy": null, // recent: change field name
  },
  "limits": { "maxRows": 0, "fieldsProfiled": 0, "distinctCap": 10000 },
  "fields": { "<fieldName>": {/* §3.2 */} },
}
```

### 3.2 Field level

| Key                | Content                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declared`         | `{type, sourceType?, required, unique, nested: null\|"array"\|"object", enumOptionCount}`: from the snapshot; enum **options are not copied** (the snapshot has them)                                |
| `sensitivity`      | `normal` \| `sensitive_by_name` \| `sensitive_by_value` \| `excluded_opt_in` (§5)                                                                                                                    |
| `counts`           | `{present, null, emptyString, whitespaceOnly}`; `present` counts every non-null value, including empty and whitespace strings                                                                        |
| `nullRatio`        | `null / rowsRead`; `emptyRatio` = `(emptyString + whitespaceOnly) / rowsRead` (separate, never merged)                                                                                               |
| `distinct`         | `{value, method: "exact"\|"estimate", capped}` over non-null, non-empty values (§14.2)                                                                                                               |
| `cardinalityClass` | `constant` (1) \| `low` (≤ 50 and ratio ≤ 0.05) \| `medium` \| `high` (ratio > 0.5) \| `unique` (ratio ≥ 0.99)                                                                                       |
| `observedTypes`    | Counts per class: `boolean`, `integer`, `decimal`, `date`, `timestamp`, `string`, `text`, `json_array`, `json_object`, `array`, `object`                                                             |
| `representations`  | Counts per representation code (§4.2), e.g. `boolean.native`, `boolean.token_true_false`, `date.iso`, `date.dmy`, `timestamp.iso_offset`, `list.json`, `list.delimited.comma`, `json.encoded_string` |
| `parseFailures`    | `{malformed_json, invalid_date, ambiguous_date, number_locale, leading_zero_numeric, ambiguous_delimiter}` counts                                                                                    |
| `length`           | `{min, p50, p95, max}` of string lengths (characters); `null` for non-strings                                                                                                                        |
| `range`            | Dates/timestamps: year buckets (month buckets when the span is < 2 years); numbers: decimal order-of-magnitude buckets with sign. **Never exact min/max values**                                     |
| `categorical`      | `{values: [{value, count}], suppressed: bool, reason: null\|code}`: only under the safe-category gate (§5.4)                                                                                         |
| `list`             | Only if list-shaped values occur: `{share, elements: {min, p50, max}, delimiter, elementTypes, elementDistinct, elementCategorical}` (element categorical values under the same gate)                |
| `json`             | Only if JSON objects occur: `{share, topLevelKeys: [names] \| {count, suppressed}, maxDepth}`; key names pass the secret-like-key test or are replaced by a count                                    |
| `suggestions`      | `[{interpretation, confidence: "high"\|"medium"\|"low", evidence: [codes]}]` (§4.3)                                                                                                                  |

Validation: `document.ts` defines the Zod schema. A document that fails it
is never persisted: the run fails with `profile_document_invalid`.

## 4. Detectors and classifiers (deterministic; no ML)

### 4.1 Per-value classification (first matching rule wins)

Input: one value as the adapter returns it. Strings are examined after a
copy is trimmed; the original is not stored.

| #   | Rule                                                                                                                                           | Class / representation                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `null` or `undefined`                                                                                                                          | `null`                                                                                                                                                                                             |
| 2   | `""`                                                                                                                                           | `empty_string`                                                                                                                                                                                     |
| 3   | string, `trim() === ""`                                                                                                                        | `whitespace_only`                                                                                                                                                                                  |
| 4   | JS boolean                                                                                                                                     | `boolean` / `boolean.native`                                                                                                                                                                       |
| 5   | JS number, `Number.isInteger`                                                                                                                  | `integer` / `integer.native`                                                                                                                                                                       |
| 6   | JS number, finite, non-integer                                                                                                                 | `decimal` / `decimal.native`                                                                                                                                                                       |
| 7   | JS array                                                                                                                                       | `array` / `list.native`; elements classified by rules 1–13 (depth 1 only)                                                                                                                          |
| 8   | plain object                                                                                                                                   | `object` / `object.native`; top-level key names recorded (§3.2)                                                                                                                                    |
| 9   | string starting with `[` or `{` after trim                                                                                                     | `JSON.parse` succeeds (≤ 64 KiB) → `json_array` or `json_object`, representation `json.encoded_string` (arrays also `list.json`); fails → `parseFailures.malformed_json`, then continue at rule 10 |
| 10  | string matching `^(true\|false)$`, `^(yes\|no)$`, `^(y\|n)$`, `^(t\|f)$` (case-insensitive)                                                    | `boolean` / `boolean.token_true_false`, `…_yes_no`, `…_y_n`, `…_t_f`                                                                                                                               |
| 11  | `^[+-]?\d+$`                                                                                                                                   | leading zero on > 1 digit → `string` / `string.leading_zero` (+ `parseFailures.leading_zero_numeric`); else `integer` / `integer.string`                                                           |
| 12  | `^[+-]?\d+\.\d+$`                                                                                                                              | `decimal` / `decimal.string`                                                                                                                                                                       |
| 12b | `^[+-]?\d{1,3}(\.\d{3})+,\d+$` or `^[+-]?\d+,\d+$`                                                                                             | `string` + `parseFailures.number_locale` (comma decimal: never a number)                                                                                                                           |
| 13  | ISO date `^\d{4}-\d{2}-\d{2}$`                                                                                                                 | calendar-valid → `date` / `date.iso`; invalid (e.g. `2025-02-30`) → `string` + `parseFailures.invalid_date`                                                                                        |
| 13b | ISO timestamp `^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z\|[+-]\d{2}:?\d{2})?$`                                                  | valid → `timestamp` / `timestamp.iso_offset`, `…_z` or `…_naive`; invalid → `string` + `invalid_date`                                                                                              |
| 13c | `^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$`                                                                                                        | first > 12 → `date.dmy`; second > 12 → `date.mdy`; both ≤ 12 → `string` + `parseFailures.ambiguous_date`; both > 12 or impossible → `string` + `invalid_date`                                      |
| 14  | contains `,`, `;` or `\|`; split on that delimiter gives ≥ 2 tokens; each trimmed token 1–64 chars with ≤ 1 internal space; empty tokens < 30% | `list.delimited.comma\|semicolon\|pipe`. If more than one delimiter qualifies, the one with the most tokens wins, ties broken comma < semicolon < pipe, and `ambiguous_delimiter` is counted       |
| 15  | otherwise                                                                                                                                      | length ≤ 255 → `string`; else `text`                                                                                                                                                               |

**Notes:**

- **Native integers are never timestamps.** Unix seconds and milliseconds
  are recognised only when the snapshot declares the field `datetime`/`date`
  and the integer is in range (`unix_s`: 1e9–1e10; `unix_ms`: 1e12–1e13).
- `1` and `0` are integers; only the field rule (§4.3) can count them as
  boolean evidence.
- Strings longer than 64 KiB skip rules 9–14 and are classified `text`
  (bounded work per value).

### 4.2 Representation and mixed-representation rules

- A field has **mixed types** when its second most frequent observed class is
  ≥ 1% of non-null values **and** at least 5 values (finding `mixed_type`).
- A field has **mixed representations** when one logical class (boolean,
  date, timestamp, list) appears in ≥ 2 representations, each ≥ 1% and at
  least 5 values (finding `mixed_representation`). Examples:
  `boolean.native` + `boolean.token_yes_no`; `date.iso` + `date.dmy`;
  `list.json` + `list.delimited.comma`.

### 4.3 Field-level suggestions (over non-null, non-empty values; n = that count)

| Suggestion            | Rule                                                                                                | Confidence                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `boolean`             | ≥ 99% of n are `boolean.*`, **or** the distinct integer set is exactly {0, 1}; distinct ≥ 2; n ≥ 20 | high: one representation; medium: mixed representations or the {0,1} rule                                                  |
| `single_select`       | scalar values; declared `enum`, **or** cardinality class `low`                                      | high: declared enum; medium: inferred                                                                                      |
| `multi_select`        | ≥ 95% of n list-shaped (native array, JSON array or delimited) and element distinct ≤ 50            | high: native/JSON; medium: delimited                                                                                       |
| `json_array`          | ≥ 95% `json_array`, not multi-select                                                                | high                                                                                                                       |
| `json_object`         | ≥ 95% `json_object` or native object                                                                | high                                                                                                                       |
| `date`                | ≥ 99% `date` in one representation                                                                  | high: `date.iso`; medium: `date.dmy`/`date.mdy`; low: any `ambiguous_date` present; never high with `mixed_representation` |
| `timestamp`           | ≥ 99% `timestamp`                                                                                   | high: with offset or `Z`; medium: naive                                                                                    |
| `integer` / `decimal` | ≥ 99% numeric of that class; any `leading_zero_numeric` excludes it                                 | high: native; medium: string                                                                                               |
| `identifier`          | cardinality ratio ≥ 0.99, **or** declared `id`/`unique`, **or** ≥ 99% identifier-like (§5.3)        | high                                                                                                                       |
| `free_text`           | cardinality class `high` and p50 length > 32                                                        | medium                                                                                                                     |

- If n < 20, no suggestion is above `low`.
- **Suggestions are technical only.** No suggestion names a canonical
  target, writes a mapping or reaches authority (`profiling-is-advisory`
  rule, §1.2).

## 5. Privacy and sensitivity model

### 5.1 Excluded fields (not profiled without an explicit, audited opt-in)

- **Names:** after lower-casing and removing separators, a field name
  containing `password`, `passwd`, `secret`, `token`, `apikey`, `card`,
  `cvv`, `iban`, `accountnumber`, `routing`, `ssn`, `taxid`, `nationalid`,
  `passport`, `dob`, `birth`.
- **Objects** the adapter classifies as payment-like (a new optional
  metadata flag, `sensitivity: "payment"`). No current adapter sets it;
  Chargebee will in M9B.
- **Opt-in:** `--include-excluded f` is recorded on the run with the actor.
  An opted-in field is profiled as `excluded_opt_in`: shape and counts only,
  never categorical values.

### 5.2 Sensitive by name (shape and counts only)

Names containing `email`, `mail`, `phone`, `mobile`, `fax`, `name`
(`firstname`, `lastname`, `fullname`), `address`, `street`, `postcode`,
`postal`, `zip`, `city`, `ip`, `url`, `website`, `linkedin`.

### 5.3 Sensitive by value (detectors)

Each detector runs on every string value (and stringified number).

| Detector        | Rule                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| email           | `^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$`                                                                                                                              |
| phone           | after removing spaces, `-`, `.`, `(`, `)`: `^\+?\d{7,15}$` **and** the original contains a separator or `+`, or has ≥ 10 digits                                         |
| card (Luhn)     | after removing spaces and `-`: `^\d{13,19}$` **and** Luhn-valid                                                                                                         |
| IBAN            | after removing spaces, upper-case: `^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$` **and** ISO 13616 mod-97 = 1                                                                        |
| identifier-like | UUID (`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, i); ≥ 12 consecutive digits; or 16–64 chars mixing letters and digits with no spaces |

- **Field becomes `sensitive_by_value`** when (email + phone + card + IBAN
  hits) ≥ 1% of n **or** ≥ 3 values. A finding `sensitive_values_detected`
  records counts per detector, never the values.
- Identifier-like hits make the field ineligible for categorical values
  (`categorical.suppressed`, reason `identifier_like`). They do not make it
  sensitive.
- **Luhn-positive non-card values.** 13–19 digit identifiers (order
  numbers, long account references) can pass Luhn by chance (~10%).
  Treatment: they count as card hits and suppress conservatively. False
  positives cost only suppression, never storage. Tests include known
  Luhn-valid non-card ids (e.g. a 16-digit order number constructed to pass
  Luhn) and assert suppression. That is accepted behaviour, not a bug.

### 5.4 Safe-category gate (the only raw values persisted)

A field's distinct values are stored with counts **only if all** hold:

1. sensitivity `normal`;
2. declared `enum`, **or** observed distinct ≤ 50 **and**
   distinct / n ≤ 0.05;
3. every distinct value has length ≤ 64 characters;
4. no value triggers the email, phone, card, IBAN or identifier-like
   detectors;
5. n ≥ 20 (otherwise `suppressed`, reason `too_few_values`; small samples
   re-identify).

Any failure suppresses **all** values of the field, with the first failing
reason code. Exact boundaries (unit tests, §13.1):

| Case                                                       | Expected                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| distinct = 50, ratio 0.05 (n = 1,000)                      | stored                                                                                                        |
| distinct = 51 (undeclared)                                 | suppressed `cardinality`                                                                                      |
| distinct = 50, n = 999 (ratio 0.05005)                     | suppressed `cardinality_ratio`                                                                                |
| declared enum with 300 options, 300 observed               | stored (declared enum bypasses condition 2 only)                                                              |
| a value of exactly 64 characters                           | stored                                                                                                        |
| a value of 65 characters                                   | suppressed `value_length`                                                                                     |
| one email among 49 status values                           | suppressed `pii_value`; field `sensitive_by_value` if the email-hit thresholds are met, else still suppressed |
| one Luhn-valid 16-digit order number among status values   | suppressed `pii_value`                                                                                        |
| field named `contact_status` (contains no sensitive token) | stored if other conditions hold                                                                               |
| field named `email_status` (contains `email`)              | suppressed `sensitive_name`, even with 3 harmless values                                                      |
| n = 19                                                     | suppressed `too_few_values`                                                                                   |

The same gate applies to list element values and to JSON key names (keys
also pass the secret-like-key test).

### 5.5 Suppression before persistence (guarantee)

- The document builder runs the privacy pass **after** accumulation and
  **before** serialisation. Accumulators hold at most 51 raw candidate
  values per field (and element), each ≤ 64 characters. Distinct counting
  uses 64-bit hashes (§14.2).
- The pass removes `categorical` values from every field failing §5.4, then
  validates the document with Zod.
- A second, independent check, `assertNoRawValues(document)`, re-runs all
  detectors over every string in the serialised document except field names
  and code strings. Any hit fails the run (`profile_privacy_violation`), and
  nothing is persisted.
- Raw values are never logged, queued, dead-lettered or written to a
  temporary file. Accumulators live only in the worker's memory for the run.
- **Mutation proofs:**
  - disabling the gate makes the privacy-scan test fail;
  - disabling `assertNoRawValues` while seeding a bypass makes the
    integration privacy scan fail.

## 6. Sampling model and limits

### 6.1 Methods

| Method       | Read pattern                                                                                                                    | Allowed when                                                                                                              | Recorded bias                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `full`       | Bounded full read (`selection: full` with a boundary) until exhausted or `maxRows`                                              | Always. Default when the population (count) ≤ `maxRows`                                                                   | none if not `bounded`; else `low_coverage_sample` finding when coverage < 0.5 |
| `systematic` | Offset pagination; every k-th page, k = ⌈population / maxRows⌉                                                                  | The object declares `pagination: offset` **and** `count: true`                                                            | `systematic_page_clusters` evidence code                                      |
| `recent`     | Ordered by the change field, newest first (selection `since` with a moving lower bound when the adapter cannot sort descending) | The object declares a `changeField`                                                                                       | `recency_bias` evidence code                                                  |
| `head`       | The first `maxRows` records in source order                                                                                     | Only when none of the above apply; `head_sample_biased` finding; **cannot cover consequential fields for publish** (§7.1) | `head_sample_biased` finding                                                  |

The service refuses a method the object's capabilities do not support
(`sampling_unsupported`). It never falls back silently.

### 6.2 Limits (approved D2; refuse, never clamp)

| Limit                                  | Value                                    | Enforcement                                                                                               |
| -------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Per-connection limit `profile.maxRows` | **required**; no implicit default        | Connection config validation; request refused `profile_limit_unset` when absent                           |
| Platform minimum                       | 1,000 rows per object                    | Connection config below → refused at configuration (`profile_limit_out_of_range`)                         |
| Platform maximum (hard ceiling)        | 250,000 rows per object per run          | Constant in code (changing it needs a code change + ADR note); config above → refused                     |
| Suggested planning value               | 50,000                                   | Documentation, and `sources configure` help text                                                          |
| Request `--max-rows`                   | must be ≤ connection value and ≥ minimum | Above or below → refused `profile_limit_out_of_range`; never clamped                                      |
| Fields per object                      | ≤ 500                                    | Request refused `profile_field_limit`; reaching it at runtime cannot happen (fields are fixed at request) |
| Wall clock per run                     | ≤ 60 minutes                             | Exceeded → run `failed` `profile_limit_reached`; nothing partial published                                |
| Memory budget per run                  | ≤ 128 MiB of accumulator estimate (§14)  | Estimated at request from fields × per-field bound; above → refused `profile_memory_budget_exceeded`      |

## 7. Mapping publication integration (designed now, implemented in M9A)

### 7.1 Covering profile

A profile set **covers** a mapping version when, for every **consequential,
source-value-dependent** entry, all of the following hold:

1. **Same schema:** the profile's `schema_snapshot_hash` equals the
   mapping's `validatedAgainst` snapshot, which M8 already requires to be
   the connection's latest.
2. **Completed:** the profile belongs to a `completed` run (`sampling_family
= profile`). Sync-family profiles do not count for publish.
3. **Field present:** the entry's source field was profiled. Not excluded
   without opt-in: an excluded consequential field → `profile_field_excluded`.
4. **Method:** sampling is not `head`.
5. **Freshness:** the run finished within **30 days** (planning value;
   configurable per connection between 1 and 90 days; outside → refused
   `profile_freshness_out_of_range`). Older → `profile_stale`.
6. **Coverage:** `sampling.coverage ≥ 0.5`, or the method was `full` and not
   `bounded`; otherwise `profile_low_coverage`, which is review_required and
   needs acknowledgement (§7.4).

**Consequential, source-value-dependent entries:**

- identity fields;
- account, product and parent reference fields;
- holding-filter fields;
- `subscription.state` value maps;
- `subscription.startsAt` / `endsAt`;
- `subscription.quantity`;
- profile fields under authority (`account_profile`, `person_profile`).

**Exempt** (no profile needed):

- entries of kind `ignored`;
- entries stated `explicit: null` or `explicit: unknown`;
- value-independent declarations: `productReferences.ignored`, declared
  time zone, declared date format, all-holdings declarations,
  `unmapped: unknown` policies.

Missing coverage → `profile_required` (publish refused). The covering
profile ids are recorded in `validation.coveringProfileIds`.

### 7.2 Profile/schema matching

- A covering profile must match the mapping's snapshot hash exactly.
- A new snapshot (any schema change) invalidates coverage for publishes
  against that snapshot. Already-published versions are unaffected; M8
  schema drift governs runs.

### 7.3 Publish-time profile checks (pure validator inputs)

| Check                                                                                                     | Result                                                                        |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Identity field with duplicates in the profile                                                             | `identity_unsuitable` (existing code; refused)                                |
| Date entry whose field has `ambiguous_date` or `mixed_representation` and no explicit `parse_date.format` | `date_format_required` (refused)                                              |
| Holding filter without a complete `reviewedDomain`                                                        | `holding_filter_domain_incomplete` (refused; §10)                             |
| Holding filter on a field without a declared enum or unsuppressed safe categorical domain                 | `holding_filter_domain_unknown` (refused)                                     |
| Observed categorical value not mapped by a state value map                                                | `observed_value_unmapped` (warning; `unmapped: unknown` keeps runtime safety) |
| Open `review_required` finding on a consequential field                                                   | `finding_unacknowledged` unless acknowledged (§7.4)                           |

### 7.4 Acknowledgements

- `--ack <findingId>:<reasonCode>`, with reason codes from a closed list:
  `accepted_known_issue`, `source_fix_pending`, `business_confirmed`,
  `not_applicable`.
- Stored in `validation.acknowledgements` as
  `[{findingId, code, reasonCode, actor, at}]`.
- An acknowledgement applies only to that mapping version.

### 7.5 Emergency profile-infrastructure override (D5) — decision A1

D5 requires an **authenticated operator**. **Verified fact:** M8's CLI takes
a free-text `--actor` (format-checked only, default `cli`), and there is no
sources HTTP API. So no authenticated operator channel exists today.

- **Decision A1 (recommended):** M9A implements the override's validation,
  scope and audit logic, but **ships it disabled**. Any `--profile-override`
  is refused with `override_requires_authenticated_operator`, and tests
  prove the refusal.
  - The override becomes available only in a later milestone that adds an
    authenticated operator channel (an authenticated admin API, or a CLI
    identity bound to a credential). That milestone re-reviews this section.
  - **Consequence:** during a profiling outage, publishing a mapping waits
    for profiling to recover. This fails closed, and mapping publishes are
    rare.
- **Alternative A1-b:** build a minimal authenticated admin endpoint in M9A.
  Not recommended: it adds an auth surface to a data-quality milestone.
- **Whichever is chosen, the D5 safeguards are fixed:**
  - only for `profile_required` caused by a `failed`/`abandoned` run with an
    infrastructure error code, or an unavailable queue;
  - authenticated operator;
  - reason (1–500 characters, secret-like checks);
  - recorded in `validation.profileOverride`;
  - warning log, metric `lip_profile_override_total{kind}`, and a flag in
    `mappings-show` and `report`;
  - no authority granted;
  - no other check bypassed, acknowledgements included;
  - `post_override_review_required` when a covering profile later
    completes.

## 8. Drift and findings — classification

**Classes:**

- **A: advisory.**
- **E: fail-closed by an existing M8 mechanism** (named).
- **B: fail-closed by an M9A guard.**

**E and B can never be disabled or demoted by configuration.** Only A codes
may be promoted (per consequential field, recorded in the mapping version).

B guards that use a threshold have **fixed thresholds in code**: they are
not configurable, and changing one needs an ADR note. Record-level B guards
have no threshold at all.

| Area                         | Code                                                                                                                                                                                                                                                                                                                                                                               | Trigger                                                                                                                                                                                                        | Class | Mechanism / where                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field removed                | `mapped_field_removed`, `mapped_object_removed`                                                                                                                                                                                                                                                                                                                                    | Schema no longer declares a mapped field or object                                                                                                                                                             | E     | M8 schema drift at run start; nothing written                                                                                                            |
| Declared type changed        | `mapped_field_type_changed`                                                                                                                                                                                                                                                                                                                                                        | Declared type of a mapped field changed                                                                                                                                                                        | E     | M8 schema drift at run start; M8 `unsupported_source_type` at publish                                                                                    |
| Relationship changed         | `relationship_target_changed`                                                                                                                                                                                                                                                                                                                                                      | Declared relation target changed                                                                                                                                                                               | E     | M8 schema drift                                                                                                                                          |
| Enum option removed          | `enum_option_removed` (used)                                                                                                                                                                                                                                                                                                                                                       | A mapped option disappears                                                                                                                                                                                     | E     | M8 schema drift (blocking when used)                                                                                                                     |
| Observed type changed        | `profile_drift_type_incompatible`                                                                                                                                                                                                                                                                                                                                                  | Consequential field: ≥ 50% of non-null values in a class incompatible with the mapping target (pre-write: first page with ≥ 20 values; pre-tombstone: whole run)                                               | B     | M9A guard in sync; run fails `type_incompatible` before writes or before tombstones/coverage                                                             |
| Observed type changed        | `profile_drift_type_compatible`                                                                                                                                                                                                                                                                                                                                                    | Compatible change (integer → decimal; date → timestamp)                                                                                                                                                        | A     | profile and run-quality findings                                                                                                                         |
| Observed type changed        | `profile_drift_type_distribution`                                                                                                                                                                                                                                                                                                                                                  | Non-consequential field: dominant class changes or a new class ≥ 1%                                                                                                                                            | A     | findings                                                                                                                                                 |
| Representation changed       | `profile_drift_representation`                                                                                                                                                                                                                                                                                                                                                     | Consequential field whose mapping depends on representation (explicit date format, value map, list parsing): ≥ 50% of values in a representation the mapping cannot read (same pre-write/pre-tombstone points) | B     | M9A guard; run fails `representation_incompatible`                                                                                                       |
| Representation changed       | `profile_drift_representation`                                                                                                                                                                                                                                                                                                                                                     | Any other field: a new representation ≥ 1%                                                                                                                                                                     | A     | findings                                                                                                                                                 |
| New category                 | `holding_filter_value_unreviewed`                                                                                                                                                                                                                                                                                                                                                  | A holding-filter value outside `reviewedDomain` (`in` or `not_in`), including empty/null if unclassified                                                                                                       | B     | **Record level, no threshold** (§10): record protected (§9), account gap, finding                                                                        |
| New category                 | `profile_drift_new_category` (state field)                                                                                                                                                                                                                                                                                                                                         | New value on a value-mapped state field                                                                                                                                                                        | A     | M8 `unmapped: unknown` makes the line `unknown`; opt-in promotion available                                                                              |
| New category                 | `profile_drift_new_category` (other)                                                                                                                                                                                                                                                                                                                                               | New value on any other safe-category field                                                                                                                                                                     | A     | findings                                                                                                                                                 |
| Category vanished            | `profile_drift_category_vanished`                                                                                                                                                                                                                                                                                                                                                  | Value with ≥ 5% share disappears                                                                                                                                                                               | A     | findings                                                                                                                                                 |
| Null-rate shift              | `profile_drift_null_ratio`                                                                                                                                                                                                                                                                                                                                                         | Non-identity field: absolute change ≥ 0.10                                                                                                                                                                     | A     | null dates → empty terms; null state → `unknown` (M8 fails safe)                                                                                         |
| Identity missing in data     | `identity_field_absent`                                                                                                                                                                                                                                                                                                                                                            | Identity or reference field null/empty in ≥ 50% of records (pre-write: first page with ≥ 20 records; pre-tombstone: whole run)                                                                                 | B     | M9A guard; run fails before writes or before tombstones/coverage. Below 50%, each affected record is protected individually (§9)                         |
| Cardinality shift            | `profile_drift_cardinality`                                                                                                                                                                                                                                                                                                                                                        | Cardinality class changes                                                                                                                                                                                      | A     | findings                                                                                                                                                 |
| Identity uniqueness          | `identifier_not_unique` (line identity)                                                                                                                                                                                                                                                                                                                                            | Duplicate source ids                                                                                                                                                                                           | E     | M8 `duplicate_external_id` counting, one row per source id (fixture 11); publish-time identity check (`identity_unsuitable`)                             |
| Holding-filter domain change | `enum_option_added` on a filter field                                                                                                                                                                                                                                                                                                                                              | Schema adds an option                                                                                                                                                                                          | B     | The option is not in `reviewedDomain`, so records carrying it fall under the record-level guard (§10). M8's non-blocking schema code stays informational |
| Holding-filter domain change | `enum_option_removed` on a filter field                                                                                                                                                                                                                                                                                                                                            | Option removed                                                                                                                                                                                                 | E     | M8 schema drift (blocking when used)                                                                                                                     |
| Volume                       | `profile_drift_row_count`                                                                                                                                                                                                                                                                                                                                                          | Population change ≥ 20% between full profiles                                                                                                                                                                  | A     | coverage relies on the proof, not on volume                                                                                                              |
| Parse failures               | `profile_drift_parse_failures`                                                                                                                                                                                                                                                                                                                                                     | Ratio up ≥ 0.01                                                                                                                                                                                                | A     | consequential parse failures are covered per record (§9) and by the B guards above                                                                       |
| Publish-time quality         | `high_null_ratio`, `required_but_null`, `empty_string_vs_null`, `mixed_type`, `mixed_representation`, `malformed_json`, `invalid_date`, `ambiguous_date`, `number_locale`, `ambiguous_delimiter`, `leading_zero_numeric`, `declared_type_mismatch`, `value_not_in_declared_enum`, `high_cardinality_identifier`, `undeclared_field_in_data`, `field_absent_in_data` (non-identity) | Profile findings                                                                                                                                                                                               | A     | `review_required` when consequential (acknowledgement §7.4); §7.3 refusals where a mapping depends on them                                               |
| Privacy and sampling         | `sensitive_values_detected`, `head_sample_biased`, `low_coverage_sample`, `findings_truncated`                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                              | A     | suppression is always applied (§5.5)                                                                                                                     |

**Never disabled:** all E rows and all B rows (`identity_field_absent`,
`profile_drift_type_incompatible`, consequential
`profile_drift_representation`, `holding_filter_value_unreviewed`), and
the record-level protection set (§9).

## 9. Seen-but-rejected protection — implementation contract

### 9.1 Data structure and key

- `RunState` (in `source-sync.service.ts`) gains `seenButRejected: Map<key,
{code, accountRef?}>`.
- `key` is the existing holding key `${obj.source}|${record.id}`:
  - `obj.source` is the mapped port object name;
  - `record.id` is the port record id, validated at the adapter boundary
    (`^[A-Za-z0-9_.:-]{1,255}$`).

  The format is identical to `holdingIds`, so both sets compare directly.

### 9.2 When a record enters the set (full and incremental runs)

| Outcome (M8 code)                                                                                                                            | Enters `seenButRejectedIds`?          | Gap reason (if attributable)                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| Writer rejection `invalid_observation` (counted `record_rejected`)                                                                           | **yes**                               | `observation_rejected`                                         |
| Mapping rejection: engine `skipped` `record_rejected` (value uninterpretable)                                                                | **yes**                               | `observation_rejected`                                         |
| Consequential field parse failure that rejects the record (e.g. `invalid_number` on quantity, identity field unreadable: `missing_identity`) | **yes**                               | `observation_rejected`                                         |
| `missing_account_reference`                                                                                                                  | **yes**                               | `observation_rejected` (attribution only via an existing line) |
| `orphan_account_reference`                                                                                                                   | **yes**                               | `account_reference_orphaned` (via an existing line)            |
| `missing_product_reference`, `orphan_product_reference`                                                                                      | **yes**                               | existing M8 reasons (unchanged)                                |
| Unreviewed holding-filter value (new `unreviewed_holding_value`, §10)                                                                        | **yes**                               | `holding_filter_value_unreviewed`                              |
| Malformed file row with readable id (M9C; contract defined now)                                                                              | **yes**                               | `observation_rejected`                                         |
| **Any rejection code not listed** (future)                                                                                                   | **yes (default protect)**             | `observation_rejected`                                         |
| `filtered_out` on a **reviewed** `non_holding` value                                                                                         | no (confident)                        | —                                                              |
| `non_subscription_product` (declared ignored)                                                                                                | no (confident)                        | —                                                              |
| Ingested (including `invalid_period` → `unknown`, `unmapped: unknown`)                                                                       | no (it is in `holdingIds`)            | —                                                              |
| `unmodelled_product_reference`                                                                                                               | n/a: the run fails before writes (M8) | —                                                              |

- **Implementation rule:** the protection decision is a **pure function**
  `protectionFor(outcome)` in the domain. Its exhaustive switch has an
  explicit `default: protect` for unknown codes.
- A unit test enumerates every engine and writer outcome code and asserts
  the table above. A mutation that removes the default makes the
  future-code test fail.

### 9.3 Interaction with `holdingIds` and the tombstone pass

- A key is in **at most one** of the two sets. A later accepted occurrence
  of the same key in the same run (duplicates) moves it to `holdingIds`. The
  M8 duplicate counting is unchanged.
- **Tombstone pass** (full runs only, M8 step 4):

  ```
  for recordId in activeSourceRecordIds(kind, obj):
    key = `${obj}|${recordId}`
    if holdingIds.has(key) or seenButRejected.has(key): skip
    tombstone(key)
  ```

  `tombstones_suppressed` counts the second branch.

- **Order** within a run:
  1. reads, building both sets;
  2. pre-tombstone B guards (§8);
  3. unattributable check (§9.5);
  4. the tombstone pass;
  5. the completion transaction: gaps replaced (including rejected-record
     gaps), run `completed`, run-quality profile stored.

  Coverage only becomes known through step 5's `completed` status, so the
  protection is always in force before coverage.

### 9.4 Ownership gaps and `ownership_incomplete`

- **Attribution, in order:**
  1. the record's account reference resolves to a canonical company
     (`repo.companyForRef`, existing);
  2. else the existing canonical line for this key has a `company_id` (new
     read `lineCompanyFor(kind, object, recordId)`).
- **Attributable:**
  - `state.gaps.set(key, {companyId, sourceObjectType, sourceRecordId,
reason})`;
  - the existing completion transaction writes it with `replaceWithin`, so
    no new write path is needed;
  - `EligibilityService` already turns any gap of the authoritative
    connection into `{coverage: 'unknown', reason:
'ownership_incomplete'}`, and `deriveOwnership` then returns `unknown`
    for **every** product of that account (verified).

  The stale line is never counted as owned, never `not_owned`, never
  whitespace.

- **Gap lifecycle:** the M8 lifecycle. A full run replaces the gaps (the
  gap disappears once the record is accepted again); incremental runs only
  add (tech debt 34).

### 9.5 Unattributable records

- A record in `seenButRejected` with no attribution (neither rule above)
  makes the run fail with `rejected_record_unattributable`. **Excluded** are
  M8's reference-integrity categories with no existing line:
  `missing_account_reference`, `orphan_account_reference`,
  `missing_product_reference` and `orphan_product_reference`. They keep M8
  handling (skipped, counted, coverage unaffected), because the source
  itself gives no account to attach. Only **value** rejections fail the run
  when unattributable: writer or mapping rejection, `missing_identity`,
  unreviewed holding value, malformed row, and unknown codes.
- The check runs after the reads and before the tombstone pass. The result:
  - no tombstones;
  - no gap replacement;
  - the run is not `completed`, so coverage and gaps are unchanged (M8's
    "cannot prove completeness" behaviour);
  - the quality document records the count.
- Writes already made are idempotent upserts through the single writers.

### 9.6 Retries and replays

- **Full runs:** a transient failure restarts the read from the first page
  under the same boundary (tech debt 30). `RunState` (both sets and gaps)
  is rebuilt from scratch on each attempt, so the protection is
  deterministic per attempt and never carries stale membership.
- **Incremental runs:** no tombstone pass. Rejected records still add gaps
  (add-only). The in-memory set is not needed across resumes, because
  nothing is deleted.
- **Replays** (an operator re-running a full sync) recompute everything. No
  persisted protection state exists, and none is needed.

### 9.7 Effect on existing behaviour

- Changes are confined to cases where M8 would have tombstoned a seen-but-
  rejected line, or would have left an account covered despite a rejected
  record.
- **Sugar fixtures 09 and 10** (first-run orphans, no existing line) are
  unchanged.
- **Expected intended changes:** M8 integration tests whose companion
  fixtures include a rejected record now see a gap for that account. Each
  changed assertion is listed in the M9A record as an **intended safety
  correction**, with the old and new expectation and the reason. None is
  silently updated.

## 10. Holding-filter reviewed domain

### 10.1 Structure (in the immutable mapping document)

```jsonc
"holdingFilter": {
  "field": "<field>",
  "operator": "in" | "not_in",
  "values": ["…"],                    // M8 list (allowlist for in, denylist for not_in)
  "confirmed": true,                  // M8 confirmation
  "reviewedDomain": {
    "entries": [
      { "value": "Closed Won", "classification": "holding" },
      { "value": "Closed Lost", "classification": "non_holding" },
      { "value": null, "classification": "non_holding" }   // null/empty: mandatory explicit entry
    ],
    "snapshotHash": "<sha256>",       // snapshot the domain was reviewed against
    "profileIds": ["<uuid>"]          // covering profile(s) whose observed values were reviewed
  }
}
```

- **Value matching:** exact string match, as M8. `null` stands for "absent,
  null, empty or whitespace-only".
- **Why the empty entry is mandatory:** M8's filter treats empty as "not a
  member". So **today a null value under `not_in` is admitted as a holding**
  (verified in `source-mapping-engine.ts`). The mandatory `null` entry
  closes that false-holding path.
- **Limit:** ≤ 2,000 entries (the M8 enum limit), and values ≤ 200
  characters (as M8 enum options).

### 10.2 Publish validation

| Rule                                                                                            | Code (refused)                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------- |
| Every option declared by the snapshot for the field has an entry                                | `holding_filter_domain_incomplete`     |
| Every value observed in the covering profile's categorical domain has an entry                  | `holding_filter_domain_incomplete`     |
| A `null` entry exists                                                                           | `holding_filter_domain_incomplete`     |
| Consistency: `in` → `holding` ⇔ value ∈ `values`; `not_in` → `non_holding` ⇔ value ∈ `values`   | `holding_filter_domain_inconsistent`   |
| Field is a declared enum, or has an unsuppressed safe categorical profile                       | `holding_filter_domain_unknown`        |
| `snapshotHash` equals the mapping's snapshot; `profileIds` are covering profiles                | `holding_filter_domain_stale`          |
| Each entry's classification is a consequential confirmation (recorded like other confirmations) | `unconfirmed_consequential_entry` (M8) |

### 10.3 Runtime

- The pure function `classifyHoldingValue(domain, value) → 'holding' |
'non_holding' | 'unreviewed'` replaces M8's direct `values.includes`. It
  is used in `mapSubscriptionRecord`:
  - `holding` → continue mapping (as M8 `in`-member or `not_in`-non-member);
  - `non_holding` → `filtered_out` (confident; not protected; tombstone
    allowed);
  - `unreviewed` → new outcome `unreviewed_holding_value`.
- **For `unreviewed_holding_value`, for both operators:**
  - the record joins `seenButRejectedIds` (§9);
  - no line is created or updated from it;
  - its existing line, if any, is not tombstoned;
  - an attributable account gets a `holding_filter_value_unreviewed` gap,
    so ownership is `unknown`: no `owned`, `not_owned` or whitespace
    conclusion;
  - unattributable → §9.5;
  - a finding goes into the run-quality profile; the value is shown only
    under the safe-category gate.
- **Only a new mapping version** whose `reviewedDomain` classifies the value
  resumes normal handling. There is no acknowledgement-only bypass.

### 10.4 Existing mapping versions (pre-M9A)

- Mapping versions published before M9A have holding filters **without**
  `reviewedDomain`.
- **Decision A3 (recommended):** a full or incremental run under such a
  version refuses to start (`mapping_requires_republish`). The operator
  republishes with a reviewed domain.
- **Justification:** keeping M8 semantics would leave the `not_in` and null
  false-holding paths open. No production tenant uses a versioned
  connection yet (LIVE SUGAR VERIFICATION: PENDING; `import` and `hubspot`
  are code-mapped and have no holding filter).
- M8 tests that publish Sugar test mappings are updated to include
  `reviewedDomain`, listed as intended changes.

## 11. Structural coverage tier

### 11.1 Types (domain, source-neutral)

```ts
// domain/coverage.ts
export type CoverageTier = 'externally_grounded' | 'stable_snapshot' | 'none';

export type ProofMethod =
  | 'count' // M8: source count before and after equals records read
  | 'operator_full_file' // M7 CSV import declared full by the operator (decision A2: stable_snapshot)
  | 'manifest' // M9C
  | 'double_enumeration' // M9B
  | 'success_marker'; // M9C

export interface ProofMetadata {
  readonly method: ProofMethod;
  readonly tier: Exclude<CoverageTier, 'none'>; // derived from method, never configured
  readonly outcome: 'passed';
  readonly connectionId: string;
  readonly runId: string; // the checkpoint that established coverage
  readonly completedAt: Date;
  readonly inferred: boolean; // true for pre-M9A runs (§11.3)
  readonly acceptance?: { readonly authorityVersion: number }; // required for adapter-declared stable_snapshot methods (§11.2)
}

export const TIER_OF: Readonly<Record<ProofMethod, Exclude<CoverageTier, 'none'>>> = {
  count: 'externally_grounded',
  operator_full_file: 'stable_snapshot', // A2: a processed file is not proof of a complete upstream population
  manifest: 'externally_grounded',
  double_enumeration: 'stable_snapshot',
  success_marker: 'stable_snapshot',
};

export type SubscriptionCoverage =
  | {
      readonly coverage: 'known';
      readonly coverageTier: 'externally_grounded' | 'stable_snapshot';
      readonly knownAsOf: Date;
      readonly proof: ProofMetadata;
      readonly sourceSystem: string;
    }
  | {
      readonly coverage: 'unknown';
      readonly coverageTier: 'none';
      readonly reason: 'authority_unassigned' | 'no_complete_run' | 'proof_not_accepted';
    };

// domain/eligibility.ts (changed)
export type OwnershipInput =
  | {
      readonly coverage: 'known';
      readonly coverageTier: 'externally_grounded' | 'stable_snapshot';
      readonly knownAsOf: Date;
      readonly subscriptions: readonly SubscriptionFact[];
    }
  | {
      readonly coverage: 'unknown';
      readonly coverageTier: 'none';
      readonly reason?: 'ownership_incomplete';
    };

export interface EligibilityResult {
  /* existing fields … */
  readonly coverageTier: CoverageTier; // new
  readonly evaluatorVersion: number; // 3
}
```

### 11.2 Derivation and persistence

- **Sync runs** record `quality.proof = {method, tier: TIER_OF[method],
outcome}`. The tier is computed from the method in code, never read from
  configuration.
- `SubscriptionRunsStore.coverage()` (existing logic: authority, streak,
  latest mapping, latest completed full run) additionally reads the proof of
  **the run it selected** and returns `SubscriptionCoverage`.
  - **stable_snapshot from an adapter-declared method** (`double_enumeration`,
    `success_marker`): coverage is `known` only if the latest authority
    version contains an acceptance for that connection (§11.4). Otherwise
    `{coverage: 'unknown', coverageTier: 'none', reason:
'proof_not_accepted'}`.
  - **stable_snapshot from `operator_full_file`** (M7 CSV `import_full`):
    coverage is `known` with tier `stable_snapshot`, and **no authority
    acceptance is needed**.
    - The operator's explicit choice of a _full_ import is already a
      recorded human assertion on the run.
    - Requiring a second acceptance would drop CSV tenants to tier `none`
      and discard their positive owned evidence, which A2 keeps usable.
    - The tier still forbids every absence conclusion (§11.5), so no
      acceptance can make CSV absence actionable.
  - **A weaker newer run reduces the tier:** the selected run is always the
    newest qualifying run. If it is `stable_snapshot`, the tier is
    `stable_snapshot`, even if an older run was `externally_grounded`.
- **`EligibilityService`** builds `OwnershipInput`:
  - no coverage, or any gap → `{coverage: 'unknown', coverageTier: 'none',
reason?}`;
  - otherwise → `{coverage: 'known', coverageTier, knownAsOf,
subscriptions}`.
- **`factsHash` and frozen input:** `canonicalJson({account, ownership,
asOf})` already serialises `ownership`, so `coverageTier` is included
  automatically. A test asserts that two inputs differing only in tier hash
  differently.
- **Snapshots and replay:**
  - `EVALUATOR_VERSION = 3`;
  - snapshots store `coverageTier` in the frozen input;
  - replaying a version-2 snapshot reports `evaluator_changed` (M8
    behaviour);
  - replaying a version-3 snapshot reproduces the same tier and result.

### 11.3 Pre-M9A runs (no data rewrite)

- Completed M8 versioned-connection backfill runs could only complete after
  a passing count proof (`countOrRefuse`, verified). Completed M7
  `import_full` runs are operator-declared full files.
- The read model treats a selected completed run **without**
  `quality.proof` as follows:
  - versioned connection → `{method: 'count', inferred: true}`, tier
    `externally_grounded`;
  - `import` connection → `{method: 'operator_full_file', inferred: true}`,
    tier **`stable_snapshot`**.

  No row is rewritten (no backfill).

- **Decision A2 (final, after independent review): `operator_full_file` is
  `stable_snapshot`.**
  - A completed M7 `import_full` checkpoint proves that a file was processed
    successfully. It does **not** independently prove that the uploaded file
    contained the complete upstream population.
  - The import's input hash provides deduplication and idempotency, not
    completeness.
  - So records present in an operator-provided full file are valid positive
    evidence, but absence from the file is not grounded enough to imply
    `not_owned`.
- **CSV downstream behaviour** (`operator_full_file` / `stable_snapshot`):
  - positive owned products remain usable;
  - absence becomes `unknown` (`coverage_tier_insufficient`);
  - no `eligible_whitespace`;
  - no absence-based opportunity.
- **Historical imports.** M7 CSV runs completed before M9A infer
  `coverageTier = stable_snapshot` from M9A onwards. Historical rows are
  **not** rewritten to preserve old whitespace behaviour.
  - Absence-based conclusions that relied only on operator-declared CSV
    completeness become **non-actionable** under the new tier:
    re-evaluation yields `unknown`.
  - Existing eligibility snapshots (evaluator version 2) keep what they
    recorded and replay as `evaluator_changed` (M8 precedent). They are
    historical records, not current conclusions.
- **Future stronger import proof.** A future import that carries
  independent **producer-side** completeness evidence (for example a
  producer-declared row count, or a manifest verified against the parsed
  file) may qualify for `externally_grounded`. That is a **separate proof
  method** (e.g. `manifest`), designed and reviewed on its own. It is never
  inferred from `import_full` alone.

### 11.4 Acceptance (stable_snapshot only)

- An authority version's `proof_acceptances` may contain `{connectionId,
tier: 'stable_snapshot', reason, actor, at}`. It is published through
  `authority-publish --accept-stable-snapshot <connection> --reason "…"`,
  with the required base version (M8).
- **Evidence condition:** the live-gate evidence condition from the master
  plan is enforced in M9B, where the first real `stable_snapshot` method
  exists. M9A validates the acceptance shape and wires it into coverage.
- **No promotion:**
  - an acceptance is only a precondition for `stable_snapshot` coverage;
  - it can never produce `externally_grounded`;
  - `TIER_OF` is a code constant with no configuration path;
  - connection configuration has no tier field (the schema refuses one).

### 11.5 Downstream semantics (implemented in `deriveOwnership` and eligibility)

| Tier                  | Ownership                                                                                                                                        | Eligibility                                                                                                                                                                               | Whitespace                     | Future opportunity generation       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------- |
| `externally_grounded` | M7/M8 rules                                                                                                                                      | M7/M8 precedence (fail > unknown > eligible)                                                                                                                                              | `eligible_whitespace` possible | absence- and presence-based allowed |
| `stable_snapshot`     | Lines give `owned`/`unknown` as usual; **every `not_owned` result becomes `unknown`** with reason `coverage_tier_insufficient` (new reason code) | Unchanged algorithm over that ownership map. `ownership_coverage` check `unknown` (`coverage_tier_insufficient`). Presence-based failures (e.g. already owned) still win (fail > unknown) | **never**                      | presence-based only (contract)      |
| `none`                | all `unknown` (M8)                                                                                                                               | `unknown`                                                                                                                                                                                 | never                          | none                                |

- `stable_snapshot` covers both adapter-declared methods (accepted) and
  `operator_full_file` (CSV imports). Downstream semantics are identical:
  presence usable, absence `unknown`, never whitespace.
- The consuming code switches exhaustively on `coverageTier` (TypeScript
  `never` checks). There is no default branch.
- **M9A builds no opportunity generator.** The contract is recorded in
  ADR 0023 for M11+.

## 12. Sugar regression plan (no Sugar-specific changes)

| Check                                                | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector behaviour unchanged                        | Snapshot test: `SugarConnector.capabilities()` and the per-object capabilities from `describeSchema()` on the fake equal the M8 values (pagination, change field, delete visibility, count, page size, adapter version)                                                                                                                                                                                                                                                                                                                        |
| Field selection unchanged                            | Fake Sugar request log: `sync` reads request exactly the mapped fields (as M8); `profile` reads request exactly the requested fields; no request contains an unrequested field                                                                                                                                                                                                                                                                                                                                                                 |
| Read-only proof unchanged                            | M8 closure connector-level test passes unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Count proof stays `externally_grounded`              | A full Sugar run records `quality.proof = {method: 'count', tier: 'externally_grounded', outcome: 'passed'}`; coverage returns `coverageTier: 'externally_grounded'`; pre-M9A runs infer the same (§11.3)                                                                                                                                                                                                                                                                                                                                      |
| M8 safe behaviour                                    | The whole M8 suite (unit, integration, adversarial RLS, behavioural single writer, runtime 70, Docker) passes. Only the intended changes listed in §9.7 and §10.4 differ, each documented with old and new expectation and reason                                                                                                                                                                                                                                                                                                              |
| No Sugar code change                                 | `git diff main -- apps/api/src/modules/sugar` is empty at the M9A gate (checked in the record)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Whitespace still possible (externally grounded only) | With `externally_grounded` coverage (Sugar fake, `count` proof), the M8 whitespace tests (`test/sources/source-sync.int.spec.ts`, runtime `70-source-connectors.sh`) still produce `eligible_whitespace`. M7 whitespace assertions that establish coverage **via CSV import** (`test/products/eligibility.int.spec.ts`, runtime `60-product-eligibility.sh`) change to `unknown` (`coverage_tier_insufficient`) under A2. They are listed as intended corrections, and an externally grounded fixture keeps a whitespace-positive case in each |

## 13. Testing plan

### 13.1 Unit (pure)

- **Classifiers:**
  - every rule in §4.1, with positive and negative cases;
  - null versus empty versus whitespace;
  - native versus JSON-encoded versus delimited arrays (`["luc","ra","ars"]`,
    `"[\"luc\",\"ra\",\"ars\"]"`, `"luc,ra,ars"`, `"a;b"`, `"a|b"`);
  - `{"values":["luc","ra"]}` native and encoded;
  - malformed JSON (`"{bad"`, `"[1,"`);
  - booleans: `true/false/1/0/yes/no/Y/N/t/f`, and `{0,1}` integers only;
  - dates: `2025-01-31`, `31/01/2025`, `01/02/2025` (ambiguous),
    `13/13/2025` (invalid), `2025-02-30` (invalid);
  - timestamps with `Z`, offset and naive;
  - unix seconds and milliseconds only when declared;
  - leading zeros; comma decimals.
- **Suggestions:** each threshold at, just below and just above its
  boundary; n = 19 versus 20.
- **Privacy:** every §5.4 boundary row; each detector (Luhn valid and
  invalid; a Luhn-positive order number; IBAN mod-97 valid and invalid;
  email; phone with and without separators; UUID); name lists; JSON key
  suppression; `assertNoRawValues`.
- **Drift:** each §8 row's trigger and class; fixed thresholds; E/B not
  demotable (a configuration attempt is refused).
- **`protectionFor`:** every M8 outcome code, plus an unknown code →
  protect.
- **`classifyHoldingValue`:** `in` and `not_in` × holding, non_holding,
  unreviewed and null.
- **Coverage tier:** `TIER_OF` exhaustive; downstream table per tier;
  `factsHash` differs by tier; no promotion paths.

### 13.2 Property tests (fast-check)

- Accumulator merge is associative and commutative: any page split and
  order gives an identical document hash.
- The classifier is total (never throws) and deterministic over arbitrary
  JSON values and strings ≤ 70 KiB.
- The safe-category gate never emits a value failing a detector.
- `deriveOwnership` with `stable_snapshot` never yields `not_owned`.
- `classifyHoldingValue` never returns `holding` for a value outside the
  domain.

### 13.3 Integration (real PostgreSQL, app role, forced RLS, fake Sugar)

**Profiling:**

- A profile run end to end: limits refused (unset, below minimum, above
  connection value, above ceiling, > 500 fields, memory budget); sampling
  methods allowed or refused per capabilities; documents valid; findings
  persisted; drift baseline linked; run state machine; one active run per
  connection; retry restarts from scratch; a failed run publishes nothing.
- **Privacy scan:** seeded fixture values (emails, names, Luhn numbers,
  IBANs) never appear in profile documents, findings, logs or CLI output.

**Mapping publish:**

- a covering profile is required;
- exemptions are honoured;
- refusals for stale, `head`-sampled, excluded and different-snapshot
  profiles;
- acknowledgements are recorded and required;
- an override attempt is refused (`override_requires_authenticated_operator`,
  A1) and audited as refused.

**Structural drift B guards:**

- `identity_field_absent` before writes (first page) and before tombstones
  (whole run);
- `profile_drift_type_incompatible`;
- consequential representation change.

**Seen-but-rejected protection:**

- **an isolated single-record rejection** in a clean full run, with no
  aggregate finding, keeps its line (`tombstones_suppressed = 1`) and gives
  the account an `observation_rejected` gap, so eligibility is `unknown`
  for its products;
- one test per rejection class in §9.2;
- a confident `filtered_out` (reviewed non-holding) line is still
  tombstoned;
- a `non_subscription_product` line is still tombstoned.

**Unattributable rejection:** `rejected_record_unattributable`; no
tombstones; coverage and gaps unchanged.

**Reviewed domain:**

- `in` with an unreviewed value: an existing line is not tombstoned, no
  update happens, and the account is `unknown`;
- `not_in` with an unreviewed value: no line is created, and the account is
  `unknown` (never owned);
- a null value under `not_in` without a classified `null` entry is refused
  at publish; with a `non_holding` null entry it is filtered out;
- publish is refused when the domain is incomplete, inconsistent or stale;
- normal behaviour resumes after a new version classifies the value;
- pre-M9A versions → `mapping_requires_republish`.

**Coverage tier:**

- **persistence:** Sugar run `proof` = count / `externally_grounded`;
- **propagation:** `coverage()` → `EligibilityService` →
  `EligibilityResult.coverageTier` → snapshot frozen input and replay;
- **no promotion:** with seeded checkpoint rows (admin SQL, test only), a
  newer `stable_snapshot` run after an `externally_grounded` one gives
  `stable_snapshot`; an acceptance never yields `externally_grounded`; a
  stable run without acceptance gives `proof_not_accepted`;
- **downstream:** identical lines under `externally_grounded` give
  `not_owned` and `eligible_whitespace` where otherwise eligible; under
  accepted `stable_snapshot` they give `unknown` (`coverage_tier_insufficient`)
  and no whitespace; owned is identical in both;
- pre-M9A inferred proofs: versioned → `count` / `externally_grounded`;
  import → `operator_full_file` / **`stable_snapshot`**;
- **CSV import tier:**
  - a completed `import_full` records `proof = {method:
'operator_full_file', tier: 'stable_snapshot'}`;
  - coverage is `known` / `stable_snapshot` without any authority
    acceptance;
  - imported active lines still make products `owned`;
  - products absent from the file are `unknown`
    (`coverage_tier_insufficient`), never `not_owned`;
  - **no `eligible_whitespace`** from CSV coverage, even where every other
    eligibility condition holds;
  - a historical import without `proof` behaves identically (inferred).

**Sugar regression:** every check in §12.

### 13.4 Adversarial RLS (M8 closure pattern; raw SQL in the attacker's transaction)

For each of `tenant_source_profile_runs`, `tenant_source_profiles`,
`tenant_source_profile_findings` and `tenant_source_profile_purges`:

- cross-tenant SELECT finds nothing;
- INSERT with the other tenant's id is refused;
- UPDATE and DELETE of the other tenant's rows affect 0 rows;
- composite-FK hijacks are refused by exact constraint name (connection,
  snapshot, run, sync run, profile, previous profile);
- moving own rows to the other tenant is refused;
- the other tenant's rows are byte-for-byte unchanged.

Also, for the new authority column and gap reasons: a cross-tenant
acceptance referencing the other tenant's connection is refused, and an
attacker cannot insert a gap with a new reason for the other tenant.

### 13.5 Runtime script `75-profiling.sh` (real API, worker, CLIs, compose PostgreSQL/Redis, fake Sugar)

1. Configure Sugar (fake) with `profile.maxRows`.
2. Capture the schema, then `profile-run --execute` → `completed`.
3. `profile-show` and `profile-findings` return aggregates.
4. Draft the mapping.
5. Publish: refused without a profile or acknowledgement; succeeds with
   both.
6. Full sync: `proof` is count / `externally_grounded`.
7. Inject a single rejected record (fake fault): the line survives and the
   account is `unknown` in `eligibility evaluate`.
8. Inject an unreviewed filter value: `not_in` → no false holding.
9. An override attempt is refused.
10. Scan every CLI output and worker log for fixture values and secrets.

### 13.6 Docker and fresh clone

- **Docker:** the processor check is unchanged (one registration); `sources
profile-run --help` and `profile-show` run inside the image; the
  migration applies in the image's migrate job.
- **Fresh clone:** `pnpm install --frozen-lockfile`, `pnpm verify`,
  `pnpm verify:runtime` and `pnpm verify:docker` all exit 0 on the first
  attempt, with no leftover resources.

### 13.7 Mutation proofs (each must fail for the stated reason; harness as M8)

| #   | Mechanism broken                                                                      | Expected failing test                                                                                                                 |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Empty string counted as null                                                          | classifier null-vs-empty test                                                                                                         |
| 2   | JSON-encoded array classified as string                                               | JSON-encoded array test                                                                                                               |
| 3   | Malformed JSON not counted                                                            | malformed JSON test                                                                                                                   |
| 4   | `1/0` alone suggests boolean                                                          | boolean `{0,1}` rule test                                                                                                             |
| 5   | Ambiguous date reported high confidence                                               | date ambiguity test                                                                                                                   |
| 6   | Safe-category cardinality `≤ 50` → `≤ 51`                                             | boundary test distinct = 51                                                                                                           |
| 7   | Length gate `≤ 64` → `≤ 65`                                                           | boundary test length 65                                                                                                               |
| 8   | One PII value suppresses only itself                                                  | sensitive-in-categorical test                                                                                                         |
| 9   | Privacy pass skipped before persistence                                               | integration privacy scan                                                                                                              |
| 10  | `assertNoRawValues` disabled                                                          | privacy violation test                                                                                                                |
| 11  | Profile limit clamped instead of refused                                              | limits test                                                                                                                           |
| 12  | Hard ceiling read from configuration                                                  | ceiling test                                                                                                                          |
| 13  | Covering-profile requirement skipped                                                  | publish test `profile_required`                                                                                                       |
| 14  | Exempt entries demand a profile                                                       | exemption test                                                                                                                        |
| 15  | Override accepted without an authenticated operator                                   | override refusal test                                                                                                                 |
| 16  | Override skips acknowledgements                                                       | override scope test                                                                                                                   |
| 17  | `identity_field_absent` guard removed                                                 | identity B-guard test                                                                                                                 |
| 18  | Incompatible type guard removed                                                       | type B-guard test                                                                                                                     |
| 19  | Tombstone pass ignores `seenButRejected`                                              | isolated single-record rejection test                                                                                                 |
| 20  | `protectionFor` default → delete                                                      | future-code protection test                                                                                                           |
| 21  | Rejected record's gap not recorded                                                    | eligibility `unknown` test                                                                                                            |
| 22  | Unattributable rejection completes the run                                            | unattributable test                                                                                                                   |
| 23  | `in` unreviewed treated as non-holding                                                | `in` reviewed-domain test                                                                                                             |
| 24  | `not_in` unreviewed treated as holding                                                | `not_in` reviewed-domain test                                                                                                         |
| 25  | Mandatory `null` entry not required                                                   | null-under-`not_in` publish test                                                                                                      |
| 26  | `coverageTier` not persisted (proof omitted)                                          | tier persistence test                                                                                                                 |
| 27  | Tier dropped between coverage and eligibility                                         | tier propagation test                                                                                                                 |
| 28  | Older externally grounded run preferred over a newer stable run                       | no-promotion test                                                                                                                     |
| 29  | Acceptance yields `externally_grounded`                                               | no-promotion test                                                                                                                     |
| 30  | `stable_snapshot` keeps `not_owned`                                                   | stable-snapshot-no-whitespace test                                                                                                    |
| 31  | Tier rule applied to `externally_grounded`                                            | externally-grounded-whitespace test                                                                                                   |
| 32  | `profiling-is-advisory` dependency rule removed / violated                            | `pnpm depcheck:boundaries`                                                                                                            |
| 33  | RLS removed or permissive on each new table                                           | adversarial RLS spec (per table)                                                                                                      |
| 34  | Profile documents mutable                                                             | immutability test                                                                                                                     |
| 35  | Purge allowed for the app role                                                        | purge privilege test                                                                                                                  |
| 36  | `TIER_OF.operator_full_file` changed from `stable_snapshot` to `externally_grounded`  | `TIER_OF` unit test and the CSV-import tier tests (§13.3): absence must stay `unknown` and no `eligible_whitespace` from CSV coverage |
| 37  | Authority acceptance demanded for `operator_full_file` (CSV coverage drops to `none`) | CSV-import tier test: imported lines must still yield `owned`                                                                         |

## 14. Performance and memory bounds

### 14.1 Per-field accumulator (worst case)

| Component                                                                   | Bound                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Counts, class and representation counters                                   | < 1 KiB                                                               |
| Exact distinct set: 64-bit hashes (SipHash/SHA-256 truncated) up to the cap | 10,000 × 8 B ≈ 80 KiB, then discarded in favour of the sketch         |
| HyperLogLog (precision 14)                                                  | 16 KiB                                                                |
| Raw categorical candidates                                                  | ≤ 51 values × ≤ 64 chars ≈ 7 KiB (dropped at the 52nd distinct value) |
| Length quantiles (fixed-size KLL-style sketch, k = 200)                     | ≈ 4 KiB                                                               |
| Range buckets                                                               | ≤ 200 buckets                                                         |
| List element sub-accumulator (if list-shaped)                               | same bounds again (one level only)                                    |
| **Total**                                                                   | ≈ 110 KiB, ≈ 220 KiB with list elements                               |

### 14.2 Distinct counting

- Exact counting up to 10,000 distinct hashes. Beyond that, the HLL estimate
  is used (`method: "estimate"`, about 0.8% standard error).
- Raw values are never kept for counting, only hashes. The hashes are not
  persisted, and neither is the sketch.

### 14.3 Run level

- **Wide objects:** 500 fields × 220 KiB ≈ 110 MiB worst case. The request
  is refused if the estimate exceeds the 128 MiB budget
  (`profile_memory_budget_exceeded`).
- Rows are streamed page by page (≤ 1,000 records per page), and no record
  is retained after its page.
- **Timeout:** 60 minutes (§6.2).
- **Per-value work is bounded:** JSON parsing ≤ 64 KiB per value; strings
  longer than 64 KiB are classified `text` without parsing.

### 14.4 Storage

- Documents ≤ 1 MiB per object (CHECK); findings ≤ 2,000 per profile, each
  evidence ≤ 4 KiB.
- Retention N = 10 per (connection, object, family). Sync-family profiles
  are pruned by the same purge.
- **No per-record persistence anywhere in profiling.** Run-quality
  accumulation in sync uses the same bounds over mapped fields only.

### 14.5 Seen-but-rejected

- The set is in memory, like `holdingIds`: one key per rejected record,
  bounded by the read.
- **Its memory joins tech debt #31.** When M9A lands, the register entry is
  extended to cover `seenButRejectedIds` alongside the seen-line and
  known-account sets, and the §19 scale gate counts it.

## 15. Migration plan (planning only; no migration created)

One migration, `2026MMDDhhmmss_m9a_source_profiling`, applied by the
schema owner (`MIGRATION_DATABASE_URL`), in this order:

1. `tenant_source_profile_runs` (columns, CHECKs, PK, composite FKs,
   indexes, forced RLS, tenant trigger, state-machine trigger).
2. `tenant_source_profiles` (CHECKs incl. size and secret-like key,
   composite FKs incl. self-FK, partial unique indexes, forced RLS,
   refuse-change trigger with the privileged purge exception).
3. `tenant_source_profile_findings` (code CHECK, FKs, forced RLS,
   refuse-change trigger).
4. `tenant_source_profile_purges` (append-only: refuse-change trigger,
   forced RLS).
5. `tenant_ownership_gaps`: drop and recreate `tenant_ownership_gaps_reason_valid`
   with the three new reasons. Existing rows are unaffected (a superset).
6. `tenant_source_authority_versions`: add `proof_acceptances jsonb NOT NULL
DEFAULT '[]'` with a shape CHECK (array, ≤ 16 entries, each with a
   `connectionId` that must belong to the tenant). Membership is checked by
   a trigger, because JSON cannot carry a composite FK. The hash function
   in code changes only for non-empty acceptances. A DO-block asserts every
   existing row's `content_hash` still recomputes (parity check).
7. Grants: SELECT/INSERT on the new tables for `lip_app` (UPDATE only on
   `tenant_source_profile_runs` for the state machine; no DELETE).

**Not migrated (JSON, no column):**

- checkpoint `quality.proof`;
- mapping `reviewedDomain`, `acknowledgements`, `coveringProfileIds`;
- eligibility snapshot `coverageTier`.

No data backfill. Pre-M9A runs are inferred by the read model (§11.3).

**Down-script (dev/staging only; production policy is forward-fix):**

- **Refuses** when any of these exist:
  - profile runs, profiles, findings or purges;
  - gaps with a new reason;
  - non-empty `proof_acceptances`;
  - mapping versions containing `reviewedDomain` (they would be
    unreadable by M8 code);
  - eligibility snapshots with `evaluator_version = 3`.
- Otherwise it drops the four tables, restores the M8 gap CHECK and drops
  the authority column.
- A migration test applies up, down and up on M8 data and asserts the M8
  schema is restored exactly, as for the M8 down-scripts.

## 16. Definition of Done (M9A gate)

M9A is **not complete** until all of these are true, with evidence (commands
and output) in `docs/milestones/M09A-…md`:

1. Implementation finished per §1–§11; no open TODOs in M9A code.
2. Deterministic verification green: `pnpm verify` (format, lint,
   typecheck, boundaries including `profiling-is-advisory`, unit,
   integration).
3. Runtime green: `pnpm verify:runtime`, including `75-profiling.sh`.
4. Docker green: `pnpm verify:docker`.
5. Fresh clone green: install, verify, runtime and Docker on the first
   attempt, with no leftovers.
6. Mutation proofs: all of §13.7 failed for the stated reason and passed
   after restore.
7. Adversarial RLS passes for the four new tables and the changed columns.
8. Privacy scan passes: documents, findings, logs and CLI output contain no
   seeded sensitive values.
9. Sugar regression (§12) passes. Intended M7/M8 test changes are listed
   with reasons, including the CSV-coverage whitespace assertions changed by
   A2. The Sugar module diff is empty.
10. Independent implementation review passes.
11. Decisions A1–A3 approved (or changed) before implementation starts.
12. ADRs 0022 (profiling) and 0023 (proof tiers, coverage tier,
    seen-but-rejected protection) are written, and the ADR 0020 as-built
    note is updated.

LIVE SUGAR VERIFICATION stays PENDING. It is not part of M9A.

## 17. Decisions for approval before implementation

| #   | Decision                                                                               | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | D5 emergency override needs an authenticated operator, which does not exist (verified) | Ship it **disabled** (refused, tested); enable only with a future authenticated channel                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A2  | Tier of M7 `import_full` coverage                                                      | **Final (independent review): `stable_snapshot` via `operator_full_file`.** A processed file is not independent proof of the complete upstream population (the input hash is idempotency, not completeness). Positive owned evidence stays usable without an authority acceptance; absence becomes `unknown`; no whitespace and no absence-based opportunity from CSV coverage; historical imports are inferred as `stable_snapshot` with no backfill. A future producer-verified row count or manifest is a separate method that may reach `externally_grounded` |
| A3  | Holding filters in mapping versions published before M9A                               | Runs refuse (`mapping_requires_republish`); republish with `reviewedDomain` (closes the verified `not_in`/null false-holding path)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A4  | Fixed B-guard thresholds (50% systemic; first page ≥ 20 records)                       | Approve as code constants with ADR note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A5  | Covering-profile freshness 30 days (bounded 1–90)                                      | Approve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 18. Risks

| Risk                                                       | Mitigation                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The protection set changes M8 outcomes unexpectedly        | Exhaustive outcome table; every changed M8 assertion documented as an intended safety correction (§9.7) |
| A3 forces republishing of test mappings                    | No production tenant on versioned connections; tests updated and listed                                 |
| Luhn false positives over-suppress categorical values      | Accepted: suppression costs only convenience, never storage                                             |
| Profiling load on sources (rate limits)                    | Same per-connection limiter and retries as sync; row ceiling; one active run per connection             |
| Wide objects exceed memory                                 | Request-time memory estimate refuses runs above budget                                                  |
| Coverage-tier change ripples through eligibility snapshots | `EVALUATOR_VERSION = 3`; old snapshots replay as `evaluator_changed` (M8 precedent)                     |
| Override unavailable during a profiling outage (A1)        | Fails closed; publishes are rare; documented                                                            |
| JSON-held acceptances lack a composite FK                  | Membership trigger plus adversarial test                                                                |
| Accumulator bugs silently skew suggestions                 | Property tests (associativity, determinism) and boundary tests; suggestions are advisory                |

## 19. Deferred scope

- `double_enumeration` executor and the live-evidence acceptance condition
  (M9B); `manifest`/`success_marker` executors (M9C).
- The authenticated operator channel and enabling the override (A1).
- Compound and composite-key detection.
- The streamed tombstone pass (tech debt 31) and the scale check (applies
  before M9C/M9D `subscription_lines` authority).
- Attribute registry and canonical targets for multi-select/JSON data.
- Opportunity generation (M11+); only its tier contract is fixed here.
- Automatic profile scheduling (operator-triggered in M9A; run-quality
  profiles come with every sync).
- **Future consideration (not M9A scope):** invalidating a covering profile
  automatically when drift of a given severity is observed, so a newer
  profile is required before the next publish. Today a covering profile is
  bounded only by the snapshot match and the freshness window (§7.1).
- Producer-side completeness for CSV imports (verified row count or
  manifest) as a separate `externally_grounded` method (§11.3).

## 20. Confirmation

Planning only. No code, migrations, fixtures or production changes were
made. **M9A implementation has NOT started.** **LIVE SUGAR VERIFICATION:
PENDING.**
