import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTHORITY_FACTS_0_5,
  AVAILABLE_REGISTRY_KINDS,
  CANONICAL_MODULES,
  CANONICAL_VERSIONS,
  CANONICAL_VERSION_FEATURES,
  CHANGE_ENTITY_KINDS,
  ENTITY_INDEX_KINDS,
  EXTENSION_TARGET_KINDS,
  GENERIC_REFERENCE_KINDS,
  IDENTITY_CONFLICT_ENTITY_KINDS,
  IDENTITY_CONFLICT_KINDS,
  MAPPING_ENTITIES_0_5,
  canonicalCatalogueFor,
  canonicalCatalogueHash,
} from '../../src/modules/domain/canonical';
import { AUDIT_ACTIONS, CAPABILITIES } from '../../src/modules/domain/security';
import {
  CLASSIFICATION_MANIFEST,
  PRIVILEGE_MANIFEST,
  SECURITY_DEFINER_FUNCTIONS,
  dataSubjectMap,
} from '../../src/modules/tenancy/security';
import { migrate, startPostgres, withAdmin } from '../support/containers';
import { createDatabase, migrationsBefore, schemaSnapshot } from '../support/migrations';

const run = promisify(execFile);

/** M10E migration (account context, canonical 0.5, ADR 0031). */
const M10E = '20270119120000_m10e_account_context';
const M10E_DOWN = resolve(`prisma/rollback/${M10E}.down.sql`);
/** M10E hardening #90 sits on top of M10E: its (data-free) down-script runs first. */
const H90_DOWN = resolve(
  'prisma/rollback/20270126130000_m10e_h90_confidential_read_grants.down.sql',
);
/** M10D hardening #83 sits on top of M10E: its (data-free here) down-script runs first. */
const H83_DOWN = resolve('prisma/rollback/20270126120000_m10d_custom_object_owner.down.sql');
/** Stored catalogue hashes: 0.1–0.4 from their own migrations, 0.5 as pinned in the M10E migration. */
const STORED_HASHES = {
  '0.1': '2fd4f7e575633de7cac4aea394a71c73adc9b73e5e18b67c0b0ee404572faf5b',
  '0.2': 'db7c0fc245cae469e8cddae88b89077c017805c7b87586b9d3e71f1936c96c98',
  '0.3': '70db9aa697147cf1d0d63e93a923ed8714b78da32550aaefe5699597e26eb069',
  '0.4': '70584afd267f4c5620c2d63c95cc547f18c1cacdb0b408304eea9a41aeae81c7',
  '0.5': 'bfc152541c0788a1532d400e1dd0d23c450f228fa7509e5108966dee9e2b46e2',
} as const;
const M10E_TABLES = [
  'tenant_account_context_persons',
  'tenant_account_context_products',
  'tenant_account_contexts',
] as const;

const hash64 = () => randomBytes(32).toString('hex');

/** A pg error's SQLSTATE and message (for `rejects.toMatchObject`). */
const pgError = (code: string, message?: RegExp) =>
  message ? { code, message: expect.stringMatching(message) as unknown } : { code };

/**
 * M10E migration and schema guard (plan §18 V1 / V2 / V3 / V21 / V22 / V24 /
 * V29 / V30), modelled on migrations-m10d.int.spec.ts: the canonical catalogue
 * rows and module row in the database (V1–V3); cross-tenant membership /
 * product / line links refused as the app role by the composite foreign keys
 * (V21); forced RLS, the tenant policy and the schema guard on the three
 * tables (V22); classification manifest coverage (V24); the line / context
 * same-account guard (deferred constraint trigger) refusing a cross-account
 * line at commit; the migration on M10D data — up, rerun, each down-script
 * refusal planted (changing nothing), exact restore, re-apply, no drift (V29);
 * privileges — no DELETE on contexts / memberships, no DDL (V30).
 */
