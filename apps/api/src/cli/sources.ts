import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ContextIntakeModule, ContextModule } from '../modules/context';
import { HubSpotModule } from '../modules/hubspot';
import { SubscriptionMergeModule, SubscriptionMergeParticipant } from '../modules/products';
import {
  MappingPreviewService,
  SchemaSnapshotsService,
  SourceAuthorityService,
  SourceConnectionsService,
  SourceMappingsService,
  SourceReportService,
  SourcesError,
  SourcesModule,
  SourceSyncService,
  type SourceConnection,
} from '../modules/sources';
import { sugarAdapterFactory } from '../modules/sugar';
import { TenancyModule, TenantContextService, type TenantContext } from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import { fail } from './hubspot-context';

/**
 * Source connectors (M8, ADRs 0019–0021): a thin CLI over the typed services.
 * Tenant-scoped; every command that writes is a dry run unless `--execute`.
 * Output is JSON with ids, codes, counts and hashes — never record values or
 * credentials. `--connection` takes a connection id or a kind (e.g. `sugar`).
 *
 *   pnpm --filter @lip/api sources:list        --tenant <slug>
 *   pnpm --filter @lip/api sources:configure   --tenant <slug> --kind sugar --label <text> --file <config.json>
 *                                               [--credential <name>] [--status enabled|disabled] [--execute]
 *   pnpm --filter @lip/api sources:test        --tenant <slug> --connection <id|kind>
 *   pnpm --filter @lip/api sources:schema      --tenant <slug> --connection <id|kind> [--capture --execute] [--diff]
 *   pnpm --filter @lip/api mappings:validate   --tenant <slug> --connection <id|kind> --file <mapping.json>
 *   pnpm --filter @lip/api mappings:preview    --tenant <slug> --connection <id|kind> --file <mapping.json> [--limit N]
 *   pnpm --filter @lip/api mappings:publish    --tenant <slug> --connection <id|kind> --file <mapping.json>
 *                                               --based-on <version> [--validated-against <hash>] [--actor <id>] [--execute]
 *   pnpm --filter @lip/api mappings:show       --tenant <slug> --connection <id|kind> [--version N]
 *   pnpm --filter @lip/api authority:show      --tenant <slug>
 *   pnpm --filter @lip/api authority:publish   --tenant <slug> --file <authority.json> --based-on <version>
 *                                               [--actor <id>] [--execute]
 *   pnpm --filter @lip/api sync:full           --tenant <slug> --connection <id|kind> [--execute]
 *   pnpm --filter @lip/api sync:incremental    --tenant <slug> --connection <id|kind> [--execute]
 *   pnpm --filter @lip/api sync:status         --tenant <slug> --connection <id|kind>
 *   pnpm --filter @lip/api source:report       --tenant <slug> --connection <id|kind> [--drift] [--products]
 *
 * Sync runs are processed by the worker (CONTEXT_PROCESSING_ENABLED=true).
 * Exit codes: 2 invalid input or refused publication/run, 1 unexpected failure.
 */
async function withSources<T>(work: (app: INestApplicationContext) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const context = ContextModule.register({
    connector: HubSpotModule,
    processors: false,
    merge: { imports: [SubscriptionMergeModule], participants: [SubscriptionMergeParticipant] },
  });

  @Module({
    imports: [
      PlatformModule.forRoot(config),
      TenancyModule,
      HubSpotModule,
      ContextIntakeModule,
      context,
      SourcesModule.register({ context, adapters: [sugarAdapterFactory()], processors: false }),
    ],
  })
  class SourcesCliModule {}

  const app = await NestFactory.createApplicationContext(SourcesCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    await app.init();
    return await work(app);
  } finally {
    await app.close();
  }
}

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

function readJson(path: string | undefined): unknown {
  if (!path) throw new Error('--file <path> is required');
  if (statSync(path).size > 1024 * 1024) throw new Error('--file exceeds 1 MiB');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('--file is not valid JSON');
  }
}

let exitCode = 0;

