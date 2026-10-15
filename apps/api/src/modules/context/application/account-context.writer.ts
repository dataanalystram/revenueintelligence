import { Injectable } from '@nestjs/common';
import { ACCOUNT_CONTEXT_ASSIGNABLE_STATUSES, type AccountContextStatus } from '../../domain';
import { GovernanceError, ModuleGate, SourceReferenceService } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  TenantDatabase,
  WriteAuthorizer,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  AccountContextStore,
  type AccountContextRow,
  type ContextTypeEntry,
} from '../infrastructure/account-context.store';
import {
  decideOperatorAttributes,
  decideSourceAttributes,
  HUMAN_OVERRIDE_RELEASE_FIELD,
  humanHeldAttributes,
  nameValid,
  ownerRefValid,
  validateDimensions,
  type AttributeDecision,
  type ContextAttribute,
  type ContextAttributes,
  type DimensionValidation,
} from './account-context.rules';
import {
  changeProvenance,
  mismatchIssue,
  overrideIssue,
  renewalDateValid,
  requireAccountContext,
  type ContextProvenance,
} from './account-context.shared';
import { operatorProvenance, requireReason, requireUuid } from './account-structure.shared';

/** One source observation of a context (built by the mapping engine, phase 2b). */
export interface AccountContextObservation {
  /** The canonical account, already resolved from the account reference by the caller. */
  readonly companyId: string;
  readonly typeKey: string;
  /** The context's source coordinates (generic source reference kind `account_context`). */
  readonly ref: { readonly system: string; readonly objectType: string; readonly id: string };
  readonly presence: 'present' | 'absent';
  readonly dimensions: Readonly<Record<string, unknown>>;
  /** undefined = not mapped (unchanged). */
  readonly name?: string;
  readonly status?: AccountContextStatus;
  readonly ownerRef?: string | null;
  /** `YYYY-MM-DD` or null. */
  readonly renewalDate?: string | null;
  readonly observedAt: Date;
  readonly provenance: ContextProvenance;
}

export type ContextRejection =
  | 'type_unknown'
  | 'type_retired'
  | 'account_unknown'
  | 'account_merged'
  | 'account_changed'
  | 'dimensions_immutable'
  | 'name_required'
  | 'name_invalid'
  | 'owner_ref_invalid'
  | 'renewal_date_invalid'
  | Extract<DimensionValidation, { ok: false }>['code'];

export interface AccountContextObserveOutcome {
  readonly status:
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'rejected'
    | 'canonical_version_too_low'
    | 'module_disabled';
  readonly reason?: ContextRejection;
  readonly contextId?: string;
  /** Held attributes whose source value differed (Q14). */
  readonly humanOverride?: number;
}

export interface OperatorContextWrite {
  /** Update an existing context by id … */
  readonly context?: string;
  /** … or create-or-update by natural key (account + type + dimensions). */
  readonly account?: string;
  readonly type?: string;
  readonly dimensions?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly status?: 'active' | 'inactive';
  readonly ownerRef?: string | null;
  readonly renewalDate?: string | null;
  readonly reason: string;
}

export interface OperatorContextRef {
  readonly context: string;
  readonly reason: string;
}

export interface AccountContextWritten {
  readonly contextId: string;
  readonly type: string;
  readonly status: AccountContextStatus;
  readonly created: boolean;
  readonly changed: boolean;
}

export interface OperatorLineAssign {
  readonly line: string;
  /** null clears the line's context. */
  readonly context: string | null;
  readonly reason: string;
}

export type LineAssignOutcome =
  | 'assigned'
  | 'unchanged'
  | 'skipped'
  | 'line_unknown'
  | 'context_unknown'
  | 'not_assignable'
  | 'company_mismatch';

export interface LineAssignment {
  readonly lineId: string;
  readonly contextId: string | null;
  readonly provenance: ContextProvenance;
  /** Source references named on a mismatch issue (`system:objectType:id`). */
  readonly issueRefs?: readonly string[];
}

const HISTORY_FIELD: Partial<Record<ContextAttribute, string>> = {
  ownerRef: 'owner_ref',
  status: 'status',
};

