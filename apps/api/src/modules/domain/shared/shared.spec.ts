import { describe, expect, it } from 'vitest';
import { at, uuid } from '../../../../test/fixtures/domain';
import { CodeSchema, LabelSchema } from './codes';
import { LeadIdSchema, PersonIdSchema, newId } from './ids';
import { InstantSchema } from './time';

describe('identifiers', () => {
  it('accepts UUIDs and rejects anything else', () => {
    expect(PersonIdSchema.parse(uuid(1))).toBe(uuid(1));
    for (const bad of ['', '123', 'not-a-uuid', 'hubspot:123']) {
      expect(PersonIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('newId generates distinct valid ids', () => {
    const a = newId(LeadIdSchema);
    const b = newId(LeadIdSchema);
    expect(a).not.toBe(b);
    expect(LeadIdSchema.safeParse(a).success).toBe(true);
  });
});

describe('InstantSchema', () => {
  it('accepts Dates and ISO strings with an offset', () => {
    expect(InstantSchema.parse(at(5))).toEqual(at(5));
    expect(InstantSchema.parse('2026-09-28T09:05:00.000Z')).toEqual(at(5));
    expect(InstantSchema.parse('2026-09-28T10:05:00+01:00')).toEqual(at(5));
  });

  it.each(['2026-09-28T09:05:00', '2026-09-28', 'yesterday', '', 1759050300000])(
    'rejects ambiguous or invalid input %j',
    (value) => {
      expect(InstantSchema.safeParse(value).success).toBe(false);
    },
  );

  it('rejects an invalid Date object', () => {
    expect(InstantSchema.safeParse(new Date('nope')).success).toBe(false);
  });
});

describe('CodeSchema / LabelSchema', () => {
  it.each(['marketplace', 'no_budget', 'rule.demo-dm', 'a1'])('accepts code %s', (code) => {
    expect(CodeSchema.parse(code)).toBe(code);
  });

  it.each(['', 'Upper', 'has space', '-leading', 'x'.repeat(65), 'emoji🙂'])(
    'rejects code %j',
    (code) => {
      expect(CodeSchema.safeParse(code).success).toBe(false);
    },
  );

  it('trims labels and rejects blank ones', () => {
    expect(LabelSchema.parse('  Demo request ')).toBe('Demo request');
    expect(LabelSchema.safeParse('   ').success).toBe(false);
  });
});
