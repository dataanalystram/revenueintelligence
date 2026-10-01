import { Global, Module, type DynamicModule, type Type } from '@nestjs/common';
import { RECEIPTS_STORED_LISTENER } from '../crm';
import { TenancyModule } from '../tenancy';
import { BulkSyncService } from './application/bulk-sync.service';
import { ContextIngestionService } from './application/context-ingestion.service';
import { ContextOperationsService } from './application/context-operations.service';
import { ContextProcessingService } from './application/context-processing.service';
import { ContextProcessors } from './application/context-processors';
import { ContextJobs, ContextReaders } from './application/context-runtime';
import { ReceiptEnqueuer } from './application/receipt-enqueuer';
import { ContextReadModel } from './infrastructure/context-read-model';
import { ContextStore } from './infrastructure/context-store';
import { ProcessingRecordsRepository } from './infrastructure/processing-records.repository';

/**
 * Intake side (API and worker): queues receipts after they are stored. Global
 * so the connector's webhook service can inject the listener without
 * importing this module.
 */
@Global()
@Module({
  providers: [
    ContextJobs,
    ReceiptEnqueuer,
    { provide: RECEIPTS_STORED_LISTENER, useExisting: ReceiptEnqueuer },
  ],
  exports: [ContextJobs, RECEIPTS_STORED_LISTENER],
})
export class ContextIntakeModule {}

export interface ContextModuleOptions {
  /** The connector module providing CRM_CONNECTOR and CRM_RECEIPT_SOURCE (composition root). */
  readonly connector: Type;
  /** Register job processors (worker process only). */
  readonly processors: boolean;
}

/**
 * Canonical account and person context (M6, ADR 0013/0014). The connector is
 * passed in by the composition root, so this module never imports a vendor
 * module (dependency rule `business-code-uses-crm-port`).
 */
@Module({})
export class ContextModule {
  static register(options: ContextModuleOptions): DynamicModule {
    return {
      module: ContextModule,
      imports: [TenancyModule, options.connector],
      providers: [
        ContextStore,
        ContextReadModel,
        ProcessingRecordsRepository,
        ContextIngestionService,
        ContextReaders,
        BulkSyncService,
        ContextProcessingService,
        ContextOperationsService,
        ...(options.processors ? [ContextProcessors] : []),
      ],
      exports: [
        ContextIngestionService,
        ContextProcessingService,
        ContextOperationsService,
        BulkSyncService,
      ],
    };
  }
}
