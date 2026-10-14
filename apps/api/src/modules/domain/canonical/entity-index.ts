/**
 * Tenant entity index (M10 plan D2, F2, §18; M10A2 plan §7): the anchor for
 * polymorphic references. Maintained only by database triggers owned by the
 * powerless `lip_entity_indexer` role; the app role can only read it.
 */
export const ENTITY_INDEX_KINDS = ['company', 'person', 'product', 'subscription'] as const;
export type EntityIndexKind = (typeof ENTITY_INDEX_KINDS)[number];

/** Which table and identity column each kind indexes (D3: products by key). */
export const ENTITY_INDEX_SOURCES: Readonly<
  Record<EntityIndexKind, { readonly table: string; readonly column: 'id' | 'key' }>
> = {
  company: { table: 'companies', column: 'id' },
  person: { table: 'persons', column: 'id' },
  product: { table: 'tenant_products', column: 'key' },
  subscription: { table: 'tenant_subscriptions', column: 'id' },
};

/** The three triggers every indexed table carries (schema guard). */
export function entityIndexTriggerNames(table: string): string[] {
  return [
    `${table}_entity_index_add`,
    `${table}_entity_index_remove`,
    `${table}_identity_immutable`,
  ];
}
