import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule, type AppConfig } from './config';
import { DatabaseModule } from './database';
import { LifecycleLogger } from './lifecycle';
import { LoggingModule } from './logging';
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
        DatabaseModule,
        RedisModule,
      ],
      providers: [LifecycleLogger],
      exports: [ConfigModule, LoggingModule, SecretsModule, DatabaseModule, RedisModule],
    };
  }
}
