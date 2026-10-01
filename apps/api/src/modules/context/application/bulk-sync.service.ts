import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { MetricsService } from '../../../platform/metrics';
import { PermanentJobError, type QueueJob } from '../../../platform/queue';
import type {
  ContextKind,
  CrmReader,
  ExternalCompanySnapshot,
  ExternalPersonSnapshot,
  ExternalRef,
  SourceObservation,
} from '../../domain';
import {
  TenantContextService,
  TenantDatabase,
  UniqueConstraintError,
  type TenantContext,
} from '../../tenancy';
import { toJobError } from '../errors';
import { PageJobSchema } from '../jobs';
import {
  ProcessingRecordsRepository,
  type CheckpointMode,
  type CheckpointRow,
} from '../infrastructure/processing-records.repository';
import { ContextIngestionService } from './context-ingestion.service';
import { ContextJobs, ContextReaders } from './context-runtime';
import { companyLinks, companyObservation, personObservation } from './observe';

const PAGE_TX_TIMEOUT_MS = 90_000;
export const CONTEXT_KINDS: readonly ContextKind[] = ['company', 'person'];

export interface StartedRun {
  readonly kind: ContextKind;
  readonly checkpointId?: string;
  readonly resumed: boolean;
  readonly skipped?: 'needs_backfill' | 'already_running';
}

/**
 * Initial backfill and watermark reconciliation (M6, ADR 0013/0015). Both
 * page through the source read-only and feed every record to the same
 * ContextIngestionService as webhooks, so there is one canonical write path.
 *
 * The cursor lives in `tenant_sync_checkpoints` and advances in the same
 * transaction as the page's ingestion: a crash re-runs the page (idempotent),
 * never skips one. Page jobs carry their page number; a duplicate or stale
 * page job finds the checkpoint already past it and does nothing.
 */
@Injectable()
export class BulkSyncService {
  private readonly logger = new Logger('BulkSync');

