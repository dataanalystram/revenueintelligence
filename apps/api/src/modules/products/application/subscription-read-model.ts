import { Injectable } from '@nestjs/common';
import type { Subscription } from '../../domain';
import { TenantDatabase, type TenantContext } from '../../tenancy';
import {
  SubscriptionRunsStore,
  type SubscriptionRun,
} from '../infrastructure/subscription-runs.store';
import { SubscriptionQueries } from '../infrastructure/subscription.queries';
import { toSubscription } from '../infrastructure/subscription.rows';

export interface OwnershipCoverage {
  /** `known` once a full subscription load has completed for the tenant (ADR 0017 §5). */
  readonly coverage: 'known' | 'unknown';
  readonly knownAsOf?: Date;
  /** Provisional: tenant-level until the Subscription Source Discovery gate. */
  readonly scope: 'tenant';
}

/** Read side of subscriptions (services for the CLI and the future UI). */
@Injectable()
export class SubscriptionReadModel {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: SubscriptionQueries,
    private readonly runs: SubscriptionRunsStore,
  ) {}

  /** Every line of one company, tombstones included, after following merge lineage. */
  async accountSubscriptions(
    ctx: TenantContext,
    companyId: string,
  ): Promise<{ requestedCompanyId: string; companyId: string; subscriptions: Subscription[] }> {
    return this.db.transaction(ctx, async (tx) => {
      const canonical = await this.store.canonicalCompany(tx, companyId);
      const lines = await this.store.linesForCompany(tx, canonical);
      return {
        requestedCompanyId: companyId,
        companyId: canonical,
        subscriptions: lines.map(toSubscription),
      };
    });
  }

  /** A platform company id or `system:objectType:id`, resolved to the canonical company. */
  async resolveCompany(ctx: TenantContext, ref: string): Promise<string | undefined> {
    return this.db.transaction(ctx, (tx) => this.store.resolveCompany(tx, ref));
  }

  async coverage(ctx: TenantContext): Promise<OwnershipCoverage> {
    return this.db.transaction(ctx, async (tx) => {
      const knownAsOf = await this.runs.coverageKnownAsOf(tx);
      return knownAsOf
        ? { coverage: 'known', knownAsOf, scope: 'tenant' }
        : { coverage: 'unknown', scope: 'tenant' };
    });
  }

  async loadRuns(ctx: TenantContext, limit = 20): Promise<SubscriptionRun[]> {
    return this.db.transaction(ctx, (tx) => this.runs.list(tx, limit));
  }

  async counts(ctx: TenantContext): Promise<Record<string, number>> {
    return this.db.transaction(ctx, (tx) => this.store.counts(tx));
  }

  /** Invariant: no non-deleted line on a merged company (must be empty). */
  async orphanedOnMergedCompanies(
    ctx: TenantContext,
  ): Promise<{ id: string; companyId: string }[]> {
    return this.db.transaction(ctx, (tx) => this.store.orphanedOnMergedCompanies(tx));
  }
}
