# ADR 0029: Account hierarchy, person–account affiliation and canonical 0.3 (Milestone 10C)

- Status: **Accepted** — implemented, in review (PR #32 `m10c-impl` → `integration`; not merged)
- Date: 2026-10-15
- Plan: [M10C plan](../milestones/M10C-account-hierarchy-affiliation-plan.md) (owner defaults Q1–Q24 apply)
- Record: [M10C record](../milestones/M10C-account-hierarchy-affiliation.md)
- Builds on: ADR 0014 (identity, references, provenance), ADR 0020 (source authority), ADR 0026 (security
  foundation), ADR 0027 (canonical versioning and governance), ADR 0028 (generic source references, evidence links)
- Candidate: implements E3 §1 (Account `parent_account_id`, hierarchy) and §2 (Person–Account affiliation), the
  CANDIDATE invariant "account hierarchy is acyclic and same-tenant" and the guardrail "maximum hierarchy depth
  (default 10)".
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.

## Context

Before M10C `companies` had no parent column, so account hierarchy did not exist, and a person had exactly one
account (`persons.company_id`, the primary account). Further person–company associations were held only as source
coordinates in `tenant_source_relationships` (M6), with no canonical ids, no period and no lifecycle. The M10 plan
(§3, §15 M10C) requires an optional, acyclic, same-tenant parent with a configurable depth guardrail, a new
authority fact for who may set it, value history, merge handling, and a Person–Account affiliation with role and
period that later milestones (M10G champion movement, M10H contact roles) build on.

## Decision

1. **Parent on `companies` (Q1, Q22).** `parent_company_id` (canonical `parent_account_id`) with a composite
   same-tenant FK `(tenant_id, parent_company_id)` → `companies (tenant_id, id)` `ON DELETE / UPDATE RESTRICT`, the
   named CHECK `companies_parent_not_self`, `parent_company_origin` (`source_provided` / `human`, NULL = never set;
   not tied to the parent being NULL, so a human clear is sticky too) and the index
   `(tenant_id, parent_company_id)`. One forward migration, `20270105120000_m10c_account_hierarchy_affiliation`,
   with no backfill: every existing company stays a root (asserted by the migration).
2. **Cycle prevention in the database (Q4).** The `companies_hierarchy_guard` trigger (BEFORE INSERT / UPDATE OF
   `parent_company_id`, `SECURITY INVOKER`, fixed `search_path`) takes a per-tenant transaction advisory lock, then
   refuses a `merged` parent, a cycle, and a walk longer than 64 steps without reaching a root (SQLSTATE `23514`,
   messages `hierarchy_parent_merged` / `hierarchy_cycle` / `hierarchy_ceiling`). Because the lock is taken in the
   trigger, two raw-SQL sessions crossing A → B / B → A are serialised and cannot both pass **at READ COMMITTED**
   (each statement after the lock takes a fresh snapshot) and at SERIALIZABLE (SSI refuses the second commit). At
   REPEATABLE READ the snapshot predates the previous lock holder's commit, so the lock alone is not enough: both
   guard triggers refuse a guarded write there (SQLSTATE `0A000`, `hierarchy_isolation_unsupported` /
   `affiliation_isolation_unsupported`; review finding M1). The application writes both tables at READ COMMITTED.
   The owner-function allow-list does not grow.
3. **Depth is a guardrail, not semantics (Q3).** Platform configuration `CANONICAL_HIERARCHY_MAX_DEPTH` (1–50,
   default 10; out of range refuses start-up). The writer refuses `depth(new parent) + 1 + height(child subtree)`
   beyond it. The trigger's 64-step ceiling is a fail-closed backstop above any allowed configuration. No
   per-tenant or per-tier override.
4. **Authority fact `account_hierarchy` (Q5, Q17).** `tenant_source_authority_versions` gains
   `account_hierarchy_connection_id` (composite FK to the connection). Existing versions keep their ADR 0020 content
   hash (the fact is hashed only when assigned). The mapping target `account.parent` (relationship → account,
   consequential, needs a recorded confirmation) is valid only for the connection holding this authority; the
   engine reads a parent only under it. Affiliations stay a `person_profile` fact; no new column for them.
5. **Single hierarchy writer.** `AccountHierarchyWriter` is the only writer of `parent_company_id` /
   `parent_company_origin`. The pure rule `decideParentChange` decides: an absent value changes nothing, an
   explicit empty value clears, self / cycle / merged parent / depth are refused, and a sticky human value wins over
   a disagreeing source value. A refused source write leaves the parent unchanged, writes no change record for it,
   applies the rest of the record and records an open interim issue (conflict key = kind + identifiers); a later
   accepted write resolves it. The writer takes the same per-tenant lock as the trigger.
6. **Source semantics (Q6).** Unresolved parents are kept in memory for the run and retried after every account
   object of the run (second pass, full and incremental); still unknown → open `hierarchy_parent_unresolved`,
   retried on the next run that observes the child. No pending store. Source disappearance never unparents: a
   retired, deleted or unseen child or parent reference, a failed or unaccepted run, a lost authority or an
   inactive account changes nothing. No cascade from a parent's state to its children.
7. **Human entry wins and is sticky (Q2, Q8).** Operator `set` / `clear` write origin `human`; while it is `human`,
   a disagreeing source value is not applied and is recorded as `hierarchy_human_override_disagrees`; an agreeing
   one changes nothing. `release` returns the origin to `source_provided` without changing the parent.
8. **Person–Account affiliation (Q9–Q13, Q21).** `tenant_person_affiliations`: tenant-owned, forced RLS, direct
   composite `RESTRICT` FKs to `persons` and `companies`, status `active` / `ended` / `merged`, `role_codes`
   (0–10 identifiers `^[a-z0-9_]{1,64}$`, only from the mapping's explicit value map; unmapped values dropped and
   counted), business period `starts_at` / `ends_at`, `ended_at`, closed `end_reason` (`source_end_date`,
   `source_removed`, `operator`, `person_merged`, `company_merged`), `merged_into_id`, `origin`, `field_hash`,
   `last_change_id`, `released_at` (set once, only on an `operator` ending; review M6). One row per period; at most one `active` row per (person, company); endpoints and origin are
   immutable; `ended` / `merged` rows are terminal (a renewal is a new row). `lip_app` has `SELECT, INSERT, UPDATE`
   and **no `DELETE`**. Entity-index kind `person_affiliation` (the endpoints stay direct FKs, F2). The primary
   account stays on `persons.company_id`, unchanged; `isPrimary` is derived, never stored. No migration backfill:
   affiliations arrive with the next authoritative run after adoption, or by operator entry.
9. **Single affiliation writer.** `PersonAffiliationWriter` projects the person's company links (after
   `replacePersonLinks`) and `person.affiliation` statements: an active, resolved link → active row; an
   **authoritative** removal → `ended` (`source_removed`); a stated `endsAt` ≤ observation time → `ended`
   (`source_end_date`). Nothing is created or ended from an email domain, an unread association, a tombstoned
   person or company, or a disappeared reference; source observations never touch `origin = 'human'` rows. An
   unresolved company → open `affiliation_endpoint_unresolved`, created when the company arrives (late-company
   path; plain company links only, review M3). Operator `add` / `end` write origin `human`.
   **An operator ending is sticky (review M6, orchestrator decision under Ram's standing instruction, mirroring
   §7):** once an operator ends a pair's row (a `human` row, a source row, or the source row an operator `add`
   replaced), a source observation that still states the link does not re-create the pair (counted in
   `humanRows`, nothing written) until an operator `release` (`person:affiliation release --person --company`,
   audited `person.affiliation.release`) sets `released_at` on the standing operator endings; the next
   authoritative statement then creates a `source_provided` row. Stickiness is per (person, company): a merge moves
   active rows only, so a standing operator ending on a loser pair does not follow the merge.
   **Source coordinates of `person.affiliation` (review m4).** At `0.3` the stated affiliation links are kept in
   `tenant_source_relationships` under the synthetic association type `AFFILIATION_LINK_TYPE_ID = -1` (scope
   `affiliations` of `replacePersonLinks`, never `is_primary`), next to the plain company links (scope `links`) of
   the same person, so an authoritative removal of a stated affiliation is detected per scope. Below `0.3` this
   scope is not written. These rows are coordinates only: the late-company path replays plain links, never them
   (M3), and they appear as non-primary links in `ContextReadModel` snapshots.
