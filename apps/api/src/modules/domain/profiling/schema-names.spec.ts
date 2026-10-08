import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceField, SourceObject } from '../source-connector';
import { objectAccumulatorFor } from './accumulators';
import { buildProfileDocument, type ProfileDocument } from './document';
import { driftFindings } from './drift';
import { assertNoRawFinding, documentFindings, finding } from './findings';
import { validateProfileRequest } from './limits';
import {
  assertNoRawValues,
  displayName,
  isRedactedName,
  ProfilePrivacyViolationError,
  profileNames,
  schemaNameHits,
} from './privacy';

/**
 * M9A closure fix: source schema names are source-controlled content. A field
 * called `acct_4111111111111111` must never be stored, printed or logged
 * verbatim. Every name class is exercised as a declared field name, an
 * undeclared field name, in the document, in findings and in the stored request.
 */

/** Synthetic, publicly documented test numbers embedded in names, with the core that must not survive. */
const ADVERSARIAL: ReadonlyArray<{ name: string; core: string; hit: string }> = [
  { name: 'acct_4111111111111111', core: '4111111111111111', hit: 'card' },
  { name: 'acct_4111_1111_1111_1111', core: '4111_1111_1111_1111', hit: 'card' },
  { name: 'tel_447700900123', core: '447700900123', hit: 'phone' },
  { name: 'tel_44_20_7946_0958', core: '20_7946_0958', hit: 'phone' },
  { name: 'iban_GB82WEST12345698765432', core: 'GB82WEST12345698765432', hit: 'iban' },
  { name: 'gb82west12345698765432', core: 'gb82west12345698765432', hit: 'iban' },
  { name: 'ref_123e4567_e89b_12d3_a456_426614174000', core: '123e4567', hit: 'identifier_like' },
  { name: 'ext_A1B2C3D4E5F6G7H8', core: 'A1B2C3D4E5F6G7H8', hit: 'identifier_like' },
];
/** Names that cannot be declared (the snapshot only declares API names) but can arrive as undeclared keys. */
const UNDECLARED_ONLY: ReadonlyArray<{ name: string; core: string; hit: string }> = [
  { name: 'contact_jane.doe@example.com', core: 'jane.doe@example.com', hit: 'email' },
  { name: '+44 20 7946 0958', core: '7946 0958', hit: 'phone' },
];

const HASH = 'f'.repeat(64);

function objectOf(names: readonly string[], objectName = 'Things'): SourceObject {
  return {
    name: objectName,
    classification: 'record',
    capabilities: { pagination: 'offset', deleteVisibility: 'none', count: true, maxPageSize: 100 },
    fields: names.map((name): SourceField => ({
      name,
      type: 'string',
      required: false,
      unique: false,
    })),
  };
}

function build(
  object: SourceObject,
  rows: ReadonlyArray<Record<string, unknown>>,
  orderedBy: string | null = null,
): ProfileDocument {
  const names = object.fields.map((f) => f.name);
  const acc = objectAccumulatorFor(object, names);
  const declared = new Set(names);
  for (const r of rows) acc.addRecord(r, declared);
  return buildProfileDocument({
    object,
    connectionKind: 'test',
    schemaSnapshotHash: HASH,
    accumulator: acc,
    sampling: {
      method: 'full',
      populationEstimate: rows.length,
      bounded: false,
      stride: null,
      orderedBy,
      evidence: [],
    },
    maxRows: 1000,
    distinctCap: 10_000,
    optedIn: new Set(),
  });
}

const rowsFor = (names: readonly string[], extra: Record<string, unknown> = {}) =>
  Array.from({ length: 25 }, (_, i) => ({
    ...Object.fromEntries(names.map((n) => [n, `v${i % 3}`])),
    ...extra,
  }));

describe('schemaNameHits: generic schema-name detectors', () => {
  it.each([...ADVERSARIAL, ...UNDECLARED_ONLY])('$name → $hit', ({ name, hit }) => {
    expect(schemaNameHits(name)).toContain(hit);
    expect(isRedactedName(name)).toBe(true);
  });

  it('every field name of the Sugar fixture schema stays readable (no over-redaction regression)', () => {
    const doc = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../test/fixtures/sugar/fields-v1.json'), 'utf8'),
    ) as Record<string, { fields: Record<string, unknown> }>;
    const names = Object.values(doc).flatMap((m) => Object.keys(m.fields));
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter(isRedactedName)).toEqual([]);
  });

  it.each([
    'address_line_2__c',
    'service_end_date',
    'renewal_rli_id',
    'Account_Number__c',
    'q1_2024_revenue',
    'utm_q12_campaign_source',
  ])('ordinary name %s is not redacted', (name) => {
    expect(schemaNameHits(name)).toEqual([]);
  });
});

