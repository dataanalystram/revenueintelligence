# ADR 0028: Generic source references, evidence links, provenance read model and canonical 0.2 (Milestone 10B)

- Status: **implemented, in review** (PR #5 `m10b-impl` → `integration`; not merged)
- Date: 2026-10-14
- Plan: [M10B plan](../milestones/M10B-source-reference-evidence-link-plan.md) (owner defaults Q1–Q24 apply)
- Record: [M10B record](../milestones/M10B-source-reference-evidence-link.md)
- Builds on: ADR 0014 (identity, references, provenance), ADR 0016 (product model versioning), ADR 0017
  (subscription line identity), ADR 0026 (security foundation), ADR 0027 (canonical versioning and governance)
- Candidate: implements E5 (source reference, provenance and history) for non-legacy kinds; E5 candidate note:
  declared product references and the evidence endpoint types (entity / change record / eligibility snapshot).
- No SOC 2, GDPR, HIPAA, ISO 27001 or legal-retention claim is made.

## Context

Before M10B only companies and persons had reference tables (`company_external_refs`, `person_external_refs`),
subscription lines carried their source triple inline, and product references existed only as `externalRefs` inside
immutable product-model documents. Change records required an `entity_id`, so key-identified entities (products,
D3) could not be recorded. Nothing linked a derived record to its evidence, and there was no read model answering
E5's questions ("where did this value come from", "what supported it"). Every later M10 entity (Signal M10G,
Opportunity M10H, …) needs one reference store, immutable evidence and a provenance read path.

## Decision

1. **One generic reference store for non-legacy kinds.** `tenant_source_references` holds every reference of a
   kind that has no legacy store; its only kind in M10B is `product` (by key, D3). Legacy kinds are refused by the
   named CHECK `tenant_source_references_not_legacy_kind` and by the service (`reference_kind_not_generic`).
   Exactly one entity form (`entity_id` xor `entity_key`), composite FKs to `tenant_entity_index` by id and by key,
   lifecycle `active` / `retired` / `deleted` / `merged` with the named retirement gate CHECK (observed rows retire
   only with a run, declared rows only with a model version), identity-immutability trigger, `lip_app`
   `SELECT, INSERT, UPDATE` and **no `DELETE`**.
2. **Shared lifecycle rules.** `decideReferenceObservation`, `decideReactivation`, `decideRetirement` and
   `decideMerge` are one pure domain module used by `SourceReferenceService` and the existing company/person path
   (behaviour-identical, proven by an equivalence grid against the legacy rule).
3. **Single writer.** `SourceReferenceService` (`observe`, `retireAbsentWithin`, `merge`,
   `applyDeclaredProductReferences`); every method takes `(actx, tx, input)` with `actx: AuthorizedContext<C>` first
   (S2), one change record per real change, row lock / advisory lock per triple.
4. **Product references are a declared projection** of the product model, written only inside product-model
   publish (`config.product_model.publish`) and backfilled by the migration from each tenant's latest model (no
   change records — a migration must not fabricate provenance). Add → `ref_added`; remove → `retired`
   (`retired_by_model_version`); re-add → `reactivated` (same row); move → re-pointed `updated`. Resolution keeps
   reading the model; parity is an integrity check. The change-record adapter name is **`product_model`**.
5. **Immutable evidence links.** `tenant_evidence_links` stores link sets (ordinal 0–999, roles `supports` /
   `contradicts` / `derived_from` / `context`, evidence types `entity` / `change_record` / `eligibility_snapshot`),
   every endpoint behind a tenant-composite FK, append-only by privilege (`SELECT, INSERT`) and by the
   `app_refuse_change` trigger. Re-derivation writes a new set with `supersedes_link_set_id`; the old set stays.
   `EvidenceLinkWriter` is the single writer (`canonical.evidence.link`, system-only): relation catalogue (empty in
   production in M10B, Q13), set limits, derivation rule, live non-merged targets, same-subject supersession,
   module gate, adopted version ≥ 0.2. It is layer-1 validation; the database is the boundary.
