import { compareCanonicalVersion } from './versions';

/**
 * Optional canonical modules (M10 plan §17, D5, F4; M10A2 plan §4). Core
 * (Account, hierarchy, Person, affiliation, Product, Subscription line,
 * references, provenance) is not a module. All nine are unavailable in M10A2
 * (Q16); each later sub-milestone's migration makes its module available at
 * the MINOR it publishes (M10D: `extension` at 0.4; M10E: `account_context` at 0.5). The schema guard keeps `canonical_modules` equal to
 * this catalogue.
 */
export const MODULE_KEYS = [
  'account_context',
  'commercial',
  'signals',
  'opportunities',
  'decision_chain',
  'value',
  'engagement',
  'extension',
  'data_quality',
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface CanonicalModuleEntry {
  readonly key: ModuleKey;
  readonly title: string;
  readonly available: boolean;
  /** NULL exactly while the module is not available. */
  readonly minimumCanonicalVersion: string | null;
  readonly dependsOn: readonly ModuleKey[];
  readonly configSchemaVersion: number;
  /** Canonical entity kinds that belong to this module (none before M10D). */
  readonly entityKinds: readonly string[];
}

const unavailable = (
  key: ModuleKey,
  title: string,
  dependsOn: readonly ModuleKey[] = [],
): CanonicalModuleEntry => ({
  key,
  title,
  available: false,
  minimumCanonicalVersion: null,
  dependsOn,
  configSchemaVersion: 1,
  entityKinds: [],
});

export const CANONICAL_MODULES: readonly CanonicalModuleEntry[] = [
  // M10E (ADR 0031): available at 0.5; account contexts belong to it (plan §10).
  {
    key: 'account_context',
    title: 'Account context',
    available: true,
    minimumCanonicalVersion: '0.5',
    dependsOn: [],
    configSchemaVersion: 1,
    entityKinds: ['account_context'],
  },
  unavailable('commercial', 'Commercial'),
  unavailable('signals', 'Signals', ['account_context']),
  unavailable('opportunities', 'Opportunities', ['commercial']),
  unavailable('decision_chain', 'Decision chain', ['opportunities']),
  unavailable('value', 'Value', ['commercial']),
  unavailable('engagement', 'Engagement'),
  // M10D (ADR 0030): available at 0.4; custom records belong to it (plan §10).
  {
    key: 'extension',
    title: 'Extensions',
    available: true,
    minimumCanonicalVersion: '0.4',
    dependsOn: [],
    configSchemaVersion: 1,
    entityKinds: ['custom_record'],
  },
  unavailable('data_quality', 'Data quality'),
];

export type ModuleChangeCode =
  | 'module_not_available'
  | 'module_dependency_missing'
  | 'module_required_by_other'
  | 'canonical_version_too_low'
  | 'stale_base_version'
  | 'no_change';

export type ModuleChangeDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ModuleChangeCode; readonly module?: string };

/**
 * Enable/disable rules (M10 §17): base version required; enabling needs the
 * module available, the adopted version at or above its minimum and every
 * dependency enabled; disabling is refused while an enabled module depends on it.
 */
export function decideModuleChange(input: {
  readonly module: Pick<
    CanonicalModuleEntry,
    'key' | 'available' | 'minimumCanonicalVersion' | 'dependsOn'
  >;
  readonly catalogue: readonly Pick<CanonicalModuleEntry, 'key' | 'dependsOn'>[];
  readonly enabled: ReadonlySet<string>;
  readonly adoptedVersion: string;
  readonly currentVersion: number;
  readonly expectedVersion: number;
  readonly targetEnabled: boolean;
  readonly configChanged: boolean;
}): ModuleChangeDecision {
  if (input.expectedVersion !== input.currentVersion) {
    return { ok: false, code: 'stale_base_version' };
  }
  const isEnabled = input.enabled.has(input.module.key);
  if (isEnabled === input.targetEnabled && !input.configChanged) {
    return { ok: false, code: 'no_change' };
  }
  if (input.targetEnabled) {
    if (!input.module.available || input.module.minimumCanonicalVersion === null) {
      return { ok: false, code: 'module_not_available' };
    }
    if (compareCanonicalVersion(input.adoptedVersion, input.module.minimumCanonicalVersion) < 0) {
      return { ok: false, code: 'canonical_version_too_low' };
    }
    for (const dep of input.module.dependsOn) {
      if (!input.enabled.has(dep)) {
        return { ok: false, code: 'module_dependency_missing', module: dep };
      }
    }
  } else if (isEnabled) {
    for (const other of input.catalogue) {
      if (
        other.key !== input.module.key &&
        input.enabled.has(other.key) &&
        other.dependsOn.includes(input.module.key)
      ) {
        return { ok: false, code: 'module_required_by_other', module: other.key };
      }
    }
  }
  return { ok: true };
}

/** Mapping hook (plan §4): targets whose entity kind belongs to a disabled module. */
export function disabledModuleTargets(
  targetEntityKinds: readonly string[],
  catalogue: readonly Pick<CanonicalModuleEntry, 'key' | 'entityKinds'>[],
  enabled: ReadonlySet<string>,
): { readonly entityKind: string; readonly module: string }[] {
  const out: { entityKind: string; module: string }[] = [];
  for (const kind of targetEntityKinds) {
    const owner = catalogue.find((m) => m.entityKinds.includes(kind));
    if (owner && !enabled.has(owner.key)) out.push({ entityKind: kind, module: owner.key });
  }
  return out;
}

export const MODULE_CONFIG_MAX_BYTES = 4096;
