/**
 * Products: the tenant's versioned product model and catalogue, subscriptions
 * (the single writer and the CSV import) and eligibility (ADRs 0016–0018).
 */
export {
  EligibilityService,
  SnapshotNotFoundError,
  UnknownCompanyError,
  type CompanyResolution,
  type EvaluationReport,
  type ReplayReport,
  type WhitespaceReport,
} from './application/eligibility.service';
export { OwnershipGapService, type OwnershipGap } from './application/ownership-gaps.service';
export {
  BaseVersionRequiredError,
  ConcurrentPublishError,
  NoProductModelError,
  ProductCatalogueService,
  ProductModelInvalidError,
  type PublishOptions,
  type PublishedVersion,
  type ValidationReport,
} from './application/product-catalogue.service';
export {
  CSV_LIMITS,
  parseSubscriptionCsv,
  type CsvError,
  type CsvLine,
} from './application/subscription-csv';
export {
  CSV_IMPORT_ADAPTER,
  CSV_IMPORT_ADAPTER_VERSION,
  SubscriptionImportService,
  type ImportReport,
  type ImportRequest,
} from './application/subscription-import.service';
export {
  SubscriptionIngestionService,
  type SubscriptionIngestMeta,
  type SubscriptionIngestOutcome,
} from './application/subscription-ingestion.service';
export { SubscriptionMergeParticipant } from './application/subscription-merge.participant';
export {
  SubscriptionReadModel,
  type OwnershipCoverage,
} from './application/subscription-read-model';
export { ImportAlreadyRunningError } from './infrastructure/subscription-runs.store';
export { ProductsModule } from './products.module';
export { SubscriptionMergeModule } from './subscription-merge.module';
