import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../../platform/database';
import { PRIVILEGE_MANIFEST, TABLE_PRIVILEGES } from '../security/privilege-manifest';
import { SecurityEventsService } from '../security/security-events.service';

/**
 * Runtime privilege check (M10A1 plan §8, §15): at start-up, the connected
 * role's table privileges are compared with the manifest. A difference (a
 * missing or an extra privilege, or a table the manifest does not know) is a
 * `privilege_manifest_mismatch` security event per table — detection, not a
 * refusal: the role guard already refuses roles that bypass row-level
 * security, and the schema guard test enforces the manifest in CI.
 */
@Injectable()
export class PrivilegeManifestCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(PrivilegeManifestCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: SecurityEventsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      // An unreachable database is reported by readiness, not here.
      this.logger.error({ err }, 'Could not compare the role privileges with the manifest');
    }
  }

  /** Tables whose privileges differ from the manifest (also emitted as events). */
  async run(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<
      { table: string; privilege: string; granted: boolean }[]
    >`
      SELECT c.relname AS table, p.privilege,
             has_table_privilege(current_user, c.oid, p.privilege) AS granted
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(${[...TABLE_PRIVILEGES]}::text[]) AS p(privilege)
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')`;
    const actual = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!actual.has(r.table)) actual.set(r.table, new Set());
      if (r.granted) actual.get(r.table)!.add(r.privilege);
    }
    const mismatched: string[] = [];
    for (const [table, granted] of actual) {
      const expected = PRIVILEGE_MANIFEST[table];
      const extra = [...granted].filter((p) => !expected?.includes(p as never));
      const missing = (expected ?? []).filter((p) => !granted.has(p));
      if (!expected || extra.length > 0 || missing.length > 0) {
        mismatched.push(table);
        this.events.emit({
          event: 'privilege_manifest_mismatch',
          outcome: 'detected',
          reasonCode: expected ? 'privileges_differ' : 'table_not_in_manifest',
          coordinates: { table, extra: extra.sort().join(','), missing: missing.join(',') },
        });
      }
    }
    return mismatched.sort();
  }
}
