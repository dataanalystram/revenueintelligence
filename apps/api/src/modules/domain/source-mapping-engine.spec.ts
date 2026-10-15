import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_SALES_STAGES,
  testMapping,
  testReviewedDomain,
} from '../../../test/fixtures/source-mapping';
import { discoveryFixture, toSourceRecord } from '../../../test/fixtures/sugar-records';
import type { SourceRecord } from './source-connector';
import type { HoldingFilter, MappingDocument, ObjectMapping } from './source-mapping';
import {
  holdingClassOf,
  mapContextRecord,
  mapSubscriptionRecord,
  type FallbackAccount,
  type SourceProductStatus,
  type SubscriptionMappingEnv,
  type SubscriptionMappingResult,
} from './source-mapping-engine';

const SEED = Number(process.env.FC_SEED ?? 20261002);
const RUNS = Number(process.env.FC_RUNS ?? 300);
fc.configureGlobal({ seed: SEED, numRuns: RUNS });

const OBSERVED = new Date('2026-10-03T09:00:00Z');
const lines = (doc: MappingDocument = testMapping()) =>
  doc.objects.find((o) => o.entity === 'subscription')!;

/** Fixture-backed environment: what the run read from the source and the product model. */
function env(overrides: Partial<SubscriptionMappingEnv> = {}): SubscriptionMappingEnv {
  const opportunities: Record<string, string | null> = {
    'FIX-OPP-011': 'FIX-ACC-DOES-NOT-EXIST',
    'FIX-OPP-019': 'FIX-ACC-016',
    'FIX-OPP-020': null,
  };
  return {
    kind: 'sugar',
    productReferences: testMapping().productReferences!,
    authority: { state: false, terms: true },
    observedAt: OBSERVED,
    accountStatus: (id) => (/^FIX-ACC-\d{3}$/.test(id) ? 'known' : 'orphan'),
    fallbackAccount: (opp): FallbackAccount => {
      if (!(opp in opportunities)) return { kind: 'orphan' };
      const account = opportunities[opp];
      return account ? { kind: 'account', id: account } : { kind: 'none' };
    },
    productStatus: (id): SourceProductStatus =>
      id === 'FIX-PROD-DOES-NOT-EXIST'
        ? 'orphan'
        : id === 'FIX-PROD-900'
          ? 'unmodelled'
          : 'modelled',
    ...overrides,
  };
}

const one = (no: string, index = 0) => discoveryFixture(no)[index]!;
const map = (record: SourceRecord, e = env(), obj: ObjectMapping = lines()) =>
  mapSubscriptionRecord(obj, record, e);

const rli = (values: Record<string, string>) =>
  toSourceRecord('RevenueLineItems', {
    id: 'FIX-RLI-999',
    account_id: 'FIX-ACC-001',
    opportunity_id: 'FIX-OPP-001',
    product_template_id: 'FIX-PROD-001',
    quantity: '1',
    sales_stage: 'Closed Won',
    status: '',
    service_start_date: '2026-01-01',
    service_end_date: '2026-12-31',
    date_modified: '2026-01-01',
    deleted: 'False',
    ...values,
  });

