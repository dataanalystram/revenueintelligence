import { Module, type DynamicModule } from '@nestjs/common';
import { ContextIntakeModule } from './modules/context';
import { HubSpotOAuthHttpModule } from './modules/hubspot';
import { IdentityModule } from './modules/identity';
import { TenancyModule } from './modules/tenancy';
import type { AppConfig } from './platform/config';
import { HealthModule } from './platform/health';
import { PlatformModule } from './platform/platform.module';

/** Root module for the HTTP API process. */
@Module({})
export class AppModule {
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(config),
        HealthModule,
        TenancyModule,
        IdentityModule,
        // M6: the webhook intake hands new receipts to the queue (processing runs in the worker).
        ContextIntakeModule,
        HubSpotOAuthHttpModule,
      ],
    };
  }
}
