import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SecretLikeValueError } from '../modules/domain';
import {
  CustomRecordWriter,
  CustomRelationshipWriter,
  ExtensionModule,
  ExtensionReadModel,
  ExtensionValueWriter,
} from '../modules/extension';
import { GovernanceError, GovernanceModule, RegistryService } from '../modules/governance';
import {
  AuthorizationDeniedError,
  TenancyError,
  TenancyModule,
  TenantContextService,
} from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import { EXTENSION_CLI_COMMANDS, limitOf, parseAssignments } from './extension-args';
import { fail } from './hubspot-context';
import { authorizeOperator, OperatorIdRequiredError } from './operator';

/**
 * Extension framework operator entry and read models (M10D plan §8, §16;
 * ADR 0030). Every command but `registry show` names an operator (`--actor`
 * or LIP_OPERATOR_ID, recorded as asserted). Writes need
 * `canonical.human_entry` (policy v5, operator; honoured only by the M10C and
 * M10D operator commands) and a reason code; reads need `data.extension.read`.
 * Each call writes one audit event. Output is JSON with identifiers, codes and
 * dates; field values are printed only for `public` / `internal` fields unless
 * `--include-confidential` (audited). With an `account_context` target,
 * `--include-confidential` also needs an explicit grant of
 * data.account_context.read_confidential (hardening #90; refused with exit 2
 * `authorization_denied` otherwise). Restricted values are never stored. No
 * HTTP endpoint (M15). `extension:capture-draft` lives in the sources CLI
 * (it reads the connection's snapshot and profiles).
 *
 *   pnpm --filter @lip/api extension:registry show --tenant <slug>
 *   pnpm --filter @lip/api extension:values show   --tenant <slug> --target <kind>:<id> [--target …]
 *                                                  [--use display] [--fields a,b] [--include-confidential] --actor <id>
 *   pnpm --filter @lip/api extension:value set     --tenant <slug> --target <kind>:<id> --field <key> --value <v> --reason <code> --actor <id>
 *   pnpm --filter @lip/api extension:value clear   --tenant <slug> --target <kind>:<id> --field <key> --reason <code> --actor <id>
 *   pnpm --filter @lip/api extension:value release --tenant <slug> --target <kind>:<id> --field <key> --reason <code> --actor <id>
 *   pnpm --filter @lip/api extension:records list  --tenant <slug> --object <key> [--after <id>] [--limit <n>] --actor <id>
 *   pnpm --filter @lip/api extension:records show  --tenant <slug> --record <id> [--use display] [--include-confidential] --actor <id>
 *   pnpm --filter @lip/api extension:record create --tenant <slug> --object <key> [--parent <kind>:<id>]
 *                                                  [--set <field>=<value> …] --reason <code> --actor <id>
 *   pnpm --filter @lip/api extension:record update --tenant <slug> --record <id> [--set <field>=<value> …]
 *                                                  [--clear <field> …] --reason <code> --actor <id>
 *   pnpm --filter @lip/api extension:record retire|reactivate --tenant <slug> --record <id> --reason <code> --actor <id>
 *   pnpm --filter @lip/api extension:relationship add --tenant <slug> --relationship <key> --from <kind>:<id>
 *                                                  --to <kind>:<id> [--role <code>] --reason <code> --actor <id>
 *   pnpm --filter @lip/api extension:relationship end --tenant <slug> --edge <id> --reason <code> --actor <id>
 *
 * An operator value is sticky until `release` hands the field back to the source (Q16).
 *
 * Exit codes: 2 refused or invalid, 1 unexpected failure.
 */
