import {
  BILLING_PERIOD_UNITS,
  COMMERCIAL_MIN_VERSION,
  CONTRACT_STATUSES,
  CURRENCY_PATTERN,
  ENTITLEMENT_STATUSES,
  PRICE_OFFER_STATUSES,
  PRICING_MODELS,
  type ContractLinkKind,
} from './canonical/commercial';
import { isAuthoritative, type AuthorityDocument, type AuthorityFact } from './source-authority';
import {
  findSourceField,
  findSourceObject,
  type SourceRecord,
  type SourceSchema,
} from './source-connector';
import { contextRenewalDate, type SourceTripleRef } from './source-mapping-account-context';
import type { MappingDocument, ObjectMapping, RelationshipEntry } from './source-mapping-document';
import { applyTransforms, type RawValue, type Transforms } from './source-transforms';

/**
 * M10F (plan §6, ADR 0032): source mapping of the commercial entities and the
 * line commercial references. Objects mapped as entity `price_offer`,
 * `contract` or `entitlement` carry a `priceOffer` / `contract` /
 * `entitlement` block (routed like M10E `accountContext`: MappingEntitySchema
 * is unchanged). A subscription line may state `subscription.agreement`
 * (Core at canonical ≥ 0.6, module-independent, Q2; mandatory agreement-header
 * confirmation and the deal-grouping refusal, Q4), `subscription.priceOfferRef`
 * and `subscription.supersedesRef` (module `commercial`). The entity blocks
 * need canonical ≥ 0.6, module `commercial` and the connection holding the
 * entity's authority fact (Q24); the line references follow
 * `subscription_lines`. Pure: no I/O.
 */

export const COMMERCIAL_MAPPING_ENTITIES = ['price_offer', 'contract', 'entitlement'] as const;
export type CommercialMappingEntity = (typeof COMMERCIAL_MAPPING_ENTITIES)[number];
export const AGREEMENT_TARGET = 'subscription.agreement' as const;
export const PRICE_OFFER_REF_TARGET = 'subscription.priceOfferRef' as const;
export const SUPERSEDES_REF_TARGET = 'subscription.supersedesRef' as const;
export const COMMERCIAL_LINE_TARGETS = [
  AGREEMENT_TARGET,
  PRICE_OFFER_REF_TARGET,
  SUPERSEDES_REF_TARGET,
] as const;
export const COMMERCIAL_MAPPING_MIN_VERSION = COMMERCIAL_MIN_VERSION;

/**
 * Q4: the closed guardrail token list. A field, its related object or the
 * header object named like a deal / opportunity grouping is refused
 * (`agreement_ref_deal_grouping`). Not proof: the confirmation is the control.
 */
export const AGREEMENT_DEAL_TOKENS = ['opportunit', 'deal', 'pipeline', 'quote'] as const;

export function isCommercialEntity(entity: string | undefined): entity is CommercialMappingEntity {
  return (COMMERCIAL_MAPPING_ENTITIES as readonly string[]).includes(entity ?? '');
}

export function isCommercialLineTarget(target: string): boolean {
  return (COMMERCIAL_LINE_TARGETS as readonly string[]).includes(target);
}

/** True when the document uses any M10F mapping statement (its `canonical_version_min` is 0.6). */
export function usesCommercialMapping(doc: {
  readonly objects: readonly {
    readonly entity?: string;
    readonly priceOffer?: unknown;
    readonly contract?: unknown;
    readonly entitlement?: unknown;
    readonly relationships: readonly { readonly target: string }[];
  }[];
}): boolean {
  return doc.objects.some(
    (o) =>
      isCommercialEntity(o.entity) ||
      o.priceOffer !== undefined ||
      o.contract !== undefined ||
      o.entitlement !== undefined ||
      o.relationships.some((r) => isCommercialLineTarget(r.target)),
  );
}

/** The authority fact each commercial entity block writes (plan §6.4). */
export const COMMERCIAL_ENTITY_FACT: Readonly<Record<CommercialMappingEntity, AuthorityFact>> = {
  price_offer: 'price_offer',
  contract: 'contract',
  entitlement: 'entitlement',
};

export interface CommercialMappingContext {
  /** The 0.6 + module gate at publish (`subscription.agreement` needs 0.6 only). */
  readonly gate: 'ok' | 'canonical_version_too_low' | 'module_disabled';
}

