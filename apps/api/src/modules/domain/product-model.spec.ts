import { describe, expect, it } from 'vitest';
import {
  findCycle,
  indexProductModel,
  validateProductModel,
  CorruptProductModelError,
  type ProductModelDocumentInput,
  type PublishedModelRef,
  type ProductModelValidation,
} from './product-model';

const T0 = new Date('2026-10-01T00:00:00Z');

/** Generic, fictional catalogue (never customer configuration). */
function base(over: Partial<ProductModelDocumentInput> = {}): ProductModelDocumentInput {
  return {
    products: [
      { key: 'core', name: 'Core', family: 'platform' },
      { key: 'analytics', name: 'Analytics', family: 'addons' },
      { key: 'analytics-plus', name: 'Analytics Plus', family: 'addons' },
      { key: 'reporting', name: 'Reporting', family: 'addons' },
      { key: 'suite', name: 'Suite', family: 'bundles' },
    ],
    relationships: [
      { id: 'analytics-needs-core', type: 'requires', product: 'analytics', anyOf: ['core'] },
      {
        id: 'plus-replaces-analytics',
        type: 'replaces',
        product: 'analytics-plus',
        replaced: 'analytics',
      },
      { id: 'suite-has-reporting', type: 'includes', product: 'suite', included: 'reporting' },
    ],
    ...over,
  };
}

function codes(v: ProductModelValidation): string[] {
  return v.ok ? [] : v.errors.map((e) => e.code);
}

function published(doc: ProductModelDocumentInput, version = 1): PublishedModelRef {
  const v = validateProductModel(doc);
  if (!v.ok) throw new Error(`fixture invalid: ${codes(v).join(',')}`);
  return { version, effectiveFrom: T0, document: v.document };
}

function withProduct(doc: ProductModelDocumentInput, key: string, patch: Record<string, unknown>) {
  return { ...doc, products: doc.products.map((p) => (p.key === key ? { ...p, ...patch } : p)) };
}

