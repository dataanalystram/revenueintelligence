import { Injectable } from '@nestjs/common';
import type { ContractLinkKind } from '../../domain';
import {
  assertAuthorized,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import { CommercialStore, type SourceRef } from '../infrastructure/commercial.store';
import {
  CommercialLineReferenceStep,
  type LineReferenceObservation,
  type LineReferenceOutcome,
} from './commercial-line-reference.step';
import { refString, unresolvedIssue, type CommercialProvenance } from './commercial.shared';
import { ContractWriter, type ContractObserveOutcome } from './contract.writer';
import { EntitlementWriter, type EntitlementObserveOutcome } from './entitlement.writer';
import {
  PriceOfferWriter,
  type PriceOfferObservation,
  type PriceOfferObserveOutcome,
} from './price-offer.writer';

/** One mapped `contract` record, references unresolved (plan §6.1). */
export interface ContractSourceRecord {
  readonly ref: SourceRef;
  readonly accountRef: SourceRef;
  readonly contextRef?: SourceRef;
  readonly presence: 'present' | 'absent';
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly renewalDate?: string | null;
  readonly autoRenew?: boolean | null;
  readonly status?: string;
  readonly totalValueMinor?: number | null;
  readonly totalValueCurrency?: string | null;
  readonly links: Partial<Record<ContractLinkKind, SourceRef>>;
  readonly observedAt: Date;
  readonly provenance: CommercialProvenance;
}

export interface ContractSourceOutcome extends ContractObserveOutcome {
  /** The mapped context reference did not resolve (counted; the contract is written without it). */
  readonly contextUnresolved?: boolean;
  /** Q14: other-source contracts of the same account and term (conflict rows). */
  readonly duplicates?: number;
}

/** One mapped `entitlement` record, account reference unresolved. */
export interface EntitlementSourceRecord {
  readonly ref: SourceRef;
  readonly accountRef: SourceRef;
  readonly presence: 'present' | 'absent';
  readonly productKey?: string;
  readonly quantity?: number | null;
  readonly status?: string;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly observedAt: Date;
  readonly provenance: CommercialProvenance;
}

/** A line waiting for its contract, resolved by the run's second pass (plan §6.3). */
export interface WaitingLineResolution {
  readonly lineId: string;
  readonly outcome: LineReferenceOutcome['contract'] | 'gate_closed';
}

const issueRef = (tenantId: string, scope: string, ref: SourceRef) =>
  unresolvedIssue(tenantId, scope, refString(ref));
const duplicateIssue = (tenantId: string, ids: readonly string[]) =>
  `${tenantId}|commercial-duplicate|${[...ids].sort().join('|')}`;

/**
 * The source-sync entry of the commercial module (M10F phase 2b, plan §6;
 * M10E `AccountContextSourceSync` pattern). The sources module calls it only
 * when the run's connection holds the entity's authority fact
 * (`price_offer` / `contract` / `entitlement`, decided by the sync run, M10E
 * D13); this service resolves the record's account / context references
 * inside one transaction and hands canonical ids to the single writers. Gate
 * closed (canonical < 0.6 or module disabled) → the writer's outcome, nothing
 * written, no audit row (the run counts it, M10E pattern).
 *
 * The line references run inside the line transaction (`lineReferences`, via
 * the products `LineAfterWrite` port, so products never imports commercial);
 * the second resolution pass (`resolveWaitingLines`) re-runs the step for
 * lines whose `agreement_ref` names a contract written in this run and that
 * have no contract yet, one transaction per line under the step's lock order.
 */
@Injectable()
export class CommercialSourceSync {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: CommercialStore,
    private readonly offers: PriceOfferWriter,
    private readonly contracts: ContractWriter,
    private readonly entitlements: EntitlementWriter,
    private readonly lines: CommercialLineReferenceStep,
  ) {}

  observePriceOffer(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: PriceOfferObservation,
  ): Promise<PriceOfferObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.offers.observeSource(actx, input);
  }

  async observeContract(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: ContractSourceRecord,
  ): Promise<ContractSourceOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, async (tx) => {
      const gate = await this.store.gate(tx);
      if (gate !== 'ok') return { status: gate };
      const companyId = await this.account(tx, 'contract-account', input.ref, input.accountRef);
      if (!companyId) return { status: 'rejected', reason: 'account_unknown' };
      let contextId: string | undefined;
      let contextUnresolved = false;
      if (input.contextRef) {
        contextId = await this.store.contextForRef(tx, input.contextRef);
        contextUnresolved = contextId === undefined;
      }
      const out = await this.contracts.observe(actx, tx, {
        companyId,
        ref: input.ref,
        presence: input.presence,
        ...(contextId !== undefined ? { contextId } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.renewalDate !== undefined ? { renewalDate: input.renewalDate } : {}),
        ...(input.autoRenew !== undefined ? { autoRenew: input.autoRenew } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.totalValueMinor !== undefined ? { totalValueMinor: input.totalValueMinor } : {}),
        ...(input.totalValueCurrency !== undefined
          ? { totalValueCurrency: input.totalValueCurrency }
          : {}),
        links: input.links,
        observedAt: input.observedAt,
        provenance: input.provenance,
      });
      let duplicates = 0;
      if (out.contractId && out.status !== 'rejected' && input.presence === 'present') {
        duplicates = await this.duplicateSource(tx, out.contractId, input.ref);
      }
      return {
        ...out,
        ...(contextUnresolved ? { contextUnresolved } : {}),
        ...(duplicates ? { duplicates } : {}),
      };
    });
  }

  async observeEntitlement(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: EntitlementSourceRecord,
  ): Promise<EntitlementObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, async (tx) => {
      const gate = await this.store.gate(tx);
      if (gate !== 'ok') return { status: gate };
      const companyId = await this.account(tx, 'entitlement-account', input.ref, input.accountRef);
      if (!companyId) return { status: 'rejected', reason: 'account_unknown' };
      return this.entitlements.observe(actx, tx, {
        companyId,
        ref: input.ref,
        presence: input.presence,
        ...(input.productKey !== undefined ? { productKey: input.productKey } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        observedAt: input.observedAt,
        provenance: input.provenance,
      });
    });
  }

  /** The line's commercial references, inside the line transaction (plan §5.4). */
  lineReferences(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: LineReferenceObservation,
  ): Promise<LineReferenceOutcome> {
    return this.lines.applyFromSource(actx, tx, input);
  }

  /**
   * The run's second resolution pass (plan §6.3, Q1): lines whose
   * `agreement_ref` names one of `contracts` (written in this run) and that
   * have no contract yet are re-run through the line-reference step, one
   * transaction per line (the step's lock order: account → contract row →
   * line row). A line the pass cannot resolve keeps its open conflict.
   */
  async resolveWaitingLines(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: {
      readonly contracts: readonly SourceRef[];
      readonly provenance: (line: SourceRef) => CommercialProvenance;
      readonly observedAt: Date;
    },
  ): Promise<WaitingLineResolution[]> {
    assertAuthorized(actx, 'canonical.source_sync');
    const out: WaitingLineResolution[] = [];
    const seen = new Set<string>();
    for (const contract of input.contracts) {
      const waiting = await this.db.transaction(actx.tenant, async (tx) =>
        (await this.store.gate(tx)) === 'ok' ? this.store.linesAwaitingContract(tx, contract) : [],
      );
      for (const line of waiting) {
        if (seen.has(line.id)) continue;
        seen.add(line.id);
        const lineRef = {
          system: line.sourceSystem,
          objectType: line.sourceObjectType,
          id: line.sourceRecordId,
        };
        const result = await this.db.transaction(actx.tenant, (tx) =>
          this.lines.applyFromSource(actx, tx, {
            lineId: line.id,
            agreementRef: {
              system: contract.system,
              objectType: contract.objectType,
              externalId: contract.id,
            },
            provenance: input.provenance(lineRef),
            observedAt: input.observedAt,
          }),
        );
        out.push({
          lineId: line.id,
          outcome: result.status === 'applied' ? result.contract : 'gate_closed',
        });
      }
    }
    return out;
  }

  /** The canonical account of a commercial record, else an open unresolved conflict. */
  private async account(
    tx: TenantTransaction,
    scope: string,
    ref: SourceRef,
    accountRef: SourceRef,
  ): Promise<string | undefined> {
    const companyId = await this.store.companyForRef(tx, accountRef);
    const identity = issueRef(tx.tenantId, scope, ref);
    if (!companyId) {
      await this.store.recordIssue(tx, {
        kind: 'contract_reference_unresolved',
        entityKind: scope === 'contract-account' ? 'contract' : 'entitlement',
        identity,
        canonicalIds: [],
        externalRefs: [refString(ref), refString(accountRef)],
      });
      return undefined;
    }
    await this.store.resolveIssue(tx, 'contract_reference_unresolved', identity);
    return companyId;
  }

  /**
   * Q14 (no contract merge in M10F): another contract of the same account and
   * the same term known only through a different source system is recorded as
   * `contract_duplicate_source` for review. A detection heuristic, not proof;
   * nothing is merged or changed.
   */
  private async duplicateSource(
    tx: TenantTransaction,
    contractId: string,
    ref: SourceRef,
  ): Promise<number> {
    const row = await this.store.contract(tx, contractId);
    if (!row?.startsAt || !row.endsAt) return 0;
    const others = await this.store.duplicateSourceContracts(
      tx,
      { id: row.id, companyId: row.companyId, startsAt: row.startsAt, endsAt: row.endsAt },
      ref.system,
    );
    for (const other of others) {
      await this.store.recordIssue(tx, {
        kind: 'contract_duplicate_source',
        entityKind: 'contract',
        identity: duplicateIssue(tx.tenantId, [row.id, other]),
        canonicalIds: [row.id, other],
        externalRefs: [refString(ref)],
      });
    }
    return others.length;
  }
}