export type CommercialMappingCode =
  | 'commercial_mappings_not_enabled'
  | 'agreement_ref_deal_grouping'
  | 'invalid_target'
  | 'invalid_enum_map'
  | 'duplicate_entity'
  | 'unknown_source_object'
  | 'unknown_source_field'
  | 'unsupported_source_type'
  | 'identity_missing'
  | 'identity_unsuitable'
  | 'missing_relationship_target'
  | 'product_reference_required'
  | 'unconfirmed_consequential_entry'
  | 'authority_conflict';

export interface CommercialMappingIssue {
  readonly code: CommercialMappingCode;
  readonly path: string;
  readonly message: string;
}

const NAME_LIKE = /(^|_)(name|title|label|description)(_c)?$/i;
const BLOCK_OF: Readonly<
  Record<CommercialMappingEntity, 'priceOffer' | 'contract' | 'entitlement'>
> = { price_offer: 'priceOffer', contract: 'contract', entitlement: 'entitlement' };

function isAgreementConfirmation(c: RelationshipEntry['confirmation']): boolean {
  return c !== undefined && 'semantics' in c && c.semantics === 'agreement_header';
}

function dealLike(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return AGREEMENT_DEAL_TOKENS.some((t) => lower.includes(t));
}

/**
 * Publish-blocking rules of the M10F statements (plan §6.1, §6.2). The generic
 * relationship rules (field exists, reference type, `relatesTo`) run in
 * `validateMapping`; this adds the gate, the authority, the referenced objects
 * and every rule of the commercial objects.
 */
