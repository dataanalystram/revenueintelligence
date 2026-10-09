import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ContextIngestionService, type IngestMeta } from '../../context';
import {
  acceptsStableSnapshot,
  assertNoRawFinding,
  buildProfileDocument,
  capFindings,
  DISTINCT_EXACT_CAP,
  detectSchemaDrift,
  documentFindings,
  driftFindings,
  failsRunWhenUnattributable,
  holdingsConfirmed,
  mayTombstone,
  objectAccumulatorFor,
  profileContentHash,
  profileNames,
  protectionFor,
  requiresAcceptance,
  requiresRepublish,
  RunGuards,
  runProof,
  isAuthoritative,
  isConnectorError,
  mapContextRecord,
  MappingDocumentSchema,
  mappedFields,
  mapSubscriptionRecord,
  SourceSchemaSchema,
  type AuthorityDocument,
  type ExternalSystem,
  type ObjectAccumulator,
  type FallbackAccount,
  type MappingDocument,
  type ObjectCapabilities,
  type ObjectMapping,
  type ProofMethod,
  type ReadSelection,
  type SourceConnector,
  type SourceProductStatus,
  type SourceRecord,
  type SourceSchema,
} from '../../domain';
import {
  OwnershipGapService,
  ProductCatalogueService,
  SubscriptionIngestionService,
  type OwnershipGap,
  type SubscriptionIngestMeta,
} from '../../products';
import {
  assertAuthorized,
  AuditTrail,
  TenantDatabase,
  type AuthorizedContext,
  type TenantContext,
} from '../../tenancy';
import { MetricsService } from '../../../platform/metrics';
import { QueueService } from '../../../platform/queue';
import { ConnectionNotFoundError, SourcesError, SyncRefusedError } from '../errors';
import { ProfilesRepository, type NewProfile } from '../infrastructure/profiles.repository';
import {
  SourcesRepository,
  type SourceConnection,
  type SourceRun,
} from '../infrastructure/sources.repository';
import { SOURCE_SYNC_JOB, SOURCES_QUEUE, sourceSyncJobId } from '../jobs';
import { SourceConnectionsService } from './source-connections.service';

export type SyncMode = 'full' | 'incremental';

export interface StartedSync {
  readonly runId: string;
  /** True when a run of this connection was already active (no second run). */
  readonly alreadyRunning: boolean;
}

export interface SyncResult {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'not_running';
  readonly errorCode?: string;
  readonly quality: Readonly<Record<string, unknown>>;
}

/** Hard cap so a misbehaving source can never loop a run forever. */
const MAX_PAGES = 100_000;
const MAX_IDS_PER_READ = 100;
const DEFAULT_PAGE_SIZE = 200;
/** Unmodelled product ids listed in a run's quality output (identifiers only). */
const MAX_LISTED_IDS = 50;

interface RunContext {
  readonly ctx: TenantContext;
  /** M10A1: the run's authorization for canonical writes (source_sync actor). */
  readonly actx: AuthorizedContext<'canonical.source_sync'>;
  readonly run: SourceRun;
  readonly connection: SourceConnection;
  readonly kind: ExternalSystem;
  readonly mapping: MappingDocument;
  readonly mappingVersion: number;
  readonly snapshot: SourceSchema;
  /** The snapshot the mapping version was validated against (run-quality profiles). */
  readonly snapshotHash: string;
  readonly authority: AuthorityDocument;
  /** The authority version's stable-snapshot acceptances (ADR 0023; never promote a tier). */
  readonly acceptances: readonly unknown[];
  readonly connector: SourceConnector;
  readonly boundary: Date;
  readonly observedAt: Date;
  readonly cause: 'backfill' | 'reconciliation';
}

/**
 * M9B (G4): one parent's child set as observed in this run. `uncertain` once
 * anything about it is not positive, complete, accepted evidence.
 */
interface ChildSet {
  readonly keys: Set<string>;
  readonly page: number;
  uncertain: boolean;
  deleted: boolean;
}

/** Coordinates of a held (secret-like) field value; never the value. */
interface HeldCoordinate {
  readonly object: string;
  readonly recordId: string;
  readonly field: string;
  readonly pattern: string;
}
const MAX_HELD_LISTED = 100;

/** Mutable run counters: counts and codes only, never values. */
class RunState {
  seen = 0;
  changed = 0;
  skipped = 0;
  failed = 0;
  pageNo = 0;
  readonly quality: Record<string, number> = {};
  readonly detail: Record<string, unknown> = {};
  readonly gaps = new Map<string, OwnershipGap>();
  readonly seenLineIds = new Set<string>();
  readonly holdingIds = new Set<string>();
  /**
   * M9A §9: keys seen in this run whose observation was not accepted. A key is
   * in at most one of `holdingIds` and `seenButRejected`; the tombstone pass
   * deletes only keys in neither. Rebuilt from scratch on every attempt.
   */
  readonly seenButRejected = new Map<string, { readonly code: string }>();
  /** Value rejections with no attributable account (the run fails before tombstones). */
  unattributable = 0;
  readonly knownAccounts = new Set<string>();
  readonly orphanAccounts = new Set<string>();
  /** Structural B guards and run-quality accumulators per mapped object (counts only). */
  readonly guards = new Map<string, RunGuards>();
  readonly accumulators = new Map<string, ObjectAccumulator>();
  readonly populations = new Map<string, number>();
  /** M9B: the full-read proof methods this run passed (the weakest decides the tier). */
  readonly proofs = new Set<ProofMethod>();
  /** M9B (G4): observed child sets per derived object and parent key. */
  readonly childSets = new Map<string, Map<string, ChildSet>>();
  /** M9B (G4): derived objects whose child sets cannot be trusted this run at all. */
  readonly childObjectsUncertain = new Set<string>();
  /** M9B (G4): pages of each derived object processed so far (split-parent detection). */
  readonly childPages = new Map<string, number>();
  /** Active canonical line ids per object, loaded once per run when needed. */
  readonly activeLines = new Map<string, readonly string[]>();
  /**
   * M9B: account objects whose references this full run may retire, with
   * every id the run saw for them (read, rejected, or referenced by a line).
   * `uncertain` once a record without a readable id was read.
   */
  readonly retirement = new Map<string, { readonly seen: Set<string>; uncertain: boolean }>();

  count(code: string, by = 1): void {
    this.quality[code] = (this.quality[code] ?? 0) + by;
  }

  /**
   * M10A1 amendment A1: a field value refused as secret-like and held. Counted
   * under `secret_like_value` and listed by coordinates (object, record id,
   * field, pattern code), bounded; the value itself is never part of the run.
   */
  hold(object: string, recordId: string, field: string, pattern: string): void {
    this.count('secret_like_value');
    const list = (this.detail.secret_like_held ??= []) as HeldCoordinate[];
    if (list.length < MAX_HELD_LISTED) list.push({ object, recordId, field, pattern });
  }

  snapshot(): Record<string, unknown> {
    const gapAccounts = new Set([...this.gaps.values()].map((g) => g.companyId)).size;
    return {
      ...this.quality,
      ...(gapAccounts > 0 ? { ownership_gap: gapAccounts } : {}),
      ...(this.seenButRejected.size > 0 ? { seen_but_rejected: this.seenButRejected.size } : {}),
      ...this.detail,
    };
  }
}

