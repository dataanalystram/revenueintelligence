import { DERIVED_ORIGINS, type ChangeOrigin } from './change-record';
import { ENTITY_INDEX_SOURCES, type EntityIndexKind } from './entity-index';
import type { ModuleKey } from './modules';

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

/**
 * The module each entity kind belongs to, for the module gate (plan §3.2).
 * Every M10B kind (company, person, product, subscription) is core: no gate.
 * Later sub-milestones add their module kinds.
 */
export const EVIDENCE_KIND_MODULES: Readonly<Partial<Record<EntityIndexKind, ModuleKey>>> = {};

/** A derivation key / version: identifiers only (secret-like refusal, M10A1 A1). */
export const EVIDENCE_DERIVATION_KEY_PATTERN = /^[a-z][a-z0-9_.:-]{0,99}$/;
export const EVIDENCE_DERIVATION_VERSION_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface EvidenceDerivation {
  readonly key: string;
  readonly version: string;
  /** 64 hex: hash of the inputs the derivation read (no values). */
  readonly inputsHash: string;
}

/** One cited piece of evidence in a link set. */
export interface EvidenceLinkInput {
  readonly ordinal: number;
  readonly evidenceType: EvidenceType;
  readonly evidenceKind?: EntityIndexKind;
  readonly evidenceId?: string;
  readonly evidenceKey?: string;
  readonly evidenceChangeId?: string;
  readonly evidenceSnapshotId?: string;
  readonly role: EvidenceRole;
  readonly weight?: number;
}

/** Everything one write of one subject cites (plan §3.1). */
export interface EvidenceSetInput {
  readonly subjectKind: EntityIndexKind;
  readonly subjectId?: string;
  readonly subjectKey?: string;
  readonly origin: EvidenceOrigin;
  readonly derivation?: EvidenceDerivation;
  readonly supersedesLinkSetId?: string;
  readonly changeId?: string;
  readonly links: readonly EvidenceLinkInput[];
}

export interface EvidenceSetIssue {
  readonly code: 'evidence_set_invalid' | 'evidence_relation_not_allowed';
  /** The link the issue is about (absent for set-level issues). */
  readonly ordinal?: number;
  /** A short machine reason (identifiers only). */
  readonly reason: string;
}

const isKeyKind = (kind: EntityIndexKind) => ENTITY_INDEX_SOURCES[kind]?.column === 'key';

/** One relation of the catalogue allows this (subject, evidence, role). */
export function evidenceRelationAllowed(
  relations: readonly EvidenceRelation[],
  subjectKind: string,
  link: {
    readonly evidenceType: string;
    readonly evidenceKind?: string | null;
    readonly role: string;
  },
): boolean {
  return relations.some(
    (r) =>
      r.subjectKind === subjectKind &&
      r.evidenceType === link.evidenceType &&
      (link.evidenceType !== 'entity' || r.evidenceKind === link.evidenceKind) &&
      (r.roles as readonly string[]).includes(link.role),
  );
}

/**
 * Layer-1 validation of a link set (plan §3.2): precise errors before the
 * database constraints (the security boundary) see the rows. Pure; the writer
 * adds the existence, module and version checks.
 */
export function validateEvidenceSet(
  set: EvidenceSetInput,
  relations: readonly EvidenceRelation[],
): EvidenceSetIssue[] {
  const issues: EvidenceSetIssue[] = [];
  const bad = (reason: string, ordinal?: number) =>
    issues.push({
      code: 'evidence_set_invalid',
      reason,
      ...(ordinal !== undefined ? { ordinal } : {}),
    });
  const n = set.links.length;
  if (n < EVIDENCE_SET_LIMITS.minLinks || n > EVIDENCE_SET_LIMITS.maxLinks) bad('set_size');
  if (!(set.subjectKind in ENTITY_INDEX_SOURCES)) bad('subject_kind');
  else if (
    isKeyKind(set.subjectKind) ? !set.subjectKey || set.subjectId : !set.subjectId || set.subjectKey
  ) {
    bad('subject_identity');
  }
  if (!(EVIDENCE_ORIGINS as readonly string[]).includes(set.origin)) bad('origin');
  const derived = (DERIVED_ORIGINS as readonly string[]).includes(set.origin);
  if (derived !== (set.derivation !== undefined)) bad('derivation_required');
  if (
    set.derivation &&
    (!EVIDENCE_DERIVATION_KEY_PATTERN.test(set.derivation.key) ||
      !EVIDENCE_DERIVATION_VERSION_PATTERN.test(set.derivation.version) ||
      !/^[0-9a-f]{64}$/.test(set.derivation.inputsHash))
  ) {
    bad('derivation_shape');
  }
  const ordinals = new Set<number>();
  for (const link of set.links) {
    const o = link.ordinal;
    if (!Number.isInteger(o) || o < 0 || o > EVIDENCE_SET_LIMITS.maxOrdinal)
      bad('ordinal_range', o);
    if (ordinals.has(o)) bad('ordinal_duplicate', o);
    ordinals.add(o);
    if (!(EVIDENCE_ROLES as readonly string[]).includes(link.role)) bad('role', o);
    if (link.weight !== undefined && !(link.weight >= 0 && link.weight <= 1)) bad('weight', o);
    const group = {
      entity:
        link.evidenceKind !== undefined ||
        link.evidenceId !== undefined ||
        link.evidenceKey !== undefined,
      change: link.evidenceChangeId !== undefined,
      snapshot: link.evidenceSnapshotId !== undefined,
    };
    let groupOk = false;
    switch (link.evidenceType) {
      case 'entity':
        groupOk =
          !group.change &&
          !group.snapshot &&
          link.evidenceKind !== undefined &&
          link.evidenceKind in ENTITY_INDEX_SOURCES &&
          (isKeyKind(link.evidenceKind)
            ? !!link.evidenceKey && link.evidenceId === undefined
            : !!link.evidenceId && link.evidenceKey === undefined);
        break;
      case 'change_record':
        groupOk = group.change && !group.entity && !group.snapshot;
        break;
      case 'eligibility_snapshot':
        groupOk = group.snapshot && !group.entity && !group.change;
        break;
    }
    if (!groupOk) {
      bad('evidence_group', o);
      continue;
    }
    if (
      link.evidenceType === 'entity' &&
      link.evidenceKind === set.subjectKind &&
      (link.evidenceId ?? null) === (set.subjectId ?? null) &&
      (link.evidenceKey ?? null) === (set.subjectKey ?? null)
    ) {
      bad('cites_own_subject', o);
    }
    if (false) {
      issues.push({ code: 'evidence_relation_not_allowed', ordinal: o, reason: 'relation' });
    }
  }
  return issues;
}
