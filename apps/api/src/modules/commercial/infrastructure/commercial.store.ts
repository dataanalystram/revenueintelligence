import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  COMMERCIAL_LOCK_VALUE,
  COMMERCIAL_MIN_VERSION,
  COMMERCIAL_MODULE_KEY,
  CONTRACT_GRAPH_LOCK_SCOPE,
  LINE_LINEAGE_LOCK_SCOPE,
  compareCanonicalVersion,
  type CommercialEntityKind,
  type IdentityConflictKind,
  type SecurityActor,
} from '../../domain';
import {
  adoptedCanonicalVersion,
  insertContextChange,
  recordValueHistory,
  tenantAdvisoryLock,
  tenantClient,
  type ChangeWrite,
  type TenantTransaction,
  type ValueChange,
} from '../../tenancy';
import type {
  ContractAttributes,
  EntitlementAttributes,
  PriceOfferAttributes,
} from '../application/commercial.rules';

/**
 * Persistence of M10F Commercial (plan §3, §4, §5; ADR 0032): price offers,
 * contracts (with their three links), entitlements and the line commercial
 * references. Used only by the commercial writers, the line-reference step
 * and the merge participant. Every method takes an open tenant transaction
 * (forced RLS) and carries the tenant predicate. Identifiers and codes only —
 * never logged.
 *
 * Lock order (plan §4, Q16), held by every caller: the company advisory lock
 * (`company-canonical`, identity, as the merge takes it) → `contract-graph` →
 * `line-lineage` → contract rows (ascending id) → price-offer rows
 * (ascending id) → line rows (ascending id). No caller takes a contract lock
 * after a line lock.
 */

export type CommercialGateState = 'ok' | 'canonical_version_too_low' | 'module_disabled';

/** The advisory-lock scope of a canonical company (= the context module's `COMPANY_CANONICAL_LOCK_SCOPE`). */
export const COMPANY_LOCK_SCOPE = 'company-canonical';
/** The source-reference triple lock (= `SourceReferenceService`'s scope and key). */
export const SOURCE_REFERENCE_LOCK_SCOPE = 'source-reference';

export interface SourceRef {
  readonly system: string;
  readonly objectType: string;
  readonly id: string;
}

