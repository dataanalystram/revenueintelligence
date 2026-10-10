import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PersonIdSchema } from '../../src/modules/domain';
import { tenantClient, type TenantContext } from '../../src/modules/tenancy';
import { appConfig, startInfrastructure, type TestInfrastructure } from '../support/containers';
import { person, provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';
import { authz } from '../support/security';

/**
 * Many tenants working at once through a shared connection pool must never
 * see or affect each other, whatever the interleaving.
 */
describe('concurrent multi-tenant operations', () => {
  let infra: TestInfrastructure;
  let h: TenancyHarness;
  let tiny: TenancyHarness;
  let tenants: TenantContext[];

  beforeAll(async () => {
    infra = await startInfrastructure();
    h = await startTenancy(infra.config);
    // A pool of 2 connections forces heavy connection reuse between tenants.
    tiny = await startTenancy(
      appConfig(infra.config.databaseUrl, infra.config.redisUrl, { DATABASE_POOL_MAX: '2' }),
    );
    tenants = await Promise.all(
      Array.from({ length: 6 }, (_, i) => provisionTenant(h, `conc${i}x`)),
    );
  });

  afterAll(async () => {
    await tiny?.close();
    await h?.close();
    await infra?.stop();
  });

  it('parallel writes and reads from 6 tenants stay isolated', async () => {
    const perTenant = 15;
    const written = new Map<string, Set<string>>();

    await Promise.all(
      tenants.flatMap((ctx) =>
        Array.from({ length: perTenant }, async (_, i) => {
          const id = PersonIdSchema.parse(randomUUID());
          await h.db.transaction(ctx, async (tx) => {
            await h.persons.save(
              tx,
              person(ctx.tenantId, id, { primaryEmail: `p${i}-${id.slice(0, 8)}@x.example` }),
            );
            // Read back inside the same transaction, interleaved with other tenants.
            const seen = await tenantClient(tx).$queryRaw<
              { tenant_id: string }[]
            >`SELECT DISTINCT tenant_id::text FROM persons`;
            expect(seen.every((r) => r.tenant_id === ctx.tenantId)).toBe(true);
          });
          const ids = written.get(ctx.tenantId) ?? new Set<string>();
          ids.add(id);
          written.set(ctx.tenantId, ids);
        }),
      ),
    );

    for (const ctx of tenants) {
      const ids = await h.db.transaction(ctx, (tx) =>
        tenantClient(tx).person.findMany({ select: { id: true, tenantId: true } }),
      );
      expect(ids).toHaveLength(perTenant);
      expect(ids.every((r) => r.tenantId === ctx.tenantId)).toBe(true);
      expect(new Set(ids.map((r) => r.id))).toEqual(written.get(ctx.tenantId));
    }
  });

  it('interleaved transactions on a 2-connection pool never observe another tenant', async () => {
    const rounds = 60;
    const observations = await Promise.all(
      Array.from({ length: rounds }, (_, i) => {
        const ctx = tenants[i % tenants.length]!;
        return tiny.db.transaction(ctx, async (tx) => {
          const [row] = await tenantClient(tx).$queryRaw<{ current: string }[]>`
            SELECT current_setting('app.current_tenant') AS current`;
          // Yield so other transactions queue up on the same connections.
          await new Promise((resolve) => setTimeout(resolve, i % 3));
          const tenantsSeen = await tenantClient(tx).$queryRaw<
            { id: string }[]
          >`SELECT id::text FROM tenants`;
          return {
            expected: ctx.tenantId,
            current: row?.current,
            tenantsSeen: tenantsSeen.map((t) => t.id),
          };
        });
      }),
    );
    for (const o of observations) {
      expect(o.current).toBe(o.expected);
      expect(o.tenantsSeen).toEqual([o.expected]);
    }
    // Prove the pool really is 2 connections, i.e. connections were reused across tenants.
    const pids = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tiny.db.transaction(tenants[i % tenants.length]!, async (tx) => {
          const [row] = await tenantClient(tx).$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          return row!.pid;
        }),
      ),
    );
    expect(new Set(pids).size).toBeLessThanOrEqual(2);
  });

  it('a failing transaction in one tenant does not disturb concurrent work in others', async () => {
    const [bad, ...good] = tenants;
    const results = await Promise.allSettled([
      ...Array.from({ length: 5 }, () =>
        tiny.db.transaction(bad!, async (tx) => {
          await tenantClient(tx).$queryRaw`SELECT 1`;
          throw new Error('deliberate failure');
        }),
      ),
      ...good.map((ctx) =>
        tiny.db.transaction(ctx, async (tx) => {
          const [row] = await tenantClient(tx).$queryRaw<
            { current: string }[]
          >`SELECT current_setting('app.current_tenant') AS current`;
          return row?.current === ctx.tenantId;
        }),
      ),
    ]);
    expect(results.slice(0, 5).every((r) => r.status === 'rejected')).toBe(true);
    expect(results.slice(5).every((r) => r.status === 'fulfilled' && r.value === true)).toBe(true);
  });

  it('concurrent config updates in different tenants do not conflict; same-tenant races are detected', async () => {
    const [t1, t2] = tenants;
    const [c1, c2] = await Promise.all([
      h.config.getQualificationConfig(t1!),
      h.config.getQualificationConfig(t2!),
    ]);
    await Promise.all([
      h.config.updateQualificationConfig(
        await authz(t1!, 'config.policy'),
        { mode: 'rules', rulesetVersion: 'r-1' },
        c1.version,
      ),
      h.config.updateQualificationConfig(
        await authz(t2!, 'config.policy'),
        { mode: 'rules', rulesetVersion: 'r-2' },
        c2.version,
      ),
    ]);
    await expect(h.config.getQualificationConfig(t1!)).resolves.toMatchObject({
      rulesetVersion: 'r-1',
    });
    await expect(h.config.getQualificationConfig(t2!)).resolves.toMatchObject({
      rulesetVersion: 'r-2',
    });

    // Two writers racing on the same tenant with the same expected version: exactly one wins.
    const current = await h.config.getQualificationConfig(t1!);
    const race = await Promise.allSettled([
      h.config.updateQualificationConfig(
        await authz(t1!, 'config.policy'),
        { mode: 'rules', rulesetVersion: 'winner-a' },
        current.version,
      ),
      h.config.updateQualificationConfig(
        await authz(t1!, 'config.policy'),
        { mode: 'rules', rulesetVersion: 'winner-b' },
        current.version,
      ),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});
