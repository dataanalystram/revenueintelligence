# Revenue Opportunity Intelligence: product charter

- Status: **approved, current architecture** (2026-10-01). Approved after
  the independent product architecture review of planning SHA `c98a300`;
  the product decisions are recorded in
  [ADR 0012](../adr/0012-revenue-opportunity-intelligence-direction.md).
- Date: 2026-10-01

How this charter relates to other documents:

- It is the **product-level source of truth**: what the platform is, the
  concepts it uses and the rules it follows.
- **Milestone records** (`docs/milestones/`) and the
  [roadmap](roadmap.md) must align with it. A milestone that needs to depart
  from it changes the charter first, with approval.
- **ADRs** (`docs/adr/`) own detailed technical decisions. Where an ADR is
  more specific than the charter, the ADR governs that detail.
- **Juniper is the first implementation, not the definition of the
  platform.** Juniper's systems, products and vocabulary are tenant
  configuration (§19).

This document describes **what** we are building and **why**. It is not an
implementation specification. Technical decisions are made per milestone and
recorded in ADRs.

## 1. Product purpose

**Revenue Opportunity Intelligence** turns customer, prospect, product, usage
and engagement signals into the right revenue opportunities, explains why
each one exists, and routes it to the right commercial team and system.

It is a reusable intelligence platform with connectors at its edges. It is
**not**:

- a HubSpot connector;
- a HubSpot-to-Sugar sync;
- a Gainsight add-on;
- a lead-scoring script;
- an AI summary dashboard.

Those systems are sources of data and destinations for actions.

## 2. Business outcomes

The platform exists to:

1. identify real revenue opportunities earlier;
2. know which customer or prospect should be offered which product;
3. find genuine whitespace across an account's existing products;
4. never recommend a product an account is not eligible for, or already owns;
5. combine signals that today sit fragmented across systems;
6. improve the marketing-to-sales (and customer-success-to-sales) handover;
7. prioritise the opportunities most worth a salesperson's time;
8. explain every opportunity: why it exists, from which evidence;
9. route each opportunity to the correct team and system;
10. learn from won, lost, converted and ignored outcomes;
11. become reusable for customers beyond Juniper.

Every milestone should be traceable to at least one of these outcomes.

## 3. The problem we are solving

At Juniper (the first customer):

- Marketing signals live in HubSpot (forms, lead scores, Leads).
- Sales opportunities and the commercial workflow live in SugarCRM.
- Customer health, adoption and product usage live in Gainsight CS and PX.
- What each customer owns sits in one or more of these, or elsewhere.

Nobody sees the combined picture. Expansion opportunities among existing
customers are missed. Leads are handed over without context, and
salespeople cannot tell why a lead matters, or whether the customer could
even buy the product. Outcomes rarely flow back, so nothing improves.
Today's HubSpot → Sugar handover is partly done by a third party (Fuelius).
The platform must coexist with it first and may later take over parts of it
(ADR 0004).

## 4. Systems and sources

| Role                        | Juniper today                      | Platform view                                                     |
| --------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| Marketing / lead generation | HubSpot                            | a source of people, accounts, engagement and Leads; a destination |
| Sales / commercial workflow | SugarCRM                           | a source of accounts, opportunities and outcomes; a destination   |
| Customer success            | Gainsight CS                       | a source of account health, renewals, CS observations             |
| Product usage               | Gainsight PX                       | a source of usage and adoption signals                            |
| Products and subscriptions  | to be confirmed (pre-M8 discovery) | the source of the catalogue and of what each account owns         |
| Future                      | support, communication, warehouse  | further sources, added as connectors                              |

The roles are configuration, not code. Another customer may use Salesforce
for sales, or have no customer-success platform at all.

## 5. Canonical business concepts

Vendor-neutral concepts at the core. Every connector maps into and out of
these concepts:

