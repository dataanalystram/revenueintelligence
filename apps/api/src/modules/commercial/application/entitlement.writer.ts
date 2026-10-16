import { Injectable } from '@nestjs/common';
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
  CommercialStore,
  type EntitlementRow,
  type SourceRef,
} from '../infrastructure/commercial.store';
import {
  decideAttributes,
  ENTITLEMENT_ATTRIBUTES,
  heldAttributes,
  validateEntitlement,
  type CommercialRejection,
  type EntitlementAttribute,
  type EntitlementAttributes,
} from './commercial.rules';
import {
  applyDecision,
  operatorProvenance,
  presentFields,
  recordCreated,
  recordOverride,
  referenceMeta,
  requireCommercial,
  requireReason,
  requireUuid,
  type CommercialProvenance,
} from './commercial.shared';
import { releaseHold } from './price-offer.writer';

/** One source observation of an entitlement (built by the mapping engine, phase 2b). */
export interface EntitlementObservation {
  /** The canonical account, already resolved from the account reference by the caller. */
  readonly companyId: string;
  readonly ref: SourceRef;
  readonly presence: 'present' | 'absent';
  readonly productKey?: string;
  readonly quantity?: number | null;
  readonly status?: string;
  /** ISO timestamps or null. */
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly observedAt: Date;
  readonly provenance: CommercialProvenance;
}

export type EntitlementRejection =
  | CommercialRejection
  | 'account_unknown'
  | 'account_merged'
  | 'account_changed'
  | 'product_unknown'
  | 'product_required';

export interface EntitlementObserveOutcome {
  readonly status:
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'rejected'
    | 'canonical_version_too_low'
    | 'module_disabled';
  readonly reason?: EntitlementRejection;
  readonly entitlementId?: string;
  readonly humanOverride?: number;
}

export interface OperatorEntitlementWrite {
  readonly entitlement?: string;
  readonly account?: string;
  readonly product?: string;
  readonly quantity?: number | null;
  readonly status?: string;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly reason: string;
}

const HISTORY: Partial<Record<EntitlementAttribute, string>> = {
  status: 'status',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
};

export const attributesOfEntitlement = (r: EntitlementRow): EntitlementAttributes => ({
  productKey: r.productKey,
  quantity: r.quantity,
  status: r.status,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
});

type Incoming = Partial<Record<EntitlementAttribute, string | number | null>>;

function incomingOf(input: Partial<Record<EntitlementAttribute, unknown>>): Incoming {
  const out: Incoming = {};
  for (const k of ENTITLEMENT_ATTRIBUTES) {
    const v = input[k];
    if (v !== undefined) out[k] = v as string | number | null;
  }
  return out;
}

function createAttributes(i: Incoming): EntitlementAttributes {
  return {
    productKey: i.productKey as string,
    quantity: (i.quantity as number | null | undefined) ?? null,
    status: (i.status as string | undefined) ?? 'unknown',
    startsAt: (i.startsAt as string | null | undefined) ?? null,
    endsAt: (i.endsAt as string | null | undefined) ?? null,
  };
}

/**
 * The single writer of `tenant_entitlements` (M10F plan §5.3; ADR 0032): E3
 * §13 fields only; informational (no reader in products / eligibility, Q27).
 * Gate, provenance, holds and audit as `PriceOfferWriter`. The account is
 * locked (`company-canonical`) before the not-merged check, as every
 * company-owned fact writer does.
 */