/**
 * Source synchronisation (ADR 0020 §12–17): full runs with full-read proof,
 * product-catalogue phase first, per-account ownership gaps and the tombstone
 * pass; incremental runs with a durable watermark and a per-connection
 * overlap. Canonical facts are written only through the existing single
 * writers. A run that cannot prove completeness never establishes coverage
 * and never tombstones.
 */
@Injectable()
export class SourceSyncService {
  private readonly logger = new Logger('SourceSync');

  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: SourcesRepository,
    private readonly connections: SourceConnectionsService,
    private readonly context: ContextIngestionService,
    private readonly subscriptions: SubscriptionIngestionService,
    private readonly catalogue: ProductCatalogueService,
    private readonly gaps: OwnershipGapService,
    private readonly profiles: ProfilesRepository,
    private readonly audit: AuditTrail,
    @Optional() @Inject(QueueService) private readonly queues?: QueueService,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  /**
   * Starts a run (pre-flight checks first) and, unless `enqueue` is false,
   * queues it for the worker. A connection has at most one active run.
   */
  async start(
    actx: AuthorizedContext<'data.sync.run'>,
    connectionId: string,
    mode: SyncMode,
    options: { correlationId?: string; enqueue?: boolean; now?: Date } = {},
  ): Promise<StartedSync> {
    assertAuthorized(actx, 'data.sync.run');
    const ctx = actx.tenant;
    const correlationId = options.correlationId ?? actx.correlationId ?? randomUUID();
    const started = await this.db.transaction(ctx, async (tx) => {
      const connection = await this.repo.connection(tx, connectionId);
      if (!connection) throw new ConnectionNotFoundError(connectionId);
      const active = await this.repo.activeRun(tx, connectionId);
      if (active) return { run: active, alreadyRunning: true };
      const mapping = await this.repo.latestMapping(tx, connectionId);
      const authority = await this.repo.latestAuthority(tx);
      this.preflight(
        connection,
        mapping ? MappingDocumentSchema.parse(mapping.document) : undefined,
        authority?.document,
      );
      const now = options.now ?? new Date();
      let windowSince = now;
      if (mode === 'incremental') {
        const overlap = this.connections.syncSettings(connection)?.overlapMinutes;
        if (overlap === undefined) {
          throw new SyncRefusedError(
            'overlap_not_configured',
            'Set sync.overlapMinutes on the connection',
          );
        }
        // M9B: objects not proven safe for incremental reads are read by full runs only.
        const published = MappingDocumentSchema.parse(mapping!.document);
        const snap = await this.repo.snapshot(tx, connectionId, mapping!.schemaSnapshotHash);
        const objects = snap ? SourceSchemaSchema.parse(snap.document).objects : [];
        const fullOnly = published.objects.filter(
          (o) => objects.find((x) => x.name === o.source)?.capabilities.incrementalReads === false,
        );
        if (fullOnly.length > 0) {
          throw new SyncRefusedError(
            'incremental_not_supported',
            `${fullOnly.map((o) => o.source).join(', ')} can only be read by full runs`,
          );
        }
        const last = await this.repo.latestCompletedRun(tx, connectionId);
        if (!last?.highWatermark) {
          throw new SyncRefusedError('no_watermark', 'Run a full synchronisation first');
        }
        windowSince = new Date(last.highWatermark.getTime() - overlap * 60_000);
      }
      const run = await this.repo.startRun(tx, {
        system: connection.kind,
        mode: mode === 'full' ? 'backfill' : 'reconcile',
        connectionId,
        mappingVersion: mapping!.version,
        correlationId,
        windowSince,
        pageSize: DEFAULT_PAGE_SIZE,
      });
      await this.audit.record(tx, actx, {
        action: 'sync.start',
        targetKind: 'sync_run',
        targetRef: run.id,
        details: { connectionId, mode, mappingVersion: mapping!.version },
      });
      return { run, alreadyRunning: false };
    });
    if (!started.alreadyRunning && options.enqueue !== false) {
      if (!this.queues) throw new SourcesError('queue_unavailable', 'No queue in this process');
      await this.queues.add(
        SOURCES_QUEUE,
        SOURCE_SYNC_JOB,
        { v: 1, tenantId: ctx.tenantId, checkpointId: started.run.id, correlationId },
        { jobId: sourceSyncJobId(started.run.id) },
      );
    }
    return { runId: started.run.id, alreadyRunning: started.alreadyRunning };
  }

  /**
   * Executes (or resumes) a running run to completion. Transient source
   * failures are rethrown with the run still running (the job retries and
   * resumes); anything else fails the run with a stable code.
   */
  async execute(
    actx: AuthorizedContext<'canonical.source_sync'>,
    runId: string,
  ): Promise<SyncResult> {
    assertAuthorized(actx, 'canonical.source_sync');
    const ctx = actx.tenant;
    const loaded = await this.db.transaction(ctx, async (tx) => {
      const run = await this.repo.run(tx, runId);
      if (!run || run.status !== 'running') return undefined;
      const connection = await this.repo.connection(tx, run.sourceConnectionId);
      const mapping = await this.repo.mappingVersion(
        tx,
        run.sourceConnectionId,
        run.mappingVersion,
      );
      const snapshot = mapping
        ? await this.repo.snapshot(tx, run.sourceConnectionId, mapping.schemaSnapshotHash)
        : undefined;
      const authority = await this.repo.latestAuthority(tx);
      return { run, connection, mapping, snapshot, authority };
    });
    if (!loaded) return { runId, status: 'not_running', quality: {} };
    const { run } = loaded;
    const state = new RunState();
    if (run.mode === 'reconcile') {
      // An incremental run resumes from its stored position and counters.
      state.seen = run.recordsSeen;
      state.changed = run.recordsChanged;
      state.skipped = run.recordsSkipped;
      state.failed = run.recordsFailed;
      state.pageNo = run.pageNo;
      for (const [k, v] of Object.entries(run.quality))
        if (typeof v === 'number') state.quality[k] = v;
    }
    try {
      if (!loaded.connection || !loaded.mapping || !loaded.snapshot) {
        throw new SyncRefusedError('mapping_not_published', 'The run has no published mapping');
      }
      const mapping = MappingDocumentSchema.parse(loaded.mapping.document);
      this.preflight(loaded.connection, mapping, loaded.authority?.document);
      const rc: RunContext = {
        ctx,
        actx,
        run,
        connection: loaded.connection,
        kind: loaded.connection.kind as ExternalSystem,
        mapping,
        mappingVersion: loaded.mapping.version,
        snapshot: SourceSchemaSchema.parse(loaded.snapshot.document),
        snapshotHash: loaded.mapping.schemaSnapshotHash,
        authority: loaded.authority!.document,
        acceptances: loaded.authority!.proofAcceptances,
        connector: this.connections.connector(ctx, loaded.connection),
        // M9B: a settle window keeps eventually consistent list reads behind the boundary.
        boundary: new Date(
          run.startedAt.getTime() -
            (this.connections.syncSettings(loaded.connection)?.settleMinutes ?? 0) * 60_000,
        ),
        observedAt: new Date(),
        cause: run.mode === 'backfill' ? 'backfill' : 'reconciliation',
      };
      await this.checkDrift(rc, state);
      if (run.mode === 'backfill') await this.full(rc, state);
      else await this.incremental(rc, state);
      await this.db.transaction(ctx, (tx) =>
        this.audit.record(
          tx,
          actx,
          {
            action: 'sync.finish',
            targetKind: 'sync_run',
            targetRef: runId,
            details: { status: 'completed', seen: state.seen, changed: state.changed },
          },
          'completed',
        ),
      );
      this.metrics?.increment('lip_source_runs', {
        kind: rc.kind,
        mode: run.mode,
        outcome: 'completed',
      });
      return { runId, status: 'completed', quality: state.snapshot() };
    } catch (err) {
      if (isConnectorError(err) && err.retryable) throw err;
      const code = errorCode(err);
      state.count(code === 'schema_drift' || code === 'unstable_read' ? code : 'run_failed');
      await this.db.transaction(ctx, async (tx) => {
        await this.repo.finishRun(tx, runId, {
          status: 'failed',
          errorCode: code,
          quality: state.snapshot(),
          seen: state.seen,
          changed: state.changed,
          skipped: state.skipped,
          failed: state.failed,
        });
        await this.audit.record(
          tx,
          actx,
          {
            action: 'sync.finish',
            targetKind: 'sync_run',
            targetRef: runId,
            details: { status: 'failed', code },
          },
          'completed',
        );
      });
      this.metrics?.increment('lip_source_runs', {
        kind: loaded.connection?.kind ?? 'unknown',
        mode: run.mode,
        outcome: 'failed',
      });
      this.metrics?.increment('lip_source_mapping_errors', { code });
      this.logger.warn({ runId, code }, 'Source run failed');
      return { runId, status: 'failed', errorCode: code, quality: state.snapshot() };
    }
  }

