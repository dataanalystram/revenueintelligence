import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CONTEXT_CONFLICT_KINDS,
  ACCOUNT_CONTEXT_MIN_VERSION,
  ACCOUNT_CONTEXT_MODULE_KEY,
  contextExtensionRefs,
  contextNaturalKeyHash,
  contextTypeRuleViolations,
  validateContextTypeDocument,
  type ContextTypeDocument,
} from './account-context';
import { IDENTITY_CONFLICT_KINDS } from './account-structure';
import { canonicalCatalogueFor } from './catalogue';
import { registryRuleViolations } from './registry';
import { canonicalCatalogueHash } from './versions';

/** M10E plan §2 (V1, V2, V6 phase-1 subset): canonical 0.5 catalogue and the context_type document. */
const dim = (over: Record<string, unknown> = {}) => ({
  key: 'region',
  type: 'code',
  required: true,
  codes: ['emea', 'amer'],
  sensitivity: 'internal',
  categories: ['operational'],
  ...over,
});
const product = (over: Record<string, unknown> = {}) =>
  dim({
    key: 'product',
    type: 'product_key',
    codes: undefined,
    categories: ['commercial'],
    ...over,
  });
const type = (over: Record<string, unknown> = {}) => ({
  key: 'product_region',
  title: 'Product in a region',
  description: 'One product of the account in one region',
  dimensions: [product(), dim()],
  member_roles: ['csm'],
  ...over,
});
const doc = (...types: Record<string, unknown>[]) => ({ schema_version: 1, types });
const issues = (raw: unknown) => {
  const v = validateContextTypeDocument(raw);
  return v.ok ? [] : v.issues.map((i) => `${i.key}:${i.code}`);
};
const entries = (raw: unknown) => {
  const v = validateContextTypeDocument(raw);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return v.entries;
};

describe('V1 / V2: canonical 0.5 catalogue (M10E plan §10)', () => {
  it('stored 0.1–0.4 hashes are reproduced from frozen lists; 0.5 adds the M10E members', () => {
    const stored = {
      '0.1': '2fd4f7e575633de7cac4aea394a71c73adc9b73e5e18b67c0b0ee404572faf5b',
      '0.2': 'db7c0fc245cae469e8cddae88b89077c017805c7b87586b9d3e71f1936c96c98',
      '0.3': '70db9aa697147cf1d0d63e93a923ed8714b78da32550aaefe5699597e26eb069',
      '0.4': '70584afd267f4c5620c2d63c95cc547f18c1cacdb0b408304eea9a41aeae81c7',
      '0.5': 'bfc152541c0788a1532d400e1dd0d23c450f228fa7509e5108966dee9e2b46e2',
    } as const;
    for (const [v, hash] of Object.entries(stored)) {
      expect(canonicalCatalogueHash(canonicalCatalogueFor(v)), v).toBe(hash);
    }
    for (const v of ['0.1', '0.2', '0.3', '0.4']) {
      const c = canonicalCatalogueFor(v);
      expect(c.entityKinds, v).not.toContain('account_context');
      expect(c.changeEntityKinds ?? [], v).not.toContain('account_context_person');
    }
  });

  it('module account_context and its minimum version', () => {
    expect(ACCOUNT_CONTEXT_MODULE_KEY).toBe('account_context');
    expect(ACCOUNT_CONTEXT_MIN_VERSION).toBe('0.5');
    for (const k of ACCOUNT_CONTEXT_CONFLICT_KINDS) expect(IDENTITY_CONFLICT_KINDS).toContain(k);
  });
});

