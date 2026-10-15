import { Module, type DynamicModule } from '@nestjs/common';
import type { SourceAdapterFactory } from '../domain';
import { AccountContextModule } from '../context';
import { ExtensionModule } from '../extension';
import { ProductsModule } from '../products';
import { TenancyModule } from '../tenancy';
import { MappingPreviewService } from './application/mapping-preview.service';
import { ProfilePurgeService } from './application/profile-purge.service';
import { SchemaSnapshotsService } from './application/schema-snapshots.service';
import { SourceExtensionSync } from './application/source-extension-sync';
import { SourceAuthorityService } from './application/source-authority.service';
import { SourceConnectionsService } from './application/source-connections.service';
import { SourceMappingsService } from './application/source-mappings.service';
import { SourceProfilingService } from './application/source-profiling.service';
import { SourceReportService } from './application/source-report.service';
import { SourceSyncProcessor } from './application/source-sync.processor';
import { SourceSyncService } from './application/source-sync.service';
import { ProfilePurgeStore } from './infrastructure/profile-purge.store';
import { ProfilesRepository } from './infrastructure/profiles.repository';
import { SourcesRepository } from './infrastructure/sources.repository';
import { SOURCE_ADAPTERS, SourceAdapterRegistry } from './source-adapters';

export interface SourcesModuleOptions {
  /**
   * The composition's ContextModule registration (the same object it imports),
   * so source runs reach the single canonical context writer.
   */
  readonly context: DynamicModule;
  /** Adapter factories (composition root; e.g. `sugarAdapterFactory()`). */
  readonly adapters: readonly SourceAdapterFactory[];
  /** Register the `lip-sources` processor (`source.sync`, `source.profile`; worker only). */
  readonly processors: boolean;
}

/**
 * Generic source connectors (M8, ADRs 0019–0021): connections, schema
 * snapshots, versioned mappings, authority, preview, synchronisation and
 * reporting. Vendor-neutral: adapters are injected by the composition root.
 */
@Module({})
export class SourcesModule {
  static register(options: SourcesModuleOptions): DynamicModule {
    const services = [
      SourceConnectionsService,
      SchemaSnapshotsService,
      SourceMappingsService,
      SourceAuthorityService,
      MappingPreviewService,
      SourceSyncService,
      SourceReportService,
      SourceProfilingService,
      ProfilePurgeService,
    ];
    return {
      module: SourcesModule,
      imports: [
        TenancyModule,
        ProductsModule,
        ExtensionModule,
        AccountContextModule,
        options.context,
      ],
      providers: [
        { provide: SOURCE_ADAPTERS, useValue: options.adapters },
        SourceAdapterRegistry,
        SourcesRepository,
        ProfilesRepository,
        ProfilePurgeStore,
        SourceExtensionSync,
        ...services,
        ...(options.processors ? [SourceSyncProcessor] : []),
      ],
      exports: [SourceAdapterRegistry, ...services],
    };
  }
}