function attributesOf(row: AccountContextRow): ContextAttributes {
  return {
    name: row.name,
    status: row.status,
    ownerRef: row.ownerRef,
    renewalDate: row.renewalDate,
  };
}

const refString = (r: { system: string; objectType: string; id: string }) =>
  `${r.system}:${r.objectType}:${r.id}`;

/**
 * The single writer of `tenant_account_contexts` and of the line's
 * `context_id` (M10E plan §4.1, §4.3, §4.4; ADR 0031). Every write is gated
 * on adopted ≥ 0.5 **and** module `account_context` enabled (Q17). Source
 * writes (`canonical.source_sync`; the authority fact `account_context` is
 * checked by the mapping engine, phase 2b) resolve by source reference, else
 * by natural key (company, type, dimension hash); operator writes
 * (`canonical.human_entry`) write one audit event each (keys and codes only)
 * and hold the attributes they set until `release` (Q14). Each accepted write
 * writes one change record and value history on `owner_ref` / `status` /
 * `subscription.context_id` in the same transaction. Locks: the context's
 * company (and the line's) before any not-merged check (review M1), in
 * sorted order.
 */
@Injectable()
export class AccountContextWriter {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: AccountContextStore,
    private readonly references: SourceReferenceService,
    readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
    private readonly moduleGate: ModuleGate,
  ) {}

  // --- Source (plan §4.1, §4.4) ---------------------------------------------------

  observeSource(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: AccountContextObservation,
  ): Promise<AccountContextObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, (tx) => this.observe(actx, tx, input));
  }

  async observe(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: AccountContextObservation,
  ): Promise<AccountContextObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('account context tenant does not match the transaction tenant');
    }
    const gate = await this.store.gate(tx);
    if (gate !== 'ok') return { status: gate };
    const reject = (reason: ContextRejection): AccountContextObserveOutcome => ({
      status: 'rejected',
      reason,
    });

    const type = (await this.store.contextTypes(tx)).byKey.get(input.typeKey);
    if (!type) return reject('type_unknown');
    // Lock the account before the not-merged check (review M1).
    await this.store.lockEntities(tx, [{ kind: 'company', id: input.companyId }]);
    const company = await this.store.company(tx, input.companyId);
    if (!company) return reject('account_unknown');
    if (company.recordState === 'merged') return reject('account_merged');

    const byRef = await this.store.contextForRef(tx, input.ref);
    if (input.presence === 'absent') {
      // A source deletion is recorded on the reference only: the context stays (plan §4.1).
      if (byRef) await this.observeReference(actx, tx, input, byRef);
      return { status: 'unchanged', ...(byRef ? { contextId: byRef } : {}) };
    }
    const dims = await this.validate(tx, type, input.dimensions);
    if (!dims.ok) return reject(dims.code);
    const attrRefusal = attributeRefusal(input);
    if (attrRefusal) return reject(attrRefusal);

    let ctx = byRef ? await this.store.context(tx, byRef) : undefined;
    if (ctx) {
      if (ctx.companyId !== input.companyId) return reject('account_changed');
      if (ctx.contextTypeId !== type.id || ctx.naturalKeyHash !== dims.naturalKeyHash) {
        return reject('dimensions_immutable');
      }
    } else {
      ctx = await this.store.contextByNaturalKey(tx, input.companyId, type.id, dims.naturalKeyHash);
    }
    // Review m1 (ADR 0031 §5): a reference still bound to a context merged away
    // in a collision keeps its reference only. It does not drive the survivor's
    // attributes or products (the survivor's own record does), so two source
    // records never alternate their values on one context.
    if (byRef && ctx && (await this.store.contextRefBound(tx, input.ref)) !== byRef) {
      await this.observeReference(actx, tx, input, byRef);
      return { status: 'unchanged', contextId: byRef };
    }

    if (!ctx) {
      if (type.status !== 'active') return reject('type_retired');
      if (input.name === undefined) return reject('name_required');
      const id = await this.create(tx, type, input.companyId, dims, {
        name: input.name.trim(),
        status: input.status ?? 'active',
        ownerRef: input.ownerRef ?? null,
        renewalDate: input.renewalDate ?? null,
        provenance: input.provenance,
        effectiveAt: input.observedAt,
      });
      await this.observeReference(actx, tx, input, id);
      return { status: 'created', contextId: id };
    }

    const held = humanHeldAttributes(await this.store.humanChanges(tx, ctx.id));
    const decision = decideSourceAttributes(
      attributesOf(ctx),
      {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.ownerRef !== undefined ? { ownerRef: input.ownerRef } : {}),
        ...(input.renewalDate !== undefined ? { renewalDate: input.renewalDate } : {}),
      },
      held,
    );
    const identity = overrideIssue(tx.tenantId, ctx.id);
    if (decision.disagreements.length > 0) {
      await this.store.recordIssue(tx, {
        kind: 'account_context_human_override_disagrees',
        identity,
        canonicalIds: [ctx.id],
        externalRefs: [refString(input.ref)],
      });
    } else {
      await this.store.resolveIssue(tx, 'account_context_human_override_disagrees', identity);
    }
    const changed = await this.applyAttributes(
      tx,
      ctx,
      decision,
      input.provenance,
      input.observedAt,
    );
    await this.store.addProducts(
      tx,
      ctx.id,
      dims.productKeys.map((productKey) => ({ productKey, origin: 'dimension' })),
    );
    await this.observeReference(actx, tx, input, ctx.id);
    return {
      status: changed ? 'updated' : 'unchanged',
      contextId: ctx.id,
      ...(decision.disagreements.length ? { humanOverride: decision.disagreements.length } : {}),
    };
  }

  private async observeReference(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: AccountContextObservation,
    contextId: string,
  ): Promise<void> {
    // A reference bound to a context merged into `contextId` stays bound to the merged-away
    // context (lineage followed on read): re-observing it names the bound id, never re-points it.
    const bound = await this.store.contextRefBound(tx, input.ref);
    const entityId =
      bound && bound !== contextId && (await this.store.contextForRef(tx, input.ref)) === contextId
        ? bound
        : contextId;
    await this.references.observe(actx, tx, {
      system: input.ref.system,
      objectType: input.ref.objectType,
      externalId: input.ref.id,
      entityKind: 'account_context',
      entityId,
      presence: input.presence,
      observedAt: input.observedAt,
      ...(input.provenance.sourceUpdatedAt
        ? { sourceUpdatedAt: input.provenance.sourceUpdatedAt }
        : {}),
      meta: {
        cause: input.provenance.cause as never,
        adapter: input.provenance.adapter,
        adapterVersion: input.provenance.adapterVersion,
        connectionId: input.provenance.connectionId ?? null,
        mappingVersion: input.provenance.mappingVersion ?? null,
        ...(input.provenance.checkpointId ? { checkpointId: input.provenance.checkpointId } : {}),
      },
    });
  }

  private async validate(
    tx: TenantTransaction,
    type: ContextTypeEntry,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<DimensionValidation> {
    const productKeys = type.definition.dimensions
      .filter((d) => d.type === 'product_key')
      .map((d) => raw[d.key])
      .filter((v): v is string => typeof v === 'string');
    const extensionFields = type.definition.dimensions
      .map((d) => d.extension_field)
      .filter((f): f is string => !!f);
    return validateDimensions(type.definition, raw, {
      products: await this.store.products(tx, productKeys),
      extensionValue: await this.store.extensionParser(tx, extensionFields),
    });
  }

  private async create(
    tx: TenantTransaction,
    type: ContextTypeEntry,
    companyId: string,
    dims: Extract<DimensionValidation, { ok: true }>,
    input: ContextAttributes & {
      readonly provenance: ContextProvenance;
      readonly effectiveAt: Date;
    },
  ): Promise<string> {
    const id = await this.store
      .insertContext(tx, {
        companyId,
        contextTypeId: type.id,
        naturalKeyHash: dims.naturalKeyHash,
        dimensions: dims.dimensions,
        name: input.name,
        status: input.status,
        ownerRef: input.ownerRef,
        renewalDate: input.renewalDate,
      })
      .catch((error: unknown) => {
        // Review n3: the natural-key guard raises (it is not an index, so not
        // P2002); it is a refusal code, never a 500.
        if (isNaturalKeyExists(error)) {
          throw new GovernanceError('validation_failed', 'account_context_natural_key_exists', {
            code: 'account_context_natural_key_exists',
          });
        }
        throw error;
      });
    const fields: ContextAttribute[] = ['name', 'status'];
    if (input.ownerRef !== null) fields.push('ownerRef');
    if (input.renewalDate !== null) fields.push('renewalDate');
    const changeId = await this.store.insertChange(tx, {
      ...changeProvenance(input.provenance),
      entityKind: 'account_context',
      entityId: id,
      changeType: 'created',
      changedFields: [...fields, 'companyId', 'contextTypeId', 'dimensions'],
    });
    await this.store.updateContext(tx, id, { lastChangeId: changeId });
    await this.store.valueHistory(tx, {
      entityKind: 'account_context',
      entityId: id,
      changeId,
      effectiveAt: input.effectiveAt,
      ...(input.provenance.actor ? { actor: input.provenance.actor } : {}),
      changes: [
        { field: 'status', oldValue: null, newValue: input.status },
        ...(input.ownerRef !== null
          ? [{ field: 'owner_ref', oldValue: null, newValue: input.ownerRef }]
          : []),
      ],
    });
    await this.store.addProducts(
      tx,
      id,
      dims.productKeys.map((productKey) => ({ productKey, origin: 'dimension' })),
    );
    return id;
  }

  /** Applies an attribute decision: one change record + value history. Returns whether anything changed. */
  private async applyAttributes(
    tx: TenantTransaction,
    ctx: AccountContextRow,
    decision: AttributeDecision,
    provenance: ContextProvenance,
    effectiveAt: Date,
  ): Promise<boolean> {
    if (decision.changedFields.length === 0) return false;
    const changeId = await this.store.insertChange(tx, {
      ...changeProvenance(provenance),
      entityKind: 'account_context',
      entityId: ctx.id,
      changeType: decision.changedFields.includes('status') ? 'state_changed' : 'updated',
      changedFields: [...decision.changedFields],
    });
    await this.store.updateContext(tx, ctx.id, { ...decision.apply, lastChangeId: changeId });
    const before = attributesOf(ctx);
    await this.store.valueHistory(tx, {
      entityKind: 'account_context',
      entityId: ctx.id,
      changeId,
      effectiveAt,
      ...(provenance.actor ? { actor: provenance.actor } : {}),
      changes: decision.changedFields.flatMap((f) =>
        HISTORY_FIELD[f]
          ? [{ field: HISTORY_FIELD[f], oldValue: before[f], newValue: decision.apply[f] }]
          : [],
      ),
    });
    return true;
  }

  // --- Operator entry (canonical.human_entry, plan §4.1, §4.4) --------------------

  @AuditFailures('account_context.write', 'account_context')
  async write(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorContextWrite,
  ): Promise<AccountContextWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const contextId = input.context ? requireUuid(input.context, '--context') : undefined;
    const accountId = input.account ? requireUuid(input.account, '--account') : undefined;
    if (!contextId && (!accountId || !input.type)) {
      throw new GovernanceError(
        'validation_failed',
        'Name --context, or --account and --type (with the dimensions)',
      );
    }
    if (input.status !== undefined && !['active', 'inactive'].includes(input.status)) {
      throw new GovernanceError('validation_failed', '--status must be active or inactive');
    }
    // Secret-like values are refused (audited denial) before anything is read or stored.
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'account_context.write', targetKind: 'account_context' },
      {
        name: input.name ?? null,
        ownerRef: input.ownerRef ?? null,
        dimensions: input.dimensions ?? {},
      },
    );
    const refusal = attributeRefusal(input);
    if (refusal) throw new GovernanceError('validation_failed', `Refused: ${refusal}`);

    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountContext(tx, actx, this.store, this.moduleGate);
      const types = await this.store.contextTypes(tx);
      let ctx: AccountContextRow | undefined;
      let type: ContextTypeEntry | undefined;
      let dims: Extract<DimensionValidation, { ok: true }> | undefined;
      if (contextId) {
        ctx = await this.lockedContext(tx, contextId);
        type = types.byId.get(ctx.contextTypeId);
      } else {
        type = types.byKey.get(input.type!);
        if (!type) throw new GovernanceError('validation_failed', 'No such context type');
        await this.store.lockEntities(tx, [{ kind: 'company', id: accountId! }]);
        const company = await this.store.company(tx, accountId!);
        if (!company || company.recordState === 'merged') {
          throw new GovernanceError(
            'validation_failed',
            'The account must exist and not be merged',
          );
        }
        const v = await this.validate(tx, type, input.dimensions ?? {});
        if (!v.ok) {
          throw new GovernanceError('validation_failed', `Dimension refused (${v.code})`, {
            dimension: v.key,
            code: v.code,
          });
        }
        dims = v;
        ctx = await this.store.contextByNaturalKey(tx, accountId!, type.id, v.naturalKeyHash);
      }
      const typeKey = type?.key ?? '';
      const provenance = operatorProvenance(actx.actor, actx.correlationId, ctx?.id ?? accountId!);
      if (!ctx) {
        if (type!.status !== 'active') {
          throw new GovernanceError('validation_failed', 'The context type is retired');
        }
        if (input.name === undefined) {
          throw new GovernanceError('validation_failed', '--name is required to create a context');
        }
        const id = await this.create(tx, type!, accountId!, dims!, {
          name: input.name.trim(),
          status: input.status ?? 'active',
          ownerRef: input.ownerRef ?? null,
          renewalDate: input.renewalDate ?? null,
          provenance,
          effectiveAt: new Date(),
        });
        await this.audit.record(tx, actx, {
          action: 'account_context.write',
          targetKind: 'account_context',
          targetRef: id,
          details: { reason, type: typeKey, created: true, changed: true },
        });
        return {
          contextId: id,
          type: typeKey,
          status: input.status ?? 'active',
          created: true,
          changed: true,
        };
      }
      const decision = decideOperatorAttributes(attributesOf(ctx), {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.ownerRef !== undefined ? { ownerRef: input.ownerRef } : {}),
        ...(input.renewalDate !== undefined ? { renewalDate: input.renewalDate } : {}),
      });
      if (decision.changedFields.includes('status') && ctx.status === 'retired') {
        throw new GovernanceError(
          'validation_failed',
          'The context is retired; use reactivate to bring it back',
        );
      }
      const changed = await this.applyAttributes(tx, ctx, decision, provenance, new Date());
      if (dims) {
        await this.store.addProducts(
          tx,
          ctx.id,
          dims.productKeys.map((productKey) => ({ productKey, origin: 'dimension' })),
        );
      }
      await this.audit.record(tx, actx, {
        action: 'account_context.write',
        targetKind: 'account_context',
        targetRef: ctx.id,
        details: {
          reason,
          type: typeKey,
          created: false,
          changed,
          fields: [...decision.changedFields],
        },
      });
      return {
        contextId: ctx.id,
        type: typeKey,
        status: decision.apply.status ?? ctx.status,
        created: false,
        changed,
      };
    });
  }

  /** Retire (plan §4.1): never touches the account, lines or members; new assignments refused. */
  @AuditFailures('account_context.retire', 'account_context')
  retire(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorContextRef,
  ): Promise<AccountContextWritten> {
    return this.operatorStatus(actx, input, 'retired', 'account_context.retire');
  }

  /** Reactivate a retired (or inactive) context; audited as a write. */
  @AuditFailures('account_context.write', 'account_context')
  reactivate(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorContextRef,
  ): Promise<AccountContextWritten> {
    return this.operatorStatus(actx, input, 'active', 'account_context.write');
  }

  private async operatorStatus(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorContextRef,
    status: 'retired' | 'active',
    action: 'account_context.retire' | 'account_context.write',
  ): Promise<AccountContextWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = requireUuid(input.context, '--context');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountContext(tx, actx, this.store, this.moduleGate);
      const ctx = await this.lockedContext(tx, id);
      const typeKey = (await this.store.contextTypes(tx)).byId.get(ctx.contextTypeId)?.key ?? '';
      const decision = decideOperatorAttributes(attributesOf(ctx), { status });
      const changed = await this.applyAttributes(
        tx,
        ctx,
        decision,
        operatorProvenance(actx.actor, actx.correlationId, id),
        new Date(),
      );
      await this.audit.record(tx, actx, {
        action,
        targetKind: 'account_context',
        targetRef: id,
        details: {
          reason,
          type: typeKey,
          changed,
          ...(action === 'account_context.write' ? { operation: 'reactivate' } : {}),
        },
      });
      return { contextId: id, type: typeKey, status, created: false, changed };
    });
  }

  /**
   * Returns the held attributes to the source (Q14): a `release` change record
   * (changed field `humanOverride`); values are unchanged until the next source
   * observation. The open disagreement issue is resolved.
   */
  @AuditFailures('account_context.release', 'account_context')
  async release(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorContextRef,
  ): Promise<AccountContextWritten & { readonly released: number }> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = requireUuid(input.context, '--context');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountContext(tx, actx, this.store, this.moduleGate);
      const ctx = await this.lockedContext(tx, id);
      const typeKey = (await this.store.contextTypes(tx)).byId.get(ctx.contextTypeId)?.key ?? '';
      const held = humanHeldAttributes(await this.store.humanChanges(tx, id));
      const changed = held.size > 0;
      if (changed) {
        const changeId = await this.store.insertChange(tx, {
          ...operatorProvenance(actx.actor, actx.correlationId, id),
          entityKind: 'account_context',
          entityId: id,
          changeType: 'updated',
          changedFields: [HUMAN_OVERRIDE_RELEASE_FIELD],
        });
        await this.store.updateContext(tx, id, { lastChangeId: changeId });
        await this.store.resolveIssue(
          tx,
          'account_context_human_override_disagrees',
          overrideIssue(tx.tenantId, id),
        );
      }
      await this.audit.record(tx, actx, {
        action: 'account_context.release',
        targetKind: 'account_context',
        targetRef: id,
        details: { reason, type: typeKey, changed, released: held.size },
      });
      return {
        contextId: id,
        type: typeKey,
        status: ctx.status,
        created: false,
        changed,
        released: held.size,
      };
    });
  }

  /**
   * The context with its account locked and re-verified under the lock until
   * stable (review M1); refuses a merged one, naming the survivor id (n2).
   */
  private async lockedContext(tx: TenantTransaction, id: string): Promise<AccountContextRow> {
    const ctx = await this.store.lockContextAccount(tx, id);
    if (!ctx) throw new GovernanceError('validation_failed', 'The context does not exist');
    if (ctx === 'unstable') {
      throw new GovernanceError('validation_failed', 'The context account kept moving; retry');
    }
    if (ctx.recordState === 'merged') {
      throw new GovernanceError(
        'validation_failed',
        `The context was merged; use the survivor ${ctx.mergedIntoId ?? ''}`.trim(),
      );
    }
    return ctx;
  }

  // --- Line assignment (plan §4.3, Q8) -------------------------------------------

  @AuditFailures('account_context.line.assign', 'account_context')
  async assignLine(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorLineAssign,
  ): Promise<{
    readonly lineId: string;
    readonly contextId: string | null;
    readonly changed: boolean;
  }> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const lineId = requireUuid(input.line, '--line');
    const contextId = input.context === null ? null : requireUuid(input.context, '--context');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountContext(tx, actx, this.store, this.moduleGate);
      const outcome = await this.assignWithin(tx, {
        lineId,
        contextId,
        provenance: operatorProvenance(actx.actor, actx.correlationId, lineId),
      });
      if (!['assigned', 'unchanged'].includes(outcome)) {
        throw new GovernanceError('validation_failed', `Line assignment refused (${outcome})`);
      }
      await this.audit.record(tx, actx, {
        action: 'account_context.line.assign',
        targetKind: 'account_context',
        targetRef: contextId ?? lineId,
        details: {
          reason,
          line: lineId,
          cleared: contextId === null,
          changed: outcome === 'assigned',
        },
      });
      return { lineId, contextId, changed: outcome === 'assigned' };
    });
  }

  /**
   * A source line assignment inside the line writer's transaction (phase 2b
   * wires `SubscriptionLineWriter` / `subscription.contextRef`). Module
   * disabled or canonical below 0.5 → `skipped` (the line is written exactly
   * as today, counted `context_assignment_skipped`). A different account →
   * `company_mismatch` with an open `account_context_company_mismatch` issue.
   */
  async assignLineFromSource(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: LineAssignment,
  ): Promise<LineAssignOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if ((await this.store.gate(tx)) !== 'ok') return 'skipped';
    const outcome = await this.assignWithin(tx, input);
    const identity = mismatchIssue(tx.tenantId, input.lineId);
    if (outcome === 'company_mismatch') {
      await this.store.recordIssue(tx, {
        kind: 'account_context_company_mismatch',
        identity,
        canonicalIds: [input.lineId, ...(input.contextId ? [input.contextId] : [])],
        externalRefs: input.issueRefs ?? [],
      });
    } else if (outcome === 'assigned' || outcome === 'unchanged') {
      await this.store.resolveIssue(tx, 'account_context_company_mismatch', identity);
    }
    return outcome;
  }

  private async assignWithin(
    tx: TenantTransaction,
    input: LineAssignment,
  ): Promise<LineAssignOutcome> {
    // Review M1: the line's and the context's accounts are locked and stable
    // under the lock (a merge may move either between the read and the lock).
    const both = await this.store.lockStable(
      tx,
      async () => {
        const line = await this.store.line(tx, input.lineId);
        if (!line) return undefined;
        const ctx = input.contextId ? await this.store.context(tx, input.contextId) : undefined;
        return { line, ctx };
      },
      ({ line, ctx }) => [line.companyId, ...(ctx ? [ctx.companyId] : [])],
    );
    if (!both) return 'line_unknown';
    if (both === 'unstable') return 'not_assignable';
    const { line, ctx } = both;
    if (line.contextId === input.contextId) return 'unchanged';
    if (input.contextId) {
      if (!ctx) return 'context_unknown';
      if (
        ctx.recordState === 'merged' ||
        !ACCOUNT_CONTEXT_ASSIGNABLE_STATUSES.includes(ctx.status)
      ) {
        return 'not_assignable';
      }
      if (ctx.companyId !== line.companyId) return 'company_mismatch';
    }
    const changeId = await this.store.insertChange(tx, {
      ...changeProvenance(input.provenance),
      entityKind: 'subscription',
      entityId: input.lineId,
      changeType: 'relationship_changed',
      changedFields: ['contextId'],
    });
    await this.store.setLineContext(tx, input.lineId, input.contextId);
    await this.store.valueHistory(tx, {
      entityKind: 'subscription',
      entityId: input.lineId,
      changeId,
      effectiveAt: new Date(),
      ...(input.provenance.actor ? { actor: input.provenance.actor } : {}),
      changes: [{ field: 'context_id', oldValue: line.contextId, newValue: input.contextId }],
    });
    return 'assigned';
  }
}

/** Shape checks of the attributes (codes only). */
function attributeRefusal(input: {
  readonly name?: string;
  readonly ownerRef?: string | null;
  readonly renewalDate?: string | null;
}): ContextRejection | undefined {
  if (input.name !== undefined && !nameValid(input.name)) return 'name_invalid';
  if (input.ownerRef !== undefined && input.ownerRef !== null && !ownerRefValid(input.ownerRef)) {
    return 'owner_ref_invalid';
  }
  if (
    input.renewalDate !== undefined &&
    input.renewalDate !== null &&
    !renewalDateValid(input.renewalDate)
  ) {
    return 'renewal_date_invalid';
  }
  return undefined;
}

/** The natural-key guard's raised exception, at any depth of the driver error chain (n3). */
export function isNaturalKeyExists(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const e = error as { message?: unknown; cause?: unknown; meta?: unknown };
  if (typeof e.message === 'string' && e.message.includes('account_context_natural_key_exists')) {
    return true;
  }
  const meta = e.meta && typeof e.meta === 'object' ? (e.meta as Record<string, unknown>) : {};
  return (
    isNaturalKeyExists(e.cause, depth + 1) || isNaturalKeyExists(meta.driverAdapterError, depth + 1)
  );
}