10. **Merge participants (Q13, Q14).** `AccountHierarchyMergeParticipant` (company merge, always wired by
    `ContextModule`): the loser's children move to the survivor (origin kept, cycle rule kept, no depth guardrail;
    depth overshoot → `hierarchy_depth_exceeded` issue and integrity finding); a survivor under the loser takes the
    loser's parent; a survivor without a parent inherits the loser's; the loser keeps its own parent (lineage). The
    merge is never refused. A child the survivor descends from is unparented with value history and a
    `hierarchy_cycle_refused` issue. Affiliations: the loser's active rows end `merged` into a reused or new survivor
    row (copying role codes and period). New port `PersonMergeParticipant` (`PERSON_MERGE_PARTICIPANTS`) does the
    same on person merge, keyed by company.
11. **Change records and value history (Q15).** Parent changes: entity `company`, `relationship_changed`,
    `changed_fields = ['parentCompanyId']` (`['parentCompanyOrigin']` for a release), source / operator / merge
    provenance. Value history `company.parent_company_id` is `full` (internal / operational). Affiliation change
    records use entity kind `person_affiliation` and the existing E5 change types: create → `created`, role or
    period change → `updated`, end → `state_changed`, merge → `merged`. Affiliation fields
    (`status`, `starts_at`, `ends_at`, `role_codes`) are personal, so their history rows are **value-free** unless a
    published data policy allows values.
