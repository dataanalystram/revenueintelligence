import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_KIND_CATALOGUE } from '../connector-kinds';
import type { SourceField, SourceObject } from '../source-connector';
import { objectAccumulatorFor } from './accumulators';
import { buildProfileDocument, type ProfileDocument } from './document';
import {
  capFindings,
  classify,
  documentFindings,
  FAIL_CLOSED_CODES,
  finding,
  FINDING_CODES,
  FindingPolicyError,
  MAX_FINDINGS_PER_PROFILE,
  validateFindingPolicy,
} from './findings';

function doc(
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: ReadonlyArray<Partial<SourceField> & { name: string }>,
  sampling: Partial<ProfileDocument['sampling']> = {},
): ProfileDocument {
  const obj: SourceObject = {
    name: 'Things',
    classification: 'record',
    capabilities: { pagination: 'offset', deleteVisibility: 'none', count: true, maxPageSize: 100 },
    fields: fields.map((f) => ({ type: 'string', required: false, unique: false, ...f })),
  };
  const names = fields.map((f) => f.name);
  const acc = objectAccumulatorFor(obj, names);
  const declared = new Set(names);
  for (const r of rows) acc.addRecord(r, declared);
  return buildProfileDocument({
    object: obj,
    connectionKind: 'test',
    schemaSnapshotHash: 'f'.repeat(64),
    accumulator: acc,
    sampling: {
      method: sampling.method ?? 'full',
      populationEstimate: sampling.populationEstimate ?? rows.length,
      bounded: sampling.bounded ?? false,
      stride: null,
      orderedBy: null,
      evidence: [],
    },
    maxRows: 1000,
    distinctCap: 10_000,
    optedIn: new Set(),
  });
}

const codes = (d: ProfileDocument, identity?: string[]) =>
  documentFindings(d, identity ? { identityFields: new Set(identity) } : {}).map(
    (f) => `${f.code}:${f.field ?? '-'}`,
  );

describe('finding codes', () => {
  it('mirror the SQL CHECK of tenant_source_profile_findings exactly (parity)', () => {
    const dir = resolve(__dirname, '../../../../prisma/migrations');
    const name = readdirSync(dir).find((n) => n.endsWith('_m9a_source_profiling'))!;
    const sql = readFileSync(resolve(dir, name, 'migration.sql'), 'utf8');
    const block =
      /"tenant_source_profile_findings_code_valid" CHECK \("code" IN \(([\s\S]*?)\)\)/.exec(
        sql,
      )![1]!;
    const fromSql = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(fromSql).toEqual([...FINDING_CODES].sort());
  });

  it('E and B codes are fail-closed classes; low coverage needs review', () => {
    expect(classify('identifier_not_unique')).toEqual({
      class: 'existing_fail_closed',
      severity: 'warning',
    });
    for (const c of [
      'identity_field_absent',
      'profile_drift_type_incompatible',
      'holding_filter_value_unreviewed',
    ] as const) {
      expect(classify(c)).toEqual({ class: 'm9a_fail_closed', severity: 'review_required' });
    }
    expect(classify('low_coverage_sample').severity).toBe('review_required');
    expect(classify('mixed_type')).toEqual({ class: 'advisory', severity: 'warning' });
  });

  it('E/B codes cannot be demoted, disabled or listed in a policy; only A codes may be promoted', () => {
    expect(validateFindingPolicy({ promote: ['mixed_type'] })).toEqual({ promote: ['mixed_type'] });
    for (const code of FAIL_CLOSED_CODES) {
      expect(() => validateFindingPolicy({ promote: [code] })).toThrow(FindingPolicyError);
      expect(() => validateFindingPolicy({ demote: [code] })).toThrow(FindingPolicyError);
      expect(() => validateFindingPolicy({ disable: [code] })).toThrow(FindingPolicyError);
    }
    expect(() => validateFindingPolicy({ demote: ['mixed_type'] })).toThrow(/cannot be demoted/);
    expect(() => validateFindingPolicy({ promote: ['made_up_code'] })).toThrow(FindingPolicyError);
  });

  it('caps findings at 2,000 with one findings_truncated carrying the count', () => {
    const many = Array.from({ length: 2500 }, () => finding('mixed_type', 'a', {}));
    const capped = capFindings(many);
    expect(capped).toHaveLength(MAX_FINDINGS_PER_PROFILE);
    expect(capped.at(-1)).toMatchObject({ code: 'findings_truncated', evidence: { omitted: 501 } });
    expect(capFindings(many.slice(0, 10))).toHaveLength(10);
  });
});

