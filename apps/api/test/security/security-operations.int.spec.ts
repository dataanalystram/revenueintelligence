import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authorizeOperator, OperatorIdRequiredError } from '../../src/cli/operator';
import { operatorActor } from '../../src/modules/domain';
import {
  AuditPurgeDisabledError,
  AuditTrail,
  SecurityEventsService,
  SecurityOperationsService,
  tenantClient,
  type TenantContext,
} from '../../src/modules/tenancy';
import { EncryptedDatabaseOAuthGrantStore } from '../../src/modules/tenancy/infrastructure/encrypted-oauth-grant.store';
import { TokenCipher, TokenKeyError, type TokenCipherSource } from '../../src/platform/crypto';
import { Secret } from '../../src/platform/secrets';
import { startInfrastructure, withAdmin, type TestInfrastructure } from '../support/containers';
import { authz } from '../support/security';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/**
 * M10A1 security operations on real PostgreSQL (app role, forced RLS):
 * S14 key rotation (v1 read, v2 write, unknown key id, rekey, key usage),
 * S23 audit-chain concurrency, S24 operator id required, S25 audit purge
 * disabled (report mode; execution only through the test override).
 */
describe('M10A1 security operations', () => {
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
  const auditRows = (t: TenantContext) =>
    admin<{
      seq: number;
      action: string;
      outcome: string;
      reason_code: string | null;
      details: Record<string, unknown>;
      prev_hash: string;
      hash: string;
    }>(
      'SELECT seq, action, outcome, reason_code, details, prev_hash, hash FROM tenant_audit_events WHERE tenant_id = $1 ORDER BY seq',
      [t.tenantId],
    );
  const key = () => new Secret(randomBytes(32).toString('base64'));
  const grant = (n: string) => ({
    accountId: '1001',
    refreshToken: new Secret(`refresh-${n}`),
    accessToken: { token: new Secret(`access-${n}`), expiresAt: new Date(Date.now() + 3_600_000) },
    scopes: ['crm.objects.companies.read'],
  });
  /** Services wired to an explicit cipher (a rotation is a change of the keyring). */
  const withCipher = (cipher: TokenCipher) => {
    const source = { get: () => Promise.resolve(cipher) } as unknown as TokenCipherSource;
    const events = h.app.get(SecurityEventsService, { strict: false });
    const store = new EncryptedDatabaseOAuthGrantStore(h.db, source, events);
    const ops = new SecurityOperationsService(
      h.db,
      h.app.get(AuditTrail, { strict: false }),
      store,
      events,
    );
    return { store, ops };
  };
  const ops = () => h.app.get(SecurityOperationsService, { strict: false });

  describe('S14: key rotation', () => {
    it('encrypt k1 → rotate → read k1 → rekey → read k2 → retire k1; audited, counts only', async () => {
      const t = await provisionTenant(h, 'rot');
      const k1 = key();
      const k2 = key();
      const before = withCipher(new TokenCipher(k1, { kid: 'k1' }));
      await before.store.put(t, 'hubspot', grant('a'));
      await expect(before.ops.keyUsage(t)).resolves.toEqual({
        currentKeyId: 'k1',
        byKeyId: { k1: 2 },
        needingRekey: 0,
      });

      const rotated = withCipher(
        new TokenCipher(k2, { kid: 'k2', others: [{ kid: 'k1', key: k1 }] }),
      );
      expect((await rotated.store.get(t, 'hubspot'))!.refreshToken.reveal()).toBe('refresh-a');
      await expect(rotated.ops.keyUsage(t)).resolves.toMatchObject({
        byKeyId: { k1: 2 },
        needingRekey: 2,
      });
      await expect(rotated.ops.rekey(t, { execute: false })).resolves.toEqual({
        dryRun: true,
        keyId: 'k2',
        ciphertexts: 2,
      });
      await expect(rotated.ops.keyUsage(t)).resolves.toMatchObject({ byKeyId: { k1: 2 } });
      const done = await rotated.ops.rekey(await authz(t, 'security.key.rotate'), {
        execute: true,
      });
      expect(done).toEqual({ dryRun: false, keyId: 'k2', grants: 1, ciphertexts: 2 });
      await expect(rotated.ops.keyUsage(t)).resolves.toEqual({
        currentKeyId: 'k2',
        byKeyId: { k2: 2 },
        needingRekey: 0,
      });

      // k1 retired: only k2 remains, and the grant still reads.
      const retired = withCipher(new TokenCipher(k2, { kid: 'k2' }));
      const read = (await retired.store.get(t, 'hubspot'))!;
      expect(read.refreshToken.reveal()).toBe('refresh-a');
      expect(read.accessToken!.token.reveal()).toBe('access-a');

      const rows = await auditRows(t);
      const rekey = rows.find((r) => r.action === 'security.rekey')!;
      expect(rekey).toMatchObject({ outcome: 'completed', details: { grants: 1, ciphertexts: 2 } });
      const text = JSON.stringify(rows);
      for (const secret of ['refresh-a', 'access-a', k1.reveal(), k2.reveal()]) {
        expect(text).not.toContain(secret);
      }
      const [stored] = await admin<{ r: string; a: string }>(
        `SELECT refresh_token_enc AS r, access_token_enc AS a FROM tenant_oauth_tokens WHERE tenant_id = $1`,
        [t.tenantId],
      );
      expect(stored!.r).toMatch(/^v2:k2:/);
      expect(stored!.a).toMatch(/^v2:k2:/);
    });

    it('a v1 row (written before M10A1) reads with the legacy key and is rekeyed to v2', async () => {
      const t = await provisionTenant(h, 'v1row');
      const legacy = key();
      const v1 = (plaintext: string, column: string) => {
        const raw = Buffer.from(legacy.reveal(), 'base64');
        const enc = Buffer.from(
          hkdfSync('sha256', raw, Buffer.alloc(0), 'lip:token-encryption:v1', 32),
        );
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', enc, iv);
        c.setAAD(Buffer.from(`tenant_oauth_tokens|${t.tenantId}|hubspot|${column}`, 'utf8'));
        const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
        return `v1:${Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url')}`;
      };
      await admin(
        `INSERT INTO tenant_oauth_tokens (tenant_id, system, account_id, refresh_token_enc, scopes, updated_at)
         VALUES ($1, 'hubspot', '1001', $2, '{}', now())`,
        [t.tenantId, v1('refresh-old', 'refresh_token')],
      );
      const ring = withCipher(new TokenCipher(key(), { kid: 'k9', legacy }));
      expect((await ring.store.get(t, 'hubspot'))!.refreshToken.reveal()).toBe('refresh-old');
      await expect(ring.ops.keyUsage(t)).resolves.toMatchObject({
        byKeyId: { legacy: 1 },
        needingRekey: 1,
      });
      await ring.ops.rekey(await authz(t, 'security.key.rotate'), { execute: true });
      await expect(ring.ops.keyUsage(t)).resolves.toMatchObject({
        byKeyId: { k9: 1 },
        needingRekey: 0,
      });
    });

    it('an unknown key id fails with TokenKeyError and a token_key_unknown security event (ids only)', async () => {
      const t = await provisionTenant(h, 'unk');
      const k1 = key();
      await withCipher(new TokenCipher(k1, { kid: 'k1' })).store.put(t, 'hubspot', grant('u'));
      const events = h.app.get(SecurityEventsService, { strict: false });
      const emitted: unknown[] = [];
      vi.spyOn(events, 'emit').mockImplementation((e) => void emitted.push(e));
      const without = withCipher(new TokenCipher(key(), { kid: 'k2' }));
      await expect(without.store.get(t, 'hubspot')).rejects.toBeInstanceOf(TokenKeyError);
      expect(emitted).toEqual([
        expect.objectContaining({
          event: 'token_key_unknown',
          outcome: 'failed',
          tenant: t.tenantSlug,
          reasonCode: 'unknown_key_id',
          coordinates: {
            table: 'tenant_oauth_tokens',
            system: 'hubspot',
            column: 'refresh_token',
            kid: 'k1',
          },
        }),
      ]);
      expect(JSON.stringify(emitted)).not.toContain(k1.reveal());
      expect(JSON.stringify(emitted)).not.toContain('refresh-u');
    });
  });

  describe('S23: audit chain under concurrent writes', () => {
    it('two simultaneous writes for one tenant, 20 times: all succeed, seq contiguous, no fork, chain verifies', async () => {
      const t = await provisionTenant(h, 'chain');
      const trail = h.app.get(AuditTrail, { strict: false });
      const write = async (i: number) => {
        const actx = await authz(t, 'config.policy');
        await h.db.transaction(t, (tx) =>
          trail.record(tx, actx, { action: 'policy.save', targetKind: 'policy', details: { i } }),
        );
      };
      for (let round = 0; round < 20; round++) {
        const results = await Promise.allSettled([write(round * 2), write(round * 2 + 1)]);
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      }
      const rows = await auditRows(t);
      const writes = rows.filter((r) => r.action === 'policy.save');
      expect(writes).toHaveLength(40);
      expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
      expect(new Set(rows.map((r) => r.prev_hash)).size).toBe(rows.length);
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
      await expect(trail.verify(t)).resolves.toMatchObject({ ok: true, events: rows.length });
      const verdict = await ops().verifyChain(await authz(t, 'security.audit.read'));
      expect(verdict).toMatchObject({ ok: true });
    });

    it('a tampered event is detected by verification (owner bypassing the append-only trigger)', async () => {
      const t = await provisionTenant(h, 'tamper');
      const trail = h.app.get(AuditTrail, { strict: false });
      const actx = await authz(t, 'config.policy');
      for (let i = 0; i < 3; i++) {
        await h.db.transaction(t, (tx) =>
          trail.record(tx, actx, { action: 'policy.save', details: { i } }),
        );
      }
      await withAdmin(infra.adminUrl, async (db) => {
        await db.query('BEGIN');
        await db.query('ALTER TABLE tenant_audit_events DISABLE TRIGGER USER');
        await db.query(
          `UPDATE tenant_audit_events SET details = '{"i": 99}' WHERE tenant_id = $1 AND seq = 2`,
          [t.tenantId],
        );
        await db.query('ALTER TABLE tenant_audit_events ENABLE TRIGGER USER');
        await db.query('COMMIT');
      });
      const events = h.app.get(SecurityEventsService, { strict: false });
      const emitted: { event: string }[] = [];
      vi.spyOn(events, 'emit').mockImplementation((e) => void emitted.push(e));
      const verdict = await ops().verifyChain(await authz(t, 'security.audit.read'));
      expect(verdict).toMatchObject({ ok: false, brokenAtSeq: 2, reason: 'hash_mismatch' });
      expect(emitted.map((e) => e.event)).toContain('audit_chain_broken');
    });

    it('the app role cannot update, delete or truncate audit events, nor write anchors', async () => {
      const t = await provisionTenant(h, 'imm');
      const inT = <R>(work: (db: ReturnType<typeof tenantClient>) => Promise<R>) =>
        h.db.transaction(t, (tx) => work(tenantClient(tx)));
      await expect(
        inT((db) => db.$executeRaw`UPDATE tenant_audit_events SET action = 'x.y'`),
      ).rejects.toThrow(/permission denied for table tenant_audit_events/);
      await expect(inT((db) => db.$executeRaw`DELETE FROM tenant_audit_events`)).rejects.toThrow(
        /permission denied for table tenant_audit_events/,
      );
      await expect(inT((db) => db.$executeRaw`TRUNCATE tenant_audit_events`)).rejects.toThrow(
        /permission denied for table tenant_audit_events/,
      );
      await expect(
        inT(
          (db) =>
            db.$executeRaw`INSERT INTO tenant_audit_anchors (tenant_id, id, anchor_seq, anchor_hash, purged, cutoff, actor, correlation_id)
              VALUES (${t.tenantId}::uuid, gen_random_uuid(), 1, ${'0'.repeat(64)}, 1, now(), 'x', gen_random_uuid())`,
        ),
      ).rejects.toThrow(/permission denied for table tenant_audit_anchors/);
    });
  });

  describe('S24: writing CLI commands require an operator id', () => {
    it('without --actor or LIP_OPERATOR_ID: refused before any write, recorded as denied', async () => {
      const t = await provisionTenant(h, 'noop');
      const saved = process.env.LIP_OPERATOR_ID;
      delete process.env.LIP_OPERATOR_ID;
      try {
        await expect(
          authorizeOperator(h.app, t, 'security.key.rotate', {
            actorFlag: undefined,
            action: 'security.rekey',
            targetKind: 'key',
          }),
        ).rejects.toBeInstanceOf(OperatorIdRequiredError);
        const denied = (await auditRows(t)).filter((r) => r.outcome === 'denied');
        expect(denied).toEqual([
          expect.objectContaining({
            action: 'security.rekey',
            reason_code: 'operator_id_required',
          }),
        ]);
        process.env.LIP_OPERATOR_ID = 'ops-env';
        const actx = await authorizeOperator(h.app, t, 'security.key.rotate', {
          actorFlag: undefined,
          action: 'security.rekey',
        });
        expect(actx.actor).toEqual(operatorActor('ops-env'));
        expect(actx.actor.assurance).toBe('asserted');
      } finally {
        if (saved === undefined) delete process.env.LIP_OPERATOR_ID;
        else process.env.LIP_OPERATOR_ID = saved;
      }
    });
  });

  describe('S25: audit purge (report mode; execution disabled)', () => {
    const later = () => new Date(Date.now() + 400 * 86_400_000);

    it('the report changes nothing; --execute is refused (audit_purge_disabled) and recorded', async () => {
      const t = await provisionTenant(h, 'purge');
      const before = await auditRows(t);
      expect(before.length).toBeGreaterThan(0);
      const report = await ops().purge(t, { execute: false, now: later() });
      expect(report).toMatchObject({
        dryRun: true,
        retentionDays: 365,
        totalEvents: before.length,
        eligibleEvents: before.length,
        anchorSeq: before.at(-1)!.seq,
        purged: 0,
      });
      expect(await auditRows(t)).toHaveLength(before.length);
      await expect(
        ops().purge(await authz(t, 'data.purge'), {
          execute: true,
          now: later(),
          ownerDatabaseUrl: infra.adminUrl,
        }),
      ).rejects.toBeInstanceOf(AuditPurgeDisabledError);
      const after = await auditRows(t);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.at(-1)).toMatchObject({
        action: 'security.audit.purge',
        outcome: 'denied',
        reason_code: 'audit_purge_disabled',
      });
    });

    it('the test-only override is refused in production', async () => {
      const t = await provisionTenant(h, 'prodov');
      const saved = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(
          ops().purge(await authz(t, 'data.purge'), {
            execute: true,
            unapprovedExecutionForTests: true,
            ownerDatabaseUrl: infra.adminUrl,
          }),
        ).rejects.toThrow(/refused in production/);
      } finally {
        process.env.NODE_ENV = saved;
      }
    });

    it('the execution path (test override): owner only, anchors the chain, audits itself, chain verifies', async () => {
      const t = await provisionTenant(h, 'purgex');
      const trail = h.app.get(AuditTrail, { strict: false });
      const actx = await authz(t, 'config.policy');
      for (let i = 0; i < 3; i++) {
        await h.db.transaction(t, (tx) =>
          trail.record(tx, actx, { action: 'policy.save', details: { i } }),
        );
      }
      const before = await auditRows(t);
      // The app role's credentials are refused.
      await expect(
        ops().purge(await authz(t, 'data.purge'), {
          execute: true,
          unapprovedExecutionForTests: true,
          now: later(),
          ownerDatabaseUrl: infra.config.databaseUrl,
        }),
      ).rejects.toThrow(/schema owner credentials/);
      const result = await ops().purge(await authz(t, 'data.purge'), {
        execute: true,
        unapprovedExecutionForTests: true,
        now: later(),
        ownerDatabaseUrl: infra.adminUrl,
      });
      expect(result).toMatchObject({
        dryRun: false,
        purged: before.length,
        anchorSeq: before.at(-1)!.seq,
      });
      const after = await auditRows(t);
      expect(after).toEqual([
        expect.objectContaining({
          seq: before.at(-1)!.seq + 1,
          action: 'security.audit.purge',
          outcome: 'completed',
          prev_hash: before.at(-1)!.hash,
          details: { purged: before.length, retentionDays: 365 },
        }),
      ]);
      const [anchor] = await admin<{ anchor_seq: number; anchor_hash: string; purged: number }>(
        'SELECT anchor_seq, anchor_hash, purged FROM tenant_audit_anchors WHERE tenant_id = $1',
        [t.tenantId],
      );
      expect(anchor).toEqual({
        anchor_seq: before.at(-1)!.seq,
        anchor_hash: before.at(-1)!.hash,
        purged: before.length,
      });
      await expect(trail.verify(t)).resolves.toMatchObject({ ok: true, events: 1 });
      // Writes continue on the anchored chain.
      await h.db.transaction(t, (tx) => trail.record(tx, actx, { action: 'policy.save' }));
      await expect(trail.verify(t)).resolves.toMatchObject({ ok: true, events: 2 });
    });
  });
});
