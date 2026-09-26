import { z } from 'zod';
import { SourceAttributionSchema } from './attribution';
import { ExternalRefListSchema, type ExternalRef, withExternalRef } from './external-ref';
import { ProductKeySchema } from './product';
import { CodeSchema, type Code } from './shared/codes';
import {
  CompanyIdSchema,
  CorrelationIdSchema,
  LeadCandidateIdSchema,
  LeadIdSchema,
  PersonIdSchema,
  TenantIdSchema,
} from './shared/ids';
import { InstantSchema, type Instant } from './shared/time';

/** Pipeline stages confirmed in the Juniper requirements. */
export const LeadStageSchema = z.enum([
  'new',
  'attempting',
  'connected',
  'qualified',
  'disqualified',
]);
export type LeadStage = z.infer<typeof LeadStageSchema>;

/** Stages in which Sales is still working the Lead. */
export const OPEN_STAGES: readonly LeadStage[] = ['new', 'attempting', 'connected'];

/**
 * Canonical lead types. Tenants map their own values onto these. The
 * requirements list "New business / Up-sell / Attempting"; "Attempting" is
 * unconfirmed (it collides with a stage name) and is not included until
 * Juniper confirms what it means.
 */
export const LeadTypeSchema = z.enum(['new_business', 'upsell', 'cross_sell', 'unclassified']);
export type LeadType = z.infer<typeof LeadTypeSchema>;

/** Who reported a stage change. Sugar is authoritative for Sales activity. */
export const ChangeSourceSchema = z.enum(['hubspot', 'sugar', 'platform', 'user']);
export type ChangeSource = z.infer<typeof ChangeSourceSchema>;

export const StageTransitionSchema = z
  .object({
    from: LeadStageSchema.nullable(),
    to: LeadStageSchema,
    occurredAt: InstantSchema,
    source: ChangeSourceSchema,
  })
  .refine((t) => t.from !== t.to, { message: 'a transition must change the stage', path: ['to'] })
  .readonly();

export type StageTransition = z.infer<typeof StageTransitionSchema>;

/**
 * A Lead: one qualifying event for one person, followed up on its own
 * (one Contact may have many Leads over time). The source attribution is
 * fixed at creation. The stage history keeps every transition with its
 * timestamp, which fills the "date entered stage" gap in the requirements.
 */
export const LeadSchema = z
  .object({
    id: LeadIdSchema,
    tenantId: TenantIdSchema,
    personId: PersonIdSchema,
    companyId: CompanyIdSchema.optional(),
    productKey: ProductKeySchema.optional(),
    candidateId: LeadCandidateIdSchema.optional(),
    leadType: LeadTypeSchema,
    source: SourceAttributionSchema,
    stage: LeadStageSchema,
    stageHistory: z.array(StageTransitionSchema).min(1).readonly(),
    /** Tenant-configured picklist code; only meaningful while disqualified. */
    disqualifiedReason: CodeSchema.optional(),
    externalRefs: ExternalRefListSchema.default([]),
    correlationId: CorrelationIdSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .superRefine((lead, ctx) => {
    const [first, ...rest] = lead.stageHistory;
    if (first && first.from !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['stageHistory', 0, 'from'],
        message: 'first transition must start from null',
      });
    }
    let previous = first;
    rest.forEach((t, i) => {
      if (previous && t.from !== previous.to) {
        ctx.addIssue({
          code: 'custom',
          path: ['stageHistory', i + 1, 'from'],
          message: 'transitions must be contiguous',
        });
      }
      if (previous && t.occurredAt < previous.occurredAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['stageHistory', i + 1, 'occurredAt'],
          message: 'transitions must be chronological',
        });
      }
      previous = t;
    });
    if (previous && previous.to !== lead.stage) {
      ctx.addIssue({
        code: 'custom',
        path: ['stage'],
        message: 'stage must equal the last transition',
      });
    }
    if (lead.disqualifiedReason !== undefined && lead.stage !== 'disqualified') {
      ctx.addIssue({
        code: 'custom',
        path: ['disqualifiedReason'],
        message: 'only disqualified leads carry a reason',
      });
    }
  })
  .readonly();

export type Lead = z.infer<typeof LeadSchema>;

