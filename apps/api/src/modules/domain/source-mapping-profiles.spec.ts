import { describe, expect, it } from 'vitest';
import {
  FIXTURE_SALES_STAGES,
  TEST_CONNECTION_ID,
  testAuthority,
  testMapping,
  testProfiles,
  testProfilingInput,
  testReviewedDomain,
  testSourceSchema,
  testSyntheticValue,
} from '../../../test/fixtures/source-mapping';
import { sourceSchemaHash } from './source-connector';
import {
  consequentialEntries,
  overrideDecision,
  requiresRepublish,
  validateMapping,
  type CandidateProfile,
  type MappingDocument,
  type ProfilingValidationInput,
} from './source-mapping';

const schema = testSourceSchema();
const hash = sourceSchemaHash(schema);
const DAY = 24 * 60 * 60 * 1000;

function validate(doc: MappingDocument, profiling: ProfilingValidationInput) {
  return validateMapping(doc, {
    connectionId: TEST_CONNECTION_ID,
    kind: 'sugar',
    schema,
    schemaHash: hash,
    latestSchemaHash: hash,
    authority: testAuthority(),
    profiling,
  });
}
const codes = (doc: MappingDocument, profiling: ProfilingValidationInput) => {
  const r = validate(doc, profiling);
  return r.ok ? [] : [...new Set(r.errors.map((e) => e.code))].sort();
};
const lines = (doc: MappingDocument) => doc.objects.find((o) => o.entity === 'subscription')!;
const without = (profiles: CandidateProfile[], object: string, field: string): CandidateProfile[] =>
  profiles.map((p) =>
    p.document.object === object
      ? {
          ...p,
          document: { ...p.document, fields: p.document.fields.filter((f) => f.name !== field) },
        }
      : p,
  );