describe('product model validation: structure and graph', () => {
  it('accepts a valid generic model and hashes it deterministically', () => {
    const a = validateProductModel(base());
    const b = validateProductModel(JSON.parse(JSON.stringify(base())));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.contentHash).toBe(b.contentHash);
      expect(a.document.ownership.ownedStates).toEqual(['active', 'trial']);
    }
  });

  it.each<[string, ProductModelDocumentInput, string]>([
    [
      'duplicate product key',
      base({ products: [...base().products, { key: 'core', name: 'Core again' }] }),
      'duplicate_product_key',
    ],
    [
      'duplicate external reference',
      base({
        products: [
          {
            key: 'core',
            name: 'Core',
            externalRefs: [{ system: 'sugar', objectType: 'Products', id: 'p1' }],
          },
          {
            key: 'analytics',
            name: 'Analytics',
            externalRefs: [{ system: 'sugar', objectType: 'Products', id: 'p1' }],
          },
        ],
        relationships: [],
      }),
      'duplicate_external_ref',
    ],
    [
      'dangling product reference',
      base({
        relationships: [{ id: 'x', type: 'requires', product: 'analytics', anyOf: ['ghost'] }],
      }),
      'unknown_product_reference',
    ],
    [
      'unknown family in a condition',
      base({
        conditions: [
          {
            id: 'c',
            type: 'account_attribute',
            appliesTo: { families: ['ghosts'] },
            attribute: 'customer_status',
            op: 'in',
            values: ['customer'],
          },
        ],
      }),
      'unknown_product_reference',
    ],
    [
      'requires itself',
      base({ relationships: [{ id: 'x', type: 'requires', product: 'core', anyOf: ['core'] }] }),
      'self_reference',
    ],
    [
      'excludes itself',
      base({ relationships: [{ id: 'x', type: 'excludes', products: ['core', 'core'] }] }),
      'self_reference',
    ],
    [
      'replaces itself',
      base({ relationships: [{ id: 'x', type: 'replaces', product: 'core', replaced: 'core' }] }),
      'self_reference',
    ],
    [
      'includes itself',
      base({ relationships: [{ id: 'x', type: 'includes', product: 'core', included: 'core' }] }),
      'self_reference',
    ],
    [
      'requires cycle (A requires B, B requires A)',
      base({
        relationships: [
          { id: 'a', type: 'requires', product: 'core', anyOf: ['analytics'] },
          { id: 'b', type: 'requires', product: 'analytics', anyOf: ['core'] },
        ],
      }),
      'requires_cycle',
    ],
    [
      'longer requires cycle',
      base({
        relationships: [
          { id: 'a', type: 'requires', product: 'core', anyOf: ['analytics'] },
          { id: 'b', type: 'requires', product: 'analytics', anyOf: ['reporting'] },
          { id: 'c', type: 'requires', product: 'reporting', anyOf: ['core'] },
        ],
      }),
      'requires_cycle',
    ],
    [
      'include cycle',
      base({
        relationships: [
          { id: 'a', type: 'includes', product: 'suite', included: 'reporting' },
          { id: 'b', type: 'includes', product: 'reporting', included: 'suite' },
        ],
      }),
      'supersession_cycle',
    ],
    [
      'replacement loop',
      base({
        relationships: [
          { id: 'a', type: 'replaces', product: 'analytics-plus', replaced: 'analytics' },
          { id: 'b', type: 'replaces', product: 'analytics', replaced: 'analytics-plus' },
        ],
      }),
      'supersession_cycle',
    ],
    [
      'mixed include/replace loop',
      base({
        relationships: [
          { id: 'a', type: 'includes', product: 'suite', included: 'reporting' },
          { id: 'b', type: 'replaces', product: 'reporting', replaced: 'suite' },
        ],
      }),
      'supersession_cycle',
    ],
    [
      'unsatisfiable requirement (all alternatives excluded)',
      base({
        relationships: [
          { id: 'r', type: 'requires', product: 'analytics', anyOf: ['core'] },
          { id: 'x', type: 'excludes', products: ['analytics', 'core'] },
        ],
      }),
      'unsatisfiable_requirement',
    ],
    [
      'requires an excluded dependency',
      base({
        relationships: [
          { id: 'r', type: 'requires', product: 'analytics', anyOf: ['core', 'reporting'] },
          { id: 'x', type: 'excludes', products: ['analytics', 'core'] },
        ],
      }),
      'contradictory_relationship',
    ],
    [
      'bundle includes a product it excludes',
      base({
        relationships: [
          { id: 'i', type: 'includes', product: 'suite', included: 'reporting' },
          { id: 'x', type: 'excludes', products: ['reporting', 'suite'] },
        ],
      }),
      'contradictory_relationship',
    ],
    [
      'duplicate rule id',
      base({
        relationships: [
          { id: 'same', type: 'requires', product: 'analytics', anyOf: ['core'] },
          { id: 'same', type: 'includes', product: 'suite', included: 'reporting' },
        ],
      }),
      'duplicate_rule',
    ],
    [
      'duplicate relationship (same edge, two ids)',
      base({
        relationships: [
          { id: 'one', type: 'excludes', products: ['core', 'reporting'] },
          { id: 'two', type: 'excludes', products: ['reporting', 'core'] },
        ],
      }),
      'duplicate_relationship',
    ],
    [
      'invalid availability window',
      base({
        products: [
          {
            key: 'core',
            name: 'Core',
            availableFrom: '2026-12-01T00:00:00Z',
            availableUntil: '2026-11-01T00:00:00Z',
          },
        ],
        relationships: [],
      }),
      'invalid_availability_window',
    ],
    [
      'condition value outside the attribute vocabulary',
      base({
        conditions: [
          {
            id: 'c',
            type: 'account_attribute',
            appliesTo: 'all',
            attribute: 'customer_status',
            op: 'in',
            values: ['vip'],
          },
        ],
      }),
      'invalid_condition_value',
    ],
  ])('rejects %s', (_label, doc, code) => {
    expect(codes(validateProductModel(doc))).toContain(code);
  });

  it('reports a witness path for a cycle', () => {
    const v = validateProductModel(
      base({
        relationships: [
          { id: 'a', type: 'requires', product: 'core', anyOf: ['analytics'] },
          { id: 'b', type: 'requires', product: 'analytics', anyOf: ['core'] },
        ],
      }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok)
      expect(v.errors.find((e) => e.code === 'requires_cycle')?.message).toMatch(
        /analytics → core → analytics/,
      );
  });

  it('rejects requires allOf with its own code (anyOf only in M7)', () => {
    const doc = base({
      relationships: [
        { id: 'x', type: 'requires', product: 'analytics', allOf: ['core'] } as never,
      ],
    });
    expect(codes(validateProductModel(doc))).toEqual(['unsupported_relationship_form']);
  });

  it('rejects unknown keys, bad key formats and unknown attributes (strict schema)', () => {
    expect(codes(validateProductModel({ ...base(), extra: true }))).toContain('invalid_document');
    expect(
      codes(
        validateProductModel(
          base({ products: [{ key: 'Bad Key', name: 'x' }], relationships: [] }),
        ),
      ),
    ).toContain('invalid_document');
    const unknownAttr = base({
      conditions: [
        {
          id: 'c',
          type: 'account_attribute',
          appliesTo: 'all',
          attribute: 'region',
          op: 'in',
          values: ['north'],
        } as never,
      ],
    });
    expect(codes(validateProductModel(unknownAttr))).toContain('invalid_document');
  });

  it('enforces size limits (max catalogue accepted, one more refused)', () => {
    const max = Array.from({ length: 2000 }, (_, i) => ({ key: `p${i}`, name: `P ${i}` }));
    expect(validateProductModel({ products: max }).ok).toBe(true);
    expect(
      codes(validateProductModel({ products: [...max, { key: 'p2000', name: 'one too many' }] })),
    ).toEqual(['model_too_large']);
  });

  it('accepts multiple requires groups, a replacement chain and nested bundles', () => {
    const v = validateProductModel(
      base({
        products: [
          ...base().products,
          { key: 'analytics-max', name: 'Analytics Max' },
          { key: 'mega', name: 'Mega' },
        ],
        relationships: [
          { id: 'a', type: 'requires', product: 'analytics', anyOf: ['core'] },
          { id: 'b', type: 'requires', product: 'analytics', anyOf: ['reporting', 'suite'] },
          { id: 'c', type: 'replaces', product: 'analytics-plus', replaced: 'analytics' },
          { id: 'd', type: 'replaces', product: 'analytics-max', replaced: 'analytics-plus' },
          { id: 'e', type: 'includes', product: 'suite', included: 'reporting' },
          { id: 'f', type: 'includes', product: 'mega', included: 'suite' },
        ],
      }),
    );
    expect(v.ok).toBe(true);
  });

  it('warns (does not fail) when an active product requires only retired products', () => {
    const v = validateProductModel(withProduct(base(), 'core', { status: 'retired' }));
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toContain('requires_only_retired');
  });
});

