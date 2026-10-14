/**
 * Generic source references (M10B plan §2, ADR 0028). The database CHECKs on
 * `tenant_source_references` equal these lists (schema guard).
 *
 * Company and person references stay in their legacy stores
 * (`company_external_refs`, `person_external_refs`) and subscription lines keep
 * their inline source triple (ADR 0017); the generic store refuses those kinds
 * by the named CHECK `tenant_source_references_not_legacy_kind` (Q2). All
 * stores are read together through the read-only `source_reference_index` view.
 */

/** Entity kinds the generic store holds. M10B: `product` only; later sub-milestones add theirs. */
export const GENERIC_REFERENCE_KINDS = ['product'] as const;
export type GenericReferenceKind = (typeof GENERIC_REFERENCE_KINDS)[number];

/** Kinds whose references live in a legacy store; never written to the generic store. */
export const LEGACY_REFERENCE_KINDS = ['company', 'person', 'subscription'] as const;
export type LegacyReferenceKind = (typeof LEGACY_REFERENCE_KINDS)[number];

/** Key-identified kinds (D3): the reference names `entity_key`, every other kind `entity_id`. */
export const KEY_IDENTIFIED_REFERENCE_KINDS: readonly GenericReferenceKind[] = ['product'];

export const SOURCE_REFERENCE_STATES = ['active', 'retired', 'deleted', 'merged'] as const;
export type SourceReferenceState = (typeof SOURCE_REFERENCE_STATES)[number];

/**
 * `observed`: a source read returned it. `declared`: a published configuration
 * document (the product model) declares it; written only by product-model publish.
 */
export const SOURCE_REFERENCE_ORIGINS = ['observed', 'declared'] as const;
export type SourceReferenceOrigin = (typeof SOURCE_REFERENCE_ORIGINS)[number];

/** Identifier-only source coordinates (as `ProductExternalRefSchema`); never a value. */
export const SOURCE_OBJECT_TYPE_PATTERN = /^[A-Za-z0-9_]{1,100}$/;
export const SOURCE_EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;

/** The stores the `source_reference_index` view unions (plan §4), by `store` value. */
export const SOURCE_REFERENCE_STORES = [
  'company_external_refs',
  'person_external_refs',
  'tenant_subscriptions',
  'tenant_source_references',
] as const;
export type SourceReferenceStore = (typeof SOURCE_REFERENCE_STORES)[number];

/** The `adapter` written on product-reference change records (plan §6, Q8). */
export const PRODUCT_REFERENCE_ADAPTER = 'product-model';
/** `changed_fields` of a product-reference change record. */
export const SOURCE_REFERENCE_CHANGED_FIELD = 'source_reference';