async function main(): Promise<void> {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      tenant: { type: 'string' },
      connection: { type: 'string' },
      kind: { type: 'string' },
      label: { type: 'string' },
      credential: { type: 'string' },
      status: { type: 'string' },
      file: { type: 'string' },
      'based-on': { type: 'string' },
      'validated-against': { type: 'string' },
      actor: { type: 'string' },
      version: { type: 'string' },
      limit: { type: 'string' },
      capture: { type: 'boolean', default: false },
      diff: { type: 'boolean', default: false },
      drift: { type: 'boolean', default: false },
      products: { type: 'boolean', default: false },
      execute: { type: 'boolean', default: false },
      ack: { type: 'string', multiple: true },
      'profile-override': { type: 'string' },
    },
  });
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const tenant = values.tenant;
  const execute = values.execute;
  const actor = values.actor ?? 'cli';
  // `--ack <findingId>:<reasonCode>` (M9A §7.4); validated by the mapping service.
  const acknowledgements = (values.ack ?? []).map((a) => {
    const [findingId = '', reasonCode = ''] = a.split(':');
    return { findingId, reasonCode } as { findingId: string; reasonCode: never };
  });
  const mappingOptions = {
    ...(values['validated-against'] ? { validatedAgainst: values['validated-against'] } : {}),
    ...(acknowledgements.length > 0 ? { acknowledgements } : {}),
    // Accepted as input only to be refused and audited (decision A1).
    ...(values['profile-override'] !== undefined
      ? { profileOverride: { reason: values['profile-override'] } }
      : {}),
    actor,
  };

  const result = await withSources(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const connections = app.get(SourceConnectionsService);
    const connection = async (c: TenantContext): Promise<SourceConnection> => {
      if (!values.connection) throw new Error('--connection <id|kind> is required');
      const all = await connections.list(c);
      const found = all.find((x) => x.id === values.connection || x.kind === values.connection);
      if (!found) throw new Error('--connection does not name a connection of this tenant');
      return found;
    };
    const describe = (x: SourceConnection) => ({
      id: x.id,
      kind: x.kind,
      label: x.label,
      status: x.status,
      mappingMode: x.mappingMode,
      credentialName: x.credentialName ?? null,
      lastTestCode: x.lastTestCode ?? null,
      lastTestedAt: x.lastTestedAt ?? null,
    });

    try {
      switch (command) {
        case 'list':
          return { connections: (await connections.list(ctx)).map(describe) };
        case 'configure': {
          if (!values.kind || !values.label) throw new Error('--kind and --label are required');
          const config = readJson(values.file) as Record<string, unknown>;
          if (!execute) return { dryRun: true, kind: values.kind };
          let configured = await connections.configure(ctx, {
            kind: values.kind,
            label: values.label,
            config,
            ...(values.credential ? { credentialName: values.credential } : {}),
          });
          if (values.status === 'enabled' || values.status === 'disabled') {
            configured = await connections.setStatus(ctx, configured.id, values.status);
          }
          return { connection: describe(configured) };
        }
        case 'test':
          return { test: await connections.test(ctx, (await connection(ctx)).id) };
        case 'schema': {
          const conn = await connection(ctx);
          const snapshots = app.get(SchemaSnapshotsService);
          if (values.capture) {
            if (!execute) return { dryRun: true, wouldCapture: conn.id };
            return { captured: await snapshots.capture(ctx, conn.id, actor) };
          }
          if (values.diff) return { drift: await snapshots.drift(ctx, conn.id) };
          const latest = await snapshots.latest(ctx, conn.id);
          return latest
            ? {
                hash: latest.hash,
                capturedAt: latest.capturedAt,
                objects: latest.schema.objects.map((o) => ({
                  name: o.name,
                  classification: o.classification,
                  fields: o.fields.length,
                  capabilities: o.capabilities,
                })),
              }
            : { found: false };
        }
        case 'mappings-validate': {
          const conn = await connection(ctx);
          const report = await app
            .get(SourceMappingsService)
            .validate(ctx, conn.id, readJson(values.file), mappingOptions);
          if (!report.ok) exitCode = 2;
          return report;
        }
        case 'mappings-preview': {
          const conn = await connection(ctx);
          const limit = int(values.limit, 'limit');
          return {
            preview: await app
              .get(MappingPreviewService)
              .preview(ctx, conn.id, readJson(values.file), limit),
          };
        }
        case 'mappings-publish': {
          const conn = await connection(ctx);
          const mappings = app.get(SourceMappingsService);
          const document = readJson(values.file);
          const report = await mappings.validate(ctx, conn.id, document, mappingOptions);
          if (!report.ok) exitCode = 2;
          if (!execute || !report.ok) return { dryRun: true, ...report };
          const basedOn = int(values['based-on'], 'based-on');
          if (basedOn === undefined) {
            throw new Error(
              '--based-on <version> is required to publish (0 for the first version)',
            );
          }
          return {
            published: await mappings.publish(ctx, conn.id, document, {
              ...mappingOptions,
              expectedBaseVersion: basedOn,
            }),
          };
        }
        case 'mappings-show': {
          const conn = await connection(ctx);
          const shown = await app
            .get(SourceMappingsService)
            .show(ctx, conn.id, int(values.version, 'version'));
          return shown ? { ...shown } : { found: false };
        }
        case 'authority-show': {
          const shown = await app.get(SourceAuthorityService).show(ctx);
          return shown ? { ...shown } : { found: false };
        }
        case 'authority-publish': {
          const document = readJson(values.file);
          if (!execute) return { dryRun: true };
          const basedOn = int(values['based-on'], 'based-on');
          if (basedOn === undefined) {
            throw new Error('--based-on <version> is required to publish');
          }
          return {
            published: await app
              .get(SourceAuthorityService)
              .publish(ctx, document, { expectedBaseVersion: basedOn, actor }),
          };
        }
        case 'sync-full':
        case 'sync-incremental': {
          const conn = await connection(ctx);
          const mode = command === 'sync-full' ? 'full' : 'incremental';
          if (!execute) return { dryRun: true, connection: conn.id, mode };
          const started = await app
            .get(SourceSyncService)
            .start(ctx, conn.id, mode, { correlationId: randomUUID() });
          return { started };
        }
        case 'sync-status': {
          const conn = await connection(ctx);
          return { runs: await app.get(SourceReportService).status(ctx, conn.id) };
        }
        case 'report': {
          const conn = await connection(ctx);
          return await app
            .get(SourceReportService)
            .report(ctx, conn.id, { drift: values.drift, products: values.products });
        }
        default:
          throw new Error(
            'Usage: sources <list|configure|test|schema|mappings-validate|mappings-preview|mappings-publish|mappings-show|authority-show|authority-publish|sync-full|sync-incremental|sync-status|report> --tenant <slug> [...]',
          );
      }
    } catch (error) {
      if (error instanceof SourcesError) {
        exitCode = 2;
        return { ok: false, code: error.code, message: error.message, issues: error.issues };
      }
      throw error;
    }
  });
  process.stdout.write(`${JSON.stringify({ tenant, command, ...wrap(result) }, null, 2)}\n`);
  process.exitCode = exitCode;
}

function wrap(result: unknown): Record<string, unknown> {
  return Array.isArray(result) ? { results: result } : (result as Record<string, unknown>);
}

main().catch(fail);
