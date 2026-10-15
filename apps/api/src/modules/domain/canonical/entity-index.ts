/**
 * Tenant entity index (M10 plan D2, F2, §18; M10A2 plan §7): the anchor for
 * polymorphic references. Maintained only by database triggers owned by the
 * powerless `lip_entity_indexer` role; the app role can only read it.
 */
export const ENTITY_INDEX_KINDS = [
  'company',
  'person',
  'product',
  'subscription',
  // M10C (0.3): affiliations are polymorphic evidence / extension targets (Q21).
  'person_affiliation',
  // M10D (0.4): records of custom objects (module `extension`, Q25).
  'custom_record',
] as const;

/** The kinds published with canonical 0.1 / 0.2 (frozen: their catalogue hashes never change). */
export const ENTITY_INDEX_KINDS_0_1 = ['company', 'person', 'product', 'subscription'] as const;
/** The kinds published with canonical 0.3 (frozen for its catalogue hash). */
export const ENTITY_INDEX_KINDS_0_3 = [
  'company',
  'person',
  'product',
  'subscription',
  'person_affiliation',
] as const;
export type EntityIndexKind = (typeof ENTITY_INDEX_KINDS)[number];

/** Which table and identity column each kind indexes (D3: products by key). */
export const ENTITY_INDEX_SOURCES: Readonly<
  Record<EntityIndexKind, { readonly table: string; readonly column: 'id' | 'key' }>
> = {
  company: { table: 'companies', column: 'id' },
  person: { table: 'persons', column: 'id' },
  product: { table: 'tenant_products', column: 'key' },
  subscription: { table: 'tenant_subscriptions', column: 'id' },
  person_affiliation: { table: 'tenant_person_affiliations', column: 'id' },
  custom_record: { table: 'tenant_custom_records', column: 'id' },
};

/** The three triggers every indexed table carries (schema guard). */
export function entityIndexTriggerNames(table: string): string[] {
  return [
    `${table}_entity_index_add`,
    `${table}_entity_index_remove`,
    `${table}_identity_immutable`,
  ];
}
