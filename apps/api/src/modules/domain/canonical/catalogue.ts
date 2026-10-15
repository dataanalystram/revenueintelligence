import {
  ACCOUNT_STRUCTURE_MAPPING_TARGETS,
  AFFILIATION_END_REASONS,
  HIERARCHY_MAX_DEPTH_CEILING,
} from './account-structure';
import {
  CHANGE_CAUSES,
  CHANGE_ENTITY_KINDS,
  CHANGE_ENTITY_KINDS_0_2,
  CHANGE_ORIGINS,
  CHANGE_TYPES,
} from './change-record';
import { ENTITY_INDEX_KINDS, ENTITY_INDEX_KINDS_0_1 } from './entity-index';
import { EVIDENCE_ROLES, EVIDENCE_TYPES } from './evidence';
import { MODULE_KEYS } from './modules';
import { GENERIC_REFERENCE_KINDS, GENERIC_REFERENCE_KINDS_0_2 } from './source-reference';
import type { CanonicalCatalogue } from './versions';

/**
 * The authority facts published with canonical 0.3 (ADR 0020 facts plus
 * `account_hierarchy`, M10C plan §1.3). Frozen here, not read from the authority
 * schema, so the stored 0.3 hash never moves with a later fact.
 */
export const AUTHORITY_FACTS_0_3 = [
  'account_profile',
  'person_profile',
  'subscription_lines',
  'subscription_state',
  'subscription_terms',
  'account_hierarchy',
] as const;

/** The mapping targets published with canonical 0.3 (M8/M9 catalogue + the two M10C targets). Frozen. */
export const MAPPING_TARGETS_0_3 = [
  'account.name',
  'account.domain',
  'person.email',
  'person.firstName',
  'person.lastName',
  'person.jobTitle',
  'subscription.state',
  'subscription.startsAt',
  'subscription.endsAt',
  'subscription.quantity',
  'subscription.account',
  'subscription.product',
  'person.primaryCompany',
  ...ACCOUNT_STRUCTURE_MAPPING_TARGETS,
] as const;

/**
 * The catalogue each published canonical version is tied to (its
 * `catalogue_hash` input). 0.1 (ADR 0027) is the M10A2 vocabulary; 0.2
 * (ADR 0028) adds the M10B members; 0.3 (ADR 0029) adds `person_affiliation`
 * to the kind lists and the M10C members. A version's catalogue never changes
 * once published: earlier versions read frozen lists, and the schema guard
 * recomputes every stored hash from this function.
 */
export function canonicalCatalogueFor(version: string): CanonicalCatalogue {
  const base: CanonicalCatalogue = {
    entityKinds: ENTITY_INDEX_KINDS_0_1,
    moduleKeys: MODULE_KEYS,
    changeTypes: CHANGE_TYPES,
    causes: CHANGE_CAUSES,
    origins: CHANGE_ORIGINS,
  };
  switch (version) {
    case '0.1':
      return base;
    case '0.2':
      return {
        ...base,
        changeEntityKinds: CHANGE_ENTITY_KINDS_0_2,
        authorityFacts: AUTHORITY_FACTS_0_3,
        mappingTargets: MAPPING_TARGETS_0_3,
        genericReferenceKinds: GENERIC_REFERENCE_KINDS_0_2,
        evidenceTypes: EVIDENCE_TYPES,
        evidenceRoles: EVIDENCE_ROLES,
      };
    case '0.3':
      return {
        ...base,
        entityKinds: ENTITY_INDEX_KINDS,
        changeEntityKinds: CHANGE_ENTITY_KINDS,
        genericReferenceKinds: GENERIC_REFERENCE_KINDS,
        evidenceTypes: EVIDENCE_TYPES,
        evidenceRoles: EVIDENCE_ROLES,
        authorityFacts: AUTHORITY_FACTS_0_3,
        mappingTargets: MAPPING_TARGETS_0_3,
        hierarchy: { maxDepthCeiling: HIERARCHY_MAX_DEPTH_CEILING },
        affiliationEndReasons: AFFILIATION_END_REASONS,
      };
    default:
      throw new Error(`no catalogue for canonical version ${version}`);
  }
}
