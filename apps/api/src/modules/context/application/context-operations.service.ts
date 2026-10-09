import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { MetricsService } from '../../../platform/metrics';
import { QueueService, type QueueCounts } from '../../../platform/queue';
import {
  CRM_RECEIPT_SOURCE,
  type CrmReceiptSource,
  type ReceiptStatus,
  type SourceReceipt,
} from '../../crm';
import type { ContextKind, ExternalSystem } from '../../domain';
import {
  assertAuthorized,
  AuditTrail,
  AuthorizedContext,
  TenantDatabase,
  type TenantContext,
} from '../../tenancy';

/** Dry runs need a tenant context; executing needs the capability (M10A1). */
function tenantOf(target: TenantContext | AuthorizedContext): TenantContext {
  return target instanceof AuthorizedContext ? target.tenant : target;
}
import { QUEUES } from '../jobs';
import { ContextReadModel } from '../infrastructure/context-read-model';
import {
  ProcessingRecordsRepository,
  type DeadLetterRow,
} from '../infrastructure/processing-records.repository';
import { ContextJobs } from './context-runtime';
import { AuditFailures } from '../../tenancy';

export interface ReceiptProcessingPlan {
  readonly dryRun: boolean;
  readonly matched: number;
  readonly byStatus: Record<string, number>;
  readonly queued: number;
  readonly deliveryKeys: readonly string[];
}

/**
 * Operator actions behind the `context:*` commands (M6). All tenant-scoped;
 * mutating actions default to a dry run in the CLIs. Outputs are identifiers,
 * counts and hashes: never record values.
 */
@Injectable()
export class ContextOperationsService {
  constructor(
    private readonly db: TenantDatabase,
    @Inject(CRM_RECEIPT_SOURCE) private readonly receipts: CrmReceiptSource,
    private readonly records: ProcessingRecordsRepository,
    private readonly readModel: ContextReadModel,
    private readonly jobs: ContextJobs,
    private readonly queues: QueueService,
    private readonly metrics: MetricsService,
    private readonly audit: AuditTrail,
  ) {}

  /**
   * Processes stored receipts in a bounded range through the normal path
   * (historical M5 receipts included). Finished receipts are skipped unless
   * `includeFinished`, in which case they are reset and replayed (idempotent).
   */
  @AuditFailures('context.receipts.process', 'context')
  async processReceipts(
    target: TenantContext | AuthorizedContext<'data.sync.run'>,
    filter: {
      from?: Date;
      to?: Date;
      statuses?: readonly ReceiptStatus[];
      onlyReason?: string;
      limit: number;
      includeFinished: boolean;
      dryRun: boolean;
      correlationId: string;
    },
  ): Promise<ReceiptProcessingPlan> {
    if (!filter.dryRun) assertAuthorized(target, 'data.sync.run');
    const ctx = tenantOf(target);
    const statuses: readonly ReceiptStatus[] =
      filter.statuses ??
      (filter.includeFinished
        ? [
            'pending',
            'retrying',
            'processing',
            'processed',
            'source_not_found',
            'ineligible',
            'deferred',
            'irrelevant',
            'dead_lettered',
          ]
        : ['pending', 'retrying']);
    const matched = await this.receipts.list(ctx, {
      statuses,
      ...(filter.from ? { receivedFrom: filter.from } : {}),
      ...(filter.to ? { receivedTo: filter.to } : {}),
      ...(filter.onlyReason ? { onlyReason: filter.onlyReason } : {}),
      limit: filter.limit,
    });
    const byStatus = countBy(matched, (r) => r.status);
    if (filter.dryRun || matched.length === 0) {
      return {
        dryRun: filter.dryRun,
        matched: matched.length,
        byStatus,
        queued: 0,
        deliveryKeys: matched.map((r) => r.deliveryKey),
      };
    }
    const finished = matched.filter((r) => r.status !== 'pending' && r.status !== 'retrying');
    await this.db.transaction(ctx, async (tx) => {
      if (finished.length > 0) {
        await this.receipts.reset(
          tx,
          finished.map((r) => r.deliveryKey),
        );
      }
      await this.audit.record(tx, target as AuthorizedContext<'data.sync.run'>, {
        action: 'context.receipts.process',
        targetKind: 'context',
        details: { matched: matched.length, reset: finished.length },
      });
    });
    let queued = 0;
    for (const r of matched) {
      await this.jobs.receipt(
        ctx,
        r.system,
        r.deliveryKey,
        r.correlationId ?? filter.correlationId,
        true,
      );
      queued += 1;
    }
    this.metrics.increment('lip_replayed', { what: 'receipts' }, queued);
    return {
      dryRun: false,
      matched: matched.length,
      byStatus,
      queued,
      deliveryKeys: matched.map((r) => r.deliveryKey),
    };
  }

