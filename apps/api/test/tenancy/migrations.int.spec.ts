import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** A Prisma config whose migrations folder holds only the migrations named before `cutoff`. */
function migrationsBefore(dir: string, cutoff: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, 'migrations'), { recursive: true });
  for (const name of readdirSync(resolve('prisma/migrations'))) {
    if (name < cutoff || name === 'migration_lock.toml') {
      cpSync(resolve('prisma/migrations', name), resolve(dir, 'migrations', name), {
        recursive: true,
      });
    }
  }
  const config = resolve(dir, 'prisma.config.ts');
  writeFileSync(
    config,
    `import { defineConfig } from 'prisma/config';
export default defineConfig({
  schema: ${JSON.stringify(resolve('prisma/schema.prisma'))},
  migrations: { path: ${JSON.stringify(resolve(dir, 'migrations'))} },
  datasource: { url: process.env.DATABASE_URL! },
});\n`,
  );
  return config;
}

/** The migrations shipped up to M5 (before M6). */
const m5MigrationsConfig = (dir: string) => migrationsBefore(dir, '20261005');
/** The migrations shipped up to M6 (before M7). */
const m6MigrationsConfig = (dir: string) => migrationsBefore(dir, '20261010');

/** Everything a migration can change, as sorted text (for exact schema comparison). */
async function schemaSnapshot(url: string): Promise<Record<string, string[]>> {
  const queries: Record<string, string> = {
    columns: `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '-') AS v
              FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'`,
    constraints: `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS v
                  FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid <> 0`,
    indexes: `SELECT indexdef AS v FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    policies: `SELECT tablename || ' ' || policyname || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS v
               FROM pg_policies WHERE schemaname = 'public'`,
    rls: `SELECT relname || ' ' || relrowsecurity || ' ' || relforcerowsecurity AS v
          FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    triggers: `SELECT tgrelid::regclass::text || ' ' || tgname AS v FROM pg_trigger WHERE NOT tgisinternal`,
    grants: `SELECT grantee || ' ' || table_name || ' ' || privilege_type AS v
             FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee LIKE 'lip_%'`,
  };
  return withAdmin(url, async (db) => {
    const out: Record<string, string[]> = {};
    for (const [key, sql] of Object.entries(queries)) {
      out[key] = (await db.query<{ v: string }>(sql)).rows.map((r) => r.v).sort();
    }
    return out;
  });
}

