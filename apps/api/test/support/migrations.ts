import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { withAdmin } from './containers';

/**
 * Migration-test helpers shared by the migration suites (tech debt #72: the
 * M10C migration cases live in their own file, test/tenancy/migrations-m10c.int.spec.ts).
 */

export function databaseUrl(container: StartedPostgreSqlContainer, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${database}`;
  return url.toString();
}

export async function createDatabase(
  container: StartedPostgreSqlContainer,
  name: string,
): Promise<string> {
  await withAdmin(container.getConnectionUri(), (db) => db.query(`CREATE DATABASE ${name}`));
  return databaseUrl(container, name);
}

/** A Prisma config whose migrations folder holds only the migrations named before `cutoff`. */
export function migrationsBefore(dir: string, cutoff: string): string {
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

/** Everything a migration can change, as sorted text (for exact schema comparison). */
export async function schemaSnapshot(url: string): Promise<Record<string, string[]>> {
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
