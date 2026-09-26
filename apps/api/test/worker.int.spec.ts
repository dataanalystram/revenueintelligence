import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/platform/database';
import { EnvSecretProvider, SECRET_PROVIDER } from '../src/platform/secrets';
import { WorkerModule } from '../src/worker.module';
import { startInfrastructure, type TestInfrastructure } from './support/containers';

describe('Worker process (real PostgreSQL + Redis)', () => {
  let infra: TestInfrastructure;

  beforeAll(async () => {
    infra = await startInfrastructure();
  });

  afterAll(async () => {
    await infra?.stop();
  });

  it('boots the platform without an HTTP server and shuts down cleanly', async () => {
    const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(infra.config), {
      logger: false,
    });

    const prisma = app.get(PrismaService);
    await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
    expect(app.get(SECRET_PROVIDER)).toBeInstanceOf(EnvSecretProvider);

    await expect(app.close()).resolves.toBeUndefined();
  });

  it('releases every database connection on shutdown', async () => {
    for (let i = 0; i < 3; i++) {
      const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(infra.config), {
        logger: false,
      });
      await app.get(PrismaService).$queryRaw`SELECT 1`;
      await app.close();
    }

    // Measure from an independent connection so the probe itself is excluded.
    const probe = new Client({ connectionString: infra.config.databaseUrl });
    await probe.connect();
    try {
      const { rows } = await probe.query<{ count: string }>(
        'SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
      );
      expect(Number(rows[0]?.count)).toBe(0);
    } finally {
      await probe.end();
    }
  });
});
