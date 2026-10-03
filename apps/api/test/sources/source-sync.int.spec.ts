import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EligibilityService } from '../../src/modules/products';
import { tenantClient, type TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeSugar } from '../support/fake-sugar';
import {
  runSync,
  sourcesServices,
  sugarTenant,
  sugarTestMapping,
  withoutTerms,
  type SourcesFixture,
} from '../support/sources';

/**
 * M8 end to end: the production Sugar adapter against the deterministic fake,
 * through the generic pipeline into the existing single writers, on real
 * PostgreSQL with the app role and forced RLS. Mapping, holding stages, date
 * pair and time zone are TEST configuration only (no live Sugar, no Juniper
 * business decision encoded).
 */
describe('source synchronisation (Sugar adapter, fake Sugar)', () => {
  let c: ContextHarness;
  let fake: FakeSugar;

  beforeAll(async () => {
    c = await startContextHarness();
    fake = await new FakeSugar().start();
  });
  afterAll(async () => {
    await fake?.stop();
    await c?.close();
  });

  const lines = (t: TenantContext) =>
    c.sql<{
      source_record_id: string;
      state: string;
      starts_at: Date | null;
      ends_at: Date | null;
      quantity: number | null;
      record_state: string;
      company_id: string;
      product_key: string;
    }>(
      `SELECT source_record_id, state, starts_at, ends_at, quantity, record_state, company_id::text, product_key
         FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY source_record_id`,
      [t.tenantId],
    );
  const companyOf = async (t: TenantContext, accountId: string) =>
    (
      await c.sql<{ company_id: string }>(
        `SELECT company_id::text FROM company_external_refs
          WHERE tenant_id = $1 AND system = 'sugar' AND object_type = 'Accounts' AND external_id = $2`,
        [t.tenantId, accountId],
      )
    )[0]?.company_id;
  const run = (t: TenantContext, id: string) =>
    c.sql<{
      status: string;
      last_error_code: string | null;
      quality: Record<string, unknown>;
      mapping_version: number;
    }>(
      'SELECT status, last_error_code, quality, mapping_version FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND id = $2',
      [t.tenantId, id],
    );

  describe('a full run over the discovery and companion fixtures', () => {
    let f: SourcesFixture;
    let result: Awaited<ReturnType<typeof runSync>>;

    beforeAll(async () => {
      f = await sugarTenant(c, fake, { prefix: 'srcfull' });
      result = await runSync(c, f, 'full');
    });

    it('completes with stable quality counts (codes and counts only)', () => {
      expect([result.status, result.errorCode, result.quality]).toEqual([
        'completed',
        undefined,
        expect.anything(),
      ]);
      expect(result.quality).toMatchObject({
        filtered_out: 4, // 06 Pending Cancellation, 07 blank stage, C1 Closed Lost, open pipeline
        orphan_product_reference: 1, // 10
        missing_product_reference: 1, // 12
        missing_account_reference: 1, // account-less, no opportunity
        orphan_account_reference: 1, // account-less, orphan opportunity (09)
        invalid_period: 1, // 13
        duplicate_external_id: 1, // 11
        ownership_gap: 2, // accounts of 10 and 12
      });
      expect(JSON.stringify(result.quality)).not.toMatch(/Fixture|Account \d|Line/);
    });

    it('ingests one line per holding RLI with state unknown (never active from Closed Won)', async () => {
      const rows = await lines(f.ctx);
      expect(rows.map((r) => r.source_record_id)).toEqual([
        'FIX-RLI-001',
        'FIX-RLI-010',
        'FIX-RLI-011',
        'FIX-RLI-012',
        'FIX-RLI-020',
        'FIX-RLI-021',
        'FIX-RLI-030',
        'FIX-RLI-031',
        'FIX-RLI-040',
        'FIX-RLI-041',
        'FIX-RLI-070',
        'FIX-RLI-090',
        'FIX-RLI-110',
        'FIX-RLI-130',
        'FIX-RLI-140',
        'FIX-RLI-903',
      ]);
      expect(rows.every((r) => r.state === 'unknown')).toBe(true);
      const normal = rows.find((r) => r.source_record_id === 'FIX-RLI-001')!;
      expect(normal.starts_at).toEqual(new Date('2026-01-01T00:00:00Z'));
      expect(normal.ends_at).toEqual(new Date('2027-01-01T00:00:00Z'));
      expect(normal.product_key).toBe('fix-prod-001');
      // 13: the holding is kept with empty terms.
      const conflicting = rows.find((r) => r.source_record_id === 'FIX-RLI-110')!;
      expect([conflicting.starts_at, conflicting.ends_at]).toEqual([null, null]);
      // 03: quantities per line.
      expect(rows.filter((r) => r.product_key === 'fix-prod-020').map((r) => r.quantity)).toEqual([
        5, 3,
      ]);
      // Fallback account through the opportunity.
      expect(rows.find((r) => r.source_record_id === 'FIX-RLI-903')!.company_id).toBe(
        await companyOf(f.ctx, 'FIX-ACC-016'),
      );
    });

    it('records per-account ownership gaps for orphan and missing products', async () => {
      const gaps = await c.sql<{ source_record_id: string; reason: string; company_id: string }>(
        'SELECT source_record_id, reason, company_id::text FROM tenant_ownership_gaps WHERE tenant_id = $1 ORDER BY source_record_id',
        [f.ctx.tenantId],
      );
      expect(gaps).toEqual([
        {
          source_record_id: 'FIX-RLI-080',
          reason: 'orphan_product_reference',
          company_id: (await companyOf(f.ctx, 'FIX-ACC-009'))!,
        },
        {
          source_record_id: 'FIX-RLI-100',
          reason: 'missing_product_reference',
          company_id: (await companyOf(f.ctx, 'FIX-ACC-011'))!,
        },
      ]);
    });

    it('provenance names the connection, object, record, mapping version, source time and run', async () => {
      const rows = await c.sql<Record<string, unknown>>(
        `SELECT source_system, source_object_type, source_record_id, source_connection_id::text,
                mapping_version, cause, checkpoint_id::text, source_updated_at, adapter, adapter_version
           FROM tenant_context_changes
          WHERE tenant_id = $1 AND entity_kind = 'subscription' AND source_record_id = 'FIX-RLI-001'`,
        [f.ctx.tenantId],
      );
      expect(rows).toEqual([
        {
          source_system: 'sugar',
          source_object_type: 'RevenueLineItems',
          source_record_id: 'FIX-RLI-001',
          source_connection_id: f.connectionId,
          mapping_version: 2,
          cause: 'backfill',
          checkpoint_id: result.runId,
          source_updated_at: new Date('2025-12-20T00:00:00Z'),
          adapter: 'sugar',
          adapter_version: 'sugar-m8.0',
        },
      ]);
      // Account references written through the M6 writer carry the same linkage.
      const accounts = await c.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM tenant_context_changes
          WHERE tenant_id = $1 AND entity_kind = 'company' AND source_connection_id = $2 AND mapping_version = 2`,
        [f.ctx.tenantId, f.connectionId],
      );
      expect(accounts[0]!.n).toBeGreaterThanOrEqual(16);
    });

    it('establishes coverage; a gapped account is ownership_incomplete, never whitespace', async () => {
      const eligibility = c.app.get(EligibilityService);
      expect(await c.h.subscriptionReads.coverage(f.ctx)).toMatchObject({ coverage: 'known' });
      const gapped = await companyOf(f.ctx, 'FIX-ACC-009');
      const report = await eligibility.evaluate(f.ctx, gapped!, 'fix-prod-001');
      expect(report.ownership).toBe('unknown');
      expect(report.checks.find((ch) => ch.check === 'ownership_coverage')).toMatchObject({
        outcome: 'unknown',
        reason: 'ownership_incomplete',
      });
      const ws = await eligibility.whitespace(f.ctx, gapped!);
      expect(ws.categories.eligible_whitespace).toEqual([]);
      // An ungapped account: the line in state unknown keeps its product unknown;
      // products with no line are not owned (coverage known).
      const covered = await companyOf(f.ctx, 'FIX-ACC-001');
      const own = await eligibility.evaluate(f.ctx, covered!, 'fix-prod-001');
      expect(own.ownership).toBe('unknown');
      const other = await eligibility.evaluate(f.ctx, covered!, 'fix-prod-140');
      expect(other.ownership).toBe('not_owned');
    });

    it('a second full run is idempotent', async () => {
      const again = await runSync(c, f, 'full');
      expect(again.status).toBe('completed');
      const [row] = await run(f.ctx, again.runId);
      expect(row!.quality).toMatchObject({ filtered_out: 4 });
      const changes = await c.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM tenant_context_changes WHERE tenant_id = $1 AND checkpoint_id = $2`,
        [f.ctx.tenantId, again.runId],
      );
      expect(changes[0]!.n).toBe(0);
    });
  });

  describe('deletes, incremental runs and watermarks', () => {
    it('only the full-run tombstone pass deletes; incremental runs never infer deletion', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'srctomb' });
        expect((await runSync(c, f, 'full')).status).toBe('completed');
        local.remove('RevenueLineItems', 'FIX-RLI-140');
        const inc = await runSync(c, f, 'incremental');
        expect(inc.status).toBe('completed');
        expect(
          (await lines(f.ctx)).find((r) => r.source_record_id === 'FIX-RLI-140')!.record_state,
        ).toBe('active');
        const full = await runSync(c, f, 'full');
        expect(full.status).toBe('completed');
        expect(full.quality).toMatchObject({ tombstoned: 1 });
        expect(
          (await lines(f.ctx)).find((r) => r.source_record_id === 'FIX-RLI-140')!.record_state,
        ).toBe('deleted');
      } finally {
        await local.stop();
      }
    });

    it('an incremental run reads from the watermark minus the overlap and advances it only on success', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'srcinc', overlapMinutes: 10 });
        const first = await runSync(c, f, 'full');
        const [{ high_watermark: wm1 }] = (await c.sql<{ high_watermark: Date }>(
          'SELECT high_watermark FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND id = $2',
          [f.ctx.tenantId, first.runId],
        )) as [{ high_watermark: Date }];
        // A late commit: modified 5 minutes before the last boundary, written after it.
        const late = new Date(wm1.getTime() - 5 * 60_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, '+00:00');
        local.upsert('RevenueLineItems', {
          ...local.data.get('RevenueLineItems')!.find((r) => r.id === 'FIX-RLI-001')!,
          id: 'FIX-RLI-950',
          date_modified: late,
        });
        const inc = await runSync(c, f, 'incremental');
        expect(inc.status).toBe('completed');
        expect((await lines(f.ctx)).some((r) => r.source_record_id === 'FIX-RLI-950')).toBe(true);
        const window = local
          .apiRequests()
          .filter(
            (r) => r.path === '/RevenueLineItems' && r.query.has('filter[0][date_modified][$gte]'),
          )
          .at(-1)!;
        // Second precision on the wire (LIVE: Sugar's date_modified precision); the
        // window start is floored, so the read only ever starts earlier, never later.
        expect(new Date(window.query.get('filter[0][date_modified][$gte]')!).getTime()).toBe(
          Math.floor((wm1.getTime() - 10 * 60_000) / 1000) * 1000,
        );
        // A failed incremental run does not move the watermark.
        local.fail({ match: /^GET \/RevenueLineItems$/, status: 400, times: 1 });
        const failed = await runSync(c, f, 'incremental');
        expect(failed).toMatchObject({ status: 'failed', errorCode: 'source_bad_request' });
        const [{ high_watermark: wm3 }] = (await c.sql<{ high_watermark: Date | null }>(
          'SELECT high_watermark FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND id = $2',
          [f.ctx.tenantId, failed.runId],
        )) as [{ high_watermark: Date | null }];
        expect(wm3).toBeNull();
      } finally {
        await local.stop();
      }
    });
  });

  describe('runs that cannot prove completeness leave coverage and gaps unchanged', () => {
    it('unstable read: a record modified during the read fails the run (unstable_read)', async () => {
      const local = await new FakeSugar({ generatedLines: 450 }).start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'srcunst' });
        local.afterListPage = (module, offset) => {
          if (module === 'RevenueLineItems' && offset === 0) {
            local.upsert('RevenueLineItems', {
              id: 'FIX-RLI-G00000',
              date_modified: new Date(Date.now() + 60_000)
                .toISOString()
                .replace(/\.\d{3}Z$/, '+00:00'),
            });
          }
        };
        const r = await runSync(c, f, 'full');
        expect(r).toMatchObject({ status: 'failed', errorCode: 'unstable_read' });
        expect(await c.h.subscriptionReads.coverage(f.ctx)).toMatchObject({ coverage: 'unknown' });
        expect(
          (
            await c.sql<{ n: number }>(
              'SELECT count(*)::int AS n FROM tenant_ownership_gaps WHERE tenant_id = $1',
              [f.ctx.tenantId],
            )
          )[0]!.n,
        ).toBe(0);
        // A retry on a stable source passes.
        local.afterListPage = undefined;
        expect((await runSync(c, f, 'full')).status).toBe('completed');
        expect(await c.h.subscriptionReads.coverage(f.ctx)).toMatchObject({ coverage: 'known' });
      } finally {
        await local.stop();
      }
    });

    it('a source without counting cannot certify a full read', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'srcnocount', stopAfter: 'connection' });
        const s = sourcesServices(c);
        const conn = await s.connections.get(f.ctx, f.connectionId);
        await s.connections.configure(f.ctx, {
          kind: 'sugar',
          label: conn.label,
          config: { ...conn.config, countSupported: false },
          credentialName: 'sugar_api',
        });
        await s.snapshots.capture(f.ctx, f.connectionId, 'test');
        await s.mappings.publish(f.ctx, f.connectionId, withoutTerms(sugarTestMapping()), {
          expectedBaseVersion: 0,
          actor: 'test',
        });
        await s.authority.publish(
          f.ctx,
          {
            facts: {
              account_profile: null,
              person_profile: null,
              subscription_lines: f.connectionId,
              subscription_state: null,
              subscription_terms: null,
            },
          },
          { expectedBaseVersion: 1, actor: 'test' },
        );
        expect(await runSync(c, f, 'full')).toMatchObject({
          status: 'failed',
          errorCode: 'unstable_read',
        });
        expect((await lines(f.ctx)).length).toBe(0);
      } finally {
        await local.stop();
      }
    });

    it('schema drift on the mapped surface refuses the run before any write', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'srcdrift' });
        local.removeField('RevenueLineItems', 'service_end_date');
        const r = await runSync(c, f, 'full');
        expect(r).toMatchObject({ status: 'failed', errorCode: 'schema_drift' });
        expect(r.quality).toMatchObject({
          drift: ['mapped_field_removed:RevenueLineItems.service_end_date'],
        });
        expect((await lines(f.ctx)).length).toBe(0);
        expect(await c.h.subscriptionReads.coverage(f.ctx)).toMatchObject({ coverage: 'unknown' });
        // Publishing against the old snapshot is stale once a new one is captured.
        const s = sourcesServices(c);
        const before = await s.snapshots.latest(f.ctx, f.connectionId);
        await s.snapshots.capture(f.ctx, f.connectionId, 'test');
        const report = await s.mappings.validate(
          f.ctx,
          f.connectionId,
          sugarTestMapping(),
          before!.hash,
        );
        expect(report.errors.map((e) => e.code)).toContain('schema_snapshot_stale');
      } finally {
        await local.stop();
      }
    });

    it('an unmodelled catalogue product fails the run after the catalogue phase, before any line', async () => {
      const local = await new FakeSugar({ includeUnmodelledProduct: true }).start();
      try {
        const f = await sugarTenant(c, local, {
          prefix: 'srcunmod',
          mapping: sugarTestMapping((d) => {
            d.productReferences!.ignored = [];
          }),
        });
        const modelBefore = await c.h.catalogue.show(f.ctx);
        const r = await runSync(c, f, 'full');
        expect(r).toMatchObject({ status: 'failed', errorCode: 'unmodelled_product_reference' });
        expect(r.quality).toMatchObject({
          unmodelled_product_reference: 1,
          unmodelledProducts: ['FIX-PROD-900'],
        });
        expect((await lines(f.ctx)).length).toBe(0);
        expect(await c.h.subscriptionReads.coverage(f.ctx)).toMatchObject({ coverage: 'unknown' });
        // The connector never changes the product model.
        expect((await c.h.catalogue.show(f.ctx))!.version).toBe(modelBefore!.version);
      } finally {
        await local.stop();
      }
    });
  });

  describe('governance gates', () => {
    it('a connection becomes authoritative for lines only with confirmed holdings', async () => {
      const s = sourcesServices(c);
      const f = await sugarTenant(c, fake, {
        prefix: 'srcgate',
        stopAfter: 'mapping',
        mapping: sugarTestMapping((d) => {
          const lines = d.objects.find((o) => o.entity === 'subscription')!;
          delete lines.holdingFilter;
        }),
      });
      await expect(
        s.authority.publish(
          f.ctx,
          {
            facts: {
              account_profile: null,
              person_profile: null,
              subscription_lines: f.connectionId,
              subscription_state: null,
              subscription_terms: null,
            },
          },
          { expectedBaseVersion: 1, actor: 'test' },
        ),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'holding_filter_required' })],
      });
      // Without lines authority the connection cannot run a line sync.
      await expect(
        s.sync.start(f.ctx, f.connectionId, 'full', { enqueue: false }),
      ).rejects.toMatchObject({
        code: 'not_authoritative_for_lines',
      });
    });

    it('state and terms cannot come from another source than the lines (no cross-source matching)', async () => {
      const s = sourcesServices(c);
      const f = await sugarTenant(c, fake, { prefix: 'srccross', stopAfter: 'mapping' });
      await expect(
        s.authority.publish(
          f.ctx,
          {
            facts: {
              account_profile: null,
              person_profile: null,
              subscription_lines: f.importConnectionId,
              subscription_state: f.connectionId,
              subscription_terms: null,
            },
          },
          { expectedBaseVersion: 1, actor: 'test' },
        ),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'cross_source_unsupported' })],
      });
    });

    it('mapping and authority publication require the base version and refuse a stale one', async () => {
      const s = sourcesServices(c);
      const f = await sugarTenant(c, fake, { prefix: 'srcconc' });
      await expect(
        s.mappings.publish(f.ctx, f.connectionId, sugarTestMapping(), { actor: 'test' } as never),
      ).rejects.toMatchObject({ code: 'base_version_required' });
      // A loads v2, B publishes v3, A's publish from v2 is refused.
      await s.mappings.publish(f.ctx, f.connectionId, sugarTestMapping(), {
        expectedBaseVersion: 2,
        actor: 'b',
      });
      await expect(
        s.mappings.publish(f.ctx, f.connectionId, sugarTestMapping(), {
          expectedBaseVersion: 2,
          actor: 'a',
        }),
      ).rejects.toMatchObject({ code: 'concurrent_publish' });
      // Racing publishers from the same base: exactly one wins.
      const racers = await Promise.allSettled(
        [1, 2, 3, 4].map((i) =>
          s.mappings.publish(f.ctx, f.connectionId, sugarTestMapping(), {
            expectedBaseVersion: 3,
            actor: `r${i}`,
          }),
        ),
      );
      expect(racers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        racers
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .every((r) => (r.reason as { code: string }).code === 'concurrent_publish'),
      ).toBe(true);
      expect((await s.mappings.show(f.ctx, f.connectionId))!.version).toBe(4);
      await expect(
        s.authority.publish(f.ctx, (await s.authority.show(f.ctx))!.document, {
          actor: 'x',
        } as never),
      ).rejects.toMatchObject({ code: 'base_version_required' });
      await expect(
        s.authority.publish(f.ctx, (await s.authority.show(f.ctx))!.document, {
          expectedBaseVersion: 1,
          actor: 'x',
        }),
      ).rejects.toMatchObject({ code: 'concurrent_publish' });
    });

    it('published mapping versions, snapshots and authority versions are immutable', async () => {
      const f = await sugarTenant(c, fake, { prefix: 'srcimm' });
      for (const sql of [
        `UPDATE tenant_source_mapping_versions SET published_by = 'x' WHERE tenant_id = '${f.ctx.tenantId}'`,
        `DELETE FROM tenant_source_mapping_versions WHERE tenant_id = '${f.ctx.tenantId}'`,
        `UPDATE tenant_source_schema_snapshots SET captured_by = 'x' WHERE tenant_id = '${f.ctx.tenantId}'`,
        `DELETE FROM tenant_source_authority_versions WHERE tenant_id = '${f.ctx.tenantId}'`,
      ]) {
        await expect(c.sql(sql)).rejects.toThrow(/is not allowed/);
      }
    });

    it("a tenant's connection resolves only its own secret, whatever the credential name", async () => {
      const s = sourcesServices(c);
      // Tenant A: same name, secret configured (sugarTenant sets it).
      const a = await sugarTenant(c, fake, { prefix: 'srcseca', stopAfter: 'connection' });
      expect((await s.connections.test(a.ctx, a.connectionId)).code).toBe('ok');
      // Tenant B: same credential name, no secret of its own → its key is
      // tenant.<b>.sugar.sugar_api, never A's; the test fails closed.
      const b = await c.h.registry.provision({
        slug: `srcsecb${Date.now().toString(36)}`,
        name: 'B',
      });
      const ctxB = await c.h.contexts.forTenantId(b.id);
      const connB = await s.connections.configure(ctxB, {
        kind: 'sugar',
        label: 'Sugar',
        config: { instanceUrl: fake.url, apiVersion: fake.version, modules: ['Accounts'] },
        credentialName: 'sugar_api',
      });
      const grantsBefore = fake.passwordGrants;
      expect(await s.connections.test(ctxB, connB.id)).toEqual({ ok: false, code: 'auth_failed' });
      expect(fake.passwordGrants).toBe(grantsBefore);
      const refs = await c.sql<{ secret_key: string }>(
        `SELECT secret_key FROM tenant_credential_refs WHERE tenant_id = $1 AND system = 'sugar'`,
        [b.id],
      );
      expect(refs).toEqual([{ secret_key: `tenant.${b.slug}.sugar.sugar_api` }]);
      // Tenant B cannot see tenant A's connection.
      expect((await s.connections.list(ctxB)).map((x) => x.kind).sort()).toEqual([
        'import',
        'sugar',
      ]);
      expect((await s.connections.list(ctxB)).some((x) => x.id === a.connectionId)).toBe(false);
    });

    it('connection config refuses secret-like keys', async () => {
      const s = sourcesServices(c);
      const f = await sugarTenant(c, fake, { prefix: 'srcsecret', stopAfter: 'connection' });
      await expect(
        s.connections.configure(f.ctx, {
          kind: 'sugar',
          label: 'Sugar',
          config: {
            instanceUrl: fake.url,
            apiVersion: fake.version,
            modules: ['Accounts'],
            password: 'x',
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid_config' });
    });
  });

  describe('reliability: interruption, resume and partial loads', () => {
    it('a transient failure mid-read leaves the run running; executing again resumes and completes idempotently', async () => {
      const local = await new FakeSugar({ generatedLines: 450 }).start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'srcresume' });
        const s = sourcesServices(c);
        const started = await s.sync.start(f.ctx, f.connectionId, 'full', { enqueue: false });
        // Page 2 of the lines keeps failing with 503 beyond the adapter's retries.
        local.fail({
          match: /^GET \/RevenueLineItems$/,
          status: 503,
          times: 10,
          when: (r) => r.query.get('offset') === '200',
        });
        await expect(s.sync.execute(f.ctx, started.runId)).rejects.toMatchObject({
          kind: 'server_error',
        });
        expect((await run(f.ctx, started.runId))[0]!.status).toBe('running');
        local.faults.length = 0;
        const resumed = await s.sync.execute(f.ctx, started.runId);
        expect(resumed.status).toBe('completed');
        expect((await lines(f.ctx)).length).toBe(16 + 450);
        // Every line was created exactly once despite the re-read.
        const created = await c.sql<{ n: number }>(
          `SELECT count(*)::int AS n FROM tenant_context_changes
            WHERE tenant_id = $1 AND entity_kind = 'subscription' AND change_type = 'created'`,
          [f.ctx.tenantId],
        );
        expect(created[0]!.n).toBe(16 + 450);
      } finally {
        await local.stop();
      }
    });

    it('a permanent failure mid-run fails it without tombstones and without changing coverage or gaps', async () => {
      const local = await new FakeSugar({ generatedLines: 450 }).start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'srcpartial' });
        expect((await runSync(c, f, 'full')).status).toBe('completed');
        const gapsBefore = await c.sql(
          'SELECT * FROM tenant_ownership_gaps WHERE tenant_id = $1 ORDER BY source_record_id',
          [f.ctx.tenantId],
        );
        local.remove('RevenueLineItems', 'FIX-RLI-140');
        local.fail({
          match: /^GET \/RevenueLineItems$/,
          status: 400,
          when: (r) => r.query.get('offset') === '200',
        });
        const failed = await runSync(c, f, 'full');
        expect(failed).toMatchObject({ status: 'failed', errorCode: 'source_bad_request' });
        expect(
          (await lines(f.ctx)).find((r) => r.source_record_id === 'FIX-RLI-140')!.record_state,
        ).toBe('active');
        expect(
          await c.sql(
            'SELECT * FROM tenant_ownership_gaps WHERE tenant_id = $1 ORDER BY source_record_id',
            [f.ctx.tenantId],
          ),
        ).toEqual(gapsBefore);
        // Coverage still rests on the earlier completed run (a failed run never establishes it).
        expect(await c.h.subscriptionReads.coverage(f.ctx)).toMatchObject({ coverage: 'known' });
      } finally {
        await local.stop();
      }
    });

    it('a mapped field disappearing mid-run fails the run as schema drift (nothing reinterpreted)', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'srcmiddrift' });
        local.droppedFields.add('service_start_date');
        const r = await runSync(c, f, 'full');
        expect(r).toMatchObject({ status: 'failed', errorCode: 'schema_drift' });
        expect(await c.h.subscriptionReads.coverage(f.ctx)).toMatchObject({ coverage: 'unknown' });
      } finally {
        await local.stop();
      }
    });

    it('a kind without a registered adapter cannot be configured or synchronised', async () => {
      const s = sourcesServices(c);
      const f = await sugarTenant(c, fake, { prefix: 'srcnoadapter', stopAfter: 'connection' });
      await expect(
        s.connections.configure(f.ctx, { kind: 'gainsight_cs', label: 'GS', config: {} }),
      ).rejects.toMatchObject({ code: 'adapter_not_registered' });
      await expect(
        s.connections.configure(f.ctx, { kind: 'hubspot', label: 'HS', config: {} }),
      ).rejects.toMatchObject({ code: 'kind_not_configurable' });
      // A connection of such a kind (created outside the service) cannot start a run.
      const [{ id }] = (await c.sql<{ id: string }>(
        `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, status, mapping_mode)
         VALUES ($1, gen_random_uuid(), 'gainsight_cs', 'GS', 'enabled', 'versioned') RETURNING id::text`,
        [f.ctx.tenantId],
      )) as [{ id: string }];
      await expect(s.sync.start(f.ctx, id, 'full', { enqueue: false })).rejects.toMatchObject({
        code: 'adapter_not_registered',
      });
    });
  });

  describe('tenant isolation of the new tables', () => {
    it("tenant B cannot read or reference tenant A's connections, snapshots, mappings, authority or gaps", async () => {
      const a = await sugarTenant(c, fake, { prefix: 'srcisoa' });
      expect((await runSync(c, a, 'full')).status).toBe('completed');
      const b = await sugarTenant(c, fake, { prefix: 'srcisob', stopAfter: 'connection' });
      const counts = await c.h.db.transaction(b.ctx, async (tx) => {
        const db = tenantClient(tx);
        return {
          connections: await db.tenantSourceConnection.count({ where: { id: a.connectionId } }),
          snapshots: await db.tenantSourceSchemaSnapshot.count({
            where: { connectionId: a.connectionId },
          }),
          mappings: await db.tenantSourceMappingVersion.count({
            where: { connectionId: a.connectionId },
          }),
          authority: await db.tenantSourceAuthorityVersion.count({
            where: { tenantId: a.ctx.tenantId },
          }),
          gaps: await db.tenantOwnershipGap.count({ where: { connectionId: a.connectionId } }),
          runs: await db.tenantSyncCheckpoint.count({
            where: { sourceConnectionId: a.connectionId },
          }),
        };
      });
      expect(counts).toEqual({
        connections: 0,
        snapshots: 0,
        mappings: 0,
        authority: 0,
        gaps: 0,
        runs: 0,
      });
      // Writing A's rows from B's transaction is refused by RLS …
      await expect(
        c.h.db.transaction(b.ctx, (tx) =>
          tenantClient(tx).tenantOwnershipGap.create({
            data: {
              tenantId: a.ctx.tenantId,
              connectionId: a.connectionId,
              sourceObjectType: 'RevenueLineItems',
              sourceRecordId: 'X',
              companyId: '00000000-0000-4000-8000-000000000000',
              reason: 'orphan_product_reference',
              checkpointId: '00000000-0000-4000-8000-000000000000',
            },
          }),
        ),
      ).rejects.toThrow();
      // … and B's own rows cannot point at A's connection (composite tenant FK).
      await expect(
        c.h.db.transaction(b.ctx, (tx) =>
          tenantClient(tx).tenantSourceAuthorityVersion.create({
            data: {
              tenantId: b.ctx.tenantId,
              version: 2,
              baseVersion: 1,
              subscriptionLinesConnectionId: a.connectionId,
              contentHash: 'a'.repeat(64),
              publishedBy: 'test',
            },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('worker processing', () => {
    it('a run started with enqueue is processed by the worker (lip-sources)', async () => {
      const s = sourcesServices(c);
      const f = await sugarTenant(c, fake, { prefix: 'srcworker' });
      const started = await s.sync.start(f.ctx, f.connectionId, 'full');
      await c.until(
        async () => (await run(f.ctx, started.runId))[0]?.status === 'completed',
        30_000,
        'source run',
      );
      // A second start while the first is active would not start another run.
      expect((await lines(f.ctx)).length).toBe(16);
    });
  });
});
