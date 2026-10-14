/**
 * Generic source references (M10B plan §2, ADR 0028). The database CHECKs on
 * `tenant_source_references` equal these lists (schema guard).
 *
 * Company and person references stay in their legacy stores
 * (`company_external_refs`, `person_external_refs`) and subscription lines keep
 * their inline source triple (ADR 0017); the generic store refuses those kinds
 * by the named CHECK `tenant_source_references_not_legacy_kind` (Q2). All
 * stores are read together through the read-only `source_reference_index` view.
 */

/** Entity kinds the generic store holds. M10B: `product` only; later sub-milestones add theirs. */
export const GENERIC_REFERENCE_KINDS = ['product'] as const;
export type GenericReferenceKind = (typeof GENERIC_REFERENCE_KINDS)[number];

/** Kinds whose references live in a legacy store; never written to the generic store. */
export const LEGACY_REFERENCE_KINDS = ['company', 'person', 'subscription'] as const;
export type LegacyReferenceKind = (typeof LEGACY_REFERENCE_KINDS)[number];

/** Key-identified kinds (D3): the reference names `entity_key`, every other kind `entity_id`. */
export const KEY_IDENTIFIED_REFERENCE_KINDS: readonly GenericReferenceKind[] = ['product'];

export const SOURCE_REFERENCE_STATES = ['active', 'retired', 'deleted', 'merged'] as const;
export type SourceReferenceState = (typeof SOURCE_REFERENCE_STATES)[number];

/**
 * `observed`: a source read returned it. `declared`: a published configuration
 * document (the product model) declares it; written only by product-model publish.
 */
export const SOURCE_REFERENCE_ORIGINS = ['observed', 'declared'] as const;
export type SourceReferenceOrigin = (typeof SOURCE_REFERENCE_ORIGINS)[number];

/** Identifier-only source coordinates (as `ProductExternalRefSchema`); never a value. */
export const SOURCE_OBJECT_TYPE_PATTERN = /^[A-Za-z0-9_]{1,100}$/;
export const SOURCE_EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;

/** The stores the `source_reference_index` view unions (plan §4), by `store` value. */
export const SOURCE_REFERENCE_STORES = [
  'company_external_refs',
  'person_external_refs',
  'tenant_subscriptions',
  'tenant_source_references',
] as const;
export type SourceReferenceStore = (typeof SOURCE_REFERENCE_STORES)[number];

/** The `adapter` written on product-reference change records (plan §6, Q8). */
export const PRODUCT_REFERENCE_ADAPTER = 'product-model';
/** `changed_fields` of a product-reference change record. */
export const SOURCE_REFERENCE_CHANGED_FIELD = 'source_reference';

/* ------------------------------------------------------------------------- *
 * Shared lifecycle rules (plan §2.4, Q9). Pure. The single implementation of
 * the reference lifecycle: `ContextIngestionService` decides company/person
 * references with these functions (through `decideApplyWithHash`), and
 * `SourceReferenceService` decides generic references with them. A
 * table-driven equivalence test proves they decide exactly as the pre-M10B
 * code did.
 * ------------------------------------------------------------------------- */

/** What is stored about a reference (any store). Structurally the M6 `StoredReference`. */
export interface ReferenceLifecycle {
  readonly state: SourceReferenceState;
  readonly sourceUpdatedAt?: Date;
  readonly fieldHash?: string;
  readonly deletedAt?: Date;
  readonly retiredAt?: Date;
  readonly lastSeenAt?: Date;
}

/** One read of a reference: present (with its source time) or absent. */
export interface ReferenceObservation {
  readonly presence: 'present' | 'absent';
  readonly observedAt: Date;
  readonly sourceUpdatedAt?: Date;
}

export type ReferenceObservationDecision =
  'create' | 'apply' | 'restore' | 'delete' | 'unchanged' | 'stale' | 'not_found';

/**
 * `decideReactivation`: a retired or deleted reference returns to `active`
 * only for a read made strictly after its retirement / deletion time (the same
 * row; never a duplicate). Merged and active references are never reactivated.
 */
export function decideReactivation(stored: ReferenceLifecycle, readAt: Date): boolean {
  if (stored.state === 'deleted') return !!stored.deletedAt && readAt > stored.deletedAt;
  if (stored.state === 'retired') return !!stored.retiredAt && readAt > stored.retiredAt;
  return false;
}

/**
 * `decideReferenceObservation`: newer → apply; older → stale no-op; same
 * source time and hash → unchanged; a tombstone (or retirement) is not revived
 * by a read older than it; a merged reference is terminal for observations.
 * Read time orders presence against absence.
 */