async function withExtension<T>(work: (app: INestApplicationContext) => Promise<T>): Promise<T> {
  const config = loadConfig();

  @Module({
    imports: [PlatformModule.forRoot(config), TenancyModule, GovernanceModule, ExtensionModule],
  })
  class ExtensionCliModule {}

  const app = await NestFactory.createApplicationContext(ExtensionCliModule, {
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
  'extension registry show --tenant <slug>',
  'extension values show --tenant <slug> --target <kind>:<id> [--use <use>] [--fields a,b] [--include-confidential] --actor <id>',
  'extension value set|clear|release --tenant <slug> --target <kind>:<id> --field <key> [--value <v>] --reason <code> --actor <id>',
  'extension records list|show --tenant <slug> (--object <key> | --record <id>) --actor <id>',
  'extension record create|update|retire|reactivate --tenant <slug> ... --reason <code> --actor <id>',
  'extension relationship add|end --tenant <slug> ... --reason <code> --actor <id>',
].join('\n  ');

async function main(): Promise<void> {
  const [area, verb, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: 'string' },
      actor: { type: 'string' },
      target: { type: 'string', multiple: true },
      field: { type: 'string' },
      value: { type: 'string' },
      fields: { type: 'string' },
      use: { type: 'string' },
      'include-confidential': { type: 'boolean', default: false },
      object: { type: 'string' },
      record: { type: 'string' },
      parent: { type: 'string' },
      set: { type: 'string', multiple: true },
      clear: { type: 'string', multiple: true },
      after: { type: 'string' },
      limit: { type: 'string' },
      relationship: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      role: { type: 'string' },
      edge: { type: 'string' },
      reason: { type: 'string' },
    },
  });
  const command = `${area ?? ''} ${verb ?? ''}`.trim();
  if (!(EXTENSION_CLI_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Usage:\n  ${USAGE}`);
  }
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const tenant = values.tenant;
  const correlationId = randomUUID();
  const reason = values.reason ?? '';
  let exitCode = 0;

  const result = await withExtension(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    try {
      switch (command) {
        case 'registry show': {
          const shown = await app.get(RegistryService).show(ctx, 'extension');
          return {
            registry: {
              latest: shown.latest
                ? {
                    version: shown.latest.version,
                    contentHash: shown.latest.contentHash,
                    canonicalVersionMin: shown.latest.canonicalVersionMin,
                    publishedAt: shown.latest.publishedAt,
                    document: shown.latest.document,
                  }
                : null,
              entries: shown.entries,
            },
          };
        }
        case 'values show': {
          const targets = values.target ?? [];
          const actx = await authorizeOperator(app, ctx, 'data.extension.read', {
            actorFlag: values.actor,
            action: 'extension.read',
            targetKind: 'extension_value',
            ...(targets.length === 1 ? { targetRef: targets[0] } : {}),
            correlationId,
          });
          const fields = values.fields
            ?.split(',')
            .map((f) => f.trim())
            .filter((f) => f !== '');
          return {
            values: await app
              .get(ExtensionReadModel)
              .valuesFor(actx, values.use ?? 'display', targets, {
                ...(fields && fields.length > 0 ? { fields } : {}),
                includeConfidential: values['include-confidential'],
              }),
          };
        }
        case 'value set':
        case 'value clear':
        case 'value release': {
          const op = verb as 'set' | 'clear' | 'release';
          const target = values.target?.[0] ?? '';
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: `extension.value.${op}`,
            targetKind: 'extension_value',
            ...(target ? { targetRef: target } : {}),
            correlationId,
          });
          if ((values.target ?? []).length > 1) {
            throw new GovernanceError('validation_failed', 'One --target per value command');
          }
          const input = {
            target,
            field: values.field ?? '',
            ...(values.value !== undefined ? { value: values.value } : {}),
            reason,
          };
          const writer = app.get(ExtensionValueWriter);
          const out =
            op === 'set'
              ? await writer.set(actx, input)
              : op === 'clear'
                ? await writer.clear(actx, input)
                : await writer.release(actx, input);
          return { value: out };
        }
        case 'records list': {
          const actx = await authorizeOperator(app, ctx, 'data.extension.read', {
            actorFlag: values.actor,
            action: 'extension.read',
            targetKind: 'custom_record',
            correlationId,
          });
          const limit = limitOf(values.limit);
          return await app.get(ExtensionReadModel).records(actx, {
            object: values.object ?? '',
            ...(values.after ? { after: values.after } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
        }
        case 'records show': {
          const actx = await authorizeOperator(app, ctx, 'data.extension.read', {
            actorFlag: values.actor,
            action: 'extension.read',
            targetKind: 'custom_record',
            ...(values.record ? { targetRef: values.record } : {}),
            correlationId,
          });
          return {
            record: await app.get(ExtensionReadModel).record(actx, {
              record: values.record ?? '',
              ...(values.use ? { use: values.use } : {}),
              includeConfidential: values['include-confidential'],
            }),
          };
        }
        case 'record create': {
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: 'extension.record.create',
            targetKind: 'custom_record',
            correlationId,
          });
          const assigned = parseAssignments(values.set);
          return {
            record: await app.get(CustomRecordWriter).createRecord(actx, {
              object: values.object ?? '',
              ...(values.parent ? { parent: values.parent } : {}),
              values: Object.fromEntries(Object.entries(assigned).map(([k, v]) => [k, v ?? ''])),
              reason,
            }),
          };
        }
        case 'record update': {
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: 'extension.record.update',
            targetKind: 'custom_record',
            ...(values.record ? { targetRef: values.record } : {}),
            correlationId,
          });
          return {
            record: await app.get(CustomRecordWriter).update(actx, {
              record: values.record ?? '',
              values: parseAssignments(values.set, values.clear),
              reason,
            }),
          };
        }
        case 'record retire':
        case 'record reactivate': {
          const op = verb as 'retire' | 'reactivate';
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: `extension.record.${op}`,
            targetKind: 'custom_record',
            ...(values.record ? { targetRef: values.record } : {}),
            correlationId,
          });
          const writer = app.get(CustomRecordWriter);
          const input = { record: values.record ?? '', reason };
          return {
            record:
              op === 'retire'
                ? await writer.retire(actx, input)
                : await writer.reactivate(actx, input),
          };
        }
        case 'relationship add': {
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: 'extension.relationship.add',
            targetKind: 'custom_relationship',
            correlationId,
          });
          return {
            relationship: await app.get(CustomRelationshipWriter).add(actx, {
              relationship: values.relationship ?? '',
              from: values.from ?? '',
              to: values.to ?? '',
              ...(values.role ? { role: values.role } : {}),
              reason,
            }),
          };
        }
        default: {
          const actx = await authorizeOperator(app, ctx, 'canonical.human_entry', {
            actorFlag: values.actor,
            action: 'extension.relationship.end',
            targetKind: 'custom_relationship',
            ...(values.edge ? { targetRef: values.edge } : {}),
            correlationId,
          });
          return {
            relationship: await app
              .get(CustomRelationshipWriter)
              .endEdge(actx, { edge: values.edge ?? '', reason }),
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
