import { z } from 'zod';
import { CodeSchema, LabelSchema } from './shared/codes';
import { DomainError } from './shared/errors';
import {
  CorrelationIdSchema,
  HumanOverrideIdSchema,
  LeadCandidateIdSchema,
  LeadIdSchema,
  QualificationDecisionIdSchema,
  SignalIdSchema,
  TenantIdSchema,
  type HumanOverrideId,
  type QualificationDecisionId,
} from './shared/ids';
import { InstantSchema, type Instant } from './shared/time';

export const TemperatureSchema = z.enum(['hot', 'warm', 'cold']);
export type Temperature = z.infer<typeof TemperatureSchema>;

/** What a qualification provider may conclude. NEEDS_REVIEW is not a temperature. */
export const QualificationOutcomeSchema = z.enum(['hot', 'warm', 'cold', 'needs_review']);
export type QualificationOutcome = z.infer<typeof QualificationOutcomeSchema>;

/** Tenant-level choice of how qualification runs (ADR 0005). */
export const QualificationModeSchema = z.enum(['rules', 'jev', 'hybrid']);
export type QualificationMode = z.infer<typeof QualificationModeSchema>;

export const ProviderKindSchema = z.enum(['rules', 'jev', 'ml', 'external']);

export const ProviderInfoSchema = z
  .object({
    kind: ProviderKindSchema,
    name: z.string().trim().min(1).max(100),
    /** Model version, or ruleset version for the rules provider. */
    version: z.string().trim().min(1).max(100),
  })
  .readonly();
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

/** What is being qualified: a candidate (before creation) or an existing Lead. */
export const QualificationSubjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lead_candidate'), id: LeadCandidateIdSchema }).readonly(),
  z.object({ type: z.literal('lead'), id: LeadIdSchema }).readonly(),
]);
export type QualificationSubject = z.infer<typeof QualificationSubjectSchema>;

export const ReasonSchema = z
  .object({
    code: CodeSchema,
    description: LabelSchema.optional(),
    signalIds: z.array(SignalIdSchema).readonly().default([]),
  })
  .readonly();

/**
 * An automated classification. Immutable. Whether a human later overrode it
 * is derived from the override history (see resolveEffectiveQualification).
 */
export const QualificationDecisionSchema = z
  .object({
    id: QualificationDecisionIdSchema,
    tenantId: TenantIdSchema,
    subject: QualificationSubjectSchema,
    outcome: QualificationOutcomeSchema,
    /** 0..1 where the provider supplies one; null otherwise. */
    confidence: z.number().min(0).max(1).nullable(),
    reasons: z.array(ReasonSchema).min(1, 'a decision must explain itself').readonly(),
    provider: ProviderInfoSchema,
    mode: QualificationModeSchema,
    input: z
      .object({
        /** Where the exact input payload is stored (e.g. an object key). */
        snapshotRef: z.string().trim().min(1).max(500),
        /** SHA-256 of the input payload, hex encoded. */
        snapshotHash: z.string().regex(/^[a-f0-9]{64}$/, 'must be a sha256 hex digest'),
      })
      .readonly(),
    decidedAt: InstantSchema,
    correlationId: CorrelationIdSchema,
  })
  .refine((d) => d.mode !== 'rules' || d.provider.kind === 'rules', {
    message: 'rules mode can only produce rules-provider decisions',
    path: ['provider', 'kind'],
  })
  .refine((d) => d.mode !== 'jev' || d.provider.kind === 'jev', {
    message: 'jev mode can only produce jev-provider decisions',
    path: ['provider', 'kind'],
  })
  .refine((d) => d.mode !== 'hybrid' || d.provider.kind === 'rules' || d.provider.kind === 'jev', {
    message: 'hybrid mode combines the rules and jev providers only',
    path: ['provider', 'kind'],
  })
  .readonly();

export type QualificationDecision = z.infer<typeof QualificationDecisionSchema>;
export type QualificationDecisionInput = z.input<typeof QualificationDecisionSchema>;

export const ActorSchema = z
  .object({
    userId: z.string().trim().min(1).max(255),
    displayName: z.string().trim().min(1).max(255).optional(),
  })
  .readonly();
export type Actor = z.infer<typeof ActorSchema>;

/**
 * An authorised person's decision. Append-only.
 *  - `set`: the given temperature becomes effective until changed again by a human.
 *  - `release`: control goes back to automated qualification.
 */
export const HumanOverrideSchema = z
  .object({
    id: HumanOverrideIdSchema,
    tenantId: TenantIdSchema,
    subject: QualificationSubjectSchema,
    action: z.enum(['set', 'release']),
    /** The effective temperature immediately before this override, if any. */
    previousTemperature: TemperatureSchema.nullable(),
    newTemperature: TemperatureSchema.nullable(),
    actor: ActorSchema,
    reason: LabelSchema.optional(),
    /** The automated decision that was effective when the human acted, if any. */
    basedOnDecisionId: QualificationDecisionIdSchema.optional(),
    at: InstantSchema,
  })
  .refine((o) => (o.action === 'set') === (o.newTemperature !== null), {
    message: 'set requires newTemperature; release must not have one',
    path: ['newTemperature'],
  })
  .readonly();

export type HumanOverride = z.infer<typeof HumanOverrideSchema>;

export type EffectiveQualification =
  | {
      readonly source: 'human';
      readonly temperature: Temperature;
      readonly overrideId: HumanOverrideId;
    }
  | {
      readonly source: 'automated';
      readonly outcome: QualificationOutcome;
      readonly temperature: Temperature | null;
      readonly decisionId: QualificationDecisionId;
    }
  | { readonly source: 'none' };

