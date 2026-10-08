import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import {
  AuthorityDocumentSchema,
  ConnectorKindSchema,
  ProofAcceptanceSchema,
  type AuthorityDocument,
  type ProofAcceptance,
  type ConnectorKind,
} from '../../domain';
import { tenantClient, translateDatabaseError, type TenantTransaction } from '../../tenancy';

export interface SourceConnection {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly label: string;
  readonly status: 'enabled' | 'disabled';
  readonly mappingMode: 'versioned' | 'code';
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialName?: string;
  readonly lastTestCode?: string;
  readonly lastTestedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredSnapshot {
  readonly connectionId: string;
  readonly hash: string;
  readonly sourceVersion?: string;
  readonly document: unknown;
  readonly capturedAt: Date;
  readonly capturedBy: string;
}

export interface StoredMappingVersion {
  readonly connectionId: string;
  readonly version: number;
  readonly baseVersion: number;
  readonly document: unknown;
  readonly contentHash: string;
  readonly schemaSnapshotHash: string;
  readonly authorityVersion: number;
  readonly validation: unknown;
  readonly publishedBy: string;
  readonly publishedAt: Date;
}

export interface StoredAuthorityVersion {
  readonly version: number;
  readonly baseVersion: number;
  readonly document: AuthorityDocument;
  /** M9A: stable-snapshot proof acceptances (never a higher tier). */
  readonly proofAcceptances: readonly ProofAcceptance[];
  readonly contentHash: string;
  readonly publishedBy: string;
  readonly publishedAt: Date;
}

export type SourceRunMode = 'backfill' | 'reconcile';

export interface SourceRun {
  readonly id: string;
  readonly system: string;
  readonly mode: SourceRunMode;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly sourceConnectionId: string;
  readonly mappingVersion: number;
  readonly cursor?: string;
  /** Full runs: the bounded-set boundary. Incremental runs: the window start. */
  readonly windowSince?: Date;
  readonly highWatermark?: Date;
  readonly pageNo: number;
  readonly recordsSeen: number;
  readonly recordsChanged: number;
  readonly recordsSkipped: number;
  readonly recordsFailed: number;
  readonly quality: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly lastErrorCode?: string;
}

type RunRow = Awaited<
  ReturnType<ReturnType<typeof tenantClient>['tenantSyncCheckpoint']['findFirst']>
>;

function toRun(row: NonNullable<RunRow>): SourceRun {
  return {
    id: row.id,
    system: row.system,
    mode: row.mode as SourceRunMode,
    status: row.status as SourceRun['status'],
    sourceConnectionId: row.sourceConnectionId!,
    mappingVersion: row.mappingVersion!,
    ...(row.cursor ? { cursor: row.cursor } : {}),
    ...(row.windowSince ? { windowSince: row.windowSince } : {}),
    ...(row.highWatermark ? { highWatermark: row.highWatermark } : {}),
    pageNo: row.pageNo,
    recordsSeen: row.recordsSeen,
    recordsChanged: row.recordsChanged,
    recordsSkipped: row.recordsSkipped,
    recordsFailed: row.recordsFailed,
    quality: (row.quality ?? {}) as Record<string, unknown>,
    correlationId: row.correlationId,
    startedAt: row.startedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
  };
}

const FACT_COLUMNS = {
  account_profile: 'accountProfileConnectionId',
  person_profile: 'personProfileConnectionId',
  subscription_lines: 'subscriptionLinesConnectionId',
  subscription_state: 'subscriptionStateConnectionId',
  subscription_terms: 'subscriptionTermsConnectionId',
} as const;

/** One active source run per connection (full and incremental exclude each other). */
export const sourceRunActiveKey = (connectionId: string) => `source:${connectionId}`;

async function guard<T>(entity: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    translateDatabaseError(error, entity);
  }
}

/** Persistence for source connections, snapshots, mappings, authority and runs. */
@Injectable()
export class SourcesRepository {
  // --- Connections ------------------------------------------------------------

  async listConnections(tx: TenantTransaction): Promise<SourceConnection[]> {
    const rows = await tenantClient(tx).tenantSourceConnection.findMany({
      where: { tenantId: tx.tenantId },
      orderBy: { kind: 'asc' },
    });
    return rows.map(toConnection);
  }

  async connection(tx: TenantTransaction, id: string): Promise<SourceConnection | undefined> {
    const row = await tenantClient(tx).tenantSourceConnection.findUnique({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
    });
    return row ? toConnection(row) : undefined;
  }

  async connectionByKind(
    tx: TenantTransaction,
    kind: string,
  ): Promise<SourceConnection | undefined> {
    const row = await tenantClient(tx).tenantSourceConnection.findUnique({
      where: { tenantId_kind: { tenantId: tx.tenantId, kind } },
    });
    return row ? toConnection(row) : undefined;
  }

