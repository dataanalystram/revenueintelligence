import {
  BILLING_PERIOD_UNITS,
  CONTRACT_LINK_KINDS,
  CONTRACT_STATUSES,
  CURRENCY_PATTERN,
  ENTITLEMENT_STATUSES,
  PRICE_OFFER_STATUSES,
  PRICING_MODELS,
  type ContractLinkKind,
} from '../../domain';

/**
 * Pure rules of the M10F commercial writers (plan §5, §6.3; ADR 0032): shape
 * validation of price offers, contracts and entitlements (codes only; the
 * database CHECKs are the backstop), the human-hold derivation and the
 * source / operator attribute decision (Q17), and the contract-graph walk
 * (Q7, the writer's friendly first line under the `contract-graph` lock; the
 * trigger is the backstop). No I/O.
 *
 * Values are plain: timestamps as ISO strings, `renewal_date` as
 * `YYYY-MM-DD`, amounts as safe integers (minor units).
 */

/** The changed field a `release` change record carries (M10C / M10E pattern). */
export const COMMERCIAL_RELEASE_FIELD = 'humanOverride';

export type Plain = string | number | boolean | null;

export const PRICE_OFFER_ATTRIBUTES = [
  'productKey',
  'currency',
  'billingPeriod',
  'billingPeriodUnit',
  'pricingModel',
  'listAmountMinor',
  'status',
] as const;
export type PriceOfferAttribute = (typeof PRICE_OFFER_ATTRIBUTES)[number];
export type PriceOfferAttributes = {
  readonly productKey: string;
  readonly currency: string;
  readonly billingPeriod: number | null;
  readonly billingPeriodUnit: string | null;
  readonly pricingModel: string | null;
  readonly listAmountMinor: number | null;
  readonly status: string;
};

export const CONTRACT_ATTRIBUTES = [
  'contextId',
  'startsAt',
  'endsAt',
  'renewalDate',
  'autoRenew',
  'status',
  'totalValueMinor',
  'totalValueCurrency',
  'renewsContractId',
  'amendsContractId',
  'parentContractId',
] as const;
export type ContractAttribute = (typeof CONTRACT_ATTRIBUTES)[number];
export type ContractAttributes = {
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
};

/** The link attribute of each Contract → Contract link kind (Q6). */
export const LINK_ATTRIBUTE: Readonly<Record<ContractLinkKind, ContractAttribute>> = {
  renews: 'renewsContractId',
  amends: 'amendsContractId',
  parent: 'parentContractId',
};

export const ENTITLEMENT_ATTRIBUTES = [
  'productKey',
  'quantity',
  'status',
  'startsAt',
  'endsAt',
] as const;
export type EntitlementAttribute = (typeof ENTITLEMENT_ATTRIBUTES)[number];
export type EntitlementAttributes = {
  readonly productKey: string;
  readonly quantity: number | null;
  readonly status: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
};

/** Shape refusals (codes only; never a value). */
export type CommercialRejection =
  | 'currency_invalid'
  | 'billing_period_invalid'
  | 'billing_period_pair'
  | 'billing_period_unit_invalid'
  | 'pricing_model_invalid'
  | 'amount_invalid'
  | 'status_invalid'
  | 'period_invalid'
  | 'timestamp_invalid'
  | 'renewal_date_invalid'
  | 'money_pair'
  | 'quantity_invalid'
  | 'product_key_invalid';

const isAmount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isTimestamp = (v: string) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
export const PRODUCT_KEY = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

