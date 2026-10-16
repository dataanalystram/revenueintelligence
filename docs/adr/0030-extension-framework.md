# ADR 0030: Extension framework — typed values, custom records, custom relationships and canonical 0.4 (Milestone 10D)

- Status: **Accepted** — implemented, in review (PR #60 `m10d-impl` → `integration`; not merged)
- Date: 2026-10-15
- Plan: [M10D plan](../milestones/M10D-extension-framework-plan.md) (owner defaults Q1–Q34 apply)
- Record: [M10D record](../milestones/M10D-extension-framework.md)
- Builds on: ADR 0020 (versioned source mapping and authority), ADR 0026 (security foundation), ADR 0027 (canonical
  versioning and governance), ADR 0028 (generic source references, evidence links), ADR 0029 (account hierarchy,
  person–account affiliation, canonical 0.3)
- Candidate: implements E4 (extension framework: registry, definitions, X1–X5, guardrails, value storage option A,
  mapping, capture; revision R1) and the E7 collection / JSON representation. Promotion (E4) is not implemented.
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.

## Context

Before M10D a tenant could only store what the canonical model names. Source attributes outside it were either
dropped or held as reserved `attribute` mapping entries that wrote nothing, and there was no way to describe a
tenant-specific object (for example a Sugar custom module) or a relationship between such objects. The M10 plan (§9,
option A approved in E4; §15 M10D) requires typed, tenant-scoped extension data **without per-tenant DDL**, with a
classification on every definition, no secrets stored as extension data, guardrails a single tenant cannot exceed,
and a hard rule that extension data never feeds ownership, identity or (in M10D) eligibility.

## Decision

1. **Registry kind `extension` (Q2, Q3).** The M10A2 registry gains the kind `extension`: one document per tenant
   holding custom field, custom object and custom relationship definitions in one key namespace (`src_` reserved
   for captured fields). Publish validates types, constraints, guardrails, classification, `allowed_uses` and
   `not_evidence_of`, and the cross-version rules X1–X5 plus **R-X6** (sensitivity and categories only become
   stricter; a looser classification needs a new key, Q11). X5 probes stored values before a narrowing is accepted
   (enum values removed, length / range / scale tightened, a fixed `currency` added or changed on a money field).
   Tightening a field to `restricted` is refused while values exist (Q10). `promoted` is refused (Q28). The
   `extension` document cap is the guardrail `EXTENSION_REGISTRY_MAX_BYTES`, default **2 MiB** (256 KiB–8 MiB;
   database ceiling 8 MiB); `data_policy` keeps 256 KiB.
2. **Classification required, credentials refused (Q12, Q34).** Every definition carries a classification
   (sensitivity + categories); a custom object's fields may not be weaker than the object. A closed whole-word
   credential-like token list is checked on key, display name and description; there is no secret value type, and
   values are scanned with the M10A1 secret-like detector. Restricted fields may be defined but their values are
   never stored (no row, counter `restricted_value_withheld`) while tech debt #15 is open. The manifest classifies
   the typed value columns `restricted` with the marker `classifiedBy: 'registry'`; per-row classification is read
   from the registry entry by FK.
3. **Typed EAV storage, no per-tenant DDL (option A; Q6–Q9, Q26).** `tenant_extension_values` holds one row per
   (target, field) with one typed column per value type (13 types: `integer` in `value_number` with a scale-0
   CHECK; money as `value_money_minor bigint` + ISO 4217 `value_currency` with in-code exponents; JSON depth / size
   ceilings and a secret-like-key CHECK) and the named typed CHECK `tenant_extension_values_typed`.
   `tenant_extension_value_items` holds array / multi-enum items, replaced on change (`DELETE` granted on items
   only). `tenant_custom_records` (entity-index kind `custom_record`, platform UUID, generic reference kind
   `custom_record`, optional natural key of ≤ 3 own fields, Q15) and `tenant_custom_relationships` (both ends in the
   entity index; cardinality guarded by the writer under a per-(tenant, definition, from) lock plus a guard trigger,
   REPEATABLE READ refused, Q27). All four tables are tenant-owned, `tenant_id`-first, forced RLS, with composite
   same-tenant FKs; `field_id` carries `field_registry_kind` so the FK proves the entry is an extension definition.
   The app role has no `CREATE`; a 600-field publish and value writes capture no DDL (V15). One migration,
   `20270112120000_m10d_extension_framework`, no backfill.
4. **Single writers.** `ExtensionValueWriter`, `CustomRecordWriter` and `CustomRelationshipWriter` are the only
   writers: typed parsing (V2), secret-like refusal, guardrails, provenance, idempotent field hash, one change record
   per call per target (`changed_fields` tokens `ext:<key>`; change types not widened, Q24), opt-in value history
   (`ext:<key>`, value-free for personal / communication / security fields unless a published data policy allows the
   key, Q23). An absent value changes nothing; **JSON `null` is an explicit empty** and clears. Inactive targets are
   accepted; merged targets refused (Q32). Operator values win and are sticky until `release`; a disagreeing source
   value is recorded as `extension_human_override_disagrees` (Q16).
5. **Mapping entry kinds (Q4, Q13, Q14, Q20).** `attribute` (un-reserved; authority is the target's existing profile
   fact, no new authority column), `custom_object` (single owner connection per object; relationships follow their
   `from` object's owner), `custom_relationship` and `capture`. Mapping publish never writes the registry. Mapping
   limits are raised globally to **1,000 fields per object** and a **1 MiB** document; existing mappings validate
   and hash identically.
6. **Use guard (Q21).** `ExtensionUseGuard.require(use, fieldKeys)`: every reader names its use; fields lacking it
   are filtered (read models) or refused (`extension_use_not_allowed`) when requested explicitly. No M10D consumer
   reads extension values for eligibility, ownership, whitespace, coverage or identity; a dependency-cruiser rule
   forbids `products` / identity code from importing the extension read model. The `not_evidence_of` floor
   (`account_identity`, `person_identity`, `subscription_ownership`) is always present, and `EvidenceLinkWriter`
   refuses a `custom_record` evidence entry whose object lists the link's relation fact (`EvidenceRelation.fact`).
7. **Captured fields (Q20).** The command `sources extension-capture-draft` generates registry additions for
   unmapped source fields (key `src_<kind>_<object>_<field>`, truncated with an 8-hex hash beyond 63 characters) for the
   operator's registry dry run. Drafts are classified `internal` / `operational` with uses `[display]` only;
   `sensitive_by_name` / `sensitive_by_value` fields are refused.
8. **Merge participants (Q22).** `ExtensionMergeParticipant` (company and person ports, always wired): a loser-only
   value is copied to the survivor; an equal value is skipped; a differing value leaves the survivor's and opens
   `extension_value_conflict` (never silently overwritten). Loser rows are kept. Custom records whose parent is the
   loser are re-pointed; reference values and relationships are not rewritten (readers follow `merged_into_id`).
9. **Read models and CLI (Q29).** `ExtensionReadModel.valuesFor` batch-loads values, items and reference lineage in
   bounded queries (no N+1); `ExtensionReadModel.records` / `.record` with keyset pagination. Capability `data.extension.read`
   (`operator`), one `extension.read` audit event per call. CLI (JSON; identifiers / codes / dates; confidential
   values only with the audited `--include-confidential`; exit 2 on refusal): `extension registry show`,
   `extension values show`, `extension value set|clear|release`, `extension records list|show`,
   `extension record create|update|retire|reactivate` (repeatable `--set key=value`, `--clear key`; no date flags),
   `extension relationship add|end`.
10. **Canonical `0.4` and module `extension` (Q18, Q19, Q31).** `0.4` is `current` (this ADR; hash
    `70584afd…`); `0.1`–`0.3` `supported` with their stored hashes reproduced (frozen `_0_3` lists). New hash
    members: `extensionValueTypes`, `extensionTargets`, `extensionAllowedUses`, `mappingEntryKinds`. Module
    `extension` becomes available at `0.4` (`entity_kinds = ['custom_record']`), disabled by default. Writers,
    registry publish of kind `extension`, mapping publish with the new kinds and operator commands require adopted
    ≥ `0.4` **and** the module enabled (`canonical_version_too_low` / `module_disabled`, audited). New tenants adopt
    `0.4` at provisioning with the module disabled. Rollback `0.4 → 0.3` with the module enabled is allowed: data
    kept and readable, writes refused, the dry run lists `modulesStranded: ['extension']`. Targets at `0.4`:
    `account`, `person`, `subscription`, `product`, `person_affiliation`, custom objects.
11. **Security integration (Q17).** Policy v5: new `data.extension.read` (`operator`); `canonical.human_entry`
    honoured by the M10C and M10D operator methods only (S2). Audit actions `extension.value.set|clear|release`,
    `extension.record.create|update|retire|reactivate`, `extension.relationship.add|end`, `extension.read`; target
    kinds `extension_value`, `custom_record`, `custom_relationship`; reason codes incl. `human_override_active`
    (added: it was not in the vocabulary). Data-policy `ext:` allow entries are validated against the current
    registry at publish (R-DP-EXT). Eight read-only integrity checks (type mismatch, restricted value, target-kind
    mismatch, items mismatch, secret-like value, missing parent, cardinality violation, history mismatch).
    `EVIDENCE_KIND_MODULES` gains `custom_record → extension`.

## Deviations from the plan (recorded during implementation)

- **No left-prefix text index on `value_text`**; typed indexes for number / bool / date / timestamp / money / enum /
  ref only (an expression or partial index is not expressible in the Prisma schema without schema-guard drift). No
  separate `(tenant, value_id)` items index: the primary key `(tenant, value_id, ordinal)` covers it.
- **Source-sync extension writes run in their own transactions**, after the canonical ingestion transaction of the
  record, not inside it, so a failed extension write does not roll back the canonical record.
- **A closed module gate skips the extension writes** of a source run and counts them on the run; no per-record
  audit event is written for the skipped writes (tech debt #84).
- **The merge participant runs regardless of the gate state**: values and records move with a merge even when the
  tenant is below `0.4` or the module is disabled, so a merge never strands data on a loser.
- **JSON `null` is an explicit empty** (clear); an absent key changes nothing (plan §4.1 "explicit empty vs absent").
- **Custom-record parents of kind `product` are operator-only**: no mapping entry may set a product parent.
- **Capture drafts** are always `internal` / `operational` with uses `[display]` (narrower than the plan's
  display / analytics).
- **Q14 owner check reads the other published mappings without cross-connection locking**: two connections
  publishing mappings for the same custom object at the same moment can both pass (tech debt #83). **Resolved by
  the M10D hardening #83 addendum below** (structural owner table, writer owner check).
- **`insertContextChange` moved to the tenancy module** (`tenancy/governance/context-change.ts`) so the extension
  module can write change records without importing `context` infrastructure (boundary rule).
- **Capture draft lives on the sources CLI** (`sources extension-capture-draft`, script `extension:capture-draft`),
  not as `extension capture-draft`, because it reads the source schema snapshot.
- **Record CLI shape**: `extension records list|show` and `extension record create|update|retire|reactivate` with
  repeatable `--set key=value` and `--clear key`; no date flags (dates are field values).
- **CLI `--file` caps fitted to the stored caps** (review of phase 3, `9ad1797`): the canonical-registry CLI reads up
  to 8 MiB (the registry ceiling) and the mapping-source CLI up to 4 MiB (an indented 1 MiB mapping document).
- **`not_evidence_of` closed list**: the floor plus `eligibility`, `whitespace`, `coverage`.
- **Guardrail counts include retired definitions** (keys never disappear).
- **Database JSON depth counts containers only** (`app_jsonb_depth`, scalar 0) while the writer counts the leaf, so
  the database ceiling never refuses what the writer accepted (documented in V22).

## Consequences

- Tenants can carry hundreds of source attributes (load evidence: 500 fields × 1,000 accounts) and their own objects
  and relationships without schema changes; every value is typed, classified and audited on read.
- Extension data cannot reach eligibility, ownership or identity in M10D by construction (boundary rule, use guard,
  `not_evidence_of` floor). A future consumer must name its use, and a consequential use needs a recorded
  confirmation on the definition.
- `CHANGE_TYPES` is unchanged, so every stored catalogue hash is unchanged; new members are optional hash members.
- The dev/staging down-script refuses while any M10D data class exists, **including any adoption of `0.4`**; every
  tenant provisioned after M10D blocks it. Production is forward-fix only; tenant-level rollback is adoption back to
  `0.3` (data kept, writes refused).
- Deferred: full writer-path load test (#82); partitioning (Q30); per-tenant guardrail overrides; promotion (Q28);
  HTTP endpoints / UI (M15); the canonical data-quality store (M10L) for per-record rejections.

## Addendum: tech debt #83 — Q14 single owner, enforced by the database (M10D hardening)

**Problem.** Q14 says a custom object is source-fed by one connection. M10D checked it only at mapping publish, by
reading the _other_ connections' published mappings under the publishing connection's own lock
(`source-mapping|<connectionId>`), so two connections publishing the same custom object concurrently could both
pass and both commit; `CustomRecordWriter` did no owner check, so both would then write (review m1).

**Decision.**

1. **Structural constraint.** Migration `20270126120000_m10d_custom_object_owner` adds
   `tenant_custom_object_owners`: one row per `(tenant_id, object_key)` — the **primary key** — with
   `connection_id` (the owner), `mapping_version` (the owner's published version holding the claim), `claimed_at`,
   `released_at`. Composite same-tenant FKs (RESTRICT) to the registry entry (`registry_kind = 'extension'`), to
   the connection and to `(tenant, connection, version)` of `tenant_source_mapping_versions`; a state-shape CHECK
   (held = owner + version + claimed, not released; released = no owner, no version, `released_at`); a guard
   trigger (identity immutable; an owner change passes through released — no direct handover); forced RLS, the
   tenant policy, tenant-id immutability; `SELECT / INSERT / UPDATE` for the app role, **no DELETE**. The guard
   trigger prevents an _accidental_ direct handover by a bug; it is not a security boundary: code running as the app
   role may release and re-claim in one transaction by design. The invariant it protects (at most one owner at any
   instant) rests on the primary key.
2. **Claimed in the publish transaction.** `SourceMappingsService.publish` claims the owner rows of every
   `custom_object:<key>` the new version sources **after inserting the version and before the audit event**, then
   releases the connection's other rows. A claim keeps the row (already ours, moving `mapping_version`), takes a
   released row, or inserts one; the insert hits the primary key when another connection holds the object **or is
   claiming it in a transaction still in flight** (PostgreSQL waits for that transaction, then raises the unique
   violation). The violation is mapped to the existing validation code `custom_object_owned_by_other_connection`
   (`mapping_invalid`), and the whole publication rolls back.
3. **Release.** Retiring the connection's _published_ version releases all its rows (retiring a superseded version
   releases nothing); a new version that no longer maps an object releases that object. Release sets
   `connection_id = NULL` (history stays; who claimed / released what is in the `mapping.publish` /
   `mapping.retire` audit details `customObjectsClaimed` / `customObjectsReleased`). A connection cannot be deleted
   while it has mapping versions (existing RESTRICT FKs), so connection removal needs no separate release path; a
   disabled connection keeps its ownership until its mapping is retired (`connection_disabled`), exactly as before.
4. **Validation reads the owner table.** The Q14 check in `validate` / `publish` (`extensionContext.objectOwners`)
   now reads the held owner rows instead of re-parsing every other connection's published mapping.
5. **Defence in depth at write time.** `CustomRecordWriter.observe` reads the object's owner row `FOR SHARE` right
   after the per-object lock and rejects (`rejected` / `object_not_owned`, counted on the run as
   `custom_record_rejected_object_not_owned`) a source write whose `provenance.connectionId` is not the owner —
   including a released object or a write with no connection. `FOR SHARE` makes a concurrent release / re-claim
   wait for the write to commit, so the owner cannot change between the check and the write; a write arriving
   behind an uncommitted release waits for it and re-reads the released row (refused). No write of the old owner
   commits after another connection's claim.
6. **Backfill and refusal.** The migration inserts one held row per custom object of each connection's currently
   published mapping (lifecycle state `published`; `claimed_at` = that version's `published_at`), and **refuses
   with a clear error** (changing nothing) when two connections' published mappings already source one object, or
   when a published mapping names a custom object the registry lacks. The down-script refuses while held rows and
   published mappings disagree, else drops the table and the guard function (ownership is derived from the
   published mappings again).

**Lock order (M10D rules plus #83).** Every transaction takes its locks in this order and never goes back:

| Path                          | Order                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mapping publish               | `source-mapping\|<connection>` advisory → owner rows, **claims in ascending `object_key` order**, then releases of its own other rows → `audit-chain` |
| Mapping retire                | `source-mapping\|<connection>` advisory → its own owner rows (release) → `audit-chain`                                                                |
| `CustomRecordWriter` (source) | `custom-object\|<objectId>` advisory → that object's owner row `FOR SHARE` → the record's single `extension-target` lock → `audit-chain`              |
| Value / relationship writers  | single `extension-target` (and `custom-relationship` from) lock → `audit-chain` (unchanged)                                                           |
| Merge participant             | `extension-target` locks of the loser / survivor **sorted pair** (`lockMergeTargets`) → `audit-chain` (unchanged)                                     |

No path holds `audit-chain` while waiting for an owner row, and publishers claim owner rows in one global order
(their own releases come after every claim and are rows no other publisher claims while they are held), so two
publishers claiming several objects in opposite document order cannot deadlock (integration test "no deadlock"
in `test/sources/custom-object-owner.int.spec.ts`). A writer holding an owner row `FOR SHARE` never waits for a
publisher, so a release that waits for in-flight writes always completes.

**Why not "ended_at + partial unique on active rows".** A partial unique index is not expressible in the Prisma
schema without schema-guard drift (the same reason as the missing `value_text` prefix index above). One row per
`(tenant, object_key)` with the primary key is the stronger structural form and needs no DELETE: release sets the
owner to NULL, and the claim history is in the audit trail.

**Evidence.** The race test (two connections, real `SourceMappingsService`, two independent transactions released
together from an audit-chain barrier) failed on the unfixed code (both publications committed) and passes with the
fix (CI run `38821831803` on `4614146` failed exactly that test; `a620ff9` is green). Four mutation proofs were all
killed: owner rows skipped (VM1), primary key dropped (VM2), claim sort removed (VM3 — the opposite-order publishers
deadlock, PostgreSQL aborts one with `P2034` instead of the Q14 refusal) and the writer owner check removed (VM4) —
recorded in the M10D record (review section, "Tech debt #83 hardening") and in tech debt #83.

**Re-review follow-up (PR #110 review m1, m2, n1–n3).**

- **Stale writer under concurrency.** Two barrier tests in `test/sources/custom-object-owner.int.spec.ts`
  ("stale writer"), two independent app-role sessions plus a barrier session, both orders: (a) the owner's source
  write paused after its owner check — the retire waits on the writer's row lock (proven in `pg_locks`), the write
  commits first, the other connection claims afterwards; (b) the retire paused after its release — the owner's write
  waits on the releasing transaction and is refused `object_not_owned`. Mutation VM5 (`FOR SHARE` removed) is killed.
- **Integrity check 32 `custom_object_owner_drift`.** The database only requires a held row's `mapping_version` to
  exist, not to be the connection's _currently published_ version (such drift fails closed but was undetected). The
  integrity run now applies the down-script's two consistency queries: a held row not supported by its connection's
  published mapping of that version sourcing the object (`held:<key>/<connection>/v<n>`), and a published mapping
  sourcing a custom object without its held row (`unheld:…`). Read-only, identifiers only, nothing repaired.
- A foreign-key violation while claiming (no registry entry or version; unreachable after validation in the same
  transaction) is reported as `mapping_invalid` / `invalid_entity` instead of a raw database error.