  /** Marks a run failed (dead-lettered job); nothing else changes. */
  async abandon(
    actx: AuthorizedContext<'data.sync.run'>,
    runId: string,
    code: string,
  ): Promise<void> {
    assertAuthorized(actx, 'data.sync.run');
    await this.db.transaction(actx.tenant, async (tx) => {
      const run = await this.repo.run(tx, runId);
      if (!run || run.status !== 'running') return;
      await this.audit.record(tx, actx, {
        action: 'sync.abandon',
        targetKind: 'sync_run',
        targetRef: runId,
        details: { code },
      });
      await this.repo.finishRun(tx, runId, {
        status: 'failed',
        errorCode: code,
        quality: run.quality,
        seen: run.recordsSeen,
        changed: run.recordsChanged,
        skipped: run.recordsSkipped,
        failed: run.recordsFailed,
      });
    });
  }

  // --- Pre-flight -------------------------------------------------------------

  private preflight(
    connection: SourceConnection,
    mapping: MappingDocument | undefined,
    authority: AuthorityDocument | undefined,
  ): void {
    if (connection.mappingMode !== 'versioned') {
      throw new SyncRefusedError('mapping_not_versioned', `${connection.kind} is mapped in code`);
    }
    if (connection.status !== 'enabled') {
      throw new SyncRefusedError('connection_disabled', 'The connection is disabled');
    }
    if (!this.connections.hasAdapter(connection.kind)) {
      throw new SyncRefusedError(
        'adapter_not_registered',
        `No source adapter is registered for ${connection.kind} in this process`,
      );
    }
    if (!mapping) throw new SyncRefusedError('mapping_not_published', 'No published mapping');
    if (!authority) throw new SyncRefusedError('authority_missing', 'No authority version');
    // M9A §10.4: a holding filter published before M9A has no reviewed domain.
    if (requiresRepublish(mapping)) {
      throw new SyncRefusedError(
        'mapping_requires_republish',
        'A holding filter has no reviewed domain: republish the mapping with one',
      );
    }
    const lineObjects = mapping.objects.filter((o) => o.entity === 'subscription');
    if (lineObjects.length > 0) {
      if (!isAuthoritative(authority, 'subscription_lines', connection.id)) {
        throw new SyncRefusedError(
          'not_authoritative_for_lines',
          'The connection is not the authority for subscription_lines',
        );
      }
      if (!lineObjects.every(holdingsConfirmed)) {
        throw new SyncRefusedError('holding_filter_required', 'Holdings are not confirmed');
      }
    }
  }

  /** Validates the mapped surface before any canonical write (ADR 0019 §6). */
  private async checkDrift(rc: RunContext, state: RunState): Promise<void> {
    const current = await rc.connector.describeSchema();
    const drift = detectSchemaDrift(rc.mapping, rc.snapshot, current);
    for (const d of drift) state.count(d.code);
    if (drift.some((d) => d.blocking)) {
      state.detail.drift = drift
        .filter((d) => d.blocking)
        .map((d) => `${d.code}:${d.object}${d.field ? `.${d.field}` : ''}`);
      throw new SyncRefusedError('schema_drift', 'The mapped source schema changed');
    }
  }

  // --- Full run ---------------------------------------------------------------

