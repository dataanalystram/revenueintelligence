import { Injectable } from '@nestjs/common';
import { CodeSchema, type AuditTargetKind, type Sensitivity } from '../../domain';
import { GovernanceError } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  TenantDatabase,
  WriteAuthorizer,
  type AuthorizedContext,
} from '../../tenancy';
import {
  CommercialStore,
  type ContractRow,
  type EntitlementRow,
  type PriceOfferRow,
} from '../infrastructure/commercial.store';
import { requireUuid } from './commercial.shared';

/** Rows per call (offers, contracts, entitlements, lines); more is flagged `truncated`, never silently cut. */
export const COMMERCIAL_READ_BOUND = 1000;
/** Accounts / product keys per batch call (plan §10). */
export const COMMERCIAL_READ_BATCH = 500;
/** Attribute keys listed on a confidential read's audit event (keys only, never values). */
const RELEASED_KEYS_MAX = 50;
/** Plan §16 (Q22): the capability an `includeConfidential` read needs on top of the read. */
export const COMMERCIAL_CONFIDENTIAL_CAPABILITY = 'data.commercial.read_confidential';

type ReadSensitivity = Sensitivity;

/**
 * The classification of every attribute a commercial view carries (plan §7; equal to
 * the classification manifest's sensitivity of the backing column — asserted by
 * `commercial.read-model.spec.ts`). Every result carries it so a later role model can
 * hide more. `confidential` attributes are withheld unless `includeConfidential` with
 * the explicit grant; a `restricted` attribute would never be released (none exists:
 * restricted values are never stored, tech debt #15).
 */
export const COMMERCIAL_VIEW_CLASSIFICATION = {
  price_offer: {
    productKey: { column: 'product_key', sensitivity: 'internal' },
    currency: { column: 'currency', sensitivity: 'internal' },
    billingPeriod: { column: 'billing_period', sensitivity: 'internal' },
    billingPeriodUnit: { column: 'billing_period_unit', sensitivity: 'internal' },
    pricingModel: { column: 'pricing_model', sensitivity: 'internal' },
    listAmountMinor: { column: 'list_amount_minor', sensitivity: 'confidential' },
    status: { column: 'status', sensitivity: 'internal' },
  },
  contract: {
    companyId: { column: 'company_id', sensitivity: 'internal' },
    contextId: { column: 'context_id', sensitivity: 'internal' },
    startsAt: { column: 'starts_at', sensitivity: 'internal' },
    endsAt: { column: 'ends_at', sensitivity: 'internal' },
    renewalDate: { column: 'renewal_date', sensitivity: 'confidential' },
    autoRenew: { column: 'auto_renew', sensitivity: 'internal' },
    status: { column: 'status', sensitivity: 'internal' },
    totalValueMinor: { column: 'total_value_minor', sensitivity: 'confidential' },
    totalValueCurrency: { column: 'total_value_currency', sensitivity: 'confidential' },
    renewsContractId: { column: 'renews_contract_id', sensitivity: 'internal' },
    amendsContractId: { column: 'amends_contract_id', sensitivity: 'internal' },
    parentContractId: { column: 'parent_contract_id', sensitivity: 'internal' },
  },
  entitlement: {
    companyId: { column: 'company_id', sensitivity: 'internal' },
    productKey: { column: 'product_key', sensitivity: 'internal' },
    quantity: { column: 'quantity', sensitivity: 'internal' },
    status: { column: 'status', sensitivity: 'internal' },
    startsAt: { column: 'starts_at', sensitivity: 'internal' },
    endsAt: { column: 'ends_at', sensitivity: 'internal' },
  },
} as const satisfies Record<
  string,
  Record<string, { readonly column: string; readonly sensitivity: ReadSensitivity }>
>;

type ViewEntity = keyof typeof COMMERCIAL_VIEW_CLASSIFICATION;
type Classification<E extends ViewEntity> = {
  readonly [K in keyof (typeof COMMERCIAL_VIEW_CLASSIFICATION)[E]]: ReadSensitivity;
};

