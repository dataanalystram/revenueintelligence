import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  tenantClient,
  translateDatabaseError,
  type TenantTransaction,
} from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeSugar } from '../support/fake-sugar';
import { runSync, sugarTenant, type SourcesFixture } from '../support/sources';

/**
 * Adversarial cross-tenant tests for the five M8 tables, on real PostgreSQL
 * with the non-privileged app role and forced RLS. Tenant A (the attacker)
 * issues raw SQL inside its own tenant transaction against tenant B's rows:
 * SELECT, INSERT, UPDATE, DELETE and composite-FK reference hijacks. Every
 * outcome is classified through the production error translation, and B's
 * rows are re-read with the admin connection to prove they are unchanged.
 */
describe('M8 source tables: cross-tenant isolation (raw SQL, app role, forced RLS)', () => {
  let c: ContextHarness;
  let fake: FakeSugar;
  let a: SourcesFixture;
  let b: SourcesFixture;
  let bSnapshotHash: string;
  let bCompanyId: string;
  let bGap: { source_object_type: string; source_record_id: string };
  let aGap: { source_object_type: string; source_record_id: string };
  let bBefore: string;

  const TABLES = [
    'tenant_source_connections',
    'tenant_source_schema_snapshots',
    'tenant_source_mapping_versions',
    'tenant_source_authority_versions',
    'tenant_ownership_gaps',
  ] as const;

  /** Admin view of every B row in the five tables (the "unchanged" oracle). */
  const bState = async () =>
    JSON.stringify(
      await Promise.all(
        TABLES.map((t) =>
          c.sql(`SELECT to_jsonb(x) AS row FROM ${t} x WHERE tenant_id = $1 ORDER BY 1::text`, [
            b.ctx.tenantId,
          ]),
        ),
      ).then((all) => all.map((rows) => rows.map((r) => JSON.stringify(r.row)).sort())),
    );

  const inA = <T>(work: (tx: TenantTransaction) => Promise<T>) => c.h.db.transaction(a.ctx, work);

  /** The outcome of an attacker statement: rows affected, or the translated error class. */
  const attempt = async (work: (tx: TenantTransaction) => Promise<unknown>) => {
    try {
      return { ok: await inA(work) };
    } catch (error) {
      try {
        translateDatabaseError(error, 'attack');
      } catch (translated) {
        const e = translated as Error;
        return { refused: e.constructor.name, message: e.message };
      }
    }
  };
  const RLS_REFUSED = { refused: 'TenantIsolationViolationError' };
  /** A composite tenant FK refusal (PostgreSQL 23503) naming the exact constraint. */
  const fkRefused = (constraint: string) => ({
    message: expect.stringMatching(
      new RegExp(`23503[\\s\\S]*violates foreign key constraint .${constraint}`),
    ),
  });

  beforeAll(async () => {
    c = await startContextHarness();
    fake = await new FakeSugar().start();
    a = await sugarTenant(c, fake, { prefix: 'rlsa' });
    b = await sugarTenant(c, fake, { prefix: 'rlsb' });
    expect((await runSync(c, a, 'full')).status).toBe('completed');
    expect((await runSync(c, b, 'full')).status).toBe('completed');
    bSnapshotHash = (
      await c.sql<{ hash: string }>(
        'SELECT hash FROM tenant_source_schema_snapshots WHERE tenant_id = $1 LIMIT 1',
        [b.ctx.tenantId],
      )
    )[0]!.hash;
    bCompanyId = (
      await c.sql<{ id: string }>('SELECT id::text FROM companies WHERE tenant_id = $1 LIMIT 1', [
        b.ctx.tenantId,
      ])
    )[0]!.id;
    const gapOf = async (tenantId: string) =>
      (
        await c.sql<{ source_object_type: string; source_record_id: string }>(
          `SELECT source_object_type, source_record_id FROM tenant_ownership_gaps
            WHERE tenant_id = $1 ORDER BY source_record_id LIMIT 1`,
          [tenantId],
        )
      )[0]!;
    bGap = await gapOf(b.ctx.tenantId);
    aGap = await gapOf(a.ctx.tenantId);
    bBefore = await bState();
  });
  afterAll(async () => {
    await fake?.stop();
    await c?.close();
  });

  it('preconditions: tenant B holds rows in every one of the five tables', async () => {
    for (const t of TABLES) {
      const [row] = await c.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`,
        [b.ctx.tenantId],
      );
      expect(row!.n, t).toBeGreaterThan(0);
    }
  });

  describe('SELECT', () => {
    it.each(TABLES)('%s: A sees none of B rows and only its own tenant', async (t) => {
      const rows = await inA((tx) =>
        tenantClient(tx).$queryRawUnsafe<{ tenant_id: string }[]>(
          `SELECT DISTINCT tenant_id::text FROM ${t}`,
        ),
      );
      expect(rows).toEqual([{ tenant_id: a.ctx.tenantId }]);
      const targeted = await inA((tx) =>
        tenantClient(tx).$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1::uuid`,
          b.ctx.tenantId,
        ),
      );
      expect(targeted).toEqual([{ n: 0 }]);
    });

    it("A cannot find B's connection by id, nor B's rows by connection id", async () => {
      const counts = await inA(async (tx) => {
        const db = tenantClient(tx);
        const [r] = await db.$queryRaw<
          {
            connections: number;
            snapshots: number;
            mappings: number;
            gaps: number;
            authority: number;
          }[]
        >`SELECT
            (SELECT count(*)::int FROM tenant_source_connections WHERE id = ${b.connectionId}::uuid) AS connections,
            (SELECT count(*)::int FROM tenant_source_schema_snapshots WHERE connection_id = ${b.connectionId}::uuid) AS snapshots,
            (SELECT count(*)::int FROM tenant_source_mapping_versions WHERE connection_id = ${b.connectionId}::uuid) AS mappings,
            (SELECT count(*)::int FROM tenant_ownership_gaps WHERE connection_id = ${b.connectionId}::uuid) AS gaps,
            (SELECT count(*)::int FROM tenant_source_authority_versions
              WHERE subscription_lines_connection_id = ${b.connectionId}::uuid) AS authority`;
        return r;
      });
      expect(counts).toEqual({ connections: 0, snapshots: 0, mappings: 0, gaps: 0, authority: 0 });
    });
  });

  describe("INSERT with tenant B's tenant_id (RLS WITH CHECK)", () => {
    it('tenant_source_connections', async () => {
      expect(
        await attempt(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_source_connections (tenant_id, id, kind, label, mapping_mode)
            VALUES (${b.ctx.tenantId}::uuid, gen_random_uuid(), 'gainsight_cs', 'Planted', 'code')`,
        ),
      ).toMatchObject(RLS_REFUSED);
    });

    it('tenant_source_schema_snapshots', async () => {
      expect(
        await attempt(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_source_schema_snapshots (tenant_id, connection_id, hash, document, captured_by)
            VALUES (${b.ctx.tenantId}::uuid, ${b.connectionId}::uuid, ${'e'.repeat(64)}, '{}'::jsonb, 'attacker')`,
        ),
      ).toMatchObject(RLS_REFUSED);
    });

    it('tenant_source_mapping_versions', async () => {
      expect(
        await attempt(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_source_mapping_versions
              (tenant_id, connection_id, version, base_version, document, content_hash,
               schema_snapshot_hash, authority_version, published_by)
            VALUES (${b.ctx.tenantId}::uuid, ${b.connectionId}::uuid, 99, 98, '{}'::jsonb, ${'e'.repeat(64)},
                    ${bSnapshotHash}, 1, 'attacker')`,
        ),
      ).toMatchObject(RLS_REFUSED);
    });

    it('tenant_source_authority_versions', async () => {
      expect(
        await attempt(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_source_authority_versions
              (tenant_id, version, base_version, subscription_lines_connection_id, content_hash, published_by)
            VALUES (${b.ctx.tenantId}::uuid, 99, 98, ${b.connectionId}::uuid, ${'e'.repeat(64)}, 'attacker')`,
        ),
      ).toMatchObject(RLS_REFUSED);
    });

    it('tenant_ownership_gaps', async () => {
      expect(
        await attempt(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_ownership_gaps
              (tenant_id, connection_id, source_object_type, source_record_id, company_id, reason, checkpoint_id)
            VALUES (${b.ctx.tenantId}::uuid, ${b.connectionId}::uuid, 'RevenueLineItems', 'PLANTED',
                    ${bCompanyId}::uuid, 'orphan_product_reference', gen_random_uuid())`,
        ),
      ).toMatchObject(RLS_REFUSED);
    });
  });

  describe("reference hijack: A's own row pointing at B's rows (composite tenant FK)", () => {
    it("snapshot on B's connection", async () => {
      expect(
        await attempt(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_source_schema_snapshots (tenant_id, connection_id, hash, document, captured_by)
            VALUES (${a.ctx.tenantId}::uuid, ${b.connectionId}::uuid, ${'e'.repeat(64)}, '{}'::jsonb, 'attacker')`,
        ),
      ).toMatchObject(fkRefused('tenant_source_schema_snapshots_tenant_id_connection_id_fkey'));
    });

    it("mapping version on B's connection", async () => {
      expect(
        await attempt(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_source_mapping_versions
              (tenant_id, connection_id, version, base_version, document, content_hash,
               schema_snapshot_hash, authority_version, published_by)
            VALUES (${a.ctx.tenantId}::uuid, ${b.connectionId}::uuid, 99, 98, '{}'::jsonb, ${'e'.repeat(64)},
                    ${bSnapshotHash}, 1, 'attacker')`,
        ),
      ).toMatchObject(fkRefused('tenant_source_mapping_versions_tenant_id_connection_id_'));
    });

    it.each([
      ['account_profile_connection_id', 'account_profile_fkey'],
      ['person_profile_connection_id', 'person_profile__fkey'],
      ['subscription_lines_connection_id', 'subscription_li_fkey'],
      ['subscription_state_connection_id', 'subscription_st_fkey'],
      ['subscription_terms_connection_id', 'subscription_te_fkey'],
    ])("authority version assigning a fact to B's connection via %s", async (column, fk) => {
      expect(
        await attempt((tx) =>
          tenantClient(tx).$executeRawUnsafe(
            `INSERT INTO tenant_source_authority_versions
               (tenant_id, version, base_version, ${column}, content_hash, published_by)
             VALUES ($1::uuid, 99, 98, $2::uuid, $3, 'attacker')`,
            a.ctx.tenantId,
            b.connectionId,
            'e'.repeat(64),
          ),
        ),
      ).toMatchObject(fkRefused(`tenant_source_authority_versions_tenant_id_${fk}`));
    });

    it("ownership gap on B's connection, and on B's company", async () => {
      expect(
        await attempt(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_ownership_gaps
              (tenant_id, connection_id, source_object_type, source_record_id, company_id, reason, checkpoint_id)
            VALUES (${a.ctx.tenantId}::uuid, ${b.connectionId}::uuid, 'RevenueLineItems', 'PLANTED',
                    (SELECT id FROM companies LIMIT 1), 'orphan_product_reference', gen_random_uuid())`,
        ),
      ).toMatchObject(fkRefused('tenant_ownership_gaps_tenant_id_connection_id_fkey'));
      expect(
        await attempt(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_ownership_gaps
              (tenant_id, connection_id, source_object_type, source_record_id, company_id, reason, checkpoint_id)
            VALUES (${a.ctx.tenantId}::uuid, ${a.connectionId}::uuid, 'RevenueLineItems', 'PLANTED',
                    ${bCompanyId}::uuid, 'orphan_product_reference', gen_random_uuid())`,
        ),
      ).toMatchObject(fkRefused('tenant_ownership_gaps_tenant_id_company_id_fkey'));
    });
  });

  describe("UPDATE and DELETE of B's rows affect nothing", () => {
    // For the three immutable tables the refuse-change trigger would raise if a
    // B row were visible; "0 rows, no error" proves RLS filtered them first.
    const updates: Record<(typeof TABLES)[number], string> = {
      tenant_source_connections: `UPDATE tenant_source_connections SET label = 'Hijacked', status = 'disabled' WHERE tenant_id = $1::uuid`,
      tenant_source_schema_snapshots: `UPDATE tenant_source_schema_snapshots SET captured_by = 'attacker' WHERE tenant_id = $1::uuid`,
      tenant_source_mapping_versions: `UPDATE tenant_source_mapping_versions SET published_by = 'attacker' WHERE tenant_id = $1::uuid`,
      tenant_source_authority_versions: `UPDATE tenant_source_authority_versions SET subscription_lines_connection_id = NULL WHERE tenant_id = $1::uuid`,
      tenant_ownership_gaps: `UPDATE tenant_ownership_gaps SET reason = 'missing_product_reference' WHERE tenant_id = $1::uuid`,
    };

    it.each(TABLES)('%s: UPDATE targeting tenant B affects 0 rows', async (t) => {
      expect(
        await attempt((tx) => tenantClient(tx).$executeRawUnsafe(updates[t], b.ctx.tenantId)),
      ).toEqual({ ok: 0 });
    });

    it.each(TABLES)('%s: DELETE targeting tenant B affects 0 rows', async (t) => {
      expect(
        await attempt((tx) =>
          tenantClient(tx).$executeRawUnsafe(
            `DELETE FROM ${t} WHERE tenant_id = $1::uuid`,
            b.ctx.tenantId,
          ),
        ),
      ).toEqual({ ok: 0 });
    });

    it("UPDATE/DELETE by B's keys (no tenant filter) affect 0 rows", async () => {
      const res = await inA(async (tx) => {
        const db = tenantClient(tx);
        return [
          await db.$executeRaw`UPDATE tenant_source_connections SET label = 'Hijacked' WHERE id = ${b.connectionId}::uuid`,
          await db.$executeRaw`DELETE FROM tenant_ownership_gaps
            WHERE connection_id = ${b.connectionId}::uuid AND source_record_id = ${bGap.source_record_id}`,
          await db.$executeRaw`DELETE FROM tenant_source_schema_snapshots WHERE connection_id = ${b.connectionId}::uuid`,
        ];
      });
      expect(res).toEqual([0, 0, 0]);
    });
  });

  describe("moving A's own rows into tenant B is refused", () => {
    it('tenant_source_connections', async () => {
      const r = await attempt(
        (tx) =>
          tenantClient(tx).$executeRaw`
          UPDATE tenant_source_connections SET tenant_id = ${b.ctx.tenantId}::uuid WHERE id = ${a.connectionId}::uuid`,
      );
      // Two independent layers: the tenant-immutability trigger, then RLS WITH CHECK.
      expect(r).toMatchObject({
        message: expect.stringMatching(
          /tenant_id is immutable on tenant_source_connections|row-level security/,
        ),
      });
      const [row] = await c.sql<{ n: number }>(
        'SELECT count(*)::int AS n FROM tenant_source_connections WHERE tenant_id = $1',
        [a.ctx.tenantId],
      );
      expect(row!.n).toBeGreaterThan(0);
    });

    it('tenant_ownership_gaps', async () => {
      const r = await attempt(
        (tx) =>
          tenantClient(tx).$executeRaw`
          UPDATE tenant_ownership_gaps SET tenant_id = ${b.ctx.tenantId}::uuid
           WHERE source_object_type = ${aGap.source_object_type} AND source_record_id = ${aGap.source_record_id}`,
      );
      // Two independent layers: the tenant-immutability trigger, then RLS WITH CHECK.
      expect(r).toMatchObject({
        message: expect.stringMatching(
          /tenant_id is immutable on tenant_ownership_gaps|row-level security/,
        ),
      });
      const [row] = await c.sql<{ n: number }>(
        'SELECT count(*)::int AS n FROM tenant_ownership_gaps WHERE tenant_id = $1',
        [a.ctx.tenantId],
      );
      expect(row!.n).toBeGreaterThan(0);
    });
  });

  it("after every attack, tenant B's rows in all five tables are byte-for-byte unchanged", async () => {
    expect(await bState()).toBe(bBefore);
  });
});
