import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MappingDocument } from '../../src/modules/domain';
import { IntegrityVerificationService } from '../../src/modules/governance';
import type { TenantContext } from '../../src/modules/tenancy';
import { advisoryLockKey } from '../../src/modules/tenancy/infrastructure/tenant-database';
import { CHAIN_LOCK_SCOPE } from '../../src/modules/tenancy/security/audit-trail';
import { appSession } from '../support/account-structure';
import { CHARGEBEE_CREDENTIAL, chargebeeSecretEnv } from '../support/chargebee';
import { startContextHarness, type ContextHarness } from '../support/context';
import {
  defaultDocument,
  enableExtension,
  publishExtension,
  recordsOf,
  services,
  sourceProvenance,
} from '../support/extension';
import { FAKE_CHARGEBEE_API_KEY, FakeChargebee } from '../support/fake-chargebee';
import { FakeSugar } from '../support/fake-sugar';
import {
  acknowledgementsFor,
  runProfile,
  sourcesServices,
  sugarTenant,
  type SourcesFixture,
} from '../support/sources';
import { authz } from '../support/security';

/**
 * M10D hardening #83 (Q14, ADR 0030 addendum): a custom object is source-fed
 * by ONE connection. Two connections of one tenant (Sugar and Chargebee, both
 * against their deterministic fakes) publish mappings that source the same
 * custom object, through the real `SourceMappingsService`, on real PostgreSQL
 * as the app role.
 *
 * The race is made deterministic with a barrier that both publications reach
 * only AFTER their own Q14 validation ran: a separate app-role session holds
 * the tenant's audit-chain advisory lock, which every publication takes when it
 * writes its `mapping.publish` audit event. Both publications therefore read
 * "no other owner" before either commits — exactly the window tech debt #83
 * described. Releasing the barrier lets them commit; exactly one may succeed.
 */