export interface QualificationResolution {
  readonly effective: EffectiveQualification;
  /** The most recent automated decision, whether or not it is effective. */
  readonly latestAutomated: QualificationDecision | undefined;
  /** Automated decisions that a later human `set` override replaced. */
  readonly overriddenDecisionIds: readonly QualificationDecisionId[];
  /**
   * An automated decision made after the active human override that
   * disagrees with it. It is never applied; it is surfaced for review.
   */
  readonly conflictingAutomatedDecision: QualificationDecision | undefined;
}

const byTime =
  <T>(at: (x: T) => Instant) =>
  (a: T, b: T) =>
    at(a).getTime() - at(b).getTime();

function toTemperature(outcome: QualificationOutcome): Temperature | null {
  return outcome === 'needs_review' ? null : outcome;
}

function sameSubject(a: QualificationSubject, b: QualificationSubject): boolean {
  return a.type === b.type && a.id === b.id;
}

/**
 * Works out which qualification applies to one subject.
 *
 * Rules (ADR 0005):
 * 1. The latest human override wins if it is a `set`, regardless of any
 *    automated decisions made before or after it.
 * 2. After a `release`, or with no overrides, the latest automated decision
 *    applies.
 * 3. Automated decisions are never discarded: overridden ones are listed, and
 *    a newer automated result that disagrees with an active override is
 *    reported as a conflict for review.
 *
 * On equal timestamps, overrides are considered later than decisions, so a
 * human never loses a race with automation.
 */
export function resolveEffectiveQualification(
  decisions: readonly QualificationDecision[],
  overrides: readonly HumanOverride[],
): QualificationResolution {
  const all = [...decisions.map((d) => d.subject), ...overrides.map((o) => o.subject)];
  const tenants = new Set([
    ...decisions.map((d) => d.tenantId),
    ...overrides.map((o) => o.tenantId),
  ]);
  if (tenants.size > 1) {
    throw new DomainError('mixed_tenants', 'Qualification history spans multiple tenants');
  }
  if (all.some((s) => !sameSubject(s, all[0]!))) {
    throw new DomainError('mixed_subjects', 'Qualification history spans multiple subjects');
  }

  const sortedDecisions = [...decisions].sort(byTime((d) => d.decidedAt));
  const sortedOverrides = [...overrides].sort(byTime((o) => o.at));
  const latestAutomated = sortedDecisions.at(-1);
  const latestOverride = sortedOverrides.at(-1);

  const setOverrides = sortedOverrides.filter((o) => o.action === 'set');
  const overriddenDecisionIds = sortedDecisions
    .filter((d) => setOverrides.some((o) => o.at >= d.decidedAt))
    .map((d) => d.id);

  if (latestOverride?.action === 'set') {
    const temperature = latestOverride.newTemperature!;
    const newer = sortedDecisions.filter((d) => d.decidedAt > latestOverride.at).at(-1);
    return {
      effective: { source: 'human', temperature, overrideId: latestOverride.id },
      latestAutomated,
      overriddenDecisionIds,
      conflictingAutomatedDecision: newer && newer.outcome !== temperature ? newer : undefined,
    };
  }

  return {
    effective: latestAutomated
      ? {
          source: 'automated',
          outcome: latestAutomated.outcome,
          temperature: toTemperature(latestAutomated.outcome),
          decisionId: latestAutomated.id,
        }
      : { source: 'none' },
    latestAutomated,
    overriddenDecisionIds,
    conflictingAutomatedDecision: undefined,
  };
}

/** The effective temperature, or null when there is none (unqualified or needs review). */
export function effectiveTemperature(resolution: QualificationResolution): Temperature | null {
  const { effective } = resolution;
  return effective.source === 'none' ? null : effective.temperature;
}

export interface OverrideRequest {
  readonly id: HumanOverrideId;
  readonly action: 'set' | 'release';
  readonly newTemperature?: Temperature;
  readonly actor: Actor;
  readonly reason?: string;
  readonly at: Instant;
}

/**
 * Builds an override against the current history so that the previous value
 * and the decision it replaces are always recorded correctly.
 */
export function createOverride(
  subject: QualificationSubject,
  tenantId: QualificationDecision['tenantId'],
  history: { decisions: readonly QualificationDecision[]; overrides: readonly HumanOverride[] },
  request: OverrideRequest,
): HumanOverride {
  const current = resolveEffectiveQualification(history.decisions, history.overrides);
  // Overrides form a chain (each records the previous value), so a new one may
  // not predate the last. Automated decisions can arrive concurrently and are
  // ordered by resolveEffectiveQualification instead.
  const lastOverride = history.overrides.reduce<Instant | undefined>(
    (latest, o) => (!latest || o.at > latest ? o.at : latest),
    undefined,
  );
  if (lastOverride && request.at < lastOverride) {
    throw new DomainError(
      'override_out_of_order',
      'An override cannot predate the previous override',
    );
  }
  if (request.action === 'release' && current.effective.source !== 'human') {
    throw new DomainError('nothing_to_release', 'There is no active human override to release');
  }

  return HumanOverrideSchema.parse({
    id: request.id,
    tenantId,
    subject,
    action: request.action,
    previousTemperature: effectiveTemperature(current),
    newTemperature: request.action === 'set' ? (request.newTemperature ?? null) : null,
    actor: request.actor,
    reason: request.reason,
    basedOnDecisionId: current.latestAutomated?.id,
    at: request.at,
  });
}
