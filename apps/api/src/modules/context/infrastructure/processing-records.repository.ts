import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ContextKind, ExternalSystem } from '../../domain';
import { tenantClient, type TenantTransaction } from '../../tenancy';

/** Dead letters and sync checkpoints (ADR 0013): durable processing state, identifiers only. */

export interface DeadLetterWrite {
  readonly queue: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly subject?: { system: ExternalSystem; kind: ContextKind; externalId: string };
  readonly receiptDeliveryKey?: string;
  readonly checkpointId?: string;
  readonly correlationId: string;
  readonly errorCode: string;
  readonly httpStatus?: number;
  readonly attempts: number;
}

export interface DeadLetterRow {
  readonly id: string;
  readonly queue: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly subjectSystem: string | null;
  readonly subjectKind: string | null;
  readonly subjectExternalId: string | null;
  readonly receiptDeliveryKey: string | null;
  readonly checkpointId: string | null;
  readonly correlationId: string;
  readonly errorCode: string;
  readonly httpStatus: number | null;
  readonly attempts: number;
  readonly firstFailedAt: Date;
  readonly lastFailedAt: Date;
  readonly state: string;
  readonly resolution: string | null;
}

export type CheckpointMode = 'backfill' | 'reconcile';
export type CheckpointStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface CheckpointRow {
  readonly id: string;
  readonly system: ExternalSystem;
  readonly kind: ContextKind;
  readonly mode: CheckpointMode;
  readonly status: CheckpointStatus;
  readonly cursor: string | null;
  readonly windowSince: Date | null;
  readonly highWatermark: Date | null;
  readonly pageNo: number;
  readonly recordsSeen: number;
  readonly recordsChanged: number;
  readonly recordsSkipped: number;
  readonly recordsFailed: number;
  readonly maxRecords: number | null;
  readonly pageSize: number;
  readonly correlationId: string;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly lastErrorCode: string | null;
}

const asCheckpoint = (r: Record<string, unknown>) => r as unknown as CheckpointRow;

@Injectable()
export class ProcessingRecordsRepository {
  /** One row per job id: a repeated final failure of the same job updates it. */
  async recordDeadLetter(tx: TenantTransaction, d: DeadLetterWrite): Promise<string> {
    const db = tenantClient(tx);
    const now = new Date();
    const row = await db.tenantDeadLetter.upsert({
      where: { tenantId_jobId: { tenantId: tx.tenantId, jobId: d.jobId } },
      create: {
        tenantId: tx.tenantId,
        id: randomUUID(),
        queue: d.queue,
        jobName: d.jobName,
        jobId: d.jobId,
        subjectSystem: d.subject?.system ?? null,
        subjectKind: d.subject?.kind ?? null,
        subjectExternalId: d.subject?.externalId ?? null,
        receiptDeliveryKey: d.receiptDeliveryKey ?? null,
        checkpointId: d.checkpointId ?? null,
        correlationId: d.correlationId,
        errorCode: d.errorCode,
        httpStatus: d.httpStatus ?? null,
        attempts: d.attempts,
        firstFailedAt: now,
        lastFailedAt: now,
      },
      update: {
        errorCode: d.errorCode,
        httpStatus: d.httpStatus ?? null,
        attempts: d.attempts,
        lastFailedAt: now,
        state: 'open',
        resolvedAt: null,
        resolution: null,
      },
      select: { id: true },
    });
    return row.id;
  }

