# ADR 0031: AccountContext — contexts of an account, memberships, line context and canonical 0.5 (Milestone 10E)

- Status: **Accepted** — implemented in PR #93 (`m10e-impl` → `integration`; phases 1–3 done, V1–V30 and VM1–VM16
  recorded, independent review PASS WITH FINDINGS); record [M10E](../milestones/M10E-account-context.md)
- Date: 2026-10-15
- Plan: [M10E plan](../milestones/M10E-account-context-plan.md)
- Builds on: ADR 0020 (versioned source mapping and authority), ADR 0026 (security foundation), ADR 0027 (canonical
  versioning and governance), ADR 0028 (generic source references), ADR 0029 (account hierarchy, affiliation),
  ADR 0030 (extension framework, canonical 0.4)
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.

## Context

An account is often sold to, served and renewed through several distinct contexts at once (a regional deal desk, a
department, a programme), each with its own people, products, owner and renewal date. Before M10E the canonical
model had only the account itself, so lines could not say which context they belong to and nothing could hold the
context's people or renewal. The plan (§1) requires a tenant-defined context type registry (no seeded types), a
natural key per context, memberships, a line's context, source mapping under its own authority fact, and the usual
governance (gating by canonical version and module, audit, classification, integrity, rollback).

## Decision

1. **Registry kind `context_type` (plan §2).** Tenant-published types with up to six ordered dimensions
   (`product_key`, `code`, `string`, `extension_ref`), closed per-type member roles and `allow_products`. Rules
   R-C1 (dimension keys, order and types never change; a new dimension needs a new type key), R-C2 (a `code`
   dimension never loses a code), R-C3 (classification only becomes stricter, per dimension), R-C4 (an
   `extension_ref` names an active string / enum / integer extension field targeting `account_context`), plus the
   generic R-K / R-X1 / R-X3 / R-X4. Publish needs canonical ≥ 0.5 and module `account_context`.
2. **Schema (plan §3; migration `20270119120000_m10e_account_context`).** `tenant_account_contexts` (natural key =
   company, type, SHA-256 of the canonical JSON of the ordered dimension pairs), `tenant_account_context_persons`,
   `tenant_account_context_products`, `tenant_subscriptions.context_id`. Composite tenant FKs, forced RLS, no DELETE
   grant on contexts, person memberships or product memberships, dimensions CHECK (object, ≤ 6 keys, flat scalars, ≤ 4096 bytes, no
   secret-like key), `owner_ref` an opaque id (emails refused, Q12). No backfill.
3. **Canonical 0.5 and module `account_context` (plan §10, Q17).** 0.1–0.4 hashes reproduced from frozen lists;
   0.5 adds entity / change kinds, generic reference kind, mapping entity, authority fact, extension target and
   registry kind. Every write path needs adopted ≥ 0.5 **and** the module enabled; reads work whatever the gate
   (Q18 / Q20). Rollback 0.5 → 0.4 with the module on is allowed: data kept and readable, writes refused, the
   adoption dry run lists `modulesStranded`; the 0.4 → 0.5 dry run lists `modulesNewlyAvailable`.
   The extension gate (Q19, review M2) covers every place an extension definition can name `account_context`:
   a field's `target`, a reference field's `reference_to`, and either end of a custom relationship. Publish and dry
   run apply 0.5 + module `account_context` to all three; `CustomRelationshipWriter` (source observe, operator
   add / end) and the reference-value path of `ExtensionValueWriter` refuse with `canonical_version_too_low` /
   `module_disabled` (operator refusals audited, source refusals counted by code); the down-script refuses while
   any extension entry names `account_context` in any of these places.
4. **Single writers (plan §4).** `AccountContextWriter` writes contexts and the line's `context_id`;
   `AccountContextMembershipWriter` writes persons and explicit products. Source writes resolve by source reference
   (kind `account_context`, following merge lineage), else by natural key; operator writes
   (`canonical.human_entry`, one audit event each, codes / ids only) hold the attributes they set until `release`
   (Q14). Each accepted write records one change record (entity kinds `account_context`,
   `account_context_person`, `subscription` for the line) and value history on `owner_ref`, `status` and
   `subscription.context_id`.
5. **Source mapping (plan §5; phase 2b).** An object mapped as entity `account_context` carries an `accountContext`
   block — `type` (constant key), `account` (reference to an object mapped as `account`), `name`, `status`
   (value map into active / inactive / retired), `ownerRef`, `renewalDate`, `dimensions` (optional value map per
   dimension) and `persons` (reference to an object mapped as `person`, role constant or value map into the type's
   member roles). A line names its context with the relationship target `subscription.contextRef` (a source id of
   an `account_context` object of the same connection). Publish refuses below 0.5 / with the module disabled
   (`account_context_mappings_not_enabled`, and the disabled-module target check), without the `account_context`
   authority fact for the connection (`authority_conflict`), and on unknown or retired types, unknown or missing
   required dimensions, roles outside the type, unmapped referenced objects or non-context statements on the object
   (`context_type_unknown`, `context_dimension_unknown`, `context_dimension_required`, `context_role_unknown`,
   `missing_relationship_target`, `invalid_target`). Any M10E statement makes the version's
   `canonical_version_min` 0.5.
