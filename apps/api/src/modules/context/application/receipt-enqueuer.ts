import { Injectable } from '@nestjs/common';
import { MetricsService } from '../../../platform/metrics';
import type { ReceiptsStoredListener } from '../../crm';
import type { ExternalSystem } from '../../domain';
import type { TenantContext } from '../../tenancy';
import { ContextJobs } from './context-runtime';

const ENQUEUE_TIMEOUT_MS = 1_500;

/**
 * Queues newly stored receipts (API process, after the receipt transaction
 * commits). Best effort and bounded in time, so a Redis outage never delays
 * HubSpot's webhook response: the receipt stays pending and the worker's
 * sweep queues it later. Does nothing when CONTEXT_PROCESSING_ENABLED=false.
 */
@Injectable()
export class ReceiptEnqueuer implements ReceiptsStoredListener {
  constructor(
    private readonly jobs: ContextJobs,
    private readonly metrics: MetricsService,
  ) {}

  async receiptsStored(
    ctx: TenantContext,
    system: ExternalSystem,
    deliveryKeys: readonly string[],
    correlationId: string,
  ): Promise<void> {
    this.metrics.increment('lip_receipts_received', { system }, deliveryKeys.length);
    if (!this.jobs.enabled) return;
    const work = Promise.all(
      deliveryKeys.map((key) => this.jobs.tryReceipt(ctx, system, key, correlationId)),
    );
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ENQUEUE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
}
