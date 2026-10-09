import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  flowConfigurationProblems,
  LockTimeoutError,
  modeRequiresJev,
  TenantConfigError,
  tenantClient,
  type TenantContext,
} from '../../src/modules/tenancy';
import { appConfig, startInfrastructure, type TestInfrastructure } from '../support/containers';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';
import { authz } from '../support/security';

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
      // pg_stat_activity is snapshotted per transaction; clear it so each poll
      // sees backends that connected after the first one.
      await admin.query('SELECT pg_stat_clear_snapshot()');
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
      // Both requests must be blocked before the blocker is released: without the
      // fix both wait on the held rows after validating; with it, one waits on
      // the rows and the other on the tenant configuration lock.
      await waitForLockWaiters(admin, 2);
      await admin.query('COMMIT');
      return await results;
    } finally {
      await admin.end();
    }
  }

  it('a flow can never end up active while a required integration was concurrently lowered', async () => {
    const ctx = await provisionTenant(h, 'raceflow');
    await h.config.configureIntegration(await authz(ctx, 'config.integration'), 'hubspot', {
      access: 'read_write',
    });
    await h.config.configureIntegration(await authz(ctx, 'config.integration'), 'sugar', {
      access: 'read_write',
    });

    const [lower, activate] = await race(
      ctx,
      [
        "SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND system = 'sugar' FOR UPDATE",
        "SELECT 1 FROM tenant_flow_settings WHERE tenant_id = $1 AND flow = 'hubspot_to_sugar_handover' FOR UPDATE",
      ],
      async () =>
        h.config.configureIntegration(await authz(ctx, 'config.integration'), 'sugar', {
          access: 'read_only',
        }),
      async () =>
        h.config.setFlowMode(
          await authz(ctx, 'config.integration'),
          'hubspot_to_sugar_handover',
          'active',
        ),
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
    await h.config.configureIntegration(await authz(ctx, 'config.integration'), 'jev', {
      access: 'read_only',
    });
    const { version } = await h.config.getQualificationConfig(ctx);

    const [disable, hybrid] = await race(
      ctx,
      [
        "SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND system = 'jev' FOR UPDATE",
        'SELECT 1 FROM tenant_qualification_config WHERE tenant_id = $1 FOR UPDATE',
      ],
      async () =>
        h.config.configureIntegration(await authz(ctx, 'config.integration'), 'jev', {
          access: 'disabled',
        }),
      async () =>
        h.config.updateQualificationConfig(
          await authz(ctx, 'config.policy'),
          { mode: 'hybrid' },
          version,
        ),
    );

    const qualification = await h.config.getQualificationConfig(ctx);
    const jev = await h.config.getIntegration(ctx, 'jev');
    expect(modeRequiresJev(qualification.mode) && jev.access === 'disabled').toBe(false);
    expect([disable.status, hybrid.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = [disable, hybrid].find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(TenantConfigError);
  });

  it('Jev cannot be disabled (sequentially) while qualification depends on it', async () => {
    const ctx = await provisionTenant(h, 'seqjev');
    await h.config.configureIntegration(await authz(ctx, 'config.integration'), 'jev', {
      access: 'read_only',
    });
    const { version } = await h.config.getQualificationConfig(ctx);
    await h.config.updateQualificationConfig(
      await authz(ctx, 'config.policy'),
      { mode: 'jev' },
      version,
    );

    await expect(
      h.config.configureIntegration(await authz(ctx, 'config.integration'), 'jev', {
        access: 'disabled',
      }),
    ).rejects.toMatchObject({
      issues: [expect.stringMatching(/qualification mode "jev" needs the jev integration/)],
    });
    await expect(h.config.getIntegration(ctx, 'jev')).resolves.toMatchObject({
      access: 'read_only',
    });
  });

  it('many concurrent flip-flops never leave an invalid state', async () => {
    const ctx = await provisionTenant(h, 'raceloop');
    await h.config.configureIntegration(await authz(ctx, 'config.integration'), 'hubspot', {
      access: 'read_write',
    });
    await h.config.configureIntegration(await authz(ctx, 'config.integration'), 'sugar', {
      access: 'read_write',
    });
    for (let round = 0; round < 10; round++) {
      await Promise.allSettled([
        h.config.setFlowMode(
          await authz(ctx, 'config.integration'),
          'hubspot_to_sugar_handover',
          round % 2 ? 'off' : 'active',
        ),
        h.config.configureIntegration(await authz(ctx, 'config.integration'), 'sugar', {
          access: round % 2 ? 'read_write' : 'read_only',
        }),
        h.config.setFlowMode(
          await authz(ctx, 'config.integration'),
          'hubspot_to_sugar_handover',
          'active',
        ),
        h.config.configureIntegration(await authz(ctx, 'config.integration'), 'sugar', {
          access: 'disabled',
        }),
      ]);
      const flows = await h.config.listFlows(ctx);
      const access = Object.fromEntries(
        (await h.config.listIntegrations(ctx)).map((i) => [i.system, i.access]),
      );
      for (const f of flows) expect(flowConfigurationProblems(f.flow, f.mode, access)).toEqual([]);
    }
  });

  it('stays correct when the database default isolation level is REPEATABLE READ', async () => {
    const admin = new Client({ connectionString: infra.adminUrl });
    await admin.connect();
    await admin.query("ALTER ROLE lip_api SET default_transaction_isolation = 'repeatable read'");
    // New connections pick up the role default.
    const rr = await startTenancy(infra.config);
    try {
      const probe = await provisionTenant(rr, 'isocheck');
      const [row] = await rr.db.transaction(
        probe,
        (tx) =>
          tenantClient(tx).$queryRaw<
            { iso: string }[]
          >`SELECT current_setting('transaction_isolation') AS iso`,
      );
      const iso = row?.iso;
      expect(iso).toBe('repeatable read'); // the environment really is misconfigured

      const ctx = await provisionTenant(rr, 'racerr');
      await rr.config.configureIntegration(await authz(ctx, 'config.integration'), 'hubspot', {
        access: 'read_write',
      });
      await rr.config.configureIntegration(await authz(ctx, 'config.integration'), 'sugar', {
        access: 'read_write',
      });
      const [lower, activate] = await race(
        ctx,
        [
          "SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND system = 'sugar' FOR UPDATE",
          "SELECT 1 FROM tenant_flow_settings WHERE tenant_id = $1 AND flow = 'hubspot_to_sugar_handover' FOR UPDATE",
        ],
        async () =>
          rr.config.configureIntegration(await authz(ctx, 'config.integration'), 'sugar', {
            access: 'read_only',
          }),
        async () =>
          rr.config.setFlowMode(
            await authz(ctx, 'config.integration'),
            'hubspot_to_sugar_handover',
            'active',
          ),
      );
      const flows = await rr.config.listFlows(ctx);
      const access = Object.fromEntries(
        (await rr.config.listIntegrations(ctx)).map((i) => [i.system, i.access]),
      );
      for (const f of flows) expect(flowConfigurationProblems(f.flow, f.mode, access)).toEqual([]);
      expect([lower.status, activate.status].sort()).toEqual(['fulfilled', 'rejected']);
    } finally {
      await rr.close();
      await admin.query('ALTER ROLE lip_api RESET default_transaction_isolation');
      await admin.end();
    }
  });

  it('a busy tenant fails fast with a retryable LockTimeoutError, and other tenants are unaffected', async () => {
    const quick = await startTenancy(
      appConfig(infra.config.databaseUrl, infra.config.redisUrl, {
        DATABASE_LOCK_TIMEOUT_MS: '300',
      }),
    );
    const admin = new Client({ connectionString: infra.adminUrl });
    await admin.connect();
    try {
      const busy = await provisionTenant(quick, 'busyt');
      const other = await provisionTenant(quick, 'othert');
      await admin.query('BEGIN');
      await admin.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('tenant-config:' || $1, 0))",
        [busy.tenantId],
      );

      const started = Date.now();
      await expect(
        quick.config.setFlowMode(
          await authz(busy, 'config.integration'),
          'hubspot_to_sugar_handover',
          'off',
        ),
      ).rejects.toBeInstanceOf(LockTimeoutError);
      expect(Date.now() - started).toBeLessThan(5_000);
      // Another tenant's configuration is not blocked by this tenant's lock.
      await expect(
        quick.config.setFlowMode(
          await authz(other, 'config.integration'),
          'hubspot_to_sugar_handover',
          'off',
        ),
      ).resolves.toMatchObject({
        mode: 'off',
      });
      await admin.query('COMMIT');
      // Once free, the busy tenant works again.
      await expect(
        quick.config.setFlowMode(
          await authz(busy, 'config.integration'),
          'hubspot_to_sugar_handover',
          'off',
        ),
      ).resolves.toMatchObject({
        mode: 'off',
      });
    } finally {
      await admin.end();
      await quick.close();
    }
  });
});
