/**
 * Generic source connectors (M8): connections, schema snapshots, versioned
 * mappings, source authority, preview, synchronisation and reporting.
 */
export {
  MappingPreviewService,
  PREVIEW_LIMIT,
  type PreviewReport,
} from './application/mapping-preview.service';
export {
  SchemaSnapshotsService,
  type CapturedSnapshot,
} from './application/schema-snapshots.service';
export { SourceAuthorityService } from './application/source-authority.service';
export {
  SourceConnectionsService,
  SourceSyncSettingsSchema,
  type ConfigureConnectionInput,
} from './application/source-connections.service';
export {
  SourceMappingsService,
  type MappingValidationReport,
  type PublishMappingOptions,
  type PublishedMapping,
} from './application/source-mappings.service';
export {
  SourceProfilingService,
  type ProfileRequestResult,
  type ProfileRunResult,
} from './application/source-profiling.service';
export { SourceReportService, type SourceReport } from './application/source-report.service';
export {
  SourceSyncService,
  type StartedSync,
  type SyncMode,
  type SyncResult,
} from './application/source-sync.service';
export * from './errors';
export type { SourceConnection, SourceRun } from './infrastructure/sources.repository';
export type {
  ProfileRun,
  StoredFinding,
  StoredProfile,
} from './infrastructure/profiles.repository';
export { SOURCE_PROFILE_JOB, SOURCE_SYNC_JOB, SOURCES_QUEUE } from './jobs';
export { SOURCE_ADAPTERS, SourceAdapterRegistry } from './source-adapters';
export { SourcesModule, type SourcesModuleOptions } from './sources.module';
