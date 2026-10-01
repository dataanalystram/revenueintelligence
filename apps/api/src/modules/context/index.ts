/**
 * Canonical account and person context (Milestone 6, ADR 0013/0014): durable
 * event processing on BullMQ, one canonical writer, external references and
 * provenance. Vendor-neutral: connectors are reached through the CRM ports.
 */
export { BulkSyncService, CONTEXT_KINDS, type StartedRun } from './application/bulk-sync.service';
export {
  ContextIngestionService,
  type IngestMeta,
  type IngestResult,
} from './application/context-ingestion.service';
export { ContextOperationsService } from './application/context-operations.service';
export { ContextProcessingService } from './application/context-processing.service';
export { PROCESSORS_DISABLED_MESSAGE } from './application/context-processors';
export { ContextIntakeModule, ContextModule, type ContextModuleOptions } from './context.module';
export { classifyFailure, type FailureInfo } from './errors';
export { CONTEXT_ADAPTER_VERSION, JOBS, QUEUES, jobIds } from './jobs';
