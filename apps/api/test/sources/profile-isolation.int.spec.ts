import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProfilePurgeService } from '../../src/modules/sources';
import {
  tenantClient,
  translateDatabaseError,
  type TenantTransaction,
} from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeSugar } from '../support/fake-sugar';
import { runSync, sugarTenant, type SourcesFixture } from '../support/sources';

/**
 * Adversarial cross-tenant tests for the four M9A tables, the authority
 * proof-acceptance column and the new ownership-gap reasons (M9A §13.4), on
 * real PostgreSQL with the non-privileged app role and forced RLS. Tenant A
 * (the attacker) issues raw SQL in its own tenant transaction against tenant
 * B's rows; every outcome is classified through the production error
 * translation and B's rows are re-read with the admin connection.
 */
describe('M9A profile tables: cross-tenant isolation (raw SQL, app role, forced RLS)', () => {
  let c: ContextHarness;
  let fake: FakeSugar;
  let fakeB: FakeSugar;
  let a: SourcesFixture;
  let b: SourcesFixture;
  const ids = {} as {
    aRun: string;
    aSnapshot: string;
    aProfile: string;
    bRun: string;
    bSnapshot: string;
    bProfile: string;
    bSyncRun: string;
    bFinding: string;
    bCompany: string;
  };
  let bBefore: string;

  const TABLES = [
    'tenant_source_profile_runs',
    'tenant_source_profiles',
    'tenant_source_profile_findings',
    'tenant_source_profile_purges',
  ] as const;

  const bState = async () =>
    JSON.stringify(
      await Promise.all(
        [...TABLES, 'tenant_source_authority_versions', 'tenant_ownership_gaps'].map((t) =>
          c.sql(`SELECT to_jsonb(x) AS row FROM ${t} x WHERE tenant_id = $1`, [b.ctx.tenantId]),
        ),
      ).then((all) => all.map((rows) => rows.map((r) => JSON.stringify(r.row)).sort())),
    );

  const inA = <T>(work: (tx: TenantTransaction) => Promise<T>) => c.h.db.transaction(a.ctx, work);
  const attempt = async (sql: string, ...params: unknown[]) => {
    try {
      return { ok: await inA((tx) => tenantClient(tx).$executeRawUnsafe(sql, ...params)) };
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
  /** SQLSTATE 42501 (no privilege): the production translation classifies it as a refusal. */
  const PERMISSION_DENIED = RLS_REFUSED;
  const fkRefused = (constraint: string) => ({
    message: expect.stringMatching(
      new RegExp(`23503[\\s\\S]*violates foreign key constraint .${constraint}`),
    ),
  });

  beforeAll(async () => {
    c = await startContextHarness();
    fake = await new FakeSugar().start();
    // B's schema differs (an extra option on an ignored field), so its snapshot hash is B's alone.
    fakeB = new FakeSugar();
    fakeB.addEnumOption('RevenueLineItems', 'status', 'Pending');
    await fakeB.start();
    a = await sugarTenant(c, fake, { prefix: 'pisoa' });
    b = await sugarTenant(c, fakeB, { prefix: 'pisob' });
    expect((await runSync(c, a, 'full')).status).toBe('completed');
    expect((await runSync(c, b, 'full')).status).toBe('completed');
    const purge = c.app.get(ProfilePurgeService);
    for (const f of [a, b]) {
      await purge.purge(f.ctx, f.connectionId, 'Accounts', {
        keep: 10,
        actor: 'ops',
        execute: true,
        ownerDatabaseUrl: c.adminUrl,
      });
    }
    const one = async <T extends Record<string, unknown>>(sql: string, tenantId: string) =>
      (await c.sql<T>(sql, [tenantId]))[0]!;
    ids.aRun = (
      await one<{ id: string }>(
        `SELECT id FROM tenant_source_profile_runs WHERE tenant_id = $1 LIMIT 1`,
        a.ctx.tenantId,
      )
    ).id;
    ids.bRun = (
      await one<{ id: string }>(
        `SELECT id FROM tenant_source_profile_runs WHERE tenant_id = $1 LIMIT 1`,
        b.ctx.tenantId,
      )
    ).id;
    ids.aSnapshot = (
      await one<{ hash: string }>(
        `SELECT hash FROM tenant_source_schema_snapshots WHERE tenant_id = $1 LIMIT 1`,
        a.ctx.tenantId,
      )
    ).hash;
    ids.bSnapshot = (
      await one<{ hash: string }>(
        `SELECT hash FROM tenant_source_schema_snapshots WHERE tenant_id = $1 LIMIT 1`,
        b.ctx.tenantId,
      )
    ).hash;
    ids.aProfile = (
      await one<{ id: string }>(
        `SELECT id FROM tenant_source_profiles WHERE tenant_id = $1 AND sampling_family = 'profile' LIMIT 1`,
        a.ctx.tenantId,
      )
    ).id;
    ids.bProfile = (
      await one<{ id: string }>(
        `SELECT id FROM tenant_source_profiles WHERE tenant_id = $1 AND sampling_family = 'profile' LIMIT 1`,
        b.ctx.tenantId,
      )
    ).id;
    ids.bSyncRun = (
      await one<{ sync_run_id: string }>(
        `SELECT sync_run_id FROM tenant_source_profiles WHERE tenant_id = $1 AND sampling_family = 'sync' LIMIT 1`,
        b.ctx.tenantId,
      )
    ).sync_run_id;
    ids.bFinding = (
      await one<{ id: string }>(
        `SELECT id FROM tenant_source_profile_findings WHERE tenant_id = $1 LIMIT 1`,
        b.ctx.tenantId,
      )
    ).id;
    expect(ids.bSnapshot).not.toBe(ids.aSnapshot);
    ids.bCompany = (
      await one<{ id: string }>(
        `SELECT id::text FROM companies WHERE tenant_id = $1 LIMIT 1`,
        b.ctx.tenantId,
      )
    ).id;
    bBefore = await bState();
  });
  afterAll(async () => {
    await fake?.stop();
    await fakeB?.stop();
    await c?.close();
  });

  it('preconditions: tenant B holds rows in every new table (profile and sync families)', async () => {
    for (const t of TABLES) {
      const [row] = await c.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`,
        [b.ctx.tenantId],
      );
      expect(row!.n, t).toBeGreaterThan(0);
    }
    expect(ids.bSyncRun).toBeDefined();
  });

  it('the app role has exactly the privileges M9A grants (immutable tables: no UPDATE/DELETE)', async () => {
    const rows = await c.sql<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'lip_app' AND table_name = ANY($1) ORDER BY 1, 2`,
      [TABLES],
    );
    const by = (t: string) =>
      rows
        .filter((r) => r.table_name === t)
        .map((r) => r.privilege_type)
        .sort();
    expect(by('tenant_source_profile_runs')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(
      by('tenant_source_profiles').filter((p) =>
        ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(p),
      ),
    ).toEqual(['INSERT', 'SELECT']);
    expect(
      by('tenant_source_profile_findings').filter((p) =>
        ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(p),
      ),
    ).toEqual(['INSERT', 'SELECT']);
    expect(
      by('tenant_source_profile_purges').filter((p) =>
        ['INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(p),
      ),
    ).toEqual(['SELECT']);
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

    it("A cannot find B's run, profile or finding by id", async () => {
      const [r] = await inA((tx) =>
        tenantClient(tx).$queryRawUnsafe<{ runs: number; profiles: number; findings: number }[]>(
          `SELECT (SELECT count(*)::int FROM tenant_source_profile_runs WHERE id = $1::uuid) AS runs,
                  (SELECT count(*)::int FROM tenant_source_profiles WHERE id = $2::uuid) AS profiles,
                  (SELECT count(*)::int FROM tenant_source_profile_findings WHERE id = $3::uuid) AS findings`,
          ids.bRun,
          ids.bProfile,
          ids.bFinding,
        ),
      );
      expect(r).toEqual({ runs: 0, profiles: 0, findings: 0 });
    });
  });

  describe("INSERT with tenant B's tenant_id", () => {
    it('tenant_source_profile_runs (RLS WITH CHECK)', async () => {
      expect(
        await attempt(
          `INSERT INTO tenant_source_profile_runs (tenant_id, id, connection_id, schema_snapshot_hash, active_key, request, requested_by, correlation_id)
           VALUES ($1::uuid, gen_random_uuid(), $2::uuid, $3, $2, '{}'::jsonb, 'attacker', gen_random_uuid())`,
          b.ctx.tenantId,
          b.connectionId,
          ids.bSnapshot,
        ),
      ).toMatchObject(RLS_REFUSED);
    });

    it('tenant_source_profiles (RLS WITH CHECK)', async () => {
      expect(
        await attempt(
          `INSERT INTO tenant_source_profiles (tenant_id, id, run_id, connection_id, object, schema_snapshot_hash, sampling_family, document, document_version, content_hash)
           VALUES ($1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, 'Planted', $4, 'profile', '{}'::jsonb, 1, repeat('e', 64))`,
          b.ctx.tenantId,
          ids.bRun,
          b.connectionId,
          ids.bSnapshot,
        ),
      ).toMatchObject(RLS_REFUSED);
    });

    it('tenant_source_profile_findings (RLS WITH CHECK)', async () => {
      expect(
        await attempt(
          `INSERT INTO tenant_source_profile_findings (tenant_id, id, profile_id, code, class, severity, object, evidence)
           VALUES ($1::uuid, gen_random_uuid(), $2::uuid, 'mixed_type', 'advisory', 'warning', 'Planted', '{}'::jsonb)`,
          b.ctx.tenantId,
          ids.bProfile,
        ),
      ).toMatchObject(RLS_REFUSED);
    });

    it('tenant_source_profile_purges (the app role cannot write the audit at all)', async () => {
      for (const tenant of [b.ctx.tenantId, a.ctx.tenantId]) {
        expect(
          await attempt(
            `INSERT INTO tenant_source_profile_purges (tenant_id, id, connection_id, object, kept, deleted_profiles, deleted_findings, actor, correlation_id)
             VALUES ($1::uuid, gen_random_uuid(), $2::uuid, 'Accounts', 0, 0, 0, 'attacker', gen_random_uuid())`,
            tenant,
            tenant === a.ctx.tenantId ? a.connectionId : b.connectionId,
          ),
        ).toMatchObject(PERMISSION_DENIED);
      }
    });

    it('an ownership gap with a new M9A reason (RLS WITH CHECK)', async () => {
      expect(
        await attempt(
          `INSERT INTO tenant_ownership_gaps (tenant_id, connection_id, source_object_type, source_record_id, company_id, reason, checkpoint_id)
           VALUES ($1::uuid, $2::uuid, 'RevenueLineItems', 'PLANTED', $3::uuid, 'observation_rejected', gen_random_uuid())`,
          b.ctx.tenantId,
          b.connectionId,
          ids.bCompany,
        ),
      ).toMatchObject(RLS_REFUSED);
    });
  });

  describe("reference hijack: A's own rows pointing at B's rows (composite tenant FKs)", () => {
    it("a run on B's connection, and on B's snapshot", async () => {
      expect(
        await attempt(
          `INSERT INTO tenant_source_profile_runs (tenant_id, id, connection_id, schema_snapshot_hash, active_key, request, requested_by, correlation_id)
           VALUES ($1::uuid, gen_random_uuid(), $2::uuid, $3, $2, '{}'::jsonb, 'attacker', gen_random_uuid())`,
          a.ctx.tenantId,
          b.connectionId,
          ids.aSnapshot,
        ),
      ).toMatchObject(
        fkRefused('tenant_source_profile_runs_(tenant_id_connection_id_fkey|snapshot_fkey)'),
      );
      expect(
        await attempt(
          `INSERT INTO tenant_source_profile_runs (tenant_id, id, connection_id, schema_snapshot_hash, active_key, request, requested_by, correlation_id)
           VALUES ($1::uuid, gen_random_uuid(), $2::uuid, $3, $2, '{}'::jsonb, 'attacker', gen_random_uuid())`,
          a.ctx.tenantId,
          a.connectionId,
          ids.bSnapshot,
        ),
      ).toMatchObject(fkRefused('tenant_source_profile_runs_snapshot_fkey'));
    });

    const profileInsert = (over: {
      run?: string;
      sync?: string;
      conn?: string;
      snap?: string;
      previous?: string;
    }) =>
      attempt(
        `INSERT INTO tenant_source_profiles (tenant_id, id, run_id, sync_run_id, connection_id, object, schema_snapshot_hash, sampling_family, previous_profile_id, document, document_version, content_hash)
         VALUES ($1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, $4::uuid, 'Planted', $5, $6, $7::uuid, '{}'::jsonb, 1, repeat('e', 64))`,
        a.ctx.tenantId,
        over.sync ? null : (over.run ?? ids.aRun),
        over.sync ?? null,
        over.conn ?? a.connectionId,
        over.snap ?? ids.aSnapshot,
        over.sync ? 'sync' : 'profile',
        over.previous ?? null,
      );

    it("a profile on B's run, B's sync run, B's connection, B's snapshot or with B's profile as baseline", async () => {
      expect(await profileInsert({ run: ids.bRun })).toMatchObject(
        fkRefused('tenant_source_profiles_tenant_id_run_id_fkey'),
      );
      expect(await profileInsert({ sync: ids.bSyncRun })).toMatchObject(
        fkRefused('tenant_source_profiles_tenant_id_sync_run_id_fkey'),
      );
      expect(await profileInsert({ conn: b.connectionId, snap: ids.bSnapshot })).toMatchObject(
        fkRefused('tenant_source_profiles_tenant_id_connection_id_(fkey|snapshot_fkey)'),
      );
      expect(await profileInsert({ snap: ids.bSnapshot })).toMatchObject(
        fkRefused('tenant_source_profiles_tenant_id_connection_id_snapshot_fkey'),
      );
      expect(await profileInsert({ previous: ids.bProfile })).toMatchObject(
        fkRefused('tenant_source_profiles_tenant_id_previous_profile_id_fkey'),
      );
    });

    it("a finding on B's profile", async () => {
      expect(
        await attempt(
          `INSERT INTO tenant_source_profile_findings (tenant_id, id, profile_id, code, class, severity, object, evidence)
           VALUES ($1::uuid, gen_random_uuid(), $2::uuid, 'mixed_type', 'advisory', 'warning', 'Planted', '{}'::jsonb)`,
          a.ctx.tenantId,
          ids.bProfile,
        ),
      ).toMatchObject(fkRefused('tenant_source_profile_findings_tenant_id_profile_id_fkey'));
    });

    it("a proof acceptance naming B's connection in A's authority version", async () => {
      const [latest] = await c.sql<{ version: number }>(
        'SELECT max(version) AS version FROM tenant_source_authority_versions WHERE tenant_id = $1',
        [a.ctx.tenantId],
      );
      const r = await attempt(
        `INSERT INTO tenant_source_authority_versions (tenant_id, version, base_version, content_hash, published_by, proof_acceptances)
         VALUES ($1::uuid, $2, $3, repeat('e', 64), 'attacker',
                 jsonb_build_array(jsonb_build_object('tier', 'stable_snapshot', 'connectionId', $4::text, 'reason', 'x', 'actor', 'attacker')))`,
        a.ctx.tenantId,
        latest!.version + 1,
        latest!.version,
        b.connectionId,
      );
      expect(r).toMatchObject({
        message: expect.stringMatching(
          /proof acceptance names a connection of another tenant or none/,
        ),
      });
    });
  });

  describe("UPDATE and DELETE of B's rows", () => {
    it('runs: UPDATE targeting tenant B affects 0 rows; DELETE is not granted', async () => {
      expect(
        await attempt(
          `UPDATE tenant_source_profile_runs SET error_code = 'hijacked' WHERE tenant_id = $1::uuid`,
          b.ctx.tenantId,
        ),
      ).toEqual({ ok: 0 });
      expect(
        await attempt(
          `UPDATE tenant_source_profile_runs SET error_code = 'hijacked' WHERE id = $1::uuid`,
          ids.bRun,
        ),
      ).toEqual({ ok: 0 });
      expect(
        await attempt(
          `DELETE FROM tenant_source_profile_runs WHERE tenant_id = $1::uuid`,
          b.ctx.tenantId,
        ),
      ).toMatchObject(PERMISSION_DENIED);
    });

    it.each([
      'tenant_source_profiles',
      'tenant_source_profile_findings',
      'tenant_source_profile_purges',
    ])('%s: UPDATE and DELETE are not granted to the app role at all', async (t) => {
      expect(
        await attempt(
          `UPDATE ${t} SET created_at = now() WHERE tenant_id = $1::uuid`,
          b.ctx.tenantId,
        ),
      ).toMatchObject(PERMISSION_DENIED);
      expect(
        await attempt(`DELETE FROM ${t} WHERE tenant_id = $1::uuid`, b.ctx.tenantId),
      ).toMatchObject(PERMISSION_DENIED);
    });
  });

  describe("moving A's own rows into tenant B is refused", () => {
    it('tenant_source_profile_runs', async () => {
      const r = await attempt(
        `UPDATE tenant_source_profile_runs SET tenant_id = $1::uuid WHERE id = $2::uuid`,
        b.ctx.tenantId,
        ids.aRun,
      );
      expect(r).toMatchObject({
        message: expect.stringMatching(
          /tenant_id is immutable on tenant_source_profile_runs|row-level security|is terminal/,
        ),
      });
    });

    it.each([
      'tenant_source_profiles',
      'tenant_source_profile_findings',
      'tenant_source_profile_purges',
    ])('%s', async (t) => {
      expect(await attempt(`UPDATE ${t} SET tenant_id = $1::uuid`, b.ctx.tenantId)).toMatchObject(
        PERMISSION_DENIED,
      );
    });
  });

  it("after every attack, tenant B's rows are byte-for-byte unchanged", async () => {
    expect(await bState()).toBe(bBefore);
    const [own] = await c.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenant_source_profiles WHERE tenant_id = $1 AND object = 'Planted'`,
      [a.ctx.tenantId],
    );
    expect(own!.n).toBe(0);
  });
});
