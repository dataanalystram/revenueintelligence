import { Injectable } from '@nestjs/common';
import { Client } from 'pg';
import {
  AUDIT_GENESIS_HASH,
  AUDIT_PURGE_EXECUTION_APPROVED,
  RETENTION_DEFAULTS,
  retentionCutoff,
  type ChainVerdict,
} from '../../domain';
import { TenancyError } from '../errors';
import { EncryptedDatabaseOAuthGrantStore } from '../infrastructure/encrypted-oauth-grant.store';
import { TenantDatabase, advisoryLockKey, tenantClient } from '../infrastructure/tenant-database';
import type { TenantContext } from '../tenant-context';
import { AuditTrail, CHAIN_LOCK_SCOPE, chainedAuditEvent } from './audit-trail';
import { assertAuthorized, AuthorizedContext } from './authorized-context';
import { SecurityEventsService } from './security-events.service';

/** Executing an audit purge is refused until the retention policy is approved (Q3). */
export class AuditPurgeDisabledError extends TenancyError {
  constructor() {
    super(
      'audit_purge_disabled',
      'Audit purge execution is disabled until the formal privacy/retention policy is approved',
    );
  }
}

export class AuditPurgeRefusedError extends TenancyError {
  constructor(code: 'purge_requires_owner_credentials' | 'audit_purge_test_override_refused') {
    super(
      code,
      code === 'purge_requires_owner_credentials'
        ? 'The audit purge runs only with the schema owner credentials (MIGRATION_DATABASE_URL)'
        : 'The test-only audit purge override is refused in production',
    );
  }
}

/** What a purge would do (dry run) or did: counts, sequence numbers and the cut-off only. */
export interface AuditPurgeReport {
  readonly dryRun: boolean;
  readonly retentionDays: number;
  readonly cutoff: string;
  readonly totalEvents: number;
  readonly eligibleEvents: number;
  /** The sequence number the new anchor would carry (the last purged event). */
  readonly anchorSeq: number | null;
  readonly purged: number;
}

/** Key usage per key id (counts only). */
export interface KeyUsage {
  readonly currentKeyId: string;
  readonly byKeyId: Readonly<Record<string, number>>;
  readonly needingRekey: number;
}

/**
 * Security operations (M10A1 plan §5.1, §10, §13): token re-encryption after a
 * key rotation, key usage, audit-chain verification and the audit purge (report
 * mode; execution disabled by AUDIT_PURGE_EXECUTION_APPROVED). CLI only.
 */
