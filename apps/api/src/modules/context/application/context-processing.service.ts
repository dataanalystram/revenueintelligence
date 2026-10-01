import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { MetricsService } from '../../../platform/metrics';
import { PermanentJobError, type QueueJob } from '../../../platform/queue';
import {
  CRM_RECEIPT_SOURCE,
  TERMINAL_RECEIPT_STATUSES,
  type CrmReceiptSource,
  type ReceiptStatus,
  type SourceReceipt,
} from '../../crm';
import type { ExternalRef } from '../../domain';
import {
  TenantContextService,
  TenantDatabase,
  TenantRegistryService,
  type TenantContext,
} from '../../tenancy';
import { classifyFailure, toJobError } from '../errors';
import { JOBS, ReceiptJobSchema, SubjectJobSchema, type Cause } from '../jobs';
import {
  ProcessingRecordsRepository,
  type DeadLetterWrite,
} from '../infrastructure/processing-records.repository';
import { BulkSyncService } from './bulk-sync.service';
import { ContextIngestionService, type IngestResult } from './context-ingestion.service';
import { ContextJobs, ContextReaders } from './context-runtime';
import { observeSubject } from './observe';

const LooseTenantPayload = z.object({ tenantId: z.uuid() }).loose();

/**
 * Worker-side processing of context jobs (ADR 0013). Every job re-issues its
 * tenant context from the payload's tenant id (the tenant must exist and be
 * active) and works only inside tenant transactions. Webhook receipts,
 * subject re-syncs, backfill and reconciliation all end in
 * ContextIngestionService.
 */
@Injectable()
export class ContextProcessingService {
  private readonly logger = new Logger('ContextProcessing');

