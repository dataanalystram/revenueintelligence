import { Logger, Module } from '@nestjs/common';
import { CRM_CONNECTOR } from '../crm';
import { TenancyModule } from '../tenancy';
import { HubSpotOAuthController } from './api/hubspot-oauth.controller';
import { HubSpotConnector } from './application/hubspot-connector.service';
import { HubSpotDiscoveryService } from './application/hubspot-discovery.service';
import { HubSpotOAuthService } from './application/hubspot-oauth.service';
import { HUBSPOT_CONFIG, loadHubSpotConfig, type HubSpotConfig } from './hubspot.config';
import { HubSpotHttpClient } from './infrastructure/http-client';
import { HubSpotOAuthClient } from './infrastructure/oauth-client';
import { SlidingWindowRateLimiter } from './infrastructure/rate-limiter';

/** Read-only HubSpot connector (Milestones 3–4): CrmConnector port, OAuth token source. */
@Module({
  imports: [TenancyModule],
  providers: [
    { provide: HUBSPOT_CONFIG, useFactory: () => loadHubSpotConfig() },
    {
      provide: HubSpotHttpClient,
      inject: [HUBSPOT_CONFIG],
      useFactory: (config: HubSpotConfig) => {
        const logger = new Logger('HubSpotHttpClient');
        return new HubSpotHttpClient(config, new SlidingWindowRateLimiter(config.requestsPer10s), {
          logger: { warn: (message, context) => logger.warn({ ...context, msg: message }) },
        });
      },
    },
    {
      provide: HubSpotOAuthClient,
      inject: [HUBSPOT_CONFIG],
      useFactory: (config: HubSpotConfig) => new HubSpotOAuthClient(config),
    },
    HubSpotOAuthService,
    HubSpotConnector,
    { provide: CRM_CONNECTOR, useExisting: HubSpotConnector },
    HubSpotDiscoveryService,
  ],
  exports: [HubSpotConnector, CRM_CONNECTOR, HubSpotOAuthService, HubSpotDiscoveryService],
})
export class HubSpotModule {}

/** The OAuth callback endpoint; registered in the API process only. */
@Module({ imports: [HubSpotModule], controllers: [HubSpotOAuthController] })
export class HubSpotOAuthHttpModule {}
