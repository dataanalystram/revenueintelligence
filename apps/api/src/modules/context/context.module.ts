import { Global, Module, type DynamicModule, type Type } from '@nestjs/common';
import { RECEIPTS_STORED_LISTENER } from '../crm';
import { ExtensionMergeParticipant, ExtensionModule } from '../extension';
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
import { AccountContextModule } from './account-context.module';
import { AccountStructureModule } from './account-structure.module';
import { AccountContextMergeParticipant } from './application/account-context-merge.participant';
import { AccountHierarchyMergeParticipant } from './application/account-hierarchy.writer';
import {
  AffiliationCompanyMergeParticipant,
  AffiliationPersonMergeParticipant,
} from './application/person-affiliation.writer';
import {
  COMPANY_MERGE_PARTICIPANTS,
  PERSON_MERGE_PARTICIPANTS,
  type CompanyMergeParticipant,
  type PersonMergeParticipant,
} from './merge-participants';

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
  /**
   * Account-merge participants (ADR 0017 §8): required, never empty. Every
   * composition that can run a merge must pass them, so no module's
   * company-owned facts are silently left on a merged-away company.
   */
  readonly merge: {
    /** Modules exporting the participants. */
    readonly imports: readonly Type[];
    readonly participants: readonly Type<CompanyMergeParticipant>[];
  };
}

/**
 * Canonical account and person context (M6, ADR 0013/0014). The connector is
 * passed in by the composition root, so this module never imports a vendor
 * module (dependency rule `business-code-uses-crm-port`).
 */
@Module({})
export class ContextModule {
  static register(options: ContextModuleOptions): DynamicModule {
    if (!options.merge?.participants?.length) {
      throw new Error(
        'ContextModule.register: merge.participants is required (account merges must move company-owned facts)',
      );
    }
    return {
      module: ContextModule,
      imports: [
        TenancyModule,
        AccountStructureModule,
        AccountContextModule,
        ExtensionModule,
        options.connector,
        ...options.merge.imports,
      ],
      providers: [
        {
          // M10C: the hierarchy and affiliation participants are part of the
          // context module and always run, after the composition's own; M10D:
          // the extension participant (values, custom-record parents) last.
          provide: COMPANY_MERGE_PARTICIPANTS,
          useFactory: (...participants: CompanyMergeParticipant[]) => participants,
          inject: [
            ...options.merge.participants,
            AccountHierarchyMergeParticipant,
            AffiliationCompanyMergeParticipant,
            // M10E (plan §7, Q15): contexts re-pointed / collisions merged.
            AccountContextMergeParticipant,
            ExtensionMergeParticipant,
          ],
        },
        {
          provide: PERSON_MERGE_PARTICIPANTS,
          useFactory: (...participants: PersonMergeParticipant[]) => participants,
          inject: [
            AffiliationPersonMergeParticipant,
            AccountContextMergeParticipant,
            ExtensionMergeParticipant,
          ],
        },
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
