import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  AccountHierarchyWriter,
  AccountStructureModule,
  AccountStructureReadModel,
  PersonAffiliationWriter,
} from '../modules/context';
import { GovernanceError } from '../modules/governance';
import {
  AuthorizationDeniedError,
  TenancyError,
  TenancyModule,
  TenantContextService,
} from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import { fail } from './hubspot-context';
import { authorizeOperator, OperatorIdRequiredError } from './operator';

/**
 * Account hierarchy and Person–Account affiliation, operator entry and read
 * models (M10C plan §2.5, §3.2, §5; ADR 0029). Every command names an operator
 * (`--actor` or LIP_OPERATOR_ID, recorded as asserted). Writes need
 * `canonical.human_entry` (policy v4, operator; honoured only by these
 * commands) and a reason code; reads need `data.account_structure.read`. Each
 * call writes one audit event. Output is JSON with identifiers, codes and
 * dates only. No HTTP endpoint (M15).
 *
 *   pnpm --filter @lip/api account:hierarchy show    --tenant <slug> --company <id> [--descendants] --actor <id>
 *   pnpm --filter @lip/api account:hierarchy set     --tenant <slug> --company <id> --parent <id> --reason <code> --actor <id>
 *   pnpm --filter @lip/api account:hierarchy clear   --tenant <slug> --company <id> --reason <code> --actor <id>
 *   pnpm --filter @lip/api account:hierarchy release --tenant <slug> --company <id> --reason <code> --actor <id>
 *   pnpm --filter @lip/api person:affiliations       --tenant <slug> (--person <id> | --company <id>) [--active] --actor <id>
 *   pnpm --filter @lip/api person:affiliation add    --tenant <slug> --person <id> --company <id> [--roles a,b]
 *                                                    [--starts-at <iso>] [--ends-at <iso>] --reason <code> --actor <id>
 *   pnpm --filter @lip/api person:affiliation end    --tenant <slug> --affiliation <id> [--ends-at <iso>] --reason <code> --actor <id>
 *   pnpm --filter @lip/api person:affiliation release --tenant <slug> --person <id> --company <id> --reason <code> --actor <id>
 *
 * An operator `end` (also of a source row an operator `add` replaced) is sticky:
 * the source does not re-create the pair until `release` hands it back.
 *
 * Exit codes: 2 refused or invalid, 1 unexpected failure.
 */
async function withAccountStructure<T>(
  work: (app: INestApplicationContext) => Promise<T>,
): Promise<T> {
  const config = loadConfig();

  @Module({ imports: [PlatformModule.forRoot(config), TenancyModule, AccountStructureModule] })
  class AccountCliModule {}

  const app = await NestFactory.createApplicationContext(AccountCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    await app.init();
    return await work(app);
  } finally {
    await app.close();
  }
}

const USAGE = [
  'account:hierarchy show|set|clear|release --tenant <slug> --company <id> [--parent <id>] [--descendants] [--reason <code>] --actor <id>',
  'person:affiliations --tenant <slug> (--person <id> | --company <id>) [--active] --actor <id>',
  'person:affiliation add|end|release --tenant <slug> ... --reason <code> --actor <id>',
].join('\n  ');

/**
 * An ISO-8601 date (`2026-01-01`, read as UTC midnight) or an instant with an
 * explicit zone (`Z` or `+hh:mm` / `-hh:mm`). A zone-less date-time would be
 * read in the server's local zone, so it is refused (review n6).
 */
function date(value: string | undefined, flag: string): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const zonedInstant = /^\d{4}-\d{2}-\d{2}T\S+(Z|[+-]\d{2}:\d{2})$/.test(value);
  if (!(dateOnly || zonedInstant) || Number.isNaN(d.getTime())) {
    throw new GovernanceError(
      'validation_failed',
      `${flag} must be an ISO-8601 date or an instant with a zone`,
    );
  }
  return d;
}