  constructor(
    private readonly db: TenantDatabase,
    private readonly tenants: TenantContextService,
    private readonly registry: TenantRegistryService,
    @Inject(CRM_RECEIPT_SOURCE) private readonly receipts: CrmReceiptSource,
    private readonly ingestion: ContextIngestionService,
    private readonly records: ProcessingRecordsRepository,
    private readonly readers: ContextReaders,
    private readonly jobs: ContextJobs,
    private readonly bulk: BulkSyncService,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** `receipt.process`: one durable receipt → read-back → canonical context. */
  async processReceipt(job: QueueJob<unknown>): Promise<void> {
    const data = parse(ReceiptJobSchema, job.data);
    const ctx = await this.context(data.tenantId);
    const claim = await this.db.transaction(ctx, async (tx) => {
      const receipt = await this.receipts.load(tx, data.deliveryKey);
      if (!receipt) throw new PermanentJobError('receipt_not_found', 'receipt not found in tenant');
      if (TERMINAL_RECEIPT_STATUSES.includes(receipt.status)) return { receipt, claimed: false };
      return { receipt, claimed: await this.receipts.claim(tx, data.deliveryKey) };
    });
    if (!claim.claimed) {
      this.metrics.increment('lip_receipts_skipped_finished', { system: data.system });
      return;
    }
    const receipt = claim.receipt;
    const meta = {
      cause: (data.replay ? 'replay' : 'webhook') as Cause,
      correlationId: receipt.correlationId ?? data.correlationId,
      receiptDeliveryKey: receipt.deliveryKey,
    };
    try {
      await this.handleReceipt(ctx, receipt, meta);
    } catch (err) {
      await this.markRetrying(ctx, receipt.deliveryKey);
      throw toJobError(err);
    }
  }

  private async handleReceipt(
    ctx: TenantContext,
    receipt: SourceReceipt,
    meta: { cause: Cause; correlationId: string; receiptDeliveryKey: string },
  ): Promise<void> {
    const plan = await this.receipts.plan(ctx, receipt);
    if (plan.action === 'skip') {
      await this.db.transaction(ctx, (tx) =>
        this.receipts.finish(tx, receipt.deliveryKey, plan.status, plan.reason),
      );
      this.outcome(receipt, plan.status, plan.reason);
      return;
    }
    const reader = await this.readers.forTenant(ctx);
    const unknown: ExternalRef[] = [];
    let status: ReceiptStatus = 'processed';

    if (plan.action === 'sync') {
      // Read back every subject first; no transaction is open during a source read.
      const observations = [];
      for (const s of plan.subjects)
        observations.push(await observeSubject(reader, s.kind, s.externalId));
      const results: IngestResult[] = [];
      for (const [i, obs] of observations.entries()) {
        const last = i === observations.length - 1;
        const result = await this.ingestion.ingest(ctx, obs, meta, {
          ...(last
            ? {
                afterApply: async (tx, r) => {
                  const all = [...results, r];
                  status = all.every((x) => x.decision === 'not_found')
                    ? 'source_not_found'
                    : 'processed';
                  // Same transaction as the canonical write (ADR 0013).
                  await this.receipts.finish(tx, receipt.deliveryKey, status);
                },
              }
            : {}),
        });
        results.push(result);
        unknown.push(...result.unknownCompanies);
        this.metrics.increment('lip_context_ingest', {
          kind: obs.kind,
          decision: result.decision,
          cause: meta.cause,
        });
      }
    } else {
      const survivorObs = await observeSubject(reader, plan.kind, plan.survivorId);
      const survivor = await this.ingestion.ingest(ctx, survivorObs, meta);
      unknown.push(...survivor.unknownCompanies);
      await this.ingestion.ingestMerge(
        ctx,
        {
          kind: plan.kind,
          survivor: reader.refFor(plan.kind, plan.survivorId),
          merged: plan.mergedIds.map((id) => reader.refFor(plan.kind, id)),
          observedAt: survivorObs.observedAt,
        },
        meta,
        async (tx, r) => {
          status = r.survivorKnown ? 'processed' : 'source_not_found';
          await this.receipts.finish(tx, receipt.deliveryKey, status);
        },
      );
      this.metrics.increment('lip_context_merge', { kind: plan.kind });
    }
    this.outcome(receipt, status);
    await this.followUps(ctx, reader.system, unknown, meta.cause, meta.correlationId);
  }

  /** `subject.sync`: read one record back and ingest it (replays, late companies, resyncs). */
  async processSubject(job: QueueJob<unknown>): Promise<void> {
    const data = parse(SubjectJobSchema, job.data);
    const ctx = await this.context(data.tenantId);
    try {
      const reader = await this.readers.forTenant(ctx);
      const obs = await observeSubject(reader, data.kind, data.externalId);
      const result = await this.ingestion.ingest(ctx, obs, {
        cause: data.cause,
        correlationId: data.correlationId,
      });
      this.metrics.increment('lip_context_ingest', {
        kind: data.kind,
        decision: result.decision,
        cause: data.cause,
      });
      // One level only: a company sync never asks for further syncs.
      if (data.kind === 'person') {
        await this.followUps(
          ctx,
          data.system,
          result.unknownCompanies,
          data.cause,
          data.correlationId,
        );
      }
    } catch (err) {
      throw toJobError(err);
    }
  }

  /** `context.tick`: per active tenant, sweep stale receipts and start due reconciliations. */
  async tick(): Promise<void> {
    const tenants = await this.registry.list('active');
    for (const tenant of tenants) {
      try {
        const ctx = await this.tenants.forTenantId(tenant.id);
        await this.sweep(ctx);
        await this.bulk.startDueReconciliations(ctx);
      } catch (err) {
        this.logger.warn({ err, tenant: tenant.slug }, 'Context tick failed for tenant');
      }
    }
  }

  /**
   * Re-enqueues receipts still pending (or interrupted) after the stale
   * interval, from the last SWEEP_MAX_AGE only. Pre-M6 receipts are left to
   * the explicit, bounded command.
   */
  async sweep(ctx: TenantContext): Promise<number> {
    const now = Date.now();
    const stale = await this.receipts.list(ctx, {
      statuses: ['pending', 'retrying', 'processing'],
      receivedFrom: new Date(now - this.config.context.sweepMaxAgeMs),
      receivedTo: new Date(now - this.config.context.sweepStaleMs),
      excludeReason: 'pre_m6',
      limit: 1_000,
    });
    let queued = 0;
    for (const r of stale) {
      if (await this.jobs.tryReceipt(ctx, r.system, r.deliveryKey, r.correlationId ?? randomId())) {
        queued += 1;
      }
    }
    if (queued > 0) {
      this.metrics.increment('lip_receipts_swept', { tenant: ctx.tenantSlug }, queued);
      this.logger.log({ tenant: ctx.tenantSlug, queued }, 'Sweep re-queued pending receipts');
    }
    return queued;
  }

  /**
   * Final failure of any context job: a durable dead letter (identifiers and
   * an error code only) and, for receipts, the receipt marked dead_lettered.
   */
  async onFinalFailure(job: QueueJob<unknown>, error: Error): Promise<void> {
    const failure = classifyFailure(error);
    this.metrics.increment('lip_dead_letters', { queue: job.queue, code: failure.code });
    const loose = LooseTenantPayload.safeParse(job.data);
    if (!loose.success) {
      this.logger.error(
        { queue: job.queue, jobId: job.id, code: failure.code },
        'Poison job without a tenant',
      );
      return;
    }
    let ctx: TenantContext;
    try {
      ctx = await this.tenants.forTenantId(loose.data.tenantId);
    } catch {
      this.logger.error(
        { queue: job.queue, jobId: job.id, code: failure.code },
        'Dead letter not recorded: tenant unknown or inactive',
      );
      return;
    }
    const d = job.data as Record<string, unknown>;
    const write: DeadLetterWrite = {
      queue: job.queue,
      jobName: job.name,
      jobId: job.id,
      correlationId:
        typeof d.correlationId === 'string' && /^[0-9a-f-]{36}$/.test(d.correlationId)
          ? d.correlationId
          : randomId(),
      errorCode: failure.code,
      attempts: job.attemptsMade + 1,
      ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
      ...(job.name === JOBS.receipt &&
      typeof d.deliveryKey === 'string' &&
      /^[0-9a-f]{64}$/.test(d.deliveryKey)
        ? { receiptDeliveryKey: d.deliveryKey }
        : {}),
      ...(job.name === JOBS.subject && SubjectJobSchema.safeParse(job.data).success
        ? {
            subject: {
              system: (job.data as { system: 'hubspot' }).system,
              kind: (job.data as { kind: 'company' | 'person' }).kind,
              externalId: (job.data as { externalId: string }).externalId,
            },
          }
        : {}),
      ...((job.name === JOBS.backfillPage || job.name === JOBS.reconcilePage) &&
      typeof d.checkpointId === 'string' &&
      /^[0-9a-f-]{36}$/.test(d.checkpointId)
        ? { checkpointId: d.checkpointId }
        : {}),
    };
    await this.db.transaction(ctx, async (tx) => {
      await this.records.recordDeadLetter(tx, write);
      if (write.receiptDeliveryKey) {
        await this.receipts.finish(tx, write.receiptDeliveryKey, 'dead_lettered', failure.code);
      }
      if (write.checkpointId) {
        await this.records.finishCheckpoint(tx, write.checkpointId, 'failed', failure.code);
      }
    });
    this.logger.warn(
      {
        queue: job.queue,
        job: job.name,
        jobId: job.id,
        code: failure.code,
        correlationId: write.correlationId,
      },
      'Job dead-lettered',
    );
  }

  private async followUps(
    ctx: TenantContext,
    system: ExternalRef['system'],
    refs: readonly ExternalRef[],
    cause: Cause,
    correlationId: string,
  ): Promise<void> {
    for (const ref of refs) {
      await this.jobs.subject(ctx, system, 'company', ref.id, cause, correlationId);
    }
  }

  private async markRetrying(ctx: TenantContext, deliveryKey: string): Promise<void> {
    try {
      await this.db.transaction(ctx, (tx) => this.receipts.finish(tx, deliveryKey, 'retrying'));
    } catch (err) {
      this.logger.warn({ err }, 'Could not mark receipt as retrying');
    }
  }

  private outcome(receipt: SourceReceipt, status: ReceiptStatus, reason?: string): void {
    this.metrics.increment('lip_receipts_outcome', {
      system: receipt.system,
      status,
      ...(reason ? { reason } : {}),
    });
    if (status === 'processed') {
      this.metrics.record('lip_receipt_latency_ms', Date.now() - receipt.receivedAt.getTime(), {
        system: receipt.system,
      });
    }
  }

  private async context(tenantId: string): Promise<TenantContext> {
    return this.tenants.forTenantId(tenantId).catch((err: unknown) => {
      throw toJobError(err);
    });
  }
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new PermanentJobError('invalid_payload', 'job payload failed validation');
  return parsed.data;
}

function randomId(): string {
  return crypto.randomUUID();
}
