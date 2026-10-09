# Canonical Architecture v1 Candidate — E7: Data quality and structured values

Part of the [Canonical Architecture v1 Candidate](CANDIDATE.md). Status: **candidate for review**.

## 1. What exists today (`IMPLEMENTED TODAY`)

- Closed transform set and typed parses: Unix seconds, enum value maps with `unknown`, number/date parsing
  (ADR 0020/0024).
- Run guards (B guards) that fail a run before writes on structural failure.
- Seen-but-rejected protection. The Chargebee adapter's structurally invalid entries become rejection rows that carry
  only readable ids.
- `record_rejected` / `seen_but_rejected` counters; ownership gaps (`observation_rejected`, …); identity conflicts;
  dead letters (M6).
- Profile parse-failure, representation and detector counts (M9A).
- **Privacy rule:** no raw source values in run records, findings, logs or gaps. Only codes and counts.

What is missing: a durable, observable **rejected observation** record with a resolution lifecycle, and a normalized
candidate.

## 2. Issue taxonomy and disposition

| Issue                                                 | Default disposition                                                                            | Notes                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| number represented as string (`"12"`)                 | **normalize** automatically (typed parse)                                                      | locale-ambiguous numbers (`1.234`) → hold for review unless the mapping declares the locale |
| boolean tokens (`"Y"`, `"true"`, `1`)                 | **normalize** with the mapping's declared token set                                            | undeclared tokens → reject                                                                  |
| date/time in a declared format                        | **normalize**                                                                                  | impossible dates → reject; ambiguous (`01/02/03`) → hold unless the format is declared      |
| enum value unknown                                    | map to `unknown` where the target allows it (`IMPLEMENTED TODAY`); else **hold for review**    | never guessed                                                                               |
| dropdown returned as JSON (`{"value":"A"}`)           | **transform** with a declared extraction transform (closed set: `json_field`)                  | undeclared shape → reject                                                                   |
| multi-select as array / delimited string              | **transform** into a collection (§4) with a declared representation                            | mixed representations in one field → hold                                                   |
| nested object where a scalar is expected              | **reject** (unless a declared extraction transform applies)                                    |                                                                                             |
| malformed email                                       | **normalize** whitespace/case; invalid → **reject the field** (record kept without that value) | email is never identity (ADR 0014)                                                          |
| null in a required target                             | **reject the record** for that entity                                                          | protected by seen-but-rejected (no tombstone, no retirement)                                |
| duplicate identifier in one read                      | **reject all occurrences** (`IMPLEMENTED TODAY` for child keys) + identity conflict            | never last-write-wins                                                                       |
| value exceeds a limit (length, array size, JSON size) | **reject the field**                                                                           | never truncated                                                                             |

Dispositions are declared per mapping entry or per transform. The default for anything undeclared is **reject**,
never silent coercion.

## 3. Rejected observation (owner decision 5)

A durable record per rejected field or record (`PROPOSED FOR V1 CANDIDATE`). Its parts are kept **separate**:

| Part                             | Content                                                                                                                                                                                                 | Storage rule                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source reference                 | system, connection, object, record id (when readable), field path                                                                                                                                       | always (identifiers only)                                                                                                                                                                                                                                                                                                       |
| Run / mapping                    | run id, mapping version, schema snapshot hash, canonical version                                                                                                                                        | always                                                                                                                                                                                                                                                                                                                          |
| Reason code                      | closed set (`unparseable_number`, `invalid_email`, `unknown_enum_value`, `nested_not_scalar`, `required_missing`, `duplicate_identifier`, `limit_exceeded`, …)                                          | always                                                                                                                                                                                                                                                                                                                          |
| Safe diagnostic metadata         | observed type class, representation, length bucket, detector hit flags (email/phone/card/iban), declared vs observed type, element counts                                                               | always — **no value content** (the M9A privacy classifiers decide what is safe)                                                                                                                                                                                                                                                 |
| Normalized candidate value       | the value the platform would write if a human accepts it (e.g. a parsed number, a canonical enum code)                                                                                                  | only when **all** hold: the target field's sensitivity is `internal` or `confidential` (never `personal` or `restricted`), no privacy detector fired on the raw or candidate value, and the field is not free text; kept at most for the candidate retention guardrail (default 30 days, configurable) and purged on resolution |
| Raw source payload **reference** | source coordinates only: connection + object + record id + field path (to re-read the value from the source system)                                                                                     | always; **never** a pointer to a platform-held copy (no content-store key, no blob) while raw retention is disabled                                                                                                                                                                                                             |
| Optional raw / sensitive value   | the raw value                                                                                                                                                                                           | **disabled** by default; policy-gated per tenant + field sensitivity + retention; stays **off** until the privacy decision (tech debt #15) is made                                                                                                                                                                              |
| Resolution state                 | `open` → `resolved_by_reprocess` (fixed at source / mapping changed and reread succeeded) / `accepted_candidate` (human accepted the normalized candidate) / `ignored` (reason) / `expired` (retention) | always; every transition is a change record with actor                                                                                                                                                                                                                                                                          |

- Rejected observations are tenant-scoped, forced RLS, retention-bounded and visible in the future Data Intelligence
  Console (data built in M10L; console views in M15).
- A rejected **record** is protected: no tombstone and no reference retirement (`IMPLEMENTED TODAY` semantics).
- Accepting a candidate writes through the entity's single writer, with `origin = human`.

## 4. Arrays, JSON, multi-select and nested structures

Where a structured source value goes (decision order):

1. **Canonical structured value.** The canonical field is itself a collection: Account `domains[]`
   (`IMPLEMENTED TODAY`), Person `roles[]`. The value is written as a typed collection after element-level validation.
2. **Normalized child records.** Elements have their own identity: Chargebee `subscription_items[]` → derived child
   object → Subscription lines (`IMPLEMENTED TODAY`, G4); CRM opportunity line items → Opportunity lines; participants
   → Activity participants.
   - The adapter declares the derived object (`classification: derived`, stable composite ids). The platform never
     invents identities.
3. **Extension typed collection.** The tenant needs the values but they have no identity: tags, multi-select picklists,
   lists of codes → `multi_enum` or `array` custom field (E4), with element type validation and ordering rules.
4. **Extension JSON value.** Genuinely structured data with no business-level fields yet: configuration blobs,
   integration metadata → `json` custom field, schema-subset validated, size-capped, not queryable by configuration
   in v1.
5. **Source payload reference.** Everything else stays at the source and is referenced, not copied. Re-read on demand
   through the connector.

Rules:

- **Never stringify blindly.** A JSON-encoded string, a native array and a delimited string are distinguished by the
  declared representation (`SourceField.nested`, M9A representation classes; `IMPLEMENTED TODAY` for profiling).
- Original source information is preserved by reference (5): later transformations or promotions can re-derive values
  without loss.
- Element-level rejections follow §2 (one bad element rejects the field, not the record, unless the field is required).

## 5. End-to-end trace: "raw storage disabled" cannot become indirect raw retention

With raw/sensitive retention **disabled** (owner decision 5; until the privacy decision, tech debt #15), every path a
rejected or raw value could take is closed or bounded:

| Path                                            | What happens to the raw value                                                                                                                                                                   | Indefinite raw PII possible? |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Adapter read                                    | in memory only for the page; Zod-validated; undeclared attributes dropped unread (`IMPLEMENTED TODAY`)                                                                                          | no                           |
| Rejected observation: reason, diagnostics       | codes, classes, buckets and detector flags only — no content                                                                                                                                    | no                           |
| Rejected observation: normalized candidate      | omitted for `personal` / `restricted` fields, detector hits and free text; otherwise TTL-bounded (default 30 days, configurable guardrail) and purged on resolution or expiry                   | no (bounded, non-sensitive)  |
| Rejected observation: payload reference         | source coordinates only; re-reading needs the live source and its credentials; nothing is copied                                                                                                | no                           |
| Run records, findings, gaps, dead letters, logs | codes and counts only (`IMPLEMENTED TODAY`; tests assert no values in logs, CLI output or profiles)                                                                                             | no                           |
| Profiles (M9A)                                  | statistics and redacted field names only; samples are not stored (`IMPLEMENTED TODAY`)                                                                                                          | no                           |
| Source attribute capture (E4 §5)                | fields classified `sensitive_by_name` / `sensitive_by_value` become `restricted` and are **not stored** while raw retention is disabled                                                         | no                           |
| Extension values and value history              | only accepted, validated values of registered fields; `personal` fields follow the field's retention policy; value history of `personal` / `restricted` fields is off unless a policy allows it | bounded by policy            |
| Engagement content (transcripts, bodies)        | separate governed content store, **off by default**, own retention and sensitivity (E3 §12); never used to hold rejected values                                                                 | no (off by default)          |
| Accepting a candidate                           | the accepted value is written through the single writer as ordinary data (`origin = human`) under that field's policy; the rejected observation keeps only the resolution                       | no                           |
| Backups / replicas                              | inherit the primary store's retention; erasure propagation is part of the privacy decision (tech debt #15)                                                                                      | out of scope, recorded       |

Rule: **no store may hold a raw rejected value unless the raw-retention policy is explicitly enabled for that tenant
and field sensitivity**, and enabling it requires the privacy decision first. Each implementing milestone's design is
checked against this table.