  async listDeadLetters(
    ctx: TenantContext,
    filter: { state?: string; code?: string; limit: number },
  ): Promise<DeadLetterRow[]> {
    return this.db.transaction(ctx, (tx) => this.records.listDeadLetters(tx, filter));
  }

  /** Replays open dead letters (receipt or subject jobs) and marks them replayed. */
  @AuditFailures('dead_letter.replay', 'dead_letter')
  async replayDeadLetters(
    target: TenantContext | AuthorizedContext<'processing.dead_letter.resolve'>,
    filter: {
      ids?: readonly string[];
      code?: string;
      limit: number;
      dryRun: boolean;
      correlationId: string;
    },
  ): Promise<{ dryRun: boolean; matched: number; replayed: number; unsupported: number }> {
    if (!filter.dryRun) assertAuthorized(target, 'processing.dead_letter.resolve');
    const ctx = tenantOf(target);
    const letters = await this.listDeadLettersBy(ctx, filter);
    if (filter.dryRun)
      return { dryRun: true, matched: letters.length, replayed: 0, unsupported: 0 };
    const actx = target as AuthorizedContext<'processing.dead_letter.resolve'>;
    let replayed = 0;
    let unsupported = 0;
    for (const d of letters) {
      if (d.receiptDeliveryKey) {
        await this.db.transaction(ctx, (tx) => this.receipts.reset(tx, [d.receiptDeliveryKey!]));
        await this.jobs.receipt(ctx, 'hubspot', d.receiptDeliveryKey, d.correlationId, true);
      } else if (d.subjectKind && d.subjectExternalId && d.subjectSystem) {
        await this.jobs.subject(
          ctx,
          d.subjectSystem as ExternalSystem,
          d.subjectKind as ContextKind,
          d.subjectExternalId,
          'replay',
          filter.correlationId,
        );
      } else {
        unsupported += 1; // page jobs: use `context:backfill --resume <checkpoint>`
        continue;
      }
      await this.db.transaction(ctx, async (tx) => {
        await this.records.resolveDeadLetter(tx, d.id, 'replayed', 'replay');
        await this.audit.record(tx, actx, {
          action: 'dead_letter.replay',
          targetKind: 'dead_letter',
          targetRef: d.id,
        });
      });
      replayed += 1;
    }
    this.metrics.increment('lip_replayed', { what: 'dead_letters' }, replayed);
    return { dryRun: false, matched: letters.length, replayed, unsupported };
  }

  @AuditFailures('dead_letter.discard', 'dead_letter')
  async discardDeadLetters(
    actx: AuthorizedContext<'processing.dead_letter.resolve'>,
    ids: readonly string[],
    reason: string,
  ): Promise<number> {
    assertAuthorized(actx, 'processing.dead_letter.resolve');
    if (!/^[a-z0-9_]{1,50}$/.test(reason)) throw new RangeError('reason must be a short code');
    let n = 0;
    for (const id of ids) {
      const discarded = await this.db.transaction(actx.tenant, async (tx) => {
        const done = await this.records.resolveDeadLetter(
          tx,
          id,
          'discarded',
          `discarded_${reason}`,
        );
        if (done) {
          await this.audit.record(tx, actx, {
            action: 'dead_letter.discard',
            targetKind: 'dead_letter',
            targetRef: id,
            details: { reason },
          });
        }
        return done;
      });
      if (discarded) n += 1;
    }
    return n;
  }