describe('profileNames: deterministic tokens that carry nothing of the name', () => {
  it('assigns redacted_field_<n> by sorted source name, independent of input order', () => {
    const declared = ['status', 'tel_447700900123', 'acct_4111111111111111', 'name'];
    const a = profileNames(declared);
    const b = profileNames([...declared].reverse());
    expect(a.toProfile('acct_4111111111111111')).toBe('redacted_field_1');
    expect(a.toProfile('tel_447700900123')).toBe('redacted_field_2');
    expect(a.toProfile('status')).toBe('status');
    for (const n of declared) expect(b.toProfile(n)).toBe(a.toProfile(n));
    expect(a.toSource('redacted_field_1')).toBe('acct_4111111111111111');
    expect(a.toSource('status')).toBe('status');
  });

  it('a source name in the reserved token form is itself replaced (no collision)', () => {
    const names = profileNames(['redacted_field_1', 'acct_4111111111111111']);
    expect(names.toProfile('acct_4111111111111111')).toBe('redacted_field_1');
    expect(names.toProfile('redacted_field_1')).toBe('redacted_field_2');
    expect(names.toSource('redacted_field_2')).toBe('redacted_field_1');
  });

  it('operator messages withhold names that cannot be stored', () => {
    expect(displayName('acct_4111111111111111')).toBe('(name withheld)');
    expect(displayName('status')).toBe('status');
  });
});

describe('profile documents and findings never hold a sensitive name verbatim', () => {
  it.each(ADVERSARIAL)('declared field $name ($hit)', ({ name, core }) => {
    const object = objectOf(['status', name]);
    const doc = build(object, rowsFor(['status', name]), name);
    const json = JSON.stringify(doc);
    expect(json).not.toContain(core);
    expect(json).not.toContain(name);
    const redacted = doc.fields.find((f) => f.nameRedacted);
    expect(redacted?.name).toBe('redacted_field_1');
    expect(doc.fields.map((f) => f.name)).toEqual(['redacted_field_1', 'status']);
    expect(doc.sampling.orderedBy).toBe('redacted_field_1');
    const findings = documentFindings(doc, { identityFields: new Set(['redacted_field_1']) });
    for (const f of findings) assertNoRawFinding(f);
    expect(JSON.stringify(findings)).not.toContain(core);
  });

  it.each([...ADVERSARIAL, ...UNDECLARED_ONLY])(
    'undeclared field $name ($hit) is counted, never listed',
    ({ name, core }) => {
      const object = objectOf(['status']);
      const doc = build(object, rowsFor(['status'], { [name]: 'x', extra_col: 'y' }));
      expect(doc.undeclaredFields).toEqual(['extra_col']);
      expect(doc.undeclaredFieldsRedacted).toBe(1);
      expect(JSON.stringify(doc)).not.toContain(core);
      const findings = documentFindings(doc);
      expect(findings.filter((f) => f.code === 'undeclared_field_in_data')).toEqual([
        expect.objectContaining({ field: 'extra_col' }),
        expect.objectContaining({ field: null, evidence: { count: 1, nameRedacted: true } }),
      ]);
      for (const f of findings) assertNoRawFinding(f);
      expect(JSON.stringify(findings)).not.toContain(core);
    },
  );

  it('acct_4111111111111111 cannot appear in a persisted document, a drift finding or a finding field', () => {
    const object = objectOf(['acct_4111111111111111', 'status']);
    const before = build(object, rowsFor(['acct_4111111111111111', 'status']));
    const after = build(
      object,
      rowsFor(['status']).map((r) => ({ ...r, acct_4111111111111111: 1 })),
    );
    const drift = driftFindings(after, before);
    expect(drift.length).toBeGreaterThan(0);
    for (const f of drift) assertNoRawFinding(f);
    const out = JSON.stringify({ before, after, drift });
    expect(out).not.toContain('4111111111111111');
  });

  it('a document builder that forgets the redaction is caught by the independent scan', () => {
    const doc = build(objectOf(['status']), rowsFor(['status']));
    const leaked = (patch: (d: Record<string, unknown>) => void) => {
      const copy = structuredClone(doc) as unknown as Record<string, unknown>;
      patch(copy);
      return () => assertNoRawValues(copy);
    };
    const hasField = (d: Record<string, unknown>) =>
      (d.fields as Array<Record<string, unknown>>)[0]!;
    expect(
      leaked((d) => {
        hasField(d).name = 'acct_4111111111111111';
      }),
    ).toThrow(ProfilePrivacyViolationError);
    expect(
      leaked((d) => {
        d.undeclaredFields = ['tel_447700900123'];
      }),
    ).toThrow(/phone at undeclaredFields\[0\]/);
    expect(
      leaked((d) => {
        d.object = 'iban_GB82WEST12345698765432';
      }),
    ).toThrow(/ at object/);
    expect(
      leaked((d) => {
        (d.sampling as Record<string, unknown>).orderedBy =
          'ref_123e4567_e89b_12d3_a456_426614174000';
      }),
    ).toThrow(/ at sampling\.orderedBy/);
    expect(
      leaked((d) => {
        hasField(d).json = { share: 1, topLevelKeys: ['acct_4111111111111111'], maxDepth: 1 };
      }),
    ).toThrow(/at fields\[0\]\.json\.topLevelKeys\[0\]/);
    // The only exemption is the platform-computed hash, and only in its hash form.
    expect(
      leaked((d) => {
        d.schemaSnapshotHash = 'acct_4111111111111111';
      }),
    ).toThrow(/ at schemaSnapshotHash/);
    expect(leaked(() => undefined)).not.toThrow();
  });

  it('a finding naming a sensitive field is caught before persistence', () => {
    expect(() =>
      assertNoRawFinding(finding('high_null_ratio', 'acct_4111111111111111', {})),
    ).toThrow(/card at finding\.field/);
  });

  it('the scan error carries the detector and path, never the name', () => {
    try {
      assertNoRawValues({ fields: [{ name: 'acct_4111111111111111' }] });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('4111');
    }
  });
});

