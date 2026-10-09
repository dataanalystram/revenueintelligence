import { describe, expect, it } from 'vitest';
import {
  companyFields,
  decideApply,
  fieldHash,
  personFields,
  primaryCompanyLink,
  type SourceCompanyLink,
  type SourceObservation,
  type StoredReference,
} from './source-observation';

const ref = { system: 'hubspot' as const, objectType: 'companies', id: '201' };
const t = (iso: string) => new Date(`2026-10-01T${iso}Z`);

function company(over: Partial<{ updated: Date; observed: Date; name: string }> = {}) {
  return {
    kind: 'company',
    presence: 'present',
    ref,
    observedAt: over.observed ?? t('12:00:00'),
    sourceUpdatedAt: over.updated ?? t('10:00:00'),
    fields: companyFields({ name: over.name ?? 'School', domain: 'school.example' }),
  } as const satisfies SourceObservation;
}
const absent = (observed: Date): SourceObservation => ({
  kind: 'company',
  presence: 'absent',
  ref,
  observedAt: observed,
});
const stored = (over: Partial<StoredReference> = {}): StoredReference => ({
  state: 'active',
  sourceUpdatedAt: t('10:00:00'),
  fieldHash: fieldHash(company()),
  lastSeenAt: t('12:00:00'),
  ...over,
});

describe('decideApply (ADR 0014)', () => {
  it('new present record → create; unknown absent record → not_found', () => {
    expect(decideApply(undefined, company())).toBe('create');
    expect(decideApply(undefined, absent(t('12:00:00')))).toBe('not_found');
  });

  it('newer source time → apply; older → stale (out-of-order events)', () => {
    expect(decideApply(stored(), company({ updated: t('11:00:00'), name: 'New' }))).toBe('apply');
    expect(decideApply(stored(), company({ updated: t('09:00:00'), name: 'Old' }))).toBe('stale');
  });

  it('same source time and same fields → unchanged; same time, different fields → apply', () => {
    expect(decideApply(stored(), company())).toBe('unchanged');
    expect(decideApply(stored(), company({ name: 'Renamed' }))).toBe('apply');
  });

  it('absence after the last presence → delete; absence read before it → stale', () => {
    expect(decideApply(stored(), absent(t('12:30:00')))).toBe('delete');
    expect(decideApply(stored(), absent(t('11:59:00')))).toBe('stale');
    expect(
      decideApply(stored({ state: 'deleted', deletedAt: t('12:30:00') }), absent(t('13:00:00'))),
    ).toBe('unchanged');
  });

  it('a tombstone is revived only by a read made after the deletion was recorded', () => {
    const tomb = stored({ state: 'deleted', deletedAt: t('12:30:00') });
    // An old snapshot (e.g. a backfill page read before the deletion) cannot resurrect it.
    expect(decideApply(tomb, company({ observed: t('12:10:00'), updated: t('12:20:00') }))).toBe(
      'stale',
    );
    // A read-back after a restore event revives it, even if HubSpot kept the old modified time.
    expect(decideApply(tomb, company({ observed: t('13:00:00'), updated: t('10:00:00') }))).toBe(
      'restore',
    );
  });

  it('M9B: a retired reference is reactivated only by a read made after the retirement', () => {
    const retired = stored({ state: 'retired', retiredAt: t('12:30:00') });
    // A page read before the retirement cannot undo it, even with identical fields.
    expect(decideApply(retired, company({ observed: t('12:10:00') }))).toBe('stale');
    // A later read always reactivates it, even with the same source time and fields.
    expect(decideApply(retired, company({ observed: t('13:00:00') }))).toBe('restore');
    // Absence of a retired reference changes nothing (never a deletion).
    expect(decideApply(retired, absent(t('13:00:00')))).toBe('unchanged');
    // Without the retirement time nothing can prove the read is newer.
    expect(decideApply(stored({ state: 'retired' }), company({ observed: t('13:00:00') }))).toBe(
      'stale',
    );
  });

  it('a merged-away reference is never revived', () => {
    expect(decideApply(stored({ state: 'merged' }), company({ updated: t('23:00:00') }))).toBe(
      'stale',
    );
    expect(decideApply(stored({ state: 'merged' }), absent(t('23:00:00')))).toBe('unchanged');
  });

  it('without a source time, only a newer read may change data', () => {
    const noTime = {
      ...company({ name: 'X', observed: t('11:00:00') }),
      sourceUpdatedAt: undefined,
    };
    expect(decideApply(stored(), noTime)).toBe('stale');
    const later = {
      ...company({ name: 'X', observed: t('13:00:00') }),
      sourceUpdatedAt: undefined,
    };
    expect(decideApply(stored(), later)).toBe('apply');
  });
});

describe('field normalisation and hashing', () => {
  it('drops invalid values instead of storing them; never invents a name', () => {
    expect(companyFields({ name: '  ', domain: 'not a domain' })).toEqual({});
    expect(companyFields({ name: ' ABC ', domain: 'ABC.Example ' })).toEqual({
      name: 'ABC',
      domain: 'abc.example',
    });
    expect(personFields({ email: 'nope', firstName: ' A ' })).toEqual({ firstName: 'A' });
    expect(personFields({ email: ' X@Y.Example ' })).toEqual({ email: 'x@y.example' });
  });

  it('hash depends on values and links, not on key order', () => {
    const a = company();
    const b = { ...a, fields: { domain: a.fields.domain, name: a.fields.name } };
    expect(fieldHash(a)).toBe(fieldHash(b));
    expect(fieldHash(a)).not.toBe(fieldHash(company({ name: 'Other' })));
    expect(fieldHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('primaryCompanyLink', () => {
  const link = (id: string, primary: boolean): SourceCompanyLink => ({
    company: { system: 'hubspot', objectType: 'companies', id },
    typeId: primary ? 1 : 279,
    category: 'standard',
    primary,
  });
  it('picks the primary link, a single unlabelled link, or nothing', () => {
    expect(primaryCompanyLink([link('1', true), link('2', false)])).toEqual({
      link: link('1', true),
      ambiguous: false,
    });
    expect(primaryCompanyLink([link('3', false)]).link?.company.id).toBe('3');
    expect(primaryCompanyLink([])).toEqual({ link: undefined, ambiguous: false });
  });
  it('never guesses between several candidates', () => {
    expect(primaryCompanyLink([link('1', false), link('2', false)])).toEqual({
      link: undefined,
      ambiguous: true,
    });
    expect(primaryCompanyLink([link('1', true), link('2', true)]).ambiguous).toBe(true);
  });
});