describe('M10D hardening #83: single-owner custom objects under concurrent publication', () => {
  let c: ContextHarness;
  let sugar: FakeSugar;
  let chargebee: FakeChargebee;

  beforeAll(async () => {
    c = await startContextHarness();
    sugar = await new FakeSugar().start();
    chargebee = await new FakeChargebee().start();
  });
  afterAll(async () => {
    await sugar?.stop();
    await chargebee?.stop();
    await c?.close();
  });

  /** The default TEST registry plus `gadget`, a second parent-optional custom object. */
  const registryDocument = () => {
    const doc = defaultDocument() as { objects: Record<string, unknown>[] };
    doc.objects.push({
      key: 'gadget',
      display_name: 'Gadget',
      description: 'Synthetic test object without a parent',
      parent: { kind: 'account', required: false },
      sensitivity: 'internal',
      categories: ['operational'],
      allowed_uses: ['display', 'analytics'],
    });
    return doc;
  };

  /** A mapping of only custom objects: each [source object, custom object key], by id. */
  const customOnly = (entries: readonly (readonly [string, string])[]): MappingDocument => ({
    objects: entries.map(([source, key]) => ({
      source,
      entity: `custom_object:${key}`,
      identity: { field: 'id' },
      relationships: [],
      fields: [],
    })),
  });

  interface TwoConnections {
    readonly ctx: TenantContext;
    readonly sugar: SourcesFixture;
    readonly chargebee: SourcesFixture;
  }

  /** One tenant with a Sugar and a Chargebee connection (snapshots, covering profiles), extension on. */
  async function twoConnections(prefix: string): Promise<TwoConnections> {
    const s = sourcesServices(c);
    const sf = await sugarTenant(c, sugar, { prefix, stopAfter: 'snapshot' });
    const ctx = sf.ctx;
    await c.h.credentials.register(
      await authz(ctx, 'config.integration'),
      'chargebee',
      CHARGEBEE_CREDENTIAL,
    );
    process.env[chargebeeSecretEnv(ctx.tenantSlug)] = FAKE_CHARGEBEE_API_KEY;
    const cb = await s.connections.configure(await authz(ctx, 'config.source.connection'), {
      kind: 'chargebee',
      label: 'Chargebee (fake)',
      config: {
        site: 'synthetic-test',
        endpoint: chargebee.url,
        maxRetries: 2,
        // TEST values only: no production default.
        sync: { overlapMinutes: 10 },
        profile: { maxRows: 1000 },
      },
      credentialName: CHARGEBEE_CREDENTIAL,
    });
    await s.connections.setStatus(await authz(ctx, 'config.source.connection'), cb.id, 'enabled');
    await s.snapshots.capture(await authz(ctx, 'config.source.schema'), cb.id);
    const cf: SourcesFixture = {
      ctx,
      connectionId: cb.id,
      importConnectionId: sf.importConnectionId,
    };
    for (const [fixture, objects] of [
      [sf, ['Opportunities', 'RevenueLineItems']],
      [cf, ['Customers', 'Items']],
    ] as const) {
      const run = await runProfile(c, fixture, objects);
      if (run.status !== 'completed') throw new Error(`profile ${run.status}: ${run.errorCode}`);
    }
    await enableExtension(c, ctx);
    await publishExtension(c, ctx, registryDocument());
    return { ctx, sugar: sf, chargebee: cf };
  }

  /** Validates (outside the race), then returns a publish thunk with the required acknowledgements. */
  async function prepare(f: SourcesFixture, doc: MappingDocument, base = 0) {
    const s = sourcesServices(c);
    const report = await s.mappings.validate(f.ctx, f.connectionId, doc);
    const acknowledgements = acknowledgementsFor(report);
    const blocking = report.errors.filter(
      (e) => e.code !== 'finding_unacknowledged' && e.code !== 'profile_low_coverage',
    );
    expect(blocking, `validation of ${f.connectionId}`).toEqual([]);
    return async () =>
      s.mappings.publish(await authz(f.ctx, 'config.mapping.publish'), f.connectionId, doc, {
        expectedBaseVersion: base,
        acknowledgements,
      });
  }

  /** Which connections' PUBLISHED mappings source `custom_object:<key>` (read through the lifecycle). */
  const sourcedBy = async (t: TenantContext, key: string) =>
    (
      await c.sql<{ connection_id: string }>(
        `SELECT DISTINCT v.connection_id::text
           FROM tenant_source_mapping_versions v
           JOIN tenant_source_mapping_states st
             ON st.tenant_id = v.tenant_id AND st.connection_id = v.connection_id AND st.version = v.version
          CROSS JOIN LATERAL jsonb_array_elements(v.document -> 'objects') o
          WHERE v.tenant_id = $1 AND st.state = 'published' AND o ->> 'entity' = $2
          ORDER BY 1`,
        [t.tenantId, `custom_object:${key}`],
      )
    ).map((r) => r.connection_id);

  /**
   * The backends waiting on a lock held by one of `pids` (this test's own
   * sessions: the barrier, or a session already waiting behind it), each with
   * the lock type it waits on and the backends blocking it (review #110 n1:
   * scoped to the test's sessions, not every ungranted lock in the cluster).
   */
  const waitersOf = (pids: readonly number[]) =>
    c.sql<{ pid: number; locktype: string; blocked_by: number[] }>(
      `SELECT DISTINCT pid, locktype, pg_blocking_pids(pid) AS blocked_by FROM pg_locks
        WHERE NOT granted AND pg_blocking_pids(pid) && $1::int[] ORDER BY pid`,
      [pids],
    );
  /**
   * How many backends wait, directly or transitively, behind `pids` (e.g. the
   * race loser waits on the winner's uncommitted owner row while the winner
   * waits on the barrier).
   */
  const waiting = async (pids: readonly number[]) =>
    Number(
      (
        await c.sql<{ n: string }>(
          `WITH RECURSIVE w (pid) AS (
             SELECT unnest($1::int[])
             UNION
             SELECT l.pid FROM pg_locks l JOIN w ON w.pid = ANY (pg_blocking_pids(l.pid))
              WHERE NOT l.granted)
           SELECT count(*)::text AS n FROM w WHERE pid <> ALL ($1::int[])`,
          [pids],
        )
      )[0]!.n,
    );
  const backendPid = async (session: { query: (q: string) => Promise<{ rows: unknown[] }> }) =>
    ((await session.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid;

  /**
   * Runs the publications concurrently behind the audit-chain barrier: both
   * pass validation, then wait; the barrier is released once both wait.
   */
  async function race(t: TenantContext, publications: (() => Promise<unknown>)[]) {
    const barrier = await appSession(c, t);
    const barrierPid = await backendPid(barrier);
    const pending: Promise<unknown>[] = [];
    try {
      await barrier.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [
        advisoryLockKey(t.tenantId, CHAIN_LOCK_SCOPE, 'head').toString(),
      ]);
      for (const p of publications) pending.push(p());
      await c.until(
        async () => (await waiting([barrierPid])) >= publications.length,
        30_000,
        'both wait',
      );
      await barrier.query('COMMIT');
    } finally {
      await barrier.query('ROLLBACK').catch(() => undefined);
      await barrier.end();
    }
    return Promise.allSettled(pending);
  }

  const refusalCodes = (r: PromiseSettledResult<unknown>) =>
    r.status === 'rejected'
      ? {
          code: (r.reason as { code?: string }).code,
          issues: ((r.reason as { issues?: { code: string }[] }).issues ?? []).map((i) => i.code),
        }
      : undefined;

  it('control (sequential): the second connection is refused custom_object_owned_by_other_connection', async () => {
    const f = await twoConnections('h83seq');
    await (
      await prepare(f.sugar, customOnly([['Opportunities', 'asset']]))
    )();
    const s = sourcesServices(c);
    const doc = customOnly([['Customers', 'asset']]);
    const report = await s.mappings.validate(f.ctx, f.chargebee.connectionId, doc);
    expect(report.errors.map((e) => e.code)).toContain('custom_object_owned_by_other_connection');
    expect(await sourcedBy(f.ctx, 'asset')).toEqual([f.sugar.connectionId]);
  });

  it('race: two connections publishing the same custom object concurrently — exactly one succeeds, the other gets the Q14 refusal', async () => {
    const f = await twoConnections('h83race');
    const publications = [
      await prepare(f.sugar, customOnly([['Opportunities', 'asset']])),
      await prepare(f.chargebee, customOnly([['Customers', 'asset']])),
    ];
    const results = await race(f.ctx, publications);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect({ fulfilled: fulfilled.length, rejected: rejected.length }).toEqual({
      fulfilled: 1,
      rejected: 1,
    });
    expect(refusalCodes(rejected[0]!)).toEqual({
      code: 'mapping_invalid',
      issues: ['custom_object_owned_by_other_connection'],
    });
    // Exactly one connection's published mapping sources the object.
    expect(await sourcedBy(f.ctx, 'asset')).toHaveLength(1);
  });

  /** The tenant's owner rows (tech debt #83). */
  const ownersOf = (t: TenantContext) =>
    c.sql<{
      object_key: string;
      connection_id: string | null;
      mapping_version: number | null;
      released: boolean;
    }>(
      `SELECT object_key, connection_id::text, mapping_version, released_at IS NOT NULL AS released
         FROM tenant_custom_object_owners WHERE tenant_id = $1 ORDER BY object_key`,
      [t.tenantId],
    );
  const auditDetails = async (t: TenantContext, action: string) =>
    (
      await c.sql<{ details: Record<string, unknown> }>(
        `SELECT details FROM tenant_audit_events
          WHERE tenant_id = $1 AND action = $2 AND outcome = 'allowed' ORDER BY seq`,
        [t.tenantId, action],
      )
    ).map((r) => r.details);

  it('owner rows follow the published mappings: claimed at publish, released by retiring the published version or by a version that no longer maps the object; audited', async () => {
    const f = await twoConnections('h83life');
    const s = sourcesServices(c);
    const sugarId = f.sugar.connectionId;
    const cbId = f.chargebee.connectionId;
    await (
      await prepare(f.sugar, customOnly([['Opportunities', 'asset']]))
    )();
    expect(await ownersOf(f.ctx)).toEqual([
      { object_key: 'asset', connection_id: sugarId, mapping_version: 1, released: false },
    ]);
    // Retiring a SUPERSEDED version releases nothing; retiring the PUBLISHED one releases.
    await (
      await prepare(f.sugar, customOnly([['Opportunities', 'asset']]), 1)
    )();
    expect((await ownersOf(f.ctx))[0]).toMatchObject({
      connection_id: sugarId,
      mapping_version: 2,
    });
    await s.mappings.retire(
      await authz(f.ctx, 'config.mapping.retire'),
      sugarId,
      1,
      'operator_retired',
    );
    expect((await ownersOf(f.ctx))[0]).toMatchObject({
      connection_id: sugarId,
      mapping_version: 2,
    });
    await s.mappings.retire(
      await authz(f.ctx, 'config.mapping.retire'),
      sugarId,
      2,
      'operator_retired',
    );
    expect(await ownersOf(f.ctx)).toEqual([
      { object_key: 'asset', connection_id: null, mapping_version: null, released: true },
    ]);
    // Released: the other connection may now claim it.
    await (
      await prepare(f.chargebee, customOnly([['Customers', 'asset']]))
    )();
    expect(await ownersOf(f.ctx)).toEqual([
      { object_key: 'asset', connection_id: cbId, mapping_version: 1, released: false },
    ]);
    // A version that maps gadget instead releases asset and claims gadget.
    await (
      await prepare(f.chargebee, customOnly([['Customers', 'gadget']]), 1)
    )();
    expect(await ownersOf(f.ctx)).toEqual([
      { object_key: 'asset', connection_id: null, mapping_version: null, released: true },
      { object_key: 'gadget', connection_id: cbId, mapping_version: 2, released: false },
    ]);
    const publishes = await auditDetails(f.ctx, 'mapping.publish');
    expect(publishes.map((d) => [d.customObjectsClaimed, d.customObjectsReleased])).toEqual([
      [['asset'], undefined],
      [undefined, undefined],
      [['asset'], undefined],
      [['gadget'], ['asset']],
    ]);
    const retires = await auditDetails(f.ctx, 'mapping.retire');
    expect(retires.map((d) => d.customObjectsReleased)).toEqual([undefined, ['asset']]);
  });

  it('no deadlock: two publications claiming two custom objects in opposite document order — one wins both, the other gets the Q14 refusal', async () => {
    const f = await twoConnections('h83order');
    const publications = [
      await prepare(
        f.sugar,
        customOnly([
          ['Opportunities', 'asset'],
          ['RevenueLineItems', 'gadget'],
        ]),
      ),
      await prepare(
        f.chargebee,
        customOnly([
          ['Customers', 'gadget'],
          ['Items', 'asset'],
        ]),
      ),
    ];
    // Barrier at the owner table itself: both publications validate, then wait
    // at their first owner-row write, and are released together.
    const barrier = await appSession(c, f.ctx);
    const barrierPid = await backendPid(barrier);
    const pending: Promise<unknown>[] = [];
    try {
      await barrier.query('LOCK TABLE tenant_custom_object_owners IN SHARE MODE');
      for (const p of publications) pending.push(p());
      await c.until(async () => (await waiting([barrierPid])) >= 2, 30_000, 'both wait');
      await barrier.query('COMMIT');
    } finally {
      await barrier.query('ROLLBACK').catch(() => undefined);
      await barrier.end();
    }
    const results = await Promise.allSettled(pending);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected.map(refusalCodes)).toEqual([
      { code: 'mapping_invalid', issues: ['custom_object_owned_by_other_connection'] },
    ]);
    const winner = results[0]!.status === 'fulfilled' ? f.sugar : f.chargebee;
    expect((await ownersOf(f.ctx)).map((o) => [o.object_key, o.connection_id])).toEqual([
      ['asset', winner.connectionId],
      ['gadget', winner.connectionId],
    ]);
  });

  /**
   * Stale-writer guarantee (review #110 m1; ADR 0030 addendum §5): a source
   * write of the owning connection reads the owner row FOR SHARE, so a release
   * (retire) waits for it, and a write arriving behind an uncommitted release
   * re-reads the released row. Either way no write of the old owner commits
   * after another connection's claim. Each case pauses one transaction at a
   * barrier held by a third app-role session and proves who waits on whom
   * through pg_locks; the outcome order is recorded as the promises settle.
   */
  describe('stale writer: a source write of the owner races retire + another connection’s claim', () => {
    type Settled = { name: string; ok: boolean; value?: unknown; error?: unknown };
    const settle = (name: string, p: Promise<unknown>, order: string[]): Promise<Settled> =>
      p.then(
        (value) => (order.push(name), { name, ok: true, value }),
        (error: unknown) => (order.push(name), { name, ok: false, error }),
      );
    /** A source write of `asset` as `connectionId` through the real CustomRecordWriter (own transaction). */
    const write = async (t: TenantContext, connectionId: string, id: string) => {
      const actx = await authz(t, 'canonical.source_sync');
      return () =>
        services(c).records.observeSource(actx, {
          objectKey: 'asset',
          ref: { system: 'sugar', objectType: 'Opportunities', id },
          presence: 'present',
          values: [],
          observedAt: new Date(),
          provenance: sourceProvenance(id, {
            source: { system: 'sugar', objectType: 'Opportunities', id },
            adapter: 'sugar',
            connectionId,
          }),
        });
    };
    const retireV1 = async (t: TenantContext, connectionId: string) => {
      const actx = await authz(t, 'config.mapping.retire');
      return () => sourcesServices(c).mappings.retire(actx, connectionId, 1, 'operator_retired');
    };
    /** Polls until `done()` or some backend waits on one of `pids`; returns those waiters. */
    const waitFor = async (pids: readonly number[], done: () => boolean, label: string) => {
      let rows: Awaited<ReturnType<typeof waitersOf>> = [];
      await c.until(
        async () => {
          if (done()) return true;
          rows = await waitersOf(pids);
          return rows.length > 0;
        },
        30_000,
        label,
      );
      return done() ? [] : rows;
    };
    const rowWait = (locktype: string) => ['tuple', 'transactionid'].includes(locktype);

    it('writer first: the retire waits for the in-flight owner write (FOR SHARE); the write commits before the release, the other connection claims after both', async () => {
      const f = await twoConnections('h83sw1');
      await (
        await prepare(f.sugar, customOnly([['Opportunities', 'asset']]))
      )();
      const sugarWrite = await write(f.ctx, f.sugar.connectionId, 'SW1-1');
      const retire = await retireV1(f.ctx, f.sugar.connectionId);
      const order: string[] = [];
      const barrier = await appSession(c, f.ctx);
      const barrierPid = await backendPid(barrier);
      const pending: Promise<Settled>[] = [];
      try {
        // Pause the writer at its record insert, AFTER its owner check (owner row held FOR SHARE).
        await barrier.query('LOCK TABLE tenant_custom_records IN SHARE MODE');
        const w = settle('write', sugarWrite(), order);
        const [writer] = await waitFor([barrierPid], () => order.length > 0, 'writer paused');
        expect(order).toEqual([]);
        // The release must wait for the owner's in-flight write.
        const r = settle('retire', retire(), order);
        pending.push(w, r);
        const behindWriter = await waitFor([writer!.pid], () => order.length > 0, 'retire waits');
        expect(order, 'the retire committed while the owner write was in flight').toEqual([]);
        expect(behindWriter).toHaveLength(1);
        expect(behindWriter[0]!.blocked_by).toEqual([writer!.pid]);
        expect(rowWait(behindWriter[0]!.locktype), behindWriter[0]!.locktype).toBe(true);
        await barrier.query('COMMIT');
      } finally {
        await barrier.query('ROLLBACK').catch(() => undefined);
        await barrier.end();
      }
      const [w, r] = await Promise.all(pending);
      expect(w).toMatchObject({ ok: true, value: { status: 'created' } });
      expect(r).toMatchObject({ ok: true });
      expect(order).toEqual(['write', 'retire']);
      // Only now can the other connection claim; the old owner's next write is refused.
      await (
        await prepare(f.chargebee, customOnly([['Customers', 'asset']]))
      )();
      expect((await ownersOf(f.ctx)).map((o) => [o.object_key, o.connection_id])).toEqual([
        ['asset', f.chargebee.connectionId],
      ]);
      expect(await (await write(f.ctx, f.sugar.connectionId, 'SW1-2'))()).toEqual({
        status: 'rejected',
        reason: 'object_not_owned',
      });
      expect(await recordsOf(c, f.ctx)).toHaveLength(1);
    });

    it('release first: a write arriving behind the uncommitted release waits (FOR SHARE), re-reads the released row and is refused object_not_owned; the other connection then claims', async () => {
      const f = await twoConnections('h83sw2');
      await (
        await prepare(f.sugar, customOnly([['Opportunities', 'asset']]))
      )();
      const sugarWrite = await write(f.ctx, f.sugar.connectionId, 'SW2-1');
      const retire = await retireV1(f.ctx, f.sugar.connectionId);
      const order: string[] = [];
      const barrier = await appSession(c, f.ctx);
      const barrierPid = await backendPid(barrier);
      const pending: Promise<Settled>[] = [];
      try {
        // Pause the retire AFTER its release UPDATE, at the audit chain it takes next.
        await barrier.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [
          advisoryLockKey(f.ctx.tenantId, CHAIN_LOCK_SCOPE, 'head').toString(),
        ]);
        const r = settle('retire', retire(), order);
        const [retirer] = await waitFor([barrierPid], () => order.length > 0, 'retire paused');
        expect(order).toEqual([]);
        expect(
          await c.sql(
            `SELECT connection_id::text FROM tenant_custom_object_owners WHERE tenant_id = $1`,
            [f.ctx.tenantId],
          ),
          'the release is not committed yet',
        ).toEqual([{ connection_id: f.sugar.connectionId }]);
        // The owner's write now waits on the uncommitted release.
        const w = settle('write', sugarWrite(), order);
        pending.push(r, w);
        let writer: Awaited<ReturnType<typeof waitersOf>>[number] | undefined;
        await c.until(
          async () => {
            if (order.length > 0) return true;
            writer = (await waitersOf([barrierPid, retirer!.pid])).find(
              (x) => x.pid !== retirer!.pid,
            );
            return writer !== undefined;
          },
          30_000,
          'writer waits',
        );
        expect(order, 'the write finished while the release was uncommitted').toEqual([]);
        expect(writer!.blocked_by, 'the writer waits on the releasing transaction').toEqual([
          retirer!.pid,
        ]);
        expect(rowWait(writer!.locktype), writer!.locktype).toBe(true);
        await barrier.query('COMMIT');
      } finally {
        await barrier.query('ROLLBACK').catch(() => undefined);
        await barrier.end();
      }
      const [r, w] = await Promise.all(pending);
      expect(r).toMatchObject({ ok: true });
      expect(w).toMatchObject({
        ok: true,
        value: { status: 'rejected', reason: 'object_not_owned' },
      });
      expect(order).toEqual(['retire', 'write']);
      await (
        await prepare(f.chargebee, customOnly([['Customers', 'asset']]))
      )();
      expect((await ownersOf(f.ctx)).map((o) => [o.object_key, o.connection_id])).toEqual([
        ['asset', f.chargebee.connectionId],
      ]);
      expect(await recordsOf(c, f.ctx)).toEqual([]);
    });
  });

  it('integrity: custom_object_owner_drift passes on published-mapping parity and reports planted drift both ways (identifiers only, nothing repaired)', async () => {
    const f = await twoConnections('h83int');
    const integrity = c.app.get(IntegrityVerificationService);
    const sugarId = f.sugar.connectionId;
    const cbId = f.chargebee.connectionId;
    await (
      await prepare(f.sugar, customOnly([['Opportunities', 'asset']]))
    )();
    await (
      await prepare(f.sugar, customOnly([['Opportunities', 'asset']]), 1)
    )();
    const drift = (r: { findings: readonly { check: string; ref: string }[] }) =>
      r.findings.filter((x) => x.check === 'custom_object_owner_drift').map((x) => x.ref);
    const clean = await integrity.record(await authz(f.ctx, 'security.integrity.run'));
    expect(Object.keys(clean.checks)).toContain('custom_object_owner_drift');
    expect(drift(clean)).toEqual([]);
    // Plant (owner, test database; replica mode turns the foreign keys and the guard trigger off):
    // sugar's held row points at its SUPERSEDED v1, and chargebee holds gadget with no published mapping.
    await c.sql(
      `SET session_replication_role = replica;
       UPDATE tenant_custom_object_owners SET mapping_version = 1
        WHERE tenant_id = '${f.ctx.tenantId}' AND object_key = 'asset';
       INSERT INTO tenant_custom_object_owners
         (tenant_id, object_key, connection_id, mapping_version, claimed_at, updated_at)
       VALUES ('${f.ctx.tenantId}', 'gadget', '${cbId}', 1, now(), now());
       SET session_replication_role = origin;`,
    );
    const found = await integrity.record(await authz(f.ctx, 'security.integrity.run'));
    expect(found.outcome).toBe('findings');
    expect(drift(found)).toEqual(
      [`held:asset/${sugarId}/v1`, `held:gadget/${cbId}/v1`, `unheld:asset/${sugarId}/v2`].sort(),
    );
    expect(found.checks.custom_object_owner_drift).toBe(3);
    // Nothing repaired.
    expect(
      (await ownersOf(f.ctx)).map((o) => [o.object_key, o.connection_id, o.mapping_version]),
    ).toEqual([
      ['asset', sugarId, 1],
      ['gadget', cbId, 1],
    ]);
  });
});
