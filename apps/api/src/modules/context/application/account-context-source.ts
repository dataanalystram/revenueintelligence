import { Injectable } from '@nestjs/common';
import type { AccountContextStatus } from '../../domain';
import {
  assertAuthorized,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import { AccountContextStore } from '../infrastructure/account-context.store';
import { AccountContextMembershipWriter } from './account-context-membership.writer';
import type { ContextProvenance } from './account-context.shared';
import {
  AccountContextWriter,
  type AccountContextObserveOutcome,
  type LineAssignOutcome,
} from './account-context.writer';

/** A source triple (generic reference coordinates). */
export interface ContextSourceRef {
  readonly system: string;
  readonly objectType: string;
  readonly id: string;
}

/** One mapped `account_context` record, references unresolved (M10E plan §5.1). */
export interface ContextSourceRecord {
  readonly typeKey: string;
  readonly ref: ContextSourceRef;
  readonly accountRef: ContextSourceRef;
  readonly presence: 'present' | 'absent';
  readonly dimensions: Readonly<Record<string, unknown>>;
  readonly name?: string;
  readonly status?: AccountContextStatus;
  readonly ownerRef?: string | null;
  readonly renewalDate?: string | null;
  readonly persons: readonly { readonly ref: ContextSourceRef; readonly role: string }[];
  readonly observedAt: Date;
  readonly provenance: ContextProvenance;
}

export interface ContextSourceOutcome {
  readonly context: AccountContextObserveOutcome;
  /** Membership outcomes by code (`added`, `reactivated`, `unchanged`, `person_unresolved`, …). */
  readonly members: Readonly<Record<string, number>>;
}

const refString = (r: ContextSourceRef) => `${r.system}:${r.objectType}:${r.id}`;
const unresolvedIssue = (tenantId: string, scope: string, key: string) =>
  `${tenantId}|account-context-ref|${scope}|${key}`;

/**
 * The source-sync entry of AccountContext (M10E phase 2b, plan §5). The
 * sources module calls it only when the run's connection holds the
 * `account_context` authority fact; this service resolves the record's
 * source references inside one transaction and hands the canonical ids to
 * `AccountContextWriter` / `AccountContextMembershipWriter` (the single
 * writers). Gate closed (canonical < 0.5 or module disabled) → the writer's
 * outcome, nothing written. Absence never clears: a deleted record is
 * recorded on its reference only, a person no longer named is not ended, a
 * line without a reference keeps its context.
 */
@Injectable()
export class AccountContextSourceSync {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: AccountContextStore,
    private readonly writer: AccountContextWriter,
    private readonly members: AccountContextMembershipWriter,
  ) {}

  async observeRecord(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: ContextSourceRecord,
  ): Promise<ContextSourceOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, async (tx) => {
      const gate = await this.store.gate(tx);
      if (gate !== 'ok') return { context: { status: gate }, members: {} };
      const companyId = await this.store.canonicalForRef(tx, 'company', input.accountRef);
      const identity = unresolvedIssue(tx.tenantId, 'account', refString(input.ref));
      if (!companyId) {
        await this.store.recordIssue(tx, {
          kind: 'account_context_reference_unresolved',
          identity,
          canonicalIds: [],
          externalRefs: [refString(input.ref), refString(input.accountRef)],
        });
        return { context: { status: 'rejected', reason: 'account_unknown' }, members: {} };
      }
      await this.store.resolveIssue(tx, 'account_context_reference_unresolved', identity);
      const context = await this.writer.observe(actx, tx, {
        companyId,
        typeKey: input.typeKey,
        ref: input.ref,
        presence: input.presence,
        dimensions: input.dimensions,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.ownerRef !== undefined ? { ownerRef: input.ownerRef } : {}),
        ...(input.renewalDate !== undefined ? { renewalDate: input.renewalDate } : {}),
        observedAt: input.observedAt,
        provenance: input.provenance,
      });
      const members: Record<string, number> = {};
      if (input.presence === 'present' && context.contextId && context.status !== 'rejected') {
        for (const p of input.persons) {
          const outcome = await this.member(tx, context.contextId, p, input.provenance);
          members[outcome] = (members[outcome] ?? 0) + 1;
        }
      }
      return { context, members };
    });
  }

  private async member(
    tx: TenantTransaction,
    contextId: string,
    p: { readonly ref: ContextSourceRef; readonly role: string },
    provenance: ContextProvenance,
  ): Promise<string> {
    const personId = await this.store.canonicalForRef(tx, 'person', p.ref);
    if (!personId) return 'person_unresolved';
    return this.members.setMemberWithin(tx, {
      op: 'add',
      contextId,
      personId,
      role: p.role,
      provenance,
    });
  }

  /**
   * A line's `subscription.contextRef` (plan §5.2): the reference resolves to
   * a context of this tenant (following merges), else an open
   * `account_context_reference_unresolved` issue and the line keeps its
   * context. Gate closed → `skipped` (counted `context_assignment_skipped`).
   */
  async assignLine(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: {
      readonly lineId: string;
      readonly contextRef: ContextSourceRef;
      readonly provenance: ContextProvenance;
    },
  ): Promise<LineAssignOutcome | 'unresolved'> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, async (tx) => {
      if ((await this.store.gate(tx)) !== 'ok') return 'skipped' as const;
      const identity = unresolvedIssue(tx.tenantId, 'line', input.lineId);
      const contextId = await this.store.contextForRef(tx, input.contextRef);
      if (!contextId) {
        await this.store.recordIssue(tx, {
          kind: 'account_context_reference_unresolved',
          identity,
          canonicalIds: [input.lineId],
          externalRefs: [refString(input.contextRef)],
        });
        return 'unresolved' as const;
      }
      await this.store.resolveIssue(tx, 'account_context_reference_unresolved', identity);
      return this.writer.assignLineFromSource(actx, tx, {
        lineId: input.lineId,
        contextId,
        provenance: input.provenance,
        issueRefs: [refString(input.contextRef)],
      });
    });
  }
}
