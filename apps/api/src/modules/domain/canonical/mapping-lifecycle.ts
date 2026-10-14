/**
 * Mapping lifecycle (E6 §4; M10A2 plan §10, Q5). Published content is
 * immutable; state lives in drafts (draft | validated) and in an append-only
 * lifecycle of published versions (published | superseded | retired).
 */
export const MAPPING_DRAFT_STATES = ['draft', 'validated'] as const;
export type MappingDraftState = (typeof MAPPING_DRAFT_STATES)[number];

export const MAPPING_LIFECYCLE_STATES = ['published', 'superseded', 'retired'] as const;
export type MappingLifecycleState = (typeof MAPPING_LIFECYCLE_STATES)[number];

export const MAPPING_RETIRE_REASONS = [
  'connection_disabled',
  'canonical_version_unsupported',
  'operator_retired',
] as const;
export type MappingRetireReason = (typeof MAPPING_RETIRE_REASONS)[number];

/** Legal transitions; `null` is "no event yet". Nothing leaves `retired`. */
export function isLegalLifecycleTransition(
  from: MappingLifecycleState | null,
  to: MappingLifecycleState,
): boolean {
  if (from === null) return to === 'published';
  if (from === 'published') return to === 'superseded' || to === 'retired';
  if (from === 'superseded') return to === 'retired';
  return false;
}
