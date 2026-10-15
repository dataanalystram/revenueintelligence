import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { extensionTargetKind, type ExtensionTargetKind } from '../../domain';
import { GovernanceError, ModuleGate } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  ExtensionStore,
  type ExtensionEntry,
  type ExtensionTarget,
  type RelationshipRow,
} from '../infrastructure/extension.store';
import {
  operatorProvenance,
  parseTarget,
  requireExtension,
  requireReason,
  requireUuid,
  targetRef,
  type ExtensionProvenance,
} from './extension-shared';

/** The `to` end as the source states it: a source reference of the mapped `to` object. */
export interface ObservedEndpoint {
  /** The entity-index kind the definition's `to` lands on. */
  readonly kind: ExtensionTargetKind;
  readonly ref: { readonly system: string; readonly objectType: string; readonly id: string };
}

export interface CustomRelationshipObservation {
  readonly relationshipKey: string;
  readonly from: ExtensionTarget;
  /** The stated `to` end; null = the source explicitly states none (authoritative removal). */
  readonly to: ObservedEndpoint | null;
  readonly role?: string;
  readonly observedAt: Date;
  readonly provenance: ExtensionProvenance;
}

export interface CustomRelationshipObserveOutcome {
  readonly status:
    | 'added'
    | 'ended'
    | 'replaced'
    | 'unchanged'
    | 'unresolved'
    | 'rejected'
    | 'canonical_version_too_low'
    | 'module_disabled';
  readonly reason?: 'relationship_unknown' | 'relationship_retired' | 'endpoint_not_allowed';
  /** Review m7: the source stated a role code that is not the definition's role (kept as the declared role). */
  readonly roleUnmapped?: true;
}

export interface OperatorEdgeAdd {
  readonly relationship: string;
  readonly from: string;
  readonly to: string;
  readonly role?: string;
  readonly reason: string;
}

export interface OperatorEdgeEnd {
  readonly edge: string;
  readonly reason: string;
}

export interface CustomRelationshipWritten {
  readonly edgeId: string;
  readonly relationship: string;
  readonly state: 'active' | 'ended';
  readonly changed: boolean;
}

const endpointIssue = (
  tenantId: string,
  defId: string,
  from: ExtensionTarget,
  ref: ObservedEndpoint['ref'],
) =>
  `${tenantId}|custom-relationship|${defId}|${from.kind}:${from.id}|${ref.system}:${ref.objectType}:${ref.id}`;

const sameEnd = (row: RelationshipRow, prefix: 'from' | 'to', t: ExtensionTarget) =>
  row[`${prefix}Kind`] === t.kind &&
  (t.kind === 'product' ? row[`${prefix}Key`] === t.id : row[`${prefix}Id`] === t.id);

/**
 * The single writer of `tenant_custom_relationships` (M10D plan §3.4, §4.2).
 * Endpoints resolve by reference; unresolved → an open
 * `custom_relationship_endpoint_unresolved` issue, retried on the next
 * observation (no pending store). Cardinality and one active edge per
 * (definition, from, to) are enforced here under the per-(definition, from)
 * advisory lock and again by the guard trigger (Q27). An authoritative
 * removal (an explicitly empty value) ends the edge `source_removed`;
 * absence never ends an edge. Edges are ended, never deleted or re-pointed;
 * merges leave them in place and readers follow lineage (Q22).
 */
