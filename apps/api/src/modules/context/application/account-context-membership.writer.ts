import { Injectable } from '@nestjs/common';
import { GovernanceError, ModuleGate } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  AccountContextStore,
  type AccountContextRow,
} from '../infrastructure/account-context.store';
import {
  decideMemberAdd,
  decideMemberEnd,
  membershipEntityId,
  planMemberMove,
  type MemberRow,
} from './account-context.rules';
import {
  changeProvenance,
  requireAccountContext,
  type ContextProvenance,
} from './account-context.shared';
import { operatorProvenance, requireReason, requireUuid } from './account-structure.shared';

const ROLE = /^[a-z0-9_]{1,64}$/;
const PRODUCT_KEY = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

export interface OperatorMemberInput {
  readonly context: string;
  readonly person: string;
  readonly role: string;
  readonly reason: string;
}

export interface OperatorProductInput {
  readonly context: string;
  readonly product: string;
  readonly reason: string;
}

export type MemberOutcome =
  | 'added'
  | 'reactivated'
  | 'ended'
  | 'unchanged'
  | 'missing'
  | 'context_unknown'
  | 'context_merged'
  | 'context_retired'
  | 'person_unknown'
  | 'person_merged'
  | 'role_unknown';

export interface MemberWritten {
  readonly contextId: string;
  readonly personId?: string;
  readonly role?: string;
  readonly product?: string;
  readonly outcome: MemberOutcome | 'product_added' | 'product_unchanged';
  readonly changed: boolean;
}

/**
 * The single writer of `tenant_account_context_persons` and
 * `tenant_account_context_products` (M10E plan §4.2, §7). Persons are added
 * and ended, never deleted (Q10); re-adding an ended (context, person, role)
 * **reactivates** its row (decision recorded in `decideMemberAdd`). The role
 * must be one of the type's `member_roles`; an affiliation between the person
 * and the context's account is not required (Q9). Explicit products only when
 * the type sets `allow_products` (Q7); product-dimension memberships are
 * maintained by `AccountContextWriter`. Gate 0.5 + module (Q17); one audit
 * event per operator call (`account_context.member.set`, codes only). Locks:
 * the context's company then the person (sorted scopes), before the
 * not-merged checks (review M1).
 */