describe('mapping engine on the sanitized discovery fixtures (test mapping only)', () => {
  it('01 normal case: one line, inclusive end converted, state unknown (never active)', () => {
    expect(map(one('01'))).toEqual({
      outcome: 'ingest',
      accountId: 'FIX-ACC-001',
      quality: [],
      observation: {
        presence: 'present',
        source: { system: 'sugar', objectType: 'RevenueLineItems', recordId: 'FIX-RLI-001' },
        companyRef: 'sugar:Accounts:FIX-ACC-001',
        productRef: 'sugar:ProductTemplates:FIX-PROD-001',
        state: 'unknown',
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2027-01-01T00:00:00Z'),
        quantity: 1,
        sourceUpdatedAt: new Date('2025-12-20T00:00:00Z'),
        observedAt: OBSERVED,
      },
    });
  });

  it('02/03/04/05/08/16: every RLI is its own line; no collapse, renewals ignored', () => {
    for (const [no, count] of [
      ['02', 3],
      ['03', 2],
      ['04', 2],
      ['05', 2],
      ['08', 1],
      ['16', 1],
    ] as const) {
      const results = discoveryFixture(no).map((r) => map(r));
      expect(results.every((r) => r.outcome === 'ingest')).toBe(true);
      const ids = results.map((r) => r.outcome === 'ingest' && r.observation.source.recordId);
      expect(new Set(ids).size).toBe(count);
      for (const r of results) {
        expect(
          r.outcome === 'ingest' && r.observation.presence === 'present' && r.observation.state,
        ).toBe('unknown');
      }
    }
    // 02 line C: Non Recurring with no dates → ingested with empty terms (product modelled).
    const lineC = map(one('02', 2));
    expect(lineC).toMatchObject({ outcome: 'ingest', quality: [] });
    expect(lineC.outcome === 'ingest' && 'startsAt' in lineC.observation).toBe(false);
    // 03: quantities kept per line.
    expect(
      discoveryFixture('03').map(
        (r) => (map(r) as { observation: { quantity: number } }).observation.quantity,
      ),
    ).toEqual([5, 3]);
  });

  it('06 Pending Cancellation is filtered out by the (test) Closed Won holding filter', () => {
    expect(map(one('06'))).toEqual({ outcome: 'filtered_out' });
  });

  it('07 blank sales_stage — INTENDED SAFETY CORRECTION (M9A): never admitted silently under not_in', () => {
    // M8 expectation was: `not_in` admits the blank stage as a holding (state unknown).
    // M9A: the empty value has an explicit, reviewed classification.
    expect(map(one('07'))).toEqual({ outcome: 'filtered_out' });
    const notIn = (
      entries: (
        d: ReturnType<typeof testReviewedDomain>,
      ) => ReturnType<typeof testReviewedDomain>['entries'],
    ) => {
      const domain = testReviewedDomain(
        'a'.repeat(64),
        FIXTURE_SALES_STAGES.filter((v) => v !== 'Closed Lost'),
      );
      return {
        ...lines(),
        holdingFilter: {
          ...lines().holdingFilter!,
          operator: 'not_in' as const,
          values: ['Closed Lost'],
          reviewedDomain: { ...domain, entries: entries(domain) },
        },
      };
    };
    // Empty reviewed as non-holding: filtered out (confident).
    expect(
      map(
        one('07'),
        env(),
        notIn((d) => d.entries),
      ),
    ).toEqual({ outcome: 'filtered_out' });
    // Empty not classified: unreviewed, protected, never a holding.
    expect(
      map(
        one('07'),
        env(),
        notIn((d) => d.entries.filter((e) => e.value !== null)),
      ),
    ).toMatchObject({
      outcome: 'skipped',
      code: 'unreviewed_holding_value',
    });
    // Only an explicit operator classification of the empty value as a holding admits it.
    expect(
      map(
        one('07'),
        env(),
        notIn((d) =>
          d.entries.map((e) =>
            e.value === null ? { ...e, classification: 'holding' as const } : e,
          ),
        ),
      ),
    ).toMatchObject({ outcome: 'ingest', observation: { state: 'unknown' } });
  });

  it('07 variant: a mapped status with an unrecognised value stays unknown and is counted', () => {
    const variant: ObjectMapping = {
      ...lines(),
      holdingFilter: undefined,
      allRecordsAreHoldings: { confirmation: { by: 'test', note: 'TEST ONLY' } },
      fields: lines().fields.map((f) =>
        'target' in f && f.target === 'subscription.state'
          ? {
              kind: 'core' as const,
              target: 'subscription.state',
              source: 'status',
              transforms: {
                valueMap: {
                  map: { Active: 'active', Expired: 'expired' },
                  unmapped: 'unknown' as const,
                },
              },
              confirmation: { by: 'test', note: 'TEST ONLY' },
            }
          : f,
      ),
    };
    const result = map(one('07'), env({ authority: { state: true, terms: true } }), variant);
    expect(result).toMatchObject({
      outcome: 'ingest',
      observation: { state: 'unknown' },
      quality: ['unmapped_source_enum_value'],
    });
    // A mapped value with authority does set the state …
    expect(
      map(rli({ status: 'Active' }), env({ authority: { state: true, terms: true } }), variant),
    ).toMatchObject({
      observation: { state: 'active' },
    });
    // … and without state authority it is dropped to unknown (pipeline enforcement).
    expect(map(rli({ status: 'Active' }), env(), variant)).toMatchObject({
      observation: { state: 'unknown' },
    });
  });

  it('09 an RLI relying on an orphan opportunity is skipped (orphan_account_reference)', () => {
    expect(map(rli({ account_id: '', opportunity_id: 'FIX-OPP-011' }))).toEqual({
      outcome: 'skipped',
      code: 'orphan_account_reference',
    });
  });

  it('account fallback: one confirmed hop when the line has no account; missing when neither', () => {
    expect(map(rli({ account_id: '', opportunity_id: 'FIX-OPP-019' }))).toMatchObject({
      outcome: 'ingest',
      accountId: 'FIX-ACC-016',
      observation: { companyRef: 'sugar:Accounts:FIX-ACC-016' },
    });
    expect(map(rli({ account_id: '', opportunity_id: '' }))).toEqual({
      outcome: 'skipped',
      code: 'missing_account_reference',
    });
    expect(map(rli({ account_id: '', opportunity_id: 'FIX-OPP-020' }))).toEqual({
      outcome: 'skipped',
      code: 'missing_account_reference',
    });
    // Primary wins over a differing fallback, and the conflict is counted.
    expect(map(rli({ account_id: 'FIX-ACC-001', opportunity_id: 'FIX-OPP-019' }))).toMatchObject({
      accountId: 'FIX-ACC-001',
      quality: ['relationship_conflict'],
    });
    // No fallback declared: an empty account is simply missing.
    const noFallback: ObjectMapping = {
      ...lines(),
      relationships: lines().relationships.map((r) => ({ ...r, fallbackVia: undefined })),
    };
    expect(map(rli({ account_id: '', opportunity_id: 'FIX-OPP-019' }), env(), noFallback)).toEqual({
      outcome: 'skipped',
      code: 'missing_account_reference',
    });
    // A primary account the source does not have is an orphan.
    expect(map(rli({ account_id: 'FIX-ACC-DOES-NOT-EXIST' }))).toEqual({
      outcome: 'skipped',
      code: 'orphan_account_reference',
    });
  });

  it('10 orphan product: skipped, and the whole account becomes an ownership gap', () => {
    expect(map(one('10'))).toEqual({
      outcome: 'skipped',
      code: 'orphan_product_reference',
      gapAccountId: 'FIX-ACC-009',
    });
  });

  it('12 missing product id: skipped, ownership gap for the account', () => {
    expect(map(one('12'))).toEqual({
      outcome: 'skipped',
      code: 'missing_product_reference',
      gapAccountId: 'FIX-ACC-011',
    });
  });

  it('11 duplicate source line: same identity and values (the run counts the duplicate)', () => {
    const [a, b] = discoveryFixture('11').map((r) => map(r));
    expect(a).toMatchObject({ outcome: 'ingest' });
    expect(b).toMatchObject({ outcome: 'ingest' });
    const strip = (r: SubscriptionMappingResult | undefined) =>
      r?.outcome === 'ingest' && r.observation.presence === 'present'
        ? { ...r.observation, sourceUpdatedAt: undefined }
        : r;
    expect(strip(a)).toEqual(strip(b));
  });

  it('13 end before start: the holding is kept with empty terms, state unknown, invalid_period', () => {
    const result = map(one('13'));
    expect(result).toMatchObject({
      outcome: 'ingest',
      quality: ['invalid_period'],
      observation: { state: 'unknown' },
    });
    expect(
      result.outcome === 'ingest' &&
        ('startsAt' in result.observation || 'endsAt' in result.observation),
    ).toBe(false);
  });

  it('an unparseable date keeps the holding with empty terms (invalid_date + invalid_period)', () => {
    const result = map(rli({ service_start_date: '31/12/2025' }));
    expect(result).toMatchObject({
      outcome: 'ingest',
      quality: ['invalid_date', 'invalid_period'],
      observation: { state: 'unknown' },
    });
    expect(result.outcome === 'ingest' && 'endsAt' in result.observation).toBe(false);
  });

  it('a missing optional date stays empty (no invalid period)', () => {
    const result = map(rli({ service_end_date: '' }));
    expect(result).toMatchObject({ outcome: 'ingest', quality: [] });
    expect(
      result.outcome === 'ingest' &&
        result.observation.presence === 'present' &&
        result.observation.startsAt,
    ).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('terms from a connection that is not (or no longer) their authority are dropped', () => {
    const result = map(one('01'), env({ authority: { state: false, terms: false } }));
    expect(
      result.outcome === 'ingest' &&
        ('startsAt' in result.observation || 'endsAt' in result.observation),
    ).toBe(false);
  });

  it('14 a visible deletion maps to an absence (tombstone)', () => {
    expect(map(one('14'))).toEqual({
      outcome: 'ingest',
      quality: [],
      observation: {
        presence: 'absent',
        source: { system: 'sugar', objectType: 'RevenueLineItems', recordId: 'FIX-RLI-120' },
        sourceUpdatedAt: new Date('2024-06-15T00:00:00Z'),
        observedAt: OBSERVED,
      },
    });
  });

  it('15 one-off product: skipped when declared non-subscription; ingested with empty terms when modelled', () => {
    expect(map(one('15'), env({ productStatus: () => 'ignored' }))).toEqual({
      outcome: 'skipped',
      code: 'non_subscription_product',
    });
    const modelled = map(one('15'));
    expect(modelled).toMatchObject({ outcome: 'ingest', observation: { state: 'unknown' } });
    expect(modelled.outcome === 'ingest' && 'startsAt' in modelled.observation).toBe(false);
  });

  it('C2 unmodelled product (in the source catalogue, not in the model, not ignored): rejected', () => {
    expect(map(rli({ product_template_id: 'FIX-PROD-900' }))).toEqual({
      outcome: 'rejected',
      code: 'unmodelled_product_reference',
      productId: 'FIX-PROD-900',
    });
  });

  it('C1 Closed Lost and open-pipeline lines are filtered out', () => {
    for (const stage of ['Closed Lost', 'Prospecting']) {
      expect(map(rli({ sales_stage: stage }))).toEqual({ outcome: 'filtered_out' });
    }
  });

  it('a record without a usable identity is skipped', () => {
    expect(map({ ...rli({ id: '' }), id: '' })).toEqual({
      outcome: 'skipped',
      code: 'missing_identity',
    });
  });

  it('a value-map rejection skips the record', () => {
    const variant: ObjectMapping = {
      ...lines(),
      fields: lines().fields.map((f) =>
        'target' in f && f.target === 'subscription.state'
          ? {
              kind: 'core' as const,
              target: 'subscription.state',
              source: 'status',
              transforms: {
                valueMap: { map: { Active: 'active' }, unmapped: 'reject_record' as const },
              },
              confirmation: { by: 'test', note: 'TEST ONLY' },
            }
          : f,
      ),
    };
    expect(
      map(rli({ status: 'Other' }), env({ authority: { state: true, terms: true } }), variant),
    ).toEqual({
      outcome: 'skipped',
      code: 'record_rejected',
      // M9A: the rejected record's account, for its ownership gap (§9.4).
      gapAccountId: 'FIX-ACC-001',
    });
  });
});

describe('holding filter semantics (M9A: reviewed domain, ADR 0023)', () => {
  const filter = (operator: 'in' | 'not_in', withEmpty = true): HoldingFilter => {
    const domain = testReviewedDomain(
      'a'.repeat(64),
      operator === 'in' ? ['Closed Won'] : FIXTURE_SALES_STAGES.filter((v) => v !== 'Closed Won'),
    );
    return {
      field: 'sales_stage',
      operator,
      values: ['Closed Won'],
      reviewedDomain: withEmpty
        ? domain
        : { ...domain, entries: domain.entries.filter((e) => e.value !== null) },
    };
  };

  it('reviewed values classify exactly after trimming', () => {
    expect(holdingClassOf(filter('in'), rli({ sales_stage: ' Closed Won ' }))).toBe('holding');
    expect(holdingClassOf(filter('in'), rli({ sales_stage: 'Closed Lost' }))).toBe('non_holding');
    expect(holdingClassOf(filter('not_in'), rli({ sales_stage: 'Closed Won' }))).toBe(
      'non_holding',
    );
    expect(holdingClassOf(filter('not_in'), rli({ sales_stage: 'Prospecting' }))).toBe('holding');
  });

  it('a value outside the domain is unreviewed under in and not_in alike', () => {
    expect(holdingClassOf(filter('in'), rli({ sales_stage: 'closed won' }))).toBe('unreviewed');
    expect(holdingClassOf(filter('not_in'), rli({ sales_stage: 'Renewal Pending' }))).toBe(
      'unreviewed',
    );
  });

  it('INTENDED CHANGE: an empty value uses the explicit empty entry (M8 admitted it under not_in)', () => {
    expect(holdingClassOf(filter('not_in'), rli({ sales_stage: '' }))).toBe('non_holding');
    expect(holdingClassOf(filter('in'), rli({ sales_stage: '' }))).toBe('non_holding');
    // Without a classified empty entry, an empty value is unreviewed, never a holding.
    expect(holdingClassOf(filter('not_in', false), rli({ sales_stage: '' }))).toBe('unreviewed');
  });

  it('a filter without a reviewed domain (pre-M9A) classifies nothing', () => {
    const { reviewedDomain: _drop, ...m8 } = filter('in');
    expect(holdingClassOf(m8, rli({ sales_stage: 'Closed Won' }))).toBe('unreviewed');
  });

  it('an unreviewed value is a protected skip that reports the readable account', () => {
    expect(map(rli({ sales_stage: 'Renewal Pending' }))).toEqual({
      outcome: 'skipped',
      code: 'unreviewed_holding_value',
      gapAccountId: 'FIX-ACC-001',
    });
    // No primary account: the confirmed hop is used for attribution.
    expect(
      map(rli({ sales_stage: 'Renewal Pending', account_id: '', opportunity_id: 'FIX-OPP-019' })),
    ).toEqual({
      outcome: 'skipped',
      code: 'unreviewed_holding_value',
      gapAccountId: 'FIX-ACC-016',
    });
    // Nothing readable: no attribution (the run decides; value rejections then fail it).
    expect(
      map(rli({ sales_stage: 'Renewal Pending', account_id: '', opportunity_id: '' })),
    ).toEqual({
      outcome: 'skipped',
      code: 'unreviewed_holding_value',
    });
    // A reviewed non-holding value stays a confident exclusion.
    expect(map(rli({ sales_stage: 'Closed Lost' }))).toEqual({ outcome: 'filtered_out' });
  });
});

describe('context records (accounts, people)', () => {
  const accounts = testMapping().objects[0]!;
  const account = toSourceRecord('Accounts', {
    id: 'FIX-ACC-001',
    name: 'Fixture Account 1',
    date_modified: '2025-12-01',
  });

  it('without account_profile authority only the reference is written (no name)', () => {
    const mapped = {
      ...accounts,
      fields: [{ kind: 'core' as const, target: 'account.name', source: 'name' }],
    };
    expect(
      mapContextRecord(mapped, account, {
        kind: 'sugar',
        profileAuthority: false,
        observedAt: OBSERVED,
      }),
    ).toEqual({
      outcome: 'ingest',
      quality: [],
      observation: {
        kind: 'company',
        presence: 'present',
        ref: { system: 'sugar', objectType: 'Accounts', id: 'FIX-ACC-001' },
        observedAt: OBSERVED,
        sourceUpdatedAt: new Date('2025-12-01T00:00:00Z'),
        fields: {},
      },
    });
    expect(
      mapContextRecord(mapped, account, {
        kind: 'sugar',
        profileAuthority: true,
        observedAt: OBSERVED,
      }),
    ).toMatchObject({ observation: { fields: { name: 'Fixture Account 1' } } });
  });
});

describe('context records: person company link and affiliation (M10C review M2, m2)', () => {
  const people: ObjectMapping = {
    source: 'Contacts',
    entity: 'person',
    identity: { field: 'id' },
    relationships: [
      { target: 'person.primaryCompany', field: 'account_id', object: 'Accounts' },
      { target: 'person.affiliation', field: 'affiliation_account_id', object: 'Accounts' },
    ],
    fields: [],
  } as unknown as ObjectMapping;
  const env = { kind: 'sugar' as const, profileAuthority: true, observedAt: OBSERVED };
  const person = (values: Record<string, string>) =>
    mapContextRecord(people, toSourceRecord('Contacts', { id: 'FIX-CON-001', ...values }), env);
  const observation = (values: Record<string, string>) => {
    const r = person(values);
    if (r.outcome !== 'ingest') throw new Error('expected ingest');
    return r as typeof r & { observation: Record<string, unknown> };
  };

  it('a primary-company field missing from the record states nothing (no companyLinks): never an ending', () => {
    expect(observation({})).not.toHaveProperty('observation.companyLinks');
  });

  it('an explicitly empty primary company states "no company"; a value states the link', () => {
    expect(observation({ account_id: '' }).observation.companyLinks).toEqual([]);
    expect(observation({ account_id: 'FIX-ACC-001' }).observation.companyLinks).toMatchObject([
      { company: { system: 'sugar', objectType: 'Accounts', id: 'FIX-ACC-001' }, primary: true },
    ]);
  });

  it('an over-long affiliation account id states nothing and is counted, never "no affiliation"', () => {
    const r = observation({ affiliation_account_id: 'x'.repeat(256) });
    expect(r).not.toHaveProperty('observation.affiliations');
    expect(r.quality).toContain('invalid_reference');
    expect(observation({ affiliation_account_id: '' }).observation.affiliations).toEqual([]);
    expect(observation({})).not.toHaveProperty('observation.affiliations');
  });
});

describe('properties: state is never inferred', () => {
  const stage = fc.constantFrom(
    'Closed Won',
    'Closed Lost',
    'Pending Cancellation',
    '',
    'Prospecting',
  );
  const day = fc
    .date({ min: new Date('2015-01-01Z'), max: new Date('2035-12-31Z'), noInvalidDate: true })
    .map((d) => d.toISOString().slice(0, 10));
  const record = fc.record({
    sales_stage: stage,
    quantity: fc.oneof(fc.integer({ min: -5, max: 1000 }).map(String), fc.constant('')),
    service_start_date: fc.oneof(day, fc.constant(''), fc.constant('garbage')),
    service_end_date: fc.oneof(day, fc.constant('')),
    status: fc.constantFrom('', 'Active', 'Expired', 'Closed Won', 'ZZ'),
    product_template_id: fc.constantFrom(
      'FIX-PROD-001',
      '',
      'FIX-PROD-DOES-NOT-EXIST',
      'FIX-PROD-900',
    ),
    account_id: fc.constantFrom('FIX-ACC-001', '', 'FIX-ACC-DOES-NOT-EXIST'),
    opportunity_id: fc.constantFrom('FIX-OPP-019', 'FIX-OPP-011', ''),
  });

  it('with state stated as unknown, no record (Closed Won, amounts, dates) ever yields another state', () => {
    fc.assert(
      fc.property(record, (values) => {
        const result = map(rli(values));
        if (result.outcome === 'ingest' && result.observation.presence === 'present') {
          expect(result.observation.state).toBe('unknown');
        }
      }),
    );
  });

  it('only records inside the holding filter are ever ingested', () => {
    fc.assert(
      fc.property(record, (values) => {
        const result = map(rli(values));
        if (result.outcome === 'ingest') expect(values.sales_stage).toBe('Closed Won');
      }),
    );
  });

  it('ingested terms are never contradictory; an invalid period forces unknown', () => {
    fc.assert(
      fc.property(record, (values) => {
        const result = map(rli(values));
        if (result.outcome !== 'ingest' || result.observation.presence !== 'present') return;
        const { startsAt, endsAt } = result.observation;
        if (startsAt && endsAt) expect(startsAt <= endsAt).toBe(true);
        if (result.quality.includes('invalid_period')) {
          expect(startsAt ?? endsAt).toBeUndefined();
        }
      }),
    );
  });

  it('skips for missing or orphan products always carry the resolved account as a gap', () => {
    fc.assert(
      fc.property(record, (values) => {
        const result = map(rli(values));
        if (
          result.outcome === 'skipped' &&
          (result.code === 'missing_product_reference' ||
            result.code === 'orphan_product_reference')
        ) {
          expect(result.gapAccountId).toMatch(/^FIX-ACC-\d{3}$/);
        }
      }),
    );
  });
});