const classificationOf = <E extends ViewEntity>(entity: E): Classification<E> =>
  Object.fromEntries(
    Object.entries(
      COMMERCIAL_VIEW_CLASSIFICATION[entity] as Readonly<
        Record<string, { readonly sensitivity: ReadSensitivity }>
      >,
    ).map(([k, v]) => [k, v.sensitivity]),
  ) as Classification<E>;

const CLASSIFICATION = {
  price_offer: classificationOf('price_offer'),
  contract: classificationOf('contract'),
  entitlement: classificationOf('entitlement'),
};

interface Redacted {
  /** Attributes withheld from this read (keys only). */
  readonly withheld: readonly string[];
}

export interface PriceOfferView extends Redacted {
  readonly id: string;
  readonly productKey: string;
  readonly currency: string;
  readonly billingPeriod: number | null;
  readonly billingPeriodUnit: string | null;
  readonly pricingModel: string | null;
  readonly listAmountMinor: number | null;
  readonly status: string;
  readonly classification: Classification<'price_offer'>;
}

export interface ContractView extends Redacted {
  readonly id: string;
  readonly companyId: string;
  readonly contextId: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly renewalDate: string | null;
  readonly autoRenew: boolean | null;
  readonly status: string;
  readonly totalValueMinor: number | null;
  readonly totalValueCurrency: string | null;
  readonly renewsContractId: string | null;
  readonly amendsContractId: string | null;
  readonly parentContractId: string | null;
  readonly classification: Classification<'contract'>;
}

export interface ContractDetail extends ContractView {
  /** Contracts linking to this one (`renews` / `amends` / `parent` of theirs). */
  readonly linkedFrom: readonly { readonly contractId: string; readonly kind: string }[];
  readonly lineIds: readonly string[];
  readonly linesTruncated: boolean;
}

export interface EntitlementView extends Redacted {
  readonly id: string;
  readonly companyId: string;
  readonly productKey: string;
  readonly quantity: number | null;
  readonly status: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly classification: Classification<'entitlement'>;
}

export interface ContractLineList {
  readonly contractId: string;
  readonly lines: readonly {
    readonly id: string;
    readonly companyId: string;
    readonly productKey: string;
    readonly state: string;
    readonly priceOfferId: string | null;
    readonly supersedesLineId: string | null;
  }[];
  readonly truncated: boolean;
}

type Assembled<V> = { view: V; confidentialKeys: string[] };

/**
 * Read models of M10F Commercial (plan §10, §16; ADR 0032): price offers of a
 * batch of products, contracts of a batch of accounts (optional `scope` =
 * contract ids, the future authorization hook), one contract with its links
 * and line ids, the lines of a contract, entitlements of a batch of accounts,
 * one price offer / entitlement. Batch ≤ 500 keys, ≤ 1000 rows (more flagged
 * `truncated`); a constant number of queries per call. Reads are allowed
 * whatever the gate says (Q19 / Q20: data kept and readable).
 *
 * Each call writes exactly one `commercial.read` audit event (capability
 * `data.commercial.read`, operator only; identifiers and counts, never values).
 * Confidential attributes (`listAmountMinor`, `totalValueMinor`,
 * `totalValueCurrency`, `renewalDate`) are withheld by default and named in
 * `withheld`. `includeConfidential: true` is authorized here, for the read's
 * own actor and tenant, against `data.commercial.read_confidential` (held by
 * no actor kind; only through an explicit tenant grant, the #90 path): without
 * it the read is refused (AuthorizationDeniedError, one `denied` audit event
 * naming that capability) — never silently redacted; with it the read's single
 * audit event names that capability, `includeConfidential: true` and the
 * released attribute keys (never values). Restricted attributes are never
 * released.
 */
