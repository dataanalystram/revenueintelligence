import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTOR_KIND_CATALOGUE } from '../../src/modules/domain/connector-kinds';
import {
  CANONICAL_MODULES,
  CANONICAL_VERSIONS,
  CHANGE_CAUSES,
  CHANGE_ORIGINS,
  CHANGE_TYPES,
  ENTITY_INDEX_KINDS,
  ENTITY_INDEX_SOURCES,
  MODULE_KEYS,
  REGISTRY_KINDS,
  canonicalCatalogueHash,
  entityIndexTriggerNames,
  valueHistoryPairs,
} from '../../src/modules/domain/canonical';
import { AUDIT_ACTIONS, CAPABILITIES } from '../../src/modules/domain/security';
import { authorityContentHash } from '../../src/modules/domain/source-authority';
import {
  CLASSIFICATION_MANIFEST,
  PRIVILEGE_MANIFEST,
  SECURITY_DEFINER_FUNCTIONS,
  TABLE_PRIVILEGES,
} from '../../src/modules/tenancy/security';
import { migrate, startPostgres, withAdmin } from '../support/containers';

const run = promisify(execFile);

/** Tables that are not tenant-owned. Anything else must satisfy every tenancy rule. */
const PLATFORM_TABLES = [
  'tenants',
  'connector_kinds',
  'canonical_model_versions',
  'canonical_modules',
];
/** Platform reference tables the app role may only read (ADR 0019, ADR 0027). */
const READ_ONLY_TABLES = ['connector_kinds', 'canonical_model_versions', 'canonical_modules'];

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
/** The migrations shipped up to M7 (before M8). */
const m7MigrationsConfig = (dir: string) => migrationsBefore(dir, '20261020');
/** The migrations shipped up to M8 (before M9A). */
const m8MigrationsConfig = (dir: string) => migrationsBefore(dir, '20261101');

/** M8 migrations in apply order. */
const M8_MIGRATIONS = [
  '20261020110000_m8_retire_tenant_field_mappings',
  '20261020120000_m8_connector_kinds_and_connections',
  '20261020130000_m8_schema_snapshots_mappings_authority',
];

/** M9A migrations in apply order. */
const M9A_MIGRATIONS = ['20261101120000_m9a_source_profiling'];
const M9A_DOWN = resolve(`prisma/rollback/${M9A_MIGRATIONS[0]}.down.sql`);

/** M9B migrations in apply order (reference data, then reference retirement). */
const M9B_MIGRATIONS = [
  '20261115120000_m9b_chargebee_connector_kind',
  '20261116120000_m9b_reference_retirement',
];
const M9B_DOWN = resolve(`prisma/rollback/${M9B_MIGRATIONS[0]}.down.sql`);
const M9B_RETIRE_DOWN = resolve(`prisma/rollback/${M9B_MIGRATIONS[1]}.down.sql`);

/** M10A1 migrations in apply order (security foundation). */
const M10A1_MIGRATIONS = ['20261201120000_m10a1_security_foundation'];
const M10A1_DOWN = resolve(`prisma/rollback/${M10A1_MIGRATIONS[0]}.down.sql`);

/** M10A2 migrations in apply order (canonical versioning and governance). */
const M10A2_MIGRATIONS = [
  '20261215120000_m10a2_canonical_versions_modules_registries',
  '20261215130000_m10a2_entity_index_history_lifecycle_integrity',
];
/** M10A2 down-scripts in the order they must run (newest first). */
const M10A2_DOWNS = [...M10A2_MIGRATIONS]
  .reverse()
  .map((name) => resolve(`prisma/rollback/${name}.down.sql`));
/** The migrations shipped up to M10A1 (before M10A2). */
const m10a1MigrationsConfig = (dir: string) => migrationsBefore(dir, '20261215');

/** Rolls M10A2 back (newest first); every older down-script runs after this. */
async function rollbackM10A2(url: string): Promise<void> {
  for (const file of M10A2_DOWNS) {
    await withAdmin(url, (db) => db.query(readFileSync(file, 'utf8')));
  }
}

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

/** Down-scripts back to M7 (M9A, then M8), in the order they must run (newest first). */
const POST_M7_DOWNS = [
  ...M8_MIGRATIONS,
  ...M9A_MIGRATIONS,
  ...M9B_MIGRATIONS,
  ...M10A1_MIGRATIONS,
  ...M10A2_MIGRATIONS,
]
  .reverse()
  .map((name) => resolve(`prisma/rollback/${name}.down.sql`));

