# ADR 0022: Source data profiling (Milestone 9A)

- Status: accepted for implementation (M9A plan approved; implementation awaiting independent review)
- Date: 2026-10-08
- Plan: [M09A source data profiling plan](../milestones/M09A-source-data-profiling-plan.md) (§1–§8, §13–§14)
- Live status: **LIVE SUGAR VERIFICATION: PENDING** (profiling ran only against the fake Sugar)

## Context

M8 maps source fields into canonical observations, but every mapping
decision (identity, references, holding filter, date format, value maps)
was made from schema metadata and a handful of discovery samples. Multi-source
work (M9) needs evidence about the data each mapping depends on, without
copying source records into the platform and without letting a statistical
"suggestion" make a business decision.

## Decision

1. **Generic, deterministic profiling.** A profile is computed through the
   generic `SourceConnector` port (`ReadRequest.purpose = 'profile'`,
   exactly the selected fields), never through a vendor-specific path. The
   engine (`src/modules/domain/profiling/`) is pure: per-value classifiers
   (closed rule list, §4.1), bounded mergeable accumulators, suggestions,
   privacy, findings and drift. No ML, no LLM. Any page split or merge order
   gives the same document (property-tested).
2. **Advisory only.** Profiling describes; it never decides. The dependency
   rule `profiling-is-advisory` forbids `domain/profiling/` from importing
   authority, the mapping engine, eligibility or the domain barrel.
   Suggestions name technical interpretations only (never a canonical target);
   `mappings draft --from-profile` writes a draft with `entity: "tbc"` and
   every field `ignored`, and never publishes.
3. **Aggregates only.** Documents (schema `v: 1`, Zod-validated) hold counts,
   ratios, classes, representation codes, magnitude/period buckets and length
   quantiles. Field names are stored as values (`fields[].name`), never as
   JSON keys, so a source field named like a secret cannot trip the database
   secret-key check or leak through keys.
