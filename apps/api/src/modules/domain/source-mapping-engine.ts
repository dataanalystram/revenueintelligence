import type { ConnectorKind } from './connector-kinds';
import { classifyHoldingValue, type HoldingValueClass } from './holding-domain';
import type { ExternalRef, ExternalSystem } from './external-ref';
import { mapRoleValues } from './canonical/account-structure';
import {
  companyFields,
  personFields,
  type SourceAffiliation,
  type SourceObservation,
  type SourceParent,
} from './source-observation';
import type { SourceRecord } from './source-connector';
import type { HoldingFilter, ObjectMapping, ProductReferences } from './source-mapping';
import { applyTransforms, type RawValue } from './source-transforms';
import {
  SubscriptionStateSchema,
  type SubscriptionObservation,
  type SubscriptionState,
} from './subscription';

/**
 * The mapping engine (ADR 0020): one source record + one published object
 * mapping → one canonical observation or a classified skip. Pure and total:
 * no I/O, no clock, no guessing. The adapter never derives state; a line's
 * state comes only from a confirmed mapping of the line's own field, else
 * `unknown`.
 */

/** Data-quality codes counted per run (identifiers and counts only, never values). */
export const QUALITY_CODES = [
  'filtered_out',
  'non_subscription_product',
  'missing_product_reference',
  'orphan_product_reference',
  'unmodelled_product_reference',
  'missing_account_reference',
  'orphan_account_reference',
  'unresolved_account_reference',
  'missing_identity',
  'duplicate_external_id',
  'invalid_period',
  'invalid_date',
  'invalid_number',
  'unmapped_source_enum_value',
  'relationship_conflict',
  'ownership_gap',
  'unstable_read',
  'schema_drift',
  'record_rejected',
  // M10C: affiliation role values outside the mapping's explicit value map (dropped, never stored).
  'unmapped_role_value',
  // M10C review m2: a relationship value that cannot be a reference (over 255 characters); it states nothing.
  'invalid_reference',
] as const;
export type QualityCode = (typeof QUALITY_CODES)[number];

/** Every `skipped` outcome code of {@link mapSubscriptionRecord} (protection decisions cover each). */
export const SKIP_CODES = [
  'non_subscription_product',
  'missing_product_reference',
  'orphan_product_reference',
  'missing_account_reference',
  'orphan_account_reference',
  'missing_identity',
  'record_rejected',
  'unreviewed_holding_value',
] as const;
export type SkipCode = (typeof SKIP_CODES)[number];

/**
 * The holding decision for one record (ADR 0023, M9A §10.3): the value is
 * looked up in the filter's reviewed domain. A value outside it is
 * `unreviewed` under `in` and `not_in` alike, and an empty value uses the
 * explicit empty entry: M8's "an empty value is never a member", which made
 * `not_in` admit empty values as holdings, no longer applies. A filter
 * without a reviewed domain (published before M9A) classifies nothing: every
 * value is `unreviewed` (runs refuse such versions before reading anyway).
 */
export function holdingClassOf(filter: HoldingFilter, record: SourceRecord): HoldingValueClass {
  if (!filter.reviewedDomain) return 'unreviewed';
  return classifyHoldingValue(filter.reviewedDomain, record.values[filter.field]);
}

/** What the run knows about a source product id. */
export type SourceProductStatus = 'modelled' | 'ignored' | 'orphan' | 'unmodelled';
/** What the run knows about a source account id. */
export type SourceAccountStatus = 'known' | 'orphan';

/** The hop's outcome: no hop value or empty target, a hop record the source does not have, or an account id. */
export type FallbackAccount =
  | { readonly kind: 'none' }
  | { readonly kind: 'orphan' }
  | { readonly kind: 'account'; readonly id: string };

export interface SubscriptionMappingEnv {
  readonly kind: ExternalSystem;
  readonly productReferences: ProductReferences;
  /** Whether this connection is (still) the authority for each fact. */
  readonly authority: { readonly state: boolean; readonly terms: boolean };
  readonly observedAt: Date;
  readonly accountStatus: (accountId: string) => SourceAccountStatus;
  /** The one-hop account for a fallback value (e.g. the line's opportunity). */
  readonly fallbackAccount: (fallbackValue: string) => FallbackAccount;
  readonly productStatus: (productId: string) => SourceProductStatus;
}

