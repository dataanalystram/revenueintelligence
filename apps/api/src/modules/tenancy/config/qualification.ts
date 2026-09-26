import { z } from 'zod';
import { QualificationModeSchema } from '../../domain';

/**
 * How a tenant qualifies leads (ADR 0005). Business policy (SLA, routing) is
 * configured separately and never here.
 */
export const QualificationSettingsSchema = z.strictObject({
  jev: z
    .strictObject({
      /** Jev results below this confidence become NEEDS_REVIEW. */
      minConfidence: z.number().min(0).max(1).default(0.6),
    })
    .default({ minConfidence: 0.6 }),
});

export const QualificationConfigInputSchema = z.strictObject({
  mode: QualificationModeSchema,
  /** Version label of the deterministic ruleset in force (null until M13 defines one). */
  rulesetVersion: z.string().trim().min(1).max(100).nullable().default(null),
  settings: QualificationSettingsSchema.default({ jev: { minConfidence: 0.6 } }),
});

export type QualificationConfigInput = z.input<typeof QualificationConfigInputSchema>;
export type QualificationConfig = z.infer<typeof QualificationConfigInputSchema> & {
  readonly version: number;
};

export const DEFAULT_QUALIFICATION_CONFIG = QualificationConfigInputSchema.parse({ mode: 'rules' });

/** Jev is used in `jev` and `hybrid` modes, so they need the Jev integration enabled. */
export function modeRequiresJev(mode: QualificationConfig['mode']): boolean {
  return mode === 'jev' || mode === 'hybrid';
}
