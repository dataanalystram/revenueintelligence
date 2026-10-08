import { z } from 'zod';

/**
 * Structural coverage tiers (ADR 0023, M9A plan §11). A tier says how well the
 * completeness of the subscription facts is grounded, and is decided only by
 * the proof method of the run that established coverage — never by
 * configuration, an adapter declaration or a human acceptance.
 *
 * - `externally_grounded`: the read matched a total the source or producer
 *   asserts independently of the enumeration (a count). Absence may be
 *   concluded (`not_owned`), so whitespace is possible.
 * - `stable_snapshot`: the data was read completely and stably as delivered,
 *   but nothing independent proves the delivery held every record (an
 *   operator-declared full file; later, double enumeration). Presence is
 *   usable; absence is never concluded.
 * - `none`: no completeness proof; ownership is unknown.
 */
export const CoverageTierSchema = z.enum(['externally_grounded', 'stable_snapshot', 'none']);
export type CoverageTier = z.infer<typeof CoverageTierSchema>;
export type KnownCoverageTier = Exclude<CoverageTier, 'none'>;

/**
 * Full-read proof methods. M9A produces `count` (M8 sources) and
 * `operator_full_file` (M7 CSV `import_full`). `manifest`,
 * `double_enumeration` and `success_marker` are placeholders for M9B/M9C:
 * typed here so consumers are exhaustive, but nothing records them yet.
 */
export const ProofMethodSchema = z.enum([
  'count',
  'operator_full_file',
  'manifest',
  'double_enumeration',
  'success_marker',
]);
export type ProofMethod = z.infer<typeof ProofMethodSchema>;

/** The tier of each method. A code constant: there is no configuration path. */
export const TIER_OF: Readonly<Record<ProofMethod, KnownCoverageTier>> = Object.freeze({
  count: 'externally_grounded',
  // A2: a processed file proves the file was read, not that it held the
  // complete upstream population (the input hash is idempotency only).
  operator_full_file: 'stable_snapshot',
  manifest: 'externally_grounded',
  double_enumeration: 'stable_snapshot',
  success_marker: 'stable_snapshot',
});

/** Adapter-declared stable methods need an operator acceptance on the authority version. */
export function requiresAcceptance(method: ProofMethod): boolean {
  return TIER_OF[method] === 'stable_snapshot' && method !== 'operator_full_file';
}

/** The proof a run records in its checkpoint quality (`quality.proof`). */
export const RunProofSchema = z.strictObject({
  method: ProofMethodSchema,
  tier: z.enum(['externally_grounded', 'stable_snapshot']),
  outcome: z.literal('passed'),
});
export type RunProof = z.infer<typeof RunProofSchema>;

/** Builds a run proof; the tier always comes from {@link TIER_OF}. */
export function runProof(method: ProofMethod): RunProof {
  return { method, tier: TIER_OF[method], outcome: 'passed' };
}

/**
 * Reads the proof stored on a completed run. A recorded proof whose tier does
 * not match its method is treated as untrustworthy and re-derived from the
 * method (the method is the only input). Runs completed before M9A carry no
 * proof: `fallback` gives the method inferred from the run's kind.
 */
export function proofOfRun(
  quality: unknown,
  fallback: ProofMethod,
): { method: ProofMethod; tier: KnownCoverageTier; inferred: boolean } {
  const raw =
    quality && typeof quality === 'object' ? (quality as Record<string, unknown>).proof : undefined;
  const parsed = RunProofSchema.safeParse(raw);
  if (parsed.success) {
    return { method: parsed.data.method, tier: TIER_OF[parsed.data.method], inferred: false };
  }
  return { method: fallback, tier: TIER_OF[fallback], inferred: true };
}

export interface ProofMetadata {
  readonly method: ProofMethod;
  readonly tier: KnownCoverageTier;
  readonly connectionId: string;
  /** The checkpoint that established coverage. */
  readonly runId: string;
  readonly completedAt: Date;
  /** True for runs completed before M9A (no recorded proof). */
  readonly inferred: boolean;
  /** The authority version holding the acceptance (adapter-declared stable methods only). */
  readonly acceptedInAuthorityVersion?: number;
}

/** Tenant subscription coverage as read by products/eligibility. */
export type SubscriptionCoverage =
  | {
      readonly coverage: 'known';
      readonly coverageTier: KnownCoverageTier;
      readonly knownAsOf: Date;
      readonly proof: ProofMetadata;
      readonly sourceSystem: string;
    }
  | {
      readonly coverage: 'unknown';
      readonly coverageTier: 'none';
      readonly reason: 'authority_unassigned' | 'no_complete_run' | 'proof_not_accepted';
    };

/** Exhaustiveness helper for switches over tiers. */
export function assertNeverTier(tier: never): never {
  throw new Error(`unhandled coverage tier ${String(tier)}`);
}