describe('profile requests: stored and printed names are profile names', () => {
  const settings = { maxRows: 1000 };
  const schema = [
    objectOf(['status', 'acct_4111111111111111', 'card_5555555555554444']),
    objectOf(['status'], 'Obj_4111111111111111'),
  ];

  it('the validated request (stored on the run, printed by profile-run) holds tokens only', () => {
    const v = validateProfileRequest(
      { objects: [{ object: 'Things' }], sampling: 'full', includeExcluded: [] },
      schema,
      settings,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.request.objects[0]!.fields).toEqual(['redacted_field_1', 'status']);
    // The excluded-by-name card field is left out and reported by its token.
    expect(v.request.excludedLeftOut).toEqual(['Things.redacted_field_2']);
    const json = JSON.stringify(v);
    expect(json).not.toContain('4111111111111111');
    expect(json).not.toContain('5555555555554444');
  });

  it('a field may be requested and opted in by token or source name; both store the token', () => {
    for (const ref of ['card_5555555555554444', 'redacted_field_2']) {
      const v = validateProfileRequest(
        {
          objects: [{ object: 'Things', fields: [ref, 'status'] }],
          sampling: 'full',
          includeExcluded: [`Things.${ref}`],
        },
        schema,
        settings,
      );
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.request.objects[0]!.fields).toEqual(['redacted_field_2', 'status']);
      expect(v.request.optIns).toEqual([{ object: 'Things', field: 'redacted_field_2' }]);
    }
  });

  it('refusal messages withhold sensitive names; an object whose name cannot be stored is refused', () => {
    const v = validateProfileRequest(
      {
        objects: [
          { object: 'Things', fields: ['card_5555555555554444', 'tel_447700900123'] },
          { object: 'Obj_4111111111111111' },
        ],
        sampling: 'full',
        includeExcluded: [],
      },
      schema,
      settings,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.issues.map((i) => i.code)).toEqual([
      'profile_field_excluded',
      'unknown_source_field',
      'profile_request_invalid',
      'source_object_name_sensitive',
    ]);
    const json = JSON.stringify(v.issues);
    for (const core of ['5555555555554444', '447700900123', '4111111111111111'])
      expect(json).not.toContain(core);
  });
});
