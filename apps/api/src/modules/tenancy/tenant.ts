import { z } from 'zod';
import { InstantSchema, TenantIdSchema } from '../domain';

/**
 * Tenant slugs are embedded in secret keys (`tenant.<slug>.<system>.<name>`).
 * Letters and digits only: secret providers map `.`, `-` and `_` onto the same
 * character (e.g. environment variables use `_`), so allowing separators in a
 * slug could let two tenants' keys collide. See ADR 0008.
 */
export const TenantSlugSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]{1,39}$/,
    'slug must be 2-40 lowercase letters/digits, starting with a letter',
  )
  .brand<'TenantSlug'>();
export type TenantSlug = z.infer<typeof TenantSlugSchema>;

export const TenantStatusSchema = z.enum(['active', 'suspended', 'offboarded']);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const TenantSchema = z
  .object({
    id: TenantIdSchema,
    slug: TenantSlugSchema,
    name: z.string().trim().min(1).max(200),
    status: TenantStatusSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .readonly();
export type Tenant = z.infer<typeof TenantSchema>;
