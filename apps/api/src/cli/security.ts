import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GovernanceModule, IntegrityVerificationService } from '../modules/governance';
import { SecurityOperationsService, TenancyModule, TenantContextService } from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import { fail } from './hubspot-context';
import { authorizeOperator } from './operator';

/**
 * Security operations (M10A1 plan §5.1, §10, §13). Tenant-scoped; output is
 * JSON with codes, counts, key ids and sequence numbers only — never a token,
 * key, hash input or record value.
 *
 *   pnpm --filter @lip/api security:key-usage    --tenant <slug>
 *   pnpm --filter @lip/api security:rekey        --tenant <slug> [--actor <id> --execute]
 *   pnpm --filter @lip/api security:audit-verify --tenant <slug> --actor <id>   (exit 3 if the chain is broken)
 *   pnpm --filter @lip/api security:audit-purge  --tenant <slug> [--actor <id> --execute]
 *   pnpm --filter @lip/api security:integrity-verify --tenant <slug> [--actor <id> --execute]   (exit 3 on findings)
 *
 * `--actor` (or LIP_OPERATOR_ID) is required for every `--execute` and for the
 * audit read (owner decision Q1); it is recorded as asserted, not authenticated.
 * Audit purge execution is refused (`audit_purge_disabled`) until the formal
 * privacy/retention policy is approved; without `--execute` it only reports.
 * A key rotation: add PLATFORM_TOKEN_ENCRYPTION_KEY_<KID> → set
 * PLATFORM_TOKEN_ENCRYPTION_KEY_ID=<kid> and list the old id in
 * PLATFORM_TOKEN_ENCRYPTION_PREVIOUS_KEY_IDS → `security:rekey --execute` per
 * tenant → `security:key-usage` shows 0 for the old id → remove the old key.
 * The audit-purge report reads the security_audit retention from the tenant's
 * published data policy (M10A2), else the product default.
 * Integrity verification (M10A2, ADR 0027) is read-only on canonical data:
 * without `--execute` it reports; with `--execute` it also records the run
 * (one audit event). Findings are never repaired (forward-fix only); the
 * automatic schedule stays off until M10M.
 */
async function withSecurity<T>(work: (app: INestApplicationContext) => Promise<T>): Promise<T> {
  const config = loadConfig();

  @Module({ imports: [PlatformModule.forRoot(config), TenancyModule, GovernanceModule] })
  class SecurityCliModule {}

  const app = await NestFactory.createApplicationContext(SecurityCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    await app.init();
    return await work(app);
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      tenant: { type: 'string' },
      actor: { type: 'string' },
      execute: { type: 'boolean', default: false },
    },
  });
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const tenant = values.tenant;
  const correlationId = randomUUID();
  let exitCode = 0;

  const result = await withSecurity(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const ops = app.get(SecurityOperationsService);
    switch (command) {
      case 'key-usage':
        return ops.keyUsage(ctx);
      case 'rekey':
        return ops.rekey(
          values.execute
            ? await authorizeOperator(app, ctx, 'security.key.rotate', {
                actorFlag: values.actor,
                action: 'security.rekey',
                targetKind: 'key',
                correlationId,
              })
            : ctx,
          { execute: values.execute },
        );
      case 'audit-verify': {
        const actx = await authorizeOperator(app, ctx, 'security.audit.read', {
          actorFlag: values.actor,
          action: 'security.audit.verify',
          targetKind: 'audit',
          correlationId,
        });
        const verdict = await ops.verifyChain(actx);
        if (!verdict.ok) exitCode = 3;
        return verdict.ok
          ? { ok: true, events: verdict.events }
          : {
              ok: false,
              events: verdict.events,
              brokenAtSeq: verdict.brokenAtSeq,
              reason: verdict.reason,
            };
      }
      case 'audit-purge':
        return ops.purge(
          values.execute
            ? await authorizeOperator(app, ctx, 'data.purge', {
                actorFlag: values.actor,
                action: 'security.audit.purge',
                targetKind: 'audit',
                correlationId,
              })
            : ctx,
          { execute: values.execute, ownerDatabaseUrl: process.env.MIGRATION_DATABASE_URL },
        );
      case 'integrity-verify': {
        const integrity = app.get(IntegrityVerificationService);
        const report = values.execute
          ? await integrity.record(
              await authorizeOperator(app, ctx, 'security.integrity.run', {
                actorFlag: values.actor,
                action: 'integrity.verify',
                targetKind: 'integrity_run',
                correlationId,
              }),
            )
          : await integrity.verify(ctx);
        if (report.outcome !== 'passed') exitCode = 3;
        return { dryRun: !values.execute, ...report };
      }
      default:
        throw new Error(
          'Usage: security <key-usage|rekey|audit-verify|audit-purge|integrity-verify> --tenant <slug> [--actor <id>] [--execute]',
        );
    }
  });
  process.stdout.write(`${JSON.stringify({ tenant, command, ...result }, null, 2)}\n`);
  process.exitCode = exitCode;
}

main().catch(fail);