describe('product model validation: effective dates', () => {
  const now = new Date('2026-10-02T10:00:00Z');
  it('refuses an effectiveFrom in the past or before the previous version', () => {
    expect(
      codes(
        validateProductModel(base(), {
          publish: { effectiveFrom: new Date(now.getTime() - 1), now },
        }),
      ),
    ).toContain('invalid_effective_from');
    const previous = { ...published(base()), effectiveFrom: new Date('2026-12-01T00:00:00Z') };
    expect(
      codes(validateProductModel(base(), { previous, publish: { effectiveFrom: now, now } })),
    ).toContain('invalid_effective_from');
    expect(validateProductModel(base(), { publish: { effectiveFrom: now, now } }).ok).toBe(true);
  });
});

describe('product identity across versions (ADR 0016 K1–K4)', () => {
  const v1 = base();
  const validateNext = (
    next: ProductModelDocumentInput,
    previousDoc: ProductModelDocumentInput = v1,
  ) => validateProductModel(next, { previous: published(previousDoc) });

  it('allows an active rename with the correct renamedFrom', () => {
    expect(
      validateNext(
        withProduct(v1, 'analytics', { name: 'Analytics Pro', renamedFrom: 'Analytics' }),
      ).ok,
    ).toBe(true);
  });

  it('rejects a rename without declaration, or with a wrong renamedFrom', () => {
    expect(codes(validateNext(withProduct(v1, 'analytics', { name: 'Analytics Pro' })))).toEqual([
      'undeclared_rename',
    ]);
    expect(
      codes(
        validateNext(
          withProduct(v1, 'analytics', { name: 'Analytics Pro', renamedFrom: 'Analytic' }),
        ),
      ),
    ).toEqual(['undeclared_rename']);
  });

  it('allows multiple sequential renames with a proper chain', () => {
    const v2 = withProduct(v1, 'analytics', { name: 'Analytics Pro', renamedFrom: 'Analytics' });
    const v3 = withProduct(v2, 'analytics', {
      name: 'Analytics Max',
      renamedFrom: 'Analytics Pro',
    });
    expect(validateNext(v2).ok).toBe(true);
    expect(validateNext(v3, v2).ok).toBe(true);
    // Republishing v3 unchanged (renamedFrom carried over) is fine.
    expect(validateNext(v3, v3).ok).toBe(true);
    // Skipping a link in the chain is not.
    expect(
      codes(
        validateNext(
          withProduct(v2, 'analytics', { name: 'Analytics Max', renamedFrom: 'Analytics' }),
          v2,
        ),
      ),
    ).toEqual(['undeclared_rename']);
  });

  it('allows retiring a product', () => {
    expect(validateNext(withProduct(v1, 'reporting', { status: 'retired' })).ok).toBe(true);
  });

  it('rejects renaming a retired product (retire then rename)', () => {
    const retired = withProduct(v1, 'reporting', { status: 'retired' });
    expect(
      codes(
        validateNext(
          withProduct(retired, 'reporting', { name: 'Reports', renamedFrom: 'Reporting' }),
          retired,
        ),
      ),
    ).toContain('retired_product_identity_change');
  });

  it('allows reactivating a retired product with the same identity, when declared', () => {
    const retired = withProduct(v1, 'reporting', { status: 'retired' });
    const back = {
      ...withProduct(retired, 'reporting', { status: 'active' }),
      lifecycle: [{ key: 'reporting', action: 'reactivate' as const }],
    };
    expect(validateNext(back, retired).ok).toBe(true);
    expect(
      codes(validateNext(withProduct(retired, 'reporting', { status: 'active' }), retired)),
    ).toEqual(['undeclared_reactivation']);
  });

  it('rejects reactivating under a different identity (the key-reuse case)', () => {
    // v2: analytics retired. v5: analytics reappears as an unrelated product.
    const retired = withProduct(v1, 'analytics', { status: 'retired' });
    const reused = {
      ...withProduct(retired, 'analytics', {
        status: 'active',
        name: 'School Payments',
        family: 'payments',
      }),
      lifecycle: [{ key: 'analytics', action: 'reactivate' as const }],
    };
    expect(codes(validateNext(reused, retired))).toContain('retired_product_identity_change');
  });

  it('rejects omitting a historical key (no removal; retire instead)', () => {
    const dropped = {
      ...v1,
      products: v1.products.filter((p) => p.key !== 'reporting'),
      relationships: [],
    };
    expect(codes(validateNext(dropped))).toContain('product_key_removed');
  });

  it('rejects key reuse via drop-and-re-add across versions', () => {
    const retired = withProduct(v1, 'analytics', { status: 'retired' });
    // Dropping it in a later version is refused (K1), so it can never come back "new".
    const dropped = {
      ...retired,
      products: retired.products.filter((p) => p.key !== 'analytics'),
      relationships: [],
    };
    expect(codes(validateNext(dropped, retired))).toContain('product_key_removed');
  });

  it('allows a description-only change and a family change while active', () => {
    expect(validateNext(withProduct(v1, 'core', { description: 'The core platform' })).ok).toBe(
      true,
    );
    expect(validateNext(withProduct(v1, 'core', { family: 'foundation' })).ok).toBe(true);
  });

  it('rejects a family change while retired', () => {
    const retired = withProduct(v1, 'reporting', { status: 'retired' });
    expect(
      codes(validateNext(withProduct(retired, 'reporting', { family: 'other' }), retired)),
    ).toContain('retired_product_identity_change');
  });

  it('rejects renamedFrom on a new key and misplaced lifecycle entries', () => {
    const added = {
      ...v1,
      products: [...v1.products, { key: 'payments', name: 'Payments', renamedFrom: 'Analytics' }],
    };
    expect(codes(validateNext(added))).toEqual(['invalid_renamed_from']);
    expect(
      codes(validateNext({ ...v1, lifecycle: [{ key: 'core', action: 'reactivate' }] })),
    ).toEqual(['invalid_lifecycle_entry']);
  });
});

