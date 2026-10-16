import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLASSIFICATION_MANIFEST, PRIVILEGE_MANIFEST } from '../../src/modules/tenancy/security';
import { migrate, startPostgres, withAdmin } from '../support/containers';
import { createDatabase, migrationsBefore, schemaSnapshot } from '../support/migrations';

/** M10D hardening #83 (tech debt #83, ADR 0030 addendum): single-owner custom objects. */
const H83 = '20270126120000_m10d_custom_object_owner';
const H83_DOWN = resolve(`prisma/rollback/${H83}.down.sql`);
/** M10F (commercial, canonical 0.6) sits on top of #90: its (data-free) down-script runs first of all. */
const M10F_DOWN = resolve('prisma/rollback/20270202120000_m10f_commercial.down.sql');
const H90_DOWN = resolve(
  'prisma/rollback/20270126130000_m10e_h90_confidential_read_grants.down.sql',
);
const TABLE = 'tenant_custom_object_owners';

const tA = 'a8300000-0000-4830-8830-00000000000a';
const tB = 'a8300000-0000-4830-8830-00000000000b';
const cS = 'a8300000-1111-4830-8830-00000000000a'; // tenant A, sugar
const cC = 'a8300000-2222-4830-8830-00000000000a'; // tenant A, chargebee
const cB = 'a8300000-1111-4830-8830-00000000000b'; // tenant B, sugar
const ON = 'SET session_replication_role = replica;';
const OFF = 'SET session_replication_role = origin;';

const mappingDoc = (...keys: string[]) =>
  JSON.stringify({
    objects: [
      { source: 'Accounts', entity: 'account', identity: { field: 'id' } },
      ...keys.map((k, i) => ({
        source: `Obj${i}`,
        entity: `custom_object:${k}`,
        identity: { field: 'id' },
      })),
    ],
  });
const version = (tenant: string, connection: string, v: number, doc: string) =>
  `INSERT INTO tenant_source_mapping_versions (tenant_id, connection_id, version, base_version, document,
     content_hash, schema_snapshot_hash, authority_version, published_by)
   VALUES ('${tenant}', '${connection}', ${v}, ${v - 1}, '${doc}', repeat('a', 64), repeat('b', 64), 1, 'test');`;
const lifecycle = (tenant: string, connection: string, v: number, seq: number, state: string) =>
  `INSERT INTO tenant_source_mapping_lifecycle (tenant_id, connection_id, version, seq, state, actor_kind,
     actor_id, actor_assurance, reason_code, audit_event_id)
   VALUES ('${tenant}', '${connection}', ${v}, ${seq}, '${state}', 'system', 'test', 'system',
     ${state === 'retired' ? `'operator_retired'` : 'NULL'}, gen_random_uuid());`;
const entry = (tenant: string, key: string) =>
  `INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
   VALUES ('${tenant}', gen_random_uuid(), 'extension', '${key}', '{"kind": "custom_object"}', 1, 1, now());`;

/**
 * Pre-#83 data (seeded as the schema owner, foreign keys off): tenant A has a
 * Sugar connection whose v1 (superseded) mapped `asset` and whose v2
 * (published) maps `site`, and a Chargebee connection whose published v1 maps
 * no custom object; tenant B's Sugar connection publishes `site` (another
 * tenant's object of the same key). Expected owners: (A, site, Sugar v2) and
 * (B, site, Sugar v1); `asset` is owned by nobody.
 */
const SEED = `INSERT INTO tenants (id, slug, name, updated_at) VALUES
  ('${tA}', 'heightthreea', 'A', now()), ('${tB}', 'heightthreeb', 'B', now());
INSERT INTO tenant_source_connections (tenant_id, id, kind, label, mapping_mode) VALUES
  ('${tA}', '${cS}', 'sugar', 'Sugar', 'versioned'),
  ('${tA}', '${cC}', 'chargebee', 'Chargebee', 'versioned'),
  ('${tB}', '${cB}', 'sugar', 'Sugar', 'versioned');
${ON}
${entry(tA, 'site')}
${entry(tA, 'asset')}
${entry(tB, 'site')}
${version(tA, cS, 1, mappingDoc('asset'))}
${version(tA, cS, 2, mappingDoc('site'))}
${version(tA, cC, 1, mappingDoc())}
${version(tB, cB, 1, mappingDoc('site'))}
${lifecycle(tA, cS, 1, 1, 'published')}
${lifecycle(tA, cS, 1, 2, 'superseded')}
${lifecycle(tA, cS, 2, 1, 'published')}
${lifecycle(tA, cC, 1, 1, 'published')}
${lifecycle(tB, cB, 1, 1, 'published')}
${OFF}`;

