# Business modules

Each bounded context lives in its own folder and is introduced in the milestone
listed below. Nothing is scaffolded ahead of its milestone.

| Module          | Responsibility                                                       | Milestone |
| --------------- | -------------------------------------------------------------------- | --------- |
| `domain`        | Canonical Lead / Contact / Company / Signal models (no vendor types) | M1        |
| `tenancy`       | Tenant model, tenant context, isolation                              | M2        |
| `hubspot`       | HubSpot connector (OAuth, read/write, webhooks)                      | M3–M5     |
| `sync`          | Queueing, idempotency, retries, orchestration                        | M6        |
| `sugar`         | Sugar CRM connector interface + mock + real implementation           | M7, M17   |
| `crossref`      | External-ID cross-reference (HubSpot ⇄ Sugar ⇄ Gainsight)            | M8        |
| `mapping`       | Configurable field-mapping engine                                    | M9        |
| `gainsight`     | Gainsight CS read-only connector and schema discovery                | M10       |
| `identity`      | Identity resolution across systems                                   | M11       |
| `signals`       | Signal aggregation into LeadCandidate                                | M11       |
| `qualification` | Qualification providers (AI + deterministic fallback)                | M12–M13   |
| `policy`        | Business policy: SLA, routing, lead temperature actions              | M14       |
| `audit`         | Audit trail for outbound writes and qualification decisions          | M6+       |

## Rules (enforced by `.dependency-cruiser.cjs`)

1. A module exposes its public API from `index.ts`. Other modules import only
   that file, never another module's internals.
2. `src/platform` never imports from `src/modules`.
3. Vendor SDKs (e.g. `@hubspot/api-client`) may only be imported inside their
   connector module. Everything else works with canonical domain types.
4. The generated Prisma client may only be imported by `src/platform/database`
   and by `infrastructure/` folders inside modules (repositories).
5. No circular dependencies.
