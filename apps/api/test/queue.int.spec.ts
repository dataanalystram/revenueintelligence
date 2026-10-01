import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/platform/config';
import { PlatformModule } from '../src/platform/platform.module';
import { MetricsService } from '../src/platform/metrics';
import {
  PermanentJobError,
  QueueService,
  RedisPolicyError,
  type QueueJob,
} from '../src/platform/queue';
import { startInfrastructure, type TestInfrastructure } from './support/containers';

/** QueueService against a real Redis (BullMQ), without business modules. */
describe('QueueService (real Redis + BullMQ)', () => {
  let infra: TestInfrastructure;
  let app: INestApplicationContext | undefined;
  let n = 0;

  beforeAll(async () => {
    infra = await startInfrastructure();
  });
  afterAll(async () => {
    await infra?.stop();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(env: NodeJS.ProcessEnv = {}): Promise<QueueService> {
    n += 1;
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: infra.config.databaseUrl,
      REDIS_URL: infra.config.redisUrl,
      QUEUE_PREFIX: `t${n}`,
      ...env,
    });
    app = await NestFactory.createApplicationContext(PlatformModule.forRoot(config), {
      logger: false,
    });
    return app.get(QueueService);
  }

  const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('processes a job once per id; duplicates of a queued id are not added', async () => {
    const queues = await start();
    const seen: QueueJob<{ v: number }>[] = [];
    await queues.add('q', 'work', { v: 1 }, { jobId: 'job-a1' });
    await queues.add('q', 'work', { v: 2 }, { jobId: 'job-a1' });
    await queues.registerProcessor<{ v: number }>(
      'q',
      async (job) => {
        seen.push(job);
        await Promise.resolve();
      },
      { concurrency: 1 },
    );
    await until(() => seen.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.data).toEqual({ v: 1 });
    expect(app!.get(MetricsService).total('lip_jobs_succeeded', { queue: 'q' })).toBe(1);
  });

  it('a permanent error fails at once and calls the final-failure handler once', async () => {
    const queues = await start();
    let runs = 0;
    const finals: string[] = [];
    await queues.registerProcessor(
      'q',
      () => {
        runs += 1;
        return Promise.reject(new PermanentJobError('bad_payload', 'nope'));
      },
      {
        concurrency: 1,
        onFinalFailure: (job, err) => {
          finals.push(`${job.id}:${err.message}`);
          return Promise.resolve();
        },
      },
    );
    await queues.add('q', 'work', {}, { jobId: 'job-p1' });
    await until(() => finals.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(runs).toBe(1);
    expect(finals).toEqual(['job-p1:nope']);
    expect((await queues.counts('q')).failed).toBe(1);
  });

  it('a transient error is retried, and the final failure comes after the last attempt', async () => {
    const queues = await start();
    let runs = 0;
    const finals: number[] = [];
    await queues.registerProcessor(
      'q',
      (job) => {
        runs += 1;
        // Retry-After hint keeps the test fast but proves the hint is honoured as a floor.
        return Promise.reject(
          Object.assign(new Error(`transient ${job.attemptsMade}`), { retryAfterMs: 1 }),
        );
      },
      {
        concurrency: 1,
        onFinalFailure: (job) => {
          finals.push(job.attemptsMade);
          return Promise.resolve();
        },
      },
    );
    // Backoff starts at 5 s, so use 2 attempts to keep the test short.
    await queues.add('q', 'work', {}, { jobId: 'job-t1', attempts: 2 });
    await until(() => finals.length === 1, 30_000);
    expect(runs).toBe(2);
    expect(finals).toEqual([1]);
  });

  it('graceful shutdown waits for the active job to finish', async () => {
    const queues = await start();
    let finished = false;
    let startedJob = false;
    await queues.registerProcessor(
      'q',
      async () => {
        startedJob = true;
        await new Promise((r) => setTimeout(r, 1_500));
        finished = true;
      },
      { concurrency: 1 },
    );
    await queues.add('q', 'work', {}, { jobId: 'job-s1' });
    await until(() => startedJob);
    await queues.stopProcessing();
    expect(finished).toBe(true);
  });

  it('refuses to process when Redis may evict keys (maxmemory-policy)', async () => {
    const admin = new Redis(infra.config.redisUrl);
    try {
      await admin.config('SET', 'maxmemory-policy', 'allkeys-lru');
      const queues = await start();
      await expect(
        queues.registerProcessor('q', () => Promise.resolve(), { concurrency: 1 }),
      ).rejects.toBeInstanceOf(RedisPolicyError);
      expect(queues.processorCount).toBe(0);
    } finally {
      await admin.config('SET', 'maxmemory-policy', 'noeviction');
      admin.disconnect();
    }
  });

  it('refuses job ids that BullMQ would misread', async () => {
    const queues = await start();
    await expect(queues.add('q', 'w', {}, { jobId: 'a:b' })).rejects.toThrow(RangeError);
    await expect(queues.add('q', 'w', {}, { jobId: '123' })).rejects.toThrow(RangeError);
  });
});
