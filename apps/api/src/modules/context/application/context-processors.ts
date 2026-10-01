import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { QueueService } from '../../../platform/queue';
import { JOBS, QUEUES } from '../jobs';
import { BulkSyncService } from './bulk-sync.service';
import { ContextProcessingService } from './context-processing.service';

export const PROCESSORS_DISABLED_MESSAGE =
  'Context processing disabled (CONTEXT_PROCESSING_ENABLED=false): no processors registered';

/**
 * Registers the context job processors when the worker starts (ADR 0013).
 * With CONTEXT_PROCESSING_ENABLED=false nothing is registered: receipts keep
 * accumulating as pending (M5 behaviour) and nothing is lost.
 */
@Injectable()
export class ContextProcessors implements OnApplicationBootstrap {
  private readonly logger = new Logger('ContextProcessors');

  constructor(
    private readonly queues: QueueService,
    private readonly processing: ContextProcessingService,
    private readonly bulk: BulkSyncService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.context.processingEnabled) {
      this.logger.warn(PROCESSORS_DISABLED_MESSAGE);
      return;
    }
    const onFinalFailure = this.processing.onFinalFailure.bind(this.processing);
    await this.queues.registerProcessor(
      QUEUES.receipts,
      (job) => this.processing.processReceipt(job),
      {
        concurrency: 8,
        onFinalFailure,
      },
    );
    await this.queues.registerProcessor(QUEUES.sync, (job) => this.processing.processSubject(job), {
      concurrency: 4,
      onFinalFailure,
    });
    await this.queues.registerProcessor(
      QUEUES.bulk,
      async (job) => {
        if (job.name === JOBS.backfillPage) return this.bulk.processPage(job, 'backfill');
        if (job.name === JOBS.reconcilePage) return this.bulk.processPage(job, 'reconcile');
        if (job.name === JOBS.tick) return this.processing.tick();
      },
      { concurrency: 2, onFinalFailure },
    );
    await this.queues.upsertScheduler(
      QUEUES.bulk,
      'context-tick',
      this.config.context.sweepIntervalMs,
      JOBS.tick,
      { v: 1 },
    );
    this.logger.log('Context processors registered');
  }
}
