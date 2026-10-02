# Business modules

Each bounded context lives in its own folder and is introduced in the milestone
listed below. Nothing is scaffolded ahead of its milestone.

| Module          | Responsibility                                                                                 | Milestone |
| --------------- | ---------------------------------------------------------------------------------------------- | --------- |
| `domain`        | Canonical Lead / Contact / Company / Signal models (no vendor types)                           | M1        |
| `tenancy`       | ✅ Tenant registry, TenantContext, TenantDatabase (RLS), per-tenant config and credential refs | M2        |
| `hubspot`       | ✅ Read-only connector and discovery (M3); OAuth, abstraction (M4); webhooks (M5)              | M3–M5     |
| `crm`           | ✅ Vendor-neutral CRM ports (reader, receipt source, receipts listener)                        | M4–M6     |
| `context`       | ✅ Event processing (BullMQ), canonical account/person context, references, provenance         | M6        |
| `products`      | ✅ Product model versions, subscriptions (single writer, CSV import), eligibility, whitespace  | M7        |
| `sugar`         | Sugar CRM connector interface + mock + real implementation                                     | M7, M17   |
| `crossref`      | External-ID cross-reference (HubSpot ⇄ Sugar ⇄ Gainsight)                                      | M8        |
| `mapping`       | Configurable field-mapping engine                                                              | M9        |
| `gainsight`     | Gainsight CS read-only connector and schema discovery                                          | M10       |
| `identity`      | ✅ Person / Company persistence (M2); identity resolution (M11)                                | M2, M11   |
| `signals`       | Signal aggregation into LeadCandidate                                                          | M11       |
| `qualification` | Qualification providers (AI + deterministic fallback)                                          | M12–M13   |
| `policy`        | Business policy: SLA, routing, lead temperature actions                                        | M14       |
| `audit`         | Audit trail for outbound writes and qualification decisions                                    | M6+       |

## Rules (enforced by `.dependency-cruiser.cjs`)

1. A module exposes its public API from `index.ts`. Other modules import only
   that file, never another module's internals.
2. `src/platform` never imports from `src/modules`.
3. Vendor SDKs (e.g. `@hubspot/api-client`) may only be imported inside their
   connector module. Everything else works with canonical domain types.
4. The generated Prisma client may only be imported by `src/platform/database`
   and by `infrastructure/` folders inside modules (repositories).
5. No circular dependencies.
6. `domain` is pure: it imports only itself, `zod` and `node:crypto`.
7. Only `tenancy/infrastructure` may import the root `PrismaService`. Every
   other module reaches tenant data through `TenantDatabase.transaction(ctx, tx => …)`,
   and its repositories take the `TenantTransaction` (ADR 0008).