  async createConnection(
    tx: TenantTransaction,
    input: {
      kind: ConnectorKind;
      label: string;
      mappingMode: 'versioned' | 'code';
      config: Record<string, unknown>;
      credentialName?: string;
    },
  ): Promise<SourceConnection> {
    const row = await guard('source connection', () =>
      tenantClient(tx).tenantSourceConnection.create({
        data: {
          tenantId: tx.tenantId,
          id: randomUUID(),
          kind: input.kind,
          label: input.label,
          status: 'disabled',
          mappingMode: input.mappingMode,
          config: input.config as Prisma.InputJsonObject,
          credentialName: input.credentialName ?? null,
        },
      }),
    );
    return toConnection(row);
  }

  async updateConnection(
    tx: TenantTransaction,
    id: string,
    change: {
      label?: string;
      status?: 'enabled' | 'disabled';
      config?: Record<string, unknown>;
      credentialName?: string | null;
    },
  ): Promise<SourceConnection> {
    const row = await guard('source connection', () =>
      tenantClient(tx).tenantSourceConnection.update({
        where: { tenantId_id: { tenantId: tx.tenantId, id } },
        data: {
          ...(change.label !== undefined ? { label: change.label } : {}),
          ...(change.status !== undefined ? { status: change.status } : {}),
          ...(change.config !== undefined
            ? { config: change.config as Prisma.InputJsonObject }
            : {}),
          ...(change.credentialName !== undefined ? { credentialName: change.credentialName } : {}),
          updatedAt: new Date(),
        },
      }),
    );
    return toConnection(row);
  }

