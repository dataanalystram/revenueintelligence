# ADR 0025: Canonical Architecture v1 Candidate — three layers, promotion rule, extension, provenance, versioning (Milestone 9E)

- Status: **Proposed — v1 candidate, approved as the candidate by the M9E final review (E12:
  `PASS — CANONICAL ARCHITECTURE V1 CANDIDATE APPROVED`).** Not accepted as Canonical Model v1.0. Acceptance as v1.0 happens only after
  M9C (file/S3) and M9D (warehouse/table) pressure-test it and the relocated M9 §13.5 freeze gate passes.
- Date: 2026-10-09
- Milestone: M9E (design/documentation only; no schema, table or code changed)
- Supersedes (on acceptance):
  - the narrow extension limits of `docs/architecture/canonical-extension-and-source-mapping.md` §1–§4 (account-only
    scalar attributes, ≤ 200, no custom objects);
  - the vendor-bound M1 Signal (`domain/signals.ts`, `DOMAIN-ONLY`);
  - the person-required M1 LeadCandidate as the opportunity shape (already directed by ADR 0012).
- Keeps: ADR 0007 (pure Zod domain), ADR 0008 (tenant isolation), ADR 0014 (identity, references, provenance), ADR
  0016–0018 (product model, subscriptions, eligibility), ADR 0019–0024 (connectors, mapping, authority, profiling,
  coverage tiers, Chargebee and its governed reference retirement).
- Detail: [Canonical Architecture v1 Candidate](../architecture/canonical-v1/CANDIDATE.md) and its parts E1–E8.

## Context

The platform must become reusable Revenue Opportunity Intelligence across CRM, billing, customer success,
conversation, support, file and warehouse sources without redesigning the business model for each system.

Today's canonical model covers Account (`companies`), Person, Product (versioned model) and Subscription lines, with
derived ownership, eligibility and whitespace. Source references and a field-name provenance log exist. There is no
extension storage, no canonical version, no Signal, Opportunity or Recommendation persistence, and no hierarchy,
context, value, engagement or commercial concepts (M9E discovery report).

## Decision

1. **System ontology ≠ business ontology.**
   - Sources keep their own objects. Discovery, profiling and versioned mapping translate them into canonical business
     nouns.
   - No vendor schema is copied into the canonical model.
   - Vendor identity lives in source references and provenance, never in canonical types.
2. **Three layers.**
   - **Core:** Account (+ hierarchy), Person, Product, Subscription line, Signal, Opportunity, Recommendation.
   - **Optional modules:** Account Context, Value (Goal / Metric), Engagement (Activity, participants, content
     reference, Support case), Commercial (Price/Offer, Contract/Agreement, Entitlement/Asset), Action & Outcome (Action, ActionOutcome).
   - **Extension layer:** governed custom fields (scalar, multi-select/array, JSON), custom objects, custom
     relationships, source attribute capture.
   - **Platform infrastructure:** source references, change records, evidence links, history policy, field
     intelligence, rejected observations, versioning, mapping lifecycle.
   - **Derived views:** ownership, eligibility, whitespace, CustomerProduct, roll-ups.
3. **Promotion rule.** A concept becomes canonical only if it passes P1–P6:
   - P1 reusable meaning;
   - P2 stable identity/lifecycle;
   - P3 cross-system applicability — a **strong default evidence threshold** (three or more systems across two
     categories), not an immutable law: justified exceptions are allowed when P1, P2, P4, P5 and P6 pass, the
     shortfall is explained, additional independent evidence is cited, and the owner approves it in the promoting
     ADR (Recommendation is recorded as such an exception: the platform is its primary producer);
   - P4 capability dependency;
   - P5 vendor-free semantics;
   - P6 the extension layer is insufficient.

   Exposure by a source is never sufficient. Promotion needs an ADR, a version bump and a migration.

4. **Account** is the architecture term; the `companies` table stays.
   - Hierarchy is canonical (`parent_account_id`, acyclic, same tenant, authority fact `account_hierarchy`). Maximum
     depth is a configurable platform guardrail (default 10), not canonical semantics.
   - Sub-account business context is the optional **AccountContext** module, never used for hierarchy.
5. **Reasoning chain as distinct records:** FACT → SIGNAL → OPPORTUNITY → DECISION (recommendation events) → ACTION
   → ACTION OUTCOME → learning, linked by evidence links. Customer business/value outcomes are **Goals** (Value
   module); **ActionOutcome** records what happened to opportunities, recommendations and actions. They are never
   conflated.
   - Signal is vendor-neutral (origin `source_provided` / `deterministic` / `ai_derived` / `human`). Signal types
     live in a governed, versioned **Signal Type Registry** (platform generic + tenant types); adding a type is a
     registry version, never a canonical schema or version change.
   - Opportunity has Account, Account + Product or Context + Product scope, with Person optional. Opportunity
     lines are a vendor-neutral product component of a potential deal (product key, quantity, amount, term), not a
     copied CRM object.
   - Activity is never a signal by itself.