async function main(): Promise<void> {
  const [area, maybeVerb, ...rest] = process.argv.slice(2);
  const verb = area === 'affiliations' ? 'list' : maybeVerb;
  const args = area === 'affiliations' ? [maybeVerb, ...rest].filter((a) => a !== undefined) : rest;
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: 'string' },
      actor: { type: 'string' },
      company: { type: 'string' },
      parent: { type: 'string' },
      person: { type: 'string' },
      affiliation: { type: 'string' },
      roles: { type: 'string' },
      'starts-at': { type: 'string' },
      'ends-at': { type: 'string' },
      reason: { type: 'string' },
      descendants: { type: 'boolean', default: false },
      active: { type: 'boolean', default: false },
    },
  });
  const command = `${area ?? ''} ${verb ?? ''}`.trim();
  const known = [
    'hierarchy show',
    'hierarchy set',
    'hierarchy clear',
    'hierarchy release',
    'affiliations list',
    'affiliation add',
    'affiliation end',
    'affiliation release',
  ];
  if (!known.includes(command)) throw new Error(`Usage:\n  ${USAGE}`);
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const tenant = values.tenant;
  const correlationId = randomUUID();
  let exitCode = 0;

  const result = await withAccountStructure(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    try {
      switch (command) {
        case 'hierarchy show': {
          const actx = await authorizeOperator(app, ctx, 'data.account_structure.read', {
            actorFlag: values.actor,
            action: 'account_structure.read',
            targetKind: 'account_hierarchy',
            correlationId,
          });
          return {
            hierarchy: await app.get(AccountStructureReadModel).hierarchy(actx, {
              companyId: values.company ?? '',
              descendants: values.descendants,
            }),
          };
        }
        case 'affiliations list': {
          const actx = await authorizeOperator(app, ctx, 'data.account_structure.read', {
            actorFlag: values.actor,
            action: 'account_structure.read',
            targetKind: 'person_affiliation',
            correlationId,
          });
          return await app.get(AccountStructureReadModel).affiliations(actx, {
            ...(values.person ? { personId: values.person } : {}),
            ...(values.company ? { companyId: values.company } : {}),
            activeOnly: values.active,
          });
        }
        case 'hierarchy set':
        case 'hierarchy clear':
        case 'hierarchy release': {
          const op = verb as 'set' | 'clear' | 'release';
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: `account.hierarchy.${op}`,
            targetKind: 'account_hierarchy',
            ...(values.company ? { targetRef: values.company } : {}),
            correlationId,
          });
          const input = {
            companyId: values.company ?? '',
            ...(values.parent ? { parentId: values.parent } : {}),
            reason: values.reason ?? '',
          };
          const writer = app.get(AccountHierarchyWriter);
          const out =
            op === 'set'
              ? await writer.set(actx, input)
              : op === 'clear'
                ? await writer.clear(actx, input)
                : await writer.release(actx, input);
          return { hierarchy: out };
        }
        case 'affiliation add': {
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: 'person.affiliation.add',
            targetKind: 'person_affiliation',
            correlationId,
          });
          const startsAt = date(values['starts-at'], '--starts-at');
          const endsAt = date(values['ends-at'], '--ends-at');
          return {
            affiliation: await app.get(PersonAffiliationWriter).add(actx, {
              personId: values.person ?? '',
              companyId: values.company ?? '',
              roleCodes: values.roles ? values.roles.split(',').map((r) => r.trim()) : [],
              ...(startsAt ? { startsAt } : {}),
              ...(endsAt ? { endsAt } : {}),
              reason: values.reason ?? '',
            }),
          };
        }
        case 'affiliation release': {
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: 'person.affiliation.release',
            targetKind: 'person_affiliation',
            correlationId,
          });
          return {
            affiliation: await app.get(PersonAffiliationWriter).release(actx, {
              personId: values.person ?? '',
              companyId: values.company ?? '',
              reason: values.reason ?? '',
            }),
          };
        }
        default: {
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: 'person.affiliation.end',
            targetKind: 'person_affiliation',
            ...(values.affiliation ? { targetRef: values.affiliation } : {}),
            correlationId,
          });
          const endsAt = date(values['ends-at'], '--ends-at');
          return {
            affiliation: await app.get(PersonAffiliationWriter).end(actx, {
              affiliationId: values.affiliation ?? '',
              ...(endsAt ? { endsAt } : {}),
              reason: values.reason ?? '',
            }),
          };
        }
      }
    } catch (error) {
      if (
        error instanceof GovernanceError ||
        error instanceof TenancyError ||
        error instanceof AuthorizationDeniedError ||
        error instanceof OperatorIdRequiredError
      ) {
        exitCode = 2;
        return {
          ok: false,
          code: (error as { code?: string }).code ?? 'operator_id_required',
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