  async listDeadLetters(
    tx: TenantTransaction,
    filter: { state?: string; code?: string; ids?: readonly string[]; limit: number },
  ): Promise<DeadLetterRow[]> {
    return tenantClient(tx).tenantDeadLetter.findMany({
      where: {
        tenantId: tx.tenantId,
        ...(filter.state ? { state: filter.state } : {}),
        ...(filter.code ? { errorCode: filter.code } : {}),
        ...(filter.ids ? { id: { in: [...filter.ids] } } : {}),
      },
      orderBy: [{ lastFailedAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(filter.limit, 1_000)),
    });
  }

  async resolveDeadLetter(
    tx: TenantTransaction,
    id: string,
    state: 'replayed' | 'discarded',
    resolution: string,
  ): Promise<boolean> {
    const { count } = await tenantClient(tx).tenantDeadLetter.updateMany({
      where: { tenantId: tx.tenantId, id, state: 'open' },
      data: { state, resolution, resolvedAt: new Date() },
    });
    return count === 1;
  }

  async deadLetterCounts(tx: TenantTransaction): Promise<Record<string, number>> {
    const groups = await tenantClient(tx).tenantDeadLetter.groupBy({
      by: ['state', 'errorCode'],
      where: { tenantId: tx.tenantId },
      _count: { _all: true },
      orderBy: [{ state: 'asc' }, { errorCode: 'asc' }],
    });
    return Object.fromEntries(groups.map((g) => [`${g.state}:${g.errorCode}`, g._count._all]));
  }

  /** Starts a run; fails with a unique violation if one is already running for this kind/mode. */
  async startCheckpoint(
    tx: TenantTransaction,
    c: {
      system: ExternalSystem;
      kind: ContextKind;
      mode: CheckpointMode;
      correlationId: string;
      pageSize: number;
      maxRecords?: number;
      windowSince?: Date;
      highWatermark?: Date;
    },
  ): Promise<CheckpointRow> {
    const row = await tenantClient(tx).tenantSyncCheckpoint.create({
      data: {
        tenantId: tx.tenantId,
        id: randomUUID(),
        system: c.system,
        kind: c.kind,
        mode: c.mode,
        status: 'running',
        activeKey: `${c.system}:${c.kind}:${c.mode}`,
        correlationId: c.correlationId,
        pageSize: c.pageSize,
        maxRecords: c.maxRecords ?? null,
        windowSince: c.windowSince ?? null,
        highWatermark: c.highWatermark ?? null,
      },
    });
    return asCheckpoint(row);
  }

  /** Re-opens a failed run at its stored cursor (fails if another run is active). */
  async reopenCheckpoint(tx: TenantTransaction, cp: CheckpointRow): Promise<void> {
    await tenantClient(tx).tenantSyncCheckpoint.updateMany({
      where: { tenantId: tx.tenantId, id: cp.id, status: 'failed' },
      data: {
        status: 'running',
        activeKey: `${cp.system}:${cp.kind}:${cp.mode}`,
        completedAt: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      },
    });
  }

  async getCheckpoint(tx: TenantTransaction, id: string): Promise<CheckpointRow | undefined> {
    const row = await tenantClient(tx).tenantSyncCheckpoint.findFirst({
      where: { tenantId: tx.tenantId, id },
    });
    return row ? asCheckpoint(row) : undefined;
  }

  /** Locks the checkpoint row for the rest of the transaction (one page at a time). */
  async lockCheckpoint(tx: TenantTransaction, id: string): Promise<CheckpointRow | undefined> {
    const rows = await tenantClient(tx).$queryRaw<{ id: string }[]>`
      SELECT id::text FROM tenant_sync_checkpoints
       WHERE tenant_id = ${tx.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    return rows.length ? this.getCheckpoint(tx, id) : undefined;
  }

  async running(
    tx: TenantTransaction,
    system: ExternalSystem,
    kind: ContextKind,
    mode: CheckpointMode,
  ): Promise<CheckpointRow | undefined> {
    const row = await tenantClient(tx).tenantSyncCheckpoint.findFirst({
      where: { tenantId: tx.tenantId, activeKey: `${system}:${kind}:${mode}` },
    });
    return row ? asCheckpoint(row) : undefined;
  }

  async lastCompleted(
    tx: TenantTransaction,
    system: ExternalSystem,
    kind: ContextKind,
    mode: CheckpointMode,
  ): Promise<CheckpointRow | undefined> {
    const row = await tenantClient(tx).tenantSyncCheckpoint.findFirst({
      where: { tenantId: tx.tenantId, system, kind, mode, status: 'completed' },
      orderBy: { completedAt: 'desc' },
    });
    return row ? asCheckpoint(row) : undefined;
  }

  async advanceCheckpoint(
    tx: TenantTransaction,
    id: string,
    patch: {
      cursor?: string | null;
      windowSince?: Date | null;
      highWatermark?: Date | null;
      seen: number;
      changed: number;
      skipped: number;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantSyncCheckpoint.updateMany({
      where: { tenantId: tx.tenantId, id, status: 'running' },
      data: {
        ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
        ...(patch.windowSince !== undefined ? { windowSince: patch.windowSince } : {}),
        ...(patch.highWatermark !== undefined ? { highWatermark: patch.highWatermark } : {}),
        pageNo: { increment: 1 },
        recordsSeen: { increment: patch.seen },
        recordsChanged: { increment: patch.changed },
        recordsSkipped: { increment: patch.skipped },
        updatedAt: new Date(),
      },
    });
  }

  async finishCheckpoint(
    tx: TenantTransaction,
    id: string,
    status: Exclude<CheckpointStatus, 'running'>,
    errorCode?: string,
  ): Promise<void> {
    await tenantClient(tx).tenantSyncCheckpoint.updateMany({
      where: { tenantId: tx.tenantId, id, status: 'running' },
      data: {
        status,
        activeKey: null,
        completedAt: new Date(),
        updatedAt: new Date(),
        lastErrorCode: errorCode ?? null,
      },
    });
  }

  async recentCheckpoints(tx: TenantTransaction, limit: number): Promise<CheckpointRow[]> {
    const rows = await tenantClient(tx).tenantSyncCheckpoint.findMany({
      where: { tenantId: tx.tenantId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return rows.map(asCheckpoint);
  }
}
