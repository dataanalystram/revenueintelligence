import { createHash } from 'node:crypto';
import {
  ACCOUNT_CONTEXT_NAME_MAX_CHARS,
  CONTEXT_DIMENSION_STRING_MAX_CHARS,
  contextNaturalKeyHash,
  findSecretLike,
  type AccountContextStatus,
  type ContextTypeDefinition,
} from '../../domain';

/**
 * Pure decision functions of the M10E AccountContext writers (plan §4, §7;
 * ADR 0031). No I/O: the writers load the facts, these functions decide, the
 * writers apply. Every outcome is a code (never a value).
 */

/** A stored dimension value: flat scalars only (plan §3.1; booleans are not a dimension type). */
export type DimensionValue = string | number;

/** What the writer resolved before validating dimensions (I/O done by the caller). */
export interface DimensionLookups {
  /** Product key → `active` flag; absent = no such product. */
  readonly products: ReadonlyMap<string, boolean>;
  /**
   * An `extension_ref` dimension value parsed against its extension field:
   * the canonical scalar, or undefined when the value is not valid for the field
   * (or the field is unknown / retired).
   */
  readonly extensionValue: (field: string, raw: unknown) => DimensionValue | undefined;
}

export type DimensionRefusal =
  | 'dimension_unknown'
  | 'dimension_required'
  | 'dimension_invalid'
  | 'code_unknown'
  | 'product_unknown'
  | 'product_retired'
  | 'extension_value_invalid'
  | 'secret_like_value';

export type DimensionValidation =
  | {
      readonly ok: true;
      /** Normalised dimensions (absent optional dimensions omitted). */
      readonly dimensions: Readonly<Record<string, DimensionValue>>;
      readonly naturalKeyHash: string;
      /** Product keys named by `product_key` dimensions (origin `dimension` memberships, Q7). */
      readonly productKeys: readonly string[];
    }
  | { readonly ok: false; readonly code: DimensionRefusal; readonly key: string };

function isEmpty(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}

/**
 * Validates observed / entered dimension values against the context type
 * (plan §4.1): unknown keys refused, required present, `code` in the closed
 * codes, `product_key` an existing active product, `string` 1–200 chars,
 * `extension_ref` valid for its extension field; secret-like strings refused.
 */
export function validateDimensions(
  type: Pick<ContextTypeDefinition, 'dimensions'>,
  raw: Readonly<Record<string, unknown>>,
  lookups: DimensionLookups,
): DimensionValidation {
  const declared = new Map(type.dimensions.map((d) => [d.key, d]));
  for (const key of Object.keys(raw).sort()) {
    if (!declared.has(key)) return { ok: false, code: 'dimension_unknown', key };
  }
  const dimensions: Record<string, DimensionValue> = {};
  const productKeys: string[] = [];
  for (const d of type.dimensions) {
    const value = raw[d.key];
    if (isEmpty(value)) {
      if (d.required) return { ok: false, code: 'dimension_required', key: d.key };
      continue;
    }
    switch (d.type) {
      case 'product_key': {
        if (typeof value !== 'string') return { ok: false, code: 'dimension_invalid', key: d.key };
        const active = lookups.products.get(value);
        if (active === undefined) return { ok: false, code: 'product_unknown', key: d.key };
        if (!active) return { ok: false, code: 'product_retired', key: d.key };
        dimensions[d.key] = value;
        productKeys.push(value);
        break;
      }
      case 'code': {
        if (typeof value !== 'string' || !(d.codes ?? []).includes(value)) {
          return { ok: false, code: 'code_unknown', key: d.key };
        }
        dimensions[d.key] = value;
        break;
      }
      case 'string': {
        if (typeof value !== 'string') return { ok: false, code: 'dimension_invalid', key: d.key };
        const v = value.trim();
        if (v.length > CONTEXT_DIMENSION_STRING_MAX_CHARS) {
          return { ok: false, code: 'dimension_invalid', key: d.key };
        }
        dimensions[d.key] = v;
        break;
      }
      case 'extension_ref': {
        const parsed = d.extension_field
          ? lookups.extensionValue(d.extension_field, value)
          : undefined;
        if (parsed === undefined) return { ok: false, code: 'extension_value_invalid', key: d.key };
        dimensions[d.key] = parsed;
        break;
      }
    }
  }
  return {
    ok: true,
    dimensions,
    naturalKeyHash: contextNaturalKeyHash(
      type.dimensions.map((d) => d.key),
      dimensions,
    ),
    productKeys: [...new Set(productKeys)].sort(),
  };
}