@Injectable()
export class AccountContextMembershipWriter {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: AccountContextStore,
    readonly audit: AuditTrail,
    private readonly moduleGate: ModuleGate,
  ) {}

  @AuditFailures('account_context.member.set', 'account_context')
  add(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorMemberInput,
  ): Promise<MemberWritten> {
    return this.operatorMember(actx, input, 'add');
  }

  @AuditFailures('account_context.member.set', 'account_context')
  end(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorMemberInput,
  ): Promise<MemberWritten> {
    return this.operatorMember(actx, input, 'end');
  }

  private async operatorMember(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorMemberInput,
    op: 'add' | 'end',
  ): Promise<MemberWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const contextId = requireUuid(input.context, '--context');
    const personId = requireUuid(input.person, '--person');
    if (!ROLE.test(input.role ?? '')) {
      throw new GovernanceError('validation_failed', '--role must be a role code');
    }
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountContext(tx, actx, this.store, this.moduleGate);
      const outcome = await this.setMemberWithin(tx, {
        op,
        contextId,
        personId,
        role: input.role,
        provenance: operatorProvenance(actx.actor, actx.correlationId, contextId),
      });
      if (!['added', 'reactivated', 'ended', 'unchanged'].includes(outcome)) {
        throw new GovernanceError('validation_failed', `Membership refused (${outcome})`);
      }
      const changed = outcome !== 'unchanged';
      await this.audit.record(tx, actx, {
        action: 'account_context.member.set',
        targetKind: 'account_context',
        targetRef: contextId,
        details: { reason, operation: op, person: personId, role: input.role, outcome, changed },
      });
      return { contextId, personId, role: input.role, outcome, changed };
    });
  }

  /**
   * One membership change inside the caller's transaction (operator commands;
   * phase 2b source persons via `account_context.person`). The caller holds
   * the gate (and, for sources, the authority decision).
   */
  async setMemberWithin(
    tx: TenantTransaction,
    input: {
      readonly op: 'add' | 'end';
      readonly contextId: string;
      readonly personId: string;
      readonly role: string;
      readonly provenance: ContextProvenance;
      readonly at?: Date;
    },
  ): Promise<MemberOutcome> {
    // Review M1: the account is locked and re-verified under the lock until stable.
    const ctx = await this.store.lockContextAccount(tx, input.contextId, [
      { kind: 'person', id: input.personId },
    ]);
    if (!ctx) return 'context_unknown';
    if (ctx === 'unstable' || ctx.recordState === 'merged') return 'context_merged';
    const person = await this.store.person(tx, input.personId);
    if (!person) return 'person_unknown';
    const existing = await this.store.member(tx, ctx.id, input.personId, input.role);
    const at = input.at ?? new Date();
    if (input.op === 'end') {
      const d = decideMemberEnd(existing);
      if (d !== 'end') return d;
      await this.writeMember(tx, existing!, 'ended', at, input.provenance);
      return 'ended';
    }
    if (person.recordState === 'merged') return 'person_merged';
    if (ctx.status === 'retired') return 'context_retired';
    const roles = await this.roles(tx, ctx);
    if (!roles.includes(input.role)) return 'role_unknown';
    const d = decideMemberAdd(existing);
    if (d === 'unchanged') return 'unchanged';
    const row: MemberRow = {
      contextId: ctx.id,
      personId: input.personId,
      roleCode: input.role,
      status: 'active',
      startedAt: at,
      endedAt: null,
    };
    if (d === 'insert') await this.insertMember(tx, row, input.provenance);
    else await this.writeMember(tx, existing!, 'active', at, input.provenance);
    return d === 'insert' ? 'added' : 'reactivated';
  }

  private async roles(tx: TenantTransaction, ctx: AccountContextRow): Promise<readonly string[]> {
    return (
      (await this.store.contextTypes(tx)).byId.get(ctx.contextTypeId)?.definition.member_roles ?? []
    );
  }

  private async insertMember(
    tx: TenantTransaction,
    row: MemberRow,
    provenance: ContextProvenance,
  ): Promise<void> {
    const changeId = await this.store.insertChange(tx, {
      ...changeProvenance(provenance),
      entityKind: 'account_context_person',
      entityId: membershipEntityId(row.contextId, row.personId, row.roleCode),
      changeType: 'created',
      changedFields: ['status', 'roleCode', 'startedAt', ...(row.endedAt ? ['endedAt'] : [])],
    });
    await this.store.insertMember(tx, { ...row, lastChangeId: changeId });
  }

  /** Ends or reactivates a row (reactivation: new `started_at`, `ended_at` cleared). */
  private async writeMember(
    tx: TenantTransaction,
    row: MemberRow,
    status: 'active' | 'ended',
    at: Date,
    provenance: ContextProvenance,
  ): Promise<void> {
    const changeId = await this.store.insertChange(tx, {
      ...changeProvenance(provenance),
      entityKind: 'account_context_person',
      entityId: membershipEntityId(row.contextId, row.personId, row.roleCode),
      changeType: 'state_changed',
      changedFields:
        status === 'ended' ? ['status', 'endedAt'] : ['status', 'startedAt', 'endedAt'],
    });
    await this.store.updateMember(
      tx,
      { contextId: row.contextId, personId: row.personId, roleCode: row.roleCode },
      status === 'ended'
        ? { status, endedAt: at < row.startedAt ? row.startedAt : at, lastChangeId: changeId }
        : { status, startedAt: at, endedAt: null, lastChangeId: changeId },
    );
  }

  /**
   * Applies a membership move plan (person merge; company-merge collision):
   * insert on the receiving side, reactivate, end on the giving side. Used by
   * the merge participant inside the merge transaction.
   */
  async applyMove(
    tx: TenantTransaction,
    from: readonly MemberRow[],
    to: readonly MemberRow[],
    retarget: (row: MemberRow) => MemberRow,
    provenance: ContextProvenance,
    at: Date,
  ): Promise<number> {
    const plan = planMemberMove(from, to, retarget);
    for (const r of plan.insert) await this.insertMember(tx, r, provenance);
    for (const r of plan.reactivate) await this.writeMember(tx, r, 'active', at, provenance);
    for (const r of plan.end) await this.writeMember(tx, r, 'ended', at, provenance);
    return plan.insert.length + plan.reactivate.length + plan.end.length;
  }

  // --- Explicit product memberships (Q7) -------------------------------------------

  @AuditFailures('account_context.member.set', 'account_context')
  async addProduct(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorProductInput,
  ): Promise<MemberWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const contextId = requireUuid(input.context, '--context');
    if (!PRODUCT_KEY.test(input.product ?? '')) {
      throw new GovernanceError('validation_failed', '--product must be a product key');
    }
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountContext(tx, actx, this.store, this.moduleGate);
      // Review M1: the account is locked and re-verified under the lock until stable.
      const ctx = await this.store.lockContextAccount(tx, contextId);
      if (!ctx) throw new GovernanceError('validation_failed', 'The context does not exist');
      if (ctx === 'unstable' || ctx.recordState === 'merged' || ctx.status === 'retired') {
        throw new GovernanceError('validation_failed', 'The context is merged or retired');
      }
      const type = (await this.store.contextTypes(tx)).byId.get(ctx.contextTypeId);
      if (!type?.definition.allow_products) {
        throw new GovernanceError(
          'validation_failed',
          'The context type does not allow explicit products',
        );
      }
      // Product key retirement: kept memberships stay; new ones are refused (plan §7).
      const active = (await this.store.products(tx, [input.product])).get(input.product);
      if (active !== true) {
        throw new GovernanceError('validation_failed', 'The product must exist and be active');
      }
      const added = await this.store.addProducts(tx, contextId, [
        { productKey: input.product, origin: 'explicit' },
      ]);
      if (added > 0) {
        const changeId = await this.store.insertChange(tx, {
          ...operatorProvenance(actx.actor, actx.correlationId, contextId),
          entityKind: 'account_context',
          entityId: contextId,
          changeType: 'relationship_changed',
          changedFields: ['products'],
        });
        await this.store.updateContext(tx, contextId, { lastChangeId: changeId });
      }
      await this.audit.record(tx, actx, {
        action: 'account_context.member.set',
        targetKind: 'account_context',
        targetRef: contextId,
        details: { reason, operation: 'add_product', product: input.product, changed: added > 0 },
      });
      return {
        contextId,
        product: input.product,
        outcome: added > 0 ? 'product_added' : 'product_unchanged',
        changed: added > 0,
      };
    });
  }
}
