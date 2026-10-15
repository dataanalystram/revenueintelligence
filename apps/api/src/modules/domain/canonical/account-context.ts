import { z } from 'zod';
import {
  atLeast,
  CATEGORY_FLOORS,
  DATA_CATEGORIES,
  SENSITIVITIES,
  type DataCategory,
  type Sensitivity,
} from '../security/classification';
import { canonicalHash } from '../shared/canonical-json';
import { credentialLikeTokens, sensitivityRank } from './extension';
import type { RegistryEntryDraft } from './registry';

/**
 * AccountContext (M10E plan docs/milestones/M10E-account-context-plan.md,
 * ADR 0031, canonical 0.5, module `account_context`). Closed vocabularies —
 * the database CHECKs equal these lists (schema guard) — the publish-time
 * validation of the `context_type` registry document (plan §2.1) and the
 * context-type cross-version rules R-C1–R-C3 (plan §2.2). Pure: no I/O.
 *
 * No context type, dimension, role code or picklist value is seeded: context
 * types are tenant-published registry entries (CLAUDE.md, plan §0).
 */

/** Minimum canonical version for contexts, memberships, line assignment and `context_type` (plan §10). */
export const ACCOUNT_CONTEXT_MIN_VERSION = '0.5';
export const ACCOUNT_CONTEXT_MODULE_KEY = 'account_context' as const;

/** Registry document schema version of kind `context_type` (plan §2.1). */
export const CONTEXT_TYPE_DOCUMENT_SCHEMA_VERSION = 1;

/** `tenant_account_contexts.status` (CHECK). */
export const ACCOUNT_CONTEXT_STATUSES = ['active', 'inactive', 'retired'] as const;
export type AccountContextStatus = (typeof ACCOUNT_CONTEXT_STATUSES)[number];
/** Statuses a subscription line may be assigned to (Q8; the guard trigger equals this list). */
export const ACCOUNT_CONTEXT_ASSIGNABLE_STATUSES: readonly AccountContextStatus[] = [
  'active',
  'inactive',
];
/** `tenant_account_contexts.record_state` (CHECK). */
export const ACCOUNT_CONTEXT_RECORD_STATES = ['active', 'merged'] as const;
/** `tenant_account_context_persons.status` (CHECK; Q10: ended, never deleted). */
export const ACCOUNT_CONTEXT_MEMBER_STATUSES = ['active', 'ended'] as const;
/** `tenant_account_context_products.origin` (CHECK; Q7). */
export const ACCOUNT_CONTEXT_PRODUCT_ORIGINS = ['dimension', 'explicit'] as const;

/** Dimension value types of a context type (plan §2.1). */
export const CONTEXT_DIMENSION_TYPES = ['product_key', 'code', 'string', 'extension_ref'] as const;
export type ContextDimensionType = (typeof CONTEXT_DIMENSION_TYPES)[number];
/** Extension field value types an `extension_ref` dimension may reference (R-C4). */
export const CONTEXT_EXTENSION_REF_VALUE_TYPES = ['string', 'enum', 'integer'] as const;

/** 1–6 ordered dimensions per type; the database CHECK bounds the stored object the same way (plan §3.1). */
export const CONTEXT_MAX_DIMENSIONS = 6;
export const ACCOUNT_CONTEXT_NAME_MAX_CHARS = 200;
/** A string dimension value (plan §3.1: flat scalars). */
export const CONTEXT_DIMENSION_STRING_MAX_CHARS = 200;

/** Interim data-quality kinds recorded in `tenant_identity_conflicts` until M10L (plan §3.5). */
export const ACCOUNT_CONTEXT_CONFLICT_KINDS = [
  'account_context_merge_collision',
  'account_context_company_mismatch',
  'account_context_human_override_disagrees',
  'account_context_reference_unresolved',
] as const;

/** Value-history fields of M10E (M10 §10: owner / status; Q23: the line's context). */
export const ACCOUNT_CONTEXT_HISTORY_FIELDS = {
  account_context: ['owner_ref', 'status'],
  subscription: ['context_id'],
} as const;

/** Issue codes that refuse a publish with their own audit reason code (plan §2.2, R-C5). */
export const CONTEXT_TYPE_REFUSAL_CODES = [
  'credential_like_definition',
  'classification_required',
  'restricted_dimension_refused',
] as const;

// ---------------------------------------------------------------------------
// Registry document (plan §2.1)
// ---------------------------------------------------------------------------

const Key = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const Code = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const ContextDimensionSchema = z.strictObject({
  key: Key,
  type: z.enum(CONTEXT_DIMENSION_TYPES),
  required: z.boolean(),
  /** `code` dimensions only: the closed codes (R-C2: never lose a code). */
  codes: z.array(Code).min(1).max(500).optional(),
  /** `extension_ref` dimensions only: an active M10D extension field key (R-C4). */
  extension_field: Key.optional(),
  sensitivity: z.enum(SENSITIVITIES).optional(),
  categories: z.array(z.enum(DATA_CATEGORIES)).max(DATA_CATEGORIES.length).optional(),
});
export type ContextDimension = z.infer<typeof ContextDimensionSchema>;

