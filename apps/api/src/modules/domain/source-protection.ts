/**
 * Seen-but-rejected protection (ADR 0023, M9A plan §9). A source record whose
 * key was resolved but whose observation was not accepted must never turn
 * into a deletion of its existing canonical line: the full-run tombstone pass
 * deletes a line only when its key is in neither the run's holdings nor its
 * protection set. This module decides, per outcome code, whether a record is
 * protected and which ownership-gap reason its account receives. Unknown
 * codes are protected by default: uncertainty is never converted into
 * deletion.
 */

/** Gap reasons a protected record can give its account (`tenant_ownership_gaps.reason`). */
export type ProtectionGapReason =
  | 'observation_rejected'
  | 'holding_filter_value_unreviewed'
  | 'account_reference_orphaned'
  | 'missing_product_reference'
  | 'orphan_product_reference';

export type ProtectionClass =
  /** A reviewed, confident classification: not a holding; tombstoning stays correct. */
  | 'confident_exclusion'
  /** The source states the referenced account/product does not exist (M8 handling kept when no line exists). */
  | 'reference_integrity'
  /** The record's value could not be interpreted safely. */
  | 'value_rejection';

export type ProtectionDecision =
  | { readonly protect: false; readonly class: 'confident_exclusion' }
  | {
      readonly protect: true;
      readonly class: Exclude<ProtectionClass, 'confident_exclusion'>;
      readonly gapReason: ProtectionGapReason;
    };

/**
 * The protection decision for an outcome code (engine skip/filter codes, writer
 * rejections and adapter row rejections). Exhaustive for the known codes, with
 * `protect` as the default for anything else.
 */
export function protectionFor(code: string): ProtectionDecision {
  switch (code) {
    // Confident classifications (reviewed values, declared exclusions).
    case 'filtered_out':
    case 'non_subscription_product':
      return { protect: false, class: 'confident_exclusion' };
    // Reference integrity.
    case 'missing_account_reference':
      return { protect: true, class: 'reference_integrity', gapReason: 'observation_rejected' };
    case 'orphan_account_reference':
      return {
        protect: true,
        class: 'reference_integrity',
        gapReason: 'account_reference_orphaned',
      };
    case 'missing_product_reference':
      return {
        protect: true,
        class: 'reference_integrity',
        gapReason: 'missing_product_reference',
      };
    case 'orphan_product_reference':
      return { protect: true, class: 'reference_integrity', gapReason: 'orphan_product_reference' };
    // Value rejections.
    case 'unreviewed_holding_value':
      return {
        protect: true,
        class: 'value_rejection',
        gapReason: 'holding_filter_value_unreviewed',
      };
    case 'invalid_observation':
    case 'record_rejected':
    case 'missing_identity':
    case 'malformed_row':
      return { protect: true, class: 'value_rejection', gapReason: 'observation_rejected' };
    default:
      // Future or unknown rejection codes: protect, never delete.
      return { protect: true, class: 'value_rejection', gapReason: 'observation_rejected' };
  }
}

/**
 * Whether an unattributable protected record (no account from its reference
 * and no existing line) must fail the run: only value rejections do. Reference
 * integrity skips with no existing line keep M8 handling (skipped, counted).
 */
export function failsRunWhenUnattributable(decision: ProtectionDecision): boolean {
  return decision.protect && decision.class === 'value_rejection';
}

/** The full-run tombstone condition (M9A plan §9.3). */
export function mayTombstone(
  key: string,
  holdingIds: ReadonlySet<string>,
  seenButRejectedIds: ReadonlySet<string>,
): boolean {
  return !holdingIds.has(key) && !seenButRejectedIds.has(key);
}
