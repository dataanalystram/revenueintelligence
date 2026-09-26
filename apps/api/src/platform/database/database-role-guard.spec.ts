import { describe, expect, it } from 'vitest';
import { assessRole, type RoleFacts } from './database-role-guard';

const safe: RoleFacts = {
  currentUser: 'lip_api',
  isSuperuser: false,
  bypassesRls: false,
  isAppRoleMember: true,
  tenancyInstalled: true,
};

describe('assessRole', () => {
  it('accepts a plain member of lip_app', () => {
    expect(assessRole(safe, false)).toEqual({ safe: true });
  });

  it.each<[string, Partial<RoleFacts>, RegExp]>([
    ['a superuser', { isSuperuser: true }, /superuser/],
    ['a BYPASSRLS role', { bypassesRls: true }, /BYPASSRLS/],
    ['a non-member', { isAppRoleMember: false }, /not a member of lip_app/],
    ['an unmigrated database', { tenancyInstalled: false }, /run database migrations/],
  ])('refuses %s', (_label, facts, reason) => {
    const result = assessRole({ ...safe, ...facts }, false);
    expect(result.safe).toBe(false);
    expect(!result.safe && result.reason).toMatch(reason);
  });

  it('the override allows privileged roles with a warning, but never an unmigrated database', () => {
    expect(assessRole({ ...safe, isSuperuser: true }, true)).toMatchObject({
      safe: true,
      warning: expect.stringMatching(/superuser/),
    });
    expect(assessRole({ ...safe, isSuperuser: true, tenancyInstalled: false }, true).safe).toBe(
      false,
    );
  });
});
