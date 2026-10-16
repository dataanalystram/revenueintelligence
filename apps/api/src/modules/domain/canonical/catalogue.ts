import {
  ACCOUNT_STRUCTURE_MAPPING_TARGETS,
  AFFILIATION_END_REASONS,
  HIERARCHY_MAX_DEPTH_CEILING,
} from './account-structure';
import {
  CHANGE_CAUSES,
  CHANGE_ENTITY_KINDS,
  CHANGE_ENTITY_KINDS_0_2,
  CHANGE_ENTITY_KINDS_0_3,
  CHANGE_ENTITY_KINDS_0_4,
  CHANGE_ENTITY_KINDS_0_5,
  CHANGE_ORIGINS,
  CHANGE_TYPES,
} from './change-record';
import {
  ENTITY_INDEX_KINDS,
  ENTITY_INDEX_KINDS_0_1,
  ENTITY_INDEX_KINDS_0_3,
  ENTITY_INDEX_KINDS_0_4,
  ENTITY_INDEX_KINDS_0_5,
} from './entity-index';
import { COMMERCIAL_LINE_MAPPING_TARGETS, COMMERCIAL_VOCABULARIES } from './commercial';
import { EVIDENCE_ROLES, EVIDENCE_TYPES } from './evidence';
import {
  EXTENSION_ALLOWED_USES,
  EXTENSION_MAPPING_ENTRY_KINDS,
  EXTENSION_TARGET_KINDS,
  EXTENSION_TARGET_KINDS_0_4,
  EXTENSION_TARGET_KINDS_0_5,
  EXTENSION_VALUE_TYPES,
} from './extension';
import { MODULE_KEYS } from './modules';
import {
  GENERIC_REFERENCE_KINDS,
  GENERIC_REFERENCE_KINDS_0_2,
  GENERIC_REFERENCE_KINDS_0_3,
  GENERIC_REFERENCE_KINDS_0_4,
  GENERIC_REFERENCE_KINDS_0_5,
} from './source-reference';
import { REGISTRY_KINDS_0_5 } from './registry';
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
 * The authority facts published with canonical 0.5 (the 0.3 facts plus the
 * optional `account_context`, M10E Q16). Frozen.
 */
export const AUTHORITY_FACTS_0_5 = [...AUTHORITY_FACTS_0_3, 'account_context'] as const;

/**
 * The mapping entities published with canonical 0.5 (M8 `account` / `person` /
 * `subscription` plus M10E `account_context`, plan §5.1). Frozen; first hashed at 0.5.
 */
export const MAPPING_ENTITIES_0_5 = [
  'account',
  'person',
  'subscription',
  'account_context',
] as const;

/**
 * The authority facts published with canonical 0.6 (the 0.5 facts plus the
 * optional `price_offer`, `contract` and `entitlement`, M10F plan §6.4, Q24). Frozen.
 */
export const AUTHORITY_FACTS_0_6 = [
  ...AUTHORITY_FACTS_0_5,
  'price_offer',
  'contract',
  'entitlement',
] as const;

/**
 * The mapping entities published with canonical 0.6 (the 0.5 entities plus the
 * M10F blocks `price_offer` / `contract` / `entitlement`, plan §6.1). Frozen.
 */
export const MAPPING_ENTITIES_0_6 = [
  ...MAPPING_ENTITIES_0_5,
  'price_offer',
  'contract',
  'entitlement',
] as const;

/**
 * The mapping targets published with canonical 0.6: the 0.3 list (unchanged
 * through 0.5) plus the M10F line targets `subscription.agreement` /
 * `.priceOfferRef` / `.supersedesRef` (plan §6.2). Frozen.
 */
export const MAPPING_TARGETS_0_6 = [
  ...MAPPING_TARGETS_0_3,
  ...COMMERCIAL_LINE_MAPPING_TARGETS,
] as const;

