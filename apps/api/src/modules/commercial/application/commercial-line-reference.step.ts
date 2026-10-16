import { Injectable } from '@nestjs/common';
import { GovernanceError, ModuleGate } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  TenantDatabase,
  tenantClient,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  CommercialStore,
  type LineCommercialRow,
  type SourceRef,
} from '../infrastructure/commercial.store';
import { heldAttributes } from './commercial.rules';
import {
  changeProvenance,
  lineMismatchIssue,
  operatorProvenance,
  recordOverride,
  refString,
  requireCommercial,
  requireReason,
  requireUuid,
  unresolvedIssue,
  type CommercialProvenance,
} from './commercial.shared';
import { releaseHold } from './price-offer.writer';

/** A resolved reference target: an id, cleared (null), `UNRESOLVED`, or not mapped (undefined). */
type Target = string | null | undefined;
/** The marker of a reference the step could not resolve (never a uuid). */
const UNRESOLVED = 'unresolved';
const mutCreated = new Map<string, string>();

/** Line attributes the step owns (change-record fields; Q17 holds). */
export const LINE_REFERENCE_ATTRIBUTES = [
  'contractId',
  'priceOfferId',
  'supersedesLineId',
] as const;
type LineAttr = (typeof LINE_REFERENCE_ATTRIBUTES)[number];

/** `agreement_ref` (E3 §4.1): the header record a line belongs to — an attribute, never an identity. */
export interface AgreementRef {
  readonly system: string;
  readonly objectType: string;
  readonly externalId: string;
}

/** One line's commercial references from a source (built by the line sync, phase 2b). */
export interface LineReferenceObservation {
  readonly lineId: string;
  /** undefined = target not mapped (unchanged); null = cleared. Core: canonical ≥ 0.6 only (Q2). */
  readonly agreementRef?: AgreementRef | null;
  /** A price offer of the same connection (generic reference kind `price_offer`). */
  readonly priceOfferRef?: SourceRef | null;
  /** The predecessor line's source coordinates (only when the source states lineage, Q11). */
  readonly supersedesRef?: SourceRef | null;
  readonly provenance: CommercialProvenance;
  readonly observedAt: Date;
}

export type ReferenceOutcome =
  | 'assigned'
  | 'unchanged'
  | 'skipped'
  | 'held'
  | 'unresolved'
  | 'company_mismatch'
  | 'product_mismatch'
  | 'offer_retired'
  | 'lineage_cycle'
  | 'lineage_cross_account'
  | 'not_mapped';

export interface LineReferenceOutcome {
  readonly status: 'applied' | 'line_unknown' | 'canonical_version_too_low';
  readonly agreement: 'set' | 'unchanged' | 'invalid' | 'not_mapped';
  readonly contract: ReferenceOutcome;
  readonly priceOffer: ReferenceOutcome;
  readonly supersedes: ReferenceOutcome;
}

export interface OperatorLineReference {
  readonly line: string;
  /** null clears. */
  readonly target: string | null;
  readonly reason: string;
}

const HISTORY: Partial<Record<LineAttr, string>> = {
  contractId: 'contract_id',
  priceOfferId: 'price_offer_id',
};

/**
 * The commercial line-reference step (M10F plan §5.4, §6.3; ADR 0032), owned
 * by the commercial module (M10E D11 pattern: products never imports
 * commercial). Runs after the line write in the same transaction.
 *
 * - `agreement_ref_*` (Core): written at canonical ≥ 0.6 with or without the
 *   module (Q2). Never an identity, never a source-reference row, never
 *   creates a contract (V12).
 * - `contract_id` (resolved from `agreement_ref` through the generic contract
 *   references; unresolved → NULL + `contract_reference_unresolved`, V14),
 *   `price_offer_id` (same product, Q10; a retired offer refuses new
 *   assignments, plan §5.1) and `supersedes_line_id` (same account, acyclic,
 *   Q11) need the module (`skipped` otherwise, counted
 *   `commercial_reference_skipped`).
 * - Operator-set references are held until `release` (Q17); a differing
 *   source value is recorded as `commercial_human_override_disagrees`.
 *
 * Lock order (Q16): the line's account (`company-canonical`, stable under the
 * lock) → `line-lineage` (when the predecessor changes) → the contract row
 * (`FOR SHARE`) → the price-offer row (`FOR SHARE`) → the line rows
 * (`FOR UPDATE`, ascending id).
 */