const ROLLBACK = {
  processing: resolve('prisma/rollback/20261005130000_m6_event_processing_state.down.sql'),
  identity: resolve('prisma/rollback/20261005120000_m6_canonical_identity_provenance.down.sql'),
  snapshots: resolve('prisma/rollback/20261010130000_m7_eligibility_snapshots.down.sql'),
  productModel: resolve(
    'prisma/rollback/20261010120000_m7_product_model_and_subscriptions.down.sql',
  ),
};

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
        '20261005120000_m6_canonical_identity_provenance',
        '20261005130000_m6_event_processing_state',
        '20261010120000_m7_product_model_and_subscriptions',
        '20261010130000_m7_eligibility_snapshots',
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

  describe('upgrading from the Milestone 5 state (M6 migrations on existing data)', () => {
    it('keeps receipts, people, companies and references; old receipts become pending pre_m6', async () => {
      const url = await createDatabase(pg, 'm5_db');
      const dir = resolve('test/.tmp/m5-state');
      try {
        await migrate(url, ['--config', m5MigrationsConfig(dir)]);
        const tenant = '11111111-1111-4111-8111-111111111111';
        const company = '22222222-2222-4222-8222-222222222222';
        const person = '33333333-3333-4333-8333-333333333333';
        await withAdmin(url, async (db) => {
          await db.query(
            `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'mfive', 'M5', now())`,
            [tenant],
          );
          await db.query(
            `INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES ($1, $2, 'School', now(), now())`,
            [company, tenant],
          );
          await db.query(
            `INSERT INTO company_external_refs (tenant_id, system, object_type, external_id, company_id, created_at)
             VALUES ($1, 'hubspot', 'companies', '201', $2, '2026-09-30T10:00:00Z')`,
            [tenant, company],
          );
          await db.query(
            `INSERT INTO persons (id, tenant_id, primary_email, company_id, created_at, updated_at)
             VALUES ($1, $2, 'a@school.example', $3, now(), now())`,
            [person, tenant, company],
          );
          await db.query(
            `INSERT INTO tenant_webhook_receipts (tenant_id, system, delivery_key, event_id, subscription_id, account_id, app_id,
               subscription_type, object_type_id, object_id, occurred_at, first_attempt_number, last_attempt_number)
             VALUES ($1, 'hubspot', $2, '1', '2', '149338734', '3', 'object.creation', '0-1', '101', now(), 0, 0)`,
            [tenant, 'a'.repeat(64)],
          );
        });

        const output = await migrate(url);
        expect(output).toMatch(/20261005120000_m6_canonical_identity_provenance/);
        expect(output).toMatch(/20261005130000_m6_event_processing_state/);

        await withAdmin(url, async (db) => {
          const receipts = await db.query(
            'SELECT processing_status, processing_reason, processing_attempts FROM tenant_webhook_receipts',
          );
          expect(receipts.rows).toEqual([
            { processing_status: 'pending', processing_reason: 'pre_m6', processing_attempts: 0 },
          ]);
          const refs = await db.query(
            'SELECT state, first_seen_at, last_seen_at IS NOT NULL AS seen FROM company_external_refs',
          );
          expect(refs.rows).toEqual([
            { state: 'active', first_seen_at: new Date('2026-09-30T10:00:00Z'), seen: true },
          ]);
          const people = await db.query('SELECT primary_email, record_state FROM persons');
          expect(people.rows).toEqual([
            { primary_email: 'a@school.example', record_state: 'active' },
          ]);
          // Now allowed: no name, no email, and the same email twice (email is not identity).
          await db.query(
            `INSERT INTO companies (id, tenant_id, created_at, updated_at) VALUES (gen_random_uuid(), $1, now(), now())`,
            [tenant],
          );
          await db.query(
            `INSERT INTO persons (id, tenant_id, primary_email, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, NULL, now(), now()), (gen_random_uuid(), $1, 'a@school.example', now(), now())`,
            [tenant],
          );
          // Still refused: blank names, placeholder-free CHECKs, unknown states.
          await expect(
            db.query(
              `INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES (gen_random_uuid(), $1, '  ', now(), now())`,
              [tenant],
            ),
          ).rejects.toThrow(/companies_name_not_blank/);
          await expect(
            db.query(`UPDATE persons SET record_state = 'merged' WHERE id = $1`, [person]),
          ).rejects.toThrow(/persons_merged_consistent/);
        });
        await expect(migrate(url)).resolves.toMatch(/No pending migrations/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    it('the M6 down-scripts restore exactly the M5 schema, refuse data M5 cannot hold, and M6 re-applies', async () => {
      const m5Url = await createDatabase(pg, 'm5_reference_db');
      const url = await createDatabase(pg, 'm6_down_db');
      const dir = resolve('test/.tmp/m5-reference');
      try {
        await migrate(m5Url, ['--config', m5MigrationsConfig(dir)]);
        await migrate(url);
        const latest = await schemaSnapshot(url);
        const tenant = '44444444-4444-4444-8444-444444444444';
        await withAdmin(url, async (db) => {
          // Later milestones roll back first (M7), then M6.
          await db.query(readFileSync(ROLLBACK.snapshots, 'utf8'));
          await db.query(readFileSync(ROLLBACK.productModel, 'utf8'));
          await db.query(
            `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'mdown', 'Down', now())`,
            [tenant],
          );
          await db.query(
            `INSERT INTO companies (id, tenant_id, created_at, updated_at) VALUES (gen_random_uuid(), $1, now(), now())`,
            [tenant],
          );
          await db.query(readFileSync(ROLLBACK.processing, 'utf8'));
          // A company without a name cannot exist in M5: refused, nothing changed.
          await expect(db.query(readFileSync(ROLLBACK.identity, 'utf8'))).rejects.toThrow(
            /cannot be rolled back/,
          );
          await db.query('ROLLBACK');
          const still = await db.query(
            `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'tenant_context_changes'`,
          );
          expect(still.rows).toEqual([{ n: 1 }]);
          await db.query('DELETE FROM companies WHERE tenant_id = $1', [tenant]);
          await db.query(readFileSync(ROLLBACK.identity, 'utf8'));
        });

        expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(m5Url));

        const output = await migrate(url);
        expect(output).toMatch(/20261005120000_m6_canonical_identity_provenance/);
        expect(output).toMatch(/20261005130000_m6_event_processing_state/);
        expect(await schemaSnapshot(url)).toEqual(latest);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('upgrading from the Milestone 6 state (M7 migrations on existing data)', () => {
    const tenant = '55555555-5555-4555-8555-555555555555';
    const company = '66666666-6666-4666-8666-666666666666';
    const t0 = '2026-01-01T00:00:00.000Z';
    async function seedM6(url: string) {
      await withAdmin(url, async (db) => {
        await db.query(
          `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'msix', 'M6', now())`,
          [tenant],
        );
        await db.query(
          `INSERT INTO tenant_products (tenant_id, key, name, updated_at) VALUES ($1, 'portal', 'Portal', now()), ($1, 'mis', 'MIS', now()), ($1, 'zero', 'Zero', now())`,
          [tenant],
        );
        await db.query(
          `INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES ($1, $2, 'School', now(), now())`,
          [company, tenant],
        );
        await db.query(
          `INSERT INTO company_products (tenant_id, company_id, product_key, status, since, until) VALUES
             ($1, $2, 'portal', 'active', $3, NULL),
             ($1, $2, 'mis', 'churned', $3, '2026-06-01T00:00:00Z'),
             ($1, $2, 'zero', 'trial', $3, $3)`,
          [tenant, company, t0],
        );
      });
    }

    it('migrates legacy ownership into subscriptions with honest provenance, then drops the table', async () => {
      const url = await createDatabase(pg, 'm6_state_db');
      const dir = resolve('test/.tmp/m6-state');
      try {
        await migrate(url, ['--config', m6MigrationsConfig(dir)]);
        await seedM6(url);
        const output = await migrate(url);
        expect(output).toMatch(/20261010120000_m7_product_model_and_subscriptions/);
        expect(output).toMatch(/20261010130000_m7_eligibility_snapshots/);
        await withAdmin(url, async (db) => {
          const gone = await db.query(`SELECT to_regclass('public.company_products') AS t`);
          expect(gone.rows).toEqual([{ t: null }]);
          const subs = await db.query(
            `SELECT product_key, state, starts_at, ends_at, source_system, source_object_type, source_record_id, record_state, company_id
               FROM tenant_subscriptions ORDER BY product_key`,
          );
          expect(subs.rows).toEqual([
            {
              product_key: 'mis',
              state: 'cancelled',
              starts_at: new Date(t0),
              ends_at: new Date('2026-06-01T00:00:00Z'),
              source_system: 'import',
              source_object_type: 'legacy_company_product',
              source_record_id: `${company}:mis`,
              record_state: 'active',
              company_id: company,
            },
            {
              product_key: 'portal',
              state: 'active',
              starts_at: new Date(t0),
              ends_at: null,
              source_system: 'import',
              source_object_type: 'legacy_company_product',
              source_record_id: `${company}:portal`,
              record_state: 'active',
              company_id: company,
            },
            // A zero-length legacy period is kept exactly (never owned), not dropped.
            {
              product_key: 'zero',
              state: 'trial',
              starts_at: new Date(t0),
              ends_at: new Date(t0),
              source_system: 'import',
              source_object_type: 'legacy_company_product',
              source_record_id: `${company}:zero`,
              record_state: 'active',
              company_id: company,
            },
          ]);
          const prov = await db.query(
            `SELECT c.change_type, c.cause, c.source_system, c.adapter, c.changed_fields
               FROM tenant_context_changes c JOIN tenant_subscriptions s ON s.id = c.entity_id
              WHERE c.entity_kind = 'subscription' ORDER BY s.product_key`,
          );
          expect(prov.rows).toEqual([
            {
              change_type: 'created',
              cause: 'import',
              source_system: 'import',
              adapter: 'migration',
              changed_fields: ['companyId', 'productKey', 'state', 'startsAt', 'endsAt'],
            },
            {
              change_type: 'created',
              cause: 'import',
              source_system: 'import',
              adapter: 'migration',
              changed_fields: ['companyId', 'productKey', 'state', 'startsAt'],
            },
            {
              change_type: 'created',
              cause: 'import',
              source_system: 'import',
              adapter: 'migration',
              changed_fields: ['companyId', 'productKey', 'state', 'startsAt', 'endsAt'],
            },
          ]);
          // K4 and immutability hold at the database level.
          await expect(
            db.query(`DELETE FROM tenant_products WHERE key = 'portal'`),
          ).rejects.toThrow(/never deleted/);
          await db.query(
            `INSERT INTO tenant_product_models (tenant_id, version, document, content_hash, effective_from, published_by) VALUES ($1, 1, '{}', $2, now(), 'test')`,
            [tenant, 'a'.repeat(64)],
          );
          await expect(
            db.query(`UPDATE tenant_product_models SET published_by = 'x'`),
          ).rejects.toThrow(/immutable/);
          await expect(db.query(`DELETE FROM tenant_product_models`)).rejects.toThrow(/immutable/);
        });
        await expect(migrate(url)).resolves.toMatch(/No pending migrations/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the M7 down-scripts restore exactly the M6 schema and the legacy rows, refuse data M6 cannot hold, and M7 re-applies', async () => {
      const m6Url = await createDatabase(pg, 'm6_reference_db');
      const url = await createDatabase(pg, 'm7_down_db');
      const dirRef = resolve('test/.tmp/m6-reference');
      const dir = resolve('test/.tmp/m6-down');
      try {
        await migrate(m6Url, ['--config', m6MigrationsConfig(dirRef)]);
        await migrate(url, ['--config', m6MigrationsConfig(dir)]);
        await seedM6(url);
        await migrate(url);
        const latest = await schemaSnapshot(url);
        await withAdmin(url, async (db) => {
          // A subscription from a real import cannot be held by the legacy table: refused, nothing changed.
          await db.query(
            `INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system, source_object_type, source_record_id, observed_at)
             VALUES ($1, gen_random_uuid(), $2, 'portal', 'active', 'import', 'csv_line', 'line-1', now())`,
            [tenant, company],
          );
          await db.query(readFileSync(ROLLBACK.snapshots, 'utf8'));
          await expect(db.query(readFileSync(ROLLBACK.productModel, 'utf8'))).rejects.toThrow(
            /cannot be rolled back/,
          );
          await db.query('ROLLBACK');
          const still = await db.query(`SELECT to_regclass('public.tenant_subscriptions') AS t`);
          expect(still.rows).toEqual([{ t: 'tenant_subscriptions' }]);
          await db.query(`DELETE FROM tenant_subscriptions WHERE source_object_type = 'csv_line'`);
          await db.query(readFileSync(ROLLBACK.productModel, 'utf8'));
          const restored = await db.query(
            `SELECT product_key, status, since, until FROM company_products ORDER BY product_key`,
          );
          expect(restored.rows).toEqual([
            {
              product_key: 'mis',
              status: 'churned',
              since: new Date(t0),
              until: new Date('2026-06-01T00:00:00Z'),
            },
            { product_key: 'portal', status: 'active', since: new Date(t0), until: null },
            { product_key: 'zero', status: 'trial', since: new Date(t0), until: new Date(t0) },
          ]);
        });

        expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(m6Url));

        const output = await migrate(url);
        expect(output).toMatch(/20261010120000_m7_product_model_and_subscriptions/);
        expect(await schemaSnapshot(url)).toEqual(latest);
      } finally {
        rmSync(dirRef, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the M7 down-scripts refuse while a published model or a snapshot exists (recorded history)', async () => {
      const url = await createDatabase(pg, 'm7_refuse_db');
      await migrate(url);
      await withAdmin(url, async (db) => {
        await db.query(
          `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'mref', 'Ref', now())`,
          [tenant],
        );
        await db.query(
          `INSERT INTO companies (id, tenant_id, created_at, updated_at) VALUES ($1, $2, now(), now())`,
          [company, tenant],
        );
        await db.query(
          `INSERT INTO tenant_products (tenant_id, key, name, updated_at) VALUES ($1, 'core', 'Core', now())`,
          [tenant],
        );
        await db.query(
          `INSERT INTO tenant_product_models (tenant_id, version, document, content_hash, effective_from, published_by) VALUES ($1, 1, '{}', $2, now(), 'test')`,
          [tenant, 'b'.repeat(64)],
        );
        await expect(db.query(readFileSync(ROLLBACK.productModel, 'utf8'))).rejects.toThrow(
          /product model versions exist/,
        );
        await db.query('ROLLBACK');
        await db.query(
          `INSERT INTO tenant_eligibility_snapshots (tenant_id, id, requested_company_id, evaluated_company_id, product_key, as_of, status, ownership, model_version, model_hash, evaluator_version, facts_hash, result, purpose, correlation_id)
           VALUES ($1, gen_random_uuid(), $2, $2, 'core', now(), 'unknown', 'unknown', 1, $3, 1, $3, '{}', 'audit', gen_random_uuid())`,
          [tenant, company, 'c'.repeat(64)],
        );
        await expect(db.query(readFileSync(ROLLBACK.snapshots, 'utf8'))).rejects.toThrow(
          /snapshots exist/,
        );
        await db.query('ROLLBACK');
        await expect(
          db.query(`UPDATE tenant_eligibility_snapshots SET purpose = 'x'`),
        ).rejects.toThrow(/append-only/);
        await expect(db.query(`DELETE FROM tenant_eligibility_snapshots`)).rejects.toThrow(
          /append-only/,
        );
      });
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
