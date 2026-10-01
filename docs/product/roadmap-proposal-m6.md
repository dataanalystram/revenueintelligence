# Proposed roadmap from M6 (for approval)

- Status: **proposal**. It replaces rows M6–M21 of
  [docs/milestones/README.md](../milestones/README.md) once approved.
  Nothing starts before approval.
- Follows the [product charter](revenue-opportunity-intelligence.md) and the
  [M0–M5 fit assessment](m0-m5-architecture-fit.md).

## How the order was chosen

The order follows the product's dependencies, not the list of integrations:

1. **Data context first**: no opportunity can be trusted until we know who
   the account and person are, across systems, with provenance.
2. **Product intelligence before signals drive anything**: a signal only
   becomes an opportunity once we know what the account owns and is
   eligible for.
3. **Connectors arrive when a capability needs their data**, and read-only
   first.
4. **Decisions before actions, shadow before writes**. Every decision
   milestone produces explainable records in shadow mode first.
5. **Humans see and correct decisions before the platform acts**, so a
   minimal operator surface comes before any write.
6. **Outcomes and measurement before learning.**

Every milestone keeps the M0–M5 discipline:

- inspect → plan → implement → test → verify (fresh clone) → PR →
  independent review;
- mutation proofs for safety checks;
- no customer-system writes without explicit approval.

## Overview

| #   | Milestone                                              | Capability layer         | Core / connector           | External access                |
| --- | ------------------------------------------------------ | ------------------------ | -------------------------- | ------------------------------ |
| M6  | Event processing and canonical account context         | Data context             | core + HubSpot adapter     | HubSpot test account           |
| M7  | Product catalogue, subscriptions and eligibility rules | Product intelligence     | core                       | none                           |
| M8  | Subscription source connector (Sugar or Gainsight CS)  | Data context / product   | connector                  | the chosen system (mock first) |
| M9  | The other system: read connector                       | Data context             | connector                  | the other system (mock first)  |
| M10 | Signal model and ingestion                             | Signal intelligence      | core + adapters            | as connected                   |
| M11 | Opportunity candidates, whitespace and suppression     | Opportunity intelligence | core                       | none                           |
| M12 | Qualification (rules provider) and evidence            | Opportunity intelligence | core                       | none                           |
| M13 | Prioritisation and routing (shadow)                    | Commercial action        | core                       | none                           |
| M14 | Operator workspace: review, explain, override          | all (human control)      | core (UI)                  | none                           |
| M15 | Commercial actions under approval                      | Commercial action        | connectors, gated          | customer sandbox + approval    |
| M16 | Outcomes, attribution and measurement                  | Revenue outcome / learn  | core + adapters            | as connected                   |
| M17 | Juniper pilot: shadow → coexist → active               | all                      | configuration + operations | Juniper accounts + approvals   |
| —   | Later, on demonstrated need                            | Learn / improve          | core                       | per item                       |

The "later" items are:

- the Jev/AI qualification provider (`hybrid`);
- soft-signal extraction from text;
- statistical prioritisation;
- additional sources (support, communication, warehouse);
- second-tenant onboarding.

M8 and M9 depend on open question 1: which system holds Juniper's products
and subscriptions. That system goes first.

## Milestones

### M6 — Event processing and canonical account context

- **Business purpose**: one trustworthy, current view of accounts and people
  across systems, with provenance. Every later answer starts from "who is
  this?".
- **Technical scope**:
  - a durable, idempotent processing pipeline (worker) that turns M5 webhook
    receipts into canonical `Company` / `Person` updates through the
    read-only `CrmReader`, with retry, a dead-letter path and correlation ids;
  - external-reference cross-references;
  - first identity-resolution rules (email, domain, cross-references) with
    conflict flags;
  - a provenance record per fact;
  - scheduled reconciliation reads for missed events.
- **Why now**: receipts are already arriving (M5), but nothing consumes them.
  Every later capability needs reliable canonical records.
- **Inputs**: M5 receipts, the M4 port, the M1 domain, M2 tenancy.
- **Outputs**:
  - canonical companies and people kept current, with source history;
  - queue metrics;
  - identity-conflict reports.
- **Out of scope**: products, signals as decisions, qualification, any
  write, Sugar or Gainsight.
- **Verification**:
  - idempotency under duplicate and concurrent events;
  - retry and dead-letter handling (mutation-proven);
  - tenant isolation of new tables (schema guard, RLS);
  - live: a HubSpot change updates the canonical record.
