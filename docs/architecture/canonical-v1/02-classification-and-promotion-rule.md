# Canonical Architecture v1 Candidate — E2: Classification and promotion rule (M9E-B)

Part of the [Canonical Architecture v1 Candidate](CANDIDATE.md). Status: **candidate for review**.

## 1. Business semantic promotion rule (written first; applied to every concept)

A concept is **canonical** (Core or Module) only if it passes **all six** tests. Otherwise it stays in the extension
layer (or source-specific / rejected). The rule replaces the decision criteria of the pre-M8 extension design
(`docs/architecture/canonical-extension-and-source-mapping.md` §1) and keeps its spirit.

| Test                             | Question                                                                                                                                       | Evidence required                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| P1 Reusable business meaning     | Does the concept mean the same thing to most tenants (same meaning, not just same label)?                                                      | Written definition; two tenants' interpretations agree         |
| P2 Stable identity and lifecycle | Does each instance have an identity independent of any one source, and a lifecycle the platform must track?                                    | Identity rule; state model                                     |
| P3 Cross-system applicability    | Do at least **three** independent source systems (two categories) expose it, in compatible semantics?                                          | Pressure-test matrix rows (E8)                                 |
| P4 Capability dependency         | Does a reusable platform capability (eligibility, signals, opportunities, recommendations, routing, outcomes) need to interpret it in code?    | Named capability and the rule that reads it                    |
| P5 Clear semantics               | Can its fields, states and relationships be specified without vendor vocabulary?                                                               | Spec without vendor terms (`item_price`, `rli`, vendor states) |
| P6 Extension insufficient        | Would the extension layer (custom field / custom object) lose something essential (identity, lifecycle, platform logic, cross-tenant meaning)? | Stated loss                                                    |

Additional rules:

- **Core vs Module.** A canonical concept is **Core** when every tenant and every v1 capability needs it. It is a
  **Module** when it is reusable but only some tenants or capabilities need it. A module is always optional: a tenant
  that does not enable it works normally, and core logic never requires module data.
- **Promotion is governed.** It needs an ADR, a canonical version bump (E6) and a migration plan. A concept that
  starts as a custom object/field in several tenants is promoted with a mechanical value migration (E4 §promotion).
- **Not by exposure.** A source exposing an object is never sufficient (brief §22).
  `customer.custom_favourite_colour` fails P1, P3, P4 → extension.
- **Derived views are not entities.** Anything computable from canonical facts plus versioned rules (ownership,
  whitespace, roll-ups, health status) stays derived. Snapshots freeze evidence when a decision depends on it.

## 2. Classification (final proposal for the v1 candidate)

### Core (always available)

| Concept                            | P1  | P2                       | P3                                                                                  | P4                                  | P5  | P6  | Why core (and not module/extension)                                                                                            |
| ---------------------------------- | --- | ------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------ |
| Account (+ `parent_account_id`)    | ✔   | ✔                        | ✔ (every CRM, billing, CS, support)                                                 | ✔ (all)                             | ✔   | ✔   | Every capability is account-scoped; hierarchy needed for roll-ups. `IMPLEMENTED TODAY` (hierarchy `PROPOSED FOR V1 CANDIDATE`) |
| Person                             | ✔   | ✔                        | ✔                                                                                   | ✔ (signals, opportunities, routing) | ✔   | ✔   | Contacts, champions, participants. `IMPLEMENTED TODAY`                                                                         |
| Product                            | ✔   | ✔ (tenant key)           | ✔                                                                                   | ✔ (eligibility, whitespace)         | ✔   | ✔   | `IMPLEMENTED TODAY` (versioned product model)                                                                                  |
| Subscription (line)                | ✔   | ✔ (source line identity) | ✔ (Chargebee, Stripe, Sugar, Salesforce assets/contracts, files, warehouse)         | ✔ (ownership)                       | ✔   | ✔   | Ownership truth. `IMPLEMENTED TODAY`                                                                                           |
| Signal                             | ✔   | ✔                        | ✔                                                                                   | ✔ (opportunities, recommendations)  | ✔   | ✔   | Replaces the vendor-bound M1 schema. `PROPOSED FOR V1 CANDIDATE`                                                               |
| Opportunity (+ optional lines)     | ✔   | ✔                        | ✔ (Salesforce, HubSpot, Sugar; platform-derived)                                    | ✔                                   | ✔   | ✔   | `PROPOSED FOR V1 CANDIDATE`                                                                                                    |
| Recommendation (+ decision events) | ✔   | ✔                        | n/a (platform-generated; Gainsight CTAs, Salesforce tasks are its source analogues) | ✔ (core product output)             | ✔   | ✔   | The platform's reason to exist; P3 applies to source analogues. `PROPOSED FOR V1 CANDIDATE`                                    |

