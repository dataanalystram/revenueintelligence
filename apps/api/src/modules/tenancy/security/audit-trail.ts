import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AUDIT_GENESIS_HASH,
  AuditEventInputSchema,
  auditEventHash,
  POLICY_VERSION,
  verifyAuditChain,
  type AuditAction,
  type AuditDetails,
  type AuditEventInput,
  type AuditOutcome,
  type AuditReasonCode,
  type AuditTargetKind,
  type Capability,
  type ChainVerdict,
  type SecurityActor,
  type StoredAuditEvent,
} from '../../domain';
import {
  TenantDatabase,
  tenantAdvisoryLock,
  tenantClient,
  type TenantTransaction,
} from '../infrastructure/tenant-database';
import type { TenantContext } from '../tenant-context';
import {
  assertAuthorizedFor,
  assertPlatformAuthorized,
  type AuthorizedContext,
  type PlatformAuthorization,
} from './authorized-context';

/** One audited operation's description: identifiers, codes and counts only. */
export interface AuditEntry {
  readonly action: AuditAction;
  readonly targetKind?: AuditTargetKind;
  readonly targetRef?: string;
  readonly details?: AuditDetails;
}

/** Audit events are appended only in READ COMMITTED transactions (see `append`). */
export class AuditIsolationError extends Error {
  constructor(readonly level: string) {
    super(`audit events are appended in READ COMMITTED transactions only (got ${level})`);
    this.name = 'AuditIsolationError';
  }
}

/** The advisory-lock scope that serialises one tenant's chain (§5.1). */
export const CHAIN_LOCK_SCOPE = 'audit-chain';

/**
 * The append-only, hash-chained audit trail (M10A1 plan §5, §5.1, §6).
 *
 * `record` writes an event inside the caller's transaction, so the event and
 * the change it describes commit or roll back together (fail closed).
 * `recordDenied` and `recordFailed` open their own transaction, so the event
 * survives the refused or rolled-back operation.
 *
 * Each append takes the tenant's chain lock, reads the head and links to it.
 * Unique (tenant_id, prev_hash) and (tenant_id, seq) make a fork impossible even
 * if the lock were bypassed: the losing insert fails instead.
 */
@Injectable()
export class AuditTrail {
  constructor(private readonly db: TenantDatabase) {}