@Injectable()
export class CommercialReadModel {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: CommercialStore,
    readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
  ) {}

  /** Plan §16: the confidential widening for the read's own actor and tenant (denied audit + throw without it). */
  private async confidential(
    actx: AuthorizedContext<'data.commercial.read'>,
    include: boolean | undefined,
    entry: {
      readonly operation: string;
      readonly targetKind: AuditTargetKind;
      readonly targetRef: string;
    },
  ): Promise<AuthorizedContext<'data.commercial.read_confidential'> | undefined> {
    if (include !== true) return undefined;
    return this.authorizer.authorize(actx.tenant, actx.actor, COMMERCIAL_CONFIDENTIAL_CAPABILITY, {
      action: 'commercial.read',
      targetKind: entry.targetKind,
      targetRef: entry.targetRef,
      details: { operation: entry.operation, includeConfidential: true },
      correlationId: actx.correlationId,
    });
  }

  @AuditFailures('commercial.read', 'price_offer')
  async priceOffersForProducts(
    actx: AuthorizedContext<'data.commercial.read'>,
    query: { readonly productKeys: readonly string[]; readonly includeConfidential?: boolean },
  ): Promise<{ readonly priceOffers: readonly PriceOfferView[]; readonly truncated: boolean }> {
    assertAuthorized(actx, 'data.commercial.read');
    const keys = batch(query.productKeys, '--product', (k) => requireKey(k));
    const targetRef = keys.length === 1 ? keys[0]! : 'products';
    const confidential = await this.confidential(actx, query.includeConfidential, {
      operation: 'list',
      targetKind: 'price_offer',
      targetRef,
    });
    return this.db.transaction(actx.tenant, async (tx) => {
      const rows = await this.store.offersOfProducts(tx, keys, COMMERCIAL_READ_BOUND + 1);
      const truncated = rows.length > COMMERCIAL_READ_BOUND;
      const assembled = rows
        .slice(0, COMMERCIAL_READ_BOUND)
        .map((r) => offerView(r, confidential !== undefined));
      await this.audit.record(tx, confidential ?? actx, {
        action: 'commercial.read',
        targetKind: 'price_offer',
        targetRef,
        details: {
          operation: 'list',
          products: keys.length,
          priceOffers: assembled.length,
          truncated,
          ...confidentialDetails(assembled, confidential !== undefined),
        },
      });
      return { priceOffers: assembled.map((a) => a.view), truncated };
    });
  }

  @AuditFailures('commercial.read', 'price_offer')
  async priceOffer(
    actx: AuthorizedContext<'data.commercial.read'>,
    query: { readonly priceOfferId: string; readonly includeConfidential?: boolean },
  ): Promise<PriceOfferView> {
    assertAuthorized(actx, 'data.commercial.read');
    const id = requireUuid(query.priceOfferId, '--price-offer');
    const confidential = await this.confidential(actx, query.includeConfidential, {
      operation: 'show',
      targetKind: 'price_offer',
      targetRef: id,
    });
    return this.db.transaction(actx.tenant, async (tx) => {
      const row = await this.store.offer(tx, id);
      if (!row) throw new GovernanceError('validation_failed', 'The price offer does not exist');
      const assembled = offerView(row, confidential !== undefined);
      await this.audit.record(tx, confidential ?? actx, {
        action: 'commercial.read',
        targetKind: 'price_offer',
        targetRef: id,
        details: {
          operation: 'show',
          ...confidentialDetails([assembled], confidential !== undefined),
        },
      });
      return assembled.view;
    });
  }

  @AuditFailures('commercial.read', 'contract')
  async contractsForAccounts(
    actx: AuthorizedContext<'data.commercial.read'>,
    query: {
      readonly companyIds: readonly string[];
      readonly scope?: readonly string[];
      readonly includeConfidential?: boolean;
    },
  ): Promise<{ readonly contracts: readonly ContractView[]; readonly truncated: boolean }> {
    assertAuthorized(actx, 'data.commercial.read');
    const companyIds = batch(query.companyIds, '--account', (id) => requireUuid(id, '--account'));
    const scope = query.scope?.map((id) => requireUuid(id, '--scope'));
    const targetRef = companyIds.length === 1 ? companyIds[0]! : 'accounts';
    const confidential = await this.confidential(actx, query.includeConfidential, {
      operation: 'list',
      targetKind: 'contract',
      targetRef,
    });
    return this.db.transaction(actx.tenant, async (tx) => {
      const rows = await this.store.contractsForRead(
        tx,
        companyIds,
        scope,
        COMMERCIAL_READ_BOUND + 1,
      );
      const truncated = rows.length > COMMERCIAL_READ_BOUND;
      const assembled = rows
        .slice(0, COMMERCIAL_READ_BOUND)
        .map((r) => contractView(r, confidential !== undefined));
      await this.audit.record(tx, confidential ?? actx, {
        action: 'commercial.read',
        targetKind: 'contract',
        targetRef,
        details: {
          operation: 'list',
          accounts: companyIds.length,
          scoped: scope !== undefined,
          contracts: assembled.length,
          truncated,
          ...confidentialDetails(assembled, confidential !== undefined),
        },
      });
      return { contracts: assembled.map((a) => a.view), truncated };
    });
  }

  @AuditFailures('commercial.read', 'contract')
  async contract(
    actx: AuthorizedContext<'data.commercial.read'>,
    query: { readonly contractId: string; readonly includeConfidential?: boolean },
  ): Promise<ContractDetail> {
    assertAuthorized(actx, 'data.commercial.read');
    const id = requireUuid(query.contractId, '--contract');
    const confidential = await this.confidential(actx, query.includeConfidential, {
      operation: 'show',
      targetKind: 'contract',
      targetRef: id,
    });
    return this.db.transaction(actx.tenant, async (tx) => {
      const row = await this.store.contract(tx, id);
      if (!row) throw new GovernanceError('validation_failed', 'The contract does not exist');
      const assembled = contractView(row, confidential !== undefined);
      const incoming = await this.store.contractsLinkingTo(tx, id, COMMERCIAL_READ_BOUND);
      const lines = await this.store.linesOfContract(tx, id, COMMERCIAL_READ_BOUND + 1);
      const linesTruncated = lines.length > COMMERCIAL_READ_BOUND;
      const linkedFrom = incoming.flatMap((c) => [
        ...(c.renewsContractId === id ? [{ contractId: c.id, kind: 'renews' }] : []),
        ...(c.amendsContractId === id ? [{ contractId: c.id, kind: 'amends' }] : []),
        ...(c.parentContractId === id ? [{ contractId: c.id, kind: 'parent' }] : []),
      ]);
      const detail: ContractDetail = {
        ...assembled.view,
        linkedFrom,
        lineIds: lines.slice(0, COMMERCIAL_READ_BOUND).map((l) => l.id),
        linesTruncated,
      };
      await this.audit.record(tx, confidential ?? actx, {
        action: 'commercial.read',
        targetKind: 'contract',
        targetRef: id,
        details: {
          operation: 'show',
          linkedFrom: linkedFrom.length,
          lines: detail.lineIds.length,
          truncated: linesTruncated,
          ...confidentialDetails([assembled], confidential !== undefined),
        },
      });
      return detail;
    });
  }

  @AuditFailures('commercial.read', 'contract')
  async linesForContract(
    actx: AuthorizedContext<'data.commercial.read'>,
    query: { readonly contractId: string },
  ): Promise<ContractLineList> {
    assertAuthorized(actx, 'data.commercial.read');
    const id = requireUuid(query.contractId, '--contract');
    return this.db.transaction(actx.tenant, async (tx) => {
      if (!(await this.store.contract(tx, id))) {
        throw new GovernanceError('validation_failed', 'The contract does not exist');
      }
      const rows = await this.store.linesOfContract(tx, id, COMMERCIAL_READ_BOUND + 1);
      const truncated = rows.length > COMMERCIAL_READ_BOUND;
      const lines = rows.slice(0, COMMERCIAL_READ_BOUND);
      await this.audit.record(tx, actx, {
        action: 'commercial.read',
        targetKind: 'contract',
        targetRef: id,
        details: { operation: 'lines', lines: lines.length, truncated },
      });
      return { contractId: id, lines, truncated };
    });
  }

  @AuditFailures('commercial.read', 'entitlement')
  async entitlementsForAccounts(
    actx: AuthorizedContext<'data.commercial.read'>,
    query: { readonly companyIds: readonly string[]; readonly includeConfidential?: boolean },
  ): Promise<{ readonly entitlements: readonly EntitlementView[]; readonly truncated: boolean }> {
    assertAuthorized(actx, 'data.commercial.read');
    const companyIds = batch(query.companyIds, '--account', (id) => requireUuid(id, '--account'));
    const targetRef = companyIds.length === 1 ? companyIds[0]! : 'accounts';
    // Entitlements carry no confidential attribute; the widening is still authorized
    // (refused without the grant) so the flag never means something weaker here.
    const confidential = await this.confidential(actx, query.includeConfidential, {
      operation: 'list',
      targetKind: 'entitlement',
      targetRef,
    });
    return this.db.transaction(actx.tenant, async (tx) => {
      const rows = await this.store.entitlementsForRead(tx, companyIds, COMMERCIAL_READ_BOUND + 1);
      const truncated = rows.length > COMMERCIAL_READ_BOUND;
      const assembled = rows
        .slice(0, COMMERCIAL_READ_BOUND)
        .map((r) => entitlementView(r, confidential !== undefined));
      await this.audit.record(tx, confidential ?? actx, {
        action: 'commercial.read',
        targetKind: 'entitlement',
        targetRef,
        details: {
          operation: 'list',
          accounts: companyIds.length,
          entitlements: assembled.length,
          truncated,
          ...confidentialDetails(assembled, confidential !== undefined),
        },
      });
      return { entitlements: assembled.map((a) => a.view), truncated };
    });
  }

  @AuditFailures('commercial.read', 'entitlement')
  async entitlement(
    actx: AuthorizedContext<'data.commercial.read'>,
    query: { readonly entitlementId: string; readonly includeConfidential?: boolean },
  ): Promise<EntitlementView> {
    assertAuthorized(actx, 'data.commercial.read');
    const id = requireUuid(query.entitlementId, '--entitlement');
    const confidential = await this.confidential(actx, query.includeConfidential, {
      operation: 'show',
      targetKind: 'entitlement',
      targetRef: id,
    });
    return this.db.transaction(actx.tenant, async (tx) => {
      const row = await this.store.entitlement(tx, id);
      if (!row) throw new GovernanceError('validation_failed', 'The entitlement does not exist');
      const assembled = entitlementView(row, confidential !== undefined);
      await this.audit.record(tx, confidential ?? actx, {
        action: 'commercial.read',
        targetKind: 'entitlement',
        targetRef: id,
        details: {
          operation: 'show',
          ...confidentialDetails([assembled], confidential !== undefined),
        },
      });
      return assembled.view;
    });
  }
}

