# Milestone 9E — Canonical architecture review: discovery report and proposed plan

- Status: **DISCOVERY COMPLETE — PLAN PROPOSED, AWAITING OWNER REVIEW.** No architecture document, schema, migration or
  code has been changed for M9E. M9C and M9D have not started. Canonical Model v1.0 is **not** frozen.
- Base: `main` at `a9c0133` (M9B closed: PR #16 merge `eb92580`, closure PR #17 merge `a9c0133`).
- Brief: the owner's "M9E — Canonical Architecture Review and v1 Candidate Design" (2026-10-09). The sequence is
  reordered: M9A ✅ → M9B ✅ → **M9E** → M9C → M9D → v1.0 freeze.
- Labels used throughout:
  - **IMPLEMENTED** — code, schema and tests exist on `main`;
  - **DOMAIN-ONLY** — a Zod schema or pure function exists in `modules/domain`, but nothing persists or uses it
    outside the domain;
  - **DOCUMENTED** — designed in an ADR or architecture document, not built;
  - **PROPOSED (M9E)** — new in this plan;
  - **DEFERRED**.

Evidence was gathered from the repository itself:

- `apps/api/prisma/schema.prisma` (33 models);
- `apps/api/src/modules/domain/*`;
- ADRs 0007, 0012, 0014, 0016–0024;
- `docs/architecture/canonical-extension-and-source-mapping.md` (pre-M8 design gate, "the extension design" below);
- `docs/product/roadmap.md`;
- `docs/milestones/M09-multi-source-data-quality-plan.md` (the M9 plan);
- the M7–M9B records.

---

## 1. Canonical entities actually implemented

| Concept                                                                                                                                               | State                                                                                                                                                                                                                                                                                                                | Where                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Account** ("Company")                                                                                                                               | **IMPLEMENTED**. Fields: platform id, nullable name, domains, `customerStatus` (`prospect`/`customer`/`former_customer`/`unknown`), `recordState` (`active`/`inactive`/`merged`), merge lineage. **No hierarchy** (no parent).                                                                                       | `companies`, `domain/company.ts`, ADR 0014                                                    |
| **Person**                                                                                                                                            | **IMPLEMENTED**. Emails (not identity), names, job title, optional primary company, buying roles (closed enum), record state, merge lineage.                                                                                                                                                                         | `persons`, `domain/person.ts`                                                                 |
| **Product**                                                                                                                                           | **IMPLEMENTED** as a per-tenant **versioned product model**. Product = tenant key (identity, meaning never changes), name, family, status. Relationships: `requires` / `excludes` / `replaces` / `includes`. Account-attribute conditions (only `customer_status`). Ownership policy per product.                    | `tenant_product_models` (immutable versions + hash), `tenant_products` (projection), ADR 0016 |
| **Subscription line**                                                                                                                                 | **IMPLEMENTED**. One source line: company, product key, canonical `state` (`active`/`trial`/`expired`/`cancelled`/`unknown`), terms, quantity, source reference `(system, objectType, recordId)`, record state (`active`/`deleted`), ordering and idempotency fields. Ownership is derived from lines, never stored. | `tenant_subscriptions`, `domain/subscription.ts`, ADR 0017                                    |
| **Eligibility / whitespace**                                                                                                                          | **IMPLEMENTED** (derived, not an entity). Pure evaluator with categories `owned` / `eligible_whitespace` / `ineligible_whitespace` / `unknown`; frozen snapshots; coverage tiers (`externally_grounded` / `stable_snapshot` / none).                                                                                 | `domain/eligibility.ts`, `coverage.ts`, `tenant_eligibility_snapshots`, ADR 0018/0023         |
| Ownership gap                                                                                                                                         | **IMPLEMENTED** (data-quality record per account and line).                                                                                                                                                                                                                                                          | `tenant_ownership_gaps`                                                                       |
| Identity conflict                                                                                                                                     | **IMPLEMENTED** (review queue; never auto-merged).                                                                                                                                                                                                                                                                   | `tenant_identity_conflicts`                                                                   |
| **Signal**                                                                                                                                            | **DOMAIN-ONLY** (M1). A vendor-bound discriminated union: `marketing` (must come from HubSpot), `product` (Gainsight PX/CS), `account` (Gainsight CS). Not persisted; not used outside `domain`.                                                                                                                     | `domain/signals.ts`                                                                           |
| **Lead, LeadCandidate**                                                                                                                               | **DOMAIN-ONLY** (M1). LeadCandidate requires a person; its "same opportunity" key is tenant + person + company + product. ADR 0012 decided to replace it with **Account × Product, Person optional** in M11.                                                                                                         | `domain/lead.ts`, `lead-candidate.ts`                                                         |
| Qualification decision, human override                                                                                                                | **DOMAIN-ONLY** (M1). Tenant configuration tables exist (`tenant_qualification_config`, `tenant_policies`, `tenant_lead_source_mappings`); the decision records themselves are not persisted.                                                                                                                        | `domain/qualification.ts`                                                                     |
| SalesOutcome                                                                                                                                          | **DOMAIN-ONLY** (M1). Tied to a Lead.                                                                                                                                                                                                                                                                                | `domain/sales-outcome.ts`                                                                     |
| **Opportunity**                                                                                                                                       | **Not implemented.** It exists only as the LeadCandidate key and the ADR 0012 direction (M11).                                                                                                                                                                                                                       | —                                                                                             |
| **Recommendation, Action, Outcome**                                                                                                                   | **Not implemented.** Roadmap M12–M16; ADR 0012 requires `FACT → DERIVED SIGNAL → OPPORTUNITY → DECISION → ACTION → OUTCOME` as distinct linked records (**DOCUMENTED**).                                                                                                                                             | roadmap                                                                                       |
| Relationship / AccountContext, Goal / Outcome / Metric, Activity / Interaction / Conversation, Price / Offer, Contract, Order, Asset, CustomerProduct | **Not implemented, not designed.** Not in any ADR or design document (verified by search).                                                                                                                                                                                                                           | —                                                                                             |

`tenant_source_relationships` is **not** a business Relationship. It stores source associations
(HubSpot person↔company associations: association type id, category, primary flag). It is source-level data.

## 2. Current database / schema representation (IMPLEMENTED)

- **Canonical tables:** `companies`, `persons`, `tenant_subscriptions`, `tenant_product_models`, `tenant_products`.
- **Reference tables:** `company_external_refs`, `person_external_refs`.
- **Provenance and history:** `tenant_context_changes`, `tenant_eligibility_snapshots`.
- **Source, mapping and profiling ledger:** `tenant_source_connections`, `tenant_source_schema_snapshots`,
  `tenant_source_mapping_versions`, `tenant_source_authority_versions`, `tenant_sync_checkpoints`,
  `tenant_ownership_gaps`, `tenant_source_profile_runs`, `tenant_source_profiles`, `tenant_source_profile_findings`,
  `tenant_source_profile_purges`.
- **Operations and integration:** `tenant_webhook_receipts`, `tenant_dead_letters`, OAuth and credential tables.
- **Configuration:** `tenant_qualification_config`, `tenant_policies`, `tenant_flow_settings`,
  `tenant_lead_source_mappings`.
- **Every tenant table:** has `tenant_id`, forced RLS and tenant-scoped keys, and is enforced by the schema-guard
  test (ADR 0008). The app role is non-privileged.
- **No generic JSON on canonical entities.** JSON appears only in versioned documents and ledgers: product model,
  mapping, authority, schema snapshot, profile, snapshot result, run quality.

## 3. Current extension / custom-field capabilities

- **IMPLEMENTED — none for canonical data.**
  - A source field is either mapped to a **code-catalogue target** or explicitly `ignored` with a reason. The
    catalogue has 13 targets:
    - account: `name`, `domain`;
    - person: `email`, `firstName`, `lastName`, `jobTitle`, `primaryCompany`;
    - subscription: `state`, `startsAt`, `endsAt`, `quantity`, `account`, `product`.
  - A mapping entry `kind: 'attribute'` is **reserved and refused by the validator** "until the attribute registry
    exists".
  - Custom fields, custom objects, arrays, JSON and multi-select values **cannot be stored** as canonical or extension
    data today.
  - The adapter declares natively structured fields (`SourceField.nested: array | object`). The profiler classifies
    their representations (JSON-encoded, delimited, native). Nothing persists them.
- **DOCUMENTED (pre-M8 extension design, never built):**
  - a governed, versioned, immutable per-tenant **attribute registry** (`AttributeDefinition`: key-as-identity,
    `dataType` from a closed scalar set, enum values, sensitivity, `allowedUses`, `notEvidenceOf`, status);
  - registry rules A1–A4, the analogue of the product model's K1–K4 key rules;
  - typed value rows (`tenant_attribute_values`, "Option C") written by the entity's single writer with provenance;
  - a promotion procedure (attribute → canonical field);
  - field annotations with a closed `role` set;
  - deliberate limits: **account only** (person later), **scalar only** (no arrays, objects, money or units), at most
    **200 attributes per tenant**, **no custom objects or relations**. Arrays, lists and relationships were declared
    "neither attribute nor canonical; a later entity or out of scope".

## 4. Current source-reference model (IMPLEMENTED)

- `ExternalRef { system, objectType, id }`. Canonical ids are platform UUIDs; vendor ids are never canonical
  (ADR 0007 §4, ADR 0014).
- `company_external_refs` and `person_external_refs`:
  - primary key `(tenant_id, system, object_type, external_id)`;
  - states `active` / `deleted` / `merged`, plus **`retired`** for companies (M9B migration
    `20261116120000`: `retired_at`, `retired_by_run_id` FK, CHECKs);
  - fields `first_seen_at`, `last_seen_at`, `source_created_at`, `source_updated_at`, `field_hash` and
    `last_change_id`.
- Reference lifecycle is separate from canonical lifecycle. A retired reference still counts for the company's record
  state. A company becomes `inactive` only when every reference is source-`deleted`.
- `system` is a foreign key to `connector_kinds` (catalogue: hubspot, sugar, gainsight_cs, gainsight_px, jev, import,
  chargebee).
- **Subscription lines carry their own source triple** (`source_system`, `source_object_type`, `source_record_id`) in
  the same row. There is no separate reference table for lines.
- **Products have no source-reference table.** Source product ids resolve through the mapping's product reference
  set to tenant product keys.

## 5. Current provenance model (IMPLEMENTED, partial)

- **One table, `tenant_context_changes`**, for companies, persons and subscriptions. Each row records:
  - the change: entity kind and id, change type, **changed field names only (no values)**;
  - the source: source system, object and record, source updated time;
  - the run: cause, checkpoint (run) id, ingest time, correlation id;
  - the producer: adapter and adapter version, `source_connection_id`, `mapping_version`.
- **Not recorded today:**
  - per-field transform provenance (which transform produced a value);
  - the schema-snapshot hash on each change (it is reachable only through the mapping version);
  - derived-versus-source origin;
  - evidence links;
  - derivation algorithm and version for derived facts.
- **Partial or elsewhere:**
  - eligibility snapshots freeze their inputs plus `modelVersion`, `modelHash`, `evaluatorVersion` and `factsHash`;
  - run quality and proof are stored on the checkpoint;
  - profile findings store evidence as codes and counts.
- The `FACT → … → OUTCOME` provenance schema is **DOCUMENTED** as an M10 kickoff requirement (roadmap). It is not
  designed.

## 6. Current mapping / versioning model (IMPLEMENTED)

- **Source schema snapshot:** immutable and hashed. Drift is detected against the snapshot and blocks a run or a
  publish.
- **Mapping version:** immutable per connection.
  - It records base version (optimistic concurrency), content hash, schema snapshot hash, authority version,
    validation warnings, publisher and time.
  - Drafts are files; only published versions are stored.
  - The lifecycle states `validated` / `superseded` / `retired` are **not** modelled: "latest published" is current.
- **Authority version:** immutable. One source per business fact (`account_profile`, `person_profile`,
  `subscription_lines`, `subscription_state`, `subscription_terms`), plus operator `proofAcceptances`.
- **Product model version:** immutable. K1–K4 key rules; mandatory base version.
- **Other component versions:** adapter version, evaluator version and profile document version are code constants.
- **There is no canonical model version.** The canonical schema evolves by migration plus ADR. No record says which
  "canonical version" a tenant, mapping or row conforms to, and there is no migration framework beyond Prisma
  migrations with down-scripts.

## 7. Current lifecycle / history mechanisms (IMPLEMENTED)

- **Canonical entities:** current state plus a change log. `tenant_context_changes` records _that_ a field changed,
  never the old or new value. Subscription rows are overwritten in place; history is reconstructable only from
  provenance (field names), not values.
- **Tombstones, not deletion:**
  - subscriptions use `record_state = deleted` and `deleted_at`;
  - references use `deleted` / `retired` / `merged`;
  - companies and persons use `inactive` / `merged`;
  - ingestion never physically deletes a canonical row.
- **Immutable versioned documents:** product model, mapping, authority, schema snapshot, profiles (chained by
  `previous_profile_id`), eligibility snapshots (frozen evidence).
- **Not implemented:** value history (temporal or bitemporal tables), signal history, opportunity stage history.
  M1's `Lead.stageHistory` is domain-only.

## 8. Current Product / Subscription / Eligibility architecture (IMPLEMENTED, closed milestones)

```
tenant product model vN (immutable) ──defines──► Product keys, relationships, ownership policy
source line ──mapping vN──► SubscriptionObservation ──single writer──► tenant_subscriptions (line identity = source triple)
lines + product model + coverage tier ──pure evaluator──► ownership / eligibility / whitespace (+ frozen snapshot)
```

These guarantees are proven and must be preserved:

- product-key identity (K1–K4);
- line identity: `<subscription>:<item_price>` for Chargebee, the source record id for Sugar;
- `unknown` never counts as owned;
- whitespace only with a sufficient coverage tier, and Chargebee alone yields none;
- reviewed holding domain;
- seen-but-rejected protection;
- one authoritative source per fact;
- `stable_snapshot` requires operator acceptance;
- the full-run completeness proof (count or double enumeration);
- tombstones and retirement only on accepted full runs;
- G4 parent-scoped child reconciliation;
- single writers (static and behavioural tests);
- tenant isolation.

**Price / offer is not modelled.** Chargebee `item_price_id` exists only inside the line key and the product reference
set.

## 9. Concepts already partially present

| Brief concept               | What exists                                                                                                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer / Account          | Company (no hierarchy; `customerStatus` is a single canonical field)                                                                                                                                                                                                                    |
| CustomerProduct             | Ownership is **derived** from lines + product model (not stored) — the closest existing concept                                                                                                                                                                                         |
| Subscription                | Line-level only. No header ("subscription agreement") entity: Chargebee Subscription is a source parent whose lines are reconciled by G4                                                                                                                                                |
| Signal                      | M1 vendor-bound union (domain-only); roadmap M10 generalises it                                                                                                                                                                                                                         |
| Opportunity                 | M1 LeadCandidate (person-required, domain-only); ADR 0012 Account × Product direction                                                                                                                                                                                                   |
| Recommendation / decision   | M1 QualificationDecision + HumanOverride (domain-only); "human override wins" rule                                                                                                                                                                                                      |
| Outcome                     | M1 SalesOutcome (lead-bound, domain-only); ADR 0012 outcome vocabulary for M16                                                                                                                                                                                                          |
| Field / schema intelligence | M9A profiles per run: counts, null/empty ratios, distinct, cardinality, observed types, representations, parse failures, detectors, drift between profiles, findings. **No** per-field `last_seen_at` / `last_populated_at` / `last_value_changed_at`, mapping-status or usage registry |
| Rejected / malformed data   | Rejection rows (Chargebee), `record_rejected` / `seen_but_rejected` counters, ownership gaps, dead letters (M6), profile parse-failure counts. **Raw rejected values are not stored** (privacy design)                                                                                  |
| Extension layer             | Documented attribute registry (§3); `attribute` entry kind reserved                                                                                                                                                                                                                     |
| Promotion rule              | Documented criteria (extension design §1, §4)                                                                                                                                                                                                                                           |
| Connector onboarding path   | Connection → schema snapshot → profiling (advisory suggestions only) → human-confirmed mapping → validate/preview → publish → full sync → incremental (gated) → drift: **IMPLEMENTED** end to end for Sugar/Chargebee                                                                   |

## 10. Architectural gaps relative to the brief

| #   | Gap                                                                                                                                                                         | Severity for v1 candidate |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| G1  | No customer hierarchy (`parent_customer_id`)                                                                                                                                | core design               |
| G2  | No Relationship / AccountContext concept                                                                                                                                    | module design             |
| G3  | No Goal / Outcome / Metric model                                                                                                                                            | module design             |
| G4  | No Activity / Interaction / Conversation model                                                                                                                              | module design             |
| G5  | Signal is vendor-bound (closed `kind` per vendor); no derivation origin/version                                                                                             | core design (M10 input)   |
| G6  | Opportunity is person-required (LeadCandidate); no source-native vs platform-derived distinction                                                                            | core design (M11 input)   |
| G7  | No Recommendation / Action / Outcome records                                                                                                                                | core/module design        |
| G8  | No Price/Offer, Contract, Order, Asset; no subscription header vs line distinction; CustomerProduct only derived                                                            | module design             |
| G9  | No extension storage at all; documented registry is scalar-only, account-only, ≤ 200 attributes — below the brief (custom objects, arrays, JSON, multi-select, 500+ fields) | extension design          |
| G10 | No per-field freshness / population / value-change / usage metadata                                                                                                         | extension/M10 console     |
| G11 | No canonical model version, no tenant adoption record, no canonical migration framework                                                                                     | governance design         |
| G12 | Mapping lifecycle has no `validated` / `superseded` / `retired` states (drafts are files)                                                                                   | governance design         |
| G13 | Provenance lacks value-level history, transform provenance, derived-vs-source origin and evidence links                                                                     | provenance design         |
| G14 | Rejected records keep codes/counts, not raw value + normalized candidate + resolution state                                                                                 | data-quality design       |
| G15 | Products have no source-reference table (resolved via mapping product-reference sets)                                                                                       | review only               |
| G16 | Vendor names in canonical enums (`ExternalSystem` partly generalised via connector kinds; M1 `LeadOrigin`, `ChangeSource`, signal `kind`s)                                  | review only (ADR 0012 §2) |

## 11. Conflicts between the brief and the current implementation or approved documents

| #   | Conflict                                                                                                                                                                                                                                                                            | Proposed handling                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | **Sequence.** The approved M9 plan puts M9E **after** M9C and M9D, as an independent review gate (§13.5) whose evidence is the diff since `375fadb`.                                                                                                                                | The owner's reordering supersedes it. M9E becomes "v1 candidate design". The §13.5 review gate is kept and re-run as the **v1.0 freeze gate** after M9C and M9D. Recorded in a plan revision.                                                                                              |
| C2  | **Extension scope.** The approved extension design says scalar attributes only, account only, ≤ 200 per tenant, and no custom objects or relations ("not an ontology engine"). The brief requires custom objects, custom relationships, arrays, JSON, multi-select and 500+ fields. | M9E must decide explicitly, in an ADR superseding parts of the extension design. Recommendation: keep the governed registry and add typed collection and structured value types plus governed custom object definitions, with limits. Keep "no inference engine / no expression language". |
| C3  | **Naming.** The brief says Customer / Account; the code, tables and ADRs say Company / Account.                                                                                                                                                                                     | A naming decision, not a schema change. Recommendation: canonical name **Account** in the architecture, physical table `companies` unchanged. A rename has a cost and no benefit before the UI exists.                                                                                     |
| C4  | **Signal shape.** The M1 schema hard-binds signal kinds to vendors (marketing ⇒ HubSpot, product ⇒ Gainsight).                                                                                                                                                                      | Domain-only and unused, so it can be replaced without migration. M10 was already scoped to generalise it. M9E specifies the target shape; M10 implements it.                                                                                                                               |
| C5  | **Opportunity.** M1 LeadCandidate requires a person, and ADR 0006 gives "same opportunity" = person + company + product. ADR 0012 decided Account × Product, Person optional, in M11.                                                                                               | M9E specifies the canonical Opportunity consistent with ADR 0012 (source-native and platform-derived types). M11 implements it with its ADR. No change now.                                                                                                                                |
| C6  | **CustomerProduct.** The brief asks whether CustomerProduct is stored. The M7 decision (ADR 0017) is that ownership is **derived, never stored**.                                                                                                                                   | Recommendation: keep derivation as the source of truth. A stored CustomerProduct is allowed only as a non-authoritative projection, or for "owned without subscription" evidence via a distinct source fact. Any change needs explicit migration reasoning (brief §10).                    |
| C7  | **Provenance values.** The brief wants a raw value plus a normalized candidate for rejected records. Current privacy rules store codes and counts only, never values (M9A record-level safety).                                                                                     | Design a governed, tenant-scoped, retention-bounded rejected-value store, with sensitivity gating and the default off for sensitive fields. Needs a privacy decision (tech debt #15).                                                                                                      |
| C8  | **Mapping lifecycle states.** The brief has `draft` / `validated` / `published` / `superseded` / `retired`. Current: published only, with drafts as files.                                                                                                                          | Specify the states as a governance model. Implementation is not needed for the v1 candidate.                                                                                                                                                                                               |

## 12. Proposed M9E work breakdown

M9E is an **architecture milestone**. I propose **no schema or code change by default**. Any implementation would be
listed explicitly and approved separately. Deliverables map to the brief's M9E-A … J.

| Step | Deliverable                                                                                                                                                                                                                                                                                                   | Output file(s)                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| E0   | This discovery report + plan (owner review)                                                                                                                                                                                                                                                                   | `docs/milestones/M09E-canonical-architecture-discovery.md`       |
| E1   | **M9E-A Canonical inventory** — every candidate concept with status (implemented / candidate core / candidate optional / extension-only / rejected-deferred) and rationale                                                                                                                                    | `docs/architecture/canonical-v1/01-inventory.md`                 |
| E2   | **M9E-B Classification** — core / optional modules / extension, each choice justified against the **promotion test** (written first, used for every entity)                                                                                                                                                   | `…/02-classification-and-promotion-rule.md`                      |
| E3   | **M9E-C Entity specifications** — one spec per approved entity: purpose, identity, lifecycle, states, relationships + cardinality matrix, provenance, history (immutable vs projection), source-mapping expectations, required/optional fields, retirement/deletion, tenant isolation, version                | `…/03-entity-specifications.md` (+ relationship matrix)          |
| E4   | **M9E-D Extension framework** — registry evolution (types incl. collection/structured), custom object definitions and records, custom relationships, value storage options and limits, field metadata (freshness / population / value-change / usage / drift kept separate)                                   | `…/04-extension-framework.md`                                    |
| E5   | **M9E-E Source reference and provenance** — unified reference model (accounts, persons, lines, products, extension records), lifecycle (active/retired/deleted/merged, reactivation), reusable provenance and evidence pattern, transform provenance, derived-origin and derivation version                   | `…/05-source-reference-and-provenance.md`                        |
| E6   | **M9E-F Versioning + M9E-G migration framework** — canonical version semantics (additive vs breaking, what does/doesn't bump), entity definition versions, mapping compatibility and lifecycle states, tenant adoption, deprecation window, preview → impact → approval → migrate → verify → rollback → audit | `…/06-versioning-and-migration.md`                               |
| E7   | **Data-quality model** — normalise / transform / hold for review / reject; rejected-record observability; JSON/array/multi-select representation rules                                                                                                                                                        | `…/07-data-quality-and-structured-values.md`                     |
| E8   | **M9E-H Pressure-test matrix** — Salesforce, HubSpot, Sugar, Chargebee, Stripe-like, Gainsight, Staircase AI, Gong, Fireflies, Zoom, Gmail, Calendar, Slack, Zendesk, Freshdesk, CSV, S3, warehouse, custom object: fits directly / optional module / extension / gap / change proposed                       | `…/08-pressure-test-matrix.md`                                   |
| E9   | **Diagrams** (Mermaid, five required) and **M9E-I ADR** (`docs/adr/0025-canonical-architecture-v1-candidate.md`) superseding the conflicting parts of the extension design (C2) and recording C1–C8 decisions                                                                                                 | ADR 0025 + diagrams embedded in the candidate                    |
| E10  | **M9E-J Canonical Architecture v1 Candidate** — one consolidated definition answering the brief's 20 questions explicitly; preserved-guarantees table (§8 above) with how each survives                                                                                                                       | `docs/architecture/canonical-v1/CANDIDATE.md`                    |
| E11  | **Consistency verification** — a docs-only check: every core/module entity has a spec, every pressure-test "gap" has a disposition, every brief question is answered with a section link; `pnpm format:check`                                                                                                 | evidence in the M9E record                                       |
| E12  | **Independent review** (separate subagent, `review-milestone` skill, read-only) → fixes → owner approval → PR → merge → closure                                                                                                                                                                               | `docs/milestones/M09E-canonical-architecture-review.md` (record) |

**Implementation during M9E:** proposed **none**. Possible narrowly scoped candidates, listed only for your decision,
not to be started without approval:

- replacing the unused, vendor-bound M1 `Signal` / `LeadCandidate` domain schemas — **recommended to defer to
  M10/M11**, where they will be implemented with their ADRs;
- a canonical-version marker table — **recommended to defer** until the first breaking change is real.

**Explicitly not changed by M9E:**

- M7/M8/M9A/M9B semantics and schemas;
- the open items, which stay open and are not marked resolved:
  - tech debt #62, #63 and #64;
  - live mutations M09/M10 not run;
  - V6, V9, V10 and V11;
  - Chargebee incremental sync disabled;
  - live Sugar verification pending.

**Decisions requested before E1** (recommended option first):

1. Confirm M9E produces **documentation and design only** (no schema/code), with any later implementation separately
   planned.
2. Confirm the extension direction for C2: **evolve the governed registry** (typed scalars + collections/structured
   values + governed custom object definitions, with limits), superseding the "scalar-only, no custom objects" limits;
   or keep the original limits and push custom objects out of v1.
3. Confirm canonical naming **Account** in the architecture with physical tables unchanged (C3).
4. Confirm the sequencing fix (C1): the M9 plan's §13.5 review gate becomes the **v1.0 freeze gate** after M9C + M9D.
5. Confirm the rejected-value store (C7) is designed in M9E but stays **off/blocked** until the privacy ADR
   (tech debt #15).