  private async full(rc: RunContext, state: RunState): Promise<void> {
    const selection: ReadSelection = { mode: 'full', boundary: rc.boundary };
    // 1. Accounts and people: references (and profiles with authority).
    for (const obj of rc.mapping.objects.filter((o) => o.entity !== 'subscription')) {
      const onPage = async (records: readonly SourceRecord[]) => {
        this.observe(rc, state, obj, records);
        this.noteSeen(state, obj, records);
        await this.ingestContext(rc, state, obj, records);
      };
      if (this.retiresReferences(rc, obj)) {
        // M9B: this run may retire the object's references, so its read must be proven.
        state.retirement.set(obj.source, { seen: new Set(), uncertain: false });
        await this.provenRead(rc, state, obj.source, mappedFields(obj), selection, onPage);
      } else {
        await this.readAll(rc, obj.source, mappedFields(obj), selection, onPage);
      }
    }
    const lineObjects = rc.mapping.objects.filter((o) => o.entity === 'subscription');
    if (lineObjects.length > 0) {
      // 2. Product catalogue first: a configuration gap fails before any line.
      const productStatus = await this.catalogueFull(rc, state);
      // 3. Lines, bounded and ordered, with start/end count reconciliation.
      for (const obj of lineObjects) {
        const population = await this.provenRead(
          rc,
          state,
          obj.source,
          this.readFields(rc, obj),
          selection,
          async (records, next) => {
            // B guards before writes (M9A §8): structural failure stops the run here.
            this.observe(rc, state, obj, records);
            await this.processLines(rc, state, obj, records, (id) => productStatus(id));
            await this.saveProgress(rc, state, next);
          },
        );
        state.populations.set(obj.source, population);
      }
    }
    // 4a. M9A: pre-tombstone B guards over the whole run, then unattributable rejections.
    this.guardAll(rc, state, 'pre_tombstone');
    this.refuseUnattributable(state);
    // 4b. M9B (G4): positive child-set evidence retires removed children (any proof).
    await this.reconcileChildren(rc, state);
    // The full-read proof this run passed: the weakest method decides (ADR 0023).
    const proof = runProof(state.proofs.has('double_enumeration') ? 'double_enumeration' : 'count');
    // A stable-snapshot proof deletes nothing until an operator accepted it for this connection.
    const tombstonesAllowed =
      !requiresAcceptance(proof.method) || acceptsStableSnapshot(rc.acceptances, rc.connection.id);
    if (lineObjects.length > 0 && !tombstonesAllowed) state.count('tombstones_not_accepted');
    if (lineObjects.length > 0 && tombstonesAllowed) {
      // 4b. Tombstones: lines in neither the run's holdings nor its protection set (§9.3).
      let suppressed = 0;
      for (const obj of lineObjects) {
        const active = await this.subscriptions.activeSourceRecordIds(rc.ctx, rc.kind, obj.source);
        if (state.childObjectsUncertain.has(obj.source)) {
          // M9B: a child set without usable parent keys proves no absence at all.
          suppressed += active.length;
          continue;
        }
        for (const recordId of active) {
          const key = `${obj.source}|${recordId}`;
          if (!mayTombstone(key, state.holdingIds, state.seenButRejected)) {
            if (state.seenButRejected.has(key)) suppressed += 1;
            continue;
          }
          const out = await this.subscriptions.ingest(
            rc.actx,
            {
              presence: 'absent',
              source: { system: rc.kind, objectType: obj.source, recordId },
              observedAt: rc.observedAt,
            },
            this.lineMeta(rc),
          );
          if (out.outcome === 'deleted') {
            state.changed += 1;
            state.count('tombstoned');
          }
        }
      }
      if (suppressed > 0) state.count('tombstones_suppressed', suppressed);
    }
    // 4d. M9B: account references this proven full read did not see — retired (in the
    // completion transaction below) only when the proof is accepted and nothing is uncertain.
    const retire = [...state.retirement].filter(([, r]) => {
      if (!tombstonesAllowed) state.count('reference_retirement_not_accepted');
      else if (r.uncertain) state.count('reference_retirement_suppressed');
      return tombstonesAllowed && !r.uncertain;
    });
    state.detail.proof = proof;
    const runQuality = await this.runQualityProfiles(rc, state);
    // 5. Complete: gaps replaced, run-quality profiles stored and the run completed in one transaction.
    // Counted locally: a rolled-back completion must not report retirements that never happened.
    let retired = 0;
    await this.db.transaction(rc.ctx, async (tx) => {
      if (lineObjects.length > 0) {
        await this.gaps.replaceWithin(tx, rc.connection.id, [...state.gaps.values()], rc.run.id);
      }
      await this.storeRunQuality(tx, rc, runQuality);
      retired = 0;
      for (const [object, r] of retire) {
        retired += await this.context.retireAbsentWithin(
          tx,
          {
            system: rc.kind,
            objectType: object,
            seen: r.seen,
            observedAt: rc.observedAt,
            runId: rc.run.id,
          },
          this.contextMeta(rc),
        );
      }
      await this.repo.finishRun(tx, rc.run.id, {
        status: 'completed',
        highWatermark: rc.boundary,
        quality: { ...state.snapshot(), ...(retired > 0 ? { references_retired: retired } : {}) },
        seen: state.seen,
        changed: state.changed + retired,
        skipped: state.skipped,
        failed: state.failed,
      });
    });
    if (retired > 0) {
      state.changed += retired;
      state.count('references_retired', retired);
    }
  }

  /** Reads the whole catalogue (ids only), proves it, and classifies product ids. */
  private async catalogueFull(
    rc: RunContext,
    state: RunState,
  ): Promise<(id: string) => SourceProductStatus> {
    const refs = rc.mapping.productReferences!;
    const selection: ReadSelection = { mode: 'full', boundary: rc.boundary };
    const catalogue = new Set<string>();
    await this.provenRead(rc, state, refs.object, [refs.identity.field], selection, (records) => {
      for (const r of records) {
        if (r.rejection) {
          // A catalogue record that cannot be read: its product is neither known nor unknown.
          throw new SyncRefusedError('unstable_read', 'A product catalogue record is invalid');
        }
        const id = text(r.values[refs.identity.field]);
        if (id) catalogue.add(id);
      }
      return Promise.resolve();
    });
    const { modelled, ignored } = await this.productSets(rc);
    const unmodelled = [...catalogue].filter((id) => !modelled.has(id) && !ignored.has(id)).sort();
    if (unmodelled.length > 0) {
      state.count('unmodelled_product_reference', unmodelled.length);
      state.detail.unmodelledProducts = unmodelled.slice(0, MAX_LISTED_IDS);
      throw new SyncRefusedError(
        'unmodelled_product_reference',
        `${unmodelled.length} source products are neither in the product model nor ignored`,
      );
    }
    return (id) =>
      ignored.has(id)
        ? 'ignored'
        : modelled.has(id)
          ? 'modelled'
          : catalogue.has(id)
            ? 'unmodelled'
            : 'orphan';
  }

  private async productSets(
    rc: RunContext,
  ): Promise<{ modelled: Set<string>; ignored: Set<string> }> {
    const refs = rc.mapping.productReferences!;
    const model = await this.catalogue.modelAt(rc.ctx, rc.observedAt);
    if (!model) throw new SyncRefusedError('no_product_model', 'No product model is in effect');
    const modelled = new Set(
      model.document.products.flatMap((p) =>
        p.externalRefs
          .filter((r) => r.system === rc.kind && r.objectType === refs.object)
          .map((r) => r.id),
      ),
    );
    return { modelled, ignored: new Set(refs.ignored.map((i) => i.id)) };
  }

  // --- Incremental run --------------------------------------------------------

  private async incremental(rc: RunContext, state: RunState): Promise<void> {
    const selection: ReadSelection = {
      mode: 'since',
      since: rc.run.windowSince!,
      boundary: rc.boundary,
    };
    for (const obj of rc.mapping.objects.filter((o) => o.entity !== 'subscription')) {
      await this.readAll(rc, obj.source, mappedFields(obj), selection, async (records) => {
        this.observe(rc, state, obj, records);
        await this.ingestContext(rc, state, obj, records);
      });
    }
    const lineObjects = rc.mapping.objects.filter((o) => o.entity === 'subscription');
    let productStatus: ((id: string) => SourceProductStatus) | undefined;
    if (lineObjects.length > 0) {
      const { modelled, ignored } = await this.productSets(rc);
      const known = new Map<string, SourceProductStatus>();
      const refs = rc.mapping.productReferences!;
      productStatus = (id) =>
        ignored.has(id) ? 'ignored' : modelled.has(id) ? 'modelled' : (known.get(id) ?? 'orphan');
      for (const obj of lineObjects) {
        const productRel = obj.relationships.find((r) => r.target === 'subscription.product')!;
        await this.readAll(
          rc,
          obj.source,
          this.readFields(rc, obj),
          selection,
          async (records, next) => {
            // Products neither modelled nor ignored: in the catalogue (unmodelled) or not (orphan).
            const unknown = [
              ...new Set(
                records
                  .map((r) => text(r.values[productRel.field]))
                  .filter(
                    (id): id is string =>
                      !!id && !modelled.has(id) && !ignored.has(id) && !known.has(id),
                  ),
              ),
            ];
            for (const found of await this.readIds(
              rc,
              refs.object,
              [refs.identity.field],
              unknown,
            )) {
              known.set(String(found.values[refs.identity.field] ?? found.id), 'unmodelled');
            }
            this.observe(rc, state, obj, records);
            await this.processLines(rc, state, obj, records, productStatus!);
            await this.saveProgress(rc, state, next);
          },
          rc.run.cursor,
        );
      }
    }
    // Incremental runs never tombstone and never replace gaps: they only add.
    this.guardAll(rc, state, 'pre_tombstone');
    this.refuseUnattributable(state);
    // M9B (G4): a re-read parent's complete child set is positive evidence on any run.
    await this.reconcileChildren(rc, state);
    const runQuality = await this.runQualityProfiles(rc, state);
    await this.db.transaction(rc.ctx, async (tx) => {
      await this.storeRunQuality(tx, rc, runQuality);
      if (lineObjects.length > 0) {
        await this.gaps.addWithin(tx, rc.connection.id, [...state.gaps.values()], rc.run.id);
      }
      await this.repo.finishRun(tx, rc.run.id, {
        status: 'completed',
        highWatermark: rc.boundary,
        quality: state.snapshot(),
        seen: state.seen,
        changed: state.changed,
        skipped: state.skipped,
        failed: state.failed,
      });
    });
  }

