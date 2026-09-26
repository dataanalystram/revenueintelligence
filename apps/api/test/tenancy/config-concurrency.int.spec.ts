import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  flowConfigurationProblems,
  modeRequiresJev,
  TenantConfigError,
  type TenantContext,
} from '../../src/modules/tenancy';
import { startInfrastructure, type TestInfrastructure } from '../support/containers';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/**
 * Regression tests for a check-then-act race between concurrent admin requests
 * (found in the Milestone 2 review): each request validated against state the
 * other was about to change, so both committed and left an invalid
 * configuration.
 *
 * The interleaving is forced deterministically: an owner connection holds row
 * locks on the rows both requests will write, so both requests perform their
 * validation reads, then block on their writes. Only after both are waiting
 * is the blocker released.
 */
describe('tenant configuration invariants under concurrent admin requests', () => {
  let infra: TestInfrastructure;
  let h: TenancyHarness;

  beforeAll(async () => {
    infra = await startInfrastructure();
    h = await startTenancy(infra.config);
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  async function waitForLockWaiters(admin: Client, count: number): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const { rows } = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'lip_api' AND wait_event_type = 'Lock'",
      );
      if ((rows[0]?.n ?? 0) >= count) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`expected ${count} requests waiting on locks`);
  }

  /** Runs two admin operations with both forced past their reads before either writes. */
  async function race<A, B>(
    ctx: TenantContext,
    lockSql: string[],
    first: () => Promise<A>,
    second: () => Promise<B>,
  ): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
    const admin = new Client({ connectionString: infra.adminUrl });
    await admin.connect();
    try {
      await admin.query('BEGIN');
      for (const sql of lockSql) await admin.query(sql, [ctx.tenantId]);
      const results = Promise.allSettled([first(), second()]);
      // Both requests are blocked: either on the held rows, or on each other.
      await waitForLockWaiters(admin, 2).catch(() => waitForLockWaiters(admin, 1));
      await new Promise((r) => setTimeout(r, 200));
      await admin.query('COMMIT');
      return await results;
    } finally {
      await admin.end();
    }
  }

  it('a flow can never end up active while a required integration was concurrently lowered', async () => {
    const ctx = await provisionTenant(h, 'raceflow');
    await h.config.configureIntegration(ctx, 'hubspot', { access: 'read_write' });
    await h.config.configureIntegration(ctx, 'sugar', { access: 'read_write' });

    const [lower, activate] = await race(
      ctx,
      [
        "SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND system = 'sugar' FOR UPDATE",
        "SELECT 1 FROM tenant_flow_settings WHERE tenant_id = $1 AND flow = 'hubspot_to_sugar_handover' FOR UPDATE",
      ],
      () => h.config.configureIntegration(ctx, 'sugar', { access: 'read_only' }),
      () => h.config.setFlowMode(ctx, 'hubspot_to_sugar_handover', 'active'),
    );

    const flows = await h.config.listFlows(ctx);
    const access = Object.fromEntries(
      (await h.config.listIntegrations(ctx)).map((i) => [i.system, i.access]),
    );
    const handover = flows.find((f) => f.flow === 'hubspot_to_sugar_handover')!;
    // The invariant holds...
    expect(flowConfigurationProblems(handover.flow, handover.mode, access)).toEqual([]);
    // ...because exactly one request won and the other was refused after seeing the winner's change.
    const outcomes = [lower.status, activate.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const rejected = [lower, activate].find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(TenantConfigError);
  });

  it('Jev can never be disabled while a concurrent request switches qualification to hybrid', async () => {
    const ctx = await provisionTenant(h, 'racejev');
    await h.config.configureIntegration(ctx, 'jev', { access: 'read_only' });
    const { version } = await h.config.getQualificationConfig(ctx);

    const [disable, hybrid] = await race(
      ctx,
      [
        "SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND system = 'jev' FOR UPDATE",
        'SELECT 1 FROM tenant_qualification_config WHERE tenant_id = $1 FOR UPDATE',
      ],
      () => h.config.configureIntegration(ctx, 'jev', { access: 'disabled' }),
      () => h.config.updateQualificationConfig(ctx, { mode: 'hybrid' }, version),
    );

    const qualification = await h.config.getQualificationConfig(ctx);
    const jev = await h.config.getIntegration(ctx, 'jev');
    expect(modeRequiresJev(qualification.mode) && jev.access === 'disabled').toBe(false);
    expect([disable.status, hybrid.status].sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('Jev cannot be disabled (sequentially) while qualification depends on it', async () => {
    const ctx = await provisionTenant(h, 'seqjev');
    await h.config.configureIntegration(ctx, 'jev', { access: 'read_only' });
    const { version } = await h.config.getQualificationConfig(ctx);
    await h.config.updateQualificationConfig(ctx, { mode: 'jev' }, version);

    await expect(
      h.config.configureIntegration(ctx, 'jev', { access: 'disabled' }),
    ).rejects.toMatchObject({
      issues: [expect.stringMatching(/qualification mode "jev" needs the jev integration/)],
    });
    await expect(h.config.getIntegration(ctx, 'jev')).resolves.toMatchObject({
      access: 'read_only',
    });
  });

  it('many concurrent flip-flops never leave an invalid state', async () => {
    const ctx = await provisionTenant(h, 'raceloop');
    await h.config.configureIntegration(ctx, 'hubspot', { access: 'read_write' });
    await h.config.configureIntegration(ctx, 'sugar', { access: 'read_write' });
    for (let round = 0; round < 10; round++) {
      await Promise.allSettled([
        h.config.setFlowMode(ctx, 'hubspot_to_sugar_handover', round % 2 ? 'off' : 'active'),
        h.config.configureIntegration(ctx, 'sugar', {
          access: round % 2 ? 'read_write' : 'read_only',
        }),
        h.config.setFlowMode(ctx, 'hubspot_to_sugar_handover', 'active'),
        h.config.configureIntegration(ctx, 'sugar', { access: 'disabled' }),
      ]);
      const flows = await h.config.listFlows(ctx);
      const access = Object.fromEntries(
        (await h.config.listIntegrations(ctx)).map((i) => [i.system, i.access]),
      );
      for (const f of flows) expect(flowConfigurationProblems(f.flow, f.mode, access)).toEqual([]);
    }
  });
});
