import { Logger, Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy';
import { HubSpotConnector } from './application/hubspot-connector.service';
import { HubSpotDiscoveryService } from './application/hubspot-discovery.service';
import { HUBSPOT_CONFIG, loadHubSpotConfig, type HubSpotConfig } from './hubspot.config';
import { HubSpotHttpClient } from './infrastructure/http-client';
import { SlidingWindowRateLimiter } from './infrastructure/rate-limiter';

/** Read-only HubSpot connector (Milestone 3). */
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
    HubSpotConnector,
    HubSpotDiscoveryService,
  ],
  exports: [HubSpotConnector, HubSpotDiscoveryService],
})
export class HubSpotModule {}