describe('V6: context_type registry document (plan §2.1)', () => {
  it('accepts a type and projects one entry with its strictest classification and roles as codes', () => {
    const out = entries(
      doc(
        type({
          dimensions: [product(), dim({ sensitivity: 'confidential', categories: ['financial'] })],
        }),
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: 'product_region',
      status: 'active',
      sensitivity: 'confidential',
      categories: ['financial', 'commercial'],
    });
    expect(out[0]!.definition).toMatchObject({ kind: 'context_type', codes: ['csm'] });
  });

  it('defaults: no member roles, no explicit products, active', () => {
    const out = entries(doc(type({ member_roles: undefined })));
    expect(out[0]!.definition).toMatchObject({
      member_roles: [],
      allow_products: false,
      codes: [],
    });
  });

  it('refuses unclassified, below-floor and restricted dimensions (R-C5, Q11)', () => {
    expect(issues(doc(type({ dimensions: [dim({ sensitivity: undefined })] })))).toEqual([
      'product_region.region:classification_required',
    ]);
    expect(issues(doc(type({ dimensions: [dim({ categories: ['financial'] })] })))).toEqual([
      'product_region.region:classification_below_floor',
    ]);
    expect(
      issues(
        doc(type({ dimensions: [dim({ sensitivity: 'restricted', categories: ['commercial'] })] })),
      ),
    ).toEqual(['product_region.region:restricted_dimension_refused']);
  });

  it('refuses credential-like keys and titles (R-C5, the M10D token list)', () => {
    expect(issues(doc(type({ title: 'API key scope' })))).toEqual([
      'product_region:credential_like_definition',
    ]);
    expect(issues(doc(type({ dimensions: [dim({ key: 'access_token' })] })))).toEqual([
      'product_region.access_token:credential_like_definition',
    ]);
  });

  it('per-type dimension rules: codes exactly for code, extension_field exactly for extension_ref', () => {
    expect(issues(doc(type({ dimensions: [dim({ codes: undefined })] })))).toEqual([
      'product_region.region:dimension_codes_invalid',
    ]);
    expect(issues(doc(type({ dimensions: [product({ codes: ['a'] })] })))).toEqual([
      'product_region.product:dimension_codes_invalid',
    ]);
    expect(
      issues(doc(type({ dimensions: [dim({ type: 'extension_ref', codes: undefined })] }))),
    ).toEqual(['product_region.region:dimension_extension_field_invalid']);
    expect(
      issues(
        doc(
          type({
            dimensions: [dim({ type: 'string', codes: undefined, extension_field: 'segment' })],
          }),
        ),
      ),
    ).toEqual(['product_region.region:dimension_extension_field_invalid']);
  });

  it('refuses duplicates, more than six dimensions and an unknown member', () => {
    expect(issues(doc(type(), type()))).toEqual(['product_region:duplicate_key']);
    expect(issues(doc(type({ dimensions: [dim(), dim()] })))).toEqual([
      'product_region.region:duplicate_dimension',
    ]);
    expect(issues(doc(type({ member_roles: ['csm', 'csm'] })))).toEqual([
      'product_region:duplicate_role',
    ]);
    const seven = Array.from({ length: 7 }, (_, i) => dim({ key: `d${i}` }));
    expect(issues(doc(type({ dimensions: seven })))).toEqual(['types.0.dimensions:too_big']);
    expect(issues(doc(type({ dimensions: [] })))).toEqual(['types.0.dimensions:too_small']);
    expect(issues({ ...doc(type()), extra: true })).toEqual(['(document):unrecognized_keys']);
  });

  it('lists extension_ref dimensions for the R-C4 publish lookup', () => {
    const d = {
      schema_version: 1,
      types: [
        type({
          dimensions: [
            product(),
            dim({
              key: 'seg',
              type: 'extension_ref',
              codes: undefined,
              extension_field: 'segment',
            }),
          ],
        }),
      ],
    } as unknown as ContextTypeDocument;
    expect(contextExtensionRefs(d)).toEqual([
      { type: 'product_region', dimension: 'seg', field: 'segment' },
    ]);
  });
});

describe('V6: context_type cross-version rules (plan §2.2)', () => {
  const stored = entries(doc(type()));
  const next = (over: Record<string, unknown>) => entries(doc(type(over)));

  it('R-C1: dimension keys, order and types never change', () => {
    expect(contextTypeRuleViolations(stored, next({ dimensions: [dim(), product()] }))).toEqual([
      { rule: 'R-C1', key: 'product_region' },
    ]);
    expect(
      contextTypeRuleViolations(
        stored,
        next({ dimensions: [product(), dim(), dim({ key: 'tier' })] }),
      ),
    ).toEqual([{ rule: 'R-C1', key: 'product_region' }]);
    expect(
      contextTypeRuleViolations(
        stored,
        next({ dimensions: [product(), dim({ type: 'string', codes: undefined })] }),
      ),
    ).toEqual([{ rule: 'R-C1', key: 'product_region' }]);
  });

  it('R-C2: a code dimension never loses a code; adding one is allowed', () => {
    expect(
      contextTypeRuleViolations(
        stored,
        next({ dimensions: [product(), dim({ codes: ['emea'] })] }),
      ),
    ).toEqual([{ rule: 'R-C2', key: 'product_region' }]);
    expect(
      contextTypeRuleViolations(
        stored,
        next({ dimensions: [product(), dim({ codes: ['emea', 'amer', 'apac'] })] }),
      ),
    ).toEqual([]);
  });

  it('R-C3: classification only becomes stricter', () => {
    expect(
      contextTypeRuleViolations(
        stored,
        next({ dimensions: [product({ sensitivity: 'public' }), dim()] }),
      ),
    ).toEqual([{ rule: 'R-C3', key: 'product_region' }]);
    expect(
      contextTypeRuleViolations(
        stored,
        next({ dimensions: [product(), dim({ categories: ['commercial'] })] }),
      ),
    ).toEqual([{ rule: 'R-C3', key: 'product_region' }]);
    expect(
      contextTypeRuleViolations(
        stored,
        next({ dimensions: [product({ sensitivity: 'confidential' }), dim()] }),
      ),
    ).toEqual([]);
  });

  it('R-C6 / R-X1 / R-X3: a type is retired, never removed; member roles never disappear', () => {
    expect(contextTypeRuleViolations(stored, next({ status: 'retired' }))).toEqual([]);
    expect(registryRuleViolations(stored, [])).toEqual([{ rule: 'R-X1', key: 'product_region' }]);
    expect(registryRuleViolations(stored, next({ member_roles: [] }))).toEqual([
      { rule: 'R-X3', key: 'product_region' },
    ]);
  });
});

describe('natural key (Q4)', () => {
  it('hashes the ordered dimension values; order and every dimension matter; absent is null', () => {
    const order = ['product', 'region'];
    const emea = contextNaturalKeyHash(order, { product: 'p1', region: 'emea' });
    const amer = contextNaturalKeyHash(order, { product: 'p1', region: 'amer' });
    expect(emea).toMatch(/^[0-9a-f]{64}$/);
    expect(emea).not.toBe(amer);
    expect(
      contextNaturalKeyHash(['region', 'product'], { product: 'p1', region: 'emea' }),
    ).not.toBe(emea);
    expect(contextNaturalKeyHash(order, { product: 'p1' })).toBe(
      contextNaturalKeyHash(order, { product: 'p1', region: null }),
    );
    expect(contextNaturalKeyHash(order, { product: 'p1', region: 'emea', extra: 'x' })).toBe(emea);
  });
});
