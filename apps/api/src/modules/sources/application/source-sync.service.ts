import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ContextIngestionService, type IngestMeta } from '../../context';
import {
  detectSchemaDrift,
  holdingsConfirmed,
  isAuthoritative,
  isConnectorError,
  mapContextRecord,
  MappingDocumentSchema,
  mappedFields,
  mapSubscriptionRecord,
  SourceSchemaSchema,
  type AuthorityDocument,
  type ExternalSystem,
  type FallbackAccount,
  type MappingDocument,
  type ObjectMapping,
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
import { TenantDatabase, type TenantContext } from '../../tenancy';
import { MetricsService } from '../../../platform/metrics';
import { QueueService } from '../../../platform/queue';
import { ConnectionNotFoundError, SourcesError, SyncRefusedError } from '../errors';
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
  readonly run: SourceRun;
  readonly connection: SourceConnection;
  readonly kind: ExternalSystem;
  readonly mapping: MappingDocument;
  readonly mappingVersion: number;
  readonly snapshot: SourceSchema;
  readonly authority: AuthorityDocument;
  readonly connector: SourceConnector;
  readonly boundary: Date;
  readonly observedAt: Date;
  readonly cause: 'backfill' | 'reconciliation';
}

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
  readonly knownAccounts = new Set<string>();
  readonly orphanAccounts = new Set<string>();

  count(code: string, by = 1): void {
    this.quality[code] = (this.quality[code] ?? 0) + by;
  }

  snapshot(): Record<string, unknown> {
    const gapAccounts = new Set([...this.gaps.values()].map((g) => g.companyId)).size;
    return {
      ...this.quality,
      ...(gapAccounts > 0 ? { ownership_gap: gapAccounts } : {}),
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
    @Optional() @Inject(QueueService) private readonly queues?: QueueService,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  /**
   * Starts a run (pre-flight checks first) and, unless `enqueue` is false,
   * queues it for the worker. A connection has at most one active run.
   */
  async start(
    ctx: TenantContext,
    connectionId: string,
    mode: SyncMode,
    options: { correlationId?: string; enqueue?: boolean; now?: Date } = {},
  ): Promise<StartedSync> {
    const correlationId = options.correlationId ?? randomUUID();
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
  async execute(ctx: TenantContext, runId: string): Promise<SyncResult> {
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
        run,
        connection: loaded.connection,
        kind: loaded.connection.kind as ExternalSystem,
        mapping,
        mappingVersion: loaded.mapping.version,
        snapshot: SourceSchemaSchema.parse(loaded.snapshot.document),
        authority: loaded.authority!.document,
        connector: this.connections.connector(ctx, loaded.connection),
        boundary: run.startedAt,
        observedAt: new Date(),
        cause: run.mode === 'backfill' ? 'backfill' : 'reconciliation',
      };
      await this.checkDrift(rc, state);
      if (run.mode === 'backfill') await this.full(rc, state);
      else await this.incremental(rc, state);
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
      await this.db.transaction(ctx, (tx) =>
        this.repo.finishRun(tx, runId, {
          status: 'failed',
          errorCode: code,
          quality: state.snapshot(),
          seen: state.seen,
          changed: state.changed,
          skipped: state.skipped,
          failed: state.failed,
        }),
      );
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
  async abandon(ctx: TenantContext, runId: string, code: string): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      const run = await this.repo.run(tx, runId);
      if (!run || run.status !== 'running') return;
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
    if (!mapping) throw new SyncRefusedError('mapping_not_published', 'No published mapping');
    if (!authority) throw new SyncRefusedError('authority_missing', 'No authority version');
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
      await this.readAll(rc, obj.source, mappedFields(obj), selection, async (records) => {
        await this.ingestContext(rc, state, obj, records);
      });
    }
    const lineObjects = rc.mapping.objects.filter((o) => o.entity === 'subscription');
    if (lineObjects.length > 0) {
      // 2. Product catalogue first: a configuration gap fails before any line.
      const productStatus = await this.catalogueFull(rc, state);
      // 3. Lines, bounded and ordered, with start/end count reconciliation.
      for (const obj of lineObjects) {
        const before = await this.countOrRefuse(rc, obj.source, selection);
        let read = 0;
        await this.readAll(rc, obj.source, mappedFields(obj), selection, async (records, next) => {
          read += records.length;
          await this.processLines(rc, state, obj, records, (id) => productStatus(id));
          await this.saveProgress(rc, state, next);
        });
        const after = await this.countOrRefuse(rc, obj.source, selection);
        if (before !== after || after !== read) {
          state.detail.read = { expected: before, after, read };
          throw new SyncRefusedError('unstable_read', 'The source changed during the read');
        }
      }
      // 4. Tombstones: this connection's lines not seen as holdings (proof passed).
      for (const obj of lineObjects) {
        const active = await this.subscriptions.activeSourceRecordIds(rc.ctx, rc.kind, obj.source);
        for (const recordId of active) {
          if (state.holdingIds.has(`${obj.source}|${recordId}`)) continue;
          const out = await this.subscriptions.ingest(
            rc.ctx,
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
    }
    // 5. Complete: gaps replaced and the run completed in one transaction.
    await this.db.transaction(rc.ctx, async (tx) => {
      if (lineObjects.length > 0) {
        await this.gaps.replaceWithin(tx, rc.connection.id, [...state.gaps.values()], rc.run.id);
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

  /** Reads the whole catalogue (ids only), proves it, and classifies product ids. */
  private async catalogueFull(
    rc: RunContext,
    state: RunState,
  ): Promise<(id: string) => SourceProductStatus> {
    const refs = rc.mapping.productReferences!;
    const selection: ReadSelection = { mode: 'full', boundary: rc.boundary };
    const before = await this.countOrRefuse(rc, refs.object, selection);
    const catalogue = new Set<string>();
    let read = 0;
    await this.readAll(rc, refs.object, [refs.identity.field], selection, (records) => {
      read += records.length;
      for (const r of records) {
        const id = text(r.values[refs.identity.field]);
        if (id) catalogue.add(id);
      }
      return Promise.resolve();
    });
    const after = await this.countOrRefuse(rc, refs.object, selection);
    if (before !== after || after !== read) {
      state.detail.read = { object: refs.object, expected: before, after, read };
      throw new SyncRefusedError('unstable_read', 'The product catalogue changed during the read');
    }
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
          mappedFields(obj),
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
            await this.processLines(rc, state, obj, records, productStatus!);
            await this.saveProgress(rc, state, next);
          },
          rc.run.cursor,
        );
      }
    }
    // Incremental runs never tombstone and never replace gaps: they only add.
    await this.db.transaction(rc.ctx, async (tx) => {
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
      await this.context.ingest(rc.ctx, result.observation, this.contextMeta(rc));
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

    for (const record of records) {
      state.seen += 1;
      const key = `${obj.source}|${record.id}`;
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
          state.skipped += 1;
          state.count('filtered_out');
          break;
        case 'skipped': {
          state.skipped += 1;
          state.count(result.code);
          if (result.gapAccountId) {
            const companyId = await this.db.transaction(rc.ctx, (tx) =>
              this.repo.companyForRef(tx, rc.kind, accountObject, result.gapAccountId!),
            );
            if (!companyId) {
              throw new SyncRefusedError(
                'unresolved_account_reference',
                'A known account has no canonical record',
              );
            }
            state.gaps.set(key, {
              companyId,
              sourceObjectType: obj.source,
              sourceRecordId: record.id,
              reason: result.code as OwnershipGap['reason'],
            });
          }
          break;
        }
        case 'rejected':
          state.count(result.code);
          state.detail.unmodelledProducts = [result.productId];
          throw new SyncRefusedError(result.code, 'A line references an unmodelled product');
        case 'ingest': {
          result.quality.forEach((q) => state.count(q));
          const out = await this.subscriptions.ingest(
            rc.ctx,
            result.observation,
            this.lineMeta(rc),
          );
          if (out.outcome === 'rejected') {
            if (out.reason === 'invalid_observation') {
              state.failed += 1;
              state.count('record_rejected');
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
          if (result.observation.presence === 'present') state.holdingIds.add(key);
          else state.holdingIds.delete(key);
          break;
        }
      }
    }
    this.metrics?.increment('lip_source_pages', {
      kind: rc.kind,
      object: obj.source.toLowerCase(),
    });
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
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await rc.connector.readRecords({
        object,
        fields,
        selection,
        pageSize,
        ...(position ? { position } : {}),
      });
      await onPage(result.records, result.next);
      if (!result.next) return;
      position = result.next;
    }
    throw new SyncRefusedError('page_limit_exceeded', 'The read exceeded the page limit');
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

  /** Count of a bounded selection; a source that cannot count cannot prove a full read. */
  private async countOrRefuse(
    rc: RunContext,
    object: string,
    selection: ReadSelection,
  ): Promise<number> {
    const capability = rc.snapshot.objects.find((o) => o.name === object)?.capabilities;
    if (!capability?.count || !rc.connector.countRecords) {
      throw new SyncRefusedError(
        'unstable_read',
        `${object} cannot be counted: completeness cannot be proven`,
      );
    }
    return rc.connector.countRecords({ object, selection });
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
