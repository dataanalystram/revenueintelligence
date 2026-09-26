import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from './platform/config';
import { HealthModule } from './platform/health';
import { PlatformModule } from './platform/platform.module';

/** Root module for the HTTP API process. */
@Module({})
export class AppModule {
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(config), HealthModule],
    };
  }
}
