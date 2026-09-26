# Database roles

The platform relies on PostgreSQL row-level security for tenant isolation
([ADR 0008](../adr/0008-tenant-isolation.md)). That only works if the
application connects with a role that RLS applies to.

| Role                                                                      | Purpose                                        | Used by                                            | Privileges                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Owner (e.g. `lip`, or the Azure admin)                                    | Owns the schema; runs migrations               | `prisma migrate deploy` (`MIGRATION_DATABASE_URL`) | DDL                                                                                            |
| `lip_app` (NOLOGIN group role, created by the first migration if missing) | Holds the application's table privileges       | —                                                  | `SELECT/INSERT/UPDATE/DELETE` on application tables; no access to `_prisma_migrations`; no DDL |
| `lip_api` (or any name; LOGIN, member of `lip_app`)                       | Runtime connection for the API, worker and CLI | `DATABASE_URL`                                     | Inherits `lip_app`. Must **not** be superuser or `BYPASSRLS`                                   |

The application checks this at start-up and on readiness checks, and refuses
to run as a superuser, a `BYPASSRLS` role, a role outside `lip_app`, or against
a database whose migrations have not been applied.

## Creating the runtime login role

Run once per environment, as the owner/admin, **after** the first migration
(or before it, if you also create `lip_app` yourself):

```sql
CREATE ROLE lip_api LOGIN PASSWORD '<generated secret>' NOSUPERUSER NOBYPASSRLS IN ROLE lip_app;
```

Store the password in the secret manager and build `DATABASE_URL` from it.
Rotate it with `ALTER ROLE lip_api PASSWORD '…'`. On Azure Database for
PostgreSQL, a Microsoft Entra managed identity can be mapped to a role in the
same way instead of a password.

Local development: `docker compose up -d postgres` creates `lip_api` /
`lip_api` automatically (`docker/postgres/init/01-app-role.sql`, development
only).

## Deployment order

1. Run the migrate job (image target `migrate`) with `MIGRATION_DATABASE_URL`
   set to the owner.
2. Start the API and worker with `DATABASE_URL` set to the runtime role.
3. Provision tenants with the CLI (runtime role):
   `node dist/cli/provision-tenant.js --slug juniper --name "Juniper Education" --template juniper`

## Notes

- Role names are cluster-wide. Do not let two environments share one server
  with the same `lip_app`.
- `DATABASE_ALLOW_PRIVILEGED_ROLE=true` exists for local experiments only and
  is rejected when `NODE_ENV=production`.
