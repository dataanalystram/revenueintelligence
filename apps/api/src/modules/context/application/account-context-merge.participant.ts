import { Injectable } from '@nestjs/common';
import type { TenantTransaction } from '../../tenancy';
import { AccountContextStore } from '../infrastructure/account-context.store';
import type {
  CompanyMerge,
  CompanyMergeParticipant,
  PersonMerge,
  PersonMergeParticipant,
} from '../merge-participants';
import { AccountContextMembershipWriter } from './account-context-membership.writer';
import { planCompanyMerge } from './account-context.rules';
import { changeProvenance, collisionIssue, type ContextProvenance } from './account-context.shared';

/**
 * AccountContext merge participation (M10E plan §7, Q15), inside the merge's
 * transaction (the merge already holds the loser's and the survivor's
 * canonical locks; this participant re-takes them in sorted order, review
 * M1, so a concurrent context write is either seen here or refused as merged
 * afterwards).
 *
 * - Company merge: the loser's contexts are re-pointed to the survivor; a
 *   natural-key collision (same type and dimensions on both accounts) marks
 *   the loser context `merged` into the survivor's, moves its members
 *   (insert + end, identity columns are immutable), its products and its
 *   lines, and records `account_context_merge_collision`.
 * - Person merge: memberships move to the survivor; a duplicate role is ended
 *   on the loser.
 *
 * Runs whatever the gate says (a tenant rolled back below 0.5 or with the
 * module disabled still has its stored contexts kept consistent; the merge is
 * never blocked, M10D pattern). The line ↔ context same-account guard is a
 * deferred constraint trigger, so the order relative to the subscription
 * participant does not matter.
 */
@Injectable()
export class AccountContextMergeParticipant
  implements CompanyMergeParticipant, PersonMergeParticipant
{
  constructor(
    private readonly store: AccountContextStore,
    private readonly members: AccountContextMembershipWriter,
  ) {}

  async onCompanyMerged(tx: TenantTransaction, merge: CompanyMerge): Promise<void> {
    await this.store.lockEntities(tx, [
      { kind: 'company', id: merge.loserId },
      { kind: 'company', id: merge.survivorId },
    ]);
    const all = await this.store.contextsForCompanies(tx, [merge.loserId, merge.survivorId]);
    const loser = all.filter((c) => c.companyId === merge.loserId);
    if (loser.length === 0) return;
    const survivor = all.filter((c) => c.companyId === merge.survivorId);
    const plan = planCompanyMerge(loser, survivor);
    const provenance = merge.provenance as ContextProvenance;
    const at = new Date();

    for (const id of plan.repoint) {
      const changeId = await this.store.insertChange(tx, {
        ...changeProvenance(provenance),
        entityKind: 'account_context',
        entityId: id,
        changeType: 'relationship_changed',
        changedFields: ['companyId'],
      });
      await this.store.updateContext(tx, id, {
        companyId: merge.survivorId,
        lastChangeId: changeId,
      });
    }

    for (const { loserId, survivorId } of plan.collisions) {
      // Members: insert on the survivor context, end on the loser context.
      const rows = await this.store.membersOfContexts(tx, [loserId, survivorId]);
      await this.members.applyMove(
        tx,
        rows.filter((r) => r.contextId === loserId),
        rows.filter((r) => r.contextId === survivorId),
        (r) => ({ ...r, contextId: survivorId }),
        provenance,
        at,
      );
      // Products: the survivor gains the loser's (origin kept); the loser's rows stay.
      const products = await this.store.productsOfContexts(tx, [loserId]);
      await this.store.addProducts(
        tx,
        survivorId,
        products.map((p) => ({ productKey: p.productKey, origin: p.origin })),
      );
      // Lines: re-pointed to the survivor context (change record + value history each).
      for (const line of await this.store.linesOfContexts(tx, [loserId])) {
        const changeId = await this.store.insertChange(tx, {
          ...changeProvenance(provenance),
          entityKind: 'subscription',
          entityId: line.id,
          changeType: 'relationship_changed',
          changedFields: ['contextId'],
        });
        await this.store.setLineContext(tx, line.id, survivorId);
        await this.store.valueHistory(tx, {
          entityKind: 'subscription',
          entityId: line.id,
          changeId,
          effectiveAt: at,
          ...(provenance.actor ? { actor: provenance.actor } : {}),
          changes: [{ field: 'context_id', oldValue: loserId, newValue: survivorId }],
        });
      }
      const changeId = await this.store.insertChange(tx, {
        ...changeProvenance(provenance),
        entityKind: 'account_context',
        entityId: loserId,
        changeType: 'merged',
        changedFields: ['recordState', 'mergedIntoId'],
      });
      await this.store.updateContext(tx, loserId, {
        recordState: 'merged',
        mergedIntoId: survivorId,
        lastChangeId: changeId,
      });
      await this.store.recordIssue(tx, {
        kind: 'account_context_merge_collision',
        identity: collisionIssue(tx.tenantId, loserId),
        canonicalIds: [loserId, survivorId, merge.loserId, merge.survivorId],
        externalRefs: [],
      });
    }
  }

  async onPersonMerged(tx: TenantTransaction, merge: PersonMerge): Promise<void> {
    await this.store.lockEntities(tx, [
      { kind: 'person', id: merge.loserId },
      { kind: 'person', id: merge.survivorId },
    ]);
    const from = await this.store.membersOfPerson(tx, merge.loserId);
    if (from.length === 0) return;
    const to = await this.store.membersOfPerson(tx, merge.survivorId);
    await this.members.applyMove(
      tx,
      from,
      to,
      (r) => ({ ...r, personId: merge.survivorId }),
      merge.provenance,
      new Date(),
    );
  }
}
