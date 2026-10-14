import type { ChangeOrigin } from './change-record';
import type { EntityIndexKind } from './entity-index';

/**
 * Evidence links (M10B plan §3, ADR 0028). The database CHECKs on
 * `tenant_evidence_links` equal these lists (schema guard). Links are
 * immutable; a re-derivation writes a new link set that supersedes the old one.
 */

/** Evidence endpoint types (Q11); more only by a later canonical MINOR. */
export const EVIDENCE_TYPES = ['entity', 'change_record', 'eligibility_snapshot'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Closed roles (Q12); extended only by a canonical MINOR. */
export const EVIDENCE_ROLES = ['supports', 'contradicts', 'derived_from', 'context'] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

/** The change-record origin vocabulary minus `migration` (a migration never cites evidence). */
export const EVIDENCE_ORIGINS = [
  'source_provided',
  'deterministic',
  'ai_derived',
  'human',
] as const satisfies readonly ChangeOrigin[];
export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

/** Size limits of one link set (plan §3.2). */
export const EVIDENCE_SET_LIMITS = { minLinks: 1, maxLinks: 200, maxOrdinal: 999 } as const;

/** One allowed (subject kind → evidence) relation (plan §3.2, Q13). */
export interface EvidenceRelation {
  readonly subjectKind: EntityIndexKind;
  readonly evidenceType: EvidenceType;
  /** For `entity` evidence: the cited entity kind. */
  readonly evidenceKind?: EntityIndexKind;
  readonly roles: readonly EvidenceRole[];
}

/**
 * The production relation catalogue. Empty in M10B (Q13): no derived canonical
 * entity exists yet. Signal (M10G) and Opportunity (M10H) add the first
 * relations; tests construct the writer with their own catalogue.
 */
export const EVIDENCE_RELATIONS: readonly EvidenceRelation[] = [];
