import { describe, expect, it } from 'vitest';
import {
  TEST_CONNECTION_ID,
  testAuthority,
  testMapping,
  testSourceSchema,
} from '../../../test/fixtures/source-mapping';
import type { SourceField, SourceObject, SourceRecord, SourceSchema } from './source-connector';
import {
  mapContractRecord,
  mapEntitlementRecord,
  mapLineCommercialRefs,
  mapPriceOfferRecord,
  usesCommercialMapping,
  validateCommercialMapping,
  type CommercialMappingContext,
} from './source-mapping-commercial';
import { mappedFields, mappingMinCanonicalVersion } from './source-mapping';
import type { MappingDocument, ObjectMapping } from './source-mapping-document';

/**
 * M10F phase 2b (plan §6, V13, V16): the commercial mapping blocks and line
 * targets — publish-blocking rules and record mapping. Synthetic TEST objects
 * only (no customer schema, no live system).
 */

const f = (
  name: string,
  type: SourceField['type'],
  extra: Partial<SourceField> = {},
): SourceField => ({
  name,
  type,
  required: false,
  unique: false,
  ...extra,
});
const o = (name: string, fields: SourceField[]): SourceObject => ({
  name,
  classification: 'record',
  capabilities: {
    pagination: 'offset',
    changeField: 'date_modified',
    deleteVisibility: 'none',
    count: true,
    maxPageSize: 200,
  },
  fields,
});

function schema(): SourceSchema {
  const base = testSourceSchema();
  const lines = base.objects.find((x) => x.name === 'RevenueLineItems')!;
  return {
    ...base,
    objects: [
      ...base.objects.filter((x) => x.name !== 'RevenueLineItems'),
      {
        ...lines,
        fields: [
          ...lines.fields,
          f('agreement_src', 'relate', { relatesTo: 'Agreements' }),
          f('offer_src', 'relate', { relatesTo: 'PriceBooks' }),
          f('deal_src', 'relate', { relatesTo: 'Deals' }),
        ],
      },
      o('Agreements', [
        f('id', 'id', { unique: true }),
        f('name', 'string'),
        f('account_id', 'relate', { relatesTo: 'Accounts' }),
        f('status_src', 'string'),
        f('start_src', 'datetime'),
        f('end_src', 'datetime'),
        f('renewal_src', 'date'),
        f('renews_src', 'relate', { relatesTo: 'Agreements' }),
        f('value_src', 'integer'),
        f('currency_src', 'string'),
        f('date_modified', 'datetime'),
      ]),
      o('PriceBooks', [
        f('id', 'id', { unique: true }),
        f('product_src', 'relate', { relatesTo: 'ProductTemplates' }),
        f('currency_src', 'string'),
        f('period_src', 'integer'),
        f('unit_src', 'string'),
        f('model_src', 'string'),
        f('status_src', 'string'),
        f('date_modified', 'datetime'),
      ]),
      o('Grants', [
        f('id', 'id', { unique: true }),
        f('account_id', 'relate', { relatesTo: 'Accounts' }),
        f('product_src', 'relate', { relatesTo: 'ProductTemplates' }),
        f('qty_src', 'integer'),
        f('status_src', 'string'),
        f('date_modified', 'datetime'),
      ]),
      o('Deals', [f('id', 'id', { unique: true }), f('date_modified', 'datetime')]),
    ],
  };
}

const UTC = { type: 'datetime' as const, format: 'iso_datetime' as const, timeZone: 'UTC' };

const contractObject = (edit?: (x: ObjectMapping) => void): ObjectMapping => {
  const x: ObjectMapping = {
    source: 'Agreements',
    entity: 'contract',
    identity: { field: 'id' },
    relationships: [],
    fields: [],
    contract: {
      account: { field: 'account_id', object: 'Accounts' },
      status: { field: 'status_src', valueMap: { Live: 'active', Ended: 'expired' } },
      startsAt: { field: 'start_src', transforms: { parse: UTC } },
      endsAt: { field: 'end_src', transforms: { parse: UTC } },
      renewalDate: { field: 'renewal_src' },
      totalValueMinor: { field: 'value_src' },
      totalValueCurrency: { field: 'currency_src' },
      renewsRef: { field: 'renews_src' },
    },
  };
  edit?.(x);
  return x;
};
const offerObject = (edit?: (x: ObjectMapping) => void): ObjectMapping => {
  const x: ObjectMapping = {
    source: 'PriceBooks',
    entity: 'price_offer',
    identity: { field: 'id' },
    relationships: [],
    fields: [],
    priceOffer: {
      product: { field: 'product_src' },
      currency: { field: 'currency_src' },
      billingPeriod: { field: 'period_src' },
      billingPeriodUnit: { field: 'unit_src', valueMap: { M: 'month', Y: 'year' } },
      pricingModel: { field: 'model_src', valueMap: { flat_fee: 'flat', per_unit: 'per_unit' } },
      status: { field: 'status_src', valueMap: { active: 'active', archived: 'retired' } },
    },
  };
  edit?.(x);
  return x;
};
const entitlementObject = (): ObjectMapping => ({
  source: 'Grants',
  entity: 'entitlement',
  identity: { field: 'id' },
  relationships: [],
  fields: [],
  entitlement: {
    account: { field: 'account_id', object: 'Accounts' },
    product: { field: 'product_src' },
    quantity: { field: 'qty_src' },
    status: { field: 'status_src', valueMap: { on: 'active', off: 'inactive' } },
  },
});