export const ContextTypeDefinitionSchema = z.strictObject({
  key: Key,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  dimensions: z.array(ContextDimensionSchema).min(1).max(CONTEXT_MAX_DIMENSIONS),
  /** Closed per-type person role codes; none is seeded. */
  member_roles: z.array(Code).max(100).default([]),
  /** Explicit product memberships beyond product dimensions (Q7). */
  allow_products: z.boolean().default(false),
  status: z.enum(['active', 'retired']).default('active'),
});
export type ContextTypeDefinition = z.infer<typeof ContextTypeDefinitionSchema>;

/**
 * Parses a stored (projected) `context_type` registry entry definition: the
 * projection adds `kind` and `codes` (= member roles, for the generic R-X3) to
 * the published type (M10E 2b fix: the strict schema refused the projection).
 */
export function parseStoredContextType(
  definition: unknown,
): ReturnType<typeof ContextTypeDefinitionSchema.safeParse> {
  const value =
    definition && typeof definition === 'object' && !Array.isArray(definition)
      ? Object.fromEntries(
          Object.entries(definition as Record<string, unknown>).filter(
            ([k]) => k !== 'kind' && k !== 'codes',
          ),
        )
      : definition;
  return ContextTypeDefinitionSchema.safeParse(value);
}

export const ContextTypeDocumentSchema = z.strictObject({
  schema_version: z.literal(CONTEXT_TYPE_DOCUMENT_SCHEMA_VERSION),
  types: z.array(ContextTypeDefinitionSchema).max(200),
});
export type ContextTypeDocument = z.infer<typeof ContextTypeDocumentSchema>;

/** One projected entry per type; classification = the strictest dimension (projection columns). */
export interface ContextTypeEntryDraft extends RegistryEntryDraft {
  readonly definition: Readonly<Record<string, unknown>>;
  readonly sensitivity: Sensitivity;
  readonly categories: readonly DataCategory[];
}

export interface ContextTypeIssue {
  readonly key: string;
  readonly code: string;
}

export type ContextTypeDocumentValidation =
  | {
      readonly ok: true;
      readonly document: ContextTypeDocument;
      readonly entries: readonly ContextTypeEntryDraft[];
    }
  | { readonly ok: false; readonly issues: readonly ContextTypeIssue[] };

/**
 * Publish-time validation of a `context_type` registry document (plan §2.1,
 * §2.2): shape, unique type keys, unique dimension keys per type, per-type
 * dimension rules (`codes` exactly for `code`, `extension_field` exactly for
 * `extension_ref`), classification required on every dimension with the
 * category floors (R-C3 baseline), `restricted` dimensions refused while tech
 * debt #15 is open (R-C5, Q11), credential-like keys / titles refused (R-C5,
 * the M10D closed token list). R-C4's registry lookups happen at publish.
 */
