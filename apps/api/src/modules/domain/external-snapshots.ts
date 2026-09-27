import { z } from 'zod';
import { EmailAddressSchema } from './email';
import { ExternalRefSchema, ExternalSystemSchema } from './external-ref';
import { InstantSchema } from './shared/time';

/**
 * Vendor-neutral read models produced by connectors (HubSpot, Sugar,
 * Gainsight). They describe what an external system holds, without its native
 * payload shape, so core logic never depends on a vendor format.
 *
 * They are snapshots, not canonical entities: identity resolution (M11) and
 * the field-mapping engine (M9) turn them into Person / Company / Lead.
 * `attributes` holds the record's raw field values keyed by the external
 * field name. Which of them matter is tenant configuration (field mappings);
 * core code never reads a vendor field name directly.
 */
const AttributesSchema = z.record(z.string().min(1), z.string().nullable()).readonly();

const recordMeta = {
  ref: ExternalRefSchema,
  createdAt: InstantSchema.optional(),
  updatedAt: InstantSchema.optional(),
  archived: z.boolean(),
  attributes: AttributesSchema,
};

export const ExternalPersonSnapshotSchema = z
  .object({
    ...recordMeta,
    /** Normalised; undefined when absent or not a valid address (raw value stays in attributes). */
    email: EmailAddressSchema.optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    jobTitle: z.string().optional(),
  })
  .readonly();

export const ExternalCompanySnapshotSchema = z
  .object({
    ...recordMeta,
    name: z.string().optional(),
    /** Lower-cased web domain, if present. */
    domain: z.string().optional(),
  })
  .readonly();

export const ExternalLeadSnapshotSchema = z
  .object({
    ...recordMeta,
    name: z.string().optional(),
  })
  .readonly();

export type ExternalPersonSnapshot = z.infer<typeof ExternalPersonSnapshotSchema>;
export type ExternalCompanySnapshot = z.infer<typeof ExternalCompanySnapshotSchema>;
export type ExternalLeadSnapshot = z.infer<typeof ExternalLeadSnapshotSchema>;

/** One field (property) definition in an external system's schema. */
export const ExternalFieldDefinitionSchema = z
  .object({
    system: ExternalSystemSchema,
    objectType: z.string().min(1),
    name: z.string().min(1),
    label: z.string(),
    /** The system's data type, e.g. string, number, enumeration, datetime. */
    type: z.string().min(1),
    fieldType: z.string().optional(),
    group: z.string().optional(),
    /** Picklist options (value → label), empty for non-picklist fields. */
    options: z
      .array(
        z
          .object({ value: z.string(), label: z.string(), hidden: z.boolean().optional() })
          .readonly(),
      )
      .readonly(),
    /** Defined by the vendor (true) or created by the customer (false). */
    vendorDefined: z.boolean(),
    readOnlyValue: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .readonly();
export type ExternalFieldDefinition = z.infer<typeof ExternalFieldDefinitionSchema>;

/**
 * `other` is the fallback for a category the external system adds later, so
 * reads keep working (the raw category is not needed by business code).
 */
export const AssociationCategorySchema = z.enum([
  'standard',
  'user_defined',
  'integrator_defined',
  'other',
]);

export const ExternalAssociationTypeSchema = z
  .object({
    category: AssociationCategorySchema,
    typeId: z.number().int(),
    /** e.g. "Primary"; null for the unlabelled default association. */
    label: z.string().nullable(),
  })
  .readonly();
export type ExternalAssociationType = z.infer<typeof ExternalAssociationTypeSchema>;

/** A link from one external record to another, with its association types. */
export const ExternalAssociationSchema = z
  .object({
    from: ExternalRefSchema,
    to: ExternalRefSchema,
    types: z.array(ExternalAssociationTypeSchema).min(1).readonly(),
  })
  .readonly();
export type ExternalAssociation = z.infer<typeof ExternalAssociationSchema>;

/** A page of results with an opaque cursor for the next page. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
}
