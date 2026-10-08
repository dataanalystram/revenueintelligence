import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExternalRef } from '../../src/modules/domain';
import { COMPANY_REPOSITORY, type CompanyRepository } from '../../src/modules/identity';
import {
  EligibilityService,
  SnapshotNotFoundError,
  UnknownCompanyError,
} from '../../src/modules/products';
import { SubscriptionQueries } from '../../src/modules/products/infrastructure/subscription.queries';
import { tenantClient, type TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { genericModel } from '../support/product-models';

/**
 * M7 eligibility (ADR 0018): on-demand evaluation and whitespace from one
 * consistent load, frozen snapshots and their replay, merge lineage, and
 * behaviour under concurrent subscription changes and publication.
 */
describe('eligibility: evaluate, whitespace, snapshots, replay', () => {
  let c: ContextHarness;
  let eligibility: EligibilityService;

  beforeAll(async () => {
    c = await startContextHarness();
    eligibility = c.app.get(EligibilityService);
  });
  afterAll(async () => {
    await c?.close();
  });

  const enc = (text: string) => new TextEncoder().encode(text);
  const HEADER = 'record_id,account,product,state,starts_at,ends_at,quantity,source_updated_at';
  const csv = (...rows: string[]) => enc([HEADER, ...rows].join('\n') + '\n');
  const hs = (id: string): ExternalRef => ({ system: 'hubspot', objectType: 'companies', id });
  const full = (t: TenantContext, ...rows: string[]) =>
    c.h.imports.import(t, csv(...rows), {
      source: 'billing',
      mode: 'full',
      execute: true,
      correlationId: randomUUID(),
    });

  async function setup(
    prefix: string,
    ids: string[],
  ): Promise<{ t: TenantContext; company: Record<string, string> }> {
    const t = await c.tenant(prefix, 1001);
    await c.h.catalogue.publish(t, genericModel(), {
      actor: 'test',
      basedOnVersion: 0,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const company: Record<string, string> = {};
    for (const id of ids) {
      const r = await c.ingestion.ingest(
        t,
        {
          kind: 'company',
          presence: 'present',
          ref: hs(id),
          observedAt: new Date(),
          fields: { name: `Company ${id}` },
        },
        { cause: 'webhook', correlationId: randomUUID() },
      );
      company[id] = r.entityId!;
    }
    return { t, company };
  }
  const record = () => ({ purpose: 'test_evidence', correlationId: randomUUID() });

  it('is unknown before ownership coverage, then decides from the facts', async () => {
    const { t, company } = await setup('elg', ['901']);
    const before = await eligibility.evaluate(t, company['901']!, 'analytics');
    expect(before).toMatchObject({ status: 'unknown', ownership: 'unknown' });
    expect(before.checks.find((ch) => ch.check === 'ownership_coverage')).toMatchObject({
      outcome: 'unknown',
      reason: 'ownership_not_loaded',
    });
    const ws0 = await eligibility.whitespace(t, company['901']!);
    expect(ws0.categories.eligible_whitespace).toEqual([]); // never inferred from no data

    await full(t, 'E1,hubspot:companies:901,core,active,2026-01-01T00:00:00Z,,,');
    await expect(eligibility.evaluate(t, company['901']!, 'core')).resolves.toMatchObject({
      status: 'ineligible',
      ownership: 'owned',
    });
    // INTENDED CHANGE (M9A, A2): CSV coverage is `stable_snapshot`. Absence from an
    // operator-declared file is not proof of non-ownership. M7/M8 expected
    // `eligible` / `not_owned` here; it is now `unknown` (`coverage_tier_insufficient`).
    const analytics = await eligibility.evaluate(t, company['901']!, 'analytics');
    expect(analytics).toMatchObject({
      status: 'unknown',
      ownership: 'unknown',
      coverageTier: 'stable_snapshot',
    });
    expect(analytics.checks.find((ch) => ch.check === 'ownership_coverage')).toMatchObject({
      outcome: 'unknown',
      reason: 'coverage_tier_insufficient',
    });
    const onprem = await eligibility.evaluate(t, company['901']!, 'onprem');
    expect(onprem.status).toBe('ineligible');
    expect(onprem.checks.find((ch) => ch.check === 'not_excluded')).toMatchObject({
      outcome: 'fail',
      reason: 'excluded_by_owned',
    });
    const retired = await eligibility.evaluate(t, company['901']!, 'legacy-reports');
    expect(retired.checks.find((ch) => ch.check === 'product_available')).toMatchObject({
      outcome: 'fail',
      reason: 'product_retired',
    });

    const ws = await eligibility.whitespace(t, company['901']!);
    const keys = (cat: keyof typeof ws.categories) => ws.categories[cat].map((r) => r.productKey);
    expect(keys('owned')).toEqual(['core']);
    // INTENDED CHANGE (A2): no eligible whitespace from CSV coverage. M7/M8 listed
    // analytics, core-pro, reporting and suite here; they are now unknown.
    expect(keys('eligible_whitespace')).toEqual([]);
    expect(keys('unknown')).toEqual(
      expect.arrayContaining(['analytics', 'core-pro', 'reporting', 'suite']),
    );
    // A presence-based fail (owned exclusion, retired product) still decides.
    expect(keys('ineligible_whitespace')).toEqual(
      expect.arrayContaining(['legacy-reports', 'onprem']),
    );
    expect(ws).toMatchObject({
      requestedCompanyId: company['901'],
      evaluatedCompanyId: company['901'],
      modelVersion: 1,
    });

    // A future-dated line is not owned yet; at its start it is.
    await full(
      t,
      'E1,hubspot:companies:901,core,active,2026-01-01T00:00:00Z,,,',
      'E2,hubspot:companies:901,reporting,active,2030-01-01T00:00:00Z,,,',
    );
    // INTENDED CHANGE (A2): not yet started is `unknown` under CSV coverage (was `not_owned`).
    await expect(eligibility.evaluate(t, company['901']!, 'reporting')).resolves.toMatchObject({
      ownership: 'unknown',
    });
    await expect(
      eligibility.evaluate(t, company['901']!, 'reporting', {
        asOf: new Date('2030-01-01T00:00:00Z'),
      }),
    ).resolves.toMatchObject({ ownership: 'owned' });
    // Timezone boundary: 2029-12-31T23:59:59.999Z is still before the start.
    await expect(
      eligibility.evaluate(t, company['901']!, 'reporting', {
        asOf: new Date('2029-12-31T23:59:59.999Z'),
      }),
    ).resolves.toMatchObject({ ownership: 'unknown' });
  });

  it('records frozen snapshots that replay exactly, even after the facts change', async () => {
    const { t, company } = await setup('snap', ['911']);
    await full(t, 'S1,hubspot:companies:911,core,active,,,,');
    const r = await eligibility.evaluate(t, company['911']!, 'analytics', { record: record() });
    expect(r.snapshotId).toBeDefined();
    const snap = await eligibility.snapshot(t, r.snapshotId!);
    expect(snap).toMatchObject({
      requestedCompanyId: company['911'],
      evaluatedCompanyId: company['911'],
      productKey: 'analytics',
      // INTENDED CHANGE (A2, evaluator 3): was eligible / not_owned / evaluator 2.
      status: 'unknown',
      ownership: 'unknown',
      modelVersion: 1,
      modelHash: r.modelHash,
      evaluatorVersion: 3,
      factsHash: r.factsHash,
      purpose: 'test_evidence',
    });
    // Frozen input: identifiers, codes and dates only (no names).
    expect(JSON.stringify(snap.result)).not.toContain('Company 911');
    await expect(eligibility.replay(t, r.snapshotId!)).resolves.toMatchObject({
      reproduced: true,
      reason: 'reproduced',
    });

    // Facts change (analytics bought): live answer changes, the snapshot replays unchanged.
    await full(
      t,
      'S1,hubspot:companies:911,core,active,,,,',
      'S2,hubspot:companies:911,analytics,active,,,,',
    );
    await expect(eligibility.evaluate(t, company['911']!, 'analytics')).resolves.toMatchObject({
      status: 'ineligible',
      ownership: 'owned',
    });
    await expect(eligibility.replay(t, r.snapshotId!)).resolves.toMatchObject({
      reproduced: true,
      recorded: { status: 'unknown' },
    });

    // A new model version does not change what the snapshot was evaluated against.
    await c.h.catalogue.publish(
      t,
      genericModel({
        relationships: genericModel().relationships!.filter((x) => x.id !== 'cloud-or-onprem'),
      }),
      {
        actor: 'test',
        basedOnVersion: 1,
      },
    );
    await expect(eligibility.replay(t, r.snapshotId!)).resolves.toMatchObject({ reproduced: true });

    // Append-only, and errors for unknown ids.
    await expect(
      c.h.db.transaction(
        t,
        (tx) => tenantClient(tx).$executeRaw`UPDATE tenant_eligibility_snapshots SET purpose = 'x'`,
      ),
    ).rejects.toThrow(/UPDATE on tenant_eligibility_snapshots is not allowed/);
    // Replay safety (M8 bumped the evaluator to 2, M9A to 3): a snapshot recorded
    // by an older evaluator is never reinterpreted by the current one.
    const oldId = randomUUID();
    await c.sql(
      `INSERT INTO tenant_eligibility_snapshots (tenant_id, id, requested_company_id, evaluated_company_id,
         product_key, as_of, status, ownership, model_version, model_hash, evaluator_version, facts_hash,
         result, purpose, correlation_id)
       SELECT tenant_id, $2, requested_company_id, evaluated_company_id, product_key, as_of, status,
              ownership, model_version, model_hash, 1, facts_hash, result, purpose, correlation_id
         FROM tenant_eligibility_snapshots WHERE tenant_id = $1 AND id = $3`,
      [t.tenantId, oldId, r.snapshotId],
    );
    await expect(eligibility.replay(t, oldId)).resolves.toMatchObject({
      reproduced: false,
      reason: 'evaluator_changed',
      recorded: { status: 'unknown' },
    });
    await expect(eligibility.replay(t, randomUUID())).rejects.toBeInstanceOf(SnapshotNotFoundError);
    await expect(eligibility.evaluate(t, randomUUID(), 'core')).rejects.toBeInstanceOf(
      UnknownCompanyError,
    );
    await expect(eligibility.evaluate(t, company['911']!, 'no-such')).rejects.toThrow(
      /not in the product model/,
    );
  });

  it('a merged-away company is evaluated as its survivor, and the snapshot records both', async () => {
    const { t, company } = await setup('lin', ['921', '922']);
    await full(t, 'A1,hubspot:companies:922,core,active,,,,');
    await c.ingestion.ingestMerge(
      t,
      { kind: 'company', survivor: hs('921'), merged: [hs('922')], observedAt: new Date() },
      { cause: 'webhook', correlationId: randomUUID() },
    );
    const r = await eligibility.evaluate(t, company['922']!, 'core', { record: record() });
    expect(r).toMatchObject({
      requestedCompanyId: company['922'],
      evaluatedCompanyId: company['921'],
      ownership: 'owned',
    });
    await expect(eligibility.snapshot(t, r.snapshotId!)).resolves.toMatchObject({
      requestedCompanyId: company['922'],
      evaluatedCompanyId: company['921'],
    });
  });

  it('whitespace loads facts once regardless of catalogue size (no N+1)', async () => {
    const { t, company } = await setup('n1', ['931']);
    const many = genericModel({
      products: [
        ...genericModel().products,
        ...Array.from({ length: 300 }, (_, i) => ({ key: `extra-${i}`, name: `Extra ${i}` })),
      ],
    });
    await c.h.catalogue.publish(t, many, { actor: 'test', basedOnVersion: 1 });
    await full(t, 'N1,hubspot:companies:931,core,active,,,,');
    const queries = c.app.get(SubscriptionQueries);
    const companies = c.app.get<CompanyRepository>(COMPANY_REPOSITORY);
    const facts = vi.spyOn(queries, 'factsForCompany');
    const find = vi.spyOn(companies, 'findById');
    try {
      const ws = await eligibility.whitespace(t, company['931']!);
      const total = Object.values(ws.categories).reduce((n, list) => n + list.length, 0);
      expect(total).toBe(308);
      expect(facts).toHaveBeenCalledTimes(1);
      expect(find.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      facts.mockRestore();
      find.mockRestore();
    }
  });

  it('under concurrent imports, publishes and snapshot creation every recorded result is consistent and replays', async () => {
    const { t, company } = await setup('cc', ['941']);
    await full(t, 'C1,hubspot:companies:941,core,active,,,,');
    const evaluations = Array.from({ length: 12 }, () =>
      eligibility.evaluate(t, company['941']!, 'analytics', { record: record() }),
    );
    const churn = [
      full(
        t,
        'C1,hubspot:companies:941,core,active,,,,',
        'C2,hubspot:companies:941,analytics,active,,,,',
      ),
      // Two publishes from the same base: one wins, the other gets concurrent_publish.
      c.h.catalogue.publish(t, genericModel(), { actor: 'test', basedOnVersion: 1 }),
      c.h.catalogue.publish(t, genericModel(), { actor: 'test', basedOnVersion: 1 }),
    ];
    const settled = await Promise.allSettled([...evaluations, ...churn]);
    const failures = settled.filter((s) => s.status === 'rejected');
    // A concurrent full import may refuse to start while another runs, and one of the two
    // same-base publishes must lose with concurrent_publish; nothing else may fail.
    expect(failures.every((f) => /already running|concurrent_publish/.test(String(f.reason)))).toBe(
      true,
    );
    const results = settled
      .slice(0, 12)
      .map((s) => (s as PromiseFulfilledResult<Awaited<(typeof evaluations)[number]>>).value);
    expect(new Set(results.map((r) => r.snapshotId)).size).toBe(12);
    for (const r of results) {
      await expect(eligibility.replay(t, r.snapshotId!)).resolves.toMatchObject({
        reproduced: true,
      });
      // Status and facts agree: analytics is eligible iff it was not yet owned in that picture.
      expect(r.status === 'eligible').toBe(r.ownership === 'not_owned');
    }
    await expect(eligibility.listSnapshots(t, { companyId: company['941'] })).resolves.toHaveLength(
      12,
    );
  });

  it('snapshots are invisible across tenants', async () => {
    const a = await setup('sna', ['951']);
    const b = await setup('snb', ['951']);
    await full(b.t, 'B1,hubspot:companies:951,core,active,,,,');
    const r = await eligibility.evaluate(b.t, b.company['951']!, 'core', { record: record() });
    await expect(eligibility.snapshot(a.t, r.snapshotId!)).rejects.toBeInstanceOf(
      SnapshotNotFoundError,
    );
    await expect(eligibility.listSnapshots(a.t)).resolves.toEqual([]);
    await expect(
      c.h.db.transaction(
        a.t,
        (tx) =>
          tenantClient(tx).$queryRaw<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM tenant_eligibility_snapshots`,
      ),
    ).resolves.toEqual([{ n: 0 }]);
  });
});