export interface PriceOfferRow extends PriceOfferAttributes {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ContractRow extends ContractAttributes {
  readonly id: string;
  readonly companyId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EntitlementRow extends EntitlementAttributes {
  readonly id: string;
  readonly companyId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LineCommercialRow {
  readonly id: string;
  readonly companyId: string;
  readonly productKey: string;
  readonly contractId: string | null;
  readonly priceOfferId: string | null;
  readonly supersedesLineId: string | null;
  readonly agreementRefSystem: string | null;
  readonly agreementRefObjectType: string | null;
  readonly agreementRefExternalId: string | null;
}

export interface CommercialIssueWrite {
  readonly kind: IdentityConflictKind;
  readonly entityKind: CommercialEntityKind | 'subscription';
  readonly identity: string;
  readonly canonicalIds: readonly string[];
  /** `system:objectType:id` references. */
  readonly externalRefs: readonly string[];
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const num = (b: bigint | null): number | null => (b === null ? null : Number(b));
const toDate = (v: string | null | undefined) =>
  v === undefined ? undefined : v === null ? null : new Date(v);
const toDay = (v: string | null | undefined) =>
  v === undefined ? undefined : v === null ? null : new Date(`${v}T00:00:00.000Z`);
const toBig = (v: number | null | undefined) =>
  v === undefined ? undefined : v === null ? null : BigInt(v);

const OFFER_SELECT = {
  id: true,
  productKey: true,
  currency: true,
  billingPeriod: true,
  billingPeriodUnit: true,
  pricingModel: true,
  listAmountMinor: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const CONTRACT_SELECT = {
  id: true,
  companyId: true,
  contextId: true,
  startsAt: true,
  endsAt: true,
  renewalDate: true,
  autoRenew: true,
  status: true,
  totalValueMinor: true,
  totalValueCurrency: true,
  renewsContractId: true,
  amendsContractId: true,
  parentContractId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ENTITLEMENT_SELECT = {
  id: true,
  companyId: true,
  productKey: true,
  quantity: true,
  status: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const LINE_SELECT = {
  id: true,
  companyId: true,
  productKey: true,
  contractId: true,
  priceOfferId: true,
  supersedesLineId: true,
  agreementRefSystem: true,
  agreementRefObjectType: true,
  agreementRefExternalId: true,
} as const;

function toOffer(r: {
  id: string;
  productKey: string;
  currency: string;
  billingPeriod: number | null;
  billingPeriodUnit: string | null;
  pricingModel: string | null;
  listAmountMinor: bigint | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): PriceOfferRow {
  return { ...r, listAmountMinor: num(r.listAmountMinor) };
}

function toContract(r: {
  id: string;
  companyId: string;
  contextId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  renewalDate: Date | null;
  autoRenew: boolean | null;
  status: string;
  totalValueMinor: bigint | null;
  totalValueCurrency: string | null;
  renewsContractId: string | null;
  amendsContractId: string | null;
  parentContractId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ContractRow {
  return {
    ...r,
    startsAt: iso(r.startsAt),
    endsAt: iso(r.endsAt),
    renewalDate: day(r.renewalDate),
    totalValueMinor: num(r.totalValueMinor),
  };
}

function toEntitlement(r: {
  id: string;
  companyId: string;
  productKey: string;
  quantity: number | null;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): EntitlementRow {
  return { ...r, startsAt: iso(r.startsAt), endsAt: iso(r.endsAt) };
}

@Injectable()
export class CommercialStore {
  // --- Gates (plan §11, Q2) ----------------------------------------------------

  /** Adopted ≥ 0.6 and module `commercial` enabled (no audit; callers decide). */
  async gate(tx: TenantTransaction): Promise<CommercialGateState> {
    if (!(await this.versionOk(tx))) return 'canonical_version_too_low';
    return (await this.moduleEnabled(tx, COMMERCIAL_MODULE_KEY)) ? 'ok' : 'module_disabled';
  }

  /** Adopted ≥ 0.6 (Core `agreement_ref`, Q2: module-independent). */
  async versionOk(tx: TenantTransaction): Promise<boolean> {
    return compareCanonicalVersion(await adoptedCanonicalVersion(tx), COMMERCIAL_MIN_VERSION) >= 0;
  }

  async moduleEnabled(tx: TenantTransaction, moduleKey: string): Promise<boolean> {
    const setting = await tenantClient(tx).tenantModuleSetting.findUnique({
      where: { tenantId_moduleKey: { tenantId: tx.tenantId, moduleKey } },
      select: { enabled: true },
    });
    return setting?.enabled ?? false;
  }

  // --- Locks (plan §4, Q16) ------------------------------------------------------

  /** Company advisory locks, sorted (identity; taken first, as the merge takes them). */
  async lockCompanies(tx: TenantTransaction, ids: readonly (string | null | undefined)[]) {
    for (const id of [...new Set(ids.filter((i): i is string => !!i))].sort()) {
      await tenantAdvisoryLock(tx, COMPANY_LOCK_SCOPE, id);
    }
  }

  /** The `SourceReferenceService` triple lock (re-entrant): one record per source triple. */
  lockSourceRef(tx: TenantTransaction, ref: SourceRef): Promise<void> {
    return tenantAdvisoryLock(
      tx,
      SOURCE_REFERENCE_LOCK_SCOPE,
      `${ref.system}\u0000${ref.objectType}\u0000${ref.id}`,
    );
  }

  lockContractGraph(tx: TenantTransaction): Promise<void> {
    return tenantAdvisoryLock(tx, CONTRACT_GRAPH_LOCK_SCOPE, COMMERCIAL_LOCK_VALUE);
  }

  lockLineLineage(tx: TenantTransaction): Promise<void> {
    return tenantAdvisoryLock(tx, LINE_LINEAGE_LOCK_SCOPE, COMMERCIAL_LOCK_VALUE);
  }

  /** Row locks, ascending id (`FOR UPDATE` or `FOR SHARE`). */
  async lockRows(
    tx: TenantTransaction,
    table:
      'tenant_contracts' | 'tenant_price_offers' | 'tenant_subscriptions' | 'tenant_entitlements',
    ids: readonly (string | null | undefined)[],
    mode: 'update' | 'share' = 'update',
  ): Promise<void> {
    const sorted = [...new Set(ids.filter((i): i is string => !!i))].sort();
    if (sorted.length === 0) return;
    // Table and mode come from the closed lists above (never input).
    await tenantClient(tx).$queryRawUnsafe(
      `SELECT id FROM ${table} WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR ${
        mode === 'update' ? 'UPDATE' : 'SHARE'
      }`,
      tx.tenantId,
      sorted,
    );
  }

  // --- Accounts and products ----------------------------------------------------

  async company(tx: TenantTransaction, id: string): Promise<{ recordState: string } | undefined> {
    const r = await tenantClient(tx).company.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: { recordState: true },
    });
    return r ?? undefined;
  }

  /** Product key → active, for the given keys (read-only; the products module owns the projection). */
  async products(tx: TenantTransaction, keys: readonly string[]): Promise<Map<string, boolean>> {
    if (keys.length === 0) return new Map();
    const rows = await tenantClient(tx).$queryRawUnsafe<{ key: string; active: boolean }[]>(
      'SELECT key, active FROM tenant_products WHERE tenant_id = $1::uuid AND key = ANY($2::text[])',
      tx.tenantId,
      [...new Set(keys)],
    );
    return new Map(rows.map((r) => [r.key, r.active]));
  }

  async contextCompany(
    tx: TenantTransaction,
    contextId: string,
  ): Promise<
    | { companyId: string; recordState: string; status: string; mergedIntoId: string | null }
    | undefined
  > {
    const r = await tenantClient(tx).tenantAccountContext.findFirst({
      where: { tenantId: tx.tenantId, id: contextId },
      select: { companyId: true, recordState: true, status: true, mergedIntoId: true },
    });
    return r ?? undefined;
  }

  // --- Source references ---------------------------------------------------------

  /** The entity a generic source reference of `kind` is bound to (undefined when none / another kind). */
  async entityForRef(
    tx: TenantTransaction,
    kind: CommercialEntityKind,
    ref: SourceRef,
  ): Promise<string | undefined> {
    const row = await tenantClient(tx).tenantSourceReference.findUnique({
      where: {
        tenantId_system_objectType_externalId: {
          tenantId: tx.tenantId,
          system: ref.system,
          objectType: ref.objectType,
          externalId: ref.id,
        },
      },
      select: { entityKind: true, entityId: true },
    });
    if (!row || row.entityKind !== kind || !row.entityId) return undefined;
    return row.entityId;
  }

  /**
   * M10F phase 2b: the canonical company of an account source reference
   * (`company_external_refs`), following merges (M10E `canonicalForRef` pattern).
   */
  async companyForRef(tx: TenantTransaction, ref: SourceRef): Promise<string | undefined> {
    const db = tenantClient(tx);
    let id = (
      await db.companyExternalRef.findFirst({
        where: {
          tenantId: tx.tenantId,
          system: ref.system,
          objectType: ref.objectType,
          externalId: ref.id,
        },
        select: { companyId: true },
      })
    )?.companyId;
    for (let hops = 0; id && hops < 20; hops += 1) {
      const row = await db.company.findFirst({
        where: { tenantId: tx.tenantId, id },
        select: { recordState: true, mergedIntoId: true },
      });
      if (!row || row.recordState !== 'merged' || !row.mergedIntoId) return id;
      id = row.mergedIntoId;
    }
    return id;
  }

  /** The account context a generic `account_context` source reference names, following merges. */
  async contextForRef(tx: TenantTransaction, ref: SourceRef): Promise<string | undefined> {
    const db = tenantClient(tx);
    const row = await db.tenantSourceReference.findUnique({
      where: {
        tenantId_system_objectType_externalId: {
          tenantId: tx.tenantId,
          system: ref.system,
          objectType: ref.objectType,
          externalId: ref.id,
        },
      },
      select: { entityKind: true, entityId: true },
    });
    let id = row?.entityKind === 'account_context' ? (row.entityId ?? undefined) : undefined;
    for (let hops = 0; id && hops < 20; hops += 1) {
      const ctx = await this.contextCompany(tx, id);
      if (!ctx || ctx.recordState !== 'merged' || !ctx.mergedIntoId) return id;
      id = ctx.mergedIntoId;
    }
    return id;
  }

  /**
   * Lines waiting for the contract an `agreement_ref` names (plan §6.3; index
   * `tenant_subscriptions_agreement_ref_idx`): active lines of the triple with
   * no contract yet, ascending id.
   */
  async linesAwaitingContract(
    tx: TenantTransaction,
    ref: SourceRef,
  ): Promise<
    { id: string; sourceSystem: string; sourceObjectType: string; sourceRecordId: string }[]
  > {
    return tenantClient(tx).tenantSubscription.findMany({
      where: {
        tenantId: tx.tenantId,
        agreementRefSystem: ref.system,
        agreementRefObjectType: ref.objectType,
        agreementRefExternalId: ref.id,
        contractId: null,
        recordState: 'active',
      },
      orderBy: { id: 'asc' },
      take: 5000,
      select: { id: true, sourceSystem: true, sourceObjectType: true, sourceRecordId: true },
    });
  }

  /**
   * Q14: other contracts of the same account over the same term, known through a
   * source reference of a different system (`contract_duplicate_source`).
   */
  async duplicateSourceContracts(
    tx: TenantTransaction,
    contract: { id: string; companyId: string; startsAt: string; endsAt: string },
    system: string,
  ): Promise<string[]> {
    const rows = await tenantClient(tx).$queryRawUnsafe<{ id: string }[]>(
      `SELECT c.id::text AS id FROM tenant_contracts c
        WHERE c.tenant_id = $1::uuid AND c.company_id = $2::uuid AND c.id <> $3::uuid
          AND c.starts_at = $4::timestamptz AND c.ends_at = $5::timestamptz
          AND EXISTS (SELECT 1 FROM tenant_source_references r
                       WHERE r.tenant_id = c.tenant_id AND r.entity_kind = 'contract'
                         AND r.entity_id = c.id AND r.system <> $6)
          AND NOT EXISTS (SELECT 1 FROM tenant_source_references r
                           WHERE r.tenant_id = c.tenant_id AND r.entity_kind = 'contract'
                             AND r.entity_id = c.id AND r.system = $6)
        ORDER BY c.id`,
      tx.tenantId,
      contract.companyId,
      contract.id,
      contract.startsAt,
      contract.endsAt,
      system,
    );
    return rows.map((r) => r.id);
  }

  // --- Price offers --------------------------------------------------------------

  async offer(tx: TenantTransaction, id: string): Promise<PriceOfferRow | undefined> {
    const r = await tenantClient(tx).tenantPriceOffer.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: OFFER_SELECT,
    });
    return r ? toOffer(r) : undefined;
  }

  async offers(tx: TenantTransaction, ids: readonly string[]): Promise<PriceOfferRow[]> {
    if (ids.length === 0) return [];
    const rows = await tenantClient(tx).tenantPriceOffer.findMany({
      where: { tenantId: tx.tenantId, id: { in: [...new Set(ids)] } },
      select: OFFER_SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map(toOffer);
  }

  async offerReferenced(tx: TenantTransaction, id: string): Promise<boolean> {
    const r = await tenantClient(tx).tenantSubscription.findFirst({
      where: { tenantId: tx.tenantId, priceOfferId: id },
      select: { id: true },
    });
    return !!r;
  }

  async insertOffer(tx: TenantTransaction, a: PriceOfferAttributes): Promise<string> {
    const id = randomUUID();
    await tenantClient(tx).tenantPriceOffer.create({
      data: {
        tenantId: tx.tenantId,
        id,
        productKey: a.productKey,
        currency: a.currency,
        billingPeriod: a.billingPeriod,
        billingPeriodUnit: a.billingPeriodUnit,
        pricingModel: a.pricingModel,
        listAmountMinor: toBig(a.listAmountMinor) ?? null,
        status: a.status,
      },
    });
    return id;
  }

  async updateOffer(
    tx: TenantTransaction,
    id: string,
    a: Partial<PriceOfferAttributes> & { readonly lastChangeId?: string },
  ): Promise<void> {
    const { listAmountMinor, ...rest } = a;
    await tenantClient(tx).tenantPriceOffer.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: {
        ...rest,
        ...(listAmountMinor !== undefined ? { listAmountMinor: toBig(listAmountMinor) } : {}),
      },
    });
  }

  // --- Contracts -----------------------------------------------------------------

  async contract(tx: TenantTransaction, id: string): Promise<ContractRow | undefined> {
    const r = await tenantClient(tx).tenantContract.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: CONTRACT_SELECT,
    });
    return r ? toContract(r) : undefined;
  }

  async contracts(tx: TenantTransaction, ids: readonly string[]): Promise<ContractRow[]> {
    if (ids.length === 0) return [];
    const rows = await tenantClient(tx).tenantContract.findMany({
      where: { tenantId: tx.tenantId, id: { in: [...new Set(ids)] } },
      select: CONTRACT_SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map(toContract);
  }

  async contractsOfCompanies(
    tx: TenantTransaction,
    companyIds: readonly string[],
  ): Promise<ContractRow[]> {
    if (companyIds.length === 0) return [];
    const rows = await tenantClient(tx).tenantContract.findMany({
      where: { tenantId: tx.tenantId, companyId: { in: [...new Set(companyIds)] } },
      select: CONTRACT_SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map(toContract);
  }

  /** The tenant's contract graph (outgoing links of every linked contract; read under `contract-graph`). */
  async contractGraph(tx: TenantTransaction): Promise<Map<string, string[]>> {
    const rows = await tenantClient(tx).tenantContract.findMany({
      where: {
        tenantId: tx.tenantId,
        OR: [
          { renewsContractId: { not: null } },
          { amendsContractId: { not: null } },
          { parentContractId: { not: null } },
        ],
      },
      select: { id: true, renewsContractId: true, amendsContractId: true, parentContractId: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        [r.renewsContractId, r.amendsContractId, r.parentContractId].filter(
          (x): x is string => !!x,
        ),
      ]),
    );
  }

  async insertContract(
    tx: TenantTransaction,
    companyId: string,
    a: ContractAttributes,
  ): Promise<string> {
    const id = randomUUID();
    await tenantClient(tx).tenantContract.create({
      data: {
        tenantId: tx.tenantId,
        id,
        companyId,
        contextId: a.contextId,
        startsAt: toDate(a.startsAt) ?? null,
        endsAt: toDate(a.endsAt) ?? null,
        renewalDate: toDay(a.renewalDate) ?? null,
        autoRenew: a.autoRenew,
        status: a.status,
        totalValueMinor: toBig(a.totalValueMinor) ?? null,
        totalValueCurrency: a.totalValueCurrency,
        renewsContractId: a.renewsContractId,
        amendsContractId: a.amendsContractId,
        parentContractId: a.parentContractId,
      },
    });
    return id;
  }

  /** Only the given columns are set (an unchanged link column is never in the SET list). */
  async updateContract(
    tx: TenantTransaction,
    id: string,
    a: Partial<ContractAttributes> & {
      readonly companyId?: string;
      readonly lastChangeId?: string;
    },
  ): Promise<void> {
    const { startsAt, endsAt, renewalDate, totalValueMinor, ...rest } = a;
    await tenantClient(tx).tenantContract.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: {
        ...rest,
        ...(startsAt !== undefined ? { startsAt: toDate(startsAt) } : {}),
        ...(endsAt !== undefined ? { endsAt: toDate(endsAt) } : {}),
        ...(renewalDate !== undefined ? { renewalDate: toDay(renewalDate) } : {}),
        ...(totalValueMinor !== undefined ? { totalValueMinor: toBig(totalValueMinor) } : {}),
      },
    });
  }

  // --- Entitlements --------------------------------------------------------------

  async entitlement(tx: TenantTransaction, id: string): Promise<EntitlementRow | undefined> {
    const r = await tenantClient(tx).tenantEntitlement.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: ENTITLEMENT_SELECT,
    });
    return r ? toEntitlement(r) : undefined;
  }

  async entitlementsOfCompanies(
    tx: TenantTransaction,
    companyIds: readonly string[],
  ): Promise<EntitlementRow[]> {
    if (companyIds.length === 0) return [];
    const rows = await tenantClient(tx).tenantEntitlement.findMany({
      where: { tenantId: tx.tenantId, companyId: { in: [...new Set(companyIds)] } },
      select: ENTITLEMENT_SELECT,
      orderBy: { id: 'asc' },
    });
    return rows.map(toEntitlement);
  }

  async insertEntitlement(
    tx: TenantTransaction,
    companyId: string,
    a: EntitlementAttributes,
  ): Promise<string> {
    const id = randomUUID();
    await tenantClient(tx).tenantEntitlement.create({
      data: {
        tenantId: tx.tenantId,
        id,
        companyId,
        productKey: a.productKey,
        quantity: a.quantity,
        status: a.status,
        startsAt: toDate(a.startsAt) ?? null,
        endsAt: toDate(a.endsAt) ?? null,
      },
    });
    return id;
  }

  async updateEntitlement(
    tx: TenantTransaction,
    id: string,
    a: Partial<EntitlementAttributes> & {
      readonly companyId?: string;
      readonly lastChangeId?: string;
    },
  ): Promise<void> {
    const { startsAt, endsAt, ...rest } = a;
    await tenantClient(tx).tenantEntitlement.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: {
        ...rest,
        ...(startsAt !== undefined ? { startsAt: toDate(startsAt) } : {}),
        ...(endsAt !== undefined ? { endsAt: toDate(endsAt) } : {}),
      },
    });
  }

  // --- Read models (bounded; `take` = bound + 1 so callers flag truncation) -------------

  async offersOfProducts(
    tx: TenantTransaction,
    productKeys: readonly string[],
    take: number,
  ): Promise<PriceOfferRow[]> {
    if (productKeys.length === 0) return [];
    const rows = await tenantClient(tx).tenantPriceOffer.findMany({
      where: { tenantId: tx.tenantId, productKey: { in: [...new Set(productKeys)] } },
      select: OFFER_SELECT,
      orderBy: [{ productKey: 'asc' }, { id: 'asc' }],
      take,
    });
    return rows.map(toOffer);
  }

  async contractsForRead(
    tx: TenantTransaction,
    companyIds: readonly string[],
    scope: readonly string[] | undefined,
    take: number,
  ): Promise<ContractRow[]> {
    if (companyIds.length === 0) return [];
    const rows = await tenantClient(tx).tenantContract.findMany({
      where: {
        tenantId: tx.tenantId,
        companyId: { in: [...new Set(companyIds)] },
        ...(scope ? { id: { in: [...new Set(scope)] } } : {}),
      },
      select: CONTRACT_SELECT,
      orderBy: [{ companyId: 'asc' }, { id: 'asc' }],
      take,
    });
    return rows.map(toContract);
  }

  async entitlementsForRead(
    tx: TenantTransaction,
    companyIds: readonly string[],
    take: number,
  ): Promise<EntitlementRow[]> {
    if (companyIds.length === 0) return [];
    const rows = await tenantClient(tx).tenantEntitlement.findMany({
      where: { tenantId: tx.tenantId, companyId: { in: [...new Set(companyIds)] } },
      select: ENTITLEMENT_SELECT,
      orderBy: [{ companyId: 'asc' }, { id: 'asc' }],
      take,
    });
    return rows.map(toEntitlement);
  }

  /** Contracts whose renews / amends / parent link names `id` (incoming links). */
  async contractsLinkingTo(
    tx: TenantTransaction,
    id: string,
    take: number,
  ): Promise<
    {
      id: string;
      renewsContractId: string | null;
      amendsContractId: string | null;
      parentContractId: string | null;
    }[]
  > {
    return tenantClient(tx).tenantContract.findMany({
      where: {
        tenantId: tx.tenantId,
        OR: [{ renewsContractId: id }, { amendsContractId: id }, { parentContractId: id }],
      },
      select: { id: true, renewsContractId: true, amendsContractId: true, parentContractId: true },
      orderBy: { id: 'asc' },
      take,
    });
  }

  async linesOfContract(
    tx: TenantTransaction,
    contractId: string,
    take: number,
  ): Promise<
    {
      id: string;
      companyId: string;
      productKey: string;
      state: string;
      priceOfferId: string | null;
      supersedesLineId: string | null;
    }[]
  > {
    return tenantClient(tx).tenantSubscription.findMany({
      where: { tenantId: tx.tenantId, contractId },
      select: {
        id: true,
        companyId: true,
        productKey: true,
        state: true,
        priceOfferId: true,
        supersedesLineId: true,
      },
      orderBy: { id: 'asc' },
      take,
    });
  }

  // --- Lines ---------------------------------------------------------------------

  async line(tx: TenantTransaction, id: string): Promise<LineCommercialRow | undefined> {
    const r = await tenantClient(tx).tenantSubscription.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: LINE_SELECT,
    });
    return r ?? undefined;
  }

