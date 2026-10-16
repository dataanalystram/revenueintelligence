import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AccountHierarchyWriter,
  AccountStructureReadModel,
  type OperatorParentInput,
} from '../../src/modules/context';
import { AccountStructureStore } from '../../src/modules/context/infrastructure/account-structure.store';
import { sourceSyncActor } from '../../src/modules/domain';
import {
  CanonicalAdoptionService,
  IntegrityVerificationService,
} from '../../src/modules/governance';
import {
  InvalidReferenceError,
  TenantDatabase,
  type TenantContext,
} from '../../src/modules/tenancy';
import { appConfig } from '../support/containers';
import type { AppConfig } from '../../src/platform/config';
import {
  appSession,
  asApp,
  auditOf,
  chain,
  companies,
  hs,
  historyOf,
  ingestMeta,
  insertCompanyRow,
  issuesOf,
  observeCompany,
  parentOf,
  structureChangesOf,
} from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import { company, person } from '../support/tenancy';
import { authz } from '../support/security';

const REASON = 'org_chart_review';

/**
 * M10C account hierarchy (plan §2, §4, §5, §6, §19) on real PostgreSQL as the
 * application role with forced RLS: the schema rules (V2), the cycle trigger
 * under raw SQL and two concurrent sessions (V3), the depth guardrail (V4),
 * source semantics at the single writer (V5, ingestion level; the end-to-end
 * Sugar run is in test/sources/account-structure-sync.int.spec.ts), operator
 * entry (V6), value history (V7), the company merge participant (V8,
 * hierarchy), the hierarchy read model (V12), cross-tenant refusal by raw SQL
 * (V11, hierarchy) and the 0.3 gate with rollback (V15, hierarchy).
 */
