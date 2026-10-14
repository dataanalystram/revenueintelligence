import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ENTITY_INDEX_KINDS, type EntityIndexKind } from '../modules/domain';
import { GovernanceError, GovernanceModule, ProvenanceQueryService } from '../modules/governance';
import { TenancyError, TenancyModule, TenantContextService } from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import { fail } from './hubspot-context';
import { authorizeOperator } from './operator';

/**
 * Provenance read model (M10B plan §5, ADR 0028). Read-only on canonical data;
 * each call names an operator (`--actor` or LIP_OPERATOR_ID, recorded as
 * asserted; capability data.provenance.read) and writes one `provenance.read`
 * audit event. Output is JSON with identifiers, codes and timestamps (plus
 * recorded non-sensitive history values). No HTTP endpoint in M10B (Q18).
 *
 *   pnpm --filter @lip/api provenance:show --tenant <slug> --kind <kind> (--id <uuid> | --key <key>)
 *                                          [--field <field>] --actor <id>
 *
 * Exit codes: 2 refused or invalid, 1 unexpected failure.
 */
async function withGovernance<T>(work: (app: INestApplicationContext) => Promise<T>): Promise<T> {
  const config = loadConfig();

  @Module({ imports: [PlatformModule.forRoot(config), TenancyModule, GovernanceModule] })
  class ProvenanceCliModule {}

  const app = await NestFactory.createApplicationContext(ProvenanceCliModule, {
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
      kind: { type: 'string' },
      id: { type: 'string' },
      key: { type: 'string' },
      field: { type: 'string' },
    },
  });
  if (command !== 'show') {
    throw new Error(
      'Usage: provenance show --tenant <slug> --kind <kind> (--id <uuid> | --key <key>) [--field <f>] --actor <id>',
    );
  }
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const kind = values.kind;
  if (!kind || !(ENTITY_INDEX_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`--kind is required (${ENTITY_INDEX_KINDS.join(' | ')})`);
  }
  const tenant = values.tenant;
  const correlationId = randomUUID();
  let exitCode = 0;

  const result = await withGovernance(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    try {
      const actx = await authorizeOperator(app, ctx, 'data.provenance.read', {
        actorFlag: values.actor,
        action: 'provenance.read',
        targetKind: 'provenance',
        correlationId,
      });
      return {
        provenance: await app.get(ProvenanceQueryService).show(actx, {
          kind: kind as EntityIndexKind,
          ...(values.id ? { id: values.id } : {}),
          ...(values.key ? { key: values.key } : {}),
          ...(values.field ? { field: values.field } : {}),
        }),
      };
    } catch (error) {
      if (error instanceof GovernanceError || error instanceof TenancyError) {
        exitCode = 2;
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
  });
  process.stdout.write(`${JSON.stringify({ tenant, command, ...result }, null, 2)}\n`);
  process.exitCode = exitCode;
}

main().catch(fail);
