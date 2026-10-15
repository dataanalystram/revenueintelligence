import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ACCOUNT_STRUCTURE_CONFLICT_KINDS,
  decideParentChange,
  type ExternalRef,
  type HierarchyRefusal,
  type IdentityConflictKind,
  type ParentDecision,
  type ParentRequest,
} from '../../domain';
import { GovernanceError } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  recordValueHistory,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { AccountStructureStore } from '../infrastructure/account-structure.store';
import type { CompanyMerge, CompanyMergeParticipant } from '../merge-participants';
import {
  accountStructureEnabled,
  operatorProvenance,
  requireAccountStructure,
  requireReason,
  requireUuid,
  type StructureProvenance,
} from './account-structure.shared';

/** Refusal → the interim data-quality issue kind it is recorded under (plan §2.6). */
const REFUSAL_ISSUE: Readonly<Record<HierarchyRefusal, IdentityConflictKind>> = {
  hierarchy_cycle: 'hierarchy_cycle_refused',
  hierarchy_depth_exceeded: 'hierarchy_depth_exceeded',
  hierarchy_parent_merged: 'hierarchy_parent_merged',
};

const HIERARCHY_ISSUE_KINDS = ACCOUNT_STRUCTURE_CONFLICT_KINDS.filter((k) =>
  k.startsWith('hierarchy_'),
);

/** One issue row per (kind, child): the identity every hierarchy issue of a child uses. */
export function hierarchyIssueIdentity(tenantId: string, childId: string): string {
  return `${tenantId}|hierarchy|${childId}`;
}

export type ParentObservationOutcome =
  'applied' | 'unchanged' | 'refused' | 'human_override' | 'unresolved' | 'disabled';

export interface ParentObservation {
  /** The canonical child. */
  readonly childId: string;
  /** The child's source reference (the observation's coordinates). */
  readonly childRef: ExternalRef;
  readonly parent: { readonly kind: 'set'; readonly ref: ExternalRef } | { readonly kind: 'clear' };
  readonly effectiveAt: Date;
  readonly provenance: StructureProvenance;
}

export interface OperatorParentInput {
  readonly companyId: string;
  /** Required for `set`. */
  readonly parentId?: string;
  readonly reason: string;
}

export interface OperatorParentResult {
  readonly companyId: string;
  readonly parentId: string | null;
  readonly origin: string | null;
  readonly changed: boolean;
}

/**
 * The single writer of the account hierarchy (M10C plan §2, ADR 0029):
 * `companies.parent_company_id` and `parent_company_origin`. Source writes come
 * from `ContextIngestionService` (authority already checked by the mapping
 * engine: an observation carries a parent only for the `account_hierarchy`
 * authority); operator writes (set / clear / release) need
 * `canonical.human_entry` and write one audit event each. Every accepted change
 * writes one change record and a full value-history row in the same
 * transaction. Refusals leave the parent unchanged and record an open issue.
 * The `companies_hierarchy_guard` trigger (cycle, merged parent, ceiling,
 * per-tenant lock) is the boundary; this writer takes the same lock first.
 */
