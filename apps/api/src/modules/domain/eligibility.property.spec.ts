import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CustomerStatus } from './company';
import {
  classifyWhitespace,
  evaluateEligibility,
  type EligibilityStatus,
  type OwnershipInput,
} from './eligibility';
import type { ProductKey } from './product';
import {
  indexProductModel,
  validateProductModel,
  type IndexedProductModel,
  type ProductModelDocumentInput,
  type Relationship,
} from './product-model';
import type { CompanyId } from './shared/ids';
import {
  SubscriptionFactSchema,
  type SubscriptionFact,
  type SubscriptionState,
} from './subscription';

/**
 * Property-based tests of the pure core (M7). Deterministic: a fixed default
 * seed (override with FC_SEED); a failure prints the seed and shrink path, so
 * `FC_SEED=<seed> pnpm test:unit -t <name>` reproduces it.
 */
const SEED = Number(process.env.FC_SEED ?? 20261002);
const RUNS = Number(process.env.FC_RUNS ?? 300);
fc.configureGlobal({ seed: SEED, numRuns: RUNS });

const AS_OF = new Date('2026-10-02T12:00:00Z');
const COMPANY_A = '11111111-1111-4111-8111-111111111111' as CompanyId;
const COMPANY_B = '22222222-2222-4222-8222-222222222222' as CompanyId;
const STATES: SubscriptionState[] = ['active', 'trial', 'expired', 'cancelled', 'unknown'];
const STATUSES: CustomerStatus[] = ['prospect', 'customer', 'former_customer', 'unknown'];
const GOODNESS: Record<EligibilityStatus, number> = { ineligible: 0, unknown: 1, eligible: 2 };

/**
 * A random valid model: edges only point from a higher to a lower product
 * index, so requires and includes/replaces graphs are acyclic by construction;
 * exclusions that would contradict a requirement or bundle are dropped.
 */
const modelArb = fc.integer({ min: 2, max: 12 }).chain((n) => {
  const key = (i: number) => `p${i}`;
  const pair = fc
    .tuple(fc.integer({ min: 1, max: n - 1 }), fc.nat())
    .map(([hi, r]) => [hi, r % hi] as const);
  return fc
    .record({
      n: fc.constant(n),
      retired: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
      requires: fc.array(fc.tuple(pair, fc.array(fc.nat(), { minLength: 0, maxLength: 2 })), {
        maxLength: n,
      }),
      includes: fc.array(pair, { maxLength: n }),
      replaces: fc.array(pair, { maxLength: n }),
      excludes: fc.array(pair, { maxLength: n }),
      condition: fc.option(
        fc.record({
          op: fc.constantFrom('in' as const, 'not_in' as const),
          value: fc.constantFrom(...STATUSES.filter((s) => s !== 'unknown')),
        }),
      ),
    })
    .map((g): ProductModelDocumentInput => {
      const rels: Relationship[] = [];
      const seen = new Set<string>();
      let id = 0;
      const add = (r: Omit<Relationship, 'id'>, semantic: string) => {
        if (seen.has(semantic)) return;
        seen.add(semantic);
        rels.push({ ...(r as Relationship), id: `r${id++}` });
      };
      for (const [[hi, lo], extra] of g.requires) {
        const anyOf = [...new Set([lo, ...extra.map((e) => e % hi)])].sort().map(key);
        add(
          { type: 'requires', product: key(hi), anyOf } as Omit<Relationship, 'id'>,
          `req|${hi}|${anyOf.join(',')}`,
        );
      }
      for (const [hi, lo] of g.includes)
        add({ type: 'includes', product: key(hi), included: key(lo) } as never, `inc|${hi}|${lo}`);
      for (const [hi, lo] of g.replaces)
        add({ type: 'replaces', product: key(hi), replaced: key(lo) } as never, `rep|${hi}|${lo}`);
      const reqPairs = new Set(
        rels.flatMap((r) => (r.type === 'requires' ? r.anyOf.map((k) => `${r.product}|${k}`) : [])),
      );
      const incPairs = new Set(
        rels.flatMap((r) => (r.type === 'includes' ? [`${r.product}|${r.included}`] : [])),
      );
      for (const [hi, lo] of g.excludes) {
        const a = key(hi);
        const b = key(lo);
        if (
          reqPairs.has(`${a}|${b}`) ||
          reqPairs.has(`${b}|${a}`) ||
          incPairs.has(`${a}|${b}`) ||
          incPairs.has(`${b}|${a}`)
        )
          continue;
        add({ type: 'excludes', products: [a, b] } as never, `exc|${[a, b].sort().join('|')}`);
      }
      return {
        products: Array.from({ length: g.n }, (_, i) => ({
          key: key(i),
          name: `P${i}`,
          family: i % 2 ? 'odd' : 'even',
          status: g.retired[i] && i > 0 ? ('retired' as const) : ('active' as const),
        })),
        relationships: rels,
        conditions: g.condition
          ? [
              {
                id: 'cond',
                type: 'account_attribute',
                appliesTo: { families: ['odd'] },
                attribute: 'customer_status',
                op: g.condition.op,
                values: [g.condition.value],
              },
            ]
          : [],
      };
    });
});