export interface NewLeadInput {
  readonly id: Lead['id'];
  readonly tenantId: Lead['tenantId'];
  readonly personId: Lead['personId'];
  readonly companyId?: Lead['companyId'];
  readonly productKey?: Lead['productKey'];
  readonly candidateId?: Lead['candidateId'];
  readonly leadType: LeadType;
  readonly source: z.input<typeof SourceAttributionSchema>;
  readonly correlationId: Lead['correlationId'];
  readonly createdAt: Instant;
  readonly createdBy: ChangeSource;
  readonly externalRefs?: readonly ExternalRef[];
}

/** Creates a Lead in stage "new", with the entry recorded in its history. */
export function createLead(input: NewLeadInput): Lead {
  const { createdBy, ...rest } = input;
  return LeadSchema.parse({
    ...rest,
    stage: 'new',
    stageHistory: [{ from: null, to: 'new', occurredAt: input.createdAt, source: createdBy }],
    updatedAt: input.createdAt,
  });
}

export interface StageChange {
  readonly to: LeadStage;
  readonly occurredAt: Instant;
  readonly source: ChangeSource;
  readonly disqualifiedReason?: Code;
}

export type StageChangeWarning = 'missing_disqualified_reason' | 'reopened_closed_lead';

export type StageChangeResult =
  | {
      readonly status: 'applied';
      readonly lead: Lead;
      readonly warnings: readonly StageChangeWarning[];
    }
  | { readonly status: 'unchanged'; readonly lead: Lead }
  | { readonly status: 'stale'; readonly lead: Lead };

/**
 * Applies a stage change reported by a source system.
 *
 * - External systems are the source of truth for Sales activity, so a change
 *   is never rejected for business reasons. Irregularities (disqualified
 *   without a reason, reopening a closed Lead) are applied and returned as
 *   warnings for data-quality reporting.
 * - Events can arrive out of order (webhook retries, polling). A change that
 *   happened before the latest recorded transition is `stale` and ignored, so
 *   an old event can never roll a Lead backwards.
 * - A change to the current stage only updates the disqualified reason, if
 *   one is supplied.
 */
export function applyStageChange(lead: Lead, change: StageChange): StageChangeResult {
  const last = lead.stageHistory[lead.stageHistory.length - 1]!;
  if (change.occurredAt < last.occurredAt) {
    return { status: 'stale', lead };
  }

  if (change.to === lead.stage) {
    if (
      lead.stage === 'disqualified' &&
      change.disqualifiedReason !== undefined &&
      change.disqualifiedReason !== lead.disqualifiedReason
    ) {
      const updated = LeadSchema.parse({
        ...lead,
        disqualifiedReason: change.disqualifiedReason,
        updatedAt: maxInstant(lead.updatedAt, change.occurredAt),
      });
      return { status: 'applied', lead: updated, warnings: [] };
    }
    return { status: 'unchanged', lead };
  }

  const warnings: StageChangeWarning[] = [];
  if (!OPEN_STAGES.includes(lead.stage)) warnings.push('reopened_closed_lead');
  if (change.to === 'disqualified' && change.disqualifiedReason === undefined) {
    warnings.push('missing_disqualified_reason');
  }

  const updated = LeadSchema.parse({
    ...lead,
    stage: change.to,
    stageHistory: [
      ...lead.stageHistory,
      { from: lead.stage, to: change.to, occurredAt: change.occurredAt, source: change.source },
    ],
    disqualifiedReason: change.to === 'disqualified' ? change.disqualifiedReason : undefined,
    updatedAt: maxInstant(lead.updatedAt, change.occurredAt),
  });
  return { status: 'applied', lead: updated, warnings };
}

/** When the Lead first entered a stage (the "Date entered <stage>" property), if ever. */
export function dateEnteredStage(lead: Lead, stage: LeadStage): Instant | undefined {
  return lead.stageHistory.find((t) => t.to === stage)?.occurredAt;
}

/** When the Lead most recently entered a stage, if ever. */
export function lastEnteredStage(lead: Lead, stage: LeadStage): Instant | undefined {
  return lead.stageHistory.findLast((t) => t.to === stage)?.occurredAt;
}

export function isLeadOpen(lead: Lead): boolean {
  return OPEN_STAGES.includes(lead.stage);
}

export function addLeadExternalRef(lead: Lead, ref: ExternalRef, at: Instant): Lead {
  const refs = withExternalRef(lead.externalRefs, ref);
  if (refs === lead.externalRefs) return lead;
  return LeadSchema.parse({
    ...lead,
    externalRefs: refs,
    updatedAt: maxInstant(lead.updatedAt, at),
  });
}

function maxInstant(a: Instant, b: Instant): Instant {
  return a >= b ? a : b;
}
