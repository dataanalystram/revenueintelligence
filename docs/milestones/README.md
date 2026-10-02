# Delivery plan

> **M0–M6 are complete** (M6 with documented non-blocking technical debt). From M6 onward the plan follows the **approved
> roadmap** in [docs/product/roadmap.md](../product/roadmap.md), which follows
> the [product charter](../product/revenue-opportunity-intelligence.md) and
> [ADR 0012](../adr/0012-revenue-opportunity-intelligence-direction.md). The
> original M6–M21 rows were replaced on 2026-10-01; the roadmap maps each one
> to its new place. Each milestone starts only after its plan is approved.

We build and test one milestone at a time. We don't start the next milestone
until the current one's tests and Definition of Done pass. Each milestone is
committed separately with its own record in this folder.

| #   | Milestone                                                                  | Needs external access?                            |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| 0   | Repository / infrastructure foundation                                     | No                                                |
| 1   | Canonical domain model                                                     | No                                                |
| 2   | Tenants and data isolation (RLS, tenant context, per-tenant configuration) | No                                                |
| 3   | HubSpot developer environment / read connector                             | HubSpot **developer test account** (we create it) |
| 4   | HubSpot connector abstraction                                              | Dev test account                                  |
| 5   | HubSpot webhook receiver                                                   | Dev test account + public tunnel                  |
| 6   | Event processing and canonical account context                             | HubSpot test account                              |
| 7   | Product catalogue, subscriptions and eligibility                           | No                                                |
| —   | Pre-M8 gate: Subscription Source Discovery (not a milestone)               | Juniper source schemas                            |
| 8   | Authoritative subscription-source connector (read-only, mock first)        | The chosen system (mock first)                    |
| 9   | Remaining system read connector                                            | The other system (mock first)                     |
| 10  | Signal model and ingestion (provenance schema defined at kickoff)          | As connected                                      |
| 11  | Opportunity candidates / whitespace / suppression (shadow)                 | No                                                |
| 12  | Rules-based qualification and evidence (Jev interface only)                | No                                                |
| 13  | Prioritisation + routing (shadow; separate Priority and Routing Decisions) | No                                                |
| 14  | Minimal operator workspace: review / explanation / override                | No                                                |
| 15  | Commercial actions under approval (outbox, approval gates, Fuelius)        | Customer sandbox + explicit approval              |
| 16  | Outcomes / attribution / measurement                                       | As connected                                      |
| 17  | Juniper pilot: shadow → coexist → active                                   | Juniper accounts + approvals                      |

Records: [M0](M00-foundation.md) · [M1](M01-canonical-domain-model.md) · [M2](M02-tenancy-data-isolation.md) · [M3](M03-hubspot-test-environment.md) · [M4](M04-hubspot-connector-abstraction.md) · [M5](M05-hubspot-webhooks.md) · [M6](M06-event-processing-canonical-context.md) · [M7 (plan, awaiting approval)](M07-product-catalogue-subscriptions-eligibility.md)

Known non-blocking items: [technical-debt register](../tech-debt.md).