  // --- Shared steps -----------------------------------------------------------

  private async ingestContext(
    rc: RunContext,
    state: RunState,
    obj: ObjectMapping,
    records: readonly SourceRecord[],
  ): Promise<void> {
    const fact = obj.entity === 'person' ? 'person_profile' : 'account_profile';
    const profileAuthority = isAuthoritative(rc.authority, fact, rc.connection.id);
    for (const record of records) {
      if (record.rejection) {
        // M9B: structurally invalid — never mapped; a full run counts it as seen (no retirement).
        state.failed += 1;
        state.count('record_rejected');
        continue;
      }
      const result = mapContextRecord(obj, record, {
        kind: rc.kind,
        profileAuthority,
        observedAt: rc.observedAt,
      });
      if (result.outcome === 'skipped') {
        state.count(result.code);
        continue;
      }
      result.quality.forEach((q) => state.count(q));
      const ingested = await this.context.ingest(rc.actx, result.observation, this.contextMeta(rc));
      for (const h of ingested.held ?? [])
        state.hold(obj.source, result.observation.ref.id, h.field, h.code);
      if (obj.entity === 'account') state.knownAccounts.add(result.observation.ref.id);
    }
    this.metrics?.increment(
      'lip_source_records',
      { kind: rc.kind, object: obj.source.toLowerCase(), outcome: 'mapped' },
      records.length,
    );
  }

