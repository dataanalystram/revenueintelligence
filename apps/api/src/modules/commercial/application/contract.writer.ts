import { Injectable } from '@nestjs/common';
import { CONTRACT_LINK_KINDS, type ContractLinkKind } from '../../domain';
import { GovernanceError, ModuleGate, SourceReferenceService } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  TenantDatabase,
  WriteAuthorizer,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  CommercialStore,
  type ContractRow,
  type SourceRef,
} from '../infrastructure/commercial.store';
import {
  CONTRACT_ATTRIBUTES,
  decideAttributes,
  heldAttributes,
  LINK_ATTRIBUTE,
  linkClosesCycle,
  validateContract,
  type CommercialRejection,
  type ContractAttribute,
  type ContractAttributes,
  type Plain,
} from './commercial.rules';
import {
  applyDecision,
  linkIssue,
  operatorProvenance,
  presentFields,
  recordCreated,
  recordOverride,
  referenceMeta,
  refString,
  requireAccountContextModule,
  requireCommercial,
  requireReason,
  requireUuid,
  unresolvedIssue,
  type CommercialProvenance,
} from './commercial.shared';
import { releaseHold } from './price-offer.writer';

/** One source observation of a contract header (built by the mapping engine, phase 2b). */
export interface ContractObservation {
  /** The canonical account, already resolved from the account reference by the caller. */
  readonly companyId: string;
  readonly ref: SourceRef;
  readonly presence: 'present' | 'absent';
  /** The account context, resolved by the caller (needs module `account_context`, Q13). */
  readonly contextId?: string | null;
  /** ISO timestamps or null. */
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  /** `YYYY-MM-DD` or null. */
  readonly renewalDate?: string | null;
  readonly autoRenew?: boolean | null;
  readonly status?: string;
  readonly totalValueMinor?: number | null;
  readonly totalValueCurrency?: string | null;
  /** Contracts of the same connection this one renews / amends / is a child of (source ids). */
  readonly links?: Partial<Record<ContractLinkKind, SourceRef | null>>;
  readonly observedAt: Date;
  readonly provenance: CommercialProvenance;
}

export type ContractRejection =
  CommercialRejection | 'account_unknown' | 'account_merged' | 'account_changed';

export interface ContractObserveOutcome {
  readonly status:
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'rejected'
    | 'canonical_version_too_low'
    | 'module_disabled';
  readonly reason?: ContractRejection;
  readonly contractId?: string;
  readonly humanOverride?: number;
  /** Why the mapped context was not set (counted `context_assignment_skipped`). */
  readonly contextSkipped?: 'module_disabled' | 'context_unknown' | 'context_mismatch';
  /** Links refused (cycle / cross-account; conflict rows) and unresolved (conflict rows). */
  readonly linksRefused?: number;
  readonly linksUnresolved?: number;
}

export interface OperatorContractWrite {
  readonly contract?: string;
  readonly account?: string;
  readonly context?: string | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly renewalDate?: string | null;
  readonly autoRenew?: boolean | null;
  readonly status?: string;
  readonly totalValueMinor?: number | null;
  readonly totalValueCurrency?: string | null;
  readonly reason: string;
}

export interface OperatorContractLink {
  readonly contract: string;
  readonly kind: ContractLinkKind;
  /** null clears the link. */
  readonly target: string | null;
  readonly reason: string;
}

export interface ContractWritten {
  readonly contractId: string;
  readonly created: boolean;
  readonly changed: boolean;
}

const HISTORY: Partial<Record<ContractAttribute, string>> = {
  status: 'status',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  renewalDate: 'renewal_date',
};

const RELATIONSHIP_FIELDS: readonly ContractAttribute[] = [
  'contextId',
  'renewsContractId',
  'amendsContractId',
  'parentContractId',
];

const VALUE_ATTRIBUTES = [
  'startsAt',
  'endsAt',
  'renewalDate',
  'autoRenew',
  'status',
  'totalValueMinor',
  'totalValueCurrency',
] as const;

