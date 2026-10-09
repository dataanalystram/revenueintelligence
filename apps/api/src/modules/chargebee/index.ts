/**
 * Chargebee reference adapter (M9B, ADR 0024). Only composition roots and the
 * CLI may import this module (dependency rule); business code reaches sources
 * through the generic port.
 */
export {
  ChargebeeConnector,
  chargebeeAdapterFactory,
  CHARGEBEE_ADAPTER_VERSION,
} from './application/chargebee-connector';
export {
  assertReadOnlyChargebeeRequest,
  CHARGEBEE_ALLOWED_PATHS,
  type ChargebeeTransportCounters,
} from './infrastructure/chargebee-http';
export { ChargebeeError } from './errors';
export {
  ChargebeeConnectionConfigSchema,
  type ChargebeeConnectionConfig,
} from './chargebee.config';
