import { Module, type DynamicModule } from '@nestjs/common';
import { ContextIntakeModule, ContextModule } from './modules/context';
import { HubSpotModule } from './modules/hubspot';
import { IdentityModule } from './modules/identity';
import { SubscriptionMergeModule, SubscriptionMergeParticipant } from './modules/products';
import { SourcesModule } from './modules/sources';
import { sugarAdapterFactory } from './modules/sugar';
import { TenancyModule } from './modules/tenancy';
import type { AppConfig } from './platform/config';
import { PlatformModule } from './platform/platform.module';

/**
 * Root module for the background worker process. Context-processing queue
 * processors (Milestone 6) and source synchronisation (Milestone 8) are
 * registered here; the worker exposes no HTTP API.
 */
@Module({})
export class WorkerModule {
  static forRoot(config?: AppConfig): DynamicModule {
    const context = ContextModule.register({
      connector: HubSpotModule,
      processors: true,
      merge: {
        imports: [SubscriptionMergeModule],
        participants: [SubscriptionMergeParticipant],
      },
    });
    return {
      module: WorkerModule,
      imports: [
        PlatformModule.forRoot(config),
        TenancyModule,
        IdentityModule,
        HubSpotModule,
        ContextIntakeModule,
        context,
        // M8: generic source connectors; adapters are registered here only.
        SourcesModule.register({ context, adapters: [sugarAdapterFactory()], processors: true }),
      ],
    };
  }
}
