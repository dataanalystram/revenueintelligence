import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { createRedisClient, RedisHealthIndicator, RedisLifecycle } from './redis.module';

class FakeRedis extends EventEmitter {
  status = 'wait';
  connect = vi.fn(() => Promise.resolve());
  quit = vi.fn(() => Promise.resolve('OK'));
  disconnect = vi.fn();
  ping = vi.fn(() => Promise.resolve('PONG'));
}

const asRedis = (fake: FakeRedis) => fake as unknown as Redis;

describe('RedisLifecycle', () => {
  it('connects on module init', async () => {
    const fake = new FakeRedis();
    await new RedisLifecycle(asRedis(fake)).onModuleInit();
    expect(fake.connect).toHaveBeenCalledOnce();
  });

  it('still boots when Redis is unreachable at start-up', async () => {
    const fake = new FakeRedis();
    fake.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(new RedisLifecycle(asRedis(fake)).onModuleInit()).resolves.toBeUndefined();
  });

  it('handles connection error events instead of crashing the process', () => {
    const fake = new FakeRedis();
    new RedisLifecycle(asRedis(fake));
    expect(fake.listenerCount('error')).toBe(1);
    expect(() => fake.emit('error', new Error('socket closed'))).not.toThrow();
  });

  it('quits gracefully when connected and disconnects otherwise', async () => {
    const ready = new FakeRedis();
    ready.status = 'ready';
    await new RedisLifecycle(asRedis(ready)).onApplicationShutdown();
    expect(ready.quit).toHaveBeenCalledOnce();

    const broken = new FakeRedis();
    broken.status = 'reconnecting';
    await new RedisLifecycle(asRedis(broken)).onApplicationShutdown();
    expect(broken.quit).not.toHaveBeenCalled();
    expect(broken.disconnect).toHaveBeenCalledOnce();
  });
});

describe('RedisHealthIndicator', () => {
  it('passes on PONG', async () => {
    await expect(
      new RedisHealthIndicator(asRedis(new FakeRedis())).check(),
    ).resolves.toBeUndefined();
  });

  it('fails on an unexpected reply', async () => {
    const fake = new FakeRedis();
    fake.ping.mockResolvedValueOnce('LOADING');
    await expect(new RedisHealthIndicator(asRedis(fake)).check()).rejects.toThrow('LOADING');
  });

  it('fails when the command errors', async () => {
    const fake = new FakeRedis();
    fake.ping.mockRejectedValueOnce(new Error("Stream isn't writeable"));
    await expect(new RedisHealthIndicator(asRedis(fake)).check()).rejects.toThrow();
  });
});

describe('createRedisClient', () => {
  it('fails fast rather than queueing commands while disconnected', () => {
    const client = createRedisClient('redis://localhost:6379');
    try {
      expect(client.options.lazyConnect).toBe(true);
      expect(client.options.enableOfflineQueue).toBe(false);
      expect(client.status).toBe('wait');
    } finally {
      client.disconnect();
    }
  });
});
