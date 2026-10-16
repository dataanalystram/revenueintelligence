import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLASSIFICATION_MANIFEST } from '../../src/modules/tenancy/security';
import { migrate, startPostgres, withAdmin } from '../support/containers';
import { createDatabase, migrationsBefore, schemaSnapshot } from '../support/migrations';

const run = promisify(execFile);

/** M10F migration (commercial, canonical 0.6, ADR 0032). */
const M10F = '20270202120000_m10f_commercial';
const M10F_DOWN = resolve(`prisma/rollback/${M10F}.down.sql`);
const M10F_TABLES = ['tenant_contracts', 'tenant_entitlements', 'tenant_price_offers'] as const;

/**
 * M10F migration and schema guard (plan §12, tech debt #72; V11 / V22 / V23 /
 * V30 / V31 / V32 and the database half of V10): forced RLS, the tenant
 * policy and privileges on the three tables (no DELETE); every relation a
 * composite same-tenant FK (cross-tenant raw SQL as the app role refused);
 * the CHECKs (closed codes, currency shape, period pair, money pair, amounts
 * ≥ 0, all-or-none agreement_ref, no self link); the deferred two-table
 * guards (line ↔ contract account, line ↔ offer product, contract links,
 * line lineage); the acyclic contract graph over the union of the three link
 * kinds and the acyclic line lineage, each with a two-session race resolving
 * to its named code without deadlock; the migration on the #90 state — up,
 * rerun, each down-script refusal planted (changing nothing), exact restore,
 * re-apply, no drift.
 */