  /**
   * An allowed, completed or (for a multi-transaction run whose failure is itself
   * committed) failed operation, inside the transaction of the change it describes.
   */
  async record(
    tx: TenantTransaction,
    actx: AuthorizedContext,
    entry: AuditEntry,
    outcome: Extract<AuditOutcome, 'allowed' | 'completed' | 'failed'> = 'allowed',
    reason?: AuditReasonCode,
  ): Promise<void> {
    assertAuthorizedFor(actx, [actx.capability]);
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('audit event tenant does not match the transaction tenant');
    }
    await this.append(tx, {
      actorKind: actx.actor.kind,
      actorId: actx.actor.id,
      actorAssurance: actx.actor.assurance,
      capability: actx.capability,
      action: entry.action,
      outcome,
      reasonCode: outcome === 'failed' ? (reason ?? 'operation_failed') : null,
      targetKind: entry.targetKind ?? null,
      targetRef: entry.targetRef ?? null,
      correlationId: actx.correlationId,
      policyVersion: actx.policyVersion,
      details: entry.details ?? {},
    });
  }

  /** A platform-level operation (provisioning, status), into the target tenant's trail. */
  async recordPlatform(
    tx: TenantTransaction,
    auth: PlatformAuthorization,
    entry: AuditEntry,
  ): Promise<void> {
    assertPlatformAuthorized(auth, auth.capability);
    await this.append(tx, {
      actorKind: auth.actor.kind,
      actorId: auth.actor.id,
      actorAssurance: auth.actor.assurance,
      capability: auth.capability,
      action: entry.action,
      outcome: 'allowed',
      reasonCode: null,
      targetKind: entry.targetKind ?? null,
      targetRef: entry.targetRef ?? null,
      correlationId: auth.correlationId,
      policyVersion: auth.policyVersion,
      details: entry.details ?? {},
    });
  }

  /** A refused attempt, in its own transaction (it must survive the refusal). */
  async recordDenied(
    ctx: TenantContext,
    attempt: {
      readonly actor: SecurityActor;
      readonly capability: Capability;
      readonly reason: AuditReasonCode;
      readonly correlationId: string;
    } & AuditEntry,
  ): Promise<void> {
    await this.db.transaction(ctx, (tx) =>
      this.append(tx, {
        actorKind: attempt.actor.kind,
        actorId: attempt.actor.id,
        actorAssurance: attempt.actor.assurance,
        capability: attempt.capability,
        action: attempt.action,
        outcome: 'denied',
        reasonCode: attempt.reason,
        targetKind: attempt.targetKind ?? null,
        targetRef: attempt.targetRef ?? null,
        correlationId: attempt.correlationId,
        policyVersion: POLICY_VERSION,
        details: attempt.details ?? {},
      }),
    );
  }

  /** An authorized operation that failed and rolled back, in its own transaction. */
  async recordFailed(
    actx: AuthorizedContext,
    entry: AuditEntry & { readonly reason: AuditReasonCode },
  ): Promise<void> {
    await this.db.transaction(actx.tenant, (tx) =>
      this.append(tx, {
        actorKind: actx.actor.kind,
        actorId: actx.actor.id,
        actorAssurance: actx.actor.assurance,
        capability: actx.capability,
        action: entry.action,
        outcome: 'failed',
        reasonCode: entry.reason,
        targetKind: entry.targetKind ?? null,
        targetRef: entry.targetRef ?? null,
        correlationId: actx.correlationId,
        policyVersion: actx.policyVersion,
        details: entry.details ?? {},
      }),
    );
  }

  /** Re-walks the tenant's chain from its anchor (read-only). */
  async verify(ctx: TenantContext): Promise<ChainVerdict> {
    return this.db.transaction(ctx, async (tx) => {
      const client = tenantClient(tx);
      const anchor = await client.tenantAuditAnchor.findFirst({ orderBy: { anchorSeq: 'desc' } });
      const rows = await client.tenantAuditEvent.findMany({ orderBy: { seq: 'asc' } });
      return verifyAuditChain(
        rows.map(toStored),
        anchor ? { hash: anchor.anchorHash, seq: anchor.anchorSeq } : undefined,
      );
    });
  }

  private async append(tx: TenantTransaction, input: AuditEventInput): Promise<void> {
    const event = AuditEventInputSchema.parse(input);
    const client = tenantClient(tx);
    // The head must be read as committed after the lock is granted. A repeatable-read
    // or serializable snapshot could predate the previous holder's commit, so audit
    // writes refuse to run there (fail closed) instead of failing on the unique keys.
    const isolation = await client.$queryRaw<{ level: string }[]>`
      SELECT current_setting('transaction_isolation') AS level`;
    const level = isolation[0]?.level ?? 'unknown';
    if (level !== 'read committed') {
      throw new AuditIsolationError(level);
    }
    await tenantAdvisoryLock(tx, CHAIN_LOCK_SCOPE, 'head');
    const head = await client.tenantAuditEvent.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true, hash: true },
    });
    let prev = head ? { seq: head.seq, hash: head.hash } : undefined;
    if (!prev) {
      const anchor = await client.tenantAuditAnchor.findFirst({
        orderBy: { anchorSeq: 'desc' },
        select: { anchorSeq: true, anchorHash: true },
      });
      prev = anchor
        ? { seq: anchor.anchorSeq, hash: anchor.anchorHash }
        : { seq: 0, hash: AUDIT_GENESIS_HASH };
    }
    const { payload, hash } = chainedAuditEvent(prev, tx.tenantId, event);
    await client.tenantAuditEvent.create({
      data: {
        tenantId: payload.tenantId,
        id: payload.id,
        seq: payload.seq,
        occurredAt: payload.occurredAt,
        actorKind: payload.actorKind,
        actorId: payload.actorId,
        actorAssurance: payload.actorAssurance,
        capability: payload.capability,
        action: payload.action,
        outcome: payload.outcome,
        reasonCode: payload.reasonCode,
        targetKind: payload.targetKind,
        targetRef: payload.targetRef,
        correlationId: payload.correlationId,
        policyVersion: payload.policyVersion,
        details: payload.details,
        prevHash: prev.hash,
        hash,
      },
    });
  }
}

/**
 * The next event of a tenant's chain: identity, sequence, time and the hash
 * linking it to `prev` (pure; shared by the app-role writer and the owner-path
 * purge, so both produce identical chains).
 */
export function chainedAuditEvent(
  prev: { readonly seq: number; readonly hash: string },
  tenantId: string,
  input: AuditEventInput,
  occurredAt: Date = new Date(),
) {
  const event = AuditEventInputSchema.parse(input);
  const payload = { ...event, tenantId, id: randomUUID(), seq: prev.seq + 1, occurredAt };
  return { payload, hash: auditEventHash(prev.hash, payload) };
}

type AuditRow = Awaited<
  ReturnType<ReturnType<typeof tenantClient>['tenantAuditEvent']['findMany']>
>[number];

export function toStored(row: AuditRow): StoredAuditEvent {
  return {
    tenantId: row.tenantId,
    id: row.id,
    seq: row.seq,
    occurredAt: row.occurredAt,
    actorKind: row.actorKind as StoredAuditEvent['actorKind'],
    actorId: row.actorId,
    actorAssurance: row.actorAssurance as StoredAuditEvent['actorAssurance'],
    capability: row.capability as StoredAuditEvent['capability'],
    action: row.action as StoredAuditEvent['action'],
    outcome: row.outcome as StoredAuditEvent['outcome'],
    reasonCode: row.reasonCode as StoredAuditEvent['reasonCode'],
    targetKind: row.targetKind as StoredAuditEvent['targetKind'],
    targetRef: row.targetRef,
    correlationId: row.correlationId,
    policyVersion: row.policyVersion,
    details: row.details as AuditDetails,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}
