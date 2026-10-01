import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config';
import { MetricsService } from '../metrics';
import { createRedisClient } from '../redis';

/**
 * Job coordination on BullMQ + Redis (ADR 0013). This is the only code that
 * imports BullMQ (dependency rule `bullmq-only-in-platform-queue`). PostgreSQL
 * stays the source of truth: payloads carry identifiers only, and every job
 * can be re-created from its durable record.
 */

/** A job as processors see it (no BullMQ types leak out). */
export interface QueueJob<T = unknown> {
  readonly queue: string;
  readonly name: string;
  readonly id: string;
  readonly data: T;
  /** Attempts already made before this one (0 on the first run). */
  readonly attemptsMade: number;
  readonly maxAttempts: number;
  /** When the job was first added (ms since epoch). */
  readonly enqueuedAt: number;
}

/** Throw from a processor when retrying cannot help: the job fails at once. */
export class PermanentJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Optional hint on an error: wait at least this long before the next attempt. */
export interface RetryAfterHint {
  readonly retryAfterMs?: number;
}

export interface AddJobOptions {
  /** Deterministic id; a job with this id already waiting/active/delayed is not added again. */
  readonly jobId: string;
  readonly attempts?: number;
  readonly delayMs?: number;
}

export interface ProcessorOptions<T> {
  readonly concurrency: number;
  /**
   * Called once when the job will not be retried (permanent error, attempts
   * exhausted, or stalled too often), before the job is marked failed. Its
   * own failure is logged; the job still fails.
   */
  readonly onFinalFailure?: (job: QueueJob<T>, error: Error) => Promise<void>;
}

export type Processor<T> = (job: QueueJob<T>) => Promise<void>;

export const DEFAULT_ATTEMPTS = 8;
export const QUEUE_STOPPED_MESSAGE = 'Queue processors stopped after active jobs finished';
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 600_000;
const JITTER = 0.2;
/** BullMQ job ids must not contain ':' and must not be plain integers. */
const JOB_ID = /^[a-z][a-z0-9-]{2,190}$/;

/**
 * Delay before attempt `attemptsMade + 1`: exponential from 5 s, capped at
 * 10 min, ±20 % jitter; never shorter than a source's Retry-After hint.
 */
export function retryDelayMs(
  attemptsMade: number,
  hint: RetryAfterHint | undefined,
  random: () => number = Math.random,
): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1));
  const jittered = Math.round(exp * (1 - JITTER + 2 * JITTER * random()));
  return Math.max(jittered, hint?.retryAfterMs ?? 0);
}

/** Redis must not evict keys under memory pressure, or BullMQ loses jobs. */
export async function redisEvictionPolicy(redisUrl: string): Promise<string | undefined> {
  const client = createRedisClient(redisUrl);
  try {
    await client.connect();
    const info = await client.info('memory');
    return /^maxmemory_policy:(\S+)/m.exec(info)?.[1];
  } finally {
    client.disconnect();
  }
}

export class RedisPolicyError extends Error {
  constructor(policy: string | undefined) {
    super(
      `Redis maxmemory-policy must be "noeviction" for job queues (found ${policy ?? 'unknown'})`,
    );
    this.name = 'RedisPolicyError';
  }
}

