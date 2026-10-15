import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CANONICAL_MODULES,
  CANONICAL_VERSIONS,
  CHANGE_ENTITY_KINDS,
  CUSTOM_RECORD_PARENT_KINDS,
  CUSTOM_RECORD_STATES,
  CUSTOM_RELATIONSHIP_END_REASONS,
  CUSTOM_RELATIONSHIP_STATES,
  ENTITY_INDEX_KINDS,
  EXTENSION_ITEM_TYPES,
  EXTENSION_ORIGINS,
  EXTENSION_TARGET_KINDS,
  EXTENSION_VALUE_STATES,
  EXTENSION_VALUE_TYPES,
  GENERIC_REFERENCE_KINDS,
  IDENTITY_CONFLICT_ENTITY_KINDS,
  IDENTITY_CONFLICT_KINDS,
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

/** M10D migration (extension framework, canonical 0.4, ADR 0030). */
const M10D = '20270112120000_m10d_extension_framework';
const M10D_DOWN = resolve(`prisma/rollback/${M10D}.down.sql`);
/**
 * Stored catalogue hashes: 0.1–0.3 from their own migrations (never
 * recomputed into new values) and 0.4 as pinned in the M10D migration.
 */
const STORED_HASHES = {
  '0.1': '2fd4f7e575633de7cac4aea394a71c73adc9b73e5e18b67c0b0ee404572faf5b',
  '0.2': 'db7c0fc245cae469e8cddae88b89077c017805c7b87586b9d3e71f1936c96c98',
  '0.3': '70db9aa697147cf1d0d63e93a923ed8714b78da32550aaefe5699597e26eb069',
  '0.4': '70584afd267f4c5620c2d63c95cc547f18c1cacdb0b408304eea9a41aeae81c7',
} as const;
const M10D_TABLES = [
  'tenant_custom_records',
  'tenant_custom_relationships',
  'tenant_extension_value_items',
  'tenant_extension_values',
] as const;

/**
 * M10D migration and schema guard (plan §10, §11, §13, §22 V15 / V17 / V22 /
 * V24), in its own file (tech debt #72): the canonical catalogue and the
 * module row in the database (V17); the M10D schema guard — forced RLS,
 * privileges (DELETE on the items table only), closed-set CHECKs equal to the
 * code, triggers, guard functions, composite same-tenant foreign keys,
 * classification manifest with the registry marker and the data-subject map
 * (V22); no DDL privilege for the app role (V15, with the event-trigger
 * capture in extension-governance.int.spec.ts); the migration on M10C data —
 * no backfill, rerun, each down-script refusal planted (changing nothing),
 * exact restore of the M10C schema and re-apply (V24).
 */
