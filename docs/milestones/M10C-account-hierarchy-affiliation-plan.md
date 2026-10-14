# Milestone 10C — Account hierarchy + Person–Account affiliation: implementation plan

- Status: **PROPOSED PLAN (2026-10-14).** No schema, migration or code change has been made for M10C.
  Implementation follows `BUILD → TEST → VERIFY → MUTATION PROOF → FRESH CLONE → RUNTIME → DOCKER → INDEPENDENT
REVIEW → USER APPROVAL → MERGE`, on a fresh branch from `integration`.
- Every open question (§22) carries a **recommended default**. Owner instruction (2026-10-14): building all M10
  sub-milestones is approved and the recommended defaults apply **unless the owner overrides them**; each is marked
  `DEFAULT`.
- Parent: [M10 plan](M10-canonical-architecture-implementation-plan.md) (approved, revision 3: D1–D6, F1–F5), §3,
  §5 row 4, §8, §10, §13, §14, §15 (M10C), §16, §17, §18. Predecessors: [M10A1](M10A1-security-foundation.md) (ADR
  0026), [M10A2](M10A2-canonical-versioning-governance.md) (ADR 0027, merged into `integration` as `506839f`),
  [M10B](M10B-source-reference-evidence-link.md) (ADR 0028, merged into `integration` as `e23dfd4`).
