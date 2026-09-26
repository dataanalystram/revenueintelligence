# ADR 0007 — Canonical domain model: immutable data, Zod schemas, pure functions

- Status: Accepted (Milestone 1)
- Date: 2026-09-26

## Context

Every module (connectors, qualification, policy, sync, audit, the future UI)
must speak one vocabulary that is independent of HubSpot, Sugar and Gainsight.
Domain objects cross process boundaries: they are serialised into BullMQ jobs,
stored as JSON snapshots for qualification inputs, and returned by the API.

## Decision

1. **Zod schemas are the single source of truth.** TypeScript types are
   inferred from them, so the runtime validation and the static types cannot
   drift apart. Every construction or deserialisation goes through `parse`,
   and invariants live in the schema (`refine` / `superRefine`).
2. **Entities are immutable plain data** (frozen by `.readonly()`), not
   classes. They serialise to JSON and back without custom mappers; this is
   tested for every entity.
3. **Behaviour is pure functions** that return new values
   (`applyStageChange`, `resolveEffectiveQualification`, `markConverted`, …).
   Expected business outcomes are returned as discriminated unions (`applied`
   / `unchanged` / `stale`). `DomainError` is reserved for programming errors,
   such as acting on a closed candidate.
4. **Branded UUID identifiers** per entity. External IDs are never canonical;
   they are `ExternalRef { system, objectType, id }`.
5. **The domain is pure.** It may import only itself, `zod` and `node:crypto`.
   A dependency-cruiser rule (`domain-is-pure`) fails CI otherwise.
6. **Tenant-specific vocabularies are codes, not enums.** Product keys,
   disqualification reasons and reason codes are validated slugs whose allowed
   values come from tenant configuration (M2/M9). Values that the requirements
   confirm are canonical enums: stages, temperatures, origins, channels.
7. **Persistence is separate.** M2 introduces tenant-scoped tables and
   repositories that map to and from these types. The domain has no knowledge
   of Prisma.

## Notable rules encoded

| Rule                                                                                                                                 | Where                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| External systems are authoritative for Sales activity. Stage changes are never rejected; irregularities come back as warnings        | `applyStageChange`                     |
| Out-of-order events (retries, polling) are `stale` and cannot roll a Lead back                                                       | `applyStageChange`                     |
| Every stage entry is timestamped; the first and latest entry dates can be derived                                                    | `dateEnteredStage`, `lastEnteredStage` |
| Source attribution is fixed at creation; which channels an origin may produce is validated                                           | `SourceAttributionSchema`              |
| An active human override wins; later automated results are recorded, never applied, and flagged if they disagree; a human wins a tie | `resolveEffectiveQualification`        |
| Overrides record the previous value and the decision they replaced                                                                   | `createOverride`                       |
| A decision must give ≥ 1 reason; rules / Jev / hybrid mode must match the provider kind                                              | `QualificationDecisionSchema`          |
| Duplicate signal deliveries share a de-duplication key                                                                               | `signalDeduplicationKey`               |
| "Same opportunity" = tenant + person + company + product                                                                             | `equivalenceKey`                       |

## Alternatives considered

- **Class-based entities with private state.** Rejected: they need mappers
  for every queue, JSON and DB hop, and a mutation API that makes history
  harder to reason about.
- **Plain TypeScript interfaces with separate validators.** Rejected: types
  and validation drift apart.
