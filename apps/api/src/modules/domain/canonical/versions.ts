import { canonicalHash } from '../shared/canonical-json';

/**
 * Canonical model versions (M10A2 plan §2, ADR 0027). `MAJOR.MINOR`; `0.x`
 * while the canonical model is being implemented (M10 plan D1). The database
 * refuses any `major >= 1` row (named CHECK `canonical_model_versions_pre_freeze`)
 * until a freeze migration with its own ADR drops it.
 */
export const CANONICAL_VERSION_PATTERN = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,3})$/;

export const CANONICAL_VERSION_STATUSES = [
  'current',
  'supported',
  'deprecated',
  'unsupported',
] as const;
export type CanonicalVersionStatus = (typeof CANONICAL_VERSION_STATUSES)[number];

export interface CanonicalVersion {
  readonly major: number;
  readonly minor: number;
}

export class InvalidCanonicalVersionError extends Error {
  constructor(readonly label: string) {
    super(`Invalid canonical version: ${JSON.stringify(label)}`);
    this.name = 'InvalidCanonicalVersionError';
  }
}

export function parseCanonicalVersion(label: string): CanonicalVersion {
  const m = CANONICAL_VERSION_PATTERN.exec(label);
  if (!m) throw new InvalidCanonicalVersionError(label);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function formatCanonicalVersion(v: CanonicalVersion): string {
  return `${v.major}.${v.minor}`;
}

/**
 * Numeric `(major, minor)` ordering, never lexical (`0.10 > 0.9`).
 * Negative when `a < b`, zero when equal, positive when `a > b`.
 */
export function compareCanonicalVersion(a: string, b: string): number {
  const x = parseCanonicalVersion(a);
  const y = parseCanonicalVersion(b);
  return x.major !== y.major ? x.major - y.major : x.minor - y.minor;
}

/** The code catalogue; the schema guard keeps `canonical_model_versions` equal to it. */
export interface CanonicalVersionEntry {
  readonly version: string;
  readonly status: CanonicalVersionStatus;
  readonly adr: string;
}

export const CANONICAL_VERSIONS: readonly CanonicalVersionEntry[] = [
  { version: '0.1', status: 'supported', adr: '0027' },
  // M10B (ADR 0028): generic source references, evidence links, key-identified change records.
  { version: '0.2', status: 'supported', adr: '0028' },
  // M10C (ADR 0029): account hierarchy, person–account affiliation.
  { version: '0.3', status: 'supported', adr: '0029' },
  // M10D (ADR 0030): extension framework (registry, typed values, custom objects / relationships).
  { version: '0.4', status: 'supported', adr: '0030' },
  // M10E (ADR 0031): AccountContext (context types, contexts, memberships, line context).
  { version: '0.5', status: 'supported', adr: '0031' },
  // M10F (ADR 0032): Commercial (price offers, contracts and links, entitlements, line references).
  { version: '0.6', status: 'current', adr: '0032' },
];

/**
 * What each canonical version enables for a tenant that adopts it (M10B plan
 * §7): the adoption dry run lists the features gained (forward) or withdrawn
 * (rollback) between the adopted and the target version. Codes only.
 */
export const CANONICAL_VERSION_FEATURES: Readonly<Record<string, readonly string[]>> = {
  '0.1': [],
  '0.2': ['observed_generic_source_references', 'evidence_links', 'key_identified_change_records'],
  '0.3': ['account_hierarchy', 'person_affiliations', 'hierarchy_operator_entry'],
  '0.4': [
    'extension_registry',
    'extension_values',
    'custom_objects',
    'custom_relationships',
    'source_attribute_capture',
  ],
  '0.5': ['account_context', 'context_type_registry', 'context_membership', 'line_context'],
  '0.6': [
    'agreement_ref',
    'price_offer',
    'contract',
    'contract_links',
    'entitlement',
    'line_commercial_refs',
  ],
};

/** Features enabled by versions in (from, to] when moving forward, or withdrawn when moving back. */
export function canonicalFeatureChanges(
  from: string,
  to: string,
): { readonly enables: readonly string[]; readonly disables: readonly string[] } {
  const cmp = compareCanonicalVersion(to, from);
  if (cmp === 0) return { enables: [], disables: [] };
  const [lo, hi] = cmp > 0 ? [from, to] : [to, from];
  const between = Object.keys(CANONICAL_VERSION_FEATURES)
    .filter((v) => compareCanonicalVersion(v, lo) > 0 && compareCanonicalVersion(v, hi) <= 0)
    .sort(compareCanonicalVersion)
    .flatMap((v) => CANONICAL_VERSION_FEATURES[v] ?? []);
  return cmp > 0 ? { enables: between, disables: [] } : { enables: [], disables: between };
}

export function currentCanonicalVersion(): string {
  const current = CANONICAL_VERSIONS.filter((v) => v.status === 'current');
  if (current.length !== 1) throw new Error('exactly one canonical version must be current');
  return current[0]!.version;
}

/** Statuses a tenant may adopt (plan §3). */
export function isAdoptableStatus(status: CanonicalVersionStatus): boolean {
  return status === 'current' || status === 'supported';
}

/** The vocabulary a canonical version is tied to (the input of its `catalogue_hash`). */
export interface CanonicalCatalogue {
  readonly entityKinds: readonly string[];
  readonly moduleKeys: readonly string[];
  readonly changeTypes: readonly string[];
  readonly causes: readonly string[];
  readonly origins: readonly string[];
  /** M10B (0.2): optional members, hashed only when present (Q19), so 0.1's stored hash is unchanged. */
  readonly changeEntityKinds?: readonly string[];
  readonly genericReferenceKinds?: readonly string[];
  readonly evidenceTypes?: readonly string[];
  readonly evidenceRoles?: readonly string[];
  /** M10C (0.3): optional members, hashed only when present, so 0.1 / 0.2 hashes are unchanged. */
  readonly authorityFacts?: readonly string[];
  readonly mappingTargets?: readonly string[];
  readonly hierarchy?: { readonly maxDepthCeiling: number };
  readonly affiliationEndReasons?: readonly string[];
  /** M10D (0.4): optional members, hashed only when present, so 0.1–0.3 hashes are unchanged. */
  readonly extensionValueTypes?: readonly string[];
  readonly extensionTargets?: readonly string[];
  readonly extensionAllowedUses?: readonly string[];
  readonly mappingEntryKinds?: readonly string[];
  /** M10E (0.5): optional members, hashed only when present, so 0.1–0.4 hashes are unchanged. */
  readonly mappingEntities?: readonly string[];
  readonly registryKinds?: readonly string[];
  /** M10F (0.6): the closed commercial vocabularies (plan §2), hashed only when present. */
  readonly commercial?: {
    readonly pricingModels: readonly string[];
    readonly billingPeriodUnits: readonly string[];
    readonly priceOfferStatuses: readonly string[];
    readonly contractStatuses: readonly string[];
    readonly contractLinkKinds: readonly string[];
    readonly entitlementStatuses: readonly string[];
  };
}

/**
 * The vocabulary a version's rows are tied to: entity-index kinds, module keys
 * and the change-record vocabulary (0.2 adds the change entity kinds, generic
 * reference kinds, evidence types and roles). Its hash is stored as
 * `catalogue_hash`. Absent optional members are not hashed (Q19).
 */
export function canonicalCatalogueHash(catalogue: CanonicalCatalogue): string {
  const sorted = (xs: readonly string[] | undefined) => (xs ? [...xs].sort() : undefined);
  return canonicalHash({
    entityKinds: sorted(catalogue.entityKinds),
    moduleKeys: sorted(catalogue.moduleKeys),
    changeTypes: sorted(catalogue.changeTypes),
    causes: sorted(catalogue.causes),
    origins: sorted(catalogue.origins),
    changeEntityKinds: sorted(catalogue.changeEntityKinds),
    genericReferenceKinds: sorted(catalogue.genericReferenceKinds),
    evidenceTypes: sorted(catalogue.evidenceTypes),
    evidenceRoles: sorted(catalogue.evidenceRoles),
    authorityFacts: sorted(catalogue.authorityFacts),
    mappingTargets: sorted(catalogue.mappingTargets),
    hierarchy: catalogue.hierarchy
      ? { maxDepthCeiling: catalogue.hierarchy.maxDepthCeiling }
      : undefined,
    affiliationEndReasons: sorted(catalogue.affiliationEndReasons),
    extensionValueTypes: sorted(catalogue.extensionValueTypes),
    extensionTargets: sorted(catalogue.extensionTargets),
    extensionAllowedUses: sorted(catalogue.extensionAllowedUses),
    mappingEntryKinds: sorted(catalogue.mappingEntryKinds),
    mappingEntities: sorted(catalogue.mappingEntities),
    registryKinds: sorted(catalogue.registryKinds),
    commercial: catalogue.commercial
      ? {
          pricingModels: sorted(catalogue.commercial.pricingModels),
          billingPeriodUnits: sorted(catalogue.commercial.billingPeriodUnits),
          priceOfferStatuses: sorted(catalogue.commercial.priceOfferStatuses),
          contractStatuses: sorted(catalogue.commercial.contractStatuses),
          contractLinkKinds: sorted(catalogue.commercial.contractLinkKinds),
          entitlementStatuses: sorted(catalogue.commercial.entitlementStatuses),
        }
      : undefined,
  });
}

export type AdoptionDecision =
  | { readonly ok: true; readonly reason: 'operator_adoption' | 'rollback' }
  | {
      readonly ok: false;
      readonly code:
        | 'canonical_version_not_supported'
        | 'canonical_version_unknown'
        | 'no_change'
        | 'stale_base_version';
    };

/**
 * Adoption rules (plan §3, Q3): the target must exist and be current or
 * supported; forward to any newer adoptable version; backward only to the
 * immediately previous MINOR of the same MAJOR (a `rollback`).
 */
export function decideAdoption(input: {
  readonly current: string;
  readonly expectedCurrent: string;
  readonly target: string;
  readonly catalogue: readonly {
    readonly version: string;
    readonly status: CanonicalVersionStatus;
  }[];
}): AdoptionDecision {
  if (input.expectedCurrent !== input.current) return { ok: false, code: 'stale_base_version' };
  const entry = input.catalogue.find((v) => v.version === input.target);
  if (!entry) return { ok: false, code: 'canonical_version_unknown' };
  if (!isAdoptableStatus(entry.status)) {
    return { ok: false, code: 'canonical_version_not_supported' };
  }
  const order = compareCanonicalVersion(input.target, input.current);
  if (order === 0) return { ok: false, code: 'no_change' };
  if (order > 0) return { ok: true, reason: 'operator_adoption' };
  const cur = parseCanonicalVersion(input.current);
  const tgt = parseCanonicalVersion(input.target);
  if (tgt.major === cur.major && tgt.minor === cur.minor - 1) {
    return { ok: true, reason: 'rollback' };
  }
  return { ok: false, code: 'canonical_version_not_supported' };
}