describe('M10D migration and schema guard', () => {
  let pg: StartedPostgreSqlContainer;
  let cleanUrl: string;

  beforeAll(async () => {
    pg = await startPostgres();
    cleanUrl = await createDatabase(pg, 'm10d_clean');
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

  describe('V17: canonical catalogue and module in the database', () => {
    it('0.4 published (ADR 0030; supported since M10E, 0.5 current) with the pinned hash the code reproduces; 0.1–0.3 supported and unchanged; one current; 1.0 refused', async () => {
      const rows = await q<Record<string, unknown>>(
        cleanUrl,
        'SELECT version, status, adr, catalogue_hash FROM canonical_model_versions ORDER BY major, minor',
      );
      expect(rows).toEqual([
        { version: '0.1', status: 'supported', adr: '0027', catalogue_hash: STORED_HASHES['0.1'] },
        { version: '0.2', status: 'supported', adr: '0028', catalogue_hash: STORED_HASHES['0.2'] },
        { version: '0.3', status: 'supported', adr: '0029', catalogue_hash: STORED_HASHES['0.3'] },
        { version: '0.4', status: 'supported', adr: '0030', catalogue_hash: STORED_HASHES['0.4'] },
        // M10E (ADR 0031) sits on top.
        {
          version: '0.5',
          status: 'current',
          adr: '0031',
          catalogue_hash: canonicalCatalogueHash(canonicalCatalogueFor('0.5')),
        },
      ]);
      for (const v of ['0.1', '0.2', '0.3', '0.4'] as const) {
        expect(canonicalCatalogueHash(canonicalCatalogueFor(v)), v).toBe(STORED_HASHES[v]);
      }
      expect(CANONICAL_VERSIONS.map((v) => [v.version, v.status])).toEqual([
        ['0.1', 'supported'],
        ['0.2', 'supported'],
        ['0.3', 'supported'],
        ['0.4', 'supported'],
        ['0.5', 'current'],
      ]);
      // 0.4 adds the extension members; 0.3 does not carry them (frozen lists).
      const c03 = canonicalCatalogueFor('0.3') as unknown as Record<string, unknown>;
      const c04 = canonicalCatalogueFor('0.4') as unknown as Record<string, unknown>;
      for (const member of [
        'extensionValueTypes',
        'extensionTargets',
        'extensionAllowedUses',
        'mappingEntryKinds',
      ]) {
        expect(c04[member], member).toBeDefined();
        expect(c03[member], member).toBeUndefined();
      }
      expect(c04.entityKinds).toContain('custom_record');
      expect(c03.entityKinds).not.toContain('custom_record');
      await expect(
        q(cleanUrl, `UPDATE canonical_model_versions SET status = 'current' WHERE version = '0.3'`),
      ).rejects.toThrow();
      await expect(
        q(
          cleanUrl,
          `INSERT INTO canonical_model_versions (version, major, minor, status, released_at, catalogue_hash, adr)
           VALUES ('1.0', 1, 0, 'supported', now(), repeat('e', 64), '0030')`,
        ),
      ).rejects.toThrow();
    });

    it('module extension is available at 0.4 (row = code), every other module but account_context (M10E) unavailable; no tenant has it enabled by migration', async () => {
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
        // M10E: account_context available at 0.5.
        { module_key: 'account_context', available: true, minimum_canonical_version: '0.5' },
        { module_key: 'extension', available: true, minimum_canonical_version: '0.4' },
      ]);
      expect(CANONICAL_MODULES.find((m) => m.key === 'extension')!.entityKinds).toEqual([
        'custom_record',
      ]);
      expect(await q(cleanUrl, `SELECT 1 FROM tenant_module_settings`)).toEqual([]);
    });
  });

  describe('V22: M10D schema guard', () => {
    it('forced RLS, the tenant policy and tenant-id immutability on the four tables; DELETE is granted on the items table only', async () => {
      const rls = await q<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        cleanUrl,
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = ANY($1::text[]) ORDER BY relname`,
        [[...M10D_TABLES]],
      );
      expect(rls).toEqual(
        M10D_TABLES.map((relname) => ({
          relname,
          relrowsecurity: true,
          relforcerowsecurity: true,
        })),
      );
      const policies = await q<{ tablename: string; qual: string; with_check: string }>(
        cleanUrl,
        `SELECT tablename, qual, with_check FROM pg_policies
          WHERE tablename = ANY($1::text[]) ORDER BY tablename`,
        [[...M10D_TABLES]],
      );
      expect(policies).toEqual(
        M10D_TABLES.map((tablename) => ({
          tablename,
          qual: '(tenant_id = app_current_tenant())',
          with_check: '(tenant_id = app_current_tenant())',
        })),
      );
      const grants = await q<{ table_name: string; privilege_type: string }>(
        cleanUrl,
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee = 'lip_app' AND table_name = ANY($1::text[])
          ORDER BY table_name, privilege_type`,
        [[...M10D_TABLES]],
      );
      expect(grants.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual([
        'tenant_custom_records:INSERT',
        'tenant_custom_records:SELECT',
        'tenant_custom_records:UPDATE',
        'tenant_custom_relationships:INSERT',
        'tenant_custom_relationships:SELECT',
        'tenant_custom_relationships:UPDATE',
        'tenant_extension_value_items:DELETE',
        'tenant_extension_value_items:INSERT',
        'tenant_extension_value_items:SELECT',
        'tenant_extension_values:INSERT',
        'tenant_extension_values:SELECT',
        'tenant_extension_values:UPDATE',
      ]);
      for (const table of M10D_TABLES) {
        expect(sorted(PRIVILEGE_MANIFEST[table]!), table).toEqual(
          grants.filter((g) => g.table_name === table).map((g) => g.privilege_type),
        );
      }
      // Behaviourally: as the app role, DELETE on values / records / edges is refused; on items it is allowed.
      const asApp = (sql: string) =>
        q(
          cleanUrl,
          `DO $$ BEGIN
             SET LOCAL ROLE lip_app;
             PERFORM set_config('app.current_tenant', gen_random_uuid()::text, true);
             ${sql};
           END $$`,
        );
      for (const table of [
        'tenant_extension_values',
        'tenant_custom_records',
        'tenant_custom_relationships',
      ]) {
        await expect(asApp(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
      }
      await expect(asApp('DELETE FROM tenant_extension_value_items')).resolves.toBeDefined();
      const triggers = await q<{ tgname: string }>(
        cleanUrl,
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY($1::regclass[]) ORDER BY tgname`,
        [[...M10D_TABLES]],
      );
      expect(triggers.map((t) => t.tgname)).toEqual([
        'tenant_custom_records_entity_index_add',
        'tenant_custom_records_entity_index_remove',
        'tenant_custom_records_guard',
        'tenant_custom_records_identity_immutable',
        'tenant_custom_records_tenant_immutable',
        'tenant_custom_relationships_guard',
        'tenant_custom_relationships_tenant_immutable',
        'tenant_extension_value_items_tenant_immutable',
        'tenant_extension_values_guard',
        'tenant_extension_values_tenant_immutable',
      ]);
    });

    it('V15: the app role has no DDL privilege (no CREATE on the schema or the database) and stays powerless', async () => {
      const [row] = await q<Record<string, boolean>>(
        cleanUrl,
        `SELECT has_schema_privilege('lip_app', 'public', 'CREATE') AS schema_create,
                has_database_privilege('lip_app', current_database(), 'CREATE') AS database_create,
                (SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = 'lip_app') AS powerful`,
      );
      expect(row).toEqual({ schema_create: false, database_create: false, powerful: false });
      // No new table is owned by the app role.
      expect(
        await q(
          cleanUrl,
          `SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relowner = 'lip_app'::regrole`,
          [[...M10D_TABLES]],
        ),
      ).toEqual([]);
    });

    it('the closed-set CHECKs equal the code catalogues; the typed and integrity CHECKs are in place', async () => {
      const cases: [string, readonly string[]][] = [
        ['tenant_extension_values_target_kind_valid', EXTENSION_TARGET_KINDS],
        ['tenant_extension_values_value_type_valid', EXTENSION_VALUE_TYPES],
        ['tenant_extension_values_value_state_valid', EXTENSION_VALUE_STATES],
        ['tenant_extension_values_origin_valid', EXTENSION_ORIGINS],
        ['tenant_extension_values_ref_kind_valid', EXTENSION_TARGET_KINDS],
        ['tenant_extension_value_items_item_type_valid', EXTENSION_ITEM_TYPES],
        ['tenant_custom_records_parent_kind_valid', CUSTOM_RECORD_PARENT_KINDS],
        ['tenant_custom_records_state_valid', CUSTOM_RECORD_STATES],
        ['tenant_custom_records_origin_valid', EXTENSION_ORIGINS],
        ['tenant_custom_relationships_from_kind_valid', EXTENSION_TARGET_KINDS],
        ['tenant_custom_relationships_to_kind_valid', EXTENSION_TARGET_KINDS],
        ['tenant_custom_relationships_state_valid', CUSTOM_RELATIONSHIP_STATES],
        ['tenant_custom_relationships_end_reason_valid', CUSTOM_RELATIONSHIP_END_REASONS],
        ['tenant_custom_relationships_origin_valid', EXTENSION_ORIGINS],
        ['tenant_entity_index_kind_valid', ENTITY_INDEX_KINDS],
        ['tenant_source_references_entity_kind_valid', GENERIC_REFERENCE_KINDS],
        ['tenant_context_changes_entity_kind_valid', CHANGE_ENTITY_KINDS],
        ['tenant_identity_conflicts_kind_valid', IDENTITY_CONFLICT_KINDS],
        ['tenant_identity_conflicts_entity_kind_valid', IDENTITY_CONFLICT_ENTITY_KINDS],
        ['tenant_audit_events_capability_valid', CAPABILITIES],
        ['tenant_audit_events_action_valid', AUDIT_ACTIONS],
      ];
      for (const [name, code] of cases) expect(await checkValues(name), name).toEqual(sorted(code));
      expect(ENTITY_INDEX_KINDS).toContain('custom_record');
      expect(CHANGE_ENTITY_KINDS).toEqual(
        expect.arrayContaining(['custom_record', 'custom_relationship']),
      );
      expect(CAPABILITIES).toContain('data.extension.read');
      const defs = await q<{ conname: string; def: string }>(
        cleanUrl,
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'c' AND conname = ANY($1::text[]) ORDER BY conname`,
        [
          [
            'tenant_extension_values_typed',
            'tenant_extension_values_integer_scale',
            'tenant_extension_values_json_size',
            'tenant_extension_values_json_no_secrets',
            'tenant_extension_values_currency_format',
            'tenant_extension_values_text_length',
            'tenant_extension_value_items_typed',
            'tenant_custom_relationships_custom_end',
            'tenant_context_changes_fields_format',
            'tenant_source_mapping_versions_document_object',
            'tenant_source_mapping_drafts_document_object',
          ],
        ],
      );
      expect(defs.map((d) => d.conname)).toHaveLength(11);
      const def = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
      expect(def.tenant_extension_values_json_size).toMatch(/65536/);
      expect(def.tenant_extension_values_json_size).toMatch(/app_jsonb_depth\(value_json\) <= 16/);
      expect(def.tenant_extension_values_json_no_secrets).toMatch(/app_jsonb_has_secret_like_key/);
      expect(def.tenant_extension_values_integer_scale).toMatch(/trunc\(value_number\)/);
      expect(def.tenant_context_changes_fields_format).toContain('ext:');
      // Q4: the mapping document cap widened to 1 MiB (draft and version).
      expect(def.tenant_source_mapping_versions_document_object).toMatch(/1048576/);
      expect(def.tenant_source_mapping_drafts_document_object).toMatch(/1048576/);
    });

    it('guard functions are SECURITY INVOKER with a fixed search_path; app_jsonb_depth is IMMUTABLE; the owner-function allow-list is unchanged', async () => {
      const fns = await q<{
        proname: string;
        prosecdef: boolean;
        provolatile: string;
        config: string;
      }>(
        cleanUrl,
        `SELECT proname, prosecdef, provolatile, array_to_string(proconfig, ',') AS config FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname IN ('app_jsonb_depth', 'app_extension_value_guard', 'app_custom_record_guard',
                            'app_custom_relationship_guard')
          ORDER BY proname`,
      );
      expect(fns.map((f) => [f.proname, f.prosecdef, f.provolatile])).toEqual([
        ['app_custom_record_guard', false, 'v'],
        ['app_custom_relationship_guard', false, 'v'],
        ['app_extension_value_guard', false, 'v'],
        ['app_jsonb_depth', false, 'i'],
      ]);
      expect(fns.every((f) => f.config.startsWith('search_path='))).toBe(true);
      const definers = await q<{ proname: string }>(
        cleanUrl,
        `SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace ORDER BY proname`,
      );
      expect(definers.map((d) => d.proname)).toEqual(sorted(SECURITY_DEFINER_FUNCTIONS));
      const [depth] = await q<{ a: number; b: number; c: number }>(
        cleanUrl,
        `SELECT app_jsonb_depth('1'::jsonb) AS a, app_jsonb_depth('{"x": [1, {"y": 2}]}'::jsonb) AS b,
                app_jsonb_depth('[]'::jsonb) AS c`,
      );
      // Containers only (a scalar is 0): never above the writer's depth, which counts the leaf (DB ceiling 16).
      expect(depth).toEqual({ a: 0, b: 3, c: 1 });
    });

    it('targets, references, record parents and both relationship ends are composite same-tenant foreign keys to the entity index; definitions to the tenant registry projection (RESTRICT)', async () => {
      const defs = await q<{ conname: string; def: string }>(
        cleanUrl,
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'f' AND conrelid = ANY($1::regclass[]) ORDER BY conname`,
        [[...M10D_TABLES]],
      );
      const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
      const restrict = 'ON UPDATE RESTRICT ON DELETE RESTRICT';
      const index = (cols: string, key = 'entity_id') =>
        `FOREIGN KEY (${cols}) REFERENCES tenant_entity_index(tenant_id, kind, ${key}) ${restrict}`;
      const projection = (cols: string) =>
        `FOREIGN KEY (${cols}) REFERENCES tenant_registry_entries(tenant_id, kind, id) ${restrict}`;
      expect(byName).toMatchObject({
        tenant_extension_values_target_id_fkey: index('tenant_id, target_kind, target_id'),
        tenant_extension_values_target_key_fkey: index(
          'tenant_id, target_kind, target_key',
          'entity_key',
        ),
        tenant_extension_values_ref_id_fkey: index('tenant_id, value_ref_kind, value_ref_id'),
        tenant_extension_values_ref_key_fkey: index(
          'tenant_id, value_ref_kind, value_ref_key',
          'entity_key',
        ),
        tenant_extension_values_tenant_id_field_registry_kind_fiel_fkey: projection(
          'tenant_id, field_registry_kind, field_id',
        ),
        tenant_extension_value_items_tenant_id_value_id_fkey: `FOREIGN KEY (tenant_id, value_id) REFERENCES tenant_extension_values(tenant_id, id) ${restrict}`,
        tenant_custom_records_parent_id_fkey: index('tenant_id, parent_kind, parent_id'),
        tenant_custom_records_parent_key_fkey: index(
          'tenant_id, parent_kind, parent_key',
          'entity_key',
        ),
        tenant_custom_records_tenant_id_object_registry_kind_objec_fkey: projection(
          'tenant_id, object_registry_kind, object_id',
        ),
        tenant_custom_relationships_from_id_fkey: index('tenant_id, from_kind, from_id'),
        tenant_custom_relationships_from_key_fkey: index(
          'tenant_id, from_kind, from_key',
          'entity_key',
        ),
        tenant_custom_relationships_to_id_fkey: index('tenant_id, to_kind, to_id'),
        tenant_custom_relationships_to_key_fkey: index('tenant_id, to_kind, to_key', 'entity_key'),
        tenant_custom_relationships_tenant_id_rel_registry_kind_re_fkey: projection(
          'tenant_id, rel_registry_kind, rel_def_id',
        ),
      });
      // Every foreign key of the four tables starts with tenant_id (no cross-tenant path).
      for (const d of defs) expect(d.def, d.conname).toMatch(/^FOREIGN KEY \(tenant_id[,)]/);
      expect(
        await q(
          cleanUrl,
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'tenant_registry_entries_tenant_id_kind_id_key'`,
        ),
      ).toEqual([
        {
          indexdef:
            'CREATE UNIQUE INDEX tenant_registry_entries_tenant_id_kind_id_key ON public.tenant_registry_entries USING btree (tenant_id, kind, id)',
        },
      ]);
    });

    it('classification (Q34): typed value columns are restricted and registry-classified; identifiers are operational; the data-subject map links values, records and edges to the person', async () => {
      for (const table of M10D_TABLES) {
        const columns = await q<{ column_name: string }>(
          cleanUrl,
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
          [table],
        );
        expect(Object.keys(CLASSIFICATION_MANIFEST[table]!).sort(), table).toEqual(
          columns.map((c) => c.column_name),
        );
      }
      const values = CLASSIFICATION_MANIFEST.tenant_extension_values!;
      for (const column of [
        'value_text',
        'value_number',
        'value_bool',
        'value_date',
        'value_ts',
        'value_money_minor',
        'value_currency',
        'value_enum',
        'value_json',
        'value_ref_id',
        'value_ref_key',
      ]) {
        expect(values[column], column).toMatchObject({
          sensitivity: 'restricted',
          classifiedBy: 'registry',
          history: 'none',
        });
      }
      const items = CLASSIFICATION_MANIFEST.tenant_extension_value_items!;
      for (const column of ['item_text', 'item_number', 'item_date', 'item_enum']) {
        expect(items[column], column).toMatchObject({
          sensitivity: 'restricted',
          classifiedBy: 'registry',
        });
      }
      // The registry marker is used only by the typed extension columns.
      const marked = Object.entries(CLASSIFICATION_MANIFEST).flatMap(([t, cols]) =>
        Object.entries(cols)
          .filter(([, c]) => (c as { classifiedBy?: string }).classifiedBy === 'registry')
          .map(([col]) => `${t}.${col}`),
      );
      expect(marked.every((m) => /^tenant_extension_value(s|_items)\./.test(m))).toBe(true);
      for (const column of ['target_kind', 'field_id', 'value_type', 'value_state', 'field_hash']) {
        expect(values[column]!.sensitivity, column).not.toBe('restricted');
        expect((values[column] as { classifiedBy?: string }).classifiedBy, column).toBeUndefined();
      }
      const subjects = dataSubjectMap();
      const link = (table: string, column: string) =>
        subjects.find((s) => s.table === table)?.columns.find((c) => c.column === column);
      expect(link('tenant_extension_values', 'target_id')).toEqual({
        column: 'target_id',
        entity: 'person',
        action: 'erase',
      });
      expect(link('tenant_custom_records', 'parent_id')).toMatchObject({ entity: 'person' });
      expect(link('tenant_custom_relationships', 'from_id')).toMatchObject({ entity: 'person' });
      expect(link('tenant_custom_relationships', 'to_id')).toMatchObject({ entity: 'person' });
    });
  });

  describe('V24: the M10D migration on M10C data', () => {
    const tA = 'd10d0000-0000-4d10-8d10-00000000000a';
    const tB = 'd10d0000-0000-4d10-8d10-00000000000b';
    const cA1 = 'd10d0000-2222-4d10-8d10-00000000000a';
    const cA2 = 'd10d0000-2222-4d10-8d10-00000000000b';
    const pA1 = 'd10d0000-3333-4d10-8d10-00000000000a';
    const ON = 'SET session_replication_role = replica;';
    const OFF = 'SET session_replication_role = origin;';
    /** A: two companies (one parented), a person, an adoption of 0.3, a published data policy; B: empty. */
    const SEED = `INSERT INTO tenants (id, slug, name, updated_at) VALUES
  ('${tA}', 'mdtena', 'A', now()), ('${tB}', 'mdtenb', 'B', now());
INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
  ('${cA1}', '${tA}', 'School A', now(), now()), ('${cA2}', '${tA}', 'Trust A', now(), now());
INSERT INTO persons (id, tenant_id, primary_email, company_id, created_at, updated_at) VALUES
  ('${pA1}', '${tA}', 'a1@school.example', '${cA1}', now(), now());
UPDATE companies SET parent_company_id = '${cA2}', parent_company_origin = 'source_provided' WHERE id = '${cA1}';
${ON}
INSERT INTO tenant_canonical_adoptions (tenant_id, id, seq, version, previous_version, reason,
  actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
VALUES ('${tA}', gen_random_uuid(), 1, '0.3', NULL, 'new_tenant', 'system', 'test', 'system', gen_random_uuid(), gen_random_uuid());
INSERT INTO tenant_registry_versions (tenant_id, kind, version, base_version, document, document_schema_version,
  content_hash, canonical_version_min, effective_from, actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
VALUES ('${tA}', 'data_policy', 1, 0, '{"schema": 1, "raw_retention": false}', 1, repeat('d', 64), '0.3', now(),
  'operator', 'ops', 'asserted', gen_random_uuid(), gen_random_uuid());
INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
VALUES ('${tA}', gen_random_uuid(), 'data_policy', 'data_policy', '{"schema": 1}', 1, 1, now());
${OFF}`;

    /** A database at the M10C state (optionally holding SEED). */
    async function m10cDatabase(name: string, seed = true): Promise<string> {
      const url = await createDatabase(pg, name);
      const dir = resolve(`test/.tmp/${name}`);
      try {
        await migrate(url, ['--config', migrationsBefore(dir, '20270112')]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (seed) await withAdmin(url, (db) => db.query(SEED));
      return url;
    }
    /** M10E sits on top: the V24 round trip applies (and re-applies) migrations through M10D only. */
    async function migrateThroughM10D(url: string, name: string): Promise<string> {
      const dir = resolve(`test/.tmp/${name}-m10d`);
      try {
        return await migrate(url, ['--config', migrationsBefore(dir, '20270119')]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const state = (url: string) =>
      q<Record<string, unknown>>(
        url,
        `SELECT (SELECT count(*)::int FROM tenant_extension_values) AS ext_values,
                (SELECT count(*)::int FROM tenant_extension_value_items) AS ext_items,
                (SELECT count(*)::int FROM tenant_custom_records) AS records,
                (SELECT count(*)::int FROM tenant_custom_relationships) AS edges,
                (SELECT count(*)::int FROM tenant_registry_versions WHERE kind = 'extension') AS ext_registry,
                (SELECT count(*)::int FROM tenant_registry_entries WHERE kind = 'extension') AS ext_entries,
                (SELECT count(*)::int FROM tenant_registry_entries WHERE sensitivity IS NOT NULL OR cardinality(categories) > 0) AS classified_entries,
                (SELECT count(*)::int FROM tenant_entity_index WHERE kind = 'custom_record') AS indexed,
                (SELECT count(*)::int FROM tenant_module_settings) AS module_settings,
                (SELECT string_agg(version, ',' ORDER BY seq) FROM tenant_canonical_adoptions) AS adoptions,
                (SELECT count(*)::int FROM tenant_context_changes) AS changes,
                (SELECT parent_company_id::text FROM companies WHERE id = '${cA1}') AS parent`,
      );
    const EXPECTED_STATE = {
      ext_values: 0,
      ext_items: 0,
      records: 0,
      edges: 0,
      ext_registry: 0,
      ext_entries: 0,
      classified_entries: 0,
      indexed: 0,
      module_settings: 0,
      adoptions: '0.3',
      changes: 0,
      parent: cA2,
    };

    it('applies with no backfill: no definition, value, record, setting or adoption is invented; data_policy entries stay unclassified; 0.4 current; rerun is a no-op', async () => {
      const url = await m10cDatabase('m10d_on_m10c');
      const output = await migrateThroughM10D(url, 'm10d_on_m10c');
      expect(output).toMatch(new RegExp(M10D));
      expect(await state(url)).toEqual([EXPECTED_STATE]);
      expect(
        await q(url, `SELECT version, status FROM canonical_model_versions ORDER BY major, minor`),
      ).toEqual([
        { version: '0.1', status: 'supported' },
        { version: '0.2', status: 'supported' },
        { version: '0.3', status: 'supported' },
        { version: '0.4', status: 'current' },
      ]);
      await expect(migrateThroughM10D(url, 'm10d_on_m10c')).resolves.toMatch(
        /No pending migrations/,
      );
      expect(await state(url)).toEqual([EXPECTED_STATE]);
    });

    it('the down-script refuses each M10D-only data class (changing nothing), then restores exactly the M10C schema, and M10D re-applies', async () => {
      const before = await m10cDatabase('m10d_before_db', false);
      const url = await m10cDatabase('m10d_down_db');
      await migrateThroughM10D(url, 'm10d_down_db');
      const latest = await schemaSnapshot(url);
      const down = readFileSync(M10D_DOWN, 'utf8');
      const audit = (capability: string, action: string) =>
        `INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance,
           capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
         VALUES ('${tA}', gen_random_uuid(), 1, now(), 'operator', 'ops', 'asserted', '${capability}', '${action}',
           'allowed', gen_random_uuid(), 5, '{}', repeat('0', 64), repeat('a', 64))`;
      const change = (kind: string, fields: string) =>
        `INSERT INTO tenant_context_changes (tenant_id, id, entity_kind, entity_id, change_type, source_system,
           source_object_type, source_record_id, cause, adapter, adapter_version, correlation_id, changed_fields)
         VALUES ('${tA}', gen_random_uuid(), '${kind}', gen_random_uuid(), 'updated', 'hubspot', 'companies', '1',
           'webhook', 'hubspot', '1', gen_random_uuid(), ARRAY[${fields}]::text[])`;
      const adoption = (seq: number, version: string, previous: string, reason: string) =>
        `INSERT INTO tenant_canonical_adoptions (tenant_id, id, seq, version, previous_version, reason,
           actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
         VALUES ('${tA}', gen_random_uuid(), ${seq}, '${version}', '${previous}', '${reason}',
           'operator', 'ops', 'asserted', gen_random_uuid(), gen_random_uuid())`;
      const big = `jsonb_build_object('pad', repeat('x', 300000))`;
      const refusals: [string, string, RegExp][] = [
        [
          `INSERT INTO tenant_registry_versions (tenant_id, kind, version, base_version, document, document_schema_version,
             content_hash, canonical_version_min, effective_from, actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
           VALUES ('${tA}', 'extension', 1, 0, '{"schema_version": 1}', 1, repeat('a', 64), '0.4', now(),
             'operator', 'ops', 'asserted', gen_random_uuid(), gen_random_uuid())`,
          `DELETE FROM tenant_registry_versions WHERE kind = 'extension'`,
          /refusing rollback: 1 extension registry versions exist/,
        ],
        [
          `INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in,
             updated_at, sensitivity, categories)
           VALUES ('${tA}', gen_random_uuid(), 'extension', 'tier', '{"kind": "field"}', 1, 1, now(), 'internal',
             ARRAY['commercial'])`,
          `DELETE FROM tenant_registry_entries WHERE kind = 'extension'`,
          /refusing rollback: 1 extension registry entries exist/,
        ],
        [
          `INSERT INTO tenant_extension_values (tenant_id, target_kind, target_id, field_id, value_type, value_state,
             origin, registry_version)
           VALUES ('${tA}', 'company', '${cA1}', gen_random_uuid(), 'string', 'empty', 'human', 1)`,
          `DELETE FROM tenant_extension_values`,
          /refusing rollback: 1 extension values exist/,
        ],
        [
          `INSERT INTO tenant_extension_value_items (tenant_id, value_id, ordinal, item_type, item_text)
           VALUES ('${tA}', gen_random_uuid(), 0, 'string', 'x')`,
          `DELETE FROM tenant_extension_value_items`,
          /refusing rollback: 1 extension value items exist/,
        ],
        [
          `INSERT INTO tenant_custom_records (tenant_id, object_id, origin) VALUES ('${tA}', gen_random_uuid(), 'human')`,
          `DELETE FROM tenant_custom_records`,
          /refusing rollback: 1 custom records exist/,
        ],
        [
          `INSERT INTO tenant_custom_relationships (tenant_id, rel_def_id, from_kind, from_id, to_kind, to_id, origin)
           VALUES ('${tA}', gen_random_uuid(), 'custom_record', gen_random_uuid(), 'company', '${cA1}', 'human')`,
          `DELETE FROM tenant_custom_relationships`,
          /refusing rollback: 1 custom relationships exist/,
        ],
        [
          `INSERT INTO tenant_entity_index (tenant_id, kind, entity_id) VALUES ('${tA}', 'custom_record', gen_random_uuid())`,
          `DELETE FROM tenant_entity_index WHERE kind = 'custom_record'`,
          /refusing rollback: 1 custom_record entity-index rows exist/,
        ],
        [
          `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_id, origin)
           VALUES ('${tA}', 'sugar', 'Site', 's-1', 'custom_record', gen_random_uuid(), 'observed')`,
          `DELETE FROM tenant_source_references WHERE entity_kind = 'custom_record'`,
          /refusing rollback: 1 custom_record source references exist/,
        ],
        [
          change('custom_record', `'name'`),
          `DELETE FROM tenant_context_changes WHERE entity_kind = 'custom_record'`,
          /refusing rollback: 1 change records use M10D kinds or ext: fields/,
        ],
        [
          change('custom_relationship', ''),
          `DELETE FROM tenant_context_changes WHERE entity_kind = 'custom_relationship'`,
          /refusing rollback: 1 change records use M10D kinds or ext: fields/,
        ],
        [
          change('company', `'name', 'ext:tier'`),
          `DELETE FROM tenant_context_changes WHERE 'ext:tier' = ANY(changed_fields)`,
          /refusing rollback: 1 change records use M10D kinds or ext: fields/,
        ],
        [
          `INSERT INTO tenant_value_history (tenant_id, id, entity_kind, entity_id, field, values_recorded, effective_at,
             change_id, retention_class, actor_kind, actor_id, actor_assurance)
           VALUES ('${tA}', gen_random_uuid(), 'company', '${cA1}', 'ext:tier', false, now(), gen_random_uuid(),
             'canonical_lifecycle', 'system', 'test', 'system')`,
          `DELETE FROM tenant_value_history WHERE field = 'ext:tier'`,
          /refusing rollback: 1 value history rows of extension fields exist/,
        ],
        [
          `INSERT INTO tenant_identity_conflicts (tenant_id, id, kind, entity_kind, conflict_key)
           VALUES ('${tA}', gen_random_uuid(), 'extension_value_conflict', 'company', repeat('a', 64))`,
          `DELETE FROM tenant_identity_conflicts`,
          /refusing rollback: 1 identity conflicts of M10D kinds exist/,
        ],
        [
          `INSERT INTO tenant_identity_conflicts (tenant_id, id, kind, entity_kind, conflict_key)
           VALUES ('${tA}', gen_random_uuid(), 'shared_email', 'custom_record', repeat('b', 64))`,
          `DELETE FROM tenant_identity_conflicts`,
          /refusing rollback: 1 identity conflicts of M10D kinds exist/,
        ],
        [
          `INSERT INTO tenant_module_settings (tenant_id, module_key, enabled, version, updated_at, updated_by_kind,
             updated_by_id, updated_by_assurance)
           VALUES ('${tA}', 'extension', false, 2, now(), 'operator', 'ops', 'asserted')`,
          `DELETE FROM tenant_module_settings`,
          /refusing rollback: 1 tenant settings of module extension exist/,
        ],
        [
          `INSERT INTO tenant_module_setting_events (tenant_id, id, seq, module_key, to_enabled, to_config_hash,
             base_version, actor_kind, actor_id, actor_assurance, audit_event_id)
           VALUES ('${tA}', gen_random_uuid(), 1, 'extension', true, repeat('a', 64), 0, 'operator', 'ops', 'asserted',
             gen_random_uuid())`,
          `DELETE FROM tenant_module_setting_events`,
          /refusing rollback: 1 setting events of module extension exist/,
        ],
        [
          adoption(2, '0.4', '0.3', 'operator_adoption'),
          `DELETE FROM tenant_canonical_adoptions WHERE seq = 2`,
          /refusing rollback: 1 adoptions of canonical 0.4 exist/,
        ],
        [
          // A rollback away from 0.4 (previous_version) also names 0.4.
          adoption(2, '0.3', '0.4', 'rollback'),
          `DELETE FROM tenant_canonical_adoptions WHERE seq = 2`,
          /refusing rollback: 1 adoptions of canonical 0.4 exist/,
        ],
        [
          `INSERT INTO tenant_source_mapping_versions (tenant_id, connection_id, version, base_version, document,
             content_hash, schema_snapshot_hash, authority_version, published_by)
           VALUES ('${tA}', gen_random_uuid(), 1, 0, ${big}, repeat('a', 64), repeat('b', 64), 1, 'test')`,
          `DELETE FROM tenant_source_mapping_versions`,
          /refusing rollback: 1 mapping versions exceed the 256 KiB document cap/,
        ],
        [
          `INSERT INTO tenant_source_mapping_drafts (tenant_id, connection_id, id, document, content_hash, version,
             updated_by_kind, updated_by_id, updated_by_assurance, updated_at)
           VALUES ('${tA}', gen_random_uuid(), gen_random_uuid(), ${big}, repeat('a', 64), 1, 'operator', 'ops',
             'asserted', now())`,
          `DELETE FROM tenant_source_mapping_drafts`,
          /refusing rollback: 1 mapping drafts exceed the 256 KiB document cap/,
        ],
        [
          audit('data.extension.read', 'extension.read'),
          `DELETE FROM tenant_audit_events`,
          /refusing rollback: 1 audit events use M10D capabilities or actions/,
        ],
        [
          audit('canonical.human_entry', 'extension.value.set'),
          `DELETE FROM tenant_audit_events`,
          /refusing rollback: 1 audit events use M10D capabilities or actions/,
        ],
      ];
      for (const [plant, cleanup, message] of refusals) {
        await withAdmin(url, (db) => db.query(`${ON} ${plant}; ${OFF}`));
        const snapshot = await schemaSnapshot(url);
        await expect(
          withAdmin(url, (db) => db.query(down)),
          String(message),
        ).rejects.toThrow(message);
        expect(await schemaSnapshot(url)).toEqual(snapshot);
        await withAdmin(url, (db) => db.query(`${ON} ${cleanup}; ${OFF}`));
      }
      expect(await state(url)).toEqual([EXPECTED_STATE]);
      await withAdmin(url, (db) => db.query(down));
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(before));
      expect(
        await q(url, `SELECT version, status FROM canonical_model_versions ORDER BY major, minor`),
      ).toEqual([
        { version: '0.1', status: 'supported' },
        { version: '0.2', status: 'supported' },
        { version: '0.3', status: 'current' },
      ]);
      expect(
        await q(
          url,
          `SELECT available, minimum_canonical_version FROM canonical_modules WHERE module_key = 'extension'`,
        ),
      ).toEqual([{ available: false, minimum_canonical_version: null }]);
      // The owner functions and their grants are the M10C set again.
      const fns = (u: string) =>
        q<{ v: string }>(
          u,
          `SELECT proname || ' ' || prosecdef || ' ' || coalesce(array_to_string(proacl, ','), '') AS v
             FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`,
        );
      expect(await fns(url)).toEqual(await fns(before));
      // M10C data is untouched by the round trip.
      expect(
        await q(url, `SELECT parent_company_id::text AS parent FROM companies WHERE id = '${cA1}'`),
      ).toEqual([{ parent: cA2 }]);
      const output = await migrateThroughM10D(url, 'm10d_down_db');
      expect(output).toMatch(new RegExp(M10D));
      expect(await schemaSnapshot(url)).toEqual(latest);
      expect(await state(url)).toEqual([EXPECTED_STATE]);
    });
  });
});
