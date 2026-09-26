import { z } from 'zod';
import { CodeSchema } from './shared/codes';
import { InstantSchema } from './shared/time';

/**
 * Products are identified by tenant-configured keys (e.g. `marketplace`),
 * never by a hard-coded catalogue.
 */
export const ProductKeySchema = CodeSchema.brand<'ProductKey'>();
export type ProductKey = z.infer<typeof ProductKeySchema>;

export const OwnershipStatusSchema = z.enum(['active', 'trial', 'expired', 'churned']);
export type OwnershipStatus = z.infer<typeof OwnershipStatusSchema>;

/** A company's relationship with one product (typically from Gainsight CS). */
export const ProductOwnershipSchema = z
  .object({
    productKey: ProductKeySchema,
    status: OwnershipStatusSchema,
    since: InstantSchema.optional(),
    until: InstantSchema.optional(),
  })
  .refine((o) => !o.since || !o.until || o.since <= o.until, {
    message: 'since must not be after until',
    path: ['until'],
  })
  .readonly();

export type ProductOwnership = z.infer<typeof ProductOwnershipSchema>;