6. **Read-only `source_reference_index` view** (`security_invoker = true`, `SELECT` only) over the company, person,
   subscription and generic stores — no copy, no write path.
7. **Provenance read model.** `ProvenanceQueryService.show(actx, query)` (`data.provenance.read`, operator-only)
   returns references, the latest change record naming a field with its value history (values only where
   `values_recorded`), current / superseded evidence sets and "cited by"; one `provenance.read` audit event per
   call; never reads a value from a canonical row. CLI `provenance show`.
8. **Change records for key-identified entities.** `tenant_context_changes` gains `entity_key`; `entity_id`
   becomes nullable; exactly-one and key-only-for-products CHECKs; `product` added to the entity kinds.
9. **Canonical `0.2`** (`current`, this ADR; `0.1` → `supported`). Its catalogue adds change entity kinds, generic
   reference kinds, evidence types and roles as optional hash members (Q19), so `0.1`'s stored hash is unchanged.
   Existing tenants adopt explicitly (`canonical adopt … --version 0.2`, dry run lists
   `observed_generic_source_references`, `evidence_links`, `key_identified_change_records`); new tenants adopt
   `0.2` at provisioning. Observed references and evidence links are refused below `0.2`
   (`canonical_version_too_low`, audited); the declared projection is not gated (Q7). Rollback to `0.1` keeps the
   data and refuses new writes.
10. **Security integration.** Policy v3 (`canonical.evidence.link` system-only, `data.provenance.read`
    operator-only), audit actions `provenance.read`, `evidence.link`, `source_reference.observe`, manifests
    (privilege incl. the view, classification of every new column), six integrity checks (declared drift,
    cross-store ambiguity, change mismatch, unknown relation, invalid supersession, index parity).

## Deviations from the plan (recorded during implementation)

- **Adapter name `product_model`**, not `product-model` (plan §6): the existing change-record adapter CHECK is
  `^[a-z0-9_]{1,32}$`. Plan §6 carries a note.
- **Plain index instead of the partial index** `(tenant_id, system, object_type) WHERE state = 'active'`: a plain
  `(tenant_id, system, object_type, state)` index (Prisma-schema expressible, no drift with the schema guard);
  retirement scans filter on `state` within the same prefix.
- **No separate `link_set_id` index**: the unique `(tenant_id, link_set_id, ordinal)` index serves set lookups.
- **Extra change-record index** `(tenant_id, entity_kind, entity_key, ingested_at)` for key-identified history
  (provenance and integrity reads).
- **Method signatures `(actx, tx, input)`** instead of the plan's `(tx, ctx, …)`: S2 requires the authorized
  context as the first parameter of every write.
- **Merge semantics**: `decideMerge` returns `merge` for a reference already merged into a _different_ survivor
  (re-points lineage), matching the legacy company/person merge path; `refused` only for a self-merge.
- **S22 test edit**: the M10A1 secret-ingestion integration test (`secret-ingestion.int.spec.ts`) scoped its
  change-record actor assertion (distinct `actor_kind` / `actor_assurance` of the runs' change records) to
  `entity_kind <> 'product'` (`c52bd44`), because product-model
  publish now writes operator-actor product-reference change records by design.

## Consequences

- Later entities (Signal, Opportunity, …) add their kinds to the generic store and their relations to the
  evidence catalogue instead of new reference tables.
- The legacy company / person / subscription stores stay as they are; the view unifies reads. Their migration into
  the generic store is out of scope.
- The dev/staging down-script refuses while any M10B-only data class exists, **including any adoption of `0.2`**;
  a tenant that adopted `0.2` (every new tenant) blocks the down-script. Production is forward-fix only.
- Deferred: time-range partitioning of evidence links (M10 §13); the first production evidence relations (M10G /
  M10H); module-owned evidence kinds (`EVIDENCE_KIND_MODULES` is empty, so the writer's module gate is not
  exercised yet).
