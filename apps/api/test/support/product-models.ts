import { randomUUID } from 'node:crypto';
import {
  indexProductModel,
  validateProductModel,
  type CompanyId,
  type IndexedProductModel,
  type ProductKey,
  type ProductModelDocumentInput,
  type SubscriptionFact,
  type SubscriptionState,
} from '../../src/modules/domain';

/**
 * Generic, fictional product models for tests (M7). Never customer
 * configuration: product names describe shapes (core, add-on, bundle), not
 * anything a real tenant sells.
 */
export function genericModel(
  over: Partial<ProductModelDocumentInput> = {},
): ProductModelDocumentInput {
  return {
    products: [
      { key: 'core', name: 'Core', family: 'platform' },
      { key: 'core-pro', name: 'Core Pro', family: 'platform' },
      { key: 'analytics', name: 'Analytics', family: 'addons' },
      { key: 'analytics-plus', name: 'Analytics Plus', family: 'addons' },
      { key: 'reporting', name: 'Reporting', family: 'addons' },
      { key: 'legacy-reports', name: 'Legacy Reports', family: 'addons', status: 'retired' },
      { key: 'suite', name: 'Suite', family: 'bundles' },
      { key: 'onprem', name: 'On-premises', family: 'platform' },
    ],
    relationships: [
      {
        id: 'analytics-needs-core',
        type: 'requires',
        product: 'analytics',
        anyOf: ['core', 'core-pro'],
      },
      {
        id: 'plus-needs-core',
        type: 'requires',
        product: 'analytics-plus',
        anyOf: ['core', 'core-pro'],
      },
      {
        id: 'plus-replaces-analytics',
        type: 'replaces',
        product: 'analytics-plus',
        replaced: 'analytics',
      },
      { id: 'pro-replaces-core', type: 'replaces', product: 'core-pro', replaced: 'core' },
      { id: 'suite-has-reporting', type: 'includes', product: 'suite', included: 'reporting' },
      { id: 'suite-has-analytics', type: 'includes', product: 'suite', included: 'analytics' },
      { id: 'cloud-or-onprem', type: 'excludes', products: ['core', 'onprem'] },
    ],
    ...over,
  };
}

export function indexed(
  doc: ProductModelDocumentInput = genericModel(),
  version = 1,
): IndexedProductModel {
  const v = validateProductModel(doc);
  if (!v.ok)
    throw new Error(
      `invalid fixture model: ${v.errors.map((e) => `${e.code}@${e.path}`).join(', ')}`,
    );
  return indexProductModel({
    version,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    document: v.document,
    contentHash: v.contentHash,
  });
}

export function line(
  productKey: string,
  state: SubscriptionState = 'active',
  over: Partial<Omit<SubscriptionFact, 'productKey' | 'state'>> = {},
): SubscriptionFact {
  return { id: randomUUID(), productKey: productKey as ProductKey, state, ...over };
}

export const COMPANY = '11111111-1111-4111-8111-111111111111' as CompanyId;

/**
 * Publishes the latest model of a tenant plus `products` (tests that share a
 * tenant: keys can never disappear between versions, K1).
 */
export async function publishAdding(
  catalogue: {
    show(ctx: never, version?: number): Promise<{ document: unknown; version: number } | undefined>;
    publish(
      ctx: never,
      document: unknown,
      options: { actor: string; basedOnVersion: number },
    ): Promise<{ version: number }>;
  },
  ctx: unknown,
  products: readonly { key: string; name: string; status?: 'active' | 'retired' }[],
): Promise<{ version: number }> {
  const stored = await catalogue.show(ctx as never);
  const latest = stored?.document as ProductModelDocumentInput | undefined;
  const existing = latest?.products ?? [];
  const keys = new Set(existing.map((p) => p.key));
  return catalogue.publish(
    ctx as never,
    {
      ...(latest ?? {}),
      lifecycle: [],
      products: [
        ...existing.map((p) => ({ ...p, renamedFrom: undefined })),
        ...products.filter((p) => !keys.has(p.key)),
      ],
    },
    { actor: 'test', basedOnVersion: stored?.version ?? 0 },
  );
}
