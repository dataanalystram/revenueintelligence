import { Module } from '@nestjs/common';
import { SubscriptionMergeParticipant } from './application/subscription-merge.participant';
import { OwnershipGapStore } from './infrastructure/ownership-gap.store';
import { SubscriptionStore } from './infrastructure/subscription.store';

/**
 * The products module's account-merge participant, imported by
 * `ContextModule.register({ merge })` in every composition that can merge
 * companies (worker and context CLI). Kept separate from `ProductsModule` so
 * the context module needs nothing else from products.
 */
@Module({
  providers: [SubscriptionStore, OwnershipGapStore, SubscriptionMergeParticipant],
  exports: [SubscriptionMergeParticipant],
})
export class SubscriptionMergeModule {}
