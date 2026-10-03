import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  tenantClient,
  translateDatabaseError,
  UniqueConstraintError,
  type TenantTransaction,
} from '../../tenancy';

/**
 * Subscription load runs, recorded in the M6 `tenant_sync_checkpoints` table
 * (`kind = subscription`). A completed **full** load (an `import_full` run now,
 * a connector `backfill` in M8) is what makes ownership coverage known
 * (ADR 0017 §5). Coverage is per tenant in M7 (provisional until the
 * Subscription Source Discovery gate).
 */

export type ImportMode = 'import_full' | 'import_incremental';

export interface SubscriptionRun {
  readonly id: string;
  readonly mode: string;
  readonly system: string;
  readonly status: string;
  readonly recordsSeen: number;
  readonly recordsChanged: number;
  readonly recordsSkipped: number;
  readonly recordsFailed: number;
  readonly inputHash: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly lastErrorCode: string | null;
}

const IMPORT_ACTIVE_KEY = 'import:subscription:import';

export class ImportAlreadyRunningError extends Error {
  constructor(readonly checkpointId: string) {
    super(`a subscription import is already running (${checkpointId})`);
    this.name = 'ImportAlreadyRunningError';
  }
}

@Injectable()
export class SubscriptionRunsStore {
  async running(tx: TenantTransaction): Promise<SubscriptionRun | undefined> {
    const row = await tenantClient(tx).tenantSyncCheckpoint.findFirst({
      where: { tenantId: tx.tenantId, kind: 'subscription', status: 'running' },
    });
    return row ?? undefined;
  }

  async start(
    tx: TenantTransaction,
    input: { mode: ImportMode; inputHash: string; correlationId: string },
  ): Promise<string> {
    const existing = await this.running(tx);
    if (existing) throw new ImportAlreadyRunningError(existing.id);
    const id = randomUUID();
    // Every tenant has an `import` connection (provisioning and the M8 backfill).
    const connection = await tenantClient(tx).tenantSourceConnection.findUnique({
      where: { tenantId_kind: { tenantId: tx.tenantId, kind: 'import' } },
      select: { id: true },
    });
    try {
      await tenantClient(tx).tenantSyncCheckpoint.create({
        data: {
          tenantId: tx.tenantId,
          id,
          system: 'import',
          kind: 'subscription',
          mode: input.mode,
          status: 'running',
          activeKey: IMPORT_ACTIVE_KEY,
          correlationId: input.correlationId,
          inputHash: input.inputHash,
          sourceConnectionId: connection?.id ?? null,
        },
      });
    } catch (error) {
      // A run started concurrently holds the active key (unique per tenant).
      try {
        translateDatabaseError(error, 'subscription run');
      } catch (translated) {
        if (translated instanceof UniqueConstraintError)
          throw new ImportAlreadyRunningError('concurrent');
        throw translated;
      }
    }
    return id;
  }

  async finish(
    tx: TenantTransaction,
    id: string,
    result: {
      status: 'completed' | 'failed' | 'cancelled';
      seen: number;
      changed: number;
      skipped: number;
      failed: number;
      errorCode?: string;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantSyncCheckpoint.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: {
        status: result.status,
        activeKey: null,
        recordsSeen: result.seen,
        recordsChanged: result.changed,
        recordsSkipped: result.skipped,
        recordsFailed: result.failed,
        lastErrorCode: result.errorCode ?? null,
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  /** When ownership facts became complete for the tenant, if ever. */
  async coverageKnownAsOf(tx: TenantTransaction): Promise<Date | undefined> {
    const row = await tenantClient(tx).tenantSyncCheckpoint.findFirst({
      where: {
        tenantId: tx.tenantId,
        kind: 'subscription',
        status: 'completed',
        mode: { in: ['import_full', 'backfill'] },
      },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    });
    return row?.completedAt ?? undefined;
  }

  async list(tx: TenantTransaction, limit = 20): Promise<SubscriptionRun[]> {
    return tenantClient(tx).tenantSyncCheckpoint.findMany({
      where: { tenantId: tx.tenantId, kind: 'subscription' },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }
}