@Injectable()
export class EntitlementWriter {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: CommercialStore,
    private readonly references: SourceReferenceService,
    readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
    private readonly moduleGate: ModuleGate,
  ) {}

  observeSource(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: EntitlementObservation,
  ): Promise<EntitlementObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, (tx) => this.observe(actx, tx, input));
  }

  async observe(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: EntitlementObservation,
  ): Promise<EntitlementObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('entitlement tenant does not match the transaction tenant');
    }
    const gate = await this.store.gate(tx);
    if (gate !== 'ok') return { status: gate };
    const reject = (reason: EntitlementRejection): EntitlementObserveOutcome => ({
      status: 'rejected',
      reason,
    });
    await this.store.lockCompanies(tx, [input.companyId]);
    const company = await this.store.company(tx, input.companyId);
    if (!company) return reject('account_unknown');
    if (company.recordState === 'merged') return reject('account_merged');
    await this.store.lockSourceRef(tx, input.ref);
    const byRef = await this.store.entityForRef(tx, 'entitlement', input.ref);
    if (input.presence === 'absent') {
      if (byRef) await this.observeReference(actx, tx, input, byRef);
      return { status: 'unchanged', ...(byRef ? { entitlementId: byRef } : {}) };
    }
    if (input.productKey !== undefined) {
      const products = await this.store.products(tx, [input.productKey]);
      if (!products.has(input.productKey)) return reject('product_unknown');
    }
    const incoming = incomingOf(input);
    if (byRef) await this.store.lockRows(tx, 'tenant_entitlements', [byRef]);
    const row = byRef ? await this.store.entitlement(tx, byRef) : undefined;
    if (!row) {
      if (input.productKey === undefined) return reject('product_required');
      const attrs = createAttributes(incoming);
      const bad = validateEntitlement(attrs);
      if (bad) return reject(bad);
      const id = await this.create(tx, input.companyId, attrs, input.provenance, input.observedAt);
      await this.observeReference(actx, tx, input, id);
      return { status: 'created', entitlementId: id };
    }
    if (row.companyId !== input.companyId) return reject('account_changed');
    const held = heldAttributes(
      await this.store.humanChanges(tx, 'entitlement', row.id),
      ENTITLEMENT_ATTRIBUTES,
    );
    const before = attributesOfEntitlement(row);
    const decision = decideAttributes<EntitlementAttribute>(before, incoming, held);
    const bad = validateEntitlement({ ...before, ...decision.apply } as EntitlementAttributes);
    if (bad) return reject(bad);
    await recordOverride(
      tx,
      this.store,
      'entitlement',
      row.id,
      decision.disagreements.length,
      input.ref,
    );
    const changed = await this.apply(tx, row, decision, input.provenance, input.observedAt);
    await this.observeReference(actx, tx, input, row.id);
    return {
      status: changed ? 'updated' : 'unchanged',
      entitlementId: row.id,
      ...(decision.disagreements.length ? { humanOverride: decision.disagreements.length } : {}),
    };
  }

  private async observeReference(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: EntitlementObservation,
    id: string,
  ): Promise<void> {
    await this.references.observe(actx, tx, {
      system: input.ref.system,
      objectType: input.ref.objectType,
      externalId: input.ref.id,
      entityKind: 'entitlement',
      entityId: id,
      presence: input.presence,
      observedAt: input.observedAt,
      ...(input.provenance.sourceUpdatedAt
        ? { sourceUpdatedAt: input.provenance.sourceUpdatedAt }
        : {}),
      meta: referenceMeta(input.provenance),
    });
  }

  private async create(
    tx: TenantTransaction,
    companyId: string,
    attrs: EntitlementAttributes,
    provenance: CommercialProvenance | ((id: string) => CommercialProvenance),
    effectiveAt: Date,
  ): Promise<string> {
    const id = await this.store.insertEntitlement(tx, companyId, attrs);
    const changeId = await recordCreated(tx, this.store, {
      entityKind: 'entitlement',
      entityId: id,
      fields: [...presentFields(attrs), 'companyId'],
      provenance: typeof provenance === 'function' ? provenance(id) : provenance,
      effectiveAt,
      history: [
        { field: 'status', value: attrs.status },
        { field: 'starts_at', value: attrs.startsAt },
        { field: 'ends_at', value: attrs.endsAt },
      ],
    });
    await this.store.updateEntitlement(tx, id, { lastChangeId: changeId });
    return id;
  }

  private apply(
    tx: TenantTransaction,
    row: EntitlementRow,
    decision: ReturnType<typeof decideAttributes<EntitlementAttribute>>,
    provenance: CommercialProvenance,
    effectiveAt: Date,
  ): Promise<boolean> {
    return applyDecision(tx, this.store, {
      entityKind: 'entitlement',
      entityId: row.id,
      before: attributesOfEntitlement(row),
      decision,
      provenance,
      effectiveAt,
      history: HISTORY,
      changeType: (f) => (f.includes('status') ? 'state_changed' : 'updated'),
      update: (apply) =>
        this.store.updateEntitlement(tx, row.id, apply as Partial<EntitlementAttributes>),
    });
  }

  // --- Operator entry ------------------------------------------------------------------

  @AuditFailures('commercial.entitlement.write', 'entitlement')
  async write(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorEntitlementWrite,
  ): Promise<{
    readonly entitlementId: string;
    readonly created: boolean;
    readonly changed: boolean;
  }> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = input.entitlement ? requireUuid(input.entitlement, '--entitlement') : undefined;
    const account = input.account ? requireUuid(input.account, '--account') : undefined;
    if (!id && !account) {
      throw new GovernanceError(
        'validation_failed',
        'Name --entitlement, or --account to create one',
      );
    }
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'commercial.entitlement.write', targetKind: 'entitlement' },
      { product: input.product ?? null, status: input.status ?? null },
    );
    const incoming = incomingOf({ ...input, productKey: input.product });
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireCommercial(tx, actx, this.store, this.moduleGate);
      if (input.product !== undefined) {
        const active = (await this.store.products(tx, [input.product])).get(input.product);
        if (active !== true) {
          throw new GovernanceError('validation_failed', 'The product must exist and be active');
        }
      }
      if (!id) {
        await this.store.lockCompanies(tx, [account]);
        const company = await this.store.company(tx, account!);
        if (!company || company.recordState === 'merged') {
          throw new GovernanceError(
            'validation_failed',
            'The account must exist and not be merged',
          );
        }
        if (input.product === undefined) {
          throw new GovernanceError(
            'validation_failed',
            '--product is required to create an entitlement',
          );
        }
        const attrs = createAttributes(incoming);
        const bad = validateEntitlement(attrs);
        if (bad) throw new GovernanceError('validation_failed', `Refused: ${bad}`, { code: bad });
        const newId = await this.create(
          tx,
          account!,
          attrs,
          (eid) => operatorProvenance(actx.actor, actx.correlationId, eid),
          new Date(),
        );
        await this.audit.record(tx, actx, {
          action: 'commercial.entitlement.write',
          targetKind: 'entitlement',
          targetRef: newId,
          details: { reason, created: true, changed: true },
        });
        return { entitlementId: newId, created: true, changed: true };
      }
      const row = await this.lockedEntitlement(tx, id);
      const before = attributesOfEntitlement(row);
      const decision = decideAttributes<EntitlementAttribute>(before, incoming);
      const bad = validateEntitlement({ ...before, ...decision.apply } as EntitlementAttributes);
      if (bad) throw new GovernanceError('validation_failed', `Refused: ${bad}`, { code: bad });
      const changed = await this.apply(
        tx,
        row,
        decision,
        operatorProvenance(actx.actor, actx.correlationId, id),
        new Date(),
      );
      await this.audit.record(tx, actx, {
        action: 'commercial.entitlement.write',
        targetKind: 'entitlement',
        targetRef: id,
        details: { reason, created: false, changed, fields: [...decision.changedFields] },
      });
      return { entitlementId: id, created: false, changed };
    });
  }

  @AuditFailures('commercial.release', 'entitlement')
  async release(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: { readonly entitlement: string; readonly reason: string },
  ): Promise<{ readonly entitlementId: string; readonly released: number }> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = requireUuid(input.entitlement, '--entitlement');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireCommercial(tx, actx, this.store, this.moduleGate);
      await this.lockedEntitlement(tx, id);
      const released = await releaseHold(tx, this.store, actx, 'entitlement', id, (changeId) =>
        this.store.updateEntitlement(tx, id, { lastChangeId: changeId }),
      );
      await this.audit.record(tx, actx, {
        action: 'commercial.release',
        targetKind: 'entitlement',
        targetRef: id,
        details: { reason, kind: 'entitlement', released },
      });
      return { entitlementId: id, released };
    });
  }

  /** The entitlement with its account locked (stable under the lock; a merge may move it). */
  private async lockedEntitlement(tx: TenantTransaction, id: string): Promise<EntitlementRow> {
    let row = await this.store.entitlement(tx, id);
    for (let i = 0; row && i < 3; i += 1) {
      await this.store.lockCompanies(tx, [row.companyId]);
      const again = await this.store.entitlement(tx, id);
      if (again?.companyId === row.companyId) {
        await this.store.lockRows(tx, 'tenant_entitlements', [id]);
        return again;
      }
      row = again;
    }
    throw new GovernanceError(
      'validation_failed',
      row ? 'The entitlement account kept moving; retry' : 'The entitlement does not exist',
    );
  }
}