| Concept                    | Meaning                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Account (Company)          | an organisation we sell to or serve                                                                        |
| Person (Contact)           | someone at an account                                                                                      |
| Product                    | something the tenant sells, from the tenant's catalogue                                                    |
| Subscription / entitlement | an account's relationship with a product: owned, trial, expired, churned, with dates                       |
| Signal                     | an observed fact or derived indication about an account, person or product                                 |
| Opportunity candidate      | a possible revenue opportunity: account × product (± person), with its triggering signals                  |
| Eligibility                | whether an account may buy a product at all                                                                |
| Dependency / exclusion     | product relationships: requires, includes, replaces, mutually exclusive                                    |
| Whitespace                 | products an account is eligible for, does not own and is not already pursuing                              |
| Qualification              | how strong a candidate is (HOT / WARM / COLD / NEEDS_REVIEW)                                               |
| Priority                   | the order in which qualified opportunities should be worked                                                |
| Recommendation             | the proposed next commercial action for an opportunity                                                     |
| Route / destination        | which team, owner and system should receive it                                                             |
| Commercial outcome         | what happened: accepted, worked, ignored, rejected/disqualified, converted, won, lost, expired, superseded |
| Evidence / reason          | the signals, rules, versions and data behind every decision                                                |
| Human override             | a person's decision that replaces an automated one                                                         |
| Feedback                   | outcomes linked back to the decisions that produced them                                                   |

The tenant's lifecycle vocabulary (prospect, MQL, SQL, CSQL, expansion
candidate, lead, opportunity, won, lost, disqualified) is mapped onto these
concepts per tenant. Canonical concepts do not adopt one customer's
terminology.

## 6. Product catalogue and subscriptions

The platform must know:

- what products exist (catalogue, product families, active or retired);
- what each account owns, since when, and in what state (subscription,
  trial, expired, churned);
- where each fact came from (source system, time, provenance).

Each tenant has its own catalogue, as tenant configuration. Ownership facts
come from the tenant's source of truth for subscriptions.

## 7. Whitespace and eligibility

Whitespace is **not** "the customer does not have product X". It is:

> products the account is **eligible** for, that it does **not already own**
> (or own something that includes or replaces), that are **not excluded**
> by what it owns, whose **prerequisites** are met, and that are **not
> already being pursued** (an open lead or opportunity).

This requires explicit, declarative, versioned rules per tenant:

- dependencies;
- inclusions and replacements;
- mutual exclusions;
- segment, region and size eligibility;
- cool-off periods after disqualification.

The rules must be deterministic and explainable: every "eligible" or "not
eligible" must name the rule that produced it.

## 8. Signal model

Two kinds of signals, both stored with source, time, subject and evidence:

| Hard / structured (facts)              | Soft / derived (indications)  |
| -------------------------------------- | ----------------------------- |
| form submission, demo request          | engagement trend              |
| product-usage threshold crossed        | customer-success observations |
| renewal approaching, contract state    | communication intent          |
| subscription or entitlement change     | relationship strength         |
| opportunity created or closed          | support themes                |
| role or title, account characteristics | expansion interest            |

Structured facts are the reliable source of truth. Soft signals carry their
derivation (rule or model, version, confidence) and are never presented as
facts.

Each stage of the chain is its own record, linked to the one before it, and
never collapsed into one generic signal record:

```
FACT → DERIVED SIGNAL → OPPORTUNITY → DECISION → ACTION → OUTCOME
```

Where applicable, facts and signals record: tenant, source system, source
record id, source timestamp, ingestion timestamp, signal/fact type,
derivation status, derivation method/provider, derivation version and an
evidence reference. The schema was designed in M9E (Canonical Architecture v1 Candidate) and is
implemented in M10.

## 9. Opportunity intelligence

For every opportunity the platform should be able to answer:

- Why is this account an opportunity?
- Which product is relevant?
- What signal triggered it?
- Is the account eligible? Does it already own the product?
- What evidence supports the recommendation?
- How strong is it?
- What should happen next, and who should receive it?
- What happened afterwards? Did it convert?
- What should the platform learn from that?

An opportunity candidate is created only when the signals and the
eligibility/whitespace check allow it. Duplicates and recently disqualified
equivalents are suppressed (ADR 0006).