const AGREEMENT = {
  target: 'subscription.agreement',
  field: 'agreement_src',
  object: 'Agreements',
  confirmation: { semantics: 'agreement_header' as const, confirmedBy: 'test-operator' },
};

/** The default test mapping plus the commercial objects and the line references. */
function doc(
  edit: (d: MappingDocument) => void = () => undefined,
  extras: ObjectMapping[] = [contractObject(), offerObject(), entitlementObject()],
): MappingDocument {
  const d = structuredClone(testMapping());
  const lines = d.objects.find((x) => x.entity === 'subscription')!;
  lines.relationships = [
    ...lines.relationships,
    AGREEMENT,
    { target: 'subscription.priceOfferRef', field: 'offer_src', object: 'PriceBooks' },
    { target: 'subscription.supersedesRef', field: 'renewal_rli_id', object: 'RevenueLineItems' },
  ];
  d.objects.push(...extras);
  edit(d);
  return d;
}

const ALL_FACTS = {
  price_offer: TEST_CONNECTION_ID,
  contract: TEST_CONNECTION_ID,
  entitlement: TEST_CONNECTION_ID,
};
const codes = (
  d: MappingDocument,
  commercial: CommercialMappingContext | null = { gate: 'ok' },
  authority = testAuthority(ALL_FACTS),
) =>
  validateCommercialMapping(d, {
    connectionId: TEST_CONNECTION_ID,
    schema: schema(),
    authority,
    ...(commercial ? { commercial } : {}),
  }).map((i) => i.code);