/**
 * The catalogue each published canonical version is tied to (its
 * `catalogue_hash` input). 0.1 (ADR 0027) is the M10A2 vocabulary; 0.2
 * (ADR 0028) adds the M10B members; 0.3 (ADR 0029) adds `person_affiliation`
 * to the kind lists and the M10C members; 0.4 (ADR 0030) adds `custom_record`
 * (and the change entity kind `custom_relationship`) and the M10D members; 0.5 (ADR 0031) adds
 * `account_context` (and the change entity kind `account_context_person`), the authority fact,
 * mapping entity, extension target and registry kind of M10E; 0.6 (ADR 0032) adds `price_offer`,
 * `contract` and `entitlement` (kinds, generic references, extension targets), their authority facts and
 * mapping entities, the three line mapping targets and the closed commercial vocabularies of M10F. A
 * version's catalogue never changes
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
        genericReferenceKinds: GENERIC_REFERENCE_KINDS_0_2,
        evidenceTypes: EVIDENCE_TYPES,
        evidenceRoles: EVIDENCE_ROLES,
      };
    case '0.3':
      return catalogue0_3(base);
    case '0.4':
      return catalogue0_4(base);
    case '0.5':
      return catalogue0_5(base);
    case '0.6':
      return {
        ...catalogue0_5(base),
        entityKinds: ENTITY_INDEX_KINDS,
        changeEntityKinds: CHANGE_ENTITY_KINDS,
        genericReferenceKinds: GENERIC_REFERENCE_KINDS,
        extensionTargets: EXTENSION_TARGET_KINDS,
        authorityFacts: AUTHORITY_FACTS_0_6,
        mappingEntities: MAPPING_ENTITIES_0_6,
        mappingTargets: MAPPING_TARGETS_0_6,
        commercial: COMMERCIAL_VOCABULARIES,
      };
    default:
      throw new Error(`no catalogue for canonical version ${version}`);
  }
}

/** The 0.5 catalogue from frozen lists only (M10F: the kind lists grew after 0.5 was published). */
function catalogue0_5(base: CanonicalCatalogue): CanonicalCatalogue {
  return {
    ...catalogue0_4(base),
    entityKinds: ENTITY_INDEX_KINDS,
    changeEntityKinds: CHANGE_ENTITY_KINDS,
    genericReferenceKinds: GENERIC_REFERENCE_KINDS,
    extensionTargets: EXTENSION_TARGET_KINDS,
    authorityFacts: AUTHORITY_FACTS_0_5,
    mappingEntities: MAPPING_ENTITIES_0_5,
    registryKinds: REGISTRY_KINDS_0_5,
  };
}

/** The 0.4 catalogue from frozen lists only (M10E: the kind lists grew after 0.4 was published). */
function catalogue0_4(base: CanonicalCatalogue): CanonicalCatalogue {
  return {
    ...catalogue0_3(base),
    entityKinds: ENTITY_INDEX_KINDS_0_4,
    changeEntityKinds: CHANGE_ENTITY_KINDS_0_4,
    genericReferenceKinds: GENERIC_REFERENCE_KINDS_0_4,
    extensionValueTypes: EXTENSION_VALUE_TYPES,
    extensionTargets: EXTENSION_TARGET_KINDS_0_4,
    extensionAllowedUses: EXTENSION_ALLOWED_USES,
    mappingEntryKinds: EXTENSION_MAPPING_ENTRY_KINDS,
  };
}

/** The 0.3 catalogue from frozen lists only (M10D: the kind lists grew after 0.3 was published). */
function catalogue0_3(base: CanonicalCatalogue): CanonicalCatalogue {
  return {
    ...base,
    entityKinds: ENTITY_INDEX_KINDS_0_3,
    changeEntityKinds: CHANGE_ENTITY_KINDS_0_3,
    genericReferenceKinds: GENERIC_REFERENCE_KINDS_0_3,
    evidenceTypes: EVIDENCE_TYPES,
    evidenceRoles: EVIDENCE_ROLES,
    authorityFacts: AUTHORITY_FACTS_0_3,
    mappingTargets: MAPPING_TARGETS_0_3,
    hierarchy: { maxDepthCeiling: HIERARCHY_MAX_DEPTH_CEILING },
    affiliationEndReasons: AFFILIATION_END_REASONS,
  };
}