/** `owner_ref` (Q12): an opaque source owner id — never an email, never secret-like. */
export const OWNER_REF_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;

export function ownerRefValid(v: string): boolean {
  return OWNER_REF_PATTERN.test(v) && !findSecretLike(v);
}

export function nameValid(v: string): boolean {
  const t = v.trim();
  return t.length >= 1 && t.length <= ACCOUNT_CONTEXT_NAME_MAX_CHARS && !findSecretLike(t);
}

// ---------------------------------------------------------------------------
// Q14: human values sticky until release
// ---------------------------------------------------------------------------

/** The context attributes a source or an operator writes (change-record field names). */
export const CONTEXT_ATTRIBUTES = ['name', 'status', 'ownerRef', 'renewalDate'] as const;
export type ContextAttribute = (typeof CONTEXT_ATTRIBUTES)[number];

/**
 * The changed-field marker of a `release` change record (M10C
 * `parentCompanyOrigin` pattern): the context has no origin column, so the
 * human hold is derived from its change records.
 */
export const HUMAN_OVERRIDE_RELEASE_FIELD = 'humanOverride';

export interface ChangeOriginRow {
  readonly origin: string | null;
  readonly changedFields: readonly string[];
}

/**
 * The attributes an operator holds (Q14): the union of the attributes of
 * `human` changes newer than the newest release. `changes` is newest first.
 */
export function humanHeldAttributes(changes: readonly ChangeOriginRow[]): Set<ContextAttribute> {
  const held = new Set<ContextAttribute>();
  for (const c of changes) {
    if (c.origin !== 'human') continue;
    if (c.changedFields.includes(HUMAN_OVERRIDE_RELEASE_FIELD)) break;
    for (const f of c.changedFields) {
      if ((CONTEXT_ATTRIBUTES as readonly string[]).includes(f)) held.add(f as ContextAttribute);
    }
  }
  return held;
}

export interface ContextAttributes {
  readonly name: string;
  readonly status: AccountContextStatus;
  readonly ownerRef: string | null;
  /** `YYYY-MM-DD` or null. */
  readonly renewalDate: string | null;
}

export interface AttributeDecision {
  readonly apply: Partial<ContextAttributes>;
  readonly changedFields: readonly ContextAttribute[];
  /** Held attributes whose source value differs (Q14, recorded as an issue). */
  readonly disagreements: readonly ContextAttribute[];
}

/**
 * A source observation against the stored context. `observed[attr]` undefined
 * = not mapped (nothing changes). Held attributes keep the operator value and
 * report a disagreement; `retired` is terminal for the source (only an
 * operator reactivates).
 */
export function decideSourceAttributes(
  current: ContextAttributes,
  observed: Partial<ContextAttributes>,
  held: ReadonlySet<ContextAttribute>,
): AttributeDecision {
  const apply: Record<string, unknown> = {};
  const changedFields: ContextAttribute[] = [];
  const disagreements: ContextAttribute[] = [];
  for (const attr of CONTEXT_ATTRIBUTES) {
    const next = observed[attr];
    if (next === undefined || next === current[attr]) continue;
    if (held.has(attr)) {
      disagreements.push(attr);
      continue;
    }
    if (attr === 'status' && current.status === 'retired') continue;
    apply[attr] = next;
    changedFields.push(attr);
  }
  return { apply: apply, changedFields, disagreements };
}

/** An operator write: every differing given attribute applies (the operator always wins, may reactivate). */
export function decideOperatorAttributes(
  current: ContextAttributes,
  given: Partial<ContextAttributes>,
): AttributeDecision {
  return withStatus(current, given);
}

function withStatus(
  current: ContextAttributes,
  given: Partial<ContextAttributes>,
): AttributeDecision {
  const apply: Record<string, unknown> = {};
  const changedFields: ContextAttribute[] = [];
  for (const attr of CONTEXT_ATTRIBUTES) {
    const next = given[attr];
    if (next === undefined || next === current[attr]) continue;
    apply[attr] = next;
    changedFields.push(attr);
  }
  return { apply: apply, changedFields, disagreements: [] };
}