describe('commercial mapping validation (M10F plan §6.1, §6.2)', () => {
  it('accepts complete price_offer / contract / entitlement objects and the three line references', () => {
    expect(codes(doc())).toEqual([]);
  });

  it('V5: refuses every statement without the 0.6 + module gate; the agreement needs only 0.6', () => {
    const tooLow = codes(doc(), { gate: 'canonical_version_too_low' });
    // three objects + agreement + priceOfferRef + supersedesRef
    expect(tooLow.filter((c) => c === 'commercial_mappings_not_enabled')).toHaveLength(6);
    const disabled = codes(doc(), { gate: 'module_disabled' });
    // the agreement is Core (Q2): only the objects and the two module references
    expect(disabled.filter((c) => c === 'commercial_mappings_not_enabled')).toHaveLength(5);
    const agreementOnly = codes(doc(undefined, []), { gate: 'module_disabled' });
    expect(
      codes(
        doc((d) => {
          const l = d.objects.find((x) => x.entity === 'subscription')!;
          l.relationships = l.relationships.filter(
            (r) =>
              r.target !== 'subscription.priceOfferRef' &&
              r.target !== 'subscription.supersedesRef',
          );
        }, []),
        { gate: 'module_disabled' },
      ),
    ).toEqual([]);
    expect(agreementOnly).toContain('commercial_mappings_not_enabled');
    expect(codes(doc(), null)).toContain('commercial_mappings_not_enabled');
  });

  it('V16: refuses an object whose fact the connection does not hold', () => {
    const c = codes(doc(), { gate: 'ok' }, testAuthority({ price_offer: TEST_CONNECTION_ID }));
    expect(c.filter((x) => x === 'authority_conflict')).toHaveLength(2);
  });

  it('V13: subscription.agreement needs the agreement_header confirmation', () => {
    const unconfirmed = doc((d) => {
      const l = d.objects.find((x) => x.entity === 'subscription')!;
      l.relationships = l.relationships.map((r) =>
        r.target === 'subscription.agreement' ? { ...r, confirmation: undefined } : r,
      );
    });
    expect(codes(unconfirmed)).toContain('unconfirmed_consequential_entry');
    const ordinary = doc((d) => {
      const l = d.objects.find((x) => x.entity === 'subscription')!;
      l.relationships = l.relationships.map((r) =>
        r.target === 'subscription.agreement'
          ? { ...r, confirmation: { by: 'someone', note: 'not the agreement semantics' } }
          : r,
      );
    });
    expect(codes(ordinary)).toContain('unconfirmed_consequential_entry');
    // An agreement confirmation on another target is not a confirmation of it.
    const misplaced = doc((d) => {
      const l = d.objects.find((x) => x.entity === 'subscription')!;
      l.relationships = l.relationships.map((r) =>
        r.target === 'subscription.priceOfferRef'
          ? { ...r, confirmation: AGREEMENT.confirmation }
          : r,
      );
    });
    expect(codes(misplaced)).toContain('invalid_target');
  });

  it('V13: refuses a deal / opportunity / pipeline / quote grouping (Q4 guardrail)', () => {
    const grouping = (rel: Record<string, unknown>) =>
      codes(
        doc((d) => {
          const l = d.objects.find((x) => x.entity === 'subscription')!;
          l.relationships = l.relationships.map((r) =>
            r.target === 'subscription.agreement' ? { ...r, ...rel } : r,
          );
        }),
      );
    // The line's opportunity reference (field name and related object).
    expect(grouping({ field: 'opportunity_id', object: 'Opportunities' })).toContain(
      'agreement_ref_deal_grouping',
    );
    // A related object named like a deal.
    expect(grouping({ field: 'deal_src', object: 'Deals' })).toContain(
      'agreement_ref_deal_grouping',
    );
    // A header object mapped as something other than a contract (an account grouping).
    expect(grouping({ field: 'account_id', object: 'Accounts' })).toContain(
      'agreement_ref_deal_grouping',
    );
    // An unknown header object.
    expect(grouping({ object: 'Nowhere' })).toContain('unknown_source_object');
  });

  it('refuses value maps outside the frozen vocabularies (Q8) and incomplete pairs', () => {
    const bad = doc(undefined, [
      contractObject((x) => {
        x.contract = {
          ...x.contract!,
          status: { field: 'status_src', valueMap: { Live: 'live' } },
          totalValueCurrency: undefined,
        };
      }),
      offerObject((x) => {
        x.priceOffer = {
          ...x.priceOffer!,
          billingPeriodUnit: { field: 'unit_src', valueMap: { M: 'monthly' } },
          pricingModel: { field: 'model_src', valueMap: { tiers: 'stairstep' } },
        };
      }),
      entitlementObject(),
    ]);
    const c = codes(bad);
    expect(c.filter((x) => x === 'invalid_enum_map')).toHaveLength(3);
    expect(c).toContain('invalid_target'); // money pair mapped alone
    const period = codes(
      doc(undefined, [
        contractObject(),
        offerObject((x) => {
          x.priceOffer = { ...x.priceOffer!, billingPeriodUnit: undefined };
        }),
        entitlementObject(),
      ]),
    );
    expect(period).toContain('invalid_target');
  });

  it('refuses unmapped referenced objects, duplicate entities, foreign statements and missing product references', () => {
    const c = codes(
      doc(
        (d) => {
          d.productReferences = undefined;
          const l = d.objects.find((x) => x.entity === 'subscription')!;
          l.relationships = l.relationships.map((r) =>
            r.target === 'subscription.priceOfferRef' ? { ...r, object: 'Agreements' } : r,
          );
        },
        [
          contractObject((x) => {
            x.contract = { ...x.contract!, account: { field: 'account_id', object: 'Leads' } };
            x.fields = [{ kind: 'core', target: 'account.name', source: 'name' }];
          }),
          contractObject(),
          offerObject(),
          entitlementObject(),
        ],
      ),
    );
    expect(c).toContain('missing_relationship_target');
    expect(c).toContain('duplicate_entity');
    expect(c).toContain('invalid_target');
    expect(c).toContain('product_reference_required');
    // An instant without a parse.
    const unparsed = codes(
      doc(undefined, [
        contractObject((x) => {
          x.contract = { ...x.contract!, startsAt: { field: 'start_src' } };
        }),
        offerObject(),
        entitlementObject(),
      ]),
    );
    expect(unparsed).toContain('unsupported_source_type');
  });

  it('uses canonical 0.6 and reads the block fields', () => {
    expect(usesCommercialMapping(doc())).toBe(true);
    expect(mappingMinCanonicalVersion(doc())).toBe('0.6');
    expect(usesCommercialMapping(testMapping())).toBe(false);
    expect(mappingMinCanonicalVersion(testMapping())).toBeUndefined();
    expect(mappedFields(contractObject())).toEqual(
      [
        'account_id',
        'currency_src',
        'end_src',
        'id',
        'renewal_src',
        'renews_src',
        'start_src',
        'status_src',
        'value_src',
      ].sort(),
    );
  });
});

const rec = (values: SourceRecord['values'], extra: Partial<SourceRecord> = {}): SourceRecord => ({
  object: 'X',
  id: String(values.id ?? 'X'),
  values,
  ...extra,
});
const keyOf = (id: string) => (id === 'P-1' ? 'prod_one' : undefined);

