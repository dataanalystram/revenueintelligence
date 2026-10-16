import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  CommercialLineReferenceStep,
  CommercialModule,
  CommercialReadModel,
  ContractWriter,
  EntitlementWriter,
  PriceOfferWriter,
} from '../modules/commercial';
import { SecretLikeValueError, type AuditAction } from '../modules/domain';
import { GovernanceError, GovernanceModule } from '../modules/governance';
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
 * Commercial operator entry and read models (M10F plan §10, §16; ADR 0032).
 * Every command names an operator (`--actor` or LIP_OPERATOR_ID, recorded as
 * asserted). Reads need `data.commercial.read` (one audit event per call) and
 * work whatever the gate (Q19 / Q20). Writes need `canonical.human_entry` and
 * a reason code, plus adopted canonical ≥ 0.6 and module `commercial` enabled.
 * Output is JSON with identifiers, codes and dates; confidential attributes
 * (list amount, contract total value and currency, renewal date) are withheld
 * unless `--include-confidential`, which also needs
 * `data.commercial.read_confidential` — held only through an explicit tenant
 * grant (`security grant`, the #90 path). Without it the read is refused
 * (exit 2, `authorization_denied`, a `denied` audit event naming that
 * capability), never silently redacted; with it the read's audit event names
 * that capability and the released keys (never values). No HTTP endpoint (M15).
 *
 *   pnpm --filter @lip/api commercial price-offer list  --tenant <slug> --product <key> [--product …] [--include-confidential] --actor <id>
 *   pnpm --filter @lip/api commercial price-offer show  --tenant <slug> --price-offer <id> [--include-confidential] --actor <id>
 *   pnpm --filter @lip/api commercial price-offer write --tenant <slug> [--price-offer <id>] [--product <key>] [--currency XXX]
 *                                        [--billing-period <n> --billing-period-unit day|week|month|year]
 *                                        [--pricing-model <code>] [--list-amount-minor <n>] [--status active|retired]
 *                                        [--clear billing_period|pricing_model|list_amount_minor] --reason <code> --actor <id>
 *   pnpm --filter @lip/api commercial price-offer retire --tenant <slug> --price-offer <id> --reason <code> --actor <id>
 *   pnpm --filter @lip/api commercial contract list  --tenant <slug> --account <id> [--account …] [--include-confidential] --actor <id>
 *   pnpm --filter @lip/api commercial contract show  --tenant <slug> --contract <id> [--lines] [--include-confidential] --actor <id>
 *   pnpm --filter @lip/api commercial contract write --tenant <slug> (--contract <id> | --account <id>) [--context <id>]
 *                                        [--starts-at <iso>] [--ends-at <iso>] [--renewal-date YYYY-MM-DD] [--auto-renew true|false]
 *                                        [--status <code>] [--total-value-minor <n> --total-value-currency XXX]
 *                                        [--clear context|starts_at|ends_at|renewal_date|auto_renew|total_value]
 *                                        --reason <code> --actor <id>
 *   pnpm --filter @lip/api commercial contract link   --tenant <slug> --contract <id> --kind renews|amends|parent --target <id> --reason <code> --actor <id>
 *   pnpm --filter @lip/api commercial contract unlink --tenant <slug> --contract <id> --kind renews|amends|parent --reason <code> --actor <id>
 *   pnpm --filter @lip/api commercial contract retire --tenant <slug> --contract <id> --reason <code> --actor <id>   (status terminated)
 *   pnpm --filter @lip/api commercial entitlement list  --tenant <slug> --account <id> [--account …] --actor <id>
 *   pnpm --filter @lip/api commercial entitlement show  --tenant <slug> --entitlement <id> --actor <id>
 *   pnpm --filter @lip/api commercial entitlement write --tenant <slug> (--entitlement <id> | --account <id> --product <key>)
 *                                        [--quantity <n>] [--status <code>] [--starts-at <iso>] [--ends-at <iso>]
 *                                        [--clear quantity|starts_at|ends_at] --reason <code> --actor <id>
 *   pnpm --filter @lip/api commercial line assign-contract    --tenant <slug> --line <id> (--target <id> | --clear-target) --reason <code> --actor <id>
 *   pnpm --filter @lip/api commercial line assign-price-offer --tenant <slug> --line <id> (--target <id> | --clear-target) --reason <code> --actor <id>
 *   pnpm --filter @lip/api commercial line set-supersedes     --tenant <slug> --line <id> (--target <id> | --clear-target) --reason <code> --actor <id>
 *   pnpm --filter @lip/api commercial release --tenant <slug> (--price-offer <id> | --contract <id> | --entitlement <id> | --line <id>)
 *                                        --reason <code> --actor <id>
 *
 * An operator write holds the attributes it set until `release` hands them back to the source (Q17).
 *
 * Exit codes: 2 refused or invalid, 1 unexpected failure.
 */
export const COMMERCIAL_CLI_COMMANDS = [
  'price-offer list',
  'price-offer show',
  'price-offer write',
  'price-offer retire',
  'contract list',
  'contract show',
  'contract write',
  'contract link',
  'contract unlink',
  'contract retire',
  'entitlement list',
  'entitlement show',
  'entitlement write',
  'line assign-contract',
  'line assign-price-offer',
  'line set-supersedes',
  'release',
] as const;
export type CommercialCliCommand = (typeof COMMERCIAL_CLI_COMMANDS)[number];

const GROUPS = new Set(['price-offer', 'contract', 'entitlement', 'line']);

const USAGE = [
  'commercial price-offer list|show|write|retire …',
  'commercial contract list|show|write|link|unlink|retire …',
  'commercial entitlement list|show|write …',
  'commercial line assign-contract|assign-price-offer|set-supersedes --line <id> (--target <id> | --clear-target) …',
  'commercial release (--price-offer <id> | --contract <id> | --entitlement <id> | --line <id>) --reason <code> --actor <id>',
].join('\n  ');

async function withCommercial<T>(work: (app: INestApplicationContext) => Promise<T>): Promise<T> {
  const config = loadConfig();

  @Module({
    imports: [PlatformModule.forRoot(config), TenancyModule, GovernanceModule, CommercialModule],
  })
  class CommercialCliModule {}

  const app = await NestFactory.createApplicationContext(CommercialCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    await app.init();
    return await work(app);
  } finally {
    await app.close();
  }
}

/** `--n` → a safe integer (validation_failed otherwise). */
function intArg(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new GovernanceError('validation_failed', `${flag} takes an integer`);
  }
  return Number(value);
}

