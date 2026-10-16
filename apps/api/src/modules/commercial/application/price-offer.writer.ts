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
  type PriceOfferRow,
  type SourceRef,
} from '../infrastructure/commercial.store';
import {
  COMMERCIAL_RELEASE_FIELD,
  decideAttributes,
  heldAttributes,
  PRICE_OFFER_ATTRIBUTES,
  validatePriceOffer,
  type CommercialRejection,
  type PriceOfferAttribute,
  type PriceOfferAttributes,
} from './commercial.rules';
import {
  applyDecision,
  changeProvenance,
  operatorProvenance,
  presentFields,
  recordCreated,
  recordOverride,
  overrideIssue,
  referenceMeta,
  requireCommercial,
  requireReason,
  requireUuid,
  type CommercialProvenance,
} from './commercial.shared';

/** One source observation of a price offer (built by the mapping engine, phase 2b). */
export interface PriceOfferObservation {
  readonly ref: SourceRef;
  readonly presence: 'present' | 'absent';
  /** The canonical product key (resolved by the caller from the product reference set). */
  readonly productKey?: string;
  readonly currency?: string;
  readonly billingPeriod?: number | null;
  readonly billingPeriodUnit?: string | null;
  readonly pricingModel?: string | null;
  readonly listAmountMinor?: number | null;
  readonly status?: string;
  readonly observedAt: Date;
  readonly provenance: CommercialProvenance;
}

export type PriceOfferRejection =
  | CommercialRejection
  | 'product_unknown'
  | 'product_required'
  | 'currency_required'
  | 'product_referenced';

export interface PriceOfferObserveOutcome {
  readonly status:
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'rejected'
    | 'canonical_version_too_low'
    | 'module_disabled';
  readonly reason?: PriceOfferRejection;
  readonly priceOfferId?: string;
  readonly humanOverride?: number;
}

export interface OperatorPriceOfferWrite {
  /** Update by id; omitted = create. */
  readonly priceOffer?: string;
  readonly product?: string;
  readonly currency?: string;
  readonly billingPeriod?: number | null;
  readonly billingPeriodUnit?: string | null;
  readonly pricingModel?: string | null;
  readonly listAmountMinor?: number | null;
  readonly status?: 'active' | 'retired';
  readonly reason: string;
}

export interface PriceOfferWritten {
  readonly priceOfferId: string;
  readonly created: boolean;
  readonly changed: boolean;
}

const HISTORY: Partial<Record<PriceOfferAttribute, string>> = {
  status: 'status',
  listAmountMinor: 'list_amount_minor',
};

export const attributesOfOffer = (r: PriceOfferRow): PriceOfferAttributes => ({
  productKey: r.productKey,
  currency: r.currency,
  billingPeriod: r.billingPeriod,
  billingPeriodUnit: r.billingPeriodUnit,
  pricingModel: r.pricingModel,
  listAmountMinor: r.listAmountMinor,
  status: r.status,
});

type Incoming = Partial<Record<PriceOfferAttribute, string | number | null>>;

/**
 * The single writer of `tenant_price_offers` (M10F plan §5.1; ADR 0032).
 * Every write is gated on adopted ≥ 0.6 **and** module `commercial` enabled.
 * Source writes (`canonical.source_sync`; the `price_offer` authority fact is
 * decided by the sync run) resolve by generic source reference (no natural
 * key, Q5); operator writes (`canonical.human_entry`) write one audit event
 * each (ids and codes only) and hold the attributes they set until
 * `release` (Q17). A product key may change only while no line references
 * the offer (Q10). Retiring never touches lines; new line assignments to a
 * retired offer are refused by the line-reference step.
 */