12. **Read models (Q16, Q23).** `AccountStructureReadModel` (`data.account_structure.read`, operator only, one
    `account_structure.read` audit event per call): ancestors, root, depth, descendants bounded by the guardrail + 1
    (deeper trees truncated and flagged), affiliations of a person or an account with derived `isPrimary`. Read-only
    `security_invoker` views `account_hierarchy_paths` and `person_affiliation_index` (`SELECT` only). CLI
    `account:hierarchy show|set|clear|release`, `person:affiliations`, `person:affiliation add|end|release` (JSON output,
    identifiers, codes and dates only).
13. **Canonical `0.3` (Q18–Q20).** `current` (this ADR); `0.1`, `0.2` `supported`. The catalogue adds the
    optional hash members `authorityFacts`, `mappingTargets`, `hierarchy` and `affiliationEndReasons`, and
    `person_affiliation` to the entity, change-entity and generic-reference kinds; the stored `0.1` / `0.2` hashes
    are reproduced unchanged (`0.3`: `70db9aa6…`). Adoption is explicit (dry run lists `account_hierarchy`,
    `person_affiliations`, `hierarchy_operator_entry`); new tenants adopt `0.3` at provisioning. Below `0.3` the
    hierarchy and affiliation writes, the operator commands, an `account_hierarchy` authority assignment and a
    mapping using a `0.3` target are refused (`canonical_version_too_low`, audited). Rollback to `0.2` keeps parents
    and affiliations readable and refuses new writes; nothing is unparented.
14. **Security integration.** Policy v4: `canonical.human_entry` granted to `operator` and honoured only by the
    M10C operator methods (S2 asserts it); new `data.account_structure.read` (`operator`). Audit actions
    `account.hierarchy.set|clear|release`, `person.affiliation.add|end|release`, `account_structure.read`; target kinds
    `account_hierarchy`, `person_affiliation`. Interim data-quality issues on `tenant_identity_conflicts` (Q7):
    `hierarchy_cycle_refused`, `hierarchy_depth_exceeded`, `hierarchy_parent_merged`,
    `hierarchy_parent_unresolved`, `hierarchy_human_override_disagrees`, `affiliation_endpoint_unresolved`. Manifests
    (privilege incl. the views, classification of every new column, data-subject link
    `tenant_person_affiliations.person_id`). Six integrity checks: `hierarchy_cycle`, `hierarchy_depth_exceeded`
    (current guardrail), `hierarchy_parent_merged`, `hierarchy_history_parity`, `affiliation_endpoint_merged`,
    `affiliation_reference_parity`. Read-only; nothing is repaired.

## Deviations from the plan (recorded during implementation)

- **One active row per pair by trigger, not a partial unique index** (plan §3.1). The partial index
  `(tenant_id, person_id, company_id) WHERE status = 'active'` cannot be expressed in the Prisma schema without
  drift against the schema guard. `app_person_affiliation_guard` takes a per-pair advisory lock and refuses a second
  active row (`affiliation_active_exists`, SQLSTATE `23505`); the same trigger enforces immutable endpoints / origin
  and terminal states.
- **`app_tenant_advisory_key(uuid, text, text)`**: a new `IMMUTABLE`, invoker SQL helper that computes the same
  key as `advisoryLockKey` / `tenantAdvisoryLock` in code (first 8 bytes of `sha256(tenant | scope | value)`), so
  the trigger and the writer serialise on one lock. V19 asserts it equals the code.