@Injectable()
export class CustomRelationshipWriter {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: ExtensionStore,
    readonly audit: AuditTrail,
    private readonly moduleGate: ModuleGate,
  ) {}

  observeSource(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: CustomRelationshipObservation,
  ): Promise<CustomRelationshipObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, (tx) => this.observe(actx, tx, input));
  }

  async observe(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: CustomRelationshipObservation,
  ): Promise<CustomRelationshipObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('custom relationship tenant does not match the transaction tenant');
    }
    const gate = await this.store.gate(tx);
    if (gate !== 'ok') return { status: gate };
    const def = (await this.store.registry(tx)).byKey.get(input.relationshipKey);
    const check = checkDefinition(def);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    const entry = check.entry;
    const from = await this.store.resolveLineage(tx, input.from);
    if (!(await this.endOk(tx, entry, 'from', from))) {
      return { status: 'rejected', reason: 'endpoint_not_allowed' };
    }
    await this.store.lockRelationshipFrom(tx, entry.id, from);
    const active = await this.store.activeEdgesFrom(tx, entry.id, from);
    const { connectionId, ...change } = input.provenance;
    const source = connectionId
      ? {
          connectionId,
          objectType: input.provenance.source.objectType,
          recordId: input.provenance.source.id,
        }
      : undefined;

    if (input.to === null) {
      // Authoritative removal: the source states no target now (only source edges end).
      let ended = 0;
      for (const edge of active.filter((e) => e.origin !== 'human')) {
        await this.end(tx, edge, 'source_removed', input.observedAt, change);
        ended += 1;
      }
      return { status: ended > 0 ? 'ended' : 'unchanged' };
    }
    const to = await this.resolveEndpoint(tx, input.to);
    const identity = endpointIssue(tx.tenantId, entry.id, from, input.to.ref);
    if (!to) {
      await this.store.recordIssue(tx, {
        kind: 'custom_relationship_endpoint_unresolved',
        entityKind: from.kind,
        identity,
        canonicalIds: from.kind === 'product' ? [entry.id] : [from.id, entry.id],
        externalRefs: [`${input.to.ref.system}:${input.to.ref.objectType}:${input.to.ref.id}`],
      });
      return { status: 'unresolved' };
    }
    await this.store.resolveIssue(tx, 'custom_relationship_endpoint_unresolved', identity);
    if (!(await this.endOk(tx, entry, 'to', to))) {
      return { status: 'rejected', reason: 'endpoint_not_allowed' };
    }
    if (active.some((e) => sameEnd(e, 'to', to))) return { status: 'unchanged' };
    const cardinality = String(entry.definition.cardinality);
    if (cardinality === 'one_to_one') {
      // Review m4: refuse before anything ends, so a rejected call leaves the old edge intact.
      const taken = await this.store.activeEdgesTo(tx, entry.id, to);
      if (taken.length > 0) return { status: 'rejected', reason: 'endpoint_not_allowed' };
    }
    let replaced = false;
    if (cardinality !== 'many_to_many') {
      // The source states a different single target: its earlier source edge ends.
      for (const edge of active) {
        if (edge.origin === 'human') return { status: 'unchanged' }; // operator edge stands (sticky)
        await this.end(tx, edge, 'source_removed', input.observedAt, change);
        replaced = true;
      }
    }
    const role = this.role(entry, input.role);
    // Review m7: a source role that is not the definition's role is counted, never silent.
    const roleUnmapped = input.role !== undefined && input.role !== role;
    const edgeId = randomUUID();
    const changeId = await this.store.insertChange(tx, {
      ...change,
      entityKind: 'custom_relationship',
      entityId: edgeId,
      changeType: 'relationship_changed',
      changedFields: ['state'],
    });
    await this.store.insertEdge(tx, {
      id: edgeId,
      defId: entry.id,
      from,
      to,
      roleCode: role,
      origin: input.provenance.origin === 'migration' ? 'migration' : 'source_provided',
      ...(source ? { source } : {}),
      lastChangeId: changeId,
    });
    return { status: replaced ? 'replaced' : 'added', ...(roleUnmapped ? { roleUnmapped } : {}) };
  }

  /** A role code is kept only when it is the definition's role (value map, plan §5.3); any other is counted (m7). */
  private role(entry: ExtensionEntry, role: string | undefined): string | null {
    const declared = typeof entry.definition.role === 'string' ? entry.definition.role : undefined;
    return role !== undefined && role === declared ? role : (declared ?? null);
  }

  private async resolveEndpoint(
    tx: TenantTransaction,
    end: ObservedEndpoint,
  ): Promise<ExtensionTarget | undefined> {
    let id: string | undefined;
    if (end.kind === 'company' || end.kind === 'person')
      id = await this.store.canonicalForRef(tx, end.kind, end.ref);
    else if (end.kind === 'subscription') id = await this.store.subscriptionForRef(tx, end.ref);
    else if (end.kind === 'custom_record') id = await this.store.customRecordForRef(tx, end.ref);
    if (!id) return undefined;
    const e = await this.store.entity(tx, { kind: end.kind, id });
    return e.exists && e.state !== 'merged' ? { kind: end.kind, id } : undefined;
  }

  /** The end matches the definition's `from` / `to` (custom records: exactly that object). */
  private async endOk(
    tx: TenantTransaction,
    entry: ExtensionEntry,
    which: 'from' | 'to',
    t: ExtensionTarget,
  ): Promise<boolean> {
    const raw = entry.definition[which];
    const declared = typeof raw === 'string' ? raw : '';
    if (extensionTargetKind(declared) !== t.kind) return false;
    const e = await this.store.entity(tx, t);
    if (!e.exists || e.state === 'merged') return false;
    if (t.kind !== 'custom_record') return true;
    const objectKey = (await this.store.registry(tx)).byId.get(e.objectId ?? '')?.key;
    return declared === `custom_object:${objectKey}`;
  }

  private async end(
    tx: TenantTransaction,
    edge: RelationshipRow,
    reason: 'source_removed' | 'operator' | 'endpoint_merged',
    at: Date,
    change: Omit<ExtensionProvenance, 'connectionId'>,
  ): Promise<void> {
    const changeId = await this.store.insertChange(tx, {
      ...change,
      entityKind: 'custom_relationship',
      entityId: edge.id,
      changeType: 'relationship_changed',
      changedFields: ['state'],
    });
    await this.store.endEdge(tx, edge.id, reason, at, changeId);
  }

  // --- Operator entry (canonical.human_entry, Q17) ------------------------------------

  @AuditFailures('extension.relationship.add', 'custom_relationship')
  async add(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorEdgeAdd,
  ): Promise<CustomRelationshipWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const fromIn = parseTarget(input.from, '--from');
    const to = parseTarget(input.to, '--to');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireExtension(tx, actx, this.store, this.moduleGate);
      const check = checkDefinition((await this.store.registry(tx)).byKey.get(input.relationship));
      if (!check.ok) {
        throw new GovernanceError(
          check.reason === 'relationship_retired'
            ? 'extension_field_retired'
            : 'extension_field_unknown',
          'No such active custom relationship',
        );
      }
      const entry = check.entry;
      const from = fromIn;
      if (
        !(await this.endOk(tx, entry, 'from', from)) ||
        !(await this.endOk(tx, entry, 'to', to))
      ) {
        throw new GovernanceError(
          'validation_failed',
          'The ends must exist, not be merged and match the definition',
        );
      }
      if (input.role !== undefined && input.role !== entry.definition.role) {
        throw new GovernanceError('validation_failed', 'The role must be the definition role code');
      }
      await this.store.lockRelationshipFrom(tx, entry.id, from);
      const active = await this.store.activeEdgesFrom(tx, entry.id, from);
      const existing = active.find((e) => sameEnd(e, 'to', to));
      if (existing) {
        await this.audit.record(tx, actx, {
          action: 'extension.relationship.add',
          targetKind: 'custom_relationship',
          targetRef: existing.id,
          details: { reason, relationship: entry.key, changed: false },
        });
        return { edgeId: existing.id, relationship: entry.key, state: 'active', changed: false };
      }
      const { connectionId: _c, ...change } = operatorProvenance(
        actx.actor,
        actx.correlationId,
        from.id,
      );
      const cardinality = String(entry.definition.cardinality);
      if (cardinality !== 'many_to_many') {
        // The operator's edge replaces the current one (ended `operator`).
        for (const edge of active) await this.end(tx, edge, 'operator', new Date(), change);
      }
      if (
        cardinality === 'one_to_one' &&
        (await this.store.activeEdgesTo(tx, entry.id, to)).length > 0
      ) {
        throw new GovernanceError(
          'validation_failed',
          'The target already has an edge (one_to_one)',
        );
      }
      const edgeId = randomUUID();
      const changeId = await this.store.insertChange(tx, {
        ...change,
        entityKind: 'custom_relationship',
        entityId: edgeId,
        changeType: 'relationship_changed',
        changedFields: ['state'],
      });
      const id = await this.store.insertEdge(tx, {
        id: edgeId,
        defId: entry.id,
        from,
        to,
        roleCode: input.role ?? (entry.definition.role as string | undefined) ?? null,
        origin: 'human',
        lastChangeId: changeId,
      });
      await this.audit.record(tx, actx, {
        action: 'extension.relationship.add',
        targetKind: 'custom_relationship',
        targetRef: id,
        details: {
          reason,
          relationship: entry.key,
          from: targetRef(from),
          to: targetRef(to),
          changed: true,
        },
      });
      return { edgeId: id, relationship: entry.key, state: 'active', changed: true };
    });
  }

  @AuditFailures('extension.relationship.end', 'custom_relationship')
  async endEdge(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorEdgeEnd,
  ): Promise<CustomRelationshipWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = requireUuid(input.edge, '--edge');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireExtension(tx, actx, this.store, this.moduleGate);
      const edge = await this.store.relationship(tx, id);
      if (!edge) throw new GovernanceError('validation_failed', 'No such custom relationship edge');
      const key = (await this.store.registry(tx)).byId.get(edge.relDefId)?.key ?? '';
      const from: ExtensionTarget = {
        kind: edge.fromKind as ExtensionTargetKind,
        id: edge.fromId ?? edge.fromKey!,
      };
      await this.store.lockRelationshipFrom(tx, edge.relDefId, from);
      const current = (await this.store.relationship(tx, id))!;
      if (current.state !== 'active') {
        throw new GovernanceError('validation_failed', 'The edge has already ended');
      }
      const { connectionId: _c, ...change } = operatorProvenance(
        actx.actor,
        actx.correlationId,
        id,
      );
      await this.end(tx, current, 'operator', new Date(), change);
      await this.audit.record(tx, actx, {
        action: 'extension.relationship.end',
        targetKind: 'custom_relationship',
        targetRef: id,
        details: { reason, relationship: key },
      });
      return { edgeId: id, relationship: key, state: 'ended', changed: true };
    });
  }
}

function checkDefinition(
  def: ExtensionEntry | undefined,
):
  | { readonly ok: true; readonly entry: ExtensionEntry }
  | { readonly ok: false; readonly reason: 'relationship_unknown' | 'relationship_retired' } {
  if (!def || def.definition.kind !== 'custom_relationship')
    return { ok: false, reason: 'relationship_unknown' };
  if (def.status !== 'active') return { ok: false, reason: 'relationship_retired' };
  return { ok: true, entry: def };
}
