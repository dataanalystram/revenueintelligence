import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  BulkSyncService,
  CONTEXT_KINDS,
  ContextIntakeModule,
  ContextModule,
  ContextOperationsService,
} from '../modules/context';
import type { ReceiptStatus } from '../modules/crm';
import {
  ContextKindSchema,
  ExternalSystemSchema,
  type AuditAction,
  type Capability,
  type ContextKind,
} from '../modules/domain';
import { HubSpotModule } from '../modules/hubspot';
import { SubscriptionMergeModule, SubscriptionMergeParticipant } from '../modules/products';
import { TenancyModule, TenantContextService } from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import { fail } from './hubspot-context';
import { authorizeOperator } from './operator';

/**
 * Context-processing operations (M6, ADR 0013/0014). Tenant-scoped; every
 * command that changes anything is a dry run unless `--execute` is given.
 * Output is JSON with identifiers, counts, states and hashes only — never
 * names, emails or other record values.
 *
 *   pnpm --filter @lip/api context:report      --tenant <slug>
 *   pnpm --filter @lip/api context:receipts    --tenant <slug> [--only-reason pre_m6] [--since ISO] [--until ISO]
 *                                              [--status pending,retrying] [--include-finished] [--limit N] [--execute]
 *   pnpm --filter @lip/api context:backfill    --tenant <slug> --kind company|person|all [--page-size N]
 *                                              [--max-records N] [--resume <checkpointId>] [--execute]
 *   pnpm --filter @lip/api context:reconcile   --tenant <slug> --kind company|person|all [--since ISO] [--execute]
 *   pnpm --filter @lip/api context:replay      --tenant <slug> (--dead-letter <id>[,<id>] | --code <code>
 *                                              | --subject hubspot:company|person:<id>) [--execute]
 *   pnpm --filter @lip/api context:dead-letters --tenant <slug> [--state open|replayed|discarded] [--code C]
 *                                              [--discard <id>[,<id>] --reason <code> --execute]
 *   pnpm --filter @lip/api context:show        --tenant <slug> --kind company|person --ref hubspot:<objectType>:<id>
 *   pnpm --filter @lip/api context:state-hash  --tenant <slug>
 *
 * Enqueued work is processed by the worker (CONTEXT_PROCESSING_ENABLED=true).
 */
async function withContext<T>(work: (app: INestApplicationContext) => Promise<T>): Promise<T> {
  const config = loadConfig();

  @Module({
    imports: [
      PlatformModule.forRoot(config),
      TenancyModule,
      HubSpotModule,
      ContextIntakeModule,
      ContextModule.register({
        connector: HubSpotModule,
        processors: false,
        merge: { imports: [SubscriptionMergeModule], participants: [SubscriptionMergeParticipant] },
      }),
    ],
  })
  class ContextCliModule {}

  const app = await NestFactory.createApplicationContext(ContextCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    await app.init();
    return await work(app);
  } finally {
    await app.close();
  }
}