export interface QueueCounts {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly completed: number;
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger('Queue');
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private policyChecked: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  private connection(forWorker: boolean) {
    return {
      url: this.config.redisUrl,
      // Workers must keep retrying (BullMQ requirement); producers fail fast so
      // an outage never blocks an HTTP request: the durable record remains.
      maxRetriesPerRequest: forWorker ? null : 1,
      enableOfflineQueue: forWorker,
      connectTimeout: 5_000,
    };
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection(false), prefix: this.config.queue.prefix });
      q.on('error', (err) => this.logger.warn({ err, queue: name }, 'Queue connection error'));
      this.queues.set(name, q);
    }
    return q;
  }

  /** Adds a job; resolves false (without throwing) if the id is already queued. */
  async add(queue: string, name: string, data: object, options: AddJobOptions): Promise<void> {
    if (!JOB_ID.test(options.jobId)) throw new RangeError(`invalid job id for ${queue}`);
    await this.queue(queue).add(name, data, {
      jobId: options.jobId,
      attempts: options.attempts ?? DEFAULT_ATTEMPTS,
      backoff: { type: 'capped-exponential' },
      delay: options.delayMs,
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
    });
    this.metrics.increment('lip_jobs_queued', { queue, job: name });
  }

  async counts(queue: string): Promise<QueueCounts> {
    const c = await this.queue(queue).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
    );
    return {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      failed: c.failed ?? 0,
      completed: c.completed ?? 0,
    };
  }

  /** Stored payload of a job (tests and diagnostics: proves what Redis holds). */
  async jobData(queue: string, jobId: string): Promise<unknown> {
    return (await this.queue(queue).getJob(jobId))?.data;
  }

  /** Verifies the Redis eviction policy once (workers only). */
  assertRedisPolicy(): Promise<void> {
    this.policyChecked ??= redisEvictionPolicy(this.config.redisUrl).then((policy) => {
      if (policy !== 'noeviction') throw new RedisPolicyError(policy);
    });
    return this.policyChecked;
  }

  /** Starts consuming `queue` with `processor` (worker process only). */
  async registerProcessor<T>(
    queue: string,
    processor: Processor<T>,
    options: ProcessorOptions<T>,
  ): Promise<void> {
    await this.assertRedisPolicy();
    const toJob = (job: Job): QueueJob<T> => ({
      queue,
      name: job.name,
      id: job.id ?? '',
      data: job.data as T,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
      enqueuedAt: job.timestamp,
    });
    const worker = new Worker(
      queue,
      async (job: Job) => {
        const view = toJob(job);
        const started = Date.now();
        this.metrics.increment('lip_jobs_started', { queue, job: job.name });
        try {
          await processor(view);
          this.metrics.increment('lip_jobs_succeeded', { queue, job: job.name });
          this.metrics.record('lip_job_duration_ms', Date.now() - started, {
            queue,
            job: job.name,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const permanent = error instanceof PermanentJobError;
          const final = permanent || job.attemptsMade + 1 >= view.maxAttempts;
          this.metrics.increment(final ? 'lip_jobs_failed_final' : 'lip_jobs_retried', {
            queue,
            job: job.name,
          });
          if (final && options.onFinalFailure) {
            await options.onFinalFailure(view, error).catch((handlerErr: unknown) => {
              this.logger.error(
                { err: handlerErr, queue, job: job.name },
                'Final-failure handler failed',
              );
            });
          }
          if (permanent) throw new UnrecoverableError(`${error.code}: ${error.message}`);
          throw error;
        }
      },
      {
        connection: this.connection(true),
        prefix: this.config.queue.prefix,
        concurrency: options.concurrency,
        maxStalledCount: 2,
        removeOnComplete: { count: 0 },
        settings: {
          backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) =>
            retryDelayMs(attemptsMade, err as RetryAfterHint | undefined),
        },
      },
    );
    worker.on('error', (err) => this.logger.warn({ err, queue }, 'Worker connection error'));
    worker.on('failed', (job, err) => {
      // Stalled too often: BullMQ failed the job without running the processor.
      if (job && /stalled more than/i.test(err.message) && options.onFinalFailure) {
        this.metrics.increment('lip_jobs_failed_final', { queue, job: job.name });
        void options.onFinalFailure(toJob(job), err).catch((handlerErr: unknown) => {
          this.logger.error({ err: handlerErr, queue }, 'Final-failure handler failed');
        });
      }
    });
    this.workers.push(worker);
    await worker.waitUntilReady();
    this.logger.log({ queue, concurrency: options.concurrency }, 'Queue processor registered');
  }

  /** Number of registered processors (readiness and runtime evidence). */
  get processorCount(): number {
    return this.workers.length;
  }

  /**
   * Graceful shutdown: stop taking jobs, wait for active ones (bounded by
   * WORKER_SHUTDOWN_TIMEOUT_MS), then close queue connections. Idempotent.
   * The worker calls it on SIGTERM before closing the application, so active
   * jobs finish while the database is still connected; onModuleDestroy is the
   * fallback for other shutdown paths.
   */
  stopProcessing(): Promise<void> {
    this.stopping ??= this.stop();
    return this.stopping;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopProcessing();
  }

  private async stop(): Promise<void> {
    const timeoutMs = this.config.queue.shutdownTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const closing = Promise.allSettled(this.workers.map((w) => w.close()));
    const timedOut = await Promise.race([
      closing.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      this.logger.warn({ timeoutMs }, 'Active jobs did not finish before the shutdown timeout');
      await Promise.allSettled(this.workers.map((w) => w.close(true)));
    } else if (this.workers.length > 0) {
      this.logger.log({ workers: this.workers.length }, QUEUE_STOPPED_MESSAGE);
    }
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
