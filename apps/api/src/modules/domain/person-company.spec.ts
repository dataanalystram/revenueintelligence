import { describe, expect, it } from 'vitest';
import { at, ids } from '../../../test/fixtures/domain';
import { CompanySchema, isCustomer, ownsProduct, type CompanyInput } from './company';
import { EmailAddressSchema, emailDomain } from './email';
import { ProductKeySchema, ProductOwnershipSchema } from './product';
import { hasRole, PersonSchema, personDisplayName, personEmails, type PersonInput } from './person';

const person = (over: Partial<PersonInput> = {}) =>
  PersonSchema.parse({
    id: ids.person,
    tenantId: ids.tenant,
    primaryEmail: 'John.Smith@ABCSchool.org.uk ',
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  });

const company = (over: Partial<CompanyInput> = {}) =>
  CompanySchema.parse({
    id: ids.company,
    tenantId: ids.tenant,
    name: 'ABC Academy',
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  });

describe('M6 identity rules (ADR 0014)', () => {
  it('a person may have no email; display falls back to undefined, never a placeholder', () => {
    const p = person({ primaryEmail: undefined });
    expect(p.primaryEmail).toBeUndefined();
    expect(personDisplayName(p)).toBeUndefined();
    expect(personEmails(p)).toEqual([]);
    expect(person({ primaryEmail: undefined, firstName: 'Ann' }).firstName).toBe('Ann');
  });

  it('an invalid email is still refused when present', () => {
    expect(() => person({ primaryEmail: 'not-an-email' })).toThrow();
  });

  it('a company may have no name, but never a blank one', () => {
    expect(company({ name: undefined }).name).toBeUndefined();
    expect(() => company({ name: '   ' })).toThrow();
  });

  it('record state defaults to active; merged requires mergedIntoId and never self', () => {
    expect(company().recordState).toBe('active');
    expect(person().recordState).toBe('active');
    expect(() => company({ recordState: 'merged' })).toThrow(/mergedIntoId/);
    expect(() => person({ mergedIntoId: ids.otherPerson })).toThrow(/mergedIntoId/);
    expect(() => company({ recordState: 'merged', mergedIntoId: ids.company })).toThrow(/itself/);
    expect(company({ recordState: 'merged', mergedIntoId: ids.otherCompany }).mergedIntoId).toBe(
      ids.otherCompany,
    );
    expect(company({ recordState: 'inactive' }).recordState).toBe('inactive');
  });
});

describe('EmailAddress', () => {
  it('normalises case and whitespace', () => {
    const email = EmailAddressSchema.parse('  Sarah.Jones@Juniper.EXAMPLE ');
    expect(email).toBe('sarah.jones@juniper.example');
    expect(emailDomain(email)).toBe('juniper.example');
  });

  it.each(['', 'no-at-sign', 'a@', '@b.com', 'a b@c.com'])('rejects %j', (value) => {
    expect(EmailAddressSchema.safeParse(value).success).toBe(false);
  });
});

describe('Person', () => {
  it('applies defaults and normalises email', () => {
    const p = person();
    expect(p.primaryEmail).toBe('john.smith@abcschool.org.uk');
    expect(p.roles).toEqual([]);
    expect(p.externalRefs).toEqual([]);
    expect(personDisplayName(p)).toBe('john.smith@abcschool.org.uk');
  });

  it('exposes names, emails and roles', () => {
    const p = person({
      firstName: 'John',
      lastName: 'Smith',
      additionalEmails: ['j.smith@home.example'],
      roles: ['decision_maker'],
    });
    expect(personDisplayName(p)).toBe('John Smith');
    expect(personEmails(p)).toEqual(['john.smith@abcschool.org.uk', 'j.smith@home.example']);
    expect(hasRole(p, 'decision_maker')).toBe(true);
    expect(hasRole(p, 'end_user')).toBe(false);
  });

  it.each<[string, Partial<PersonInput>]>([
    ['repeated primary email', { additionalEmails: ['JOHN.SMITH@abcschool.org.uk'] }],
    ['duplicate role', { roles: ['end_user', 'end_user'] }],
    ['unknown role', { roles: ['ceo' as never] }],
    ['updatedAt before createdAt', { createdAt: at(10), updatedAt: at(0) }],
    ['foreign tenant id format', { tenantId: 'juniper' }],
  ])('rejects %s', (_label, over) => {
    expect(() => person(over)).toThrow();
  });

  it('is immutable', () => {
    const p = person();
    expect(Object.isFrozen(p)).toBe(true);
  });
});

describe('Company and product ownership', () => {
  const marketplace = ProductKeySchema.parse('marketplace');
  const portal = ProductKeySchema.parse('portal');
  const mis = ProductKeySchema.parse('mis');

  it('knows which products are currently owned', () => {
    const c = company({
      customerStatus: 'customer',
      domains: ['ABCAcademy.sch.uk'],
      products: [
        { productKey: 'portal', status: 'active' },
        { productKey: 'marketplace', status: 'trial' },
        { productKey: 'mis', status: 'churned' },
      ],
    });
    expect(c.domains).toEqual(['abcacademy.sch.uk']);
    expect(isCustomer(c)).toBe(true);
    expect(ownsProduct(c, portal)).toBe(true);
    expect(ownsProduct(c, marketplace)).toBe(true);
    expect(ownsProduct(c, mis)).toBe(false);
  });

  it.each<[string, Partial<CompanyInput>]>([
    [
      'duplicate product',
      {
        products: [
          { productKey: 'mis', status: 'active' },
          { productKey: 'mis', status: 'churned' },
        ],
      },
    ],
    ['invalid domain', { domains: ['not a domain'] }],
    ['duplicate domain', { domains: ['abc.sch.uk', 'ABC.sch.uk'] }],
    ['blank name', { name: '  ' }],
  ])('rejects %s', (_label, over) => {
    expect(() => company(over)).toThrow();
  });

  it('rejects an ownership period that ends before it starts', () => {
    expect(
      ProductOwnershipSchema.safeParse({
        productKey: 'mis',
        status: 'expired',
        since: at(10),
        until: at(0),
      }).success,
    ).toBe(false);
  });
});
