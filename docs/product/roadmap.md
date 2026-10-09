# Roadmap from M6 (approved)

- Status: **approved**, 2026-10-01. The independent product architecture
  review of the proposal (planning SHA `c98a300`) passed with required
  planning changes; those changes are applied here. This document replaces
  the original rows M6–M21 of [docs/milestones/README.md](../milestones/README.md).
- Follows the [product charter](revenue-opportunity-intelligence.md) and the
  [M0–M5 fit assessment](m0-m5-architecture-fit.md). The product decisions
  behind it are recorded in
  [ADR 0012](../adr/0012-revenue-opportunity-intelligence-direction.md).
- Approval of the roadmap is not approval to start a milestone. Each
  milestone still starts only after its own plan is approved.
- **Renumbered on 2026-10-09 (owner decision D4, M10 plan).** A new **M10 —
  Canonical Architecture + Security/Data Governance Implementation** is
  inserted. It absorbs the data-model halves of the former M10 (signal model)
  and M11 (opportunity candidates). Their engine halves and every later
  milestone move up by one. See [Renumbering of 2026-10-09](#renumbering-of-2026-10-09).
  Closed milestone records and accepted ADRs keep the numbering of their date.

## Approved roadmap

```
M6   Event processing and canonical account context

M7   Product catalogue, subscriptions and eligibility

PRE-M8 DISCOVERY GATE
     Subscription Source Discovery

M8   Authoritative subscription-source connector
     read-only, mock first

M9   Remaining system read connector

M10  Canonical Architecture + Security/Data Governance Implementation
     canonical v1 candidate structures, provenance, extensions,
     versioning, module enablement, classification, audit (no engines)

M11  Signal derivation and ingestion engine
     on the M10 Signal model and provenance

M12  Opportunity candidate generation / whitespace / suppression
     on the M10 Opportunity model (Account × Product, Person optional)

M13  Rules-based qualification and evidence
     Jev interface only

M14  Prioritisation + routing
     shadow only
     separate Priority Decision and Routing Decision records

M15  Minimal operator workspace
     review / explanation / override

M16  Commercial actions under approval
     outbox / approval gates / Fuelius coexistence

M17  Outcomes / attribution / measurement
     including expired and superseded

M18  Juniper pilot
     shadow → coexist → active

Later
     Jev/hybrid
     soft-signal AI
     statistical prioritisation
     more sources
     second tenant
```

## How the order was chosen

The order follows the product's dependencies, not the list of integrations:

1. **Data context first**: no opportunity can be trusted until we know who
   the account and person are, across systems, with provenance.
2. **Product intelligence before signals drive anything**: a signal only
   becomes an opportunity once we know what the account owns and is
   eligible for.
3. **Connectors arrive when a capability needs their data**, and read-only
   first. Which connector comes first is decided by discovery, not assumed.
4. **Decisions before actions, shadow before writes**. Every decision
   milestone produces explainable records in shadow mode first. M12–M15
   write nothing to customer systems.
5. **Humans see and correct decisions before the platform acts**, so the
   minimal operator workspace (M15) comes before any write (M16).
6. **Outcomes and measurement before learning.**

Every milestone keeps the M0–M5 discipline:

- inspect → plan → implement → test → verify (fresh clone) → PR →
  independent review;
- mutation proofs for safety checks;
- no customer-system writes without explicit approval.

## Overview

| #     | Milestone                                         | Capability layer         | Core / connector           | External access                |
| ----- | ------------------------------------------------- | ------------------------ | -------------------------- | ------------------------------ |
| M6    | Event processing and canonical account context    | Data context             | core + HubSpot adapter     | HubSpot test account           |
| M7    | Product catalogue, subscriptions and eligibility  | Product intelligence     | core                       | none                           |
| Gate  | Subscription Source Discovery (before M8)         | Data context / product   | discovery only (no code)   | Juniper source schemas         |
| M8    | Authoritative subscription-source connector       | Data context / product   | connector                  | the chosen system (mock first) |
| M9    | Remaining system read connector                   | Data context             | connector                  | the other system (mock first)  |
| M10   | Canonical Architecture + Security/Data Governance | Data foundation          | core                       | Chargebee TEST site (read)     |
| M11   | Signal derivation and ingestion engine            | Signal intelligence      | core + adapters            | as connected                   |
| M12   | Opportunity candidate generation and suppression  | Opportunity intelligence | core                       | none                           |
| M13   | Rules-based qualification and evidence            | Opportunity intelligence | core                       | none                           |
| M14   | Prioritisation and routing (shadow)               | Commercial action        | core                       | none                           |
| M15   | Minimal operator workspace                        | all (human control)      | core (UI)                  | none                           |
| M16   | Commercial actions under approval                 | Commercial action        | connectors, gated          | customer sandbox + approval    |
| M17   | Outcomes, attribution and measurement             | Revenue outcome / learn  | core + adapters            | as connected                   |
| M18   | Juniper pilot: shadow → coexist → active          | all                      | configuration + operations | Juniper accounts + approvals   |
| Later | On demonstrated need                              | Learn / improve          | core                       | per item                       |

The "later" items are:

- the Jev/AI qualification provider (`jev` and `hybrid` modes);
- soft-signal extraction from text (AI);
- statistical prioritisation;
- additional sources (support, communication, warehouse);
- second-tenant onboarding.

## Milestones

### M6 — Event processing and canonical account context

- **Business purpose**: one trustworthy, current view of accounts and people,
  with provenance. Every later answer starts from "who is this, where did the
  data come from, and can we process or replay it safely?". M6 does not yet
  identify revenue opportunities.
- **Technical scope**:
  - a durable, idempotent processing pipeline on **BullMQ + Redis** (approved)
    in the existing worker role, turning M5 webhook receipts into canonical
    `Company` / `Person` context through the read-only `CrmReader`;
  - retry with backoff, a dead-letter path, replay, and correlation ids;
  - tenant-scoped job context;
  - **canonical platform ids with external cross-references**: a HubSpot id
    is never the platform id;
  - a provenance record per fact;
  - reconciliation reads for missed or out-of-order events.
- **Not in M6**: cross-system matching rules for Sugar or Gainsight. They are
  defined only once those schemas are known.
- **Why now**: receipts are already arriving (M5), but nothing consumes them.
  Every later capability needs reliable canonical records.
- **Inputs**: M5 receipts, the M4 port, the M1 domain, M2 tenancy.
- **Outputs**:
  - canonical companies and people kept current, with source history;
  - queue and processing metrics;
  - dead-letter and replay tooling.
- **Out of scope**: products, subscriptions, eligibility, signals as
  decisions, qualification, priority, routing, any write, Sugar or
  Gainsight, UI, Jev, AI.
- **Verification**:
  - idempotency under duplicate and concurrent events;
  - retry and dead-letter handling (mutation-proven);
  - tenant isolation of new tables and jobs (schema guard, RLS);
  - live: a HubSpot change updates the canonical record.

### M7 — Product catalogue, subscriptions and eligibility

- **Business purpose**: know what each account owns, and what it could
  genuinely buy (charter §6–7).
- **Technical scope**:
  - extend the tenant catalogue with product families, dependencies,
    inclusions/replacements, exclusions and eligibility rules, as
    **declarative, versioned per-tenant data** (approved);
  - subscription/ownership records with source and provenance;
  - a pure, deterministic evaluator: `eligibility(account, product)` and
    `whitespace(account)`, each result with the rules that produced it;
  - import from CSV/admin CLI until a real source is connected.
- **Guard rail**: M7 is not a generic rules-engine project. The rule types
  are the ones the charter names, evaluated by small pure functions.
- **Why now**: whitespace is the heart of opportunity intelligence. It is
  pure core logic and needs no external access, so it can be built and
  tested exhaustively.
- **Inputs**: the M6 canonical accounts; the M2 catalogue; Juniper's product
  rules (to be supplied: `tbc` until then; never invented).
- **Outputs**:
  - an explainable eligibility and whitespace answer per account;
  - versioned rule sets.
- **Out of scope**: connectors, signals, candidate creation, any UI beyond
  a CLI.
- **Verification**:
  - property and branch tests of the evaluator (dependencies, exclusions,
    replacements, cycles refused);
  - rule-version audit;
  - mutation proofs of each rule type.

### Pre-M8 discovery gate — Subscription Source Discovery

A short, explicit gate, **not a milestone**. It does not block M6 or M7; it
must be complete before M8 starts.

- **Purpose**: establish from Juniper's real sources and schemas where
  subscription and entitlement truth lives. Sugar, Gainsight, billing or a
  warehouse is **not assumed**.
- **Produces** (recorded in `docs/integrations/`, unknowns stay `tbc`):
  - the authoritative Juniper subscription/entitlement source;
  - whether authority sits in one system or is combined across systems (and
    which system wins for which fact);
  - the basic source schema;
  - account and product identifiers, and how they relate to the HubSpot
    company and the M7 catalogue;
  - the subscription/entitlement shape (dates, quantities, states);
  - ownership and active-state fields;
  - enough to decide which connector is M8 and which is M9.
- **How**: read-only schema/metadata discovery with Juniper-approved access,
  plus confirmation from Juniper's owners of those systems. No connector or
  business code.
- **Exit**: the decision for M8/M9, approved by the owner.

### M8 — Authoritative subscription-source connector (read-only, mock first)

- **Business purpose**: fill M7 with real ownership and account data from the
  source the discovery gate identified.
- **Technical scope**:
  - a read-only connector behind a vendor-neutral port: a realistic mock
    first (built from the discovered schema), then real read-only access
    when credentials exist;
  - Zod validation at the boundary;
  - mapping into canonical companies and subscriptions;
  - cross-references to existing canonical accounts (M6), using matching
    rules defined from the discovered schema.
- **Why now**: whitespace without real ownership data is theory.
- **Inputs**: the discovery gate, M6 (identity, cross-references) and M7
  (ownership model).
- **Outputs**: real subscriptions per account, with provenance.
- **Out of scope**: writes, opportunities, the other system.
- **Verification**:
  - contract tests against the mock;
  - live read-only discovery (when access exists);
  - isolation;
  - zero writes (transport guard, mutation-proven).

### M9 — Remaining system read connector

> **Redefined by approved decision D1 (2026-10).** M9 is now _multi-source
> data quality and subscription validation_
> ([M9 plan](../milestones/M09-multi-source-data-quality-plan.md), phased;
> M9A = [source data profiling foundation](../milestones/M09A-source-data-profiling-plan.md)).
> The scope below (pipeline suppression context, CS/usage context) moves to a
> later milestone that reuses the M9 profiling and source contracts.

- **Business purpose**: the context from the system M8 did not cover, for
  example:
  - Sugar: what is already in the sales pipeline (so it is not re-suggested)
    and, later, outcomes;
  - Gainsight: health, renewals and usage context.
- **Technical scope**: as M8, for the remaining system(s). Gainsight PX usage
  may become its own milestone if access arrives separately.
- **Why now**: suppression ("already being pursued") and CS/usage context
  are needed before candidates are generated.
- **Inputs**: the discovery gate, M6 and M7.
- **Outputs**: open leads and opportunities per account (Sugar), or account
  health and usage aggregates (Gainsight).
- **Out of scope**: writes; using the data for decisions (that is M11–M12).
- **Verification**: as M8.

### M10 — Canonical Architecture + Security/Data Governance Implementation

- **Business purpose**: build the approved
  [Canonical Architecture v1 Candidate](../architecture/canonical-v1/CANDIDATE.md)
  and its security and data-governance foundations, so every later engine
  reads trustworthy, isolated, classified and provenanced data.
- **Technical scope** ([M10 plan](../milestones/M10-canonical-architecture-implementation-plan.md),
  sub-milestones M10A1–M10M):
  - security & governance primitives: actor attribution, write
    authorization, audit events, data classification, retention metadata,
    secret-like value refusal, key-identified encryption;
  - canonical versioning (`0.x`; `1.0` reserved for the freeze), tenant
    adoption, separate module enablement, governed registries, value history,
    mapping lifecycle;
  - generic source references and immutable evidence links, with
    database-enforced polymorphic integrity;
  - Account hierarchy, Person affiliation, extension framework,
    AccountContext, Commercial, vendor-neutral Signal model, Opportunity
    model, Recommendation / Action / ActionOutcome records, Value,
    Engagement, data quality and field intelligence;
  - migration and adoption tooling.
- **Why now**: every engine milestone needs these structures, and security
  is built in rather than retrofitted.
- **Inputs**: M6–M9B, M9E.
- **Outputs**: the canonical data foundation at `0.x`, with the two
  acceptance sections (canonical correctness; security & data governance)
  passed per sub-milestone.
- **Out of scope**: engines (signal derivation, candidate generation,
  recommendation generation, qualification, routing), customer-system
  writes, the v1.0 freeze (needs M9C/M9D), compliance claims.
- **Verification**: per sub-milestone, as the M10 plan sets out (`pnpm
verify`, runtime, Docker, fresh clone, mutation and adversarial proofs).

### M11 — Signal derivation and ingestion engine

- **Business purpose**: combine fragmented signals (charter §8) into one
  stream of explainable facts and indications.
- **Technical scope** (the Signal model, Signal Type Registry, provenance and
  evidence links are built in M10):
  - versioned signal derivation definitions and their evaluator, where the
    source is data rather than a per-vendor rule;
  - adapters that turn HubSpot (forms, lifecycle, lead score, Lead
    changes), Sugar and Gainsight data into canonical facts and signals,
    with evidence and provenance;
  - de-duplication over time;
  - retention rules.
- **Kickoff checkpoint**: the signal and provenance schema was designed in
  M9E and is implemented in M10 (M10A2, M10B, M10G). At kickoff, confirm it
  covers, where applicable:
  - tenant;
  - source system;
  - source record id;
  - source timestamp;
  - ingestion timestamp;
  - signal/fact type;
  - derivation status (observed fact or derived);
  - derivation method/provider;
  - derivation version;
  - evidence reference.

  It must preserve the chain
  `FACT → DERIVED SIGNAL → OPPORTUNITY → DECISION → ACTION → OUTCOME` as
  distinct records linked by reference. These are **not** collapsed into one
  generic signal record.

- **Why now**: candidates need signals, and signals need account and product
  context to be meaningful.
- **Inputs**: M6–M10.
- **Outputs**: per-account and per-person fact and signal timelines.
- **Out of scope**: AI-derived soft signals (later); decisions.
- **Verification**:
  - de-duplication;
  - provenance completeness (every required field present, test-enforced);
  - isolation;
  - adapter contract tests;
  - live HubSpot signals end to end.

### M12 — Opportunity candidate generation, whitespace and suppression

- **Business purpose**: answer "why is this account an opportunity, for which
  product?" (charter §9).
- **Technical scope**:
  - the opportunity model (**Account × Product, Person optional**; approved
    direction) is built in M10 (M10H), replacing `LeadCandidate`; this
    milestone generates candidates on it;
  - candidate creation from signals plus M7 eligibility and whitespace;
  - suppression of duplicates, already-owned, already-pursued and cool-off
    cases (ADR 0006);
  - an evidence trail per candidate;
  - shadow mode only: no writes.
- **Why now**: this is the first point where all prerequisite context exists.
- **Inputs**: M7, M9, M10 and M11.
- **Outputs**: explainable candidates and suppression records.
- **Out of scope**: qualification, priority, routing, writes.
- **Verification**:
  - every branch of the candidate and suppression decisions;
  - an evidence trail on each candidate;
  - mutation proofs on suppression rules.

### M13 — Rules-based qualification and evidence

- **Business purpose**: say how strong each candidate is, with reasons
  (charter §10).
- **Technical scope**:
  - the `QualificationProvider` in `rules` mode with versioned tenant
    rulesets (rules-first, approved);
  - decision records (existing M1 schema);
  - human override;
  - NEEDS_REVIEW queue semantics;
  - the Jev adapter interface only (no Jev implementation).
- **Why now**: qualification needs candidates. The rules provider gives a
  measurable baseline before any AI.
- **Inputs**: M12.
- **Outputs**: qualified candidates (HOT / WARM / COLD / NEEDS_REVIEW) with
  reasons.
- **Out of scope**: Jev/AI, priority, routing, writes.
- **Verification**:
  - ruleset versioning;
  - override precedence (existing pure logic, now persisted);
  - reasons required;
  - mutation proofs.

### M14 — Prioritisation and routing (shadow)

- **Business purpose**: decide what to work first and who should receive it
  (charter §11–12).
- **Technical scope**: one milestone with **two distinct outputs**:
  - **Priority Decision**: a deterministic priority policy (qualification,
    value, timing, SLA), recorded as its own decision record;
  - **Routing Decision**: a routing policy (team, owner, destination system)
    replacing the M2 placeholders, recorded as its own decision record;
  - flow modes generalised from vendor pairs to route + destination;
  - recorded "would route to" decisions (shadow only).
- **Separation rule**: qualification, priority and routing remain separate
  concepts and separate records, each with its own policy version, reasons
  and override. Neither M14 decision overwrites the qualification decision.
- **Why now**: priority and routing consume qualified candidates. Shadow
  output can be compared with today's process.
- **Inputs**: M13.
- **Outputs**: Priority Decision and Routing Decision records (shadow), with
  explanations.
- **Out of scope**: writes, the UI (M15).
- **Verification**: policy tests per branch for each decision type;
  explanation completeness; record separation; isolation.

### M15 — Minimal operator workspace: review, explanation, override

- **Business purpose**: let people:
  - see every opportunity and its full explanation;
  - work the NEEDS_REVIEW queue;
  - override qualification, priority, routing and suppression;
  - compare shadow decisions with reality.

  This comes before the platform acts anywhere (approved: M15 before M16).

- **Technical scope**:
  - a minimal authenticated web UI over the API (tenant-scoped, roles);
  - explanation views;
  - Data Intelligence Console views over the M10 field metadata and
    rejected observations;
  - user identity and roles, through the M10 write-authorization port;
  - override actions (append-only);
  - a shadow-comparison report.
- **Why now**: explainability and human override are core requirements, and
  the pilot needs them. This moves the original M21 earlier, kept minimal.
- **Inputs**: M12–M14.
- **Outputs**: a usable review surface; audit of human decisions.
- **Out of scope**: dashboards or analytics beyond the review needs; design
  polish; writes to customer systems.
- **Verification**:
  - authorisation and tenant isolation tests;
  - override audit;
  - accessibility basics;
  - end-to-end browser tests.

### M16 — Commercial actions under approval

- **Business purpose**: deliver opportunities into the commercial workflow:
  HubSpot Lead, Sugar Lead or Opportunity, or a CS task.
- **Technical scope**:
  - write adapters, explicitly allow-listed per operation;
  - per-tenant, per-flow modes (`shadow` → `coexist` → `active`);
  - human approval gates;
  - an idempotent write outbox;
  - a reconciliation report;
  - coexistence with Fuelius.
- **Why now**: only after decisions are explainable, reviewable and proven in
  shadow. This is the first milestone that may write to a customer system.
- **Inputs**: M14 and M15; the customer's explicit approval for writes.
- **Outputs**: approved actions in sandbox systems, with an audit trail.
- **Out of scope**: production writes without approval; bulk back-fills.
- **Verification**:
  - sandbox-only live tests;
  - idempotency;
  - approval-gate mutation proofs;
  - zero writes in `shadow` and `coexist`.

### M17 — Outcomes, attribution and measurement

- **Business purpose**: know what happened to each opportunity, and measure
  which signals, products, rules and routes convert (charter §17).
- **Technical scope**:
  - ingest outcomes from Sugar and HubSpot and link them to candidates and
    decisions;
  - attribution reporting;
  - conversion metrics.
- **Design-time requirement**: the outcome vocabulary is settled at M17
  design time and must cover, as appropriate:
  - accepted;
  - worked;
  - ignored;
  - rejected / disqualified;
  - converted;
  - won;
  - lost;
  - expired;
  - superseded.

  The existing `SalesOutcomeType` is extended then, not before.

- **Why now**: requires actions (M16) or, in coexist mode, matching (M6/M9).
- **Inputs**: M9, M16.
- **Outputs**: measured conversion by signal, product, rule, route and
  source.
- **Out of scope**: machine learning; automated rule changes.
- **Verification**: correct linkage of outcomes; metric tests; isolation.

### M18 — Juniper pilot: shadow → coexist → active

- **Business purpose**: prove business value on Juniper's real data, safely.
- **Technical scope**:
  - Juniper's real installs;
  - the catalogue and rules (supplied by Juniper);
  - staged flow modes with sign-off at each stage;
  - operations runbooks;
  - production deployment (Azure).
- **Inputs**: everything above; Juniper credentials and approvals.
- **Outputs**:
  - pilot metrics against the business outcomes;
  - a go/no-go for `active`.

## Mapping from the original plan

| Original                    | Where it goes                                               |
| --------------------------- | ----------------------------------------------------------- |
| M6 queue/idempotency        | M6 (with canonical account context)                         |
| M7 Sugar mock + interface   | M8 or M9 (decided by the discovery gate; mock first)        |
| M8 cross-references         | M6                                                          |
| M9 field-mapping engine     | M6/M8/M9 (as each connector needs it)                       |
| M10 Gainsight CS            | M8 or M9 (decided by the discovery gate)                    |
| M11 signal aggregation      | M10 (model) + M11 + M12                                     |
| M12 Jev                     | later (interface only in M13)                               |
| M13 deterministic fallback  | M13 (rules provider is the baseline, not a fallback)        |
| M14 policy/SLA/routing      | M14                                                         |
| M15 simulated end-to-end    | each milestone's shadow mode plus the M15 comparison report |
| M16 real HubSpot validation | M18 (HubSpot already live-proven in M5)                     |
| M17–M18 Sugar read/write    | M8/M9 (read), M16 (write)                                   |
| M19 Sugar → HubSpot sync    | M16/M17                                                     |
| M20 pilot                   | M18                                                         |
| M21 frontend                | M15 (minimal, earlier); polish later                        |

## Renumbering of 2026-10-09

Owner decision D4 in the
[M10 plan](../milestones/M10-canonical-architecture-implementation-plan.md).
Closed milestone records and accepted ADRs keep the numbering of their date;
use this table to read them.

| Before 2026-10-09                                     | From 2026-10-09                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| —                                                     | M10 Canonical Architecture + Security/Data Governance Implementation (new) |
| M10 Signal model and ingestion                        | data model → M10 (M10G); derivation and ingestion engine → M11             |
| M11 Opportunity candidates / whitespace / suppression | data model → M10 (M10H); candidate generation and suppression → M12        |
| M12 Rules-based qualification and evidence            | M13                                                                        |
| M13 Prioritisation + routing                          | M14                                                                        |
| M14 Minimal operator workspace                        | M15 (also user identity/roles and the Data Intelligence Console views)     |
| M15 Commercial actions under approval                 | M16                                                                        |
| M16 Outcomes / attribution / measurement              | M17                                                                        |
| M17 Juniper pilot                                     | M18                                                                        |

"Live mutations M09/M10" in the M9B records are Chargebee live-mutation
labels, not milestones.
