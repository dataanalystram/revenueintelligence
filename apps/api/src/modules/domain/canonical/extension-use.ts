import { createHash } from 'node:crypto';
import {
  CAPTURED_FIELD_USES,
  CAPTURED_KEY_PREFIX,
  EXTENSION_ALLOWED_USES,
  EXTENSION_KEY_PATTERN,
  NOT_EVIDENCE_OF_FLOOR,
  type ExtensionAllowedUse,
} from './extension';

/**
 * Use enforcement (M10D plan §6, Q21) and source-captured field keys (plan
 * §5.4, Q20). Pure: no I/O.
 */

/** The parts of a definition the use guard reads (projected registry definition). */
export interface ExtensionUseSubject {
  readonly key: string;
  readonly allowedUses: readonly string[];
  readonly notEvidenceOf: readonly string[];
}

export function useSubjectFromDefinition(
  key: string,
  definition: Readonly<Record<string, unknown>>,
): ExtensionUseSubject {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    key,
    allowedUses: list(definition.allowed_uses),
    // The platform floor is always present (Q21), whatever the stored definition says.
    notEvidenceOf: [...new Set([...NOT_EVIDENCE_OF_FLOOR, ...list(definition.not_evidence_of)])],
  };
}

export function isExtensionUse(use: string): use is ExtensionAllowedUse {
  return (EXTENSION_ALLOWED_USES as readonly string[]).includes(use);
}

export type ExtensionUseDecision =
  | { readonly ok: true; readonly allowed: readonly string[] }
  | { readonly ok: false; readonly refused: readonly string[] };

/**
 * `ExtensionUseGuard.require(use, fieldKeys)` (plan §6): every reader names
 * its use. Without explicit keys the fields lacking the use are filtered out;
 * with explicit keys a key lacking the use refuses the whole request
 * (`extension_use_not_allowed`), so a consumer never silently gets less than
 * it asked for.
 */
export function decideExtensionUse(
  use: ExtensionAllowedUse,
  subjects: readonly ExtensionUseSubject[],
  explicitKeys?: readonly string[],
): ExtensionUseDecision {
  const allows = (_s: ExtensionUseSubject) => use !== undefined;
  if (explicitKeys === undefined) {
    return { ok: true, allowed: subjects.filter(allows).map((s) => s.key) };
  }
  const byKey = new Map(subjects.map((s) => [s.key, s]));
  const refused = explicitKeys.filter((k) => {
    const s = byKey.get(k);
    return !s || !allows(s);
  });
  return refused.length > 0
    ? { ok: false, refused: [...new Set(refused)].sort() }
    : { ok: true, allowed: [...new Set(explicitKeys)] };
}

/**
 * Whether a definition may stand as evidence of a fact (plan §6): never for a
 * fact in its `not_evidence_of` (the floor `account_identity`,
 * `person_identity`, `subscription_ownership` always included).
 */
export function extensionMayEvidence(subject: ExtensionUseSubject, fact: string): boolean {
  return !subject.notEvidenceOf.includes(fact);
}

// ---------------------------------------------------------------------------
// Captured fields (plan §5.4, Q20)
// ---------------------------------------------------------------------------

function normalisePart(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/**
 * `src_<connection_kind>_<object>_<field>` normalised to the key pattern;
 * beyond 63 characters truncated to 54 plus `_` and an 8-hex hash suffix of
 * the full normalised key (Q20). Deterministic.
 */
export function capturedFieldKey(connectionKind: string, object: string, field: string): string {
  const full =
    `${CAPTURED_KEY_PREFIX}${[connectionKind, object, field].map(normalisePart).join('_')}`
      .replace(/_+/g, '_')
      .replace(/_+$/, '');
  if (full.length <= 63) return full;
  const suffix = createHash('sha256').update(full).digest('hex').slice(0, 8);
  return `${full.slice(0, 54).replace(/_+$/, '')}_${suffix}`;
}

export interface CaptureSource {
  readonly connectionKind: string;
  /** The mapped object's source ApiName and its mapping entity (`account`, `custom_object:x`, …). */
  readonly object: string;
  readonly entity: string;
  readonly field: string;
  /** Profile sensitivity of the source field (M9A), when profiled. */
  readonly profileSensitivity?: string;
  /** Declared source type from the snapshot (`string`, `number`, `boolean`, `date`, `datetime`, …). */
  readonly sourceType?: string;
}

export type CaptureDraftEntry =
  | {
      readonly ok: true;
      readonly source: string;
      readonly definition: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly source: string; readonly code: string };

const CAPTURE_TYPE: Readonly<Record<string, string>> = {
  string: 'string',
  text: 'text',
  textarea: 'text',
  number: 'number',
  decimal: 'number',
  integer: 'integer',
  int: 'integer',
  boolean: 'boolean',
  bool: 'boolean',
  date: 'date',
  datetime: 'datetime',
  timestamp: 'datetime',
};

/**
 * The registry additions for captured fields (`extension capture-draft`):
 * mapping publish never publishes registry entries (Q20). Sensitive source
 * fields are refused `capture_sensitive_refused` (never stored); a key that
 * collides with an existing definition or another capture is refused
 * `capture_key_collision`. Captured definitions are `internal` / `operational`,
 * uses `display` (⊆ display, analytics).
 */
export function captureDraft(
  sources: readonly CaptureSource[],
  existingKeys: ReadonlySet<string>,
  isSensitiveName: (field: string) => boolean,
): CaptureDraftEntry[] {
  const out: CaptureDraftEntry[] = [];
  const taken = new Map<string, string>();
  for (const s of sources) {
    const label = `${s.object}.${s.field}`;
    if (
      s.profileSensitivity === 'sensitive_by_name' ||
      s.profileSensitivity === 'sensitive_by_value' ||
      (s.profileSensitivity === undefined && isSensitiveName(s.field))
    ) {
      out.push({ ok: false, source: label, code: 'capture_sensitive_refused' });
      continue;
    }
    const key = capturedFieldKey(s.connectionKind, s.object, s.field);
    if (!EXTENSION_KEY_PATTERN.test(key)) {
      out.push({ ok: false, source: label, code: 'capture_key_invalid' });
      continue;
    }
    const prior = taken.get(key);
    if (prior !== undefined && prior !== label) {
      out.push({ ok: false, source: label, code: 'capture_key_collision' });
      continue;
    }
    taken.set(key, label);
    if (existingKeys.has(key)) continue; // already in the registry: nothing to add
    out.push({
      ok: true,
      source: label,
      definition: {
        key,
        target: s.entity,
        display_name: label.slice(0, 200),
        description: `Captured from ${s.connectionKind} ${label}`.slice(0, 2000),
        value_type: CAPTURE_TYPE[(s.sourceType ?? 'string').toLowerCase()] ?? 'string',
        sensitivity: 'internal',
        categories: ['operational'],
        allowed_uses: [CAPTURED_FIELD_USES[0]],
        origin: 'source_captured',
      },
    });
  }
  return out;
}