@Injectable()
export class PriceOfferWriter {
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
    input: PriceOfferObservation,
  ): Promise<PriceOfferObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, (tx) => this.observe(actx, tx, input));
  }

  async observe(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: PriceOfferObservation,
  ): Promise<PriceOfferObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('price offer tenant does not match the transaction tenant');
    }
    const gate = await this.store.gate(tx);
    if (gate !== 'ok') return { status: gate };
    const reject = (reason: PriceOfferRejection): PriceOfferObserveOutcome => ({
      status: 'rejected',
      reason,
    });
    // One record per source triple (V34): the reference service's triple lock, held to commit.
    await this.store.lockSourceRef(tx, input.ref);
    const byRef = await this.store.entityForRef(tx, 'price_offer', input.ref);
    if (input.presence === 'absent') {
      // A source deletion is recorded on the reference only: the offer stays.
      if (byRef) await this.observeReference(actx, tx, input, byRef);
      return { status: 'unchanged', ...(byRef ? { priceOfferId: byRef } : {}) };
    }
    if (input.productKey !== undefined) {
      // A retired product keeps (and may gain, from the source) offers (plan §8).
      const products = await this.store.products(tx, [input.productKey]);
      if (!products.has(input.productKey)) return reject('product_unknown');
    }
    const incoming = incomingOf(input);
    if (byRef) await this.store.lockRows(tx, 'tenant_price_offers', [byRef]);
    const offer = byRef ? await this.store.offer(tx, byRef) : undefined;
    if (!offer) {
      if (input.productKey === undefined) return reject('product_required');
      if (input.currency === undefined) return reject('currency_required');
      const attrs = createAttributes(incoming);
      const bad = validatePriceOffer(attrs);
      if (bad) return reject(bad);
      const id = await this.create(tx, attrs, input.provenance, input.observedAt);
      await this.observeReference(actx, tx, input, id);
      return { status: 'created', priceOfferId: id };
    }
    const held = heldAttributes(
      await this.store.humanChanges(tx, 'price_offer', offer.id),
      PRICE_OFFER_ATTRIBUTES,
    );
    const before = attributesOfOffer(offer);
    const decision = decideAttributes<PriceOfferAttribute>(before, incoming, held);
    const bad = validatePriceOffer({ ...before, ...decision.apply } as PriceOfferAttributes);
    if (bad) return reject(bad);
    if (
      decision.changedFields.includes('productKey') &&
      (await this.store.offerReferenced(tx, offer.id))
    ) {
      return reject('product_referenced');
    }
    await recordOverride(
      tx,
      this.store,
      'price_offer',
      offer.id,
      decision.disagreements.length,
      input.ref,
    );
    const changed = await this.apply(tx, offer, decision, input.provenance, input.observedAt);
    await this.observeReference(actx, tx, input, offer.id);
    return {
      status: changed ? 'updated' : 'unchanged',
      priceOfferId: offer.id,
      ...(decision.disagreements.length ? { humanOverride: decision.disagreements.length } : {}),
    };
  }

  private async observeReference(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: PriceOfferObservation,
    id: string,
  ): Promise<void> {
    await this.references.observe(actx, tx, {
      system: input.ref.system,
      objectType: input.ref.objectType,
      externalId: input.ref.id,
      entityKind: 'price_offer',
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
    attrs: PriceOfferAttributes,
    provenance: CommercialProvenance | ((id: string) => CommercialProvenance),
    effectiveAt: Date,
  ): Promise<string> {
    const id = await this.store.insertOffer(tx, attrs);
    const changeId = await recordCreated(tx, this.store, {
      entityKind: 'price_offer',
      entityId: id,
      fields: presentFields(attrs),
      provenance: typeof provenance === 'function' ? provenance(id) : provenance,
      effectiveAt,
      history: [
        { field: 'status', value: attrs.status },
        { field: 'list_amount_minor', value: attrs.listAmountMinor },
      ],
    });
    await this.store.updateOffer(tx, id, { lastChangeId: changeId });
    return id;
  }

  private apply(
    tx: TenantTransaction,
    offer: PriceOfferRow,
    decision: ReturnType<typeof decideAttributes<PriceOfferAttribute>>,
    provenance: CommercialProvenance,
    effectiveAt: Date,
  ): Promise<boolean> {
    return applyDecision(tx, this.store, {
      entityKind: 'price_offer',
      entityId: offer.id,
      before: attributesOfOffer(offer),
      decision,
      provenance,
      effectiveAt,
      history: HISTORY,
      changeType: (f) => (f.includes('status') ? 'state_changed' : 'updated'),
      update: (apply) =>
        this.store.updateOffer(tx, offer.id, apply as Partial<PriceOfferAttributes>),
    });
  }

  // --- Operator entry (canonical.human_entry) ----------------------------------------

  @AuditFailures('commercial.price_offer.write', 'price_offer')
  async write(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorPriceOfferWrite,
  ): Promise<PriceOfferWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = input.priceOffer ? requireUuid(input.priceOffer, '--price-offer') : undefined;
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'commercial.price_offer.write', targetKind: 'price_offer' },
      { product: input.product ?? null, currency: input.currency ?? null },
    );
    const incoming = incomingOf({ ...input, productKey: input.product });
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireCommercial(tx, actx, this.store, this.moduleGate);
      if (input.product !== undefined) {
        const active = (await this.store.products(tx, [input.product])).get(input.product);
        // Operator create / re-point on a retired product key is refused (plan §8).
        if (active !== true) {
          throw new GovernanceError('validation_failed', 'The product must exist and be active');
        }
      }
      if (!id) {
        if (input.product === undefined || input.currency === undefined) {
          throw new GovernanceError(
            'validation_failed',
            '--product and --currency are required to create a price offer',
          );
        }
        const attrs = createAttributes(incoming);
        const bad = validatePriceOffer(attrs);
        if (bad) throw new GovernanceError('validation_failed', `Refused: ${bad}`, { code: bad });
        const newId = await this.create(
          tx,
          attrs,
          (newId) => operatorProvenance(actx.actor, actx.correlationId, newId),
          new Date(),
        );
        await this.audit.record(tx, actx, {
          action: 'commercial.price_offer.write',
          targetKind: 'price_offer',
          targetRef: newId,
          details: { reason, created: true, changed: true },
        });
        return { priceOfferId: newId, created: true, changed: true };
      }
      await this.store.lockRows(tx, 'tenant_price_offers', [id]);
      const offer = await this.store.offer(tx, id);
      if (!offer) throw new GovernanceError('validation_failed', 'The price offer does not exist');
      const changed = await this.operatorUpdate(tx, actx, offer, incoming);
      await this.audit.record(tx, actx, {
        action: 'commercial.price_offer.write',
        targetKind: 'price_offer',
        targetRef: id,
        details: { reason, created: false, changed: changed.length > 0, fields: changed },
      });
      return { priceOfferId: id, created: false, changed: changed.length > 0 };
    });
  }

  /** Retire (plan §5.1): lines keep `price_offer_id`; new assignments are refused. */
  @AuditFailures('commercial.price_offer.write', 'price_offer')
  retire(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: { readonly priceOffer: string; readonly reason: string },
  ): Promise<PriceOfferWritten> {
    return this.write(actx, {
      priceOffer: input.priceOffer,
      status: 'retired',
      reason: input.reason,
    });
  }

  private async operatorUpdate(
    tx: TenantTransaction,
    actx: AuthorizedContext<'canonical.human_entry'>,
    offer: PriceOfferRow,
    incoming: Incoming,
  ): Promise<PriceOfferAttribute[]> {
    const before = attributesOfOffer(offer);
    const decision = decideAttributes<PriceOfferAttribute>(before, incoming);
    const bad = validatePriceOffer({ ...before, ...decision.apply } as PriceOfferAttributes);
    if (bad) throw new GovernanceError('validation_failed', `Refused: ${bad}`, { code: bad });
    if (
      decision.changedFields.includes('productKey') &&
      (await this.store.offerReferenced(tx, offer.id))
    ) {
      throw new GovernanceError(
        'validation_failed',
        'Refused: product_referenced (lines reference this price offer)',
        { code: 'product_referenced' },
      );
    }
    await this.apply(
      tx,
      offer,
      decision,
      operatorProvenance(actx.actor, actx.correlationId, offer.id),
      new Date(),
    );
    return [...decision.changedFields];
  }

  /** Returns the held attributes to the source (Q17); values unchanged until the next observation. */
  @AuditFailures('commercial.release', 'price_offer')
  async release(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: { readonly priceOffer: string; readonly reason: string },
  ): Promise<{ readonly priceOfferId: string; readonly released: number }> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = requireUuid(input.priceOffer, '--price-offer');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireCommercial(tx, actx, this.store, this.moduleGate);
      await this.store.lockRows(tx, 'tenant_price_offers', [id]);
      if (!(await this.store.offer(tx, id))) {
        throw new GovernanceError('validation_failed', 'The price offer does not exist');
      }
      const released = await releaseHold(tx, this.store, actx, 'price_offer', id, (changeId) =>
        this.store.updateOffer(tx, id, { lastChangeId: changeId }),
      );
      await this.audit.record(tx, actx, {
        action: 'commercial.release',
        targetKind: 'price_offer',
        targetRef: id,
        details: { reason, kind: 'price_offer', released },
      });
      return { priceOfferId: id, released };
    });
  }
}