function requireKey(value: string): string {
  if (!CodeSchema.safeParse(value).success) {
    throw new GovernanceError('validation_failed', '--product must be a product key');
  }
  return value;
}

function batch(values: readonly string[], what: string, check: (v: string) => string): string[] {
  const out = [...new Set(values.map(check))];
  if (out.length === 0 || out.length > COMMERCIAL_READ_BATCH) {
    throw new GovernanceError(
      'validation_failed',
      `Name 1–${COMMERCIAL_READ_BATCH} ${what} values`,
    );
  }
  return out;
}

/**
 * Applies the classification: a `restricted` attribute is never released; a
 * `confidential` one with a value is withheld (value null, key in `withheld`) unless
 * `include`; `confidentialKeys` are the confidential attributes holding a value
 * (released on an `include` read — keys only).
 */
function redact<T extends Record<string, unknown>>(
  row: T,
  classification: Readonly<Record<string, ReadSensitivity>>,
  include: boolean,
): { values: T; withheld: string[]; confidentialKeys: string[] } {
  const values: Record<string, unknown> = { ...row };
  const withheld: string[] = [];
  const confidentialKeys: string[] = [];
  for (const [key, sensitivity] of Object.entries(classification)) {
    if (values[key] === null || values[key] === undefined) continue;
    if (sensitivity === 'restricted' || (sensitivity === 'confidential' && !include)) {
      values[key] = null;
      withheld.push(key);
    }
    if (sensitivity === 'confidential') confidentialKeys.push(key);
  }
  return { values: values as T, withheld, confidentialKeys };
}

