import type { CustomerStatus } from './company';
import type { ProductKey } from './product';
import type { IndexedProductModel, ProductDefinition } from './product-model';
import { canonicalHash } from './shared/canonical-json';
import type { CompanyId } from './shared/ids';
import type { OwnableState, SubscriptionFact } from './subscription';

/**
 * Eligibility and whitespace (ADR 0018). Pure and deterministic: no I/O, no
 * clock (`asOf` is always an input). Every check is always evaluated, so the
 * explanation is complete; precedence is fail > unknown > eligible.
 */

/**
 * Bumped whenever built-in check semantics change. Recorded on every result.
 * 2 (M8): per-account ownership gaps (`ownership_incomplete`).
 */
export const EVALUATOR_VERSION = 2;

export type EligibilityStatus = 'eligible' | 'ineligible' | 'unknown';
export type OwnershipStatus = 'owned' | 'not_owned' | 'unknown';
export type CheckOutcome = 'pass' | 'fail' | 'unknown' | 'not_applicable';

export type CheckCode =
  | 'ownership_coverage'
  | 'product_available'
  | 'not_already_owned'
  | 'not_superseded'
  | 'not_excluded'
  | 'requirements_met'
  | 'account_attribute';

export type ReasonCode =
  | 'ok'
  | 'not_applicable'
  | 'ownership_not_loaded'
  /** The account holds a line whose product cannot be known (M8 ownership gap). */
  | 'ownership_incomplete'
  | 'subscription_state_unknown'
  | 'subscription_state_conflict'
  | 'attribute_missing'
  | 'product_retired'
  | 'product_not_available'
  | 'already_owned'
  | 'superseded_by_owned'
  | 'excluded_by_owned'
  | 'requirement_unmet'
  | 'condition_not_met';

export type FactRef =
  | { readonly kind: 'subscription'; readonly id: string; readonly productKey: ProductKey }
  | { readonly kind: 'product'; readonly key: ProductKey; readonly via?: 'includes' }
  | { readonly kind: 'attribute'; readonly name: string; readonly value: string | null };

export interface EligibilityCheck {
  readonly check: CheckCode;
  readonly ruleId?: string;
  readonly outcome: CheckOutcome;
  readonly reason: ReasonCode;
  readonly facts: readonly FactRef[];
}

export type OwnershipInput =
  | {
      readonly coverage: 'known';
      readonly knownAsOf: Date;
      readonly subscriptions: readonly SubscriptionFact[];
    }
  | {
      readonly coverage: 'unknown';
      /**
       * Why ownership is not known: the tenant's facts are not loaded (default)
       * or this account has an ownership gap (ADR 0020 §15). Tenant-level
       * `ownership_not_loaded` and account-level `ownership_incomplete` stay
       * distinct.
       */
      readonly reason?: 'ownership_incomplete';
    };

/** The reason an unknown ownership input carries. */
export function unknownOwnershipReason(
  ownership: Extract<OwnershipInput, { coverage: 'unknown' }>,
): 'ownership_not_loaded' | 'ownership_incomplete' {
  return ownership.reason ?? 'ownership_not_loaded';
}

export interface AccountFacts {
  readonly companyId: CompanyId;
  readonly customerStatus: CustomerStatus;
}

export interface EligibilityInput {
  readonly model: IndexedProductModel;
  readonly account: AccountFacts;
  readonly ownership: OwnershipInput;
  readonly productKey: ProductKey;
  readonly asOf: Date;
}

export interface EligibilityResult {
  readonly productKey: ProductKey;
  readonly companyId: CompanyId;
  readonly asOf: Date;
  readonly status: EligibilityStatus;
  readonly ownership: OwnershipStatus;
  readonly checks: readonly EligibilityCheck[];
  readonly modelVersion: number;
  readonly modelHash: string;
  readonly evaluatorVersion: number;
  readonly factsHash: string;
}

export class UnknownProductError extends Error {
  constructor(readonly productKey: string) {
    super(`product ${productKey} is not in the product model`);
    this.name = 'UnknownProductError';
  }
}

/** Ownership of one product, with the facts that decided it. */
interface ProductOwnership {
  readonly status: OwnershipStatus;
  readonly reason: ReasonCode;
  readonly facts: FactRef[];
}

const RANK: Record<OwnershipStatus, number> = { not_owned: 0, unknown: 1, owned: 2 };

/**
 * Derived ownership for every product (ADR 0017 §2): a product is owned when a
 * line in an owned state is in force at `asOf`; owned products are closed over
 * `includes`. A line in state `unknown`, or a non-owned state still within its
 * term, makes ownership unknown rather than "not owned".
 */