- Candidate input: [E3 — Entity specifications](../architecture/canonical-v1/03-entity-specifications.md) §1
  (Account, hierarchy), §2 (Person, affiliation) and the relationship table; [CANDIDATE](../architecture/canonical-v1/CANDIDATE.md)
  (core: "Account (+ `parent_account_id`), Person (+ affiliation)"; invariant "account hierarchy is acyclic and
  same-tenant"; guardrail "maximum hierarchy depth (default 10)"); [E8 pressure-test matrix](../architecture/canonical-v1/08-pressure-test-matrix.md)
  (Salesforce `ParentId` / `AccountContactRelation`, HubSpot parent-company association / associations, Gainsight
  company hierarchy / Company Person); ADR 0014 (identity, references, provenance), ADR 0020 (authority), ADR 0025.
- Base: `integration` at `e23dfd4` (M10B merge; includes the M10A2 merge `506839f`). `main` stays untouched. This
  plan's PR targets `integration`.
- Two acceptance sections apply: `Canonical / business correctness` (§17) and `Security & Data Governance` (§18).
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made. M10C builds technical foundations only.
- Canonical version after M10C: **`0.3`** (M10 plan §15.0).
- ADR: following the M10A1/M10A2/M10B pattern, **no ADR is drafted with this plan**. ADR 0029 (account hierarchy,
  person–account affiliation, canonical `0.3`) is written during implementation (Q24).

## 0. What exists today (`IMPLEMENTED TODAY`, from inspection of `integration` `e23dfd4`)

| Area                          | Fact                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account (`companies`)         | `id`, `tenant_id`, `name` (nullable, never a placeholder), `domains[]`, `customer_status`, `record_state` (`active` / `inactive` / `merged`), `merged_into_id` (composite same-tenant FK), timestamps. **No parent column: account hierarchy does not exist.** Written only by `ContextIngestionService` (ADR 0014 §4).                                                                                                          |
| Person (`persons`)            | emails, names, `job_title`, **`company_id`** (the single _primary_ account; composite FK `(tenant_id, company_id)` → `companies`, `ON DELETE RESTRICT`), `roles[]`, `record_state`, `merged_into_id`. **No affiliation table.**                                                                                                                                                                                                  |
| Person→company links today    | Mapping target `person.primaryCompany` (relationship → account, fact `person_profile`, optional). The engine emits one `companyLinks[]` entry (`primary: true`). `ContextIngestionService` resolves the primary link (`primaryCompanyLink`), writes `persons.company_id`, links people that arrived before their company (`peopleAwaitingCompany`, change type `relationship_changed`), and records `ambiguous_primary_company`. |
| `tenant_source_relationships` | Source-observed associations (M6, HubSpot-shaped): PK `(tenant_id, system, from_object_type, from_external_id, to_object_type, to_external_id, association_type_id)`, `category` CHECK (`standard` / `user_defined` / `integrator_defined` / `other`), `is_primary`, `state` (`active` / `removed`). Source coordinates only; no canonical ids; maintained by `replacePersonLinks`.                                              |
| Merge                         | One company-merge workflow in `ContextIngestionService.merge` (refs re-pointed, people re-pointed, `merge_across_systems` conflicts). Port `CompanyMergeParticipant` (`COMPANY_MERGE_PARTICIPANTS`) runs inside the merge transaction (implemented by `products/subscription-merge.participant.ts`). Advisory-lock scope `COMPANY_CANONICAL_LOCK_SCOPE`. **No person-merge participant port.**                                   |
| Authority (ADR 0020)          | `AuthorityFactSchema` = `account_profile`, `person_profile`, `subscription_lines`, `subscription_state`, `subscription_terms`; `tenant_source_authority_versions` has one nullable connection column per fact (immutable versions; a new fact needs a new column and a new published version).                                                                                                                                   |
| Mapping targets               | Closed catalogue `MAPPING_TARGETS` (`account.name`, `account.domain`, `person.*`, `subscription.*`, `person.primaryCompany`); kinds `core` / `relationship`; no `account.parent`, no affiliation target.                                                                                                                                                                                                                         |
| Identity conflicts            | `tenant_identity_conflicts` kinds `shared_email` / `merge_across_systems` / `ambiguous_primary_company`, entity kinds `company` / `person`; open / resolved.                                                                                                                                                                                                                                                                     |
| Canonical versions            | `0.1` `supported` (ADR 0027), `0.2` `current` (ADR 0028); explicit adoption; writers fail closed (`canonical_version_unknown` / `canonical_version_too_low`); `tenant_source_mapping_versions.canonical_version_min`.                                                                                                                                                                                                            |
| Entity index / references     | `tenant_entity_index` kinds `company`, `person`, `product` (key), `subscription`; `tenant_source_references` generic kinds `product` only; `tenant_evidence_links` with an empty production relation catalogue; read-only `source_reference_index` view.                                                                                                                                                                         |
| Value history (M10A2)         | Catalogue: `company.name`, `company.customer_status`, subscription fields. Restricted-history rule: personal / communication / security / restricted / `tbc` columns get **value-free** rows unless a published data policy allows values. Persons: no history fields.                                                                                                                                                           |
| Security                      | `POLICY_VERSION = 3` (31 capabilities); `canonical.human_entry` exists but is granted to **no** actor kind ("reserved for M15"); hash-chained audit events; privilege, classification and audit-vocabulary manifests; `SECURITY_DEFINER_FUNCTIONS` allow-list; `security integrity-verify` (M10A2 + six M10B checks).                                                                                                            |
| Modules                       | Core (Account, hierarchy, Person, affiliation, Product, Subscription line, references, provenance) is **not a module** (M10A2 plan §4). M10C adds no module.                                                                                                                                                                                                                                                                     |
| Latest migration              | `20261229120000_m10b_source_references_evidence`.                                                                                                                                                                                                                                                                                                                                                                                |

## 1. Scope

In scope (M10 plan §3, §5 row 4, §15 M10C, refined by inspection):

1. **Account hierarchy:** `companies.parent_company_id` (canonical `parent_account_id`), same-tenant composite FK,
   no self-parent, **cycle prevention in the database** (trigger, serialised per tenant) and in the writer.
2. **Depth guardrail** from platform configuration (default 10), enforced by the writer; refusals recorded as
   data-quality issues (interim: widened `tenant_identity_conflicts`, M10 §3).
3. **Authority fact `account_hierarchy`** and column `tenant_source_authority_versions.account_hierarchy_connection_id`.
4. **Mapping target `account.parent`** (relationship → account, consequential, human-confirmed).
5. **Person–Account affiliation:** `tenant_person_affiliations` (role codes, period, lifecycle), single writer,
   mapping target `person.affiliation`, source projection of observed person–company associations.
6. **Operator entry** for hierarchy and affiliation (CLI), authorised by `canonical.human_entry`, audited.
7. **Merge participants:** company merge re-points children and affiliations; new person-merge participant port
   re-points affiliations.
8. **Value history** for `company.parent_company_id`; value-free history for affiliation fields (personal).
9. **Hierarchy read model** (ancestors, descendants, root, depth; derived group ownership) + CLI.
10. **Canonical `0.3`** with the explicit adoption path; entity-index kind `person_affiliation`; generic reference
    kind `person_affiliation`.
11. **Security integration:** policy v4, audit vocabulary, manifests, schema guard, integrity checks.

Out of scope: see §21.

## 2. Account hierarchy

### 2.1 Schema (`companies`, additive)

| Column / object                                                                   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parent_company_id uuid NULL`                                                     | canonical name `parent_account_id`; composite FK `(tenant_id, parent_company_id)` → `companies (tenant_id, id)`, `ON DELETE RESTRICT ON UPDATE RESTRICT` (same-tenant; a cross-tenant parent has no matching row)                                                                                                                                                                                                                                                                                                                                                                                             |
| CHECK `companies_parent_not_self`                                                 | `parent_company_id IS NULL OR parent_company_id <> id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `parent_company_origin text NULL`                                                 | who last set or cleared the parent: CHECK `parent_company_origin IS NULL OR parent_company_origin IN ('source_provided', 'human')`; NULL = never set. Not tied to `parent_company_id IS NULL`, because an explicit human _clear_ must be sticky too. Drives the human-override rule (§2.5, Q8)                                                                                                                                                                                                                                                                                                                |
| index `companies_tenant_parent_idx`                                               | `(tenant_id, parent_company_id)` (children lookup, roll-ups; M10 §13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| trigger `companies_hierarchy_guard` (BEFORE INSERT/UPDATE OF `parent_company_id`) | when the new parent is non-NULL: (1) takes `pg_advisory_xact_lock` on `(tenant_id, 'account-hierarchy')` so concurrent re-parenting in one tenant is serialised **even for raw SQL** (two crossing updates A→B / B→A cannot both pass); (2) refuses a parent whose `record_state = 'merged'`; (3) walks ancestors from the new parent (`tenant_id` predicate in every step) and refuses if it reaches `NEW.id` (**cycle**) or exceeds the hard ceiling `64` steps without reaching a root (fail closed). SQLSTATE `23514`, named messages `hierarchy_cycle` / `hierarchy_parent_merged` / `hierarchy_ceiling` |

- The trigger function is **`SECURITY INVOKER`** (it reads only same-tenant `companies` rows the caller can already
  see), so the owner-function allow-list does not grow (Q4). Fixed `search_path` anyway.
- **Depth** is not canonical semantics (E3 §1): the configurable guardrail (§2.3) is enforced by the writer; the
  database ceiling `64` is a fail-closed backstop against a runaway walk, not the guardrail, and is above any
  allowed configuration (Q3).
- **Descendant depth:** re-parenting a node with a deep subtree changes its descendants' depth. The writer computes
  `depth(new parent) + 1 + height(subtree)` and refuses beyond the guardrail; the trigger's ceiling covers the
  ancestor walk only. Integrity check `hierarchy_depth_exceeded` (§11) catches rows beyond the _current_ guardrail
  (e.g. after the guardrail was lowered) without repairing them.

### 2.2 Who may set a parent

| Path                           | Capability              | Precondition                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source sync (`account.parent`) | `canonical.source_sync` | tenant adopted ≥ `0.3`; the published authority version names this run's connection for `account_hierarchy`; the mapping version publishing `account.parent` has `canonical_version_min = 0.3`; no active human override (§2.5) |
| Operator CLI                   | `canonical.human_entry` | tenant adopted ≥ `0.3`; reason text required (stored only in the audit event details as a bounded, secret-scanned string); one audit event per edit                                                                             |
| Merge participant              | inherits the merge's    | inside the merge transaction (§4)                                                                                                                                                                                               |

### 2.3 Depth guardrail

- Platform configuration `CANONICAL_HIERARCHY_MAX_DEPTH` (integer 1–50, default **10**; validated with Zod at
  start-up; a value outside the range refuses start-up). Depth counts edges from the root (a root has depth 0).
- Per-tenant / per-tier override: **not** in M10C (Q3); raising the guardrail is configuration, never a canonical
  version change (E3 §1).
- A refused write (cycle, merged parent, depth) leaves the account's current parent **unchanged**, writes no change
  record for the parent, and records an open data-quality issue in `tenant_identity_conflicts` (kinds widened, §2.6).
  The rest of the record (name, domains, …) is still applied. A later accepted write resolves the issue.

### 2.4 Source semantics

- **Unresolved parent:** the parent's source reference is not yet known (parent arrives later in the run or in a
  later run). The engine keeps the unresolved child→parent pair **in memory for the run** and retries it after every
  account observation of the run has been applied (second pass, same run, same authority). Still unresolved → open
  issue `hierarchy_parent_unresolved` (identifiers only), retried on the next run that observes the child. **No new
  pending store** (Q6).
- **Explicit clear:** an authoritative observation whose mapped parent is explicitly empty (`explicit: none` in the
  source value, not merely an unmapped/absent field) clears the parent (value history `old → NULL`).
- **Source disappearance never unparents** (M10 §15): a retired / deleted / unseen child or parent reference, a
  failed / partial / unaccepted run, or an account becoming `inactive` changes nothing. The parent is kept until an
  authoritative source or an operator changes it.
- **No cascade:** retiring, inactivating or merging a parent never changes children's state (E3 §1); merge
  re-points them (§4).

### 2.5 Human entry and source authority (Q8)

- CLAUDE.md: "Human overrides win." An operator set / clear writes `parent_company_origin = 'human'`.
- While the origin is `human`, a source write that would change the parent is **not applied**; it is recorded as an
  open issue `hierarchy_human_override_disagrees` (source triple + both canonical ids) so the operator sees the
  disagreement. A source write that agrees with the human value changes nothing.
- `account hierarchy release --company <id>` (operator, `canonical.human_entry`, audited) sets the origin back to
  `source_provided` without changing the parent; the next authoritative observation applies normally.

### 2.6 Data-quality issues (interim store)

`tenant_identity_conflicts` kind CHECK widened with `hierarchy_cycle_refused`, `hierarchy_depth_exceeded`,
`hierarchy_parent_merged`, `hierarchy_parent_unresolved`, `hierarchy_human_override_disagrees`,
`affiliation_endpoint_unresolved`; `entity_kind` stays `company` / `person`. Conflict key = SHA-256 of kind +
identifiers, so a repeated refusal updates one row. M10L (`tenant_rejected_observations`) later becomes the
canonical home; M10C does not pre-empt it (Q7).

## 3. Person–Account affiliation

### 3.1 `tenant_person_affiliations` (tenant-owned, forced RLS)

| Column                     | Type / rule                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `id`          | PK `(tenant_id, id)`; `id` uuid                                                                                                                                                                                                 |
| `person_id`                | composite FK `(tenant_id, person_id)` → `persons`, `ON DELETE RESTRICT` (direct FK, F2: permanently one kind)                                                                                                                   |
| `company_id`               | composite FK `(tenant_id, company_id)` → `companies`, `ON DELETE RESTRICT` (direct FK, F2)                                                                                                                                      |
| `status`                   | `active` / `ended` / `merged`                                                                                                                                                                                                   |
| —                          | **partial unique** `(tenant_id, person_id, company_id) WHERE status = 'active'`: one current affiliation per pair; ended periods are kept as separate rows (Q10)                                                                |
| `role_codes text[]`        | 0–10 elements, each CHECK `^[a-z0-9_]{1,64}$`; values come only from the mapping's explicit value map (no free text, no invented picklist; unmapped source values → `tbc` is **not** stored, they are dropped and counted, Q11) |
| `starts_at`, `ends_at`     | timestamptz NULL — the **business period as stated by the source or operator**; CHECK `ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at`                                                                            |
| `ended_at`                 | timestamptz NULL — when the platform recorded the ending; CHECK `(status = 'active') = (ended_at IS NULL)`                                                                                                                      |
| `end_reason`               | NULL iff `active`; closed: `source_end_date`, `source_removed`, `operator`, `person_merged`, `company_merged`                                                                                                                   |
| `merged_into_id`           | uuid NULL; composite FK → `tenant_person_affiliations (tenant_id, id)`; NOT NULL iff `status = 'merged'`                                                                                                                        |
| `origin`                   | `source_provided` / `human`                                                                                                                                                                                                     |
| `field_hash`               | 64 hex NULL (idempotency; no values)                                                                                                                                                                                            |
| `last_change_id`           | uuid NULL; composite FK → `tenant_context_changes (tenant_id, id)`                                                                                                                                                              |
| `created_at`, `updated_at` | timestamptz                                                                                                                                                                                                                     |

- **Indexes:** `(tenant_id, person_id, status)`, `(tenant_id, company_id, status)`.
- **Privileges (`lip_app`):** `SELECT, INSERT, UPDATE`; **no `DELETE`** (affiliations end, never disappear).
- **Triggers:** tenant-id immutability; identity immutability — `person_id`, `company_id` and `origin` **never**
  change (a merge ends the loser row with `status = 'merged'` and inserts or reuses a survivor row instead of
  re-pointing, Q13); `ended` / `merged` rows are terminal (no transition back to `active`; a renewed
  affiliation is a new row); `updated_at` maintenance.
- **Entity index:** new kind `person_affiliation` (AFTER INSERT trigger via `lip_entity_indexer`), so evidence
  links (M10G "champion departed") and extension values can cite an affiliation polymorphically. Its own endpoints
  stay direct FKs (F2).
- **Generic source references:** new generic kind `person_affiliation` for sources whose affiliation has its own id
  (Salesforce `AccountContactRelation`, Gainsight Company Person), written by `SourceReferenceService.observe` (its
  first production caller). Associations without an id (HubSpot) are identified by the natural key (person, company)
  and carry no generic reference (Q12).
- **Relationship to `persons.company_id`:** the primary account **stays on `persons.company_id`**, unchanged
  (writers, semantics, M6 tests). The affiliation table holds every affiliation, including the one to the primary
  account. "Is primary" is **derived** in the read model (`affiliation.company_id = persons.company_id`), never
  stored, so there is no second source of truth (Q9). No backfill from `persons.company_id` (§8).

### 3.2 Sources of affiliations

| Source path                                                                                                                                      | Effect (tenant adopted ≥ `0.3`)                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing `person.primaryCompany` / `companyLinks[]` (HubSpot associations, mapped sources)                                                       | `ContextIngestionService`, after `replacePersonLinks`, calls `PersonAffiliationWriter.observeLinks`: every `active` link whose company resolves → active affiliation (insert if absent); a link that became `removed` in an **authoritative** observation → `ended` (`source_removed`, `ended_at` = observation time, `ends_at` untouched) |
| New mapping target `person.affiliation` (collection: `account` relationship + optional `roleCodes`, `startsAt`, `endsAt`, source affiliation id) | same writer; a stated `endsAt` ≤ observation time → `ended` (`source_end_date`)                                                                                                                                                                                                                                                            |
| Operator CLI                                                                                                                                     | `person affiliation add / end` (`canonical.human_entry`, audited); `origin = 'human'`                                                                                                                                                                                                                                                      |

- **Authority (Q5):** affiliations are a `person_profile` fact (as the primary company link is today). No new
  authority fact or column for affiliations.
- **Unresolved company:** the link is skipped and an open `affiliation_endpoint_unresolved` issue is recorded; the
  existing late-company path (`peopleAwaitingCompany`) is extended to create the affiliation when the company
  arrives.
- **Never inferred:** no affiliation is created or ended from email domains, email absence, or a source record's
  disappearance (E3 §2: "never inferred from email absence alone"). A retired / deleted person or company reference
  ends nothing.
- **Human rows:** a source observation never ends an `origin = 'human'` affiliation; disagreement → open issue (as
  §2.5).

### 3.3 `PersonAffiliationWriter` (single writer)

| Method                                          | Capability              | Notes                                                                                                                            |
| ----------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `observeLinks(actx, tx, person, links)`         | `canonical.source_sync` | from `ContextIngestionService` only; `person_profile` authority already checked by the caller; one change record per real change |
| `observe(actx, tx, observation)`                | `canonical.source_sync` | `person.affiliation` target; generic reference via `SourceReferenceService.observe` for id-bearing sources                       |
| `add(actx, tx, input)` / `end(actx, tx, input)` | `canonical.human_entry` | operator; audit event per call                                                                                                   |
| `onCompanyMerged` / `onPersonMerged`            | merge's                 | §4                                                                                                                               |

- Takes the person's canonical advisory lock and `COMPANY_CANONICAL_LOCK_SCOPE` for the company (sorted), so an
  affiliation never lands on a company or person merged away concurrently.
- Layer-1 checks: person and company exist in the tenant and are not `merged`; period valid; role codes match the
  pattern; adopted version ≥ `0.3` (`canonical_version_too_low`).

## 4. Merge participants

- **Company merge** (existing port `CompanyMergeParticipant`; new implementation `AccountHierarchyMergeParticipant`
  in `context`, wired in the composition root):
  - children of the loser → re-pointed to the survivor (`relationship_changed`, value history, origin kept);
  - if the survivor is itself a child of the loser, the survivor takes the loser's parent instead (no self-parent);
  - the merge is never refused, and a child can never keep a `merged` parent (the trigger refuses it). The re-point
    is applied **without** the depth guardrail (depth is a guardrail, not semantics) but **with** the cycle rule
    (Q14). A cycle can only arise when the survivor descends from the child; that child is then unparented, with
    value history and an open `hierarchy_cycle_refused` issue naming both ids — the only case a merge unparents, and
    it is recorded. Depth overshoot is recorded as `hierarchy_depth_exceeded` (integrity finding, not refusal);
  - the loser's own parent: the survivor keeps its own parent; if the survivor has none, it inherits the loser's
    (change record with the merge's provenance); if both differ, the survivor keeps its own and the loser's parent
    is named only in the merge's change record (no extra issue kind, Q14);
  - the loser keeps its `parent_company_id` (lineage; merged rows are never re-parented).
- **Company merge (affiliations):** each active loser affiliation → if the survivor has an active affiliation for
  the same person, end the loser row `merged` with `merged_into_id` = survivor row; else end the loser row `merged`
  and insert a survivor row copying role codes and period (`company_merged`).
- **Person merge:** new port `PersonMergeParticipant` (`PERSON_MERGE_PARTICIPANTS`), invoked by the existing person
  branch of `ContextIngestionService.merge` in the same transaction (mirrors the company port; dependency
  inversion unchanged). Same affiliation rule keyed by company (`person_merged`).
- Every move writes a change record carrying the merge's provenance (as `subscription-merge.participant.ts`).

## 5. Hierarchy read model

- `AccountHierarchyReadModel` (read-only): `ancestors(id)`, `descendants(id)`, `root(id)`, `depth(id)`,
  `tree(rootId)`; recursive CTEs with `tenant_id` in every step, bounded by the guardrail + 1 (a deeper tree is
  truncated and flagged, never looped).
- **Derived roll-ups only** (E3 §1, CANDIDATE "hierarchy roll-ups" = derived): group owned products / subscription
  lines across the subtree, computed from the existing derived ownership (M7). No stored roll-up, no new
  ownership semantics; group ARR waits for Commercial (M10F).
- `PersonAffiliationReadModel`: affiliations of a person / of an account (active, ended), derived `isPrimary`.
- CLI: `account hierarchy show --tenant <slug> --company <id> [--descendants]`,
  `person affiliations --tenant <slug> --person <id>`; output identifiers, codes, dates (affiliation output is
  personal: operator-only, audited read, Q16).

## 6. Change records and value history

- `companies` parent changes: `entity_kind = 'company'`, `change_type = 'relationship_changed'`,
  `changed_fields = ['parentCompanyId']`, source triple of the observation (or operator / merge provenance),
  `origin` `source_provided` / `human`, actor, `canonical_version`.
- **Value history:** catalogue gains `company.parent_company_id` (classification `internal` / `operational`, history
  `full`: not sensitive under F3) — the M10 §10 initial field "Account `parent_account_id`".
- Affiliations: `entity_kind` CHECK on `tenant_context_changes` widened with `person_affiliation`
  (`CHANGE_ENTITY_KINDS`); change types `created`, `updated`, `relationship_changed` (`ended`, `merged` map to the
  existing E5 change types — exact mapping recorded in ADR 0029). Value-history catalogue gains
  `person_affiliation.status`, `.starts_at`, `.ends_at`, `.role_codes`; they are classified `personal`, so the
  M10A2 restricted-history rule writes **value-free** rows unless a published data policy allows values (Q15).
- `persons.company_id` changes keep their existing change records; no value history is added for persons.

## 7. Canonical version `0.3`

- **Catalogue:** `CANONICAL_VERSIONS` = `0.1` (`supported`), `0.2` (`supported`), `0.3` (`current`, ADR 0029). The
  migration inserts `0.3` and moves `0.2` to `supported` in the order the one-current trigger accepts.
- **Catalogue hash:** optional members `authorityFacts`, `mappingTargets`, `hierarchy` (`{ maxDepthCeiling: 64 }`),
  `affiliationEndReasons`; `entityKinds` / `changeEntityKinds` / `genericReferenceKinds` gain `person_affiliation`.
  Members hashed only when present, so the stored `0.1` and `0.2` hashes are reproduced unchanged (test).
- **`0.3` means:** hierarchy writes, affiliation writes, the `account.parent` / `person.affiliation` mapping targets
  and the operator commands are allowed. Below `0.3` they are refused (`canonical_version_too_low`, audited); a
  mapping version using the new targets declares `canonical_version_min = 0.3` and its publication is refused for a
  tenant below `0.3`.
- **Adoption:** explicit (`canonical adopt --version 0.3 --expected-current 0.2`, dry run lists
  `account_hierarchy`, `person_affiliations`, `hierarchy_operator_entry`); new tenants adopt `0.3` at provisioning.
  Rollback `0.3 → 0.2` keeps parents and affiliations (readable), refuses new writes, and **existing parents stay**
  (no unparenting on rollback).

## 8. Migration

One forward migration (M10 §5 row 4), down-script, standard migration tests:

**`20270105120000_m10c_account_hierarchy_affiliation`** (timestamp after `20261229120000`)

1. `companies`: `parent_company_id`, `parent_company_origin`, FK, CHECKs, index, `companies_hierarchy_guard`
   trigger + function.
2. `tenant_source_authority_versions`: `account_hierarchy_connection_id uuid NULL` + composite FK →
   `tenant_source_connections`. Existing versions untouched (NULL = no hierarchy authority); `content_hash` of
   existing versions unchanged (the hash covers the new fact only when non-NULL — test).
3. `tenant_person_affiliations` with constraints, triggers, entity-index trigger.
4. `tenant_entity_index` / `tenant_source_references` / `tenant_context_changes` kind CHECKs widened with
   `person_affiliation`; `tenant_identity_conflicts.kind` widened (§2.6).
5. `canonical_model_versions`: insert `0.3` (`current`, `catalogue_hash`, `adr = '0029'`); `0.2` → `supported`.
6. Audit CHECKs widened (§13); forced RLS, tenant policy, tenant-id immutability; privileges (`REVOKE ALL` then the
   manifest grants).

- **No backfill.** No hierarchy is invented (M10 §15); no affiliation is created from `persons.company_id` or
  `tenant_source_relationships` by the migration — affiliations arrive through the next authoritative sync run (or
  operator entry) after adoption, with real provenance (Q9). The migration asserts every existing `companies` row
  has `parent_company_id IS NULL`.
- Additive only: nullable columns, new table, widened CHECKs, triggers, grants on new objects only.
- **Down-script** (dev/staging) refuses while any parent is set, any affiliation exists, any change record or
  conflict uses a new kind, any authority version names a hierarchy connection, or any tenant adopted `0.3`
  (including new tenants provisioned at `0.3`); otherwise drops the new objects and restores CHECKs, the `0.2`
  `current` row and the M10B privilege matrix exactly. Prisma schema updated; drift test green.

## 9. Backward compatibility

- Ingestion, mapping, eligibility, ownership, whitespace, coverage tiers, snapshots, M9B retirement and every CLI
  behave as before for tenants below `0.3` and for mappings without the new targets.
- `persons.company_id`, `person.primaryCompany`, `ambiguous_primary_company`, `peopleAwaitingCompany` unchanged; at
  `0.3` the same path additionally maintains affiliations.
- Existing published mappings validate identically; no republish required. Existing authority versions keep their
  hash.
- `ON DELETE RESTRICT` from children and affiliations: the M2 physical-delete paths
  (`PrismaCompanyRepository.delete`, `PrismaPersonRepository.delete`) are re-inspected; **if a legitimate path
  breaks, work stops and it is reported** (M10A2 Q15 / M10B Q24 pattern).

## 10. Tenant isolation

- Parent FK and both affiliation FKs are composite `(tenant_id, x)` → a cross-tenant parent or affiliation is
  impossible even with raw SQL as the app role (no matching row).
- The cycle trigger walks with a `tenant_id` predicate and runs as the invoker under forced RLS; the advisory-lock
  key includes the tenant id (no cross-tenant serialisation).
- `tenant_person_affiliations`: `tenant_id` first in every key, forced RLS, tenant-id immutability; the schema guard
  covers it automatically; entity-index rows copy `NEW.tenant_id`.

## 11. Integrity verification (extends M10A2 §11 / M10B §11)

| Code                           | Check                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `hierarchy_cycle`              | no account reaches itself through `parent_company_id` (impossible with the trigger; detects owner tampering) |
| `hierarchy_depth_exceeded`     | no account deeper than the **current** guardrail (finding after a guardrail was lowered or after a merge)    |
| `hierarchy_parent_merged`      | no active account has a `merged` parent                                                                      |
| `hierarchy_history_parity`     | current `parent_company_id` = `new_value` of its latest value-history row (when one exists)                  |
| `affiliation_endpoint_merged`  | no `active` affiliation points at a `merged` person or company                                               |
| `affiliation_reference_parity` | every `person_affiliation` generic reference resolves to an existing affiliation of the same tenant          |

Read-only; findings raise a security event and a non-zero exit; nothing is repaired.

## 12. Building on M10A1 / M10A2 / M10B

| Primitive                            | Use in M10C                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `AuthorizedContext<C>` / S2          | every new write method takes its typed context first; S2 list extended                                                 |
| Policy (`POLICY_VERSION` 3 → **4**)  | §13                                                                                                                    |
| Audit trail                          | operator edits (`allowed`), denials / failures, hierarchy and affiliation reads                                        |
| Privilege / classification manifests | new columns and table; affiliation columns `confidential` / `personal`; `parent_company_id` `internal` / `operational` |
| Data-subject map                     | `tenant_person_affiliations.person_id` → person subject (export / erasure hooks inherit it)                            |
| Entity index                         | new kind `person_affiliation`                                                                                          |
| Value history                        | `company.parent_company_id` full; affiliation fields value-free                                                        |
| Generic source references (B)        | kind `person_affiliation`; first production caller of `SourceReferenceService.observe`                                 |
| Evidence links (B)                   | no production relation added (affiliation evidence arrives with M10G)                                                  |
| Canonical versions / adoption        | `0.3`; mapping `canonical_version_min`                                                                                 |
| Integrity verification               | six new checks (§11)                                                                                                   |

## 13. Permissions (policy v4)

| Capability                            | Covers                                                          | Granted to (v4)               |
| ------------------------------------- | --------------------------------------------------------------- | ----------------------------- |
| `canonical.human_entry` (existing)    | operator hierarchy set / clear / release; affiliation add / end | **`operator`** (was none; Q2) |
| `data.account_structure.read` (new)   | hierarchy and affiliation read models / CLI                     | `operator`                    |
| `canonical.source_sync` (existing)    | source hierarchy and affiliation writes                         | `source_sync`, `system`       |
| `config.authority.publish` (existing) | publishing an authority version with `account_hierarchy`        | `operator`                    |
| `config.canonical.adopt` (existing)   | adoption of `0.3` and rollback                                  | `operator`                    |

- `canonical.human_entry` is honoured **only** by the M10C operator commands in this sub-milestone; other writers
  keep refusing it (S2 test asserts the accepted capability per method).
- **Audit actions added:** `account.hierarchy.set`, `account.hierarchy.clear`, `account.hierarchy.release`,
  `person.affiliation.add`, `person.affiliation.end`, `account_structure.read`. **Reason codes added:**
  `hierarchy_cycle`, `hierarchy_depth_exceeded`, `hierarchy_parent_merged`, `hierarchy_authority_missing`,
  `human_override_active`, `affiliation_period_invalid`, `affiliation_endpoint_not_allowed`. **Target kinds added:**
  `account_hierarchy`, `person_affiliation`. DB CHECKs equal the code (schema guard).

## 14. Performance and indexing

- `(tenant_id, parent_company_id)` serves children / descendants; ancestor walks are PK probes, bounded.
- The per-tenant hierarchy advisory lock is taken **only** when a parent is set to non-NULL (rare, configuration-
  like rate); ordinary account writes never take it.
- Roll-ups: recursive CTE bounded by the guardrail; batch loading by `id = ANY($1)`; no stored aggregates.
- Affiliations: two composite indexes; writes are per person observation (≤ links per person).

## 15. Rollback / forward-fix

- Production: forward-fix; tenant rollback = adoption back to `0.2` (data kept, writes refused).
- Dev/staging: the down-script (§8). The cycle trigger, FKs and CHECKs are never relaxed to get green.

## 16. Risks

| Risk                                             | Mitigation                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Concurrent crossing re-parents create a cycle    | per-tenant advisory lock taken **in the trigger** (raw SQL included); concurrency test (V3)  |
| Trigger walk cost on deep trees                  | bounded (64); guardrail 10; lock only on non-NULL parent writes                              |
| Two sources of truth for the primary account     | `is_primary` derived, never stored; `persons.company_id` unchanged (Q9)                      |
| Source vs human disagreement loops               | sticky human origin + explicit release (Q8)                                                  |
| Merge creates a cycle or exceeds depth           | merge never refused; cycle → unparent + issue; depth → finding (Q14)                         |
| Affiliation ending inferred from absence         | only authoritative removal / stated end date / operator; tests (V9)                          |
| Personal data in history / logs                  | value-free history; identifiers only in issues and audit details; scan tests                 |
| `canonical.human_entry` granted earlier than M15 | honoured only by M10C commands; S1/S2 tests; recorded as a conflict with the M10B note (§23) |
| `RESTRICT` blocks a legitimate delete path       | inspection first; stop and report                                                            |

## 17. Acceptance — Canonical / business correctness

- Optional parent; no self-parent; no cycles (property test + trigger + concurrency); merged parent refused.
- Guardrail refusal leaves the parent unchanged and records an issue; the rest of the record is applied.
- Value history on every parent change; explicit clear vs absent field distinguished.
- Source disappearance never unparents or ends affiliations; no cascade from parent state.
- Unresolved parent resolved in the same run's second pass or a later run.
- Human override sticky until release.
- Merge: children and affiliations re-pointed; survivor-under-loser case; no silent unparenting.
- Affiliations: one active row per pair; ended periods kept; renewed affiliation = new row; primary derived;
  `persons.company_id` behaviour unchanged.
- Not modelled via AccountContext (no context code involved).
- Canonical `0.3` published; `0.1` / `0.2` `supported`; adoption forward / rollback; new tenants at `0.3`.
- Full M6–M10B suites unchanged; identical canonical results on the Sugar and Chargebee fakes.
- Migration up / rerun / down-refusal / exact restore / re-apply.

## 18. Acceptance — Security & Data Governance

- **Cross-tenant hierarchy and affiliation impossible, proved with raw SQL as the app role** (parent, person,
  company; entity-index row for `person_affiliation`).
- Cycle refused by the database for raw-SQL writes as the app role, including two concurrent sessions.
- Authorization: source writes need `canonical.source_sync` + `account_hierarchy` authority (hierarchy) or
  `person_profile` authority (affiliation); operator edits need `canonical.human_entry` and write exactly one audit
  event; denials audited.
- Affiliations classified `personal` / `confidential`; value-free history; no names, emails or role labels in
  issues, logs or audit details (identifiers and codes only).
- Affiliations cannot be deleted by the app role; `ended` / `merged` rows terminal.
- Privilege, classification, audit-vocabulary and data-subject manifests equal the database (schema guard);
  owner-function allow-list unchanged.
- `1.0` still refused; no compliance claim.

## 19. Tests and mutation proofs

| #   | Test                                                                                                                                                                                                        | Level                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| V1  | pure hierarchy rules (`decideParentChange`: cycle, depth incl. subtree height, merged parent, human override, explicit clear vs absent); property test over random forests and re-parent sequences          | unit (property)           |
| V2  | schema: self-parent CHECK, same-tenant FK, origin CHECK, merged-parent refusal, ceiling refusal                                                                                                             | integration               |
| V3  | cycle trigger as the app role with raw SQL: direct, long, and **two concurrent sessions** crossing (A→B / B→A) → exactly one succeeds                                                                       | integration (adversarial) |
| V4  | guardrail: default 10, configured value, refusal leaves parent unchanged, issue recorded once (conflict key), other fields applied; invalid config refuses start-up                                         | integration               |
| V5  | source hierarchy sync: authority required, `canonical_version_min`, second-pass resolution, unresolved issue, explicit clear, disappearance / retirement / failed run never unparent                        | integration               |
| V6  | operator CLI: set / clear / release; capability required; one audit event; reason secret-scanned; human override blocks source change and records disagreement                                              | integration               |
| V7  | value history: full rows for `parent_company_id`; change record fields; history parity                                                                                                                      | integration               |
| V8  | merge: children re-pointed; survivor-under-loser; cycle-on-merge → unparent + issue; depth finding; loser keeps lineage; affiliations moved / ended `merged`; person-merge port                             | integration               |
| V9  | affiliations: link projection from `companyLinks`; `person.affiliation` target; authoritative removal ends; non-authoritative / absent never ends; human rows untouched; renewed = new row; primary derived | integration               |
| V10 | affiliation constraints: partial unique, period CHECK, terminal states, identity immutability, no `DELETE`, role-code pattern                                                                               | integration               |
| V11 | adversarial (app role, raw SQL): tenant-A child → tenant-B parent; tenant-A affiliation → tenant-B person / company; forge entity-index row → refused / denied                                              | integration (adversarial) |
| V12 | read models: ancestors / descendants / root / depth; bounded truncation flag; derived group ownership equals union of subtree ownership; capability + audit                                                 | integration               |
| V13 | privacy: no personal values in history (scan), issues, audit details, logs                                                                                                                                  | integration               |
| V14 | canonical catalogue: table = code; one `current` (`0.3`); stored `0.1` / `0.2` hashes reproduced; `1.0` refused                                                                                             | unit + integration        |
| V15 | adoption: below `0.3` writes refused (audited); mapping with new targets refused; after adoption accepted; rollback keeps data, refuses writes; new tenant at `0.3`                                         | integration               |
| V16 | authority: new column; existing versions' hash unchanged; `account_hierarchy` validated like other facts                                                                                                    | integration               |
| V17 | integrity: clean tenant passes; planted (owner, test DB) cycle, depth overshoot, merged parent, history mismatch, merged endpoint, orphan reference → findings + security event; nothing repaired           | integration               |
| V18 | S1 / S2: policy v4 exhaustive; `canonical.human_entry` accepted only by M10C operator methods                                                                                                               | unit                      |
| V19 | schema guard: privilege matrix, classification, data-subject map, direct composite FKs, kind / audit / conflict CHECKs equal code, allow-list unchanged                                                     | integration               |
| V20 | regression: M6 primary-company / `ambiguous_primary_company` / late-company tests, M9B retirement, M10A2 / M10B suites unchanged; identical canonical results on Sugar and Chargebee fakes                  | integration (regression)  |
| V21 | migration up / rerun / down-refusal (each condition) / exact restore / re-apply; no-backfill assertion                                                                                                      | integration (migration)   |
| V22 | runtime `88-account-hierarchy-affiliation.sh`: adopt `0.3`; operator set / show / release; affiliation add / end / list; no personal values in logs                                                         | runtime                   |

Mutation proofs (break → the named test fails for that reason → restore → green; harness refuses a dirty tree):

| #    | Mutation                                                                       | Must fail          |
| ---- | ------------------------------------------------------------------------------ | ------------------ |
| VM1  | drop the cycle trigger                                                         | V3, V19            |
| VM2  | remove the advisory lock from the trigger                                      | V3 (concurrent)    |
| VM3  | drop `tenant_id` from the parent FK (single-column FK)                         | V11, V19           |
| VM4  | drop `tenant_id` from an affiliation FK                                        | V11, V19           |
| VM5  | drop the self-parent CHECK                                                     | V2                 |
| VM6  | writer ignores the depth guardrail                                             | V4                 |
| VM7  | writer ignores subtree height                                                  | V1, V4             |
| VM8  | operator command skips the capability check                                    | V6, V18            |
| VM9  | operator command skips the audit event                                         | V6                 |
| VM10 | source write ignores `account_hierarchy` authority                             | V5                 |
| VM11 | retirement / absence unparents                                                 | V5                 |
| VM12 | human override ignored by source writes                                        | V6                 |
| VM13 | merge participant not wired                                                    | V8                 |
| VM14 | affiliation ended on non-authoritative absence                                 | V9                 |
| VM15 | `GRANT DELETE ON tenant_person_affiliations TO lip_app`                        | V10, V19           |
| VM16 | affiliation history records values (restricted rule bypassed)                  | V13                |
| VM17 | writers skip the `0.3` gate                                                    | V15                |
| VM18 | writer validation disabled entirely (positive control: database still refuses) | V3, V11 stay green |
| VM19 | integrity ignores planted cycle                                                | V17                |
| VM20 | catalogue hash always includes new members (changes `0.2`'s hash)              | V14                |
| VM21 | down-script refusal on affiliations removed                                    | V21                |

## 20. Definition of Done and evidence

| Item                                                                                                                          | Evidence                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Migration + down-script; V21                                                                                                  | CI integration job                                                                                           |
| V1–V21                                                                                                                        | CI (unit; integration with Testcontainers as the app role)                                                   |
| V22 runtime script                                                                                                            | CI runtime job                                                                                               |
| Format, lint, typecheck, boundaries, unit, integration, runtime, docker                                                       | **GitHub Actions run IDs** (workflow `CI`, all four jobs green on the reviewed head), recorded in the record |
| Mutation proofs VM1–VM21                                                                                                      | recorded with the failing output (command, failing assertion, restore, green rerun)                          |
| Fresh-clone run                                                                                                               | recorded (Docker-capable machine or CI); the sandbox has no Docker                                           |
| ADR 0029; record `docs/milestones/M10C-account-hierarchy-affiliation.md`; README status; E3 candidate note; tech-debt entries | in the PR                                                                                                    |
| Independent review, PR to `integration`, owner approval, merge                                                                | PR and review record                                                                                         |

## 21. Out of scope

- Stored roll-ups, group ARR / revenue roll-ups (Commercial, M10F), hierarchy-aware eligibility or ownership
  semantics (unchanged derived ownership only).
- Per-tenant / per-tier depth guardrail overrides (Q3).
- AccountContext (M10E) — hierarchy is never modelled through it.
- Champion-movement signals derived from affiliation ends (M10G / M11).
- Affiliation-aware opportunity contact roles (M10H), activity participants (M10K).
- Backfilling hierarchy or affiliations from existing data (Q9).
- Adapter work for Salesforce / Gainsight (no adapter exists); HubSpot parent-company association capture beyond
  what the existing mapping engine can read (Q17).
- HTTP endpoints / UI (M15); data-quality store (M10L); integrity worker job (tech debt #65).
- Raw value retention (tech debt #15); any compliance claim; publishing `1.0`.

## 22. Open questions and decisions for the owner

Each answer marked `DEFAULT` is what implementation proceeds with unless the owner overrides it.

| #   | Question                                                                   | Recommended answer (`DEFAULT`)                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | One migration / one PR?                                                    | `DEFAULT` yes (M10 §5 row 4).                                                                                                                                                                       |
| Q2  | Operator edits need `canonical.human_entry`, reserved for M15 in policy v3 | `DEFAULT` grant it to `operator` in policy v4, honoured only by the M10C hierarchy / affiliation commands (M10 §15 M10C requires operator edits under this capability).                             |
| Q3  | Depth guardrail source and DB ceiling                                      | `DEFAULT` platform config `CANONICAL_HIERARCHY_MAX_DEPTH` (1–50, default 10), writer-enforced; DB fail-closed ceiling 64 in the trigger; per-tenant / tier override deferred.                       |
| Q4  | Cycle trigger as `SECURITY DEFINER`?                                       | `DEFAULT` no: `SECURITY INVOKER` (reads only same-tenant rows visible to the caller); allow-list unchanged.                                                                                         |
| Q5  | Authority for affiliations                                                 | `DEFAULT` `person_profile` (as the primary company link today); only `account_hierarchy` is a new fact.                                                                                             |
| Q6  | Pending parent when the parent is not yet known                            | `DEFAULT` in-run second pass, then an open `hierarchy_parent_unresolved` issue retried on the next observation; no pending store.                                                                   |
| Q7  | Where guardrail / cycle refusals are recorded                              | `DEFAULT` widened `tenant_identity_conflicts` kinds (M10 §3) until M10L.                                                                                                                            |
| Q8  | Human edit vs later source value                                           | `DEFAULT` human wins and is sticky (`parent_company_origin = 'human'`); source disagreement recorded; explicit `release` returns control to the source.                                             |
| Q9  | Affiliation vs `persons.company_id`; backfill                              | `DEFAULT` `persons.company_id` stays the primary account; `is_primary` derived; no migration backfill — affiliations are projected from the next authoritative run after adoption.                  |
| Q10 | Period model                                                               | `DEFAULT` one row per period; partial unique active row per (person, company); renewed = new row.                                                                                                   |
| Q11 | Role vocabulary                                                            | `DEFAULT` `role_codes` identifiers from the mapping's explicit value map only; no canonical role picklist invented; unmapped values dropped and counted. A governed role registry is a later MINOR. |
| Q12 | Source references for affiliations                                         | `DEFAULT` generic kind `person_affiliation` for id-bearing sources; id-less associations identified by natural key.                                                                                 |
| Q13 | Re-pointing affiliations on merge                                          | `DEFAULT` end the loser row (`merged`, `merged_into_id`) and insert / reuse a survivor row; endpoints always immutable.                                                                             |
| Q14 | Merge cycle / depth / differing parents                                    | `DEFAULT` merge never refused; cycle → child unparented with history + issue; depth → integrity finding; survivor keeps its parent, inherits the loser's only when it has none.                     |
| Q15 | Affiliation value history                                                  | `DEFAULT` value-free (personal) unless a published data policy allows values.                                                                                                                       |
| Q16 | Read capability                                                            | `DEFAULT` new `data.account_structure.read` (`operator`), audited reads.                                                                                                                            |
| Q17 | Which source supplies hierarchy first                                      | `DEFAULT` any connector whose published mapping maps `account.parent` (generic engine); live verification on the Sugar fake / Chargebee test only where a parent field exists; no new adapter.      |
| Q18 | `0.2` status after `0.3`                                                   | `DEFAULT` `supported`.                                                                                                                                                                              |
| Q19 | Automatic adoption of `0.3`?                                               | `DEFAULT` no; explicit operator adoption; new tenants at `0.3`.                                                                                                                                     |
| Q20 | Rollback `0.3 → 0.2` effect on existing parents                            | `DEFAULT` kept and readable; writes refused; never unparented.                                                                                                                                      |
| Q21 | Index `person_affiliation` in the entity index?                            | `DEFAULT` yes (future evidence / extension targets); endpoints stay direct FKs (F2).                                                                                                                |
| Q22 | `ON DELETE RESTRICT` on parent and affiliation FKs                         | `DEFAULT` yes; inspect physical-delete paths; stop and report if a legitimate one breaks.                                                                                                           |
| Q23 | Hierarchy roll-up scope                                                    | `DEFAULT` structural + derived group ownership only; no stored aggregates.                                                                                                                          |
| Q24 | ADR timing                                                                 | `DEFAULT` ADR 0029 written during implementation.                                                                                                                                                   |

## 23. Conflicts / refinements against the approved M10 plan (recorded, not silent)

- **`canonical.human_entry`:** M10B / policy v3 keep it reserved for M15; M10 §15 M10C requires operator hierarchy
  edits under it. Resolved by Q2 (granted to `operator` in v4, narrowly honoured).
- **Extra column `parent_company_origin`** beyond the M10 §3 row, needed for "human overrides win" (Q8).
- **Cycle-prevention lock in the trigger**, not only in the writer (M10 §15 says "writer under a per-tenant advisory
  lock"): strictly stronger, covers raw SQL.
- **Affiliation authority:** M10 §3 adds only `account_hierarchy_connection_id`; affiliations reuse `person_profile`
  (Q5).
- **"Affiliation changes produce … value history"** (M10 §15) is met with **value-free** rows under the M10 §10
  restricted-history rule (personal category).
- **"Guardrail refusal recorded as a data-quality issue"**: the data-quality store is M10L; interim kinds on
  `tenant_identity_conflicts`, which M10 §3 already anticipates ("hierarchy conflicts").
- **Entity-index kind `person_affiliation`:** consistent with F2 (endpoints are direct FKs; indexing makes the
  affiliation a polymorphic _target_ for later evidence).

## 24. Inherited open items (unchanged unless stated)

- Tech debt #15 (privacy / retention), #62, #63, #64, #65 (integrity worker job), #66 (M10A2 down-script refusal
  coverage), #67–#71 (M10B deferrals: observed product refs, resolution via the store, operator lifecycle actions /
  HTTP provenance, multi-connection reference keys, evidence partitioning / module kinds / production relations),
  #72 (`migrations.int.spec.ts` near the hook timeout — M10C adds migration cases; the file may need splitting),
  #73 (declared-vs-observed product reference conflict on publish).
- M10C becomes the first production caller of `SourceReferenceService.observe` (kind `person_affiliation`),
  partially addressing the M10B "no production caller" risk; #67 itself (product) stays open.
- Authenticated operator identity (M15): assurance stays `asserted`.
- Live Chargebee mutations M09/M10 not run; Chargebee incremental sync disabled; live Sugar verification pending.

## 25. Baseline at plan time (2026-10-14)

- Documentation-only change: this plan and the README status line. No code, schema or migration change.
- `prettier --check` on the changed files; the CI run on the PR head is the evidence. Code baseline: `integration`
  at `e23dfd4` (M10B merge; M10B record run `38612945317` green on `1b3ef6d`, all four jobs).
