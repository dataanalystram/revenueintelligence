import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  operatorActor,
  SecretLikeValueError,
  SecurityActorSchema,
  sourceSyncActor,
} from '../../src/modules/domain';
import {
  AuditTrail,
  AuthorizationDeniedError,
  SecurityEventsService,
  SecurityOperationsService,
  tenantClient,
  WriteAuthorizer,
  type TenantContext,
} from '../../src/modules/tenancy';
import { startInfrastructure, withAdmin, type TestInfrastructure } from '../support/containers';
import { authz } from '../support/security';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/**
 * M10A1 audit behaviour on real PostgreSQL (app role, forced RLS):
 * S3 allowed → one event in the same transaction, S4 denied → one denied event
 * and no change, S5 fail closed, S6 details rules, S12 secret-like refusal on
 * configuration writes, S16 tenant isolation, S17 purge keeps newer events.
 */
describe('M10A1 audit trail behaviour', () => {
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
  afterEach(() => vi.restoreAllMocks());

  const admin = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    withAdmin(infra.adminUrl, async (db) => (await db.query<T>(text, params)).rows);
  const events = (t: TenantContext) =>
    admin<{
      seq: number;
      action: string;
      outcome: string;
      reason_code: string | null;
      actor_kind: string;
      actor_assurance: string;
      capability: string;
      details: Record<string, unknown>;
    }>(
      `SELECT seq, action, outcome, reason_code, actor_kind, actor_assurance, capability, details
         FROM tenant_audit_events WHERE tenant_id = $1 ORDER BY seq`,
      [t.tenantId],
    );
  const trail = () => h.app.get(AuditTrail, { strict: false });
  const securityEvents = () => {
    const service = h.app.get(SecurityEventsService, { strict: false });
    const emitted: Record<string, unknown>[] = [];
    vi.spyOn(service, 'emit').mockImplementation((e) => void emitted.push({ ...e }));
    return emitted;
  };

  describe('S3: an allowed operation writes one audit event in its own transaction', () => {
    it('one event per write, with actor, capability and asserted assurance', async () => {
      const t = await provisionTenant(h, 'allow');
      const before = (await events(t)).length;
      await h.config.configureIntegration(
        await authz(t, 'config.integration', operatorActor('ops-1')),
        'hubspot',
        { access: 'read_only' },
      );
      const after = await events(t);
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toMatchObject({
        action: 'integration.configure',
        outcome: 'allowed',
        actor_kind: 'operator',
        actor_assurance: 'asserted',
        capability: 'config.integration',
      });
    });

    it('a rollback removes the change and its event together', async () => {
      const t = await provisionTenant(h, 'rollback');
      const before = await events(t);
      const actx = await authz(t, 'config.integration');
      await expect(
        h.db.transaction(t, async (tx) => {
          await tenantClient(tx).tenantLeadSourceMapping.create({
            data: {
              tenantId: tx.tenantId,
              system: 'gainsight_px',
              sourceProperty: 'event',
              matchType: 'equals',
              sourceValue: 'feature_adopted',
              channel: 'product_usage',
              priority: 1,
            },
          });
          await trail().record(tx, actx, { action: 'lead_source_mapping.save' });
          throw new Error('business failure after the audit insert');
        }),
      ).rejects.toThrow(/business failure/);
      expect(await events(t)).toEqual(before);
      const [n] = await admin<{ n: number }>(
        'SELECT count(*)::int AS n FROM tenant_lead_source_mappings WHERE tenant_id = $1',
        [t.tenantId],
      );
      expect(n!.n).toBe(0);
    });
  });

  describe('S4: a denied operation writes one denied event and changes nothing', () => {
    it('policy denial (wrong actor kind, unsupported actor kind) is decided before any write', async () => {
      const t = await provisionTenant(h, 'deny');
      const before = await events(t);
      const integrations = await h.config.listIntegrations(t);
      const emitted = securityEvents();
      const authorizer = h.app.get(WriteAuthorizer, { strict: false });
      await expect(
        authorizer.authorize(t, sourceSyncActor('run:x'), 'config.integration', {
          action: 'integration.configure',
          targetKind: 'integration',
          targetRef: 'hubspot',
        }),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      await expect(
        authorizer.authorize(
          t,
          SecurityActorSchema.parse({
            kind: 'human_user',
            id: 'person-1',
            assurance: 'authenticated',
          }),
          'config.policy',
          {
            action: 'policy.save',
          },
        ),
      ).rejects.toThrow(/actor_kind_not_supported/);
      const after = await events(t);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toEqual([
        expect.objectContaining({
          action: 'integration.configure',
          outcome: 'denied',
          reason_code: 'capability_not_granted',
          actor_kind: 'source_sync',
        }),
        expect.objectContaining({
          action: 'policy.save',
          outcome: 'denied',
          reason_code: 'actor_kind_not_supported',
          actor_kind: 'human_user',
        }),
      ]);
      expect(await h.config.listIntegrations(t)).toEqual(integrations);
      expect(emitted.map((e) => [e.event, e.reasonCode])).toEqual([
        ['authz_denied', 'capability_not_granted'],
        ['authz_denied', 'actor_kind_not_supported'],
      ]);
    });

    it('identical denials within a minute are written once and counted', async () => {
      const t = await provisionTenant(h, 'coalesce');
      const authorizer = h.app.get(WriteAuthorizer, { strict: false });
      for (let i = 0; i < 3; i++) {
        await expect(
          authorizer.authorize(t, sourceSyncActor('run:y'), 'config.policy', {
            action: 'policy.save',
          }),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      }
      expect((await events(t)).filter((e) => e.outcome === 'denied')).toHaveLength(1);
    });
  });

  describe('S5: fail closed', () => {
    it('when the audit insert fails, the operation fails and nothing is changed', async () => {
      const t = await provisionTenant(h, 'failclosed');
      const before = await events(t);
      const integrations = await h.config.listIntegrations(t);
      // The insert itself fails (below `record`), so swallowing it anywhere would be caught.
      vi.spyOn(
        AuditTrail.prototype as unknown as { append: () => Promise<void> },
        'append',
      ).mockRejectedValue(new Error('audit store down'));
      await expect(
        h.config.configureIntegration(await authz(t, 'config.integration'), 'hubspot', {
          access: 'read_only',
        }),
      ).rejects.toThrow(/audit store down/);
      vi.restoreAllMocks();
      expect(await h.config.listIntegrations(t)).toEqual(integrations);
      expect(await events(t)).toEqual(before);
    });

    it('an audit append outside READ COMMITTED is refused (the head would be stale)', async () => {
      const t = await provisionTenant(h, 'iso');
      const actx = await authz(t, 'config.policy');
      await expect(
        h.db.transaction(t, (tx) => trail().record(tx, actx, { action: 'policy.save' }), {
          isolationLevel: 'RepeatableRead',
        }),
      ).rejects.toThrow(/READ COMMITTED transactions only/);
    });
  });

  describe('S6: audit details carry identifiers, codes and counts only', () => {
    it('refuses nested values, secret-like values and oversized details before writing', async () => {
      const t = await provisionTenant(h, 'details');
      const before = await events(t);
      const actx = await authz(t, 'config.policy');
      const jwtShaped = ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(16)].join('.');
      for (const details of [
        { nested: { a: 1 } },
        { token: jwtShaped },
        { big: 'x'.repeat(5000) },
      ] as never[]) {
        await expect(
          h.db.transaction(t, (tx) => trail().record(tx, actx, { action: 'policy.save', details })),
        ).rejects.toThrow();
      }
      expect(await events(t)).toEqual(before);
    });
  });

  describe('S12: configuration writes refuse secret-like values (denied, value never stored)', () => {
    it('policy, integration settings, lead-source mapping: refused, audited as denied, emitted with codes only', async () => {
      const t = await provisionTenant(h, 'secretcfg');
      const before = await events(t);
      const emitted = securityEvents();
      const shaped = ['sk', 'live', 'z'.repeat(24)].join('_');
      await expect(
        h.config.savePolicy(await authz(t, 'config.policy'), 'routing', {
          placeholder: true,
          notes: `rotate ${shaped}`,
        }),
      ).rejects.toBeInstanceOf(SecretLikeValueError);
      await expect(
        h.config.saveLeadSourceMapping(await authz(t, 'config.integration'), {
          system: 'gainsight_px',
          sourceProperty: 'event',
          matchType: 'equals',
          sourceValue: shaped,
          channel: 'product_usage',
        }),
      ).rejects.toBeInstanceOf(SecretLikeValueError);
      const after = await events(t);
      const denied = after.slice(before.length);
      expect(denied.map((e) => [e.action, e.outcome, e.reason_code])).toEqual([
        ['policy.save', 'denied', 'secret_like_value'],
        ['lead_source_mapping.save', 'denied', 'secret_like_value'],
      ]);
      expect(denied.every((e) => e.details.pattern === 'stripe_key')).toBe(true);
      expect(emitted.filter((e) => e.event === 'secret_like_refused')).toHaveLength(2);
      const everything = JSON.stringify(
        await admin(
          `SELECT row_to_json(x)::text AS r FROM (
             SELECT * FROM tenant_audit_events WHERE tenant_id = $1) x
           UNION ALL SELECT row_to_json(p)::text FROM tenant_policies p WHERE tenant_id = $1
           UNION ALL SELECT row_to_json(m)::text FROM tenant_lead_source_mappings m WHERE tenant_id = $1`,
          [t.tenantId],
        ),
      );
      expect(everything).not.toContain(shaped);
      expect(JSON.stringify(emitted)).not.toContain(shaped);
    });
  });

  describe('S16: audit tenant isolation (adversarial, app role)', () => {
    it("tenant B can neither read nor insert into tenant A's audit trail", async () => {
      const a = await provisionTenant(h, 'auda');
      const b = await provisionTenant(h, 'audb');
      const inB = <R>(work: (db: ReturnType<typeof tenantClient>) => Promise<R>) =>
        h.db.transaction(b, (tx) => work(tenantClient(tx)));
      const visible = await inB(
        (db) =>
          db.$queryRaw<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM tenant_audit_events WHERE tenant_id = ${a.tenantId}::uuid`,
      );
      expect(visible[0]!.n).toBe(0);
      await expect(
        inB(
          (db) =>
            db.$executeRaw`INSERT INTO tenant_audit_events (tenant_id, id, seq, occurred_at, actor_kind, actor_id,
              actor_assurance, capability, action, outcome, correlation_id, policy_version, details, prev_hash, hash)
              VALUES (${a.tenantId}::uuid, gen_random_uuid(), 999, now(), 'operator', 'x', 'asserted', 'config.policy',
                'policy.save', 'allowed', gen_random_uuid(), 1, '{}', ${'1'.repeat(64)}, ${'2'.repeat(64)})`,
        ),
      ).rejects.toThrow(/row-level security/);
      // The authorized context binds the tenant: an event cannot be recorded into another tenant.
      const actxA = await authz(a, 'config.policy');
      await expect(
        h.db.transaction(b, (tx) => trail().record(tx, actxA, { action: 'policy.save' })),
      ).rejects.toThrow(/does not match the transaction tenant/);
      await expect(trail().verify(a)).resolves.toMatchObject({ ok: true });
      await expect(trail().verify(b)).resolves.toMatchObject({ ok: true });
    });
  });

  describe('S17: the purge removes only events older than the class period', () => {
    it('older events go, newer events stay, the anchor links them, and the chain verifies', async () => {
      const t = await provisionTenant(h, 'partial');
      const actx = await authz(t, 'config.policy');
      for (let i = 0; i < 2; i++) {
        await h.db.transaction(t, (tx) => trail().record(tx, actx, { action: 'policy.save' }));
      }
      const old = await events(t);
      await new Promise((r) => setTimeout(r, 1500));
      const boundary = Date.now();
      await new Promise((r) => setTimeout(r, 1500));
      for (let i = 0; i < 2; i++) {
        await h.db.transaction(t, (tx) => trail().record(tx, actx, { action: 'policy.save' }));
      }
      const all = await events(t);
      // "now" such that the 365-day cut-off falls between the two batches.
      const now = new Date(boundary + 365 * 86_400_000);
      const ops = h.app.get(SecurityOperationsService, { strict: false });
      await expect(ops.purge(t, { execute: false, now })).resolves.toMatchObject({
        eligibleEvents: old.length,
        anchorSeq: old.at(-1)!.seq,
      });
      const result = await ops.purge(await authz(t, 'data.purge'), {
        execute: true,
        unapprovedExecutionForTests: true,
        now,
        ownerDatabaseUrl: infra.adminUrl,
      });
      expect(result).toMatchObject({ purged: old.length, anchorSeq: old.at(-1)!.seq });
      const kept = await events(t);
      expect(kept.map((e) => e.seq)).toEqual([
        ...all.slice(old.length).map((e) => e.seq),
        all.at(-1)!.seq + 1,
      ]);
      expect(kept.at(-1)).toMatchObject({ action: 'security.audit.purge', outcome: 'completed' });
      await expect(trail().verify(t)).resolves.toMatchObject({ ok: true, events: kept.length });
    });
  });
});
