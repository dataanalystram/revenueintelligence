import { z } from 'zod';

/**
 * Chargebee API v2 response shapes (Product Catalog 2.0), validated at the
 * connector boundary. Shapes follow Chargebee's official SDK types
 * (`chargebee@3.34.0`) and API reference; live-gate items are marked V#.
 * Only the attributes the platform declares are kept; everything else
 * (including `card` and payment data) is dropped unread.
 */

/** UTC Unix seconds (F18). Milliseconds or strings are not timestamps here. */
const Seconds = z.number().int().min(0).max(9_999_999_999);
/** Chargebee identifiers (V7: length and character set re-checked on the test site). */
const Id = z.string().regex(/^[A-Za-z0-9_.@-]{1,100}$/);

/** `GET /{resource}` list envelope: entries and an opaque continuation token. */
export const ListEnvelopeSchema = z.looseObject({
  list: z.array(z.record(z.string(), z.unknown())),
  next_offset: z.string().min(1).max(2000).optional(),
});
export type ListEnvelope = z.infer<typeof ListEnvelopeSchema>;

export const CustomerSchema = z.looseObject({
  id: Id,
  company: z.string().max(250).nullish(),
  created_at: Seconds,
  updated_at: Seconds.optional(),
  resource_version: z.number().int().nonnegative().optional(),
  deleted: z.boolean(),
  business_entity_id: z.string().max(50).optional(),
});
export type ChargebeeCustomer = z.infer<typeof CustomerSchema>;

export const ItemSchema = z.looseObject({
  id: Id,
  name: z.string().max(250),
  type: z.string().max(30),
  status: z.string().max(30).optional(),
  item_family_id: z.string().max(100).optional(),
  metered: z.boolean().optional(),
  updated_at: Seconds.optional(),
  archived_at: Seconds.optional(),
  deleted: z.boolean().optional(),
});
export type ChargebeeItem = z.infer<typeof ItemSchema>;

export const ItemPriceSchema = z.looseObject({
  id: Id,
  item_id: Id.optional(),
  item_type: z.string().max(30).optional(),
  status: z.string().max(30).optional(),
  currency_code: z.string().max(10),
  period: z.number().int().optional(),
  period_unit: z.string().max(10).optional(),
  price_variant_id: z.string().max(100).optional(),
  pricing_model: z.string().max(30),
  updated_at: Seconds.optional(),
  deleted: z.boolean().optional(),
});
export type ChargebeeItemPrice = z.infer<typeof ItemPriceSchema>;

export const SubscriptionItemSchema = z.looseObject({
  item_price_id: Id,
  item_type: z.string().max(30),
  quantity: z.number().int().optional(),
  quantity_in_decimal: z.string().max(40).optional(),
  current_term_start: Seconds.optional(),
  current_term_end: Seconds.optional(),
});

export const SubscriptionSchema = z.looseObject({
  id: Id,
  customer_id: Id,
  status: z.string().max(30),
  start_date: Seconds.optional(),
  started_at: Seconds.optional(),
  activated_at: Seconds.optional(),
  trial_start: Seconds.optional(),
  trial_end: Seconds.optional(),
  current_term_start: Seconds.optional(),
  current_term_end: Seconds.optional(),
  next_billing_at: Seconds.optional(),
  cancelled_at: Seconds.optional(),
  cancel_reason: z.string().max(60).optional(),
  pause_date: Seconds.optional(),
  resume_date: Seconds.optional(),
  created_at: Seconds.optional(),
  updated_at: Seconds.optional(),
  /** A millisecond value (F18): an ordering value only, never a time. */
  resource_version: z.number().int().nonnegative().optional(),
  deleted: z.boolean(),
  decommissioned: z.boolean().optional(),
  business_entity_id: z.string().max(50).optional(),
  subscription_items: z.array(SubscriptionItemSchema).min(1).max(250),
});
export type ChargebeeSubscription = z.infer<typeof SubscriptionSchema>;

/** Error bodies: Chargebee's `api_error_code` (a code, never a value). */
export const ErrorBodySchema = z.looseObject({
  api_error_code: z.string().max(100).optional(),
  error_code: z.string().max(100).optional(),
});
