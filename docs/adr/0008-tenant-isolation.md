# ADR 0008 — Tenant isolation: row-level security, mandatory tenant context, composite keys

- Status: Accepted (Milestone 2)
- Date: 2026-09-26

## Context

Juniper is tenant #1, but the platform will serve several customers. Every
customer-owned object must belong to exactly one tenant: people, companies,
configuration, credential references, and later integration state and
operational records. Application code must not be able to read or modify
another tenant's data by accident. Relying on developers to remember
`WHERE tenant_id = …` is not acceptable.

## Decision

Isolation is enforced in three independent layers, so a single mistake in
any one of them cannot leak data.

### 1. The database enforces it: PostgreSQL row-level security (RLS)

- Every tenant-owned table has `tenant_id uuid NOT NULL` and a
  `tenant_isolation` policy:
  `USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())`.
- `app_current_tenant()` reads the transaction-local setting
  `app.current_tenant`, which is set with `set_config(…, true)` at the start of
  every tenant transaction. Because it is local to the transaction, it cannot
  leak to another request through a pooled connection. It is also compatible
  with PgBouncer transaction pooling.
- RLS is **forced** (it applies to the table owner as well).
- With no tenant set, tenant rows are invisible and inserts fail. A malformed
  value raises an error rather than matching anything.
- The `tenants` registry is visible to platform code (no tenant set). Inside a
  tenant transaction, only the own tenant is visible, and the registry is
  read-only.
- **Operational consequence:** superusers and `BYPASSRLS` roles ignore RLS.
  The application therefore connects as a login role that is a member of the
  `lip_app` group role (DML only, no DDL, no access to the migration history).
  Migrations run as the schema owner. At start-up, and on each readiness check
  until verified, the application **refuses to run** as a superuser, as a
  `BYPASSRLS` role, as a role outside `lip_app`, or against an unmigrated
  schema. `DATABASE_ALLOW_PRIVILEGED_ROLE` relaxes this for local experiments
  only; configuration validation rejects it in production.

### 2. The application makes tenant context mandatory by construction

- `TenantContext` proves the caller acts for one active tenant. Only
  `TenantContextService` issues one, after checking the registry. A forged
  object (`{ tenantId } as TenantContext`, or one built on the prototype) is
  rejected at runtime, because issued contexts are tracked in a `WeakSet`.
- `TenantDatabase.transaction(ctx, tx => …)` is the only way into tenant data.
  It binds the tenant for RLS and re-checks the tenant's status in the same
  round trip, so a suspension takes effect immediately.
- Repositories accept only the resulting `TenantTransaction`, never a database
  client. The client is released when the transaction ends, so a leaked `tx`
  cannot be reused. Repositories also filter by `tenant_id` explicitly and
  refuse to save an entity whose `tenantId` differs from the transaction's.
- **Explicit parameters, not ambient context.** We chose an explicit `ctx` /
  `tx` argument over AsyncLocalStorage. It is visible in every signature,
  testable, and cannot silently carry the wrong tenant across queue jobs,
  timers or `Promise.all` fan-outs. AsyncLocalStorage may later be used only to
  enrich logs.

### 3. Relational and CI guards

- **Composite foreign keys** `(tenant_id, parent_id) → parent(tenant_id, id)`,
  so even raw SQL cannot link a row to another tenant's parent. `tenant_id` is
  immutable (trigger), and every foreign key is `ON UPDATE RESTRICT`.
- **Tenant-scoped uniqueness:** `(tenant_id, …)` on every business key, so
  identical external IDs, emails and product keys coexist across tenants.
  Surrogate `id` primary keys are random UUIDs.
- **Credential references** store a derived secret key
  `tenant.<slug>.<system>.<name>`. A `CHECK` constraint (with the slug bound
  to the tenant by a composite foreign key, and slugs made immutable) makes it
  impossible for a tenant's reference to point at another tenant's secret.
  Slugs are `[a-z][a-z0-9]{1,39}`. They contain no separators, because secret
  providers fold `.` `-` `_` together (environment variables use `_`), which
  could otherwise make two tenants' keys collide. This is covered by an
  exhaustive unit test.
- **dependency-cruiser** forbids business modules from importing the root
  `PrismaService`. Only `modules/tenancy/infrastructure` may.
- A **schema-guard integration test** inspects the live catalogue and fails CI
  if any table:
  - lacks forced RLS or a tenant policy,
  - lacks `tenant_id NOT NULL`,
  - has a unique index not scoped by tenant, or
  - has a foreign key to a tenant table without `tenant_id`.
    It was shown to catch a deliberately leaky table.

## Consequences

- **Two database credentials** per environment: owner (migrations) and app
  role (runtime). See `docs/operations/database-roles.md`.
- **Every tenant operation runs in a transaction**, with one extra round trip
  for `set_config` plus the status check. This is negligible at the expected
  volumes.
- **Service methods each open their own transaction.** Multi-step atomic work
  composes repositories inside one `TenantDatabase.transaction` call.
- **Cross-tenant platform jobs** (e.g. SLA sweeps) list tenants through the
  registry, then obtain a context per tenant.
- **New tables** need their RLS policy written in the migration SQL, because
  Prisma does not model RLS. The schema guard makes forgetting this impossible
  to merge.
- **Role names are cluster-wide.** Two environments sharing one PostgreSQL
  server share `lip_app`. Use separate servers or databases with separate
  login roles.

## Alternatives considered

- **Application-only filtering** (a Prisma extension adding `tenant_id` to
  every query). Rejected as the sole mechanism: raw SQL, new query shapes and
  bugs in the extension bypass it. Explicit filtering remains as defence in
  depth.
- **Schema-per-tenant or database-per-tenant.** Stronger physical separation,
  but it multiplies migrations, connections and operational cost for a
  product expecting tens of tenants, not thousands. It can still be offered
  later for a customer who contractually requires it, because tenant access
  already goes through `TenantDatabase`.
