import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { MetricsService } from '../metrics';
import { PrismaService } from './prisma.service';

/** The group role that holds the application's table privileges (see the M2 migration). */
export const APP_DATABASE_ROLE = 'lip_app';

export interface RoleFacts {
  readonly currentUser: string;
  readonly isSuperuser: boolean;
  readonly bypassesRls: boolean;
  readonly isAppRoleMember: boolean;
  readonly tenancyInstalled: boolean;
}

export type RoleAssessment =
  | { readonly safe: true; readonly warning?: string }
  | { readonly safe: false; readonly reason: string };

export class UnsafeDatabaseRoleError extends Error {
  constructor(reason: string) {
    super(`Refusing to use the database connection: ${reason}`);
    this.name = 'UnsafeDatabaseRoleError';
  }
}

/**
 * Pure decision: may the process run with this database role?
 * Tenant isolation relies on row-level security, which superusers and
 * BYPASSRLS roles silently ignore, so those roles are refused.
 */
export function assessRole(facts: RoleFacts, allowPrivilegedRole: boolean): RoleAssessment {
  if (!facts.tenancyInstalled) {
    return { safe: false, reason: 'tenancy schema not installed; run database migrations' };
  }
  const privileged = facts.isSuperuser || facts.bypassesRls;
  if (privileged) {
    const reason = `role "${facts.currentUser}" is ${facts.isSuperuser ? 'a superuser' : 'BYPASSRLS'}; row-level security would not apply`;
    return allowPrivilegedRole
      ? { safe: true, warning: `${reason} (allowed by DATABASE_ALLOW_PRIVILEGED_ROLE)` }
      : { safe: false, reason };
  }
  if (!facts.isAppRoleMember) {
    return {
      safe: false,
      reason: `role "${facts.currentUser}" is not a member of ${APP_DATABASE_ROLE}`,
    };
  }
  return { safe: true };
}

/** A stable code for a refused role (never the role name). */
export function roleRefusalCode(facts: RoleFacts): string {
  if (!facts.tenancyInstalled) return 'tenancy_not_installed';
  if (facts.isSuperuser) return 'superuser';
  if (facts.bypassesRls) return 'bypassrls';
  return 'not_app_role_member';
}

/**
 * Verifies at start-up (and on every readiness check until it succeeds) that
 * the process is connected with a role subject to row-level security.
 * An unsafe role stops the process; an unreachable database does not (the
 * readiness probe reports it instead).
 */
@Injectable()
export class DatabaseRoleGuard implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseRoleGuard.name);
  private verified = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureSafe();
    } catch (err) {
      if (err instanceof UnsafeDatabaseRoleError) throw err;
      this.logger.error(
        { err },
        'Could not verify the database role at start-up; readiness will retry',
      );
    }
  }

  /** Throws UnsafeDatabaseRoleError if the role is unsafe; caches success. */
  async ensureSafe(): Promise<void> {
    if (this.verified) return;
    const facts = await this.readFacts();
    const assessment = assessRole(facts, this.config.database.allowPrivilegedRole);
    if (!assessment.safe) {
      // M10A1 §15: the same security-event shape and counter as the tenancy emitter
      // (the platform layer cannot depend on modules). Codes only.
      this.metrics?.increment('lip_security_events_total', {
        event: 'role_guard_refused',
        outcome: 'refused',
      });
      this.logger.warn({
        msg: 'Security event',
        security_event: true,
        event: 'role_guard_refused',
        outcome: 'refused',
        reasonCode: roleRefusalCode(facts),
      });
      throw new UnsafeDatabaseRoleError(assessment.reason);
    }
    if (assessment.warning) this.logger.warn(assessment.warning);
    this.verified = true;
  }

  private async readFacts(): Promise<RoleFacts> {
    const [row] = await this.prisma.$queryRaw<
      {
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        is_member: boolean;
        tenancy_installed: boolean;
      }[]
    >`
      SELECT current_user::text AS current_user,
             r.rolsuper,
             r.rolbypassrls,
             EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_DATABASE_ROLE})
               AND pg_has_role(current_user, ${APP_DATABASE_ROLE}, 'MEMBER') AS is_member,
             to_regprocedure('app_current_tenant()') IS NOT NULL AS tenancy_installed
      FROM pg_roles r
      WHERE r.rolname = current_user`;
    if (!row) throw new Error('Could not read the current database role');
    return {
      currentUser: row.current_user,
      isSuperuser: row.rolsuper,
      bypassesRls: row.rolbypassrls,
      isAppRoleMember: row.is_member,
      tenancyInstalled: row.tenancy_installed,
    };
  }
}