4. **Privacy (§5).** Excluded names (credentials, cards, IBAN, national ids,
   birth dates…) and payment-like objects are not profiled without an
   audited per-field opt-in (shape and counts only). Sensitive names and
   values (email, phone, Luhn, IBAN mod-97, identifier-like) suppress raw
   values. The **safe-category gate** is the only path for raw values:
   sensitivity normal, declared enum or ≤ 50 distinct with ratio ≤ 0.05,
   every value ≤ 64 characters, no detector hit, n ≥ 20; any failure
   suppresses every value of the field. After the gate and Zod validation, an
   **independent** scan (`assertNoRawValues`) re-runs every detector over
   every string of the document (and of every finding's evidence); a hit
   fails the run with `profile_privacy_violation` and nothing is persisted.
   **Schema names are source content (closure fix).** Object, field,
   undeclared and JSON key names are chosen by the source, so a field may be
   called `acct_4111111111111111`. A generic schema-name detector set
   (`schemaNameHits`: the value detectors plus digit runs joined by separators
   → card/phone/identifier, IBAN over one or consecutive tokens, UUIDs, long
   mixed tokens, anything that is not an API name) decides whether a name may
   be stored. A field name that may not is replaced everywhere M9A stores,
   prints or logs it (documents, findings, the run's stored request and
   opt-ins, CLI output, drafts, refusal messages) by `redacted_field_<n>`: n by
   sorted source name over the snapshot's declared names, so it is
   deterministic per snapshot and carries nothing of the name (no hash of a
   low-entropy value); the field profile is marked `nameRedacted` and the worker
   and the mapping validator resolve the token through the snapshot, so a
   mapping can still be covered. Undeclared names that may not be stored are
   counted (`undeclaredFieldsRedacted`), never listed. An object whose name may
   not be stored is refused (`source_object_name_sensitive`): the object name
   keys every profile. `assertNoRawValues` no longer exempts names: name paths
   get the schema-name detectors; the single exemption is the platform-computed
   snapshot hash, and only in its SHA-256 hex form. Out of scope (M8 stores, by
   design): the schema snapshot and operator-authored mapping documents keep
   source names verbatim, because reading a field requires its name.
5. **Limits (approved D2): refuse, never clamp.** A per-connection
   `profile.maxRows` is required (no default; 1,000–250,000; suggested
   50,000); the 250,000 ceiling is a code constant. ≤ 500 fields per object,
   ≤ 60 minutes per run, ≤ 128 MiB accumulator estimate per run. Sampling
   methods (`full`, `systematic`, `recent`, `head`) follow the object's
   declared capabilities and are never substituted (`sampling_unsupported`).
6. **Persistence (four tables, ADR 0008).** `tenant_source_profile_runs`
   (forward-only lifecycle enforced by a trigger, one active run per
   connection), `tenant_source_profiles` and `tenant_source_profile_findings`
   (immutable; the app role has no UPDATE/DELETE), and
   `tenant_source_profile_purges` (append-only audit; the app role cannot
   write it). Every table: tenant-leading keys, composite tenant FKs, forced
   RLS, tenant immutability.
7. **Lifecycle.** `profile-run` validates (dry run by default) and enqueues
   `source.profile` (ids only) on `lip-sources`; the existing processor
   dispatches by job name. A transient source error retries the job and the
   retried attempt restarts from scratch; any other error fails the run with
   a code; profiles and findings are written with the run's completion in one
   transaction (all or nothing).
8. **Publication uses profiles (§7).** A mapping version publishes only when
   a completed, fresh (30 days; 1–90 per connection), non-`head`,
   same-snapshot profile covers every consequential, source-value-dependent
   entry; review-required findings on consequential fields are acknowledged
   with a closed reason code (recorded with the version); date entries over
   ambiguous or mixed representations are refused (`date_format_required`);
   holding filters need a known domain. Ignored/explicit entries and
   value-independent declarations are exempt.
   **Identity duplicates — approved two-tier rule** (independent implementation
   review): (a) an identity field the snapshot does **not** declare id/unique
   (an undeclared or unconfirmed identity) whose covering profile shows
   duplicate values is a **hard block** (`identity_unsuitable`; no
   acknowledgement path); (b) a field the snapshot **declares** id/unique whose
   profile still shows duplicates may publish only through the acknowledgement
   path (the E-class `identifier_not_unique` finding on the consequential
   field, closed reason code, recorded with the version) **and** keeps an
   unconditional quality signal: the finding is always emitted and persisted
   with every profile (an acknowledgement never removes it), and M8's
   per-record `duplicate_external_id` keeps counting every duplicate in each
   sync's run quality.
9. **Override (D5, decision A1): ships disabled.** There is no authenticated
   operator channel (the CLI actor is free text). Any `--profile-override` is
   refused with `override_requires_authenticated_operator`, counted
   (`lip_profile_override_total{kind="refused"}`) and logged; the scope and
   reason checks exist but can never remove another error. No configuration
   flag can enable it.
10. **Retention (D3) is privileged.** `profile-purge` runs only with the
    schema owner's credentials (refused for `lip_app` and its members, by the
    service and independently by the database trigger). It keeps the N newest
    per family, their direct baselines and every profile a published mapping
    version cites as covering, and writes an audit row in the same transaction.
11. **Run-quality profiles.** Every sync run also stores a `sync`-family
    profile of the mapped fields (same engine, same privacy pass) in its
    completion transaction; drift compares within a family.

## Consequences

- Mapping publication now depends on a recent profile; an outage of
  profiling blocks publication (fails closed; acceptable: publications are rare).
- Profile reads add source load (shared per-connection rate limiter;
  tech debt 37 applies).
- `systematic` sampling reads pages sequentially and folds every k-th page:
  port positions are opaque, so pages cannot be skipped (deviation recorded in
  the M9A record).
- Advisory thresholds (high null ratio 0.5, mixed 1% and 5 values, low
  coverage 0.5) are planning values; B-guard thresholds are not configurable
  (ADR 0023).
