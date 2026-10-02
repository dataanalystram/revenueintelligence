import { Injectable, Logger } from '@nestjs/common';
import type { CompanyMerge, CompanyMergeParticipant } from '../../context';
import type { TenantTransaction } from '../../tenancy';
import { SubscriptionStore } from '../infrastructure/subscription.store';

/**
 * Moves a merged-away company's subscription lines to the survivor inside the
 * M6 merge transaction (ADR 0017 §8). The same rows are repointed (ids,
 * sources and history kept), each with one `merged` provenance row; nothing is
 * created or deleted. Ownership is derived, so nothing else needs recomputing.
 * Replays are idempotent: a second call finds no lines left on the loser.
 */
@Injectable()
export class SubscriptionMergeParticipant implements CompanyMergeParticipant {
  private readonly logger = new Logger(SubscriptionMergeParticipant.name);

  constructor(private readonly store: SubscriptionStore) {}

  async onCompanyMerged(tx: TenantTransaction, merge: CompanyMerge): Promise<void> {
    const moved = await this.store.repointCompany(tx, merge);
    if (moved > 0) this.logger.log(`subscriptions_repointed count=${moved}`);
  }
}
