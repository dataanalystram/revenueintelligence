import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config';
import type { HealthIndicator } from '../health/health-indicator';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    // Fail fast instead of queueing commands while disconnected, so readiness
    // reflects reality. BullMQ (M6) creates its own connections with its own
    // recommended settings.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  });
}

@Injectable()
export class RedisLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    // Without a listener ioredis reports errors as unhandled; reconnection is automatic.
    this.redis.on('error', (err: Error) => this.logger.warn({ err }, 'Redis connection error'));
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (err) {
      // Boot anyway: readiness reports the outage and ioredis keeps retrying.
      this.logger.error({ err }, 'Redis unavailable at start-up');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}

@Injectable()
export class RedisHealthIndicator implements HealthIndicator {
  readonly name = 'redis';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async check(): Promise<void> {
    const reply: string = await this.redis.ping();
    if (reply !== 'PONG') {
      throw new Error(`Unexpected PING reply: ${reply}`);
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createRedisClient(config.redisUrl),
    },
    RedisLifecycle,
    RedisHealthIndicator,
  ],
  exports: [REDIS_CLIENT, RedisHealthIndicator],
})
export class RedisModule {}