  /** Maps and writes one page of lines (accounts and fallbacks resolved in batches). */
  private async processLines(
    rc: RunContext,
    state: RunState,
    obj: ObjectMapping,
    records: readonly SourceRecord[],
    productStatus: (id: string) => SourceProductStatus,
  ): Promise<void> {
    const accountRel = obj.relationships.find((r) => r.target === 'subscription.account')!;
    const accountObject = accountRel.object!;
    const fallback = accountRel.fallbackVia;

    // One batched read for the page's fallback hops.
    const hops = new Map<string, FallbackAccount>();
    if (fallback) {
      const values = [
        ...new Set(
          records.map((r) => text(r.values[fallback.field])).filter((v): v is string => !!v),
        ),
      ];
      const found = await this.readIds(rc, fallback.object, [fallback.targetField], values);
      for (const v of values) hops.set(v, { kind: 'orphan' });
      for (const r of found) {
        const target = text(r.values[fallback.targetField]);
        hops.set(r.id, target ? { kind: 'account', id: target } : { kind: 'none' });
      }
    }

    // Accounts referenced by the page: known, ingested now, or orphans.
    const accountIds = new Set<string>();
    for (const r of records) {
      const primary = text(r.values[accountRel.field]);
      if (primary) accountIds.add(primary);
      const via = fallback ? text(r.values[fallback.field]) : undefined;
      const hop = via ? hops.get(via) : undefined;
      if (hop?.kind === 'account') accountIds.add(hop.id);
    }
    // M9B: an account a line refers to is not absent, whatever the account read returned.
    accountIds.forEach((id) => state.retirement.get(accountObject)?.seen.add(id));
    const unresolved = [...accountIds].filter(
      (id) => !state.knownAccounts.has(id) && !state.orphanAccounts.has(id),
    );
    const known = await this.db.transaction(rc.ctx, (tx) =>
      this.repo.knownRefs(tx, rc.kind, accountObject, unresolved),
    );
    known.forEach((id) => state.knownAccounts.add(id));
    const missing = unresolved.filter((id) => !known.has(id));
    if (missing.length > 0) {
      const accountMapping = rc.mapping.objects.find((o) => o.source === accountObject)!;
      const found = await this.readIds(rc, accountObject, mappedFields(accountMapping), missing);
      await this.ingestContext(rc, state, accountMapping, found);
      const foundIds = new Set(found.map((r) => r.id));
      missing.filter((id) => !foundIds.has(id)).forEach((id) => state.orphanAccounts.add(id));
    }

    // M9B (G4): derived child sets (one page carries a parent's complete set).
    const childOf = this.capabilities(rc, obj.source)?.childOf;
    const page = childOf ? (state.childPages.get(obj.source) ?? 0) + 1 : 0;
    if (childOf) state.childPages.set(obj.source, page);
    const sets = childOf ? this.childSetsOf(state, obj.source) : undefined;
    // Keys repeated within a page of a child set are ambiguous: every occurrence is rejected.
    const repeated = new Set<string>();
    if (childOf) {
      const counts = new Map<string, number>();
      for (const r of records) {
        if (r.rejection) continue;
        const k = lineIdOf(obj, r);
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      for (const [k, n] of counts) if (n > 1) repeated.add(k);
    }
    const childSet = (record: SourceRecord): ChildSet | undefined => {
      if (!childOf || !sets) return undefined;
      const parent = text(record.values[childOf.parentKeyField]);
      if (!parent || parent.includes(':')) {
        // A child without a usable parent key: no child set of this object can be trusted.
        state.childObjectsUncertain.add(obj.source);
        return undefined;
      }
      let set = sets.get(parent);
      if (!set) {
        set = { keys: new Set(), page, uncertain: false, deleted: false };
        sets.set(parent, set);
      } else if (set.page !== page) {
        // The parent was split across pages: its child set may be incomplete.
        set.uncertain = true;
      }
      return set;
    };

    for (const record of records) {
      state.seen += 1;
      const set = childSet(record);
      if (record.rejection) {
        // M9B: observed but structurally invalid. Never mapped, never reconciled.
        state.failed += 1;
        state.count('record_rejected');
        if (set) set.uncertain = true;
        const accountId = text(record.values[accountRel.field]);
        if (childOf) {
          const parent = text(record.values[childOf.parentKeyField]);
          await this.protectParent(rc, state, obj, accountObject, parent, accountId);
        } else {
          await this.protect(
            rc,
            state,
            obj,
            accountObject,
            record.id,
            'record_rejected',
            accountId,
          );
        }
        continue;
      }
      const lineId = lineIdOf(obj, record) ?? record.id;
      const key = `${obj.source}|${lineId}`;
      if (set) {
        set.keys.add(lineId);
        if (record.deleted) set.deleted = true;
      }
      if (repeated.has(lineId)) {
        // Duplicate child identity: fail closed (no write, protected, parent not reconciled).
        state.skipped += 1;
        state.count('duplicate_external_id');
        if (set) set.uncertain = true;
        await this.protect(
          rc,
          state,
          obj,
          accountObject,
          lineId,
          'duplicate_external_id',
          text(record.values[accountRel.field]),
        );
        continue;
      }
      if (state.seenLineIds.has(key)) state.count('duplicate_external_id');
      state.seenLineIds.add(key);
      const result = mapSubscriptionRecord(obj, record, {
        kind: rc.kind,
        productReferences: rc.mapping.productReferences!,
        authority: {
          state: isAuthoritative(rc.authority, 'subscription_state', rc.connection.id),
          terms: isAuthoritative(rc.authority, 'subscription_terms', rc.connection.id),
        },
        observedAt: rc.observedAt,
        accountStatus: (id) => (state.orphanAccounts.has(id) ? 'orphan' : 'known'),
        fallbackAccount: (value) => hops.get(value) ?? { kind: 'orphan' },
        productStatus,
      });
      switch (result.outcome) {
        case 'filtered_out':
          // A reviewed non-holding value: a confident exclusion (tombstonable).
          state.skipped += 1;
          state.count('filtered_out');
          break;
        case 'skipped': {
          state.skipped += 1;
          state.count(result.code);
          // A protected skip makes the parent's child set uncertain (G4 never retires its siblings).
          if (set && protectionFor(result.code).protect) set.uncertain = true;
          await this.protect(
            rc,
            state,
            obj,
            accountObject,
            lineId,
            result.code,
            result.gapAccountId,
          );
          break;
        }
        case 'rejected':
          state.count(result.code);
          state.detail.unmodelledProducts = [result.productId];
          throw new SyncRefusedError(result.code, 'A line references an unmodelled product');
        case 'ingest': {
          result.quality.forEach((q) => state.count(q));
          const out = await this.subscriptions.ingest(
            rc.actx,
            result.observation,
            this.lineMeta(rc),
          );
          if (out.outcome === 'rejected') {
            if (out.reason === 'invalid_observation') {
              state.failed += 1;
              state.count('record_rejected');
              if (set) set.uncertain = true;
              // M9A §9.2: the writer rejected the observation; its line is protected.
              await this.protect(
                rc,
                state,
                obj,
                accountObject,
                lineId,
                'invalid_observation',
                result.accountId,
              );
              break;
            }
            throw new SyncRefusedError(
              out.reason === 'unknown_account'
                ? 'unresolved_account_reference'
                : 'unresolved_product_reference',
              'The writer could not resolve a line reference',
            );
          }
          if (['created', 'updated', 'restored', 'deleted'].includes(out.outcome))
            state.changed += 1;
          if (result.observation.presence === 'present') {
            // A later accepted occurrence moves the key to the holdings (§9.3).
            state.seenButRejected.delete(key);
            state.holdingIds.add(key);
          } else {
            state.holdingIds.delete(key);
            state.seenButRejected.delete(key);
          }
          break;
        }
      }
    }
    this.metrics?.increment('lip_source_pages', {
      kind: rc.kind,
      object: obj.source.toLowerCase(),
    });
  }

  /**
   * Seen-but-rejected protection (M9A §9.2-§9.5): a protected record's key
   * enters the protection set and its account gets an ownership gap
   * (attributed by its account reference, else by its existing line). A value
   * rejection that cannot be attributed is counted; the run then fails
   * before any tombstone. Confident exclusions are not protected.
   */
  private async protect(
    rc: RunContext,
    state: RunState,
    obj: ObjectMapping,
    accountObject: string,
    recordId: string,
    code: string,
    accountId: string | undefined,
  ): Promise<void> {
    const decision = protectionFor(code);
    if (!decision.protect) return;
    const key = `${obj.source}|${recordId}`;
    state.holdingIds.delete(key);
    state.seenButRejected.set(key, { code });
    let companyId = accountId
      ? await this.db.transaction(rc.ctx, (tx) =>
          this.repo.companyForRef(tx, rc.kind, accountObject, accountId),
        )
      : undefined;
    // M8: a known account of a product-reference gap always has a canonical record.
    if (
      !companyId &&
      accountId &&
      (code === 'missing_product_reference' || code === 'orphan_product_reference')
    ) {
      throw new SyncRefusedError(
        'unresolved_account_reference',
        'A known account has no canonical record',
      );
    }
    companyId ??= await this.subscriptions.lineCompanyFor(rc.ctx, rc.kind, obj.source, recordId);
    if (companyId) {
      state.gaps.set(key, {
        companyId,
        sourceObjectType: obj.source,
        sourceRecordId: recordId,
        reason: decision.gapReason,
      });
    } else if (failsRunWhenUnattributable(decision)) {
      state.unattributable += 1;
      state.count('rejected_record_unattributable');
    }
  }

  /** Feeds a page into the run-quality accumulators and B guards; refuses before writes on a structural failure. */
  private observe(
    rc: RunContext,
    state: RunState,
    obj: ObjectMapping,
    records: readonly SourceRecord[],
  ): void {
    let guards = state.guards.get(obj.source);
    if (!guards) {
      guards = new RunGuards(obj);
      state.guards.set(obj.source, guards);
    }
    let acc = state.accumulators.get(obj.source);
    const object = rc.snapshot.objects.find((o) => o.name === obj.source);
    if (!acc && object) {
      acc = objectAccumulatorFor(object, mappedFields(obj));
      state.accumulators.set(obj.source, acc);
    }
    for (const record of records) {
      guards.observe(record);
      if (!record.deleted && !record.rejection) acc?.addRecord(record.values);
    }
    this.trip(state, guards.check('pre_write'));
  }

  private guardAll(rc: RunContext, state: RunState, stage: 'pre_tombstone'): void {
    for (const obj of rc.mapping.objects)
      this.trip(state, state.guards.get(obj.source)?.check(stage));
  }

  private trip(state: RunState, trip: ReturnType<RunGuards['check']>): void {
    if (!trip) return;
    state.count(trip.code);
    state.detail.guard = {
      code: trip.code,
      field: trip.field,
      seen: trip.seen,
      failing: trip.failing,
    };
    throw new SyncRefusedError(trip.code, `Structural guard ${trip.code} tripped on ${trip.field}`);
  }

  private refuseUnattributable(state: RunState): void {
    if (state.unattributable > 0) {
      throw new SyncRefusedError(
        'rejected_record_unattributable',
        `${state.unattributable} rejected record(s) cannot be attributed to an account`,
      );
    }
  }

  /**
   * Run-quality profiles (family `sync`, M9A §1.5): aggregates over the mapped
   * fields of every object read, with findings and drift against the previous
   * run-quality profile. A document that fails validation or the raw-value
   * scan is not stored (counted); it never fails the synchronisation.
   */
  private async runQualityProfiles(rc: RunContext, state: RunState): Promise<NewProfile[]> {
    const out: NewProfile[] = [];
    for (const obj of rc.mapping.objects) {
      const acc = state.accumulators.get(obj.source);
      const object = rc.snapshot.objects.find((o) => o.name === obj.source);
      if (!acc || !object) continue;
      try {
        const document = buildProfileDocument({
          object,
          connectionKind: rc.kind,
          schemaSnapshotHash: rc.snapshotHash,
          accumulator: acc,
          sampling: {
            method: 'sync',
            populationEstimate: state.populations.get(obj.source) ?? null,
            bounded: false,
            stride: null,
            orderedBy: null,
            evidence: [rc.run.mode === 'backfill' ? 'sync_full' : 'sync_incremental'],
          },
          maxRows: acc.rows,
          distinctCap: DISTINCT_EXACT_CAP,
          optedIn: new Set(),
        });
        const baseline = await this.db.transaction(rc.ctx, (tx) =>
          this.profiles.latestProfile(tx, rc.connection.id, obj.source, 'sync'),
        );
        const names = profileNames(object.fields.map((f) => f.name));
        const identity = new Set(
          [obj.identity.field, ...obj.relationships.map((r) => r.field)].map((f) =>
            names.toProfile(f),
          ),
        );
        const findings = capFindings([
          ...documentFindings(document, { identityFields: identity }),
          ...(baseline
            ? driftFindings(document, baseline.document, { identityFields: identity })
            : []),
        ]);
        for (const f of findings) assertNoRawFinding(f);
        out.push({
          object: obj.source,
          document,
          contentHash: profileContentHash(document),
          ...(baseline ? { previousProfileId: baseline.id } : {}),
          findings,
        });
      } catch (err) {
        this.logger.warn(
          { runId: rc.run.id, object: obj.source, code: errorCode(err) },
          'Run-quality profile not stored',
        );
        state.count('run_quality_profile_invalid');
      }
    }
    return out;
  }

  private async storeRunQuality(
    tx: Parameters<Parameters<TenantDatabase['transaction']>[1]>[0],
    rc: RunContext,
    profiles: readonly NewProfile[],
  ): Promise<void> {
    for (const profile of profiles) {
      await this.profiles.insertSyncProfile(tx, {
        syncRunId: rc.run.id,
        connectionId: rc.connection.id,
        schemaSnapshotHash: rc.snapshotHash,
        profile,
      });
    }
  }

  private async saveProgress(
    rc: RunContext,
    state: RunState,
    next: string | undefined,
  ): Promise<void> {
    state.pageNo += 1;
    await this.db.transaction(rc.ctx, (tx) =>
      this.repo.progress(tx, rc.run.id, {
        // Only incremental runs resume mid-read; a full run restarts its read under the same boundary.
        cursor: rc.run.mode === 'reconcile' ? (next ?? null) : null,
        pageNo: state.pageNo,
        seen: state.seen,
        changed: state.changed,
        skipped: state.skipped,
        failed: state.failed,
        quality: state.snapshot(),
      }),
    );
  }

  /** Every page of a bounded selection, in order. */
  private async readAll(
    rc: RunContext,
    object: string,
    fields: readonly string[],
    selection: ReadSelection,
    onPage: (records: readonly SourceRecord[], next: string | undefined) => Promise<void>,
    from?: string,
  ): Promise<void> {
    const pageSize = this.pageSize(rc, object);
    let position = from;
    // M9B: positions are opaque; a repeated one, or a page identical to the
    // previous one, is non-progress. The read stops at once (never a loop).
    const used = new Set<string>(position ? [position] : []);
    let previous: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await rc.connector.readRecords({
        purpose: 'sync',
        object,
        fields,
        selection,
        pageSize,
        ...(position ? { position } : {}),
      });
      const signature =
        result.records.length > 0
          ? `${result.records.length}|${result.records[0]!.id}|${result.records.at(-1)!.id}`
          : undefined;
      if (
        (result.next !== undefined && used.has(result.next)) ||
        (result.next !== undefined && signature !== undefined && signature === previous)
      ) {
        throw new SyncRefusedError(
          'pagination_stalled',
          `${object}: the source repeated a page position (non-progress)`,
        );
      }
      await onPage(result.records, result.next);
      if (!result.next) return;
      used.add(result.next);
      previous = signature;
      position = result.next;
    }
    throw new SyncRefusedError('page_limit_exceeded', 'The read exceeded the page limit');
  }

