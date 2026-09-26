import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from './config.schema';
import { loadConfig } from './load-config';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  /** Validates process.env (or the supplied config, for tests) and exposes it as APP_CONFIG. */
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useFactory: () => config ?? loadConfig() }],
      exports: [APP_CONFIG],
    };
  }
}
