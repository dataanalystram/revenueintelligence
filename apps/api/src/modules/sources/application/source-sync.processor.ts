import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ContextProcessingService } from '../../context';
import { TenantContextService } from '../../tenancy';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import {
  PermanentJobError,
  QueueService,
  RedisPolicyError,
  type QueueJob,
} from '../../../platform/queue';
import {
  SOURCE_PROFILE_JOB,
  SourceProfileJobSchema,
  SOURCES_QUEUE,
  SourceSyncJobSchema,
} from '../jobs';
import { SourceProfilingService } from './source-profiling.service';
import { SourceSyncService } from './source-sync.service';

const REGISTER_RETRY_MS = 5_000;

/**
 * Worker-side `lip-sources` processing: `source.sync` (M8) and, dispatched by
 * job name on the same registration, `source.profile` (M9A). Reuses the M6 queue platform:
 * retries with backoff (honouring Retry-After hints), stalled-job recovery,
 * dead letters. A run's own outcome (completed or failed with a code) is
 * recorded on its checkpoint; only exhausted transient failures dead-letter.
 */
@Injectable()
export class SourceSyncProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SourceSyncProcessor');
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly queues: QueueService,
    private readonly sync: SourceSyncService,
    private readonly profiling: SourceProfilingService,
    private readonly tenants: TenantContextService,
    private readonly processing: ContextProcessingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.context.processingEnabled) return;
    try {
      await this.queues.assertRedisPolicy();
    } catch (err) {
      if (err instanceof RedisPolicyError) throw err;
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
          if (!(err instanceof RedisPolicyError)) this.scheduleRetry();
        });
    }, REGISTER_RETRY_MS);
    this.retry.unref();
  }

  private async register(): Promise<void> {
    if (this.stopped) return;
    await this.queues.registerProcessor(SOURCES_QUEUE, (job) => this.process(job), {
      concurrency: 2,
      onFinalFailure: (job, error) => this.onFinalFailure(job, error),
    });
    this.logger.log('Source sync processor registered');
  }

  async process(job: QueueJob<unknown>): Promise<void> {
    if (job.name === SOURCE_PROFILE_JOB) {
      const profile = SourceProfileJobSchema.safeParse(job.data);
      if (!profile.success)
        throw new PermanentJobError('invalid_payload', 'source.profile failed validation');
      const ctx = await this.tenants.forTenantId(profile.data.tenantId);
      const result = await this.profiling.execute(ctx, profile.data.runId);
      this.logger.log(
        { runId: result.runId, status: result.status, code: result.errorCode },
        'Profile run finished',
      );
      return;
    }
    const parsed = SourceSyncJobSchema.safeParse(job.data);
    if (!parsed.success)
      throw new PermanentJobError('invalid_payload', 'source.sync failed validation');
    const ctx = await this.tenants.forTenantId(parsed.data.tenantId);
    const result = await this.sync.execute(ctx, parsed.data.checkpointId);
    this.logger.log(
      { runId: result.runId, status: result.status, code: result.errorCode },
      'Source run finished',
    );
  }

  private async onFinalFailure(job: QueueJob<unknown>, error: Error): Promise<void> {
    const profile =
      job.name === SOURCE_PROFILE_JOB ? SourceProfileJobSchema.safeParse(job.data) : undefined;
    if (profile?.success) {
      try {
        const ctx = await this.tenants.forTenantId(profile.data.tenantId);
        await this.profiling.abandon(ctx, profile.data.runId, 'retries_exhausted');
      } catch (err) {
        this.logger.error({ err, jobId: job.id }, 'Could not mark the profile run failed');
      }
    }
    const parsed =
      job.name === SOURCE_PROFILE_JOB ? undefined : SourceSyncJobSchema.safeParse(job.data);
    if (parsed?.success) {
      try {
        const ctx = await this.tenants.forTenantId(parsed.data.tenantId);
        await this.sync.abandon(ctx, parsed.data.checkpointId, 'retries_exhausted');
      } catch (err) {
        this.logger.error({ err, jobId: job.id }, 'Could not mark the source run failed');
      }
    }
    // Dead letter (identifiers and codes only) through the M6 recorder.
    await this.processing.onFinalFailure(job, error);
  }
}