export const attributesOfContract = (r: ContractRow): ContractAttributes => ({
  contextId: r.contextId,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  renewalDate: r.renewalDate,
  autoRenew: r.autoRenew,
  status: r.status,
  totalValueMinor: r.totalValueMinor,
  totalValueCurrency: r.totalValueCurrency,
  renewsContractId: r.renewsContractId,
  amendsContractId: r.amendsContractId,
  parentContractId: r.parentContractId,
});

type Incoming = Partial<Record<ContractAttribute, Plain>>;

function valuesOf(input: Partial<Record<(typeof VALUE_ATTRIBUTES)[number], unknown>>): Incoming {
  const out: Incoming = {};
  for (const k of VALUE_ATTRIBUTES) {
    const v = input[k];
    if (v !== undefined) out[k] = v as Plain;
  }
  return out;
}

function createAttributes(i: Incoming): ContractAttributes {
  const get = <T>(k: ContractAttribute, d: T): T => (i[k] === undefined ? d : (i[k] as T));
  return {
    contextId: get('contextId', null),
    startsAt: get('startsAt', null),
    endsAt: get('endsAt', null),
    renewalDate: get('renewalDate', null),
    autoRenew: get('autoRenew', null),
    status: get('status', 'unknown'),
    totalValueMinor: get('totalValueMinor', null),
    totalValueCurrency: get('totalValueCurrency', null),
    renewsContractId: get('renewsContractId', null),
    amendsContractId: get('amendsContractId', null),
    parentContractId: get('parentContractId', null),
  };
}

const changeTypeOf = (fields: readonly ContractAttribute[]) =>
  fields.includes('status')
    ? ('state_changed' as const)
    : fields.every((f) => RELATIONSHIP_FIELDS.includes(f))
      ? ('relationship_changed' as const)
      : ('updated' as const);

/**
 * The single writer of `tenant_contracts` and their three links (M10F plan
 * §5.2; ADR 0032). Gate (0.6 + module), provenance, holds (Q17) and audit as
 * `PriceOfferWriter`. Lock order (Q16): the account (`company-canonical`) →
 * `contract-graph` (every contract write; the link guards serialise on it)
 * → the contract row. A link that would close a cycle over the union of the
 * three kinds (Q7) or reach another account (Q12) is refused: from a source
 * with a conflict row (`contract_link_cycle_refused` /
 * `contract_link_cross_account`) and the contract written without that link;
 * from an operator as a refusal. `context_id` only with module
 * `account_context` enabled (Q13). A status change never cascades to lines.
 */