Platform (cross-cutting, core infrastructure, not business nouns): Source reference, Provenance / change record,
Evidence link, value history policy, field intelligence, rejected observation, canonical version and tenant adoption,
mapping lifecycle, the existing versioned registries.

Derived (never stored as truth): ownership, eligibility, whitespace, **CustomerProduct view**, hierarchy roll-ups,
health status (when computed from metrics).

### Optional modules

| Module               | Concepts                                                        | Promotion test summary                                                                                                                                                                                                                                                      | Why a module, not core                                                                    |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Account Context**  | AccountContext (+ context membership)                           | P1 ✔ (sub-account business context), P2 ✔, P3 ✔ (Gainsight Relationship, Salesforce account teams / workspaces, product-region contracts in billing, warehouse dimensions), P4 ✔ (scope for signals, opportunities, goals), P5 ✔, P6 ✔ (needs identity + many associations) | Many tenants manage at account level only                                                 |
| **Value**            | Goal, MetricDefinition, MetricObservation                       | P1 ✔, P2 ✔ (goal lifecycle; observation immutable), P3 ✔ (Gainsight success plans/scorecards, Staircase, product analytics, warehouse metrics, spreadsheets), P4 ✔ (value-realisation signals), P5 ✔, P6 ✔ (time series and targets)                                        | Not every tenant tracks goals/metrics                                                     |
| **Engagement**       | Activity, Activity participant, content reference, Support case | Activity: P3 ✔✔ (Gong, Fireflies, Zoom, Gmail, Calendar, Slack, Staircase, CRM tasks, support). Support case: P3 ✔ (Zendesk, Freshdesk, Salesforce Case, HubSpot Ticket), P4 ✔ (support escalation signals)                                                                 | Only tenants connecting engagement systems need it                                        |
| **Commercial**       | Price/Offer, Contract/Agreement, Entitlement/Asset              | Price: P3 ✔ (Chargebee, Stripe, Salesforce), P4 ✔ (value, ARR, upgrade path). Contract: P3 ✔ (Salesforce, CLM, billing headers), P4 ✔ (renewal). Entitlement: P3 ✔ (Salesforce Asset, licence systems), P4 ✔ (ownership without subscription)                               | Lines + product model already cover v1 ownership; value/renewal capabilities are optional |
| **Action & Outcome** | Action, Outcome                                                 | P1 ✔, P2 ✔, P4 ✔ (M15 actions, M16 measurement) — specified now so the reasoning chain is complete                                                                                                                                                                          | Implemented with M15/M16                                                                  |

### Extension (tenant data, governed; never changes canonical schema)

- custom field definitions and values: scalar, enum, multi-select, array, JSON / structured;
- custom object definitions and records;
- custom relationships (custom ↔ canonical, custom ↔ custom);
- source-specific attribute capture;
- examples that stay extension: favourite colour, school type, region code (until promoted), contract tier, order,
  invoice summaries, NPS free text, any vendor-only object.

### Rejected / superseded

- **BusinessOutcome as an entity:** folded into Goal.
- **Health as an entity:** it is a metric observation or signal.
- **Conversation as an entity:** it is an Activity with content.
- **Lead / LeadCandidate:** superseded by Opportunity + Recommendation + Action.
- **Source-specific canonical objects** (`GongCall`, `FirefliesMeeting`, `StaircaseSignal`, `GmailEmailCanonical`):
  rejected; they fail P1, P3 and P5.

### Deferred

- **Order:** stays an extension until promoted.
- **Internal user / team:** reference shape reserved; M13/M14.
- **Segment:** M14.
- **Campaign:** M16.
- **Invoice / payment:** excluded for sensitivity.
- **Multi-currency FX:** money is stored with its currency; no conversion.