export function decideReferenceObservation(
  stored: ReferenceLifecycle | undefined,
  observation: ReferenceObservation,
  hash: string | undefined,
): ReferenceObservationDecision {
  if (!stored) return observation.presence === 'present' ? 'create' : 'not_found';

  if (observation.presence === 'absent') {
    if (stored.state === 'deleted' || stored.state === 'merged' || stored.state === 'retired') {
      return 'unchanged';
    }
    if (stored.lastSeenAt && observation.observedAt <= stored.lastSeenAt) return 'stale';
    return 'delete';
  }

  if (stored.state === 'merged') return 'stale';
  if (stored.state === 'deleted' || stored.state === 'retired') {
    return decideReactivation(stored, observation.observedAt) ? 'restore' : 'stale';
  }

  if (stored.sourceUpdatedAt && observation.sourceUpdatedAt) {
    if (observation.sourceUpdatedAt < stored.sourceUpdatedAt) return 'stale';
    if (
      observation.sourceUpdatedAt.getTime() === stored.sourceUpdatedAt.getTime() &&
      hash === stored.fieldHash
    ) {
      return 'unchanged';
    }
    return 'apply';
  }
  if (stored.sourceUpdatedAt && !observation.sourceUpdatedAt) {
    // Without a source time, only a read newer than the last one may change data.
    if (stored.lastSeenAt && observation.observedAt <= stored.lastSeenAt) return 'stale';
  }
  return hash === stored.fieldHash ? 'unchanged' : 'apply';
}

/** The run facts retirement depends on (M9B contract). */
export interface RetirementRun {
  /** Operator-accepted run (M9B acceptance). */
  readonly accepted: boolean;
  /** The run proved completeness (counts reconcile). */
  readonly proven: boolean;
  /** A full read of the object, not incremental. */
  readonly full: boolean;
  /** Any uncertainty (partial pages, errors) blocks retirement. */
  readonly uncertain: boolean;
  /** The run's read time; only references last seen at or before it qualify. */
  readonly observedAt: Date;
  /** Every id the run saw (accepted or rejected) or referenced. */
  readonly seen: ReadonlySet<string>;
  /** Ids seen but rejected (e.g. a validation failure): never retired. */
  readonly rejected?: ReadonlySet<string>;
  /** Ids protected by a child (e.g. a referenced parent): never retired. */
  readonly protectedIds?: ReadonlySet<string>;
}

export type RetirementDecision =
  | { readonly retire: true }
  | {
      readonly retire: false;
      readonly reason:
        | 'run_not_eligible'
        | 'declared'
        | 'not_active'
        | 'seen'
        | 'rejected'
        | 'protected'
        | 'seen_after_run';
    };

/**
 * `decideRetirement`: only for an accepted, proven, full run with no
 * uncertainty; never for keys seen in the run, seen-but-rejected keys or
 * protected keys; never for `declared` references (those retire only by an
 * explicit model version); only an `active` reference last read at or before
 * the run's read time.
 */
export function decideRetirement(
  ref: {
    readonly externalId: string;
    readonly origin: SourceReferenceOrigin;
    readonly state: SourceReferenceState;
    readonly lastSeenAt?: Date;
  },
  run: RetirementRun,
): RetirementDecision {
  if (!run.accepted || !run.proven || !run.full || run.uncertain) {
    return { retire: false, reason: 'run_not_eligible' };
  }
  if (ref.origin === 'declared') return { retire: false, reason: 'declared' };
  if (ref.state !== 'active') return { retire: false, reason: 'not_active' };
  if (run.seen.has(ref.externalId)) return { retire: false, reason: 'seen' };
  if (run.rejected?.has(ref.externalId)) return { retire: false, reason: 'rejected' };
  if (run.protectedIds?.has(ref.externalId)) return { retire: false, reason: 'protected' };
  if (ref.lastSeenAt && ref.lastSeenAt > run.observedAt) {
    return { retire: false, reason: 'seen_after_run' };
  }
  return { retire: true };
}

export type MergeDecision = 'merge' | 'unchanged' | 'refused';

/**
 * `decideMerge` (ADR 0014 §5): merging a reference into a survivor makes it
 * `merged` (terminal for observations, retirement and reactivation; lineage
 * kept through `merged_into_external_id`). Already merged into the same
 * survivor → unchanged; a reference cannot be merged into itself. A later
 * merge may re-point lineage to a newer survivor, as the legacy stores do.
 */
export function decideMerge(
  ref: {
    readonly externalId: string;
    readonly state: SourceReferenceState;
    readonly mergedIntoExternalId?: string | null;
  },
  survivorExternalId: string,
): MergeDecision {
  if (ref.externalId === survivorExternalId) return 'refused';
  if (ref.state === 'merged' && ref.mergedIntoExternalId === survivorExternalId) return 'unchanged';
  return 'merge';
}
