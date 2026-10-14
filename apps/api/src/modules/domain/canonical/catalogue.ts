import { CHANGE_CAUSES, CHANGE_ENTITY_KINDS, CHANGE_ORIGINS, CHANGE_TYPES } from './change-record';
import { ENTITY_INDEX_KINDS } from './entity-index';
import { EVIDENCE_ROLES, EVIDENCE_TYPES } from './evidence';
import { MODULE_KEYS } from './modules';
import { GENERIC_REFERENCE_KINDS } from './source-reference';
import type { CanonicalCatalogue } from './versions';

/**
 * The catalogue each published canonical version is tied to (its
 * `catalogue_hash` input). 0.1 (ADR 0027) is the M10A2 vocabulary; 0.2
 * (ADR 0028) adds the M10B members. A version's catalogue never changes once
 * published: the schema guard recomputes every stored hash from this function.
 */
export function canonicalCatalogueFor(version: string): CanonicalCatalogue {
  const base: CanonicalCatalogue = {
    entityKinds: ENTITY_INDEX_KINDS,
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
        changeEntityKinds: CHANGE_ENTITY_KINDS,
        genericReferenceKinds: GENERIC_REFERENCE_KINDS,
        evidenceTypes: EVIDENCE_TYPES,
        evidenceRoles: EVIDENCE_ROLES,
      };
    default:
      throw new Error(`no catalogue for canonical version ${version}`);
  }
}
