import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { MetricsService } from '../../../platform/metrics';
import { QueueService } from '../../../platform/queue';
import { CRM_CONNECTOR, type CrmConnector } from '../../crm';
import type { ContextKind, CrmReader, ExternalSystem } from '../../domain';
import type { TenantContext } from '../../tenancy';
import {
  JOBS,
  QUEUES,
  jobIds,
  type Cause,
  type PageJob,
  type ReceiptJob,
  type SubjectJob,
} from '../jobs';

const READER_TTL_MS = 5 * 60_000;

function replaySalt(): string {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
}

/** A tenant's verified CrmReader, reused briefly (the connector verifies the account each time). */
@Injectable()
export class ContextReaders {
  private readonly cache = new Map<string, { reader: CrmReader; expires: number }>();

  constructor(@Inject(CRM_CONNECTOR) private readonly connector: CrmConnector) {}

  async forTenant(ctx: TenantContext): Promise<CrmReader> {
    const hit = this.cache.get(ctx.tenantId);
    if (hit && hit.expires > Date.now()) return hit.reader;
    const reader = await this.connector.forTenant(ctx);
    this.cache.set(ctx.tenantId, { reader, expires: Date.now() + READER_TTL_MS });
    return reader;
  }

  forget(ctx: TenantContext): void {
    this.cache.delete(ctx.tenantId);
  }
}

/** Enqueue helpers: identifiers only, deterministic ids, honour the runtime switch. */
@Injectable()
export class ContextJobs {
  private readonly logger = new Logger('ContextJobs');

  constructor(
    private readonly queues: QueueService,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get enabled(): boolean {
    return this.config.context.processingEnabled;
  }

  async receipt(
    ctx: TenantContext,
    system: ExternalSystem,
    deliveryKey: string,
    correlationId: string,
    replay = false,
  ): Promise<void> {
    const data: ReceiptJob = {
      v: 1,
      tenantId: ctx.tenantId,
      system,
      deliveryKey,
      correlationId,
      ...(replay ? { replay: true as const } : {}),
    };
    await this.queues.add(QUEUES.receipts, JOBS.receipt, data, {
      jobId: jobIds.receipt(ctx.tenantId, system, deliveryKey, replay ? replaySalt() : undefined),
    });
  }

  async subject(
    ctx: TenantContext,
    system: ExternalSystem,
    kind: ContextKind,
    externalId: string,
    cause: Cause,
    correlationId: string,
  ): Promise<void> {
    const data: SubjectJob = {
      v: 1,
      tenantId: ctx.tenantId,
      system,
      kind,
      externalId,
      cause,
      correlationId,
    };
    // One job per subject per correlation: bursts from one event coalesce.
    await this.queues.add(QUEUES.sync, JOBS.subject, data, {
      jobId: jobIds.subject(ctx.tenantId, system, kind, externalId, correlationId),
    });
  }

  async page(
    ctx: TenantContext,
    mode: 'backfill' | 'reconcile',
    checkpointId: string,
    page: number,
    correlationId: string,
    salt?: string,
  ): Promise<void> {
    const data: PageJob = { v: 1, tenantId: ctx.tenantId, checkpointId, correlationId, page };
    await this.queues.add(
      QUEUES.bulk,
      mode === 'backfill' ? JOBS.backfillPage : JOBS.reconcilePage,
      data,
      { jobId: `${jobIds.page(mode, checkpointId, page)}${salt ? `-${salt}` : ''}` },
    );
  }

  /** Best effort: never throws (the durable record is the safety net). */
  async tryReceipt(
    ctx: TenantContext,
    system: ExternalSystem,
    deliveryKey: string,
    correlationId: string,
  ): Promise<boolean> {
    try {
      await this.receipt(ctx, system, deliveryKey, correlationId);
      return true;
    } catch (err) {
      this.metrics.increment('lip_receipts_enqueue_failed', { system });
      this.logger.warn(
        { err, correlationId },
        'Receipt not queued; it stays pending for the sweep',
      );
      return false;
    }
  }
}