  /** The line's predecessor chain would reach `lineId` (Q11; read under `line-lineage`). */
  async lineageReaches(
    tx: TenantTransaction,
    from: string,
    lineId: string,
    ceiling = 64,
  ): Promise<boolean> {
    let cur: string | null = from;
    for (let steps = 0; cur; steps += 1) {
      if (cur === lineId || steps > ceiling) return true;
      const row: { supersedesLineId: string | null } | null = await tenantClient(
        tx,
      ).tenantSubscription.findFirst({
        where: { tenantId: tx.tenantId, id: cur },
        select: { supersedesLineId: true },
      });
      cur = row?.supersedesLineId ?? null;
    }
    return false;
  }

  async updateLine(
    tx: TenantTransaction,
    id: string,
    data: {
      readonly contractId?: string | null;
      readonly priceOfferId?: string | null;
      readonly supersedesLineId?: string | null;
      readonly agreementRefSystem?: string | null;
      readonly agreementRefObjectType?: string | null;
      readonly agreementRefExternalId?: string | null;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantSubscription.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data,
    });
  }

  // --- Change records, value history, issues ------------------------------------------

  insertChange(tx: TenantTransaction, change: ChangeWrite): Promise<string> {
    return insertContextChange(tx, change);
  }

  valueHistory(
    tx: TenantTransaction,
    input: {
      readonly entityKind: CommercialEntityKind | 'subscription';
      readonly entityId: string;
      readonly changeId: string;
      readonly effectiveAt: Date;
      readonly actor?: SecurityActor;
      readonly changes: readonly ValueChange[];
    },
  ): Promise<number> {
    return recordValueHistory(tx, input);
  }

