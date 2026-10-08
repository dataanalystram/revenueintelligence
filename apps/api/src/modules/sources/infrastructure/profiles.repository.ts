import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import {
  ProfileDocumentSchema,
  type CandidateProfile,
  type Finding,
  type FindingClass,
  type FindingSeverity,
  type ProfileDocument,
} from '../../domain';
import {
  tenantClient,
  translateDatabaseError,
  UniqueConstraintError,
  type TenantTransaction,
} from '../../tenancy';

/**
 * Persistence for source profiling (M9A plan §2): profile runs (mutable until
 * terminal), profiles and findings (immutable) through the app role. The
 * privileged retention purge lives in `profile-purge.store.ts`.
 */

export type ProfileRunStatus = 'requested' | 'running' | 'completed' | 'failed' | 'abandoned';
export type SamplingFamily = 'profile' | 'sync';

export interface ProfileRunRequest {
  readonly objects: ReadonlyArray<{ readonly object: string; readonly fields: readonly string[] }>;
  readonly sampling: 'full' | 'systematic' | 'recent' | 'head';
  readonly maxRows: number;
  /** Excluded fields opted in, with the actor that opted in (names only). */
  readonly optIns: ReadonlyArray<{
    readonly object: string;
    readonly field: string;
    readonly actor: string;
  }>;
}

export interface ProfileRun {
  readonly id: string;
  readonly connectionId: string;
  readonly schemaSnapshotHash: string;
  readonly status: ProfileRunStatus;
  readonly request: ProfileRunRequest;
  readonly sampling?: Readonly<Record<string, unknown>>;
  readonly errorCode?: string;
  readonly requestedBy: string;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
}

export interface StoredProfile {
  readonly id: string;
  readonly runId?: string;
  readonly syncRunId?: string;
  readonly connectionId: string;
  readonly object: string;
  readonly schemaSnapshotHash: string;
  readonly samplingFamily: SamplingFamily;
  readonly previousProfileId?: string;
  readonly document: ProfileDocument;
  readonly contentHash: string;
  readonly createdAt: Date;
}

