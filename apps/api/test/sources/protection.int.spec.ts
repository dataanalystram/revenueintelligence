import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExternalRef, MappingDocument } from '../../src/modules/domain';
import { EligibilityService } from '../../src/modules/products';
import { SubscriptionRunsStore } from '../../src/modules/products/infrastructure/subscription-runs.store';
import type { TenantContext } from '../../src/modules/tenancy';
import { FIXTURE_SALES_STAGES, testReviewedDomain } from '../fixtures/source-mapping';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeSugar, type FakeSugarRecord } from '../support/fake-sugar';
import { genericModel } from '../support/product-models';
import {
  acknowledgementsFor,
  mappingObjects,
  publishWithAcks,
  runProfile,
  runSync,
  sourcesServices,
  sugarTenant,
  sugarTestMapping,
  withSnapshot,
  type SourcesFixture,
} from '../support/sources';

/**
 * M9A record-level safety end to end (ADR 0023): seen-but-rejected
 * protection, reviewed holding-filter domains, structural B guards and
 * structural coverage tiers, on real PostgreSQL with the app role and forced
 * RLS, against the fake Sugar. Every scenario changes exactly one thing.
 */
describe('record-level protection, reviewed domains, guards and coverage tiers', () => {
  let c: ContextHarness;
  let eligibility: EligibilityService;
  let runs: SubscriptionRunsStore;

  beforeAll(async () => {
    c = await startContextHarness();
    eligibility = c.app.get(EligibilityService);
    runs = c.app.get(SubscriptionRunsStore);
  });
  afterAll(async () => {
    await c?.close();
  });

  const line = async (f: SourcesFixture, recordId: string) =>
    (
      await c.sql<{ record_state: string; quantity: number | null; company_id: string }>(
        `SELECT record_state, quantity, company_id FROM tenant_subscriptions
          WHERE tenant_id = $1 AND source_record_id = $2`,
        [f.ctx.tenantId, recordId],
      )
    )[0];
  const gaps = (f: SourcesFixture) =>
    c.sql<{ source_record_id: string; reason: string; company_id: string }>(
      `SELECT source_record_id, reason, company_id FROM tenant_ownership_gaps WHERE tenant_id = $1 ORDER BY 1`,
      [f.ctx.tenantId],
    );
  const companyOf = async (f: SourcesFixture, accountId: string) =>
    (
      await c.sql<{ company_id: string }>(
        `SELECT company_id FROM company_external_refs
          WHERE tenant_id = $1 AND system = 'sugar' AND object_type = 'Accounts' AND external_id = $2`,
        [f.ctx.tenantId, accountId],
      )
    )[0]!.company_id;
  const coverage = (ctx: TenantContext) => c.h.db.transaction(ctx, (tx) => runs.coverage(tx));
  const rli = (local: FakeSugar, id: string): FakeSugarRecord => ({
    ...local.data.get('RevenueLineItems')!.find((r) => r.id === id)!,
  });

  /** A tenant with one completed full run (FIX-RLI-001 is an active holding of FIX-ACC-001). */
  async function synced(prefix: string, local: FakeSugar, mapping?: MappingDocument) {
    const f = await sugarTenant(c, local, { prefix, ...(mapping ? { mapping } : {}) });
    const first = await runSync(c, f, 'full');
    expect(first.status).toBe('completed');
    return { f, first };
  }

  describe('seen-but-rejected protection (§9)', () => {
    it('an isolated single rejected record keeps its line, gives its account a gap and makes eligibility unknown', async () => {
      const local = await new FakeSugar().start();
      try {
        const { f, first } = await synced('sbrone', local);
        // Reference-integrity skips of the fixtures (09, 10, 12) are protected too.
        const baseline = Number(first.quality.seen_but_rejected ?? 0);
        expect(await line(f, 'FIX-RLI-001')).toMatchObject({ record_state: 'active' });
        const s = sourcesServices(c);
        const current = await s.authority.show(f.ctx);
        // TEST configuration: state read from `status`; an unmapped value rejects the record.
        await s.authority.publish(
          f.ctx,
          { facts: { ...current!.document.facts, subscription_state: f.connectionId } },
          { expectedBaseVersion: current!.version, actor: 'test' },
        );
        const snapshot = await s.snapshots.latest(f.ctx, f.connectionId);
        const withState = withSnapshot(
          sugarTestMapping((d) => {
            const lines = d.objects.find((o) => o.entity === 'subscription')!;
            lines.fields = lines.fields.map((e) =>
              'target' in e && e.target === 'subscription.state'
                ? {
                    kind: 'core' as const,
                    target: 'subscription.state',
                    source: 'status',
                    transforms: {
                      valueMap: {
                        map: { Active: 'active', Expired: 'expired', Other: 'unknown' },
                        unmapped: 'reject_record' as const,
                      },
                    },
                    confirmation: { by: 'test-operator', note: 'TEST ONLY: state from status' },
                  }
                : e.kind === 'ignored' && e.source === 'status'
                  ? { kind: 'ignored' as const, source: 'mrr_c', reason: 'not_used' }
                  : e,
            );
          }),
          snapshot!.hash,
        );
        await publishWithAcks(c, f, withState, 2);
        local.upsert('RevenueLineItems', {
          ...rli(local, 'FIX-RLI-001'),
          status: 'Weird',
          quantity: '7',
        });
        const second = await runSync(c, f, 'full');
        expect(second).toMatchObject({ status: 'completed' });
        expect(second.quality).toMatchObject({
          seen_but_rejected: baseline + 1,
          tombstones_suppressed: 1,
          record_rejected: 1,
        });
        // The line survives unchanged (never tombstoned, never updated).
        expect(await line(f, 'FIX-RLI-001')).toMatchObject({ record_state: 'active', quantity: 1 });
        const company = await companyOf(f, 'FIX-ACC-001');
        expect(await gaps(f)).toContainEqual({
          source_record_id: 'FIX-RLI-001',
          reason: 'observation_rejected',
          company_id: company,
        });
        const r = await eligibility.evaluate(f.ctx, company, 'fix-prod-001');
        expect(r).toMatchObject({ status: 'unknown', ownership: 'unknown' });
        expect(r.checks.find((ch) => ch.check === 'ownership_coverage')).toMatchObject({
          reason: 'ownership_incomplete',
        });
      } finally {
        await local.stop();
      }
    });

    it('a confident exclusion (reviewed non-holding) and a declared non-subscription product are still tombstoned', async () => {
      const local = await new FakeSugar().start();
      try {
        const { f } = await synced('sbrconf', local);
        local.upsert('RevenueLineItems', {
          ...rli(local, 'FIX-RLI-001'),
          sales_stage: 'Closed Lost',
        });
        const prod002 = local.data
          .get('RevenueLineItems')!
          .find(
            (r) =>
              r.id !== 'FIX-RLI-001' && r.sales_stage === 'Closed Won' && r.product_template_id,
          )!;
        local.upsert('RevenueLineItems', { ...prod002, product_template_id: 'FIX-PROD-900' });
        const second = await runSync(c, f, 'full');
        expect(second.status).toBe('completed');
        expect(second.quality).not.toHaveProperty('tombstones_suppressed');
        expect(await line(f, 'FIX-RLI-001')).toMatchObject({ record_state: 'deleted' });
        expect(await line(f, String(prod002.id))).toMatchObject({ record_state: 'deleted' });
      } finally {
        await local.stop();
      }
    });

    it('an unattributable value rejection fails the run: no tombstones, gaps and coverage unchanged', async () => {
      const local = await new FakeSugar().start();
      try {
        const { f, first } = await synced('sbrunattr', local);
        const gapsBefore = await gaps(f);
        local.upsert('RevenueLineItems', {
          ...rli(local, 'FIX-RLI-001'),
          id: 'FIX-RLI-ORPHAN',
          account_id: null,
          opportunity_id: null,
          sales_stage: 'Renewal Pending',
        });
        // A line the source no longer has: would be tombstoned by a completed run.
        const [gone] = await c.sql<{ source_record_id: string }>(
          `SELECT source_record_id FROM tenant_subscriptions
            WHERE tenant_id = $1 AND record_state = 'active' AND source_record_id <> 'FIX-RLI-001'
            ORDER BY source_record_id LIMIT 1`,
          [f.ctx.tenantId],
        );
        local.remove('RevenueLineItems', gone!.source_record_id);
        const second = await runSync(c, f, 'full');
        expect(second).toMatchObject({
          status: 'failed',
          errorCode: 'rejected_record_unattributable',
        });
        expect(second.quality).toMatchObject({ rejected_record_unattributable: 1 });
        expect(await line(f, gone!.source_record_id)).toMatchObject({ record_state: 'active' });
        expect(await gaps(f)).toEqual(gapsBefore);
        const cov = await coverage(f.ctx);
        expect(cov.known && cov.proof.runId).toBe(first.runId);
      } finally {
        await local.stop();
      }
    });
  });

  describe('reviewed holding-filter domain (§10)', () => {
    it('in: an unreviewed value on an existing line keeps it unchanged and makes the account unknown', async () => {
      const local = await new FakeSugar().start();
      try {
        const { f } = await synced('rdin', local);
        local.upsert('RevenueLineItems', {
          ...rli(local, 'FIX-RLI-001'),
          sales_stage: 'Renewal Pending',
          quantity: '7',
        });
        const second = await runSync(c, f, 'full');
        expect(second.status).toBe('completed');
        expect(second.quality).toMatchObject({
          unreviewed_holding_value: 1,
          tombstones_suppressed: 1,
        });
        expect(await line(f, 'FIX-RLI-001')).toMatchObject({ record_state: 'active', quantity: 1 });
        const company = await companyOf(f, 'FIX-ACC-001');
        expect(await gaps(f)).toContainEqual({
          source_record_id: 'FIX-RLI-001',
          reason: 'holding_filter_value_unreviewed',
          company_id: company,
        });
        await expect(eligibility.evaluate(f.ctx, company, 'fix-prod-001')).resolves.toMatchObject({
          ownership: 'unknown',
        });
      } finally {
        await local.stop();
      }
    });

    it('not_in: an unreviewed value never becomes a holding; a reviewed empty value is filtered out', async () => {
      const local = await new FakeSugar().start();
      try {
        const notIn = sugarTestMapping((d) => {
          const lines = d.objects.find((o) => o.entity === 'subscription')!;
          lines.holdingFilter = {
            ...lines.holdingFilter!,
            operator: 'not_in',
            values: FIXTURE_SALES_STAGES.filter((v) => v !== 'Closed Won'),
            reviewedDomain: testReviewedDomain('0'.repeat(64), ['Closed Won']),
          };
        });
        const { f } = await synced('rdnotin', local, notIn);
        // Fixture 07's blank stage: reviewed as non-holding, so no line (M8 admitted it).
        const blank = local.data
          .get('RevenueLineItems')!
          .find((r) => r.sales_stage === null || r.sales_stage === '');
        expect(blank).toBeDefined();
        expect(await line(f, String(blank!.id))).toBeUndefined();
        local.upsert('RevenueLineItems', {
          ...rli(local, 'FIX-RLI-001'),
          id: 'FIX-RLI-NEWSTAGE',
          sales_stage: 'Renewal Pending',
        });
        const second = await runSync(c, f, 'full');
        expect(second.status).toBe('completed');
        expect(await line(f, 'FIX-RLI-NEWSTAGE')).toBeUndefined();
        const company = await companyOf(f, 'FIX-ACC-001');
        expect(await gaps(f)).toContainEqual({
          source_record_id: 'FIX-RLI-NEWSTAGE',
          reason: 'holding_filter_value_unreviewed',
          company_id: company,
        });
        await expect(eligibility.evaluate(f.ctx, company, 'fix-prod-001')).resolves.toMatchObject({
          ownership: 'unknown',
        });
      } finally {
        await local.stop();
      }
    });

    it('a not_in domain without a classified empty value is refused at publish', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'rdnull', stopAfter: 'profile' });
        const s = sourcesServices(c);
        const snapshot = await s.snapshots.latest(f.ctx, f.connectionId);
        const domain = testReviewedDomain(snapshot!.hash, ['Closed Won']);
        const doc = sugarTestMapping((d) => {
          const lines = d.objects.find((o) => o.entity === 'subscription')!;
          lines.holdingFilter = {
            ...lines.holdingFilter!,
            operator: 'not_in',
            values: FIXTURE_SALES_STAGES.filter((v) => v !== 'Closed Won'),
            reviewedDomain: { ...domain, entries: domain.entries.filter((e) => e.value !== null) },
          };
        });
        const report = await s.mappings.validate(f.ctx, f.connectionId, doc);
        expect(report.errors.map((e) => e.code)).toContain('holding_filter_domain_incomplete');
      } finally {
        await local.stop();
      }
    });

    it('only a new mapping version classifies a new value; normal behaviour then resumes', async () => {
      const local = await new FakeSugar().start();
      try {
        const { f } = await synced('rdresume', local);
        local.addEnumOption('RevenueLineItems', 'sales_stage', 'Renewal Pending');
        local.upsert('RevenueLineItems', {
          ...rli(local, 'FIX-RLI-001'),
          sales_stage: 'Renewal Pending',
          quantity: '7',
        });
        const s = sourcesServices(c);
        await s.snapshots.capture(f.ctx, f.connectionId, 'test');
        expect((await runProfile(c, f, mappingObjects(sugarTestMapping()))).status).toBe(
          'completed',
        );
        const snapshot = await s.snapshots.latest(f.ctx, f.connectionId);
        const v3 = withSnapshot(
          sugarTestMapping((d) => {
            const lines = d.objects.find((o) => o.entity === 'subscription')!;
            const domain = testReviewedDomain(snapshot!.hash, ['Closed Won', 'Renewal Pending']);
            lines.holdingFilter = {
              ...lines.holdingFilter!,
              values: ['Closed Won', 'Renewal Pending'],
              reviewedDomain: {
                ...domain,
                entries: [
                  ...domain.entries,
                  { value: 'Renewal Pending', classification: 'holding' },
                ],
              },
            };
          }),
          snapshot!.hash,
        );
        await publishWithAcks(c, f, v3, 2);
        const third = await runSync(c, f, 'full');
        expect(third.status).toBe('completed');
        expect(third.quality).not.toHaveProperty('unreviewed_holding_value');
        expect(await line(f, 'FIX-RLI-001')).toMatchObject({ record_state: 'active', quantity: 7 });
        expect((await gaps(f)).map((g) => g.source_record_id)).not.toContain('FIX-RLI-001');
      } finally {
        await local.stop();
      }
    });

    it('a version published before M9A (no reviewed domain) must be republished before any run', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'rdm8' });
        const [latest] = await c.sql<{
          version: number;
          document: MappingDocument;
          schema_snapshot_hash: string;
          authority_version: number;
        }>(
          `SELECT version, document, schema_snapshot_hash, authority_version FROM tenant_source_mapping_versions
            WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`,
          [f.ctx.tenantId],
        );
        const m8 = structuredClone(latest!.document);
        for (const o of m8.objects)
          if (o.holdingFilter)
            delete (o.holdingFilter as { reviewedDomain?: unknown }).reviewedDomain;
        // Seeded as an M8 publication (admin SQL, test only).
        await c.sql(
          `INSERT INTO tenant_source_mapping_versions (tenant_id, connection_id, version, base_version, document, content_hash,
             schema_snapshot_hash, authority_version, published_by)
           VALUES ($1, $2, $3, $4, $5, repeat('a', 64), $6, $7, 'm8')`,
          [
            f.ctx.tenantId,
            f.connectionId,
            latest!.version + 1,
            latest!.version,
            JSON.stringify(m8),
            latest!.schema_snapshot_hash,
            latest!.authority_version,
          ],
        );
        await expect(
          sourcesServices(c).sync.start(f.ctx, f.connectionId, 'full', { enqueue: false }),
        ).rejects.toMatchObject({ code: 'mapping_requires_republish' });
      } finally {
        await local.stop();
      }
    });
  });

  describe('structural B guards (§8; fixed thresholds)', () => {
    const inject = (local: FakeSugar, n: number, over: Partial<FakeSugarRecord>) => {
      for (let i = 0; i < n; i++) {
        local.upsert('RevenueLineItems', {
          ...rli(local, 'FIX-RLI-001'),
          id: `FIX-RLI-G${String(i).padStart(3, '0')}`,
          ...over,
        });
      }
    };

    it.each([
      ['identity_field_absent', 'product_template_id', { product_template_id: null }],
      ['type_incompatible', 'quantity', { quantity: 'n/a' }],
      ['representation_incompatible', 'service_start_date', { service_start_date: '31/01/2026' }],
    ] as const)('%s fails the run before any write', async (code, field, over) => {
      const local = await new FakeSugar().start();
      try {
        const { f } = await synced(`grd${code.slice(0, 5)}`, local);
        const before = await c.sql(
          `SELECT id, record_state, quantity FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY id`,
          [f.ctx.tenantId],
        );
        inject(local, 60, over);
        const second = await runSync(c, f, 'full');
        expect(second).toMatchObject({ status: 'failed', errorCode: code });
        expect(second.quality).toMatchObject({ guard: { code, field } });
        expect(
          await c.sql(
            `SELECT id, record_state, quantity FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY id`,
            [f.ctx.tenantId],
          ),
        ).toEqual(before);
      } finally {
        await local.stop();
      }
    });

    it('below the threshold, records are handled individually and the run completes', async () => {
      const local = await new FakeSugar().start();
      try {
        const { f } = await synced('grdbelow', local);
        inject(local, 3, { product_template_id: null });
        const second = await runSync(c, f, 'full');
        expect(second.status).toBe('completed');
        expect(second.quality).toMatchObject({ missing_product_reference: expect.any(Number) });
      } finally {
        await local.stop();
      }
    });
  });

  describe('structural coverage tiers (§11)', () => {
    it('a Sugar full run records a count proof: externally grounded, propagated into eligibility and snapshots', async () => {
      const local = await new FakeSugar().start();
      try {
        const { f, first } = await synced('tierext', local);
        expect(first.quality).toMatchObject({
          proof: { method: 'count', tier: 'externally_grounded', outcome: 'passed' },
        });
        const [row] = await c.sql<{ quality: { proof: unknown } }>(
          'SELECT quality FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND id = $2',
          [f.ctx.tenantId, first.runId],
        );
        expect(row!.quality.proof).toEqual({
          method: 'count',
          tier: 'externally_grounded',
          outcome: 'passed',
        });
        const cov = await coverage(f.ctx);
        expect(cov).toMatchObject({
          known: true,
          coverageTier: 'externally_grounded',
          proof: { method: 'count', runId: first.runId, inferred: false },
        });
        const company = await companyOf(f, 'FIX-ACC-001');
        const r = await eligibility.evaluate(f.ctx, company, 'fix-prod-001', {
          record: { purpose: 'test_evidence', correlationId: randomUUID() },
        });
        expect(r.coverageTier).toBe('externally_grounded');
        const snap = await eligibility.snapshot(f.ctx, r.snapshotId!);
        expect(JSON.stringify(snap.result)).toContain('"coverageTier":"externally_grounded"');
        await expect(eligibility.replay(f.ctx, r.snapshotId!)).resolves.toMatchObject({
          reproduced: true,
        });
      } finally {
        await local.stop();
      }
    });

    it('no promotion: a newer stable run lowers the tier; acceptance gives stable_snapshot, never externally grounded', async () => {
      const local = await new FakeSugar().start();
      try {
        const { f } = await synced('tiernoprom', local);
        const company = await companyOf(f, 'FIX-ACC-001');
        const owned = (
          await c.sql<{ product_key: string }>(
            `SELECT product_key FROM tenant_subscriptions WHERE tenant_id = $1 AND company_id = $2`,
            [f.ctx.tenantId, company],
          )
        ).map((r) => r.product_key);
        const other = ['fix-prod-140', 'fix-prod-130', 'fix-prod-120'].find(
          (p) => !owned.includes(p),
        )!;
        // Externally grounded: absence is not_owned and whitespace.
        await expect(eligibility.evaluate(f.ctx, company, other)).resolves.toMatchObject({
          ownership: 'not_owned',
          status: 'eligible',
        });
        const wsExt = await eligibility.whitespace(f.ctx, company);
        expect(wsExt.categories.eligible_whitespace.map((x) => x.productKey)).toContain(other);
        // A newer completed run whose proof is adapter-declared stable (seeded; admin SQL, test only).
        const [latest] = await c.sql<{ mapping_version: number }>(
          `SELECT max(mapping_version) AS mapping_version FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND source_connection_id = $2`,
          [f.ctx.tenantId, f.connectionId],
        );
        const seed = async (proof: Record<string, unknown>) => {
          const id = randomUUID();
          await c.sql(
            `INSERT INTO tenant_sync_checkpoints (tenant_id, id, system, kind, mode, status, correlation_id, started_at, updated_at, completed_at, source_connection_id, mapping_version, quality)
             VALUES ($1, $2, 'sugar', 'subscription', 'backfill', 'completed', gen_random_uuid(), now(), now(), now() + interval '1 second', $3, $4, $5)`,
            [
              f.ctx.tenantId,
              id,
              f.connectionId,
              latest!.mapping_version,
              JSON.stringify({ proof }),
            ],
          );
          return id;
        };
        const stableRun = await seed({
          method: 'double_enumeration',
          tier: 'stable_snapshot',
          outcome: 'passed',
        });
        await expect(coverage(f.ctx)).resolves.toEqual({
          known: false,
          reason: 'proof_not_accepted',
        });
        const s = sourcesServices(c);
        const current = await s.authority.show(f.ctx);
        const accepted = await s.authority.publish(f.ctx, current!.document, {
          expectedBaseVersion: current!.version,
          actor: 'ops',
          proofAcceptances: [
            { connectionId: f.connectionId, reason: 'double enumeration reviewed' },
          ],
        });
        expect(accepted.contentHash).not.toBe(current!.contentHash);
        expect(await coverage(f.ctx)).toMatchObject({
          known: true,
          coverageTier: 'stable_snapshot',
          proof: {
            runId: stableRun,
            method: 'double_enumeration',
            acceptedInAuthorityVersion: accepted.version,
          },
        });
        // Accepted stable: absence is unknown, no whitespace; owned is unchanged.
        const r = await eligibility.evaluate(f.ctx, company, other);
        expect(r).toMatchObject({
          ownership: 'unknown',
          status: 'unknown',
          coverageTier: 'stable_snapshot',
        });
        expect(r.checks.find((ch) => ch.check === 'ownership_coverage')).toMatchObject({
          reason: 'coverage_tier_insufficient',
        });
        const wsStable = await eligibility.whitespace(f.ctx, company);
        expect(wsStable.categories.eligible_whitespace).toEqual([]);
        expect(wsStable.categories.owned.map((x) => x.productKey).sort()).toEqual(
          wsExt.categories.owned.map((x) => x.productKey).sort(),
        );
        // A tampered stored tier is ignored: the tier is re-derived from the method.
        const tampered = await seed({
          method: 'double_enumeration',
          tier: 'externally_grounded',
          outcome: 'passed',
        });
        expect(await coverage(f.ctx)).toMatchObject({
          coverageTier: 'stable_snapshot',
          proof: { runId: tampered },
        });
      } finally {
        await local.stop();
      }
    });

    it('pre-M9A runs without a proof are inferred: versioned → count / externally grounded', async () => {
      const local = await new FakeSugar().start();
      try {
        const { f, first } = await synced('tierinfer', local);
        await c.sql(
          `UPDATE tenant_sync_checkpoints SET quality = quality - 'proof' WHERE tenant_id = $1 AND id = $2`,
          [f.ctx.tenantId, first.runId],
        );
        expect(await coverage(f.ctx)).toMatchObject({
          coverageTier: 'externally_grounded',
          proof: { method: 'count', inferred: true },
        });
      } finally {
        await local.stop();
      }
    });
  });

  describe('CSV imports (A2): operator_full_file → stable_snapshot', () => {
    const HEADER = 'record_id,account,product,state,starts_at,ends_at,quantity,source_updated_at';
    const hs = (id: string): ExternalRef => ({ system: 'hubspot', objectType: 'companies', id });

    async function csvTenant(prefix: string) {
      const t = await c.tenant(prefix, 1101 + Math.floor(Math.random() * 1000));
      await c.h.catalogue.publish(t, genericModel(), {
        actor: 'test',
        basedOnVersion: 0,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        now: new Date('2026-01-01T00:00:00Z'),
      });
      const r = await c.ingestion.ingest(
        t,
        {
          kind: 'company',
          presence: 'present',
          ref: hs('970'),
          observedAt: new Date(),
          fields: { name: 'Company 970' },
        },
        { cause: 'webhook', correlationId: randomUUID() },
      );
      await c.h.imports.import(
        t,
        new TextEncoder().encode(
          `${HEADER}\nC1,hubspot:companies:970,core,active,2026-01-01T00:00:00Z,,,\n`,
        ),
        {
          source: 'billing',
          mode: 'full',
          execute: true,
          correlationId: randomUUID(),
        },
      );
      return { t, company: r.entityId! };
    }

    it('records the proof; coverage is known without acceptance; owned holds, absence is unknown, no whitespace', async () => {
      const { t, company } = await csvTenant('csvtier');
      const [run] = await c.sql<{ id: string; quality: { proof: unknown } }>(
        `SELECT id, quality FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND mode = 'import_full' AND status = 'completed'`,
        [t.tenantId],
      );
      expect(run!.quality.proof).toEqual({
        method: 'operator_full_file',
        tier: 'stable_snapshot',
        outcome: 'passed',
      });
      expect(await coverage(t)).toMatchObject({
        known: true,
        coverageTier: 'stable_snapshot',
        proof: { method: 'operator_full_file', inferred: false },
      });
      await expect(eligibility.evaluate(t, company, 'core')).resolves.toMatchObject({
        ownership: 'owned',
      });
      const absent = await eligibility.evaluate(t, company, 'analytics');
      expect(absent).toMatchObject({ ownership: 'unknown', status: 'unknown' });
      expect(absent.checks.find((ch) => ch.check === 'ownership_coverage')).toMatchObject({
        reason: 'coverage_tier_insufficient',
      });
      expect((await eligibility.whitespace(t, company)).categories.eligible_whitespace).toEqual([]);
    });

    it('a historical import without a proof behaves identically (inferred)', async () => {
      const { t, company } = await csvTenant('csvhist');
      await c.sql(
        `UPDATE tenant_sync_checkpoints SET quality = NULL WHERE tenant_id = $1 AND mode = 'import_full'`,
        [t.tenantId],
      );
      expect(await coverage(t)).toMatchObject({
        known: true,
        coverageTier: 'stable_snapshot',
        proof: { method: 'operator_full_file', inferred: true },
      });
      await expect(eligibility.evaluate(t, company, 'core')).resolves.toMatchObject({
        ownership: 'owned',
      });
      await expect(eligibility.evaluate(t, company, 'analytics')).resolves.toMatchObject({
        ownership: 'unknown',
      });
      expect((await eligibility.whitespace(t, company)).categories.eligible_whitespace).toEqual([]);
    });
  });

  it('acknowledgement helper names exactly the unacknowledged findings (test support sanity)', () => {
    expect(
      acknowledgementsFor({
        ok: false,
        snapshotHash: 'x',
        authorityVersion: 1,
        coveringProfileIds: [],
        warnings: [],
        errors: [
          {
            code: 'finding_unacknowledged',
            path: 'profiles.a.findings.00000000-0000-4000-8000-000000000001',
            message: '',
          },
        ],
      }),
    ).toEqual([
      { findingId: '00000000-0000-4000-8000-000000000001', reasonCode: 'accepted_known_issue' },
    ]);
  });
});
