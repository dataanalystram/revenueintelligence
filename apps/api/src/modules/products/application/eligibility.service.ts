import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  canonicalJson,
  classifyWhitespace,
  CompanyIdSchema,
  CustomerStatusSchema,
  evaluateEligibility,
  EVALUATOR_VERSION,
  InstantSchema,
  ProductKeySchema,
  SubscriptionFactSchema,
  type AccountFacts,
  type CompanyId,
  type EligibilityResult,
  type IndexedProductModel,
  type OwnershipInput,
  type WhitespaceResult,
} from '../../domain';
import { COMPANY_REPOSITORY, type CompanyRepository } from '../../identity';
import {
  assertAuthorized,
  AuditTrail,
  AuthorizedContext,
  TenantDatabase,
  type TenantContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  EligibilitySnapshotStore,
  type SnapshotRow,
} from '../infrastructure/eligibility-snapshot.store';
import { SubscriptionRunsStore } from '../infrastructure/subscription-runs.store';
import { SubscriptionQueries } from '../infrastructure/subscription.queries';
import { NoProductModelError, ProductCatalogueService } from './product-catalogue.service';

export class UnknownCompanyError extends Error {
  constructor(readonly companyId: string) {
    super(`company ${companyId} does not exist in this tenant`);
    this.name = 'UnknownCompanyError';
  }
}

export class SnapshotNotFoundError extends Error {
  constructor(readonly snapshotId: string) {
    super(`eligibility snapshot ${snapshotId} does not exist in this tenant`);
    this.name = 'SnapshotNotFoundError';
  }
}

/** Which company was asked about, and which canonical company answered (merge lineage). */
export interface CompanyResolution {
  readonly requestedCompanyId: string;
  readonly evaluatedCompanyId: string;
}

export type EvaluationReport = EligibilityResult &
  CompanyResolution & { readonly snapshotId?: string };
export type WhitespaceReport = WhitespaceResult & CompanyResolution;

export interface ReplayReport {
  readonly snapshotId: string;
  /** True when the stored model, evaluator and frozen facts reproduce the recorded result exactly. */
  readonly reproduced: boolean;
  readonly reason:
    | 'reproduced'
    | 'evaluator_changed'
    | 'model_hash_mismatch'
    | 'facts_hash_mismatch'
    | 'result_differs';
  readonly recorded: { status: string; ownership: string; factsHash: string };
  readonly replayed?: { status: string; ownership: string; factsHash: string };
}

/** The frozen input stored with a snapshot: identifiers, codes and dates only. */
const FrozenInputSchema = z.strictObject({
  account: z.strictObject({ companyId: CompanyIdSchema, customerStatus: CustomerStatusSchema }),
  ownership: z.discriminatedUnion('coverage', [
    z.strictObject({
      coverage: z.literal('known'),
      coverageTier: z.enum(['externally_grounded', 'stable_snapshot']),
      knownAsOf: InstantSchema,
      subscriptions: z.array(SubscriptionFactSchema),
    }),
    z.strictObject({
      coverage: z.literal('unknown'),
      coverageTier: z.literal('none'),
      reason: z.literal('ownership_incomplete').optional(),
    }),
  ]),
  asOf: InstantSchema,
});

const SnapshotResultSchema = z.object({ checks: z.array(z.unknown()), input: FrozenInputSchema });

const PURPOSE = /^[a-z0-9_]{1,64}$/;

/**
 * Eligibility and whitespace for one account (ADR 0018). Loads the account,
 * its subscription facts and the tenant's ownership coverage **once**, in one
 * repeatable-read transaction (a consistent picture even while lines or the
 * model change), then evaluates in memory with the pure evaluator. Optional
 * frozen snapshots record what a consumer relied on; replay re-evaluates the
 * frozen facts against the stored model version.
 */
