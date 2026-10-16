import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  AccountContextMembershipWriter,
  AccountContextModule,
  AccountContextReadModel,
  AccountContextWriter,
} from '../modules/context';
import { SecretLikeValueError } from '../modules/domain';
import { GovernanceError, GovernanceModule } from '../modules/governance';
import {
  AuthorizationDeniedError,
  TenancyError,
  TenancyModule,
  TenantContextService,
} from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import { parseAssignments } from './extension-args';
import { fail } from './hubspot-context';
import { authorizeOperator, OperatorIdRequiredError } from './operator';

/**
 * AccountContext operator entry and read models (M10E plan §8, ADR 0031).
 * Every command names an operator (`--actor` or LIP_OPERATOR_ID, recorded as
 * asserted). Reads need `data.account_context.read`; writes need
 * `canonical.human_entry` and a reason code, plus adopted canonical ≥ 0.5 and
 * module `account_context` enabled (reads work whatever the gate, Q18/Q20).
 * Each call writes one audit event. Output is JSON with identifiers, codes
 * and dates; confidential values (the renewal date, confidential
 * dimensions; restricted values are never stored) are withheld unless
 * `--include-confidential`, which also needs
 * `data.account_context.read_confidential` — held only through an explicit
 * tenant grant (`security grant`, hardening #90). Without it the read is
 * refused (exit 2, `authorization_denied`, a `denied` audit event naming that
 * capability), never silently redacted; with it the read's audit event names
 * that capability and the released keys. No HTTP endpoint (M15).
 *
 *   pnpm --filter @lip/api account-context list   --tenant <slug> --account <id> [--account …]
 *                                                 [--include-confidential] --actor <id>
 *   pnpm --filter @lip/api account-context show   --tenant <slug> --context <id> [--lines]
 *                                                 [--include-confidential] --actor <id>
 *   pnpm --filter @lip/api account-context write  --tenant <slug> (--context <id> |
 *                                                 --account <id> --type <key> [--dim <key>=<v> …])
 *                                                 [--name <n>] [--status active|inactive] [--owner-ref <r>]
 *                                                 [--renewal-date YYYY-MM-DD] [--clear owner_ref|renewal_date]
 *                                                 --reason <code> --actor <id>
 *   pnpm --filter @lip/api account-context retire|reactivate|release --tenant <slug> --context <id>
 *                                                 --reason <code> --actor <id>
 *   pnpm --filter @lip/api account-context member add|end --tenant <slug> --context <id> --person <id>
 *                                                 --role <code> --reason <code> --actor <id>
 *   pnpm --filter @lip/api account-context product add --tenant <slug> --context <id> --product <key>
 *                                                 --reason <code> --actor <id>
 *   pnpm --filter @lip/api account-context line-assign --tenant <slug> --line <id> (--context <id> | --clear-context)
 *                                                 --reason <code> --actor <id>
 *
 * An operator write holds the attributes it set until `release` hands them back to the source (Q14).
 *
 * Exit codes: 2 refused or invalid, 1 unexpected failure.
 */
export const ACCOUNT_CONTEXT_CLI_COMMANDS = [
  'list',
  'show',
  'write',
  'retire',
  'reactivate',
  'release',
  'member add',
  'member end',
  'product add',
  'line-assign',
] as const;

const USAGE = [
  'account-context list --tenant <slug> --account <id> [--account …] [--include-confidential] --actor <id>',
  'account-context show --tenant <slug> --context <id> [--lines] [--include-confidential] --actor <id>',
  'account-context write --tenant <slug> (--context <id> | --account <id> --type <key> [--dim k=v …]) [--name …] [--status …] [--owner-ref …] [--renewal-date …] [--clear owner_ref|renewal_date] --reason <code> --actor <id>',
  'account-context retire|reactivate|release --tenant <slug> --context <id> --reason <code> --actor <id>',
  'account-context member add|end --tenant <slug> --context <id> --person <id> --role <code> --reason <code> --actor <id>',
  'account-context product add --tenant <slug> --context <id> --product <key> --reason <code> --actor <id>',
  'account-context line-assign --tenant <slug> --line <id> (--context <id> | --clear-context) --reason <code> --actor <id>',
].join('\n  ');

async function withAccountContext<T>(
  work: (app: INestApplicationContext) => Promise<T>,
): Promise<T> {
  const config = loadConfig();

  @Module({
    imports: [
      PlatformModule.forRoot(config),
      TenancyModule,
      GovernanceModule,
      AccountContextModule,
    ],
  })
  class AccountContextCliModule {}

  const app = await NestFactory.createApplicationContext(AccountContextCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    await app.init();
    return await work(app);
  } finally {
    await app.close();
  }
}