// ---------------------------------------------------------------------------
// Memberships (Q10: never deleted; the PK holds one row per context/person/role)
// ---------------------------------------------------------------------------

/**
 * Re-adding an ended (context, person, role) **reactivates** the same row
 * (status `active`, new `started_at`, `ended_at` cleared): the primary key
 * allows one row per triple, and the ended period stays in the membership's
 * change records (entity kind `account_context_person`). Decision recorded for
 * plan Q10 / phase-1 handover.
 */
export function decideMemberAdd(
  existing: { readonly status: string } | undefined,
): 'insert' | 'reactivate' | 'unchanged' {
  if (!existing) return 'insert';
  return existing.status === 'active' ? 'unchanged' : 'reactivate';
}

export function decideMemberEnd(
  existing: { readonly status: string } | undefined,
): 'end' | 'unchanged' | 'missing' {
  if (!existing) return 'missing';
  return existing.status === 'active' ? 'end' : 'unchanged';
}

/**
 * The change-record entity id of a membership row (which has no id column): a
 * deterministic UUID (version-5 layout) over the row's primary key.
 */
export function membershipEntityId(contextId: string, personId: string, roleCode: string): string {
  const h = createHash('sha256')
    .update(`account_context_person|${contextId}|${personId}|${roleCode}`)
    .digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export interface MemberRow {
  readonly contextId: string;
  readonly personId: string;
  readonly roleCode: string;
  readonly status: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export interface MemberMovePlan {
  /** Rows to create on the receiving side (copied status and period). */
  readonly insert: readonly MemberRow[];
  /** Receiving-side rows to reactivate (the moved membership was active there only as ended). */
  readonly reactivate: readonly MemberRow[];
  /** Giving-side rows to end (active ones; ended rows stay as history). */
  readonly end: readonly MemberRow[];
}

/**
 * Moves memberships (plan §7): person merge (loser person → survivor person,
 * same context) and company-merge collision (loser context → survivor context,
 * same person). Identity columns are immutable, so a move is "insert on the
 * receiving side + end on the giving side"; a duplicate role is ended on the
 * giving side only, reactivating the receiving row when only the giving one
 * was active.
 */
export function planMemberMove(
  from: readonly MemberRow[],
  to: readonly MemberRow[],
  retarget: (row: MemberRow) => MemberRow,
): MemberMovePlan {
  const key = (r: MemberRow) => `${r.contextId}|${r.personId}|${r.roleCode}`;
  const existing = new Map(to.map((r) => [key(r), r]));
  const insert: MemberRow[] = [];
  const reactivate: MemberRow[] = [];
  const end: MemberRow[] = [];
  for (const row of from) {
    const moved = retarget(row);
    const there = existing.get(key(moved));
    if (!there) {
      insert.push(moved);
      existing.set(key(moved), moved);
    } else if (row.status === 'active' && there.status !== 'active') {
      reactivate.push(there);
      existing.set(key(moved), { ...there, status: 'active' });
    }
    if (row.status === 'active') end.push(row);
  }
  return { insert, reactivate, end };
}

// ---------------------------------------------------------------------------
// Company merge (Q15)
// ---------------------------------------------------------------------------

export interface ContextKeyRow {
  readonly id: string;
  readonly contextTypeId: string;
  readonly naturalKeyHash: string;
  readonly recordState: string;
}

export interface CompanyMergePlan {
  /** Loser contexts re-pointed to the survivor company. */
  readonly repoint: readonly string[];
  /** Natural-key collisions: the loser context is merged into the survivor's. */
  readonly collisions: readonly { readonly loserId: string; readonly survivorId: string }[];
}

export function planCompanyMerge(
  loser: readonly ContextKeyRow[],
  survivor: readonly ContextKeyRow[],
): CompanyMergePlan {
  const k = (r: ContextKeyRow) => `${r.contextTypeId}|${r.naturalKeyHash}`;
  const active = new Map(survivor.filter((r) => r.recordState === 'active').map((r) => [k(r), r]));
  const repoint: string[] = [];
  const collisions: { loserId: string; survivorId: string }[] = [];
  for (const r of [...loser].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (r.recordState !== 'active') continue;
    const hit = active.get(k(r));
    if (hit) collisions.push({ loserId: r.id, survivorId: hit.id });
    else repoint.push(r.id);
  }
  return { repoint, collisions };
}