- **Decision needed**: the queue technology (open question 6).

### M7 — Product catalogue, subscriptions and eligibility rules

- **Business purpose**: know what each account owns, and what it could
  genuinely buy (charter §6–7).
- **Technical scope**:
  - extend the tenant catalogue with product families, dependencies,
    inclusions/replacements, exclusions and eligibility rules, as
    declarative, versioned tenant data;
  - subscription/ownership records with source and provenance;
  - a pure, deterministic evaluator: `eligibility(account, product)` and
    `whitespace(account)`, each result with the rules that produced it;
  - import from CSV/admin CLI until a real source is connected.
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
- **Decision needed**: the rules representation (open question 5).

### M8 — Subscription source connector (Sugar or Gainsight CS, whichever owns subscriptions)

- **Business purpose**: fill M7 with real ownership and account data.
- **Technical scope**:
  - a read-only connector behind a vendor-neutral port: a realistic mock
    first, then real read-only discovery when credentials exist;
  - Zod validation at the boundary;
  - mapping into canonical companies and subscriptions;
  - cross-references to HubSpot accounts.
- **Why now**: whitespace without real ownership data is theory.
- **Inputs**: M6 (identity, cross-references) and M7 (ownership model).
- **Outputs**: real subscriptions per account, with provenance.
- **Out of scope**: writes, opportunities, the other system.
- **Verification**:
  - contract tests against the mock;
  - live read-only discovery (when access exists);
  - isolation;
  - zero writes (transport guard, mutation-proven).

### M9 — The other system: read connector (Sugar or Gainsight CS/PX)

- **Business purpose**:
  - Sugar: what is already in the sales pipeline (so it is not re-suggested)
    and, later, outcomes;
  - Gainsight: health, renewals and usage context.
- **Technical scope**: as M8, for the remaining system(s). Gainsight PX usage
  may become its own milestone if access arrives separately.
- **Why now**: suppression ("already being pursued") and CS/usage context
  are needed before candidates are generated.
- **Inputs**: M6 and M7.
- **Outputs**: open leads and opportunities per account (Sugar), or account
  health and usage aggregates (Gainsight).
- **Out of scope**: writes; using the data for decisions (that is M10–M11).
- **Verification**: as M8.

### M10 — Signal model and ingestion

- **Business purpose**: combine fragmented signals (charter §8) into one
  stream of explainable facts and indications.
- **Technical scope**:
  - generalise the M1 signal model to hard and soft signals, where the
    source is data rather than a per-vendor rule;
  - adapters that turn HubSpot (forms, lifecycle, lead score, Lead
    changes), Sugar and Gainsight data into canonical signals, with
    evidence and provenance;
  - de-duplication;
  - retention rules.
- **Why now**: candidates need signals, and signals need account and product
  context to be meaningful.
- **Inputs**: M6–M9.
- **Outputs**: per-account and per-person signal timelines.
- **Out of scope**: AI-derived soft signals (later); decisions.
- **Verification**:
  - de-duplication;
  - provenance completeness;
  - isolation;
  - adapter contract tests;
  - live HubSpot signals end to end.

### M11 — Opportunity candidates, whitespace and suppression

- **Business purpose**: answer "why is this account an opportunity, for which
  product?" (charter §9).
- **Technical scope**:
  - an opportunity-candidate model (account × product, person optional;
    ADR proposed: evolve `LeadCandidate`);
  - candidate creation from signals plus M7 eligibility and whitespace;
  - suppression of duplicates, already-owned, already-pursued and cool-off
    cases (ADR 0006);
  - an evidence trail per candidate;
  - shadow mode only.
- **Why now**: this is the first point where all prerequisite context exists.
- **Inputs**: M7, M9 and M10.
- **Outputs**: explainable candidates and suppression records.
- **Out of scope**: qualification, priority, routing, writes.
- **Verification**:
  - every branch of the candidate and suppression decisions;
  - an evidence trail on each candidate;
  - mutation proofs on suppression rules.

### M12 — Qualification (rules provider) and evidence

- **Business purpose**: say how strong each candidate is, with reasons
  (charter §10).
- **Technical scope**:
  - the `QualificationProvider` in `rules` mode with versioned tenant
    rulesets;
  - decision records (existing M1 schema);
  - human override;
  - NEEDS_REVIEW queue semantics;
  - the Jev adapter interface stubbed only.
