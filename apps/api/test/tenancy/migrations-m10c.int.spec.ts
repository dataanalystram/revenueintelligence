import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AFFILIATION_END_REASONS,
  AFFILIATION_ORIGINS,
  AFFILIATION_STATUSES,
  CANONICAL_VERSIONS,
  CHANGE_ENTITY_KINDS,
  ENTITY_INDEX_KINDS,
  GENERIC_REFERENCE_KINDS,
  IDENTITY_CONFLICT_KINDS,
  PARENT_COMPANY_ORIGINS,
  canonicalCatalogueFor,
  canonicalCatalogueHash,
} from '../../src/modules/domain/canonical';
import { AUDIT_ACTIONS, CAPABILITIES } from '../../src/modules/domain/security';
import {
  authorityContentHash,
  type AuthorityDocument,
} from '../../src/modules/domain/source-authority';
import { advisoryLockKey } from '../../src/modules/tenancy/infrastructure/tenant-database';
import {
  CLASSIFICATION_MANIFEST,
  SECURITY_DEFINER_FUNCTIONS,
  dataSubjectMap,
} from '../../src/modules/tenancy/security';
import { migrate, startPostgres, withAdmin } from '../support/containers';
import { createDatabase, migrationsBefore, schemaSnapshot } from '../support/migrations';

/** M10C migration (account hierarchy, person–account affiliation, canonical 0.3). */
const M10C = '20270105120000_m10c_account_hierarchy_affiliation';
const M10C_DOWN = resolve(`prisma/rollback/${M10C}.down.sql`);
/** Stored catalogue hashes of the earlier versions (their own migrations); never recomputed into new values. */
const STORED_HASHES = {
  '0.1': '2fd4f7e575633de7cac4aea394a71c73adc9b73e5e18b67c0b0ee404572faf5b',
  '0.2': 'db7c0fc245cae469e8cddae88b89077c017805c7b87586b9d3e71f1936c96c98',
  '0.3': '70db9aa697147cf1d0d63e93a923ed8714b78da32550aaefe5699597e26eb069',
} as const;

/**
 * M10C migration and schema guard (plan §8, §18, §19 V14 / V19 / V21), in its
 * own file (tech debt #72: `migrations.int.spec.ts` runs close to the hook
 * timeout): the canonical catalogue in the database (V14), the M10C schema
 * guard — privileges, classification, data-subject map, direct composite
 * foreign keys, closed-set CHECKs, the owner-function allow-list (V19) — and
 * the migration on M10B data: no backfill, rerun, every down-script refusal,
 * exact restore of the M10B schema and re-apply (V21).
 */