function index(doc: ProductModelDocumentInput): IndexedProductModel {
  const v = validateProductModel(doc);
  if (!v.ok)
    throw new Error(
      `generator produced an invalid model: ${v.errors.map((e) => e.code).join(',')}`,
    );
  return indexProductModel({
    version: 1,
    effectiveFrom: AS_OF,
    document: v.document,
    contentHash: v.contentHash,
  });
}

const dayMs = 86_400_000;
const linesArb = (n: number) =>
  fc
    .array(
      fc.record({
        p: fc.nat({ max: n - 1 }),
        state: fc.constantFrom(...STATES),
        start: fc.option(fc.integer({ min: -400, max: 100 })),
        len: fc.option(fc.integer({ min: 1, max: 500 })),
      }),
      { maxLength: 12 },
    )
    .map((ls) =>
      ls.map((l): SubscriptionFact => {
        const startsAt = l.start === null ? undefined : new Date(AS_OF.getTime() + l.start * dayMs);
        const endsAt =
          l.len === null
            ? undefined
            : new Date(
                (startsAt ?? new Date(AS_OF.getTime() - 400 * dayMs)).getTime() + l.len * dayMs,
              );
        return {
          id: randomUUID(),
          productKey: `p${l.p}` as ProductKey,
          state: l.state,
          startsAt,
          endsAt,
        };
      }),
    );

const scenarioArb = modelArb.chain((doc) =>
  fc.record({
    doc: fc.constant(doc),
    lines: linesArb(doc.products.length),
    coverage: fc.constantFrom('known' as const, 'known' as const, 'unknown' as const),
    status: fc.constantFrom(...STATUSES),
  }),
);

const ownership = (coverage: 'known' | 'unknown', lines: SubscriptionFact[]): OwnershipInput =>
  coverage === 'known' ? { coverage, knownAsOf: AS_OF, subscriptions: lines } : { coverage };