- **Why now**: qualification needs candidates. The rules provider gives a
  measurable baseline before any AI.
- **Inputs**: M11.
- **Outputs**: qualified candidates (HOT / WARM / COLD / NEEDS_REVIEW) with
  reasons.
- **Out of scope**: Jev/AI, priority, routing, writes.
- **Verification**:
  - ruleset versioning;
  - override precedence (existing pure logic, now persisted);
  - reasons required;
  - mutation proofs.

### M13 — Prioritisation and routing (shadow)

- **Business purpose**: decide what to work first and who should receive it
  (charter §11–12).
- **Technical scope**:
  - a deterministic priority policy (qualification, value, timing, SLA);
  - routing policy (team, owner, destination system), replacing the M2
    placeholders;
  - flow modes generalised from vendor pairs to route + destination;
  - recorded "would route to" decisions (shadow).
- **Why now**: priority and routing consume qualified candidates. Shadow
  output can be compared with today's process.
- **Inputs**: M12.
- **Outputs**: prioritised, routed opportunities (shadow), with explanations.
- **Out of scope**: writes, the UI (M14).
- **Verification**: policy tests per branch; explanation completeness;
  isolation.

### M14 — Operator workspace: review, explain, override

- **Business purpose**: let people:
  - see every opportunity and its full explanation;
  - work the NEEDS_REVIEW queue;
  - override qualification, routing and suppression;
  - compare shadow decisions with reality.

  This comes before the platform acts anywhere.

- **Technical scope**:
  - a minimal authenticated web UI over the API (tenant-scoped, roles);
  - explanation views;
  - override actions (append-only);
  - a shadow-comparison report.
- **Why now**: explainability and human override are core requirements, and
  the pilot needs them. This moves the original M21 earlier, kept minimal.
- **Inputs**: M11–M13.
- **Outputs**: a usable review surface; audit of human decisions.
- **Out of scope**: dashboards or analytics beyond the review needs; design
  polish.
- **Verification**:
  - authorisation and tenant isolation tests;
  - override audit;
  - accessibility basics;
  - end-to-end browser tests.

### M15 — Commercial actions under approval

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
  shadow.
- **Inputs**: M13 and M14; the customer's explicit approval for writes.
- **Outputs**: approved actions in sandbox systems, with an audit trail.
- **Out of scope**: production writes without approval; bulk back-fills.
- **Verification**:
  - sandbox-only live tests;
  - idempotency;
  - approval-gate mutation proofs;
  - zero writes in `shadow` and `coexist`.

### M16 — Outcomes, attribution and measurement

- **Business purpose**: know what happened to each opportunity, and measure
  which signals, products, rules and routes convert (charter §17).
- **Technical scope**:
  - ingest outcomes from Sugar and HubSpot (accepted, worked, converted,
    won, lost, ignored, disqualified) and link them to candidates and
    decisions;
  - attribution reporting;
  - conversion metrics.
- **Why now**: requires actions (M15) or, in coexist mode, matching (M6/M9).
- **Inputs**: M9, M15.
- **Outputs**: measured conversion by signal, product, rule, route and
  source.
- **Out of scope**: machine learning; automated rule changes.
- **Verification**: correct linkage of outcomes; metric tests; isolation.

### M17 — Juniper pilot: shadow → coexist → active

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
| M7 Sugar mock + interface   | M8 or M9 (mock first)                                       |
| M8 cross-references         | M6                                                          |
| M9 field-mapping engine     | M6/M8/M9 (as each connector needs it)                       |
| M10 Gainsight CS            | M8 or M9                                                    |
| M11 signal aggregation      | M10 + M11                                                   |
| M12 Jev                     | later (interface stubbed in M12)                            |
| M13 deterministic fallback  | M12 (rules provider is the baseline, not a fallback)        |
| M14 policy/SLA/routing      | M13                                                         |
| M15 simulated end-to-end    | each milestone's shadow mode plus the M14 comparison report |
| M16 real HubSpot validation | M17 (HubSpot already live-proven in M5)                     |
| M17–M18 Sugar read/write    | M8/M9 (read), M15 (write)                                   |
| M19 Sugar → HubSpot sync    | M15/M16                                                     |
| M20 pilot                   | M17                                                         |
| M21 frontend                | M14 (minimal, earlier); polish later                        |