  constructor(
    private readonly db: TenantDatabase,
    private readonly tenants: TenantContextService,
    private readonly ingestion: ContextIngestionService,
    private readonly records: ProcessingRecordsRepository,
    private readonly readers: ContextReaders,
    private readonly jobs: ContextJobs,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Starts (or resumes) a backfill per kind; one active run per kind. */
  async startBackfill(
    ctx: TenantContext,
    kinds: readonly ContextKind[],
    options: { pageSize?: number; maxRecords?: number; correlationId: string },
  ): Promise<StartedRun[]> {
    const reader = await this.readers.forTenant(ctx);
    const out: StartedRun[] = [];
    for (const kind of kinds) {
      const { checkpoint, resumed } = await this.db.transaction(ctx, async (tx) => {
        const running = await this.records.running(tx, reader.system, kind, 'backfill');
        if (running) return { checkpoint: running, resumed: true };
        return {
          checkpoint: await this.records.startCheckpoint(tx, {
            system: reader.system,
            kind,
            mode: 'backfill',
            correlationId: options.correlationId,
            pageSize: options.pageSize ?? 100,
            ...(options.maxRecords ? { maxRecords: options.maxRecords } : {}),
          }),
          resumed: false,
        };
      });
      await this.enqueuePage(ctx, checkpoint, resumed);
      out.push({ kind, checkpointId: checkpoint.id, resumed });
    }
    return out;
  }

  /**
   * Starts a reconciliation from the last watermark (source time) minus the
   * lookback. Needs a baseline: a completed reconciliation or backfill.
   */
  async startReconcile(
    ctx: TenantContext,
    kind: ContextKind,
    options: { since?: Date; pageSize?: number; correlationId: string },
  ): Promise<StartedRun> {
    const reader = await this.readers.forTenant(ctx);
    const lookback = this.config.context.reconcileLookbackMs;
    const result = await this.db.transaction(ctx, async (tx) => {
      const running = await this.records.running(tx, reader.system, kind, 'reconcile');
      if (running) return { checkpoint: running, resumed: true };
      const baseline = options.since ?? (await this.baseline(tx, reader, kind));
      if (!baseline) return { skipped: 'needs_backfill' as const };
      const windowSince = new Date(baseline.getTime() - (options.since ? 0 : lookback));
      const checkpoint = await this.records.startCheckpoint(tx, {
        system: reader.system,
        kind,
        mode: 'reconcile',
        correlationId: options.correlationId,
        pageSize: options.pageSize ?? 100,
        windowSince,
        // Carries the baseline forward even if this run finds nothing.
        highWatermark: baseline,
      });
      return { checkpoint, resumed: false };
    });
    if ('skipped' in result) return { kind, resumed: false, skipped: result.skipped };
    await this.enqueuePage(ctx, result.checkpoint, result.resumed);
    return { kind, checkpointId: result.checkpoint.id, resumed: result.resumed };
  }

  /** Called by the tick: starts reconciliation for kinds whose last run is older than the interval. */
  async startDueReconciliations(ctx: TenantContext): Promise<void> {
    const interval = this.config.context.reconcileIntervalMs;
    if (interval === 0) return;
    for (const kind of CONTEXT_KINDS) {
      const due = await this.db.transaction(ctx, async (tx) => {
        for (const system of ['hubspot'] as const) {
          if (await this.records.running(tx, system, kind, 'reconcile')) return false;
          const last = await this.records.lastCompleted(tx, system, kind, 'reconcile');
          const backfill = await this.records.lastCompleted(tx, system, kind, 'backfill');
          if (!last && !backfill) return false;
          return !last?.completedAt || Date.now() - last.completedAt.getTime() >= interval;
        }
        return false;
      });
      if (due) {
        await this.startReconcile(ctx, kind, { correlationId: crypto.randomUUID() }).catch(
          (err: unknown) => {
            if (!(err instanceof UniqueConstraintError)) throw err;
          },
        );
      }
    }
  }

  /** Re-opens a failed run at its stored cursor (operator command). */
  async resume(ctx: TenantContext, checkpointId: string): Promise<StartedRun> {
    const checkpoint = await this.db.transaction(ctx, async (tx) => {
      const cp = await this.records.lockCheckpoint(tx, checkpointId);
      if (!cp) throw new Error('checkpoint not found');
      if (cp.status === 'running') return cp;
      if (cp.status !== 'failed') throw new Error(`checkpoint is ${cp.status}`);
      await this.records.reopenCheckpoint(tx, cp);
      return { ...cp, status: 'running' as const };
    });
    await this.enqueuePage(ctx, checkpoint, true);
    return { kind: checkpoint.kind, checkpointId, resumed: true };
  }

  /** `backfill.page` / `reconcile.page`. */
  async processPage(job: QueueJob<unknown>, mode: CheckpointMode): Promise<void> {
    const parsed = PageJobSchema.safeParse(job.data);
    if (!parsed.success)
      throw new PermanentJobError('invalid_payload', 'page job failed validation');
    const data = parsed.data;
    try {
      const ctx = await this.tenants.forTenantId(data.tenantId);
      const checkpoint = await this.db.transaction(ctx, (tx) =>
        this.records.getCheckpoint(tx, data.checkpointId),
      );
      if (!checkpoint) throw new PermanentJobError('checkpoint_not_found', 'checkpoint not found');
      if (checkpoint.mode !== mode) throw new PermanentJobError('checkpoint_mode', 'wrong mode');
      if (checkpoint.status !== 'running' || checkpoint.pageNo !== data.page) return;
      await this.page(ctx, checkpoint, data.page);
    } catch (err) {
      throw toJobError(err);
    }
  }

  private async page(ctx: TenantContext, cp: CheckpointRow, pageNo: number): Promise<void> {
    const reader = await this.readers.forTenant(ctx);
    const observedAt = new Date();
    const fetched =
      cp.mode === 'backfill'
        ? await reader.listRecords(cp.kind, {
            limit: cp.pageSize,
            ...(cp.cursor ? { after: cp.cursor } : {}),
          })
        : await reader.listChangedSince(cp.kind, {
            since: cp.windowSince!,
            limit: cp.pageSize,
            ...(cp.cursor ? { after: cp.cursor } : {}),
          });
    const items = fetched.items;
    const links =
      cp.kind === 'person'
        ? await companyLinks(
            reader,
            items.filter((i) => !i.archived).map((i) => i.ref.id),
          )
        : undefined;
    const observations: SourceObservation[] = items.map((snap) =>
      cp.kind === 'company'
        ? companyObservation(snap as ExternalCompanySnapshot, observedAt)
        : personObservation(snap as ExternalPersonSnapshot, observedAt, links?.get(snap.ref.id)),
    );
    const windowExhausted = 'windowExhausted' in fetched && fetched.windowExhausted === true;
    const lastUpdated = items.reduce<Date | undefined>(
      (max, i) => (i.updatedAt && (!max || i.updatedAt > max) ? i.updatedAt : max),
      undefined,
    );

    const outcome = await this.db.transaction(
      ctx,
      async (tx) => {
        const locked = await this.records.lockCheckpoint(tx, cp.id);
        if (!locked || locked.status !== 'running' || locked.pageNo !== pageNo) return undefined;
        let changed = 0;
        let skipped = 0;
        const unknown: ExternalRef[] = [];
        const cause = cp.mode === 'backfill' ? 'backfill' : 'reconciliation';
        for (const obs of observations) {
          const r = await this.ingestion.ingest(
            ctx,
            obs,
            { cause, correlationId: cp.correlationId, checkpointId: cp.id },
            { within: tx },
          );
          if (r.changed) changed += 1;
          else skipped += 1;
          unknown.push(...r.unknownCompanies);
          this.metrics.increment(
            cp.mode === 'backfill' ? 'lip_backfill_records' : 'lip_reconcile_records',
            {
              kind: cp.kind,
              decision: r.decision,
            },
          );
        }
        const seenTotal = locked.recordsSeen + items.length;
        let done: boolean;
        let patch: Parameters<ProcessingRecordsRepository['advanceCheckpoint']>[2];
        if (cp.mode === 'backfill') {
          const reachedMax = locked.maxRecords !== null && seenTotal >= locked.maxRecords;
          done = !fetched.nextCursor || reachedMax;
          patch = { cursor: fetched.nextCursor ?? null, seen: items.length, changed, skipped };
        } else {
          const highWatermark =
            lastUpdated && (!locked.highWatermark || lastUpdated > locked.highWatermark)
              ? lastUpdated
              : locked.highWatermark;
          if (fetched.nextCursor) {
            done = false;
            patch = {
              cursor: fetched.nextCursor,
              highWatermark,
              seen: items.length,
              changed,
              skipped,
            };
          } else if (windowExhausted) {
            // New query from the last record's time; records at that exact time are re-read.
            if (!lastUpdated || lastUpdated.getTime() <= locked.windowSince!.getTime()) {
              throw new PermanentJobError('window_not_advancing', 'search window cannot advance');
            }
            done = false;
            patch = {
              cursor: null,
              windowSince: lastUpdated,
              highWatermark,
              seen: items.length,
              changed,
              skipped,
            };
          } else {
            done = true;
            patch = { cursor: null, highWatermark, seen: items.length, changed, skipped };
          }
        }
        await this.records.advanceCheckpoint(tx, cp.id, patch);
        if (done) await this.records.finishCheckpoint(tx, cp.id, 'completed');
        return { done, unknown };
      },
      { timeoutMs: PAGE_TX_TIMEOUT_MS },
    );
    if (!outcome) return;
    for (const ref of outcome.unknown) {
      await this.jobs.subject(
        ctx,
        reader.system,
        'company',
        ref.id,
        cp.mode === 'backfill' ? 'backfill' : 'reconciliation',
        cp.correlationId,
      );
    }
    if (!outcome.done) {
      await this.jobs.page(ctx, cp.mode, cp.id, pageNo + 1, cp.correlationId);
      return;
    }
    this.logger.log(
      { tenant: ctx.tenantSlug, mode: cp.mode, kind: cp.kind, checkpointId: cp.id },
      'Sync run completed',
    );
    if (cp.mode === 'backfill') {
      // Close the gap between the page reads and live webhooks.
      await this.startReconcile(ctx, cp.kind, { correlationId: cp.correlationId }).catch(
        (err: unknown) => this.logger.warn({ err }, 'Post-backfill reconciliation not started'),
      );
    }
  }

  private async baseline(
    tx: Parameters<ProcessingRecordsRepository['lastCompleted']>[0],
    reader: CrmReader,
    kind: ContextKind,
  ): Promise<Date | undefined> {
    const last = await this.records.lastCompleted(tx, reader.system, kind, 'reconcile');
    const backfill = await this.records.lastCompleted(tx, reader.system, kind, 'backfill');
    const candidates = [last?.highWatermark, backfill?.startedAt].filter((d): d is Date => !!d);
    return candidates.length
      ? new Date(Math.max(...candidates.map((d) => d.getTime())))
      : undefined;
  }

  private async enqueuePage(
    ctx: TenantContext,
    cp: CheckpointRow,
    resumed: boolean,
  ): Promise<void> {
    if (resumed) {
      // A resumed run may have its previous page job in the failed set: use a fresh id.
      await this.jobs.page(ctx, cp.mode, cp.id, cp.pageNo, cp.correlationId, `r${Date.now()}`);
    } else {
      await this.jobs.page(ctx, cp.mode, cp.id, cp.pageNo, cp.correlationId);
    }
  }
}