describe('covering profiles (M9A §7.1)', () => {
  it('a complete, fresh, full profile set covers the default mapping and is recorded', () => {
    const profiling = testProfilingInput();
    const r = validate(testMapping(), profiling);
    expect(r.ok).toBe(true);
    const used = new Set(['Accounts', 'RevenueLineItems', 'ProductTemplates']);
    const expected = profiling.profiles
      .filter((p) => used.has(p.document.object))
      .map((p) => p.id)
      .sort();
    expect(r.ok && r.coveringProfileIds).toEqual(expected);
  });

  it('no profile at all: profile_required', () => {
    expect(codes(testMapping(), testProfilingInput({ profiles: [] }))).toEqual([
      'profile_required',
    ]);
  });

  it('profiles of another schema snapshot do not cover', () => {
    const other = testProfiles(schema, { snapshotHash: 'a'.repeat(64) });
    expect(codes(testMapping(), testProfilingInput({ profiles: other }))).toEqual([
      'profile_required',
    ]);
  });

  it('a profile that is not completed, or is a sync run-quality profile, does not cover', () => {
    const running = testProfiles().map((p) => ({ ...p, runStatus: 'running' }));
    expect(codes(testMapping(), testProfilingInput({ profiles: running }))).toEqual([
      'profile_required',
    ]);
    const sync = testProfiles().map((p) => ({ ...p, family: 'sync' as const }));
    expect(codes(testMapping(), testProfilingInput({ profiles: sync }))).toEqual([
      'profile_required',
    ]);
  });

  it('head-sampled profiles cannot cover consequential fields', () => {
    const head = testProfiles(schema, { method: 'head' });
    const r = validate(testMapping(), testProfilingInput({ profiles: head }));
    expect(r.ok).toBe(false);
    expect(
      !r.ok &&
        r.errors.some((e) => e.code === 'profile_required' && /head-sampled/.test(e.message)),
    ).toBe(true);
  });

  it('stale profiles: older than the freshness window', () => {
    const old = testProfiles(schema, { finishedAt: new Date(Date.now() - 31 * DAY) });
    expect(codes(testMapping(), testProfilingInput({ profiles: old }))).toEqual(['profile_stale']);
    expect(codes(testMapping(), testProfilingInput({ profiles: old, freshnessDays: 40 }))).toEqual(
      [],
    );
  });

  it('freshness is configurable between 1 and 90 days only', () => {
    for (const freshnessDays of [0, 91, 1.5]) {
      expect(codes(testMapping(), testProfilingInput({ freshnessDays }))).toContain(
        'profile_freshness_out_of_range',
      );
    }
  });

  it('a consequential field missing from the profile: profile_required for that entry', () => {
    const profiles = without(testProfiles(), 'RevenueLineItems', 'quantity');
    const r = validate(testMapping(), testProfilingInput({ profiles }));
    expect(!r.ok && r.errors.map((e) => `${e.code}@${e.path}`)).toEqual([
      'profile_required@objects.1.fields.3.source',
    ]);
  });

  it('exempt entries need no profile: ignored, explicit and value-independent declarations', () => {
    let profiles = testProfiles();
    // `renewal`, `renewal_rli_id`, `status` are ignored entries; state is explicit unknown.
    for (const f of ['renewal', 'renewal_rli_id', 'status', 'name', 'recurring_one_off_c'])
      profiles = without(profiles, 'RevenueLineItems', f);
    profiles = without(profiles, 'Accounts', 'name');
    expect(codes(testMapping(), testProfilingInput({ profiles }))).toEqual([]);
    const kinds = consequentialEntries(testMapping())
      .map((e) => `${e.object}.${e.field}:${e.kind}`)
      .sort();
    expect(kinds).toEqual([
      'Accounts.id:identity',
      'ProductTemplates.id:identity',
      'RevenueLineItems.account_id:reference',
      'RevenueLineItems.id:identity',
      'RevenueLineItems.opportunity_id:reference',
      'RevenueLineItems.product_template_id:reference',
      'RevenueLineItems.quantity:quantity',
      'RevenueLineItems.sales_stage:holding_filter',
      'RevenueLineItems.service_end_date:terms',
      'RevenueLineItems.service_start_date:terms',
    ]);
  });

  it('low coverage needs its finding acknowledged', () => {
    const sampled = testProfiles(schema, { method: 'systematic' });
    expect(codes(testMapping(), testProfilingInput({ profiles: sampled }))).toEqual([
      'profile_low_coverage',
    ]);
    // Only findings of covering profiles can be acknowledged.
    const covering = new Set(['Accounts', 'RevenueLineItems', 'ProductTemplates']);
    const acks = sampled
      .filter((p) => covering.has(p.document.object))
      .flatMap((p) => p.findings)
      .filter((f) => f.code === 'low_coverage_sample')
      .map((f) => ({ findingId: f.id, reasonCode: 'accepted_known_issue' as const }));
    const r = validate(
      testMapping(),
      testProfilingInput({ profiles: sampled, acknowledgements: acks }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.acknowledgements.map((a) => a.code)).toContain('low_coverage_sample');
  });
});

describe('publish-time profile checks and acknowledgements (M9A §7.3, §7.4)', () => {
  /** Profiles where `field` of RevenueLineItems holds `value(i)`. */
  const withValues = (field: string, value: (i: number) => string | number | null) =>
    testProfiles(schema, {
      values: (object, f, i) =>
        object === 'RevenueLineItems' && f.name === field ? value(i) : testSyntheticValue(f, i),
    });

  it('a warning on a consequential field needs an acknowledgement; an acknowledgement clears it', () => {
    const profiles = withValues('quantity', (i) => (i % 2 ? null : 3));
    const r = validate(testMapping(), testProfilingInput({ profiles }));
    expect(!r.ok && r.errors.map((e) => e.code)).toEqual(['finding_unacknowledged']);
    const finding = profiles
      .flatMap((p) => p.findings)
      .find((f) => f.code === 'high_null_ratio' && f.field === 'quantity')!;
    const ok = validate(
      testMapping(),
      testProfilingInput({
        profiles,
        acknowledgements: [{ findingId: finding.id, reasonCode: 'source_fix_pending' }],
      }),
    );
    expect(ok.ok && ok.acknowledgements).toEqual([
      { findingId: finding.id, reasonCode: 'source_fix_pending', code: 'high_null_ratio' },
    ]);
  });

  it('the same warning on a non-consequential field needs nothing', () => {
    const profiles = withValues('mrr_c', (i) => (i % 2 ? null : 3));
    expect(codes(testMapping(), testProfilingInput({ profiles }))).toEqual([]);
  });

  it('refuses acknowledgements of unknown findings or with an open reason code', () => {
    expect(
      codes(
        testMapping(),
        testProfilingInput({
          acknowledgements: [
            { findingId: '00000000-0000-4000-8000-000000000000', reasonCode: 'not_applicable' },
          ],
        }),
      ),
    ).toEqual(['acknowledgement_invalid']);
    const profiles = withValues('quantity', (i) => (i % 2 ? null : 3));
    const finding = profiles.flatMap((p) => p.findings).find((f) => f.code === 'high_null_ratio')!;
    expect(
      codes(
        testMapping(),
        testProfilingInput({
          profiles,
          acknowledgements: [{ findingId: finding.id, reasonCode: 'because' as never }],
        }),
      ),
    ).toEqual(['acknowledgement_invalid', 'finding_unacknowledged']);
  });

  it('duplicates of a declared id: the E finding needs an acknowledgement (not identity_unsuitable)', () => {
    const profiles = withValues('id', (i) => `R${i % 50}`);
    expect(codes(testMapping(), testProfilingInput({ profiles }))).toEqual([
      'finding_unacknowledged',
    ]);
    const finding = profiles
      .flatMap((p) => p.findings)
      .find((f) => f.code === 'identifier_not_unique' && f.field === 'id')!;
    expect(finding.class).toBe('existing_fail_closed');
  });

  it('duplicates of an undeclared, confirmed identity: identity_unsuitable', () => {
    const doc = testMapping();
    // Accounts.website is a plain string; the synthetic values repeat (v0, v1, v2).
    doc.objects[0]!.identity = { field: 'website', confirmation: { by: 't', note: 'n' } };
    expect(codes(doc, testProfilingInput())).toEqual(['identity_unsuitable']);
  });

  it('date entries over ambiguous or mixed date representations: date_format_required', () => {
    const ambiguous = withValues('service_start_date', (i) =>
      i === 0 ? '01/02/2025' : '2025-01-31',
    );
    const r = validate(testMapping(), testProfilingInput({ profiles: ambiguous }));
    expect(!r.ok && r.errors.map((e) => e.code)).toContain('date_format_required');
    const mixed = withValues('service_end_date', (i) => (i < 10 ? '31/01/2025' : '2025-01-31'));
    expect(codes(testMapping(), testProfilingInput({ profiles: mixed }))).toContain(
      'date_format_required',
    );
  });
});

describe('holding filters need a known, reviewed domain (M9A §10.2)', () => {
  it('refuses a filter without a reviewed domain, or with an incomplete one', () => {
    const doc = testMapping();
    delete (lines(doc).holdingFilter as { reviewedDomain?: unknown }).reviewedDomain;
    expect(codes(doc, testProfilingInput())).toEqual(['holding_filter_domain_incomplete']);
    expect(requiresRepublish(doc)).toBe(true);
    expect(requiresRepublish(testMapping())).toBe(false);
  });

  it('refuses a domain missing a value observed in the profile', () => {
    const doc = testMapping();
    const domain = testReviewedDomain(hash);
    lines(doc).holdingFilter!.reviewedDomain = {
      ...domain,
      entries: domain.entries.filter((e) => e.value !== 'Pending Cancellation'),
    };
    // The value is declared and observed: both reported, one code.
    expect(codes(doc, testProfilingInput())).toEqual(['holding_filter_domain_incomplete']);
  });

  it('null under not_in without a classified empty entry is refused at publish', () => {
    const doc = testMapping();
    lines(doc).holdingFilter!.operator = 'not_in';
    const domain = testReviewedDomain(
      hash,
      FIXTURE_SALES_STAGES.filter((v) => v !== 'Closed Won'),
    );
    lines(doc).holdingFilter!.reviewedDomain = {
      ...domain,
      entries: domain.entries.filter((e) => e.value !== null),
    };
    expect(codes(doc, testProfilingInput())).toEqual(['holding_filter_domain_incomplete']);
  });

  it('refuses a domain reviewed against another snapshot or citing a non-covering profile', () => {
    const doc = testMapping('b'.repeat(64));
    expect(codes(doc, testProfilingInput())).toEqual(['holding_filter_domain_stale']);
    const cites = testMapping();
    lines(cites).holdingFilter!.reviewedDomain = testReviewedDomain(
      hash,
      ['Closed Won'],
      ['00000000-0000-4000-8000-0000000000aa'],
    );
    expect(codes(cites, testProfilingInput())).toEqual(['holding_filter_domain_stale']);
  });

  it('refuses a filter whose field domain is unknown (no enum, safe categories suppressed)', () => {
    const s2 = structuredClone(schema);
    const rli = s2.objects.find((o) => o.name === 'RevenueLineItems')!;
    (rli.fields).push({
      name: 'stage_code',
      type: 'string',
      required: false,
      unique: false,
    });
    const h2 = sourceSchemaHash(s2);
    const doc = testMapping(h2);
    lines(doc).holdingFilter = {
      field: 'stage_code',
      operator: 'in',
      values: ['A'],
      confirmation: { by: 't', note: 'n' },
      reviewedDomain: {
        entries: [
          { value: 'A', classification: 'holding' },
          { value: null, classification: 'non_holding' },
        ],
        snapshotHash: h2,
        profileIds: [],
      },
    };
    // 100 distinct values: categorical suppressed, no declared enum.
    const profiles = testProfiles(s2, {
      values: (object, f, i) => (f.name === 'stage_code' ? `code${i}` : testSyntheticValue(f, i)),
    });
    const r = validateMapping(doc, {
      connectionId: TEST_CONNECTION_ID,
      kind: 'sugar',
      schema: s2,
      schemaHash: h2,
      latestSchemaHash: h2,
      authority: testAuthority(),
      profiling: testProfilingInput({ profiles }, s2),
    });
    expect(!r.ok && r.errors.map((e) => e.code)).toContain('holding_filter_domain_unknown');
  });
});

describe('emergency override (D5) ships disabled (decision A1)', () => {
  it('any override attempt is refused, even when it is the only problem', () => {
    const r = validate(
      testMapping(),
      testProfilingInput({ override: { reason: 'profiling worker down' } }),
    );
    expect(!r.ok && r.errors.map((e) => e.code)).toEqual([
      'override_requires_authenticated_operator',
    ]);
  });

  it('an override never removes another error (profile_required and acknowledgements stay)', () => {
    const r = validate(
      testMapping(),
      testProfilingInput({ profiles: [], override: { reason: 'queue unavailable' } }),
    );
    expect(!r.ok && [...new Set(r.errors.map((e) => e.code))].sort()).toEqual([
      'override_requires_authenticated_operator',
      'profile_required',
    ]);
    const profiles = testProfiles(schema, {
      values: (object, f, i) =>
        object === 'RevenueLineItems' && f.name === 'quantity'
          ? i % 2
            ? null
            : 3
          : testSyntheticValue(f, i),
    });
    const scoped = validate(
      testMapping(),
      testProfilingInput({ profiles, override: { reason: 'queue unavailable' } }),
    );
    expect(!scoped.ok && [...new Set(scoped.errors.map((e) => e.code))].sort()).toEqual([
      'finding_unacknowledged',
      'override_out_of_scope',
      'override_requires_authenticated_operator',
    ]);
  });

  it('validates the reason and scope even though the operator check always fails', () => {
    expect(overrideDecision({ reason: ' ' }, undefined, []).map((i) => i.code)).toEqual([
      'override_requires_authenticated_operator',
      'override_reason_invalid',
    ]);
    expect(
      overrideDecision({ reason: 'x' }, { authenticated: false, actor: 'cli' }, []).map(
        (i) => i.code,
      ),
    ).toEqual(['override_requires_authenticated_operator']);
  });
});