function boolArg(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') {
    throw new GovernanceError('validation_failed', `${flag} takes true or false`);
  }
  return value === 'true';
}

/** `--clear a|b` → the named attributes set to null (only the allowed names). */
function clearArgs(
  values: readonly string[] | undefined,
  allowed: Readonly<Record<string, readonly string[]>>,
): Record<string, null> {
  const out: Record<string, null> = {};
  for (const c of values ?? []) {
    const attrs = allowed[c];
    if (!attrs) {
      throw new GovernanceError(
        'validation_failed',
        `--clear takes ${Object.keys(allowed).join(', ')}`,
      );
    }
    for (const a of attrs) out[a] = null;
  }
  return out;
}

/** Only the flags given (an omitted flag is never a clear). */
function given<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const grouped = GROUPS.has(argv[0] ?? '');
  const command = grouped ? `${argv[0]} ${argv[1] ?? ''}` : (argv[0] ?? '');
  const args = argv.slice(grouped ? 2 : 1);
  if (!(COMMERCIAL_CLI_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Usage:\n  ${USAGE}`);
  }
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: 'string' },
      actor: { type: 'string' },
      account: { type: 'string', multiple: true },
      product: { type: 'string', multiple: true },
      'price-offer': { type: 'string' },
      contract: { type: 'string' },
      entitlement: { type: 'string' },
      line: { type: 'string' },
      context: { type: 'string' },
      target: { type: 'string' },
      'clear-target': { type: 'boolean', default: false },
      kind: { type: 'string' },
      currency: { type: 'string' },
      'billing-period': { type: 'string' },
      'billing-period-unit': { type: 'string' },
      'pricing-model': { type: 'string' },
      'list-amount-minor': { type: 'string' },
      status: { type: 'string' },
      'starts-at': { type: 'string' },
      'ends-at': { type: 'string' },
      'renewal-date': { type: 'string' },
      'auto-renew': { type: 'string' },
      'total-value-minor': { type: 'string' },
      'total-value-currency': { type: 'string' },
      quantity: { type: 'string' },
      clear: { type: 'string', multiple: true },
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

  const result = await withCommercial(async (app) => {
    const ctx = await app.get(TenantContextService).forSlug(tenant);
    const read = (targetKind: 'price_offer' | 'contract' | 'entitlement', targetRef?: string) =>
      authorizeOperator(app, ctx, 'data.commercial.read', {
        actorFlag: values.actor,
        action: 'commercial.read',
        targetKind,
        ...(targetRef ? { targetRef } : {}),
        correlationId,
      });
    const human = (
      action: AuditAction,
      targetKind: 'price_offer' | 'contract' | 'entitlement',
      targetRef?: string,
    ) =>
      authorizeOperator(app, ctx, 'canonical.human_entry', {
        actorFlag: values.actor,
        action,
        targetKind,
        ...(targetRef ? { targetRef } : {}),
        correlationId,
      });
    const reads = app.get(CommercialReadModel);
    try {
      switch (command as CommercialCliCommand) {
        case 'price-offer list':
          return await reads.priceOffersForProducts(await read('price_offer'), {
            productKeys: values.product ?? [],
            includeConfidential,
          });
        case 'price-offer show':
          return {
            priceOffer: await reads.priceOffer(await read('price_offer', values['price-offer']), {
              priceOfferId: values['price-offer'] ?? '',
              includeConfidential,
            }),
          };
        case 'price-offer write': {
          if ((values.product?.length ?? 0) > 1) {
            throw new GovernanceError('validation_failed', 'write takes one --product');
          }
          const raw = values.status;
          if (raw !== undefined && raw !== 'active' && raw !== 'retired') {
            throw new GovernanceError('validation_failed', '--status takes active or retired');
          }
          const status: 'active' | 'retired' | undefined = raw;
          const actx = await human(
            'commercial.price_offer.write',
            'price_offer',
            values['price-offer'],
          );
          return {
            priceOffer: await app.get(PriceOfferWriter).write(actx, {
              ...given({
                priceOffer: values['price-offer'],
                product: values.product?.[0],
                currency: values.currency,
                billingPeriod: intArg(values['billing-period'], '--billing-period'),
                billingPeriodUnit: values['billing-period-unit'],
                pricingModel: values['pricing-model'],
                listAmountMinor: intArg(values['list-amount-minor'], '--list-amount-minor'),
                status,
              }),
              ...clearArgs(values.clear, {
                billing_period: ['billingPeriod', 'billingPeriodUnit'],
                pricing_model: ['pricingModel'],
                list_amount_minor: ['listAmountMinor'],
              }),
              reason,
            }),
          };
        }
        case 'price-offer retire': {
          const actx = await human(
            'commercial.price_offer.write',
            'price_offer',
            values['price-offer'],
          );
          return {
            priceOffer: await app.get(PriceOfferWriter).retire(actx, {
              priceOffer: values['price-offer'] ?? '',
              reason,
            }),
          };
        }
        case 'contract list':
          return await reads.contractsForAccounts(await read('contract'), {
            companyIds: values.account ?? [],
            includeConfidential,
          });
        case 'contract show': {
          const actx = await read('contract', values.contract);
          const contract = await reads.contract(actx, {
            contractId: values.contract ?? '',
            includeConfidential,
          });
          return {
            contract,
            ...(values.lines
              ? { lines: await reads.linesForContract(actx, { contractId: values.contract ?? '' }) }
              : {}),
          };
        }
        case 'contract write':
        case 'contract retire': {
          if ((values.account?.length ?? 0) > 1) {
            throw new GovernanceError('validation_failed', 'write takes one --account');
          }
          const actx = await human('commercial.contract.write', 'contract', values.contract);
          const writer = app.get(ContractWriter);
          if (command === 'contract retire') {
            // No `retired` contract status (E3 §13): retire = status terminated (ADR 0032).
            return {
              contract: await writer.write(actx, {
                contract: values.contract ?? '',
                status: 'terminated',
                reason,
              }),
            };
          }
          const totalValueMinor = intArg(values['total-value-minor'], '--total-value-minor');
          return {
            contract: await writer.write(actx, {
              ...given({
                contract: values.contract,
                account: values.account?.[0],
                context: values.context,
                startsAt: values['starts-at'],
                endsAt: values['ends-at'],
                renewalDate: values['renewal-date'],
                autoRenew: boolArg(values['auto-renew'], '--auto-renew'),
                status: values.status,
                totalValueMinor,
                totalValueCurrency: values['total-value-currency'],
              }),
              ...clearArgs(values.clear, {
                context: ['context'],
                starts_at: ['startsAt'],
                ends_at: ['endsAt'],
                renewal_date: ['renewalDate'],
                auto_renew: ['autoRenew'],
                total_value: ['totalValueMinor', 'totalValueCurrency'],
              }),
              reason,
            }),
          };
        }
        case 'contract link':
        case 'contract unlink': {
          const kind = values.kind ?? '';
          if (kind !== 'renews' && kind !== 'amends' && kind !== 'parent') {
            throw new GovernanceError(
              'validation_failed',
              '--kind must be renews, amends or parent',
            );
          }
          if (command === 'contract unlink' && values.target !== undefined) {
            throw new GovernanceError('validation_failed', 'unlink takes no --target');
          }
          const actx = await human('commercial.contract.link', 'contract', values.contract);
          return {
            contract: await app.get(ContractWriter).link(actx, {
              contract: values.contract ?? '',
              kind,
              target: command === 'contract unlink' ? null : (values.target ?? ''),
              reason,
            }),
          };
        }
        case 'entitlement list':
          return await reads.entitlementsForAccounts(await read('entitlement'), {
            companyIds: values.account ?? [],
            includeConfidential,
          });
        case 'entitlement show':
          return {
            entitlement: await reads.entitlement(await read('entitlement', values.entitlement), {
              entitlementId: values.entitlement ?? '',
              includeConfidential,
            }),
          };
        case 'entitlement write': {
          if ((values.account?.length ?? 0) > 1 || (values.product?.length ?? 0) > 1) {
            throw new GovernanceError('validation_failed', 'write takes one --account / --product');
          }
          const actx = await human(
            'commercial.entitlement.write',
            'entitlement',
            values.entitlement,
          );
          return {
            entitlement: await app.get(EntitlementWriter).write(actx, {
              ...given({
                entitlement: values.entitlement,
                account: values.account?.[0],
                product: values.product?.[0],
                quantity: intArg(values.quantity, '--quantity'),
                status: values.status,
                startsAt: values['starts-at'],
                endsAt: values['ends-at'],
              }),
              ...clearArgs(values.clear, {
                quantity: ['quantity'],
                starts_at: ['startsAt'],
                ends_at: ['endsAt'],
              }),
              reason,
            }),
          };
        }
        case 'line assign-contract':
        case 'line assign-price-offer':
        case 'line set-supersedes': {
          if (values['clear-target'] === (values.target !== undefined)) {
            throw new GovernanceError(
              'validation_failed',
              `${command} takes exactly one of --target or --clear-target`,
            );
          }
          const offer = command === 'line assign-price-offer';
          const actx = await human(
            'commercial.line.reference',
            offer ? 'price_offer' : 'contract',
            values.target ?? values.line,
          );
          const step = app.get(CommercialLineReferenceStep);
          const input = {
            line: values.line ?? '',
            target: values['clear-target'] ? null : (values.target ?? null),
            reason,
          };
          return {
            line:
              command === 'line assign-contract'
                ? await step.assignContract(actx, input)
                : offer
                  ? await step.assignPriceOffer(actx, input)
                  : await step.setSupersedes(actx, input),
          };
        }
        default: {
          // release: exactly one of --price-offer / --contract / --entitlement / --line.
          const named = (
            [
              ['price-offer', values['price-offer']],
              ['contract', values.contract],
              ['entitlement', values.entitlement],
              ['line', values.line],
            ] as const
          ).filter(([, v]) => v !== undefined);
          if (named.length !== 1) {
            throw new GovernanceError(
              'validation_failed',
              'release takes exactly one of --price-offer, --contract, --entitlement or --line',
            );
          }
          const [what, id] = named[0]!;
          const kind =
            what === 'price-offer'
              ? 'price_offer'
              : what === 'entitlement'
                ? 'entitlement'
                : 'contract';
          const actx = await human('commercial.release', kind, id);
          const input = { reason };
          return {
            released:
              what === 'price-offer'
                ? await app.get(PriceOfferWriter).release(actx, { ...input, priceOffer: id ?? '' })
                : what === 'contract'
                  ? await app.get(ContractWriter).release(actx, { ...input, contract: id ?? '' })
                  : what === 'entitlement'
                    ? await app
                        .get(EntitlementWriter)
                        .release(actx, { ...input, entitlement: id ?? '' })
                    : await app
                        .get(CommercialLineReferenceStep)
                        .release(actx, { ...input, line: id ?? '' }),
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