6. **Source sync (plan §5; phase 2b).** Context objects are read after accounts and people and before lines, and
   only when the run's connection holds the `account_context` authority fact (else nothing is read and the run
   counts `account_context_not_authoritative`). `AccountContextSourceSync` resolves the account, person and context
   references in one transaction and hands canonical ids to the single writers. **Absence never clears:** a deleted
   record is recorded on its reference only, a person no longer named is not ended, an empty line reference leaves
   the line's context unchanged. An unresolved account or line reference opens an
   `account_context_reference_unresolved` issue (identifiers only) and the line is written without (a new) context;
   a closed gate counts `context_assignment_skipped`. Counters are codes only.
7. **Read models and CLI (plan §8).** `account-context list | show [--lines] | write | retire | reactivate |
release | member add | member end | product add | line-assign`; operator id, capability
   (`data.account_context.read` for reads, `canonical.human_entry` for writes) and one audit event per call. Reads
   withhold the renewal date (`confidential` / financial) and confidential or restricted dimensions unless
   `--include-confidential`, which is recorded on the read's audit event.
8. **Integrity (plan §14).** Five read-only checks: `account_context_company_mismatch`,
   `account_context_natural_key_drift`, `account_context_type_mismatch`, `account_context_dangling_merge`,
   `account_context_member_role_unknown`.
9. **Merges (plan §7).** Company merge re-points the loser's contexts; a natural-key collision merges the loser
   context into the survivor's (members, products and lines move; `account_context_merge_collision` issue). Person
   merge moves memberships (a duplicate role is ended on the loser). After a collision the loser's source record
   stays bound to the merged-away context (E5 §1) and resolves to the survivor, but it keeps its reference only: it
   does not write the survivor's name, status, owner, renewal date or dimension products (review m1). The
   survivor's own record drives those, so two source records never alternate their values on one context. Every
   context-addressed writer (operator write / retire / reactivate / release, line assignment, person and product
   membership) locks the context's account, re-reads the context and repeats until the account is stable under
   the lock (`AccountContextStore.lockContextAccount` / `lockStable`, at most 3 moves, then refused), so a merge
   that moves a context between the read and the lock cannot leave the write holding the old account only
   (review M1). A merged context's refusal names the survivor id (review n2). The natural-key guard's raised
   `account_context_natural_key_exists` is a `validation_failed` refusal, never a 500 (review n3).

## Deviations from the plan (recorded during implementation)

Phase 1 (schema, domain, registry):

- Active natural-key uniqueness is a guard trigger with an advisory lock (`account_context_natural_key_exists`),
  not a partial unique index (Prisma drift; the M10C pattern). VM7 targets the trigger's check (guarded by V7); a
  two-session race test in V7 holds the lock.
- The line ↔ context same-account guard is a deferred constraint trigger on both tables (so a company merge can
  re-point lines and contexts in one transaction), not a BEFORE trigger.
- Context type entries project `codes = member_roles`, so the generic R-X3 keeps a role from disappearing.
- R-C1 also covers a changed `extension_field` of an `extension_ref` dimension.
- The projected entry classification is the strictest dimension sensitivity plus the union of categories.
- Dimension values are string / number / boolean only; an absent optional dimension is omitted (null in the hash).
- Ended person memberships are not terminal at the database (the primary key (context, person, role) would block
  re-adding a person).
- Catalogue 0.5 hashes the live `AVAILABLE_REGISTRY_KINDS` and extension targets (freeze to `_0_5` lists when a
  later kind lands). The authority-fact gate checks canonical ≥ 0.5 only, not the module (as `account_hierarchy`).
- `migrations-m10e.int.spec.ts` (phase 3) holds V1–V3, V21, V22, V24, V29 and V30.

Phase 2a (writers, merge participants, read model):

- **Q10:** re-adding an ended membership reactivates the row (new `started_at`, `ended_at` NULL); the ended period
  survives in change records. Membership change records use a deterministic UUID over (context, person, role).
- **Q14 without a column:** held attributes = the union of `changedFields` of human change records newer than the
  last release change (changed field `humanOverride`); per attribute.