  /** Re-reads one record from the source and ingests it. */
  @AuditFailures('context.resync', 'context')
  async resync(
    actx: AuthorizedContext<'data.sync.run'>,
    system: ExternalSystem,
    kind: ContextKind,
    externalId: string,
    correlationId: string,
  ): Promise<void> {
    assertAuthorized(actx, 'data.sync.run');
    await this.db.transaction(actx.tenant, (tx) =>
      this.audit.record(tx, actx, {
        action: 'context.resync',
        targetKind: 'context',
        targetRef: `${system}:${kind}`,
      }),
    );
    await this.jobs.subject(actx.tenant, system, kind, externalId, 'resync', correlationId);
  }

  async report(ctx: TenantContext): Promise<Record<string, unknown>> {
    const queues: Record<string, QueueCounts | string> = {};
    for (const q of Object.values(QUEUES)) {
      queues[q] = await this.queues.counts(q).catch(() => 'unavailable');
    }
    const summary = await this.db.transaction(ctx, async (tx) => ({
      deadLetters: await this.records.deadLetterCounts(tx),
      checkpoints: (await this.records.recentCheckpoints(tx, 10)).map((c) => ({
        id: c.id,
        mode: c.mode,
        kind: c.kind,
        status: c.status,
        pages: c.pageNo,
        seen: c.recordsSeen,
        changed: c.recordsChanged,
        skipped: c.recordsSkipped,
        windowSince: c.windowSince,
        highWatermark: c.highWatermark,
        startedAt: c.startedAt,
        completedAt: c.completedAt,
        lastErrorCode: c.lastErrorCode,
      })),
      ...(await this.readModel.counts(tx)),
    }));
    return {
      processingEnabled: this.jobs.enabled,
      queues,
      receipts: await this.receiptCounts(ctx),
      ...summary,
    };
  }

  async show(
    ctx: TenantContext,
    kind: ContextKind,
    ref: { system: ExternalSystem; objectType: string; id: string },
  ): Promise<Record<string, unknown> | undefined> {
    return this.db.transaction(ctx, (tx) => this.readModel.show(tx, kind, ref));
  }

  /** Deterministic hash of canonical context (ids, states, field hashes; no values printed). */
  async stateHash(ctx: TenantContext): Promise<{ hash: string; rows: Record<string, number> }> {
    return this.db.transaction(ctx, async (tx) => {
      const rows = await this.readModel.hashRows(tx);
      const hash = createHash('sha256');
      const counts: Record<string, number> = {};
      for (const [table, list] of Object.entries(rows)) {
        counts[table] = list.length;
        for (const line of list) hash.update(`${table}|${line}\n`);
      }
      return { hash: hash.digest('hex'), rows: counts };
    });
  }

  private async receiptCounts(ctx: TenantContext): Promise<Record<string, number>> {
    const all = await this.receipts.list(ctx, {
      statuses: [
        'pending',
        'processing',
        'retrying',
        'processed',
        'ineligible',
        'deferred',
        'irrelevant',
        'source_not_found',
        'dead_lettered',
      ],
      limit: 10_000,
    });
    return countBy(all, (r: SourceReceipt) => `${r.status}${r.reason ? `:${r.reason}` : ''}`);
  }

  private async listDeadLettersBy(
    ctx: TenantContext,
    filter: { ids?: readonly string[]; code?: string; limit: number },
  ): Promise<DeadLetterRow[]> {
    return this.db.transaction(ctx, (tx) =>
      this.records.listDeadLetters(tx, {
        state: 'open',
        ...(filter.code ? { code: filter.code } : {}),
        ...(filter.ids ? { ids: filter.ids } : {}),
        limit: filter.limit,
      }),
    );
  }
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}