describe('structural re-validation of stored versions', () => {
  it('loads a stored version that declared a rename or a reactivation (no previous context)', () => {
    const doc = {
      ...withProduct(base(), 'analytics', { name: 'Analytics Pro', renamedFrom: 'Analytics' }),
      lifecycle: [{ key: 'reporting', action: 'reactivate' as const }],
    };
    const v = validateProductModel(doc);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(() =>
        indexProductModel({
          version: 4,
          effectiveFrom: T0,
          document: v.document,
          contentHash: v.contentHash,
        }),
      ).not.toThrow();
    }
  });

  it('applies new-key and lifecycle rules once there is a version chain (first version: previous = null)', () => {
    const first = {
      ...base(),
      products: [...base().products, { key: 'x', name: 'X', renamedFrom: 'Y' }],
    };
    expect(codes(validateProductModel(first, { previous: null }))).toEqual([
      'invalid_renamed_from',
    ]);
  });
});

describe('findCycle and indexing', () => {
  it('terminates on large acyclic graphs and finds a cycle when one exists', () => {
    const edges = new Map<string, Set<string>>();
    for (let i = 0; i < 5000; i += 1) edges.set(`n${i}`, new Set([`n${i + 1}`]));
    expect(findCycle(edges)).toBeUndefined();
    edges.set('n5000', new Set(['n0']));
    expect(findCycle(edges)?.length).toBeGreaterThan(5000);
  });

  it('refuses to index a corrupt stored model (re-validated on load)', () => {
    const corrupt = {
      products: [
        { key: 'a', name: 'A' },
        { key: 'b', name: 'B' },
      ],
      relationships: [
        { id: 'x', type: 'requires', product: 'a', anyOf: ['b'] },
        { id: 'y', type: 'requires', product: 'b', anyOf: ['a'] },
      ],
    };
    expect(() =>
      indexProductModel({
        version: 3,
        effectiveFrom: T0,
        document: corrupt,
        contentHash: 'x'.repeat(64),
      }),
    ).toThrow(CorruptProductModelError);
  });

  it('refuses a stored model whose hash does not match its document', () => {
    const v = validateProductModel(base());
    if (!v.ok) throw new Error('fixture');
    expect(() =>
      indexProductModel({
        version: 1,
        effectiveFrom: T0,
        document: v.document,
        contentHash: '0'.repeat(64),
      }),
    ).toThrow(/content hash/);
    expect(
      indexProductModel({
        version: 1,
        effectiveFrom: T0,
        document: v.document,
        contentHash: v.contentHash,
      }).products.size,
    ).toBe(5);
  });
});