function date(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} must be an ISO timestamp`);
  return d;
}

function int(value: string | undefined, name: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new Error(`--${name} must be an integer from 1 to ${max}`);
  return n;
}

function kinds(value: string | undefined): readonly ContextKind[] {
  if (value === 'all') return CONTEXT_KINDS;
  return [ContextKindSchema.parse(value)];
}

const list = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : undefined);

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      tenant: { type: 'string' },
      kind: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      status: { type: 'string' },
      'only-reason': { type: 'string' },
      'include-finished': { type: 'boolean', default: false },
      limit: { type: 'string' },
      'page-size': { type: 'string' },
      'max-records': { type: 'string' },
      resume: { type: 'string' },
      'dead-letter': { type: 'string' },
      code: { type: 'string' },
      subject: { type: 'string' },
      state: { type: 'string' },
      discard: { type: 'string' },
      reason: { type: 'string' },
      ref: { type: 'string' },
      actor: { type: 'string' },
      execute: { type: 'boolean', default: false },
    },
  });
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const tenant = values.tenant;
  const execute = values.execute;
  const correlationId = randomUUID();

  const result = await withContext(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const ops = app.get(ContextOperationsService);
    const bulk = app.get(BulkSyncService);
    // Q1: every write names an operator (asserted, not authenticated); refusals are audited.
    const op = <C extends Capability>(capability: C, action: AuditAction) =>
      authorizeOperator(app, ctx, capability, { actorFlag: values.actor, action, correlationId });
    switch (command) {
      case 'report':
        return ops.report(ctx);
      case 'state-hash':
        return ops.stateHash(ctx);
      case 'receipts':
        return ops.processReceipts(
          execute ? await op('data.sync.run', 'context.receipts.process') : ctx,
          {
            ...(values.since ? { from: date(values.since, 'since')! } : {}),
            ...(values.until ? { to: date(values.until, 'until')! } : {}),
            ...(values.status ? { statuses: list(values.status) as ReceiptStatus[] } : {}),
            ...(values['only-reason'] ? { onlyReason: values['only-reason'] } : {}),
            limit: int(values.limit, 'limit', 10_000) ?? 1_000,
            includeFinished: values['include-finished'],
            dryRun: !execute,
            correlationId,
          },
        );
      case 'backfill': {
        if (!execute)
          return { dryRun: true, wouldStart: kinds(values.kind), resume: values.resume ?? null };
        const auth = await op('data.sync.run', 'context.backfill.start');
        if (values.resume) return bulk.resume(auth, values.resume);
        return bulk.startBackfill(auth, kinds(values.kind), {
          ...(values['page-size'] ? { pageSize: int(values['page-size'], 'page-size', 100)! } : {}),
          ...(values['max-records']
            ? { maxRecords: int(values['max-records'], 'max-records', 10_000_000)! }
            : {}),
          correlationId,
        });
      }
      case 'reconcile': {
        if (!execute)
          return {
            dryRun: true,
            wouldStart: kinds(values.kind),
            since: values.since ?? 'watermark',
          };
        const runs = [];
        const auth = await op('data.sync.run', 'context.reconcile.start');
        for (const kind of kinds(values.kind)) {
          runs.push(
            await bulk.startReconcile(auth, kind, {
              ...(values.since ? { since: date(values.since, 'since')! } : {}),
              correlationId,
            }),
          );
        }
        return runs;
      }
      case 'replay': {
        if (values.subject) {
          const [system, kind, id] = values.subject.split(':');
          const parsedSystem = ExternalSystemSchema.parse(system);
          const parsedKind = ContextKindSchema.parse(kind);
          if (!id || !/^[A-Za-z0-9_.-]{1,255}$/.test(id))
            throw new Error('--subject must be system:kind:id');
          if (!execute)
            return { dryRun: true, wouldResync: { system: parsedSystem, kind: parsedKind, id } };
          await ops.resync(
            await op('data.sync.run', 'context.resync'),
            parsedSystem,
            parsedKind,
            id,
            correlationId,
          );
          return { queued: 1, correlationId };
        }
        return ops.replayDeadLetters(
          execute ? await op('processing.dead_letter.resolve', 'dead_letter.replay') : ctx,
          {
            ...(values['dead-letter'] ? { ids: list(values['dead-letter'])! } : {}),
            ...(values.code ? { code: values.code } : {}),
            limit: int(values.limit, 'limit', 1_000) ?? 100,
            dryRun: !execute,
            correlationId,
          },
        );
      }
      case 'dead-letters': {
        if (values.discard) {
          if (!values.reason) throw new Error('--reason <code> is required to discard');
          if (!execute) return { dryRun: true, wouldDiscard: list(values.discard) };
          return {
            discarded: await ops.discardDeadLetters(
              await op('processing.dead_letter.resolve', 'dead_letter.discard'),
              list(values.discard)!,
              values.reason,
            ),
          };
        }
        return ops.listDeadLetters(ctx, {
          ...(values.state ? { state: values.state } : {}),
          ...(values.code ? { code: values.code } : {}),
          limit: int(values.limit, 'limit', 1_000) ?? 100,
        });
      }
      case 'show': {
        const [system, objectType, id] = (values.ref ?? '').split(':');
        if (!system || !objectType || !id) throw new Error('--ref must be system:objectType:id');
        const found = await ops.show(ctx, ContextKindSchema.parse(values.kind), {
          system: ExternalSystemSchema.parse(system),
          objectType,
          id,
        });
        return found ?? { found: false };
      }
      default:
        throw new Error(
          'Usage: context <report|receipts|backfill|reconcile|replay|dead-letters|show|state-hash> --tenant <slug> [...]',
        );
    }
  });
  process.stdout.write(`${JSON.stringify({ tenant, command, ...wrap(result) }, null, 2)}\n`);
}

function wrap(result: unknown): Record<string, unknown> {
  return Array.isArray(result) ? { results: result } : (result as Record<string, unknown>);
}

main().catch(fail);
