import { z } from 'zod';
import { CustomerStatusSchema } from './company';
import { ExternalSystemSchema } from './external-ref';
import { ProductKeySchema, type ProductKey } from './product';
import { canonicalHash } from './shared/canonical-json';
import { CodeSchema } from './shared/codes';
import { InstantSchema } from './shared/time';
import { OwnableStateSchema, type OwnableState } from './subscription';

/**
 * The per-tenant product model (ADR 0016): catalogue, relationships,
 * conditions and ownership settings, validated together and published as one
 * immutable version. Rules are data; their semantics are the pure checks in
 * `eligibility.ts`. There is no expression language.
 */

export const PRODUCT_MODEL_LIMITS = {
  products: 2000,
  rules: 10_000,
  anyOf: 50,
  externalRefsPerProduct: 20,
} as const;

export const ProductStatusSchema = z.enum(['active', 'retired']);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

const NameSchema = z.string().trim().min(1).max(200);
const RuleIdSchema = CodeSchema;

const ProductExternalRefSchema = z.strictObject({
  system: ExternalSystemSchema,
  objectType: z.string().regex(/^[A-Za-z0-9_]{1,100}$/),
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/),
});

export const ProductDefinitionSchema = z.strictObject({
  key: ProductKeySchema,
  name: NameSchema,
  description: z.string().trim().min(1).max(2000).optional(),
  family: CodeSchema.optional(),
  status: ProductStatusSchema.default('active'),
  availableFrom: InstantSchema.optional(),
  availableUntil: InstantSchema.optional(),
  /** Declares a rename (K3): must equal the previous version's name. */
  renamedFrom: NameSchema.optional(),
  externalRefs: z
    .array(ProductExternalRefSchema)
    .max(PRODUCT_MODEL_LIMITS.externalRefsPerProduct)
    .default([]),
});

const StatesSchema = z.array(OwnableStateSchema).min(1).max(4);

export const RequiresSchema = z.strictObject({
  id: RuleIdSchema,
  type: z.literal('requires'),
  product: ProductKeySchema,
  anyOf: z.array(ProductKeySchema).min(1).max(PRODUCT_MODEL_LIMITS.anyOf),
  states: StatesSchema.optional(),
});
export const ExcludesSchema = z.strictObject({
  id: RuleIdSchema,
  type: z.literal('excludes'),
  products: z.tuple([ProductKeySchema, ProductKeySchema]),
});
export const ReplacesSchema = z.strictObject({
  id: RuleIdSchema,
  type: z.literal('replaces'),
  product: ProductKeySchema,
  replaced: ProductKeySchema,
});
export const IncludesSchema = z.strictObject({
  id: RuleIdSchema,
  type: z.literal('includes'),
  product: ProductKeySchema,
  included: ProductKeySchema,
});
export const RelationshipSchema = z.discriminatedUnion('type', [
  RequiresSchema,
  ExcludesSchema,
  ReplacesSchema,
  IncludesSchema,
]);
export type Relationship = z.infer<typeof RelationshipSchema>;

/** Canonical account attributes a condition may read (ADR 0016 §5). */
export const ConditionAttributeSchema = z.enum(['customer_status']);
export type ConditionAttribute = z.infer<typeof ConditionAttributeSchema>;

const AppliesToSchema = z.union([
  z.literal('all'),
  z.strictObject({ products: z.array(ProductKeySchema).min(1).max(PRODUCT_MODEL_LIMITS.products) }),
  z.strictObject({ families: z.array(CodeSchema).min(1).max(200) }),
]);

export const AccountAttributeConditionSchema = z.strictObject({
  id: RuleIdSchema,
  type: z.literal('account_attribute'),
  appliesTo: AppliesToSchema,
  attribute: ConditionAttributeSchema,
  op: z.enum(['in', 'not_in']),
  values: z.array(CodeSchema).min(1).max(50),
});
export type AccountAttributeCondition = z.infer<typeof AccountAttributeConditionSchema>;

