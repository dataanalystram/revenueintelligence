import { z } from 'zod';
import { ExternalRefListSchema, RecordStateSchema } from './external-ref';
import { ProductOwnershipSchema, type ProductKey } from './product';
import { CompanyIdSchema, TenantIdSchema } from './shared/ids';
import { InstantSchema } from './shared/time';

export const CustomerStatusSchema = z.enum(['prospect', 'customer', 'former_customer', 'unknown']);
export type CustomerStatus = z.infer<typeof CustomerStatusSchema>;

const DomainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'invalid domain');

/** An organisation (school, MAT, business): HubSpot Company, Sugar Account, Gainsight Company. */
export const CompanySchema = z
  .object({
    id: CompanyIdSchema,
    tenantId: TenantIdSchema,
    /** Optional (ADR 0014): source records may have no usable name; never a placeholder. */
    name: z.string().trim().min(1).max(500).optional(),
    domains: z.array(DomainNameSchema).readonly().default([]),
    customerStatus: CustomerStatusSchema.default('unknown'),
    products: z.array(ProductOwnershipSchema).readonly().default([]),
    externalRefs: ExternalRefListSchema.default([]),
    recordState: RecordStateSchema.default('active'),
    /** The record this one was merged into (only when recordState is `merged`). */
    mergedIntoId: CompanyIdSchema.optional(),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .refine((c) => new Set(c.domains).size === c.domains.length, {
    message: 'duplicate domain',
    path: ['domains'],
  })
  .refine((c) => new Set(c.products.map((p) => p.productKey)).size === c.products.length, {
    message: 'a product may appear only once',
    path: ['products'],
  })
  .refine((c) => (c.recordState === 'merged') === (c.mergedIntoId !== undefined), {
    message: 'mergedIntoId is required exactly when the record is merged',
    path: ['mergedIntoId'],
  })
  .refine((c) => c.mergedIntoId !== c.id, {
    message: 'a record cannot be merged into itself',
    path: ['mergedIntoId'],
  })
  .refine((c) => c.createdAt <= c.updatedAt, {
    message: 'updatedAt must not be before createdAt',
    path: ['updatedAt'],
  })
  .readonly();

export type Company = z.infer<typeof CompanySchema>;
export type CompanyInput = z.input<typeof CompanySchema>;

/** True when the company currently has the product (active or on trial). */
export function ownsProduct(company: Company, productKey: ProductKey): boolean {
  return company.products.some(
    (p) => p.productKey === productKey && (p.status === 'active' || p.status === 'trial'),
  );
}

export function isCustomer(company: Company): boolean {
  return company.customerStatus === 'customer';
}