export function validateContextTypeDocument(raw: unknown): ContextTypeDocumentValidation {
  const parsed = ContextTypeDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        key: i.path.join('.') || '(document)',
        code: i.code,
      })),
    };
  }
  const doc = parsed.data;
  const issues: ContextTypeIssue[] = [];
  const add = (key: string, code: string) => issues.push({ key, code });
  const seen = new Set<string>();
  const entries: ContextTypeEntryDraft[] = [];
  for (const t of doc.types) {
    if (seen.has(t.key)) add(t.key, 'duplicate_key');
    seen.add(t.key);
    for (const text of [t.key, t.title, t.description]) {
      if (credentialLikeTokens(text).length > 0) {
        add(t.key, 'credential_like_definition');
        break;
      }
    }
    if (new Set(t.member_roles).size !== t.member_roles.length) add(t.key, 'duplicate_role');
    const dimKeys = new Set<string>();
    let strictest: Sensitivity = 'public';
    const categories = new Set<DataCategory>();
    for (const d of t.dimensions) {
      const where = `${t.key}.${d.key}`;
      if (dimKeys.has(d.key)) add(where, 'duplicate_dimension');
      dimKeys.add(d.key);
      if (credentialLikeTokens(d.key).length > 0) add(where, 'credential_like_definition');
      if ((d.type === 'code') !== (d.codes !== undefined)) add(where, 'dimension_codes_invalid');
      if (d.codes && new Set(d.codes).size !== d.codes.length) add(where, 'duplicate_code');
      if ((d.type === 'extension_ref') !== (d.extension_field !== undefined)) {
        add(where, 'dimension_extension_field_invalid');
      }
      if (!d.sensitivity || !d.categories || d.categories.length === 0) {
        add(where, 'classification_required');
        continue;
      }
      if (new Set(d.categories).size !== d.categories.length) add(where, 'duplicate_category');
      for (const c of d.categories) {
        const floor = CATEGORY_FLOORS[c];
        if (floor && !atLeast(d.sensitivity, floor)) add(where, 'classification_below_floor');
        categories.add(c);
      }
      if (d.sensitivity === 'restricted') add(where, 'restricted_dimension_refused');
      if (sensitivityRank(d.sensitivity) > sensitivityRank(strictest)) strictest = d.sensitivity;
    }
    entries.push({
      key: t.key,
      status: t.status,
      definition: { ...t, kind: 'context_type', codes: [...t.member_roles] },
      sensitivity: strictest,
      categories: DATA_CATEGORIES.filter((c) => categories.has(c)),
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, document: doc, entries };
}

// ---------------------------------------------------------------------------
// Cross-version rules (plan §2.2)
// ---------------------------------------------------------------------------

export type ContextTypeRule = 'R-C1' | 'R-C2' | 'R-C3';
export interface ContextTypeRuleViolation {
  readonly rule: ContextTypeRule;
  readonly key: string;
}

function dimensionsOf(definition: Readonly<Record<string, unknown>>): ContextDimension[] {
  const parsed = z.array(ContextDimensionSchema).safeParse(definition.dimensions);
  return parsed.success ? parsed.data : [];
}

/**
 * R-C1: dimension keys, order and types never change (a new dimension needs a
 * new type key, Q5). R-C2: a `code` dimension never loses a code. R-C3: a
 * dimension's classification never becomes weaker and never drops a category
 * (the M10D R-X6 rule per dimension). Generic R-K / R-X1 / R-X3 (member roles,
 * projected as `codes`) / R-X4 run beside these.
 */
export function contextTypeRuleViolations(
  previous: readonly {
    readonly key: string;
    readonly definition: Readonly<Record<string, unknown>>;
  }[],
  next: readonly { readonly key: string; readonly definition: Readonly<Record<string, unknown>> }[],
): ContextTypeRuleViolation[] {
  const out: ContextTypeRuleViolation[] = [];
  const byKey = new Map(next.map((e) => [e.key, e]));
  for (const before of previous) {
    const after = byKey.get(before.key);
    if (!after) continue; // R-X1 (generic)
    const b = dimensionsOf(before.definition);
    const a = dimensionsOf(after.definition);
    const shape = (ds: ContextDimension[]) => ds.map((d) => `${d.key}:${d.type}`).join('|');
    if (shape(b) !== shape(a)) {
      out.push({ rule: 'R-C1', key: before.key });
      continue;
    }
    let lostCode = false;
    let weaker = false;
    b.forEach((bd, i) => {
      const ad = a[i]!;
      const kept = new Set(ad.codes ?? []);
      if ((bd.codes ?? []).some((c) => !kept.has(c))) lostCode = true;
      if (bd.extension_field !== ad.extension_field) {
        // The referenced field is part of the dimension's meaning (R-C1).
        out.push({ rule: 'R-C1', key: before.key });
      }
      if (
        bd.sensitivity !== undefined &&
        (ad.sensitivity === undefined ||
          sensitivityRank(ad.sensitivity) < sensitivityRank(bd.sensitivity))
      ) {
        weaker = true;
      }
      if ((bd.categories ?? []).some((c) => !(ad.categories ?? []).includes(c))) weaker = true;
    });
    if (lostCode) out.push({ rule: 'R-C2', key: before.key });
    if (weaker) out.push({ rule: 'R-C3', key: before.key });
  }
  return out;
}

/** R-C4: the `extension_ref` dimensions of a document as `(type, dimension, field key)`. */
export function contextExtensionRefs(
  doc: ContextTypeDocument,
): { readonly type: string; readonly dimension: string; readonly field: string }[] {
  return doc.types.flatMap((t) =>
    t.dimensions.flatMap((d) =>
      d.type === 'extension_ref' && d.extension_field
        ? [{ type: t.key, dimension: d.key, field: d.extension_field }]
        : [],
    ),
  );
}

// ---------------------------------------------------------------------------
// Natural key (Q4)
// ---------------------------------------------------------------------------

/**
 * The natural-key hash of a context: SHA-256 of the canonical JSON of the
 * ordered `[dimension key, value]` pairs in the type's dimension order (an
 * absent optional dimension is `null`). Company and type are the other two
 * natural-key columns (plan §3.1).
 */
export function contextNaturalKeyHash(
  dimensionOrder: readonly string[],
  values: Readonly<Record<string, string | number | null | undefined>>,
): string {
  return canonicalHash(dimensionOrder.slice(0, -1).map((k) => [k, values[k] ?? null]));
}