export function validateCommercialMapping(
  doc: MappingDocument,
  input: {
    readonly connectionId: string;
    readonly schema: SourceSchema;
    readonly authority: AuthorityDocument;
    readonly commercial?: CommercialMappingContext;
  },
): CommercialMappingIssue[] {
  const issues: CommercialMappingIssue[] = [];
  const err = (code: CommercialMappingCode, path: string, message: string) =>
    issues.push({ code, path, message });
  const gate = input.commercial?.gate ?? 'canonical_version_too_low';
  const gateMessage = `commercial mappings need canonical ${COMMERCIAL_MAPPING_MIN_VERSION} and module commercial (${gate})`;
  const seen = new Set<string>();
  const mappedAs = (source: string | undefined) =>
    source === undefined ? undefined : doc.objects.find((o) => o.source === source)?.entity;
  const field = (object: string, name: string, path: string): boolean => {
    if (findSourceField(input.schema, object, name)) return true;
    err('unknown_source_field', path, `${object}.${name} is not in the snapshot`);
    return false;
  };
  const codeMap = (
    stmt:
      { readonly field: string; readonly valueMap: Readonly<Record<string, string>> } | undefined,
    object: string,
    path: string,
    codes: readonly string[],
  ) => {
    if (!stmt) return;
    field(object, stmt.field, `${path}.field`);
    for (const [from, to] of Object.entries(stmt.valueMap)) {
      if (!codes.includes(to)) {
        err(
          'invalid_enum_map',
          `${path}.valueMap.${from}`,
          `${to} is not one of ${codes.join(', ')}`,
        );
      }
    }
  };
  const dateStatement = (
    stmt: { readonly field: string; readonly transforms?: Transforms } | undefined,
    object: string,
    path: string,
    parseRequired: boolean,
  ) => {
    if (!stmt) return;
    field(object, stmt.field, `${path}.field`);
    const parse = stmt.transforms?.parse?.type;
    if (stmt.transforms?.valueMap) {
      err('unsupported_source_type', `${path}.transforms.valueMap`, 'dates are not value-mapped');
    }
    if (parse !== undefined && parse !== 'date' && parse !== 'datetime' && parse !== 'timestamp') {
      err('unsupported_source_type', `${path}.transforms.parse`, 'dates need a date parse');
    }
    if (parseRequired && parse === undefined) {
      err(
        'unsupported_source_type',
        `${path}.transforms.parse`,
        'instants need a date or datetime parse with a declared time zone, or a Unix-seconds timestamp',
      );
    }
  };
  const reference = (
    ref: { readonly field: string; readonly object: string } | undefined,
    object: string,
    path: string,
    entity: string,
  ) => {
    if (!ref) return;
    if (field(object, ref.field, `${path}.field`) && mappedAs(ref.object) !== entity) {
      err(
        'missing_relationship_target',
        `${path}.object`,
        `${ref.object} is not mapped as ${entity}`,
      );
    }
  };

  doc.objects.forEach((obj, i) => {
    const at = `objects.${i}`;
    // Line references (subscription objects).
    obj.relationships.forEach((rel, j) => {
      const path = `${at}.relationships.${j}`;
      if (isAgreementConfirmation(rel.confirmation) && rel.target !== AGREEMENT_TARGET) {
        err('invalid_target', `${path}.confirmation`, 'only subscription.agreement carries it');
      }
      if (!isCommercialLineTarget(rel.target) || obj.entity !== 'subscription') return;
      if (rel.target === AGREEMENT_TARGET) {
        if (gate === 'canonical_version_too_low') {
          err('commercial_mappings_not_enabled', `${path}.target`, gateMessage);
        }
        if (!isAgreementConfirmation(rel.confirmation)) {
          err(
            'unconfirmed_consequential_entry',
            `${path}.confirmation`,
            'subscription.agreement needs a recorded agreement_header confirmation',
          );
        }
        if (!rel.object) {
          err('missing_relationship_target', `${path}.object`, 'the header object is required');
          return;
        }
        if (!findSourceObject(input.schema, rel.object)) {
          err('unknown_source_object', `${path}.object`, `${rel.object} is not in the snapshot`);
        }
        const sourceField = findSourceField(input.schema, obj.source, rel.field);
        const headerEntity = mappedAs(rel.object);
        if (
          dealLike(rel.field) ||
          dealLike(rel.object) ||
          dealLike(sourceField?.relatesTo) ||
          (headerEntity !== undefined && headerEntity !== 'contract')
        ) {
          err(
            'agreement_ref_deal_grouping',
            path,
            'an agreement reference names the agreement header, never a deal, opportunity, pipeline or quote grouping',
          );
        }
        return;
      }
      if (gate !== 'ok') err('commercial_mappings_not_enabled', `${path}.target`, gateMessage);
      const wanted = rel.target === PRICE_OFFER_REF_TARGET ? 'price_offer' : 'subscription';
      if (!rel.object) {
        err('missing_relationship_target', `${path}.object`, 'the referenced object is required');
      } else if (mappedAs(rel.object) !== wanted) {
        err(
          'missing_relationship_target',
          `${path}.object`,
          `${rel.object} is not mapped as ${wanted}`,
        );
      }
    });

    for (const key of ['priceOffer', 'contract', 'entitlement'] as const) {
      if (obj[key] && (!isCommercialEntity(obj.entity) || BLOCK_OF[obj.entity] !== key)) {
        err('invalid_target', `${at}.${key}`, `only ${key} objects carry it`);
      }
    }
    if (!isCommercialEntity(obj.entity)) return;
    const entity = obj.entity;
    if (gate !== 'ok') err('commercial_mappings_not_enabled', `${at}.entity`, gateMessage);
    if (seen.has(entity)) {
      err('duplicate_entity', `${at}.entity`, `${entity} is mapped by more than one object`);
    }
    seen.add(entity);
    const fact = COMMERCIAL_ENTITY_FACT[entity];
    if (!isAuthoritative(input.authority, fact, input.connectionId)) {
      err(
        'authority_conflict',
        `${at}.entity`,
        `${entity} writes the ${fact} fact, for which this connection is not the authority`,
      );
    }
    if (!findSourceObject(input.schema, obj.source)) return; // reported by validateMapping
    const idField = findSourceField(input.schema, obj.source, obj.identity.field);
    if (!idField) {
      err(
        'identity_missing',
        `${at}.identity.field`,
        `${obj.source}.${obj.identity.field} is not in the snapshot`,
      );
    } else if (NAME_LIKE.test(idField.name)) {
      err('identity_unsuitable', `${at}.identity.field`, 'a name-like field is not an identity');
    } else if (idField.type !== 'id' && !idField.unique && !obj.identity.confirmation) {
      err(
        'identity_unsuitable',
        `${at}.identity.field`,
        'the identity field is neither an id nor unique, and is not confirmed',
      );
    }
    obj.fields.forEach((entry, j) => {
      if (entry.kind !== 'ignored') {
        err(
          'invalid_target',
          `${at}.fields.${j}`,
          `${entity} objects carry ${BLOCK_OF[entity]} statements only`,
        );
      }
    });
    obj.relationships.forEach((_rel, j) => {
      err(
        'invalid_target',
        `${at}.relationships.${j}.target`,
        `${entity} objects have no relationships`,
      );
    });
    if (obj.holdingFilter || obj.allRecordsAreHoldings || obj.customObject || obj.accountContext) {
      err(
        'invalid_target',
        at,
        `holding, custom-object and context statements do not apply to ${entity}`,
      );
    }
    const src = obj.source;
    if (entity === 'price_offer') {
      const b = obj.priceOffer;
      if (!b)
        return err(
          'invalid_target',
          `${at}.priceOffer`,
          'a price_offer object needs its priceOffer statements',
        );
      field(src, b.product.field, `${at}.priceOffer.product.field`);
      if (!doc.productReferences) {
        err(
          'product_reference_required',
          `${at}.priceOffer.product`,
          'productReferences must declare the catalogue',
        );
      }
      field(src, b.currency.field, `${at}.priceOffer.currency.field`);
      if (b.billingPeriod)
        field(src, b.billingPeriod.field, `${at}.priceOffer.billingPeriod.field`);
      if ((b.billingPeriod === undefined) !== (b.billingPeriodUnit === undefined)) {
        err(
          'invalid_target',
          `${at}.priceOffer`,
          'the billing period and its unit are mapped together',
        );
      }
      if (b.listAmountMinor)
        field(src, b.listAmountMinor.field, `${at}.priceOffer.listAmountMinor.field`);
      codeMap(b.billingPeriodUnit, src, `${at}.priceOffer.billingPeriodUnit`, BILLING_PERIOD_UNITS);
      codeMap(b.pricingModel, src, `${at}.priceOffer.pricingModel`, PRICING_MODELS);
      codeMap(b.status, src, `${at}.priceOffer.status`, PRICE_OFFER_STATUSES);
      return;
    }
    if (entity === 'contract') {
      const b = obj.contract;
      if (!b)
        return err(
          'invalid_target',
          `${at}.contract`,
          'a contract object needs its contract statements',
        );
      reference(b.account, src, `${at}.contract.account`, 'account');
      reference(b.context, src, `${at}.contract.context`, 'account_context');
      dateStatement(b.startsAt, src, `${at}.contract.startsAt`, true);
      dateStatement(b.endsAt, src, `${at}.contract.endsAt`, true);
      dateStatement(b.renewalDate, src, `${at}.contract.renewalDate`, false);
      if (b.autoRenew) field(src, b.autoRenew.field, `${at}.contract.autoRenew.field`);
      codeMap(b.status, src, `${at}.contract.status`, CONTRACT_STATUSES);
      if (b.totalValueMinor)
        field(src, b.totalValueMinor.field, `${at}.contract.totalValueMinor.field`);
      if (b.totalValueCurrency) {
        field(src, b.totalValueCurrency.field, `${at}.contract.totalValueCurrency.field`);
      }
      if ((b.totalValueMinor === undefined) !== (b.totalValueCurrency === undefined)) {
        err(
          'invalid_target',
          `${at}.contract`,
          'the total value and its currency are mapped together',
        );
      }
      for (const key of ['renewsRef', 'amendsRef', 'parentRef'] as const) {
        const link = b[key];
        if (link)
          reference(
            { field: link.field, object: link.object ?? src },
            src,
            `${at}.contract.${key}`,
            'contract',
          );
      }
      return;
    }
    const b = obj.entitlement;
    if (!b)
      return err(
        'invalid_target',
        `${at}.entitlement`,
        'an entitlement object needs its entitlement statements',
      );
    reference(b.account, src, `${at}.entitlement.account`, 'account');
    field(src, b.product.field, `${at}.entitlement.product.field`);
    if (!doc.productReferences) {
      err(
        'product_reference_required',
        `${at}.entitlement.product`,
        'productReferences must declare the catalogue',
      );
    }
    if (b.quantity) field(src, b.quantity.field, `${at}.entitlement.quantity.field`);
    codeMap(b.status, src, `${at}.entitlement.status`, ENTITLEMENT_STATUSES);
    dateStatement(b.startsAt, src, `${at}.entitlement.startsAt`, true);
    dateStatement(b.endsAt, src, `${at}.entitlement.endsAt`, true);
  });
  return issues;
}