  /** The newest `human` change records of an entity (Q17 hold derivation), newest first. */
  humanChanges(
    tx: TenantTransaction,
    entityKind: CommercialEntityKind | 'subscription',
    entityId: string,
  ): Promise<{ origin: string | null; changedFields: string[] }[]> {
    return tenantClient(tx).tenantContextChange.findMany({
      where: { tenantId: tx.tenantId, entityKind, entityId, origin: 'human' },
      orderBy: [{ ingestedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: { origin: true, changedFields: true },
    });
  }

  static issueKey(kind: string, identity: string): string {
    return createHash('sha256').update(`${kind}|${identity}`).digest('hex');
  }

  async recordIssue(tx: TenantTransaction, issue: CommercialIssueWrite): Promise<void> {
    const conflictKey = CommercialStore.issueKey(issue.kind, issue.identity);
    const canonicalIds = [...new Set(issue.canonicalIds)].sort();
    const externalRefs = [...new Set(issue.externalRefs)].sort();
    await tenantClient(tx).tenantIdentityConflict.upsert({
      where: { tenantId_conflictKey: { tenantId: tx.tenantId, conflictKey } },
      create: {
        tenantId: tx.tenantId,
        id: randomUUID(),
        kind: issue.kind,
        entityKind: issue.entityKind,
        conflictKey,
        canonicalIds,
        externalRefs,
      },
      update: {
        canonicalIds,
        externalRefs,
        state: 'open',
        resolvedAt: null,
        updatedAt: new Date(),
      },
    });
  }

  async resolveIssue(
    tx: TenantTransaction,
    kind: IdentityConflictKind,
    identity: string,
  ): Promise<void> {
    const now = new Date();
    await tenantClient(tx).tenantIdentityConflict.updateMany({
      where: {
        tenantId: tx.tenantId,
        conflictKey: CommercialStore.issueKey(kind, identity),
        state: 'open',
      },
      data: { state: 'resolved', resolvedAt: now, updatedAt: now },
    });
  }
}
