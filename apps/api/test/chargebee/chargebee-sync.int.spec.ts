import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MappingDocument } from '../../src/modules/domain';
import { EligibilityService } from '../../src/modules/products';
import { SubscriptionRunsStore } from '../../src/modules/products/infrastructure/subscription-runs.store';
import type { TenantContext } from '../../src/modules/tenancy';
import { chargebeeTenant, chargebeeTestMapping } from '../support/chargebee';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeChargebee, nowSeconds } from '../support/fake-chargebee';
import {
  acknowledgementsFor,
  mappingObjects,
  publishWithAcks,
  runProfile,
  runSync,
  sourcesServices,
  withSnapshot,
  type SourcesFixture,
} from '../support/sources';

/**
 * M9B: the Chargebee reference adapter end to end against the deterministic
 * fake (CB01–CB36), on real PostgreSQL with the app role and forced RLS.
 * TEST configuration only (test/fixtures/chargebee). The fake is NOT evidence
 * of real Chargebee behaviour: LIVE CHARGEBEE VERIFICATION is pending (V2–V12).
 */
describe('Chargebee reference adapter (fake Chargebee, CB01–CB36)', () => {
  let c: ContextHarness;
  let eligibility: EligibilityService;
  let runs: SubscriptionRunsStore;
  let seq = 0;

  beforeAll(async () => {
    c = await startContextHarness();
    eligibility = c.app.get(EligibilityService);
    runs = c.app.get(SubscriptionRunsStore);
  });
  afterAll(async () => {
    await c?.close();
  });

  type Line = {
    source_record_id: string;
    state: string;
    record_state: string;
    product_key: string;
    quantity: number | null;
    starts_at: Date | null;
    ends_at: Date | null;
    company_id: string;
  };

  const lines = async (f: SourcesFixture) =>
    new Map(
      (
        await c.sql<Line>(
          `SELECT source_record_id, state, record_state, product_key, quantity, starts_at, ends_at, company_id
             FROM tenant_subscriptions WHERE tenant_id = $1 AND source_system = 'chargebee'`,
          [f.ctx.tenantId],
        )
      ).map((l) => [l.source_record_id, l]),
    );
  const active = async (f: SourcesFixture) =>
    [...(await lines(f)).values()]
      .filter((l) => l.record_state === 'active')
      .map((l) => l.source_record_id)
      .sort();
  const gaps = (f: SourcesFixture) =>
    c.sql<{ source_record_id: string; reason: string; company_id: string }>(
      `SELECT source_record_id, reason, company_id FROM tenant_ownership_gaps WHERE tenant_id = $1 ORDER BY 1`,
      [f.ctx.tenantId],
    );
  const companyOf = async (f: SourcesFixture, customerId: string) =>
    (
      await c.sql<{ company_id: string; deleted_at: Date | null }>(
        `SELECT company_id, deleted_at FROM company_external_refs
          WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers' AND external_id = $2`,
        [f.ctx.tenantId, customerId],
      )
    )[0];
  type RefRow = {
    external_id: string;
    state: string;
    company_id: string;
    deleted_at: Date | null;
    retired_at: Date | null;
    retired_by_run_id: string | null;
  };
  const refs = async (f: SourcesFixture) =>
    new Map(
      (
        await c.sql<RefRow>(
          `SELECT external_id, state, company_id, deleted_at, retired_at, retired_by_run_id
             FROM company_external_refs
            WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers'`,
          [f.ctx.tenantId],
        )
      ).map((r) => [r.external_id, r]),
    );
  const refOf = async (f: SourcesFixture, id: string) => (await refs(f)).get(id);
  const companyRow = async (id: string) =>
    (
      await c.sql<{ id: string; name: string | null; record_state: string }>(
        `SELECT id, name, record_state FROM companies WHERE id = $1`,
        [id],
      )
    )[0];
  /** Physical row counts of every table retirement could touch (never decreasing). */
  const rowCounts = async (f: SourcesFixture) =>
    (
      await c.sql<{ companies: number; refs: number; lines: number; changes: number }>(
        `SELECT (SELECT count(*)::int FROM companies WHERE tenant_id = $1) AS companies,
                (SELECT count(*)::int FROM company_external_refs WHERE tenant_id = $1) AS refs,
                (SELECT count(*)::int FROM tenant_subscriptions WHERE tenant_id = $1) AS lines,
                (SELECT count(*)::int FROM tenant_context_changes WHERE tenant_id = $1) AS changes`,
        [f.ctx.tenantId],
      )
    )[0]!;
  const removeCustomer = (fake: FakeChargebee, id: string) => {
    fake.customers = fake.customers.filter((x) => x.id !== id);
  };
  const checkpoint = async (runId: string) =>
    (
      await c.sql<{
        status: string;
        last_error_code: string | null;
        records_changed: number;
        records_seen: number;
      }>(
        `SELECT status, last_error_code, records_changed, records_seen FROM tenant_sync_checkpoints WHERE id = $1`,
        [runId],
      )
    )[0]!;
  const coverage = (ctx: TenantContext) => c.h.db.transaction(ctx, (tx) => runs.coverage(tx));
  const sec = (d: Date | null) => (d ? d.getTime() / 1000 : null);

  /** A fresh fake and tenant; `accept` accepts the double-enumeration proof (CB29). */
  async function setup(
    options: {
      accept?: boolean;
      mapping?: MappingDocument;
      config?: Record<string, unknown>;
      productIds?: readonly string[];
      prepare?: (fake: FakeChargebee) => void;
    } = {},
  ) {
    const fake = await new FakeChargebee().start();
    options.prepare?.(fake);
    seq += 1;
    const f = await chargebeeTenant(c, fake, {
      prefix: `cb${seq}`,
      accept: options.accept ?? true,
      ...(options.mapping ? { mapping: options.mapping } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.productIds ? { productIds: options.productIds } : {}),
    });
    return { fake, f };
  }
  async function withFake<T>(
    options: Parameters<typeof setup>[0],
    body: (fake: FakeChargebee, f: SourcesFixture) => Promise<T>,
  ): Promise<T> {
    const { fake, f } = await setup(options);
    try {
      return await body(fake, f);
    } finally {
      await fake.stop();
    }
  }
  async function full(f: SourcesFixture) {
    const r = await runSync(c, f, 'full');
    return r;
  }
  const removeSubscription = (fake: FakeChargebee, id: string) => {
    fake.subscriptions = fake.subscriptions.filter((s) => s.id !== id);
  };

  describe('identity, products, states and terms (CB01–CB09, CB13, CB16, CB18)', () => {
    it('one stable full run maps every scenario of the default dataset', async () => {
      await withFake({}, async (fake, f) => {
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        const all = await lines(f);
        // CB01: one line, active, terms from current_term_* (UTC seconds, F18).
        const l01 = all.get('sub-01:plan-basic-USD-monthly')!;
        const s01 = fake.subscription('sub-01');
        expect(l01).toMatchObject({ state: 'active', product_key: 'plan-basic', quantity: 1 });
        expect(sec(l01.starts_at)).toBe(s01.current_term_start);
        expect(sec(l01.ends_at)).toBe(s01.current_term_end);
        expect(await companyOf(f, 'cus-01')).toMatchObject({ deleted_at: null });
        expect(l01.company_id).toBe((await companyOf(f, 'cus-01'))!.company_id);
        // CB02: plan + 2 add-ons → 3 lines, products by item id (Product = Item).
        expect(
          [...all.values()]
            .filter((l) => l.source_record_id.startsWith('sub-02:'))
            .map((l) => [l.product_key, l.quantity])
            .sort(),
        ).toEqual([
          ['addon-seats', 3],
          ['addon-support', 1],
          ['plan-pro', 1],
        ]);
        // CB03: two subscriptions, same customer, same item → two lines (no collapse).
        expect(all.get('sub-03a:plan-basic-USD-monthly')!.company_id).toBe(
          all.get('sub-03b:plan-basic-USD-monthly')!.company_id,
        );
        // CB04–CB09: the versioned status mapping (never inferred from dates).
        expect(all.get('sub-04:plan-pro-USD-monthly')!.state).toBe('trial');
        expect(all.get('sub-05:plan-basic-USD-monthly')!.state).toBe('unknown');
        expect(all.get('sub-06:plan-basic-USD-monthly')!.state).toBe('active');
        expect(all.get('sub-07:plan-basic-USD-monthly')!.state).toBe('cancelled');
        expect(all.get('sub-08:plan-basic-USD-monthly')!.state).toBe('unknown');
        expect(all.get('sub-09:plan-basic-USD-monthly')!.state).toBe('unknown');
        // CB05: a future term is kept as read (no date inference changes the state).
        expect(sec(all.get('sub-05:plan-basic-USD-monthly')!.starts_at)).toBe(
          fake.subscription('sub-05').current_term_start,
        );
        // CB13: USD and EUR prices of one item → one product, two lines.
        expect(all.get('sub-13a:plan-basic-USD-monthly')!.product_key).toBe('plan-basic');
        expect(all.get('sub-13b:plan-basic-EUR-monthly')!.product_key).toBe('plan-basic');
        // CB16: a one-off charge is a reviewed non-holding: filtered out, never a line.
        expect(all.has('sub-16:charge-setup-USD')).toBe(false);
        expect(all.get('sub-16:plan-basic-USD-monthly')).toBeDefined();
        // CB18: an ignored item: no line and no gap.
        expect(all.has('sub-18:addon-legacy-USD-monthly')).toBe(false);
        expect(run.quality).toMatchObject({ filtered_out: 1, non_subscription_product: 1 });
        expect((await gaps(f)).map((g) => g.source_record_id)).not.toContain(
          'sub-18:addon-legacy-USD-monthly',
        );
        // Every line key is the approved fallback identity <subscription_id>:<item_price_id>.
        for (const key of all.keys()) expect(key).toMatch(/^sub-[0-9a-z]+:[a-z]+-[a-z]+-[A-Z]{3}/);
        // Payment data never reached the platform.
        const dump = JSON.stringify(
          await c.sql(`SELECT * FROM tenant_subscriptions WHERE tenant_id = $1`, [f.ctx.tenantId]),
        );
        expect(dump).not.toMatch(/masked_number|card_type|\*{4}1111|visa/);
      });
    });

    it('CB09/C13: an unlisted status is unknown (never active) and is reported unmapped', async () => {
      await withFake({}, async (fake, f) => {
        fake.subscription('sub-10').status = 'synthetic_unlisted';
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect((await lines(f)).get('sub-10:plan-basic-USD-monthly')!.state).toBe('unknown');
        expect(run.quality).toMatchObject({ unmapped_source_enum_value: 1 });
        // Drift: a fresh profile shows the value; validation reports it unmapped (CB33).
        const mapping = withSnapshot(
          chargebeeTestMapping(),
          (await sourcesServices(c).snapshots.latest(f.ctx, f.connectionId))!.hash,
        );
        await runProfile(c, f, mappingObjects(mapping));
        const report = await sourcesServices(c).mappings.validate(f.ctx, f.connectionId, mapping);
        expect(report.warnings.map((w) => w.code)).toContain('observed_value_unmapped');
      });
    });

    it('CB17/C18: an item without a Product Model entry fails the run before any write; no product is created', async () => {
      await withFake(
        { productIds: ['plan-basic', 'addon-seats', 'addon-support', 'charge-setup'] },
        async (_fake, f) => {
          const products = async () =>
            (
              await c.sql<{ key: string }>(
                `SELECT key FROM tenant_products WHERE tenant_id = $1 ORDER BY 1`,
                [f.ctx.tenantId],
              )
            ).map((p) => p.key);
          const before = await products();
          const run = await full(f);
          expect(run).toMatchObject({
            status: 'failed',
            errorCode: 'unmodelled_product_reference',
          });
          expect(await lines(f)).toEqual(new Map());
          expect(await products()).toEqual(before);
          expect(before).not.toContain('plan-pro');
        },
      );
    });

    it('C11: the published mapping chooses the line identity; item identity is a governed mapping choice', async () => {
      const mapping = chargebeeTestMapping((d) => {
        const lineObj = d.objects.find((o) => o.entity === 'subscription')!;
        lineObj.identity = {
          field: 'line_key_item',
          confirmation: { by: 'test-operator', note: 'TEST ONLY: V3 assumed for this test' },
        };
        lineObj.fields = lineObj.fields.map((e) =>
          e.kind === 'ignored' && e.source === 'line_key_item'
            ? { kind: 'ignored' as const, source: 'line_key_item_price', reason: 'not_identity' }
            : e,
        );
      });
      await withFake({ mapping }, async (_fake, f) => {
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        const keys = await active(f);
        expect(keys).toContain('sub-01:plan-basic');
        expect(keys).toContain('sub-13b:plan-basic');
        expect(keys.some((k) => k.includes('-USD-'))).toBe(false);
      });
    });
  });

  describe('changes over runs (CB10–CB12, CB14, CB22)', () => {
    it('CB10 renewal and CB11 quantity update the same line; no new line', async () => {
      await withFake({}, async (fake, f) => {
        await full(f);
        const s = fake.subscription('sub-10');
        fake.touch('sub-10', (x) => {
          x.current_term_start = x.current_term_end!;
          x.current_term_end = x.current_term_end! + 30 * 86_400;
          x.subscription_items[0]!.quantity = 5;
        });
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        const sub10 = [...(await lines(f)).values()].filter((l) =>
          l.source_record_id.startsWith('sub-10:'),
        );
        expect(sub10).toHaveLength(1);
        expect(sub10[0]).toMatchObject({ quantity: 5, record_state: 'active' });
        expect(sec(sub10[0]!.ends_at)).toBe(s.current_term_end);
      });
    });

    it('CB12 price change and CB14 upgrade: the old line is retired by G4 (positive child-set evidence), the new one created', async () => {
      await withFake({ accept: false }, async (fake, f) => {
        await full(f);
        fake.touch('sub-14', (x) => {
          x.subscription_items = [
            { item_price_id: 'plan-pro-USD-monthly', item_type: 'plan', quantity: 1 },
          ];
        });
        fake.touch('sub-13a', (x) => {
          x.subscription_items = [
            { item_price_id: 'plan-basic-USD-yearly', item_type: 'plan', quantity: 1 },
          ];
        });
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        // No acceptance: no absence-based tombstone, yet G4 retires replaced children.
        expect(run.quality).toMatchObject({ child_retired: 2, tombstones_not_accepted: 1 });
        expect(run.quality.tombstoned).toBeUndefined();
        const all = await lines(f);
        expect(all.get('sub-14:plan-basic-USD-monthly')!.record_state).toBe('deleted');
        expect(all.get('sub-14:plan-pro-USD-monthly')!.record_state).toBe('active');
        expect(all.get('sub-13a:plan-basic-USD-monthly')!.record_state).toBe('deleted');
        expect(all.get('sub-13a:plan-basic-USD-yearly')).toMatchObject({
          record_state: 'active',
          product_key: 'plan-basic',
        });
        // Unrelated subscriptions are untouched.
        expect(all.get('sub-13b:plan-basic-EUR-monthly')!.record_state).toBe('active');
      });
    });

    it('CB22: cancelled then reactivated keeps the same line (cancelled → active)', async () => {
      await withFake({}, async (fake, f) => {
        await full(f);
        fake.touch('sub-22', (x) => (x.status = 'cancelled'));
        await full(f);
        expect((await lines(f)).get('sub-22:plan-pro-USD-monthly')).toMatchObject({
          state: 'cancelled',
          record_state: 'active',
        });
        fake.touch('sub-22', (x) => (x.status = 'active'));
        await full(f);
        const sub22 = [...(await lines(f)).values()].filter((l) =>
          l.source_record_id.startsWith('sub-22:'),
        );
        expect(sub22.map((l) => [l.state, l.record_state])).toEqual([['active', 'active']]);
      });
    });
  });

  describe('references and deletions (CB19–CB21, CB23)', () => {
    it('CB19: a subscription of a never-seen customer is an orphan: no line, protected; an existing line moved to it is kept with a gap', async () => {
      await withFake({}, async (fake, f) => {
        const first = await full(f);
        expect(first).toMatchObject({ status: 'completed' });
        expect(first.quality).toMatchObject({ orphan_account_reference: 1 });
        expect((await lines(f)).has('sub-19:plan-basic-USD-monthly')).toBe(false);
        const company = (await companyOf(f, 'cus-10'))!.company_id;
        fake.touch('sub-10', (x) => (x.customer_id = 'cus-405'));
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ orphan_account_reference: 2 });
        expect((await lines(f)).get('sub-10:plan-basic-USD-monthly')).toMatchObject({
          record_state: 'active',
          company_id: company,
        });
        expect(await gaps(f)).toContainEqual({
          source_record_id: 'sub-10:plan-basic-USD-monthly',
          reason: 'account_reference_orphaned',
          company_id: company,
        });
      });
    });

    it('CB20 (live-only reads): a deleted customer and its subscriptions are absent; the accepted full run retires the lines and the customer reference (never the company)', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        await full(f);
        const company = (await companyOf(f, 'cus-01'))!.company_id;
        // Chargebee deletes a customer's subscriptions with the customer.
        fake.customers.find((x) => x.id === 'cus-01')!.deleted = true;
        fake.subscription('sub-01').deleted = true;
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ tombstoned: 1 });
        expect((await lines(f)).get('sub-01:plan-basic-USD-monthly')).toMatchObject({
          record_state: 'deleted',
          state: 'active',
          company_id: company,
        });
        // Governed correction (M08): the reference is retired, never deleted; the company stays.
        expect(await refOf(f, 'cus-01')).toMatchObject({
          state: 'retired',
          deleted_at: null,
          retired_by_run_id: run.runId,
          company_id: company,
        });
        expect(run.quality).toMatchObject({ references_retired: 1 });
        expect(await companyRow(company)).toMatchObject({ record_state: 'active' });
      });
    });

    it('CB21/C17 (live-only reads): a deleted subscription is absent; never retired without an acceptance', async () => {
      await withFake({ accept: false }, async (fake, f) => {
        await full(f);
        fake.touch('sub-02', (x) => (x.deleted = true));
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ tombstones_not_accepted: 1 });
        expect(run.quality.tombstoned).toBeUndefined();
        expect(run.quality.child_retired).toBeUndefined();
        expect(await active(f)).toEqual(
          expect.arrayContaining([
            'sub-02:plan-pro-USD-monthly',
            'sub-02:addon-seats-USD-monthly',
            'sub-02:addon-support-USD-monthly',
          ]),
        );
        expect(fake.requests.some((r) => r.query.has('include_deleted'))).toBe(false);
      });
    });

    it('CB21/C17 (live-only reads): the next accepted full run retires exactly the deleted subscription (deletion, not cancellation)', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        await full(f);
        fake.touch('sub-02', (x) => (x.deleted = true));
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ tombstoned: 3 });
        const all = await lines(f);
        for (const key of [
          'sub-02:plan-pro-USD-monthly',
          'sub-02:addon-seats-USD-monthly',
          'sub-02:addon-support-USD-monthly',
        ]) {
          // Retired as absent; the state was never rewritten to cancelled.
          expect(all.get(key)).toMatchObject({ record_state: 'deleted', state: 'active' });
        }
        expect(await active(f)).toContain('sub-03a:plan-basic-USD-monthly');
        // Cancellation is never deletion evidence.
        fake.touch('sub-07', (x) => (x.status = 'cancelled'));
        await full(f);
        expect((await lines(f)).get('sub-07:plan-basic-USD-monthly')!.record_state).toBe('active');
      });
    });

    it('V5/V7: a deleted record that reuses a live id (even if returned) never collides, at any page size', async () => {
      await withFake(
        {
          accept: true,
          config: { pageSize: 10 },
          prepare: (fake) => {
            const live02 = fake.subscription('sub-02');
            // The deleted original sits on another page than the live record with the same id.
            fake.subscriptions.unshift({
              ...structuredClone(live02),
              created_at: live02.created_at - 30 * 86_400,
              deleted: true,
              status: 'in_trial',
            });
            fake.alwaysIncludeDeleted = true;
          },
        },
        async (fake, f) => {
          const run = await full(f);
          expect(run).toMatchObject({ status: 'completed' });
          expect(run.quality.proof).toEqual({
            method: 'double_enumeration',
            tier: 'stable_snapshot',
            outcome: 'passed',
          });
          expect(run.quality.duplicate_external_id).toBeUndefined();
          const all = await lines(f);
          for (const key of [
            'sub-02:plan-pro-USD-monthly',
            'sub-02:addon-seats-USD-monthly',
            'sub-02:addon-support-USD-monthly',
          ]) {
            expect(all.get(key)).toMatchObject({ record_state: 'active', state: 'active' });
          }
          const pages = fake.requests.filter(
            (r) => r.path === '/subscriptions' && !r.query.get('offset'),
          ).length;
          expect(pages).toBeGreaterThanOrEqual(2);
          // A rerun is stable and changes nothing.
          const again = await full(f);
          expect(again).toMatchObject({ status: 'completed' });
          expect((await checkpoint(again.runId)).records_changed).toBe(0);
        },
      );
    });

    it('CB23: an unknown item price is a missing product: protected with a gap; no sibling or old line retired', async () => {
      await withFake({}, async (fake, f) => {
        await full(f);
        fake.touch('sub-15', (x) => {
          x.subscription_items = [
            { item_price_id: 'plan-basic-USD-monthly', item_type: 'plan', quantity: 1 },
            { item_price_id: 'ghost-price-USD', item_type: 'addon', quantity: 2 },
          ];
        });
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ missing_product_reference: 1 });
        // The parent's child set is uncertain: the old add-on line is neither retired nor tombstoned.
        expect(run.quality).toMatchObject({ child_reconciliation_skipped: 2 });
        expect(await active(f)).toEqual(
          expect.arrayContaining([
            'sub-15:plan-basic-USD-monthly',
            'sub-15:addon-seats-USD-monthly',
          ]),
        );
        expect(run.quality.child_retired).toBeUndefined();
        expect(run.quality.tombstoned).toBeUndefined();
        expect(await gaps(f)).toContainEqual(
          expect.objectContaining({
            source_record_id: 'sub-15:ghost-price-USD',
            reason: 'missing_product_reference',
          }),
        );
      });
    });
  });

  describe('fail-closed values and duplicates (CB24, CB25, CB33)', () => {
    it('CB24: a malformed term rejects the subscription at the boundary; its lines stay protected', async () => {
      await withFake({}, async (fake, f) => {
        await full(f);
        const s = fake.subscription('sub-10');
        s.raw = { ...s, raw: undefined, current_term_end: 'not-a-timestamp' };
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ record_rejected: 1 });
        expect((await lines(f)).get('sub-10:plan-basic-USD-monthly')).toMatchObject({
          record_state: 'active',
          state: 'active',
        });
        expect(await gaps(f)).toContainEqual(
          expect.objectContaining({
            source_record_id: 'sub-10:plan-basic-USD-monthly',
            reason: 'observation_rejected',
          }),
        );
      });
    });

    it('CB25/C12: a repeated line key fails closed (every occurrence protected, no write, parent not reconciled)', async () => {
      await withFake({}, async (fake, f) => {
        await full(f);
        fake.touch('sub-02', (x) => {
          x.subscription_items = [
            { item_price_id: 'plan-pro-USD-monthly', item_type: 'plan', quantity: 1 },
            { item_price_id: 'addon-seats-USD-monthly', item_type: 'addon', quantity: 9 },
            { item_price_id: 'addon-seats-USD-monthly', item_type: 'addon', quantity: 4 },
          ];
        });
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ duplicate_external_id: 2 });
        const all = await lines(f);
        // Neither duplicate was written (quantity unchanged); the removed sibling is not retired.
        expect(all.get('sub-02:addon-seats-USD-monthly')).toMatchObject({
          quantity: 3,
          record_state: 'active',
        });
        expect(all.get('sub-02:addon-support-USD-monthly')!.record_state).toBe('active');
        expect(run.quality.child_retired).toBeUndefined();
      });
    });

    it('CB25 under item identity: the same item twice in one subscription is a duplicate key', async () => {
      const mapping = chargebeeTestMapping((d) => {
        const lineObj = d.objects.find((o) => o.entity === 'subscription')!;
        lineObj.identity = {
          field: 'line_key_item',
          confirmation: { by: 'test-operator', note: 'TEST ONLY: V3 assumed for this test' },
        };
        lineObj.fields = lineObj.fields.map((e) =>
          e.kind === 'ignored' && e.source === 'line_key_item'
            ? { kind: 'ignored' as const, source: 'line_key_item_price', reason: 'not_identity' }
            : e,
        );
      });
      await withFake(
        {
          mapping,
          prepare: (fake) => {
            fake.subscription('sub-01').subscription_items.push({
              item_price_id: 'plan-basic-USD-yearly',
              item_type: 'plan',
              quantity: 1,
            });
          },
        },
        async (_fake, f) => {
          const run = await full(f);
          expect(run).toMatchObject({ status: 'completed' });
          expect(run.quality).toMatchObject({ duplicate_external_id: 2 });
          expect(await active(f)).not.toContain('sub-01:plan-basic');
        },
      );
    });

    it('CB33: a new item_type value is an unreviewed holding value (protected, gap), never a guess', async () => {
      await withFake({}, async (fake, f) => {
        await full(f);
        fake.touch('sub-01', (x) => (x.subscription_items[0]!.item_type = 'synthetic_kind'));
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ unreviewed_holding_value: 1 });
        expect((await lines(f)).get('sub-01:plan-basic-USD-monthly')!.record_state).toBe('active');
        expect(await gaps(f)).toContainEqual(
          expect.objectContaining({
            source_record_id: 'sub-01:plan-basic-USD-monthly',
            reason: 'holding_filter_value_unreviewed',
          }),
        );
      });
    });
  });

  describe('structurally rejected parent (CB35, C21)', () => {
    it('full run: a rejected parent never reconciles; its children stay active and protected with a gap', async () => {
      await withFake({}, async (fake, f) => {
        await full(f);
        const company = (await companyOf(f, 'cus-02'))!.company_id;
        const s = fake.subscription('sub-02');
        // `customer_id` absent: structurally invalid at the boundary.
        s.raw = {
          ...s,
          raw: undefined,
          customer_id: undefined,
          subscription_items: [s.subscription_items[0]],
        };
        // An unrelated removal elsewhere is still tombstoned (positive evidence is per parent).
        removeSubscription(fake, 'sub-03b');
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ record_rejected: 1, tombstoned: 1 });
        expect(run.quality.child_retired).toBeUndefined();
        const all = await lines(f);
        for (const key of [
          'sub-02:plan-pro-USD-monthly',
          'sub-02:addon-seats-USD-monthly',
          'sub-02:addon-support-USD-monthly',
        ]) {
          expect(all.get(key)!.record_state).toBe('active');
          expect(await gaps(f)).toContainEqual({
            source_record_id: key,
            reason: 'observation_rejected',
            company_id: company,
          });
        }
        expect(all.get('sub-03b:plan-basic-USD-monthly')!.record_state).toBe('deleted');
      });
    });

    it('incremental run (V12 assumed in the fake): a rejected parent never reconciles either', async () => {
      await withFake({ config: { incrementalLines: 'verified' } }, async (fake, f) => {
        await full(f);
        const s = fake.subscription('sub-02');
        fake.touch('sub-02', () => undefined);
        s.raw = { ...s, raw: undefined, subscription_items: 'not-an-array' };
        // Alone in the window, the rejected parent trips the structural guard (fail closed).
        const alone = await runSync(c, f, 'incremental');
        expect(alone).toMatchObject({ status: 'failed', errorCode: 'identity_field_absent' });
        expect(alone.quality.child_retired).toBeUndefined();
        for (const id of ['sub-01', 'sub-03a', 'sub-04']) fake.touch(id, () => undefined);
        const run = await runSync(c, f, 'incremental');
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ record_rejected: 1 });
        expect(run.quality.child_retired).toBeUndefined();
        expect(await active(f)).toEqual(
          expect.arrayContaining([
            'sub-02:plan-pro-USD-monthly',
            'sub-02:addon-seats-USD-monthly',
            'sub-02:addon-support-USD-monthly',
          ]),
        );
      });
    });

    it('an unattributable rejected parent (no readable key) fails the run before any tombstone', async () => {
      await withFake({}, async (fake, f) => {
        await full(f);
        const s = fake.subscription('sub-02');
        s.raw = { id: 'not a valid id', deleted: false };
        removeSubscription(fake, 'sub-03b');
        const run = await full(f);
        expect(run).toMatchObject({
          status: 'failed',
          errorCode: 'rejected_record_unattributable',
        });
        expect(await active(f)).toContain('sub-03b:plan-basic-USD-monthly');
      });
    });
  });

  describe('proof, coverage, tombstones and pagination (CB26, CB28–CB31, CB36)', () => {
    it('CB29: a stable full run with acceptance: double_enumeration → stable_snapshot (never externally grounded), tombstones allowed, no whitespace', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        const first = await full(f);
        expect(first.quality.proof).toEqual({
          method: 'double_enumeration',
          tier: 'stable_snapshot',
          outcome: 'passed',
        });
        const cov = await coverage(f.ctx);
        expect(cov).toMatchObject({
          known: true,
          coverageTier: 'stable_snapshot',
          proof: { method: 'double_enumeration', runId: first.runId },
        });
        expect(JSON.stringify(cov)).not.toContain('externally_grounded');
        removeSubscription(fake, 'sub-01');
        const second = await full(f);
        expect(second.quality).toMatchObject({ tombstoned: 1 });
        expect((await lines(f)).get('sub-01:plan-basic-USD-monthly')!.record_state).toBe('deleted');
        // Positive ownership is usable; absence stays unknown: Chargebee alone yields no whitespace.
        const company = (await companyOf(f, 'cus-02'))!.company_id;
        const ws = await eligibility.whitespace(f.ctx, company);
        expect(ws.categories.owned.map((x) => x.productKey).sort()).toEqual([
          'addon-seats',
          'addon-support',
          'plan-pro',
        ]);
        expect(ws.categories.eligible_whitespace).toEqual([]);
        const r = await eligibility.evaluate(f.ctx, company, 'plan-basic');
        expect(r).toMatchObject({ ownership: 'unknown', coverageTier: 'stable_snapshot' });
        expect(r.status).not.toBe('eligible');
      });
    });

    it('CB30/C7: without an acceptance: lines written, coverage none (proof_not_accepted), zero tombstones', async () => {
      await withFake({ accept: false }, async (fake, f) => {
        const first = await full(f);
        expect(first.status).toBe('completed');
        expect((await active(f)).length).toBeGreaterThan(10);
        expect(await coverage(f.ctx)).toEqual({ known: false, reason: 'proof_not_accepted' });
        removeSubscription(fake, 'sub-01');
        const second = await full(f);
        expect(second.quality).toMatchObject({ tombstones_not_accepted: 1 });
        expect(second.quality.tombstoned).toBeUndefined();
        expect((await lines(f)).get('sub-01:plan-basic-USD-monthly')!.record_state).toBe('active');
      });
    });

    it('CB28/C4/C5/C8: a subscription appearing between the two enumerations is unstable_read: no proof, no tombstone, coverage unchanged', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        const first = await full(f);
        removeSubscription(fake, 'sub-01');
        let calls = 0;
        fake.afterListPage = (path) => {
          if (path !== '/subscriptions') return;
          calls += 1;
          if (calls === 1) {
            const t = fake.subscription('sub-22');
            fake.subscriptions.push({
              ...structuredClone(t),
              id: 'sub-late',
              created_at: nowSeconds() - 120,
            });
          }
        };
        const run = await full(f);
        expect(run).toMatchObject({ status: 'failed', errorCode: 'unstable_read' });
        expect(run.quality.proof).toBeUndefined();
        expect(run.quality.tombstoned).toBeUndefined();
        expect((await lines(f)).get('sub-01:plan-basic-USD-monthly')!.record_state).toBe('active');
        expect(await coverage(f.ctx)).toMatchObject({ proof: { runId: first.runId } });
      });
    });

    it('CB26: > 100 subscriptions over >= 3 pages; a transient 503 mid-read is retried; all lines written', async () => {
      await withFake(
        {
          prepare: (fake) => {
            const t = fake.subscription('sub-01');
            for (let i = 0; i < 240; i += 1) {
              fake.subscriptions.push({
                ...structuredClone(t),
                id: `gen-${String(i).padStart(3, '0')}`,
                created_at: t.created_at + i + 1,
              });
            }
          },
        },
        async (fake, f) => {
          const before = fake.requests.length;
          let pages = 0;
          fake.afterListPage = (path) => {
            if (path !== '/subscriptions') return;
            pages += 1;
            if (pages === 2) fake.fail({ match: /^\/subscriptions$/, status: 503 });
          };
          const run = await full(f);
          expect(run).toMatchObject({ status: 'completed' });
          const gen = (await active(f)).filter((k) => k.startsWith('gen-'));
          expect(gen).toHaveLength(240);
          const listCalls = fake.requests.slice(before).filter((r) => r.path === '/subscriptions');
          expect(listCalls.filter((r) => !r.query.get('offset')).length).toBe(2);
          expect(listCalls.length).toBeGreaterThanOrEqual(2 * 3 + 1);
        },
      );
    });

    it('CB31: a 429 storm is retried honouring Retry-After; the run completes; a rerun is idempotent', async () => {
      await withFake({}, async (fake, f) => {
        fake.fail({ match: /^\/subscriptions$/, status: 429, retryAfter: '1', times: 2 });
        const started = Date.now();
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
        const again = await full(f);
        expect(again.status).toBe('completed');
        expect((await checkpoint(again.runId)).records_changed).toBe(0);
      });
    });

    it('CB36/C22: a repeated next_offset is pagination_stalled: bounded requests, no proof, no coverage change, no tombstones', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        const first = await full(f);
        removeSubscription(fake, 'sub-01');
        fake.repeatOffsetFor = '/subscriptions';
        const before = fake.requests.length;
        const run = await full(f);
        expect(run).toMatchObject({ status: 'failed', errorCode: 'pagination_stalled' });
        expect(fake.requests.slice(before).filter((r) => r.path === '/subscriptions').length).toBe(
          2,
        );
        expect(run.quality.proof).toBeUndefined();
        expect(run.quality.tombstoned).toBeUndefined();
        expect((await lines(f)).get('sub-01:plan-basic-USD-monthly')!.record_state).toBe('active');
        expect(await coverage(f.ctx)).toMatchObject({ proof: { runId: first.runId } });
        expect((await checkpoint(run.runId)).status).toBe('failed');
      });
    });

    it('C19: the settle window keeps a just-created subscription outside the full run', async () => {
      await withFake(
        { config: { sync: { overlapMinutes: 10, settleMinutes: 5 } } },
        async (fake, f) => {
          const t = fake.subscription('sub-22');
          fake.subscriptions.push({
            ...structuredClone(t),
            id: 'sub-fresh',
            created_at: nowSeconds() - 60,
          });
          const before = fake.requests.length;
          const run = await full(f);
          expect(run).toMatchObject({ status: 'completed' });
          expect(await active(f)).not.toContain('sub-fresh:plan-pro-USD-monthly');
          const req = fake.requests.slice(before).find((r) => r.path === '/subscriptions')!;
          expect(Number(req.query.get('created_at[before]'))).toBeLessThanOrEqual(
            nowSeconds() - 4 * 60,
          );
        },
      );
    });
  });

  describe('governed customer reference retirement (M08 correction; R1–R10)', () => {
    it('R1: without an acceptance a customer absent from a proven full read keeps an active reference', async () => {
      await withFake({ accept: false }, async (fake, f) => {
        await full(f);
        removeCustomer(fake, 'cus-08');
        removeSubscription(fake, 'sub-08');
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({
          reference_retirement_not_accepted: 1,
          tombstones_not_accepted: 1,
        });
        expect(run.quality.references_retired).toBeUndefined();
        expect(await refOf(f, 'cus-08')).toMatchObject({ state: 'active', retired_at: null });
        expect((await lines(f)).get('sub-08:plan-basic-USD-monthly')!.record_state).toBe('active');
      });
    });

    it('R2–R6, R8–R10 (M08 shape): the accepted full run retires exactly the absent customer reference; company, history and unrelated references are kept; rerun idempotent', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        await full(f);
        const company = (await refOf(f, 'cus-08'))!.company_id;
        const name = (await companyRow(company))!.name;
        const refsBefore = await refs(f);
        const countsBefore = await rowCounts(f);
        // Chargebee deletes the customer together with its only (paused) subscription.
        removeCustomer(fake, 'cus-08');
        removeSubscription(fake, 'sub-08');
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality.proof).toEqual({
          method: 'double_enumeration',
          tier: 'stable_snapshot',
          outcome: 'passed',
        });
        expect(run.quality).toMatchObject({ references_retired: 1, tombstoned: 1 });
        expect(run.quality.child_retired).toBeUndefined();
        // R2: the Chargebee source reference is retired by this run.
        const retired = (await refOf(f, 'cus-08'))!;
        expect(retired).toMatchObject({
          state: 'retired',
          deleted_at: null,
          retired_by_run_id: run.runId,
          company_id: company,
        });
        expect(retired.retired_at).toBeInstanceOf(Date);
        // R3: the canonical company remains, active and unchanged.
        expect(await companyRow(company)).toEqual({ id: company, name, record_state: 'active' });
        // R4: the historical line is stored but retired by the tombstone pass (not cancelled).
        expect((await lines(f)).get('sub-08:plan-basic-USD-monthly')).toMatchObject({
          record_state: 'deleted',
          state: 'unknown',
          company_id: company,
        });
        // R5: nothing was physically deleted.
        const countsAfter = await rowCounts(f);
        expect(countsAfter.companies).toBe(countsBefore.companies);
        expect(countsAfter.refs).toBe(countsBefore.refs);
        expect(countsAfter.lines).toBe(countsBefore.lines);
        expect(countsAfter.changes).toBeGreaterThan(countsBefore.changes);
        // Provenance: one state change naming the reference and the run.
        const prov = await c.sql<{ change_type: string; changed_fields: string[] }>(
          `SELECT change_type, changed_fields FROM tenant_context_changes
            WHERE tenant_id = $1 AND source_object_type = 'Customers' AND source_record_id = 'cus-08'
              AND checkpoint_id = $2`,
          [f.ctx.tenantId, run.runId],
        );
        expect(prov).toEqual([{ change_type: 'state_changed', changed_fields: ['refState'] }]);
        // R6: every other reference is unchanged.
        const refsAfter = await refs(f);
        for (const [id, before] of refsBefore) {
          if (id === 'cus-08') continue;
          expect(refsAfter.get(id)).toEqual(before);
        }
        // R8: coverage stays stable_snapshot (never externally grounded).
        expect(await coverage(f.ctx)).toMatchObject({
          known: true,
          coverageTier: 'stable_snapshot',
          proof: { method: 'double_enumeration', runId: run.runId },
        });
        // R9: no whitespace from the retirement: absence stays unknown.
        const ws = await eligibility.whitespace(f.ctx, company);
        expect(ws.categories.owned).toEqual([]);
        expect(ws.categories.eligible_whitespace).toEqual([]);
        const r = await eligibility.evaluate(f.ctx, company, 'plan-basic');
        expect(r).toMatchObject({ ownership: 'unknown', coverageTier: 'stable_snapshot' });
        expect(r.status).not.toBe('eligible');
        // R10: a clean rerun changes nothing (retired exactly once).
        const again = await full(f);
        expect(again).toMatchObject({ status: 'completed' });
        expect(again.quality.references_retired).toBeUndefined();
        expect(again.quality.tombstoned).toBeUndefined();
        expect(await refOf(f, 'cus-08')).toEqual(retired);
        expect(await rowCounts(f)).toEqual(countsAfter);
      });
    });

    it('R7a: seen-but-rejected — a structurally invalid customer is never retired (and never mapped) while an absent one is', async () => {
      await withFake(
        {
          accept: true,
          prepare: (fake) => {
            // A second customer without subscriptions, removed in the same run as the control.
            const t = fake.customers.find((x) => x.id === 'cus-23')!;
            fake.customers.push({
              ...structuredClone(t),
              id: 'cus-24',
              created_at: t.created_at + 1,
            });
          },
        },
        async (fake, f) => {
          await full(f);
          const company = (await refOf(f, 'cus-23'))!.company_id;
          const name = (await companyRow(company))!.name;
          // cus-23 has no subscription: only the customer read can protect it.
          fake.customers.find((x) => x.id === 'cus-23')!.resource_version = -5;
          removeCustomer(fake, 'cus-24');
          const run = await full(f);
          expect(run).toMatchObject({ status: 'completed' });
          expect(run.quality).toMatchObject({ record_rejected: 1, references_retired: 1 });
          // Protected because it was seen, not because the whole pass was suppressed.
          expect(run.quality.reference_retirement_suppressed).toBeUndefined();
          expect(await refOf(f, 'cus-24')).toMatchObject({ state: 'retired' });
          expect(await refOf(f, 'cus-23')).toMatchObject({ state: 'active', retired_at: null });
          expect(await companyRow(company)).toMatchObject({ name, record_state: 'active' });
        },
      );
    });

    it('R7b: a rejected customer without a readable id makes the whole retirement uncertain', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        await full(f);
        removeCustomer(fake, 'cus-23');
        const t = fake.customers.find((x) => x.id === 'cus-22')!;
        fake.customers.push({ ...structuredClone(t), id: 'bad id!', created_at: t.created_at + 1 });
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ reference_retirement_suppressed: 1 });
        expect(run.quality.references_retired).toBeUndefined();
        expect(await refOf(f, 'cus-23')).toMatchObject({ state: 'active' });
      });
    });

    it('R7c: no blind cascade — a customer absent from the customer read but referenced by a live subscription is not retired; a removed subscription leaves its (still listed) customer active', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        await full(f);
        removeCustomer(fake, 'cus-10');
        removeSubscription(fake, 'sub-07');
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality.references_retired).toBeUndefined();
        expect(await refOf(f, 'cus-10')).toMatchObject({ state: 'active' });
        expect((await lines(f)).get('sub-10:plan-basic-USD-monthly')!.record_state).toBe('active');
        expect(run.quality).toMatchObject({ tombstoned: 1 });
        expect(await refOf(f, 'cus-07')).toMatchObject({ state: 'active' });
      });
    });

    it('R-gates: unstable, failed and incremental runs never retire a reference', async () => {
      await withFake(
        { accept: true, config: { incrementalLines: 'verified' } },
        async (fake, f) => {
          await full(f);
          removeCustomer(fake, 'cus-23');
          // Unstable: a customer appears between the two enumerations.
          let calls = 0;
          fake.afterListPage = (path) => {
            if (path !== '/customers') return;
            calls += 1;
            if (calls === 1) {
              const t = fake.customers.find((x) => x.id === 'cus-22')!;
              fake.customers.push({
                ...structuredClone(t),
                id: 'cus-late',
                created_at: nowSeconds() - 120,
              });
            }
          };
          const unstable = await full(f);
          expect(unstable).toMatchObject({ status: 'failed', errorCode: 'unstable_read' });
          fake.afterListPage = undefined;
          removeCustomer(fake, 'cus-late');
          // Failed: the customer read completes, the run fails later.
          fake.fail({
            match: /^\/subscriptions$/,
            status: 403,
            times: 100,
            body: { api_error_code: 'api_authorization_failed' },
          });
          const failed = await full(f);
          expect(failed).toMatchObject({ status: 'failed' });
          fake.faults.length = 0;
          // Incremental: never an absence-based retirement.
          const inc = await runSync(c, f, 'incremental');
          expect(inc).toMatchObject({ status: 'completed' });
          expect(inc.quality.references_retired).toBeUndefined();
          expect(await refOf(f, 'cus-23')).toMatchObject({ state: 'active', retired_at: null });
          // The next accepted full run retires it.
          const ok = await full(f);
          expect(ok.quality).toMatchObject({ references_retired: 1 });
          expect(await refOf(f, 'cus-23')).toMatchObject({
            state: 'retired',
            retired_by_run_id: ok.runId,
          });
        },
      );
    });

    it('R3b: retirement is neutral to the company record state (its other source may still delete it, never the retirement)', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        await full(f);
        const company = (await refOf(f, 'cus-23'))!.company_id;
        removeCustomer(fake, 'cus-23');
        await full(f);
        expect(await refOf(f, 'cus-23')).toMatchObject({ state: 'retired' });
        // The same company is also known to HubSpot, which then deletes its record.
        await c.sql(
          `INSERT INTO company_external_refs (tenant_id, system, object_type, external_id, company_id)
           VALUES ($1, 'hubspot', 'companies', 'hs-r3b', $2)`,
          [f.ctx.tenantId, company],
        );
        const out = await c.ingestion.ingest(
          f.ctx,
          {
            kind: 'company',
            presence: 'absent',
            ref: { system: 'hubspot', objectType: 'companies', id: 'hs-r3b' },
            observedAt: new Date(),
          },
          { cause: 'backfill', correlationId: randomUUID() },
        );
        expect(out.decision).toBe('delete');
        // The retired Chargebee reference still counts: the company is not inferred gone.
        expect(await companyRow(company)).toMatchObject({ record_state: 'active' });
      });
    });

    it('R-restore: a retired customer read again is reactivated on the same company (no duplicate)', async () => {
      await withFake({ accept: true }, async (fake, f) => {
        await full(f);
        const company = (await refOf(f, 'cus-23'))!.company_id;
        const saved = structuredClone(fake.customers.find((x) => x.id === 'cus-23')!);
        removeCustomer(fake, 'cus-23');
        await full(f);
        expect(await refOf(f, 'cus-23')).toMatchObject({ state: 'retired' });
        const counts = await rowCounts(f);
        fake.customers.push(saved);
        const run = await full(f);
        expect(run).toMatchObject({ status: 'completed' });
        expect(await refOf(f, 'cus-23')).toMatchObject({
          state: 'active',
          retired_at: null,
          retired_by_run_id: null,
          company_id: company,
        });
        expect((await rowCounts(f)).companies).toBe(counts.companies);
        expect(await companyRow(company)).toMatchObject({ record_state: 'active' });
      });
    });
  });

  describe('incremental runs (CB15, CB27, V12)', () => {
    it('V12 unverified (default): incremental runs are refused; full runs only', async () => {
      await withFake({}, async (_fake, f) => {
        await full(f);
        await expect(
          sourcesServices(c).sync.start(f.ctx, f.connectionId, 'incremental', {
            enqueue: false,
            correlationId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'incremental_not_supported' });
      });
    });

    it('CB27/C16: an incremental run reads only changes, with overlap; never an absence-based tombstone', async () => {
      await withFake({ config: { incrementalLines: 'verified' } }, async (fake, f) => {
        const first = await full(f);
        const watermark = (
          await c.sql<{ high_watermark: Date }>(
            `SELECT high_watermark FROM tenant_sync_checkpoints WHERE id = $1`,
            [first.runId],
          )
        )[0]!.high_watermark;
        fake.touch('sub-10', (x) => (x.subscription_items[0]!.quantity = 7));
        removeSubscription(fake, 'sub-01');
        const before = fake.requests.length;
        const run = await runSync(c, f, 'incremental');
        expect(run).toMatchObject({ status: 'completed' });
        const req = fake.requests.slice(before).find((r) => r.path === '/subscriptions')!;
        expect(Number(req.query.get('updated_at[after]'))).toBeLessThanOrEqual(
          watermark.getTime() / 1000 - 10 * 60,
        );
        const all = await lines(f);
        expect(all.get('sub-10:plan-basic-USD-monthly')!.quantity).toBe(7);
        expect(all.get('sub-01:plan-basic-USD-monthly')!.record_state).toBe('active');
        expect(run.quality.tombstoned).toBeUndefined();
      });
    });

    it('CB15: a removed add-on is retired by G4 on an incremental run; the plan line stays', async () => {
      await withFake({ config: { incrementalLines: 'verified' } }, async (fake, f) => {
        await full(f);
        fake.touch('sub-15', (x) => {
          x.subscription_items = x.subscription_items.filter((i) => i.item_type === 'plan');
        });
        const run = await runSync(c, f, 'incremental');
        expect(run).toMatchObject({ status: 'completed' });
        expect(run.quality).toMatchObject({ child_retired: 1 });
        const all = await lines(f);
        expect(all.get('sub-15:addon-seats-USD-monthly')!.record_state).toBe('deleted');
        expect(all.get('sub-15:plan-basic-USD-monthly')!.record_state).toBe('active');
      });
    });
  });

  describe('connection tests (CB32, CB34) and read-only behaviour', () => {
    it('CB32: a Product Catalog 1.0 site is catalog_version_unsupported', async () => {
      await withFake({}, async (fake, f) => {
        fake.productCatalogV1 = true;
        await expect(sourcesServices(c).connections.test(f.ctx, f.connectionId)).resolves.toEqual({
          ok: false,
          code: 'catalog_version_unsupported',
        });
      });
    });

    it('CB34: a key without catalogue scope is forbidden at test and never a partial run', async () => {
      await withFake({}, async (fake, f) => {
        fake.fail({
          match: /^\/items$/,
          status: 403,
          times: 100,
          body: { api_error_code: 'api_authorization_failed' },
        });
        await expect(sourcesServices(c).connections.test(f.ctx, f.connectionId)).resolves.toEqual({
          ok: false,
          code: 'forbidden',
        });
        const run = await full(f);
        expect(run).toMatchObject({ status: 'failed', errorCode: 'source_forbidden' });
        expect(await lines(f)).toEqual(new Map());
      });
    });

    it('everything the platform sent to Chargebee was a GET to an allowlisted list endpoint', async () => {
      await withFake({ config: { incrementalLines: 'verified' } }, async (fake, f) => {
        await full(f);
        await runSync(c, f, 'incremental');
        await sourcesServices(c).connections.test(f.ctx, f.connectionId);
        expect(Object.keys(fake.methodCounts)).toEqual(['GET']);
        expect([...new Set(fake.requests.map((r) => r.path))].sort()).toEqual([
          '/customers',
          '/item_prices',
          '/items',
          '/subscriptions',
        ]);
      });
    });
  });

  describe('M9A profiling of Chargebee objects', () => {
    it('stored profiles and findings hold no key, no customer value and no payment data', async () => {
      await withFake({}, async (_fake, f) => {
        const dump = JSON.stringify([
          ...(await c.sql(`SELECT * FROM tenant_source_profiles WHERE tenant_id = $1`, [
            f.ctx.tenantId,
          ])),
          ...(await c.sql(`SELECT * FROM tenant_source_profile_findings WHERE tenant_id = $1`, [
            f.ctx.tenantId,
          ])),
          ...(await c.sql(`SELECT * FROM tenant_source_profile_runs WHERE tenant_id = $1`, [
            f.ctx.tenantId,
          ])),
        ]);
        expect(dump.length).toBeGreaterThan(1000);
        for (const forbidden of [
          'test_fakeChargebeeReadOnlyKey0001',
          'example.invalid',
          'Synthetic Co',
          'masked_number',
          '1111',
        ]) {
          expect(dump).not.toContain(forbidden);
        }
      });
    });

    it('a repeated next_offset fails a profile run with pagination_stalled (bounded)', async () => {
      await withFake({}, async (fake, f) => {
        fake.repeatOffsetFor = '/subscriptions';
        const before = fake.requests.length;
        const profiled = await runProfile(c, f, ['SubscriptionItems']);
        expect(profiled).toMatchObject({ status: 'failed', errorCode: 'pagination_stalled' });
        expect(fake.requests.slice(before).filter((r) => r.path === '/subscriptions').length).toBe(
          2,
        );
      });
    });
  });

  it('publication needs the covering profile and acknowledgements like any versioned source', async () => {
    const fake = await new FakeChargebee().start();
    try {
      seq += 1;
      const f = await chargebeeTenant(c, fake, { prefix: `cb${seq}`, stopAfter: 'snapshot' });
      const s = sourcesServices(c);
      const snapshot = await s.snapshots.latest(f.ctx, f.connectionId);
      const mapping = withSnapshot(chargebeeTestMapping(), snapshot!.hash);
      const report = await s.mappings.validate(f.ctx, f.connectionId, mapping);
      expect(report.ok).toBe(false);
      expect(report.errors.map((e) => e.code)).toContain('profile_required');
      expect(acknowledgementsFor(report)).toEqual([]);
      await runProfile(c, f, mappingObjects(mapping));
      await expect(publishWithAcks(c, f, mapping, 0)).rejects.toBeDefined();
    } finally {
      await fake.stop();
    }
  });
});
