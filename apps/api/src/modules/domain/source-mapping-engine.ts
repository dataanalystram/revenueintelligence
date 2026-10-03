import type { ConnectorKind } from './connector-kinds';
import type { ExternalRef, ExternalSystem } from './external-ref';
import { companyFields, personFields, type SourceObservation } from './source-observation';
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
] as const;
export type QualityCode = (typeof QUALITY_CODES)[number];

/** Literal set membership on the mapped object's own field. An empty value is
 * never a member of `values` (so `not_in` admits it, `in` does not). */
export function holdingFilterMatches(filter: HoldingFilter, record: SourceRecord): boolean {
  const raw = record.values[filter.field];
  const value = raw === null || raw === undefined ? undefined : String(raw).trim();
  const member = value !== undefined && value !== '' && filter.values.includes(value);
  return filter.operator === 'in' ? member : !member;
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
      readonly code:
        | 'non_subscription_product'
        | 'missing_product_reference'
        | 'orphan_product_reference'
        | 'missing_account_reference'
        | 'orphan_account_reference'
        | 'missing_identity'
        | 'record_rejected';
      /** The line's account when it resolved: an ownership gap for missing/orphan products. */
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

  if (obj.holdingFilter && !holdingFilterMatches(obj.holdingFilter, record)) {
    return { outcome: 'filtered_out' };
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
      if (result.rejectRecord) return { outcome: 'skipped', code: 'record_rejected' };
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
    return {
      outcome: 'ingest',
      observation: {
        ...base,
        kind: 'company',
        presence: 'present',
        fields: companyFields({ name: values.name, domain: values.domain }),
      },
      quality,
    };
  }
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
      ...(env.profileAuthority && companyRel
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
    },
    quality,
  };
}
