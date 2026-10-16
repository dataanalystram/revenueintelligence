import { Injectable } from '@nestjs/common';
import type { SecurityActor } from '../../domain';
import type { TenantTransaction } from '../../tenancy';
import { CommercialStore } from '../infrastructure/commercial.store';
import { changeProvenance, type CommercialProvenance } from './commercial.shared';

/**
 * The merge as the context module's company merge port describes it
 * (structurally identical to `CompanyMerge`; the commercial module does not
 * import context, which wires this participant — the M10D extension pattern).
 */
export interface CommercialEntityMerge {
  readonly loserId: string;
  readonly survivorId: string;
  readonly provenance: {
    readonly source: { readonly system: string; readonly objectType: string; readonly id: string };
    readonly cause: string;
    readonly receiptDeliveryKey?: string;
    readonly checkpointId?: string;
    readonly sourceUpdatedAt?: Date;
    readonly adapter: string;
    readonly adapterVersion: string;
    readonly correlationId: string;
    readonly actor?: SecurityActor;
  };
}

/**
 * `CommercialMergeParticipant` (M10F plan §8; ADR 0032), inside the company
 * merge's transaction, wired by the context module **after** the account
 * context participant (so a contract whose context was merged away in a
 * collision follows it to the survivor context). Contracts and entitlements
 * of the loser are re-pointed to the survivor (change record each); lines are
 * re-pointed by the subscription participant in the same transaction (the
 * deferred same-account guards make the order irrelevant); contract links
 * stay valid (both ends belong to the one account, so both move).
 *
 * Lock order (Q16): the merge already holds both accounts' `company-canonical`
 * locks (re-taken here, sorted, re-entrant) → `contract-graph` → contract rows
 * ascending → entitlement rows ascending. Every commercial writer takes the
 * account lock first, so no writer can hold a contract or line row of these
 * accounts while waiting for the merge.
 *
 * Runs whatever the gate says (a tenant rolled back below 0.6 or with the
 * module disabled still has its stored commercial rows kept consistent; the
 * merge is never blocked). No person references (plan §8).
 */
@Injectable()
export class CommercialMergeParticipant {
  constructor(private readonly store: CommercialStore) {}

  async onCompanyMerged(tx: TenantTransaction, merge: CommercialEntityMerge): Promise<void> {
    await this.store.lockCompanies(tx, [merge.loserId, merge.survivorId]);
    const provenance = changeProvenance(merge.provenance as CommercialProvenance);
    const contracts = await this.store.contractsOfCompanies(tx, [merge.loserId]);
    if (contracts.length > 0) {
      await this.store.lockContractGraph(tx);
      await this.store.lockRows(
        tx,
        'tenant_contracts',
        contracts.map((c) => c.id),
      );
      for (const c of contracts) {
        const contextId = await this.survivingContext(tx, c.contextId);
        const fields = ['companyId', ...(contextId !== c.contextId ? ['contextId'] : [])];
        const changeId = await this.store.insertChange(tx, {
          ...provenance,
          entityKind: 'contract',
          entityId: c.id,
          changeType: 'relationship_changed',
          changedFields: fields,
        });
        await this.store.updateContract(tx, c.id, {
          companyId: merge.survivorId,
          ...(contextId !== c.contextId ? { contextId } : {}),
          lastChangeId: changeId,
        });
      }
    }
    const entitlements = await this.store.entitlementsOfCompanies(tx, [merge.loserId]);
    if (entitlements.length === 0) return;
    await this.store.lockRows(
      tx,
      'tenant_entitlements',
      entitlements.map((e) => e.id),
    );
    for (const e of entitlements) {
      const changeId = await this.store.insertChange(tx, {
        ...provenance,
        entityKind: 'entitlement',
        entityId: e.id,
        changeType: 'relationship_changed',
        changedFields: ['companyId'],
      });
      await this.store.updateEntitlement(tx, e.id, {
        companyId: merge.survivorId,
        lastChangeId: changeId,
      });
    }
  }

  /** A context merged away in a collision (M10E) is followed to its survivor. */
  private async survivingContext(
    tx: TenantTransaction,
    contextId: string | null,
  ): Promise<string | null> {
    let id = contextId;
    for (let hops = 0; id && hops < 20; hops += 1) {
      const ctx = await this.store.contextCompany(tx, id);
      if (!ctx || ctx.recordState !== 'merged' || !ctx.mergedIntoId) return id;
      id = ctx.mergedIntoId;
    }
    return id;
  }
}
