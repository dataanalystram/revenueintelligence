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
  type PendingParent,
} from './application/context-ingestion.service';
export { ContextOperationsService } from './application/context-operations.service';
export { ContextProcessingService } from './application/context-processing.service';
export { PROCESSORS_DISABLED_MESSAGE } from './application/context-processors';
export { ContextIntakeModule, ContextModule, type ContextModuleOptions } from './context.module';
export { classifyFailure, type FailureInfo } from './errors';
export { CONTEXT_ADAPTER_VERSION, JOBS, QUEUES, jobIds } from './jobs';
export {
  COMPANY_CANONICAL_LOCK_SCOPE,
  COMPANY_MERGE_PARTICIPANTS,
  PERSON_CANONICAL_LOCK_SCOPE,
  PERSON_MERGE_PARTICIPANTS,
  type CompanyMerge,
  type CompanyMergeParticipant,
  type PersonMerge,
  type PersonMergeParticipant,
} from './merge-participants';
// M10C (ADR 0029): account hierarchy and person–account affiliation.
export { AccountStructureModule } from './account-structure.module';
export {
  AccountHierarchyWriter,
  type OperatorParentInput,
  type OperatorParentResult,
} from './application/account-hierarchy.writer';
export {
  PersonAffiliationWriter,
  type AffiliationWritten,
  type OperatorAffiliationAdd,
  type OperatorAffiliationEnd,
  type OperatorAffiliationRelease,
} from './application/person-affiliation.writer';
export {
  AccountStructureReadModel,
  type AffiliationView,
  type AffiliationList,
  type HierarchyView,
} from './application/account-structure.read-model';