@Injectable()
export class EligibilityService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly catalogue: ProductCatalogueService,
    private readonly queries: SubscriptionQueries,
    private readonly runs: SubscriptionRunsStore,
    private readonly snapshots: EligibilitySnapshotStore,
    @Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepository,
    private readonly audit: AuditTrail,
  ) {}

  /**
   * Evaluates one account × product. Recording a snapshot is a write: it needs
   * an operator authorized for `data.eligibility.record` (M10A1); a plain
   * evaluation needs only a tenant context.
   */
  async evaluate(
    target: TenantContext | AuthorizedContext<'data.eligibility.record'>,
    companyId: string,
    productKey: string,
    options: { asOf?: Date; record?: { purpose: string; correlationId: string } } = {},
  ): Promise<EvaluationReport> {
    if (options.record) assertAuthorized(target, 'data.eligibility.record');
    const ctx = target instanceof AuthorizedContext ? target.tenant : target;
    if (options.record && !PURPOSE.test(options.record.purpose)) {
      throw new Error('snapshot purpose must match [a-z0-9_]{1,64}');
    }
    const key = ProductKeySchema.parse(productKey);
    // The evaluation reads one consistent snapshot (REPEATABLE READ). Recording is a
    // separate READ COMMITTED transaction (M10A1): the snapshot row and its audit
    // event commit together, and the audit chain head is read as committed, which a
    // repeatable-read snapshot cannot guarantee. The recorded content is the frozen
    // input computed above, so the split changes nothing the snapshot says.
    const evaluated = await this.consistent(ctx, async (tx) => {
      const loaded = await this.load(tx, companyId, options.asOf ?? new Date());
      const result = evaluateEligibility({ ...loaded.input, productKey: key });
      return { loaded, result, report: { ...result, ...loaded.resolution } };
    });
    if (!options.record) return evaluated.report;
    const { loaded, result, report } = evaluated;
    const record = options.record;
    const actx = target as AuthorizedContext<'data.eligibility.record'>;
    return this.db.transaction(ctx, async (tx) => {
      const snapshot = await this.snapshots.insert(tx, {
        requestedCompanyId: loaded.resolution.requestedCompanyId,
        evaluatedCompanyId: loaded.resolution.evaluatedCompanyId,
        productKey: result.productKey,
        asOf: result.asOf,
        status: result.status,
        ownership: result.ownership,
        modelVersion: result.modelVersion,
        modelHash: result.modelHash,
        evaluatorVersion: result.evaluatorVersion,
        factsHash: result.factsHash,
        result: { checks: result.checks, input: frozenInput(loaded.input) },
        purpose: record.purpose,
        correlationId: record.correlationId,
      });
      await this.audit.record(tx, actx, {
        action: 'eligibility.record',
        targetKind: 'eligibility_snapshot',
        targetRef: snapshot.id,
        details: { productKey: result.productKey, purpose: record.purpose },
      });
      return { ...report, snapshotId: snapshot.id };
    });
  }

  /** Every catalogue product for one account, grouped (owned / eligible / ineligible / unknown). */
  async whitespace(
    ctx: TenantContext,
    companyId: string,
    options: { asOf?: Date } = {},
  ): Promise<WhitespaceReport> {
    return this.consistent(ctx, async (tx) => {
      const loaded = await this.load(tx, companyId, options.asOf ?? new Date());
      return { ...classifyWhitespace(loaded.input), ...loaded.resolution };
    });
  }

  async snapshot(ctx: TenantContext, id: string): Promise<SnapshotRow> {
    return this.db.transaction(ctx, async (tx) => {
      const row = await this.snapshots.byId(tx, id);
      if (!row) throw new SnapshotNotFoundError(id);
      return row;
    });
  }

  async listSnapshots(
    ctx: TenantContext,
    filter: { companyId?: string; productKey?: string; limit?: number } = {},
  ) {
    return this.db.transaction(ctx, (tx) => this.snapshots.list(tx, filter));
  }

  /**
   * Re-evaluates a snapshot's frozen facts against its stored model version
   * with the current evaluator. Never reads current subscriptions: later
   * changes to the account do not alter what was recorded.
   */
  async replay(ctx: TenantContext, id: string): Promise<ReplayReport> {
    return this.db.transaction(ctx, async (tx) => {
      const row = await this.snapshots.byId(tx, id);
      if (!row) throw new SnapshotNotFoundError(id);
      const recorded = { status: row.status, ownership: row.ownership, factsHash: row.factsHash };
      if (row.evaluatorVersion !== EVALUATOR_VERSION) {
        return { snapshotId: id, reproduced: false, reason: 'evaluator_changed', recorded };
      }
      const model = await this.catalogue.modelVersionTx(tx, row.modelVersion);
      if (!model || model.contentHash !== row.modelHash) {
        return { snapshotId: id, reproduced: false, reason: 'model_hash_mismatch', recorded };
      }
      const stored = SnapshotResultSchema.parse(row.result);
      const input = stored.input as {
        account: AccountFacts;
        ownership: OwnershipInput;
        asOf: Date;
      };
      const result = evaluateEligibility({
        model,
        ...input,
        productKey: ProductKeySchema.parse(row.productKey),
      });
      const replayed = {
        status: result.status,
        ownership: result.ownership,
        factsHash: result.factsHash,
      };
      if (result.factsHash !== row.factsHash) {
        return {
          snapshotId: id,
          reproduced: false,
          reason: 'facts_hash_mismatch',
          recorded,
          replayed,
        };
      }
      const same =
        result.status === row.status &&
        result.ownership === row.ownership &&
        canonicalJson(result.checks) === canonicalJson(stored.checks);
      return {
        snapshotId: id,
        reproduced: same,
        reason: same ? 'reproduced' : 'result_differs',
        recorded,
        replayed,
      };
    });
  }

  private consistent<T>(
    ctx: TenantContext,
    work: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(ctx, work, { isolationLevel: 'RepeatableRead' });
  }

  /** One load per request: model (cached per version), account, coverage, facts. */
  private async load(
    tx: TenantTransaction,
    companyId: string,
    asOf: Date,
  ): Promise<{
    input: {
      model: IndexedProductModel;
      account: AccountFacts;
      ownership: OwnershipInput;
      asOf: Date;
    };
    resolution: CompanyResolution;
  }> {
    const requested = CompanyIdSchema.safeParse(companyId);
    if (!requested.success) throw new UnknownCompanyError(companyId);
    if (!(await this.companies.findById(tx, requested.data)))
      throw new UnknownCompanyError(companyId);
    const evaluatedId = (await this.queries.canonicalCompany(tx, requested.data)) as CompanyId;
    const company = await this.companies.findById(tx, evaluatedId);
    if (!company) throw new UnknownCompanyError(evaluatedId);
    const model = await this.catalogue.modelAtTx(tx, asOf);
    if (!model) throw new NoProductModelError(asOf);
    const coverage = await this.runs.coverage(tx);
    let ownership: OwnershipInput = { coverage: 'unknown', coverageTier: 'none' };
    if (coverage.known) {
      // An account holding a line whose product cannot be known is never
      // "covered": no not-owned inference, no eligible whitespace (ADR 0020 §15).
      const gaps = await this.queries.ownershipGapCount(tx, coverage.connectionId, evaluatedId);
      ownership =
        gaps > 0
          ? { coverage: 'unknown', coverageTier: 'none', reason: 'ownership_incomplete' }
          : {
              coverage: 'known',
              // The tier of the run that established coverage (ADR 0023).
              coverageTier: coverage.coverageTier,
              knownAsOf: coverage.knownAsOf,
              subscriptions: await this.queries.factsForCompany(
                tx,
                evaluatedId,
                coverage.sourceSystem,
              ),
            };
    }
    return {
      input: {
        model,
        account: { companyId: evaluatedId, customerStatus: company.customerStatus },
        ownership,
        asOf,
      },
      resolution: { requestedCompanyId: requested.data, evaluatedCompanyId: evaluatedId },
    };
  }
}

function frozenInput(input: {
  account: AccountFacts;
  ownership: OwnershipInput;
  asOf: Date;
}): unknown {
  return JSON.parse(
    canonicalJson({ account: input.account, ownership: input.ownership, asOf: input.asOf }),
  );
}