describe('M10E migration and schema guard', () => {
  let pg: StartedPostgreSqlContainer;
  let cleanUrl: string;

  beforeAll(async () => {
    pg = await startPostgres();
    cleanUrl = await createDatabase(pg, 'm10e_clean');
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

  /**
   * Runs statements in one transaction as the app role (`lip_app`) bound to
   * `tenant`, committing unless `rollback` (deferred constraint triggers fire
   * at the COMMIT). The transaction is rolled back on any error.
   */
  const asApp = (
    url: string,
    tenant: string,
    statements: readonly string[],
    options: { rollback?: boolean } = {},
  ) =>
    withAdmin(url, async (db) => {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE lip_app');
        await db.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenant]);
        const out: Record<string, unknown>[][] = [];
        for (const sql of statements) out.push((await db.query<Record<string, unknown>>(sql)).rows);
        await db.query(options.rollback ? 'ROLLBACK' : 'COMMIT');
        return out;
      } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });

  /** The quoted values of a named CHECK constraint, sorted. */
  const checkValues = async (name: string): Promise<string[]> => {
    const rows = await q<{ def: string }>(
      cleanUrl,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [name],
    );
    expect(rows, name).toHaveLength(1);
    return [...new Set([...rows[0]!.def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]!))].sort();
  };
  const sorted = (list: readonly string[]) => [...list].sort();

  describe('V1 / V2 / V3: canonical catalogue and module in the database', () => {
    it('V1: 0.5 is current (ADR 0031) with the pinned hash the code reproduces; 0.4 supported; the 0.5 members (kinds, mapping entity, authority fact, registry kinds, features)', async () => {
      const rows = await q<Record<string, unknown>>(
        cleanUrl,
        'SELECT version, status, adr, catalogue_hash FROM canonical_model_versions ORDER BY major, minor',
      );
      expect(rows).toEqual([
        { version: '0.1', status: 'supported', adr: '0027', catalogue_hash: STORED_HASHES['0.1'] },
        { version: '0.2', status: 'supported', adr: '0028', catalogue_hash: STORED_HASHES['0.2'] },
        { version: '0.3', status: 'supported', adr: '0029', catalogue_hash: STORED_HASHES['0.3'] },
        { version: '0.4', status: 'supported', adr: '0030', catalogue_hash: STORED_HASHES['0.4'] },
        { version: '0.5', status: 'current', adr: '0031', catalogue_hash: STORED_HASHES['0.5'] },
      ]);
      expect(canonicalCatalogueHash(canonicalCatalogueFor('0.5'))).toBe(STORED_HASHES['0.5']);
      expect(CANONICAL_VERSIONS.map((v) => [v.version, v.status])).toEqual([
        ['0.1', 'supported'],
        ['0.2', 'supported'],
        ['0.3', 'supported'],
        ['0.4', 'supported'],
        ['0.5', 'current'],
      ]);
      const c04 = canonicalCatalogueFor('0.4') as unknown as Record<string, readonly string[]>;
      const c05 = canonicalCatalogueFor('0.5') as unknown as Record<string, readonly string[]>;
      expect(c05.entityKinds).toContain('account_context');
      expect(c05.changeEntityKinds).toEqual(
        expect.arrayContaining(['account_context', 'account_context_person']),
      );
      expect(c05.genericReferenceKinds).toContain('account_context');
      expect(c05.extensionTargets).toContain('account_context');
      expect(c05.authorityFacts).toEqual([...AUTHORITY_FACTS_0_5]);
      expect(c05.authorityFacts).toContain('account_context');
      expect(c05.mappingEntities).toEqual([...MAPPING_ENTITIES_0_5]);
      expect(c05.mappingEntities).toContain('account_context');
      expect(c05.registryKinds).toEqual([...AVAILABLE_REGISTRY_KINDS]);
      expect(c05.registryKinds).toContain('context_type');
      // 0.4 reads frozen lists: none of the M10E members.
      expect(c04.entityKinds).not.toContain('account_context');
      expect(c04.changeEntityKinds).not.toContain('account_context_person');
      expect(c04.genericReferenceKinds).not.toContain('account_context');
      expect(c04.extensionTargets).not.toContain('account_context');
      expect(c04.authorityFacts).not.toContain('account_context');
      expect(c04.mappingEntities).toBeUndefined();
      expect(c04.registryKinds).toBeUndefined();
      expect(CANONICAL_VERSION_FEATURES['0.5']).toEqual([
        'account_context',
        'context_type_registry',
        'context_membership',
        'line_context',
      ]);
      // One current: 0.4 cannot be made current beside 0.5; a 0.6 row is not insertable.
      await expect(
        q(cleanUrl, `UPDATE canonical_model_versions SET status = 'current' WHERE version = '0.4'`),
      ).rejects.toThrow();
      await expect(
        q(
          cleanUrl,
          `INSERT INTO canonical_model_versions (version, major, minor, status, released_at, catalogue_hash, adr)
           VALUES ('0.6', 0, 6, 'current', now(), repeat('e', 64), '0031')`,
        ),
      ).rejects.toThrow();
    });

    it('V2: the stored 0.1–0.4 catalogue hashes are reproduced unchanged by the code (frozen lists)', async () => {
      for (const v of ['0.1', '0.2', '0.3', '0.4'] as const) {
        expect(canonicalCatalogueHash(canonicalCatalogueFor(v)), v).toBe(STORED_HASHES[v]);
        expect(
          await q(
            cleanUrl,
            `SELECT catalogue_hash FROM canonical_model_versions WHERE version = $1`,
            [v],
          ),
          v,
        ).toEqual([{ catalogue_hash: STORED_HASHES[v] }]);
      }
    });

    it('V3: canonical_modules = code; account_context available at 0.5 with entity kinds [account_context]; no tenant has it enabled by migration', async () => {
      const rows = await q<{
        module_key: string;
        available: boolean;
        minimum_canonical_version: string | null;
      }>(
        cleanUrl,
        `SELECT module_key, available, minimum_canonical_version FROM canonical_modules ORDER BY module_key`,
      );
      expect(rows).toEqual(
        [...CANONICAL_MODULES]
          .map((m) => ({
            module_key: m.key,
            available: m.available,
            minimum_canonical_version: m.minimumCanonicalVersion,
          }))
          .sort((a, b) => a.module_key.localeCompare(b.module_key)),
      );
      expect(rows.filter((r) => r.available)).toEqual([
        { module_key: 'account_context', available: true, minimum_canonical_version: '0.5' },
        { module_key: 'extension', available: true, minimum_canonical_version: '0.4' },
      ]);
      expect(CANONICAL_MODULES.find((m) => m.key === 'account_context')!.entityKinds).toEqual([
        'account_context',
      ]);
      expect(await q(cleanUrl, `SELECT 1 FROM tenant_module_settings`)).toEqual([]);
    });
  });

  describe('V22 / V30: M10E schema guard and privileges', () => {
    it('V22: forced RLS, the tenant policy and tenant-id immutability on the three tables', async () => {
      const rls = await q(
        cleanUrl,
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = ANY($1::text[]) ORDER BY relname`,
        [[...M10E_TABLES]],
      );
      expect(rls).toEqual(
        M10E_TABLES.map((relname) => ({
          relname,
          relrowsecurity: true,
          relforcerowsecurity: true,
        })),
      );
      const policies = await q(
        cleanUrl,
        `SELECT tablename, policyname, qual, with_check FROM pg_policies
          WHERE tablename = ANY($1::text[]) ORDER BY tablename`,
        [[...M10E_TABLES]],
      );
      expect(policies).toEqual(
        M10E_TABLES.map((tablename) => ({
          tablename,
          policyname: 'tenant_isolation',
          qual: '(tenant_id = app_current_tenant())',
          with_check: '(tenant_id = app_current_tenant())',
        })),
      );
      const triggers = await q<{ tgname: string }>(
        cleanUrl,
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY($1::regclass[]) ORDER BY tgname`,
        [[...M10E_TABLES]],
      );
      expect(triggers.map((t) => t.tgname)).toEqual([
        'tenant_account_context_persons_guard',
        'tenant_account_context_persons_tenant_immutable',
        'tenant_account_context_products_guard',
        'tenant_account_context_products_tenant_immutable',
        'tenant_account_contexts_entity_index_add',
        'tenant_account_contexts_entity_index_remove',
        'tenant_account_contexts_guard',
        'tenant_account_contexts_identity_immutable',
        'tenant_account_contexts_line_guard',
        'tenant_account_contexts_tenant_immutable',
      ]);
      // The line / context guard: constraint triggers, DEFERRABLE INITIALLY DEFERRED, on both tables.
      expect(
        await q(
          cleanUrl,
          `SELECT tgrelid::regclass::text AS rel, tgname, tgconstraint <> 0 AS constraint_trigger,
                  tgdeferrable, tginitdeferred
             FROM pg_trigger WHERE tgname IN ('tenant_subscriptions_context_guard', 'tenant_account_contexts_line_guard')
            ORDER BY tgname`,
        ),
      ).toEqual([
        {
          rel: 'tenant_account_contexts',
          tgname: 'tenant_account_contexts_line_guard',
          constraint_trigger: true,
          tgdeferrable: true,
          tginitdeferred: true,
        },
        {
          rel: 'tenant_subscriptions',
          tgname: 'tenant_subscriptions_context_guard',
          constraint_trigger: true,
          tgdeferrable: true,
          tginitdeferred: true,
        },
      ]);
    });

    it('V22: the closed-set CHECKs widened by M10E equal the code catalogues; the context CHECKs are in place', async () => {
      const cases: [string, readonly string[]][] = [
        ['tenant_entity_index_kind_valid', ENTITY_INDEX_KINDS],
        ['tenant_source_references_entity_kind_valid', GENERIC_REFERENCE_KINDS],
        ['tenant_context_changes_entity_kind_valid', CHANGE_ENTITY_KINDS],
        ['tenant_identity_conflicts_kind_valid', IDENTITY_CONFLICT_KINDS],
        ['tenant_identity_conflicts_entity_kind_valid', IDENTITY_CONFLICT_ENTITY_KINDS],
        ['tenant_extension_values_target_kind_valid', EXTENSION_TARGET_KINDS],
        ['tenant_extension_values_ref_kind_valid', EXTENSION_TARGET_KINDS],
        ['tenant_custom_relationships_from_kind_valid', EXTENSION_TARGET_KINDS],
        ['tenant_custom_relationships_to_kind_valid', EXTENSION_TARGET_KINDS],
        ['tenant_audit_events_capability_valid', CAPABILITIES],
        ['tenant_audit_events_action_valid', AUDIT_ACTIONS],
        ['tenant_account_contexts_status_valid', ['active', 'inactive', 'retired']],
        ['tenant_account_contexts_record_state_valid', ['active', 'merged']],
        ['tenant_account_context_persons_status_valid', ['active', 'ended']],
        ['tenant_account_context_products_origin_valid', ['dimension', 'explicit']],
      ];
      for (const [name, code] of cases) expect(await checkValues(name), name).toEqual(sorted(code));
      expect(ENTITY_INDEX_KINDS).toContain('account_context');
      expect(CHANGE_ENTITY_KINDS).toEqual(
        expect.arrayContaining(['account_context', 'account_context_person']),
      );
      expect(CAPABILITIES).toContain('data.account_context.read');
      const defs = await q<{ conname: string; def: string }>(
        cleanUrl,
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'c' AND conrelid = 'tenant_account_contexts'::regclass ORDER BY conname`,
      );
      const def = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
      expect(Object.keys(def)).toEqual(
        expect.arrayContaining([
          'tenant_account_contexts_type_registry_kind',
          'tenant_account_contexts_natural_key_hash_format',
          'tenant_account_contexts_dimensions_flat',
          'tenant_account_contexts_name_length',
          'tenant_account_contexts_owner_ref_format',
          'tenant_account_contexts_merged_target',
          'tenant_account_contexts_not_merged_into_self',
        ]),
      );
      expect(def.tenant_account_contexts_dimensions_flat).toMatch(/app_jsonb_has_secret_like_key/);
      expect(def.tenant_account_contexts_dimensions_flat).toMatch(/4096/);
      expect(def.tenant_account_contexts_owner_ref_format).not.toContain('@');
      // Value history: owner / status of a context and the line's context (Q23).
      const [vh] = await q<{ def: string }>(
        cleanUrl,
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'tenant_value_history_field_valid'`,
      );
      for (const pair of [
        "(entity_kind = 'account_context'::text) AND (field = 'owner_ref'::text)",
        "(entity_kind = 'account_context'::text) AND (field = 'status'::text)",
        "(entity_kind = 'subscription'::text) AND (field = 'context_id'::text)",
      ]) {
        expect(vh!.def, pair).toContain(pair);
      }
    });

    it('V22: guard functions are SECURITY INVOKER with a fixed search_path and no PUBLIC execute; the owner-function allow-list is unchanged', async () => {
      const fns = await q<{ proname: string; prosecdef: boolean; config: string; acl: string }>(
        cleanUrl,
        `SELECT proname, prosecdef, array_to_string(proconfig, ',') AS config,
                coalesce(array_to_string(proacl, ','), '') AS acl FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname IN ('app_account_context_guard', 'app_account_context_person_guard',
                            'app_account_context_product_guard', 'app_line_context_guard')
          ORDER BY proname`,
      );
      expect(fns.map((f) => [f.proname, f.prosecdef])).toEqual([
        ['app_account_context_guard', false],
        ['app_account_context_person_guard', false],
        ['app_account_context_product_guard', false],
        ['app_line_context_guard', false],
      ]);
      for (const f of fns) {
        expect(f.config, f.proname).toMatch(/^search_path=/);
        // REVOKE ALL FROM PUBLIC: no "=X/" (PUBLIC) entry.
        expect(f.acl, f.proname).not.toMatch(/(^|,)=X\//);
      }
      const definers = await q<{ proname: string }>(
        cleanUrl,
        `SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace ORDER BY proname`,
      );
      expect(definers.map((d) => d.proname)).toEqual(sorted(SECURITY_DEFINER_FUNCTIONS));
    });

    it('V21 / V22: every foreign key of the three tables and the line → context link is a composite same-tenant key (RESTRICT)', async () => {
      const defs = await q<{ conname: string; def: string }>(
        cleanUrl,
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'f' AND (conrelid = ANY($1::regclass[])
             OR conname IN ('tenant_subscriptions_tenant_id_context_id_fkey',
                            'tenant_source_authority_versions_tenant_id_account_context_fkey'))
          ORDER BY conname`,
        [[...M10E_TABLES]],
      );
      const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
      const restrict = 'ON UPDATE RESTRICT ON DELETE RESTRICT';
      expect(byName).toMatchObject({
        tenant_account_context_persons_tenant_id_person_id_fkey: `FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id) ${restrict}`,
        tenant_account_context_persons_tenant_id_context_id_fkey: `FOREIGN KEY (tenant_id, context_id) REFERENCES tenant_account_contexts(tenant_id, id) ${restrict}`,
        tenant_account_context_products_tenant_id_product_key_fkey: `FOREIGN KEY (tenant_id, product_key) REFERENCES tenant_products(tenant_id, key) ${restrict}`,
        tenant_account_context_products_tenant_id_context_id_fkey: `FOREIGN KEY (tenant_id, context_id) REFERENCES tenant_account_contexts(tenant_id, id) ${restrict}`,
        tenant_account_contexts_tenant_id_company_id_fkey: `FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ${restrict}`,
        tenant_account_contexts_tenant_id_context_type_registry_ki_fkey: `FOREIGN KEY (tenant_id, context_type_registry_kind, context_type_id) REFERENCES tenant_registry_entries(tenant_id, kind, id) ${restrict}`,
        tenant_subscriptions_tenant_id_context_id_fkey: `FOREIGN KEY (tenant_id, context_id) REFERENCES tenant_account_contexts(tenant_id, id) ${restrict}`,
      });
      for (const d of defs) expect(d.def, d.conname).toMatch(/^FOREIGN KEY \(tenant_id[,)]/);
    });

    it('V30: SELECT / INSERT / UPDATE only (no DELETE / TRUNCATE) on the three tables; DELETE refused as the app role; no DDL privilege', async () => {
      const grants = await q<{ table_name: string; privilege_type: string }>(
        cleanUrl,
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee = 'lip_app' AND table_name = ANY($1::text[])
          ORDER BY table_name, privilege_type`,
        [[...M10E_TABLES]],
      );
      expect(grants.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual(
        M10E_TABLES.flatMap((t) => [`${t}:INSERT`, `${t}:SELECT`, `${t}:UPDATE`]),
      );
      for (const table of M10E_TABLES) {
        expect(sorted(PRIVILEGE_MANIFEST[table]!), table).toEqual(
          grants.filter((g) => g.table_name === table).map((g) => g.privilege_type),
        );
      }
      for (const table of M10E_TABLES) {
        await expect(
          asApp(cleanUrl, randomUUID(), [`DELETE FROM ${table}`]),
          table,
        ).rejects.toMatchObject(pgError('42501', /permission denied/));
        await expect(
          asApp(cleanUrl, randomUUID(), [`TRUNCATE ${table}`]),
          table,
        ).rejects.toMatchObject(pgError('42501'));
      }
      const [row] = await q<Record<string, boolean>>(
        cleanUrl,
        `SELECT has_schema_privilege('lip_app', 'public', 'CREATE') AS schema_create,
                has_database_privilege('lip_app', current_database(), 'CREATE') AS database_create,
                (SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = 'lip_app') AS powerful`,
      );
      expect(row).toEqual({ schema_create: false, database_create: false, powerful: false });
      expect(
        await q(
          cleanUrl,
          `SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relowner = 'lip_app'::regrole`,
          [[...M10E_TABLES]],
        ),
      ).toEqual([]);
      // DDL as the app role is refused.
      await expect(
        asApp(cleanUrl, randomUUID(), ['ALTER TABLE tenant_account_contexts DISABLE TRIGGER ALL']),
      ).rejects.toMatchObject(pgError('42501'));
      await expect(
        asApp(cleanUrl, randomUUID(), ['CREATE TABLE public.m10e_smuggled (id int)']),
      ).rejects.toMatchObject(pgError('42501'));
      await expect(
        asApp(cleanUrl, randomUUID(), [
          'ALTER TABLE tenant_account_contexts NO FORCE ROW LEVEL SECURITY',
        ]),
      ).rejects.toMatchObject(pgError('42501'));
    });

    it('V24: the classification manifest covers every M10E column; dimensions are registry-classified; the person membership is in the data-subject map', async () => {
      for (const table of M10E_TABLES) {
        const columns = await q<{ column_name: string }>(
          cleanUrl,
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
          [table],
        );
        expect(columns.length, table).toBeGreaterThan(0);
        expect(Object.keys(CLASSIFICATION_MANIFEST[table]!).sort(), table).toEqual(
          columns.map((c) => c.column_name),
        );
      }
      expect(CLASSIFICATION_MANIFEST.tenant_subscriptions!.context_id).toBeDefined();
      expect(
        CLASSIFICATION_MANIFEST.tenant_source_authority_versions!.account_context_connection_id,
      ).toBeDefined();
      // Every column of every table is classified (the new columns on existing tables included).
      const all = await q<{ t: string; c: string }>(
        cleanUrl,
        `SELECT table_name AS t, column_name AS c FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name IN ('tenant_subscriptions', 'tenant_source_authority_versions')`,
      );
      for (const { t, c } of all)
        expect(CLASSIFICATION_MANIFEST[t]?.[c], `${t}.${c}`).toBeDefined();
      const contexts = CLASSIFICATION_MANIFEST.tenant_account_contexts!;
      expect(contexts.dimensions).toMatchObject({ classifiedBy: 'registry', kind: 'json' });
      expect(contexts.renewal_date!.sensitivity).toBe('confidential');
      expect(contexts.owner_ref).toMatchObject({ kind: 'identifier', history: 'full' });
      expect(contexts.status).toMatchObject({ history: 'full' });
      const marked = Object.entries(CLASSIFICATION_MANIFEST).flatMap(([t, cols]) =>
        Object.entries(cols)
          .filter(([, c]) => (c as { classifiedBy?: string }).classifiedBy === 'registry')
          .map(([col]) => `${t}.${col}`),
      );
      expect(marked).toContain('tenant_account_contexts.dimensions');
      const subjects = dataSubjectMap();
      const link = subjects
        .find((s) => s.table === 'tenant_account_context_persons')
        ?.columns.find((c) => c.column === 'person_id');
      expect(link).toEqual({ column: 'person_id', entity: 'person', action: 'erase' });
    });
  });

  describe('V21 and the line / context guard (raw SQL as the app role)', () => {
    const tA = 'e10e0000-0000-4e10-8e10-00000000000a';
    const tB = 'e10e0000-0000-4e10-8e10-00000000000b';
    const cA1 = 'e10e0000-2222-4e10-8e10-00000000000a';
    const cA2 = 'e10e0000-2222-4e10-8e10-00000000000b';
    const cB1 = 'e10e0000-2222-4e10-8e10-00000000000c';
    const pA1 = 'e10e0000-3333-4e10-8e10-00000000000a';
    const pB1 = 'e10e0000-3333-4e10-8e10-00000000000b';
    const typeA = 'e10e0000-4444-4e10-8e10-00000000000a';
    const typeB = 'e10e0000-4444-4e10-8e10-00000000000b';
    const ctxA = 'e10e0000-5555-4e10-8e10-00000000000a';
    const ctxB = 'e10e0000-5555-4e10-8e10-00000000000b';
    const lineA = 'e10e0000-6666-4e10-8e10-00000000000a';

    const registry = (t: string, type: string) => `
INSERT INTO tenant_registry_versions (tenant_id, kind, version, base_version, document, document_schema_version,
  content_hash, canonical_version_min, effective_from, actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
VALUES ('${t}', 'context_type', 1, 0, '{"schema_version": 1}', 1, repeat('c', 64), '0.5', now(),
  'operator', 'ops', 'asserted', gen_random_uuid(), gen_random_uuid());
INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
VALUES ('${t}', '${type}', 'context_type', 'renewal', '{"key": "renewal"}', 1, 1, now());`;

    beforeAll(async () => {
      await withAdmin(cleanUrl, (db) =>
        db.query(`
INSERT INTO tenants (id, slug, name, updated_at) VALUES
  ('${tA}', 'metena', 'A', now()), ('${tB}', 'metenb', 'B', now());
INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
  ('${cA1}', '${tA}', 'School A1', now(), now()), ('${cA2}', '${tA}', 'School A2', now(), now()),
  ('${cB1}', '${tB}', 'School B1', now(), now());
INSERT INTO persons (id, tenant_id, primary_email, company_id, created_at, updated_at) VALUES
  ('${pA1}', '${tA}', 'a1@school.example', '${cA1}', now(), now()),
  ('${pB1}', '${tB}', 'b1@school.example', '${cB1}', now(), now());
INSERT INTO tenant_products (tenant_id, key, name, updated_at) VALUES
  ('${tA}', 'core', 'Core', now()), ('${tB}', 'core', 'Core', now()), ('${tB}', 'bonly', 'B only', now());
${registry(tA, typeA)}
${registry(tB, typeB)}
INSERT INTO tenant_account_contexts (tenant_id, id, company_id, context_type_id, natural_key_hash, name) VALUES
  ('${tA}', '${ctxA}', '${cA1}', '${typeA}', repeat('a', 64), 'A renewal'),
  ('${tB}', '${ctxB}', '${cB1}', '${typeB}', repeat('b', 64), 'B renewal');
INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system, source_object_type,
  source_record_id, observed_at) VALUES
  ('${tA}', '${lineA}', '${cA1}', 'core', 'active', 'import', 'subscriptions', 'a-1', now());`),
      );
    });

    /** A fresh context of tenant A on `company` (status given), as the owner. */
    const context = async (company: string, status = 'active'): Promise<string> => {
      const id = randomUUID();
      await q(
        cleanUrl,
        `INSERT INTO tenant_account_contexts (tenant_id, id, company_id, context_type_id, natural_key_hash, name, status)
         VALUES ($1, $2, $3, $4, $5, 'ctx', $6)`,
        [tA, id, company, typeA, hash64(), status],
      );
      return id;
    };
    /** A fresh line of tenant A on `company` (optionally assigned), as the owner. */
    const line = async (company: string, contextId: string | null = null): Promise<string> => {
      const id = randomUUID();
      await q(
        cleanUrl,
        `INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system,
           source_object_type, source_record_id, observed_at, context_id)
         VALUES ($1, $2, $3, 'core', 'active', 'import', 'subscriptions', $4, now(), $5)`,
        [tA, id, company, `l-${id}`, contextId],
      );
      return id;
    };
    const lineContext = async (id: string) =>
      (
        await q<{ context_id: string | null }>(
          cleanUrl,
          `SELECT context_id FROM tenant_subscriptions WHERE id = $1`,
          [id],
        )
      )[0]!.context_id;

    it('the same-tenant links are accepted as the app role (control)', async () => {
      const out = await asApp(
        cleanUrl,
        tA,
        [
          `INSERT INTO tenant_account_context_persons (tenant_id, context_id, person_id, role_code)
           VALUES ('${tA}', '${ctxA}', '${pA1}', 'csm')`,
          `INSERT INTO tenant_account_context_products (tenant_id, context_id, product_key, origin)
           VALUES ('${tA}', '${ctxA}', 'core', 'explicit')`,
          `UPDATE tenant_subscriptions SET context_id = '${ctxA}' WHERE id = '${lineA}'`,
          `SELECT id FROM tenant_account_contexts ORDER BY id`,
        ],
        { rollback: true },
      );
      // Tenant B's context is invisible to tenant A.
      expect(out[3]).toEqual([{ id: ctxA }]);
    });

    it('V21: a membership naming another tenant’s person or context is refused by the composite FK (23503)', async () => {
      await expect(
        asApp(cleanUrl, tA, [
          `INSERT INTO tenant_account_context_persons (tenant_id, context_id, person_id, role_code)
           VALUES ('${tA}', '${ctxA}', '${pB1}', 'csm')`,
        ]),
      ).rejects.toMatchObject(
        pgError('23503', /tenant_account_context_persons_tenant_id_person_id_fkey/),
      );
      await expect(
        asApp(cleanUrl, tA, [
          `INSERT INTO tenant_account_context_persons (tenant_id, context_id, person_id, role_code)
           VALUES ('${tA}', '${ctxB}', '${pA1}', 'csm')`,
        ]),
      ).rejects.toMatchObject(
        pgError('23503', /tenant_account_context_persons_tenant_id_context_id_fkey/),
      );
      // Writing the other tenant's id directly is refused by the policy.
      await expect(
        asApp(cleanUrl, tA, [
          `INSERT INTO tenant_account_context_persons (tenant_id, context_id, person_id, role_code)
           VALUES ('${tB}', '${ctxB}', '${pB1}', 'csm')`,
        ]),
      ).rejects.toMatchObject(pgError('42501', /row-level security/));
      expect(await q(cleanUrl, `SELECT 1 FROM tenant_account_context_persons`)).toEqual([]);
    });

    it('V21: a product membership naming another tenant’s product or context is refused (23503)', async () => {
      await expect(
        asApp(cleanUrl, tA, [
          `INSERT INTO tenant_account_context_products (tenant_id, context_id, product_key, origin)
           VALUES ('${tA}', '${ctxA}', 'bonly', 'explicit')`,
        ]),
      ).rejects.toMatchObject(
        pgError('23503', /tenant_account_context_products_tenant_id_product_key_fkey/),
      );
      await expect(
        asApp(cleanUrl, tA, [
          `INSERT INTO tenant_account_context_products (tenant_id, context_id, product_key, origin)
           VALUES ('${tA}', '${ctxB}', 'core', 'explicit')`,
        ]),
      ).rejects.toMatchObject(
        pgError('23503', /tenant_account_context_products_tenant_id_context_id_fkey/),
      );
      expect(await q(cleanUrl, `SELECT 1 FROM tenant_account_context_products`)).toEqual([]);
    });

    it('V21: a line pointed at another tenant’s context, and a context on another tenant’s account, are refused (23503)', async () => {
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_subscriptions SET context_id = '${ctxB}' WHERE id = '${lineA}'`,
        ]),
      ).rejects.toMatchObject(pgError('23503', /tenant_subscriptions_tenant_id_context_id_fkey/));
      await expect(
        asApp(cleanUrl, tA, [
          `INSERT INTO tenant_account_contexts (tenant_id, company_id, context_type_id, natural_key_hash, name)
           VALUES ('${tA}', '${cB1}', '${typeA}', repeat('d', 64), 'smuggled')`,
        ]),
      ).rejects.toMatchObject(
        pgError('23503', /tenant_account_contexts_tenant_id_company_id_fkey/),
      );
      // Another tenant's context type: the guard finds no active type of this tenant.
      await expect(
        asApp(cleanUrl, tA, [
          `INSERT INTO tenant_account_contexts (tenant_id, company_id, context_type_id, natural_key_hash, name)
           VALUES ('${tA}', '${cA1}', '${typeB}', repeat('d', 64), 'smuggled')`,
        ]),
      ).rejects.toMatchObject(pgError('23514', /account_context_type_not_active/));
      expect(await lineContext(lineA)).toBeNull();
      expect(
        await q(
          cleanUrl,
          `SELECT count(*)::int AS n FROM tenant_account_contexts WHERE name = 'smuggled'`,
        ),
      ).toEqual([{ n: 0 }]);
    });

    it('line guard: a line assigned to a context of another account is accepted by the statement and refused at COMMIT (deferred, account_context_company_mismatch)', async () => {
      const ctx = await context(cA1);
      const other = await line(cA2);
      // The statement itself succeeds (deferred): refused only when the transaction commits.
      await expect(
        asApp(
          cleanUrl,
          tA,
          [`UPDATE tenant_subscriptions SET context_id = '${ctx}' WHERE id = '${other}'`],
          {
            rollback: true,
          },
        ),
      ).resolves.toBeDefined();
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_subscriptions SET context_id = '${ctx}' WHERE id = '${other}'`,
        ]),
      ).rejects.toMatchObject(pgError('23514', /account_context_company_mismatch/));
      expect(await lineContext(other)).toBeNull();
      // SET CONSTRAINTS ... IMMEDIATE makes the same statement fail on the spot.
      await expect(
        asApp(cleanUrl, tA, [
          'SET CONSTRAINTS tenant_subscriptions_context_guard IMMEDIATE',
          `UPDATE tenant_subscriptions SET context_id = '${ctx}' WHERE id = '${other}'`,
        ]),
      ).rejects.toMatchObject(pgError('23514', /account_context_company_mismatch/));
      // A new line inserted with a context of another account is refused too.
      await expect(
        asApp(cleanUrl, tA, [
          `INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system,
             source_object_type, source_record_id, observed_at, context_id)
           VALUES ('${tA}', gen_random_uuid(), '${cA2}', 'core', 'active', 'import', 'subscriptions', 'x-mismatch', now(), '${ctx}')`,
        ]),
      ).rejects.toMatchObject(pgError('23514', /account_context_company_mismatch/));
      // The same-account assignment commits.
      const same = await line(cA1);
      await asApp(cleanUrl, tA, [
        `UPDATE tenant_subscriptions SET context_id = '${ctx}' WHERE id = '${same}'`,
      ]);
      expect(await lineContext(same)).toBe(ctx);
    });

    it('line guard: moving a context to another account while its lines stay is refused at COMMIT; moving lines and context together in one transaction commits', async () => {
      const ctx = await context(cA1);
      const assigned = await line(cA1, ctx);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_account_contexts SET company_id = '${cA2}' WHERE id = '${ctx}'`,
        ]),
      ).rejects.toMatchObject(pgError('23514', /account_context_company_mismatch/));
      expect(
        await q(cleanUrl, `SELECT company_id FROM tenant_account_contexts WHERE id = $1`, [ctx]),
      ).toEqual([{ company_id: cA1 }]);
      // A company merge re-points both inside one transaction (either order): commits.
      await withAdmin(cleanUrl, async (db) => {
        await db.query('BEGIN');
        await db.query(`UPDATE tenant_account_contexts SET company_id = $1 WHERE id = $2`, [
          cA2,
          ctx,
        ]);
        await db.query(`UPDATE tenant_subscriptions SET company_id = $1 WHERE id = $2`, [
          cA2,
          assigned,
        ]);
        await db.query('COMMIT');
      });
      expect(
        await q(
          cleanUrl,
          `SELECT s.company_id AS line_company, c.company_id AS context_company
             FROM tenant_subscriptions s JOIN tenant_account_contexts c ON c.tenant_id = s.tenant_id AND c.id = s.context_id
            WHERE s.id = $1`,
          [assigned],
        ),
      ).toEqual([{ line_company: cA2, context_company: cA2 }]);
    });

    it('line guard: a retired context is not assignable (account_context_not_assignable at COMMIT)', async () => {
      const retired = await context(cA1, 'retired');
      const free = await line(cA1);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_subscriptions SET context_id = '${retired}' WHERE id = '${free}'`,
        ]),
      ).rejects.toMatchObject(pgError('23514', /account_context_not_assignable/));
      expect(await lineContext(free)).toBeNull();
    });
  });

  describe('V29: the M10E migration on M10D data', () => {
    const tA = 'd10e0000-0000-4d10-8d10-00000000000a';
    const tB = 'd10e0000-0000-4d10-8d10-00000000000b';
    const cA1 = 'd10e0000-2222-4d10-8d10-00000000000a';
    const pA1 = 'd10e0000-3333-4d10-8d10-00000000000a';
    const lA1 = 'd10e0000-4444-4d10-8d10-00000000000a';
    const ON = 'SET session_replication_role = replica;';
    const OFF = 'SET session_replication_role = origin;';
    /** A: a company, a person, a product and a line, an adoption of 0.4, a published data policy; B: empty. */
    const SEED = `INSERT INTO tenants (id, slug, name, updated_at) VALUES
  ('${tA}', 'mdetena', 'A', now()), ('${tB}', 'mdetenb', 'B', now());
INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
  ('${cA1}', '${tA}', 'School A', now(), now());
INSERT INTO persons (id, tenant_id, primary_email, company_id, created_at, updated_at) VALUES
  ('${pA1}', '${tA}', 'a1@school.example', '${cA1}', now(), now());
INSERT INTO tenant_products (tenant_id, key, name, updated_at) VALUES ('${tA}', 'core', 'Core', now());
INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system, source_object_type,
  source_record_id, observed_at) VALUES
  ('${tA}', '${lA1}', '${cA1}', 'core', 'active', 'import', 'subscriptions', 'r1', now());
${ON}
INSERT INTO tenant_canonical_adoptions (tenant_id, id, seq, version, previous_version, reason,
  actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
VALUES ('${tA}', gen_random_uuid(), 1, '0.4', NULL, 'new_tenant', 'system', 'test', 'system', gen_random_uuid(), gen_random_uuid());
INSERT INTO tenant_registry_versions (tenant_id, kind, version, base_version, document, document_schema_version,
  content_hash, canonical_version_min, effective_from, actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
VALUES ('${tA}', 'data_policy', 1, 0, '{"schema": 1, "raw_retention": false}', 1, repeat('d', 64), '0.4', now(),
  'operator', 'ops', 'asserted', gen_random_uuid(), gen_random_uuid());
INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
VALUES ('${tA}', gen_random_uuid(), 'data_policy', 'data_policy', '{"schema": 1}', 1, 1, now());
${OFF}`;

    /** Migrations through M10D only (M10E excluded). */
    async function migrateThroughM10D(url: string, name: string): Promise<string> {
      const dir = resolve(`test/.tmp/${name}-m10d`);
      try {
        return await migrate(url, ['--config', migrationsBefore(dir, '20270119')]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    /** A database at the M10D state (optionally holding SEED). */
    async function m10dDatabase(name: string, seed = true): Promise<string> {
      const url = await createDatabase(pg, name);
      await migrateThroughM10D(url, name);
      if (seed) await withAdmin(url, (db) => db.query(SEED));
      return url;
    }
    const state = (url: string) =>
      q<Record<string, unknown>>(
        url,
        `SELECT (SELECT count(*)::int FROM tenant_account_contexts) AS contexts,
                (SELECT count(*)::int FROM tenant_account_context_persons) AS persons,
                (SELECT count(*)::int FROM tenant_account_context_products) AS products,
                (SELECT count(*)::int FROM tenant_subscriptions) AS lines,
                (SELECT count(*)::int FROM tenant_subscriptions WHERE context_id IS NOT NULL) AS assigned,
                (SELECT count(*)::int FROM tenant_registry_entries WHERE kind = 'context_type') AS context_types,
                (SELECT count(*)::int FROM tenant_entity_index WHERE kind = 'account_context') AS indexed,
                (SELECT count(*)::int FROM tenant_source_authority_versions WHERE account_context_connection_id IS NOT NULL) AS authority,
                (SELECT count(*)::int FROM tenant_module_settings) AS module_settings,
                (SELECT string_agg(version, ',' ORDER BY seq) FROM tenant_canonical_adoptions) AS adoptions,
                (SELECT count(*)::int FROM tenant_context_changes) AS changes`,
      );
    const EXPECTED_STATE = {
      contexts: 0,
      persons: 0,
      products: 0,
      lines: 1,
      assigned: 0,
      context_types: 0,
      indexed: 0,
      authority: 0,
      module_settings: 0,
      adoptions: '0.4',
      changes: 0,
    };
    const versions = (url: string) =>
      q(url, `SELECT version, status FROM canonical_model_versions ORDER BY major, minor`);

    it('applies with no backfill: no context type, context, membership, assignment, setting or adoption is invented; 0.5 current; rerun is a no-op', async () => {
      const url = await m10dDatabase('m10e_on_m10d');
      const output = await migrate(url);
      expect(output).toMatch(new RegExp(M10E));
      expect(await state(url)).toEqual([EXPECTED_STATE]);
      expect(await versions(url)).toEqual([
        { version: '0.1', status: 'supported' },
        { version: '0.2', status: 'supported' },
        { version: '0.3', status: 'supported' },
        { version: '0.4', status: 'supported' },
        { version: '0.5', status: 'current' },
      ]);
      await expect(migrate(url)).resolves.toMatch(/No pending migrations/);
      expect(await state(url)).toEqual([EXPECTED_STATE]);
    });

    it('the down-script refuses each M10E data class (changing nothing), then restores exactly the M10D schema; M10E re-applies with no drift', async () => {
      const before = await m10dDatabase('m10e_before_db', false);
      const url = await m10dDatabase('m10e_down_db');
      await migrate(url);
      const latest = await schemaSnapshot(url);
      // #90 then #83 sit on top of M10E: their (data-free) rollbacks run first, #90 first.
      await withAdmin(url, (db) => db.query(readFileSync(H90_DOWN, 'utf8')));
      await withAdmin(url, (db) => db.query(readFileSync(H83_DOWN, 'utf8')));
      const down = readFileSync(M10E_DOWN, 'utf8');
      const audit = (capability: string, action: string) =>
        `INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance,
           capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
         VALUES ('${tA}', gen_random_uuid(), 1, now(), 'operator', 'ops', 'asserted', '${capability}', '${action}',
           'allowed', gen_random_uuid(), 6, '{}', repeat('0', 64), repeat('a', 64))`;
      const change = (kind: string) =>
        `INSERT INTO tenant_context_changes (tenant_id, id, entity_kind, entity_id, change_type, source_system,
           source_object_type, source_record_id, cause, adapter, adapter_version, correlation_id, changed_fields)
         VALUES ('${tA}', gen_random_uuid(), '${kind}', gen_random_uuid(), 'updated', 'hubspot', 'companies', '1',
           'webhook', 'hubspot', '1', gen_random_uuid(), ARRAY['name']::text[])`;
      const history = (kind: string, field: string) =>
        `INSERT INTO tenant_value_history (tenant_id, id, entity_kind, entity_id, field, values_recorded, effective_at,
           change_id, retention_class, actor_kind, actor_id, actor_assurance)
         VALUES ('${tA}', gen_random_uuid(), '${kind}', gen_random_uuid(), '${field}', false, now(), gen_random_uuid(),
           'canonical_lifecycle', 'system', 'test', 'system')`;
      const conflict = (kind: string, entityKind: string) =>
        `INSERT INTO tenant_identity_conflicts (tenant_id, id, kind, entity_kind, conflict_key)
         VALUES ('${tA}', gen_random_uuid(), '${kind}', '${entityKind}', repeat('a', 64))`;
      const adoption = (version: string, previous: string, reason: string) =>
        `INSERT INTO tenant_canonical_adoptions (tenant_id, id, seq, version, previous_version, reason,
           actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
         VALUES ('${tA}', gen_random_uuid(), 2, '${version}', '${previous}', '${reason}',
           'operator', 'ops', 'asserted', gen_random_uuid(), gen_random_uuid())`;
      const refusals: [string, string, RegExp][] = [
        [
          `INSERT INTO tenant_registry_versions (tenant_id, kind, version, base_version, document, document_schema_version,
             content_hash, canonical_version_min, effective_from, actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
           VALUES ('${tA}', 'context_type', 1, 0, '{"schema_version": 1}', 1, repeat('a', 64), '0.5', now(),
             'operator', 'ops', 'asserted', gen_random_uuid(), gen_random_uuid())`,
          `DELETE FROM tenant_registry_versions WHERE kind = 'context_type'`,
          /refusing rollback: 1 context_type registry versions exist/,
        ],
        [
          `INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
           VALUES ('${tA}', gen_random_uuid(), 'context_type', 'renewal', '{}', 1, 1, now())`,
          `DELETE FROM tenant_registry_entries WHERE kind = 'context_type'`,
          /refusing rollback: 1 context_type registry entries exist/,
        ],
        [
          `INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
           VALUES ('${tA}', gen_random_uuid(), 'extension', 'region', '{"kind": "field", "target": "account_context"}', 1, 1, now())`,
          `DELETE FROM tenant_registry_entries WHERE kind = 'extension'`,
          /refusing rollback: 1 extension definitions target account_context/,
        ],
        // Review M2: a relationship end or a reference_to naming account_context also refuses.
        [
          `INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
           VALUES ('${tA}', gen_random_uuid(), 'extension', 'scope_rel', '{"kind": "custom_relationship", "from": "account", "to": "account_context"}', 1, 1, now())`,
          `DELETE FROM tenant_registry_entries WHERE kind = 'extension'`,
          /refusing rollback: 1 extension definitions reference account_context/,
        ],
        // Review M2: a relationship end or a reference_to naming account_context also refuses.
        [
          `INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
           VALUES ('${tA}', gen_random_uuid(), 'extension', 'rel_scope', '{"kind": "custom_relationship", "from": "account_context", "to": "account"}', 1, 1, now())`,
          `DELETE FROM tenant_registry_entries WHERE kind = 'extension'`,
          /refusing rollback: 1 extension definitions reference account_context/,
        ],
        // Review M2: a relationship end or a reference_to naming account_context also refuses.
        [
          `INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
           VALUES ('${tA}', gen_random_uuid(), 'extension', 'scope_ref', '{"kind": "field", "target": "account", "constraints": {"reference_to": ["person", "account_context"]}}', 1, 1, now())`,
          `DELETE FROM tenant_registry_entries WHERE kind = 'extension'`,
          /refusing rollback: 1 extension definitions reference account_context/,
        ],
        [
          `INSERT INTO tenant_account_contexts (tenant_id, company_id, context_type_id, natural_key_hash, name)
           VALUES ('${tA}', '${cA1}', gen_random_uuid(), repeat('a', 64), 'X')`,
          `DELETE FROM tenant_account_contexts`,
          /refusing rollback: 1 account contexts exist/,
        ],
        [
          `INSERT INTO tenant_account_context_persons (tenant_id, context_id, person_id, role_code)
           VALUES ('${tA}', gen_random_uuid(), '${pA1}', 'csm')`,
          `DELETE FROM tenant_account_context_persons`,
          /refusing rollback: 1 account-context person memberships exist/,
        ],
        [
          `INSERT INTO tenant_account_context_products (tenant_id, context_id, product_key, origin)
           VALUES ('${tA}', gen_random_uuid(), 'core', 'explicit')`,
          `DELETE FROM tenant_account_context_products`,
          /refusing rollback: 1 account-context product memberships exist/,
        ],
        [
          `UPDATE tenant_subscriptions SET context_id = gen_random_uuid() WHERE id = '${lA1}'`,
          `UPDATE tenant_subscriptions SET context_id = NULL WHERE id = '${lA1}'`,
          /refusing rollback: 1 subscription lines carry an account context/,
        ],
        [
          `INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version, account_context_connection_id,
             content_hash, published_by)
           VALUES ('${tA}', 1, 0, gen_random_uuid(), repeat('a', 64), 'test')`,
          `DELETE FROM tenant_source_authority_versions`,
          /refusing rollback: 1 authority versions name an account_context connection/,
        ],
        [
          `INSERT INTO tenant_entity_index (tenant_id, kind, entity_id) VALUES ('${tA}', 'account_context', gen_random_uuid())`,
          `DELETE FROM tenant_entity_index WHERE kind = 'account_context'`,
          /refusing rollback: 1 account_context entity-index rows exist/,
        ],
        [
          `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_id, origin)
           VALUES ('${tA}', 'sugar', 'Relationship', 'r-1', 'account_context', gen_random_uuid(), 'observed')`,
          `DELETE FROM tenant_source_references WHERE entity_kind = 'account_context'`,
          /refusing rollback: 1 account_context source references exist/,
        ],
        [
          change('account_context'),
          `DELETE FROM tenant_context_changes`,
          /refusing rollback: 1 change records use M10E kinds/,
        ],
        [
          change('account_context_person'),
          `DELETE FROM tenant_context_changes`,
          /refusing rollback: 1 change records use M10E kinds/,
        ],
        [
          history('account_context', 'owner_ref'),
          `DELETE FROM tenant_value_history`,
          /refusing rollback: 1 value history rows of M10E fields exist/,
        ],
        [
          history('subscription', 'context_id'),
          `DELETE FROM tenant_value_history`,
          /refusing rollback: 1 value history rows of M10E fields exist/,
        ],
        [
          conflict('account_context_company_mismatch', 'subscription'),
          `DELETE FROM tenant_identity_conflicts`,
          /refusing rollback: 1 identity conflicts of M10E kinds exist/,
        ],
        [
          conflict('shared_email', 'account_context'),
          `DELETE FROM tenant_identity_conflicts`,
          /refusing rollback: 1 identity conflicts of M10E kinds exist/,
        ],
        [
          `INSERT INTO tenant_extension_values (tenant_id, target_kind, target_id, field_id, value_type, value_state,
             origin, registry_version)
           VALUES ('${tA}', 'account_context', gen_random_uuid(), gen_random_uuid(), 'string', 'empty', 'human', 1)`,
          `DELETE FROM tenant_extension_values`,
          /refusing rollback: 1 extension values name an account context/,
        ],
        [
          `INSERT INTO tenant_extension_values (tenant_id, target_kind, target_id, field_id, value_type, value_state,
             origin, registry_version, value_ref_kind, value_ref_id)
           VALUES ('${tA}', 'company', '${cA1}', gen_random_uuid(), 'reference', 'present', 'human', 1,
             'account_context', gen_random_uuid())`,
          `DELETE FROM tenant_extension_values`,
          /refusing rollback: 1 extension values name an account context/,
        ],
        [
          `INSERT INTO tenant_custom_relationships (tenant_id, rel_def_id, from_kind, from_id, to_kind, to_id, origin)
           VALUES ('${tA}', gen_random_uuid(), 'account_context', gen_random_uuid(), 'custom_record', gen_random_uuid(), 'human')`,
          `DELETE FROM tenant_custom_relationships`,
          /refusing rollback: 1 custom relationships name an account context/,
        ],
        [
          `INSERT INTO tenant_module_settings (tenant_id, module_key, enabled, version, updated_at, updated_by_kind,
             updated_by_id, updated_by_assurance)
           VALUES ('${tA}', 'account_context', false, 2, now(), 'operator', 'ops', 'asserted')`,
          `DELETE FROM tenant_module_settings`,
          /refusing rollback: 1 tenant settings of module account_context exist/,
        ],
        [
          `INSERT INTO tenant_module_setting_events (tenant_id, id, seq, module_key, to_enabled, to_config_hash,
             base_version, actor_kind, actor_id, actor_assurance, audit_event_id)
           VALUES ('${tA}', gen_random_uuid(), 1, 'account_context', true, repeat('a', 64), 0, 'operator', 'ops',
             'asserted', gen_random_uuid())`,
          `DELETE FROM tenant_module_setting_events`,
          /refusing rollback: 1 setting events of module account_context exist/,
        ],
        [
          adoption('0.5', '0.4', 'operator_adoption'),
          `DELETE FROM tenant_canonical_adoptions WHERE seq = 2`,
          /refusing rollback: 1 adoptions of canonical 0.5 exist/,
        ],
        [
          // A rollback away from 0.5 (previous_version) also names 0.5.
          adoption('0.4', '0.5', 'rollback'),
          `DELETE FROM tenant_canonical_adoptions WHERE seq = 2`,
          /refusing rollback: 1 adoptions of canonical 0.5 exist/,
        ],
        [
          audit('data.account_context.read', 'account_context.read'),
          `DELETE FROM tenant_audit_events`,
          /refusing rollback: 1 audit events use M10E capabilities or actions/,
        ],
        [
          audit('canonical.human_entry', 'account_context.write'),
          `DELETE FROM tenant_audit_events`,
          /refusing rollback: 1 audit events use M10E capabilities or actions/,
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
      expect(await state(url)).toEqual([EXPECTED_STATE]);
      await withAdmin(url, (db) => db.query(down));
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(before));
      expect(await versions(url)).toEqual([
        { version: '0.1', status: 'supported' },
        { version: '0.2', status: 'supported' },
        { version: '0.3', status: 'supported' },
        { version: '0.4', status: 'current' },
      ]);
      expect(
        await q(
          url,
          `SELECT available, minimum_canonical_version FROM canonical_modules WHERE module_key = 'account_context'`,
        ),
      ).toEqual([{ available: false, minimum_canonical_version: null }]);
      // The functions and their grants are the M10D set again.
      const fns = (u: string) =>
        q<{ v: string }>(
          u,
          `SELECT proname || ' ' || prosecdef || ' ' || coalesce(array_to_string(proacl, ','), '') AS v
             FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`,
        );
      expect(await fns(url)).toEqual(await fns(before));
      expect(
        await q(url, `SELECT migration_name FROM _prisma_migrations WHERE migration_name = $1`, [
          M10E,
        ]),
      ).toEqual([]);
      // M10D data is untouched by the round trip.
      expect(
        await q(
          url,
          `SELECT company_id::text AS company FROM tenant_subscriptions WHERE id = '${lA1}'`,
        ),
      ).toEqual([{ company: cA1 }]);
      const output = await migrate(url);
      expect(output).toMatch(new RegExp(M10E));
      expect(await schemaSnapshot(url)).toEqual(latest);
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(cleanUrl));
      expect(await state(url)).toEqual([EXPECTED_STATE]);
      // Drift: the re-applied database matches the Prisma schema exactly.
      const diff = await run(
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
          env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url },
        },
      ).then(
        (r) => ({ code: 0, out: r.stdout }),
        (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }),
      );
      expect(diff.out).toMatch(/No difference detected/);
      expect(diff.code).toBe(0);
    });
  });
});