function incomingOf(input: {
  readonly productKey?: string;
  readonly currency?: string;
  readonly billingPeriod?: number | null;
  readonly billingPeriodUnit?: string | null;
  readonly pricingModel?: string | null;
  readonly listAmountMinor?: number | null;
  readonly status?: string;
}): Incoming {
  const out: Incoming = {};
  for (const k of PRICE_OFFER_ATTRIBUTES) {
    const v = input[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function createAttributes(i: Incoming): PriceOfferAttributes {
  return {
    productKey: i.productKey as string,
    currency: i.currency as string,
    billingPeriod: (i.billingPeriod as number | null | undefined) ?? null,
    billingPeriodUnit: (i.billingPeriodUnit as string | null | undefined) ?? null,
    pricingModel: (i.pricingModel as string | null | undefined) ?? null,
    listAmountMinor: (i.listAmountMinor as number | null | undefined) ?? null,
    status: (i.status as string | undefined) ?? 'active',
  };
}

/**
 * Q17 release: a `release` change record (changed field `humanOverride`) when
 * anything is held, and the open disagreement issue resolved. Returns the
 * number of attributes released.
 */
export async function releaseHold(
  tx: TenantTransaction,
  store: CommercialStore,
  actx: AuthorizedContext<'canonical.human_entry'>,
  entityKind: 'price_offer' | 'contract' | 'entitlement' | 'subscription',
  id: string,
  stamp: (changeId: string) => Promise<void>,
  attributes?: readonly string[],
): Promise<number> {
  const changes = await store.humanChanges(tx, entityKind, id);
  const held = heldAttributes(
    changes,
    attributes ??
      changes.flatMap((c) => c.changedFields.filter((f) => f !== COMMERCIAL_RELEASE_FIELD)),
  );
  if (held.size === 0) return 0;
  const changeId = await store.insertChange(tx, {
    ...changeProvenance(operatorProvenance(actx.actor, actx.correlationId, id)),
    entityKind,
    entityId: id,
    changeType: 'updated',
    changedFields: [COMMERCIAL_RELEASE_FIELD],
  });
  await stamp(changeId);
  await store.resolveIssue(
    tx,
    'commercial_human_override_disagrees',
    overrideIssue(tx.tenantId, entityKind, id),
  );
  return held.size;
}