export const ProductModelDocumentSchema = z.strictObject({
  ownership: z
    .strictObject({ ownedStates: StatesSchema })
    .default({ ownedStates: ['active', 'trial'] }),
  products: z.array(ProductDefinitionSchema).max(PRODUCT_MODEL_LIMITS.products),
  relationships: z.array(RelationshipSchema).default([]),
  conditions: z.array(AccountAttributeConditionSchema).default([]),
  /** Explicit lifecycle declarations (K2): bringing a retired product back to sale. */
  lifecycle: z
    .array(z.strictObject({ key: ProductKeySchema, action: z.literal('reactivate') }))
    .default([]),
});
export type ProductModelDocument = z.infer<typeof ProductModelDocumentSchema>;
export type ProductModelDocumentInput = z.input<typeof ProductModelDocumentSchema>;
export type ProductDefinition = z.infer<typeof ProductDefinitionSchema>;

/** Stable validation error codes (ADR 0016 §7–8). */
export const PRODUCT_MODEL_ERROR_CODES = [
  'invalid_document',
  'unsupported_relationship_form',
  'duplicate_product_key',
  'duplicate_external_ref',
  'unknown_product_reference',
  'self_reference',
  'requires_cycle',
  'supersession_cycle',
  'unsatisfiable_requirement',
  'contradictory_relationship',
  'duplicate_rule',
  'duplicate_relationship',
  'invalid_availability_window',
  'invalid_effective_from',
  'invalid_condition_value',
  'model_too_large',
  'product_key_removed',
  'retired_product_identity_change',
  'undeclared_reactivation',
  'undeclared_rename',
  'invalid_renamed_from',
  'invalid_lifecycle_entry',
] as const;
export type ProductModelErrorCode = (typeof PRODUCT_MODEL_ERROR_CODES)[number];

export interface ProductModelIssue {
  readonly code: ProductModelErrorCode | ProductModelWarningCode;
  readonly path: string;
  readonly message: string;
}

export type ProductModelWarningCode = 'requires_only_retired' | 'never_sellable';

/** The previously published version, for cross-version checks. */
export interface PublishedModelRef {
  readonly version: number;
  readonly effectiveFrom: Date;
  readonly document: ProductModelDocument;
}

export interface ValidationContext {
  /**
   * Cross-version checks (K1–K3): the latest published version, or `null` when
   * publishing the first version. Omitted (`undefined`) = structural checks
   * only, as when re-validating a stored version on load.
   */
  readonly previous?: PublishedModelRef | null;
  /** Requested `effectiveFrom` and the clock reading at publish time. */
  readonly publish?: { readonly effectiveFrom: Date; readonly now: Date };
}