export function renewalDateValid(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The merged offer (current + incoming) must satisfy every CHECK. */
export function validatePriceOffer(a: PriceOfferAttributes): CommercialRejection | undefined {
  if (typeof a.productKey !== 'string' || !PRODUCT_KEY.test(a.productKey)) {
    return 'product_key_invalid';
  }
  if (typeof a.currency !== 'string' || !CURRENCY_PATTERN.test(a.currency)) {
    return 'currency_invalid';
  }
  if (a.billingPeriod !== null && !(Number.isSafeInteger(a.billingPeriod) && a.billingPeriod > 0)) {
    return 'billing_period_invalid';
  }
  if (
    a.billingPeriodUnit !== null &&
    !(BILLING_PERIOD_UNITS as readonly string[]).includes(a.billingPeriodUnit)
  ) {
    return 'billing_period_unit_invalid';
  }
  if ((a.billingPeriod === null) !== (a.billingPeriodUnit === null)) return 'billing_period_pair';
  if (a.pricingModel !== null && !(PRICING_MODELS as readonly string[]).includes(a.pricingModel)) {
    return 'pricing_model_invalid';
  }
  if (a.listAmountMinor !== null && !isAmount(a.listAmountMinor)) return 'amount_invalid';
  if (!(PRICE_OFFER_STATUSES as readonly string[]).includes(a.status)) return 'status_invalid';
  return undefined;
}

export function validateContract(a: ContractAttributes): CommercialRejection | undefined {
  if (!(CONTRACT_STATUSES as readonly string[]).includes(a.status)) return 'status_invalid';
  for (const t of [a.startsAt, a.endsAt]) {
    if (t !== null && !isTimestamp(t)) return 'timestamp_invalid';
  }
  if (a.startsAt !== null && a.endsAt !== null && Date.parse(a.endsAt) < Date.parse(a.startsAt)) {
    return 'period_invalid';
  }
  if (a.renewalDate !== null && !renewalDateValid(a.renewalDate)) return 'renewal_date_invalid';
  if ((a.totalValueMinor === null) !== (a.totalValueCurrency === null)) return 'money_pair';
  if (a.totalValueMinor !== null && !isAmount(a.totalValueMinor)) return 'amount_invalid';
  if (a.totalValueCurrency !== null && !CURRENCY_PATTERN.test(a.totalValueCurrency)) {
    return 'currency_invalid';
  }
  return undefined;
}

export function validateEntitlement(a: EntitlementAttributes): CommercialRejection | undefined {
  if (typeof a.productKey !== 'string' || !PRODUCT_KEY.test(a.productKey)) {
    return 'product_key_invalid';
  }
  if (a.quantity !== null && !(Number.isSafeInteger(a.quantity) && a.quantity >= 0)) {
    return 'quantity_invalid';
  }
  if (a.quantity !== null && a.quantity > 2_147_483_647) return 'quantity_invalid';
  if (!(ENTITLEMENT_STATUSES as readonly string[]).includes(a.status)) return 'status_invalid';
  for (const t of [a.startsAt, a.endsAt]) {
    if (t !== null && !isTimestamp(t)) return 'timestamp_invalid';
  }
  if (a.startsAt !== null && a.endsAt !== null && Date.parse(a.endsAt) < Date.parse(a.startsAt)) {
    return 'period_invalid';
  }
  return undefined;
}

/** A plain value's comparison form (timestamps compare by instant). */
export function samePlain(a: Plain | undefined, b: Plain | undefined): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string' && isTimestamp(a) && isTimestamp(b)) {
    return Date.parse(a) === Date.parse(b);
  }
  return false;
}

/** One change-record row's origin and fields (newest first). */
export interface ChangeOriginRow {
  readonly origin: string | null;
  readonly changedFields: readonly string[];
}

/**
 * The attributes an operator holds (Q17): the union of the attributes of
 * `human` changes newer than the newest release. `changes` is newest first.
 */
export function heldAttributes<A extends string>(
  changes: readonly ChangeOriginRow[],
  attributes: readonly A[],
): Set<A> {
  const held = new Set<A>();
  for (const c of changes) {
    if (c.origin !== 'human') continue;
    if (c.changedFields.includes(COMMERCIAL_RELEASE_FIELD)) break;
    for (const f of c.changedFields) {
      if ((attributes as readonly string[]).includes(f)) held.add(f as A);
    }
  }
  return held;
}

export interface AttributeDecision<A extends string> {
  readonly apply: Partial<Record<A, Plain>>;
  readonly changedFields: readonly A[];
  /** Held attributes whose source value differs (Q17, recorded as an issue). */
  readonly disagreements: readonly A[];
}

/**
 * Source writes (Q17): an attribute the operator holds is never overwritten;
 * a differing source value is a disagreement. `incoming` lists mapped
 * attributes only (undefined = unchanged).
 */
export function decideAttributes<A extends string>(
  current: Readonly<Record<A, Plain>>,
  incoming: Partial<Record<A, Plain>>,
  held: ReadonlySet<A> = new Set(),
): AttributeDecision<A> {
  const apply: Partial<Record<A, Plain>> = {};
  const changed: A[] = [];
  const disagreements: A[] = [];
  for (const key of Object.keys(incoming) as A[]) {
    const next = incoming[key];
    if (next === undefined) continue;
    if (samePlain(current[key], next)) continue;
    if (held.has(key)) {
      disagreements.push(key);
      continue;
    }
    apply[key] = next;
    changed.push(key);
  }
  return { apply, changedFields: changed, disagreements };
}

/** The contract links of one contract (ids, any kind). */
export type ContractGraph = ReadonlyMap<string, readonly string[]>;

/**
 * Q7: would linking `from` → `to` (any kind) close a cycle over the union of
 * the three link kinds? `graph` holds the current outgoing links (with the
 * proposed links of `from` already replacing its old ones is not required:
 * the walk starts at `to` and looks for `from`). Fails closed past the
 * ceiling (treated as a cycle).
 */
export function linkClosesCycle(
  graph: ContractGraph,
  from: string,
  to: string,
  ceiling = 64,
): boolean {
  if (from === to) return true;
  let frontier = [to];
  const seen = new Set(frontier);
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth > ceiling) return true;
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of graph.get(id) ?? []) {
        if (n === from) return true;
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return false;
}

export const LINK_KINDS = CONTRACT_LINK_KINDS;
