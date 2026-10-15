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
  // M10D (Q4): 256 KiB → 1 MiB and 300 → 1,000 fields so a mapping can carry the
  // E4 "500+ fields" extension attributes. Limits only widen: every published
  // mapping still validates, and the mapping hash never covers a limit.
  documentBytes: 1024 * 1024,
  objects: 20,
  fieldsPerObject: 1000,
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

const ExtensionKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

/**
 * M10D (plan §5.1): a source field into a published extension field of the
 * object's entity (or custom object). Needs canonical 0.4 and module
 * `extension` (below 0.4: `attribute_mappings_not_enabled`).
 */
export const AttributeEntrySchema = z.strictObject({
  kind: z.literal('attribute'),
  field: ExtensionKey,
  source: ApiName,
  transforms: TransformsSchema.optional(),
  confirmation: ConfirmationSchema.optional(),
});
export type AttributeEntry = z.infer<typeof AttributeEntrySchema>;

/**
 * M10D (plan §5.4, Q20): a source field captured into a `source_captured`
 * extension field already published as `src_<kind>_<object>_<field>`; mapping
 * publish never publishes registry entries (`extension capture-draft`).
 */
export const CaptureEntrySchema = z.strictObject({
  kind: z.literal('capture'),
  source: ApiName,
});
export type CaptureEntry = z.infer<typeof CaptureEntrySchema>;

export const FieldEntrySchema = z.union([
  MappedFieldEntrySchema,
  ExplicitFieldEntrySchema,
  IgnoredEntrySchema,
  AttributeEntrySchema,
  CaptureEntrySchema,
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
  /**
   * M10D (`custom_relationship:<key>` only, plan §5.3): the role of the edge,
   * a value map into the definition's role code only.
   */
  role: z
    .strictObject({
      field: ApiName,
      valueMap: z.record(z.string().min(1).max(200), z.string().regex(/^[a-z0-9_]{1,64}$/)),
    })
    .optional(),
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

const ContextKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const ContextCode = z.string().regex(/^[a-z0-9_]{1,64}$/);
const SourceValue = z.string().min(1).max(200);

/**
 * M10E (plan §5.1, ADR 0031): the statements of an object mapped as entity
 * `account_context`. Each key is one target of the plan's catalogue:
 * `account_context.account` (`account`), `.type` (`type`, a constant context
 * type key per object), `.name`, `.status` (value map), `.ownerRef`,
 * `.renewalDate`, `.dimension.<key>` (`dimensions`) and
 * `account_context.person` (`persons`, role constant or value map). Closed
 * transforms only: value maps, no expressions.
 */
export const AccountContextMappingSchema = z.strictObject({
  type: ContextKey,
  account: z.strictObject({ field: ApiName, object: ApiName }),
  name: z.strictObject({ field: ApiName }).optional(),
  status: z
    .strictObject({
      field: ApiName,
      valueMap: z.record(SourceValue, z.enum(['active', 'inactive', 'retired'])),
    })
    .optional(),
  ownerRef: z.strictObject({ field: ApiName }).optional(),
  renewalDate: z.strictObject({ field: ApiName }).optional(),
  dimensions: z
    .array(
      z.strictObject({
        key: ContextKey,
        field: ApiName,
        valueMap: z.record(SourceValue, SourceValue).optional(),
      }),
    )
    .max(6)
    .optional(),
  persons: z
    .array(
      z.strictObject({
        field: ApiName,
        object: ApiName,
        role: z.union([
          z.strictObject({ constant: ContextCode }),
          z.strictObject({ field: ApiName, valueMap: z.record(SourceValue, ContextCode) }),
        ]),
      }),
    )
    .max(5)
    .optional(),
});
export type AccountContextMapping = z.infer<typeof AccountContextMappingSchema>;

export const ObjectMappingSchema = z.strictObject({
  source: ApiName,
  entity: z.string().max(50),
  identity: z.strictObject({ field: ApiName, confirmation: ConfirmationSchema.optional() }),
  holdingFilter: HoldingFilterSchema.optional(),
  /** Explicit, confirmed statement that every record of the object is a holding. */
  allRecordsAreHoldings: z.strictObject({ confirmation: ConfirmationSchema.optional() }).optional(),
  relationships: z.array(RelationshipEntrySchema).max(10).default([]),
  fields: z.array(FieldEntrySchema).max(MAPPING_LIMITS.fieldsPerObject).default([]),
  /**
   * M10D (entity `custom_object:<key>` only, plan §5.2): the record's parent
   * (a reference field to an object mapped as the definition's parent entity)
   * and its state (a value map into active / inactive / retired). Holding
   * filters never apply to custom objects (no ownership semantics).
   */
  customObject: z
    .strictObject({
      parent: z.strictObject({ field: ApiName, object: ApiName }).optional(),
      recordState: z
        .strictObject({
          field: ApiName,
          valueMap: z.record(z.string().min(1).max(200), z.enum(['active', 'inactive', 'retired'])),
        })
        .optional(),
    })
    .optional(),
  /** M10E (entity `account_context` only, plan §5.1): the context statements. */
  accountContext: AccountContextMappingSchema.optional(),
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
