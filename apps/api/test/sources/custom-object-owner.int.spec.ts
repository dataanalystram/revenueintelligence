import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MappingDocument } from '../../src/modules/domain';
import type { TenantContext } from '../../src/modules/tenancy';
import { advisoryLockKey } from '../../src/modules/tenancy/infrastructure/tenant-database';
import { CHAIN_LOCK_SCOPE } from '../../src/modules/tenancy/security/audit-trail';
import { appSession } from '../support/account-structure';
import { CHARGEBEE_CREDENTIAL, chargebeeSecretEnv } from '../support/chargebee';
import { startContextHarness, type ContextHarness } from '../support/context';
import { defaultDocument, enableExtension, publishExtension } from '../support/extension';
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

  /** Lock waits of the tenant's sessions (the barrier's waiters). */
  const waiting = async () =>
    Number(
      (await c.sql<{ n: string }>(`SELECT count(*)::text AS n FROM pg_locks WHERE NOT granted`))[0]!
        .n,
    );

  /**
   * Runs the publications concurrently behind the audit-chain barrier: both
   * pass validation, then wait; the barrier is released once both wait.
   */
  async function race(t: TenantContext, publications: (() => Promise<unknown>)[]) {
    const barrier = await appSession(c, t);
    const pending: Promise<unknown>[] = [];
    try {
      await barrier.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [
        advisoryLockKey(t.tenantId, CHAIN_LOCK_SCOPE, 'head').toString(),
      ]);
      for (const p of publications) pending.push(p());
      await c.until(async () => (await waiting()) >= publications.length, 30_000, 'both wait');
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
});
