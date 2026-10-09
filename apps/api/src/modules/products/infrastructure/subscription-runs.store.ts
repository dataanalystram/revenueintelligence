import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  proofOfRun,
  requiresAcceptance,
  acceptsStableSnapshot,
  type KnownCoverageTier,
  type ProofMetadata,
  type RunProof,
} from '../../domain';
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

export type TenantCoverage =
  | {
      readonly known: true;
      readonly knownAsOf: Date;
      /** The connection whose run established coverage (ownership gaps are scoped to it). */
      readonly connectionId: string;
      /** Versioned sources: only this system's lines are ownership facts (no cross-source lines). */
      readonly sourceSystem?: string;
      /** From the proof of the run that established coverage (ADR 0023); never configured. */
      readonly coverageTier: KnownCoverageTier;
      readonly proof: ProofMetadata;
    }
  | {
      readonly known: false;
      readonly reason: 'authority_unassigned' | 'no_complete_run' | 'proof_not_accepted';
    };

/** Operator acceptances of adapter-declared stable proofs, stored on an authority version. */

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
    const connectionId = await this.importConnectionId(tx);
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
          sourceConnectionId: connectionId ?? null,
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
      /** The full-read proof of a completed full load (M9A, ADR 0023). */
      proof?: RunProof;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantSyncCheckpoint.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: {
        status: result.status,
        ...(result.proof ? { quality: { proof: result.proof } } : {}),
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

  /**
   * Tenant ownership coverage (ADR 0020 §12). Known only from the connection
   * authoritative for `subscription_lines`:
   * - the `import` connection: its latest completed full import (M7 rule);
   * - a versioned connection: its latest completed full source run under the
   *   connection's latest mapping version, started after that connection
   *   became the authority. A run only completes when its full-read proof
   *   passed, so failed, partial or unstable runs never count.
   * Unassigned authority: unknown.
   */
  async coverage(tx: TenantTransaction): Promise<TenantCoverage> {
    const db = tenantClient(tx);
    const authority = await db.tenantSourceAuthorityVersion.findFirst({
      where: { tenantId: tx.tenantId },
      orderBy: { version: 'desc' },
    });
    const linesConnectionId = authority?.subscriptionLinesConnectionId ?? null;
    if (!authority || !linesConnectionId) return { known: false, reason: 'authority_unassigned' };
    const connection = await db.tenantSourceConnection.findUnique({
      where: { tenantId_id: { tenantId: tx.tenantId, id: linesConnectionId } },
      select: { id: true, kind: true },
    });
    if (!connection) return { known: false, reason: 'authority_unassigned' };
    if (connection.kind === 'import') {
      const row = await db.tenantSyncCheckpoint.findFirst({
        where: {
          tenantId: tx.tenantId,
          system: 'import',
          kind: 'subscription',
          status: 'completed',
          mode: 'import_full',
        },
        orderBy: { completedAt: 'desc' },
        select: { id: true, completedAt: true, quality: true },
      });
      if (!row?.completedAt) return { known: false, reason: 'no_complete_run' };
      // M7 CSV imports: an operator-declared full file (A2: stable_snapshot).
      // Runs completed before M9A carry no proof and are inferred the same way.
      const proof = proofOfRun(row.quality, 'operator_full_file');
      return {
        known: true,
        knownAsOf: row.completedAt,
        connectionId: connection.id,
        coverageTier: proof.tier,
        proof: {
          method: proof.method,
          tier: proof.tier,
          connectionId: connection.id,
          runId: row.id,
          completedAt: row.completedAt,
          inferred: proof.inferred,
        },
      };
    }
    // The current authority streak: since the last version that named someone else.
    const before = await db.tenantSourceAuthorityVersion.findFirst({
      where: {
        tenantId: tx.tenantId,
        OR: [
          { subscriptionLinesConnectionId: null },
          { subscriptionLinesConnectionId: { not: connection.id } },
        ],
      },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const since = await db.tenantSourceAuthorityVersion.findFirst({
      where: { tenantId: tx.tenantId, version: { gt: before?.version ?? 0 } },
      orderBy: { version: 'asc' },
      select: { publishedAt: true },
    });
    const mapping = await db.tenantSourceMappingVersion.findFirst({
      where: { tenantId: tx.tenantId, connectionId: connection.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    if (!mapping || !since) return { known: false, reason: 'no_complete_run' };
    const row = await db.tenantSyncCheckpoint.findFirst({
      where: {
        tenantId: tx.tenantId,
        sourceConnectionId: connection.id,
        kind: 'subscription',
        mode: 'backfill',
        status: 'completed',
        mappingVersion: mapping.version,
        startedAt: { gte: since.publishedAt },
      },
      orderBy: { completedAt: 'desc' },
      select: { id: true, completedAt: true, quality: true },
    });
    if (!row?.completedAt) return { known: false, reason: 'no_complete_run' };
    // The newest qualifying run decides the tier, so a weaker newer run lowers
    // it. Runs completed before M9A could only complete after a count proof.
    const proof = proofOfRun(row.quality, 'count');
    let acceptedInAuthorityVersion: number | undefined;
    if (requiresAcceptance(proof.method)) {
      if (!acceptsStableSnapshot(authority.proofAcceptances, connection.id)) {
        return { known: false, reason: 'proof_not_accepted' };
      }
      acceptedInAuthorityVersion = authority.version;
    }
    return {
      known: true,
      knownAsOf: row.completedAt,
      connectionId: connection.id,
      sourceSystem: connection.kind,
      coverageTier: proof.tier,
      proof: {
        method: proof.method,
        tier: proof.tier,
        connectionId: connection.id,
        runId: row.id,
        completedAt: row.completedAt,
        inferred: proof.inferred,
        ...(acceptedInAuthorityVersion !== undefined ? { acceptedInAuthorityVersion } : {}),
      },
    };
  }

  /** When ownership facts became complete for the tenant, if ever. */
  async coverageKnownAsOf(tx: TenantTransaction): Promise<Date | undefined> {
    const coverage = await this.coverage(tx);
    return coverage.known ? coverage.knownAsOf : undefined;
  }

  /** The tenant's `import` connection (M7 runs and provenance record it). */
  async importConnectionId(tx: TenantTransaction): Promise<string | undefined> {
    const row = await tenantClient(tx).tenantSourceConnection.findUnique({
      where: { tenantId_kind: { tenantId: tx.tenantId, kind: 'import' } },
      select: { id: true },
    });
    return row?.id;
  }

  async list(tx: TenantTransaction, limit = 20): Promise<SubscriptionRun[]> {
    return tenantClient(tx).tenantSyncCheckpoint.findMany({
      where: { tenantId: tx.tenantId, kind: 'subscription' },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }
}
