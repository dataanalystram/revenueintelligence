# Delivery plan

> **M0–M7 are complete** (M6 and M7 with documented non-blocking technical debt). **M8 passed independent review and is merged to `main`** (PR #12; LIVE SUGAR VERIFICATION: PENDING). **M9 is redefined (approved decision D1)** as multi-source data quality and subscription validation; **M9A (source data profiling foundation) is implemented and awaits independent review** — M9B and later phases have not started. From M6 onward the plan follows the **approved
> roadmap** in [docs/product/roadmap.md](../product/roadmap.md), which follows
> the [product charter](../product/revenue-opportunity-intelligence.md) and
> [ADR 0012](../adr/0012-revenue-opportunity-intelligence-direction.md). The
> original M6–M21 rows were replaced on 2026-10-01; the roadmap maps each one
> to its new place. Each milestone starts only after its plan is approved.

We build and test one milestone at a time. We don't start the next milestone
until the current one's tests and Definition of Done pass. Each milestone is
committed separately with its own record in this folder.

| #   | Milestone                                                                                                                                    | Needs external access?                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 0   | Repository / infrastructure foundation                                                                                                       | No                                                   |
| 1   | Canonical domain model                                                                                                                       | No                                                   |
| 2   | Tenants and data isolation (RLS, tenant context, per-tenant configuration)                                                                   | No                                                   |
| 3   | HubSpot developer environment / read connector                                                                                               | HubSpot **developer test account** (we create it)    |
| 4   | HubSpot connector abstraction                                                                                                                | Dev test account                                     |
| 5   | HubSpot webhook receiver                                                                                                                     | Dev test account + public tunnel                     |
| 6   | Event processing and canonical account context                                                                                               | HubSpot test account                                 |
| 7   | Product catalogue, subscriptions and eligibility                                                                                             | No                                                   |
| —   | Pre-M8 gate: Subscription Source Discovery (not a milestone)                                                                                 | Juniper source schemas                               |
| 8   | Authoritative subscription-source connector (read-only, mock first)                                                                          | The chosen system (mock first)                       |
| 9   | Multi-source data quality and subscription validation (D1; phased: M9A profiling foundation, M9B…)                                           | Chargebee test site, files, warehouse (later phases) |
| 9+  | Former M9 scope: remaining-system context (pipeline suppression, CS/usage) — moved later by D1, reuses the M9 profiling and source contracts | The other system (mock first)                        |
| 10  | Signal model and ingestion (provenance schema defined at kickoff)                                                                            | As connected                                         |
| 11  | Opportunity candidates / whitespace / suppression (shadow)                                                                                   | No                                                   |
| 12  | Rules-based qualification and evidence (Jev interface only)                                                                                  | No                                                   |
| 13  | Prioritisation + routing (shadow; separate Priority and Routing Decisions)                                                                   | No                                                   |
| 14  | Minimal operator workspace: review / explanation / override                                                                                  | No                                                   |
| 15  | Commercial actions under approval (outbox, approval gates, Fuelius)                                                                          | Customer sandbox + explicit approval                 |
| 16  | Outcomes / attribution / measurement                                                                                                         | As connected                                         |
| 17  | Juniper pilot: shadow → coexist → active                                                                                                     | Juniper accounts + approvals                         |

Records: [M0](M00-foundation.md) · [M1](M01-canonical-domain-model.md) · [M2](M02-tenancy-data-isolation.md) · [M3](M03-hubspot-test-environment.md) · [M4](M04-hubspot-connector-abstraction.md) · [M5](M05-hubspot-webhooks.md) · [M6](M06-event-processing-canonical-context.md) · [M7](M07-product-catalogue-subscriptions-eligibility.md) · [M8 (merged; live Sugar pending)](M08-generic-source-connector-and-mapping.md) · [M9 plan](M09-multi-source-data-quality-plan.md) · [M9A plan](M09A-source-data-profiling-plan.md) · [M9A implementation record (pending review)](M09A-source-data-profiling.md)

Known non-blocking items: [technical-debt register](../tech-debt.md).