/** The source fields the commercial blocks read (for `mappedFields`). */
export function commercialFields(
  obj: Pick<ObjectMapping, 'priceOffer' | 'contract' | 'entitlement'>,
): string[] {
  const out: string[] = [];
  const add = (s: { readonly field: string } | undefined) => {
    if (s) out.push(s.field);
  };
  const p = obj.priceOffer;
  if (p)
    [
      p.product,
      p.currency,
      p.billingPeriod,
      p.billingPeriodUnit,
      p.pricingModel,
      p.listAmountMinor,
      p.status,
    ].forEach(add);
  const c = obj.contract;
  if (c) {
    [
      c.account,
      c.context,
      c.startsAt,
      c.endsAt,
      c.renewalDate,
      c.autoRenew,
      c.status,
      c.totalValueMinor,
      c.totalValueCurrency,
      c.renewsRef,
      c.amendsRef,
      c.parentRef,
    ].forEach(add);
  }
  const e = obj.entitlement;
  if (e) [e.account, e.product, e.quantity, e.status, e.startsAt, e.endsAt].forEach(add);
  return out;
}

// ---------------------------------------------------------------------------
// Record mapping (sync)
// ---------------------------------------------------------------------------

const REF_RE = /^[A-Za-z0-9_.:-]{1,255}$/;
/** A stated value that could not be read (dropped and counted, never stored). */
const INVALID: unique symbol = Symbol('invalid');
type Invalid = typeof INVALID;