/** `--clear owner_ref|renewal_date` → the attributes set to null. */
function clears(values: readonly string[] | undefined): { ownerRef?: null; renewalDate?: null } {
  const out: { ownerRef?: null; renewalDate?: null } = {};
  for (const c of values ?? []) {
    if (c === 'owner_ref') out.ownerRef = null;
    else if (c === 'renewal_date') out.renewalDate = null;
    else throw new GovernanceError('validation_failed', '--clear takes owner_ref or renewal_date');
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const grouped = argv[0] === 'member' || argv[0] === 'product';
  const command = grouped ? `${argv[0]} ${argv[1] ?? ''}` : (argv[0] ?? '');
  const args = argv.slice(grouped ? 2 : 1);
  if (!(ACCOUNT_CONTEXT_CLI_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Usage:\n  ${USAGE}`);
  }
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: 'string' },
      actor: { type: 'string' },
      account: { type: 'string', multiple: true },
      context: { type: 'string' },
      type: { type: 'string' },
      dim: { type: 'string', multiple: true },
      name: { type: 'string' },
      status: { type: 'string' },
      'owner-ref': { type: 'string' },
      'renewal-date': { type: 'string' },
      clear: { type: 'string', multiple: true },
      person: { type: 'string' },
      role: { type: 'string' },
      product: { type: 'string' },
      line: { type: 'string' },
      'clear-context': { type: 'boolean', default: false },
      lines: { type: 'boolean', default: false },
      'include-confidential': { type: 'boolean', default: false },
      reason: { type: 'string' },
    },
  });
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const tenant = values.tenant;
  const correlationId = randomUUID();
  const reason = values.reason ?? '';
  const includeConfidential = values['include-confidential'] === true;
  let exitCode = 0;

  const result = await withAccountContext(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const human = (
      action:
        | 'account_context.write'
        | 'account_context.retire'
        | 'account_context.release'
        | 'account_context.member.set'
        | 'account_context.line.assign',
      targetRef?: string,
    ) =>
      authorizeOperator(app, ctx, 'canonical.human_entry', {
        actorFlag: values.actor,
        action,
        targetKind: 'account_context',
        ...(targetRef ? { targetRef } : {}),
        correlationId,
      });
    try {
      switch (command) {
        case 'list': {
          const actx = await authorizeOperator(app, ctx, 'data.account_context.read', {
            actorFlag: values.actor,
            action: 'account_context.read',
            targetKind: 'account_context',
            correlationId,
          });
          return await app.get(AccountContextReadModel).listForAccounts(actx, {
            companyIds: values.account ?? [],
            includeConfidential,
          });
        }
        case 'show': {
          const actx = await authorizeOperator(app, ctx, 'data.account_context.read', {
            actorFlag: values.actor,
            action: 'account_context.read',
            targetKind: 'account_context',
            ...(values.context ? { targetRef: values.context } : {}),
            correlationId,
          });
          const reads = app.get(AccountContextReadModel);
          const context = await reads.get(actx, {
            contextId: values.context ?? '',
            includeConfidential,
          });
          return {
            context,
            ...(values.lines
              ? { lines: await reads.linesForContext(actx, { contextId: values.context ?? '' }) }
              : {}),
          };
        }
        case 'write': {
          const actx = await human('account_context.write', values.context);
          const status = values.status;
          if (status !== undefined && status !== 'active' && status !== 'inactive') {
            throw new GovernanceError('validation_failed', '--status takes active or inactive');
          }
          if ((values.account?.length ?? 0) > 1) {
            throw new GovernanceError('validation_failed', 'write takes one --account');
          }
          const dims = parseAssignments(values.dim);
          return {
            context: await app.get(AccountContextWriter).write(actx, {
              ...(values.context ? { context: values.context } : {}),
              ...(values.account?.[0] ? { account: values.account[0] } : {}),
              ...(values.type ? { type: values.type } : {}),
              ...(values.dim
                ? {
                    dimensions: Object.fromEntries(
                      Object.entries(dims).map(([k, v]) => [k, v ?? '']),
                    ),
                  }
                : {}),
              ...(values.name !== undefined ? { name: values.name } : {}),
              ...(status ? { status } : {}),
              ...(values['owner-ref'] !== undefined ? { ownerRef: values['owner-ref'] } : {}),
              ...(values['renewal-date'] !== undefined
                ? { renewalDate: values['renewal-date'] }
                : {}),
              ...clears(values.clear),
              reason,
            }),
          };
        }
        case 'retire':
        case 'reactivate':
        case 'release': {
          const actx = await human(
            command === 'retire'
              ? 'account_context.retire'
              : command === 'release'
                ? 'account_context.release'
                : 'account_context.write',
            values.context,
          );
          const writer = app.get(AccountContextWriter);
          const input = { context: values.context ?? '', reason };
          return {
            context:
              command === 'retire'
                ? await writer.retire(actx, input)
                : command === 'release'
                  ? await writer.release(actx, input)
                  : await writer.reactivate(actx, input),
          };
        }
        case 'member add':
        case 'member end': {
          const actx = await human('account_context.member.set', values.context);
          const writer = app.get(AccountContextMembershipWriter);
          const input = {
            context: values.context ?? '',
            person: values.person ?? '',
            role: values.role ?? '',
            reason,
          };
          return {
            member:
              command === 'member add'
                ? await writer.add(actx, input)
                : await writer.end(actx, input),
          };
        }
        case 'product add': {
          const actx = await human('account_context.member.set', values.context);
          return {
            member: await app.get(AccountContextMembershipWriter).addProduct(actx, {
              context: values.context ?? '',
              product: values.product ?? '',
              reason,
            }),
          };
        }
        default: {
          if (values['clear-context'] === (values.context !== undefined)) {
            throw new GovernanceError(
              'validation_failed',
              'line-assign takes exactly one of --context or --clear-context',
            );
          }
          const actx = await human('account_context.line.assign', values.context ?? values.line);
          return {
            line: await app.get(AccountContextWriter).assignLine(actx, {
              line: values.line ?? '',
              context: values['clear-context'] ? null : (values.context ?? null),
              reason,
            }),
          };
        }
      }
    } catch (error) {
      if (
        error instanceof GovernanceError ||
        error instanceof TenancyError ||
        error instanceof AuthorizationDeniedError ||
        error instanceof OperatorIdRequiredError ||
        error instanceof SecretLikeValueError
      ) {
        exitCode = 2;
        return {
          ok: false,
          code:
            error instanceof SecretLikeValueError
              ? 'secret_like_value'
              : ((error as { code?: string }).code ?? 'operator_id_required'),
          message: error.message,
        };
      }
      throw error;
    }
  });
  process.stdout.write(`${JSON.stringify({ tenant, command, ...result }, null, 2)}\n`);
  process.exitCode = exitCode;
}

main().catch(fail);
