import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  CSV_LIMITS,
  EligibilityService,
  ProductCatalogueService,
  ProductModelInvalidError,
  ProductsModule,
  SubscriptionImportService,
  SubscriptionReadModel,
} from '../modules/products';
import { TenancyModule, TenantContextService, type TenantContext } from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';
import { fail } from './hubspot-context';

/**
 * Product catalogue, subscriptions and eligibility (M7, ADRs 0016–0018).
 * Tenant-scoped; every command that writes is a dry run unless `--execute`.
 * Output is JSON with keys, ids, codes, counts and hashes — never company
 * names or other record values.
 *
 *   pnpm --filter @lip/api product:model       validate --tenant <slug> --file <model.json> [--effective-from ISO]
 *   pnpm --filter @lip/api product:model       publish  --tenant <slug> --file <model.json> [--effective-from ISO]
 *                                              [--based-on <version>] [--actor <id>] [--execute]
 *   pnpm --filter @lip/api product:model       show     --tenant <slug> [--version N]
 *   pnpm --filter @lip/api product:model       diff     --tenant <slug> --from N --to M
 *   pnpm --filter @lip/api subscriptions:import         --tenant <slug> --file <lines.csv> --source <name>
 *                                              --mode full|incremental [--execute] | --cancel <checkpointId> --execute
 *   pnpm --filter @lip/api subscriptions:show           --tenant <slug> --company <id|system:objectType:id>
 *   pnpm --filter @lip/api subscriptions:coverage       --tenant <slug>
 *   pnpm --filter @lip/api eligibility:evaluate         --tenant <slug> --company <ref> --product <key> [--as-of ISO]
 *                                              [--record --purpose <code> --execute]
 *   pnpm --filter @lip/api eligibility:whitespace       --tenant <slug> --company <ref> [--as-of ISO]
 *   pnpm --filter @lip/api eligibility:replay           --tenant <slug> --snapshot <id>
 *   pnpm --filter @lip/api products:report              --tenant <slug>   (exit 3 if an invariant is violated)
 */
