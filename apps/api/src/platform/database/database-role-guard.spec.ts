import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  assessRole,
  DatabaseRoleGuard,
  roleRefusalCode,
  UnsafeDatabaseRoleError,
  type RoleFacts,
} from './database-role-guard';

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

describe('DatabaseRoleGuard security event (M10A1 §15)', () => {
  it('a refused role emits role_guard_refused (code only) and counts it', async () => {
    const counted: unknown[] = [];
    const prisma = {
      $queryRaw: () =>
        Promise.resolve([
          {
            current_user: 'admin_role',
            rolsuper: true,
            rolbypassrls: false,
            is_member: true,
            tenancy_installed: true,
          },
        ]),
    };
    const metrics = {
      increment: (name: string, labels: unknown) => counted.push({ name, labels }),
    };
    const guard = new DatabaseRoleGuard(
      prisma as never,
      { database: { allowPrivilegedRole: false } } as never,
      metrics as never,
    );
    const logs: unknown[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void logs.push(m));
    await expect(guard.ensureSafe()).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
    expect(counted).toEqual([
      {
        name: 'lip_security_events_total',
        labels: { event: 'role_guard_refused', outcome: 'refused' },
      },
    ]);
    expect(logs).toEqual([
      expect.objectContaining({ event: 'role_guard_refused', reasonCode: 'superuser' }),
    ]);
    expect(JSON.stringify(logs)).not.toContain('admin_role');
    expect(roleRefusalCode({ ...safe, isAppRoleMember: false })).toBe('not_app_role_member');
    vi.restoreAllMocks();
  });
});