describe('publish-time quality findings (M9A §8)', () => {
  const rows = (n: number, f: (i: number) => Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => f(i));

  it('null ratio, required-but-null and empty-vs-null', () => {
    const d = doc(
      rows(40, (i) => ({
        a: i % 2 ? null : 'x',
        r: i === 0 ? null : 'y',
        e: i % 4 === 0 ? null : i % 4 === 1 ? '' : 'z',
      })),
      [{ name: 'a' }, { name: 'r', required: true }, { name: 'e' }],
    );
    expect(codes(d)).toEqual(
      expect.arrayContaining([
        'high_null_ratio:a',
        'required_but_null:r',
        'empty_string_vs_null:e',
      ]),
    );
    // Identity fields do not get the null-ratio advisory.
    expect(codes(d, ['a'])).not.toContain('high_null_ratio:a');
  });

  it('mixed type and mixed representation at the 1% / 5-value boundary', () => {
    const mixed = doc(
      rows(100, (i) => ({ m: i < 5 ? 7 : 'text' })),
      [{ name: 'm' }],
    );
    expect(codes(mixed)).toContain('mixed_type:m');
    const notMixed = doc(
      rows(100, (i) => ({ m: i < 4 ? 7 : 'text' })),
      [{ name: 'm' }],
    );
    expect(codes(notMixed)).not.toContain('mixed_type:m');
    const reps = doc(
      rows(100, (i) => ({ d: i < 5 ? '31/01/2025' : '2025-01-31' })),
      [{ name: 'd' }],
    );
    expect(codes(reps)).toContain('mixed_representation:d');
  });

  it('parse failures, declared type mismatch and values outside the declared enum', () => {
    const d = doc(
      rows(30, (i) => ({
        j: i === 0 ? '{bad' : '{"a":1}',
        n: i < 10 ? 'abc' : '12',
        s: i === 0 ? 'Other' : 'Open',
      })),
      [
        { name: 'j' },
        { name: 'n', type: 'number' },
        { name: 's', type: 'enum', enumOptions: [{ value: 'Open', active: true }] },
      ],
    );
    expect(codes(d)).toEqual(
      expect.arrayContaining([
        'malformed_json:j',
        'declared_type_mismatch:n',
        'value_not_in_declared_enum:s',
      ]),
    );
  });

  it('identity uniqueness (E), absent fields, undeclared fields and sensitive values', () => {
    const d = doc(
      rows(30, (i) => ({
        id: i < 2 ? 'A' : `R${i}`,
        x: i < 3 ? `p${i}@example.com` : 'n/a',
        extra_col: 1,
      })),
      [{ name: 'id' }, { name: 'x' }, { name: 'gone' }],
    );
    const c = codes(d, ['id']);
    expect(c).toEqual(
      expect.arrayContaining([
        'identifier_not_unique:id',
        'field_absent_in_data:gone',
        'undeclared_field_in_data:extra_col',
        'sensitive_values_detected:x',
      ]),
    );
    const sensitive = documentFindings(d).find((f) => f.code === 'sensitive_values_detected')!;
    expect(sensitive.evidence).toMatchObject({ email: 3 });
    expect(JSON.stringify(documentFindings(d))).not.toMatch(/example\.com/);
  });

  it('sampling findings: head-sampled and low coverage', () => {
    const head = doc(
      rows(30, () => ({ a: 'x' })),
      [{ name: 'a' }],
      { method: 'head', populationEstimate: 1000, bounded: true },
    );
    expect(codes(head)).toEqual(
      expect.arrayContaining(['head_sample_biased:-', 'low_coverage_sample:-']),
    );
    const full = doc(
      rows(30, () => ({ a: 'x' })),
      [{ name: 'a' }],
    );
    expect(codes(full).filter((c) => c.endsWith(':-'))).toEqual([]);
  });
});

describe('no vendor names in the source-neutral M9A domain', () => {
  it('profiling, holding-domain and coverage never name a connector kind', () => {
    const domain = resolve(__dirname, '..');
    const files = [
      ...readdirSync(__dirname)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
        .map((f) => resolve(__dirname, f)),
      resolve(domain, 'holding-domain.ts'),
      resolve(domain, 'coverage.ts'),
      resolve(domain, 'source-protection.ts'),
    ];
    const kinds = CONNECTOR_KIND_CATALOGUE.map((k) => k.kind).filter((k) => k !== 'import');
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const k of kinds) expect(text.includes(k), `${file} names ${k}`).toBe(false);
    }
  });
});