export interface StoredFinding {
  readonly id: string;
  readonly profileId: string;
  readonly code: string;
  readonly class: FindingClass;
  readonly severity: FindingSeverity;
  readonly object: string;
  readonly field?: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface NewProfile {
  readonly object: string;
  readonly document: ProfileDocument;
  readonly contentHash: string;
  readonly previousProfileId?: string;
  readonly findings: readonly Finding[];
}

export class ProfileRunActiveError extends Error {
  readonly code = 'profile_run_active';
  constructor() {
    super('a profile run is already active for this connection');
    this.name = 'ProfileRunActiveError';
  }
}

type RunRow = NonNullable<
  Awaited<ReturnType<ReturnType<typeof tenantClient>['tenantSourceProfileRun']['findFirst']>>
>;
type ProfileRow = NonNullable<
  Awaited<ReturnType<ReturnType<typeof tenantClient>['tenantSourceProfile']['findFirst']>>
>;
type FindingRow = NonNullable<
  Awaited<ReturnType<ReturnType<typeof tenantClient>['tenantSourceProfileFinding']['findFirst']>>
>;

function toRun(row: RunRow): ProfileRun {
  return {
    id: row.id,
    connectionId: row.connectionId,
    schemaSnapshotHash: row.schemaSnapshotHash,
    status: row.status as ProfileRunStatus,
    request: row.request as unknown as ProfileRunRequest,
    ...(row.sampling ? { sampling: row.sampling as Record<string, unknown> } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    requestedBy: row.requestedBy,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
  };
}

function toProfile(row: ProfileRow): StoredProfile {
  return {
    id: row.id,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.syncRunId ? { syncRunId: row.syncRunId } : {}),
    connectionId: row.connectionId,
    object: row.object,
    schemaSnapshotHash: row.schemaSnapshotHash,
    samplingFamily: row.samplingFamily as SamplingFamily,
    ...(row.previousProfileId ? { previousProfileId: row.previousProfileId } : {}),
    // Re-validated on read: a stored document always satisfies the v1 schema.
    document: ProfileDocumentSchema.parse(row.document),
    contentHash: row.contentHash,
    createdAt: row.createdAt,
  };
}

function toFinding(row: FindingRow): StoredFinding {
  return {
    id: row.id,
    profileId: row.profileId,
    code: row.code,
    class: row.class as FindingClass,
    severity: row.severity as FindingSeverity,
    object: row.object,
    ...(row.field ? { field: row.field } : {}),
    evidence: row.evidence as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

async function guard<T>(entity: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    translateDatabaseError(error, entity);
  }
}

@Injectable()
export class ProfilesRepository {
  // --- Runs -------------------------------------------------------------------

  /** Creates a `requested` run; one active run per connection (unique active key). */
  async createRun(
    tx: TenantTransaction,
    input: {
      connectionId: string;
      schemaSnapshotHash: string;
      request: ProfileRunRequest;
      requestedBy: string;
      correlationId: string;
    },
  ): Promise<ProfileRun> {
    try {
      const row = await tenantClient(tx).tenantSourceProfileRun.create({
        data: {
          tenantId: tx.tenantId,
          id: randomUUID(),
          connectionId: input.connectionId,
          schemaSnapshotHash: input.schemaSnapshotHash,
          status: 'requested',
          activeKey: input.connectionId,
          request: input.request as unknown as Prisma.InputJsonObject,
          requestedBy: input.requestedBy,
          correlationId: input.correlationId,
        },
      });
      return toRun(row);
    } catch (error) {
      try {
        translateDatabaseError(error, 'profile run');
      } catch (translated) {
        if (translated instanceof UniqueConstraintError) throw new ProfileRunActiveError();
        throw translated;
      }
      throw error;
    }
  }

  async run(tx: TenantTransaction, id: string): Promise<ProfileRun | undefined> {
    const row = await tenantClient(tx).tenantSourceProfileRun.findUnique({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
    });
    return row ? toRun(row) : undefined;
  }

  async listRuns(tx: TenantTransaction, connectionId: string, limit = 20): Promise<ProfileRun[]> {
    const rows = await tenantClient(tx).tenantSourceProfileRun.findMany({
      where: { tenantId: tx.tenantId, connectionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toRun);
  }

  /** requested → running (restarts keep `running`: a retried attempt rebuilds from scratch). */
  async markRunning(tx: TenantTransaction, id: string, at: Date): Promise<ProfileRun> {
    const row = await guard('profile run', () =>
      tenantClient(tx).tenantSourceProfileRun.update({
        where: { tenantId_id: { tenantId: tx.tenantId, id } },
        data: { status: 'running', startedAt: at },
      }),
    );
    return toRun(row);
  }

  /** running|requested → failed|abandoned (terminal; frees the active key). */
  async failRun(
    tx: TenantTransaction,
    id: string,
    status: 'failed' | 'abandoned',
    errorCode: string,
    at: Date,
  ): Promise<void> {
    await guard('profile run', () =>
      tenantClient(tx).tenantSourceProfileRun.update({
        where: { tenantId_id: { tenantId: tx.tenantId, id } },
        data: { status, errorCode, activeKey: null, finishedAt: at },
      }),
    );
  }

  /**
   * Inserts every object's profile and findings and marks the run completed,
   * in the caller's transaction (all or nothing).
   */
  async completeRun(
    tx: TenantTransaction,
    run: ProfileRun,
    sampling: Record<string, unknown>,
    profiles: readonly NewProfile[],
    at: Date,
  ): Promise<StoredProfile[]> {
    const stored: StoredProfile[] = [];
    for (const p of profiles) {
      stored.push(
        await this.insertProfile(tx, {
          runId: run.id,
          connectionId: run.connectionId,
          schemaSnapshotHash: run.schemaSnapshotHash,
          samplingFamily: 'profile',
          profile: p,
        }),
      );
    }
    await guard('profile run', () =>
      tenantClient(tx).tenantSourceProfileRun.update({
        where: { tenantId_id: { tenantId: tx.tenantId, id: run.id } },
        data: {
          status: 'completed',
          sampling: sampling as Prisma.InputJsonObject,
          activeKey: null,
          finishedAt: at,
        },
      }),
    );
    return stored;
  }

  /** A run-quality profile from a sync run (family `sync`), in the run's completion transaction. */
  async insertSyncProfile(
    tx: TenantTransaction,
    input: {
      syncRunId: string;
      connectionId: string;
      schemaSnapshotHash: string;
      profile: NewProfile;
    },
  ): Promise<StoredProfile> {
    return this.insertProfile(tx, { ...input, samplingFamily: 'sync' });
  }

  private async insertProfile(
    tx: TenantTransaction,
    input: {
      runId?: string;
      syncRunId?: string;
      connectionId: string;
      schemaSnapshotHash: string;
      samplingFamily: SamplingFamily;
      profile: NewProfile;
    },
  ): Promise<StoredProfile> {
    const db = tenantClient(tx);
    const id = randomUUID();
    const row = await guard('source profile', () =>
      db.tenantSourceProfile.create({
        data: {
          tenantId: tx.tenantId,
          id,
          runId: input.runId ?? null,
          syncRunId: input.syncRunId ?? null,
          connectionId: input.connectionId,
          object: input.profile.object,
          schemaSnapshotHash: input.schemaSnapshotHash,
          samplingFamily: input.samplingFamily,
          previousProfileId: input.profile.previousProfileId ?? null,
          document: input.profile.document,
          documentVersion: input.profile.document.v,
          contentHash: input.profile.contentHash,
        },
      }),
    );
    if (input.profile.findings.length > 0) {
      await guard('profile finding', () =>
        db.tenantSourceProfileFinding.createMany({
          data: input.profile.findings.map((f) => ({
            tenantId: tx.tenantId,
            id: randomUUID(),
            profileId: id,
            code: f.code,
            class: f.class,
            severity: f.severity,
            object: input.profile.object,
            field: f.field,
            evidence: f.evidence as Prisma.InputJsonObject,
          })),
        }),
      );
    }
    return toProfile(row);
  }

  // --- Reads ------------------------------------------------------------------

  async profile(tx: TenantTransaction, id: string): Promise<StoredProfile | undefined> {
    const row = await tenantClient(tx).tenantSourceProfile.findUnique({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
    });
    return row ? toProfile(row) : undefined;
  }

  /** The newest profile of an object in a sampling family (the drift baseline). */
  async latestProfile(
    tx: TenantTransaction,
    connectionId: string,
    object: string,
    family: SamplingFamily,
  ): Promise<StoredProfile | undefined> {
    const row = await tenantClient(tx).tenantSourceProfile.findFirst({
      where: { tenantId: tx.tenantId, connectionId, object, samplingFamily: family },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return row ? toProfile(row) : undefined;
  }

  async profilesOfRun(tx: TenantTransaction, runId: string): Promise<StoredProfile[]> {
    const rows = await tenantClient(tx).tenantSourceProfile.findMany({
      where: { tenantId: tx.tenantId, runId },
      orderBy: { object: 'asc' },
    });
    return rows.map(toProfile);
  }

  async findings(
    tx: TenantTransaction,
    filter: { profileIds: readonly string[]; severity?: FindingSeverity },
  ): Promise<StoredFinding[]> {
    const rows = await tenantClient(tx).tenantSourceProfileFinding.findMany({
      where: {
        tenantId: tx.tenantId,
        profileId: { in: [...filter.profileIds] },
        ...(filter.severity ? { severity: filter.severity } : {}),
      },
      orderBy: [{ profileId: 'asc' }, { code: 'asc' }, { field: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toFinding);
  }

  /**
   * Publish candidates (M9A §7.1): every profile-family profile of the
   * connection on `schemaSnapshotHash`, with its run's state and findings.
   * The pure validator applies the covering rules.
   */
  async candidateProfiles(
    tx: TenantTransaction,
    connectionId: string,
    schemaSnapshotHash: string,
  ): Promise<CandidateProfile[]> {
    const db = tenantClient(tx);
    const rows = await db.tenantSourceProfile.findMany({
      where: { tenantId: tx.tenantId, connectionId, schemaSnapshotHash, samplingFamily: 'profile' },
      include: { run: true, findings: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 200,
    });
    return rows.map((row) => {
      const request = row.run?.request as unknown as ProfileRunRequest | undefined;
      return {
        id: row.id,
        family: 'profile' as const,
        runStatus: row.run?.status ?? 'unknown',
        finishedAt: row.run?.finishedAt ?? null,
        schemaSnapshotHash: row.schemaSnapshotHash,
        document: ProfileDocumentSchema.parse(row.document),
        optedIn: (request?.optIns ?? []).filter((o) => o.object === row.object).map((o) => o.field),
        findings: row.findings.map((f) => ({
          id: f.id,
          code: f.code,
          class: f.class as FindingClass,
          severity: f.severity as FindingSeverity,
          field: f.field,
        })),
      };
    });
  }
}