  /**
   * Reads a bounded selection with a full-read proof (ADR 0023): a count
   * before and after (`count`, externally grounded), or, for an object that
   * declares it, two enumerations with identical membership
   * (`double_enumeration`, stable snapshot). Returns the population read.
   * A failed proof is `unstable_read`: nothing is established.
   */
  private async provenRead(
    rc: RunContext,
    state: RunState,
    object: string,
    fields: readonly string[],
    selection: ReadSelection,
    onPage: (records: readonly SourceRecord[], next: string | undefined) => Promise<void>,
  ): Promise<number> {
    const capability = this.capabilities(rc, object);
    if (capability?.count && rc.connector.countRecords) {
      const before = await rc.connector.countRecords({ object, selection });
      let read = 0;
      await this.readAll(rc, object, fields, selection, async (records, next) => {
        read += records.length;
        await onPage(records, next);
      });
      const after = await rc.connector.countRecords({ object, selection });
      if (before !== after || after !== read) {
        state.detail.read = { object, expected: before, after, read };
        throw new SyncRefusedError('unstable_read', `${object} changed during the read`);
      }
      state.proofs.add('count');
      return read;
    }
    if (capability?.fullReadProof === 'double_enumeration') {
      const first = await this.enumerate(rc, object, capability, fields, selection, onPage);
      const proofFields = capability.childOf ? [capability.childOf.parentKeyField] : [];
      const second = await this.enumerate(rc, object, capability, proofFields, selection);
      if (first.size !== second.size || [...first].some((k) => !second.has(k))) {
        state.detail.read = { object, pass1: first.size, pass2: second.size };
        throw new SyncRefusedError(
          'unstable_read',
          `${object}: the two enumerations differ (membership changed during the read)`,
        );
      }
      state.proofs.add('double_enumeration');
      return first.size;
    }
    throw new SyncRefusedError(
      'unstable_read',
      `${object} can neither be counted nor double-enumerated: completeness cannot be proven`,
    );
  }

  /**
   * One exhausted traversal collecting membership keys: the record id, or for
   * a derived child set the parent key (a parent's children never span
   * pages). A key reappearing on a later page is unstable.
   */
  private async enumerate(
    rc: RunContext,
    object: string,
    capability: ObjectCapabilities,
    fields: readonly string[],
    selection: ReadSelection,
    onPage?: (records: readonly SourceRecord[], next: string | undefined) => Promise<void>,
  ): Promise<Set<string>> {
    const firstPage = new Map<string, number>();
    let page = 0;
    await this.readAll(rc, object, fields, selection, async (records, next) => {
      page += 1;
      for (const r of records) {
        const key = capability.childOf
          ? (text(r.values[capability.childOf.parentKeyField]) ?? `#${r.id}`)
          : r.id;
        const seenOn = firstPage.get(key);
        if (seenOn !== undefined && (seenOn !== page || !capability.childOf)) {
          throw new SyncRefusedError(
            'unstable_read',
            `${object}: a record appeared twice in one enumeration`,
          );
        }
        firstPage.set(key, page);
      }
      if (onPage) await onPage(records, next);
    });
    return new Set(firstPage.keys());
  }

