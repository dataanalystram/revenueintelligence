/**
 * HubSpot connector (read-only in Milestone 3). Business code obtains a
 * tenant-bound reader from `HubSpotConnector.forTenant(ctx)` and works with
 * vendor-neutral read models; HubSpot payloads never leave this module.
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
export { HubSpotModule } from './hubspot.module';
export {
  HubSpotReader,
  type HubSpotAccount,
  type ListOptions,
} from './infrastructure/hubspot-reader';
export {
  HUBSPOT_DEFAULT_PROPERTIES,
  HUBSPOT_OBJECT_TYPES,
  type HubSpotObjectType,
} from './infrastructure/mappers';