@Injectable()
export class AccountHierarchyWriter {
  private readonly logger = new Logger(AccountHierarchyWriter.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly store: AccountStructureStore,
    readonly audit: AuditTrail,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get maxDepth(): number {
    return (this.config as Partial<AppConfig>).canonical?.hierarchyMaxDepth ?? 10;
  }

  /**
   * One authoritative source observation of a child's parent, inside the
   * ingestion transaction. Below canonical 0.3 nothing is written (`disabled`).
   * An unknown parent reference returns `unresolved` (the caller retries it in
   * the run's second pass and records the issue then).
   */
  async observeParent(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: ParentObservation,
  ): Promise<ParentObservationOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('hierarchy tenant does not match the transaction tenant');
    }
    if (!(await accountStructureEnabled(tx))) return 'disabled';
    let request: ParentRequest = { kind: 'clear' };
    if (input.parent.kind === 'set') {
      const parentId = await this.store.companyIdForRef(tx, input.parent.ref);
      if (!parentId) return 'unresolved';
      request = { kind: 'set', parentId };
    }
    const refs =
      input.parent.kind === 'set' ? [input.childRef, input.parent.ref] : [input.childRef];
    const { decision } = await this.decideAndApply(tx, {
      childId: input.childId,
      request,
      writer: 'source',
      provenance: input.provenance,
      effectiveAt: input.effectiveAt,
      issueRefs: refs,
    });
    switch (decision.outcome) {
      case 'apply':
        return 'applied';
      case 'unchanged':
        return 'unchanged';
      case 'refused':
        return 'refused';
      case 'human_override':
        return 'human_override';
    }
  }

  /** Records an unresolved parent after the run's second pass (identifiers only). */
  async recordUnresolved(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: {
      readonly childId: string;
      readonly childRef: ExternalRef;
      readonly parentRef: ExternalRef;
    },
  ): Promise<void> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (!(await accountStructureEnabled(tx))) return;
    await this.store.recordIssue(tx, {
      kind: 'hierarchy_parent_unresolved',
      entityKind: 'company',
      identity: hierarchyIssueIdentity(tx.tenantId, input.childId),
      canonicalIds: [input.childId],
      externalRefs: [input.childRef, input.parentRef],
    });
  }

  // --- Operator entry (plan §2.2, §2.5; canonical.human_entry) -------------------

  @AuditFailures('account.hierarchy.set', 'account_hierarchy')
  async set(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorParentInput,
  ): Promise<OperatorParentResult> {
    assertAuthorized(actx, 'canonical.human_entry');
    const companyId = requireUuid(input.companyId, '--company');
    const parentId = requireUuid(input.parentId, '--parent');
    const reason = requireReason(input.reason);
    return this.operatorWrite(actx, 'account.hierarchy.set', companyId, reason, {
      kind: 'set',
      parentId,
    });
  }

  @AuditFailures('account.hierarchy.clear', 'account_hierarchy')
  async clear(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorParentInput,
  ): Promise<OperatorParentResult> {
    assertAuthorized(actx, 'canonical.human_entry');
    const companyId = requireUuid(input.companyId, '--company');
    const reason = requireReason(input.reason);
    return this.operatorWrite(actx, 'account.hierarchy.clear', companyId, reason, {
      kind: 'clear',
    });
  }

  /**
   * Returns control of the parent to the source (plan §2.5): the origin goes
   * back to `source_provided`, the parent is unchanged; the next authoritative
   * observation applies normally.
   */
  @AuditFailures('account.hierarchy.release', 'account_hierarchy')
  async release(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorParentInput,
  ): Promise<OperatorParentResult> {
    assertAuthorized(actx, 'canonical.human_entry');
    const companyId = requireUuid(input.companyId, '--company');
    const reason = requireReason(input.reason);
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountStructure(tx);
      await this.store.lockEntities(tx, [{ kind: 'company', id: companyId }]);
      const company = await this.liveCompany(tx, companyId);
      const changed = company.origin === 'human';
      if (changed) {
        await this.store.setParent(tx, companyId, company.parentId, 'source_provided');
        await this.store.insertChange(tx, {
          entityKind: 'company',
          entityId: companyId,
          changeType: 'relationship_changed',
          changedFields: ['parentCompanyOrigin'],
          ...operatorProvenance(actx.actor, actx.correlationId, companyId),
        });
      }
      await this.audit.record(tx, actx, {
        action: 'account.hierarchy.release',
        targetKind: 'account_hierarchy',
        targetRef: companyId,
        details: { reason, changed },
      });
      return {
        companyId,
        parentId: company.parentId,
        origin: changed ? 'source_provided' : company.origin,
        changed,
      };
    });
  }

  private async operatorWrite(
    actx: AuthorizedContext<'canonical.human_entry'>,
    action: 'account.hierarchy.set' | 'account.hierarchy.clear',
    companyId: string,
    reason: string,
    request: ParentRequest,
  ): Promise<OperatorParentResult> {
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountStructure(tx);
      const lock: { kind: 'company'; id: string }[] = [{ kind: 'company', id: companyId }];
      if (request.kind === 'set') lock.push({ kind: 'company', id: request.parentId });
      await this.store.lockEntities(tx, lock);
      await this.liveCompany(tx, companyId);
      if (request.kind === 'set' && !(await this.store.company(tx, request.parentId))) {
        throw new GovernanceError('validation_failed', 'The parent company does not exist');
      }
      const { decision, after } = await this.decideAndApply(tx, {
        childId: companyId,
        request,
        writer: 'human',
        provenance: operatorProvenance(actx.actor, actx.correlationId, companyId),
        effectiveAt: new Date(),
        issueRefs: [],
        recordRefusal: false,
      });
      if (decision.outcome === 'refused') {
        throw new GovernanceError(decision.code, `Parent change refused (${decision.code})`);
      }
      const changed = decision.outcome === 'apply';
      await this.audit.record(tx, actx, {
        action,
        targetKind: 'account_hierarchy',
        targetRef: companyId,
        details: {
          reason,
          changed,
          parentChanged: decision.outcome === 'apply' && decision.parentChanged,
          ...(after.parentId ? { parentId: after.parentId } : {}),
        },
      });
      return { companyId, parentId: after.parentId, origin: after.origin, changed };
    });
  }

  private async liveCompany(tx: TenantTransaction, id: string) {
    const company = await this.store.company(tx, id);
    if (!company) throw new GovernanceError('validation_failed', 'The company does not exist');
    if (company.recordState === 'merged') {
      throw new GovernanceError('validation_failed', 'The company was merged; use the survivor');
    }
    return company;
  }

  /**
   * Loads the facts, decides (pure rule) and applies one parent change.
   * Refusals and human-override disagreements are recorded as issues (source
   * writes) and leave the parent unchanged; an accepted change resolves the
   * child's open hierarchy issues.
   */
  private async decideAndApply(
    tx: TenantTransaction,
    input: {
      readonly childId: string;
      readonly request: ParentRequest;
      readonly writer: 'source' | 'human';
      readonly provenance: StructureProvenance;
      readonly effectiveAt: Date;
      readonly issueRefs: readonly ExternalRef[];
      readonly recordRefusal?: boolean;
    },
  ): Promise<{
    readonly decision: ParentDecision;
    readonly after: { parentId: string | null; origin: string | null };
  }> {
    if (input.request.kind === 'set') await this.store.lockHierarchy(tx);
    const child = await this.store.company(tx, input.childId);
    if (!child || child.recordState === 'merged') {
      // Merged records are never re-parented (lineage).
      return {
        decision: { outcome: 'unchanged' },
        after: { parentId: child?.parentId ?? null, origin: child?.origin ?? null },
      };
    }
    const bound = this.maxDepth + 1;
    let parent: { recordState: string; path: readonly string[]; truncated: boolean } | undefined;
    if (input.request.kind === 'set' && input.request.parentId !== child.id) {
      const node = await this.store.company(tx, input.request.parentId);
      const walk = await this.store.path(tx, input.request.parentId, bound);
      parent = {
        recordState: node?.recordState ?? 'merged',
        path: walk.path,
        truncated: walk.truncated,
      };
    }
    const subtree =
      input.request.kind === 'set'
        ? await this.store.subtreeHeight(tx, child.id, bound)
        : { height: 0, truncated: false };
    const decision = decideParentChange({
      childId: child.id,
      current: { parentId: child.parentId, origin: child.origin },
      request: input.request,
      writer: input.writer,
      ...(parent ? { parent } : {}),
      subtreeHeight: subtree.height,
      subtreeTruncated: subtree.truncated,
      maxDepth: this.maxDepth,
    });
    const issue = (kind: IdentityConflictKind) =>
      this.store.recordIssue(tx, {
        kind,
        entityKind: 'company',
        identity: hierarchyIssueIdentity(tx.tenantId, child.id),
        canonicalIds: [
          child.id,
          ...(input.request.kind === 'set' ? [input.request.parentId] : []),
          ...(child.parentId ? [child.parentId] : []),
        ],
        externalRefs: input.issueRefs,
      });
    switch (decision.outcome) {
      case 'unchanged':
        return { decision, after: { parentId: child.parentId, origin: child.origin } };
      case 'human_override':
        await issue('hierarchy_human_override_disagrees');
        return { decision, after: { parentId: child.parentId, origin: child.origin } };
      case 'refused':
        // A source refusal is recorded as an issue and logged (code only); an
        // operator refusal is returned to the operator and audited instead (the
        // CLI's stdout carries only its JSON result).
        if (input.recordRefusal !== false) {
          await issue(REFUSAL_ISSUE[decision.code]);
          this.logger.warn(`hierarchy_refused code=${decision.code}`);
        }
        return { decision, after: { parentId: child.parentId, origin: child.origin } };
      case 'apply':
        await this.write(tx, {
          childId: child.id,
          oldParentId: child.parentId,
          newParentId: decision.parentId,
          origin: decision.origin,
          parentChanged: decision.parentChanged,
          provenance: input.provenance,
          effectiveAt: input.effectiveAt,
        });
        await this.store.resolveIssues(
          tx,
          HIERARCHY_ISSUE_KINDS.map((kind) => ({
            kind,
            identity: hierarchyIssueIdentity(tx.tenantId, child.id),
          })),
        );
        return { decision, after: { parentId: decision.parentId, origin: decision.origin } };
    }
  }

  /** Projection, change record and value history in one transaction. */
  private async write(
    tx: TenantTransaction,
    input: {
      readonly childId: string;
      readonly oldParentId: string | null;
      readonly newParentId: string | null;
      readonly origin: 'source_provided' | 'human';
      readonly parentChanged: boolean;
      readonly provenance: StructureProvenance;
      readonly effectiveAt: Date;
    },
  ): Promise<void> {
    await this.store.setParent(tx, input.childId, input.newParentId, input.origin);
    const changeId = await this.store.insertChange(tx, {
      entityKind: 'company',
      entityId: input.childId,
      changeType: 'relationship_changed',
      changedFields: input.parentChanged ? ['parentCompanyId'] : ['parentCompanyOrigin'],
      ...input.provenance,
    });
    if (input.parentChanged) {
      await recordValueHistory(tx, {
        entityKind: 'company',
        entityId: input.childId,
        changeId,
        effectiveAt: input.effectiveAt,
        ...(input.provenance.actor ? { actor: input.provenance.actor } : {}),
        changes: [
          { field: 'parent_company_id', oldValue: input.oldParentId, newValue: input.newParentId },
        ],
      });
    }
  }

  // --- Merge (plan §4, Q14) -------------------------------------------------------

  /**
   * Inside the company-merge transaction, before the loser is marked merged.
   * Never refuses the merge. Children of the loser move to the survivor (origin
   * kept, no depth guardrail, cycle rule kept: a child the survivor descends
   * from is unparented with an issue). A survivor under the loser takes the
   * loser's parent. A survivor without a parent inherits the loser's, unless an
   * operator cleared it (origin `human`, sticky; review m1). The loser keeps its
   * own parent (lineage).
   */
  async onCompanyMerged(tx: TenantTransaction, merge: CompanyMerge): Promise<void> {
    // The per-tenant hierarchy lock first, before reading children (review M5):
    // a source parent write onto the loser that is in flight commits before
    // these reads, or waits and then sees the loser merged. Merges are rare.
    await this.store.lockHierarchy(tx);
    const loser = await this.store.company(tx, merge.loserId);
    const survivor = await this.store.company(tx, merge.survivorId);
    if (!loser || !survivor) return;
    const children = await this.store.children(tx, loser.id);
    if (children.length === 0 && loser.parentId === null && survivor.parentId !== loser.id) return;
    const provenance: StructureProvenance = { ...merge.provenance };
    const effectiveAt = merge.provenance.sourceUpdatedAt ?? new Date();
    const move = async (
      id: string,
      from: string | null,
      to: string | null,
      origin: string | null,
    ) =>
      this.write(tx, {
        childId: id,
        oldParentId: from,
        newParentId: to,
        origin: (origin as 'source_provided' | 'human' | null) ?? 'source_provided',
        parentChanged: true,
        provenance,
        effectiveAt,
      });

    // 1. A survivor under the loser takes the loser's parent (no self-parent).
    if (survivor.parentId === loser.id) {
      const next =
        loser.parentId !== null && loser.parentId !== survivor.id ? loser.parentId : null;
      const cycles = next !== null && (await this.store.path(tx, next)).path.includes(survivor.id);
      await move(survivor.id, loser.id, cycles ? null : next, survivor.origin);
    } else if (
      survivor.parentId === null &&
      survivor.origin === 'human' &&
      loser.parentId !== null &&
      loser.parentId !== survivor.id
    ) {
      // An operator's explicit clear is sticky (review m1): no inheritance; the
      // loser's parent is recorded as a disagreement with the human value.
      await this.store.recordIssue(tx, {
        kind: 'hierarchy_human_override_disagrees',
        entityKind: 'company',
        identity: hierarchyIssueIdentity(tx.tenantId, survivor.id),
        canonicalIds: [survivor.id, loser.parentId],
        externalRefs: [],
      });
    } else if (
      survivor.parentId === null &&
      loser.parentId !== null &&
      loser.parentId !== survivor.id
    ) {
      // 2. A survivor without a parent inherits the loser's (when that creates no cycle).
      const cycles = (await this.store.path(tx, loser.parentId)).path.includes(survivor.id);
      if (!cycles) {
        await move(survivor.id, null, loser.parentId, loser.origin);
      } else {
        await this.cycleIssue(tx, survivor.id, loser.parentId);
      }
    }

    // 3. The loser's children move to the survivor.
    const survivorPath = (await this.store.path(tx, survivor.id)).path;
    for (const childId of children) {
      if (childId === survivor.id) continue;
      const child = await this.store.company(tx, childId);
      if (!child) continue;
      if (survivorPath.includes(childId)) {
        // The survivor descends from this child: unparent it, recorded (the only unparenting merge).
        await move(childId, loser.id, null, child.origin);
        await this.cycleIssue(tx, childId, survivor.id);
        continue;
      }
      await move(childId, loser.id, survivor.id, child.origin);
      // Depth is a guardrail, not semantics: an overshoot is a finding, not a refusal.
      const depth = survivorPath.length; // survivor depth + 1
      const height = (await this.store.subtreeHeight(tx, childId)).height;
      if (depth + height > this.maxDepth) {
        await this.store.recordIssue(tx, {
          kind: 'hierarchy_depth_exceeded',
          entityKind: 'company',
          identity: hierarchyIssueIdentity(tx.tenantId, childId),
          canonicalIds: [childId, survivor.id],
          externalRefs: [],
        });
      }
    }
  }

  private async cycleIssue(tx: TenantTransaction, childId: string, otherId: string): Promise<void> {
    await this.store.recordIssue(tx, {
      kind: 'hierarchy_cycle_refused',
      entityKind: 'company',
      identity: hierarchyIssueIdentity(tx.tenantId, childId),
      canonicalIds: [childId, otherId],
      externalRefs: [],
    });
  }
}

/** The company-merge participant of the hierarchy (wired by `ContextModule`, always present). */
@Injectable()
export class AccountHierarchyMergeParticipant implements CompanyMergeParticipant {
  constructor(private readonly writer: AccountHierarchyWriter) {}

  onCompanyMerged(tx: TenantTransaction, merge: CompanyMerge): Promise<void> {
    return this.writer.onCompanyMerged(tx, merge);
  }
}
