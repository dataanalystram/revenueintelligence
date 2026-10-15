import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ReviewedDomainSchema } from './holding-domain';
import { stableJson } from './source-connector';
import { TransformsSchema } from './source-transforms';

/**
 * The versioned source mapping document schema (ADR 0020), separate from its
 * validator so profile-aware checks can read the document types without a
 * module cycle. Re-exported by `source-mapping.ts`.
 */
export const MAPPING_LIMITS = {
  documentBytes: 256 * 1024,
  objects: 20,
  fieldsPerObject: 300,
  holdingValues: 200,
  ignoredProducts: 5000,
} as const;

const ApiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
const ReasonCode = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

/** Who confirmed a consequential choice, and what they confirmed. Optional in
 * the schema so a missing confirmation is reported as a validation code. */
export const ConfirmationSchema = z
  .strictObject({
    by: z.string().trim().min(1).max(100),
    note: z.string().trim().min(1).max(500),
  })
  .readonly();
export type Confirmation = z.infer<typeof ConfirmationSchema>;

export const MappingEntitySchema = z.enum(['account', 'person', 'subscription']);
export type MappingEntity = z.infer<typeof MappingEntitySchema>;

// ---------------------------------------------------------------------------
// Document schema
// ---------------------------------------------------------------------------

export const MappedFieldEntrySchema = z.strictObject({
  kind: z.literal('core'),
  target: z.string().max(100),
  source: ApiName,
  transforms: TransformsSchema.optional(),
  confirmation: ConfirmationSchema.optional(),
});

const ExplicitFieldEntrySchema = z.strictObject({
  kind: z.literal('core'),
  target: z.string().max(100),
  /** "No source" stated deliberately: `unknown` (targets with an unknown value) or `null`. */
  explicit: z.enum(['unknown', 'null']),
  reason: ReasonCode,
});

const IgnoredEntrySchema = z.strictObject({
  kind: z.literal('ignored'),
  source: ApiName,
  reason: ReasonCode,
});

/** Reserved until the attribute registry exists (refused by the validator). */
const AttributeEntrySchema = z.looseObject({ kind: z.literal('attribute') });

export const FieldEntrySchema = z.union([
  MappedFieldEntrySchema,
  ExplicitFieldEntrySchema,
  IgnoredEntrySchema,
  AttributeEntrySchema,
]);
export type FieldEntry = z.infer<typeof FieldEntrySchema>;

export const RelationshipEntrySchema = z.strictObject({
  target: z.string().max(100),
  /** A field on the mapped object itself. */
  field: ApiName,
  /** The object the value points at (accounts); omitted for product references. */
  object: ApiName.optional(),
  productReference: z.literal(true).optional(),
  /** One confirmed hop when `field` is empty (no multi-hop, no joins). */
  fallbackVia: z
    .strictObject({
      field: ApiName,
      object: ApiName,
      targetField: ApiName,
      confirmation: ConfirmationSchema.optional(),
    })
    .optional(),
  /** M10C: a recorded confirmation of a consequential relationship (`account.parent`). */
  confirmation: ConfirmationSchema.optional(),
  /**
   * M10C (`person.affiliation` only): further fields of the same record that
   * describe the affiliation. Role values become codes only through the explicit
   * value map (Q11); unmapped values are dropped and counted, never stored.
   */
  affiliation: z
    .strictObject({
      roleField: ApiName.optional(),
      roleValueMap: z
        .record(z.string().min(1).max(200), z.string().regex(/^[a-z0-9_]{1,64}$/))
        .optional(),
      startsAtField: ApiName.optional(),
      endsAtField: ApiName.optional(),
    })
    .optional(),
});
export type RelationshipEntry = z.infer<typeof RelationshipEntrySchema>;

/**
 * The holding filter (ADR 0020 §6): exactly one field of the mapped object,
 * one membership predicate. No nesting, combinations, expressions, scripting,
 * SQL fragments or cross-field comparisons. Fields of a parent or related
 * object are not supported (ADR 0020 §7).
 */
export const HoldingFilterSchema = z.strictObject({
  field: ApiName,
  operator: z.enum(['in', 'not_in']),
  values: z.array(z.string().min(1).max(200)).min(1).max(MAPPING_LIMITS.holdingValues),
  confirmation: ConfirmationSchema.optional(),
  /**
   * M9A (ADR 0023): every value the filter can meet, classified `holding` or
   * `non_holding`, including the empty value (`null`). Optional in the schema
   * so a missing domain is reported as a validation code; versions published
   * before M9A carry none and must be republished (`mapping_requires_republish`).
   */
  reviewedDomain: ReviewedDomainSchema.optional(),
});
export type HoldingFilter = z.infer<typeof HoldingFilterSchema>;

export const ObjectMappingSchema = z.strictObject({
  source: ApiName,
  entity: z.string().max(50),
  identity: z.strictObject({ field: ApiName, confirmation: ConfirmationSchema.optional() }),
  holdingFilter: HoldingFilterSchema.optional(),
  /** Explicit, confirmed statement that every record of the object is a holding. */
  allRecordsAreHoldings: z.strictObject({ confirmation: ConfirmationSchema.optional() }).optional(),
  relationships: z.array(RelationshipEntrySchema).max(10).default([]),
  fields: z.array(FieldEntrySchema).max(MAPPING_LIMITS.fieldsPerObject).default([]),
});
export type ObjectMapping = z.infer<typeof ObjectMappingSchema>;

export const ProductReferencesSchema = z.strictObject({
  /** The source's product catalogue object (a reference set only). */
  object: ApiName,
  identity: z.strictObject({ field: ApiName }),
  /** Source products that are not subscription products: their lines are skipped. */
  ignored: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/),
        reason: ReasonCode,
      }),
    )
    .max(MAPPING_LIMITS.ignoredProducts)
    .default([]),
});
export type ProductReferences = z.infer<typeof ProductReferencesSchema>;

export const MappingDocumentSchema = z.strictObject({
  objects: z.array(ObjectMappingSchema).min(1).max(MAPPING_LIMITS.objects),
  productReferences: ProductReferencesSchema.optional(),
});
export type MappingDocument = z.infer<typeof MappingDocumentSchema>;

export function mappingContentHash(doc: MappingDocument): string {
  return createHash('sha256').update(stableJson(doc)).digest('hex');
}
