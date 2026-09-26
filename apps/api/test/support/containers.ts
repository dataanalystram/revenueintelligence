import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { loadConfig, type AppConfig } from '../../src/platform/config';

const run = promisify(execFile);

// Image names are overridable so CI or air-gapped runners can use a mirror.
const POSTGRES_IMAGE = process.env.TEST_POSTGRES_IMAGE ?? 'postgres:16-alpine';
const REDIS_IMAGE = process.env.TEST_REDIS_IMAGE ?? 'redis:7-alpine';

export interface TestInfrastructure {
  readonly postgres: StartedPostgreSqlContainer;
  readonly redis: StartedRedisContainer;
  readonly config: AppConfig;
  stop(): Promise<void>;
}

export async function startInfrastructure(): Promise<TestInfrastructure> {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase('lip_test').start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: redis.getConnectionUrl(),
    HEALTH_CHECK_TIMEOUT_MS: '1500',
  });

  return {
    postgres,
    redis,
    config,
    async stop() {
      await Promise.allSettled([postgres.stop(), redis.stop()]);
    },
  };
}

/**
 * Applies all Prisma migrations exactly as a deployment would. Vitest runs
 * with the app package (apps/api) as its working directory.
 */
export async function migrate(databaseUrl: string): Promise<string> {
  const { stdout } = await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return stdout;
}
