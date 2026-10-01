import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule, type AppConfig } from './config';
import { CryptoModule } from './crypto';
import { DatabaseModule } from './database';
import { LifecycleLogger } from './lifecycle';
import { LoggingModule } from './logging';
import { MetricsModule } from './metrics';
import { QueueModule } from './queue';
import { RedisModule } from './redis';
import { SecretsModule } from './secrets';

/**
 * Cross-cutting infrastructure shared by the API and worker processes.
 * Business modules (src/modules/*) may depend on platform; platform must
 * never depend on business modules (enforced by dependency-cruiser).
 */
@Module({})
export class PlatformModule {
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: PlatformModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule,
        SecretsModule,
        CryptoModule,
        DatabaseModule,
        RedisModule,
        MetricsModule,
        QueueModule,
      ],
      providers: [LifecycleLogger],
      exports: [
        ConfigModule,
        LoggingModule,
        SecretsModule,
        CryptoModule,
        DatabaseModule,
        RedisModule,
        MetricsModule,
        QueueModule,
      ],
    };
  }
}