export type ProductModelValidation =
  | {
      readonly ok: true;
      readonly document: ProductModelDocument;
      readonly contentHash: string;
      readonly warnings: readonly ProductModelIssue[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly ProductModelIssue[];
      readonly warnings: readonly ProductModelIssue[];
    };

/** Pure validation of a candidate product model (structure, graph, identity, dates). */
export function validateProductModel(
  raw: unknown,
  context: ValidationContext = {},
): ProductModelValidation {
  const errors: ProductModelIssue[] = [];
  const warnings: ProductModelIssue[] = [];
  const err = (code: ProductModelErrorCode, path: string, message: string) =>
    errors.push({ code, path, message });

  // `allOf` gets a precise code rather than a generic "unknown key".
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { relationships?: unknown }).relationships)
  ) {
    (raw as { relationships: unknown[] }).relationships.forEach((r, i) => {
      if (r && typeof r === 'object' && 'allOf' in r) {
        err(
          'unsupported_relationship_form',
          `relationships[${i}].allOf`,
          'requires supports anyOf only in M7',
        );
      }
    });
    if (
      (raw as { relationships: unknown[] }).relationships.length +
        (Array.isArray((raw as { conditions?: unknown }).conditions)
          ? (raw as { conditions: unknown[] }).conditions.length
          : 0) >
      PRODUCT_MODEL_LIMITS.rules
    ) {
      err(
        'model_too_large',
        'relationships',
        `at most ${PRODUCT_MODEL_LIMITS.rules} relationships and conditions`,
      );
    }
  }
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { products?: unknown }).products) &&
    (raw as { products: unknown[] }).products.length > PRODUCT_MODEL_LIMITS.products
  ) {
    err('model_too_large', 'products', `at most ${PRODUCT_MODEL_LIMITS.products} products`);
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  const parsed = ProductModelDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 50)) {
      err('invalid_document', issue.path.join('.') || '(root)', issue.message);
    }
    return { ok: false, errors, warnings };
  }
  const doc = parsed.data;

  // --- Catalogue -------------------------------------------------------------
  const products = new Map<string, { def: ProductDefinition; index: number }>();
  const families = new Set<string>();
  const externalRefs = new Map<string, string>();
  doc.products.forEach((p, i) => {
    if (products.has(p.key))
      err('duplicate_product_key', `products[${i}].key`, `duplicate key ${p.key}`);
    else products.set(p.key, { def: p, index: i });
    if (p.family) families.add(p.family);
    if (p.availableFrom && p.availableUntil && p.availableUntil <= p.availableFrom) {
      err(
        'invalid_availability_window',
        `products[${i}].availableUntil`,
        'availableUntil must be after availableFrom',
      );
    }
    p.externalRefs.forEach((r, j) => {
      const id = `${r.system}:${r.objectType}:${r.id}`;
      const owner = externalRefs.get(id);
      if (owner !== undefined) {
        err(
          'duplicate_external_ref',
          `products[${i}].externalRefs[${j}]`,
          `${id} already belongs to ${owner}`,
        );
      } else externalRefs.set(id, p.key);
    });
  });
  const known = (key: string, path: string): boolean => {
    if (products.has(key)) return true;
    err('unknown_product_reference', path, `unknown product ${key}`);
    return false;
  };

  // --- Rule ids ----------------------------------------------------------------
  const ruleIds = new Set<string>();
  [...doc.relationships, ...doc.conditions].forEach((r, i) => {
    if (ruleIds.has(r.id)) err('duplicate_rule', `rules[${i}].id`, `duplicate rule id ${r.id}`);
    ruleIds.add(r.id);
  });

  // --- Relationships -------------------------------------------------------------
  const excluded = new Set<string>(); // "a|b" both orders
  const requiresEdges = new Map<string, Set<string>>();
  const supersedeEdges = new Map<string, Set<string>>();
  const includePairs = new Set<string>();
  const seenSemantics = new Set<string>();
  const addEdge = (m: Map<string, Set<string>>, from: string, to: string) => {
    let set = m.get(from);
    if (!set) m.set(from, (set = new Set()));
    set.add(to);
  };
  doc.relationships.forEach((r, i) => {
    const path = `relationships[${i}]`;
    let semantic: string;
    switch (r.type) {
      case 'requires': {
        known(r.product, `${path}.product`);
        r.anyOf.forEach((k, j) => known(k, `${path}.anyOf[${j}]`));
        if (r.anyOf.includes(r.product))
          err('self_reference', path, `${r.product} requires itself`);
        for (const k of r.anyOf) addEdge(requiresEdges, r.product, k);
        semantic = `requires|${r.product}|${[...new Set(r.anyOf)].sort().join(',')}|${[...new Set(r.states ?? [])].sort().join(',')}`;
        break;
      }
      case 'excludes': {
        const [a, b] = r.products;
        known(a, `${path}.products[0]`);
        known(b, `${path}.products[1]`);
        if (a === b) err('self_reference', path, `${a} excludes itself`);
        excluded.add(`${a}|${b}`).add(`${b}|${a}`);
        semantic = `excludes|${[a, b].sort().join('|')}`;
        break;
      }
      case 'replaces':
        known(r.product, `${path}.product`);
        known(r.replaced, `${path}.replaced`);
        if (r.product === r.replaced) err('self_reference', path, `${r.product} replaces itself`);
        addEdge(supersedeEdges, r.product, r.replaced);
        semantic = `replaces|${r.product}|${r.replaced}`;
        break;
      case 'includes':
        known(r.product, `${path}.product`);
        known(r.included, `${path}.included`);
        if (r.product === r.included) err('self_reference', path, `${r.product} includes itself`);
        addEdge(supersedeEdges, r.product, r.included);
        includePairs.add(`${r.product}|${r.included}`);
        semantic = `includes|${r.product}|${r.included}`;
        break;
    }
    if (seenSemantics.has(semantic))
      err('duplicate_relationship', path, `same relationship declared twice (${r.id})`);
    seenSemantics.add(semantic);
  });

  doc.relationships.forEach((r, i) => {
    if (r.type !== 'requires') return;
    const conflicting = r.anyOf.filter((k) => excluded.has(`${r.product}|${k}`));
    if (conflicting.length === r.anyOf.length) {
      err(
        'unsatisfiable_requirement',
        `relationships[${i}]`,
        `${r.product} requires only products it excludes`,
      );
    } else if (conflicting.length > 0) {
      err(
        'contradictory_relationship',
        `relationships[${i}]`,
        `${r.product} requires excluded ${conflicting.join(', ')}`,
      );
    }
  });
  for (const pair of includePairs) {
    if (excluded.has(pair)) {
      err(
        'contradictory_relationship',
        'relationships',
        `${pair.replace('|', ' includes ')} while excluding it`,
      );
    }
  }

  const reqCycle = findCycle(requiresEdges);
  if (reqCycle) err('requires_cycle', 'relationships', `requires cycle: ${reqCycle.join(' → ')}`);
  const supCycle = findCycle(supersedeEdges);
  if (supCycle)
    err('supersession_cycle', 'relationships', `includes/replaces cycle: ${supCycle.join(' → ')}`);

  // --- Conditions ----------------------------------------------------------------
  doc.conditions.forEach((c, i) => {
    const path = `conditions[${i}]`;
    if (c.appliesTo !== 'all') {
      if ('products' in c.appliesTo)
        c.appliesTo.products.forEach((k, j) => known(k, `${path}.appliesTo.products[${j}]`));
      else
        c.appliesTo.families.forEach((f, j) => {
          if (!families.has(f))
            err(
              'unknown_product_reference',
              `${path}.appliesTo.families[${j}]`,
              `unknown family ${f}`,
            );
        });
    }
    const allowed = new Set<string>(CustomerStatusSchema.options);
    c.values.forEach((v, j) => {
      if (!allowed.has(v))
        err(
          'invalid_condition_value',
          `${path}.values[${j}]`,
          `${v} is not a ${c.attribute} value`,
        );
    });
  });

  // --- Lifecycle and cross-version identity (K1–K3) -------------------------------
  const previous = context.previous;
  const prevProducts = new Map<string, ProductDefinition>(
    (previous?.document.products ?? []).map((p) => [p.key, p]),
  );
  const reactivations = new Set<string>();
  const seenLifecycle = new Set<string>();
  doc.lifecycle.forEach((l, i) => {
    const duplicate = seenLifecycle.has(l.key);
    seenLifecycle.add(l.key);
    reactivations.add(l.key);
    if (previous === undefined) return; // structural validation only
    const prev = prevProducts.get(l.key);
    const next = products.get(l.key)?.def;
    if (!prev || !next || prev.status !== 'retired' || next.status !== 'active' || duplicate) {
      err(
        'invalid_lifecycle_entry',
        `lifecycle[${i}]`,
        `${l.key}: reactivate applies only to a retired product returning to active`,
      );
    }
  });
  if (previous) {
    for (const prev of previous.document.products) {
      if (!products.has(prev.key)) {
        err(
          'product_key_removed',
          'products',
          `${prev.key} was published in version ${previous.version} and cannot be removed (retire it instead)`,
        );
      }
    }
  }
  for (const [key, { def, index }] of products) {
    const path = `products[${index}]`;
    const prev = prevProducts.get(key);
    if (!prev) {
      if (previous !== undefined && def.renamedFrom !== undefined)
        err(
          'invalid_renamed_from',
          `${path}.renamedFrom`,
          `${key} is new; renamedFrom applies to an existing product`,
        );
      continue;
    }
    if (prev.status === 'retired') {
      if (def.name !== prev.name || def.family !== prev.family) {
        err(
          'retired_product_identity_change',
          path,
          `${key} is retired; its name and family cannot change (a different product needs a new key)`,
        );
      }
      if (def.status === 'active' && !reactivations.has(key)) {
        err(
          'undeclared_reactivation',
          path,
          `${key} returns to active without a lifecycle reactivate entry`,
        );
      }
      continue;
    }
    if (def.name !== prev.name) {
      if (def.renamedFrom !== prev.name) {
        err(
          'undeclared_rename',
          `${path}.name`,
          `${key} changes name from "${prev.name}" without renamedFrom: "${prev.name}"`,
        );
      }
    } else if (def.renamedFrom !== undefined && def.renamedFrom !== prev.renamedFrom) {
      err(
        'invalid_renamed_from',
        `${path}.renamedFrom`,
        `${key}: renamedFrom without a name change`,
      );
    }
  }

  // --- Effective date ---------------------------------------------------------------
  if (context.publish) {
    const { effectiveFrom, now } = context.publish;
    if (effectiveFrom.getTime() < now.getTime()) {
      err('invalid_effective_from', 'effectiveFrom', 'effectiveFrom cannot be in the past');
    }
    if (previous && effectiveFrom.getTime() < previous.effectiveFrom.getTime()) {
      err(
        'invalid_effective_from',
        'effectiveFrom',
        `effectiveFrom precedes version ${previous.version}`,
      );
    }
  }

  // --- Warnings -------------------------------------------------------------------
  for (const r of doc.relationships) {
    if (r.type !== 'requires') continue;
    const target = products.get(r.product)?.def;
    if (
      target?.status === 'active' &&
      r.anyOf.every((k) => products.get(k)?.def.status === 'retired')
    ) {
      warnings.push({
        code: 'requires_only_retired',
        path: r.id,
        message: `${r.product} requires only retired products`,
      });
    }
  }
  for (const [key, { def }] of products) {
    if (def.availableUntil && def.availableFrom && def.availableUntil <= def.availableFrom)
      continue;
    if (
      def.status === 'active' &&
      def.availableUntil &&
      context.publish &&
      def.availableUntil <= context.publish.now
    ) {
      warnings.push({
        code: 'never_sellable',
        path: key,
        message: `${key} availability has already ended`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, document: doc, contentHash: canonicalHash(doc), warnings };
}

/**
 * First cycle in a directed graph, as a witness path (`a → b → a`), or
 * undefined. Iterative three-colour DFS: no recursion, terminates on any input.
 */
export function findCycle(edges: ReadonlyMap<string, ReadonlySet<string>>): string[] | undefined {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const nodes = new Set<string>();
  for (const [from, tos] of edges) {
    nodes.add(from);
    for (const t of tos) nodes.add(t);
  }
  for (const start of [...nodes].sort()) {
    if ((colour.get(start) ?? WHITE) !== WHITE) continue;
    const stack: Array<{ node: string; next: string[] }> = [
      { node: start, next: [...(edges.get(start) ?? [])].sort() },
    ];
    colour.set(start, GREY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const child = top.next.shift();
      if (child === undefined) {
        colour.set(top.node, BLACK);
        stack.pop();
        continue;
      }
      const c = colour.get(child) ?? WHITE;
      if (c === GREY) {
        const from = stack.findIndex((f) => f.node === child);
        return [...stack.slice(from).map((f) => f.node), child];
      }
      if (c === WHITE) {
        colour.set(child, GREY);
        stack.push({ node: child, next: [...(edges.get(child) ?? [])].sort() });
      }
    }
  }
  return undefined;
}

/**
 * A validated model indexed for evaluation. Built only from a document that
 * passed validation; `indexProductModel` re-checks structure so a corrupt
 * stored model fails loudly instead of being evaluated.
 */
export interface IndexedProductModel {
  readonly version: number;
  readonly contentHash: string;
  readonly effectiveFrom: Date;
  readonly document: ProductModelDocument;
  readonly products: ReadonlyMap<ProductKey, ProductDefinition>;
  readonly ownedStates: ReadonlySet<OwnableState>;
  /** product → requires relationships */
  readonly requires: ReadonlyMap<ProductKey, readonly z.infer<typeof RequiresSchema>[]>;
  /** product → products mutually exclusive with it, with the rule id */
  readonly excludes: ReadonlyMap<ProductKey, readonly { key: ProductKey; ruleId: string }[]>;
  /** product → products that replace it, with the rule id */
  readonly replacedBy: ReadonlyMap<ProductKey, readonly { key: ProductKey; ruleId: string }[]>;
  /** product → products it includes, with the rule id */
  readonly includes: ReadonlyMap<ProductKey, readonly { key: ProductKey; ruleId: string }[]>;
  readonly conditions: readonly AccountAttributeCondition[];
}

export class CorruptProductModelError extends Error {
  constructor(
    readonly version: number,
    readonly issues: readonly ProductModelIssue[],
  ) {
    super(
      `product model version ${version} is invalid: ${issues.map((i) => `${i.code} at ${i.path}: ${i.message}`).join('; ')}`,
    );
    this.name = 'CorruptProductModelError';
  }
}

export function indexProductModel(input: {
  version: number;
  effectiveFrom: Date;
  document: unknown;
  contentHash: string;
}): IndexedProductModel {
  const checked = validateProductModel(input.document);
  if (!checked.ok) throw new CorruptProductModelError(input.version, checked.errors);
  if (checked.contentHash !== input.contentHash) {
    throw new CorruptProductModelError(input.version, [
      {
        code: 'invalid_document',
        path: '(root)',
        message: 'content hash does not match the stored document',
      },
    ]);
  }
  const doc = checked.document;
  const push = <V>(m: Map<ProductKey, V[]>, k: ProductKey, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const requires = new Map<ProductKey, z.infer<typeof RequiresSchema>[]>();
  const excludes = new Map<ProductKey, { key: ProductKey; ruleId: string }[]>();
  const replacedBy = new Map<ProductKey, { key: ProductKey; ruleId: string }[]>();
  const includes = new Map<ProductKey, { key: ProductKey; ruleId: string }[]>();
  for (const r of doc.relationships) {
    if (r.type === 'requires') push(requires, r.product, r);
    else if (r.type === 'excludes') {
      push(excludes, r.products[0], { key: r.products[1], ruleId: r.id });
      push(excludes, r.products[1], { key: r.products[0], ruleId: r.id });
    } else if (r.type === 'replaces')
      push(replacedBy, r.replaced, { key: r.product, ruleId: r.id });
    else push(includes, r.product, { key: r.included, ruleId: r.id });
  }
  return {
    version: input.version,
    contentHash: input.contentHash,
    effectiveFrom: input.effectiveFrom,
    document: doc,
    products: new Map(doc.products.map((p) => [p.key, p])),
    ownedStates: new Set(doc.ownership.ownedStates),
    requires,
    excludes,
    replacedBy,
    includes,
    conditions: doc.conditions,
  };
}
