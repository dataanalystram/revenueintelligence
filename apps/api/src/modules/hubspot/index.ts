/**
 * HubSpot connector (read-only). Business code does NOT import this module: it
 * injects `CRM_CONNECTOR` (src/modules/crm) and works with the vendor-neutral
 * `CrmReader`. Only composition roots (app/worker modules) and the CLI import
 * it (dependency-cruiser enforces this). HubSpot payloads never leave it.
 */
export {
  HUBSPOT_ACCESS_TOKEN,
  HubSpotConnector,
  type VerifiedHubSpotConnection,
} from './application/hubspot-connector.service';
export {
  HubSpotDiscoveryService,
  TEST_ACCOUNT_TYPES,
  type DiscoveryOptions,
  type HubSpotDiscoveryReport,
  type Probe,
} from './application/hubspot-discovery.service';
export { HubSpotError, isHubSpotError, type HubSpotErrorKind } from './errors';
export { HUBSPOT_CONFIG, loadHubSpotConfig, type HubSpotConfig } from './hubspot.config';
export {
  ACCESS_TOKEN_SKEW_MS,
  HUBSPOT_APP_CLIENT_SECRET,
  HubSpotOAuthService,
  type CompletedInstall,
  type RefreshOutcome,
} from './application/hubspot-oauth.service';
export { HUBSPOT_OBJECT_FOR_KIND, HubSpotCrmReader } from './application/hubspot-crm-reader';
export { HubSpotModule, HubSpotOAuthHttpModule } from './hubspot.module';
export {
  HUBSPOT_OAUTH_REVOKE_PATH,
  HUBSPOT_OAUTH_SCOPES,
  assertOAuthRequest,
} from './infrastructure/oauth-client';
export {
  HubSpotWebhookService,
  type UnroutableReason,
  type WebhookOutcome,
  type WebhookRequest,
} from './application/hubspot-webhook.service';
export {
  WebhookReceiptRepository,
  type RecordedDeliveries,
  type WebhookReceiptRow,
  type WebhookReceiptSummary,
} from './infrastructure/webhook-receipt.repository';
export {
  SIGNATURE_V3_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_MAX_AGE_MS,
  WEBHOOK_MAX_FUTURE_SKEW_MS,
  externalRequestUri,
  signatureV3,
  signedUri,
  verifySignatureV3,
} from './infrastructure/webhook-signature';
export {
  WEBHOOK_MAX_EVENTS,
  parseWebhookBatch,
  type WebhookEvent,
} from './infrastructure/webhook-events';
export {
  HubSpotReader,
  type AssociationReadFailure,
  type AssociationReadResult,
  type HubSpotAccount,
  type ListOptions,
} from './infrastructure/hubspot-reader';
export {
  HUBSPOT_DEFAULT_PROPERTIES,
  HUBSPOT_OBJECT_TYPES,
  type HubSpotObjectType,
} from './infrastructure/mappers';
