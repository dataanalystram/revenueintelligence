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
  { version: '0.1', status: 'current', adr: '0027' },
];

export function currentCanonicalVersion(): string {
  const current = CANONICAL_VERSIONS.filter((v) => v.status === 'current');
  if (current.length !== 1) throw new Error('exactly one canonical version must be current');
  return current[0]!.version;
}

/** Statuses a tenant may adopt (plan §3). */
export function isAdoptableStatus(status: CanonicalVersionStatus): boolean {
  return status === 'current' || status === 'supported';
}

/**
 * The vocabulary a version's rows are tied to: entity-index kinds, module keys
 * and the change-record vocabulary. Its hash is stored as `catalogue_hash`.
 */
export function canonicalCatalogueHash(catalogue: {
  readonly entityKinds: readonly string[];
  readonly moduleKeys: readonly string[];
  readonly changeTypes: readonly string[];
  readonly causes: readonly string[];
  readonly origins: readonly string[];
}): string {
  return canonicalHash({
    entityKinds: [...catalogue.entityKinds].sort(),
    moduleKeys: [...catalogue.moduleKeys].sort(),
    changeTypes: [...catalogue.changeTypes].sort(),
    causes: [...catalogue.causes].sort(),
    origins: [...catalogue.origins].sort(),
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