/**
 * Tech debt #83 migration and schema guard: the owner table's forced RLS,
 * tenant policy, privileges (no DELETE), composite same-tenant foreign keys,
 * CHECKs and guard trigger; raw SQL as the app role (a second owner is a
 * primary-key violation, a direct handover and an identity change are refused,
 * DELETE is not granted); the migration on M10E data (backfill from the
 * published mappings, rerun no-op, refusal when single ownership is already
 * violated); the down-script (refuses on drift, changing nothing; restores
 * the M10E schema exactly; re-applies).
 */
describe('M10D hardening #83: custom object owner migration and schema guard', () => {
  let pg: StartedPostgreSqlContainer;
  let cleanUrl: string;

  beforeAll(async () => {
    pg = await startPostgres();
    cleanUrl = await createDatabase(pg, 'h83_clean');
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

  /** Statements in one transaction as the app role bound to `tenant` (rolled back on error). */
  const asApp = (url: string, tenant: string, statements: readonly string[]) =>
    withAdmin(url, async (db) => {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE lip_app');
        await db.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenant]);
        for (const sql of statements) await db.query(sql);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });

  const owners = (url: string) =>
    q(
      url,
      `SELECT tenant_id::text AS tenant, object_key, connection_id::text AS connection, mapping_version,
              released_at IS NOT NULL AS released
         FROM ${TABLE} ORDER BY tenant_id, object_key`,
    );

  describe('schema guard', () => {
    it('forced RLS, the tenant policy, the guard and tenant-id triggers; SELECT / INSERT / UPDATE only; manifests cover every column', async () => {
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
      expect(
        (
          await q<{ tgname: string }>(
            cleanUrl,
            `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = $1::regclass ORDER BY tgname`,
            [TABLE],
          )
        ).map((t) => t.tgname),
      ).toEqual([
        'tenant_custom_object_owners_guard',
        'tenant_custom_object_owners_tenant_immutable',
      ]);
      const grants = await q<{ privilege_type: string }>(
        cleanUrl,
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'lip_app' AND table_name = $1 ORDER BY privilege_type`,
        [TABLE],
      );
      expect(grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      expect(PRIVILEGE_MANIFEST[TABLE]).toEqual(['SELECT', 'INSERT', 'UPDATE']);
      const columns = await q<{ column_name: string }>(
        cleanUrl,
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
        [TABLE],
      );
      expect(Object.keys(CLASSIFICATION_MANIFEST[TABLE]!).sort()).toEqual(
        columns.map((c) => c.column_name),
      );
      const fn = await q(
        cleanUrl,
        `SELECT prosecdef, array_to_string(proconfig, ',') AS config,
                has_function_privilege('public', oid, 'EXECUTE') AS public_execute
           FROM pg_proc WHERE proname = 'app_custom_object_owner_guard'`,
      );
      expect(fn).toEqual([
        {
          prosecdef: false,
          config: 'search_path=pg_catalog, public, pg_temp',
          public_execute: false,
        },
      ]);
    });

    it('the primary key is (tenant, object key); every foreign key is a composite same-tenant key (RESTRICT); the CHECKs are in place', async () => {
      const defs = Object.fromEntries(
        (
          await q<{ conname: string; def: string }>(
            cleanUrl,
            `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
              WHERE conrelid = $1::regclass ORDER BY conname`,
            [TABLE],
          )
        ).map((r) => [r.conname, r.def]),
      );
      const restrict = 'ON UPDATE RESTRICT ON DELETE RESTRICT';
      expect(defs).toEqual({
        tenant_custom_object_owners_pkey: 'PRIMARY KEY (tenant_id, object_key)',
        tenant_custom_object_owners_tenant_id_fkey: `FOREIGN KEY (tenant_id) REFERENCES tenants(id) ${restrict}`,
        tenant_custom_object_owners_tenant_id_registry_kind_object_fkey: `FOREIGN KEY (tenant_id, registry_kind, object_key) REFERENCES tenant_registry_entries(tenant_id, kind, key) ${restrict}`,
        tenant_custom_object_owners_tenant_id_connection_id_fkey: `FOREIGN KEY (tenant_id, connection_id) REFERENCES tenant_source_connections(tenant_id, id) ${restrict}`,
        tenant_custom_object_owners_tenant_id_connection_id_mappin_fkey: `FOREIGN KEY (tenant_id, connection_id, mapping_version) REFERENCES tenant_source_mapping_versions(tenant_id, connection_id, version) ${restrict}`,
        tenant_custom_object_owners_key_format: expect.stringContaining('object_key ~'),
        tenant_custom_object_owners_registry_kind: "CHECK ((registry_kind = 'extension'::text))",
        tenant_custom_object_owners_state_shape: expect.stringContaining('released_at IS NOT NULL'),
      });
    });
  });

  describe('raw SQL as the app role', () => {
    beforeAll(async () => {
      await withAdmin(cleanUrl, (db) => db.query(SEED));
    });
    const insert = (connection: string, v: number, key = 'site', tenant = tA) =>
      `INSERT INTO ${TABLE} (tenant_id, object_key, connection_id, mapping_version, claimed_at)
       VALUES ('${tenant}', '${key}', '${connection}', ${v}, now())`;

    it('one owner per (tenant, object): a second owner is a primary-key violation; another tenant may own its own object of the same key', async () => {
      await asApp(cleanUrl, tA, [insert(cS, 2)]);
      await expect(asApp(cleanUrl, tA, [insert(cC, 1)])).rejects.toThrow(
        /duplicate key value violates unique constraint "tenant_custom_object_owners_pkey"/,
      );
      await asApp(cleanUrl, tB, [insert(cB, 1, 'site', tB)]);
      expect((await owners(cleanUrl)).map((o) => [o.tenant, o.object_key, o.connection])).toEqual([
        [tA, 'site', cS],
        [tB, 'site', cB],
      ]);
    });

    it('a direct handover, an identity change and a malformed released row are refused; release then claim is the only way to move ownership', async () => {
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE ${TABLE} SET connection_id = '${cC}', mapping_version = 1 WHERE object_key = 'site'`,
        ]),
      ).rejects.toThrow(/custom_object_owned_by_other_connection/);
      await expect(
        asApp(cleanUrl, tA, [`UPDATE ${TABLE} SET object_key = 'asset' WHERE object_key = 'site'`]),
      ).rejects.toThrow(/custom_object_owner_identity_immutable/);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE ${TABLE} SET connection_id = NULL, mapping_version = NULL WHERE object_key = 'site'`,
        ]),
      ).rejects.toThrow(/tenant_custom_object_owners_state_shape/);
      await asApp(cleanUrl, tA, [
        `UPDATE ${TABLE} SET connection_id = NULL, mapping_version = NULL, released_at = now() WHERE object_key = 'site'`,
        `UPDATE ${TABLE} SET connection_id = '${cC}', mapping_version = 1, claimed_at = now(), released_at = NULL
          WHERE object_key = 'site'`,
      ]);
      expect((await owners(cleanUrl))[0]).toMatchObject({ connection: cC, mapping_version: 1 });
    });

    it('DELETE is not granted; another tenant’s connection, a version the connection does not have, and an unregistered object are refused by the composite keys', async () => {
      await expect(asApp(cleanUrl, tA, [`DELETE FROM ${TABLE}`])).rejects.toThrow(
        /permission denied/,
      );
      await expect(asApp(cleanUrl, tA, [insert(cB, 1, 'asset')])).rejects.toThrow(
        /tenant_custom_object_owners_tenant_id_connection_id_fkey|violates foreign key/,
      );
      await expect(asApp(cleanUrl, tA, [insert(cS, 9, 'asset')])).rejects.toThrow(
        /violates foreign key constraint "tenant_custom_object_owners_tenant_id_connection_id_mappin_fkey"/,
      );
      await expect(asApp(cleanUrl, tA, [insert(cS, 2, 'nope')])).rejects.toThrow(
        /violates foreign key constraint "tenant_custom_object_owners_tenant_id_registry_kind_object_fkey"/,
      );
    });
  });

  describe('the migration on M10E data', () => {
    /** A database at the M10E state (every migration before #83), optionally seeded. */
    async function m10eDatabase(name: string, seed: string | null = SEED): Promise<string> {
      const url = await createDatabase(pg, name);
      const dir = resolve(`test/.tmp/${name}`);
      try {
        await migrate(url, ['--config', migrationsBefore(dir, '20270126')]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (seed) await withAdmin(url, (db) => db.query(seed));
      return url;
    }
    const EXPECTED = [
      { tenant: tA, object_key: 'site', connection: cS, mapping_version: 2, released: false },
      { tenant: tB, object_key: 'site', connection: cB, mapping_version: 1, released: false },
    ];

    it('backfills one owner per custom object of the currently published mappings (not superseded versions); rerun is a no-op', async () => {
      const url = await m10eDatabase('h83_on_m10e');
      expect(await migrate(url)).toMatch(new RegExp(H83));
      expect(await owners(url)).toEqual(EXPECTED);
      await expect(migrate(url)).resolves.toMatch(/No pending migrations/);
      expect(await owners(url)).toEqual(EXPECTED);
    });

    it('is refused with a clear error when two connections’ published mappings already source one custom object (nothing created)', async () => {
      const url = await m10eDatabase('h83_refused');
      await withAdmin(url, (db) =>
        db.query(`${ON}
          UPDATE tenant_source_mapping_versions SET document = '${mappingDoc('site')}'
           WHERE tenant_id = '${tA}' AND connection_id = '${cC}' AND version = 1;
          ${OFF}`),
      );
      await expect(migrate(url)).rejects.toThrow(
        /M10D hardening #83 refused: custom object site of tenant a8300000-0000-4830-8830-00000000000a is sourced by 2 connections/,
      );
      expect(await q(url, `SELECT to_regclass('${TABLE}')::text AS t`)).toEqual([{ t: null }]);
    });

    it('the down-script refuses while owners and published mappings disagree (changing nothing), then restores exactly the M10E schema; #83 re-applies and re-backfills', async () => {
      const before = await m10eDatabase('h83_before_db', null);
      const url = await m10eDatabase('h83_down_db');
      await migrate(url);
      const latest = await schemaSnapshot(url);
      // M10E hardening #90 (20270126130000) sits on top of #83: its (data-free) rollback runs first.
      await withAdmin(url, (db) => db.query(readFileSync(M10F_DOWN, 'utf8')));
      await withAdmin(url, (db) => db.query(readFileSync(H90_DOWN, 'utf8')));
      const down = readFileSync(H83_DOWN, 'utf8');
      const drift: [string, string, RegExp][] = [
        [
          // A held row the owner's published mapping does not support.
          `INSERT INTO ${TABLE} (tenant_id, object_key, connection_id, mapping_version, claimed_at)
           VALUES ('${tA}', 'asset', '${cS}', 2, now())`,
          `UPDATE ${TABLE} SET connection_id = NULL, mapping_version = NULL, released_at = now()
            WHERE tenant_id = '${tA}' AND object_key = 'asset'`,
          /refusing rollback: 1 custom object owner rows are not supported by their owner's published mapping/,
        ],
        [
          // A published custom object mapping without its held owner row.
          `UPDATE ${TABLE} SET connection_id = NULL, mapping_version = NULL, released_at = now()
            WHERE tenant_id = '${tB}' AND object_key = 'site'`,
          `UPDATE ${TABLE} SET connection_id = '${cB}', mapping_version = 1, released_at = NULL
            WHERE tenant_id = '${tB}' AND object_key = 'site'`,
          /refusing rollback: 1 published custom object mappings have no matching owner row/,
        ],
      ];
      for (const [plant, undo, message] of drift) {
        await withAdmin(url, (db) => db.query(plant));
        const planted = await schemaSnapshot(url);
        await expect(withAdmin(url, (db) => db.query(down))).rejects.toThrow(message);
        expect(await schemaSnapshot(url)).toEqual(planted);
        await withAdmin(url, (db) => db.query(undo));
      }
      // Released rows (history) do not block the rollback.
      await withAdmin(url, (db) => db.query(down));
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(before));
      const fns = (u: string) =>
        q<{ v: string }>(
          u,
          `SELECT proname || ' ' || prosecdef || ' ' || coalesce(array_to_string(proacl, ','), '') AS v
             FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`,
        );
      expect(await fns(url)).toEqual(await fns(before));
      expect(
        await q(url, `SELECT 1 FROM _prisma_migrations WHERE migration_name = $1`, [H83]),
      ).toEqual([]);
      expect(await migrate(url)).toMatch(new RegExp(H83));
      expect(await schemaSnapshot(url)).toEqual(latest);
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(cleanUrl));
      expect(await owners(url)).toEqual(EXPECTED);
    });
  });
});
