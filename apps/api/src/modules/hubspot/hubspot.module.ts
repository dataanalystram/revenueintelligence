import { Logger, Module } from '@nestjs/common';
import { CRM_CONNECTOR, CRM_RECEIPT_SOURCE } from '../crm';
import { TenancyModule } from '../tenancy';
import { HubSpotOAuthController } from './api/hubspot-oauth.controller';
import { HubSpotWebhookController } from './api/hubspot-webhook.controller';
import { HubSpotConnector } from './application/hubspot-connector.service';
import { HubSpotDiscoveryService } from './application/hubspot-discovery.service';
import { HubSpotOAuthService } from './application/hubspot-oauth.service';
import { HubSpotReceiptSource } from './application/hubspot-receipt-source';
import { HubSpotWebhookService } from './application/hubspot-webhook.service';
import { HUBSPOT_CONFIG, loadHubSpotConfig, type HubSpotConfig } from './hubspot.config';
import { HubSpotHttpClient } from './infrastructure/http-client';
import { HubSpotOAuthClient } from './infrastructure/oauth-client';
import { SlidingWindowRateLimiter } from './infrastructure/rate-limiter';
import { WebhookReceiptRepository } from './infrastructure/webhook-receipt.repository';

/** Read-only HubSpot connector (Milestones 3–5): CrmConnector port, OAuth token source, webhook intake. */
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
    WebhookReceiptRepository,
    HubSpotWebhookService,
    HubSpotReceiptSource,
    { provide: CRM_RECEIPT_SOURCE, useExisting: HubSpotReceiptSource },
  ],
  exports: [
    CRM_RECEIPT_SOURCE,
    HubSpotConnector,
    CRM_CONNECTOR,
    HubSpotOAuthService,
    HubSpotDiscoveryService,
    HubSpotWebhookService,
    WebhookReceiptRepository,
  ],
})
export class HubSpotModule {}

/** The OAuth callback and webhook endpoints; registered in the API process only. */
@Module({
  imports: [HubSpotModule],
  controllers: [HubSpotOAuthController, HubSpotWebhookController],
})
export class HubSpotOAuthHttpModule {}
