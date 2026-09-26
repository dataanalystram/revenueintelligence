# Milestone 1 — Canonical domain model

- Status: **Complete — approved**
- Date: 2026-09-26
- Branch / PR: `claude/blissful-mendel-urbh4r` —
  [PR #1](https://github.com/laxmanprasadsomaraju/Garethtasktest/pull/1)

## Goal

Define the vendor-neutral vocabulary that every later module uses, with its
invariants and core business rules as pure, tested functions. The HubSpot,
Sugar and Gainsight native structures stay out of it. There is **no
persistence** in this milestone; tenant-scoped storage arrives in M2.

## Delivered (`apps/api/src/modules/domain`)

| File                       | Contents                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `shared/ids.ts`            | Branded UUIDs for every entity + `CorrelationId`; `newId()`                                                                    |
| `shared/time.ts`           | `InstantSchema`: accepts a Date or an ISO string with an offset (rejects ambiguous local times)                                |
| `shared/codes.ts`          | Tenant-configurable code slugs; labels                                                                                         |
| `external-ref.ts`          | `ExternalRef {system, objectType, id}` for HubSpot / Sugar / Gainsight CS / PX; idempotent linking                             |
| `email.ts`                 | Normalised, validated email addresses                                                                                          |
| `person.ts`                | **Person**, with buying roles (e.g. decision maker)                                                                            |
| `company.ts`, `product.ts` | **Company**, customer status, **product ownership** (tenant product keys)                                                      |
| `attribution.ts`           | **Source attribution**: origin × channel, validated combinations; `isIntelligenceSourced`                                      |
| `signals.ts`               | **MarketingSignal** (HubSpot), **ProductSignal** (Gainsight PX), **AccountSignal** (Gainsight CS); de-duplication key          |
| `lead-candidate.ts`        | **LeadCandidate** lifecycle (open → needs_review → converted / suppressed / discarded); suppression reasons; equivalence key   |
| `lead.ts`                  | **Lead**: stage machine with a timestamped history, out-of-order protection, disqualified reason, lead type, fixed attribution |
| `qualification.ts`         | **QualificationDecision**, **HumanOverride**, `resolveEffectiveQualification`, `createOverride`                                |
| `sales-outcome.ts`         | **SalesOutcome** (qualified / disqualified / opportunity / won / lost), money in minor units                                   |

Also added:

- a `domain-is-pure` dependency-cruiser rule
- deterministic test fixtures (`test/fixtures/domain.ts`)
- ADR 0007
- ADRs 0002 (updated), 0003 (updated), 0004, 0005 and 0006, recording the
  post-M0 architecture decisions

## How the review decisions are reflected

| Decision                                                                                | In the model                                                                                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qualification is pluggable (rules / Jev / hybrid)                                       | `QualificationMode`, `ProviderInfo {kind, name, version}`; mode ↔ provider validation                                                               |
| Every decision is stored with its provenance                                            | Decision holds tenant, subject, provider + version, outcome, confidence, reasons + signal ids, input snapshot ref + hash, timestamp, correlation id |
| Humans take precedence; nothing is silently overwritten                                 | Overrides are append-only `set` / `release`; the effective value is derived; later AI results are surfaced as `conflictingAutomatedDecision`        |
| Qualification ≠ policy                                                                  | Outcomes stop at HOT / WARM / COLD / NEEDS_REVIEW; there are no SLA or routing fields in qualification types                                        |
| HubSpot owns marketing-sourced Leads; the platform owns intelligence Leads after checks | Candidate lifecycle with `suppressed` + reasons (`duplicate_open_lead`, `recently_disqualified`, …); `equivalenceKey`; `MARKETING_CHANNELS`         |
| One Contact → many Leads                                                                | A Lead is per qualifying event, independent of other Leads for the same person                                                                      |
| True origin kept                                                                        | `SourceAttribution` is required on candidates and Leads; origin/channel validation                                                                  |
| Traceability                                                                            | `correlationId` on signals, candidates, decisions and Leads                                                                                         |
| Multi-tenancy                                                                           | `tenantId` on every entity; resolution refuses histories that mix tenants                                                                           |
| Don't invent unconfirmed fields                                                         | Lead type excludes the unconfirmed "Attempting"; reasons and products are tenant codes; no Sugar field names anywhere                               |

## Definition of Done

| #   | Criterion                                                                                                                                                         | Result                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Canonical entities for Person, Company, LeadCandidate, Lead, MarketingSignal, ProductSignal, QualificationDecision, SalesOutcome (+ AccountSignal, HumanOverride) | ✅                                                                                                                                           |
| 2   | Runtime validation of every entity with explicit invariants                                                                                                       | ✅ Zod schemas; 60+ negative cases                                                                                                           |
| 3   | Core rules implemented as pure functions and unit-tested, including error paths                                                                                   | ✅ Stage machine, candidate lifecycle, override resolution                                                                                   |
| 4   | Idempotency / duplicate-delivery behaviour in the model                                                                                                           | ✅ Repeated signals, stage events, refs and final transitions are no-ops; stale events are ignored                                           |
| 5   | Serialisation-safe (queues)                                                                                                                                       | ✅ Every entity round-trips through JSON unchanged (journey test)                                                                            |
| 6   | Domain is framework- and vendor-free, enforced in CI                                                                                                              | ✅ `domain-is-pure` rule; shown to fail on a temporary `@nestjs/common` import                                                               |
| 7   | Tests demonstrably catch regressions                                                                                                                              | ✅ 4 deliberate mutations (AI beats human, no stale check, PX claims demo channel, tie goes to AI): each failed the suite, then was reverted |
| 8   | Full verification suite passes                                                                                                                                    | ✅ See below                                                                                                                                 |
| 9   | Architecture decisions documented                                                                                                                                 | ✅ ADRs 0002–0007, architecture.md                                                                                                           |

### Test evidence (final run)

```
pnpm verify
  prettier --check       All matched files use Prettier code style!
  eslint                 0 problems
  tsc --noEmit           0 errors
  depcruise              no dependency violations found
  vitest (unit)          Test Files 17 passed · Tests 213 passed   (144 new in M1)
  vitest (integration)   Test Files 2 passed  · Tests 12 passed
```

Domain module coverage: **100% lines, 100% functions, 99.6% statements,
96.9% branches**.

### Test inventory (M1)

- **Shared** (17): ids, instants (ambiguous local times rejected), codes, labels.
- **External refs** (7): keys, validation, duplicates, idempotent linking.
- **Person / Company** (22): normalisation, roles, product ownership, 9 invalid cases, immutability.
- **Attribution / Signals** (23): origin × channel matrix, three signal kinds, 10 invalid signals, dedup key per tenant.
- **LeadCandidate** (17): lifecycle, idempotent final transitions, 5 closed-candidate refusals, 6 invariant violations, equivalence key.
- **Lead** (21): creation, full journey with stage dates, stage skipping, stale events, duplicate events, reopening, reason correction, missing reason warning, re-entry, immutability, 8 invariant violations.
- **Qualification** (25): decision provenance, 8 invalid decisions, resolution (none, automated, needs_review, override wins, later AI never applied, conflict flagging, override chain, release, tie-break, order independence, tenant/subject mixing), override creation rules.
- **SalesOutcome** (9): won with value, disqualified with reason, 7 invalid cases.
- **Journey** (1): Gainsight PX signal → candidate → AI decision → human override → Lead → Sugar stages → won deal; one correlation id; JSON round-trips.

## Open points for later milestones (not blocking)

- **Lead type "Attempting"**: waiting on Juniper to confirm what it means
  before it is added (mapping config can translate in the meantime).
- **Disqualification reason list, product keys, "Recent conversion" →
  channel mapping**: tenant configuration (M2 / M9); values come from Juniper
  discovery.
- **Requalification windows and thresholds**: tenant policy (M14); the
  decision function is built in M11 on top of `equivalenceKey` and the Lead
  stages.
