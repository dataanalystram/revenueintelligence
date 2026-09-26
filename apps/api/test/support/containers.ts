import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Client } from 'pg';
import { loadConfig, type AppConfig } from '../../src/platform/config';

const run = promisify(execFile);

// Image names are overridable so CI or air-gapped runners can use a mirror.
const POSTGRES_IMAGE = process.env.TEST_POSTGRES_IMAGE ?? 'postgres:16-alpine';
const REDIS_IMAGE = process.env.TEST_REDIS_IMAGE ?? 'redis:7-alpine';

/** The runtime login role used by tests, as in production (member of lip_app). */
export const APP_LOGIN = { user: 'lip_api', password: 'lip_api_test' } as const;

export interface TestInfrastructure {
  readonly postgres: StartedPostgreSqlContainer;
  readonly redis: StartedRedisContainer;
  /** Config for the application: connects as the non-privileged app role. */
  readonly config: AppConfig;
  /** Owner/superuser connection string: migrations and test assertions only. */
  readonly adminUrl: string;
  stop(): Promise<void>;
}

export function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase('lip_test').start();
}

/** Applies all Prisma migrations exactly as a deployment would (as the owner). */
export async function migrate(databaseUrl: string, extraArgs: string[] = []): Promise<string> {
  const { stdout } = await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy', ...extraArgs], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl },
  });
  return stdout;
}

/** Creates the runtime login role, as ops would in a real environment. */
export async function createAppLogin(adminUrl: string): Promise<void> {
  await withAdmin(adminUrl, async (db) => {
    await db.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_LOGIN.user}') THEN
          CREATE ROLE ${APP_LOGIN.user} LOGIN PASSWORD '${APP_LOGIN.password}' IN ROLE lip_app;
        END IF;
      END $$;`);
  });
}

export async function withAdmin<T>(adminUrl: string, work: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: adminUrl });
  await db.connect();
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

export function appConfig(
  databaseUrl: string,
  redisUrl: string,
  overrides: NodeJS.ProcessEnv = {},
): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    HEALTH_CHECK_TIMEOUT_MS: '1500',
    ...overrides,
  });
}

/** PostgreSQL (migrated, with the app login) + Redis, ready for the application. */
export async function startInfrastructure(): Promise<TestInfrastructure> {
  const [postgres, redis] = await Promise.all([
    startPostgres(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  const adminUrl = postgres.getConnectionUri();
  await migrate(adminUrl);
  await createAppLogin(adminUrl);
  const config = appConfig(
    withCredentials(adminUrl, APP_LOGIN.user, APP_LOGIN.password),
    redis.getConnectionUrl(),
  );
  return {
    postgres,
    redis,
    config,
    adminUrl,
    async stop() {
      await Promise.allSettled([postgres.stop(), redis.stop()]);
    },
  };
}