@Injectable()
export class ContractWriter {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: CommercialStore,
    private readonly references: SourceReferenceService,
    readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
    private readonly moduleGate: ModuleGate,
  ) {}

  observeSource(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: ContractObservation,
  ): Promise<ContractObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, (tx) => this.observe(actx, tx, input));
  }

  async observe(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: ContractObservation,
  ): Promise<ContractObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('contract tenant does not match the transaction tenant');
    }
    const gate = await this.store.gate(tx);
    if (gate !== 'ok') return { status: gate };
    const reject = (reason: ContractRejection): ContractObserveOutcome => ({
      status: 'rejected',
      reason,
    });
    await this.store.lockCompanies(tx, [input.companyId]);
    const company = await this.store.company(tx, input.companyId);
    if (!company) return reject('account_unknown');
    if (company.recordState === 'merged') return reject('account_merged');
    // One record per source triple (V34).
    await this.store.lockSourceRef(tx, input.ref);
    const byRef = await this.store.entityForRef(tx, 'contract', input.ref);
    if (input.presence === 'absent') {
      if (byRef) await this.observeReference(actx, tx, input, byRef);
      return { status: 'unchanged', ...(byRef ? { contractId: byRef } : {}) };
    }
    // Lock order: contract-graph, then the contract row.
    await this.store.lockContractGraph(tx);
    if (byRef) await this.store.lockRows(tx, 'tenant_contracts', [byRef]);
    const row = byRef ? await this.store.contract(tx, byRef) : undefined;
    if (row && row.companyId !== input.companyId) return reject('account_changed');

    const incoming = valuesOf(input);
    let contextSkipped: ContractObserveOutcome['contextSkipped'];
    if (input.contextId !== undefined) {
      const ctx = await this.contextFor(tx, input.companyId, input.contextId);
      if (ctx === 'ok') incoming.contextId = input.contextId;
      else contextSkipped = ctx;
    }
    // Links: resolved through the generic contract references of the same connection.
    let linksUnresolved = 0;
    const proposed: Partial<Record<ContractLinkKind, string | null>> = {};
    for (const kind of CONTRACT_LINK_KINDS) {
      const ref = input.links?.[kind];
      if (ref === undefined) continue;
      if (ref === null) {
        proposed[kind] = null;
        continue;
      }
      const target = await this.store.entityForRef(tx, 'contract', ref);
      const identity = unresolvedIssue(tx.tenantId, `contract-link-${kind}`, refString(input.ref));
      if (!target) {
        linksUnresolved += 1;
        await this.store.recordIssue(tx, {
          kind: 'contract_reference_unresolved',
          entityKind: 'contract',
          identity,
          canonicalIds: row ? [row.id] : [],
          externalRefs: [refString(input.ref), refString(ref)],
        });
        continue;
      }
      await this.store.resolveIssue(tx, 'contract_reference_unresolved', identity);
      proposed[kind] = target;
    }

    const held = row
      ? heldAttributes(await this.store.humanChanges(tx, 'contract', row.id), CONTRACT_ATTRIBUTES)
      : new Set<ContractAttribute>();
    const before = row ? attributesOfContract(row) : undefined;
    // Held links are never re-linked by the source (Q17); they count as disagreements below.
    const links = await this.acceptLinks(
      tx,
      row?.id,
      input.companyId,
      proposed,
      held,
      before,
      input.ref,
    );
    for (const [kind, target] of Object.entries(links.accepted) as [
      ContractLinkKind,
      string | null,
    ][]) {
      incoming[LINK_ATTRIBUTE[kind]] = target;
    }

    if (!row) {
      const attrs = createAttributes(incoming);
      const bad = validateContract(attrs);
      if (bad) return reject(bad);
      const id = await this.create(tx, input.companyId, attrs, input.provenance, input.observedAt);
      await this.observeReference(actx, tx, input, id);
      return {
        status: 'created',
        contractId: id,
        ...summary(contextSkipped, links.refused, linksUnresolved),
      };
    }
    const decision = decideAttributes<ContractAttribute>(before!, incoming, held);
    const bad = validateContract({ ...before!, ...decision.apply } as ContractAttributes);
    if (bad) return reject(bad);
    const disagreements = decision.disagreements.length + links.heldDisagreements;
    await recordOverride(tx, this.store, 'contract', row.id, disagreements, input.ref);
    const changed = await this.apply(tx, row, decision, input.provenance, input.observedAt);
    await this.observeReference(actx, tx, input, row.id);
    return {
      status: changed ? 'updated' : 'unchanged',
      contractId: row.id,
      ...(disagreements ? { humanOverride: disagreements } : {}),
      ...summary(contextSkipped, links.refused, linksUnresolved),
    };
  }

  /**
   * Under the `contract-graph` lock: each proposed link is checked against
   * the target's account (Q12) and the union graph (Q7) with the links
   * accepted so far. A refused link records its conflict; an accepted link
   * resolves it.
   */
  private async acceptLinks(
    tx: TenantTransaction,
    contractId: string | undefined,
    companyId: string,
    proposed: Partial<Record<ContractLinkKind, string | null>>,
    held: ReadonlySet<ContractAttribute>,
    before: ContractAttributes | undefined,
    ref: SourceRef,
  ): Promise<{
    accepted: Partial<Record<ContractLinkKind, string | null>>;
    refused: number;
    heldDisagreements: number;
  }> {
    const accepted: Partial<Record<ContractLinkKind, string | null>> = {};
    let refused = 0;
    let heldDisagreements = 0;
    const kinds = Object.keys(proposed) as ContractLinkKind[];
    if (kinds.length === 0) return { accepted, refused, heldDisagreements };
    const graph = await this.store.contractGraph(tx);
    const outgoing = new Set(contractId ? (graph.get(contractId) ?? []) : []);
    for (const kind of kinds) {
      const target = proposed[kind]!;
      const attr = LINK_ATTRIBUTE[kind];
      const current = before ? before[attr] : null;
      if (target === current) continue;
      if (held.has(attr)) {
        heldDisagreements += 1;
        continue;
      }
      const identity = linkIssue(tx.tenantId, contractId ?? refString(ref), kind);
      if (target === null) {
        accepted[kind] = null;
        continue;
      }
      const targetRow = await this.store.contract(tx, target);
      const crossAccount = !targetRow || targetRow.companyId !== companyId;
      const cycle =
        !crossAccount &&
        contractId !== undefined &&
        linkClosesCycle(withOutgoing(graph, contractId, outgoing), contractId, target);
      if (crossAccount || cycle) {
        refused += 1;
        await this.store.recordIssue(tx, {
          kind: crossAccount ? 'contract_link_cross_account' : 'contract_link_cycle_refused',
          entityKind: 'contract',
          identity,
          canonicalIds: [...(contractId ? [contractId] : []), target],
          externalRefs: [refString(ref)],
        });
        continue;
      }
      await this.store.resolveIssue(tx, 'contract_link_cross_account', identity);
      await this.store.resolveIssue(tx, 'contract_link_cycle_refused', identity);
      if (current) outgoing.delete(current as string);
      outgoing.add(target);
      accepted[kind] = target;
    }
    return { accepted, refused, heldDisagreements };
  }

  private async contextFor(
    tx: TenantTransaction,
    companyId: string,
    contextId: string | null,
  ): Promise<'ok' | 'module_disabled' | 'context_unknown' | 'context_mismatch'> {
    if (!(await this.store.moduleEnabled(tx, 'account_context'))) return 'module_disabled';
    if (contextId === null) return 'ok';
    const ctx = await this.store.contextCompany(tx, contextId);
    if (!ctx || ctx.recordState === 'merged') return 'context_unknown';
    return ctx.companyId === companyId ? 'ok' : 'context_mismatch';
  }

  private async observeReference(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: ContractObservation,
    id: string,
  ): Promise<void> {
    await this.references.observe(actx, tx, {
      system: input.ref.system,
      objectType: input.ref.objectType,
      externalId: input.ref.id,
      entityKind: 'contract',
      entityId: id,
      presence: input.presence,
      observedAt: input.observedAt,
      ...(input.provenance.sourceUpdatedAt
        ? { sourceUpdatedAt: input.provenance.sourceUpdatedAt }
        : {}),
      meta: referenceMeta(input.provenance),
    });
  }

  private async create(
    tx: TenantTransaction,
    companyId: string,
    attrs: ContractAttributes,
    provenance: CommercialProvenance | ((id: string) => CommercialProvenance),
    effectiveAt: Date,
  ): Promise<string> {
    const id = await this.store.insertContract(tx, companyId, attrs);
    const changeId = await recordCreated(tx, this.store, {
      entityKind: 'contract',
      entityId: id,
      fields: [...presentFields(attrs), 'companyId'],
      provenance: typeof provenance === 'function' ? provenance(id) : provenance,
      effectiveAt,
      history: [
        { field: 'status', value: attrs.status },
        { field: 'starts_at', value: attrs.startsAt },
        { field: 'ends_at', value: attrs.endsAt },
        { field: 'renewal_date', value: attrs.renewalDate },
      ],
    });
    await this.store.updateContract(tx, id, { lastChangeId: changeId });
    return id;
  }

  private apply(
    tx: TenantTransaction,
    row: ContractRow,
    decision: ReturnType<typeof decideAttributes<ContractAttribute>>,
    provenance: CommercialProvenance,
    effectiveAt: Date,
  ): Promise<boolean> {
    return applyDecision(tx, this.store, {
      entityKind: 'contract',
      entityId: row.id,
      before: attributesOfContract(row),
      decision,
      provenance,
      effectiveAt,
      history: HISTORY,
      changeType: changeTypeOf,
      update: (apply) =>
        this.store.updateContract(tx, row.id, apply as Partial<ContractAttributes>),
    });
  }

  // --- Operator entry ------------------------------------------------------------------

  // MUTATION VM9b: @AuditFailures removed
  async write(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorContractWrite,
  ): Promise<ContractWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = input.contract ? requireUuid(input.contract, '--contract') : undefined;
    const account = input.account ? requireUuid(input.account, '--account') : undefined;
    const context =
      input.context === undefined || input.context === null
        ? input.context
        : requireUuid(input.context, '--context');
    if (!id && !account) {
      throw new GovernanceError('validation_failed', 'Name --contract, or --account to create one');
    }
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'commercial.contract.write', targetKind: 'contract' },
      { status: input.status ?? null, currency: input.totalValueCurrency ?? null },
    );
    const incoming = valuesOf(input);
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireCommercial(tx, actx, this.store, this.moduleGate);
      if (context !== undefined) await requireAccountContextModule(tx, actx, this.moduleGate);
      if (!id) {
        await this.store.lockCompanies(tx, [account]);
        const company = await this.store.company(tx, account!);
        if (!company || company.recordState === 'merged') {
          throw new GovernanceError(
            'validation_failed',
            'The account must exist and not be merged',
          );
        }
        await this.store.lockContractGraph(tx);
        if (context !== undefined) {
          await this.requireContext(tx, account!, context);
          incoming.contextId = context;
        }
        const attrs = createAttributes(incoming);
        const bad = validateContract(attrs);
        if (bad) throw new GovernanceError('validation_failed', `Refused: ${bad}`, { code: bad });
        const newId = await this.create(
          tx,
          account!,
          attrs,
          (cid) => operatorProvenance(actx.actor, actx.correlationId, cid),
          new Date(),
        );
        await this.audit.record(tx, actx, {
          action: 'commercial.contract.write',
          targetKind: 'contract',
          targetRef: newId,
          details: { reason, created: true, changed: true },
        });
        return { contractId: newId, created: true, changed: true };
      }
      const row = await this.lockedContract(tx, id);
      if (context !== undefined) {
        await this.requireContext(tx, row.companyId, context);
        incoming.contextId = context;
      }
      const before = attributesOfContract(row);
      const decision = decideAttributes<ContractAttribute>(before, incoming);
      const bad = validateContract({ ...before, ...decision.apply } as ContractAttributes);
      if (bad) throw new GovernanceError('validation_failed', `Refused: ${bad}`, { code: bad });
      const changed = await this.apply(
        tx,
        row,
        decision,
        operatorProvenance(actx.actor, actx.correlationId, id),
        new Date(),
      );
      await this.audit.record(tx, actx, {
        action: 'commercial.contract.write',
        targetKind: 'contract',
        targetRef: id,
        details: { reason, created: false, changed, fields: [...decision.changedFields] },
      });
      return { contractId: id, created: false, changed };
    });
  }

  /** `contract link` / `unlink` (plan §5.2): refused on a cycle (Q7) or another account (Q12). */
  @AuditFailures('commercial.contract.link', 'contract')
  async link(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorContractLink,
  ): Promise<ContractWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = requireUuid(input.contract, '--contract');
    if (!(CONTRACT_LINK_KINDS as readonly string[]).includes(input.kind)) {
      throw new GovernanceError('validation_failed', '--kind must be renews, amends or parent');
    }
    const target = input.target === null ? null : requireUuid(input.target, '--target');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireCommercial(tx, actx, this.store, this.moduleGate);
      const row = await this.lockedContract(tx, id);
      const attr = LINK_ATTRIBUTE[input.kind];
      if (target !== null) {
        const targetRow = await this.store.contract(tx, target);
        if (!targetRow) {
          throw new GovernanceError('validation_failed', 'The target contract does not exist');
        }
        if (targetRow.companyId !== row.companyId) {
          throw new GovernanceError('validation_failed', 'Refused: contract_link_cross_account', {
            code: 'contract_link_cross_account',
          });
        }
        const graph = await this.store.contractGraph(tx);
        const outgoing = new Set(graph.get(id) ?? []);
        if (row[attr]) outgoing.delete(row[attr] as string);
        if (linkClosesCycle(withOutgoing(graph, id, outgoing), id, target)) {
          throw new GovernanceError('validation_failed', 'Refused: contract_link_cycle', {
            code: 'contract_link_cycle',
          });
        }
      }
      const decision = decideAttributes<ContractAttribute>(attributesOfContract(row), {
        [attr]: target,
      });
      const changed = await this.apply(
        tx,
        row,
        decision,
        operatorProvenance(actx.actor, actx.correlationId, id),
        new Date(),
      );
      await this.audit.record(tx, actx, {
        action: 'commercial.contract.link',
        targetKind: 'contract',
        targetRef: id,
        details: {
          reason,
          kind: input.kind,
          ...(target ? { target } : {}),
          cleared: target === null,
          changed,
        },
      });
      return { contractId: id, created: false, changed };
    });
  }

  @AuditFailures('commercial.release', 'contract')
  async release(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: { readonly contract: string; readonly reason: string },
  ): Promise<{ readonly contractId: string; readonly released: number }> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = requireUuid(input.contract, '--contract');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireCommercial(tx, actx, this.store, this.moduleGate);
      await this.lockedContract(tx, id);
      const released = await releaseHold(
        tx,
        this.store,
        actx,
        'contract',
        id,
        (changeId) => this.store.updateContract(tx, id, { lastChangeId: changeId }),
        CONTRACT_ATTRIBUTES,
      );
      await this.audit.record(tx, actx, {
        action: 'commercial.release',
        targetKind: 'contract',
        targetRef: id,
        details: { reason, kind: 'contract', released },
      });
      return { contractId: id, released };
    });
  }

  private async requireContext(
    tx: TenantTransaction,
    companyId: string,
    contextId: string | null,
  ): Promise<void> {
    const state = await this.contextFor(tx, companyId, contextId);
    if (state !== 'ok') {
      throw new GovernanceError('validation_failed', `Refused: ${state}`, { code: state });
    }
  }

  /**
   * The contract with its account locked and stable under the lock (a merge
   * may move it), then `contract-graph`, then the row (lock order Q16).
   */
  private async lockedContract(tx: TenantTransaction, id: string): Promise<ContractRow> {
    let row = await this.store.contract(tx, id);
    for (let i = 0; row && i < 3; i += 1) {
      await this.store.lockCompanies(tx, [row.companyId]);
      const again = await this.store.contract(tx, id);
      if (again?.companyId === row.companyId) {
        await this.store.lockContractGraph(tx);
        await this.store.lockRows(tx, 'tenant_contracts', [id]);
        return (await this.store.contract(tx, id))!;
      }
      row = again;
    }
    throw new GovernanceError(
      'validation_failed',
      row ? 'The contract account kept moving; retry' : 'The contract does not exist',
    );
  }
}

/** The graph with `id`'s outgoing links replaced. */
function withOutgoing(
  graph: ReadonlyMap<string, readonly string[]>,
  id: string,
  outgoing: ReadonlySet<string>,
): Map<string, readonly string[]> {
  const g = new Map(graph);
  g.set(id, [...outgoing]);
  return g;
}

function summary(
  contextSkipped: ContractObserveOutcome['contextSkipped'],
  refused: number,
  unresolved: number,
): Partial<ContractObserveOutcome> {
  return {
    ...(contextSkipped ? { contextSkipped } : {}),
    ...(refused ? { linksRefused: refused } : {}),
    ...(unresolved ? { linksUnresolved: unresolved } : {}),
  };
}