describe('M10F migration and schema guard', () => {
  let pg: StartedPostgreSqlContainer;
  let cleanUrl: string;

  beforeAll(async () => {
    pg = await startPostgres();
    cleanUrl = await createDatabase(pg, 'm10f_clean');
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

  /** Statements in one transaction as the app role bound to `tenant` (deferred triggers fire at COMMIT). */
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

  /** An open app-role session bound to `tenant` inside BEGIN (for two-session races). */
  const session = async (url: string, tenant: string) => {
    const db = new Client({ connectionString: url });
    await db.connect();
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE lip_app');
    await db.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenant]);
    return db;
  };

  const tA = 'f10f0000-0000-4f10-8f10-00000000000a';
  const tB = 'f10f0000-0000-4f10-8f10-00000000000b';
  const cA1 = 'f10f0000-2222-4f10-8f10-00000000000a';
  const cA2 = 'f10f0000-2222-4f10-8f10-00000000000b';
  const cB1 = 'f10f0000-2222-4f10-8f10-00000000000c';
  const offerB = 'f10f0000-3333-4f10-8f10-00000000000b';
  const contractB = 'f10f0000-4444-4f10-8f10-00000000000b';

  describe('V22 / V23 / V31: schema guard and privileges', () => {
    it('V23: forced RLS, the tenant policy and tenant-id immutability on the three tables', async () => {
      const rows = await q<{ relname: string; rls: boolean; forced: boolean }>(
        cleanUrl,
        `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
          WHERE relname = ANY($1) ORDER BY relname`,
        [M10F_TABLES],
      );
      expect(rows).toEqual(M10F_TABLES.map((relname) => ({ relname, rls: true, forced: true })));
      const policies = await q<{ tablename: string; qual: string; with_check: string }>(
        cleanUrl,
        `SELECT tablename, qual, with_check FROM pg_policies WHERE tablename = ANY($1) ORDER BY tablename`,
        [M10F_TABLES],
      );
      expect(policies.map((p) => p.tablename)).toEqual([...M10F_TABLES]);
      for (const p of policies) {
        expect(p.qual).toMatch(/tenant_id = app_current_tenant\(\)/);
        expect(p.with_check).toMatch(/tenant_id = app_current_tenant\(\)/);
      }
      const triggers = await q<{ tgname: string }>(
        cleanUrl,
        `SELECT tgname FROM pg_trigger WHERE tgname = ANY($1) ORDER BY tgname`,
        [M10F_TABLES.map((t) => `${t}_tenant_immutable`)],
      );
      expect(triggers).toHaveLength(3);
    });

    it('V31: SELECT / INSERT / UPDATE only (no DELETE / TRUNCATE) for the app role; DELETE refused (42501)', async () => {
      const grants = await q<{ table_name: string; privs: string }>(
        cleanUrl,
        `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
           FROM information_schema.role_table_grants
          WHERE grantee = 'lip_app' AND table_name = ANY($1) GROUP BY table_name ORDER BY table_name`,
        [M10F_TABLES],
      );
      expect(grants).toEqual(
        M10F_TABLES.map((table_name) => ({ table_name, privs: 'INSERT,SELECT,UPDATE' })),
      );
      for (const t of M10F_TABLES) {
        await expect(asApp(cleanUrl, tA, [`DELETE FROM ${t}`])).rejects.toMatchObject({
          code: '42501',
        });
      }
    });

    it('V22: every foreign key of the three tables and the line commercial columns is composite with tenant_id first', async () => {
      const fks = await q<{ conname: string; def: string }>(
        cleanUrl,
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'f' AND (conrelid::regclass::text = ANY($1)
             OR conname IN ('tenant_subscriptions_tenant_id_contract_id_fkey',
                            'tenant_subscriptions_tenant_id_price_offer_id_fkey',
                            'tenant_subscriptions_tenant_id_supersedes_line_id_fkey'))
          ORDER BY conname`,
        [M10F_TABLES],
      );
      expect(fks.length).toBeGreaterThanOrEqual(15);
      for (const fk of fks) {
        if (/\(tenant_id\) REFERENCES tenants\(id\)/.test(fk.def)) continue;
        expect(fk.def, fk.conname).toMatch(
          /^FOREIGN KEY \(tenant_id, \w+\) REFERENCES \w+\(tenant_id, \w+\)/,
        );
        expect(fk.def, fk.conname).toMatch(/ON UPDATE RESTRICT ON DELETE RESTRICT/);
      }
    });

    it('V25: the classification manifest covers every M10F column; financial columns are at least confidential', () => {
      for (const t of M10F_TABLES) expect(CLASSIFICATION_MANIFEST[t], t).toBeDefined();
      for (const col of ['list_amount_minor']) {
        expect(CLASSIFICATION_MANIFEST.tenant_price_offers![col]).toMatchObject({
          sensitivity: 'confidential',
          history: 'value_free',
        });
      }
      for (const col of ['total_value_minor', 'total_value_currency', 'renewal_date']) {
        expect(CLASSIFICATION_MANIFEST.tenant_contracts![col]!.sensitivity, col).toBe(
          'confidential',
        );
      }
    });
  });

  describe('V11 / V22 / V10 / V32: constraints and guards (raw SQL as the app role)', () => {
    beforeAll(async () => {
      await withAdmin(cleanUrl, (db) =>
        db.query(`
INSERT INTO tenants (id, slug, name, updated_at) VALUES
  ('${tA}', 'mftena', 'A', now()), ('${tB}', 'mftenb', 'B', now());
INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
  ('${cA1}', '${tA}', 'A1', now(), now()), ('${cA2}', '${tA}', 'A2', now(), now()),
  ('${cB1}', '${tB}', 'B1', now(), now());
INSERT INTO tenant_products (tenant_id, key, name, updated_at) VALUES
  ('${tA}', 'core', 'Core', now()), ('${tA}', 'addon', 'Add-on', now()), ('${tB}', 'core', 'Core', now());
INSERT INTO tenant_price_offers (tenant_id, id, product_key, currency) VALUES ('${tB}', '${offerB}', 'core', 'EUR');
INSERT INTO tenant_contracts (tenant_id, id, company_id) VALUES ('${tB}', '${contractB}', '${cB1}');`),
      );
    });

    const contract = async (company = cA1): Promise<string> => {
      const id = randomUUID();
      await q(
        cleanUrl,
        `INSERT INTO tenant_contracts (tenant_id, id, company_id) VALUES ($1, $2, $3)`,
        [tA, id, company],
      );
      return id;
    };
    const offer = async (product = 'core'): Promise<string> => {
      const id = randomUUID();
      await q(
        cleanUrl,
        `INSERT INTO tenant_price_offers (tenant_id, id, product_key, currency) VALUES ($1, $2, $3, 'EUR')`,
        [tA, id, product],
      );
      return id;
    };
    const line = async (company = cA1, product = 'core'): Promise<string> => {
      const id = randomUUID();
      await q(
        cleanUrl,
        `INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system,
           source_object_type, source_record_id, observed_at)
         VALUES ($1, $2, $3, $4, 'active', 'import', 'subscriptions', $5, now())`,
        [tA, id, company, product, `l-${id}`],
      );
      return id;
    };

    it('control: same-tenant same-account / same-product references commit as the app role', async () => {
      const k = await contract();
      const o = await offer();
      const l = await line();
      const p = await line();
      await asApp(cleanUrl, tA, [
        `UPDATE tenant_subscriptions SET contract_id = '${k}', price_offer_id = '${o}', supersedes_line_id = '${p}',
           agreement_ref_system = 'chargebee', agreement_ref_object_type = 'Subscriptions', agreement_ref_external_id = 'sub_1'
          WHERE id = '${l}'`,
      ]);
      // Tenant B's rows are invisible to tenant A.
      const out = await asApp(
        cleanUrl,
        tA,
        [`SELECT id FROM tenant_contracts WHERE id = '${contractB}'`],
        {
          rollback: true,
        },
      );
      expect(out[0]).toEqual([]);
    });

    it('V22: cross-tenant offer / contract / link / entitlement / line references are refused by the composite FKs (23503)', async () => {
      const k = await contract();
      const l = await line();
      for (const sql of [
        `UPDATE tenant_subscriptions SET contract_id = '${contractB}' WHERE id = '${l}'`,
        `UPDATE tenant_subscriptions SET price_offer_id = '${offerB}' WHERE id = '${l}'`,
        `UPDATE tenant_contracts SET renews_contract_id = '${contractB}' WHERE id = '${k}'`,
        `INSERT INTO tenant_contracts (tenant_id, company_id) VALUES ('${tA}', '${cB1}')`,
        `INSERT INTO tenant_entitlements (tenant_id, company_id, product_key) VALUES ('${tA}', '${cB1}', 'core')`,
      ]) {
        await expect(asApp(cleanUrl, tA, [sql]), sql).rejects.toMatchObject({ code: '23503' });
      }
    });

    it('CHECKs: currency shape, period pair, closed codes, money pair, amounts ≥ 0, agreement_ref all-or-none, no self link (23514)', async () => {
      const k = await contract();
      const l = await line();
      for (const sql of [
        `INSERT INTO tenant_price_offers (tenant_id, product_key, currency) VALUES ('${tA}', 'core', 'eur')`,
        `INSERT INTO tenant_price_offers (tenant_id, product_key, currency, billing_period) VALUES ('${tA}', 'core', 'EUR', 1)`,
        `INSERT INTO tenant_price_offers (tenant_id, product_key, currency, pricing_model) VALUES ('${tA}', 'core', 'EUR', 'tiers')`,
        `INSERT INTO tenant_price_offers (tenant_id, product_key, currency, list_amount_minor) VALUES ('${tA}', 'core', 'EUR', -1)`,
        `UPDATE tenant_contracts SET total_value_minor = 100 WHERE id = '${k}'`,
        `UPDATE tenant_contracts SET total_value_minor = -1, total_value_currency = 'EUR' WHERE id = '${k}'`,
        `UPDATE tenant_contracts SET status = 'renewed' WHERE id = '${k}'`,
        `UPDATE tenant_contracts SET renews_contract_id = id WHERE id = '${k}'`,
        `UPDATE tenant_contracts SET starts_at = now(), ends_at = now() - interval '1 day' WHERE id = '${k}'`,
        `INSERT INTO tenant_entitlements (tenant_id, company_id, product_key, quantity) VALUES ('${tA}', '${cA1}', 'core', -1)`,
        `UPDATE tenant_subscriptions SET agreement_ref_system = 'chargebee' WHERE id = '${l}'`,
        `UPDATE tenant_subscriptions SET supersedes_line_id = id WHERE id = '${l}'`,
      ]) {
        await expect(asApp(cleanUrl, tA, [sql]), sql).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('V11: a line on a contract of another account is accepted by the statement and refused at COMMIT; moving the contract away from its lines is refused too', async () => {
      const k = await contract(cA2);
      const l = await line(cA1);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_subscriptions SET contract_id = '${k}' WHERE id = '${l}'`,
        ]),
      ).rejects.toThrow(/line_contract_company_mismatch/);
      const k2 = await contract(cA1);
      await asApp(cleanUrl, tA, [
        `UPDATE tenant_subscriptions SET contract_id = '${k2}' WHERE id = '${l}'`,
      ]);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_contracts SET company_id = '${cA2}' WHERE id = '${k2}'`,
        ]),
      ).rejects.toThrow(/line_contract_company_mismatch/);
      // Moving both in one transaction (a company merge) commits.
      await asApp(cleanUrl, tA, [
        `UPDATE tenant_contracts SET company_id = '${cA2}' WHERE id = '${k2}'`,
        `UPDATE tenant_subscriptions SET company_id = '${cA2}' WHERE id = '${l}'`,
      ]);
    });

    it('V11 / Q10: a line on an offer of another product is refused at COMMIT; a referenced offer keeps its product', async () => {
      const o = await offer('addon');
      const l = await line(cA1, 'core');
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_subscriptions SET price_offer_id = '${o}' WHERE id = '${l}'`,
        ]),
      ).rejects.toThrow(/line_price_offer_product_mismatch/);
      const o2 = await offer('core');
      await asApp(cleanUrl, tA, [
        `UPDATE tenant_subscriptions SET price_offer_id = '${o2}' WHERE id = '${l}'`,
      ]);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_price_offers SET product_key = 'addon' WHERE id = '${o2}'`,
        ]),
      ).rejects.toThrow(/price_offer_product_referenced/);
    });

    it('V10 / Q7: a cycle over the UNION of renews / amends / parent is refused (contract_link_cycle); cross-account links refused at COMMIT', async () => {
      const a = await contract();
      const b = await contract();
      const c = await contract();
      await asApp(cleanUrl, tA, [
        `UPDATE tenant_contracts SET renews_contract_id = '${b}' WHERE id = '${a}'`,
        `UPDATE tenant_contracts SET amends_contract_id = '${c}' WHERE id = '${b}'`,
      ]);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_contracts SET parent_contract_id = '${a}' WHERE id = '${c}'`,
        ]),
      ).rejects.toThrow(/contract_link_cycle/);
      const other = await contract(cA2);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_contracts SET parent_contract_id = '${other}' WHERE id = '${c}'`,
        ]),
      ).rejects.toThrow(/contract_link_cross_account/);
      // Moving a linked contract alone to another account is refused (both ends checked).
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_contracts SET company_id = '${cA2}' WHERE id = '${b}'`,
        ]),
      ).rejects.toThrow(/contract_link_cross_account/);
    });

    it('V32 / Q11: a lineage cycle is refused (line_lineage_cycle); a predecessor of another account at COMMIT (line_lineage_cross_account)', async () => {
      const l1 = await line();
      const l2 = await line();
      await asApp(cleanUrl, tA, [
        `UPDATE tenant_subscriptions SET supersedes_line_id = '${l1}' WHERE id = '${l2}'`,
      ]);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_subscriptions SET supersedes_line_id = '${l2}' WHERE id = '${l1}'`,
        ]),
      ).rejects.toThrow(/line_lineage_cycle/);
      const l3 = await line(cA2);
      await expect(
        asApp(cleanUrl, tA, [
          `UPDATE tenant_subscriptions SET supersedes_line_id = '${l3}' WHERE id = '${l1}'`,
        ]),
      ).rejects.toThrow(/line_lineage_cross_account/);
    });

    it('REPEATABLE READ is refused by the graph and lineage guards', async () => {
      const a = await contract();
      const b = await contract();
      await expect(
        withAdmin(cleanUrl, async (db) => {
          await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          try {
            await db.query(
              `UPDATE tenant_contracts SET renews_contract_id = '${b}' WHERE id = '${a}'`,
            );
          } finally {
            await db.query('ROLLBACK');
          }
        }),
      ).rejects.toThrow(/contract_graph_isolation_unsupported/);
    });

    it('V10 race: A renews B and B renews A committed concurrently by two sessions → exactly one refused (contract_link_cycle), no deadlock', async () => {
      const a = await contract();
      const b = await contract();
      const s1 = await session(cleanUrl, tA);
      const s2 = await session(cleanUrl, tA);
      try {
        await s1.query(`UPDATE tenant_contracts SET renews_contract_id = '${b}' WHERE id = '${a}'`);
        // s2 waits on the contract-graph lock s1 holds.
        const second = s2
          .query(`UPDATE tenant_contracts SET renews_contract_id = '${a}' WHERE id = '${b}'`)
          .then(() => s2.query('COMMIT'))
          .then(
            () => 'committed',
            (e: Error & { code?: string }) => `${e.code ?? ''} ${e.message}`,
          );
        await new Promise((r) => setTimeout(r, 300));
        await s1.query('COMMIT');
        const outcome = await second;
        expect(outcome).toMatch(/contract_link_cycle/);
        expect(outcome).not.toMatch(/40P01|deadlock/);
      } finally {
        await s2.query('ROLLBACK').catch(() => undefined);
        await s1.end();
        await s2.end();
      }
      const rows = await q<{ id: string; renews: string | null }>(
        cleanUrl,
        `SELECT id, renews_contract_id AS renews FROM tenant_contracts WHERE id = ANY($1) ORDER BY id`,
        [[a, b]],
      );
      expect(rows.find((r) => r.id === a)!.renews).toBe(b);
      expect(rows.find((r) => r.id === b)!.renews).toBeNull();
    });

    it('V32 race: two lines superseding each other concurrently → exactly one refused (line_lineage_cycle), no deadlock', async () => {
      const l1 = await line();
      const l2 = await line();
      const s1 = await session(cleanUrl, tA);
      const s2 = await session(cleanUrl, tA);
      try {
        await s1.query(
          `UPDATE tenant_subscriptions SET supersedes_line_id = '${l2}' WHERE id = '${l1}'`,
        );
        const second = s2
          .query(`UPDATE tenant_subscriptions SET supersedes_line_id = '${l1}' WHERE id = '${l2}'`)
          .then(() => s2.query('COMMIT'))
          .then(
            () => 'committed',
            (e: Error & { code?: string }) => `${e.code ?? ''} ${e.message}`,
          );
        await new Promise((r) => setTimeout(r, 300));
        await s1.query('COMMIT');
        const outcome = await second;
        expect(outcome).toMatch(/line_lineage_cycle/);
        expect(outcome).not.toMatch(/40P01|deadlock/);
      } finally {
        await s2.query('ROLLBACK').catch(() => undefined);
        await s1.end();
        await s2.end();
      }
    });
  });

  describe('V30: the M10F migration on the #90 state', () => {
    const tA0 = 'e10f0000-0000-4e10-8e10-00000000000a';
    const cA = 'e10f0000-2222-4e10-8e10-00000000000a';
    const lA = 'e10f0000-4444-4e10-8e10-00000000000a';
    const ON = 'SET session_replication_role = replica;';
    const OFF = 'SET session_replication_role = origin;';
    const SEED = `INSERT INTO tenants (id, slug, name, updated_at) VALUES ('${tA0}', 'mfrta', 'A', now());
INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES ('${cA}', '${tA0}', 'A', now(), now());
INSERT INTO tenant_products (tenant_id, key, name, updated_at) VALUES ('${tA0}', 'core', 'Core', now());
INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system, source_object_type,
  source_record_id, observed_at) VALUES ('${tA0}', '${lA}', '${cA}', 'core', 'active', 'import', 'subscriptions', 'r1', now());
${ON}
INSERT INTO tenant_canonical_adoptions (tenant_id, id, seq, version, previous_version, reason,
  actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
VALUES ('${tA0}', gen_random_uuid(), 1, '0.5', NULL, 'new_tenant', 'system', 'test', 'system', gen_random_uuid(), gen_random_uuid());
${OFF}`;

    async function h90Database(name: string, seed = true): Promise<string> {
      const url = await createDatabase(pg, name);
      const dir = resolve(`test/.tmp/${name}-h90`);
      try {
        await migrate(url, ['--config', migrationsBefore(dir, '20270202')]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (seed) await withAdmin(url, (db) => db.query(SEED));
      return url;
    }
    const state = (url: string) =>
      q<Record<string, unknown>>(
        url,
        `SELECT (SELECT count(*)::int FROM tenant_price_offers) AS offers,
                (SELECT count(*)::int FROM tenant_contracts) AS contracts,
                (SELECT count(*)::int FROM tenant_entitlements) AS entitlements,
                (SELECT count(*)::int FROM tenant_subscriptions WHERE contract_id IS NOT NULL OR price_offer_id IS NOT NULL
                   OR supersedes_line_id IS NOT NULL OR agreement_ref_system IS NOT NULL) AS referenced,
                (SELECT count(*)::int FROM tenant_subscriptions) AS lines,
                (SELECT count(*)::int FROM tenant_module_settings) AS module_settings,
                (SELECT string_agg(version, ',' ORDER BY seq) FROM tenant_canonical_adoptions) AS adoptions`,
      );
    const EXPECTED = {
      offers: 0,
      contracts: 0,
      entitlements: 0,
      referenced: 0,
      lines: 1,
      module_settings: 0,
      adoptions: '0.5',
    };

    it('applies with no backfill (no offer, contract, entitlement, reference, setting or adoption invented); 0.6 current; rerun is a no-op', async () => {
      const url = await h90Database('m10f_on_h90');
      expect(await migrate(url)).toMatch(new RegExp(M10F));
      expect(await state(url)).toEqual([EXPECTED]);
      expect(
        await q(
          url,
          `SELECT version, status FROM canonical_model_versions WHERE major = 0 AND minor >= 5 ORDER BY minor`,
        ),
      ).toEqual([
        { version: '0.5', status: 'supported' },
        { version: '0.6', status: 'current' },
      ]);
      expect(
        await q(
          url,
          `SELECT available, minimum_canonical_version FROM canonical_modules WHERE module_key = 'commercial'`,
        ),
      ).toEqual([{ available: true, minimum_canonical_version: '0.6' }]);
      await expect(migrate(url)).resolves.toMatch(/No pending migrations/);
      expect(await state(url)).toEqual([EXPECTED]);
    });

    it('the down-script refuses each M10F data class (changing nothing), then restores exactly the #90 schema; M10F re-applies with no drift', async () => {
      const before = await h90Database('m10f_before_db', false);
      const url = await h90Database('m10f_down_db');
      await migrate(url);
      const latest = await schemaSnapshot(url);
      const down = readFileSync(M10F_DOWN, 'utf8');
      const change = (kind: string) =>
        `INSERT INTO tenant_context_changes (tenant_id, id, entity_kind, entity_id, change_type, source_system,
           source_object_type, source_record_id, cause, adapter, adapter_version, correlation_id, changed_fields)
         VALUES ('${tA0}', gen_random_uuid(), '${kind}', gen_random_uuid(), 'updated', 'import', 'operator_entry', '1',
           'human', 'operator', '1', gen_random_uuid(), ARRAY['status']::text[])`;
      const history = (kind: string, field: string) =>
        `INSERT INTO tenant_value_history (tenant_id, id, entity_kind, entity_id, field, values_recorded, effective_at,
           change_id, retention_class, actor_kind, actor_id, actor_assurance)
         VALUES ('${tA0}', gen_random_uuid(), '${kind}', gen_random_uuid(), '${field}', false, now(), gen_random_uuid(),
           'canonical_lifecycle', 'system', 'test', 'system')`;
      const conflict = (kind: string, entityKind: string) =>
        `INSERT INTO tenant_identity_conflicts (tenant_id, id, kind, entity_kind, conflict_key)
         VALUES ('${tA0}', gen_random_uuid(), '${kind}', '${entityKind}', repeat('a', 64))`;
      const audit = (capability: string, action: string) =>
        `INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance,
           capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
         VALUES ('${tA0}', gen_random_uuid(), 1, now(), 'operator', 'ops', 'asserted', '${capability}', '${action}',
           'allowed', gen_random_uuid(), 8, '{}', repeat('0', 64), repeat('a', 64))`;
      const refusals: [string, string, RegExp][] = [
        [
          `INSERT INTO tenant_price_offers (tenant_id, product_key, currency) VALUES ('${tA0}', 'core', 'EUR')`,
          `DELETE FROM tenant_price_offers`,
          /refusing rollback: 1 price offers exist/,
        ],
        [
          `INSERT INTO tenant_contracts (tenant_id, company_id) VALUES ('${tA0}', '${cA}')`,
          `DELETE FROM tenant_contracts`,
          /refusing rollback: 1 contracts exist/,
        ],
        [
          `INSERT INTO tenant_entitlements (tenant_id, company_id, product_key) VALUES ('${tA0}', '${cA}', 'core')`,
          `DELETE FROM tenant_entitlements`,
          /refusing rollback: 1 entitlements exist/,
        ],
        [
          `UPDATE tenant_subscriptions SET agreement_ref_system = 'chargebee', agreement_ref_object_type = 'Subscriptions',
             agreement_ref_external_id = 'sub_1' WHERE id = '${lA}'`,
          `UPDATE tenant_subscriptions SET agreement_ref_system = NULL, agreement_ref_object_type = NULL,
             agreement_ref_external_id = NULL WHERE id = '${lA}'`,
          /refusing rollback: 1 subscription lines carry commercial references/,
        ],
        [
          `UPDATE tenant_subscriptions SET contract_id = gen_random_uuid() WHERE id = '${lA}'`,
          `UPDATE tenant_subscriptions SET contract_id = NULL WHERE id = '${lA}'`,
          /refusing rollback: 1 subscription lines carry commercial references/,
        ],
        [
          `INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version, contract_connection_id,
             content_hash, published_by) VALUES ('${tA0}', 1, 0, gen_random_uuid(), repeat('a', 64), 'test')`,
          `DELETE FROM tenant_source_authority_versions`,
          /refusing rollback: 1 authority versions name a commercial connection/,
        ],
        [
          `INSERT INTO tenant_entity_index (tenant_id, kind, entity_id) VALUES ('${tA0}', 'contract', gen_random_uuid())`,
          `DELETE FROM tenant_entity_index WHERE kind = 'contract'`,
          /refusing rollback: 1 commercial entity-index rows exist/,
        ],
        [
          `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_id, origin)
           VALUES ('${tA0}', 'chargebee', 'Subscriptions', 'sub_1', 'contract', gen_random_uuid(), 'observed')`,
          `DELETE FROM tenant_source_references WHERE entity_kind = 'contract'`,
          /refusing rollback: 1 commercial source references exist/,
        ],
        [
          change('price_offer'),
          `DELETE FROM tenant_context_changes`,
          /refusing rollback: 1 change records use M10F kinds/,
        ],
        [
          history('subscription', 'contract_id'),
          `DELETE FROM tenant_value_history`,
          /refusing rollback: 1 value history rows of M10F fields exist/,
        ],
        [
          history('contract', 'renewal_date'),
          `DELETE FROM tenant_value_history`,
          /refusing rollback: 1 value history rows of M10F fields exist/,
        ],
        [
          conflict('contract_reference_unresolved', 'subscription'),
          `DELETE FROM tenant_identity_conflicts`,
          /refusing rollback: 1 identity conflicts of M10F kinds exist/,
        ],
        [
          `INSERT INTO tenant_extension_values (tenant_id, target_kind, target_id, field_id, value_type, value_state,
             origin, registry_version)
           VALUES ('${tA0}', 'contract', gen_random_uuid(), gen_random_uuid(), 'string', 'empty', 'human', 1)`,
          `DELETE FROM tenant_extension_values`,
          /refusing rollback: 1 extension values name a commercial entity/,
        ],
        [
          `INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
           VALUES ('${tA0}', gen_random_uuid(), 'extension', 'tier', '{"kind": "field", "target": "contract"}', 1, 1, now())`,
          `DELETE FROM tenant_registry_entries WHERE kind = 'extension'`,
          /refusing rollback: 1 extension definitions name a commercial entity/,
        ],
        [
          `INSERT INTO tenant_module_settings (tenant_id, module_key, enabled, version, updated_at, updated_by_kind,
             updated_by_id, updated_by_assurance)
           VALUES ('${tA0}', 'commercial', false, 2, now(), 'operator', 'ops', 'asserted')`,
          `DELETE FROM tenant_module_settings`,
          /refusing rollback: 1 tenant settings of module commercial exist/,
        ],
        [
          `INSERT INTO tenant_canonical_adoptions (tenant_id, id, seq, version, previous_version, reason,
             actor_kind, actor_id, actor_assurance, correlation_id, audit_event_id)
           VALUES ('${tA0}', gen_random_uuid(), 2, '0.6', '0.5', 'operator_adoption', 'operator', 'ops', 'asserted',
             gen_random_uuid(), gen_random_uuid())`,
          `DELETE FROM tenant_canonical_adoptions WHERE seq = 2`,
          /refusing rollback: 1 adoptions of canonical 0.6 exist/,
        ],
        [
          audit('data.commercial.read', 'commercial.read'),
          `DELETE FROM tenant_audit_events`,
          /refusing rollback: 1 audit events use policy-v8 capabilities or M10F actions/,
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
      expect(await state(url)).toEqual([EXPECTED]);
      await withAdmin(url, (db) => db.query(down));
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(before));
      expect(
        await q(
          url,
          `SELECT version, status FROM canonical_model_versions WHERE major = 0 AND minor >= 5 ORDER BY minor`,
        ),
      ).toEqual([{ version: '0.5', status: 'current' }]);
      expect(
        await q(url, `SELECT migration_name FROM _prisma_migrations WHERE migration_name = $1`, [
          M10F,
        ]),
      ).toEqual([]);
      expect(await migrate(url)).toMatch(new RegExp(M10F));
      expect(await schemaSnapshot(url)).toEqual(latest);
      expect(await schemaSnapshot(url)).toEqual(await schemaSnapshot(cleanUrl));
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
