import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { QueueService, RedisPolicyError } from '../../../platform/queue';
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
const REGISTER_RETRY_MS = 5_000;

@Injectable()
export class ContextProcessors implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ContextProcessors');
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly queues: QueueService,
    private readonly processing: ContextProcessingService,
    private readonly bulk: BulkSyncService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * A wrong Redis eviction policy stops the worker (BullMQ could lose jobs).
   * Redis being unreachable at start-up does not: registration is retried in
   * the background while receipts stay durable in PostgreSQL.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.context.processingEnabled) {
      this.logger.warn(PROCESSORS_DISABLED_MESSAGE);
      return;
    }
    try {
      await this.queues.assertRedisPolicy();
    } catch (err) {
      if (err instanceof RedisPolicyError) throw err;
      this.logger.warn(
        { err },
        'Redis unavailable; context processors will register when it is back',
      );
      this.scheduleRetry();
      return;
    }
    await this.register();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.retry);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.retry = setTimeout(() => {
      void this.queues
        .assertRedisPolicy()
        .then(() => this.register())
        .catch((err: unknown) => {
          if (err instanceof RedisPolicyError) {
            this.logger.error(
              { err },
              'Redis eviction policy is unsafe; context processors not registered',
            );
            return;
          }
          this.scheduleRetry();
        });
    }, REGISTER_RETRY_MS);
    this.retry.unref();
  }

  private async register(): Promise<void> {
    if (this.stopped) return;
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