export function deriveOwnership(
  model: IndexedProductModel,
  ownership: OwnershipInput,
  asOf: Date,
  states: ReadonlySet<OwnableState> = model.ownedStates,
): ReadonlyMap<ProductKey, ProductOwnership> {
  const result = new Map<ProductKey, ProductOwnership>();
  if (ownership.coverage === 'unknown') {
    const reason = unknownOwnershipReason(ownership);
    for (const key of model.products.keys()) {
      result.set(key, { status: 'unknown', reason, facts: [] });
    }
    return result;
  }
  for (const key of model.products.keys()) {
    result.set(key, { status: 'not_owned', reason: 'ok', facts: [] });
  }
  const t = asOf.getTime();
  for (const line of [...ownership.subscriptions].sort((a, b) => a.id.localeCompare(b.id))) {
    const current = result.get(line.productKey);
    if (!current) continue; // a product unknown to this model version
    const fact: FactRef = { kind: 'subscription', id: line.id, productKey: line.productKey };
    const started = !line.startsAt || line.startsAt.getTime() <= t;
    const notEnded = !line.endsAt || line.endsAt.getTime() > t;
    let status: OwnershipStatus;
    let reason: ReasonCode = 'ok';
    if (line.state === 'unknown') {
      status = 'unknown';
      reason = 'subscription_state_unknown';
    } else if (states.has(line.state)) {
      status = started && notEnded ? 'owned' : 'not_owned';
    } else if (
      line.endsAt &&
      notEnded &&
      started &&
      (line.state === 'cancelled' || line.state === 'expired')
    ) {
      // Source says not active, yet the term is still running: cannot decide.
      status = 'unknown';
      reason = 'subscription_state_conflict';
    } else {
      status = 'not_owned';
    }
    if (RANK[status] > RANK[current.status]) {
      result.set(line.productKey, { status, reason, facts: [fact] });
    } else if (RANK[status] === RANK[current.status] && status !== 'not_owned') {
      current.facts.push(fact);
    }
  }
  // Close over `includes`: owning a bundle counts as owning its contents.
  // Monotone over a finite lattice; bounded defensively.
  // Each product's rank can rise at most twice, and every round raises one.
  const bound = 2 * model.products.size + 2;
  for (let round = 0; ; round += 1) {
    if (round > bound) throw new Error('includes closure did not converge (corrupt model)');
    let changed = false;
    for (const [bundle, contents] of model.includes) {
      const b = result.get(bundle);
      if (!b || b.status === 'not_owned') continue;
      for (const { key } of contents) {
        const c = result.get(key);
        if (c && RANK[b.status] > RANK[c.status]) {
          result.set(key, {
            status: b.status,
            reason: b.reason,
            facts: [{ kind: 'product', key: bundle, via: 'includes' }],
          });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return result;
}

/**
 * Facts derived once per account and reused for every product (whitespace
 * evaluates the whole catalogue against one context: no per-product work
 * beyond the checks themselves).
 */
interface EvaluationContext {
  readonly input: Omit<EligibilityInput, 'productKey'>;
  readonly owned: ReadonlyMap<ProductKey, ProductOwnership>;
  readonly ownershipFor: (
    states?: readonly OwnableState[],
  ) => ReadonlyMap<ProductKey, ProductOwnership>;
  readonly factsHash: string;
}

function evaluationContext(input: Omit<EligibilityInput, 'productKey'>): EvaluationContext {
  const owned = deriveOwnership(input.model, input.ownership, input.asOf);
  const byStates = new Map<string, ReadonlyMap<ProductKey, ProductOwnership>>();
  const ownershipFor = (states?: readonly OwnableState[]) => {
    if (!states) return owned;
    const key = [...new Set(states)].sort().join(',');
    let m = byStates.get(key);
    if (!m)
      byStates.set(
        key,
        (m = deriveOwnership(input.model, input.ownership, input.asOf, new Set(states))),
      );
    return m;
  };
  return { input, owned, ownershipFor, factsHash: factsHash(input) };
}

/** Evaluate one product for one account. Pure; throws only for an unknown product key. */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  return evaluateInContext(evaluationContext(input), input.productKey);
}

function evaluateInContext(ctx: EvaluationContext, productKey: ProductKey): EligibilityResult {
  const { model, account, asOf } = ctx.input;
  const product = model.products.get(productKey);
  if (!product) throw new UnknownProductError(productKey);
  const { owned, ownershipFor } = ctx;
  const self = owned.get(productKey)!;
  const checks: EligibilityCheck[] = [];

  // 1. Coverage: is "owns nothing" distinguishable from "no data yet"?
  checks.push(
    ctx.input.ownership.coverage === 'known'
      ? { check: 'ownership_coverage', outcome: 'pass', reason: 'ok', facts: [] }
      : {
          check: 'ownership_coverage',
          outcome: 'unknown',
          reason: unknownOwnershipReason(ctx.input.ownership),
          facts: [],
        },
  );

  // 2. Product available at asOf.
  checks.push(availability(product, asOf));

  // 3. Not already owned (directly or through a bundle).
  checks.push(ownershipCheck('not_already_owned', self, 'already_owned', undefined));

  // 4. Not superseded by an owned replacement.
  checks.push(
    anyOwnedCheck(
      'not_superseded',
      model.replacedBy.get(productKey) ?? [],
      owned,
      'superseded_by_owned',
    ),
  );

  // 5. Not excluded by an owned product.
  checks.push(
    anyOwnedCheck('not_excluded', model.excludes.get(productKey) ?? [], owned, 'excluded_by_owned'),
  );

  // 6. Each requirement: at least one of anyOf owned (in the required states).
  for (const rel of model.requires.get(productKey) ?? []) {
    const m = ownershipFor(rel.states);
    const members = rel.anyOf.map((k) => ({ key: k, own: m.get(k)! }));
    const ownedMembers = members.filter((x) => x.own.status === 'owned');
    const unknownMembers = members.filter((x) => x.own.status === 'unknown');
    if (ownedMembers.length > 0) {
      checks.push({
        check: 'requirements_met',
        ruleId: rel.id,
        outcome: 'pass',
        reason: 'ok',
        facts: ownedMembers.flatMap((x) => [
          { kind: 'product', key: x.key } as const,
          ...x.own.facts,
        ]),
      });
    } else if (unknownMembers.length > 0) {
      checks.push({
        check: 'requirements_met',
        ruleId: rel.id,
        outcome: 'unknown',
        reason: unknownMembers[0]!.own.reason,
        facts: unknownMembers.flatMap((x) => [
          { kind: 'product', key: x.key } as const,
          ...x.own.facts,
        ]),
      });
    } else {
      checks.push({
        check: 'requirements_met',
        ruleId: rel.id,
        outcome: 'fail',
        reason: 'requirement_unmet',
        facts: rel.anyOf.map((k) => ({ kind: 'product', key: k }) as const),
      });
    }
  }

  // 7. Configured conditions that apply to this product.
  for (const c of model.conditions) {
    if (!applies(c.appliesTo, product)) continue;
    const value = account.customerStatus === 'unknown' ? null : account.customerStatus;
    const fact: FactRef = { kind: 'attribute', name: c.attribute, value };
    if (value === null) {
      checks.push({
        check: 'account_attribute',
        ruleId: c.id,
        outcome: 'unknown',
        reason: 'attribute_missing',
        facts: [fact],
      });
      continue;
    }
    const inList = c.values.includes(value);
    const ok = c.op === 'in' ? inList : !inList;
    checks.push({
      check: 'account_attribute',
      ruleId: c.id,
      outcome: ok ? 'pass' : 'fail',
      reason: ok ? 'ok' : 'condition_not_met',
      facts: [fact],
    });
  }

  const status: EligibilityStatus = checks.some((c) => c.outcome === 'fail')
    ? 'ineligible'
    : checks.some((c) => c.outcome === 'unknown')
      ? 'unknown'
      : 'eligible';

  return {
    productKey,
    companyId: account.companyId,
    asOf,
    status,
    ownership: self.status,
    checks,
    modelVersion: model.version,
    modelHash: model.contentHash,
    evaluatorVersion: EVALUATOR_VERSION,
    factsHash: ctx.factsHash,
  };
}

/** SHA-256 of the canonicalised input facts (account, ownership, asOf). */
export function factsHash(input: Pick<EligibilityInput, 'account' | 'ownership' | 'asOf'>): string {
  const ownership =
    input.ownership.coverage === 'unknown'
      ? input.ownership.reason
        ? { coverage: 'unknown', reason: input.ownership.reason }
        : { coverage: 'unknown' }
      : {
          coverage: 'known',
          knownAsOf: input.ownership.knownAsOf,
          subscriptions: [...input.ownership.subscriptions].sort((a, b) =>
            a.id.localeCompare(b.id),
          ),
        };
  return canonicalHash({ account: input.account, ownership, asOf: input.asOf });
}

function availability(product: ProductDefinition, asOf: Date): EligibilityCheck {
  const facts: FactRef[] = [{ kind: 'product', key: product.key }];
  if (product.status === 'retired') {
    return { check: 'product_available', outcome: 'fail', reason: 'product_retired', facts };
  }
  const t = asOf.getTime();
  if (
    (product.availableFrom && t < product.availableFrom.getTime()) ||
    (product.availableUntil && t >= product.availableUntil.getTime())
  ) {
    return { check: 'product_available', outcome: 'fail', reason: 'product_not_available', facts };
  }
  return { check: 'product_available', outcome: 'pass', reason: 'ok', facts };
}

function ownershipCheck(
  check: CheckCode,
  own: ProductOwnership,
  failReason: ReasonCode,
  ruleId: string | undefined,
): EligibilityCheck {
  const base = ruleId ? { check, ruleId } : { check };
  if (own.status === 'owned')
    return { ...base, outcome: 'fail', reason: failReason, facts: own.facts };
  if (own.status === 'unknown')
    return { ...base, outcome: 'unknown', reason: own.reason, facts: own.facts };
  return { ...base, outcome: 'pass', reason: 'ok', facts: [] };
}

function anyOwnedCheck(
  check: CheckCode,
  related: readonly { key: ProductKey; ruleId: string }[],
  owned: ReadonlyMap<ProductKey, ProductOwnership>,
  failReason: ReasonCode,
): EligibilityCheck {
  if (related.length === 0)
    return { check, outcome: 'not_applicable', reason: 'not_applicable', facts: [] };
  const sorted = [...related].sort((a, b) => a.key.localeCompare(b.key));
  const hit = sorted.find((r) => owned.get(r.key)?.status === 'owned');
  if (hit) {
    const own = owned.get(hit.key)!;
    return {
      check,
      ruleId: hit.ruleId,
      outcome: 'fail',
      reason: failReason,
      facts: [{ kind: 'product', key: hit.key }, ...own.facts],
    };
  }
  const unk = sorted.find((r) => owned.get(r.key)?.status === 'unknown');
  if (unk) {
    const own = owned.get(unk.key)!;
    return {
      check,
      ruleId: unk.ruleId,
      outcome: 'unknown',
      reason: own.reason,
      facts: [{ kind: 'product', key: unk.key }, ...own.facts],
    };
  }
  return {
    check,
    outcome: 'pass',
    reason: 'ok',
    facts: sorted.map((r) => ({ kind: 'product', key: r.key }) as const),
  };
}

function applies(
  appliesTo: IndexedProductModel['conditions'][number]['appliesTo'],
  product: ProductDefinition,
): boolean {
  if (appliesTo === 'all') return true;
  if ('products' in appliesTo) return appliesTo.products.includes(product.key);
  return product.family !== undefined && appliesTo.families.includes(product.family);
}

export type WhitespaceCategory =
  'owned' | 'eligible_whitespace' | 'ineligible_whitespace' | 'unknown';

export interface WhitespaceResult {
  readonly companyId: CompanyId;
  readonly asOf: Date;
  readonly modelVersion: number;
  readonly modelHash: string;
  readonly evaluatorVersion: number;
  readonly factsHash: string;
  readonly categories: Readonly<Record<WhitespaceCategory, readonly EligibilityResult[]>>;
}

/**
 * Every catalogue product, grouped (ADR 0018 §4): `owned` by ownership;
 * otherwise by eligibility status. Products are evaluated in memory against
 * one set of facts (no per-product loading).
 */
export function classifyWhitespace(input: Omit<EligibilityInput, 'productKey'>): WhitespaceResult {
  const categories: Record<WhitespaceCategory, EligibilityResult[]> = {
    owned: [],
    eligible_whitespace: [],
    ineligible_whitespace: [],
    unknown: [],
  };
  const ctx = evaluationContext(input);
  for (const key of [...input.model.products.keys()].sort()) {
    const r = evaluateInContext(ctx, key);
    if (r.ownership === 'owned') categories.owned.push(r);
    else if (r.status === 'eligible') categories.eligible_whitespace.push(r);
    else if (r.status === 'ineligible') categories.ineligible_whitespace.push(r);
    else categories.unknown.push(r);
  }
  return {
    companyId: input.account.companyId,
    asOf: input.asOf,
    modelVersion: input.model.version,
    modelHash: input.model.contentHash,
    evaluatorVersion: EVALUATOR_VERSION,
    factsHash: ctx.factsHash,
    categories,
  };
}
