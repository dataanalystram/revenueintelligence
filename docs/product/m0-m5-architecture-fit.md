# M0–M5 against the Revenue Opportunity Intelligence vision

- Status: assessment, 2026-10-01 (after the M5 merge, `aca9c40`). Confirmed
  by the independent product architecture review of planning SHA `c98a300`:
  M0–M5 are compatible with the vision and no preparatory refactor is needed
  before M6 ([ADR 0012](../adr/0012-revenue-opportunity-intelligence-direction.md)).
- Scope: does the completed foundation fit the
  [product charter](revenue-opportunity-intelligence.md)? What needs to
  change, and when?

## Summary

There is **no material architectural conflict**. The foundation reads as
designed for a reusable, multi-tenant, connector-based platform:

- pure canonical domain;
- forced-RLS tenancy;
- vendor-neutral CRM port;
- per-tenant configuration and flow modes;
- auditable decisions with human override.

There is one **domain-model gap** to address when the opportunity model is
built, not before: the canonical centre is a person-required `LeadCandidate`
and a `Lead`, whereas the vision centres on account × product opportunities.
No tables for candidates or leads exist yet, so evolving them later costs
little. **No preparatory refactor is needed before M6.**

## 1. Reusable foundation (keep as is)

| Area                       | What exists                                                                                                                                        | Why it fits                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Runtime (M0)               | API + worker processes, config validation, redacting logs, health, OpenTelemetry/Sentry hooks, Docker, CI, runtime/Docker/fresh-clone verification | product-agnostic plumbing                                           |
| Domain discipline (M1)     | Zod-first immutable entities, pure functions, branded ids, `ExternalRef`, domain-purity rule                                                       | the right shape for a canonical model of any vocabulary             |
| Qualification (M1)         | `QualificationDecision` (provider, version, mode, reasons, signals, input hash), overrides, `resolveEffectiveQualification`                        | matches charter §10 and §15 directly                                |
| Attribution (M1)           | fixed-at-creation origin and channel; tenant mapping of channels                                                                                   | basis for outcome attribution (charter §17)                         |
| Signals (M1)               | marketing / product / account signals with de-duplication keys                                                                                     | a start for the signal model (charter §8)                           |
| Tenancy (M2)               | forced RLS, tenant context, schema guard, non-privileged role, credential references                                                               | foundational for multi-tenant reuse                                 |
| Tenant config (M2)         | product catalogue, product ownership table, field and lead-source mappings, qualification config, SLA/routing/requalification policies, flow modes | already "configuration, not code" for tenant specifics              |
| Coexistence (M2, ADR 0004) | per-flow `off` / `shadow` / `coexist` / `active`                                                                                                   | exactly the Fuelius coexistence requirement; shadow-first actions   |
| CRM port (M4)              | `CrmReader` / `CrmConnector`, `ConnectorError`, boundary rule (`business-code-uses-crm-port`)                                                      | business code never sees HubSpot; Sugar can implement the same port |
| OAuth + secrets (M4)       | encrypted per-tenant grants, single-use state, cross-process refresh lock, SecretProvider                                                          | reusable for any OAuth connector                                    |
| Intake + routing (M5)      | verified raw-body webhooks, account→tenant routing by grant, identifier-only receipts, atomic de-duplication                                       | the pattern for every inbound event source                          |

## 2. HubSpot-specific, appropriately isolated

| Item                                                                            | Where it lives             | Assessment                                         |
| ------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| HubSpot reader, mappers, discovery, OAuth client, webhook signature and payload | `src/modules/hubspot/**`   | isolated behind the port; dependency rule enforced |
| HubSpot app definition and renderer                                             | `hubspot-app/`             | outside the platform code                          |
| Webhook receipts table (`system` column, `hubspot` only today)                  | migration `20260928120000` | already generic by design (system column)          |
| Account routing function (`app_route_oauth_account(system, account)`)           | migration `20260928120000` | generic by system                                  |

## 3. Vendor or Juniper assumptions inside the core (not conflicts yet)

These are acceptable for Juniper, and they are documented. They should be
generalised **when** the milestone that needs them arrives:

| Assumption                                                                      | Where                                                 | When to address                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `LeadCandidate.personId` is required; candidates are person-centric             | `domain/lead-candidate.ts`                            | M11, with its own ADR (direction approved: Account × Product, Person optional) |
| `LeadStage` = HubSpot's default Lead pipeline (`new` … `disqualified`)          | `domain/lead.ts`                                      | when lifecycle mapping is built (tenant stage mapping)                         |
| Vendor names in canonical enums: `ExternalSystem`, `LeadOrigin`, `ChangeSource` | `domain/external-ref.ts`, `attribution.ts`, `lead.ts` | before the first connector outside these four systems, or the second customer  |
| `ProductSignal` must come from Gainsight                                        | `domain/signals.ts`                                   | the signal milestone (source becomes data, not a rule)                         |
| Flow names are vendor pairs (`hubspot_to_sugar_handover`, …)                    | `tenancy/config/flows.ts`                             | the commercial-action milestone (flows as route + destination)                 |
| `SalesOutcomeType` has no `ignored` / `accepted`                                | `domain/sales-outcome.ts`                             | the outcomes milestone                                                         |
| Product ownership has no dependency, exclusion or eligibility concepts          | `domain/product.ts`, `tenant_products`                | the product-intelligence milestone                                             |

## 4. Material conflicts

**None.** Nothing in M0–M5 forces a HubSpot-only lead pipeline:

- the port, tenancy and configuration layers are vendor-neutral;
- every assumption above is local and replaceable;
- no persisted data depends on the lead-centric shape (the only business
  tables are persons, companies, products, ownership and external refs).

## 5. Small preparatory refactors

**None required before M6.** Generalising enums or the candidate shape now,
without a concrete consumer, would be premature abstraction. Each item in §3
lands inside the milestone that first needs it, with its own ADR and tests.

## 6. Leave alone until later

- AI/Jev integration: keep the interface (ADR 0005); build only when Jev's
  contract and access exist.
- Learning from outcomes beyond measurement: only after outcome data exists.
- Webhooks Journal: future resilience option (tech debt #14).
- Key rotation for `PLATFORM_TOKEN_ENCRYPTION_KEY` (tech debt #11): before
  production, not before M6.
- Renaming the repository and product references: a documentation task to
  schedule, with no architectural impact.
