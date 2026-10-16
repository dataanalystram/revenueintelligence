import { canonicalHash } from '../shared/canonical-json';

/**
 * Governed versioned registries (M10A2 plan §5). One generic store for every
 * kind; only `data_policy` has a document schema in M10A2 (Q8). The other
 * kinds are refused `registry_kind_not_available` until their sub-milestone
 * registers a schema.
 */
export const REGISTRY_KINDS = [
  'data_policy',
  'signal_type',
  'metric',
  'action_type',
  'context_type',
  'extension',
] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

/** Kinds with a registered document schema (M10D: `extension`, plan §2; M10E: `context_type`). */
export const AVAILABLE_REGISTRY_KINDS: readonly RegistryKind[] = [
  'data_policy',
  'extension',
  'context_type',
];

/** The available registry kinds published with canonical 0.5 (frozen for its catalogue hash; M10F adds none, Q3). */
export const REGISTRY_KINDS_0_5 = ['data_policy', 'extension', 'context_type'] as const;

export const REGISTRY_ENTRY_STATUSES = ['active', 'retired', 'promoted'] as const;
export type RegistryEntryStatus = (typeof REGISTRY_ENTRY_STATUSES)[number];

/** R-K: registry keys. */
export const REGISTRY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Document cap of every kind except `extension` (M10A2). The `extension` kind is
 * capped by the `EXTENSION_REGISTRY_MAX_BYTES` guardrail (M10D Q3, default 2 MiB);
 * the database ceiling of that kind is `EXTENSION_REGISTRY_MAX_BYTES_CEILING`.
 */
export const REGISTRY_DOCUMENT_MAX_BYTES = 256 * 1024;

/** One projected entry of a registry version. */
export interface RegistryEntryDraft {
  readonly key: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly status?: RegistryEntryStatus;
  /** M10D: per-definition classification, projected into the entry's columns (control 8). */
  readonly sensitivity?: string;
  readonly categories?: readonly string[];
}

export type RegistryRule = 'R-K' | 'R-X1' | 'R-X3' | 'R-X4';
export interface RegistryRuleViolation {
  readonly rule: RegistryRule;
  readonly key: string;
}

function codesOf(definition: Readonly<Record<string, unknown>>): string[] {
  const codes = definition.codes;
  return Array.isArray(codes) ? codes.filter((c): c is string => typeof c === 'string') : [];
}

/**
 * Generic cross-version rules: R-K key format, R-X1 a key never disappears,
 * R-X3 codes never disappear, R-X4 a key's `kind` / `target` never changes.
 */
export function registryRuleViolations(
  previous: readonly RegistryEntryDraft[],
  next: readonly RegistryEntryDraft[],
): RegistryRuleViolation[] {
  const out: RegistryRuleViolation[] = [];
  const nextByKey = new Map(next.map((e) => [e.key, e]));
  for (const e of next) {
    if (!REGISTRY_KEY_PATTERN.test(e.key)) out.push({ rule: 'R-K', key: e.key });
  }
  for (const before of previous) {
    const after = nextByKey.get(before.key);
    if (!after) {
      out.push({ rule: 'R-X1', key: before.key });
      continue;
    }
    const kept = new Set(codesOf(after.definition));
    if (codesOf(before.definition).some((c) => !kept.has(c))) {
      out.push({ rule: 'R-X3', key: before.key });
    }
    for (const field of ['kind', 'target'] as const) {
      if (field in before.definition && before.definition[field] !== after.definition[field]) {
        out.push({ rule: 'R-X4', key: before.key });
        break;
      }
    }
  }
  return out;
}

/** sha256 of the canonical JSON of a registry document (what the dry run prints). */
export function registryContentHash(document: unknown): string {
  return canonicalHash(document);
}