6. **CustomerProduct is a derived view.** Ownership stays derived (ADR 0017). An Entitlement/Asset may later feed the
   derivation under a new evaluator version.
7. **Extension framework.**
   - One immutable, versioned tenant registry with field, object and relationship definitions.
   - Typed storage, with no per-tenant DDL.
   - Limits enforced as **configurable platform guardrails** (not canonical-model constraints), `allowed_uses`,
     `not_evidence_of`, sensitivity.
   - Single writers and provenance.
   - Human-confirmed publish.
   - No expression or inference engine.
8. **Source references and provenance.**
   - One logical reference model for all records, with lifecycle `active` / `retired` / `deleted` / `merged` and
     reactivation without duplication.
   - No inferred deletion outside accepted, proven full runs.
   - One change-record pattern widened with schema snapshot, transforms, origin, derivation, actor and canonical
     version.
   - Evidence links.
   - A per-entity history policy: immutable, projection + value history, or projection + change log.
9. **Versioning.**
   - Canonical model `MAJOR.MINOR`: additive = MINOR, breaking = MAJOR.
   - Extension, mapping, product-model and derivation changes are not canonical versions.
   - A compatibility window of the previous MAJOR.
   - A tenant adoption record.
   - Mapping lifecycle `draft` / `validated` / `published` / `superseded` / `retired`.
10. **Migration framework:** plan → preview (no customer writes) → impact → approval → execution (idempotent,
    resumable, per tenant) → verification → publish → audit.
    - Production schema stays forward-fix. Data rollback uses reverse steps or a pre-migration tenant snapshot.
      Adoption rollback stays within the compatibility window.
11. **Data quality.**
    - Declared dispositions: normalize, transform, hold, reject. The default for anything undeclared is reject.
    - Rejected observations keep these parts separate: source reference, run and mapping, reason code, safe
      diagnostics, normalized candidate (non-sensitive only), raw payload **reference**, and optional raw value.
    - The optional raw value is **disabled** until the privacy decision (tech debt #15).
12. **Human confirmation** stays mandatory for consequential semantics: identity, ownership, holding domains, value
    maps, authority, eligibility use, signal-input use and AI-suggested definitions. AI suggests; it never publishes.

## Consequences

- **New connectors** are adapter + mapping + registry configuration. The pressure test (E8) found no system that
  needs a new core entity.
- **Additive changes the pressure test forced into the candidate:**
  - `parent_account_id`;
  - Person–Account affiliation;
  - Opportunity lines;
  - `agreement_ref` on lines (an opaque source grouping key, distinct from SourceReference and from canonical
    Contract identity) and line → Contract as 0..1 at a time with history;
  - the Support case specification.
- **No implementation in M9E.** Implementation order (updated 2026-10-09 by the roadmap renumbering, owner decision
  D4):
  - the canonical structures, including extension layer, modules, provenance and field intelligence, are built
    in **M10 — Canonical Architecture + Security/Data Governance Implementation** (sub-milestones M10A1–M10M), each
    with its own plan approval and tests;
  - the engines that use them come later: signal derivation (M11), opportunity generation (M12), qualification
    (M13), routing (M14), action execution (M16) and measurement (M17).
- **Proven guarantees from M7–M9B are unchanged:**
  - product key identity;
  - line identity;
  - derived ownership;
  - `unknown` never owned;
  - coverage tiers;
  - `stable_snapshot` acceptance;
  - full-read proof;
  - seen-but-rejected protection;
  - G4;
  - single writers;
  - authority;
  - retirement semantics;
  - tenant isolation.
- **Open items remain open and separate:**
  - tech debt #62, #63, #64;
  - live mutations M09/M10;
  - V6, V9, V10, V11;
  - Chargebee incremental sync disabled;
  - live Sugar verification pending.

## Alternatives considered

- **Universal enterprise schema** (copying Salesforce/Gainsight objects). Rejected: it fails P1/P5, makes every
  tenant carry unused structure, and couples the core to vendors.
- **Everything as extension** (a minimal core plus custom objects). Rejected: platform capabilities (eligibility,
  signals, opportunities) need interpretable, stable nouns.
- **Unrestricted EAV / JSON blob per entity.** Rejected: no type safety, weak provenance, poor queryability, painful
  promotion.
- **Per-tenant DDL columns.** Rejected: schema drift per tenant, migration risk, RLS and schema-guard complexity.
- **Separate canonical objects per communication tool** (`GongCall`, `GmailEmail`). Rejected: fails P1/P3/P5; one
  Activity model covers them.
- **Bitemporal history everywhere.** Deferred: value history on selected fields plus immutable records covers the v1
  needs at much lower cost.