@Injectable()
export class SecurityOperationsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly audit: AuditTrail,
    private readonly grants: EncryptedDatabaseOAuthGrantStore,
    private readonly events: SecurityEventsService,
  ) {}

  keyUsage(ctx: TenantContext): Promise<KeyUsage> {
    return this.grants.keyUsage(ctx);
  }

  /**
   * Dry run (a tenant context): what would be re-encrypted. Execute (an operator
   * authorized for `security.key.rotate`): re-encrypts under the current key and
   * audits the counts in the same transaction.
   */
  async rekey(
    target: TenantContext | AuthorizedContext<'security.key.rotate'>,
    options: { execute: boolean },
  ): Promise<{ dryRun: boolean; keyId: string; grants?: number; ciphertexts: number }> {
    if (!options.execute) {
      const ctx = target instanceof AuthorizedContext ? target.tenant : target;
      const usage = await this.grants.keyUsage(ctx);
      return { dryRun: true, keyId: usage.currentKeyId, ciphertexts: usage.needingRekey };
    }
    assertAuthorized(target, 'security.key.rotate');
    const actx = target;
    const result = await this.grants.rekey(actx.tenant, (tx, r) =>
      this.audit.record(
        tx,
        actx,
        {
          action: 'security.rekey',
          targetKind: 'key',
          targetRef: r.keyId,
          details: { grants: r.grants, ciphertexts: r.ciphertexts },
        },
        'completed',
      ),
    );
    this.events.emit({
      event: 'key_rotation_completed',
      outcome: 'completed',
      tenant: actx.tenant.tenantSlug,
      actorKind: actx.actor.kind,
      capability: actx.capability,
      reasonCode: 'rekeyed',
      correlationId: actx.correlationId,
      coordinates: { keyId: result.keyId, ciphertexts: String(result.ciphertexts) },
    });
    return { dryRun: false, ...result };
  }

  /**
   * Re-walks the tenant's chain (read-only over the events), then records the
   * verification itself. A broken chain emits `audit_chain_broken`.
   */
  async verifyChain(actx: AuthorizedContext<'security.audit.read'>): Promise<ChainVerdict> {
    assertAuthorized(actx, 'security.audit.read');
    const verdict = await this.audit.verify(actx.tenant);
    if (!verdict.ok) {
      this.events.emit({
        event: 'audit_chain_broken',
        outcome: 'detected',
        tenant: actx.tenant.tenantSlug,
        actorKind: actx.actor.kind,
        capability: actx.capability,
        reasonCode: verdict.reason,
        correlationId: actx.correlationId,
        coordinates: { seq: String(verdict.brokenAtSeq) },
      });
      // A broken chain cannot be extended: the event would link to a forged head.
      return verdict;
    }
    await this.db.transaction(actx.tenant, (tx) =>
      this.audit.record(
        tx,
        actx,
        {
          action: 'security.audit.verify',
          targetKind: 'audit',
          details: { events: verdict.events, ok: true },
        },
        'completed',
      ),
    );
    return verdict;
  }

  /**
   * The audit purge. Without `execute`: a report of what the 365-day class would
   * purge (changes nothing). With `execute`: refused (`audit_purge_disabled`)
   * while AUDIT_PURGE_EXECUTION_APPROVED is false, unless the test-only override
   * is passed outside production. Executing runs with the schema owner's
   * credentials, deletes only events older than the cut-off, records the last
   * purged event as the chain anchor and appends one audit event, all in one
   * transaction under the chain lock.
   */
  async purge(
    target: TenantContext | AuthorizedContext<'data.purge'>,
    options: {
      execute: boolean;
      ownerDatabaseUrl?: string;
      now?: Date;
      /** Test-only: exercises the execution path while execution is not approved. */
      unapprovedExecutionForTests?: boolean;
    },
  ): Promise<AuditPurgeReport> {
    const now = options.now ?? new Date();
    const cutoff = retentionCutoff('security_audit', now)!;
    const retention = RETENTION_DEFAULTS.security_audit;
    const retentionDays = retention.kind === 'days' ? retention.days : 0;
    if (!options.execute) {
      const ctx = target instanceof AuthorizedContext ? target.tenant : target;
      return this.db.transaction(ctx, async (tx) => {
        const client = tenantClient(tx);
        const totalEvents = await client.tenantAuditEvent.count();
        const firstKept = await client.tenantAuditEvent.findFirst({
          where: { occurredAt: { gte: cutoff } },
          orderBy: { seq: 'asc' },
          select: { seq: true },
        });
        const eligible = await client.tenantAuditEvent.aggregate({
          where: firstKept ? { seq: { lt: firstKept.seq } } : {},
          _count: { _all: true },
          _max: { seq: true },
        });
        return {
          dryRun: true,
          retentionDays,
          cutoff: cutoff.toISOString(),
          totalEvents,
          eligibleEvents: eligible._count._all,
          anchorSeq: eligible._max.seq,
          purged: 0,
        };
      });
    }
    assertAuthorized(target, 'data.purge');
    const actx = target;
    if (options.unapprovedExecutionForTests && process.env.NODE_ENV === 'production') {
      throw new AuditPurgeRefusedError('audit_purge_test_override_refused');
    }
    if (!AUDIT_PURGE_EXECUTION_APPROVED && !options.unapprovedExecutionForTests) {
      await this.audit.recordDenied(actx.tenant, {
        actor: actx.actor,
        capability: actx.capability,
        reason: 'audit_purge_disabled',
        correlationId: actx.correlationId,
        action: 'security.audit.purge',
        targetKind: 'audit',
      });
      throw new AuditPurgeDisabledError();
    }
    if (!options.ownerDatabaseUrl)
      throw new AuditPurgeRefusedError('purge_requires_owner_credentials');
    return this.executePurge(actx, options.ownerDatabaseUrl, cutoff, retentionDays);
  }

  private async executePurge(
    actx: AuthorizedContext<'data.purge'>,
    ownerDatabaseUrl: string,
    cutoff: Date,
    retentionDays: number,
  ): Promise<AuditPurgeReport> {
    const tenantId = actx.tenant.tenantId;
    const client = new Client({ connectionString: ownerDatabaseUrl });
    await client.connect();
    try {
      const role = await client.query<{ member: boolean }>(
        'SELECT app_session_in_app_role() AS member',
      );
      if (role.rows[0]?.member)
        throw new AuditPurgeRefusedError('purge_requires_owner_credentials');
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      try {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          advisoryLockKey(tenantId, CHAIN_LOCK_SCOPE, 'head').toString(),
        ]);
        const total = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM tenant_audit_events WHERE tenant_id = $1',
          [tenantId],
        );
        // Only a contiguous prefix of the chain, every event of it older than the
        // cut-off: everything before the first event at or after the cut-off.
        const last = await client.query<{ seq: number | null; hash: string | null; n: number }>(
          `WITH bound AS (
             SELECT coalesce(min(seq), 2147483647) AS first_kept FROM tenant_audit_events
              WHERE tenant_id = $1 AND occurred_at >= $2
           )
           SELECT max(e.seq) AS seq, count(*)::int AS n,
                  (SELECT hash FROM tenant_audit_events x, bound b
                    WHERE x.tenant_id = $1 AND x.seq < b.first_kept ORDER BY x.seq DESC LIMIT 1) AS hash
             FROM tenant_audit_events e, bound b
            WHERE e.tenant_id = $1 AND e.seq < b.first_kept`,
          [tenantId, cutoff],
        );
        const eligible = last.rows[0]!;
        let purged = 0;
        if (eligible.n > 0) {
          await client.query(`SELECT set_config('lip.audit_purge', 'on', true)`);
          const deleted = await client.query(
            'DELETE FROM tenant_audit_events WHERE tenant_id = $1 AND seq <= $2',
            [tenantId, eligible.seq],
          );
          purged = deleted.rowCount ?? 0;
          await client.query(`SELECT set_config('lip.audit_purge', 'off', true)`);
          await client.query(
            `INSERT INTO tenant_audit_anchors
               (tenant_id, id, anchor_seq, anchor_hash, purged, cutoff, actor, correlation_id)
             VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7)`,
            [
              tenantId,
              eligible.seq,
              eligible.hash,
              purged,
              cutoff,
              actx.actor.id,
              actx.correlationId,
            ],
          );
        }
        // The purge itself is audited, linked to the current head (or the new anchor).
        const head = await client.query<{ seq: number; hash: string }>(
          `SELECT seq, hash FROM tenant_audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1`,
          [tenantId],
        );
        const anchor = await client.query<{ seq: number; hash: string }>(
          `SELECT anchor_seq AS seq, anchor_hash AS hash FROM tenant_audit_anchors
            WHERE tenant_id = $1 ORDER BY anchor_seq DESC LIMIT 1`,
          [tenantId],
        );
        const prev = head.rows[0] ?? anchor.rows[0] ?? { seq: 0, hash: AUDIT_GENESIS_HASH };
        const { payload, hash } = chainedAuditEvent(prev, tenantId, {
          actorKind: actx.actor.kind,
          actorId: actx.actor.id,
          actorAssurance: actx.actor.assurance,
          capability: actx.capability,
          action: 'security.audit.purge',
          outcome: 'completed',
          reasonCode: null,
          targetKind: 'audit',
          targetRef: null,
          correlationId: actx.correlationId,
          policyVersion: actx.policyVersion,
          details: { purged, retentionDays },
        });
        await client.query(
          `INSERT INTO tenant_audit_events
             (tenant_id, id, seq, occurred_at, actor_kind, actor_id, actor_assurance, capability,
              action, outcome, reason_code, target_kind, target_ref, correlation_id, policy_version,
              details, prev_hash, hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            tenantId,
            payload.id,
            payload.seq,
            payload.occurredAt,
            payload.actorKind,
            payload.actorId,
            payload.actorAssurance,
            payload.capability,
            payload.action,
            payload.outcome,
            payload.reasonCode,
            payload.targetKind,
            payload.targetRef,
            payload.correlationId,
            payload.policyVersion,
            JSON.stringify(payload.details),
            prev.hash,
            hash,
          ],
        );
        await client.query('COMMIT');
        this.events.emit({
          event: 'audit_purge_completed',
          outcome: 'completed',
          tenant: actx.tenant.tenantSlug,
          actorKind: actx.actor.kind,
          capability: actx.capability,
          reasonCode: 'purged',
          correlationId: actx.correlationId,
          coordinates: { purged: String(purged) },
        });
        return {
          dryRun: false,
          retentionDays,
          cutoff: cutoff.toISOString(),
          totalEvents: total.rows[0]!.n,
          eligibleEvents: eligible.n,
          anchorSeq: eligible.n > 0 ? eligible.seq : null,
          purged,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      await client.end();
    }
  }
}
