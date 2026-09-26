import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../src/bootstrap';
import { migrate, startInfrastructure, type TestInfrastructure } from './support/containers';

describe('API process (real PostgreSQL + Redis)', () => {
  let infra: TestInfrastructure;
  let app: INestApplication;
  let http: App;

  beforeAll(async () => {
    infra = await startInfrastructure();
    app = await createApiApp(infra.config);
    await app.init();
    http = app.getHttpServer() as App;
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  it('applies database migrations cleanly and idempotently', async () => {
    // Re-running must be a no-op, as it is on every deployment.
    await expect(migrate(infra.adminUrl)).resolves.toBeDefined();
  });

  it('GET /health/live returns 200', async () => {
    const res = await request(http).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports database and Redis up', async () => {
    const res = await request(http).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('propagates a caller-supplied x-request-id', async () => {
    const res = await request(http).get('/health/live').set('x-request-id', 'trace-42').expect(200);
    expect(res.headers['x-request-id']).toBe('trace-42');
  });

  it('generates an x-request-id when none is supplied', async () => {
    const res = await request(http).get('/health/live').expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('applies security headers and hides the framework', async () => {
    const res = await request(http).get('/health/live').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await request(http)
      .get('/does-not-exist')
      .set('x-request-id', 'req-404')
      .expect(404);
    expect(res.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Cannot GET /does-not-exist',
      requestId: 'req-404',
    });
  });

  // Destructive scenarios run last: they stop the containers.
  describe('when dependencies fail', () => {
    it('reports 503 with redis down when Redis is unavailable', async () => {
      await infra.redis.stop();
      const res = await request(http).get('/health/ready').expect(503);
      expect(res.body).toMatchObject({
        status: 'error',
        checks: { database: { status: 'up' }, redis: { status: 'down' } },
      });
    });

    it('stays live while not ready', async () => {
      await request(http).get('/health/live').expect(200);
    });

    it('reports 503 with database down when PostgreSQL is unavailable', async () => {
      await infra.postgres.stop();
      const res = await request(http).get('/health/ready').expect(503);
      expect(res.body).toMatchObject({ status: 'error', checks: { database: { status: 'down' } } });
    });
  });
});