function text(value: RawValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

/** Common shape of a mapped commercial record. */
interface MappedBase {
  readonly outcome: 'mapped';
  readonly ref: SourceTripleRef;
  readonly presence: 'present' | 'absent';
  /** Value-free quality codes. */
  readonly quality: readonly string[];
  readonly sourceUpdatedAt?: Date;
}
type Skipped = { readonly outcome: 'skipped'; readonly code: string };

function identityOf(obj: ObjectMapping, record: SourceRecord, entity: string): string | Skipped {
  const id = text(record.values[obj.identity.field]) ?? text(record.id);
  if (!id || !REF_RE.test(id)) return { outcome: 'skipped', code: `${entity}_identity_invalid` };
  return id;
}

/** A closed value map: undefined = empty / not mapped; `null` = a value missing from the map. */
function mapCode(
  stmt: { readonly field: string; readonly valueMap: Readonly<Record<string, string>> } | undefined,
  record: SourceRecord,
): string | null | undefined {
  if (!stmt) return undefined;
  const raw = text(record.values[stmt.field]);
  if (raw === undefined) return undefined;
  return Object.hasOwn(stmt.valueMap, raw) ? stmt.valueMap[raw]! : null;
}

/** A non-negative safe integer; `null` = mapped and empty; `invalid` otherwise. */
function integer(
  stmt: { readonly field: string } | undefined,
  record: SourceRecord,
): number | null | Invalid | undefined {
  if (!stmt) return undefined;
  const raw = record.values[stmt.field];
  const s = text(raw);
  if (s === undefined) return null;
  if (typeof raw === 'number' ? !Number.isSafeInteger(raw) : !/^\d{1,15}$/.test(s)) return INVALID;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : INVALID;
}

/** An instant as ISO text: `null` = mapped and empty; `invalid` = not parseable. */
function instant(
  stmt: { readonly field: string; readonly transforms?: Transforms } | undefined,
  record: SourceRecord,
): string | null | Invalid | undefined {
  if (!stmt) return undefined;
  const result = applyTransforms(record.values[stmt.field], stmt.transforms);
  if (!result.ok || 'unknown' in result) return INVALID;
  if (result.value === undefined) return null;
  return result.value instanceof Date ? result.value.toISOString() : INVALID;
}

/** A date as `YYYY-MM-DD` (date-only text, or the UTC date of a parsed instant). */
function dateOnly(
  stmt: { readonly field: string; readonly transforms?: Transforms } | undefined,
  record: SourceRecord,
): string | null | Invalid | undefined {
  if (!stmt) return undefined;
  const raw = record.values[stmt.field];
  if (text(raw) === undefined) return null;
  if (stmt.transforms?.parse) {
    const result = applyTransforms(raw, stmt.transforms);
    if (!result.ok || 'unknown' in result || !(result.value instanceof Date)) return INVALID;
    return result.value.toISOString().slice(0, 10);
  }
  return contextRenewalDate(raw) ?? INVALID;
}

export type MappedPriceOffer =
  | Skipped
  | (MappedBase & {
      readonly productKey?: string;
      readonly currency?: string;
      readonly billingPeriod?: number | null;
      readonly billingPeriodUnit?: string | null;
      readonly pricingModel?: string | null;
      readonly listAmountMinor?: number | null;
      readonly status?: string;
    });

/**
 * One record of a `price_offer` object → the writer's observation inputs. The
 * product is the source product id resolved through the product model's
 * external references (`productKeyOf`); unmodelled → skipped. An unmapped
 * code is dropped and counted; an incomplete period pair is dropped whole.
 */
export function mapPriceOfferRecord(
  obj: ObjectMapping,
  record: SourceRecord,
  system: string,
  productKeyOf: (sourceProductId: string) => string | undefined,
): MappedPriceOffer {
  const b = obj.priceOffer;
  if (!b) return { outcome: 'skipped', code: 'price_offer_mapping_invalid' };
  const id = identityOf(obj, record, 'price_offer');
  if (typeof id !== 'string') return id;
  const base = {
    outcome: 'mapped' as const,
    ref: { system, objectType: obj.source, id },
    ...(record.modifiedAt ? { sourceUpdatedAt: record.modifiedAt } : {}),
  };
  if (record.deleted) return { ...base, presence: 'absent', quality: [] };
  const productId = text(record.values[b.product.field]);
  if (!productId) return { outcome: 'skipped', code: 'price_offer_product_missing' };
  const productKey = productKeyOf(productId);
  if (!productKey) return { outcome: 'skipped', code: 'price_offer_product_unmodelled' };
  const quality: string[] = [];
  const currencyRaw = text(record.values[b.currency.field])?.toUpperCase();
  let currency: string | undefined;
  if (currencyRaw !== undefined) {
    if (CURRENCY_PATTERN.test(currencyRaw)) currency = currencyRaw;
    else quality.push('price_offer_currency_invalid');
  }
  // The period pair is both or neither (CHECK; mapped together, validated at publish).
  let period: number | null | undefined;
  let unit: string | null | undefined;
  if (b.billingPeriod && b.billingPeriodUnit) {
    const p = integer(b.billingPeriod, record);
    const u = mapCode(b.billingPeriodUnit, record);
    if (p === INVALID || p === 0) quality.push('price_offer_period_invalid');
    if (u === null) quality.push('price_offer_period_unit_unmapped');
    if (p !== INVALID && p !== 0 && u !== null) {
      if (p === null && u === undefined) {
        period = null;
        unit = null;
      } else if (p !== null && p !== undefined && u !== undefined) {
        period = p;
        unit = u;
      } else {
        quality.push('price_offer_period_incomplete');
      }
    }
  }
  const model = mapCode(b.pricingModel, record);
  if (model === null) quality.push('price_offer_pricing_model_unmapped');
  let amount = integer(b.listAmountMinor, record);
  if (amount === INVALID) {
    quality.push('price_offer_amount_invalid');
    amount = undefined;
  }
  const status = mapCode(b.status, record);
  if (status === null) quality.push('price_offer_status_unmapped');
  return {
    ...base,
    presence: 'present',
    productKey,
    ...(currency !== undefined ? { currency } : {}),
    ...(period !== undefined ? { billingPeriod: period } : {}),
    ...(unit !== undefined ? { billingPeriodUnit: unit } : {}),
    ...(model ? { pricingModel: model } : {}),
    ...(amount !== undefined ? { listAmountMinor: amount } : {}),
    ...(status ? { status } : {}),
    quality,
  };
}

export type MappedContract =
  | Skipped
  | (MappedBase & {
      readonly accountRef: SourceTripleRef;
      readonly contextRef?: SourceTripleRef;
      readonly startsAt?: string | null;
      readonly endsAt?: string | null;
      readonly renewalDate?: string | null;
      readonly autoRenew?: boolean | null;
      readonly status?: string;
      readonly totalValueMinor?: number | null;
      readonly totalValueCurrency?: string | null;
      /** Stated links only (an empty link field never clears, plan §6.1). */
      readonly links: Partial<Record<ContractLinkKind, SourceTripleRef>>;
    });

/**
 * One record of a `contract` object → the writer's observation inputs
 * (references unresolved; the sync resolves them). An unmapped status reads
 * `unknown` (plan §6.1); an invalid value is dropped and counted; an
 * incomplete money pair is dropped whole.
 */
export function mapContractRecord(
  obj: ObjectMapping,
  record: SourceRecord,
  system: string,
): MappedContract {
  const b = obj.contract;
  if (!b) return { outcome: 'skipped', code: 'contract_mapping_invalid' };
  const id = identityOf(obj, record, 'contract');
  if (typeof id !== 'string') return id;
  const accountId = text(record.values[b.account.field]);
  if (!accountId) return { outcome: 'skipped', code: 'contract_account_missing' };
  if (!REF_RE.test(accountId)) return { outcome: 'skipped', code: 'contract_account_invalid' };
  const base = {
    outcome: 'mapped' as const,
    ref: { system, objectType: obj.source, id },
    accountRef: { system, objectType: b.account.object, id: accountId },
    ...(record.modifiedAt ? { sourceUpdatedAt: record.modifiedAt } : {}),
  };
  if (record.deleted) return { ...base, presence: 'absent', links: {}, quality: [] };
  const quality: string[] = [];
  const keep = <T>(v: T | Invalid | undefined, code: string): T | undefined => {
    if (v === INVALID) {
      quality.push(code);
      return undefined;
    }
    return v;
  };
  const startsAt = keep(instant(b.startsAt, record), 'contract_date_invalid');
  const endsAt = keep(instant(b.endsAt, record), 'contract_date_invalid');
  const renewalDate = keep(dateOnly(b.renewalDate, record), 'contract_date_invalid');
  let autoRenew: boolean | null | undefined;
  if (b.autoRenew) {
    const raw = record.values[b.autoRenew.field];
    const s = text(raw);
    if (s === undefined) autoRenew = null;
    else if (b.autoRenew.valueMap) {
      autoRenew = Object.hasOwn(b.autoRenew.valueMap, s) ? b.autoRenew.valueMap[s] : undefined;
      if (autoRenew === undefined) quality.push('contract_auto_renew_unmapped');
    } else if (typeof raw === 'boolean') autoRenew = raw;
    else if (/^(true|false)$/i.test(s)) autoRenew = s.toLowerCase() === 'true';
    else quality.push('contract_auto_renew_invalid');
  }
  let status = mapCode(b.status, record);
  if (status === null) {
    quality.push('contract_status_unmapped');
    status = 'unknown';
  }
  let total = keep(integer(b.totalValueMinor, record), 'contract_total_value_invalid');
  let currency: string | null | undefined;
  if (b.totalValueCurrency) {
    const c = text(record.values[b.totalValueCurrency.field])?.toUpperCase();
    if (c === undefined) currency = null;
    else if (CURRENCY_PATTERN.test(c)) currency = c;
    else quality.push('contract_currency_invalid');
  }
  // The money pair is both or neither (CHECK; mapped together, validated at publish).
  if (b.totalValueMinor && b.totalValueCurrency) {
    const consistent =
      total !== undefined && currency !== undefined && (total === null) === (currency === null);
    if (!consistent) {
      quality.push('contract_total_value_incomplete');
      total = undefined;
      currency = undefined;
    }
  }
  const links: Partial<Record<ContractLinkKind, SourceTripleRef>> = {};
  for (const [kind, stmt] of [
    ['renews', b.renewsRef],
    ['amends', b.amendsRef],
    ['parent', b.parentRef],
  ] as const) {
    if (!stmt) continue;
    const target = text(record.values[stmt.field]);
    if (!target) continue;
    if (!REF_RE.test(target)) {
      quality.push('contract_link_ref_invalid');
      continue;
    }
    links[kind] = { system, objectType: stmt.object ?? obj.source, id: target };
  }
  let contextRef: SourceTripleRef | undefined;
  if (b.context) {
    const ctx = text(record.values[b.context.field]);
    if (ctx && REF_RE.test(ctx)) contextRef = { system, objectType: b.context.object, id: ctx };
    else if (ctx) quality.push('contract_context_ref_invalid');
  }
  return {
    ...base,
    presence: 'present',
    ...(contextRef ? { contextRef } : {}),
    ...(startsAt !== undefined ? { startsAt } : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
    ...(renewalDate !== undefined ? { renewalDate } : {}),
    ...(autoRenew !== undefined ? { autoRenew } : {}),
    ...(status ? { status } : {}),
    ...(total !== undefined ? { totalValueMinor: total } : {}),
    ...(currency !== undefined ? { totalValueCurrency: currency } : {}),
    links,
    quality,
  };
}

export type MappedEntitlement =
  | Skipped
  | (MappedBase & {
      readonly accountRef: SourceTripleRef;
      readonly productKey?: string;
      readonly quantity?: number | null;
      readonly status?: string;
      readonly startsAt?: string | null;
      readonly endsAt?: string | null;
    });

/** One record of an `entitlement` object (E3 fields only; informational, plan §3.3). */
export function mapEntitlementRecord(
  obj: ObjectMapping,
  record: SourceRecord,
  system: string,
  productKeyOf: (sourceProductId: string) => string | undefined,
): MappedEntitlement {
  const b = obj.entitlement;
  if (!b) return { outcome: 'skipped', code: 'entitlement_mapping_invalid' };
  const id = identityOf(obj, record, 'entitlement');
  if (typeof id !== 'string') return id;
  const accountId = text(record.values[b.account.field]);
  if (!accountId) return { outcome: 'skipped', code: 'entitlement_account_missing' };
  if (!REF_RE.test(accountId)) return { outcome: 'skipped', code: 'entitlement_account_invalid' };
  const base = {
    outcome: 'mapped' as const,
    ref: { system, objectType: obj.source, id },
    accountRef: { system, objectType: b.account.object, id: accountId },
    ...(record.modifiedAt ? { sourceUpdatedAt: record.modifiedAt } : {}),
  };
  if (record.deleted) return { ...base, presence: 'absent', quality: [] };
  const productId = text(record.values[b.product.field]);
  if (!productId) return { outcome: 'skipped', code: 'entitlement_product_missing' };
  const productKey = productKeyOf(productId);
  if (!productKey) return { outcome: 'skipped', code: 'entitlement_product_unmodelled' };
  const quality: string[] = [];
  let quantity = integer(b.quantity, record);
  if (quantity === INVALID) {
    quality.push('entitlement_quantity_invalid');
    quantity = undefined;
  }
  let status = mapCode(b.status, record);
  if (status === null) {
    quality.push('entitlement_status_unmapped');
    status = 'unknown';
  }
  const startsAt = instant(b.startsAt, record);
  const endsAt = instant(b.endsAt, record);
  if (startsAt === INVALID || endsAt === INVALID) quality.push('entitlement_date_invalid');
  return {
    ...base,
    presence: 'present',
    productKey,
    ...(quantity !== undefined ? { quantity } : {}),
    ...(status ? { status } : {}),
    ...(startsAt !== undefined && startsAt !== INVALID ? { startsAt } : {}),
    ...(endsAt !== undefined && endsAt !== INVALID ? { endsAt } : {}),
    quality,
  };
}

/** A line's commercial references (plan §6.2); each undefined when not mapped, empty or malformed. */
export interface MappedLineCommercial {
  /** True when the line object maps `subscription.agreement` (the line `field_hash` covers it, V4). */
  readonly agreementMapped: boolean;
  readonly agreementRef?: {
    readonly system: string;
    readonly objectType: string;
    readonly externalId: string;
  };
  readonly priceOfferRef?: SourceTripleRef;
  readonly supersedesRef?: SourceTripleRef;
}

/**
 * The references a line record states. An empty or malformed reference is
 * not stated: the line keeps what it has (absence never clears, M10E pattern).
 * `agreement_ref` = (connector kind, header object type, external id), an
 * attribute only — never an identity (E3 §4.1).
 */
export function mapLineCommercialRefs(
  obj: ObjectMapping,
  record: SourceRecord,
  system: string,
): MappedLineCommercial {
  const ref = (target: string): SourceTripleRef | undefined => {
    const rel = obj.relationships.find((r) => r.target === target);
    if (!rel?.object) return undefined;
    const id = text(record.values[rel.field]);
    if (!id || !REF_RE.test(id)) return undefined;
    return { system, objectType: rel.object, id };
  };
  const agreement = ref(AGREEMENT_TARGET);
  const priceOfferRef = ref(PRICE_OFFER_REF_TARGET);
  const supersedesRef = ref(SUPERSEDES_REF_TARGET);
  return {
    agreementMapped: obj.relationships.some((r) => r.target === AGREEMENT_TARGET),
    ...(agreement
      ? { agreementRef: { system, objectType: agreement.objectType, externalId: agreement.id } }
      : {}),
    ...(priceOfferRef ? { priceOfferRef } : {}),
    ...(supersedesRef ? { supersedesRef } : {}),
  };
}

/** True when the line object states any commercial reference. */
export function hasLineCommercialRefs(obj: Pick<ObjectMapping, 'relationships'>): boolean {
  return obj.relationships.some((r) => isCommercialLineTarget(r.target));
}