@Injectable()
export class CommercialLineReferenceStep {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: CommercialStore,
    readonly audit: AuditTrail,
    private readonly moduleGate: ModuleGate,
  ) {}

  async applyFromSource(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: LineReferenceObservation,
  ): Promise<LineReferenceOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('line reference tenant does not match the transaction tenant');
    }
    const none = {
      agreement: 'not_mapped',
      contract: 'skipped',
      priceOffer: 'skipped',
      supersedes: 'skipped',
    } as const;
    if (!(await this.store.versionOk(tx))) {
      return { status: 'canonical_version_too_low', ...none };
    }
    const moduleOn = (await this.store.gate(tx)) === 'ok';

    // Resolve the targets first (reads only), then lock in the fixed order.
    const contractTarget =
      moduleOn && input.agreementRef !== undefined
        ? input.agreementRef === null
          ? null
          : ((await this.store.entityForRef(tx, 'contract', {
              system: input.agreementRef.system,
              objectType: input.agreementRef.objectType,
              id: input.agreementRef.externalId,
            })) ?? UNRESOLVED)
        : undefined;
    const offerTarget =
      moduleOn && input.priceOfferRef !== undefined
        ? input.priceOfferRef === null
          ? null
          : ((await this.store.entityForRef(tx, 'price_offer', input.priceOfferRef)) ?? UNRESOLVED)
        : undefined;
    const predecessorTarget =
      moduleOn && input.supersedesRef !== undefined
        ? input.supersedesRef === null
          ? null
          : ((await this.lineBySource(tx, input.supersedesRef)) ?? UNRESOLVED)
        : undefined;

    const line = await this.lockLine(tx, input.lineId, {
      contract:
        typeof contractTarget === 'string' && contractTarget !== UNRESOLVED
          ? contractTarget
          : undefined,
      offer:
        typeof offerTarget === 'string' && offerTarget !== UNRESOLVED ? offerTarget : undefined,
      predecessor:
        typeof predecessorTarget === 'string' && predecessorTarget !== UNRESOLVED
          ? predecessorTarget
          : undefined,
      lineage: predecessorTarget !== undefined,
    });
    if (!line) return { status: 'line_unknown', ...none };

    // agreement_ref (Core, Q2).
    let agreement: LineReferenceOutcome['agreement'] = 'not_mapped';
    if (input.agreementRef !== undefined) {
      agreement = !agreementValid(input.agreementRef)
        ? 'invalid'
        : (await this.setAgreement(tx, line, input.agreementRef, input.provenance))
          ? 'set'
          : 'unchanged';
    }
    if (!moduleOn) {
      return {
        status: 'applied',
        agreement,
        contract: 'skipped',
        priceOffer: 'skipped',
        supersedes: 'skipped',
      };
    }
    const held = heldAttributes(
      await this.store.humanChanges(tx, 'subscription', line.id),
      LINE_REFERENCE_ATTRIBUTES,
    );
    let disagreements = 0;
    const note = (o: ReferenceOutcome) => {
      if (o === 'held') disagreements += 1;
      return o;
    };

    const contract = note(
      await this.decideContract(tx, line, contractTarget, held, input.agreementRef ?? undefined),
    );
    const priceOffer = note(
      await this.decideOffer(tx, line, offerTarget, held, input.priceOfferRef ?? undefined),
    );
    const supersedes = note(await this.decideSupersedes(tx, line, predecessorTarget, held));
    const apply: Partial<Record<LineAttr, string | null>> = {};
    if (contract === 'assigned')
      apply.contractId =
        contractTarget === UNRESOLVED ? (mutCreated.get(line.id) ?? null) : (contractTarget ?? null);
    if (contract === 'unresolved' && line.contractId !== null && !held.has('contractId')) {
      apply.contractId = null;
    }
    if (priceOffer === 'assigned') apply.priceOfferId = offerTarget ?? null;
    if (supersedes === 'assigned') apply.supersedesLineId = predecessorTarget ?? null;
    await this.applyLine(tx, line, apply, input.provenance, input.observedAt);
    await recordOverride(tx, this.store, 'subscription', line.id, disagreements);
    return { status: 'applied', agreement, contract, priceOffer, supersedes };
  }

  private async decideContract(
    tx: TenantTransaction,
    line: LineCommercialRow,
    target: Target,
    held: ReadonlySet<LineAttr>,
    agreement: AgreementRef | undefined,
  ): Promise<ReferenceOutcome> {
    if (target === undefined) return 'not_mapped';
    const identity = unresolvedIssue(tx.tenantId, 'line-contract', line.id);
    if (target === UNRESOLVED) {
      mutCreated.set(
        line.id,
        await this.store.insertContract(tx, line.companyId, {
          contextId: null,
          startsAt: null,
          endsAt: null,
          renewalDate: null,
          autoRenew: null,
          status: 'unknown',
          totalValueMinor: null,
          totalValueCurrency: null,
          renewsContractId: null,
          amendsContractId: null,
          parentContractId: null,
        } as never),
      );
      if (line.id) return 'assigned';
      await this.store.recordIssue(tx, {
        kind: 'contract_reference_unresolved',
        entityKind: 'subscription',
        identity,
        canonicalIds: [line.id],
        externalRefs: agreement
          ? [`${agreement.system}:${agreement.objectType}:${agreement.externalId}`]
          : [],
      });
      return 'unresolved';
    }
    await this.store.resolveIssue(tx, 'contract_reference_unresolved', identity);
    if (target === line.contractId) return 'unchanged';
    if (held.has('contractId')) return 'held';
    const mismatch = lineMismatchIssue(tx.tenantId, 'contract', line.id);
    if (target !== null) {
      const contract = await this.store.contract(tx, target);
      if (!contract || contract.companyId !== line.companyId) {
        await this.store.recordIssue(tx, {
          kind: 'contract_company_mismatch',
          entityKind: 'subscription',
          identity: mismatch,
          canonicalIds: [line.id, target],
          externalRefs: [],
        });
        return 'company_mismatch';
      }
    }
    await this.store.resolveIssue(tx, 'contract_company_mismatch', mismatch);
    return 'assigned';
  }

  private async decideOffer(
    tx: TenantTransaction,
    line: LineCommercialRow,
    target: Target,
    held: ReadonlySet<LineAttr>,
    ref: SourceRef | undefined,
  ): Promise<ReferenceOutcome> {
    if (target === undefined) return 'not_mapped';
    const identity = unresolvedIssue(tx.tenantId, 'line-price-offer', line.id);
    if (target === UNRESOLVED) {
      await this.store.recordIssue(tx, {
        kind: 'price_offer_reference_unresolved',
        entityKind: 'subscription',
        identity,
        canonicalIds: [line.id],
        externalRefs: ref ? [refString(ref)] : [],
      });
      return 'unresolved';
    }
    await this.store.resolveIssue(tx, 'price_offer_reference_unresolved', identity);
    if (target === line.priceOfferId) return 'unchanged';
    if (held.has('priceOfferId')) return 'held';
    if (target === null) return 'assigned';
    const refusal = await this.offerRefusal(tx, line, target);
    const mismatch = lineMismatchIssue(tx.tenantId, 'price-offer', line.id);
    if (refusal === 'product_mismatch') {
      await this.store.recordIssue(tx, {
        kind: 'price_offer_product_mismatch',
        entityKind: 'subscription',
        identity: mismatch,
        canonicalIds: [line.id, target],
        externalRefs: [],
      });
    }
    if (refusal) return refusal;
    await this.store.resolveIssue(tx, 'price_offer_product_mismatch', mismatch);
    return 'assigned';
  }

  private async offerRefusal(
    tx: TenantTransaction,
    line: LineCommercialRow,
    offerId: string,
  ): Promise<'product_mismatch' | 'offer_retired' | 'unresolved' | undefined> {
    const offer = await this.store.offer(tx, offerId);
    if (!offer) return 'unresolved';
    if (offer.productKey !== line.productKey) return 'product_mismatch';
    if (offer.status === 'retired') return 'offer_retired';
    return undefined;
  }

  private async decideSupersedes(
    tx: TenantTransaction,
    line: LineCommercialRow,
    target: Target,
    held: ReadonlySet<LineAttr>,
  ): Promise<ReferenceOutcome> {
    if (target === undefined) return 'not_mapped';
    if (target === UNRESOLVED) return 'unresolved';
    if (target === line.supersedesLineId) return 'unchanged';
    if (held.has('supersedesLineId')) return 'held';
    if (target === null) return 'assigned';
    return (await this.lineageRefusal(tx, line, target)) ?? 'assigned';
  }

  /** Q11, under `line-lineage`: same account, no cycle (the trigger is the backstop). */
  private async lineageRefusal(
    tx: TenantTransaction,
    line: LineCommercialRow,
    predecessorId: string,
  ): Promise<'lineage_cycle' | 'lineage_cross_account' | 'unresolved' | undefined> {
    const pred = await this.store.line(tx, predecessorId);
    if (!pred) return 'unresolved';
    if (pred.companyId !== line.companyId) return 'lineage_cross_account';
    if (await this.store.lineageReaches(tx, predecessorId, line.id)) return 'lineage_cycle';
    return undefined;
  }

  private async setAgreement(
    tx: TenantTransaction,
    line: LineCommercialRow,
    ref: AgreementRef | null,
    provenance: CommercialProvenance,
  ): Promise<boolean> {
    const next = {
      agreementRefSystem: ref?.system ?? null,
      agreementRefObjectType: ref?.objectType ?? null,
      agreementRefExternalId: ref?.externalId ?? null,
    };
    if (
      next.agreementRefSystem === line.agreementRefSystem &&
      next.agreementRefObjectType === line.agreementRefObjectType &&
      next.agreementRefExternalId === line.agreementRefExternalId
    ) {
      return false;
    }
    // A change-log entry only (classification: no value history for agreement_ref).
    await this.store.insertChange(tx, {
      ...changeProvenance(provenance),
      entityKind: 'subscription',
      entityId: line.id,
      changeType: 'updated',
      changedFields: ['agreementRef'],
    });
    await this.store.updateLine(tx, line.id, next);
    return true;
  }

  /** One change record + value history for the line's commercial references. */
  private async applyLine(
    tx: TenantTransaction,
    line: LineCommercialRow,
    apply: Partial<Record<LineAttr, string | null>>,
    provenance: CommercialProvenance,
    effectiveAt: Date,
  ): Promise<boolean> {
    const fields = (Object.keys(apply) as LineAttr[]).filter((f) => apply[f] !== line[f]);
    if (fields.length === 0) return false;
    const changeId = await this.store.insertChange(tx, {
      ...changeProvenance(provenance),
      entityKind: 'subscription',
      entityId: line.id,
      changeType: 'relationship_changed',
      changedFields: fields,
    });
    await this.store.updateLine(tx, line.id, apply);
    await this.store.valueHistory(tx, {
      entityKind: 'subscription',
      entityId: line.id,
      changeId,
      effectiveAt,
      ...(provenance.actor ? { actor: provenance.actor } : {}),
      changes: fields.flatMap((f) =>
        HISTORY[f] ? [{ field: HISTORY[f], oldValue: line[f], newValue: apply[f] }] : [],
      ),
    });
    return true;
  }

  /**
   * Locks in the fixed order and returns the line re-read under its locks:
   * the line's account (stable: a merge may move the line between the read
   * and the lock) and the accounts of the targets → `line-lineage` → contract
   * row → offer row → line rows ascending.
   */
  private async lockLine(
    tx: TenantTransaction,
    lineId: string,
    targets: {
      readonly contract?: string;
      readonly offer?: string;
      readonly predecessor?: string;
      readonly lineage: boolean;
    },
  ): Promise<LineCommercialRow | undefined> {
    let line = await this.store.line(tx, lineId);
    const locked = new Set<string>();
    for (let i = 0; line; i += 1) {
      if (locked.has(line.companyId)) break;
      if (i >= 3)
        throw new GovernanceError('validation_failed', 'The line account kept moving; retry');
      await this.store.lockCompanies(tx, [line.companyId]);
      locked.add(line.companyId);
      line = await this.store.line(tx, lineId);
    }
    if (!line) return undefined;
    if (targets.lineage) await this.store.lockLineLineage(tx);
    await this.store.lockRows(tx, 'tenant_contracts', [targets.contract], 'share');
    await this.store.lockRows(tx, 'tenant_price_offers', [targets.offer], 'share');
    await this.store.lockRows(tx, 'tenant_subscriptions', [lineId, targets.predecessor]);
    return this.store.line(tx, lineId);
  }

  private async lineBySource(tx: TenantTransaction, ref: SourceRef): Promise<string | undefined> {
    const row = await tenantClient(tx).tenantSubscription.findFirst({
      where: {
        tenantId: tx.tenantId,
        sourceSystem: ref.system,
        sourceObjectType: ref.objectType,
        sourceRecordId: ref.id,
      },
      select: { id: true },
    });
    return row?.id;
  }

  // --- Operator entry (canonical.human_entry; audit commercial.line.reference) ----------

  @AuditFailures('commercial.line.reference', 'contract')
  assignContract(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorLineReference,
  ): Promise<{ readonly lineId: string; readonly changed: boolean }> {
    return this.operatorSet(actx, input, 'contractId');
  }

  @AuditFailures('commercial.line.reference', 'price_offer')
  assignPriceOffer(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorLineReference,
  ): Promise<{ readonly lineId: string; readonly changed: boolean }> {
    return this.operatorSet(actx, input, 'priceOfferId');
  }

  @AuditFailures('commercial.line.reference', 'contract')
  setSupersedes(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorLineReference,
  ): Promise<{ readonly lineId: string; readonly changed: boolean }> {
    return this.operatorSet(actx, input, 'supersedesLineId');
  }

  private async operatorSet(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorLineReference,
    attr: LineAttr,
  ): Promise<{ readonly lineId: string; readonly changed: boolean }> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const lineId = requireUuid(input.line, '--line');
    const target = input.target === null ? null : requireUuid(input.target, '--target');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireCommercial(tx, actx, this.store, this.moduleGate);
      const line = await this.lockLine(tx, lineId, {
        ...(attr === 'contractId' && target ? { contract: target } : {}),
        ...(attr === 'priceOfferId' && target ? { offer: target } : {}),
        ...(attr === 'supersedesLineId' && target ? { predecessor: target } : {}),
        lineage: attr === 'supersedesLineId',
      });
      if (!line) throw new GovernanceError('validation_failed', 'The line does not exist');
      const refuse = (code: string) => {
        throw new GovernanceError('validation_failed', `Refused: ${code}`, { code });
      };
      if (target !== null && target !== line[attr]) {
        if (attr === 'contractId') {
          const contract = await this.store.contract(tx, target);
          if (!contract) refuse('contract_unknown');
          if (contract!.companyId !== line.companyId) refuse('line_contract_company_mismatch');
        } else if (attr === 'priceOfferId') {
          const refusal = await this.offerRefusal(tx, line, target);
          if (refusal === 'unresolved') refuse('price_offer_unknown');
          if (refusal === 'product_mismatch') refuse('line_price_offer_product_mismatch');
          if (refusal === 'offer_retired') refuse('price_offer_retired');
        } else {
          if (target === line.id) refuse('line_lineage_cycle');
          const refusal = await this.lineageRefusal(tx, line, target);
          if (refusal === 'unresolved') refuse('line_unknown');
          if (refusal === 'lineage_cross_account') refuse('line_lineage_cross_account');
          if (refusal === 'lineage_cycle') refuse('line_lineage_cycle');
        }
      }
      const changed = await this.applyLine(
        tx,
        line,
        { [attr]: target },
        operatorProvenance(actx.actor, actx.correlationId, lineId),
        new Date(),
      );
      await this.audit.record(tx, actx, {
        action: 'commercial.line.reference',
        targetKind: attr === 'priceOfferId' ? 'price_offer' : 'contract',
        targetRef: target ?? lineId,
        details: {
          reason,
          line: lineId,
          reference: attr,
          cleared: target === null,
          changed,
        },
      });
      return { lineId, changed };
    });
  }

  /** Returns the line's held references to the source (Q17). */
  @AuditFailures('commercial.release', 'contract')
  async release(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: { readonly line: string; readonly reason: string },
  ): Promise<{ readonly lineId: string; readonly released: number }> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const lineId = requireUuid(input.line, '--line');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireCommercial(tx, actx, this.store, this.moduleGate);
      const line = await this.lockLine(tx, lineId, { lineage: false });
      if (!line) throw new GovernanceError('validation_failed', 'The line does not exist');
      const released = await releaseHold(
        tx,
        this.store,
        actx,
        'subscription',
        lineId,
        () => Promise.resolve(),
        LINE_REFERENCE_ATTRIBUTES,
      );
      await this.audit.record(tx, actx, {
        action: 'commercial.release',
        targetKind: 'contract',
        targetRef: lineId,
        details: { reason, kind: 'subscription', released },
      });
      return { lineId, released };
    });
  }
}

/** The `agreement_ref` CHECK shapes (bounded like the line source columns). */
export function agreementValid(ref: AgreementRef | null): boolean {
  if (ref === null) return true;
  return (
    /^[a-z][a-z0-9_]{0,63}$/.test(ref.system) &&
    /^[A-Za-z0-9_]{1,100}$/.test(ref.objectType) &&
    /^[A-Za-z0-9_.:-]{1,255}$/.test(ref.externalId)
  );
}
