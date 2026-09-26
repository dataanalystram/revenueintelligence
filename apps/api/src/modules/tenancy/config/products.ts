import { z } from 'zod';
import { ProductKeySchema } from '../../domain';

/** An entry in a tenant's product catalogue. Company ownership references these keys. */
export const ProductSchema = z
  .strictObject({
    key: ProductKeySchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000).nullable().default(null),
    active: z.boolean().default(true),
  })
  .readonly();
export type Product = z.infer<typeof ProductSchema>;
export type ProductInput = z.input<typeof ProductSchema>;
