import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import type { HealthIndicator } from './health-indicator';
import { HealthService } from './health.service';

const config = loadConfig({
  DATABASE_URL: 'postgresql://u:p@db/lip',
  REDIS_URL: 'redis://r',
  HEALTH_CHECK_TIMEOUT_MS: '100',
});

const indicator = (name: string, check: () => Promise<void>): HealthIndicator => ({ name, check });
const up = (name: string) => indicator(name, () => Promise.resolve());
const down = (name: string) =>
  indicator(name, () => Promise.reject(new Error('connection refused')));

describe('HealthService.readiness', () => {
  it('is ok when every indicator is up', async () => {
    const report = await new HealthService([up('database'), up('redis')], config).readiness();

    expect(report.status).toBe('ok');
    expect(report.checks.database?.status).toBe('up');
    expect(report.checks.redis?.status).toBe('up');
    expect(report.checks.database?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('is an error when any indicator fails, and reports which one', async () => {
    const report = await new HealthService([up('database'), down('redis')], config).readiness();

    expect(report.status).toBe('error');
    expect(report.checks).toMatchObject({ database: { status: 'up' }, redis: { status: 'down' } });
  });

  it('does not expose error details in the report', async () => {
    const report = await new HealthService([down('database')], config).readiness();
    expect(JSON.stringify(report)).not.toContain('connection refused');
  });

  it('marks a hanging indicator as down after the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const hanging = indicator('database', () => new Promise<void>(() => undefined));
      const pending = new HealthService([hanging, up('redis')], config).readiness();
      await vi.advanceTimersByTimeAsync(100);
      const report = await pending;

      expect(report.status).toBe('error');
      expect(report.checks.database?.status).toBe('down');
      expect(report.checks.redis?.status).toBe('up');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs indicators concurrently', async () => {
    const slow = (name: string) =>
      indicator(name, () => new Promise<void>((resolve) => setTimeout(resolve, 60)));
    const started = performance.now();
    const report = await new HealthService([slow('a'), slow('b'), slow('c')], config).readiness();

    expect(report.status).toBe('ok');
    expect(performance.now() - started).toBeLessThan(100 + 60);
  });

  it('is ok with no indicators registered', async () => {
    await expect(new HealthService([], config).readiness()).resolves.toEqual({
      status: 'ok',
      checks: {},
    });
  });
});
