import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { TenancyModule } from '../tenancy';
import { EligibilityService } from './application/eligibility.service';
import { ProductCatalogueService } from './application/product-catalogue.service';
import { SubscriptionImportService } from './application/subscription-import.service';
import { SubscriptionIngestionService } from './application/subscription-ingestion.service';
import { SubscriptionReadModel } from './application/subscription-read-model';
import { EligibilitySnapshotStore } from './infrastructure/eligibility-snapshot.store';
import { ProductModelStore } from './infrastructure/product-model.store';
import { SubscriptionRunsStore } from './infrastructure/subscription-runs.store';
import { SubscriptionQueries } from './infrastructure/subscription.queries';
import { SubscriptionStore } from './infrastructure/subscription.store';

/**
 * Product catalogue, subscriptions and eligibility (M7, ADRs 0016–0018).
 * Vendor-neutral: sources reach subscriptions only through
 * `SubscriptionIngestionService`; the evaluator itself is pure domain code.
 */
@Module({
  imports: [TenancyModule, IdentityModule],
  providers: [
    ProductModelStore,
    SubscriptionStore,
    SubscriptionQueries,
    SubscriptionRunsStore,
    ProductCatalogueService,
    SubscriptionIngestionService,
    SubscriptionImportService,
    SubscriptionReadModel,
    EligibilitySnapshotStore,
    EligibilityService,
  ],
  exports: [
    EligibilityService,
    ProductCatalogueService,
    SubscriptionIngestionService,
    SubscriptionImportService,
    SubscriptionReadModel,
  ],
})
export class ProductsModule {}
