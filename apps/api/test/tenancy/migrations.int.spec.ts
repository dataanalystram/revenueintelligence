import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, startPostgres, withAdmin } from '../support/containers';

const run = promisify(execFile);

/** Tables that are not tenant-owned. Anything else must satisfy every tenancy rule. */
const PLATFORM_TABLES = ['tenants'];

function databaseUrl(container: StartedPostgreSqlContainer, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${database}`;
  return url.toString();
}

async function createDatabase(
  container: StartedPostgreSqlContainer,
  name: string,
): Promise<string> {
  await withAdmin(container.getConnectionUri(), (db) => db.query(`CREATE DATABASE ${name}`));
  return databaseUrl(container, name);
}

describe('database migrations and schema guard', () => {
  let pg: StartedPostgreSqlContainer;
  let cleanUrl: string;
  const tmp = resolve('test/.tmp/m1-state');

  beforeAll(async () => {
    pg = await startPostgres();
    cleanUrl = await createDatabase(pg, 'clean_db');
    await migrate(cleanUrl);
  });

  afterAll(async () => {
    rmSync(tmp, { recursive: true, force: true });
    await pg?.stop();
  });

  describe('from a clean database', () => {
    it('applies all migrations and records them', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ migration_name: string; finished_at: Date | null }>(
          'SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name',
        ),
      );
      expect(rows.map((r) => r.migration_name)).toEqual([
        '20260926120000_tenancy_and_identity',
        '20260927120000_oauth_tokens_and_states',
        '20260928120000_webhook_receipts_and_routing',
      ]);
      expect(rows.every((r) => r.finished_at !== null)).toBe(true);
    });

    it('re-running migrations is a no-op', async () => {
      const output = await migrate(cleanUrl);
      expect(output).toMatch(/No pending migrations/);
    });

    it('migrations use MIGRATION_DATABASE_URL (owner), not the application DATABASE_URL', async () => {
      const { stdout } = await run('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://app:wrong@127.0.0.1:1/not_used',
          MIGRATION_DATABASE_URL: cleanUrl,
        },
      });
      expect(stdout).toMatch(/Database schema is up to date/);
    });

    it('the migrated database matches the Prisma schema exactly (no drift)', async () => {
      const result = await run(
        'pnpm',
        [
          'exec',
          'prisma',
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--exit-code',
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: cleanUrl, MIGRATION_DATABASE_URL: cleanUrl },
        },
      ).then(
        (r) => ({ code: 0, out: r.stdout }),
        (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }),
      );
      expect(result.out).toMatch(/No difference detected/);
      expect(result.code).toBe(0);
    });
  });

  describe('schema guard: every tenant-owned table is isolated', () => {
    interface TableFacts {
      table: string;
      rls: boolean;
      forced: boolean;
      has_tenant_id: boolean;
      policies: string[];
    }

    let tables: TableFacts[];

    beforeAll(async () => {
      ({ rows: tables } = await withAdmin(cleanUrl, (db) =>
        db.query<TableFacts>(`
          SELECT c.relname AS table,
                 c.relrowsecurity AS rls,
                 c.relforcerowsecurity AS forced,
                 EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                           AND a.attnotnull AND NOT a.attisdropped) AS has_tenant_id,
                 COALESCE((SELECT array_agg(pg_get_expr(p.polqual, p.polrelid)) FROM pg_policy p WHERE p.polrelid = c.oid), '{}') AS policies
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
          ORDER BY c.relname`),
      ));
    });

    it('found the expected tables', () => {
      expect(tables.map((t) => t.table)).toEqual(
        expect.arrayContaining([
          'tenants',
          'tenant_integrations',
          'persons',
          'companies',
          'person_external_refs',
          'tenant_oauth_tokens',
          'tenant_oauth_states',
          'tenant_webhook_receipts',
        ]),
      );
      expect(tables.length).toBeGreaterThanOrEqual(17);
    });

    it('every table has row-level security enabled and forced', () => {
      const offenders = tables.filter((t) => !t.rls || !t.forced).map((t) => t.table);
      expect(offenders).toEqual([]);
    });

    it('every tenant-owned table has NOT NULL tenant_id and a policy on app_current_tenant()', () => {
      const offenders = tables
        .filter((t) => !PLATFORM_TABLES.includes(t.table))
        .filter(
          (t) =>
            !t.has_tenant_id ||
            !t.policies.some((p) => /tenant_id = app_current_tenant\(\)/.test(p)),
        )
        .map((t) => t.table);
      expect(offenders).toEqual([]);
    });

    it('unique constraints on tenant-owned tables are tenant-scoped (or on a global uuid id)', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ table: string; index: string; columns: string[] }>(`
          SELECT t.relname AS table, i.relname AS index,
                 array_agg(a.attname::text ORDER BY a.attnum) AS columns
          FROM pg_index x
          JOIN pg_class t ON t.oid = x.indrelid
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (x.indkey)
          WHERE n.nspname = 'public' AND x.indisunique AND t.relname <> '_prisma_migrations'
          GROUP BY t.relname, i.relname`),
      );
      const offenders = rows
        .filter((r) => !PLATFORM_TABLES.includes(r.table))
        .filter(
          (r) =>
            !r.columns.includes('tenant_id') && !(r.columns.length === 1 && r.columns[0] === 'id'),
        )
        .map((r) => `${r.table}.${r.index}`);
      expect(offenders).toEqual([]);
    });

    it('foreign keys between tenant-owned tables include tenant_id', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ name: string; from_table: string; to_table: string; columns: string[] }>(`
          SELECT c.conname AS name, f.relname AS from_table, r.relname AS to_table,
                 array_agg(a.attname::text) AS columns
          FROM pg_constraint c
          JOIN pg_class f ON f.oid = c.conrelid
          JOIN pg_class r ON r.oid = c.confrelid
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'f'
          GROUP BY c.conname, f.relname, r.relname`),
      );
      const offenders = rows
        .filter((r) => !PLATFORM_TABLES.includes(r.to_table))
        .filter((r) => !r.columns.includes('tenant_id'))
        .map((r) => r.name);
      expect(offenders).toEqual([]);
      expect(rows.length).toBeGreaterThan(10);
    });

    it('the app role can use every table except the migration history', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ table: string; ok: boolean }>(`
          SELECT c.relname AS table,
                 has_table_privilege('lip_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS ok
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'`),
      );
      expect(rows.filter((r) => r.table !== '_prisma_migrations').every((r) => r.ok)).toBe(true);
      expect(rows.find((r) => r.table === '_prisma_migrations')?.ok).toBe(false);
    });

    it('the app role cannot bypass row-level security', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
          "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'lip_app'",
        ),
      );
      expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }]);
    });
  });

  describe('webhook routing role (ADR 0011)', () => {
    it('is a powerless NOLOGIN role that the app role cannot become', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<Record<string, boolean>>(`
          SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb,
                 pg_has_role('lip_app', 'lip_webhook_router', 'MEMBER') AS app_is_member,
                 pg_has_role('lip_webhook_router', 'lip_app', 'MEMBER') AS router_is_app
          FROM pg_roles WHERE rolname = 'lip_webhook_router'`),
      );
      expect(rows).toEqual([
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreaterole: false,
          rolcreatedb: false,
          app_is_member: false,
          router_is_app: false,
        },
      ]);
    });

    it('can read only non-secret columns: never a token column, never another table', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ table_name: string; column_name: string; privilege_type: string }>(`
          SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
          WHERE grantee = 'lip_webhook_router' ORDER BY table_name, column_name`),
      );
      expect(rows.map((r) => `${r.table_name}.${r.column_name}:${r.privilege_type}`)).toEqual([
        'tenant_oauth_tokens.account_id:SELECT',
        'tenant_oauth_tokens.system:SELECT',
        'tenant_oauth_tokens.tenant_id:SELECT',
        'tenants.id:SELECT',
        'tenants.status:SELECT',
      ]);
      const tables = await withAdmin(cleanUrl, (db) =>
        db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE grantee = 'lip_webhook_router'",
        ),
      );
      expect(tables.rows[0]!.n).toBe(0);
    });

    it('owns exactly one function, SECURITY DEFINER with a fixed search_path, executable by the app role only', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{
          name: string;
          definer: boolean;
          config: string[] | null;
          app: boolean;
          public: boolean;
        }>(`
          SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config,
                 has_function_privilege('lip_app', p.oid, 'EXECUTE') AS app,
                 has_function_privilege('public', p.oid, 'EXECUTE') AS public
          FROM pg_proc p WHERE p.proowner = 'lip_webhook_router'::regrole`),
      );
      expect(rows).toEqual([
        {
          name: 'app_route_oauth_account',
          definer: true,
          config: ['search_path=pg_catalog, pg_temp'],
          app: true,
          public: false,
        },
      ]);
    });
  });

  describe('upgrading from the Milestone 1 state', () => {
    it('applies cleanly to a database last deployed at M1, where ops had already created the roles', async () => {
      const url = await createDatabase(pg, 'm1_db');

      // M1 shipped no migrations: reproduce its `prisma migrate deploy` with an empty migrations folder.
      mkdirSync(resolve(tmp, 'migrations'), { recursive: true });
      writeFileSync(
        resolve(tmp, 'prisma.config.ts'),
        `import { defineConfig } from 'prisma/config';
export default defineConfig({
  schema: ${JSON.stringify(resolve('prisma/schema.prisma'))},
  migrations: { path: ${JSON.stringify(resolve(tmp, 'migrations'))} },
  datasource: { url: process.env.DATABASE_URL! },
});\n`,
      );
      const m1 = await migrate(url, ['--config', resolve(tmp, 'prisma.config.ts')]);
      expect(m1).toMatch(/No migration found/);
      const before = await withAdmin(url, (db) =>
        db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
        ),
      );
      expect(before.rows[0]?.n).toBe(0);

      // Roles are cluster-wide and already exist (created by the clean-database run and by ops).
      const output = await migrate(url);
      expect(output).toMatch(/20260926120000_tenancy_and_identity/);
      expect(output).toMatch(/successfully applied/);

      const after = await withAdmin(url, (db) =>
        db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND rowsecurity AND tablename <> '_prisma_migrations'",
        ),
      );
      expect(after.rows[0]?.n).toBeGreaterThanOrEqual(14);
      await expect(migrate(url)).resolves.toMatch(/No pending migrations/);
    });
  });
});