describe('commercial record mapping (sync)', () => {
  it('maps a price offer: product key via the model, codes via the closed maps, pair rules', () => {
    const m = mapPriceOfferRecord(
      offerObject(),
      rec({
        id: 'PB-1',
        product_src: 'P-1',
        currency_src: 'eur',
        period_src: 1,
        unit_src: 'M',
        model_src: 'flat_fee',
        status_src: 'active',
      }),
      'sugar',
      keyOf,
    );
    expect(m).toMatchObject({
      outcome: 'mapped',
      ref: { system: 'sugar', objectType: 'PriceBooks', id: 'PB-1' },
      presence: 'present',
      productKey: 'prod_one',
      currency: 'EUR',
      billingPeriod: 1,
      billingPeriodUnit: 'month',
      pricingModel: 'flat',
      status: 'active',
      quality: [],
    });
    const odd = mapPriceOfferRecord(
      offerObject(),
      rec({
        id: 'PB-2',
        product_src: 'P-1',
        currency_src: 'EURO',
        period_src: 3,
        unit_src: 'Q',
        model_src: 'x',
      }),
      'sugar',
      keyOf,
    );
    expect(odd).toMatchObject({
      outcome: 'mapped',
      quality: expect.arrayContaining([
        'price_offer_currency_invalid',
        'price_offer_period_unit_unmapped',
        'price_offer_pricing_model_unmapped',
      ]),
    });
    expect('billingPeriod' in odd).toBe(false);
    expect(
      mapPriceOfferRecord(offerObject(), rec({ id: 'PB-3', product_src: 'P-9' }), 'sugar', keyOf),
    ).toEqual({ outcome: 'skipped', code: 'price_offer_product_unmodelled' });
    expect(
      mapPriceOfferRecord(offerObject(), rec({ id: 'PB-4' }, { deleted: true }), 'sugar', keyOf),
    ).toMatchObject({ outcome: 'mapped', presence: 'absent' });
  });

  it('maps a contract: unmapped status reads unknown, dates as ISO, links as same-connection refs, money pair', () => {
    const m = mapContractRecord(
      contractObject(),
      rec({
        id: 'AG-1',
        account_id: 'ACC-1',
        status_src: 'Paused',
        start_src: '2026-01-01T00:00:00Z',
        end_src: '2027-01-01T00:00:00Z',
        renewal_src: '2026-12-01',
        value_src: 120000,
        currency_src: 'usd',
        renews_src: 'AG-0',
      }),
      'sugar',
    );
    expect(m).toMatchObject({
      outcome: 'mapped',
      accountRef: { system: 'sugar', objectType: 'Accounts', id: 'ACC-1' },
      status: 'unknown',
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2027-01-01T00:00:00.000Z',
      renewalDate: '2026-12-01',
      totalValueMinor: 120000,
      totalValueCurrency: 'USD',
      links: { renews: { system: 'sugar', objectType: 'Agreements', id: 'AG-0' } },
      quality: ['contract_status_unmapped'],
    });
    const half = mapContractRecord(
      contractObject(),
      rec({ id: 'AG-2', account_id: 'ACC-1', value_src: 5, currency_src: null }),
      'sugar',
    );
    expect(half).toMatchObject({ quality: ['contract_total_value_incomplete'] });
    expect('totalValueMinor' in half).toBe(false);
    expect(mapContractRecord(contractObject(), rec({ id: 'AG-3' }), 'sugar')).toEqual({
      outcome: 'skipped',
      code: 'contract_account_missing',
    });
  });

  it('maps an entitlement (E3 fields only) and the line references (absence never clears)', () => {
    expect(
      mapEntitlementRecord(
        entitlementObject(),
        rec({ id: 'G-1', account_id: 'ACC-1', product_src: 'P-1', qty_src: 5, status_src: 'gone' }),
        'sugar',
        keyOf,
      ),
    ).toMatchObject({
      outcome: 'mapped',
      productKey: 'prod_one',
      quantity: 5,
      status: 'unknown',
      quality: ['entitlement_status_unmapped'],
    });
    const lines = doc().objects.find((x) => x.entity === 'subscription')!;
    expect(
      mapLineCommercialRefs(
        lines,
        rec({ id: 'L-1', agreement_src: 'AG-1', offer_src: 'PB-1', renewal_rli_id: 'L-0' }),
        'sugar',
      ),
    ).toEqual({
      agreementMapped: true,
      agreementRef: { system: 'sugar', objectType: 'Agreements', externalId: 'AG-1' },
      priceOfferRef: { system: 'sugar', objectType: 'PriceBooks', id: 'PB-1' },
      supersedesRef: { system: 'sugar', objectType: 'RevenueLineItems', id: 'L-0' },
    });
    expect(mapLineCommercialRefs(lines, rec({ id: 'L-2', agreement_src: ' ' }), 'sugar')).toEqual({
      agreementMapped: true,
    });
  });
});