function offerView(r: PriceOfferRow, include: boolean): Assembled<PriceOfferView> {
  const { values, withheld, confidentialKeys } = redact(
    {
      productKey: r.productKey,
      currency: r.currency,
      billingPeriod: r.billingPeriod,
      billingPeriodUnit: r.billingPeriodUnit,
      pricingModel: r.pricingModel,
      listAmountMinor: r.listAmountMinor,
      status: r.status,
    },
    CLASSIFICATION.price_offer,
    include,
  );
  return {
    view: { id: r.id, ...values, withheld, classification: CLASSIFICATION.price_offer },
    confidentialKeys: confidentialKeys.map((k) => `price_offer.${k}`),
  };
}

function contractView(r: ContractRow, include: boolean): Assembled<ContractView> {
  const { values, withheld, confidentialKeys } = redact(
    {
      companyId: r.companyId,
      contextId: r.contextId,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      renewalDate: r.renewalDate,
      autoRenew: r.autoRenew,
      status: r.status,
      totalValueMinor: r.totalValueMinor,
      totalValueCurrency: r.totalValueCurrency,
      renewsContractId: r.renewsContractId,
      amendsContractId: r.amendsContractId,
      parentContractId: r.parentContractId,
    },
    CLASSIFICATION.contract,
    include,
  );
  return {
    view: { id: r.id, ...values, withheld, classification: CLASSIFICATION.contract },
    confidentialKeys: confidentialKeys.map((k) => `contract.${k}`),
  };
}

