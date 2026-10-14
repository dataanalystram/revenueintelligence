import { describe, expect, it } from 'vitest';
import {
  classificationProblems,
  ColumnClassificationSchema,
  effectiveSensitivity,
} from '../../domain';
import { CLASSIFICATION_MANIFEST, dataSubjectMap } from './classification-manifest';
import { PRIVILEGE_MANIFEST } from './privilege-manifest';

/**
 * M10A1 plan §8, §9, §14: the manifests are well-formed on their own. Coverage
 * against the real database (every column, every table, exact privileges) is
 * asserted by the schema guard in test/tenancy/migrations.int.spec.ts.
 */
describe('classification manifest', () => {
  const entries = Object.entries(CLASSIFICATION_MANIFEST).flatMap(([table, columns]) =>
    Object.entries(columns).map(([column, c]) => ({ name: `${table}.${column}`, c })),
  );

  it('every entry is valid and respects the category floors', () => {
    expect(entries.length).toBeGreaterThan(400);
    const problems = entries.flatMap(({ name, c }) => {
      const parsed = ColumnClassificationSchema.safeParse(c);
      return parsed.success ? classificationProblems(name, c) : [`${name}: invalid`];
    });
    expect(problems).toEqual([]);
  });

  it('Q6: the tbc list is small, each with a reason and an owner, and treated as restricted', () => {
    const tbc = entries.filter(({ c }) => c.tbc);
    expect(tbc.length).toBeGreaterThan(0);
    // M10A1: nine operator-id columns; M10A2 adds eight, M10B one
    // (tenant_evidence_links.actor_id; plan §12: new operator-id columns reuse
    // the same reason). Every tbc entry is an operator-id column.
    expect(tbc.length).toBeLessThanOrEqual(18);
    for (const { name } of tbc)
      expect(name).toMatch(
        /\.(actor_id|updated_by_id|published_by|captured_by|requested_by|actor|[a-z_]+_by)$/,
      );
    for (const { c } of tbc) {
      expect(c.tbc!.reason.length).toBeGreaterThan(20);
      expect(c.tbc!.owner.length).toBeGreaterThan(2);
      expect(effectiveSensitivity(c)).toBe('restricted');
    }
  });

  it('credential material is never free text; ciphertext columns are restricted security', () => {
    for (const { name, c } of entries) {
      if (/_enc$/.test(name))
        expect(c, name).toMatchObject({ kind: 'ciphertext', sensitivity: 'restricted' });
      if (c.kind === 'ciphertext') expect(c.categories, name).toContain('security');
    }
  });

  it('the data-subject map covers every table with a personal column', () => {
    const map = dataSubjectMap();
    for (const t of map.filter((x) => x.personal)) {
      expect(t.columns.length, t.table).toBeGreaterThan(0);
    }
    expect(map.find((t) => t.table === 'persons')).toMatchObject({ personal: true });
    expect(map.map((t) => t.table)).toEqual(
      expect.arrayContaining(['persons', 'person_external_refs', 'companies']),
    );
  });

  it('a personal column without a subject link, or below its floor, is a problem (the check can fail)', () => {
    expect(
      classificationProblems('x.email', {
        sensitivity: 'internal',
        categories: ['personal'],
        kind: 'identifier',
        retention: 'canonical_lifecycle',
        history: 'none',
      }),
    ).toEqual([
      'x.email: category personal needs at least confidential, not internal',
      'x.email: a personal column needs a subject link',
    ]);
  });
});

describe('privilege manifest', () => {
  it('names the same tables as the classification manifest (plus the migration history)', () => {
    expect(Object.keys(PRIVILEGE_MANIFEST).sort()).toEqual(
      [...Object.keys(CLASSIFICATION_MANIFEST), '_prisma_migrations'].sort(),
    );
  });

  it('never grants TRUNCATE, REFERENCES or TRIGGER', () => {
    for (const privileges of Object.values(PRIVILEGE_MANIFEST)) {
      expect(privileges).not.toContain('TRUNCATE');
      expect(privileges).not.toContain('REFERENCES');
      expect(privileges).not.toContain('TRIGGER');
    }
  });
});
