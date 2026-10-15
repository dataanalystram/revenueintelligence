# Milestone 10E — AccountContext (canonical `0.5`, module `account_context`): implementation plan

- Status: **PROPOSED PLAN (2026-10-15).** No schema, migration or code change has been made for M10E.
  Implementation follows `BUILD → TEST → VERIFY → MUTATION PROOF → FRESH CLONE → RUNTIME → DOCKER → INDEPENDENT
REVIEW → USER APPROVAL → MERGE`, on a fresh branch from `integration`.
- Every open question (§25) carries a **recommended default**. Owner instruction (2026-10-14): building all M10
  sub-milestones is approved and the recommended defaults apply **unless the owner overrides them**; each is marked
  `DEFAULT`.
- Parent: [M10 plan](M10-canonical-architecture-implementation-plan.md) (approved, revision 3: D1–D6, F1–F5), §2
  (Account Context row), §4 (AccountContext and Commercial before Signal / Opportunity), §5 row 6, §10 (value-history
  fields "AccountContext owner / status"), §15.0 and §15 (M10E), §17 (module `account_context`), §18 (scope rule F2:
  AccountContext → account is a **direct** composite FK). Predecessors: [M10A1](M10A1-security-foundation.md) (ADR
  0026), [M10A2](M10A2-canonical-versioning-governance.md) (ADR 0027), [M10B](M10B-source-reference-evidence-link.md)
  (ADR 0028), [M10C](M10C-account-hierarchy-affiliation.md) (ADR 0029), [M10D](M10D-extension-framework.md) (ADR 0030,
  merged into `integration` as `c6fd540`, PR #60).
- Candidate input: [E3 — Entity specifications §10 AccountContext](../architecture/canonical-v1/03-entity-specifications.md)
  (identity, required / optional fields, associations, pressure scenario, optional by design, retirement);
  [E4](../architecture/canonical-v1/04-extension-framework.md) (extension-registered dimensions, targets);
  [E5](../architecture/canonical-v1/05-source-reference-and-provenance.md) (source-reference lifecycle);
  [E8 pressure-test matrix](../architecture/canonical-v1/08-pressure-test-matrix.md) (Gainsight Relationship →
  AccountContext; Slack channel as a context); [CANDIDATE](../architecture/canonical-v1/CANDIDATE.md); ADR 0020
  (mapping, authority, closed transforms), ADR 0027 (registry, modules, value history).
- Base: `integration` at `c6fd540` (M10D merge; includes M10C `ce9b052`, M10B `e23dfd4`, M10A2 `506839f`). `main`
  stays untouched. This plan's PR targets `integration`.
- Two acceptance sections apply: `Canonical / business correctness` (§20) and `Security & Data Governance` (§21).
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made. M10E builds technical foundations only.
- Canonical version after M10E: **`0.5`** (M10 plan §15.0). Module `account_context` becomes **available** at `0.5`
  and stays **disabled by default** for every tenant.
- **No customer schema is invented.** No context type, dimension, role code, Gainsight field or picklist value is
  seeded. Context types are tenant-published registry entries; unknown source semantics stay `tbc` (CLAUDE.md).
- ADR: following the M10A1–M10D pattern, **no ADR is drafted with this plan**. ADR **0031** (AccountContext, module
  `account_context`, canonical `0.5`) is written during implementation (Q26).

## 0. What exists today (`IMPLEMENTED TODAY`, from inspection of `integration` `c6fd540`)

| Area                   | Fact                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccountContext storage | **None.** No `tenant_account_context*` table, no `tenant_subscriptions.context_id`, no writer, no read model.                                                                                                                                                             |
| Governed registry      | `REGISTRY_KINDS` includes `context_type`; `AVAILABLE_REGISTRY_KINDS = ['data_policy', 'extension']`, so `context_type` is refused `registry_kind_not_available`. DB CHECKs on `tenant_registry_versions` / `tenant_registry_entries` already admit `context_type`.        |
| Modules                | `canonical_modules` row `account_context`: `available = false`, `minimum_canonical_version NULL`, `depends_on []`. `signals` already declares `depends_on ['account_context']`. `ModuleGate.require` refuses `module_disabled` (audited). `extension` available at `0.4`. |
| Canonical versions     | `0.1`–`0.3` `supported`, `0.4` `current` (ADR 0030); catalogue hashes stored per version; frozen `_0_3` lists introduced in M10D for kinds lists and `AUTHORITY_FACTS_0_3`.                                                                                               |
| Entity index           | kinds `company`, `person`, `product`, `subscription`, `person_affiliation`, `custom_record`; generic `app_entity_index_add/remove(kind)` triggers owned by `lip_entity_indexer`.                                                                                          |
| Authority (ADR 0020)   | facts `account_profile`, `person_profile`, `subscription_lines`, `subscription_state`, `subscription_terms` (required) and `account_hierarchy` (optional, M10C).                                                                                                          |
| Mapping                | `MappingEntitySchema` = `account` / `person` / `subscription` (+ M10D entry kinds `attribute`, `custom_object`, `custom_relationship`, `capture`).                                                                                                                        |
| Subscriptions          | `tenant_subscriptions` PK `(tenant_id, id)`, composite FKs to `companies` and `tenant_products (tenant_id, key)`; no context column.                                                                                                                                      |
| Security               | `POLICY_VERSION = 5`; capabilities `canonical.source_sync`, `canonical.human_entry`, `config.registry.publish`, `data.extension.read`; secret-like refusal (M10A1); classification manifest covers every column (schema guard).                                           |

## 1. Scope

1. Registry kind **`context_type`** made available (document, rules, classification of dimensions) — §2.
2. Tables `tenant_account_contexts`, `tenant_account_context_persons`, `tenant_account_context_products`, and
   `tenant_subscriptions.context_id` (0..1) — §3.
3. Writers: `AccountContextWriter`, `AccountContextMembershipWriter`, line context assignment — §4.
4. Mapping entity **`account_context`** and the subscription line context reference — §5.
5. Module gate `account_context`, canonical `0.5`, adoption / rollback behaviour — §10.
6. Merge participants, read models (optional scope filter), CLI, integrity checks, permissions (policy v6).

## 1.1 Non-goals

- No context-level **permission model** (only a stable scope id and an optional read filter; M15 decides permissions).
- No Goal, MetricObservation, Signal, Opportunity, Contract or Activity links to contexts (their milestones add
  `context_id` FKs at `0.6`+). The renewal date is a plain optional date; the Contract reference arrives with M10F.
- No derived account-level aggregation view beyond the read model listing contexts per account.
- No automatic context inference (no context is created from subscriptions, regions or owners without a mapping or an
  operator command).
- No live Gainsight connector; Gainsight Relationship is a pressure scenario tested with fixtures only.
- No change to hierarchy (M10C): AccountContext never models parent / child accounts.

## 2. Context type registry (kind `context_type`)

### 2.1 Document

One immutable registry version per publish (M10A2 pattern: base version, reviewed content hash, advisory lock, one
audit event). Entries:

- `key` (`^[a-z][a-z0-9_]{0,62}$`), `title`, `description`;
- `dimensions[]` (1–6, ordered; order is part of the natural key): `key`, `type` ∈ `product_key` | `code` |
  `string` | `extension_ref`, `required` boolean, `codes[]` (for `code`), `extension_field` (for `extension_ref`,
  an active M10D field definition), `sensitivity`, `categories[]`;
- `member_roles[]`: closed per-type role codes for persons (for example a tenant-declared `csm`); none is seeded;
- `allow_products` boolean (explicit product memberships beyond product dimensions);
- `status` `active` / `retired` (projection column).

### 2.2 Rules (beyond the generic R-K / R-X1 / R-X3 / R-X4)

- **R-C1** dimension keys and order never change for an existing type; adding a dimension needs a new type key (the
  natural key would otherwise move, Q5).
- **R-C2** a dimension's `codes` never lose a code (R-X3 applied); new codes may be added.
- **R-C3** dimension classification may only become stricter (R-X6 from M10D).
- **R-C4** `extension_ref` dimensions must reference an active extension field of type `string`, `enum` or
  `integer` whose target includes `account_context`, and require module `extension` enabled at publish.
- **R-C5** credential-like keys / titles refused (M10D closed token list); `restricted` dimensions refused while tech
  debt #15 is open (Q11).
- **R-C6** a type with live contexts can be retired, never deleted; new contexts of a retired type are refused.

## 3. Schema (one migration, §11)

All tables tenant-owned, `tenant_id` first in every key, **forced RLS** with the tenant policy, tenant-id immutability
trigger, privileges from the manifest.

### 3.1 `tenant_account_contexts`

`(tenant_id, id uuid, company_id, context_type_id, context_type_registry_kind = 'context_type', natural_key_hash,
dimensions jsonb, name, status, owner_ref, renewal_date date, record_state, merged_into_id, created_at, updated_at,
last_change_id)`

- PK `(tenant_id, id)`; **direct composite FK** `(tenant_id, company_id) → companies (tenant_id, id)` (F2);
- FK `(tenant_id, context_type_registry_kind, context_type_id) → tenant_registry_entries (tenant_id, kind, id)` (proves
  the entry is a context type; M10D `field_registry_kind` pattern);
- unique `(tenant_id, company_id, context_type_id, natural_key_hash)` where `record_state = 'active'`;
- `natural_key_hash` = SHA-256 of the canonical JSON of the ordered dimension values (Q4);
- CHECKs: `status IN ('active','inactive','retired')`, `record_state IN ('active','merged')`, `merged_into_id` set
  iff merged, `name` 1–200 chars, `dimensions` an object of ≤ 6 scalar values, depth 1;
- `merged_into_id` composite self-FK; entity-index triggers (kind `account_context`).

### 3.2 `tenant_account_context_persons`

`(tenant_id, context_id, person_id, role_code, status ('active','ended'), started_at, ended_at, last_change_id)` —
PK `(tenant_id, context_id, person_id, role_code)`; composite FKs to contexts and `persons`; CHECK
`ended_at IS NULL OR ended_at >= started_at`. Role validated against the type's `member_roles` by the writer.

### 3.3 `tenant_account_context_products`

`(tenant_id, context_id, product_key, origin ('dimension','explicit'), created_at)` — PK
`(tenant_id, context_id, product_key)`; composite FKs to contexts and `tenant_products (tenant_id, key)`.

### 3.4 `tenant_subscriptions.context_id`

Nullable column + composite FK `(tenant_id, context_id) → tenant_account_contexts (tenant_id, id)` (0..1 per line).
Guard trigger: the context's `company_id` equals the line's `company_id` and the context is `active` /
`inactive` at assignment (Q8). Index `(tenant_id, context_id)`.

### 3.5 Widened catalogues

- `tenant_entity_index` kind + `account_context`; `tenant_source_references.entity_kind` + `account_context`;
- `tenant_context_changes.entity_kind` + `account_context`, `account_context_person`; change **types not widened**
  (catalogue hash);
- `tenant_value_history_field_valid` + `account_context.owner_ref`, `account_context.status` (M10 §10),
  `subscription.context_id`;
- `tenant_identity_conflicts.kind` + `account_context_merge_collision`, `account_context_company_mismatch`,
  `account_context_human_override_disagrees`, `account_context_reference_unresolved`;
- M10D extension target CHECKs + `account_context` (Q19).

## 4. Writers

### 4.1 `AccountContextWriter` (single writer of contexts)

- Upsert by natural key `(company, type, dimensions)` or by source reference; dimensions validated against the type
  (required, type, codes, product exists, extension value resolvable); secret-like refusal on every string.
- Gate: adopted ≥ `0.5` **and** module enabled (`canonical_version_too_low` / `module_disabled`, both audited).
- Source writes need `canonical.source_sync` plus authority fact `account_context` held by the connection; operator
  writes need `canonical.human_entry` and write an audit event with a code-token reason.
- Product dimensions maintain `origin = 'dimension'` product memberships.
- Change record per write; value history on `owner_ref` / `status`; source reference via the generic store.
- Status `retired` never touches the account, lines or members (lines keep their `context_id`; new assignments
  refused).

### 4.2 `AccountContextMembershipWriter`

- Persons: add / end (never delete); person and context must be same tenant (writer + FK); an affiliation between the person
  and the context's account is **not required** (Q9); role validated.
- Explicit products: only when the type sets `allow_products`.

### 4.3 Line context assignment

- `SubscriptionLineWriter` sets `context_id` from the mapping reference (§5.2) or `account-context assign-line`.
  Different account → refused + `account_context_company_mismatch` issue. Change record + value history on
  `subscription.context_id`. Module disabled ⇒ the line is written exactly as today and the assignment is counted
  `context_assignment_skipped`.

### 4.4 Human vs source (Q14)

Operator values win and are sticky until `release` (M10D Q16 pattern); disagreement recorded as
`account_context_human_override_disagrees`.

## 5. Mapping

### 5.1 Entity `account_context`

`MappingEntitySchema` + `account_context` (canonical `0.5` mapping catalogue): targets `account_context.account`
(account source reference), `.type` (constant per object), `.name`, `.status` (via `valueMap`), `.ownerRef`,
`.renewalDate`, `.dimension.<key>`; persons via `account_context.person` (`role` constant or `valueMap`). Closed
transforms unchanged. Publish refused below `0.5` or with the module disabled (`disabledModuleTargets`).

### 5.2 Line reference

Subscription mapping target `subscription.contextRef` (source id of a context from the same connection); unresolved →
`account_context_reference_unresolved`, line written without context.

## 6. Classification

- `name` `internal`; `dimensions` classified per row from the type (manifest marks the column `restricted` with
  `classifiedBy: 'registry'`, M10D Q34 pattern); `owner_ref` `internal` (opaque source owner id; email-like values
  refused, Q12); `renewal_date` `confidential` / `financial`; membership `role_code` `internal`; person link `personal`
  via the person subject link.

## 7. Merge participants

- Company merge: loser's contexts re-pointed to the survivor; natural-key collision → loser context `merged` into the
  survivor's, members and lines moved, `account_context_merge_collision` recorded (Q15).
- Person merge: memberships moved (duplicate role ended on the loser).
- Product key retirement: product memberships kept (history), new ones refused.

## 8. Read models and CLI

- `AccountContextReadModel.listForAccounts(ids, { scope?: contextId[] })`, `get(id)`, `linesForContext(id)` — batch
  loading; the optional `scope` filter is the future authorization hook (no permission model yet).
- CLI `account-context` `list` / `show` / `upsert` / `retire` / `member add|end` / `assign-line` / `release`; reads
  audited one event per call; `data.account_context.read` required.

## 9. Change records and value history

Existing change types only; entity kinds `account_context`, `account_context_person`; value history on `owner_ref`,
`status` and `subscription.context_id` (classification-aware restricted-history rule unchanged).

## 10. Canonical version `0.5` and module `account_context`

- `CANONICAL_VERSIONS`: `0.1`–`0.4` `supported`, `0.5` `current` (ADR 0031); migration inserts `0.5` and moves `0.4` to
  `supported` in the order the one-current trigger accepts.
- **Catalogue hash:** `0.5` = `0.4` catalogue + entity kind `account_context`, change kinds `account_context` /
  `account_context_person`, generic reference kind `account_context`, mapping entity `account_context`, authority
  fact `account_context`, extension target `account_context`, registry kind `context_type`. Frozen `_0_4` lists are
  introduced so the **stored `0.1`–`0.4` hashes are reproduced unchanged** (test V2).
- `CANONICAL_VERSION_FEATURES['0.5']` = `account_context`, `context_type_registry`, `context_membership`,
  `line_context`.
- Module row: `available = true`, `minimum_canonical_version = '0.5'`, `entity_kinds = ['account_context']`,
  `depends_on []` (unchanged). Disabled by default.
- **Gating (Q17):** writers, registry publish of `context_type`, mapping publish with `account_context` and operator
  commands need adopted ≥ `0.5` **and** module enabled.
- **Adoption:** explicit `canonical adopt --version 0.5 --expected-current 0.4`; dry run lists
  `modulesNewlyAvailable: ['account_context']`; new tenants adopt `0.5` at provisioning (module disabled).
  **Rollback `0.5 → 0.4`** allowed with the module enabled: data kept and readable, writes refused, dry run lists
  `modulesStranded: ['account_context']` (Q18).
- **Disable** after use: data and line `context_id` kept; writes refused; reads still allowed (Q20).

## 11. Migration / rollback

One forward migration **`20270119120000_m10e_account_context`** (timestamp after `20270112120000`):

1. tables §3.1–3.3 with constraints, indexes, triggers; `tenant_subscriptions.context_id` + FK + guard trigger;
2. kind CHECKs widened (§3.5); authority-document schema accepts optional `account_context`;
3. `canonical_modules` `account_context` available at `0.5`; `canonical_model_versions` insert `0.5`, `0.4` →
   `supported`;
4. audit capability / action CHECKs widened (policy v6); forced RLS, tenant policy, tenant-id immutability;
   privileges (`REVOKE ALL`, then manifest grants; no DELETE on contexts or person memberships).

- **No backfill**: no context, context type or line assignment is invented. Additive only; existing lines get
  `context_id NULL`.
- **Down-script** (dev/staging) refuses while any context-type registry version, context, membership or non-null
  `context_id` exists, any change / conflict / value-history / source-reference / entity-index row uses a new kind, any
  tenant has `account_context` enabled or a setting event for it, or any tenant adopted `0.5`; otherwise restores the
  M10D state exactly (CHECKs, module row, `0.4` `current`, privilege matrix). Production: forward-fix only.
- Migration tests in `migrations-m10e.int.spec.ts` (tech debt #72): up, idempotent rerun, down refusal, exact
  restore, re-apply; Prisma drift test green.

## 12. Backward compatibility

Module disabled (default) ⇒ every existing flow (sync, eligibility, hierarchy, extension, adoption) is byte-for-byte
unchanged: same change records, same eligibility snapshots, same mapping hashes (regression V4).

## 13. Tenant isolation

Composite FKs on every relation (context → company, type entry, person, product, line → context); forced RLS on all
three tables; adversarial raw SQL as the app role cannot create a cross-tenant membership, product or line link.

## 14. Integrity verification (extends M10A2–M10D)

New checks: `account_context_company_mismatch` (line vs context account), `account_context_natural_key_drift`
(stored hash vs recomputed), `account_context_type_mismatch` (dimensions vs type), `account_context_dangling_merge`,
`account_context_member_role_unknown`. CLI only (tech debt #65).

## 15. Permissions (policy v6)

- No new write capability: `canonical.source_sync` (+ authority fact), `canonical.human_entry` (scope widened to M10E
  commands), `config.registry.publish` for `context_type`, `module.enable` unchanged.
- New `data.account_context.read` (`operator`). Audit actions: `account_context.write`, `account_context.retire`,
  `account_context.member.set`, `account_context.line.assign`, `account_context.release`, `account_context.read`.

## 16. Performance

Indexes `(tenant_id, company_id)`, `(tenant_id, context_type_id)`, `(tenant_id, context_id)` on lines and members;
read models batch by account. Load evidence: 10k contexts × 100k lines (recorded, not a gate).

## 17. Risks

- Natural key drift if dimension semantics change → R-C1 (new type key) + integrity check.
- Line ↔ context account mismatch after a company merge → merge participant re-points contexts first; guard trigger
  and integrity check.
- Module disabled while data exists → writes refused, reads allowed, documented.
- Owner reference leaking personal data → opaque id only, email-like refusal.

## 18. Tests (V\*)

| #   | Test                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| V1  | Canonical `0.5` catalogue: features, kinds, mapping entity, authority fact; `0.5` `current`, `0.4` `supported`.           |
| V2  | Stored `0.1`–`0.4` catalogue hashes reproduced unchanged.                                                                 |
| V3  | Module catalogue = code (schema guard): `account_context` available at `0.5`, entity kinds `['account_context']`.         |
| V4  | Module disabled ⇒ zero behavioural change (sync, eligibility, mapping hash, change records) — regression.                 |
| V5  | Below `0.5` → `canonical_version_too_low`; disabled → `module_disabled`; both audited.                                    |
| V6  | Context type publish: R-C1–R-C6, credential-like refusal, unclassified dimension refused.                                 |
| V7  | Same account + product in two regions → two contexts, distinct natural keys (E3 pressure scenario).                       |
| V8  | Natural-key idempotency: re-sync updates, never duplicates.                                                               |
| V9  | Dimension validation: missing required, unknown code, unknown product, wrong type refused.                                |
| V10 | 0..1 context per line; line of another account refused + issue.                                                           |
| V11 | Retirement never cascades to account, lines or members; new assignment to retired context refused.                        |
| V12 | Person membership add / end, role validated, never deleted.                                                               |
| V13 | Product memberships from product dimensions and explicit (`allow_products`).                                              |
| V14 | Mapping entity `account_context` publish / validate / run (fixture shaped like a Gainsight Relationship, no real fields). |
| V15 | Line `contextRef` resolution and unresolved issue.                                                                        |
| V16 | Authority: source write without `account_context` fact refused.                                                           |
| V17 | Human override sticky until release; disagreement recorded.                                                               |
| V18 | Value history on owner / status / line `context_id`.                                                                      |
| V19 | Company merge re-points; collision merges contexts; person merge moves members.                                           |
| V20 | Read model batch + optional scope filter; read audit.                                                                     |
| V21 | Cross-tenant membership / product / line link impossible (raw SQL as app role).                                           |
| V22 | Forced RLS + tenant policy on the three tables (schema guard).                                                            |
| V23 | Secret-like values refused in name, dimensions, owner_ref; email-like owner_ref refused.                                  |
| V24 | Classification manifest covers every new column; dimension classification from the registry.                              |
| V25 | Adoption `0.4 → 0.5` dry run / apply; rollback `0.5 → 0.4` with module enabled (data readable, writes refused).           |
| V26 | Module disable after use: reads allowed, writes refused, data kept.                                                       |
| V27 | Extension values on `account_context` targets (module `extension` enabled) and `extension_ref` dimension.                 |
| V28 | Integrity checks (§14) detect seeded faults.                                                                              |
| V29 | Migration: up, rerun, down refusal per guard, exact restore, re-apply; drift test.                                        |
| V30 | Privileges: no DELETE on contexts / person memberships; no DDL by the app role.                                           |

## 19. Mutation proofs (VM\*)

| #    | Mutation (each must turn a named test red)                            |
| ---- | --------------------------------------------------------------------- |
| VM1  | Drop `tenant_id` from the membership → person FK (V21).               |
| VM2  | Drop `tenant_id` from the line → context FK (V21).                    |
| VM3  | Remove the module gate in the writer (V5).                            |
| VM4  | Skip the refusal audit event (V5).                                    |
| VM5  | Remove the line / context same-account guard trigger (V10).           |
| VM6  | Cascade retirement to lines (V11).                                    |
| VM7  | Drop the natural-key unique index (V8).                               |
| VM8  | Omit a dimension from the natural-key hash (V7).                      |
| VM9  | Disable R-C1 (V6).                                                    |
| VM10 | Accept an unclassified dimension (V6, V24).                           |
| VM11 | Remove secret-like refusal on dimensions (V23).                       |
| VM12 | Use the live (unfrozen) kinds list in the `0.4` hash (V2).            |
| VM13 | Remove `FORCE ROW LEVEL SECURITY` on `tenant_account_contexts` (V22). |
| VM14 | Skip the authority-fact check on source writes (V16).                 |
| VM15 | Ignore the scope filter in the read model (V20).                      |
| VM16 | Merge participant leaves loser contexts on the loser account (V19).   |

## 20. Acceptance — Canonical / business correctness

Optional module (disabled ⇒ no change); two contexts for same account + product in different regions; 0..1 context
per line; retirement never cascades; separate from hierarchy; natural key stable; merge correct; stored hashes
unchanged.

## 21. Acceptance — Security & Data Governance

Context membership tenant enforcement (composite FKs, adversarial); stable context id usable as a future
authorization scope, read models take the optional scope filter; writers refuse when the module is disabled and the
refusal is audited; context dimension values classified; forced RLS on every new table; secret-like refusal; reads
audited.

## 22. Done criteria

- V1–V30 green; VM1–VM16 recorded with the failing test each; CI green on the PR head.
- Fresh clone, runtime and Docker checks per the standard gates; migration down / up evidence.
- Record `M10E-account-context.md`, ADR 0031, README / delivery-plan status, tech-debt entries for deferrals.
- Independent review passed; merge into `integration` (merge to `main` needs Ram's approval).

## 23. Out of scope

Context permissions (M15), Contract link (M10F), Signal / Opportunity / Goal / Activity context FKs (their
milestones), derived account rollups, live Gainsight / Slack connectors, context inference.

## 24. Building on predecessors

M10A1 actor / audit / classification / secret refusal; M10A2 registry, modules, entity index, value history,
adoption; M10B generic source references; M10C merge participants and override pattern; M10D frozen-list pattern,
registry-classified columns, extension targets.

## 25. Open questions and decisions for the owner

Each answer marked `DEFAULT` is what implementation proceeds with unless the owner overrides it.

| #   | Question                               | Recommended answer (`DEFAULT`)                                                                                                           |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | One migration / one PR?                | `DEFAULT` yes (M10 §5 row 6), staged commits.                                                                                            |
| Q2  | Where context types live               | `DEFAULT` governed registry kind `context_type` (M10 §2), not a column enum; none seeded.                                                |
| Q3  | Dimensions storage                     | `DEFAULT` `dimensions jsonb` (flat, ≤ 6 scalars, validated against the type) — no per-dimension columns, no DDL per type.                |
| Q4  | Natural key                            | `DEFAULT` `(tenant, company, type, SHA-256 of ordered canonical dimension JSON)`, unique among active rows.                              |
| Q5  | Changing a type's dimensions           | `DEFAULT` refused (R-C1); a new type key is needed.                                                                                      |
| Q6  | Account FK style                       | `DEFAULT` direct composite FK to `companies` (F2); entity index used only because contexts are polymorphic **targets**.                  |
| Q7  | Product association                    | `DEFAULT` product-key dimensions auto-maintain memberships; explicit memberships only when the type allows.                              |
| Q8  | Line ↔ context account                 | `DEFAULT` must match (guard trigger + writer); assignment to a retired context refused.                                                  |
| Q9  | Person must be affiliated with account | `DEFAULT` not required (Gainsight relationship persons may be unaffiliated); integrity reports it informationally.                       |
| Q10 | Membership deletion                    | `DEFAULT` never deleted; ended with `ended_at`.                                                                                          |
| Q11 | Restricted dimensions                  | `DEFAULT` refused at publish while tech debt #15 is open.                                                                                |
| Q12 | `owner_ref` shape                      | `DEFAULT` opaque source owner id, `internal`; email-like and secret-like values refused; no person FK (CSM is a vendor user).            |
| Q13 | Renewal date vs Contract               | `DEFAULT` plain optional date now; `contract_id` added by M10F.                                                                          |
| Q14 | Operator vs source                     | `DEFAULT` human wins, sticky until `release`; disagreement recorded.                                                                     |
| Q15 | Company merge collision                | `DEFAULT` loser context `merged` into survivor's; members and lines moved; conflict recorded.                                            |
| Q16 | Authority                              | `DEFAULT` new optional authority fact `account_context` (frozen in the `0.5` catalogue); line `contextRef` follows `subscription_lines`. |
| Q17 | Gating                                 | `DEFAULT` adopted ≥ `0.5` **and** module enabled for writers, `context_type` publish, mapping publish and operator commands.             |
| Q18 | Rollback `0.5 → 0.4` with module on    | `DEFAULT` allowed; data kept and readable; writes refused; dry run lists `modulesStranded`.                                              |
| Q19 | Extension targets                      | `DEFAULT` `account_context` becomes an extension target at `0.5`; `extension_ref` dimensions need module `extension`.                    |
| Q20 | Disable after use                      | `DEFAULT` reads allowed, writes refused, line `context_id` kept (no silent nulling).                                                     |
| Q21 | Context-level permissions              | `DEFAULT` none in M10E; stable id + optional read scope filter only.                                                                     |
| Q22 | Capabilities                           | `DEFAULT` existing write capabilities (human-entry scope widened); new `data.account_context.read`; policy v6.                           |
| Q23 | Value history                          | `DEFAULT` `owner_ref`, `status` (M10 §10) and line `context_id`.                                                                         |
| Q24 | Change vocabulary                      | `DEFAULT` change types unchanged; entity kinds `account_context`, `account_context_person`.                                              |
| Q25 | Read audit                             | `DEFAULT` one audit event per read call (identifiers, counts).                                                                           |
| Q26 | ADR timing                             | `DEFAULT` ADR 0031 written during implementation.                                                                                        |

## 26. Conflicts / refinements against the approved M10 plan (recorded, not silent)

- Context types use the `context_type` registry kind with dimension classification (M10 §15 says "context type
  registry entries" without rules; R-C1–R-C6 added).
- `tenant_account_context_persons` / `_products` named as in M10 §2; the line same-account guard is added beyond the
  M10 text ("0..1 context per line").
- New authority fact `account_context` (M10 does not list one); optional, so existing authority documents and hashes
  are unchanged.
- Policy version bumps to v6 for `data.account_context.read`.

## 27. Tech-debt interactions

#15 (restricted dimensions refused), #65 (integrity checks CLI only), #71 (`account_context` becomes the second
module-owned entity kind), #72 (separate migration spec), #79 (code-token reasons), #83 / #88 (unchanged, M10D).

## 28. Baseline at plan time (2026-10-15)

Documentation-only change: this plan and the README status. No code, schema or migration change. `prettier --check`
on the changed files; the CI run on the PR head is the evidence. Code baseline: `integration` at `c6fd540` (M10D
merge, PR #60).