## 10. Qualification model

- One `QualificationProvider` interface with interchangeable providers
  (ADR 0005). Modes are per tenant:
  - `rules`: deterministic rulesets;
  - `jev`: an external AI service;
  - `hybrid`: rules first, the model for undecided cases.
- Outcomes: HOT / WARM / COLD / NEEDS_REVIEW. When the model is unavailable,
  the outcome is NEEDS_REVIEW, never a silent guess.
- Every decision records:
  - provider and version;
  - mode;
  - outcome and confidence;
  - reasons and the signals behind them;
  - an input snapshot hash;
  - time.
- The platform must not bind permanently to one scoring engine.

## 11. Prioritisation

Qualification says how strong an opportunity is. Priority says what to work
first. Priority combines qualification, potential value, timing (renewals,
SLA) and capacity. It is deterministic, per-tenant policy, and explainable.

Qualification, priority and routing are separate concepts with separate
decision records (Qualification Decision, Priority Decision, Routing
Decision), each with its own policy version, reasons and override.

## 12. Routing and commercial action

- Routing policy (per tenant, deterministic) decides the team, owner and
  destination system: for example HubSpot Lead, Sugar Lead or Opportunity,
  or a CS task.
- Actions follow per-tenant flow modes (ADR 0004):
  - `off`: nothing runs;
  - `shadow`: record what would be done;
  - `coexist`: another integration writes, we only observe and match;
  - `active`: we write.
- Writes to customer systems need explicit approval per tenant and flow.
  Shadow mode comes first.

## 13. Explainability

Explainability is a core requirement, not a later feature. Every opportunity,
qualification, priority and route must be traceable to:

- source signals and source systems;
- rules and models used, with versions;
- confidence and reasons;
- timestamps;
- human overrides;
- routing decisions;
- the eventual outcome.

## 14. Auditability and provenance

- Every fact carries where it came from and when (system, object, id, time).
- Decisions are append-only records.
- External identifiers are never canonical identifiers; cross-references link
  them (ExternalRef).
- Tenant isolation is enforced by the database (forced RLS, ADR 0008), not
  by convention. Secrets go only through the SecretProvider.

## 15. Human override

A human decision wins over an automated one: qualification, eligibility
exceptions, routing and suppression. It stays in force until a human changes
it or hands control back. Later automated results are recorded and flagged if
they disagree, never silently applied (ADR 0005, `resolveEffectiveQualification`).

## 16. AI versus deterministic responsibilities

| Deterministic (rules, structured data)                         | AI-assisted (where it demonstrably adds value)                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| identity matching rules, eligibility, dependencies, exclusions | extracting soft signals from unstructured text                     |
| whitespace, suppression, cool-off                              | qualifying complex combinations the rules cannot decide (`hybrid`) |
| SLA, priority policy, routing, flow modes                      | summarising evidence for a salesperson                             |
| every write to a customer system                               | suggesting rule improvements from outcomes (later)                 |

AI never performs an irreversible commercial action directly. AI output is
recorded with its model version and confidence, and is reviewable.

## 17. Outcome and feedback loop

```
signals → candidate opportunity → eligibility → qualification → priority
        → routing/action → sales/customer outcome → feedback → better decisions
```

Start deterministic and measurable: conversion and win rates by signal,
product, rule and route. Introduce statistical or AI learning only where it
solves a demonstrated problem.

## 18. Multi-tenant and reusable architecture principles

These continue from M0–M5:

- modular monolith first; no microservices or Kubernetes without
  demonstrated need;
- multi-tenant from the database up (forced RLS, tenant-scoped keys);
- a vendor-neutral canonical model in a pure domain;
- connectors and adapters at the boundaries; vendor payloads never cross
  them;
- read-only ingestion before actions; shadow before active;
- deterministic business rules where possible; human override;
- security by default; cloud-portable containers; Azure preferred for
  deployment.

The core never assumes:

- HubSpot is always the marketing CRM;
- SugarCRM is always the sales CRM;
- Gainsight is always the CS platform;
- Juniper's product names exist;
- Juniper's lifecycle stages exist.