function entitlementView(r: EntitlementRow, include: boolean): Assembled<EntitlementView> {
  const { values, withheld, confidentialKeys } = redact(
    {
      companyId: r.companyId,
      productKey: r.productKey,
      quantity: r.quantity,
      status: r.status,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
    },
    CLASSIFICATION.entitlement,
    include,
  );
  return {
    view: { id: r.id, ...values, withheld, classification: CLASSIFICATION.entitlement },
    confidentialKeys: confidentialKeys.map((k) => `entitlement.${k}`),
  };
}

/**
 * The audit details of the widening: `includeConfidential` always; on a confidential
 * read the released attribute keys (distinct, sorted, at most RELEASED_KEYS_MAX; keys
 * only, never values).
 */
function confidentialDetails(
  assembled: readonly { readonly confidentialKeys: readonly string[] }[],
  include: boolean,
): { includeConfidential: boolean; releasedKeys?: string[]; releasedKeysTruncated?: boolean } {
  if (!include) return { includeConfidential: false };
  const keys = [...new Set(assembled.flatMap((a) => a.confidentialKeys))].sort();
  return {
    includeConfidential: true,
    releasedKeys: keys.slice(0, RELEASED_KEYS_MAX),
    releasedKeysTruncated: keys.length > RELEASED_KEYS_MAX,
  };
}
