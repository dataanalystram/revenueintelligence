import { NestFactory } from '@nestjs/core';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnsafeDatabaseRoleError } from '../../src/platform/database';
import { WorkerModule } from '../../src/worker.module';
import {
  APP_LOGIN,
  appConfig,
  createAppLogin,
  migrate,
  startPostgres,
  withAdmin,
  withCredentials,
} from '../support/containers';

const REDIS_UNUSED = 'redis://127.0.0.1:1';

async function boot(databaseUrl: string, env: NodeJS.ProcessEnv = {}) {
  const app = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(appConfig(databaseUrl, REDIS_UNUSED, env)),
    { logger: false, abortOnError: false },
  );
  try {
    await app.init();
  } finally {
    await app.close().catch(() => undefined);
  }
}

describe('database role guard (the app refuses roles that bypass RLS)', () => {
  let pg: StartedPostgreSqlContainer;
  let adminUrl: string;

  beforeAll(async () => {
    pg = await startPostgres();
    adminUrl = pg.getConnectionUri();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it('refuses to start before migrations have installed tenancy', async () => {
    await expect(boot(adminUrl, { DATABASE_ALLOW_PRIVILEGED_ROLE: 'true' })).rejects.toThrow(
      /tenancy schema not installed/,
    );
  });

  describe('after migration', () => {
    beforeAll(async () => {
      await migrate(adminUrl);
      await createAppLogin(adminUrl);
      await withAdmin(adminUrl, (db) => db.query("CREATE ROLE outsider LOGIN PASSWORD 'outsider'"));
    });

    it('refuses a superuser connection', async () => {
      await expect(boot(adminUrl)).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
      await expect(boot(adminUrl)).rejects.toThrow(/superuser/);
    });

    it('allows a superuser only with the explicit development override', async () => {
      await expect(
        boot(adminUrl, { DATABASE_ALLOW_PRIVILEGED_ROLE: 'true' }),
      ).resolves.toBeUndefined();
    });

    it('refuses a login role that is not a member of lip_app', async () => {
      await expect(boot(withCredentials(adminUrl, 'outsider', 'outsider'))).rejects.toThrow(
        /not a member of lip_app/,
      );
    });

    it('refuses a BYPASSRLS role', async () => {
      await withAdmin(adminUrl, (db) =>
        db.query("CREATE ROLE bypasser LOGIN PASSWORD 'bypasser' BYPASSRLS IN ROLE lip_app"),
      );
      await expect(boot(withCredentials(adminUrl, 'bypasser', 'bypasser'))).rejects.toThrow(
        /BYPASSRLS/,
      );
    });

    it('starts with the application role', async () => {
      await expect(
        boot(withCredentials(adminUrl, APP_LOGIN.user, APP_LOGIN.password)),
      ).resolves.toBeUndefined();
    });

    it('the production configuration can never enable the override', () => {
      expect(() =>
        appConfig(adminUrl, REDIS_UNUSED, {
          NODE_ENV: 'production',
          DATABASE_ALLOW_PRIVILEGED_ROLE: 'true',
        }),
      ).toThrow(/must not be enabled in production/);
    });
  });
});