- **Operator reason is a code token**, not free text (plan §2.2 "reason text … secret-scanned"): `--reason` must
  match `^[a-z][a-z0-9_]{1,63}$` and is stored only in the audit event details. A code cannot carry personal data
  or a secret, so no scanner is needed; free text is not supported (tech debt #79).
- **`person.affiliation` is a relationship target on the person** (relationship → account, `person_profile`,
  optional role value map and period fields), identified by the natural key (person, company). Id-bearing
  affiliation objects (Salesforce `AccountContactRelation`, Gainsight Company Person) are **not mapped yet**: no
  connector supplies them, so `PersonAffiliationWriter` has no production `person_affiliation` reference writer.
  The generic reference kind `person_affiliation` exists, resolves through `SourceReferenceService.observe` at `0.3`
  (tested) and is checked by `affiliation_reference_parity`.
- **Group roll-up is deferred** (plan §5, Q23): the read model is structural only (ancestors, root, depth,
  descendants). Derived group ownership of products / subscription lines across a subtree is not implemented; it
  belongs to the products module (M7 derived ownership).
- **Operator refusals are not logged to stdout.** A refused operator write returns the refusal to the operator
  (exit 2 with the code) and is audited as `failed` with the code; it is not recorded as a data-quality issue and
  is not logged (Nest's console logger writes warnings to stdout and broke the CLI's JSON output, found by runtime
  script 88). Source refusals are recorded as issues and logged (code only).
- **Merge inheritance that would cycle is skipped with an issue.** The plan covers a cycle when moving the loser's
  children. When a parentless survivor would inherit a loser parent that descends from the survivor, the
  inheritance is skipped and `hierarchy_cycle_refused` is recorded naming both ids; the survivor stays a root.
- **Extra read-only views** `account_hierarchy_paths` and `person_affiliation_index` (`security_invoker`, `SELECT`
  only, classified column by column), not named in the plan.
- **No issue for source vs operator affiliation disagreement** (plan §3.2 "disagreement → open issue"): a source
  observation leaves a human row untouched, but no issue kind records the disagreement yet (tech debt #76).
- **Review decisions (2026-10-15, orchestrator under Ram's standing no-stop instruction, pending his sign-off at
  the `main` merge).** M1: both guard triggers refuse REPEATABLE READ (§2). M6: operator affiliation endings are
  sticky until `release` (§9). m1: a survivor whose parent an operator cleared does not inherit the loser's parent
  (recorded as `hierarchy_human_override_disagrees`). **m6: the Q23 group roll-up (tech debt #74) and the Q12
  production `person_affiliation` reference writer (#75) stay deferred**; both are approved-default scope, so this is
  a recorded shortfall against the approved plan, not a plan change.
- **The M10C migration cases live in their own suite** (`migrations-m10c.int.spec.ts`; helpers moved to
  `test/support/migrations.ts`) because `migrations.int.spec.ts` runs close to the hook timeout (tech debt #72).

## Consequences

- Later entities can cite an affiliation polymorphically (entity index `person_affiliation`): M10G champion movement
  derives from affiliation ends, M10H contact roles from active affiliations.
- `persons.company_id` and the M6 primary-company path are unchanged; at `0.3` the same path additionally maintains
  affiliations, so there is no second source of truth for the primary account.
- `ON DELETE RESTRICT` (Q22): the M2 physical-delete paths are called only from the isolation test. Deleting a
  company with children or affiliations raises `InvalidReferenceError`; deleting a person with an affiliation
  raises the raw FK error (tech debt #77). Ingested companies were already undeletable since M10A2.
- The writer refuses cycles, merged parents and depth before the trigger fires; the trigger is the boundary for
  raw SQL. If the trigger fires under the writer (only possible if the writer's validation is broken, VM18), the
  operator gets a raw Prisma error, not a `GovernanceError` (tech debt #78).
- The dev/staging down-script refuses while any M10C data class exists, **including any adoption of `0.3`**;
  every tenant provisioned after M10C blocks it. Production is forward-fix only; tenant-level rollback is adoption
  back to `0.2` (data kept, writes refused).
- Deferred: group roll-up (#74); id-bearing affiliation mapping and the production `person_affiliation` reference
  writer (#75); per-tenant guardrail overrides; HTTP endpoints / UI (M15); the canonical data-quality store (M10L),
  which later takes over the interim issue kinds.