describe('M10C migration and schema guard', () => {
  let pg: StartedPostgreSqlContainer;
  let cleanUrl: string;

  beforeAll(async () => {
    pg = await startPostgres();
    cleanUrl = await createDatabase(pg, 'm10c_clean');
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

  describe('V14: canonical catalogue in the database', () => {
    it('one current version (0.3); stored 0.1 / 0.2 hashes unchanged and reproduced by the code; 1.0 refused', async () => {
      const rows = await q<{
        version: string;
        status: string;
        adr: string;
        catalogue_hash: string;
      }>(
        cleanUrl,
        'SELECT version, status, adr, catalogue_hash FROM canonical_model_versions ORDER BY major, minor',
      );
      expect(rows).toEqual([
        { version: '0.1', status: 'supported', adr: '0027', catalogue_hash: STORED_HASHES['0.1'] },
        { version: '0.2', status: 'supported', adr: '0028', catalogue_hash: STORED_HASHES['0.2'] },
        { version: '0.3', status: 'current', adr: '0029', catalogue_hash: STORED_HASHES['0.3'] },
      ]);
      expect(
        CANONICAL_VERSIONS.filter((v) => v.status === 'current').map((v) => v.version),
      ).toEqual(['0.3']);
      for (const v of ['0.1', '0.2', '0.3'] as const) {
        expect(canonicalCatalogueHash(canonicalCatalogueFor(v)), v).toBe(STORED_HASHES[v]);
      }
      await expect(
        q(
          cleanUrl,
          `INSERT INTO canonical_model_versions (version, major, minor, status, released_at, catalogue_hash, adr)
           VALUES ('1.0', 1, 0, 'supported', now(), repeat('e', 64), '0029')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('V19: M10C schema guard', () => {
    it('the app role holds exactly SELECT/INSERT/UPDATE on affiliations (no DELETE) and SELECT on the two views', async () => {
      const grants = await q<{ table_name: string; privilege_type: string }>(
        cleanUrl,
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee = 'lip_app'
            AND table_name IN ('tenant_person_affiliations', 'account_hierarchy_paths', 'person_affiliation_index')
          ORDER BY table_name, privilege_type`,
      );
      expect(grants.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual([
        'account_hierarchy_paths:SELECT',
        'person_affiliation_index:SELECT',
        'tenant_person_affiliations:INSERT',
        'tenant_person_affiliations:SELECT',
        'tenant_person_affiliations:UPDATE',
      ]);
      const rls = await q<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        cleanUrl,
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tenant_person_affiliations'`,
      );
      expect(rls).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      const views = await q<{ relname: string; reloptions: string[] | null }>(
        cleanUrl,
        `SELECT relname, reloptions FROM pg_class WHERE relname IN ('account_hierarchy_paths', 'person_affiliation_index')
          ORDER BY relname`,
      );
      expect(views.map((v) => [v.relname, v.reloptions])).toEqual([
        ['account_hierarchy_paths', ['security_invoker=true']],
        ['person_affiliation_index', ['security_invoker=true']],
      ]);
    });

    it('classification: affiliation facts are confidential / personal and value-free; the parent is internal with full history; the data-subject map links the person', async () => {
      const columns = await q<{ column_name: string }>(
        cleanUrl,
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'tenant_person_affiliations' ORDER BY column_name`,
      );
      expect(Object.keys(CLASSIFICATION_MANIFEST.tenant_person_affiliations!).sort()).toEqual(
        columns.map((c) => c.column_name),
      );
      const a = CLASSIFICATION_MANIFEST.tenant_person_affiliations!;
      for (const column of ['person_id', 'status', 'role_codes', 'starts_at', 'ends_at']) {
        expect(a[column], column).toMatchObject({
          sensitivity: 'confidential',
          categories: ['personal'],
        });
      }
      for (const column of ['status', 'role_codes', 'starts_at', 'ends_at']) {
        expect(a[column]!.history, column).toBe('value_free');
      }
      expect(CLASSIFICATION_MANIFEST.companies!.parent_company_id).toMatchObject({
        sensitivity: 'internal',
        categories: ['operational'],
        history: 'full',
      });
      const subject = dataSubjectMap().find((t) => t.table === 'tenant_person_affiliations');
      expect(subject).toMatchObject({ personal: true });
      expect(subject!.columns).toContainEqual({
        column: 'person_id',
        entity: 'person',
        action: 'erase',
      });
    });

    it('endpoints and the parent are direct composite same-tenant foreign keys (RESTRICT)', async () => {
      const defs = await q<{ conname: string; def: string }>(
        cleanUrl,
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'f' AND conrelid IN ('tenant_person_affiliations'::regclass, 'companies'::regclass,
                                               'tenant_source_authority_versions'::regclass)
          ORDER BY conname`,
      );
      const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
      const restrict = 'ON UPDATE RESTRICT ON DELETE RESTRICT';
      expect(byName).toMatchObject({
        companies_tenant_id_parent_company_id_fkey: `FOREIGN KEY (tenant_id, parent_company_id) REFERENCES companies(tenant_id, id) ${restrict}`,
        tenant_person_affiliations_tenant_id_person_id_fkey: `FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id) ${restrict}`,
        tenant_person_affiliations_tenant_id_company_id_fkey: `FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ${restrict}`,
        tenant_person_affiliations_tenant_id_merged_into_id_fkey: `FOREIGN KEY (tenant_id, merged_into_id) REFERENCES tenant_person_affiliations(tenant_id, id) ${restrict}`,
        tenant_person_affiliations_tenant_id_last_change_id_fkey: `FOREIGN KEY (tenant_id, last_change_id) REFERENCES tenant_context_changes(tenant_id, id) ${restrict}`,
        tenant_source_authority_versions_tenant_id_account_hierarc_fkey: `FOREIGN KEY (tenant_id, account_hierarchy_connection_id) REFERENCES tenant_source_connections(tenant_id, id) ${restrict}`,
      });
    });

    it('the kind, status, origin, end-reason, conflict and audit CHECKs equal the code catalogues', async () => {
      expect(await checkValues('tenant_entity_index_kind_valid')).toEqual(
        [...ENTITY_INDEX_KINDS].sort(),
      );
      expect(ENTITY_INDEX_KINDS).toContain('person_affiliation');
      expect(await checkValues('tenant_source_references_entity_kind_valid')).toEqual(
        [...GENERIC_REFERENCE_KINDS].sort(),
      );
      expect(await checkValues('tenant_context_changes_entity_kind_valid')).toEqual(
        [...CHANGE_ENTITY_KINDS].sort(),
      );
      expect(await checkValues('tenant_identity_conflicts_kind_valid')).toEqual(
        [...IDENTITY_CONFLICT_KINDS].sort(),
      );
      expect(await checkValues('tenant_person_affiliations_status_valid')).toEqual(
        [...AFFILIATION_STATUSES].sort(),
      );
      expect(await checkValues('tenant_person_affiliations_origin_valid')).toEqual(
        [...AFFILIATION_ORIGINS].sort(),
      );
      expect(await checkValues('tenant_person_affiliations_end_reason_valid')).toEqual(
        [...AFFILIATION_END_REASONS].sort(),
      );
      expect(await checkValues('companies_parent_origin_valid')).toEqual(
        [...PARENT_COMPANY_ORIGINS].sort(),
      );
      expect(await checkValues('tenant_audit_events_capability_valid')).toEqual(
        [...CAPABILITIES].sort(),
      );
      expect(await checkValues('tenant_audit_events_action_valid')).toEqual(
        [...AUDIT_ACTIONS].sort(),
      );
      expect(CAPABILITIES).toContain('data.account_structure.read');
      for (const action of [
        'account.hierarchy.set',
        'account.hierarchy.clear',
        'account.hierarchy.release',
        'person.affiliation.add',
        'person.affiliation.end',
        'account_structure.read',
      ]) {
        expect(AUDIT_ACTIONS).toContain(action);
      }
    });

    it('the guard functions are SECURITY INVOKER with a fixed search_path; the owner-function allow-list is unchanged; triggers are in place; the lock key equals the code', async () => {
      const fns = await q<{ proname: string; prosecdef: boolean; config: string }>(
        cleanUrl,
        `SELECT proname, prosecdef, array_to_string(proconfig, ',') AS config FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND proname IN ('app_company_hierarchy_guard', 'app_person_affiliation_guard', 'app_tenant_advisory_key')
          ORDER BY proname`,
      );
      expect(fns.map((f) => [f.proname, f.prosecdef])).toEqual([
        ['app_company_hierarchy_guard', false],
        ['app_person_affiliation_guard', false],
        ['app_tenant_advisory_key', false],
      ]);
      expect(fns.every((f) => f.config.startsWith('search_path='))).toBe(true);
      const definers = await q<{ proname: string }>(
        cleanUrl,
        `SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace ORDER BY proname`,
      );
      expect(definers.map((d) => d.proname)).toEqual([...SECURITY_DEFINER_FUNCTIONS].sort());
      const triggers = await q<{ tgname: string }>(
        cleanUrl,
        `SELECT tgname FROM pg_trigger
          WHERE NOT tgisinternal AND tgrelid IN ('companies'::regclass, 'tenant_person_affiliations'::regclass)
          ORDER BY tgname`,
      );
      expect(triggers.map((t) => t.tgname)).toEqual(
        expect.arrayContaining([
          'companies_hierarchy_guard',
          'tenant_person_affiliations_guard',
          'tenant_person_affiliations_tenant_immutable',
          'tenant_person_affiliations_entity_index_add',
          'tenant_person_affiliations_entity_index_remove',
          'tenant_person_affiliations_identity_immutable',
        ]),
      );
      const tenant = '7c7c7c7c-7c7c-47c7-87c7-7c7c7c7c7c7c';
      const [key] = await q<{ k: string }>(
        cleanUrl,
        `SELECT app_tenant_advisory_key($1::uuid, 'account-hierarchy', 'tenant')::text AS k`,
        [tenant],
      );
      expect(BigInt(key!.k)).toBe(advisoryLockKey(tenant, 'account-hierarchy', 'tenant'));
    });
  });

  describe('V21: the M10C migration on M10B data', () => {
    const tA = 'c10c0000-0000-4c10-8c10-00000000000a';
    const tB = 'c10c0000-0000-4c10-8c10-00000000000b';
    const cA1 = 'c10c0000-2222-4c10-8c10-00000000000a';
    const cA2 = 'c10c0000-2222-4c10-8c10-00000000000b';
    const pA1 = 'c10c0000-3333-4c10-8c10-00000000000a';
    const AUTHORITY: AuthorityDocument = {
      facts: {
        account_profile: null,
        person_profile: null,
        subscription_lines: null,
        subscription_state: null,
        subscription_terms: null,
      },
    };
    /** A: two companies, a person with a primary company and two source associations, an authority version; B: empty. */
    const SEED = `INSERT INTO tenants (id, slug, name, updated_at) VALUES
  ('${tA}', 'mctena', 'A', now()), ('${tB}', 'mctenb', 'B', now());
INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
  ('${cA1}', '${tA}', 'School A', now(), now()), ('${cA2}', '${tA}', 'Trust A', now(), now());
INSERT INTO persons (id, tenant_id, primary_email, company_id, created_at, updated_at) VALUES
  ('${pA1}', '${tA}', 'a1@school.example', '${cA1}', now(), now());
INSERT INTO tenant_source_relationships (tenant_id, system, from_object_type, from_external_id, to_object_type,
  to_external_id, association_type_id, category, is_primary) VALUES
  ('${tA}', 'hubspot', 'contacts', '1', 'companies', '10', 1, 'standard', true),
  ('${tA}', 'hubspot', 'contacts', '1', 'companies', '11', 279, 'standard', false);
INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version, content_hash, published_by) VALUES
  ('${tA}', 1, 0, '${authorityContentHash(AUTHORITY)}', 'test');`;

    /** A database at the M10B state (optionally holding SEED). */
    async function m10bDatabase(name: string, seed = true): Promise<string> {
      const url = await createDatabase(pg, name);
      const dir = resolve(`test/.tmp/${name}`);
      try {
        await migrate(url, ['--config', migrationsBefore(dir, '20270105')]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (seed) await withAdmin(url, (db) => db.query(SEED));
      return url;
    }
    const state = (url: string) =>
      q<Record<string, unknown>>(
        url,
        `SELECT (SELECT count(*)::int FROM companies WHERE parent_company_id IS NOT NULL OR parent_company_origin IS NOT NULL) AS parents,
                (SELECT count(*)::int FROM tenant_person_affiliations) AS affiliations,
                (SELECT count(*)::int FROM tenant_context_changes) AS changes,
                (SELECT count(*)::int FROM tenant_value_history) AS history,
                (SELECT count(*)::int FROM tenant_identity_conflicts) AS conflicts,
                (SELECT count(*)::int FROM tenant_entity_index WHERE kind = 'person_affiliation') AS indexed,
                (SELECT string_agg(content_hash || ':' || coalesce(account_hierarchy_connection_id::text, '-'), ',')
                   FROM tenant_source_authority_versions) AS authority,
                (SELECT company_id::text FROM persons WHERE id = '${pA1}') AS primary_company`,
      );
    const EXPECTED_STATE = {
      parents: 0,
      affiliations: 0,
      changes: 0,
      history: 0,
      conflicts: 0,
      indexed: 0,
      authority: `${authorityContentHash(AUTHORITY)}:-`,
      primary_company: cA1,
    };

    it('applies with no backfill: no parent, no affiliation, no change record; the authority hash is unchanged; 0.3 current; rerun is a no-op', async () => {
      const url = await m10bDatabase('m10c_on_m10b');
      const output = await migrate(url);
      expect(output).toMatch(new RegExp(M10C));
      expect(await state(url)).toEqual([EXPECTED_STATE]);
      const versions = await q<Record<string, unknown>>(
        url,
        `SELECT version, status FROM canonical_model_versions ORDER BY 1`,
      );
      expect(versions).toEqual([
        { version: '0.1', status: 'supported' },
        { version: '0.2', status: 'supported' },
        { version: '0.3', status: 'current' },
      ]);
      // No tenant adopts 0.3 by migration (explicit adoption, Q19).
      expect(
        await q(url, `SELECT 1 FROM tenant_canonical_adoptions WHERE version = '0.3'`),
      ).toEqual([]);
      await expect(migrate(url)).resolves.toMatch(/No pending migrations/);
      expect(await state(url)).toEqual([EXPECTED_STATE]);
    });

    it('the down-script refuses each M10C-only data class (changing nothing), then restores exactly the M10B schema, and M10C re-applies', async () => {
      const before = await m10bDatabase('m10c_before_db', false);
      const url = await m10bDatabase('m10c_down_db');
      await migrate(url);
      const latest = await schemaSnapshot(url);
      const down = readFileSync(M10C_DOWN, 'utf8');
      const ON = 'SET session_replication_role = replica;';
      const OFF = 'SET session_replication_role = origin;';
      const refusals: [string, string, RegExp][] = [
        [
          `UPDATE companies SET parent_company_id = '${cA2}', parent_company_origin = 'source_provided' WHERE id = '${cA1}'`,
          `UPDATE companies SET parent_company_id = NULL, parent_company_origin = NULL WHERE id = '${cA1}'`,
          /refusing rollback: 1 companies carry a parent or parent origin/,
        ],
        [
          // A sticky human clear: no parent, but an origin.
          `UPDATE companies SET parent_company_origin = 'human' WHERE id = '${cA1}'`,
          `UPDATE companies SET parent_company_origin = NULL WHERE id = '${cA1}'`,
          /refusing rollback: 1 companies carry a parent or parent origin/,
        ],
        [
          `INSERT INTO tenant_person_affiliations (tenant_id, person_id, company_id, origin)
           VALUES ('${tA}', '${pA1}', '${cA1}', 'source_provided')`,
          `DELETE FROM tenant_person_affiliations`,
          /refusing rollback: 1 person affiliations exist/,
        ],
        [
          `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_id, origin)
           VALUES ('${tA}', 'sugar', 'AccountContactRelation', 'acr-1', 'person_affiliation', gen_random_uuid(), 'observed')`,
          `DELETE FROM tenant_source_references WHERE entity_kind = 'person_affiliation'`,
          /refusing rollback: 1 person_affiliation source references exist/,
        ],
        [
          `INSERT INTO tenant_context_changes (tenant_id, id, entity_kind, entity_id, change_type, source_system,
             source_object_type, source_record_id, cause, adapter, adapter_version, correlation_id)
           VALUES ('${tA}', gen_random_uuid(), 'person_affiliation', gen_random_uuid(), 'created', 'hubspot', 'contacts', '1',
             'webhook', 'hubspot', '1', gen_random_uuid())`,
          `DELETE FROM tenant_context_changes WHERE entity_kind = 'person_affiliation'`,
          /refusing rollback: 1 person_affiliation change records exist/,
        ],
        [
          `INSERT INTO tenant_value_history (tenant_id, id, entity_kind, entity_id, field, values_recorded, effective_at,
             change_id, retention_class, actor_kind, actor_id, actor_assurance)
           VALUES ('${tA}', gen_random_uuid(), 'company', '${cA1}', 'parent_company_id', false, now(), gen_random_uuid(),
             'canonical_lifecycle', 'system', 'test', 'system')`,
          `DELETE FROM tenant_value_history WHERE field = 'parent_company_id'`,
          /refusing rollback: 1 value history rows of M10C fields exist/,
        ],
        [
          `INSERT INTO tenant_identity_conflicts (tenant_id, id, kind, entity_kind, conflict_key)
           VALUES ('${tA}', gen_random_uuid(), 'hierarchy_cycle_refused', 'company', repeat('a', 64))`,
          `DELETE FROM tenant_identity_conflicts WHERE kind = 'hierarchy_cycle_refused'`,
          /refusing rollback: 1 identity conflicts of M10C kinds exist/,
        ],
        [
          `INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version, account_hierarchy_connection_id,
             content_hash, published_by)
           VALUES ('${tA}', 2, 1, gen_random_uuid(), repeat('b', 64), 'test')`,
          `DELETE FROM tenant_source_authority_versions WHERE version = 2`,
          /refusing rollback: 1 authority versions name an account_hierarchy connection/,
        ],
        [
          `INSERT INTO tenant_canonical_adoptions (tenant_id, id, seq, version, previous_version, reason,
             actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
           VALUES ('${tA}', gen_random_uuid(), 1, '0.3', NULL, 'new_tenant', 'system', 'test', 'system',
             gen_random_uuid(), gen_random_uuid())`,
          `DELETE FROM tenant_canonical_adoptions WHERE version = '0.3'`,
          /refusing rollback: 1 adoptions of canonical 0.3 exist/,
        ],
        [
          `INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance,
             capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
           VALUES ('${tA}', gen_random_uuid(), 1, now(), 'operator', 'ops', 'asserted', 'canonical.human_entry',
             'account.hierarchy.set', 'allowed', gen_random_uuid(), 4, '{}', repeat('0', 64), repeat('a', 64))`,
          `DELETE FROM tenant_audit_events WHERE action = 'account.hierarchy.set'`,
          /refusing rollback: 1 audit events use M10C capabilities or actions/,
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
      const versions = await q<Record<string, unknown>>(
        url,
        `SELECT version, status FROM canonical_model_versions ORDER BY 1`,
      );
      expect(versions).toEqual([
        { version: '0.1', status: 'supported' },
        { version: '0.2', status: 'current' },
      ]);
      // Data the M10B schema holds is untouched by the round trip.
      expect(await q(url, `SELECT company_id::text FROM persons WHERE id = '${pA1}'`)).toEqual([
        { company_id: cA1 },
      ]);
      const output = await migrate(url);
      expect(output).toMatch(new RegExp(M10C));
      expect(await schemaSnapshot(url)).toEqual(latest);
      expect(await state(url)).toEqual([EXPECTED_STATE]);
    });
  });
});
