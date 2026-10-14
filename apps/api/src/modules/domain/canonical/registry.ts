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

/** Kinds with a registered document schema. */
export const AVAILABLE_REGISTRY_KINDS: readonly RegistryKind[] = ['data_policy'];

export const REGISTRY_ENTRY_STATUSES = ['active', 'retired', 'promoted'] as const;
export type RegistryEntryStatus = (typeof REGISTRY_ENTRY_STATUSES)[number];

/** R-K: registry keys. */
export const REGISTRY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export const REGISTRY_DOCUMENT_MAX_BYTES = 256 * 1024;

/** One projected entry of a registry version. */
export interface RegistryEntryDraft {
  readonly key: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly status?: RegistryEntryStatus;
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
