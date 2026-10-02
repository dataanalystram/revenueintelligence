import { type z } from 'zod';
import { CodeSchema } from './shared/codes';

/**
 * Products are identified by tenant-configured keys (e.g. `marketplace`),
 * never by a hard-coded catalogue. The key is the product identity within a
 * tenant and never changes meaning (ADR 0016). What an account holds is
 * modelled by subscriptions (`subscription.ts`); ownership is derived from
 * them (`eligibility.ts`), never stored on the company.
 */
export const ProductKeySchema = CodeSchema.brand<'ProductKey'>();
export type ProductKey = z.infer<typeof ProductKeySchema>;
