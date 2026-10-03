/**
 * SugarCRM reference adapter (M8, ADR 0021). Only composition roots and the
 * CLI may import this module (dependency rule); business code reaches sources
 * through the generic port.
 */
export {
  SugarConnector,
  sugarAdapterFactory,
  SUGAR_ADAPTER_VERSION,
} from './application/sugar-connector';
export {
  assertReadOnlySugarRequest,
  type SugarTransportCounters,
} from './infrastructure/sugar-http';
export { SugarError } from './errors';
export { SugarConnectionConfigSchema, type SugarConnectionConfig } from './sugar.config';
