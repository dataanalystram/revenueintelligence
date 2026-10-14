import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SecretLikeValueError } from '../modules/domain';
import {
  CanonicalAdoptionService,
  GovernanceError,
  GovernanceModule,
  ModuleSettingsService,
  RegistryService,
} from '../modules/governance';
import { TenancyError, TenancyModule, TenantContextService } from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import { fail } from './hubspot-context';
import { authorizeOperator } from './operator';

/**
 * Canonical governance (M10A2, ADR 0027): adoption, modules and governed
 * registries. Tenant-scoped; every command that writes is a dry run unless
 * `--execute`, and every write names an operator (`--actor` or
 * LIP_OPERATOR_ID, recorded as asserted). Output is JSON with codes, versions,
 * counts and hashes only.
 *
 *   pnpm --filter @lip/api canonical:history  --tenant <slug>
 *   pnpm --filter @lip/api canonical:adopt    --tenant <slug> --version 0.x --expected-current 0.y [--actor <id>] [--execute]
 *   pnpm --filter @lip/api canonical:modules  --tenant <slug>
 *   pnpm --filter @lip/api canonical:module   --tenant <slug> --module <key> --enable|--disable|--file <config.json>
 *                                              --expected-version <n> [--actor <id>] [--execute]
 *   pnpm --filter @lip/api registry:show      --tenant <slug> --kind <kind>
 *   pnpm --filter @lip/api registry:publish   --tenant <slug> --kind <kind> --file <document.json>
 *                                              [--based-on <version> --expected-hash <hash> --actor <id> --execute]
 *
 * `registry publish` without `--execute` prints the content hash; `--execute`
 * publishes only with `--expected-hash` equal to it (Q11: what is published is
 * exactly what was reviewed). `data_policy` uses config.data_policy.publish,
 * every other kind config.registry.publish (refused until its sub-milestone).
 * Exit codes: 2 refused or invalid, 1 unexpected failure.
 */
async function withGovernance<T>(work: (app: INestApplicationContext) => Promise<T>): Promise<T> {
  const config = loadConfig();

  @Module({ imports: [PlatformModule.forRoot(config), TenancyModule, GovernanceModule] })
  class CanonicalCliModule {}

  const app = await NestFactory.createApplicationContext(CanonicalCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    await app.init();
    return await work(app);
  } finally {
    await app.close();
  }
}

function int(value: string | undefined, name: string): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} <n> is required (a non-negative integer)`);
  }
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      tenant: { type: 'string' },
      actor: { type: 'string' },
      execute: { type: 'boolean', default: false },
      version: { type: 'string' },
      'expected-current': { type: 'string' },
      module: { type: 'string' },
      enable: { type: 'boolean', default: false },
      disable: { type: 'boolean', default: false },
      'expected-version': { type: 'string' },
      kind: { type: 'string' },
      file: { type: 'string' },
      'based-on': { type: 'string' },
      'expected-hash': { type: 'string' },
    },
  });
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const tenant = values.tenant;
  const execute = values.execute;
  const correlationId = randomUUID();
  let exitCode = 0;

  const result = await withGovernance(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    try {
      switch (command) {
        case 'history':
          return { adoptions: await app.get(CanonicalAdoptionService).history(ctx) };
        case 'adopt': {
          const target = values.version;
          const expectedCurrent = values['expected-current'];
          if (!target || !expectedCurrent) {
            throw new Error('--version and --expected-current are required');
          }
          const adoption = app.get(CanonicalAdoptionService);
          const plan = await adoption.plan(ctx, target, expectedCurrent);
          if (!execute || plan.decision === 'refused') {
            if (plan.decision === 'refused') exitCode = 2;
            return { dryRun: true, ...plan };
          }
          const actx = await authorizeOperator(app, ctx, 'config.canonical.adopt', {
            actorFlag: values.actor,
            action: 'canonical.adopt',
            targetKind: 'canonical_version',
            targetRef: target,
            correlationId,
          });
          return { adopted: await adoption.adopt(actx, { target, expectedCurrent }) };
        }
        case 'modules':
          return { modules: await app.get(ModuleSettingsService).list(ctx) };
        case 'module': {
          const module = values.module;
          if (!module) throw new Error('--module <key> is required');
          const modes = [values.enable, values.disable, values.file !== undefined].filter(Boolean);
          if (modes.length !== 1) throw new Error('exactly one of --enable, --disable, --file');
          const expectedVersion = int(values['expected-version'], 'expected-version');
          const config = values.file
            ? (readJson(values.file) as Record<string, unknown>)
            : undefined;
          const service = app.get(ModuleSettingsService);
          if (!execute) {
            const state = (await service.list(ctx)).find((m) => m.module === module);
            if (!state) throw new Error('--module does not name a canonical module');
            return { dryRun: true, current: state };
          }
          const action = values.enable
            ? ('module.enable' as const)
            : values.disable
              ? ('module.disable' as const)
              : ('module.configure' as const);
          const actx = await authorizeOperator(app, ctx, 'config.module.change', {
            actorFlag: values.actor,
            action,
            targetKind: 'module',
            targetRef: module,
            correlationId,
          });
          const input = { module, expectedVersion, ...(config ? { config } : {}) };
          if (values.enable) return { module: await service.enable(actx, input) };
          if (values.disable) return { module: await service.disable(actx, input) };
          return { module: await service.configure(actx, { ...input, config: config! }) };
        }
        case 'registry-show': {
          if (!values.kind) throw new Error('--kind <kind> is required');
          const shown = await app.get(RegistryService).show(ctx, values.kind);
          return {
            kind: shown.kind,
            latest: shown.latest
              ? {
                  version: shown.latest.version,
                  contentHash: shown.latest.contentHash,
                  canonicalVersionMin: shown.latest.canonicalVersionMin,
                  publishedAt: shown.latest.publishedAt,
                }
              : null,
            entries: shown.entries,
          };
        }
        case 'registry-publish': {
          if (!values.kind) throw new Error('--kind <kind> is required');
          const document = readJson(values.file);
          const registry = app.get(RegistryService);
          const dry = await registry.dryRun(ctx, values.kind, document);
          if (!dry.valid) exitCode = 2;
          if (!execute || !dry.valid) return { dryRun: true, ...dry };
          const expectedHash = values['expected-hash'];
          if (!expectedHash) {
            throw new Error('--expected-hash <hash printed by the dry run> is required');
          }
          const input = {
            document,
            expectedBaseVersion: int(values['based-on'], 'based-on'),
            expectedContentHash: expectedHash,
          };
          if (values.kind === 'data_policy') {
            const actx = await authorizeOperator(app, ctx, 'config.data_policy.publish', {
              actorFlag: values.actor,
              action: 'data_policy.publish',
              targetKind: 'data_policy',
              targetRef: values.kind,
              correlationId,
            });
            return { published: await registry.publishDataPolicy(actx, input) };
          }
          const actx = await authorizeOperator(app, ctx, 'config.registry.publish', {
            actorFlag: values.actor,
            action: 'registry.publish',
            targetKind: 'registry',
            targetRef: values.kind,
            correlationId,
          });
          return { published: await registry.publish(actx, values.kind, input) };
        }
        default:
          throw new Error(
            'Usage: canonical <history|adopt|modules|module|registry-show|registry-publish> --tenant <slug> [...]',
          );
      }
    } catch (error) {
      if (
        error instanceof GovernanceError ||
        error instanceof TenancyError ||
        error instanceof SecretLikeValueError
      ) {
        exitCode = 2;
        return {
          ok: false,
          code: error instanceof SecretLikeValueError ? 'secret_like_value' : error.code,
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