export type SubscriptionMappingResult =
  | { readonly outcome: 'filtered_out' }
  | {
      readonly outcome: 'skipped';
      readonly code: SkipCode;
      /** The line's account when it could be read: the ownership gap's attribution (§9.4). */
      readonly gapAccountId?: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code: 'unmodelled_product_reference';
      readonly productId: string;
    }
  | {
      readonly outcome: 'ingest';
      readonly observation: SubscriptionObservation;
      readonly accountId?: string;
      readonly quality: readonly QualityCode[];
    };

/** The record's account id when one can be read (primary reference, else the hop), for gap attribution only. */
function bestEffortAccount(
  obj: ObjectMapping,
  record: SourceRecord,
  env: SubscriptionMappingEnv,
): string | undefined {
  const rel = obj.relationships.find((r) => r.target === 'subscription.account');
  if (!rel) return undefined;
  const primary = text(record.values[rel.field]);
  if (primary) return primary;
  if (!rel.fallbackVia) return undefined;
  const via = text(record.values[rel.fallbackVia.field]);
  const hop = via ? env.fallbackAccount(via) : undefined;
  return hop?.kind === 'account' ? hop.id : undefined;
}

function text(value: RawValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

/** Maps one subscription-object record. */
export function mapSubscriptionRecord(
  obj: ObjectMapping,
  record: SourceRecord,
  env: SubscriptionMappingEnv,
): SubscriptionMappingResult {
  const id = text(record.values[obj.identity.field]) ?? text(record.id);
  if (!id || !/^[A-Za-z0-9_.:-]{1,255}$/.test(id)) {
    return { outcome: 'skipped', code: 'missing_identity' };
  }
  const source = { system: env.kind as ConnectorKind, objectType: obj.source, recordId: id };

  // A visible source deletion is an absence whatever the filter says (a line
  // that was never ingested is simply not found by the writer).
  if (record.deleted) {
    return {
      outcome: 'ingest',
      observation: {
        presence: 'absent',
        source,
        ...(record.modifiedAt ? { sourceUpdatedAt: record.modifiedAt } : {}),
        observedAt: env.observedAt,
      },
      quality: [],
    };
  }

  if (obj.holdingFilter) {
    const holding = holdingClassOf(obj.holdingFilter, record);
    // A reviewed non-holding value is a confident exclusion (tombstonable).
    if (holding === 'non_holding') return { outcome: 'filtered_out' };
    // An unreviewed value is never classified: the record is protected and its
    // account (best effort, for the ownership gap) is reported.
    if (holding === 'unreviewed') {
      const gapAccountId = bestEffortAccount(obj, record, env);
      return {
        outcome: 'skipped',
        code: 'unreviewed_holding_value',
        ...(gapAccountId ? { gapAccountId } : {}),
      };
    }
  }

  const quality: QualityCode[] = [];

  // Account: the primary reference, else one confirmed hop.
  const accountRel = obj.relationships.find((r) => r.target === 'subscription.account')!;
  const primary = text(record.values[accountRel.field]);
  let accountId: string | undefined;
  let accountObject = accountRel.object!;
  if (primary) {
    if (env.accountStatus(primary) === 'orphan') {
      return { outcome: 'skipped', code: 'orphan_account_reference' };
    }
    accountId = primary;
    if (accountRel.fallbackVia) {
      const via = text(record.values[accountRel.fallbackVia.field]);
      const hop: FallbackAccount = via ? env.fallbackAccount(via) : { kind: 'none' };
      if (hop.kind === 'account' && hop.id !== primary) {
        quality.push('relationship_conflict');
      }
    }
  } else if (accountRel.fallbackVia) {
    const via = text(record.values[accountRel.fallbackVia.field]);
    const hop: FallbackAccount = via ? env.fallbackAccount(via) : { kind: 'none' };
    if (hop.kind === 'none') return { outcome: 'skipped', code: 'missing_account_reference' };
    if (hop.kind === 'orphan' || env.accountStatus(hop.id) === 'orphan') {
      return { outcome: 'skipped', code: 'orphan_account_reference' };
    }
    accountId = hop.id;
    accountObject = accountRel.object!;
  } else {
    return { outcome: 'skipped', code: 'missing_account_reference' };
  }

  // Product: by source id through the product model's external references only.
  const productRel = obj.relationships.find((r) => r.target === 'subscription.product')!;
  const productId = text(record.values[productRel.field]);
  if (!productId) {
    return { outcome: 'skipped', code: 'missing_product_reference', gapAccountId: accountId };
  }
  switch (env.productStatus(productId)) {
    case 'ignored':
      return { outcome: 'skipped', code: 'non_subscription_product' };
    case 'orphan':
      return { outcome: 'skipped', code: 'orphan_product_reference', gapAccountId: accountId };
    case 'unmodelled':
      return { outcome: 'rejected', code: 'unmodelled_product_reference', productId };
    case 'modelled':
      break;
  }

  // State: only a confirmed mapping of the line's own field; otherwise unknown.
  let state: SubscriptionState = 'unknown';
  let startsAt: Date | undefined;
  let endsAt: Date | undefined;
  let quantity: number | undefined;
  let invalidTerms = false;

  for (const entry of obj.fields) {
    if (entry.kind !== 'core' || !('source' in entry)) continue;
    const result = applyTransforms(record.values[entry.source], entry.transforms);
    if (!result.ok) {
      quality.push(result.code === 'invalid_boolean' ? 'invalid_number' : result.code);
      if (result.rejectRecord) {
        return { outcome: 'skipped', code: 'record_rejected', gapAccountId: accountId };
      }
      if (entry.target === 'subscription.startsAt' || entry.target === 'subscription.endsAt') {
        invalidTerms = true;
      }
      continue;
    }
    if ('unknown' in result) {
      quality.push(result.code);
      continue;
    }
    const value = result.value;
    switch (entry.target) {
      case 'subscription.state': {
        const parsed = SubscriptionStateSchema.safeParse(value);
        if (env.authority.state && parsed.success) state = parsed.data;
        break;
      }
      case 'subscription.startsAt':
        if (env.authority.terms && value instanceof Date) startsAt = value;
        break;
      case 'subscription.endsAt':
        if (env.authority.terms && value instanceof Date) endsAt = value;
        break;
      case 'subscription.quantity':
        if (
          typeof value === 'number' &&
          Number.isInteger(value) &&
          value >= 1 &&
          value <= 10_000_000
        ) {
          quantity = value;
        } else if (value !== undefined) {
          quality.push('invalid_number');
        }
        break;
    }
  }

  // An invalid or contradictory term keeps the holding: both terms empty, state unknown.
  if (invalidTerms || (startsAt && endsAt && endsAt < startsAt)) {
    startsAt = undefined;
    endsAt = undefined;
    state = 'unknown';
    quality.push('invalid_period');
  }

  return {
    outcome: 'ingest',
    accountId,
    observation: {
      presence: 'present',
      source,
      companyRef: `${env.kind}:${accountObject}:${accountId}`,
      productRef: `${env.kind}:${env.productReferences.object}:${productId}`,
      state,
      ...(startsAt ? { startsAt } : {}),
      ...(endsAt ? { endsAt } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(record.modifiedAt ? { sourceUpdatedAt: record.modifiedAt } : {}),
      observedAt: env.observedAt,
    },
    quality,
  };
}

export interface ContextMappingEnv {
  readonly kind: ExternalSystem;
  /** Profile authority for the entity (account_profile / person_profile). */
  readonly profileAuthority: boolean;
  /** M10C: `account_hierarchy` authority (accounts only); without it the parent is not read. */
  readonly hierarchyAuthority?: boolean;
  readonly observedAt: Date;
}

export type ContextMappingResult =
  | { readonly outcome: 'skipped'; readonly code: 'missing_identity' }
  | {
      readonly outcome: 'ingest';
      readonly observation: SourceObservation;
      readonly quality: readonly QualityCode[];
    };

/** Maps an account or person record into an M6 observation (reference always;
 * profile fields only with profile authority). */
export function mapContextRecord(
  obj: ObjectMapping,
  record: SourceRecord,
  env: ContextMappingEnv,
): ContextMappingResult {
  const id = text(record.values[obj.identity.field]) ?? text(record.id);
  if (!id || id.length > 255) return { outcome: 'skipped', code: 'missing_identity' };
  const ref: ExternalRef = { system: env.kind, objectType: obj.source, id };
  const kind = obj.entity === 'person' ? 'person' : 'company';
  if (record.deleted) {
    return {
      outcome: 'ingest',
      observation: { kind, presence: 'absent', ref, observedAt: env.observedAt },
      quality: [],
    };
  }
  const quality: QualityCode[] = [];
  const values: Record<string, string> = {};
  if (env.profileAuthority) {
    for (const entry of obj.fields) {
      if (entry.kind !== 'core' || !('source' in entry)) continue;
      const result = applyTransforms(record.values[entry.source], entry.transforms);
      if (!result.ok) {
        quality.push(result.code === 'invalid_boolean' ? 'invalid_number' : result.code);
        continue;
      }
      if ('unknown' in result || result.value === undefined) continue;
      values[entry.target.split('.')[1]!] = String(result.value);
    }
  }
  const base = {
    ref,
    observedAt: env.observedAt,
    ...(record.modifiedAt ? { sourceUpdatedAt: record.modifiedAt } : {}),
  };
  if (kind === 'company') {
    const parent = env.hierarchyAuthority ? mappedParent(obj, record, env.kind) : undefined;
    return {
      outcome: 'ingest',
      observation: {
        ...base,
        kind: 'company',
        presence: 'present',
        fields: companyFields({ name: values.name, domain: values.domain }),
        ...(parent ? { parent } : {}),
      },
      quality,
    };
  }
  const affiliationRel = obj.relationships.find((r) => r.target === 'person.affiliation');
  const affiliations =
    env.profileAuthority && affiliationRel
      ? mappedAffiliations(affiliationRel, record, env.kind, quality)
      : undefined;
  const companyRel = obj.relationships.find((r) => r.target === 'person.primaryCompany');
  const companyId = companyRel ? text(record.values[companyRel.field]) : undefined;
  return {
    outcome: 'ingest',
    observation: {
      ...base,
      kind: 'person',
      presence: 'present',
      fields: personFields({
        email: values.email,
        firstName: values.firstName,
        lastName: values.lastName,
        jobTitle: values.jobTitle,
      }),
      // The company link is a person_profile fact; without authority it is not read.
      // A field missing from the record (not read) states nothing (M10C review M2):
      // only an explicitly empty value states "no company" and ends affiliations.
      ...(env.profileAuthority && companyRel && Object.hasOwn(record.values, companyRel.field)
        ? {
            companyLinks: companyId
              ? [
                  {
                    company: { system: env.kind, objectType: companyRel.object!, id: companyId },
                    typeId: 0,
                    category: 'standard' as const,
                    primary: true,
                  },
                ]
              : [],
          }
        : {}),
      ...(affiliations ? { affiliations } : {}),
    },
    quality,
  };
}

/**
 * M10C (plan §2.4): the `account.parent` value of an account record. A field
 * missing from the record (not read) states nothing; an explicitly empty value
 * clears the parent; otherwise the parent's source reference.
 */
function mappedParent(
  obj: ObjectMapping,
  record: SourceRecord,
  system: ExternalSystem,
): SourceParent | undefined {
  const rel = obj.relationships.find((r) => r.target === 'account.parent');
  if (!rel || !Object.hasOwn(record.values, rel.field)) return undefined;
  const id = text(record.values[rel.field]);
  if (!id) return { kind: 'clear' };
  if (id.length > 255) return undefined;
  return { kind: 'set', ref: { system, objectType: rel.object!, id } };
}

const AFFILIATION_DATE_RULES = [
  { parse: { type: 'datetime', format: 'iso_datetime', timeZone: 'UTC' } },
  { parse: { type: 'date', format: 'iso_date', timeZone: 'UTC', inclusiveEnd: false } },
] as const;

function affiliationDate(raw: RawValue, quality: QualityCode[]): Date | undefined {
  if (text(raw) === undefined) return undefined;
  for (const rule of AFFILIATION_DATE_RULES) {
    const r = applyTransforms(raw, rule);
    if (r.ok && 'value' in r && r.value instanceof Date) return r.value;
  }
  quality.push('invalid_date');
  return undefined;
}

/**
 * M10C (plan §3.2): the `person.affiliation` of a person record — one account
 * reference with optional role codes (explicit value map only, Q11; multi-value
 * fields split on `;`) and a stated period. An empty account value states the
 * person has no such affiliation (`[]`); nothing is inferred from email.
 */
function mappedAffiliations(
  rel: ObjectMapping['relationships'][number],
  record: SourceRecord,
  system: ExternalSystem,
  quality: QualityCode[],
): readonly SourceAffiliation[] | undefined {
  if (!Object.hasOwn(record.values, rel.field)) return undefined;
  const id = text(record.values[rel.field]);
  if (!id) return [];
  // A malformed (over-long) value states nothing, as for `account.parent`: never "no affiliation" (m2).
  if (id.length > 255) {
    quality.push('invalid_reference');
    return undefined;
  }
  const a = rel.affiliation;
  let roleCodes: string[] = [];
  if (a?.roleField && a.roleValueMap) {
    const raw = text(record.values[a.roleField]);
    const values = raw
      ? raw
          .split(';')
          .map((v) => v.trim())
          .filter((v) => v !== '')
      : [];
    const mapped = mapRoleValues(values, a.roleValueMap);
    roleCodes = mapped.codes;
    for (let i = 0; i < mapped.dropped; i += 1) quality.push('unmapped_role_value');
  }
  let startsAt = a?.startsAtField
    ? affiliationDate(record.values[a.startsAtField], quality)
    : undefined;
  let endsAt = a?.endsAtField ? affiliationDate(record.values[a.endsAtField], quality) : undefined;
  if (startsAt && endsAt && endsAt < startsAt) {
    quality.push('invalid_period');
    startsAt = undefined;
    endsAt = undefined;
  }
  return [
    {
      company: { system, objectType: rel.object!, id },
      roleCodes,
      ...(startsAt ? { startsAt } : {}),
      ...(endsAt ? { endsAt } : {}),
    },
  ];
}

// ---------------------------------------------------------------------------
// M10D (plan §5): extension attributes, captures, custom objects, custom relationships
// ---------------------------------------------------------------------------

/** One stated extension value: the field key and the raw value after the closed transforms. */
export interface MappedExtensionValue {
  readonly field: string;
  /** `null` = explicitly empty at the source; never `undefined` (no statement is not listed). */
  readonly raw: string | number | boolean | Date | null;
}

/** One stated custom-relationship end on the `from` record. */
export interface MappedCustomRelationship {
  readonly key: string;
  /** The `to` record's source reference; null = explicitly none (authoritative removal). */
  readonly to: ExternalRef | null;
  /** The definition's role code when the role value map matched. */
  readonly role?: string;
}

export interface MappedExtensions {
  readonly values: readonly MappedExtensionValue[];
  readonly relationships: readonly MappedCustomRelationship[];
}

/**
 * The extension statements of one record (plan §5.1, §5.3, §5.4). A field
 * missing from the record (not read) states nothing; an empty value, or a
 * value the null transform empties, is an explicit empty; a value the
 * transforms cannot read is counted and states nothing (absence never clears).
 */
export function mapExtensionStatements(
  obj: ObjectMapping,
  record: SourceRecord,
  system: ExternalSystem,
  quality: QualityCode[],
  capturedKey: (object: string, field: string) => string,
): MappedExtensions {
  const values: MappedExtensionValue[] = [];
  for (const entry of obj.fields) {
    if (entry.kind !== 'attribute' && entry.kind !== 'capture') continue;
    if (!Object.hasOwn(record.values, entry.source)) {
      if (process.env.VM19_MODE === 'missing')
        values.push({
          field: entry.kind === 'attribute' ? entry.field : capturedKey(obj.source, entry.source),
          raw: null,
        });
      continue;
    }
    const field = entry.kind === 'attribute' ? entry.field : capturedKey(obj.source, entry.source);
    const result = applyTransforms(
      record.values[entry.source],
      entry.kind === 'attribute' ? entry.transforms : undefined,
    );
    if (!result.ok) {
      quality.push(result.code === 'invalid_boolean' ? 'invalid_number' : result.code);
      continue;
    }
    if ('unknown' in result) continue;
    values.push({ field, raw: result.value === undefined ? null : result.value });
  }
  const relationships: MappedCustomRelationship[] = [];
  for (const rel of obj.relationships) {
    if (!rel.target.startsWith('custom_relationship:') || !rel.object) continue;
    if (!Object.hasOwn(record.values, rel.field)) continue;
    const id = text(record.values[rel.field]);
    if (id !== undefined && id.length > 255) {
      quality.push('invalid_reference');
      continue;
    }
    let role: string | undefined;
    if (rel.role) {
      const raw = text(record.values[rel.role.field]);
      role = raw !== undefined ? rel.role.valueMap[raw] : undefined;
    }
    relationships.push({
      key: rel.target.slice('custom_relationship:'.length),
      to: id ? { system, objectType: rel.object, id } : null,
      ...(role ? { role } : {}),
    });
  }
  return { values, relationships };
}

export type CustomObjectMappingResult =
  | { readonly outcome: 'skipped'; readonly code: 'missing_identity' }
  | {
      readonly outcome: 'ingest';
      readonly objectKey: string;
      readonly ref: ExternalRef;
      readonly presence: 'present' | 'absent';
      /** undefined = not mapped / not read; null = explicitly none. */
      readonly parent?: ExternalRef | null;
      readonly state?: 'active' | 'inactive' | 'retired';
      readonly extensions: MappedExtensions;
      readonly sourceUpdatedAt?: Date;
      readonly quality: readonly QualityCode[];
    };

/** Maps one record of a `custom_object:<key>` object mapping (plan §5.2). */
export function mapCustomObjectRecord(
  obj: ObjectMapping,
  record: SourceRecord,
  system: ExternalSystem,
  capturedKey: (object: string, field: string) => string,
): CustomObjectMappingResult {
  const id = text(record.values[obj.identity.field]) ?? text(record.id);
  if (!id || id.length > 255) return { outcome: 'skipped', code: 'missing_identity' };
  const objectKey = obj.entity.slice('custom_object:'.length);
  const ref: ExternalRef = { system, objectType: obj.source, id };
  const quality: QualityCode[] = [];
  if (record.deleted) {
    return {
      outcome: 'ingest',
      objectKey,
      ref,
      presence: 'absent',
      extensions: { values: [], relationships: [] },
      quality,
    };
  }
  let parent: ExternalRef | null | undefined;
  const p = obj.customObject?.parent;
  if (p && Object.hasOwn(record.values, p.field)) {
    const pid = text(record.values[p.field]);
    if (pid !== undefined && pid.length > 255) quality.push('invalid_reference');
    else parent = pid ? { system, objectType: p.object, id: pid } : null;
  }
  let state: 'active' | 'inactive' | 'retired' | undefined;
  const s = obj.customObject?.recordState;
  if (s) {
    const raw = text(record.values[s.field]);
    state = raw !== undefined ? s.valueMap[raw] : undefined;
  }
  return {
    outcome: 'ingest',
    objectKey,
    ref,
    presence: 'present',
    ...(parent !== undefined ? { parent } : {}),
    ...(state ? { state } : {}),
    extensions: mapExtensionStatements(obj, record, system, quality, capturedKey),
    ...(record.modifiedAt ? { sourceUpdatedAt: record.modifiedAt } : {}),
    quality,
  };
}
