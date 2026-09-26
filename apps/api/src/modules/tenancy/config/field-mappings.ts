import { z } from 'zod';
import { CodeSchema } from '../../domain';

export const MappedSystemSchema = z.enum(['hubspot', 'sugar', 'gainsight_cs', 'gainsight_px']);
export type MappedSystem = z.infer<typeof MappedSystemSchema>;

export const CanonicalEntitySchema = z.enum([
  'lead',
  'lead_candidate',
  'person',
  'company',
  'sales_outcome',
]);

/**
 * How one canonical field maps onto a field in an external system.
 *
 * `status` makes unknowns explicit rather than guessed:
 *  - `tbc`: the external field is not known yet (externalField must be null)
 *  - `proposed`: a candidate field awaiting the customer's sign-off
 *  - `confirmed`: signed off; only confirmed mappings may drive writes (M9)
 */
export const FieldMappingSchema = z
  .strictObject({
    system: MappedSystemSchema,
    objectType: z.string().trim().min(1).max(100),
    canonicalEntity: CanonicalEntitySchema,
    canonicalField: CodeSchema,
    externalField: z.string().trim().min(1).max(200).nullable(),
    direction: z.enum(['inbound', 'outbound', 'bidirectional']),
    status: z.enum(['tbc', 'proposed', 'confirmed']),
    /** Picklist translation, canonical value → external value. */
    valueMap: z.record(z.string().min(1), z.string().min(1)).default({}),
    notes: z.string().trim().min(1).max(2000).nullable().default(null),
  })
  .refine((m) => (m.status === 'tbc') === (m.externalField === null), {
    message: 'externalField must be null exactly when status is tbc',
    path: ['externalField'],
  })
  .readonly();

export type FieldMapping = z.infer<typeof FieldMappingSchema>;
export type FieldMappingInput = z.input<typeof FieldMappingSchema>;
