import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ContextIntakeModule, ContextModule } from '../modules/context';
import { HubSpotModule } from '../modules/hubspot';
import { SubscriptionMergeModule, SubscriptionMergeParticipant } from '../modules/products';
import {
  MappingPreviewService,
  ProfilePurgeService,
  SchemaSnapshotsService,
  SourceAuthorityService,
  SourceConnectionsService,
  SourceMappingsService,
  SourceProfilingService,
  SourceReportService,
  SourcesError,
  SourcesModule,
  SourceSyncService,
  type SourceConnection,
} from '../modules/sources';
import { chargebeeAdapterFactory } from '../modules/chargebee';
import { sugarAdapterFactory } from '../modules/sugar';
import { TenancyModule, TenantContextService, type TenantContext } from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import type { AuditAction, AuditTargetKind, Capability } from '../modules/domain';
import { fail } from './hubspot-context';
import { authorizeOperator } from './operator';

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
 * Source profiling (M9A, ADR 0022; aggregates only, never raw values except safe categories):
 *   sources profile-run      --tenant <slug> --connection <id|kind> --objects A[,B] [--fields f1,f2]
 *                            --sampling full|systematic|recent|head [--max-rows N]
 *                            [--include-excluded Object.field,...] [--actor <id>] [--execute]
 *   sources profile-status   --tenant <slug> --connection <id|kind> [--run <id>]
 *   sources profile-show     --tenant <slug> --connection <id|kind> --object A [--profile <id>]
 *   sources profile-findings --tenant <slug> --connection <id|kind> [--object A] [--severity info|warning|review_required]
 *   sources profile-drift    --tenant <slug> --connection <id|kind> --object A
 *   sources mappings-draft   --tenant <slug> --connection <id|kind> --from-profile [--out <file>]
 *   sources profile-purge    --tenant <slug> --connection <id|kind> --object A --keep 10 [--execute]
 *                            (schema owner credentials: MIGRATION_DATABASE_URL; the app role is refused)
 * mappings-publish/validate also take `--ack <findingId>:<reasonCode>` (repeatable) and
 * `--profile-override <reason>`, which is always refused in M9A (no authenticated operator).
 * authority-publish takes `--accept-proof <connectionId>:<reason>` (stable_snapshot only).
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
      SourcesModule.register({
        context,
        adapters: [sugarAdapterFactory(), chargebeeAdapterFactory()],
        processors: false,
      }),
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
      'accept-proof': { type: 'string', multiple: true },
      objects: { type: 'string' },
      object: { type: 'string' },
      fields: { type: 'string' },
      sampling: { type: 'string' },
      'max-rows': { type: 'string' },
      'include-excluded': { type: 'string' },
      run: { type: 'string' },
      profile: { type: 'string' },
      severity: { type: 'string' },
      'from-profile': { type: 'boolean', default: false },
      out: { type: 'string' },
      keep: { type: 'string' },
    },
  });
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const tenant = values.tenant;
  const execute = values.execute;
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
  };

  const result = await withSources(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    // Q1: every write names an operator (asserted, not authenticated); refusals are audited.
    const op = <C extends Capability>(
      capability: C,
      action: AuditAction,
      targetKind?: AuditTargetKind,
      targetRef?: string,
    ) =>
      authorizeOperator(app, ctx, capability, {
        actorFlag: values.actor,
        action,
        ...(targetKind ? { targetKind } : {}),
        ...(targetRef ? { targetRef } : {}),
      });
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
          const auth = await op('config.source.connection', 'source_connection.configure');
          let configured = await connections.configure(auth, {
            kind: values.kind,
            label: values.label,
            config,
            ...(values.credential ? { credentialName: values.credential } : {}),
          });
          if (values.status === 'enabled' || values.status === 'disabled') {
            configured = await connections.setStatus(auth, configured.id, values.status);
          }
          return { connection: describe(configured) };
        }
        case 'test': {
          const conn = await connection(ctx);
          const auth = await op(
            'config.source.connection',
            'source_connection.test',
            'source_connection',
            conn.id,
          );
          return { test: await connections.test(auth, conn.id) };
        }
        case 'schema': {
          const conn = await connection(ctx);
          const snapshots = app.get(SchemaSnapshotsService);
          if (values.capture) {
            if (!execute) return { dryRun: true, wouldCapture: conn.id };
            const auth = await op(
              'config.source.schema',
              'source_schema.capture',
              'source_connection',
              conn.id,
            );
            return { captured: await snapshots.capture(auth, conn.id) };
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
          const auth = await op('config.mapping.publish', 'mapping.publish', 'mapping', conn.id);
          return {
            published: await mappings.publish(auth, conn.id, document, {
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
          const auth = await op('config.authority.publish', 'authority.publish', 'authority');
          return {
            published: await app.get(SourceAuthorityService).publish(auth, document, {
              expectedBaseVersion: basedOn,
              proofAcceptances: (values['accept-proof'] ?? []).map((a) => {
                const at = a.indexOf(':');
                return { connectionId: a.slice(0, at), reason: a.slice(at + 1) };
              }),
            }),
          };
        }
        case 'sync-full':
        case 'sync-incremental': {
          const conn = await connection(ctx);
          const mode = command === 'sync-full' ? 'full' : 'incremental';
          if (!execute) return { dryRun: true, connection: conn.id, mode };
          const auth = await op('data.sync.run', 'sync.start', 'source_connection', conn.id);
          const started = await app
            .get(SourceSyncService)
            .start(auth, conn.id, mode, { correlationId: auth.correlationId });
          return { started };
        }
        case 'sync-status': {
          const conn = await connection(ctx);
          return { runs: await app.get(SourceReportService).status(ctx, conn.id) };
        }
        case 'profile-run': {
          const conn = await connection(ctx);
          if (!values.objects) throw new Error('--objects A[,B] is required');
          if (!values.sampling)
            throw new Error('--sampling full|systematic|recent|head is required');
          const objects = values.objects.split(',').filter(Boolean);
          const fields = values.fields?.split(',').filter(Boolean);
          if (fields && objects.length !== 1) throw new Error('--fields needs exactly one object');
          const result = await app.get(SourceProfilingService).request(
            execute
              ? await op('data.profile.run', 'profile.start', 'source_connection', conn.id)
              : ctx,
            conn.id,
            {
              objects: objects.map((object) => ({ object, ...(fields ? { fields } : {}) })),
              sampling: values.sampling,
              ...(values['max-rows'] !== undefined
                ? { maxRows: int(values['max-rows'], 'max-rows') }
                : {}),
              includeExcluded: values['include-excluded']?.split(',').filter(Boolean) ?? [],
            },
            { execute, correlationId: randomUUID() },
          );
          return { ...result };
        }
        case 'profile-status': {
          const conn = await connection(ctx);
          const runs = await app.get(SourceProfilingService).status(ctx, conn.id, values.run);
          return {
            runs: runs.map((r) => ({
              id: r.id,
              status: r.status,
              errorCode: r.errorCode ?? null,
              objects: r.request.objects.map((o) => o.object),
              sampling: r.request.sampling,
              maxRows: r.request.maxRows,
              requestedBy: r.requestedBy,
              createdAt: r.createdAt,
              finishedAt: r.finishedAt ?? null,
              summary: r.sampling ?? null,
            })),
          };
        }
        case 'profile-show': {
          const conn = await connection(ctx);
          if (!values.object) throw new Error('--object is required');
          const shown = await app
            .get(SourceProfilingService)
            .show(ctx, conn.id, values.object, values.profile);
          return shown
            ? {
                profileId: shown.id,
                runId: shown.runId ?? null,
                syncRunId: shown.syncRunId ?? null,
                family: shown.samplingFamily,
                contentHash: shown.contentHash,
                previousProfileId: shown.previousProfileId ?? null,
                document: shown.document,
              }
            : { found: false };
        }
        case 'profile-findings': {
          const conn = await connection(ctx);
          const severity = values.severity as 'info' | 'warning' | 'review_required' | undefined;
          if (severity && !['info', 'warning', 'review_required'].includes(severity)) {
            throw new Error('--severity must be info, warning or review_required');
          }
          const findings = await app.get(SourceProfilingService).findings(ctx, conn.id, {
            ...(values.object ? { object: values.object } : {}),
            ...(severity ? { severity } : {}),
          });
          return { findings };
        }
        case 'profile-drift': {
          const conn = await connection(ctx);
          if (!values.object) throw new Error('--object is required');
          return await app.get(SourceProfilingService).drift(ctx, conn.id, values.object);
        }
        case 'mappings-draft': {
          const conn = await connection(ctx);
          if (!values['from-profile']) throw new Error('--from-profile is required');
          const draft = await app.get(SourceProfilingService).draftMapping(ctx, conn.id);
          if (values.out) {
            writeFileSync(values.out, `${JSON.stringify(draft, null, 2)}\n`, { flag: 'wx' });
            return { written: values.out, draft: true, basedOnProfiles: draft.basedOnProfiles };
          }
          return draft;
        }
        case 'profile-purge': {
          const conn = await connection(ctx);
          if (!values.object) throw new Error('--object is required');
          const keep = int(values.keep, 'keep');
          if (keep === undefined) throw new Error('--keep N is required');
          return {
            purge: await app
              .get(ProfilePurgeService)
              .purge(
                execute
                  ? await op('data.purge', 'profile.purge', 'source_connection', conn.id)
                  : ctx,
                conn.id,
                values.object,
                {
                  keep,
                  execute,
                  // The schema owner's URL (never printed); the app role is refused.
                  ownerDatabaseUrl: process.env.MIGRATION_DATABASE_URL,
                },
              ),
          };
        }
        case 'report': {
          const conn = await connection(ctx);
          return await app
            .get(SourceReportService)
            .report(ctx, conn.id, { drift: values.drift, products: values.products });
        }
        default:
          throw new Error(
            'Usage: sources <list|configure|test|schema|mappings-validate|mappings-preview|mappings-publish|mappings-show|mappings-draft|authority-show|authority-publish|sync-full|sync-incremental|sync-status|report|profile-run|profile-status|profile-show|profile-findings|profile-drift|profile-purge> --tenant <slug> [...]',
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