describe('M10C account hierarchy', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  const writer = () => c.app.get(AccountHierarchyWriter);
  const readModel = () => c.app.get(AccountStructureReadModel);
  const store = () => c.app.get(AccountStructureStore, { strict: false });
  const db = () => c.app.get(TenantDatabase);
  const adoption = () => c.app.get(CanonicalAdoptionService);
  const integrity = () => c.app.get(IntegrityVerificationService);
  /** The writer with another platform guardrail (same store, audit trail and database). */
  const writerWithDepth = (maxDepth: number) =>
    new AccountHierarchyWriter(db(), store(), writer().audit, {
      canonical: { hierarchyMaxDepth: maxDepth },
    } as AppConfig);

  const set = async (t: TenantContext, input: OperatorParentInput, w = writer()) =>
    w.set(await authz(t, 'canonical.human_entry'), input);
  const clear = async (t: TenantContext, companyId: string) =>
    writer().clear(await authz(t, 'canonical.human_entry'), { companyId, reason: REASON });
  const release = async (t: TenantContext, companyId: string) =>
    writer().release(await authz(t, 'canonical.human_entry'), { companyId, reason: REASON });
  const merge = async (t: TenantContext, survivor: string, merged: string[]) =>
    c.ingestion.ingestMerge(
      await authz(t, 'canonical.source_sync'),
      { kind: 'company', survivor: hs(survivor), merged: merged.map(hs), observedAt: new Date() },
      ingestMeta(),
    );
  const parent = async (t: TenantContext, id: string) =>
    (await parentOf(c, t, id)).parent_company_id;

  describe('V2: schema rules (raw SQL as the app role)', () => {
    it('self-parent CHECK, origin CHECK and the same-tenant composite FK refuse; a valid parent is accepted', async () => {
      const t = await c.tenant('hschema', 1001);
      const other = await c.tenant('hschemab', 2002);
      const ids = await companies(c, t, ['201', '202']);
      const foreign = await companies(c, other, ['201']);
      await asApp(c, t, async (db) => {
        await expect(
          db.query(`UPDATE companies SET parent_company_id = id WHERE id = $1`, [ids['201']]),
        ).rejects.toMatchObject({ code: '23514', constraint: 'companies_parent_not_self' });
      });
      await asApp(c, t, async (db) => {
        await expect(
          db.query(`UPDATE companies SET parent_company_origin = 'inferred' WHERE id = $1`, [
            ids['201'],
          ]),
        ).rejects.toMatchObject({ code: '23514', constraint: 'companies_parent_origin_valid' });
      });
      await asApp(c, t, async (db) => {
        // A parent of another tenant has no (tenant_id, id) row: the composite FK refuses it.
        await expect(
          db.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [
            ids['201'],
            foreign['201'],
          ]),
        ).rejects.toMatchObject({
          code: '23503',
          constraint: 'companies_tenant_id_parent_company_id_fkey',
        });
      });
      await asApp(c, t, async (db) => {
        const r = await db.query(
          `UPDATE companies SET parent_company_id = $2, parent_company_origin = 'human' WHERE id = $1`,
          [ids['202'], ids['201']],
        );
        expect(r.rowCount).toBe(1);
      });
      // Rolled back: nothing persisted.
      expect(await parentOf(c, t, ids['202']!)).toMatchObject({
        parent_company_id: null,
        parent_company_origin: null,
      });
    });

    it('a merged parent is refused by the trigger (hierarchy_parent_merged)', async () => {
      const t = await c.tenant('hmerged', 1001);
      const ids = await companies(c, t, ['211', '212', '213']);
      await merge(t, '212', ['211']);
      expect((await parentOf(c, t, ids['211']!)).record_state).toBe('merged');
      await asApp(c, t, async (db) => {
        await expect(
          db.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [
            ids['213'],
            ids['211'],
          ]),
        ).rejects.toMatchObject({ code: '23514', message: 'hierarchy_parent_merged' });
      });
    });

    it('the walk ceiling (64) refuses a parent with no root within 64 ancestors (hierarchy_ceiling)', async () => {
      const t = await c.tenant('hceiling', 1001);
      await asApp(c, t, async (db) => {
        // c0 (root) … c64: c64 sits at depth 64, the deepest the backstop accepts.
        let previous = await insertCompanyRow(db, t);
        for (let depth = 1; depth <= 64; depth += 1) {
          previous = await insertCompanyRow(db, t, previous);
        }
        const deepest = previous;
        await expect(insertCompanyRow(db, t, deepest)).rejects.toMatchObject({
          code: '23514',
          message: 'hierarchy_ceiling',
        });
      });
    });
  });

  describe('V3: the cycle trigger as the app role (raw SQL)', () => {
    it('refuses a direct and a long cycle', async () => {
      const t = await c.tenant('hcycle', 1001);
      const [a, b] = Object.values(await companies(c, t, ['301', '302']));
      await asApp(c, t, async (db) => {
        await db.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [a, b]);
        await expect(
          db.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [b, a]),
        ).rejects.toMatchObject({ code: '23514', message: 'hierarchy_cycle' });
      });
      const ids = await chain(c, t, ['311', '312', '313', '314', '315']);
      await asApp(c, t, async (db) => {
        await expect(
          db.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [ids[0], ids[4]]),
        ).rejects.toMatchObject({ code: '23514', message: 'hierarchy_cycle' });
      });
      expect(await parent(t, ids[0]!)).toBeNull();
    });

    it('two concurrent sessions crossing (A → B, B → A): exactly one succeeds, no cycle is stored', async () => {
      const t = await c.tenant('hconc', 1001);
      for (let round = 0; round < 3; round += 1) {
        const ids = await companies(c, t, [`32${round}1`, `32${round}2`]);
        const [a, b] = [ids[`32${round}1`]!, ids[`32${round}2`]!];
        const s1 = await appSession(c, t);
        const s2 = await appSession(c, t);
        try {
          await s1.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [a, b]);
          const second = s2
            .query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [b, a])
            .then(
              () => 'ok' as const,
              (e: { message?: string }) => e.message ?? 'error',
            );
          // Wait (bounded) until the second session queues on the tenant's hierarchy lock.
          const end = Date.now() + 5_000;
          while (Date.now() < end) {
            const [waiting] = await c.sql<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
            );
            if (waiting!.n > 0) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          await s1.query('COMMIT');
          const outcome = await second;
          await s2.query(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK');
          expect(outcome).toBe('hierarchy_cycle');
        } finally {
          await s1.end();
          await s2.end();
        }
        const parents = [await parent(t, a), await parent(t, b)];
        expect(parents).toEqual([b, null]);
      }
      expect((await integrity().verify(t)).findings.map((f) => f.check)).not.toContain(
        'hierarchy_cycle',
      );
    });

    it('REPEATABLE READ is refused (hierarchy_isolation_unsupported): the crossing cannot slip past a stale snapshot; SERIALIZABLE and READ COMMITTED re-parent (M1)', async () => {
      const t = await c.tenant('hiso', 1001);
      const ids = await companies(c, t, ['341', '342', '343']);
      const [a, b, d] = [ids['341']!, ids['342']!, ids['343']!];
      // Two crossing app-role sessions at REPEATABLE READ: both are refused before any lock or walk.
      const s1 = await appSession(c, t, 'REPEATABLE READ');
      const s2 = await appSession(c, t, 'REPEATABLE READ');
      try {
        await expect(
          s1.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [a, b]),
        ).rejects.toMatchObject({ code: '0A000', message: 'hierarchy_isolation_unsupported' });
        await expect(
          s2.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [b, a]),
        ).rejects.toMatchObject({ code: '0A000', message: 'hierarchy_isolation_unsupported' });
        // An insert with a parent is refused too; an insert without one is untouched.
        await s1.query('ROLLBACK');
        await s1.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await s1.query(`SELECT set_config('app.current_tenant', $1, true)`, [t.tenantId]);
        await expect(insertCompanyRow(s1, t, a)).rejects.toMatchObject({
          message: 'hierarchy_isolation_unsupported',
        });
        await s1.query('ROLLBACK');
        await s1.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await s1.query(`SELECT set_config('app.current_tenant', $1, true)`, [t.tenantId]);
        await expect(insertCompanyRow(s1, t, null)).resolves.toEqual(expect.any(String));
      } finally {
        await s1.query('ROLLBACK').catch(() => undefined);
        await s2.query('ROLLBACK').catch(() => undefined);
        await s1.end();
        await s2.end();
      }
      expect([await parent(t, a), await parent(t, b)]).toEqual([null, null]);
      const ser = await appSession(c, t, 'SERIALIZABLE');
      try {
        await ser.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [a, b]);
        await ser.query('COMMIT');
      } finally {
        await ser.end();
      }
      const rc = await appSession(c, t);
      try {
        await rc.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [d, b]);
        await rc.query('COMMIT');
      } finally {
        await rc.end();
      }
      expect([await parent(t, a), await parent(t, d)]).toEqual([b, b]);
    });

    it('two concurrent operator writes crossing: one applied, the other refused hierarchy_cycle', async () => {
      const t = await c.tenant('hconcop', 1001);
      const ids = await companies(c, t, ['331', '332']);
      const [a, b] = [ids['331']!, ids['332']!];
      const results = await Promise.allSettled([
        set(t, { companyId: a, parentId: b, reason: REASON }),
        set(t, { companyId: b, parentId: a, reason: REASON }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: 'hierarchy_cycle' });
      const stored = [await parent(t, a), await parent(t, b)];
      expect(stored.filter((p) => p !== null)).toHaveLength(1);
    });
  });

  describe('V4: depth guardrail', () => {
    it('default 10: depth 10 accepted, depth 11 refused; parent unchanged, one issue (conflict key), other fields applied; a later accepted write resolves it', async () => {
      const t = await c.tenant('hdepth', 1001);
      expect(writer().maxDepth).toBe(10);
      const ids = await chain(
        c,
        t,
        Array.from({ length: 11 }, (_, i) => `4${String(i).padStart(2, '0')}`),
      );
      expect((await integrity().verify(t)).outcome).toBe('passed');
      // ids[10] sits at depth 10. A child below it would be at depth 11.
      const child = await observeCompany(c, t, '499', { parent: '410', name: 'First name' });
      const childId = child.entityId!;
      expect(await parentOf(c, t, childId)).toMatchObject({
        parent_company_id: null,
        parent_company_origin: null,
        name: 'First name',
      });
      await observeCompany(c, t, '499', { parent: '410', name: 'Second name' });
      expect(await parentOf(c, t, childId)).toMatchObject({
        parent_company_id: null,
        name: 'Second name',
      });
      const issues = await issuesOf(c, t);
      expect(issues).toEqual([
        {
          kind: 'hierarchy_depth_exceeded',
          entity_kind: 'company',
          state: 'open',
          canonical_ids: [childId, ids[10]!].sort(),
          external_refs: ['hubspot:companies:410', 'hubspot:companies:499'],
        },
      ]);
      expect(await historyOf(c, t, 'company', childId)).toEqual([]);
      // A later accepted write resolves the issue.
      await observeCompany(c, t, '499', { parent: '405', name: 'Second name' });
      expect(await parent(t, childId)).toBe(ids[5]);
      expect((await issuesOf(c, t)).map((i) => [i.kind, i.state])).toEqual([
        ['hierarchy_depth_exceeded', 'resolved'],
      ]);
    });

    it('a configured guardrail is honoured, counting the subtree height of the re-parented account', async () => {
      const t = await c.tenant('hdepthcfg', 1001);
      const w = writerWithDepth(3);
      expect(w.maxDepth).toBe(3);
      const r = await chain(c, t, ['421', '422', '423', '424']); // r[3] at depth 3
      const [x, y] = await chain(c, t, ['431', '432']); // x with one child (height 1)
      await expect(
        set(
          t,
          { companyId: (await companies(c, t, ['425']))['425']!, parentId: r[3]!, reason: REASON },
          w,
        ),
      ).rejects.toMatchObject({ code: 'hierarchy_depth_exceeded' });
      // depth(r2) = 2, + 1 + height 1 = 4 > 3: refused although x itself would sit at depth 3.
      await expect(
        set(t, { companyId: x!, parentId: r[2]!, reason: REASON }, w),
      ).rejects.toMatchObject({ code: 'hierarchy_depth_exceeded' });
      expect(await parent(t, x!)).toBeNull();
      // depth(r1) = 1, + 1 + 1 = 3: accepted; y lands at depth 3.
      await expect(
        set(t, { companyId: x!, parentId: r[1]!, reason: REASON }, w),
      ).resolves.toMatchObject({ parentId: r[1], changed: true });
      expect(await parent(t, y!)).toBe(x);
      // The refused operator writes are audited as failed with the refusal code.
      const failed = (await auditOf(c, t, 'account.hierarchy.set')).filter(
        (e) => e.outcome === 'failed',
      );
      expect(failed.map((e) => e.reason_code)).toEqual([
        'hierarchy_depth_exceeded',
        'hierarchy_depth_exceeded',
      ]);
    });

    it('an invalid guardrail refuses start-up (configuration schema)', () => {
      for (const bad of ['0', '51', '-1', '2.5', 'ten']) {
        expect(
          () =>
            appConfig('postgresql://x:y@127.0.0.1:1/db', 'redis://127.0.0.1:1', {
              CANONICAL_HIERARCHY_MAX_DEPTH: bad,
            }),
          bad,
        ).toThrow();
      }
      expect(
        appConfig('postgresql://x:y@127.0.0.1:1/db', 'redis://127.0.0.1:1', {
          CANONICAL_HIERARCHY_MAX_DEPTH: '50',
        }).canonical.hierarchyMaxDepth,
      ).toBe(50);
      expect(
        appConfig('postgresql://x:y@127.0.0.1:1/db', 'redis://127.0.0.1:1').canonical
          .hierarchyMaxDepth,
      ).toBe(10);
    });
  });

  describe('V5: source semantics at the single writer', () => {
    it('an unknown parent is retried in the second pass; still unknown → one open issue; resolved by a later observation', async () => {
      const t = await c.tenant('hpending', 1001);
      const first = await observeCompany(c, t, '501', { parent: '502' });
      expect(first.unresolvedParent).toEqual(hs('502'));
      const childId = first.entityId!;
      expect(await parent(t, childId)).toBeNull();
      const actx = await authz(t, 'canonical.source_sync');
      // Second pass, the parent still unknown: an open unresolved issue (identifiers only).
      await expect(
        c.ingestion.resolvePendingParent(
          actx,
          { child: hs('501'), parent: hs('502'), observedAt: new Date() },
          ingestMeta(),
        ),
      ).resolves.toBe('unresolved');
      expect(await issuesOf(c, t)).toEqual([
        {
          kind: 'hierarchy_parent_unresolved',
          entity_kind: 'company',
          state: 'open',
          canonical_ids: [childId],
          external_refs: ['hubspot:companies:501', 'hubspot:companies:502'],
        },
      ]);
      // The parent arrives; the second pass of that run applies the pair.
      const parentId = (await observeCompany(c, t, '502')).entityId!;
      await expect(
        c.ingestion.resolvePendingParent(
          await authz(t, 'canonical.source_sync'),
          { child: hs('501'), parent: hs('502'), observedAt: new Date() },
          ingestMeta(),
        ),
      ).resolves.toBe('applied');
      expect(await parentOf(c, t, childId)).toMatchObject({
        parent_company_id: parentId,
        parent_company_origin: 'source_provided',
      });
      expect((await issuesOf(c, t)).map((i) => i.state)).toEqual(['resolved']);
      // In-run second pass: the child read before its parent in one run.
      const late = await observeCompany(c, t, '511', { parent: '512' });
      expect(late.unresolvedParent).toEqual(hs('512'));
      const lateParent = (await observeCompany(c, t, '512')).entityId!;
      await c.ingestion.resolvePendingParent(
        await authz(t, 'canonical.source_sync'),
        { child: hs('511'), parent: hs('512'), observedAt: new Date() },
        ingestMeta(),
      );
      expect(await parent(t, late.entityId!)).toBe(lateParent);
    });

    it('explicit clear unparents (history old → NULL); an absent value, a tombstone of child or parent and inactivity change nothing', async () => {
      const t = await c.tenant('hclear', 1001);
      const [p, k] = await chain(c, t, ['521', '522']);
      // Absent parent value (unmapped / not authoritative): unchanged.
      await observeCompany(c, t, '522', { name: 'Renamed' });
      expect(await parent(t, k!)).toBe(p);
      // Parent and child tombstoned: no cascade, no unparenting.
      for (const id of ['521', '522']) {
        await c.ingestion.ingest(
          await authz(t, 'canonical.source_sync'),
          { kind: 'company', presence: 'absent', ref: hs(id), observedAt: new Date() },
          ingestMeta(),
        );
      }
      expect(await parent(t, k!)).toBe(p);
      expect(await historyOf(c, t, 'company', k)).toHaveLength(1);
      // Restored and explicitly cleared: unparented, with history.
      await observeCompany(c, t, '522', { parent: null });
      expect(await parentOf(c, t, k!)).toMatchObject({
        parent_company_id: null,
        parent_company_origin: 'source_provided',
      });
      const history = await historyOf(c, t, 'company', k);
      expect(history.map((h) => [h.old_value, h.new_value])).toEqual([
        [null, p],
        [p, null],
      ]);
      // A clear of an account without a parent changes nothing.
      await observeCompany(c, t, '522', { parent: null });
      expect(await historyOf(c, t, 'company', k)).toHaveLength(2);
    });

    it('retiring a parent reference (an accepted full read no longer returned it) never unparents its children (VM11)', async () => {
      const t = await c.tenant('hretire', 1001);
      const [p, k] = await chain(c, t, ['531', '532']);
      const runId = randomUUID();
      await c.sql(
        `INSERT INTO tenant_sync_checkpoints (tenant_id, id, system, kind, mode, status, correlation_id, completed_at)
         VALUES ($1, $2, 'hubspot', 'company', 'backfill', 'completed', gen_random_uuid(), now())`,
        [t.tenantId, runId],
      );
      const actx = await authz(t, 'canonical.source_sync');
      const retired = await db().transaction(t, (tx) =>
        c.ingestion.retireAbsentWithin(
          actx,
          tx,
          {
            system: 'hubspot',
            objectType: 'companies',
            seen: new Set(['532']),
            observedAt: new Date(Date.now() + 1_000),
            runId,
          },
          ingestMeta(),
        ),
      );
      expect(retired).toBe(1);
      expect(await parentOf(c, t, k!)).toMatchObject({
        parent_company_id: p,
        parent_company_origin: 'source_provided',
      });
      expect(await historyOf(c, t, 'company', k)).toHaveLength(1);
    });

    it('below canonical 0.3 a stated parent is not written (disabled), and no issue is recorded', async () => {
      const t = await c.tenant('hsrc02', 1001);
      // M10F: new tenants adopt 0.6; step back to 0.5 first.
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.5',
        expectedCurrent: '0.6',
      });
      // M10E: new tenants adopt 0.5; rollback goes one MINOR at a time (0.5 → 0.4 first).
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      // M10D: new tenants adopt 0.4; rollback goes one MINOR at a time (0.4 → 0.3 first).
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.3',
        expectedCurrent: '0.4',
      });
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.2',
        expectedCurrent: '0.3',
      });
      const [p] = Object.values(await companies(c, t, ['531']));
      const child = await observeCompany(c, t, '532', { parent: '531' });
      expect(await parent(t, child.entityId!)).toBeNull();
      expect(p).toBeDefined();
      expect(await issuesOf(c, t)).toEqual([]);
      expect(await structureChangesOf(c, t, 'company')).toEqual([]);
    });
  });

  describe('V6: operator entry (canonical.human_entry)', () => {
    it('set / clear / release: one audit event each, origin human until released; source disagreement recorded, never applied', async () => {
      const t = await c.tenant('hop', 1001);
      const ids = await companies(c, t, ['601', '602', '603']);
      const [child, p1, p2] = [ids['601']!, ids['602']!, ids['603']!];
      const before = (await auditOf(c, t)).length;
      await expect(set(t, { companyId: child, parentId: p1, reason: REASON })).resolves.toEqual({
        companyId: child,
        parentId: p1,
        origin: 'human',
        changed: true,
      });
      let events = await auditOf(c, t);
      expect(events).toHaveLength(before + 1);
      expect(events.at(-1)).toMatchObject({
        action: 'account.hierarchy.set',
        outcome: 'allowed',
        capability: 'canonical.human_entry',
        actor_kind: 'operator',
        target_kind: 'account_hierarchy',
        target_ref: child,
        details: { reason: REASON, changed: true, parentChanged: true, parentId: p1 },
      });
      // A disagreeing source value is not applied: an open issue names both ids.
      await observeCompany(c, t, '601', { parent: '603' });
      expect(await parentOf(c, t, child)).toMatchObject({
        parent_company_id: p1,
        parent_company_origin: 'human',
      });
      expect(await issuesOf(c, t)).toEqual([
        expect.objectContaining({
          kind: 'hierarchy_human_override_disagrees',
          state: 'open',
          canonical_ids: [child, p1, p2].sort(),
          external_refs: ['hubspot:companies:601', 'hubspot:companies:603'],
        }),
      ]);
      // An explicit source clear is a disagreement too; an agreeing value changes nothing.
      await observeCompany(c, t, '601', { parent: null });
      await observeCompany(c, t, '601', { parent: '602' });
      expect(await parent(t, child)).toBe(p1);
      // Release: origin back to the source, parent unchanged, one event.
      await expect(release(t, child)).resolves.toEqual({
        companyId: child,
        parentId: p1,
        origin: 'source_provided',
        changed: true,
      });
      events = await auditOf(c, t);
      expect(events).toHaveLength(before + 2);
      expect(events.at(-1)).toMatchObject({
        action: 'account.hierarchy.release',
        outcome: 'allowed',
        details: { reason: REASON, changed: true },
      });
      // The next authoritative observation applies normally and resolves the disagreement.
      await observeCompany(c, t, '601', { parent: '603' });
      expect(await parentOf(c, t, child)).toMatchObject({
        parent_company_id: p2,
        parent_company_origin: 'source_provided',
      });
      expect((await issuesOf(c, t)).map((i) => [i.kind, i.state])).toEqual([
        ['hierarchy_human_override_disagrees', 'resolved'],
      ]);
      // Clear: sticky too (an explicit human clear).
      await expect(clear(t, child)).resolves.toMatchObject({
        parentId: null,
        origin: 'human',
        changed: true,
      });
      await observeCompany(c, t, '601', { parent: '602' });
      expect(await parentOf(c, t, child)).toMatchObject({
        parent_company_id: null,
        parent_company_origin: 'human',
      });
      expect((await auditOf(c, t)).filter((e) => e.outcome === 'allowed')).toHaveLength(
        events.filter((e) => e.outcome === 'allowed').length + 1,
      );
    });

    it('needs canonical.human_entry: a source-sync actor is denied (audited) and nothing changes', async () => {
      const t = await c.tenant('hopdeny', 1001);
      const ids = await companies(c, t, ['611', '612']);
      await expect(
        authz(
          t,
          'canonical.human_entry',
          sourceSyncActor(`run:${randomUUID()}`),
          'account.hierarchy.set',
        ),
      ).rejects.toMatchObject({ name: 'AuthorizationDeniedError' });
      await expect(
        authz(
          t,
          'data.account_structure.read',
          sourceSyncActor(`run:${randomUUID()}`),
          'account_structure.read',
        ),
      ).rejects.toMatchObject({ name: 'AuthorizationDeniedError' });
      expect(
        (await auditOf(c, t))
          .filter((e) => e.outcome === 'denied')
          .map((e) => [e.action, e.reason_code]),
      ).toEqual([
        ['account.hierarchy.set', 'capability_not_granted'],
        ['account_structure.read', 'capability_not_granted'],
      ]);
      // A context of another capability is not accepted by the operator method.
      await expect(
        writer().set((await authz(t, 'canonical.source_sync')) as never, {
          companyId: ids['611']!,
          parentId: ids['612']!,
          reason: REASON,
        }),
      ).rejects.toThrow();
      expect(await parent(t, ids['611']!)).toBeNull();
      expect(await auditOf(c, t, 'account.hierarchy.set')).toHaveLength(1);
    });

    it('a reason code is required (no free text); a cycle, a merged or unknown company is refused and audited as failed', async () => {
      const t = await c.tenant('hopbad', 1001);
      const ids = await companies(c, t, ['621', '622', '623', '624']);
      for (const reason of ['', 'Free text reason', 'person@school.example', 'x']) {
        await expect(
          set(t, { companyId: ids['621']!, parentId: ids['622']!, reason }),
        ).rejects.toMatchObject({ code: 'validation_failed' });
      }
      await set(t, { companyId: ids['621']!, parentId: ids['622']!, reason: REASON });
      await expect(
        set(t, { companyId: ids['622']!, parentId: ids['621']!, reason: REASON }),
      ).rejects.toMatchObject({ code: 'hierarchy_cycle' });
      await merge(t, '624', ['623']);
      await expect(
        set(t, { companyId: ids['622']!, parentId: ids['623']!, reason: REASON }),
      ).rejects.toMatchObject({ code: 'hierarchy_parent_merged' });
      await expect(
        set(t, { companyId: ids['623']!, parentId: ids['622']!, reason: REASON }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(
        set(t, { companyId: randomUUID(), parentId: ids['622']!, reason: REASON }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      const events = await auditOf(c, t, 'account.hierarchy.set');
      expect(events.map((e) => [e.outcome, e.reason_code])).toEqual([
        ['failed', 'validation_failed'],
        ['failed', 'validation_failed'],
        ['failed', 'validation_failed'],
        ['failed', 'validation_failed'],
        ['allowed', null],
        ['failed', 'hierarchy_cycle'],
        ['failed', 'hierarchy_parent_merged'],
        ['failed', 'validation_failed'],
        ['failed', 'validation_failed'],
      ]);
      // Audit details carry codes and identifiers only, never the rejected reason text.
      expect(JSON.stringify(events)).not.toMatch(/Free text|school\.example/);
      expect(await parent(t, ids['622']!)).toBeNull();
    });
  });

  describe('V7: value history and change records', () => {
    it('every parent change writes a full history row and one relationship_changed record with its provenance', async () => {
      const t = await c.tenant('hhist', 1001);
      const ids = await companies(c, t, ['701', '702', '703']);
      const [child, p1, p2] = [ids['701']!, ids['702']!, ids['703']!];
      await observeCompany(c, t, '701', { parent: '702' });
      await observeCompany(c, t, '701', { parent: '703' });
      await set(t, { companyId: child, parentId: p1, reason: REASON });
      await release(t, child);
      await observeCompany(c, t, '701', { parent: null });
      const history = await historyOf(c, t, 'company', child);
      expect(
        history.map((h) => [h.values_recorded, h.old_value, h.new_value, h.actor_kind]),
      ).toEqual([
        [true, null, p1, 'source_sync'],
        [true, p1, p2, 'source_sync'],
        [true, p2, p1, 'operator'],
        [true, p1, null, 'source_sync'],
      ]);
      const changes = await structureChangesOf(c, t, 'company', child);
      expect(
        changes.map((ch) => [
          ch.change_type,
          ch.changed_fields,
          `${ch.source_system}:${ch.source_object_type}:${ch.source_record_id}`,
          ch.cause,
          ch.origin,
          ch.canonical_version,
        ]),
      ).toEqual([
        [
          'relationship_changed',
          ['parentCompanyId'],
          'hubspot:companies:701',
          'webhook',
          'source_provided',
          '0.6',
        ],
        [
          'relationship_changed',
          ['parentCompanyId'],
          'hubspot:companies:701',
          'webhook',
          'source_provided',
          '0.6',
        ],
        [
          'relationship_changed',
          ['parentCompanyId'],
          `import:operator_entry:${child}`,
          'human',
          'human',
          '0.6',
        ],
        [
          'relationship_changed',
          ['parentCompanyOrigin'],
          `import:operator_entry:${child}`,
          'human',
          'human',
          '0.6',
        ],
        [
          'relationship_changed',
          ['parentCompanyId'],
          'hubspot:companies:701',
          'webhook',
          'source_provided',
          '0.6',
        ],
      ]);
      // Every history row points at a parent change record of this account.
      const parentChanges = changes.filter((ch) => ch.changed_fields.includes('parentCompanyId'));
      expect(history.map((h) => h.change_id)).toEqual(parentChanges.map((ch) => ch.id));
      // History parity holds.
      const report = await integrity().verify(t);
      expect(report.findings.filter((f) => f.check === 'hierarchy_history_parity')).toEqual([]);
    });
  });

  describe('n1: history parity with rows tied at one instant', () => {
    it('two parent rows recorded in one transaction never make a false parity finding; a real drift still does', async () => {
      const t = await c.tenant('hparity', 1001);
      const ids = await companies(c, t, ['871', '872']);
      const child = (await observeCompany(c, t, '873', { parent: '871' })).entityId!;
      // A tied earlier row (same recorded_at, the highest id, the stale value), as one
      // transaction writing two parent changes would leave it.
      await c.sql(
        `INSERT INTO tenant_value_history (tenant_id, id, entity_kind, entity_id, entity_key, field, values_recorded,
                old_value, new_value, effective_at, recorded_at, change_id, retention_class, policy_version,
                actor_kind, actor_id, actor_assurance)
         SELECT tenant_id, 'ffffffff-ffff-4fff-bfff-ffffffffffff'::uuid, entity_kind, entity_id, entity_key, field,
                values_recorded, NULL, to_jsonb($3::text), effective_at, recorded_at, change_id, retention_class,
                policy_version, actor_kind, actor_id, actor_assurance
           FROM tenant_value_history
          WHERE tenant_id = $1 AND entity_kind = 'company' AND entity_id = $2 AND field = 'parent_company_id'`,
        [t.tenantId, child, ids['872']],
      );
      const checks = async () =>
        (await integrity().verify(t)).findings.filter(
          (f) => f.check === 'hierarchy_history_parity',
        );
      expect(await checks()).toEqual([]);
      // A parent changed without history is still found.
      await c.sql(`UPDATE companies SET parent_company_id = $3 WHERE tenant_id = $1 AND id = $2`, [
        t.tenantId,
        child,
        ids['872'],
      ]);
      await c.sql(
        `UPDATE companies SET parent_company_id = NULL WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, child],
      );
      expect((await checks()).length).toBe(1);
    });
  });

  describe('V8: company merge participant (hierarchy)', () => {
    it("children move to the survivor; a survivor without a parent inherits the loser's; the loser keeps its lineage", async () => {
      const t = await c.tenant('hmerge', 1001);
      const ids = await companies(c, t, ['801', '802', '803']);
      const [top, loser, survivor] = [ids['801']!, ids['802']!, ids['803']!];
      await observeCompany(c, t, '802', { parent: '801' });
      const k1 = (await observeCompany(c, t, '804', { parent: '802' })).entityId!;
      const k2 = (
        await set(t, {
          companyId: (await companies(c, t, ['805']))['805']!,
          parentId: loser,
          reason: REASON,
        })
      ).companyId;
      await merge(t, '803', ['802']);
      expect(await parentOf(c, t, k1)).toMatchObject({
        parent_company_id: survivor,
        parent_company_origin: 'source_provided',
      });
      // The origin is kept (a human parent stays human).
      expect(await parentOf(c, t, k2)).toMatchObject({
        parent_company_id: survivor,
        parent_company_origin: 'human',
      });
      expect(await parent(t, survivor)).toBe(top);
      expect(await parentOf(c, t, loser)).toMatchObject({
        parent_company_id: top,
        record_state: 'merged',
      });
      // Each move: a change record with the merge's provenance and a history row.
      for (const [id, from, to] of [
        [k1, loser, survivor],
        [k2, loser, survivor],
        [survivor, null, top],
      ] as const) {
        const last = (await structureChangesOf(c, t, 'company', id)).at(-1)!;
        expect(last).toMatchObject({
          change_type: 'relationship_changed',
          changed_fields: ['parentCompanyId'],
          source_record_id: '802',
          cause: 'webhook',
        });
        expect((await historyOf(c, t, 'company', id)).at(-1)).toMatchObject({
          old_value: from,
          new_value: to,
          values_recorded: true,
        });
      }
      const report = await integrity().verify(t);
      expect(report.findings.filter((f) => f.check.startsWith('hierarchy_'))).toEqual([]);
    });

    it('a survivor under the loser takes the loser parent; differing parents: the survivor keeps its own', async () => {
      const t = await c.tenant('hmerge2', 1001);
      const ids = await companies(c, t, ['811']);
      const loser = (await observeCompany(c, t, '812', { parent: '811' })).entityId!;
      const survivor = (await observeCompany(c, t, '813', { parent: '812' })).entityId!;
      const sibling = (await observeCompany(c, t, '814', { parent: '812' })).entityId!;
      await merge(t, '813', ['812']);
      expect(await parent(t, survivor)).toBe(ids['811']);
      expect(await parent(t, sibling)).toBe(survivor);
      expect(await parent(t, loser)).toBe(ids['811']);

      const more = await companies(c, t, ['821', '822']);
      const l2 = (await observeCompany(c, t, '823', { parent: '821' })).entityId!;
      const s2 = (await observeCompany(c, t, '824', { parent: '822' })).entityId!;
      await merge(t, '824', ['823']);
      expect(await parent(t, s2)).toBe(more['822']);
      expect(await parent(t, l2)).toBe(more['821']);
      expect(await issuesOf(c, t)).toEqual([]);
    });

    it("a parentless survivor an operator cleared keeps its sticky clear: no inheritance, the loser's parent recorded as a disagreement (review m1)", async () => {
      const t = await c.tenant('hmergeclr', 1001);
      const ids = await companies(c, t, ['851', '852', '853']);
      const [top, otherTop, survivor] = [ids['851']!, ids['852']!, ids['853']!];
      await set(t, { companyId: survivor, parentId: otherTop, reason: REASON });
      await clear(t, survivor);
      expect(await parentOf(c, t, survivor)).toMatchObject({
        parent_company_id: null,
        parent_company_origin: 'human',
      });
      await observeCompany(c, t, '854', { parent: '851' });
      await merge(t, '853', ['854']);
      expect(await parentOf(c, t, survivor)).toMatchObject({
        parent_company_id: null,
        parent_company_origin: 'human',
      });
      expect(
        (await issuesOf(c, t)).map((i) => [i.kind, i.state, [...i.canonical_ids].sort()]),
      ).toEqual([['hierarchy_human_override_disagrees', 'open', [survivor, top].sort()]]);
    });

    it('a source parent write in flight onto the loser and the merge serialise: no live child keeps a merged parent (review M5)', async () => {
      const t = await c.tenant('hmergerace', 1001);
      const ids = await companies(c, t, ['861', '862', '863']);
      const [loser, survivor, child] = [ids['861']!, ids['862']!, ids['863']!];
      const sactx = await authz(t, 'canonical.source_sync');
      let releaseT1!: () => void;
      const gate = new Promise<void>((r) => (releaseT1 = r));
      let written!: () => void;
      const parentWritten = new Promise<void>((r) => (written = r));
      // T1: the ingestion-side parent write C -> loser, held open after the write.
      const t1 = db().transaction(
        t,
        async (tx) => {
          const out = await writer().observeParent(sactx, tx, {
            childId: child,
            childRef: hs('863'),
            parent: { kind: 'set', ref: hs('861') },
            effectiveAt: new Date(),
            provenance: {
              source: hs('863'),
              cause: 'webhook',
              adapter: 'hubspot',
              adapterVersion: '1',
              correlationId: randomUUID(),
            },
          });
          written();
          await gate;
          return out;
        },
        { timeoutMs: 20_000 },
      );
      await parentWritten;
      // T2: merge the loser into the survivor while T1 is uncommitted.
      const t2 = merge(t, '862', ['861']);
      // Wait (bounded) until the merge queues on the tenant's hierarchy lock.
      const end = Date.now() + 5_000;
      while (Date.now() < end) {
        const [waiting] = await c.sql<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        if (waiting!.n > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      releaseT1();
      expect(await t1).toBe('applied');
      await t2;
      expect(await parentOf(c, t, loser)).toMatchObject({ record_state: 'merged' });
      expect(await parent(t, child)).toBe(survivor);
      const report = await integrity().verify(t);
      expect(report.findings.map((f) => f.check)).not.toContain('hierarchy_parent_merged');
    });

    it('merge never refused: a cycle unparents the child with an issue; a depth overshoot is recorded, not refused', async () => {
      const t = await c.tenant('hmerge3', 1001);
      // loser ← child ← survivor: merging the loser into the survivor would make child its own ancestor.
      const loser = (await companies(c, t, ['831']))['831']!;
      const child = (await observeCompany(c, t, '832', { parent: '831' })).entityId!;
      const survivor = (await observeCompany(c, t, '833', { parent: '832' })).entityId!;
      await merge(t, '833', ['831']);
      expect(await parent(t, child)).toBeNull();
      expect(await parent(t, survivor)).toBe(child);
      expect(await parentOf(c, t, loser)).toMatchObject({ record_state: 'merged' });
      expect(await issuesOf(c, t)).toEqual([
        expect.objectContaining({
          kind: 'hierarchy_cycle_refused',
          state: 'open',
          canonical_ids: [child, survivor].sort(),
        }),
      ]);
      expect((await historyOf(c, t, 'company', child)).at(-1)).toMatchObject({
        old_value: loser,
        new_value: null,
      });

      // Depth: a survivor at depth 9 takes a loser child with a child of its own.
      const deep = await chain(
        c,
        t,
        Array.from({ length: 10 }, (_, i) => `84${i}`),
      );
      const l = (await companies(c, t, ['850']))['850']!;
      const k = (await observeCompany(c, t, '851', { parent: '850' })).entityId!;
      const kk = (await observeCompany(c, t, '852', { parent: '851' })).entityId!;
      await merge(t, '849', ['850']);
      expect(await parent(t, k)).toBe(deep[9]);
      expect(await parent(t, kk)).toBe(k);
      expect(await issuesOf(c, t, 'hierarchy_depth_exceeded')).toEqual([
        expect.objectContaining({ state: 'open', canonical_ids: [k, deep[9]!].sort() }),
      ]);
      expect(await parentOf(c, t, l)).toMatchObject({ record_state: 'merged' });
      const report = await integrity().verify(t);
      expect(report.findings).toContainEqual({ check: 'hierarchy_depth_exceeded', ref: kk });
      expect(report.findings.filter((f) => f.check === 'hierarchy_parent_merged')).toEqual([]);
    });
  });

  describe('V12: hierarchy read model', () => {
    it('ancestors, root, depth and descendants; one audited read per call; the view agrees', async () => {
      const t = await c.tenant('hread', 1001);
      const ids = await chain(c, t, ['1201', '1202', '1203']);
      const side = (await observeCompany(c, t, '1204', { parent: '1201' })).entityId!;
      const actx = await authz(t, 'data.account_structure.read');
      const view = await readModel().hierarchy(actx, { companyId: ids[2]! });
      expect(view).toMatchObject({
        companyId: ids[2],
        recordState: 'active',
        parentId: ids[1],
        origin: 'source_provided',
        ancestors: [ids[2], ids[1], ids[0]],
        rootId: ids[0],
        depth: 2,
        truncated: false,
      });
      expect(view.descendants).toBeUndefined();
      const root = await readModel().hierarchy(await authz(t, 'data.account_structure.read'), {
        companyId: ids[0]!,
        descendants: true,
      });
      expect(root).toMatchObject({ depth: 0, rootId: ids[0], descendantsTruncated: false });
      expect(
        root
          .descendants!.map((d) => [d.id, d.parentId, d.depth])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual(
        [
          [ids[1], ids[0], 1],
          [ids[2], ids[1], 2],
          [side, ids[0], 1],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
      const reads = await auditOf(c, t, 'account_structure.read');
      expect(reads.map((e) => [e.outcome, e.capability, e.target_kind, e.target_ref])).toEqual([
        ['allowed', 'data.account_structure.read', 'account_hierarchy', ids[2]],
        ['allowed', 'data.account_structure.read', 'account_hierarchy', ids[0]],
      ]);
      expect(reads[1]!.details).toEqual({ ancestors: 0, truncated: false, descendants: 3 });
      const paths = await asApp(
        c,
        t,
        async (db) =>
          (
            await db.query<{ company_id: string; root_company_id: string; depth: number }>(
              `SELECT company_id::text, root_company_id::text, depth FROM account_hierarchy_paths
              WHERE company_id = ANY($1::uuid[]) ORDER BY depth, company_id`,
              [[...ids, side]],
            )
          ).rows,
      );
      expect(paths.find((p) => p.company_id === ids[2])).toEqual({
        company_id: ids[2],
        root_company_id: ids[0],
        depth: 2,
      });
      await asApp(c, t, async (db) => {
        await expect(
          db.query(`INSERT INTO account_hierarchy_paths (tenant_id) VALUES ($1)`, [t.tenantId]),
        ).rejects.toThrow(/permission denied|cannot insert into view/);
      });
    });

    it('a tree deeper than the bound is truncated and flagged, never looped', async () => {
      const t = await c.tenant('hreadcut', 1001);
      const ids = await chain(c, t, ['1211', '1212', '1213', '1214', '1215']); // depth 4
      const narrow = new AccountStructureReadModel(db(), store(), readModel().audit, {
        canonical: { hierarchyMaxDepth: 2 },
      } as AppConfig);
      const leaf = await narrow.hierarchy(await authz(t, 'data.account_structure.read'), {
        companyId: ids[4]!,
      });
      expect(leaf.truncated).toBe(true);
      expect(leaf.ancestors.length).toBeLessThan(ids.length);
      expect(leaf.ancestors[0]).toBe(ids[4]);
      const root = await narrow.hierarchy(await authz(t, 'data.account_structure.read'), {
        companyId: ids[0]!,
        descendants: true,
      });
      expect(root.descendantsTruncated).toBe(true);
      expect(root.descendants!.length).toBeLessThan(ids.length - 1);
    });

    it('an unknown company is refused (failed, audited)', async () => {
      const t = await c.tenant('hreadbad', 1001);
      await expect(
        readModel().hierarchy(await authz(t, 'data.account_structure.read'), {
          companyId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect((await auditOf(c, t, 'account_structure.read')).map((e) => e.outcome)).toEqual([
        'failed',
      ]);
    });
  });

  describe('V11: cross-tenant hierarchy is impossible (raw SQL as the app role)', () => {
    it('tenant A cannot see, parent onto or forge an index row for tenant B', async () => {
      const a = await c.tenant('hxa', 1001);
      const b = await c.tenant('hxb', 2002);
      const ca = (await companies(c, a, ['1101']))['1101']!;
      const cb = (await companies(c, b, ['1101']))['1101']!;
      await asApp(c, a, async (db) => {
        expect((await db.query(`SELECT 1 FROM companies WHERE id = $1`, [cb])).rowCount).toBe(0);
        await expect(
          db.query(`UPDATE companies SET parent_company_id = $2 WHERE id = $1`, [ca, cb]),
        ).rejects.toMatchObject({ code: '23503' });
      });
      await asApp(c, a, async (db) => {
        // A row inserted for tenant A naming a tenant-B parent: no matching (tenant_id, id).
        await expect(insertCompanyRow(db, a, cb)).rejects.toMatchObject({ code: '23503' });
      });
      await asApp(c, a, async (db) => {
        // Writing tenant B's row from tenant A: row-level security hides it (nothing updated).
        const r = await db.query(`UPDATE companies SET parent_company_id = NULL WHERE id = $1`, [
          cb,
        ]);
        expect(r.rowCount).toBe(0);
      });
      await asApp(c, a, async (db) => {
        await expect(
          db.query(
            `INSERT INTO tenant_entity_index (tenant_id, kind, entity_id) VALUES ($1, 'company', gen_random_uuid())`,
            [a.tenantId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      });
      expect(await parent(a, ca)).toBeNull();
    });
  });

  describe('V15: the 0.3 gate (hierarchy)', () => {
    it('below 0.3 operator writes are refused (audited); a rollback keeps parents readable; re-adoption accepts writes', async () => {
      const t = await c.tenant('hgate', 1001);
      const ids = await companies(c, t, ['1501', '1502', '1503']);
      await set(t, { companyId: ids['1501']!, parentId: ids['1502']!, reason: REASON });
      // M10F: new tenants adopt 0.6; step back to 0.5 first.
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.5',
        expectedCurrent: '0.6',
      });
      // M10E: new tenants adopt 0.5; rollback goes one MINOR at a time (0.5 → 0.4 first).
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      // M10D: new tenants adopt 0.4; rollback goes one MINOR at a time (0.4 → 0.3 first).
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.3',
        expectedCurrent: '0.4',
      });
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.2',
        expectedCurrent: '0.3',
      });
      // Existing parents stay (never unparented on rollback) and stay readable.
      expect(await parent(t, ids['1501']!)).toBe(ids['1502']);
      await expect(
        readModel().hierarchy(await authz(t, 'data.account_structure.read'), {
          companyId: ids['1501']!,
        }),
      ).resolves.toMatchObject({ parentId: ids['1502'], depth: 1 });
      await expect(
        set(t, { companyId: ids['1503']!, parentId: ids['1502']!, reason: REASON }),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      await expect(clear(t, ids['1501']!)).rejects.toMatchObject({
        code: 'canonical_version_too_low',
      });
      await expect(release(t, ids['1501']!)).rejects.toMatchObject({
        code: 'canonical_version_too_low',
      });
      expect(
        (await auditOf(c, t))
          .filter((e) => e.action.startsWith('account.hierarchy.') && e.outcome === 'failed')
          .map((e) => [e.action, e.reason_code]),
      ).toEqual([
        ['account.hierarchy.set', 'canonical_version_too_low'],
        ['account.hierarchy.clear', 'canonical_version_too_low'],
        ['account.hierarchy.release', 'canonical_version_too_low'],
      ]);
      expect(await parent(t, ids['1501']!)).toBe(ids['1502']);
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.3',
        expectedCurrent: '0.2',
      });
      // M10D: back to the current version (0.4), where the authority version was published.
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.3',
      });
      // M10E: back to the current version (0.5), where the authority version was published.
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.5',
        expectedCurrent: '0.4',
      });
      await expect(
        set(t, { companyId: ids['1503']!, parentId: ids['1502']!, reason: REASON }),
      ).resolves.toMatchObject({ changed: true });
    });
  });
  describe('Q22: physical deletes under ON DELETE RESTRICT', () => {
    it('a parent or an affiliated company and an affiliated person cannot be physically deleted; an unreferenced company still can', async () => {
      const t = await c.tenant('hdelete', 1001);
      const [parentId, childId, freeId, personId] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await db().transaction(t, async (tx) => {
        for (const id of [parentId, childId, freeId])
          await c.h.companies.save(tx, company(t.tenantId, id));
        await c.h.persons.save(tx, person(t.tenantId, personId));
      });
      await c.sql(`UPDATE companies SET parent_company_id = $2 WHERE tenant_id = $3 AND id = $1`, [
        childId,
        parentId,
        t.tenantId,
      ]);
      const remove = (kind: 'company' | 'person', id: string) =>
        db().transaction(t, (tx) =>
          kind === 'company'
            ? c.h.companies.delete(tx, id as never)
            : c.h.persons.delete(tx, id as never),
        );
      // M2 repository path: the RESTRICT refusal surfaces as InvalidReferenceError (as for a company with people).
      await expect(remove('company', parentId)).rejects.toBeInstanceOf(InvalidReferenceError);
      await c.sql(
        `INSERT INTO tenant_person_affiliations (tenant_id, person_id, company_id, origin) VALUES ($1, $2, $3, 'human')`,
        [t.tenantId, personId, freeId],
      );
      await expect(remove('company', freeId)).rejects.toBeInstanceOf(InvalidReferenceError);
      // The person repository does not translate the refusal (raw foreign-key error; recorded, Q22).
      await expect(remove('person', personId)).rejects.toThrow();
      await expect(remove('company', childId)).resolves.toBeUndefined();
      const left = await c.sql<{ id: string }>(
        `SELECT id::text FROM companies WHERE tenant_id = $1 ORDER BY id`,
        [t.tenantId],
      );
      expect(left.map((r) => r.id).sort()).toEqual([parentId, freeId].sort());
      expect(
        await c.sql(`SELECT 1 FROM persons WHERE tenant_id = $1 AND id = $2`, [
          t.tenantId,
          personId,
        ]),
      ).toHaveLength(1);
    });
  });
});
