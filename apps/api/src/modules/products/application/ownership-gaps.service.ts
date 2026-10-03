import { Injectable } from '@nestjs/common';
import { TenantDatabase, type TenantContext, type TenantTransaction } from '../../tenancy';
import { OwnershipGapStore, type OwnershipGap } from '../infrastructure/ownership-gap.store';

export type { OwnershipGap } from '../infrastructure/ownership-gap.store';

/**
 * Per-account ownership gaps (ADR 0020 §15). A source's completed full run
 * replaces its connection's gaps in the run's completing transaction; the
 * eligibility service reads them; account merges move them.
 */
@Injectable()
export class OwnershipGapService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: OwnershipGapStore,
  ) {}

  /** Inside the caller's transaction (the run completion), never on its own. */
  replaceWithin(
    tx: TenantTransaction,
    connectionId: string,
    gaps: readonly OwnershipGap[],
    checkpointId: string,
  ): Promise<number> {
    return this.store.replace(tx, connectionId, gaps, checkpointId);
  }

  /** Inside the caller's transaction: an incremental run adds, never removes. */
  addWithin(
    tx: TenantTransaction,
    connectionId: string,
    gaps: readonly OwnershipGap[],
    checkpointId: string,
  ): Promise<number> {
    return this.store.add(tx, connectionId, gaps, checkpointId);
  }

  list(ctx: TenantContext, connectionId?: string) {
    return this.db.transaction(ctx, (tx) => this.store.list(tx, connectionId));
  }
}