async function withProducts<T>(work: (app: INestApplicationContext) => Promise<T>): Promise<T> {
  const config = loadConfig();

  @Module({ imports: [PlatformModule.forRoot(config), TenancyModule, ProductsModule] })
  class ProductsCliModule {}

  const app = await NestFactory.createApplicationContext(ProductsCliModule, {
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
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error(`--${name} must be an ISO timestamp with an offset (e.g. Z)`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} must be an ISO timestamp`);
  return d;
}

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

function readFile(path: string | undefined, maxBytes: number): Buffer {
  if (!path) throw new Error('--file <path> is required');
  if (statSync(path).size > maxBytes) throw new Error(`--file exceeds ${maxBytes} bytes`);
  return readFileSync(path);
}

function readJson(path: string | undefined): unknown {
  const raw = readFile(path, 8 * 1024 * 1024).toString('utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('--file is not valid JSON');
  }
}

let exitCode = 0;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const sub = command === 'model' ? rest.shift() : undefined;
  const { values } = parseArgs({
    args: rest,
    options: {
      tenant: { type: 'string' },
      file: { type: 'string' },
      'effective-from': { type: 'string' },
      'based-on': { type: 'string' },
      actor: { type: 'string' },
      version: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      source: { type: 'string' },
      mode: { type: 'string' },
      cancel: { type: 'string' },
      company: { type: 'string' },
      product: { type: 'string' },
      'as-of': { type: 'string' },
      record: { type: 'boolean', default: false },
      purpose: { type: 'string' },
      snapshot: { type: 'string' },
      execute: { type: 'boolean', default: false },
    },
  });
  if (!values.tenant) throw new Error('--tenant <slug> is required');
  const tenant = values.tenant;
  const execute = values.execute;
  const correlationId = randomUUID();
  const asOf = date(values['as-of'], 'as-of');

  const result = await withProducts(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const catalogue = app.get(ProductCatalogueService);
    const imports = app.get(SubscriptionImportService);
    const reads = app.get(SubscriptionReadModel);
    const eligibility = app.get(EligibilityService);
    const company = async (c: TenantContext) => {
      if (!values.company) throw new Error('--company <id|system:objectType:id> is required');
      const id = await reads.resolveCompany(c, values.company);
      if (!id) throw new Error('--company does not resolve to a company in this tenant');
      return id;
    };

    switch (command) {
      case 'model': {
        const effectiveFrom = date(values['effective-from'], 'effective-from');
        switch (sub) {
          case 'validate':
          case 'publish': {
            const document = readJson(values.file);
            const report = await catalogue.validate(
              ctx,
              document,
              effectiveFrom ? { effectiveFrom } : {},
            );
            if (!report.ok) exitCode = 2;
            if (sub === 'validate' || !execute || !report.ok)
              return { dryRun: sub === 'publish', ...report };
            try {
              const basedOn = int(values['based-on'], 'based-on');
              return {
                published: await catalogue.publish(ctx, document, {
                  actor: values.actor ?? 'cli',
                  ...(effectiveFrom ? { effectiveFrom } : {}),
                  ...(basedOn !== undefined ? { basedOnVersion: basedOn } : {}),
                }),
              };
            } catch (error) {
              if (error instanceof ProductModelInvalidError) {
                exitCode = 2;
                return { ok: false, errors: error.errors, warnings: error.warnings };
              }
              throw error;
            }
          }
          case 'show': {
            const version = int(values.version, 'version');
            const shown = await catalogue.show(ctx, version);
            return shown ? { ...shown } : { found: false, versions: await catalogue.versions(ctx) };
          }
          case 'diff': {
            const from = int(values.from, 'from');
            const to = int(values.to, 'to');
            if (from === undefined || to === undefined)
              throw new Error('--from and --to are required');
            return (await catalogue.diff(ctx, from, to)) ?? { found: false };
          }
          default:
            throw new Error(
              'Usage: product:model <validate|publish|show|diff> --tenant <slug> [...]',
            );
        }
      }
      case 'import': {
        if (values.cancel) {
          if (!execute) return { dryRun: true, wouldCancel: values.cancel };
          return imports.cancel(ctx, values.cancel);
        }
        if (!values.source) throw new Error('--source <name> is required');
        if (values.mode !== 'full' && values.mode !== 'incremental')
          throw new Error('--mode full|incremental is required');
        const report = await imports.import(ctx, readFile(values.file, CSV_LIMITS.maxBytes), {
          source: values.source,
          mode: values.mode,
          execute,
          correlationId,
        });
        if (report.status === 'invalid' || report.status === 'failed') exitCode = 2;
        return report;
      }
      case 'show':
        return reads.accountSubscriptions(ctx, await company(ctx));
      case 'coverage':
        return { ...(await reads.coverage(ctx)), runs: await reads.loadRuns(ctx, 10) };
      case 'evaluate': {
        if (!values.product) throw new Error('--product <key> is required');
        if (values.record && !values.purpose)
          throw new Error('--purpose <code> is required with --record');
        const record =
          values.record && execute ? { purpose: values.purpose!, correlationId } : undefined;
        const r = await eligibility.evaluate(ctx, await company(ctx), values.product, {
          ...(asOf ? { asOf } : {}),
          ...(record ? { record } : {}),
        });
        return values.record && !execute ? { dryRun: true, wouldRecord: true, ...r } : r;
      }
      case 'whitespace': {
        const ws = await eligibility.whitespace(ctx, await company(ctx), asOf ? { asOf } : {});
        return {
          ...ws,
          summary: Object.fromEntries(
            Object.entries(ws.categories).map(([k, v]) => [k, v.map((r) => r.productKey)]),
          ),
        };
      }
      case 'replay': {
        if (!values.snapshot) throw new Error('--snapshot <id> is required');
        const r = await eligibility.replay(ctx, values.snapshot);
        if (!r.reproduced) exitCode = 3;
        return r;
      }
      case 'report': {
        const [versions, coverage, counts, orphans] = await Promise.all([
          catalogue.versions(ctx),
          reads.coverage(ctx),
          reads.counts(ctx),
          reads.orphanedOnMergedCompanies(ctx),
        ]);
        const invariants = { noActiveLinesOnMergedCompanies: orphans.length === 0 };
        if (!invariants.noActiveLinesOnMergedCompanies) exitCode = 3;
        return {
          modelVersions: versions.map((v) => ({
            version: v.version,
            contentHash: v.contentHash,
            effectiveFrom: v.effectiveFrom,
          })),
          coverage,
          subscriptions: counts,
          invariants,
          ...(orphans.length ? { violations: { activeLinesOnMergedCompanies: orphans } } : {}),
        };
      }
      default:
        throw new Error(
          'Usage: products <model|import|show|coverage|evaluate|whitespace|replay|report> --tenant <slug> [...]',
        );
    }
  });
  process.stdout.write(
    `${JSON.stringify({ tenant, command: sub ? `${command} ${sub}` : command, ...wrap(result) }, null, 2)}\n`,
  );
  process.exitCode = exitCode;
}

function wrap(result: unknown): Record<string, unknown> {
  return Array.isArray(result) ? { results: result } : (result as Record<string, unknown>);
}

main().catch(fail);