- Merge moves are insert + end (identity columns are immutable). Extension values on a merged-away context are not
  moved (readers follow lineage; tech debt #92).
- The merge participant runs regardless of the gate (below 0.5 or module disabled), as in M10D: a merge never
  strands contexts on a loser account.
- Operator refusals use the audit reason `validation_failed` (the message carries the code); no new reason codes.
- Line assignment lives in `AccountContextWriter` (context must not import products).
- A retired context accepts no new members, explicit products or lines (Q8).

Phase 2b (mapping, sync, CLI, integrity, runtime):

- `MappingEntitySchema` stays `account | person | subscription`; `account_context` is routed like the M10D
  `custom_object:<key>` entities (`isAccountContextEntity`) and its targets are one `accountContext` block on the
  object instead of `fields` entries with `account_context.*` target strings. The 0.5 catalogue already hashes the
  mapping entity (`MAPPING_ENTITIES_0_5`); the block and `subscription.contextRef` change no stored hash
  (`subscription.contextRef` is outside the frozen 0.3 target list by design).
- The `account_context` authority fact is decided by the sync run (as M10C / M10D), not re-checked in the writer.
  The writer gate (0.5 + module) still applies; a closed gate writes nothing.
- An empty or missing line reference never clears a context (absence never clears); clearing is operator-only
  (`line-assign --clear-context`).
- Source persons are only added (or reactivated), never ended by the source.
- Source dimension values reach the writer as trimmed strings (the writer's type rules decide).
- `SourceReferenceService` now requires canonical 0.5 for reference kind `account_context` (defence in depth; the
  writer gates first).
- The read model withholds confidential values itself (a `withheld` list per context) rather than in the CLI.

## Consequences

- With the module disabled (the default) every existing flow is unchanged: no mapping, sync, eligibility or
  adoption behaviour changes until a tenant adopts 0.5, enables the module and publishes context types.
- Contexts are tenant-defined; nothing is seeded or inferred. A tenant can roll back to 0.4 without losing data.
- Phase 3 is done: integration tests of the writers, sync wiring, merge paths and read-model batching, the M10E
  migration round-trip spec, V1–V30 and the mutation proofs VM1–VM16 (record
  [M10E](../milestones/M10E-account-context.md)). Deferred: tech debt #89–#92.
- Fix `26da394` (phase 3): after a merge collision, re-observing the loser's source record observes the reference
  against its bound (merged-away) id when lineage resolves it to the written context, so the binding is kept and
  never re-bound to the survivor (no `reference_identity_conflict`).

## Addendum: confidential reads need their own capability (hardening #90, PR #115)

Tech debt #90 (review m4): `includeConfidential` released the renewal date and confidential dimensions to any holder
of `data.account_context.read`, with only an audited flag. Owner decision: fix it with a separate capability.

- **Capability.** `data.account_context.read_confidential` (policy v7). Name: the platform's read capabilities are
  `data.<area>.read` (`data.provenance.read`, `data.account_structure.read`, `data.extension.read`,
  `data.account_context.read`); a widened read keeps the area and qualifies the verb segment in snake_case, as other
  capabilities qualify a segment (`processing.dead_letter.resolve`, `config.product_model.publish`). No existing
  confidential capability existed to mirror: M10D `--include-confidential` on extension values is still a flag
  (outside #90's scope).
- **Grant model.** The policy grants it to **no actor kind**: an actor-kind grant to `operator` would give it to every
  operator and make the separation nominal. It is held only through an explicit, tenant-scoped grant to one operator
  id (`tenant_capability_grants`, migration `20270126130000`), made with `security.capability.grant` (operator, policy
  v7) by **another** operator (`security grant|revoke`; self-grant refused by the service and a DB CHECK). Grants are
  revoked (`active = false`), never deleted; history is the grant / revoke audit events. Default mapping: no operator
  holds it; there are no operator roles yet (M15).
- **No generic bypass.** `GRANTABLE_CAPABILITIES` is closed to this one capability (code and DB CHECK); the
  WriteAuthorizer consults grants only for a grantable capability the policy denied with `capability_not_granted`, so
  no other capability (and no "all restricted data" grant) is reachable through the table. Only `operator` grantees
  (DB CHECK); a grant names its tenant (forced RLS), so tenant A's grant never authorizes tenant B.
- **Read path.** The read model authorizes `includeConfidential` itself, for the read's own actor and tenant, after the
  base `data.account_context.read` check. Without the grant the read is **refused** (`AuthorizationDeniedError`, exit
  2 in the CLI, one `denied` audit event with capability `data.account_context.read_confidential`, reason
  `capability_not_granted`) — never silently redacted. With it the read's `allowed` audit event is recorded under that
  capability with `includeConfidential: true` and `releasedKeys` (attribute keys only, never values). Ordinary reads
  are unchanged (redacted by default, `withheld` keys). Restricted dimension values are never stored (R-C5) and are
  never released even with the grant. Line reads carry no confidential values and are unchanged.
- **Limitation.** Operator ids are asserted, not authenticated, until M15: the grant is an explicit, audited,
  two-person control, not proof of identity (the same limit as every operator control).
