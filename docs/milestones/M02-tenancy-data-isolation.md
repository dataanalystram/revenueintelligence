# Milestone 2 — Tenants and data isolation

- Status: **Complete — awaiting review**
- Date: 2026-09-26
- Branch: `claude/blissful-mendel-urbh4r` (restarted from `main` after PR #1 merged)

## Goal

Every persistent customer-owned object, configuration item, credential
reference and piece of integration state belongs to exactly one tenant, and
application code cannot read or modify another tenant's data, either by
accident or through a missing `WHERE` clause. Juniper is tenant #1. No
HubSpot, Sugar or Gainsight connectors are built in this milestone.

## Design (see [ADR 0008](../adr/0008-tenant-isolation.md))

Three independent layers:

1. **PostgreSQL row-level security.** Forced on every table. A
   transaction-local `app.current_tenant` is set by `TenantDatabase`. The
   application runs as a non-privileged `lip_app` member and refuses to start
   otherwise.
2. **Mandatory tenant context by construction.** `TenantContext` is issued only
   by `TenantContextService`, and forgeries are rejected at runtime.
   `TenantDatabase.transaction(ctx, tx => …)` is the only way into tenant
   data. Repositories accept only the `TenantTransaction`, and a handle is
   invalid once its transaction ends.
3. **Relational and CI guards.**
   - composite `(tenant_id, id)` foreign keys, immutable `tenant_id`, and
     tenant-scoped unique keys
   - a database-enforced credential-key prefix
   - a dependency-cruiser rule: only `tenancy/infrastructure` may import the
     root `PrismaService`
   - a schema-guard test that fails CI if any table breaks these rules

**Explicit parameters over AsyncLocalStorage:** visible in signatures,
testable, and they cannot carry the wrong tenant across queue jobs or async
fan-out.

## Delivered

### Database (`prisma/schema.prisma`, migration `20260926120000_tenancy_and_identity`)

| Table                                                    | Purpose                                                                                                                           | Key constraints                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `tenants`                                                | Registry (platform level)                                                                                                         | slug `[a-z][a-z0-9]{1,39}` unique and immutable; status check; RLS: own tenant only inside a tenant tx, read-only there |
| `tenant_integrations`                                    | Access (`disabled`/`read_only`/`read_write`) and non-secret settings per system (hubspot, sugar, gainsight_cs, gainsight_px, jev) | PK `(tenant_id, system)`; settings must be a JSON object                                                                |
| `tenant_flow_settings`                                   | Flow modes `off`/`shadow`/`coexist`/`active` (Fuelius coexistence or replacement)                                                 | PK `(tenant_id, flow)`                                                                                                  |
| `tenant_credential_refs`                                 | References to secrets, never values                                                                                               | `secret_key` must start with `tenant.<own slug>.` (CHECK plus composite FK to the tenant's id and slug)                 |
| `tenant_qualification_config`                            | Mode `rules`/`jev`/`hybrid`, ruleset version, Jev confidence floor; versioned                                                     | one row per tenant                                                                                                      |
| `tenant_products`                                        | Product catalogue                                                                                                                 | PK `(tenant_id, key)`                                                                                                   |
| `tenant_field_mappings`                                  | Canonical ↔ external field mappings with `tbc`/`proposed`/`confirmed` status                                                      | unique per `(tenant, system, object, entity, field)`; CHECK: `tbc` ⇔ no external field                                  |
| `tenant_lead_source_mappings`                            | Source values → canonical channels (e.g. "Recent conversion" contains "Demo")                                                     | unique per `(tenant, system, property, match, value)`                                                                   |
| `tenant_policies`                                        | SLA (typed), routing and requalification (placeholders); versioned                                                                | PK `(tenant_id, kind)`                                                                                                  |
| `companies`, `company_products`, `company_external_refs` | Canonical companies, product ownership (FK to the tenant's own catalogue), external IDs                                           | composite FKs; external ID unique per tenant                                                                            |
| `persons`, `person_external_refs`                        | Canonical people, external IDs                                                                                                    | email unique per tenant; composite FK to the tenant's own company                                                       |

The migration also covers CHECK constraints on every enumerated value,
immutability triggers, the `app_current_tenant()` function, the RLS policies,
the `lip_app` role and its grants (no access to `_prisma_migrations`), and
default privileges.

### Code

| Area                     | Files                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenancy (pure)           | `modules/tenancy/tenant.ts`, `tenant-context.ts`, `errors.ts`, `config/*` (integrations, flows + coexistence rules, credentials, qualification, products, field mappings, lead source mappings, policies, templates)                                                         |
| Tenancy (application)    | `TenantContextService`, `TenantRegistryService` (atomic provisioning with safe defaults, lifecycle), `TenantConfigService` (validated, cross-checked config), `TenantCredentialsService` (register / resolve through `SecretProvider`)                                       |
| Tenancy (infrastructure) | `TenantDatabase` (tenant transactions, RLS binding, status re-check), `tenantClient(tx)`, config and registry repositories, DB error translation                                                                                                                             |
| Identity                 | `PersonRepository` / `CompanyRepository` interfaces and Prisma implementations (tenant-checked saves, external refs, product ownership)                                                                                                                                      |
| Platform                 | `DatabaseRoleGuard` (refuses superuser, `BYPASSRLS`, non-member and unmigrated), readiness includes it; `DATABASE_POOL_MAX`, `DATABASE_TRANSACTION_TIMEOUT_MS`, `DATABASE_ALLOW_PRIVILEGED_ROLE` (dev only; rejected in production); `MIGRATION_DATABASE_URL` for migrations |
| Operations               | `tenant:provision` CLI; `config/tenant-templates/juniper.json` (brief values only; TBC kept TBC); compose creates the dev app role; runtime image ships templates; `docs/operations/database-roles.md`                                                                       |
| Boundaries               | `root-database-client-only-in-tenancy`, `tenant-context-issued-only-by-tenancy`                                                                                                                                                                                              |

### Safe defaults

A newly provisioned tenant has:

- every integration `disabled` and every flow `off`
- rules-only qualification and no credentials

Templates cannot set access levels, flows or credentials. Enabling writes is
always a separate, validated step. A flow cannot be enabled without the
integration access it needs, and access cannot be reduced while a flow
depends on it.

## Required tests → evidence

| Requirement                                      | Tests                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant A cannot read B's records                 | `isolation`: repository reads; raw SQL inside A's transaction; lookups by email and external ref; company lookups                                                                                                                     |
| … cannot update B's records                      | `isolation`: save with B's id fails and B is untouched; tenant-mismatch refusal; raw UPDATE affects 0 rows; row cannot move tenant (trigger); cross-tenant INSERT rejected by RLS                                                     |
| … cannot delete B's records                      | `isolation`: repository delete → not found; raw DELETE affects 0 rows; config and company deletes scoped                                                                                                                              |
| Identical external IDs across tenants            | `isolation`: same HubSpot contact id and Sugar account id in two tenants                                                                                                                                                              |
| Tenant-scoped unique constraints                 | `isolation`: external ID, email and product key unique per tenant only; `migrations` schema guard: every unique index includes `tenant_id` (or a global uuid `id`)                                                                    |
| Credentials/config not resolvable across tenants | `isolation`: B cannot resolve without its own reference; DB CHECK refuses a reference to another tenant's secret, even with B's slug; unit: exhaustive env-variable collision check                                                   |
| Qualification mode isolated                      | `isolation`: B → hybrid, A stays rules; `concurrency`: parallel updates in different tenants                                                                                                                                          |
| Field mappings isolated                          | `isolation`: B's mappings invisible to A                                                                                                                                                                                              |
| Product catalogues isolated                      | `isolation`: same key in both tenants; a company cannot own another tenant's product                                                                                                                                                  |
| Invalid or missing context fails safely          | `isolation`: forged, prototype-spoofed and missing contexts; unknown and malformed tenants; handle reuse after commit; suspension effective immediately; no tenant set → nothing visible, writes rejected; unit: `TenantContext`      |
| Transactions preserve isolation                  | `isolation`: rollback of all writes; the tenant setting never leaks to pooled connections; rows stored with the transaction's tenant (verified as owner)                                                                              |
| Concurrent tenants don't interfere               | `concurrency`: 6 tenants × 15 parallel write/read transactions; 60 interleaved transactions on a pool **proved** to be ≤ 2 connections; failures in one tenant don't disturb others; optimistic-concurrency race (exactly one winner) |
| Migration from a clean database                  | `migrations`: applies and is recorded; re-run is a no-op; no drift between the migrated DB and the Prisma schema; migrations use owner credentials                                                                                    |
| Migration from the Milestone 1 schema            | `migrations`: reproduces M1's (empty) deploy, then upgrades with pre-existing roles; re-run is a no-op                                                                                                                                |
| App refuses unsafe roles                         | `role-guard`: unmigrated DB, superuser, non-member, `BYPASSRLS` refused; override works only outside production; app role starts                                                                                                      |

## Verification evidence

```
pnpm verify   (format, lint, typecheck, boundaries, unit, integration)
  prettier --check       All matched files use Prettier code style!
  eslint                 0 problems
  tsc --noEmit           0 errors
  depcruise              no dependency violations found (134 modules, 426 dependencies)
  vitest (unit)          Test Files 21 passed · Tests 273 passed   (60 new in M2)
  vitest (integration)   Test Files 7 passed  · Tests 89 passed    (77 new in M2)
     isolation 35 · config 19 · migrations 12 · role-guard 7 · concurrency 4 · api 10 · worker 2
```

- **Coverage of tenancy, identity and database code (integration run):**
  95.4% lines, 93.1% statements, 86.8% branches, 95.2% functions.
- **Mutation checks:**
  - A temporary migration adding a table without RLS and with an unscoped
    unique index made the schema guard fail (RLS, policy, unique-scope and
    drift checks). The migration was then removed.
  - Earlier, forged-context, pool-leak and cross-tenant writes were each
    exercised against the real database.
- **Fresh clone:** the full suite passes from a clean clone (see the commit
  report).
- **Containers:**
  - `migrate` image applies the migration with owner credentials only.
  - API container is ready (`database: up`, `redis: up`) as `lip_api`,
    running as the non-root `node` user.
  - Worker container starts.
  - The CLI inside the image provisioned Juniper from the template:
    5 integrations disabled, 4 flows off, 7 lead-source mappings, 9 TBC field
    mappings, SLA 60/1440/4320.
  - Re-provisioning is refused.
  - The API started with superuser credentials exits with code 1 and a clear
    reason.

## Defects found and fixed during the milestone

- Repositories parsed full rows with strict schemas; they now map only the
  domain fields.
- Validation errors were thrown synchronously from promise-returning service
  methods. Every service method is now `async`, so callers always get a
  rejection.
- Provisioning leaked a raw Prisma error for duplicate slugs; it now raises
  `DuplicateTenantError`.
- `prisma.config.ts` still used `DATABASE_URL` for migrations. A scripted
  edit had silently failed after reformatting. It was caught by the container
  test and fixed, with a regression test (migrations use
  `MIGRATION_DATABASE_URL` even when `DATABASE_URL` is wrong). Every other
  scripted edit in this milestone was then audited, and two documentation
  tables that had also silently missed were fixed.

## Decisions for the reviewer

1. **RLS + a non-privileged app role.** Operations now need two database
   credentials per environment (owner for migrations, app role at runtime).
   This is the main operational change.
2. **Person / Company are persisted now,** in a new `identity` module, as the
   first canonical entities stored. Leads, signals and decisions get tables in
   the milestones that first write them (M6/M11/M12), and the schema guard
   ensures those are tenant-scoped.
3. **The Juniper template** contains only values stated in the brief. Sugar's
   existing `status` field is marked `proposed` for stage; everything the
   brief marks TBC is `tbc` with no field name. HubSpot internal property
   names are not guessed; they are confirmed in M3/M16.

## Known limitations / follow-ups

- **Config changes** are versioned but not yet written to an audit trail;
  audit arrives with the audit module (M6+).
- **Offboarding** blocks access, but data retention and deletion remain a
  separate, audited process to design before production.
- **Lead-source mappings** are stored and validated. Evaluating them against
  incoming values (case sensitivity, precedence) is the mapping engine's job
  (M9).
- **Role names are cluster-wide:** environments must not share a PostgreSQL
  server with the same `lip_app`.
- **Runtime image size** (~816 MB) remains an open M0 follow-up.
