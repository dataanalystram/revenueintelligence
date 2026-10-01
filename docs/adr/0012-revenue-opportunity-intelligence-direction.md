# ADR 0012: Revenue Opportunity Intelligence product direction (after Milestone 5)

- Status: accepted
- Date: 2026-10-01

## Context

After M5 the product was repositioned from a lead-handover integration to
**Revenue Opportunity Intelligence**: a reusable, multi-tenant platform that
turns account, product, usage and engagement signals into explainable revenue
opportunities ([charter](../product/revenue-opportunity-intelligence.md)).

A proposed charter, an M0–M5 fit assessment and a revised roadmap were
reviewed independently (planning SHA `c98a300`). The verdict was **PASS WITH
CHANGES REQUIRED**: the charter was approved, the roadmap was approved with
small planning changes, M0–M5 were found compatible with the vision, and no
preparatory refactor is needed before M6. The owner then approved the
decisions below.

This ADR records the product-level decisions. Detailed technical design
stays in each milestone's own ADR (for example, the M6 queue design).

## Decisions

1. **Opportunity model.** The core future shape is **Account × Product**,
   with Person/Contact optional. The schema evolution away from the
   person-required `LeadCandidate` happens in **M11**, with its own ADR. No
   change before then.
2. **Vendor enums.** Vendor names in canonical enums (`ExternalSystem`,
   `LeadOrigin`, `ChangeSource`, flows, the Gainsight-only `ProductSignal`)
   are generalised only when a real new system or tenant requires it. No
   refactor now.
3. **Subscription authority.** Sugar, Gainsight, billing or a warehouse is
   **not assumed** to own subscriptions and entitlements. A pre-M8
   **Subscription Source Discovery** gate determines it from Juniper's real
   sources and schemas, and decides which connector is M8 and which is M9.
4. **Operator UI before writes.** The minimal operator workspace (M14) comes
   before any commercial action (M15).
5. **Qualification.** Rules-first (`rules` mode). Jev and `hybrid` come later
   behind the existing `QualificationProvider` interface (ADR 0005).
6. **Shadow-first.** M11–M14 write nothing to customer systems. Writes are
   deferred to M15, behind approval gates and per-flow modes (ADR 0004).
7. **Eligibility.** Declarative, versioned, per-tenant rules evaluated by a
   pure, deterministic evaluator. M7 is not a generic rules-engine project.
8. **Queue.** **BullMQ on Redis** for event processing. A PostgreSQL job
   system is not built unless a future requirement shows a concrete need.
   The M6 ADR covers the detailed design (queues, idempotency, retry,
   dead-letter, replay, tenant context).
9. **Repository rename.** Deferred. "Lead Intelligence Platform" names in
   the repository stay until a separate decision.

Required planning changes, applied in the [roadmap](../product/roadmap.md):

- the pre-M8 Subscription Source Discovery gate;
- an M10 kickoff checkpoint for the provenance schema, keeping
  `FACT → DERIVED SIGNAL → OPPORTUNITY → DECISION → ACTION → OUTCOME` as
  distinct records;
- separate Priority Decision and Routing Decision records in M13;
- an M16 outcome vocabulary that includes accepted, worked, ignored,
  rejected/disqualified, converted, won, lost, expired and superseded.

## Consequences

- The charter is the product-level source of truth. Milestone records align
  with it; ADRs own detailed technical decisions.
- Juniper is the first implementation, not the definition of the platform.
- M6 can start once its own implementation plan is approved.
- `bullmq` becomes a dependency in M6 (the platform already runs Redis via
  `ioredis`).
