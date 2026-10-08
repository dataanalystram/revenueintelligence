# Milestone 9A — Source data profiling foundation (implementation record)

- Status: **M9A IMPLEMENTATION COMPLETE — closure fix applied, pending re-review.** Not closed, not merged.
  Independent implementation review of `0c5037a`: `PASS WITH REQUIRED FIXES — DO NOT MERGE` (one blocking
  finding: field-name privacy). The fix is recorded in [Closure fix](#closure-fix-field-name-privacy).
- **LIVE SUGAR VERIFICATION: PENDING** (profiling and every M9A check ran against the deterministic fake Sugar only).
- **M9B has NOT started.** No Chargebee, S3/file, warehouse, signal, opportunity or M9B work.
- Plans: [M9 master plan](M09-multi-source-data-quality-plan.md) and [M9A detailed plan](M09A-source-data-profiling-plan.md)
  (final verdict `PASS — M9A PLAN APPROVED FOR IMPLEMENTATION`), merged once into this branch as `73bc0c6`
  (planning branch `planning/m9-multi-source-data-quality` @ `9af61bb`).
- Branch: `claude/blissful-mendel-urbh4r` (based on `main` @ `f0cee24`).
- Implementation SHA: see [Evidence](#evidence) (the fresh clone ran at that exact SHA).
- ADRs: [0022 source data profiling](../adr/0022-source-data-profiling.md),
  [0023 record-level safety and coverage tiers](../adr/0023-record-level-safety-and-coverage-tiers.md),
  [ADR 0020 as-built amendment](../adr/0020-versioned-source-mapping-and-authority.md#as-built-m9a-amendment-adr-0022--adr-0023).
- Roadmap: decision D1 applied ([README](README.md), [roadmap](../product/roadmap.md)).

## Scope delivered (by plan section)

| Plan §                | As built                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Architecture        | Pure engine `src/modules/domain/profiling/` (classifiers, accumulators, privacy, suggestions, findings, drift, document, limits); `profiling-is-advisory` boundary rule; `ReadRequest.purpose` (`sync`/`preview`/`profile`, optional, absent = `sync`, so the Sugar module is unchanged); `source.profile` on `lip-sources` dispatched by the existing processor (one registration) |
| 2 Persistence         | Migration `20261101120000_m9a_source_profiling`: four tables, three gap reasons, `proof_acceptances`; down-script with refusals                                                                                                                                                                                                                                                     |
| 3 Document v1         | Zod schema; field profiles as an **array** (`fields[].name`), so field names are values, never JSON keys                                                                                                                                                                                                                                                                            |
| 4 Detectors           | §4.1 rules 1–15 in order; §4.2 mixed types/representations; §4.3 suggestions (n < 20 → low)                                                                                                                                                                                                                                                                                         |
| 5 Privacy             | Exclusion and sensitive-name lists; email/phone/Luhn/IBAN/identifier detectors; safe-category gate (all values suppressed on any failure); independent `assertNoRawValues` over documents **and finding evidence**                                                                                                                                                                  |
| 6 Sampling and limits | `full`/`systematic`/`recent`/`head` by capability (never substituted); D2 limits refused, never clamped (connection `profile.maxRows` required, 1,000–250,000 code ceiling, ≤ 500 fields, 60 min, 128 MiB estimate)                                                                                                                                                                 |
| 7 Publication         | Covering profile (same snapshot, completed, fresh 30 days within 1–90, non-`head`, coverage ≥ 0.5 or full+unbounded) for consequential entries; exemptions; acknowledgements (closed reason codes) recorded in `validation`; `date_format_required`; `holding_filter_domain_unknown`; override **disabled** (A1)                                                                    |
| 8 Drift and findings  | 33 finding codes (SQL CHECK parity test); classes A/E/B; drift A rules; fixed B guards in sync (`identity_field_absent`, `type_incompatible`, `representation_incompatible`; 50%, pre-write after 20 records and pre-tombstone)                                                                                                                                                     |
| 9 Seen-but-rejected   | `RunState.seenButRejected`; `protectionFor` (default protect); tombstone only when in neither set; gap attribution (account reference, then existing line); `rejected_record_unattributable`                                                                                                                                                                                        |
| 10 Reviewed domain    | `holdingFilter.reviewedDomain`; publish validation; runtime `holding`/`non_holding`/`unreviewed`; `mapping_requires_republish` for pre-M9A versions                                                                                                                                                                                                                                 |
| 11 Coverage tier      | `TIER_OF`; `proofOfRun`; tier from the newest qualifying run only; `proof_acceptances` (stable only); `EVALUATOR_VERSION = 3`; tier in `OwnershipInput`, `EligibilityResult`, facts hash and frozen snapshots                                                                                                                                                                       |
| 12 Sugar regression   | Sugar module diff empty; every M8 Sugar test passes (with the intended changes below)                                                                                                                                                                                                                                                                                               |
| 13 Tests              | Unit, property, integration, adversarial RLS, runtime `75-profiling.sh`, Docker image checks, 40 mutation proofs                                                                                                                                                                                                                                                                    |

## Migrations and schema changes

One migration, `apps/api/prisma/migrations/20261101120000_m9a_source_profiling/migration.sql`
(down-script `apps/api/prisma/rollback/20261101120000_m9a_source_profiling.down.sql`):

| Object                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_source_profile_runs` (new)         | PK `(tenant_id, id)`; FKs to connection and `(tenant, connection, snapshot hash)`; status CHECK; request ≤ 64 KiB, no secret-like keys; `active_key` unique per tenant (one active run per connection; Prisma-expressible instead of a partial index); trigger `app_profile_run_transition` (forward-only, terminal frozen, identity immutable, never deleted); tenant immutability; app role: SELECT, INSERT, UPDATE |
| `tenant_source_profiles` (new)             | FKs to run, sync run (checkpoint), connection, snapshot, previous profile (self); exactly one origin; family `profile`⇔run; document ≤ 1 MiB, no secret-like keys, `document_version = 1`, SHA-256 `content_hash`; unique `(tenant, run, object)` and `(tenant, sync_run, object)`; immutable (`app_profile_refuse_change`); app role: SELECT, INSERT                                                                 |
| `tenant_source_profile_findings` (new)     | FK to profile; code CHECK (33 codes, parity-tested against `FINDING_CODES`); class/severity CHECKs; names format; evidence ≤ 4 KiB, no secret-like keys; immutable; app role: SELECT, INSERT                                                                                                                                                                                                                          |
| `tenant_source_profile_purges` (new)       | FK to connection; counts ≥ 0; actor format; append-only (`app_refuse_change`); app role: **SELECT only** (written by the privileged purge)                                                                                                                                                                                                                                                                            |
| All four                                   | `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `tenant_isolation`, `app_prevent_tenant_change`                                                                                                                                                                                                                                                                                                                         |
| `app_session_in_app_role()` (new function) | Real (transitive) membership of `lip_app` for the session user; unlike `pg_has_role`, a superuser is **not** a member. Used by the purge-mode exception of the refuse-change trigger and by the purge store                                                                                                                                                                                                           |
| `tenant_ownership_gaps`                    | Reason CHECK + `observation_rejected`, `holding_filter_value_unreviewed`, `account_reference_orphaned`                                                                                                                                                                                                                                                                                                                |
| `tenant_source_authority_versions`         | `proof_acceptances jsonb NOT NULL DEFAULT '[]'` (array ≤ 16, ≤ 16 KiB, no secret-like keys); insert trigger: each element `{tier: stable_snapshot, connectionId, reason, actor}` naming a connection of the same tenant (`foreign_key_violation` otherwise); migration-time parity block: every existing version still hashes with the M8 rule and has empty acceptances                                              |

Prisma: four new models (`TenantSourceProfileRun`, `TenantSourceProfile`, `TenantSourceProfileFinding`,
`TenantSourceProfilePurge`) with `map:` names matching the SQL, back-relations, and
`TenantSourceAuthorityVersion.proofAcceptances`. The drift test (`prisma migrate diff --exit-code`) reports
no difference. The down-script refuses (and changes nothing) when profile rows, M9A gap reasons, non-empty
acceptances, mapping versions with a reviewed domain or evaluator-v3 snapshots exist; otherwise it restores the
exact M8 schema, and M9A re-applies (tested).

## Exact implementations

### Coverage tier (`domain/coverage.ts`, `subscription-runs.store.ts`, `eligibility.ts`, `eligibility.service.ts`)

- `TIER_OF` (frozen): `count`, `manifest` → `externally_grounded`; `operator_full_file`, `double_enumeration`,
  `success_marker` → `stable_snapshot`. `requiresAcceptance(m)` = stable and not `operator_full_file`.
- `proofOfRun(quality, fallback)` reads `quality.proof.method` and **re-derives** the tier from it (a stored tier
  is ignored); no proof → the fallback method, `inferred: true` (versioned → `count`, import → `operator_full_file`).
- `coverage()` picks the newest qualifying run (`completedAt desc`), so a weaker newer run lowers the tier;
  a stable adapter method without an acceptance on the latest authority version → `proof_not_accepted`
  (coverage unknown). It returns `{known, coverageTier, proof: {method, tier, connectionId, runId, completedAt,
inferred, acceptedInAuthorityVersion?}}`.
- Full Sugar runs record `quality.proof = {method: 'count', tier: 'externally_grounded', outcome: 'passed'}`;
  completed `import_full` runs record `{method: 'operator_full_file', tier: 'stable_snapshot', ...}`.
- `deriveOwnership`: for `stable_snapshot`, every `not_owned` becomes `unknown` (`coverage_tier_insufficient`);
  `coverageCheck` switches exhaustively (`assertNeverTier`). `EligibilityResult.coverageTier`, the facts hash and
  the frozen input (strict schema) carry the tier; `EVALUATOR_VERSION = 3`.

### Seen-but-rejected protection (`domain/source-protection.ts`, `source-sync.service.ts`)

- `protectionFor(code)`: `filtered_out`, `non_subscription_product` → not protected; reference-integrity codes →
  protected (`observation_rejected`, `account_reference_orphaned`, M8 product reasons); value rejections
  (`invalid_observation`, `record_rejected`, `missing_identity`, `malformed_row`, `unreviewed_holding_value`) and
  **any unknown code** → protected (`observation_rejected` / `holding_filter_value_unreviewed`).
- Sync `protect()`: removes the key from `holdingIds`, adds it to `seenButRejected`; attribution by
  `companyForRef(accountId)`, else `lineCompanyFor(object, recordId)`; attributable → gap (written by the existing
  `replaceWithin`/`addWithin`); unattributable value rejection → counted, run fails
  `rejected_record_unattributable` after the reads and before tombstones. A later accepted occurrence moves the key
  back to `holdingIds`. Tombstones require `mayTombstone(key, holdingIds, seenButRejected)`;
  `tombstones_suppressed` and `seen_but_rejected` are in the run quality.
- Engine: `record_rejected` carries its account; `unreviewed_holding_value` carries the best-effort account
  (primary reference, else the confirmed hop) for attribution.

### Reviewed holding-filter domain (`domain/holding-domain.ts`, `source-mapping-document.ts`, `source-mapping-engine.ts`)

- `reviewedDomain = {entries: [{value: string|null, classification: holding|non_holding}], snapshotHash, profileIds}`
  inside `holdingFilter` (immutable mapping document). `domainKey`: absent/null/empty/whitespace → `null`, else the
  trimmed string (as M8 compared); a structured value never maps to the empty entry.
- Publish (`validateReviewedDomain`): domain present, no duplicate, `null` entry present, every declared option and
  every observed (safe-category) value classified, consistent with the list (`in`: holding ⇔ listed; `not_in`:
  non-holding ⇔ listed), every listed value present, snapshot hash equal, cited profiles covering.
- Runtime `holdingClassOf`: `non_holding` → `filtered_out` (confident, tombstonable); `unreviewed` (either operator,
  including an unclassified empty value) → protected skip + gap; no domain (pre-M9A) → every value unreviewed; runs
  refuse such versions first (`mapping_requires_republish`).

### Privacy (`domain/profiling/privacy.ts`, `document.ts`, `accumulators.ts`)

- Accumulators keep ≤ 51 raw candidates (≤ 64 chars; + declared option count for enum fields) and 52-bit hashes
  (exact to 10,000, then HLL p14); hashes and sketches are never persisted.
- Gate order: excluded → sensitive name → sensitive value (`pii_value`) → `too_few_values` (n < 20) →
  `cardinality` (> 50, undeclared) → `cardinality_ratio` (> 0.05) → `value_length` → `pii_value` →
  `identifier_like`; any failure suppresses every value.
- `assertNoRawValues` re-runs all detectors over every string of the document and over every finding's evidence;
  a hit fails the run (`profile_privacy_violation`). Name paths (object, `fields[].name`, `undeclaredFields[]`,
  `sampling.orderedBy`) get the schema-name detectors; JSON key names get both; the single exemption is the
  platform-computed snapshot hash in its SHA-256 hex form (closure fix; before it, names were exempt).
- Schema names are source content (closure fix): field names that may not be stored become `redacted_field_<n>`
  everywhere M9A stores, prints or logs them; undeclared ones are counted only; an object whose name may not be
  stored is refused. See [Closure fix](#closure-fix-field-name-privacy).

### Profile CLI and jobs

- `sources profile-run | profile-status | profile-show | profile-findings | profile-drift | profile-purge` and
  `mappings-draft --from-profile`; `mappings-validate/publish --ack <findingId>:<reasonCode>` and
  `--profile-override` (always refused); `authority-publish --accept-proof <connectionId>:<reason>`. The CLI only
  parses arguments and calls services (no Prisma, no business logic); output carries ids, codes, counts and
  safe-category values only.
- `profile-run` refuses a code-mapped connection (`mapping_not_versioned`), a disabled connection
  (`connection_disabled`) and a kind with no adapter in the process (`adapter_not_registered`) before any run row.
- Job `source.profile` `{v: 1, tenantId, runId, correlationId}` on `lip-sources`; the existing processor dispatches
  by job name; exhausted retries mark the run failed and dead-letter through the M6 recorder.

## Intended M7/M8 test changes (safety corrections, not silent updates)

| Test                                                                                 | M7/M8 expectation                                     | M9A expectation                                                                                                                                                                    | Reason                                                    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `test/products/eligibility.int.spec.ts` › unknown before coverage… (`analytics`)     | `eligible` / `not_owned`; whitespace lists 4 products | `unknown` / `unknown` (`coverage_tier_insufficient`); no eligible whitespace (4 → `unknown`)                                                                                       | A2: CSV coverage is `stable_snapshot`                     |
| same, future-dated `reporting` before its start                                      | `not_owned`                                           | `unknown`                                                                                                                                                                          | A2                                                        |
| `test/products/eligibility.int.spec.ts` › frozen snapshots (`analytics`)             | `eligible` / `not_owned`, `evaluatorVersion: 2`       | `unknown` / `unknown`, `evaluatorVersion: 3`; replays still reproduce                                                                                                              | A2 + evaluator v3                                         |
| `scripts/verify-runtime.d/60-product-eligibility.sh` evaluate/whitespace and replay  | `eligible:not_owned`; replay recorded `eligible`      | `unknown:unknown:stable_snapshot:…:coverage_tier_insufficient`; 0 eligible whitespace; replay recorded `unknown`                                                                   | A2                                                        |
| `src/modules/domain/eligibility.spec.ts` evaluator version                           | 2                                                     | 3                                                                                                                                                                                  | evaluator v3                                              |
| `src/modules/domain/source-mapping-engine.spec.ts` › fixture 07 blank stage          | `not_in` admits the blank stage as a holding          | filtered out when the empty value is reviewed `non_holding`; unreviewed (protected) when unclassified; admitted only if explicitly classified `holding`                            | §10: closes the verified `not_in`/null false-holding path |
| same › holding filter semantics (`holdingFilterMatches`)                             | literal membership; empty never a member              | `holdingClassOf` through the reviewed domain                                                                                                                                       | §10                                                       |
| same › value-map rejection                                                           | `{skipped, record_rejected}`                          | plus `gapAccountId` (the record's account)                                                                                                                                         | §9.4 attribution                                          |
| `src/modules/domain/source-mapping.spec.ts` (identity, holding filter, runtime file) | M8 validator without profiles                         | every case runs with real covering profiles; a confirmed but duplicated undeclared identity is refused; `not_in` needs a consistent domain; an unlisted value is also unclassified | §7, §10                                                   |
| `test/sources/source-sync.int.spec.ts` (no-count, base-version tests)                | publish the raw test mapping                          | profile first, stamp the reviewed domain, acknowledge the identity finding                                                                                                         | §7, §10                                                   |
| `test/support/sources.ts` › `sugarTenant`                                            | snapshot → publish                                    | snapshot → profile run → publish with acknowledgements                                                                                                                             | §7                                                        |
| `scripts/verify-runtime.d/70-source-connectors.sh`                                   | publish the test file                                 | profile on the worker, stamp the domain, acknowledge the finding                                                                                                                   | §7, §10                                                   |
| `test/fixtures/sugar/mapping.test.json`, `test/fixtures/source-mapping.ts`           | holding filter without a domain                       | TEST-ONLY reviewed domain (Closed Won holding; other synthetic stages and empty non-holding)                                                                                       | A3                                                        |

No M8 ownership-gap assertion changed: in the M8 suites the protected fixture records (09, 10, 12) have no
existing line, so they keep M8 handling; the new gaps appear only in the new M9A scenarios.

## Deviations and interpretations (for the reviewer)

1. **Duplicates of an identity — approved two-tier rule (tech debt 46, approved by the independent implementation
   review; recorded in ADR 0022 §8).** Literal §7.3 refuses publication whenever the covering profile shows
   duplicate identity values; sanitized fixture 11 contains a duplicated line id, so no Sugar mapping could ever
   publish. The approved behaviour:
   - **undeclared / unconfirmed identity with duplicates → hard block**: a field the snapshot does not declare
     `id`/unique is refused (`identity_unsuitable`); there is no acknowledgement path;
   - **declared-unique identity with observed duplicates → acknowledgement path + unconditional quality signal**:
     publication needs an acknowledgement of the E-class `identifier_not_unique` finding on the consequential
     field (closed reason code, recorded with the version); the finding is always emitted and persisted with every
     profile (an acknowledgement never removes it), and M8's per-record `duplicate_external_id` keeps counting
     every duplicate in each sync's run quality (one row per source id).
2. **Profile retention (tech debt 45).** "Never delete a profile referenced by a kept profile" is transitive over
   baseline chains and would block D3 retention entirely. As built: keep the N newest per family, their direct
   baselines and every covering profile of a published mapping; a kept profile whose baseline is purged loses that
   link (`previous_profile_id → NULL`), the only change the refuse-change trigger permits, in purge mode, for a
   session that is not `lip_app` or a member of it.
3. **Superuser membership (found and fixed).** `pg_has_role(su, 'lip_app', 'MEMBER')` is true for superusers, which
   would have refused the owner purge. Replaced by `app_session_in_app_role()` (real membership) in the trigger and
   the purge store.
4. **`date_format_required` (tech debt 47).** M8 date transforms always declare a format, so the check refuses date
   entries whose covering profile shows ambiguous dates or mixed date/timestamp representations.
5. **`systematic` sampling (tech debt 44).** Port positions are opaque; the run reads pages sequentially and folds
   every k-th page (k = ⌈population / maxRows⌉), discarding the others immediately.
6. **Field profiles as an array.** Plan §3 shows `fields: {name: …}`; field names are stored as values
   (`fields[].name`) so a source field named like a secret neither trips the database secret-key CHECK nor leaks
   through a key.
7. **Detector refinements (tech debt 53).** The phone rule ignores date-shaped strings; embedded email addresses
   count as email hits. Both only increase suppression.
8. **Candidate cap for declared enums.** The 51-candidate cap would suppress the plan's own boundary case (declared
   enum with 300 observed options → stored); enum fields keep up to 51 + option-count candidates (bounded by the
   snapshot's 2,000-option limit; included in the memory estimate).
9. **Gate order.** `too_few_values` is checked before cardinality so that the plan's boundary row (n = 19 →
   `too_few_values`) holds; every other boundary row is unchanged.
10. **Advisory thresholds** (high null ratio 0.5, mixed 1% and 5 values, low coverage 0.5) are planning values (A
    class only); B thresholds are fixed constants (A4).
11. **Finding promotion (tech debt 48).** The policy guard exists and refuses any demotion/disabling or E/B code;
    no configuration surface for promoting A codes in M9A.
12. **Purge audit grant.** The plan revokes UPDATE/DELETE on the purge audit; INSERT is revoked from the app role
    too, so only the privileged purge writes it.
13. **`proof_acceptances` publish option and `--accept-proof`.** Added to the existing authority publish (no new
    command); acceptances can only name `stable_snapshot`, and the content hash is unchanged while empty.

## New technical debt

Items 44–54 in the [register](../tech-debt.md) (item 31 extended to `seenButRejectedIds`):
44 systematic sampling cost; 45 retention interpretation; 46 declared-identity duplicates (open question);
47 `date_format_required` interpretation; 48 no promotion surface; 49 sensitive-name substring over-match;
50 purge owner URL from `MIGRATION_DATABASE_URL`; 51 refused override audited by log + metric only;
52 run-quality profile not stored on a privacy/validation failure (counted); 53 detector refinements;
54 runtime stamping of the TEST mapping's snapshot hash.

## Open questions

1. ~~Tech debt 46~~: resolved: the two-tier duplicate-identity rule is approved (deviation 1).
2. Tech debt 45: confirm the retention interpretation (direct baselines kept; older links cleared by the purge).
3. Production values for `profile.maxRows` per connection (suggested 50,000) and the freshness window (30 days).
4. The holding stages and their reviewed domain for Juniper remain a **business** decision (TEST configuration
   only here); LIVE SUGAR VERIFICATION remains PENDING.

## Closure fix: field-name privacy

Independent implementation review of `0c5037a`: `PASS WITH REQUIRED FIXES — DO NOT MERGE`, one blocking finding.
Fix commit: **`c8560da`** (branch `claude/blissful-mendel-urbh4r`). M9B has NOT started; LIVE SUGAR VERIFICATION
remains PENDING.

**Root cause.** Source schema names are source-controlled content, but M9A treated them as metadata:
`assertNoRawValues` exempted `fields[].name` and `undeclaredFields[]` (and `object`, `sampling.orderedBy`) by
path, and no detector ever ran on a name before the document was built. A field called `acct_4111111111111111` is
a valid API name and is `sensitivity: normal` (no sensitive word), so it was persisted verbatim in documents,
findings (`field`), the run's stored request, `profile-run`/`profile-show` output and drafts. The unit test
`skips names and the snapshot hash, which are not source values` encoded the exemption; it is replaced
(intended correction) by `exempts only the platform-computed snapshot hash; names are scanned`.

**Fix.**

- `schemaNameHits(name)` (`privacy.ts`): a generic, deliberately broad schema-name detector set: the value
  detectors (email incl. embedded, phone, Luhn card, IBAN mod-97) over the whole name; any `@`; digit runs whose
  groups are joined only by separators (`4111_1111_1111_1111`, `44_20_7946_0958`) → card (13-19, Luhn), else ≥ 7
  digits → phone (≤ 15) or identifier; IBAN over one token or consecutive tokens; UUIDs with `-` or `_`; any single
  token of 16-64 characters mixing letters and digits; anything that is not an API name. An over-match only
  replaces a readable name by a token. Every field name of the Sugar fixture schema stays readable (tested).
- `profileNames(declared)`: a field name that may not be stored becomes **`redacted_field_<n>`**, n from 1 by sorted
  source name over the snapshot object's declared names (deterministic per snapshot; the token carries nothing of
  the name: no hash of a low-entropy value such as a card number). A source name already of the reserved form is
  itself replaced (no collision). The field profile carries `nameRedacted: true`.
- Applied everywhere M9A stores, prints or logs a name: documents (`fields[].name`, `sampling.orderedBy`), findings
  (`field`; identity sets are mapped to profile names), the run's stored request and opt-ins and
  `excludedLeftOut` (what `profile-run` prints), refusal messages (`(name withheld)`), drafts (redacted fields
  left out and counted in `redactedFields`; a sensitive declared id becomes `tbc`). The worker resolves tokens to
  source names through the snapshot before reading; the mapping validator resolves a mapping's source names to
  profile names the same way, so a mapping over such a field can still be covered (tested). `--fields` and
  `--include-excluded` accept a token or the source name. Logs and metrics carry ids and codes only (unchanged);
  the privacy error carries the detector and path, never the name.
- Undeclared names that may not be stored are counted (`undeclaredFieldsRedacted`, one `undeclared_field_in_data`
  finding with `{count, nameRedacted: true}` and no field), never listed. Keys that are not API names (e.g. with
  `@`) were previously dropped silently; they are now counted the same way.
- An object whose name may not be stored is refused (`source_object_name_sensitive`, never echoed): the object
  name keys every profile and finding.
- Defence in depth: `assertNoRawValues` has no blanket name exemption. Name paths get the schema-name detectors,
  JSON key names get both detector sets, and the single exemption is `schemaSnapshotHash` **only** when it is a
  64-character lower-case hex string (computed by the platform with SHA-256, never source-provided; such a string
  cannot hold an email, phone, card or IBAN). `assertNoRawFinding` scans a finding's `field` and evidence.
- Out of scope, by design (M8 stores): the schema snapshot and operator-authored mapping documents keep source
  names verbatim, because reading a field requires its name (ADR 0022 §4 note).

**Non-blocking items.**

1. `proof_acceptances` **cannot be updated after insert**: M8's `tenant_source_authority_versions_immutable`
   trigger refuses every UPDATE and DELETE unconditionally (all roles, owner included), so the INSERT-time
   membership check is sufficient; no change was needed. Now tested explicitly (`proof acceptances cannot be
changed after insert …`: refused for the app role and the owner, value unchanged) and proven able to fail (N12).
2. The approved two-tier duplicate-identity rule is documented (deviation 1, ADR 0022 §8, tech debt 46).

**New tests.** `schema-names.spec.ts` (45: every name class as a declared name, an undeclared name, in documents,
findings, drift, the stored request and refusal messages; the scan catches a builder that forgets the redaction
at every name path; no Sugar fixture name redacted); `source-mapping-profiles.spec.ts` (coverage through the
token); `privacy.spec.ts` (replaced exemption test); `profiling.int.spec.ts` (fake Sugar declaring a test card,
phone, IBAN, UUID and an excluded card field: no core in the run request, documents, findings, show, findings,
drift or draft; the M8 snapshot proves the names arrived); `profile-isolation.int.spec.ts` (`proof_acceptances`
immutability); runtime `75-profiling.sh` (second fake `--variant sensitive-names`: no core in `profile-run`,
`profile-status`, `profile-show`, `profile-findings`, `mappings-draft` output, the worker log or the M9A tables).

**Mutation proofs** (`mutate-names.py`, session scratchpad; each restored and re-run green):

| #   | Mutation                                                                                               | Failing test                                                                                                               | Failure                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Old field-name exemption restored in assertNoRawValues                                                 | a document builder that forgets the redaction is caught by the independent scan                                            | AssertionError: expected function to throw an error, but it didn't                                                                                                         |
| N2  | Builder redaction removed (names stored verbatim; scan intact)                                         | declared field acct_4111111111111111 (card)                                                                                | ProfilePrivacyViolationError: profile document failed the raw-value scan (card at fields[0].name)                                                                          |
| N3  | Pre-fix behaviour fully restored (every name-handling change undone): end to end                       | source field NAMES carrying sensitive content never reach the run, documents, findings, CLI output or drafts (closure fix) | AssertionError: 4111111111111111: expected '{"request":{"dryrun":false,"runid":"f…' not to contain '4111111111111111'                                                      |
| N4  | Pre-fix behaviour fully restored: acct_4111111111111111 unit proof                                     | acct_4111111111111111 cannot appear in a persisted document, a drift finding or a finding field                            | AssertionError: expected '{"before":{"v":1,"object":"Things","c…' not to contain '4111111111111111'                                                                        |
| N5  | Undeclared sensitive names listed verbatim                                                             | undeclared field acct_4111111111111111 (card) is counted, never listed                                                     | ProfilePrivacyViolationError: profile document failed the raw-value scan (card at undeclaredFields[0])                                                                     |
| N6  | Stored request holds source names                                                                      | the validated request (stored on the run, printed by profile-run) holds tokens only                                        | AssertionError: expected [ 'acct_4111111111111111', 'status' ] to deeply equal [ 'redacted_field_1', 'status' ]                                                            |
| N7  | Finding field name not scanned                                                                         | a finding naming a sensitive field is caught before persistence                                                            | AssertionError: expected [Function] to throw an error                                                                                                                      |
| N8  | Snapshot-hash exemption broadened to any string                                                        | a document builder that forgets the redaction is caught by the independent scan                                            | AssertionError: expected [Function] to throw an error                                                                                                                      |
| N9  | Mapping validation looks profiles up by source name (no token resolution)                              | a consequential entry over a source name that cannot be stored is covered through its token (closure fix)                  | AssertionError: expected [ { code: 'profile_required', …(2) } ] to deeply equal []                                                                                         |
| N10 | Draft keeps redacted fields                                                                            | source field NAMES carrying sensitive content never reach the run, documents, findings, CLI output or drafts (closure fix) | AssertionError: expected { draft: true, …(5) } to match object { redactedFields: { …(1) } }                                                                                |
| N11 | Schema-name detectors miss digit runs (card/phone in names)                                            | acct_4111111111111111 → card                                                                                               | AssertionError: expected [] to include 'card'                                                                                                                              |
| N12 | Authority versions made updatable (immutability trigger removed): proof_acceptances could be rewritten | proof acceptances cannot be changed after insert: authority versions are immutable for the app role and the owner          | AssertionError: expected { ok: 1 } to match object { message: StringMatching{…} }                                                                                          |
| R1  | Pre-fix behaviour fully restored (as N3), whole `pnpm verify:runtime`                                  | `sensitive source field NAMES never reach …`                                                                               | `== Summary: 149 passed, 1 failed` (only this check); the kept output shows `acct_4111111111111111` verbatim in `names-run.json`, `names-show.json` and `names-draft.json` |

N3/N4 restore every name-handling change at once (builder redaction, undeclared listing, stored request, finding
field check, worker token resolution, blanket scan exemption). A first N3/N4 attempt restored only part of it and
failed for a different reason (the new finding-field check, or the token-shape assertion before the leak check);
the integration test now asserts the leak before the token shape and the mutation was made faithful.

**Verification at `c8560da`.**

| Command                                                                                                                                  | Result                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| targeted: `vitest run schema-names.spec.ts`, `source-mapping-profiles.spec.ts`; `profiling.int.spec.ts`, `profile-isolation.int.spec.ts` | 45 + 25 unit; 17 + 26 integration passed                                                                                                                                                                                                                                              |
| `pnpm verify`                                                                                                                            | unit **840 passed (60 files)**; integration **414 passed (24 files)**; `no dependency violations found (322 modules, 1372 dependencies cruised)`. Run 1 stopped at `prettier --check` (`docs/tech-debt.md` table not reformatted after the edit); formatted; run 2 green. Not a flake |
| `pnpm verify:runtime`                                                                                                                    | `== Summary: 150 passed, 0 failed` (first attempt)                                                                                                                                                                                                                                    |
| `pnpm verify:docker` (Linux sandbox, `LIP_DOCKERFILE=Dockerfile.sandbox`, `--network host --build-context ca=…`)                         | `== Summary: 23 passed, 0 failed`; cleanup verified (first attempt)                                                                                                                                                                                                                   |
| fresh clone at `c8560da`                                                                                                                 | in progress (result recorded in the next commit)                                                                                                                                                                                                                                      |

**Docker environment.** All Docker results in this record come from a Linux sandbox using the scratchpad
`Dockerfile.sandbox` (the repository Dockerfile plus the sandbox proxy CA) and `--network host`. The independent
reviewer reproduced **22 passed / 1 failed on macOS**: with `--network host`, Docker Desktop does not expose the
Linux VM's container port to the Mac host. That result is recorded, not hidden; Docker verification was not
redesigned in this fix. Linux CI (`.github/workflows/ci.yml`, job `docker`, `ubuntu-latest`) runs only on pull
requests and pushes to `main`; there is no open PR for this branch (none was requested), so no Linux CI
confirmation of `23/0` is available yet.

## Evidence

Implementation SHA: **`0c5037a15677c10c7ff3a1c261b24693e12ba0a2`** (branch `claude/blissful-mendel-urbh4r`, pushed).
Diff against the approved planning merge `73bc0c6`: 88 files changed, 12,205 insertions, 442 deletions (40 new
files). `git diff 73bc0c6 0c5037a -- apps/api/src/modules/sugar` is empty (the Sugar adapter is unchanged;
`ReadRequest.purpose` defaults to `sync`). Later commits on the branch touch this record only.

### Gates (working tree, at `0c5037a`)

| Command                                                                                                    | Result                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify` (format, lint, typecheck, dependency-cruiser, unit, integration)                             | unit **794 passed (59 files)**; integration **412 passed (24 files)**; `no dependency violations found (321 modules, 1361 dependencies cruised)`                                                                                               |
| `pnpm verify:runtime`                                                                                      | `== Summary: 149 passed, 0 failed`                                                                                                                                                                                                             |
| `LIP_DOCKERFILE=… LIP_DOCKER_BUILD_ARGS="--network host --build-context ca=/root/.ccr" pnpm verify:docker` | `== Summary: 23 passed, 0 failed`; `Cleanup verified: no containers, volumes, networks or images … remain` (includes `migrate job applies the M9A profiling migration` and `profile-status` / `profile-run` / `profile-show` inside the image) |

### Failed runs (investigated and recorded; none accepted by retry)

1. `pnpm verify` run 1 stopped at `prettier --check` (`apps/api/test/support/fake-sugar.ts` unformatted). Fixed by
   formatting (`d27b069`); run 2 passed. Not a flake.
2. `pnpm verify:runtime` run 1: 148 passed, 1 failed (`full sync records a count proof …`). Cause: the check compared
   the stored proof as a JSON string, and jsonb does not keep key order. **Defect in the check**, fixed to compare
   field by field. Not a flake.
3. `pnpm verify:runtime` run 2: 148 passed, 1 failed (same check, next assertion). Cause: the check expected
   `owned` for FIX-ACC-001 / fix-prod-001, but the Sugar TEST mapping declares `subscription.state` explicitly
   `unknown` (M8, `no_reliable_source_state`), so a present line is correctly `unknown`
   (`subscription_state_unknown`). **Defect in the check** (the product behaved as designed); the check now asserts
   tier `externally_grounded`, coverage `pass` and `subscription_state_unknown` (`0c5037a`). Run 3: 149 passed.

### Fresh clone (mandatory) at the exact SHA

`$S/freshclone-m9a.sh`: clone of `claude/blissful-mendel-urbh4r`, `pnpm install --frozen-lockfile`, then all three
gates, then a resource check:

```
### RESOURCES BEFORE: app_procs=0 lip_containers=0 all_containers=0 volumes=0 compose_networks=0 lip_images=0 testcontainers=0
### HEAD 0c5037a15677c10c7ff3a1c261b24693e12ba0a2 expected 0c5037a15677c10c7ff3a1c261b24693e12ba0a2
### HEAD matches gate SHA
### install exit=0
 no dependency violations found (321 modules, 1361 dependencies cruised)
 Test Files  59 passed (59)
      Tests  794 passed (794)
 Test Files  24 passed (24)
      Tests  412 passed (412)
### VERIFY exit=0
== Summary: 149 passed, 0 failed
### RUNTIME exit=0
### DOCKER attempt 1 exit=0
== Summary: 23 passed, 0 failed
### RESOURCES AFTER: app_procs=0 lip_containers=0 all_containers=0 volumes=0 compose_networks=0 lip_images=0 testcontainers=0
### clone removed
```

Every gate passed on its first attempt in the clone (Docker attempt 1; no retry used).

### Mutation proofs (each check seen to fail for the right reason)

Harness `mutate-m9a.py` (session scratchpad): each mutation edits one mechanism, runs the targeted spec (or
dependency-cruiser), requires a failure **in the named test**, restores the file and confirms green. 40 of 40
failed as expected (row 33 covers RLS removed on each of the four tables). The named test is the first failing test.

| #   | Mutation                                                        | Failing test (proof)                                                                                                      |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Empty string counted as null                                    | distinguishes null, empty string and whitespace-only                                                                      |
| 2   | JSON-encoded array classified as string                         | native, JSON-encoded and delimited arrays are told apart                                                                  |
| 3   | Malformed JSON not counted                                      | malformed JSON is counted and classification continues                                                                    |
| 4   | 1/0 alone suggests boolean (high)                               | boolean: one representation is high; {0,1} integers alone are only medium                                                 |
| 5   | Ambiguous date reported high confidence                         | date: ISO high, d/m/y medium, any ambiguous date low                                                                      |
| 6   | Safe-category cardinality <= 50 -> <= 51                        | distinct = 51 (undeclared): suppressed cardinality                                                                        |
| 7   | Length gate <= 64 -> <= 65                                      | a value of exactly 64 characters is stored; 65 is suppressed value_length                                                 |
| 8   | One PII value suppresses only itself (gate ignores PII)         | one email among 49 status values: every value suppressed (pii_value)                                                      |
| 9   | Privacy pass skipped before persistence                         | seeded personal and payment values never appear in documents or findings                                                  |
| 10  | assertNoRawValues disabled                                      | passes aggregate-only documents and flags any detector hit in any string                                                  |
| 11  | Profile limit clamped instead of refused                        | --max-rows above the connection value or below the minimum is refused, never clamped                                      |
| 12  | Hard ceiling read from configuration                            | the ceiling is code: no configuration raises it                                                                           |
| 13  | Covering-profile requirement skipped                            | no profile at all: profile_required                                                                                       |
| 14  | Exempt entries demand a profile                                 | exempt entries need no profile: ignored, explicit and value-independent declarations                                      |
| 15  | Override accepted without an authenticated operator             | any override attempt is refused, even when it is the only problem                                                         |
| 16  | Override skips acknowledgements                                 | an override never removes another error (profile_required and acknowledgements stay)                                      |
| 17  | identity_field_absent guard removed                             | identity_field_absent fails the run before any write                                                                      |
| 18  | Incompatible type guard removed                                 | type_incompatible fails the run before any write                                                                          |
| 19  | Tombstone pass ignores seenButRejected                          | an isolated single rejected record keeps its line, gives its account a gap and makes eligibility unknown                  |
| 20  | protectionFor default -> delete                                 | an unknown or future rejection code is protected by default, never deleted                                                |
| 21  | Rejected record's gap not recorded                              | an isolated single rejected record keeps its line, gives its account a gap and makes eligibility unknown                  |
| 22  | Unattributable rejection completes the run                      | an unattributable value rejection fails the run: no tombstones, gaps and coverage unchanged                               |
| 23  | `in` unreviewed treated as non-holding                          | in: an unreviewed value on an existing line keeps it unchanged and makes the account unknown                              |
| 24  | `not_in` unreviewed treated as holding                          | not_in: an unreviewed value never becomes a holding; a reviewed empty value is filtered out                               |
| 25  | Mandatory null entry not required                               | a not_in domain without a classified empty value is refused at publish                                                    |
| 26  | coverageTier not persisted (proof omitted)                      | a Sugar full run records a count proof: externally grounded, propagated into eligibility and snapshots                    |
| 27  | Tier dropped between coverage and eligibility                   | records the proof; coverage is known without acceptance; owned holds, absence is unknown, no whitespace                   |
| 28  | Older externally grounded run preferred over a newer stable run | no promotion: a newer stable run lowers the tier; acceptance gives stable_snapshot, never externally grounded             |
| 29  | Acceptance yields externally_grounded                           | no promotion: a newer stable run lowers the tier; acceptance gives stable_snapshot, never externally grounded             |
| 30  | stable_snapshot keeps not_owned                                 | stable_snapshot keeps positive ownership but never concludes absence or whitespace                                        |
| 31  | Tier rule applied to externally_grounded                        | externally grounded coverage still yields eligible whitespace when otherwise eligible                                     |
| 32  | profiling-is-advisory violated                                  | x 1 dependency violations (1 errors, 0 warnings).                                                                         |
| 33  | RLS removed on tenant_source_profile_runs                       | tenant_source_profile_runs: A sees none of B rows and only its own tenant                                                 |
| 33  | RLS removed on tenant_source_profiles                           | tenant_source_profiles: A sees none of B rows and only its own tenant                                                     |
| 33  | RLS removed on tenant_source_profile_findings                   | tenant_source_profile_findings: A sees none of B rows and only its own tenant                                             |
| 33  | RLS removed on tenant_source_profile_purges                     | tenant_source_profile_purges: A sees none of B rows and only its own tenant                                               |
| 34  | Profile documents mutable (trigger removed)                     | profiles and findings are immutable for the app role                                                                      |
| 35  | Purge allowed for the app role (owner check removed)            | the purge refuses the app role and, with owner credentials, keeps the newest N and referenced profiles, with an audit row |
| 36  | TIER_OF.operator_full_file -> externally_grounded               | records the proof; coverage is known without acceptance; owned holds, absence is unknown, no whitespace                   |
| 37  | Acceptance demanded for operator_full_file (CSV coverage drops) | records the proof; coverage is known without acceptance; owned holds, absence is unknown, no whitespace                   |

Two further manual mutations on the profiling request refusals (`source-profiling.service.ts`), each restored:

| Mutation                          | Result                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| disabled-connection check removed | `× refuses a disabled connection and a kind with no adapter …` — expected `connection_disabled` (line 215) |
| adapter check removed             | same test — expected `adapter_not_registered`, received `no_schema_snapshot`                               |

## Confirmation

M9A only. No Chargebee, S3/file, warehouse, signal, opportunity or M9B implementation. No production writes to
any customer system (adapters stay read-only; profiling reads with `purpose: 'profile'`). No credentials
requested, committed or logged. **M9A is not claimed closed**: it awaits independent implementation review.
**M9B has NOT started. LIVE SUGAR VERIFICATION remains PENDING.**