  async recordTest(tx: TenantTransaction, id: string, code: string, at: Date): Promise<void> {
    await tenantClient(tx).tenantSourceConnection.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: { lastTestCode: code, lastTestedAt: at, updatedAt: at },
    });
  }

  // --- Schema snapshots -------------------------------------------------------

  /** Stores a snapshot unless an identical one exists (snapshots are immutable). */
  async insertSnapshot(
    tx: TenantTransaction,
    input: {
      connectionId: string;
      hash: string;
      sourceVersion?: string;
      document: unknown;
      capturedBy: string;
    },
  ): Promise<{ created: boolean }> {
    const result = await tenantClient(tx).tenantSourceSchemaSnapshot.createMany({
      data: [
        {
          tenantId: tx.tenantId,
          connectionId: input.connectionId,
          hash: input.hash,
          sourceVersion: input.sourceVersion ?? null,
          document: input.document as Prisma.InputJsonValue,
          capturedBy: input.capturedBy,
        },
      ],
      skipDuplicates: true,
    });
    return { created: result.count === 1 };
  }

  async latestSnapshot(
    tx: TenantTransaction,
    connectionId: string,
  ): Promise<StoredSnapshot | undefined> {
    const row = await tenantClient(tx).tenantSourceSchemaSnapshot.findFirst({
      where: { tenantId: tx.tenantId, connectionId },
      orderBy: [{ capturedAt: 'desc' }, { hash: 'asc' }],
    });
    return row ? toSnapshot(row) : undefined;
  }

  async snapshot(
    tx: TenantTransaction,
    connectionId: string,
    hash: string,
  ): Promise<StoredSnapshot | undefined> {
    const row = await tenantClient(tx).tenantSourceSchemaSnapshot.findUnique({
      where: { tenantId_connectionId_hash: { tenantId: tx.tenantId, connectionId, hash } },
    });
    return row ? toSnapshot(row) : undefined;
  }

  // --- Mapping versions -------------------------------------------------------

  async latestMapping(
    tx: TenantTransaction,
    connectionId: string,
  ): Promise<StoredMappingVersion | undefined> {
    const row = await tenantClient(tx).tenantSourceMappingVersion.findFirst({
      where: { tenantId: tx.tenantId, connectionId },
      orderBy: { version: 'desc' },
    });
    return row ? toMapping(row) : undefined;
  }

  async mappingVersion(
    tx: TenantTransaction,
    connectionId: string,
    version: number,
  ): Promise<StoredMappingVersion | undefined> {
    const row = await tenantClient(tx).tenantSourceMappingVersion.findUnique({
      where: { tenantId_connectionId_version: { tenantId: tx.tenantId, connectionId, version } },
    });
    return row ? toMapping(row) : undefined;
  }

  async insertMapping(
    tx: TenantTransaction,
    input: Omit<StoredMappingVersion, 'publishedAt'>,
  ): Promise<StoredMappingVersion> {
    const row = await guard('mapping version', () =>
      tenantClient(tx).tenantSourceMappingVersion.create({
        data: {
          tenantId: tx.tenantId,
          connectionId: input.connectionId,
          version: input.version,
          baseVersion: input.baseVersion,
          document: input.document as Prisma.InputJsonValue,
          contentHash: input.contentHash,
          schemaSnapshotHash: input.schemaSnapshotHash,
          authorityVersion: input.authorityVersion,
          validation: input.validation as Prisma.InputJsonValue,
          publishedBy: input.publishedBy,
        },
      }),
    );
    return toMapping(row);
  }

  // --- Authority --------------------------------------------------------------

  async latestAuthority(tx: TenantTransaction): Promise<StoredAuthorityVersion | undefined> {
    const row = await tenantClient(tx).tenantSourceAuthorityVersion.findFirst({
      where: { tenantId: tx.tenantId },
      orderBy: { version: 'desc' },
    });
    return row ? toAuthority(row) : undefined;
  }

  async insertAuthority(
    tx: TenantTransaction,
    input: {
      version: number;
      document: AuthorityDocument;
      contentHash: string;
      publishedBy: string;
      proofAcceptances?: readonly ProofAcceptance[];
    },
  ): Promise<StoredAuthorityVersion> {
    const facts = input.document.facts;
    const row = await guard('authority version', () =>
      tenantClient(tx).tenantSourceAuthorityVersion.create({
        data: {
          tenantId: tx.tenantId,
          version: input.version,
          baseVersion: input.version - 1,
          accountProfileConnectionId: facts.account_profile,
          personProfileConnectionId: facts.person_profile,
          subscriptionLinesConnectionId: facts.subscription_lines,
          subscriptionStateConnectionId: facts.subscription_state,
          subscriptionTermsConnectionId: facts.subscription_terms,
          contentHash: input.contentHash,
          publishedBy: input.publishedBy,
          proofAcceptances: input.proofAcceptances ?? [],
        },
      }),
    );
    return toAuthority(row);
  }

  // --- Runs (tenant_sync_checkpoints, kind = subscription) ---------------------

  async activeRun(tx: TenantTransaction, connectionId: string): Promise<SourceRun | undefined> {
    const row = await tenantClient(tx).tenantSyncCheckpoint.findFirst({
      where: { tenantId: tx.tenantId, activeKey: sourceRunActiveKey(connectionId) },
    });
    return row ? toRun(row) : undefined;
  }

  async run(tx: TenantTransaction, id: string): Promise<SourceRun | undefined> {
    const row = await tenantClient(tx).tenantSyncCheckpoint.findUnique({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
    });
    return row && row.sourceConnectionId && row.mappingVersion !== null ? toRun(row) : undefined;
  }

  async startRun(
    tx: TenantTransaction,
    input: {
      system: string;
      mode: SourceRunMode;
      connectionId: string;
      mappingVersion: number;
      correlationId: string;
      windowSince: Date;
      pageSize: number;
    },
  ): Promise<SourceRun> {
    const row = await guard('source run', () =>
      tenantClient(tx).tenantSyncCheckpoint.create({
        data: {
          tenantId: tx.tenantId,
          id: randomUUID(),
          system: input.system,
          kind: 'subscription',
          mode: input.mode,
          status: 'running',
          activeKey: sourceRunActiveKey(input.connectionId),
          sourceConnectionId: input.connectionId,
          mappingVersion: input.mappingVersion,
          correlationId: input.correlationId,
          windowSince: input.windowSince,
          pageSize: input.pageSize,
          quality: {},
        },
      }),
    );
    return toRun(row);
  }

  async progress(
    tx: TenantTransaction,
    id: string,
    change: {
      cursor?: string | null;
      pageNo: number;
      seen: number;
      changed: number;
      skipped: number;
      failed: number;
      quality: Record<string, unknown>;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantSyncCheckpoint.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: {
        ...(change.cursor !== undefined ? { cursor: change.cursor } : {}),
        pageNo: change.pageNo,
        recordsSeen: change.seen,
        recordsChanged: change.changed,
        recordsSkipped: change.skipped,
        recordsFailed: change.failed,
        quality: change.quality as Prisma.InputJsonObject,
        updatedAt: new Date(),
      },
    });
  }

  async finishRun(
    tx: TenantTransaction,
    id: string,
    result: {
      status: 'completed' | 'failed' | 'cancelled';
      errorCode?: string;
      highWatermark?: Date;
      quality: Record<string, unknown>;
      seen: number;
      changed: number;
      skipped: number;
      failed: number;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantSyncCheckpoint.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: {
        status: result.status,
        activeKey: null,
        cursor: null,
        lastErrorCode: result.errorCode ?? null,
        ...(result.highWatermark ? { highWatermark: result.highWatermark } : {}),
        quality: result.quality as Prisma.InputJsonObject,
        recordsSeen: result.seen,
        recordsChanged: result.changed,
        recordsSkipped: result.skipped,
        recordsFailed: result.failed,
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  /** The latest completed run of a connection (any mode, or one mode). */
  async latestCompletedRun(
    tx: TenantTransaction,
    connectionId: string,
    mode?: SourceRunMode,
  ): Promise<SourceRun | undefined> {
    const row = await tenantClient(tx).tenantSyncCheckpoint.findFirst({
      where: {
        tenantId: tx.tenantId,
        sourceConnectionId: connectionId,
        kind: 'subscription',
        status: 'completed',
        mappingVersion: { not: null },
        ...(mode ? { mode } : {}),
      },
      orderBy: { completedAt: 'desc' },
    });
    return row ? toRun(row) : undefined;
  }

  async listRuns(tx: TenantTransaction, connectionId: string, limit = 20): Promise<SourceRun[]> {
    const rows = await tenantClient(tx).tenantSyncCheckpoint.findMany({
      where: {
        tenantId: tx.tenantId,
        sourceConnectionId: connectionId,
        kind: 'subscription',
        mappingVersion: { not: null },
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return rows.map(toRun);
  }

  /** Canonical company of a source account reference, following merges. */
  async companyForRef(
    tx: TenantTransaction,
    system: string,
    objectType: string,
    externalId: string,
  ): Promise<string | undefined> {
    const db = tenantClient(tx);
    const ref = await db.companyExternalRef.findUnique({
      where: {
        tenantId_system_objectType_externalId: {
          tenantId: tx.tenantId,
          system,
          objectType,
          externalId,
        },
      },
      select: { companyId: true },
    });
    let current = ref?.companyId;
    for (let hops = 0; current && hops < 20; hops += 1) {
      const company = await db.company.findUnique({
        where: { tenantId_id: { tenantId: tx.tenantId, id: current } },
        select: { recordState: true, mergedIntoId: true },
      });
      if (!company || company.recordState !== 'merged' || !company.mergedIntoId) return current;
      current = company.mergedIntoId;
    }
    return current;
  }

  /** Which of these source account ids already have a canonical reference. */
  async knownRefs(
    tx: TenantTransaction,
    system: string,
    objectType: string,
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tenantClient(tx).companyExternalRef.findMany({
      where: { tenantId: tx.tenantId, system, objectType, externalId: { in: [...ids] } },
      select: { externalId: true },
    });
    return new Set(rows.map((r) => r.externalId));
  }
}

function toConnection(row: {
  id: string;
  kind: string;
  label: string;
  status: string;
  mappingMode: string;
  config: unknown;
  credentialName: string | null;
  lastTestCode: string | null;
  lastTestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SourceConnection {
  return {
    id: row.id,
    kind: ConnectorKindSchema.parse(row.kind),
    label: row.label,
    status: row.status as SourceConnection['status'],
    mappingMode: row.mappingMode as SourceConnection['mappingMode'],
    config: (row.config ?? {}) as Record<string, unknown>,
    ...(row.credentialName ? { credentialName: row.credentialName } : {}),
    ...(row.lastTestCode ? { lastTestCode: row.lastTestCode } : {}),
    ...(row.lastTestedAt ? { lastTestedAt: row.lastTestedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSnapshot(row: {
  connectionId: string;
  hash: string;
  sourceVersion: string | null;
  document: unknown;
  capturedAt: Date;
  capturedBy: string;
}): StoredSnapshot {
  return {
    connectionId: row.connectionId,
    hash: row.hash,
    ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}),
    document: row.document,
    capturedAt: row.capturedAt,
    capturedBy: row.capturedBy,
  };
}

function toMapping(row: StoredMappingVersion): StoredMappingVersion {
  return {
    connectionId: row.connectionId,
    version: row.version,
    baseVersion: row.baseVersion,
    document: row.document,
    contentHash: row.contentHash,
    schemaSnapshotHash: row.schemaSnapshotHash,
    authorityVersion: row.authorityVersion,
    validation: row.validation,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
  };
}

function toAuthority(row: {
  version: number;
  baseVersion: number;
  accountProfileConnectionId: string | null;
  personProfileConnectionId: string | null;
  subscriptionLinesConnectionId: string | null;
  subscriptionStateConnectionId: string | null;
  subscriptionTermsConnectionId: string | null;
  contentHash: string;
  publishedBy: string;
  publishedAt: Date;
  proofAcceptances?: unknown;
}): StoredAuthorityVersion {
  const facts = Object.fromEntries(
    Object.entries(FACT_COLUMNS).map(([fact, column]) => [fact, row[column]]),
  );
  return {
    version: row.version,
    baseVersion: row.baseVersion,
    document: AuthorityDocumentSchema.parse({ facts }),
    proofAcceptances: ProofAcceptanceSchema.array().parse(row.proofAcceptances ?? []),
    contentHash: row.contentHash,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
  };
}