  /** M9B: the connector declares that this account object's references may be retired. */
  private retiresReferences(rc: RunContext, obj: ObjectMapping): boolean {
    return (
      obj.entity === 'account' &&
      this.capabilities(rc, obj.source)?.referenceRetirement === 'accepted_full_read'
    );
  }

  /** M9B: records the ids a retiring full run saw (accepted or rejected; never deleted ones). */
  private noteSeen(state: RunState, obj: ObjectMapping, records: readonly SourceRecord[]): void {
    const tracked = state.retirement.get(obj.source);
    if (!tracked) return;
    for (const record of records) {
      if (record.deleted) continue;
      const id =
        text(record.values[obj.identity.field]) ?? (record.rejection ? undefined : text(record.id));
      if (id) tracked.seen.add(id);
      else tracked.uncertain = true;
    }
  }

  private capabilities(rc: RunContext, object: string): ObjectCapabilities | undefined {
    return rc.snapshot.objects.find((o) => o.name === object)?.capabilities;
  }

  /** The mapped fields of an object, plus a derived child set's parent key (G4). */
  private readFields(rc: RunContext, obj: ObjectMapping): string[] {
    const fields = mappedFields(obj);
    const parentKey = this.capabilities(rc, obj.source)?.childOf?.parentKeyField;
    return parentKey && !fields.includes(parentKey) ? [...fields, parentKey] : fields;
  }

  private childSetsOf(state: RunState, object: string): Map<string, ChildSet> {
    let sets = state.childSets.get(object);
    if (!sets) {
      sets = new Map();
      state.childSets.set(object, sets);
    }
    return sets;
  }

  private async activeLinesOf(rc: RunContext, state: RunState, object: string) {
    let ids = state.activeLines.get(object);
    if (!ids) {
      ids = await this.subscriptions.activeSourceRecordIds(rc.ctx, rc.kind, object);
      state.activeLines.set(object, ids);
    }
    return ids;
  }

  /**
   * A structurally rejected parent (M9B CB35): every existing line of that
   * parent is protected (no tombstone, no retirement) with a gap on its
   * account. Without a parent key, or with no existing line and no account to
   * attribute, the rejection is unattributable and the run fails (M9A §9.4).
   */
  private async protectParent(
    rc: RunContext,
    state: RunState,
    obj: ObjectMapping,
    accountObject: string,
    parent: string | undefined,
    accountId: string | undefined,
  ): Promise<void> {
    if (!parent) {
      state.childObjectsUncertain.add(obj.source);
      state.unattributable += 1;
      state.count('rejected_record_unattributable');
      return;
    }
    const lines = (await this.activeLinesOf(rc, state, obj.source)).filter((id) =>
      id.startsWith(`${parent}:`),
    );
    for (const id of lines) {
      await this.protect(rc, state, obj, accountObject, id, 'record_rejected', accountId);
    }
    if (lines.length === 0) {
      await this.protect(rc, state, obj, accountObject, `${parent}:`, 'record_rejected', accountId);
    }
  }

  /**
   * Parent-scoped child reconciliation (M9B G4). For a derived child set, a
   * parent observed in this run with a complete, accepted child set is
   * positive evidence: its active lines whose keys are absent from that set
   * are retired. Never for a parent that was rejected, split across pages,
   * deleted, had any rejected, protected or duplicated child, or for an
   * object whose child sets are uncertain. Runs only after every read and
   * guard succeeded (a failed run never reaches it).
   */
  private async reconcileChildren(rc: RunContext, state: RunState): Promise<void> {
    for (const [object, sets] of state.childSets) {
      if (state.childObjectsUncertain.has(object)) {
        state.count('child_reconciliation_skipped');
        continue;
      }
      const active = await this.subscriptions.activeSourceRecordIds(rc.ctx, rc.kind, object);
      for (const [parent, set] of sets) {
        if (set.uncertain) {
          // An uncertain child set retires nothing: none of the parent's existing
          // lines may be tombstoned by this run either (full-run pass included).
          state.count('child_reconciliation_skipped');
          for (const id of active) {
            const key = `${object}|${id}`;
            if (!id.startsWith(`${parent}:`) || state.holdingIds.has(key)) continue;
            if (!state.seenButRejected.has(key)) {
              state.seenButRejected.set(key, { code: 'child_set_uncertain' });
              state.count('child_set_protected');
            }
          }
          continue;
        }
        if (set.deleted) continue;
        for (const id of active) {
          if (!id.startsWith(`${parent}:`) || set.keys.has(id)) continue;
          const key = `${object}|${id}`;
          if (!mayTombstone(key, state.holdingIds, state.seenButRejected)) continue;
          const out = await this.subscriptions.ingest(
            rc.actx,
            {
              presence: 'absent',
              source: { system: rc.kind, objectType: object, recordId: id },
              observedAt: rc.observedAt,
            },
            this.lineMeta(rc),
          );
          if (out.outcome === 'deleted') {
            state.changed += 1;
            state.count('child_retired');
          }
        }
      }
    }
  }

  private async readIds(
    rc: RunContext,
    object: string,
    fields: readonly string[],
    ids: readonly string[],
  ): Promise<SourceRecord[]> {
    const out: SourceRecord[] = [];
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_READ) {
      await this.readAll(
        rc,
        object,
        fields,
        { mode: 'ids', ids: ids.slice(i, i + MAX_IDS_PER_READ) },
        (records) => {
          out.push(...records);
          return Promise.resolve();
        },
      );
    }
    return out;
  }

  private pageSize(rc: RunContext, object: string): number {
    const max = rc.snapshot.objects.find((o) => o.name === object)?.capabilities.maxPageSize;
    return Math.max(1, Math.min(DEFAULT_PAGE_SIZE, max ?? DEFAULT_PAGE_SIZE));
  }

  private lineMeta(rc: RunContext): SubscriptionIngestMeta {
    return {
      cause: rc.cause,
      correlationId: rc.run.correlationId,
      checkpointId: rc.run.id,
      adapter: rc.kind,
      adapterVersion: rc.connector.capabilities().adapterVersion,
      sourceConnectionId: rc.connection.id,
      mappingVersion: rc.mappingVersion,
    };
  }

  private contextMeta(rc: RunContext): IngestMeta {
    return {
      cause: rc.cause,
      correlationId: rc.run.correlationId,
      checkpointId: rc.run.id,
      adapterVersion: rc.connector.capabilities().adapterVersion,
      mappingVersion: rc.mappingVersion,
    };
  }
}

/** The canonical source id of a line record: its mapped identity value, else the record id. */
function lineIdOf(obj: ObjectMapping, record: SourceRecord): string | undefined {
  return text(record.values[obj.identity.field]) ?? text(record.id);
}

function text(value: string | number | boolean | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

/** A stable, value-free code for a failed run. */
function errorCode(err: unknown): string {
  if (err instanceof SourcesError) return err.code;
  if (isConnectorError(err))
    return err.kind === 'schema_drift' ? 'schema_drift' : `source_${err.kind}`;
  return 'internal_error';
}
