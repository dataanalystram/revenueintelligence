import { z } from 'zod';
import { ExternalRefSchema, ExternalSystemSchema } from './external-ref';
import { CodeSchema } from './shared/codes';
import { LeadIdSchema, SalesOutcomeIdSchema, TenantIdSchema } from './shared/ids';
import { InstantSchema } from './shared/time';

export const SalesOutcomeTypeSchema = z.enum([
  'qualified',
  'disqualified',
  'opportunity_created',
  'won',
  'lost',
]);
export type SalesOutcomeType = z.infer<typeof SalesOutcomeTypeSchema>;

const OPPORTUNITY_OUTCOMES: readonly SalesOutcomeType[] = ['opportunity_created', 'won', 'lost'];

/** Money in minor units (pence/cents) to avoid floating-point rounding. */
export const MoneySchema = z
  .object({
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 currency code'),
  })
  .readonly();

/**
 * What eventually happened to a Lead. This closes the loop so Marketing can
 * report conversion and revenue by source.
 */
export const SalesOutcomeSchema = z
  .object({
    id: SalesOutcomeIdSchema,
    tenantId: TenantIdSchema,
    leadId: LeadIdSchema,
    type: SalesOutcomeTypeSchema,
    occurredAt: InstantSchema,
    reportedBy: ExternalSystemSchema,
    /** The Deal / Opportunity record, for opportunity outcomes. */
    opportunity: ExternalRefSchema.optional(),
    value: MoneySchema.optional(),
    reasonCode: CodeSchema.optional(),
  })
  .refine((o) => !OPPORTUNITY_OUTCOMES.includes(o.type) || o.opportunity !== undefined, {
    message: 'opportunity outcomes must reference the opportunity',
    path: ['opportunity'],
  })
  .refine((o) => OPPORTUNITY_OUTCOMES.includes(o.type) || (!o.opportunity && !o.value), {
    message: 'only opportunity outcomes carry an opportunity or value',
    path: ['value'],
  })
  .readonly();

export type SalesOutcome = z.infer<typeof SalesOutcomeSchema>;
