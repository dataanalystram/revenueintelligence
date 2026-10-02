import { z } from 'zod';
import { ExternalSystemSchema } from './external-ref';
import { ProductKeySchema } from './product';
import { type CompanyIdSchema } from './shared/ids';
import { InstantSchema } from './shared/time';

/**
 * Canonical subscription state (ADR 0017). Source vocabularies are mapped to
 * these by connector configuration; a value that cannot be mapped is
 * `unknown`, never guessed.
 */
export const SubscriptionStateSchema = z.enum([
  'active',
  'trial',
  'expired',
  'cancelled',
  'unknown',
]);
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;

/** States a product model may count as owning (`unknown` never counts). */
export const OwnableStateSchema = SubscriptionStateSchema.exclude(['unknown']);
export type OwnableState = z.infer<typeof OwnableStateSchema>;

/**
 * Where a subscription line comes from. `import` is an operator-supplied file
 * (M7 CSV import, legacy migration); connectors use their `ExternalSystem`.
 */
export const SubscriptionSourceSystemSchema = z.union([ExternalSystemSchema, z.literal('import')]);
export type SubscriptionSourceSystem = z.infer<typeof SubscriptionSourceSystemSchema>;

export const SubscriptionSourceSchema = z
  .strictObject({
    system: SubscriptionSourceSystemSchema,
    objectType: z.string().regex(/^[A-Za-z0-9_]{1,100}$/),
    recordId: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/),
  })
  .readonly();
export type SubscriptionSource = z.infer<typeof SubscriptionSourceSchema>;

const PositiveQuantity = z.number().int().min(1).max(10_000_000);

/**
 * One source line, as the evaluator sees it: a non-deleted subscription of a
 * company. Ownership is derived from these facts and never stored (ADR 0017).
 */
export const SubscriptionFactSchema = z
  .strictObject({
    id: z.uuid(),
    productKey: ProductKeySchema,
    state: SubscriptionStateSchema,
    startsAt: InstantSchema.optional(),
    endsAt: InstantSchema.optional(),
    quantity: PositiveQuantity.optional(),
  })
  // Equal start and end is a zero-length term (never in force): kept, not lost.
  .refine((s) => !s.startsAt || !s.endsAt || s.startsAt <= s.endsAt, {
    message: 'endsAt must not be before startsAt',
    path: ['endsAt'],
  })
  .readonly();
export type SubscriptionFact = z.infer<typeof SubscriptionFactSchema>;

/**
 * The canonical observation every source maps into (ADR 0017 §4). References
 * to the account and product are the source's own; the single writer resolves
 * them to canonical records. `absent` is a source deletion (tombstone).
 */
export const SubscriptionObservationSchema = z.discriminatedUnion('presence', [
  z.strictObject({
    presence: z.literal('present'),
    source: SubscriptionSourceSchema,
    companyRef: z.string().min(1).max(400),
    productRef: z.string().min(1).max(400),
    state: SubscriptionStateSchema,
    startsAt: InstantSchema.optional(),
    endsAt: InstantSchema.optional(),
    quantity: PositiveQuantity.optional(),
    sourceUpdatedAt: InstantSchema.optional(),
    observedAt: InstantSchema,
  }),
  z.strictObject({
    presence: z.literal('absent'),
    source: SubscriptionSourceSchema,
    sourceUpdatedAt: InstantSchema.optional(),
    observedAt: InstantSchema,
  }),
]);
export type SubscriptionObservation = z.infer<typeof SubscriptionObservationSchema>;

/** A stored subscription line (read model). */
export interface Subscription {
  readonly id: string;
  readonly companyId: z.infer<typeof CompanyIdSchema>;
  readonly productKey: z.infer<typeof ProductKeySchema>;
  readonly state: SubscriptionState;
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly quantity?: number;
  readonly source: SubscriptionSource;
  readonly recordState: 'active' | 'deleted';
  readonly sourceUpdatedAt?: Date;
  readonly observedAt: Date;
  readonly deletedAt?: Date;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}