describe('pure eligibility core: properties', () => {
  it('valid generated relationship models validate, and the evaluator always terminates', () => {
    fc.assert(
      fc.property(scenarioArb, ({ doc, lines, coverage, status }) => {
        const model = index(doc);
        for (const key of model.products.keys()) {
          const r = evaluateEligibility({
            model,
            account: { companyId: COMPANY_A, customerStatus: status },
            ownership: ownership(coverage, lines),
            productKey: key,
            asOf: AS_OF,
          });
          expect(['eligible', 'ineligible', 'unknown']).toContain(r.status);
        }
      }),
    );
  });

  it('the same input always gives the same result', () => {
    fc.assert(
      fc.property(scenarioArb, ({ doc, lines, coverage, status }) => {
        const model = index(doc);
        const input = {
          model,
          account: { companyId: COMPANY_A, customerStatus: status },
          ownership: ownership(coverage, lines),
          asOf: AS_OF,
        };
        expect(classifyWhitespace(input)).toEqual(
          classifyWhitespace({ ...input, ownership: ownership(coverage, [...lines].reverse()) }),
        );
      }),
    );
  });

  it('a failing check can never produce eligible; an unknown check can never produce eligible', () => {
    fc.assert(
      fc.property(scenarioArb, ({ doc, lines, coverage, status }) => {
        const model = index(doc);
        for (const key of model.products.keys()) {
          const r = evaluateEligibility({
            model,
            account: { companyId: COMPANY_A, customerStatus: status },
            ownership: ownership(coverage, lines),
            productKey: key,
            asOf: AS_OF,
          });
          if (r.checks.some((c) => c.outcome === 'fail')) expect(r.status).toBe('ineligible');
          else if (r.checks.some((c) => c.outcome === 'unknown')) expect(r.status).toBe('unknown');
          else expect(r.status).toBe('eligible');
        }
      }),
    );
  });

  it('incomplete subscription coverage never yields eligible whitespace or ownership', () => {
    fc.assert(
      fc.property(scenarioArb, ({ doc, lines, status }) => {
        const ws = classifyWhitespace({
          model: index(doc),
          account: { companyId: COMPANY_A, customerStatus: status },
          ownership: ownership('unknown', lines),
          asOf: AS_OF,
        });
        expect(ws.categories.eligible_whitespace).toEqual([]);
        expect(ws.categories.owned).toEqual([]);
      }),
    );
  });

  it('an owned product is never eligible whitespace, and every product lands in exactly one category', () => {
    fc.assert(
      fc.property(scenarioArb, ({ doc, lines, coverage, status }) => {
        const model = index(doc);
        const ws = classifyWhitespace({
          model,
          account: { companyId: COMPANY_A, customerStatus: status },
          ownership: ownership(coverage, lines),
          asOf: AS_OF,
        });
        const all = Object.values(ws.categories)
          .flat()
          .map((r) => r.productKey);
        expect(new Set(all).size).toBe(model.products.size);
        expect(all).toHaveLength(model.products.size);
        expect(ws.categories.eligible_whitespace.every((r) => r.ownership !== 'owned')).toBe(true);
      }),
    );
  });

  it('adding a requirement never makes a product more eligible', () => {
    fc.assert(
      fc.property(scenarioArb, fc.nat(), fc.nat(), ({ doc, lines, coverage, status }, a, b) => {
        const n = doc.products.length;
        const hi = 1 + (a % (n - 1));
        const lo = b % hi;
        const extended: ProductModelDocumentInput = {
          ...doc,
          relationships: [
            ...(doc.relationships ?? []),
            { id: 'added', type: 'requires', product: `p${hi}`, anyOf: [`p${lo}`] },
          ],
        };
        const v = validateProductModel(extended);
        fc.pre(v.ok); // e.g. it may contradict an exclusion
        const before = evaluateEligibility({
          model: index(doc),
          account: { companyId: COMPANY_A, customerStatus: status },
          ownership: ownership(coverage, lines),
          productKey: `p${hi}` as ProductKey,
          asOf: AS_OF,
        });
        const after = evaluateEligibility({
          model: index(extended),
          account: { companyId: COMPANY_A, customerStatus: status },
          ownership: ownership(coverage, lines),
          productKey: `p${hi}` as ProductKey,
          asOf: AS_OF,
        });
        expect(GOODNESS[after.status]).toBeLessThanOrEqual(GOODNESS[before.status]);
      }),
    );
  });

  it('an injected requires or bundle cycle is always rejected', () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.nat(),
        fc.constantFrom('requires' as const, 'includes' as const),
        (doc, a, kind) => {
          const n = doc.products.length;
          const hi = 1 + (a % (n - 1));
          const lo = hi - 1;
          const forward: Relationship =
            kind === 'requires'
              ? {
                  id: 'fwd',
                  type: 'requires',
                  product: `p${hi}` as ProductKey,
                  anyOf: [`p${lo}` as ProductKey],
                }
              : {
                  id: 'fwd',
                  type: 'includes',
                  product: `p${hi}` as ProductKey,
                  included: `p${lo}` as ProductKey,
                };
          const back: Relationship =
            kind === 'requires'
              ? {
                  id: 'back',
                  type: 'requires',
                  product: `p${lo}` as ProductKey,
                  anyOf: [`p${hi}` as ProductKey],
                }
              : {
                  id: 'back',
                  type: 'includes',
                  product: `p${lo}` as ProductKey,
                  included: `p${hi}` as ProductKey,
                };
          const v = validateProductModel({
            ...doc,
            relationships: [
              ...(doc.relationships ?? []).filter((r) => r.type !== 'excludes'),
              forward,
              back,
            ],
          });
          expect(v.ok).toBe(false);
          if (!v.ok)
            expect(v.errors.map((e) => e.code)).toContain(
              kind === 'requires' ? 'requires_cycle' : 'supersession_cycle',
            );
        },
      ),
    );
  });

  it('the account identifier does not change the semantics (only the partition)', () => {
    fc.assert(
      fc.property(scenarioArb, ({ doc, lines, coverage, status }) => {
        const model = index(doc);
        const run = (companyId: CompanyId) =>
          classifyWhitespace({
            model,
            account: { companyId, customerStatus: status },
            ownership: ownership(coverage, lines),
            asOf: AS_OF,
          });
        const strip = (ws: ReturnType<typeof run>) =>
          Object.fromEntries(
            Object.entries(ws.categories).map(([k, list]) => [
              k,
              list.map((r) => ({ p: r.productKey, s: r.status, o: r.ownership, c: r.checks })),
            ]),
          );
        expect(strip(run(COMPANY_A))).toEqual(strip(run(COMPANY_B)));
      }),
    );
  });

  it('serialising and replaying the frozen inputs reproduces the result exactly', () => {
    fc.assert(
      fc.property(scenarioArb, ({ doc, lines, coverage, status }) => {
        const model = index(doc);
        const input = {
          model,
          account: { companyId: COMPANY_A, customerStatus: status },
          ownership: ownership(coverage, lines),
          asOf: AS_OF,
        };
        for (const key of model.products.keys()) {
          const original = evaluateEligibility({ ...input, productKey: key });
          // What a snapshot stores: JSON of the facts; dates revived through the schema.
          const frozen = JSON.parse(
            JSON.stringify({
              ownership: input.ownership,
              asOf: input.asOf,
              account: input.account,
            }),
          ) as {
            ownership:
              | { coverage: 'known'; knownAsOf: string; subscriptions: unknown[] }
              | { coverage: 'unknown' };
            asOf: string;
            account: typeof input.account;
          };
          const revived: OwnershipInput =
            frozen.ownership.coverage === 'known'
              ? {
                  coverage: 'known',
                  knownAsOf: new Date(frozen.ownership.knownAsOf),
                  subscriptions: frozen.ownership.subscriptions.map((s) =>
                    SubscriptionFactSchema.parse(s),
                  ),
                }
              : { coverage: 'unknown' };
          const replayed = evaluateEligibility({
            model,
            account: frozen.account,
            ownership: revived,
            asOf: new Date(frozen.asOf),
            productKey: key,
          });
          expect(replayed).toEqual(original);
        }
      }),
    );
  });
});
