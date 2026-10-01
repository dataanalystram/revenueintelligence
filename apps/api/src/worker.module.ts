import { Module, type DynamicModule } from '@nestjs/common';
import { ContextIntakeModule, ContextModule } from './modules/context';
import { HubSpotModule } from './modules/hubspot';
import { IdentityModule } from './modules/identity';
import { TenancyModule } from './modules/tenancy';
import type { AppConfig } from './platform/config';
import { PlatformModule } from './platform/platform.module';

/**
 * Root module for the background worker process. Context-processing queue
 * processors (Milestone 6) are registered here; the worker exposes no HTTP API.
 */
@Module({})
export class WorkerModule {
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        PlatformModule.forRoot(config),
        TenancyModule,
        IdentityModule,
        HubSpotModule,
        ContextIntakeModule,
        ContextModule.register({ connector: HubSpotModule, processors: true }),
      ],
    };
  }
}
