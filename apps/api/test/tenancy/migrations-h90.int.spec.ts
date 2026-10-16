import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  CAPABILITIES,
  GRANTABLE_CAPABILITIES,
} from '../../src/modules/domain/security';
import { CLASSIFICATION_MANIFEST, PRIVILEGE_MANIFEST } from '../../src/modules/tenancy/security';
import { migrate, startPostgres, withAdmin } from '../support/containers';
import { createDatabase, migrationsBefore, schemaSnapshot } from '../support/migrations';

/** M10E hardening #90 migration (explicit capability grants, policy v7). */
const H90 = '20270126130000_m10e_h90_confidential_read_grants';
const H90_DOWN = resolve(`prisma/rollback/${H90}.down.sql`);
const TABLE = 'tenant_capability_grants';

/**
 * M10E hardening #90 migration and schema guard: the grants table (forced RLS,
 * tenant policy, tenant-id immutability, identity guard, SELECT / INSERT /
 * UPDATE only), the closed grantable-capability CHECK equal to the code, the
 * audit capability / action CHECKs equal to the policy-v7 catalogues,
 * classification coverage, and the round trip on M10E data: up, rerun,
 * down-script refusals (changing nothing), exact restore of the M10E schema,
 * re-apply with no drift.
 */
describe('M10E hardening #90 migration and schema guard', () => {
  let pg: StartedPostgreSqlContainer;
  let cleanUrl: string;

  beforeAll(async () => {
    pg = await startPostgres();
    cleanUrl = await createDatabase(pg, 'h90_clean');
    await migrate(cleanUrl);
  });
  afterAll(async () => {
    await pg?.stop();
  });

  const q = async <T extends Record<string, unknown>>(
    url: string,
    sql: string,
    params: unknown[] = [],
  ) => withAdmin(url, async (db) => (await db.query<T>(sql, params)).rows);
  const checkValues = async (url: string, name: string): Promise<string[]> => {
    const rows = await q<{ def: string }>(
      url,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [name],
    );
    expect(rows, name).toHaveLength(1);
    return [...new Set([...rows[0]!.def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]!))].sort();
  };
  const sorted = (list: readonly string[]) => [...list].sort();
  const asApp = (url: string, tenant: string, sql: string) =>
    withAdmin(url, async (db) => {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE lip_app');
        await db.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenant]);
        return (await db.query<Record<string, unknown>>(sql)).rows;
      } finally {
        await db.query('ROLLBACK').catch(() => undefined);
      }
    });

  it('forced RLS, the tenant policy, tenant-id immutability and the identity guard (SECURITY INVOKER, fixed search_path, no PUBLIC execute)', async () => {
    expect(
      await q(
        cleanUrl,
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [TABLE],
      ),
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect(
      await q(
        cleanUrl,
        `SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = $1`,
        [TABLE],
      ),
    ).toEqual([
      {
        policyname: 'tenant_isolation',
        qual: '(tenant_id = app_current_tenant())',
        with_check: '(tenant_id = app_current_tenant())',
      },
    ]);
    const triggers = await q<{ tgname: string }>(
      cleanUrl,
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = $1::regclass ORDER BY tgname`,
      [TABLE],
    );
    expect(triggers.map((t) => t.tgname)).toEqual([
      'tenant_capability_grants_guard',
      'tenant_capability_grants_tenant_immutable',
    ]);
    const [fn] = await q<{ prosecdef: boolean; config: string; acl: string }>(
      cleanUrl,
      `SELECT prosecdef, array_to_string(proconfig, ',') AS config,
              coalesce(array_to_string(proacl, ','), '') AS acl
         FROM pg_proc WHERE proname = 'app_capability_grant_guard'`,
    );
    expect(fn!.prosecdef).toBe(false);
    expect(fn!.config).toMatch(/^search_path=/);
    expect(fn!.acl).not.toMatch(/(^|,)=X\//);
  });

  it('the grantable CHECK equals GRANTABLE_CAPABILITIES (one capability); the audit CHECKs equal the policy-v7 catalogues', async () => {
    expect(await checkValues(cleanUrl, 'tenant_capability_grants_capability_grantable')).toEqual(
      sorted(GRANTABLE_CAPABILITIES),
    );
    expect(GRANTABLE_CAPABILITIES).toEqual(['data.account_context.read_confidential']);
    expect(await checkValues(cleanUrl, 'tenant_audit_events_capability_valid')).toEqual(
      sorted(CAPABILITIES),
    );
    expect(await checkValues(cleanUrl, 'tenant_audit_events_action_valid')).toEqual(
      sorted(AUDIT_ACTIONS),
    );
    expect(CAPABILITIES).toEqual(
      expect.arrayContaining([
        'data.account_context.read_confidential',
        'security.capability.grant',
      ]),
    );
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining(['capability.grant', 'capability.revoke']),
    );
  });

  it('SELECT / INSERT / UPDATE only (no DELETE / TRUNCATE) as in the privilege manifest; every column classified', async () => {
    const grants = await q<{ privilege_type: string }>(
      cleanUrl,
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = 'lip_app' AND table_name = $1 ORDER BY privilege_type`,
      [TABLE],
    );
    expect(grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(sorted(PRIVILEGE_MANIFEST[TABLE]!)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    await expect(asApp(cleanUrl, randomUUID(), `DELETE FROM ${TABLE}`)).rejects.toMatchObject({
      code: '42501',
    });
    const columns = await q<{ column_name: string }>(
      cleanUrl,
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
      [TABLE],
    );
    expect(sorted(Object.keys(CLASSIFICATION_MANIFEST[TABLE]!))).toEqual(
      columns.map((c) => c.column_name),
    );
    // Operator ids (grantee, grantor, revoker) carry the operator-id classification.
    for (const col of ['actor_id', 'granted_by_id', 'revoked_by_id']) {
      expect(CLASSIFICATION_MANIFEST[TABLE]![col]!.sensitivity, col).toBe('restricted');
    }
  });

  describe('round trip on M10E data', () => {
    const tA = 'd90e0000-0000-4d90-8d90-00000000000a';
    const ON = 'SET session_replication_role = replica;';
    const OFF = 'SET session_replication_role = origin;';
    async function m10eDatabase(name: string): Promise<string> {
      const url = await createDatabase(pg, name);
      const dir = resolve(`test/.tmp/${name}-m10e`);
      try {
        // The state before #90: M10E plus M10D hardening #83 (20270126120000), which #90 sits on.
        await migrate(url, ['--config', migrationsBefore(dir, '20270126130000')]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      await withAdmin(url, (db) =>
        db.query(
          `INSERT INTO tenants (id, slug, name, updated_at) VALUES ('${tA}', 'hnintena', 'A', now())`,
        ),
      );
      return url;
    }

    it('applies with no backfill (no grant invented); rerun is a no-op; the down-script refuses grants and policy-v7 audit events (changing nothing), then restores exactly the M10E schema; re-apply has no drift', async () => {
      const before = await m10eDatabase('h90_before_db');
      const url = await m10eDatabase('h90_down_db');
      expect(await migrate(url)).toMatch(new RegExp(H90));
      expect(await q(url, `SELECT count(*)::int AS n FROM ${TABLE}`)).toEqual([{ n: 0 }]);
      await expect(migrate(url)).resolves.toMatch(/No pending migrations/);
      const latest = await schemaSnapshot(url);
      const down = readFileSync(H90_DOWN, 'utf8');
      const audit = (capability: string, action: string) =>
        `INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance,
           capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
         VALUES ('${tA}', gen_random_uuid(), 1, now(), 'operator', 'ops', 'asserted', '${capability}', '${action}',
           'allowed', gen_random_uuid(), 7, '{}', repeat('0', 64), repeat('a', 64))`;
      const refusals: [string, string, RegExp][] = [
        [
          `INSERT INTO ${TABLE} (tenant_id, actor_kind, actor_id, capability, active, version, granted_at,
             granted_by_kind, granted_by_id, granted_by_assurance, revoked_at, revoked_by_kind, revoked_by_id,
             revoked_by_assurance)
           VALUES ('${tA}', 'operator', 'reader', 'data.account_context.read_confidential', false, 2, now(),
             'operator', 'grantor', 'asserted', now(), 'operator', 'grantor', 'asserted')`,
          `DELETE FROM ${TABLE}`,
          /refusing rollback: 1 capability grants exist/,
        ],
        [
          audit('data.account_context.read_confidential', 'account_context.read'),
          `DELETE FROM tenant_audit_events`,
          /refusing rollback: 1 audit events use policy-v7 capabilities or actions/,
        ],
        [
          audit('security.capability.grant', 'capability.revoke'),
          `DELETE FROM tenant_audit_events`,
          /refusing rollback: 1 audit events use policy-v7 capabilities or actions/,
        ],
      ];
      for (const [plant, cleanup, message] of refusals) {
        await withAdmin(url, (db) => db.query(`${ON} ${plant}; ${OFF}`));
        const snapshot = await schemaSnapshot(url);
        await expect(
          withAdmin(url, (db) => db.query(down)),
          String(message),
        ).rejects.toThrow(message);
        expect(await schemaSnapshot(url), String(message)).toEqual(snapshot);
        await withAdmin(url, (db) => db.query(`${ON} ${cleanup}; ${OFF}`));
      }
      await withAdmin(url, (db) => db.query(down));
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(before));
      expect(
        await q(url, `SELECT migration_name FROM _prisma_migrations WHERE migration_name = $1`, [
          H90,
        ]),
      ).toEqual([]);
      expect(await migrate(url)).toMatch(new RegExp(H90));
      expect(await schemaSnapshot(url)).toEqual(latest);
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(cleanUrl));
    });
  });
});