## 19. Juniper-specific configuration versus platform core

| Platform core (code)                                                       | Juniper configuration (data, per tenant)                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| canonical concepts and their invariants                                    | product catalogue, families, dependencies, exclusions, eligibility rules |
| eligibility/whitespace evaluator, suppression, qualification interface     | qualification mode, rulesets, thresholds                                 |
| priority and routing evaluators, flow modes, audit and override            | SLA minutes, routing teams/owners, flow modes per integration            |
| connector framework, cross-references, provenance                          | which systems are enabled, field mappings, lead-source mappings, stages  |
| HubSpot / Sugar / Gainsight connectors (reusable by any tenant using them) | the tenant's accounts, portal ids, credentials (SecretProvider)          |

## 20. What M0–M5 already provide

| Milestone | Foundation                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | runtime: API and worker processes, config, logging with redaction, health, telemetry, Docker, CI, verification scripts                                      |
| M1        | pure canonical domain: Person, Company, product ownership, Signals, LeadCandidate, Lead, qualification decisions and overrides, attribution, sales outcomes |
| M2        | tenancy: forced RLS, tenant context, per-tenant configuration (products, field and lead-source mappings, qualification, policies, flows), credentials       |
| M3        | HubSpot read connector and discovery against a real test account                                                                                            |
| M4        | the vendor-neutral `CrmReader` port; OAuth with encrypted per-tenant token storage and a cross-process refresh lock                                         |
| M5        | a real HubSpot app install; verified, tenant-routed, de-duplicated webhook receipts; live-proven reads and webhooks; zero CRM writes                        |

The fit assessment is in [m0-m5-architecture-fit.md](m0-m5-architecture-fit.md).

## 21. Architectural decisions and open questions

The questions raised with the proposal were decided on 2026-10-01
([ADR 0012](../adr/0012-revenue-opportunity-intelligence-direction.md)):

| Question                          | Decision                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Source of truth for subscriptions | not assumed; decided by the pre-M8 Subscription Source Discovery gate                          |
| Opportunity-centric domain        | Account × Product, Person optional; model built in M10 (M10H), generation in M12               |
| Vendor names in canonical enums   | generalise only when a real new system or tenant requires it                                   |
| Eligibility rules representation  | declarative, versioned per-tenant rules; pure deterministic evaluator; no generic rules engine |
| Event processing infrastructure   | BullMQ on Redis; no PostgreSQL job system without a concrete need                              |
| Jev                               | rules-first; Jev/hybrid later behind the existing provider interface                           |
| Operator interface timing         | minimal workspace in M15, before any write in M16                                              |
| Repository naming                 | deferred                                                                                       |

Still open (each answered in the milestone that needs it):

1. **Identity resolution across systems**: matching rules for Sugar,
   Gainsight and other sources (and who resolves conflicts) are defined only
   once their schemas are known. M6 uses canonical platform ids with external
   cross-references.
2. **Jev availability and contract**: needed before the Jev/hybrid work.
3. **Juniper's product rules** (dependencies, exclusions, eligibility):
   supplied by Juniper; `tbc` until then.

## 22. Future capability map

```
BUSINESS OUTCOMES
      ↓
DATA CONTEXT            accounts, people, cross-system identity, provenance
      ↓
PRODUCT INTELLIGENCE    catalogue, subscriptions, dependencies, eligibility, whitespace
      ↓
SIGNAL INTELLIGENCE     hard + soft signals from marketing, sales, CS, usage
      ↓
OPPORTUNITY INTELLIGENCE candidates, suppression, qualification, priority, evidence
      ↓
COMMERCIAL ACTION       routing, shadow/coexist/active actions, human review
      ↓
REVENUE OUTCOME         outcomes from sales and CS systems, attribution
      ↓
LEARN / IMPROVE         measured conversion by signal/product/rule/route; later, models
```

These layers describe capabilities, not milestones. The approved milestone
order is in [roadmap.md](roadmap.md).