async function rollbackToM7(db: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  for (const file of POST_M7_DOWNS) await db.query(readFileSync(file, 'utf8'));
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
        ...M8_MIGRATIONS,
        ...M9A_MIGRATIONS,
        ...M9B_MIGRATIONS,
        ...M10A1_MIGRATIONS,
        ...M10A2_MIGRATIONS,
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

    it('M10A1: the app role holds exactly the manifest privileges on every table (no more, no less)', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ table: string; privilege: string; granted: boolean }>(
          `SELECT c.relname AS table, p.privilege,
                  has_table_privilege('lip_app', c.oid, p.privilege) AS granted
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN unnest($1::text[]) AS p(privilege)
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
            ORDER BY 1, 2`,
          [[...TABLE_PRIVILEGES]],
        ),
      );
      const actual: Record<string, string[]> = {};
      for (const r of rows) {
        actual[r.table] ??= [];
        if (r.granted) actual[r.table]!.push(r.privilege);
      }
      const expected = Object.fromEntries(
        Object.entries(PRIVILEGE_MANIFEST).map(([t, p]) => [t, [...p].sort()]),
      );
      expect(Object.fromEntries(Object.entries(actual).map(([t, p]) => [t, p.sort()]))).toEqual(
        expected,
      );
      // The read-only reference tables (ADR 0019) are covered by the manifest.
      for (const table of READ_ONLY_TABLES) expect(PRIVILEGE_MANIFEST[table]).toEqual(['SELECT']);
    });

    it('M10A1: the classification manifest covers exactly every column of every table', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ table: string; column: string }>(
          `SELECT table_name AS table, column_name AS column FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
            ORDER BY 1, 2`,
        ),
      );
      const actual = rows.map((r) => `${r.table}.${r.column}`).sort();
      const manifest = Object.entries(CLASSIFICATION_MANIFEST)
        .flatMap(([t, cols]) => Object.keys(cols).map((c) => `${t}.${c}`))
        .sort();
      expect(
        actual.filter((c) => !manifest.includes(c)),
        'columns without a classification',
      ).toEqual([]);
      expect(
        manifest.filter((c) => !actual.includes(c)),
        'classifications naming no column',
      ).toEqual([]);
      expect(actual.length).toBeGreaterThan(400);
    });

    it('the connector-kind catalogue in the database equals the code catalogue', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ kind: string; display_name: string; has_adapter: boolean }>(
          'SELECT kind, display_name, has_adapter FROM connector_kinds ORDER BY kind',
        ),
      );
      expect(rows).toEqual(
        [...CONNECTOR_KIND_CATALOGUE]
          .map((k) => ({ kind: k.kind, display_name: k.displayName, has_adapter: k.hasAdapter }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
      );
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

  describe('M10A2 schema guard: canonical catalogues, entity index and polymorphic references', () => {
    /** The quoted values of a named CHECK constraint, sorted. */
    const checkValues = async (name: string): Promise<string[]> => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
          [name],
        ),
      );
      expect(rows, name).toHaveLength(1);
      return [
        ...new Set([...rows[0]!.def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]!)),
      ].sort();
    };

    it('V1: canonical_model_versions equals the code catalogue, catalogue hash included', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ version: string; status: string; adr: string; catalogue_hash: string }>(
          'SELECT version, status, adr, catalogue_hash FROM canonical_model_versions ORDER BY major, minor',
        ),
      );
      const hash = canonicalCatalogueHash({
        entityKinds: ENTITY_INDEX_KINDS,
        moduleKeys: MODULE_KEYS,
        changeTypes: CHANGE_TYPES,
        causes: CHANGE_CAUSES,
        origins: CHANGE_ORIGINS,
      });
      expect(rows).toEqual(
        CANONICAL_VERSIONS.map((v) => ({
          version: v.version,
          status: v.status,
          adr: v.adr,
          catalogue_hash: hash,
        })),
      );
    });

    it('canonical_modules equals the code catalogue (all nine unavailable in M10A2)', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{
          module_key: string;
          title: string;
          available: boolean;
          minimum_canonical_version: string | null;
          depends_on: string[];
          config_schema_version: number;
        }>(
          `SELECT module_key, title, available, minimum_canonical_version, depends_on, config_schema_version
             FROM canonical_modules ORDER BY module_key`,
        ),
      );
      expect(rows).toEqual(
        [...CANONICAL_MODULES]
          .map((m) => ({
            module_key: m.key,
            title: m.title,
            available: m.available,
            minimum_canonical_version: m.minimumCanonicalVersion,
            depends_on: [...m.dependsOn],
            config_schema_version: m.configSchemaVersion,
          }))
          .sort((a, b) => a.module_key.localeCompare(b.module_key)),
      );
      expect(rows.every((r) => !r.available)).toBe(true);
    });

    it('the M10A2 closed-set CHECKs equal the code catalogues', async () => {
      expect(await checkValues('canonical_modules_key_valid')).toEqual([...MODULE_KEYS].sort());
      expect(await checkValues('tenant_registry_versions_kind_valid')).toEqual(
        [...REGISTRY_KINDS].sort(),
      );
      expect(await checkValues('tenant_registry_entries_kind_valid')).toEqual(
        [...REGISTRY_KINDS].sort(),
      );
      expect(await checkValues('tenant_entity_index_kind_valid')).toEqual(
        [...ENTITY_INDEX_KINDS].sort(),
      );
      expect(await checkValues('tenant_context_changes_change_type_valid')).toEqual(
        [...CHANGE_TYPES].sort(),
      );
      expect(await checkValues('tenant_context_changes_cause_valid')).toEqual(
        [...CHANGE_CAUSES].sort(),
      );
      expect(await checkValues('tenant_context_changes_origin_valid')).toEqual(
        [...CHANGE_ORIGINS].sort(),
      );
      // The value-history field catalogue is a list of (kind, field) pairs.
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'tenant_value_history_field_valid'`,
        ),
      );
      const pairs = [
        ...rows[0]!.def.matchAll(
          /entity_kind = '([a-z_]+)'::text\) AND \(field = '([a-z_]+)'::text/g,
        ),
      ]
        .map((m) => `${m[1]}.${m[2]}`)
        .sort();
      expect(pairs).toEqual(
        valueHistoryPairs()
          .map((p) => `${p.entityKind}.${p.field}`)
          .sort(),
      );
    });

    it('V2: the database refuses canonical version 1.0 (named pre-freeze CHECK), even for the owner', async () => {
      await expect(
        withAdmin(cleanUrl, (db) =>
          db.query(
            `INSERT INTO canonical_model_versions (version, major, minor, status, released_at, catalogue_hash, adr)
             VALUES ('1.0', 1, 0, 'supported', now(), repeat('a', 64), '0027')`,
          ),
        ),
      ).rejects.toThrow(/canonical_model_versions_pre_freeze/);
    });

    it('every table named by ENTITY_INDEX_KINDS carries the three index triggers', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ table: string; trigger: string; enabled: string }>(
          `SELECT tgrelid::regclass::text AS table, tgname AS trigger, tgenabled AS enabled
             FROM pg_trigger WHERE NOT tgisinternal AND tgname ~ '_(entity_index_add|entity_index_remove|identity_immutable)$'`,
        ),
      );
      const expected = ENTITY_INDEX_KINDS.flatMap((k) =>
        entityIndexTriggerNames(ENTITY_INDEX_SOURCES[k].table).map(
          (t) => `${ENTITY_INDEX_SOURCES[k].table}.${t}`,
        ),
      ).sort();
      expect(rows.map((r) => `${r.table}.${r.trigger}`).sort()).toEqual(expected);
      expect(rows.every((r) => r.enabled === 'O')).toBe(true);
    });

    it('the index functions are SECURITY DEFINER, fixed search_path, owned by lip_entity_indexer', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ name: string; definer: boolean; config: string[] | null; public: boolean }>(
          `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS public
             FROM pg_proc p WHERE p.proowner = 'lip_entity_indexer'::regrole ORDER BY 1`,
        ),
      );
      expect(rows).toEqual(
        ['app_entity_index_add', 'app_entity_index_remove'].map((name) => ({
          name,
          definer: true,
          config: ['search_path=pg_catalog, pg_temp'],
          public: false,
        })),
      );
      for (const r of rows) expect(SECURITY_DEFINER_FUNCTIONS).toContain(r.name);
    });

    it('lip_entity_indexer is powerless: NOLOGIN, no bypass, rights on the index only, not reachable from the app role', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<Record<string, boolean>>(`
          SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, rolinherit,
                 pg_has_role('lip_app', 'lip_entity_indexer', 'MEMBER') AS app_is_member,
                 pg_has_role('lip_entity_indexer', 'lip_app', 'MEMBER') AS indexer_is_app
            FROM pg_roles WHERE rolname = 'lip_entity_indexer'`),
      );
      expect(rows).toEqual([
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolinherit: false,
          app_is_member: false,
          indexer_is_app: false,
        },
      ]);
      const grants = await withAdmin(cleanUrl, (db) =>
        db.query<{ v: string }>(
          `SELECT table_name || ':' || privilege_type AS v FROM information_schema.table_privileges
            WHERE grantee = 'lip_entity_indexer' ORDER BY 1`,
        ),
      );
      expect(grants.rows.map((r) => r.v)).toEqual([
        'tenant_entity_index:DELETE',
        'tenant_entity_index:INSERT',
        'tenant_entity_index:SELECT',
      ]);
      expect(PRIVILEGE_MANIFEST['tenant_entity_index']).toEqual(['SELECT']);
    });

    it('every polymorphic column set (<p>_kind + <p>_id) references the entity index by id and by key', async () => {
      // Actor columns name a security actor, not an entity. tenant_context_changes
      // predates the index (M6): its entity columns are a historical log that
      // outlives physical deletes, recorded in ADR 0027 as the one exception.
      const NOT_ENTITY_REFERENCES = ['actor', 'updated_by'];
      const LEGACY = ['tenant_context_changes.entity'];
      const pairs = await withAdmin(cleanUrl, (db) =>
        db.query<{ table: string; prefix: string; has_key: boolean }>(
          `SELECT k.table_name AS table, regexp_replace(k.column_name, '_kind$', '') AS prefix,
                  EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public'
                            AND c.table_name = k.table_name
                            AND c.column_name = regexp_replace(k.column_name, '_kind$', '') || '_key') AS has_key
             FROM information_schema.columns k
             JOIN information_schema.columns i ON i.table_schema = k.table_schema AND i.table_name = k.table_name
                  AND i.column_name = regexp_replace(k.column_name, '_kind$', '') || '_id'
            WHERE k.table_schema = 'public' AND k.column_name LIKE '%\\_kind'`,
        ),
      );
      const polymorphic = pairs.rows.filter(
        (p) =>
          !NOT_ENTITY_REFERENCES.includes(p.prefix) && !LEGACY.includes(`${p.table}.${p.prefix}`),
      );
      expect(polymorphic.map((p) => `${p.table}.${p.prefix}`)).toContain(
        'tenant_value_history.entity',
      );
      const fks = await withAdmin(cleanUrl, (db) =>
        db.query<{ table: string; columns: string[]; ref: string; on_delete: string }>(
          `SELECT c.conrelid::regclass::text AS table,
                  (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
                  c.confrelid::regclass::text AS ref, c.confdeltype AS on_delete
             FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = 'tenant_entity_index'::regclass`,
        ),
      );
      for (const p of polymorphic) {
        const mine = fks.rows.filter((f) => f.table === p.table);
        expect(mine.map((f) => f.columns.join(',')).sort(), `${p.table}.${p.prefix}`).toEqual(
          [
            `tenant_id,${p.prefix}_kind,${p.prefix}_id`,
            ...(p.has_key ? [`tenant_id,${p.prefix}_kind,${p.prefix}_key`] : []),
          ].sort(),
        );
        expect(mine.every((f) => f.on_delete === 'r')).toBe(true); // ON DELETE RESTRICT
      }
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

    it('M10A1: the audit capability and action CHECKs equal the code catalogues (closed sets)', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ name: string; def: string }>(
          `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname IN ('tenant_audit_events_capability_valid', 'tenant_audit_events_action_valid')`,
        ),
      );
      const values = (name: string) =>
        [...rows.find((r) => r.name === name)!.def.matchAll(/'([a-z_.]+)'::text/g)]
          .map((m) => m[1]!)
          .sort();
      expect(values('tenant_audit_events_capability_valid')).toEqual([...CAPABILITIES].sort());
      expect(values('tenant_audit_events_action_valid')).toEqual([...AUDIT_ACTIONS].sort());
    });

    it('M10A1: SECURITY DEFINER functions are exactly the allow-list', async () => {
      const { rows } = await withAdmin(cleanUrl, (db) =>
        db.query<{ name: string }>(
          `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`,
        ),
      );
      expect(rows.map((r) => r.name)).toEqual([...SECURITY_DEFINER_FUNCTIONS]);
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
          // Later milestones roll back first (M8, M7), then M6.
          await rollbackToM7(db);
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
          await rollbackToM7(db);
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

  describe('upgrading from the Milestone 7 state (M8 migrations on existing data)', () => {
    const tenant = '77777777-7777-4777-8777-777777777777';
    const templateRows = JSON.parse(
      readFileSync(resolve('../../docs/integrations/sugar/lead-handover-field-intent.md'), 'utf8')
        .split('```json')[1]!
        .split('```')[0]!,
    ) as {
      system: string;
      objectType: string;
      canonicalEntity: string;
      canonicalField: string;
      externalField: string | null;
      direction: string;
      status: string;
      notes: string;
    }[];
    async function seedLegacy(url: string, mutate?: (rows: typeof templateRows) => void) {
      const rows = templateRows.map((r) => ({ ...r }));
      mutate?.(rows);
      await withAdmin(url, async (db) => {
        await db.query(
          `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'mseven', 'M7', now())`,
          [tenant],
        );
        for (const r of rows) {
          await db.query(
            `INSERT INTO tenant_field_mappings (tenant_id, system, object_type, canonical_entity, canonical_field, external_field, direction, status, notes, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
            [
              tenant,
              r.system,
              r.objectType,
              r.canonicalEntity,
              r.canonicalField,
              r.externalField,
              r.direction,
              r.status,
              r.notes,
            ],
          );
        }
      });
    }
    const tableExists = (url: string) =>
      withAdmin(
        url,
        async (db) =>
          (await db.query(`SELECT to_regclass('public.tenant_field_mappings') AS t`)).rows[0]!.t as
            string | null,
      );

    it('the intent document preserves exactly the ten template rows', () => {
      expect(templateRows).toHaveLength(10);
      expect(templateRows.every((r) => r.system === 'sugar' && r.objectType === 'Leads')).toBe(
        true,
      );
      expect(
        templateRows.filter((r) => r.status === 'tbc').every((r) => r.externalField === null),
      ).toBe(true);
    });

    it('retires tenant_field_mappings when every row is a documented template row', async () => {
      const url = await createDatabase(pg, 'm8_retire_ok_db');
      const dir = resolve('test/.tmp/m7-state-ok');
      try {
        await migrate(url, ['--config', m7MigrationsConfig(dir)]);
        await seedLegacy(url);
        const output = await migrate(url);
        expect(output).toMatch(/20261020110000_m8_retire_tenant_field_mappings/);
        expect(await tableExists(url)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      [
        'a confirmed row',
        (rows: typeof templateRows) => {
          rows[0]!.status = 'confirmed';
        },
        /confirmed field mappings exist/,
      ],
      [
        'an edited row',
        (rows: typeof templateRows) => {
          rows[1]!.notes = 'changed by an operator';
        },
        /differ from the documented template rows/,
      ],
      [
        'an extra row',
        (rows: typeof templateRows) => {
          rows.push({ ...rows[1]!, canonicalField: 'extra_field' });
        },
        /differ from the documented template rows/,
      ],
    ])('refuses (and keeps the table) with %s', async (_label, mutate, message) => {
      const url = await createDatabase(
        pg,
        `m8_retire_refuse_${Math.random().toString(36).slice(2, 8)}`,
      );
      const dir = resolve(`test/.tmp/m7-state-${Math.random().toString(36).slice(2, 8)}`);
      try {
        await migrate(url, ['--config', m7MigrationsConfig(dir)]);
        await seedLegacy(url, mutate);
        await expect(migrate(url)).rejects.toThrow(message);
        expect(await tableExists(url)).toBe('tenant_field_mappings');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the M8 down-scripts restore exactly the M7 schema and M8 re-applies', async () => {
      const m7Url = await createDatabase(pg, 'm7_reference_db');
      const url = await createDatabase(pg, 'm8_down_db');
      const dir = resolve('test/.tmp/m7-reference');
      try {
        await migrate(m7Url, ['--config', m7MigrationsConfig(dir)]);
        await migrate(url);
        const latest = await schemaSnapshot(url);
        await withAdmin(url, (db) => rollbackToM7(db));
        expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(m7Url));
        const output = await migrate(url);
        for (const name of M8_MIGRATIONS) expect(output).toMatch(new RegExp(name));
        expect(await schemaSnapshot(url)).toEqual(latest);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('connector-kind catalogue and source connections (M8 migration on M7 data)', () => {
    const tenantA = '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a';
    const tenantB = '7b7b7b7b-7b7b-47b7-87b7-7b7b7b7b7b7b';
    const company = '7c7c7c7c-7c7c-47c7-87c7-7c7c7c7c7c7c';
    const importRun = '7d7d7d7d-7d7d-47d7-87d7-7d7d7d7d7d7d';
    const hubspotRun = '7e7e7e7e-7e7e-47e7-87e7-7e7e7e7e7e7e';
    let url: string;
    let before: { refs: string[]; runs: string[]; changes: string[] };

    const values = (u: string) =>
      withAdmin(u, async (db) => ({
        refs: (
          await db.query<{ v: string }>(
            `SELECT tenant_id || ' ' || system || ' ' || object_type || ' ' || external_id AS v FROM company_external_refs ORDER BY 1`,
          )
        ).rows.map((r) => r.v),
        runs: (
          await db.query<{ v: string }>(
            `SELECT id || ' ' || system || ' ' || kind || ' ' || mode || ' ' || status AS v FROM tenant_sync_checkpoints ORDER BY 1`,
          )
        ).rows.map((r) => r.v),
        changes: (
          await db.query<{ v: string }>(
            `SELECT id || ' ' || source_system || ' ' || source_record_id AS v FROM tenant_context_changes ORDER BY 1`,
          )
        ).rows.map((r) => r.v),
      }));

    /** Runs `sql` as the application role inside a rolled-back transaction. */
    const asApp = (u: string, sql: string) =>
      withAdmin(u, async (db) => {
        await db.query('BEGIN');
        try {
          await db.query('SET LOCAL ROLE lip_app');
          await db.query(sql);
        } finally {
          await db.query('ROLLBACK');
        }
      });

    beforeAll(async () => {
      url = await createDatabase(pg, 'm8_connectors_db');
      const dir = resolve('test/.tmp/m7-state-connectors');
      try {
        await migrate(url, ['--config', m7MigrationsConfig(dir)]);
        await withAdmin(url, async (db) => {
          await db.query(
            `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'msevena', 'A', now()), ($2, 'msevenb', 'B', now())`,
            [tenantA, tenantB],
          );
          await db.query(
            `INSERT INTO tenant_integrations (tenant_id, system, access, updated_at)
             VALUES ($1, 'hubspot', 'read_only', now()), ($2, 'hubspot', 'disabled', now()), ($2, 'sugar', 'read_only', now())`,
            [tenantA, tenantB],
          );
          await db.query(
            `INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES ($1, $2, 'School', now(), now())`,
            [company, tenantA],
          );
          await db.query(
            `INSERT INTO company_external_refs (tenant_id, system, object_type, external_id, company_id)
             VALUES ($1, 'hubspot', 'companies', '201', $2), ($1, 'sugar', 'Accounts', 'acc-1', $2)`,
            [tenantA, company],
          );
          await db.query(
            `INSERT INTO tenant_sync_checkpoints (tenant_id, id, system, kind, mode, status, correlation_id, completed_at)
             VALUES ($1, $2, 'import', 'subscription', 'import_full', 'completed', gen_random_uuid(), now()),
                    ($1, $3, 'hubspot', 'company', 'backfill', 'completed', gen_random_uuid(), now())`,
            [tenantA, importRun, hubspotRun],
          );
          await db.query(
            `INSERT INTO tenant_context_changes (tenant_id, id, entity_kind, entity_id, change_type, source_system,
               source_object_type, source_record_id, cause, adapter, adapter_version, correlation_id)
             VALUES ($1, gen_random_uuid(), 'company', $2, 'created', 'hubspot', 'companies', '201', 'backfill', 'hubspot', 'm6', gen_random_uuid())`,
            [tenantA, company],
          );
        });
        before = await values(url);
        const output = await migrate(url);
        expect(output).toMatch(/20261020120000_m8_connector_kinds_and_connections/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps every stored source-system value unchanged', async () => {
      expect(await values(url)).toEqual(before);
    });

    it('backfills an import connection per tenant and a hubspot connection only where HubSpot is configured', async () => {
      const { rows } = await withAdmin(url, (db) =>
        db.query<{ tenant_id: string; kind: string; status: string; mapping_mode: string }>(
          'SELECT tenant_id, kind, status, mapping_mode FROM tenant_source_connections ORDER BY tenant_id, kind',
        ),
      );
      expect(rows).toEqual([
        { tenant_id: tenantA, kind: 'hubspot', status: 'enabled', mapping_mode: 'code' },
        { tenant_id: tenantA, kind: 'import', status: 'enabled', mapping_mode: 'code' },
        { tenant_id: tenantB, kind: 'import', status: 'enabled', mapping_mode: 'code' },
      ]);
    });

    it('links existing import runs to the import connection and leaves other history untouched', async () => {
      const { rows } = await withAdmin(url, (db) =>
        db.query<{ id: string; kind: string | null }>(
          `SELECT c.id, s.kind FROM tenant_sync_checkpoints c
             LEFT JOIN tenant_source_connections s ON s.tenant_id = c.tenant_id AND s.id = c.source_connection_id
            ORDER BY c.id`,
        ),
      );
      expect(rows).toEqual([
        { id: importRun, kind: 'import' },
        { id: hubspotRun, kind: null },
      ]);
      const changes = await withAdmin(url, (db) =>
        db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM tenant_context_changes WHERE source_connection_id IS NOT NULL OR mapping_version IS NOT NULL',
        ),
      );
      expect(changes.rows[0]!.n).toBe(0);
    });

    it('refuses an unknown connector kind on every source-system column (foreign key)', async () => {
      await expect(
        withAdmin(url, (db) =>
          db.query(
            `INSERT INTO company_external_refs (tenant_id, system, object_type, external_id, company_id)
             VALUES ($1, 'salesforce', 'Account', 'x', $2)`,
            [tenantA, company],
          ),
        ),
      ).rejects.toThrow(/company_external_refs_system_fkey/);
      await expect(
        withAdmin(url, (db) =>
          db.query(
            `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, mapping_mode)
             VALUES ($1, gen_random_uuid(), 'salesforce', 'SF', 'versioned')`,
            [tenantB],
          ),
        ),
      ).rejects.toThrow(/tenant_source_connections_kind_fkey/);
    });

    it('keeps `import` out of external references, relationships and dead-letter subjects', async () => {
      await expect(
        withAdmin(url, (db) =>
          db.query(
            `INSERT INTO company_external_refs (tenant_id, system, object_type, external_id, company_id)
             VALUES ($1, 'import', 'rows', 'x', $2)`,
            [tenantA, company],
          ),
        ),
      ).rejects.toThrow(/company_external_refs_system_not_import/);
    });

    it('allows one connection per tenant and kind', async () => {
      await expect(
        withAdmin(url, (db) =>
          db.query(
            `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, mapping_mode)
             VALUES ($1, gen_random_uuid(), 'import', 'Second', 'code')`,
            [tenantA],
          ),
        ),
      ).rejects.toThrow(/tenant_source_connections_tenant_id_kind_key/);
    });

    it.each([
      ['a top-level secret-like key', { apiToken: 'x' }],
      ['a nested secret-like key', { oauth: { client_secret: 'x' } }],
      ['a secret-like key inside an array', { endpoints: [{ password: 'x' }] }],
      ['a separator-disguised key', { 'Pass-Word': 'x' }],
    ])('refuses connection config with %s', async (_label, config) => {
      await expect(
        withAdmin(url, (db) =>
          db.query(
            `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, mapping_mode, config)
             VALUES ($1, gen_random_uuid(), 'sugar', 'Sugar', 'versioned', $2)`,
            [tenantB, JSON.stringify(config)],
          ),
        ),
      ).rejects.toThrow(/tenant_source_connections_config_no_secrets/);
    });

    it('accepts non-secret config and refuses a credential name that is not registered for the tenant and kind', async () => {
      await withAdmin(url, async (db) => {
        await db.query('BEGIN');
        try {
          await db.query(
            `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, mapping_mode, config)
             VALUES ($1, gen_random_uuid(), 'sugar', 'Sugar', 'versioned', $2)`,
            [
              tenantB,
              JSON.stringify({ instanceUrl: 'https://crm.example.test', apiVersion: 'tbc' }),
            ],
          );
        } finally {
          await db.query('ROLLBACK');
        }
      });
      await expect(
        withAdmin(url, (db) =>
          db.query(
            `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, mapping_mode, credential_name)
             VALUES ($1, gen_random_uuid(), 'sugar', 'Sugar', 'versioned', 'sugar_oauth')`,
            [tenantB],
          ),
        ),
      ).rejects.toThrow(/tenant_source_connections_tenant_id_kind_credential_name_fkey/);
    });

    it('the application role may read the catalogue but never change it', async () => {
      await expect(asApp(url, 'SELECT count(*) FROM connector_kinds')).resolves.toBeUndefined();
      for (const sql of [
        `INSERT INTO connector_kinds (kind, display_name, has_adapter) VALUES ('salesforce', 'Salesforce', false)`,
        `UPDATE connector_kinds SET display_name = 'X' WHERE kind = 'sugar'`,
        `DELETE FROM connector_kinds WHERE kind = 'gainsight_px'`,
      ]) {
        await expect(asApp(url, sql)).rejects.toThrow(/permission denied/);
      }
    });

    it.each([
      [
        'a connection the migration did not create',
        `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, mapping_mode)
         VALUES ('${tenantB}', gen_random_uuid(), 'sugar', 'Sugar', 'versioned')`,
        /source connections beyond the backfilled ones/,
      ],
      [
        'a configured backfilled connection',
        `UPDATE tenant_source_connections SET config = '{"note":"x"}' WHERE tenant_id = '${tenantA}' AND kind = 'hubspot'`,
        /source connections beyond the backfilled ones/,
      ],
      [
        'provenance that references a connection',
        `UPDATE tenant_context_changes SET source_connection_id =
           (SELECT id FROM tenant_source_connections WHERE tenant_id = '${tenantA}' AND kind = 'hubspot')`,
        /provenance rows reference a connection/,
      ],
      [
        'a run with quality data',
        `UPDATE tenant_sync_checkpoints SET quality = '{}' WHERE id = '${importRun}'`,
        /runs reference a connection, mapping version or quality/,
      ],
    ])('the down-script refuses (and changes nothing) with %s', async (_label, sql, message) => {
      const target = await createDatabase(
        pg,
        `m8_conn_down_${Math.random().toString(36).slice(2, 8)}`,
      );
      await migrate(target);
      // Newest first: M10A2, M10A1, then the M9B down-scripts, before any older one.
      await rollbackM10A2(target);
      await withAdmin(target, (db) => db.query(readFileSync(M10A1_DOWN, 'utf8')));
      await withAdmin(target, (db) => db.query(readFileSync(M9B_RETIRE_DOWN, 'utf8')));
      await withAdmin(target, (db) => db.query(readFileSync(M9B_DOWN, 'utf8')));
      await withAdmin(target, async (db) => {
        await db.query(
          `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'msevena', 'A', now()), ($2, 'msevenb', 'B', now())`,
          [tenantA, tenantB],
        );
        await db.query(
          `INSERT INTO tenant_integrations (tenant_id, system, access, updated_at) VALUES ($1, 'hubspot', 'read_only', now())`,
          [tenantA],
        );
        await db.query(
          `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, status, mapping_mode)
           VALUES ($1, gen_random_uuid(), 'import', 'Operator import (CSV)', 'enabled', 'code'),
                  ($2, gen_random_uuid(), 'import', 'Operator import (CSV)', 'enabled', 'code'),
                  ($1, gen_random_uuid(), 'hubspot', 'HubSpot', 'enabled', 'code')`,
          [tenantA, tenantB],
        );
        await db.query(
          `INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES ($1, $2, 'School', now(), now())`,
          [company, tenantA],
        );
        await db.query(
          `INSERT INTO tenant_sync_checkpoints (tenant_id, id, system, kind, mode, status, correlation_id, completed_at, source_connection_id)
           VALUES ($1, $2, 'import', 'subscription', 'import_full', 'completed', gen_random_uuid(), now(),
                   (SELECT id FROM tenant_source_connections WHERE tenant_id = $1 AND kind = 'import'))`,
          [tenantA, importRun],
        );
        await db.query(
          `INSERT INTO tenant_context_changes (tenant_id, id, entity_kind, entity_id, change_type, source_system,
             source_object_type, source_record_id, cause, adapter, adapter_version, correlation_id)
           VALUES ($1, gen_random_uuid(), 'company', $2, 'created', 'hubspot', 'companies', '201', 'backfill', 'hubspot', 'm6', gen_random_uuid())`,
          [tenantA, company],
        );
        await db.query(sql);
      });
      const snapshot = await schemaSnapshot(target);
      const down = readFileSync(
        resolve('prisma/rollback/20261020120000_m8_connector_kinds_and_connections.down.sql'),
        'utf8',
      );
      await expect(withAdmin(target, (db) => db.query(down))).rejects.toThrow(message);
      expect(await schemaSnapshot(target)).toEqual(snapshot);
    });

    it('the down-script succeeds on backfilled-only data and restores the M7 CHECK lists', async () => {
      const target = await createDatabase(pg, 'm8_conn_down_ok');
      await migrate(target);
      await withAdmin(target, async (db) => {
        await db.query(
          `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'msevena', 'A', now())`,
          [tenantA],
        );
        await db.query(
          `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, status, mapping_mode)
           VALUES ($1, gen_random_uuid(), 'import', 'Operator import (CSV)', 'enabled', 'code')`,
          [tenantA],
        );
        // Later down-scripts first (newest first), then this one.
        for (const file of POST_M7_DOWNS) {
          await db.query(readFileSync(file, 'utf8'));
          if (file.includes('20261020120000_m8_connector_kinds_and_connections')) break;
        }
      });
      const { rows } = await withAdmin(target, (db) =>
        db.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'company_external_refs_system_valid'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.def).toMatch(/hubspot.*sugar.*gainsight_cs.*gainsight_px/);
    });
  });

  describe('schema snapshots, mappings, authority and gaps (M8 migration on M7 data)', () => {
    const tenantA = '8a8a8a8a-8a8a-48a8-88a8-8a8a8a8a8a8a';
    const tenantB = '8b8b8b8b-8b8b-48b8-88b8-8b8b8b8b8b8b';
    let url: string;

    beforeAll(async () => {
      url = await createDatabase(pg, 'm8_authority_db');
      const dir = resolve('test/.tmp/m7-state-authority');
      try {
        await migrate(url, ['--config', m7MigrationsConfig(dir)]);
        await withAdmin(url, async (db) => {
          await db.query(
            `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'meighta', 'A', now()), ($2, 'meightb', 'B', now())`,
            [tenantA, tenantB],
          );
          await db.query(
            `INSERT INTO tenant_integrations (tenant_id, system, access, updated_at) VALUES ($1, 'hubspot', 'read_only', now())`,
            [tenantA],
          );
        });
        await migrate(url);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('seeds authority version 1 per tenant: subscriptions to import, profiles to HubSpot where configured', async () => {
      const { rows } = await withAdmin(url, (db) =>
        db.query<Record<string, string | null>>(
          `SELECT a.tenant_id, a.version, ap.kind AS account_profile, pp.kind AS person_profile,
                  sl.kind AS lines, ss.kind AS state, st.kind AS terms, a.content_hash, a.published_by
             FROM tenant_source_authority_versions a
             LEFT JOIN tenant_source_connections ap ON ap.tenant_id = a.tenant_id AND ap.id = a.account_profile_connection_id
             LEFT JOIN tenant_source_connections pp ON pp.tenant_id = a.tenant_id AND pp.id = a.person_profile_connection_id
             LEFT JOIN tenant_source_connections sl ON sl.tenant_id = a.tenant_id AND sl.id = a.subscription_lines_connection_id
             LEFT JOIN tenant_source_connections ss ON ss.tenant_id = a.tenant_id AND ss.id = a.subscription_state_connection_id
             LEFT JOIN tenant_source_connections st ON st.tenant_id = a.tenant_id AND st.id = a.subscription_terms_connection_id
            ORDER BY a.tenant_id`,
        ),
      );
      expect(rows.map(({ content_hash: _h, ...r }) => r)).toEqual([
        {
          tenant_id: tenantA,
          version: 1,
          account_profile: 'hubspot',
          person_profile: 'hubspot',
          lines: 'import',
          state: 'import',
          terms: 'import',
          published_by: 'migration:m8',
        },
        {
          tenant_id: tenantB,
          version: 1,
          account_profile: null,
          person_profile: null,
          lines: 'import',
          state: 'import',
          terms: 'import',
          published_by: 'migration:m8',
        },
      ]);
    });

    it('the seeded content hash equals the service hash (same positional rule)', async () => {
      const { rows } = await withAdmin(url, (db) =>
        db.query<{
          a: string | null;
          p: string | null;
          l: string | null;
          s: string | null;
          t: string | null;
          content_hash: string;
        }>(
          `SELECT account_profile_connection_id AS a, person_profile_connection_id AS p,
                  subscription_lines_connection_id AS l, subscription_state_connection_id AS s,
                  subscription_terms_connection_id AS t, content_hash FROM tenant_source_authority_versions`,
        ),
      );
      for (const r of rows) {
        expect(
          authorityContentHash({
            facts: {
              account_profile: r.a,
              person_profile: r.p,
              subscription_lines: r.l,
              subscription_state: r.s,
              subscription_terms: r.t,
            },
          }),
        ).toBe(r.content_hash);
      }
    });

    it.each([
      [
        'a schema snapshot',
        `INSERT INTO tenant_source_schema_snapshots (tenant_id, connection_id, hash, document, captured_by)
         SELECT tenant_id, id, repeat('a', 64), '{"objects":[]}', 'test' FROM tenant_source_connections WHERE kind = 'import' LIMIT 1`,
        /schema snapshots exist/,
      ],
      [
        'a published authority version beyond the default',
        `INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version, content_hash, published_by)
         VALUES ('${tenantB}', 2, 1, repeat('b', 64), 'test')`,
        /authority versions beyond the default/,
      ],
    ])('the down-script refuses (and changes nothing) with %s', async (_label, sql, message) => {
      const target = await createDatabase(
        pg,
        `m8_auth_down_${Math.random().toString(36).slice(2, 8)}`,
      );
      await migrate(target);
      await withAdmin(target, async (db) => {
        await db.query(
          `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'meightb', 'B', now())`,
          [tenantB],
        );
        await db.query(
          `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, status, mapping_mode)
           VALUES ($1, gen_random_uuid(), 'import', 'Operator import (CSV)', 'enabled', 'code')`,
          [tenantB],
        );
        await db.query(
          `INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version, content_hash, published_by)
           VALUES ($1, 1, 0, repeat('c', 64), 'provisioning')`,
          [tenantB],
        );
        await db.query(sql);
      });
      const snapshot = await schemaSnapshot(target);
      const down = readFileSync(
        resolve('prisma/rollback/20261020130000_m8_schema_snapshots_mappings_authority.down.sql'),
        'utf8',
      );
      await expect(withAdmin(target, (db) => db.query(down))).rejects.toThrow(message);
      expect(await schemaSnapshot(target)).toEqual(snapshot);
    });
  });

  describe('source profiling (M9A migration on M8 data)', () => {
    const tenantA = '9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a';
    const SNAP = 'e'.repeat(64);

    /** An M8 database with one tenant, its import connection and a schema snapshot. */
    async function m8Database(name: string): Promise<string> {
      const target = await createDatabase(pg, name);
      const dir = resolve(`test/.tmp/${name}`);
      try {
        await migrate(target, ['--config', m8MigrationsConfig(dir)]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      await withAdmin(target, async (db) => {
        await db.query(
          `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'mninea', 'A', now())`,
          [tenantA],
        );
        await db.query(
          `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, status, mapping_mode)
           VALUES ($1, gen_random_uuid(), 'import', 'Operator import (CSV)', 'enabled', 'code')`,
          [tenantA],
        );
        const { rows } = await db.query<{ id: string }>(
          `SELECT id FROM tenant_source_connections WHERE tenant_id = $1`,
          [tenantA],
        );
        const hash = authorityContentHash({
          facts: {
            account_profile: null,
            person_profile: null,
            subscription_lines: rows[0]!.id,
            subscription_state: rows[0]!.id,
            subscription_terms: rows[0]!.id,
          },
        });
        await db.query(
          `INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version,
             subscription_lines_connection_id, subscription_state_connection_id, subscription_terms_connection_id,
             content_hash, published_by)
           VALUES ($1, 1, 0, $2, $2, $2, $3, 'provisioning')`,
          [tenantA, rows[0]!.id, hash],
        );
        await db.query(
          `INSERT INTO tenant_source_schema_snapshots (tenant_id, connection_id, hash, document, captured_by)
           VALUES ($1, $2, $3, '{"objects":[]}', 'test')`,
          [tenantA, rows[0]!.id, SNAP],
        );
      });
      return target;
    }

    it('applies on M8 data: existing authority versions get empty acceptances and keep their hash', async () => {
      const target = await m8Database('m9a_on_m8');
      const before = await withAdmin(target, (db) =>
        db.query<{ content_hash: string }>(
          'SELECT content_hash FROM tenant_source_authority_versions',
        ),
      );
      const output = await migrate(target);
      expect(output).toMatch(new RegExp(M9A_MIGRATIONS[0]!));
      const { rows } = await withAdmin(target, (db) =>
        db.query<{ content_hash: string; proof_acceptances: unknown }>(
          'SELECT content_hash, proof_acceptances FROM tenant_source_authority_versions',
        ),
      );
      expect(rows).toEqual(
        before.rows.map((r) => ({ content_hash: r.content_hash, proof_acceptances: [] })),
      );
    });

    it('refuses to apply when an existing authority hash does not match the M8 rule (parity check can fail)', async () => {
      const target = await m8Database('m9a_parity_fail');
      await withAdmin(target, (db) =>
        db.query(
          `INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version, content_hash, published_by)
           VALUES ($1, 2, 1, repeat('f', 64), 'test')`,
          [tenantA],
        ),
      );
      await expect(migrate(target)).rejects.toThrow(/authority hash parity failed for 1 versions/);
    });

    it('the M9A down-script restores exactly the M8 schema and M9A re-applies', async () => {
      const m8Url = await createDatabase(pg, 'm8_reference_db');
      const url = await createDatabase(pg, 'm9a_down_db');
      const dir = resolve('test/.tmp/m8-reference');
      try {
        await migrate(m8Url, ['--config', m8MigrationsConfig(dir)]);
        await migrate(url);
        const latest = await schemaSnapshot(url);
        // Newest first: M10A2, M10A1, M9B (retirement, then the connector kind), then M9A.
        await rollbackM10A2(url);
        await withAdmin(url, (db) => db.query(readFileSync(M10A1_DOWN, 'utf8')));
        await withAdmin(url, (db) => db.query(readFileSync(M9B_RETIRE_DOWN, 'utf8')));
        await withAdmin(url, (db) => db.query(readFileSync(M9B_DOWN, 'utf8')));
        await withAdmin(url, (db) => db.query(readFileSync(M9A_DOWN, 'utf8')));
        expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(m8Url));
        const output = await migrate(url);
        expect(output).toMatch(new RegExp(M9A_MIGRATIONS[0]!));
        expect(await schemaSnapshot(url)).toEqual(latest);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Gap and snapshot rows need companies, products and models; their FKs are
    // irrelevant to the refusal, so those two cases seed in replica mode.
    const replica = (sql: string) =>
      `SET session_replication_role = replica; ${sql}; SET session_replication_role = origin`;
    it.each([
      [
        'a profile run',
        `INSERT INTO tenant_source_profile_runs (tenant_id, id, connection_id, schema_snapshot_hash, active_key, request, requested_by, correlation_id)
         SELECT tenant_id, gen_random_uuid(), connection_id, hash, connection_id::text, '{}', 'test', gen_random_uuid()
           FROM tenant_source_schema_snapshots LIMIT 1`,
        /profile runs exist/,
      ],
      [
        'an ownership gap with an M9A reason',
        replica(
          `INSERT INTO tenant_ownership_gaps (tenant_id, connection_id, source_object_type, source_record_id, company_id, reason, checkpoint_id)
           SELECT tenant_id, id, 'RevenueLineItems', 'r1', gen_random_uuid(), 'observation_rejected', gen_random_uuid()
             FROM tenant_source_connections LIMIT 1`,
        ),
        /ownership gaps use an M9A reason/,
      ],
      [
        'a proof acceptance',
        `INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version, content_hash, published_by, proof_acceptances)
         SELECT tenant_id, 2, 1, repeat('a', 64), 'test',
                jsonb_build_array(jsonb_build_object('tier', 'stable_snapshot', 'connectionId', id, 'reason', 'r', 'actor', 'test'))
           FROM tenant_source_connections LIMIT 1`,
        /authority versions carry proof acceptances/,
      ],
      [
        'a mapping version with a reviewed holding domain',
        `INSERT INTO tenant_source_mapping_versions (tenant_id, connection_id, version, base_version, document, content_hash, schema_snapshot_hash, authority_version, published_by)
         SELECT tenant_id, connection_id, 1, 0,
                '{"objects":[{"holdingFilter":{"field":"s","operator":"in","values":["x"],"reviewedDomain":{}}}]}',
                repeat('b', 64), hash, 1, 'test'
           FROM tenant_source_schema_snapshots LIMIT 1`,
        /mapping versions carry a reviewed holding domain/,
      ],
      [
        'an evaluator v3 eligibility snapshot',
        replica(
          `INSERT INTO tenant_eligibility_snapshots (tenant_id, id, requested_company_id, evaluated_company_id, product_key, as_of, status, ownership, model_version, model_hash, evaluator_version, facts_hash, result, purpose, correlation_id)
           VALUES ('${tenantA}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'core', now(), 'unknown', 'unknown', 1, repeat('c', 64), 3, repeat('d', 64), '{}', 'test', gen_random_uuid())`,
        ),
        /eligibility snapshots were written by evaluator v3/,
      ],
    ])(
      'the M9A down-script refuses (and changes nothing) with %s',
      async (_label, sql, message) => {
        const target = await m8Database(`m9a_down_${Math.random().toString(36).slice(2, 8)}`);
        await migrate(target);
        await withAdmin(target, (db) => db.query(sql));
        const snapshot = await schemaSnapshot(target);
        await expect(
          withAdmin(target, (db) => db.query(readFileSync(M9A_DOWN, 'utf8'))),
        ).rejects.toThrow(message);
        expect(await schemaSnapshot(target)).toEqual(snapshot);
      },
    );
  });

  describe('chargebee connector kind (M9B reference data)', () => {
    const tenant = '9b9b9b9b-9b9b-49b9-89b9-9b9b9b9b9b9b';
    const kinds = (url: string) =>
      withAdmin(url, (db) =>
        db.query<{ kind: string; display_name: string; has_adapter: boolean }>(
          'SELECT kind, display_name, has_adapter FROM connector_kinds ORDER BY kind',
        ),
      ).then((r) => r.rows);

    it('the M9B down-script refuses while a tenant row names the kind, then restores exactly the M9A state and re-applies', async () => {
      const m9aUrl = await createDatabase(pg, 'm9a_reference_db');
      const url = await createDatabase(pg, 'm9b_down_db');
      const dir = resolve('test/.tmp/m9a-reference');
      try {
        await migrate(m9aUrl, ['--config', migrationsBefore(dir, '20261115')]);
        await migrate(url);
        const latest = await schemaSnapshot(url);
        expect((await kinds(url)).map((k) => k.kind)).toContain('chargebee');
        await withAdmin(url, async (db) => {
          await db.query(
            `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'mninebee', 'B', now())`,
            [tenant],
          );
          await db.query(
            `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, status, mapping_mode)
             VALUES ($1, gen_random_uuid(), 'chargebee', 'Chargebee', 'disabled', 'versioned')`,
            [tenant],
          );
        });
        // A chargebee credential NAME can be registered; read_write access never can.
        await withAdmin(url, async (db) => {
          await db.query(
            `INSERT INTO tenant_credential_refs (tenant_id, tenant_slug, system, name, secret_key, updated_at)
             VALUES ($1, 'mninebee', 'chargebee', 'chargebee_api', 'tenant.mninebee.chargebee.chargebee_api', now())`,
            [tenant],
          );
          await db.query(
            `INSERT INTO tenant_integrations (tenant_id, system, access, updated_at) VALUES ($1, 'chargebee', 'read_only', now())`,
            [tenant],
          );
        });
        await expect(
          withAdmin(url, (db) =>
            db.query(
              `UPDATE tenant_integrations SET access = 'read_write' WHERE tenant_id = $1 AND system = 'chargebee'`,
              [tenant],
            ),
          ),
        ).rejects.toThrow(/tenant_integrations_chargebee_read_only/);
        await expect(
          withAdmin(m9aUrl, async (db) => {
            await db.query(
              `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'mninebee', 'B', now())`,
              [tenant],
            );
            await db.query(
              `INSERT INTO tenant_credential_refs (tenant_id, tenant_slug, system, name, secret_key, updated_at)
               VALUES ($1, 'mninebee', 'chargebee', 'chargebee_api', 'tenant.mninebee.chargebee.chargebee_api', now())`,
              [tenant],
            );
          }),
        ).rejects.toThrow(/tenant_credential_refs_system_valid/);
        await withAdmin(m9aUrl, (db) => db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]));
        // Newest first: M10A2, M10A1, the retirement down-script (nothing retired here), then the kind.
        await rollbackM10A2(url);
        await withAdmin(url, (db) => db.query(readFileSync(M10A1_DOWN, 'utf8')));
        await withAdmin(url, (db) => db.query(readFileSync(M9B_RETIRE_DOWN, 'utf8')));
        await expect(
          withAdmin(url, (db) => db.query(readFileSync(M9B_DOWN, 'utf8'))),
        ).rejects.toThrow(/refusing rollback: 3 rows still name the chargebee connector kind/);
        expect((await kinds(url)).map((k) => k.kind)).toContain('chargebee');
        await withAdmin(url, async (db) => {
          await db.query(`DELETE FROM tenant_source_connections WHERE kind = 'chargebee'`);
          await db.query(`DELETE FROM tenant_integrations WHERE system = 'chargebee'`);
        });
        await expect(
          withAdmin(url, (db) => db.query(readFileSync(M9B_DOWN, 'utf8'))),
        ).rejects.toThrow(/refusing rollback: 1 rows still name the chargebee connector kind/);
        await withAdmin(url, (db) =>
          db.query(`DELETE FROM tenant_credential_refs WHERE system = 'chargebee'`),
        );
        await withAdmin(url, (db) => db.query(readFileSync(M9B_DOWN, 'utf8')));
        expect(await kinds(url)).toEqual(await kinds(m9aUrl));
        expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(m9aUrl));
        const output = await migrate(url);
        expect(output).toMatch(new RegExp(M9B_MIGRATIONS[0]!));
        expect(output).toMatch(new RegExp(M9B_MIGRATIONS[1]!));
        expect(await schemaSnapshot(url)).toEqual(latest);
        expect(await kinds(url)).toContainEqual({
          kind: 'chargebee',
          display_name: 'Chargebee',
          has_adapter: true,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('source reference retirement (M9B governed correction)', () => {
    const tenant = '9c9c9c9c-9c9c-49c9-89c9-9c9c9c9c9c9c';
    const company = '9c9c9c9c-0000-49c9-89c9-9c9c9c9c9c9c';
    const run = '9c9c9c9c-1111-49c9-89c9-9c9c9c9c9c9c';
    const seed = (url: string) =>
      withAdmin(url, async (db) => {
        await db.query(
          `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'mninec', 'C', now())`,
          [tenant],
        );
        await db.query(
          `INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES ($1, $2, 'School', now(), now())`,
          [company, tenant],
        );
        await db.query(
          `INSERT INTO tenant_sync_checkpoints (tenant_id, id, system, kind, mode, status, correlation_id, completed_at)
           VALUES ($1, $2, 'chargebee', 'subscription', 'reconcile', 'completed', gen_random_uuid(), now())`,
          [tenant, run],
        );
        await db.query(
          `INSERT INTO company_external_refs (tenant_id, system, object_type, external_id, company_id)
           VALUES ($1, 'chargebee', 'Customers', 'cust_1', $2)`,
          [tenant, company],
        );
      });

    it('`retired` needs its time and run (and only then), the run must exist, and the row cannot lose the company', async () => {
      const url = await createDatabase(pg, 'm9b_retire_checks_db');
      await migrate(url);
      await seed(url);
      const set = (assignments: string) =>
        withAdmin(url, (db) =>
          db.query(
            `UPDATE company_external_refs SET ${assignments} WHERE tenant_id = $1 AND external_id = 'cust_1'`,
            [tenant],
          ),
        );
      await expect(set(`state = 'retired'`)).rejects.toThrow(
        /company_external_refs_retired_consistent/,
      );
      await expect(set(`state = 'retired', retired_at = now()`)).rejects.toThrow(
        /company_external_refs_retired_(consistent|partial)/,
      );
      await expect(set(`retired_at = now(), retired_by_run_id = '${run}'`)).rejects.toThrow(
        /company_external_refs_retired_consistent/,
      );
      await expect(
        set(`state = 'retired', retired_at = now(), retired_by_run_id = gen_random_uuid()`),
      ).rejects.toThrow(/company_external_refs_tenant_id_retired_by_run_id_fkey/);
      await expect(set(`state = 'gone'`)).rejects.toThrow(/company_external_refs_state_valid/);
      await set(`state = 'retired', retired_at = now(), retired_by_run_id = '${run}'`);
      // The retiring run cannot be removed while a reference names it.
      await expect(
        withAdmin(url, (db) =>
          db.query(`DELETE FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND id = $2`, [
            tenant,
            run,
          ]),
        ),
      ).rejects.toThrow(/company_external_refs_tenant_id_retired_by_run_id_fkey/);
      // Reactivation clears both together.
      await set(`state = 'active', retired_at = NULL, retired_by_run_id = NULL`);
    });

    it('the retirement down-script refuses while a reference is retired, then restores exactly the prior M9B state and re-applies', async () => {
      const before = await createDatabase(pg, 'm9b_kind_reference_db');
      const url = await createDatabase(pg, 'm9b_retire_down_db');
      const dir = resolve('test/.tmp/m9b-kind-reference');
      try {
        await migrate(before, ['--config', migrationsBefore(dir, '20261116')]);
        await migrate(url);
        const latest = await schemaSnapshot(url);
        // Newest first: M10A2 and M10A1 are rolled back before the M9B retirement down-script.
        await rollbackM10A2(url);
        await withAdmin(url, (db) => db.query(readFileSync(M10A1_DOWN, 'utf8')));
        await seed(url);
        await withAdmin(url, (db) =>
          db.query(
            `UPDATE company_external_refs SET state = 'retired', retired_at = now(), retired_by_run_id = $2
             WHERE tenant_id = $1`,
            [tenant, run],
          ),
        );
        await expect(
          withAdmin(url, (db) => db.query(readFileSync(M9B_RETIRE_DOWN, 'utf8'))),
        ).rejects.toThrow(/refusing rollback: 1 references are retired/);
        // Nothing changed: the reference is still retired and the columns still exist.
        const kept = await withAdmin(url, (db) =>
          db.query<{ state: string }>(
            `SELECT state FROM company_external_refs WHERE tenant_id = $1`,
            [tenant],
          ),
        );
        expect(kept.rows).toEqual([{ state: 'retired' }]);
        await withAdmin(url, (db) =>
          db.query(
            `UPDATE company_external_refs SET state = 'active', retired_at = NULL, retired_by_run_id = NULL
             WHERE tenant_id = $1`,
            [tenant],
          ),
        );
        await withAdmin(url, (db) => db.query(readFileSync(M9B_RETIRE_DOWN, 'utf8')));
        expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(before));
        const output = await migrate(url);
        expect(output).toMatch(new RegExp(M9B_MIGRATIONS[1]!));
        expect(await schemaSnapshot(url)).toEqual(latest);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('M10A1 security foundation migration', () => {
    it('applies on M9B data; the down-script refuses audit events, actor records and v2 ciphertexts, then restores exactly the M9B schema and re-applies', async () => {
      const before = await createDatabase(pg, 'm10a1_before_db');
      const url = await createDatabase(pg, 'm10a1_down_db');
      const dir = resolve('test/.tmp/m10a1-before');
      const m10a1Dir = resolve('test/.tmp/m10a1-state');
      try {
        await migrate(before, ['--config', migrationsBefore(dir, '20261201')]);
        // The M10A1 down-script is tested on the M10A1 state (M10A2 has its own test below).
        const m10a1Config = m10a1MigrationsConfig(m10a1Dir);
        await migrate(url, ['--config', m10a1Config]);
        const latest = await schemaSnapshot(url);
        const tenant = '00000000-0000-4000-8000-0000000a1a10';
        const hex = (c: string) => c.repeat(64);
        await withAdmin(url, async (db) => {
          await db.query(
            `INSERT INTO tenants (id, slug, name, updated_at) VALUES ($1, 'm10a1', 'M10A1', now())`,
            [tenant],
          );
          await db.query(`SELECT set_config('app.current_tenant', $1, false)`, [tenant]);
          await db.query(
            `INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance,
               capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
             VALUES ($1, gen_random_uuid(), 1, now(), 'operator', 'ops', 'asserted', 'config.policy', 'policy.save',
               'allowed', gen_random_uuid(), 1, '{}', $2, $3)`,
            [tenant, hex('0'), hex('a')],
          );
          // The value rules hold for the owner too.
          await expect(
            db.query(
              `INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance,
                 capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
               VALUES ($1, gen_random_uuid(), 2, now(), 'operator', 'ops', 'authenticated', 'config.policy', 'policy.save',
                 'allowed', gen_random_uuid(), 1, '{}', $2, $3)`,
              [tenant, hex('a'), hex('b')],
            ),
          ).rejects.toThrow(/tenant_audit_events_operator_asserted/);
          await expect(
            db.query(
              `INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance,
                 capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
               VALUES ($1, gen_random_uuid(), 2, now(), 'operator', 'ops', 'asserted', 'config.policy', 'policy.save',
                 'allowed', gen_random_uuid(), 1, $4, $2, $3)`,
              [tenant, hex('a'), hex('b'), JSON.stringify({ api_key: 'x' })],
            ),
          ).rejects.toThrow(/tenant_audit_events_details_no_secrets/);
          await expect(
            db.query(
              `INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance,
                 capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
               VALUES ($1, gen_random_uuid(), 2, now(), 'operator', 'ops', 'asserted', 'config.policy', 'policy.save',
                 'allowed', gen_random_uuid(), 1, $4, $2, $3)`,
              [tenant, hex('a'), hex('b'), JSON.stringify({ n: 'x'.repeat(4100) })],
            ),
          ).rejects.toThrow(/tenant_audit_events_details_object/);
          // Owner UPDATE meets the append-only trigger.
          await expect(
            db.query(`UPDATE tenant_audit_events SET action = 'policy.save' WHERE tenant_id = $1`, [
              tenant,
            ]),
          ).rejects.toThrow(/audit events are append-only/);
        });
        await expect(
          withAdmin(url, (db) => db.query(readFileSync(M10A1_DOWN, 'utf8'))),
        ).rejects.toThrow(/refusing rollback: 1 audit events exist/);
        expect(await schemaSnapshot(url)).toEqual(latest);
        await withAdmin(url, async (db) => {
          await db.query('BEGIN');
          await db.query(`SELECT set_config('lip.audit_purge', 'on', true)`);
          await db.query(`DELETE FROM tenant_audit_events WHERE tenant_id = $1`, [tenant]);
          await db.query('COMMIT');
          await db.query(
            `INSERT INTO tenant_oauth_tokens (tenant_id, system, account_id, refresh_token_enc, scopes, updated_at)
             VALUES ($1, 'hubspot', '1', $2, '{}', now())`,
            [tenant, `v2:k1:${'A'.repeat(40)}`],
          );
        });
        await expect(
          withAdmin(url, (db) => db.query(readFileSync(M10A1_DOWN, 'utf8'))),
        ).rejects.toThrow(/refusing rollback: 1 OAuth grants hold v2 ciphertexts/);
        await withAdmin(url, (db) =>
          db.query(`DELETE FROM tenant_oauth_tokens WHERE tenant_id = $1`, [tenant]),
        );
        await withAdmin(url, (db) => db.query(readFileSync(M10A1_DOWN, 'utf8')));
        expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(before));
        const output = await migrate(url, ['--config', m10a1Config]);
        expect(output).toMatch(new RegExp(M10A1_MIGRATIONS[0]!));
        expect(await schemaSnapshot(url)).toEqual(latest);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(m10a1Dir, { recursive: true, force: true });
      }
    });
  });

  describe('M10A2 canonical versioning and governance migrations (on M10A1 data)', () => {
    const tenantA = 'a2a2a2a2-0000-4a2a-8a2a-00000000000a';
    const tenantB = 'a2a2a2a2-0000-4a2a-8a2a-00000000000b';
    const sugarA = 'a2a2a2a2-1111-4a2a-8a2a-0000000000aa';
    const sugarB = 'a2a2a2a2-1111-4a2a-8a2a-00000000000b';
    /** Two tenants with entities of every indexed kind and mapping versions 1..3 (A) and 1 (B). */
    const SEED = `INSERT INTO tenants (id, slug, name, updated_at) VALUES
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'mtenaa', 'A', now()),
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000b', 'mtenab', 'B', now());
INSERT INTO tenant_source_connections (tenant_id, id, kind, label, status, mapping_mode) VALUES
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'a2a2a2a2-1111-4a2a-8a2a-00000000000a', 'import', 'Operator import (CSV)', 'enabled', 'code'),
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'a2a2a2a2-1111-4a2a-8a2a-0000000000aa', 'sugar', 'Sugar', 'enabled', 'versioned'),
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000b', 'a2a2a2a2-1111-4a2a-8a2a-00000000000b', 'sugar', 'Sugar', 'enabled', 'versioned');
INSERT INTO tenant_source_schema_snapshots (tenant_id, connection_id, hash, document, captured_by) VALUES
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'a2a2a2a2-1111-4a2a-8a2a-0000000000aa', repeat('e', 64), '{"objects":[]}', 'test'),
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000b', 'a2a2a2a2-1111-4a2a-8a2a-00000000000b', repeat('e', 64), '{"objects":[]}', 'test');
INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version,
   subscription_lines_connection_id, subscription_state_connection_id, subscription_terms_connection_id, content_hash, published_by) VALUES
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000a', 1, 0, 'a2a2a2a2-1111-4a2a-8a2a-00000000000a', 'a2a2a2a2-1111-4a2a-8a2a-00000000000a', 'a2a2a2a2-1111-4a2a-8a2a-00000000000a', repeat('a', 64), 'provisioning'),
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000b', 1, 0, 'a2a2a2a2-1111-4a2a-8a2a-00000000000b', 'a2a2a2a2-1111-4a2a-8a2a-00000000000b', 'a2a2a2a2-1111-4a2a-8a2a-00000000000b', repeat('a', 64), 'provisioning');
INSERT INTO tenant_source_mapping_versions (tenant_id, connection_id, version, base_version, document, content_hash, schema_snapshot_hash, authority_version, published_by)
SELECT 'a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'a2a2a2a2-1111-4a2a-8a2a-0000000000aa', v, v - 1, '{"objects":[]}', repeat(v::text, 64), repeat('e', 64), 1, 'test'
  FROM generate_series(1, 3) v;
INSERT INTO tenant_source_mapping_versions (tenant_id, connection_id, version, base_version, document, content_hash, schema_snapshot_hash, authority_version, published_by)
VALUES ('a2a2a2a2-0000-4a2a-8a2a-00000000000b', 'a2a2a2a2-1111-4a2a-8a2a-00000000000b', 1, 0, '{"objects":[]}', repeat('1', 64), repeat('e', 64), 1, 'test');
INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
  ('a2a2a2a2-2222-4a2a-8a2a-00000000000a', 'a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'School A', now(), now()),
  ('a2a2a2a2-2222-4a2a-8a2a-0000000000aa', 'a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'School AA', now(), now()),
  ('a2a2a2a2-2222-4a2a-8a2a-00000000000b', 'a2a2a2a2-0000-4a2a-8a2a-00000000000b', 'School B', now(), now());
INSERT INTO persons (id, tenant_id, primary_email, company_id, created_at, updated_at) VALUES
  ('a2a2a2a2-3333-4a2a-8a2a-00000000000a', 'a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'a@example.test', 'a2a2a2a2-2222-4a2a-8a2a-00000000000a', now(), now());
INSERT INTO tenant_products (tenant_id, key, name, updated_at) VALUES
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'core', 'Core', now()),
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000b', 'core', 'Core', now());
INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system, source_object_type, source_record_id, observed_at) VALUES
  ('a2a2a2a2-0000-4a2a-8a2a-00000000000a', 'a2a2a2a2-4444-4a2a-8a2a-00000000000a', 'a2a2a2a2-2222-4a2a-8a2a-00000000000a', 'core', 'active', 'import', 'subscriptions', 'r1', now());`;

    /** A database at the M10A1 state holding SEED. */
    async function m10a1Database(name: string): Promise<string> {
      const url = await createDatabase(pg, name);
      const dir = resolve(`test/.tmp/${name}`);
      try {
        await migrate(url, ['--config', m10a1MigrationsConfig(dir)]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      await withAdmin(url, (db) => db.query(SEED));
      return url;
    }

    it('V3/V10/V16: baseline 0.1 per tenant, index backfill per kind, lifecycle backfill equals "latest wins"', async () => {
      const url = await m10a1Database('m10a2_on_m10a1');
      const latestBefore = await withAdmin(url, (db) =>
        db.query<{ tenant_id: string; connection_id: string; version: number }>(
          `SELECT tenant_id, connection_id, max(version)::int AS version
             FROM tenant_source_mapping_versions GROUP BY 1, 2 ORDER BY 1, 2`,
        ),
      );
      const output = await migrate(url);
      for (const name of M10A2_MIGRATIONS) expect(output).toMatch(new RegExp(name));

      const adoptions = await withAdmin(url, (db) =>
        db.query(
          `SELECT tenant_id, seq, version, previous_version, reason, actor_kind, actor_id, actor_assurance, audit_event_id
             FROM tenant_canonical_adoptions ORDER BY tenant_id`,
        ),
      );
      expect(adoptions.rows).toEqual(
        [tenantA, tenantB].map((tenant_id) => ({
          tenant_id,
          seq: 1,
          version: '0.1',
          previous_version: null,
          reason: 'baseline',
          actor_kind: 'system',
          actor_id: 'system:migration:m10a2',
          actor_assurance: 'system',
          audit_event_id: null,
        })),
      );

      const index = await withAdmin(url, (db) =>
        db.query<{ tenant_id: string; kind: string; n: number }>(
          `SELECT tenant_id, kind, count(*)::int AS n FROM tenant_entity_index GROUP BY 1, 2 ORDER BY 1, 2`,
        ),
      );
      expect(index.rows).toEqual([
        { tenant_id: tenantA, kind: 'company', n: 2 },
        { tenant_id: tenantA, kind: 'person', n: 1 },
        { tenant_id: tenantA, kind: 'product', n: 1 },
        { tenant_id: tenantA, kind: 'subscription', n: 1 },
        { tenant_id: tenantB, kind: 'company', n: 1 },
        { tenant_id: tenantB, kind: 'product', n: 1 },
      ]);

      const states = await withAdmin(url, (db) =>
        db.query<{ tenant_id: string; connection_id: string; version: number; state: string }>(
          `SELECT tenant_id, connection_id, version, state FROM tenant_source_mapping_states ORDER BY 1, 2, 3`,
        ),
      );
      expect(states.rows).toEqual([
        { tenant_id: tenantA, connection_id: sugarA, version: 1, state: 'superseded' },
        { tenant_id: tenantA, connection_id: sugarA, version: 2, state: 'superseded' },
        { tenant_id: tenantA, connection_id: sugarA, version: 3, state: 'published' },
        { tenant_id: tenantB, connection_id: sugarB, version: 1, state: 'published' },
      ]);
      // The published version per connection is exactly the M10A1 "latest".
      expect(
        states.rows
          .filter((r) => r.state === 'published')
          .map(({ tenant_id, connection_id, version }) => ({ tenant_id, connection_id, version })),
      ).toEqual(latestBefore.rows);
      // Pre-M10A2 rows keep NULL governance columns (no invented backfill).
      const mappingMins = await withAdmin(url, (db) =>
        db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM tenant_source_mapping_versions WHERE canonical_version_min IS NOT NULL`,
        ),
      );
      expect(mappingMins.rows[0]!.n).toBe(0);
    });

    it('V22: the down-scripts refuse M10A2-only data (changing nothing), then restore exactly the M10A1 schema, and M10A2 re-applies', async () => {
      const before = await m10a1Database('m10a2_before_db');
      const url = await m10a1Database('m10a2_down_db');
      await migrate(url);
      const latest = await schemaSnapshot(url);
      const [down2, down1] = M10A2_DOWNS.map((f) => readFileSync(f, 'utf8'));

      const refusals: [string, string, string, RegExp][] = [
        [
          down2!,
          `INSERT INTO tenant_source_mapping_drafts (tenant_id, connection_id, id, document, content_hash, version,
             updated_by_kind, updated_by_id, updated_by_assurance, updated_at)
           VALUES ('${tenantA}', '${sugarA}', gen_random_uuid(), '{"objects":[]}', repeat('d', 64), 1,
             'operator', 'ops', 'asserted', now())`,
          `DELETE FROM tenant_source_mapping_drafts`,
          /refusing rollback: 1 mapping drafts exist/,
        ],
        [
          down2!,
          `INSERT INTO tenant_context_changes (tenant_id, id, entity_kind, entity_id, change_type, source_system,
             source_object_type, source_record_id, cause, adapter, adapter_version, correlation_id, origin, canonical_version)
           VALUES ('${tenantA}', gen_random_uuid(), 'company', gen_random_uuid(), 'created', 'sugar', 'Accounts', 'x1',
             'backfill', 'sugar', 'm10a2', gen_random_uuid(), 'source_provided', '0.1')`,
          `DELETE FROM tenant_context_changes WHERE origin IS NOT NULL`,
          /refusing rollback: 1 change records carry M10A2 columns or vocabulary/,
        ],
        [
          down1!,
          `INSERT INTO tenant_module_settings (tenant_id, module_key, enabled, config, version, updated_at,
             updated_by_kind, updated_by_id, updated_by_assurance)
           VALUES ('${tenantA}', 'engagement', false, '{}', 1, now(), 'operator', 'ops', 'asserted')`,
          `DELETE FROM tenant_module_settings`,
          /refusing rollback: 1 module settings exist/,
        ],
      ];
      for (const [down, plant, cleanup, message] of refusals) {
        if (down === down1) await withAdmin(url, (db) => db.query(down2!));
        await withAdmin(url, (db) => db.query(plant));
        const snapshot = await schemaSnapshot(url);
        await expect(withAdmin(url, (db) => db.query(down))).rejects.toThrow(message);
        expect(await schemaSnapshot(url)).toEqual(snapshot);
        // The owner removes the planted row (module settings refuse DELETE for everyone else).
        await withAdmin(url, (db) =>
          db.query(
            `SET session_replication_role = replica; ${cleanup}; SET session_replication_role = origin`,
          ),
        );
      }
      await withAdmin(url, (db) => db.query(down1!));
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(before));
      const output = await migrate(url);
      for (const name of M10A2_MIGRATIONS) expect(output).toMatch(new RegExp(name));
      expect(await schemaSnapshot(url)).toEqual(latest);
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
