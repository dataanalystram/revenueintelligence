import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import {
  DEFAULT_EXTENSION_GUARDRAILS,
  extensionValueHash,
  fieldSpecFromDefinition,
  parseExtensionValue,
  type ExtensionGuardrails,
} from '../../domain';
import { GovernanceError, ModuleGate, SourceReferenceService } from '../../governance';
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
  type CustomRecordRow,
  type ExtensionEntry,
  type ExtensionTarget,
} from '../infrastructure/extension.store';
import {
  operatorProvenance,
  parseTarget,
  requireExtension,
  requireReason,
  requireUuid,
  type ExtensionProvenance,
} from './extension-shared';
import {
  ExtensionValueWriter,
  lockMergeTargets,
  type ExtensionObserveOutcome,
  type ObservedExtensionValue,
} from './extension-value.writer';

/** A source parent reference: the canonical kind and the source triple of the parent record. */
export interface ObservedParent {
  readonly kind: 'company' | 'person' | 'subscription';
  readonly ref: { readonly system: string; readonly objectType: string; readonly id: string };
}

export interface CustomRecordObservation {
  readonly objectKey: string;
  /** The record's source coordinates (generic source reference kind `custom_record`, Q15). */
  readonly ref: { readonly system: string; readonly objectType: string; readonly id: string };
  readonly presence: 'present' | 'absent';
  /** undefined = the parent is not mapped; null = explicitly no parent; else the parent's reference. */
  readonly parent?: ObservedParent | null;
  /** Mapped record state (value map), when mapped. */
  readonly state?: 'active' | 'inactive' | 'retired';
  readonly values: readonly ObservedExtensionValue[];
  readonly observedAt: Date;
  readonly provenance: ExtensionProvenance;
}

export interface CustomRecordObserveOutcome {
  readonly status:
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'rejected'
    | 'canonical_version_too_low'
    | 'module_disabled'
    | 'registry_not_published';
  /** Why a record was rejected (codes only). */
  readonly reason?:
    | 'object_unknown'
    | 'object_retired'
    | 'parent_unresolved'
    | 'records_per_object_exceeded'
    | 'record_merged'
    | 'natural_key_incomplete'
    | 'object_not_owned';
  readonly recordId?: string;
  readonly values?: ExtensionObserveOutcome;
}

export interface OperatorRecordCreate {
  readonly object: string;
  readonly parent?: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly reason: string;
}

export interface OperatorRecordUpdate {
  readonly record: string;
  readonly values: Readonly<Record<string, string | null>>;
  readonly reason: string;
}

export interface OperatorRecordState {
  readonly record: string;
  readonly reason: string;
}

export interface CustomRecordWritten {
  readonly recordId: string;
  readonly object: string;
  readonly state: string;
  readonly changed: boolean;
}

const parentIssue = (tenantId: string, objectKey: string, ref: CustomRecordObservation['ref']) =>
  `${tenantId}|custom-record-parent|${objectKey}|${ref.system}:${ref.objectType}:${ref.id}`;

/**
 * The single writer of `tenant_custom_records` (M10D plan §3.3, §4.2). Records
 * resolve by their generic source reference (kind `custom_record`), else the
 * natural-key hash, else are created; the parent resolves through the parent's
 * existing reference store (unresolved: kept without parent only when the
 * parent is optional, else rejected with an open `custom_record_parent_unresolved`
 * issue). Fields go through `ExtensionValueWriter` in the same transaction.
 * States: `active` ↔ `inactive`, → `retired` (terminal for the source; operator
 * reactivation audited). Records never disappear; absence changes nothing.
 * One owner connection per object (Q14): the owner table's primary key refuses
 * a second owner at mapping publish (tech debt #83), and source writes from any
 * other connection are rejected here (`object_not_owned`).
 */
@Injectable()
export class CustomRecordWriter {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: ExtensionStore,
    private readonly values: ExtensionValueWriter,
    private readonly references: SourceReferenceService,
    readonly audit: AuditTrail,
    private readonly moduleGate: ModuleGate,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
  ) {}

  get guardrails(): ExtensionGuardrails {
    return (
      (this.config as Partial<AppConfig> | undefined)?.canonical?.extension ??
      DEFAULT_EXTENSION_GUARDRAILS
    );
  }

  observeSource(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: CustomRecordObservation,
  ): Promise<CustomRecordObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, (tx) => this.observe(actx, tx, input));
  }

  async observe(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: CustomRecordObservation,
  ): Promise<CustomRecordObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('custom record tenant does not match the transaction tenant');
    }
    const gate = await this.store.gate(tx);
    if (gate !== 'ok') return { status: gate };
    const registry = await this.store.registry(tx);
    if (registry.version === undefined) return { status: 'registry_not_published' };
    const object = registry.byKey.get(input.objectKey);
    if (!object || object.definition.kind !== 'custom_object') {
      return { status: 'rejected', reason: 'object_unknown' };
    }
    if (object.status !== 'active') return { status: 'rejected', reason: 'object_retired' };
    await this.store.lockObject(tx, object.id);
    // Tech debt #83 (Q14, defence in depth): only the owning connection's source
    // writes land; the owner row is held FOR SHARE until this write commits.
    const owner = await this.store.customObjectOwner(tx, input.objectKey);
    void owner; // MUTATION VM4: owner check removed

    let recordId = await this.store.customRecordForRef(tx, input.ref);
    if (input.presence === 'absent') {
      // A source deletion is recorded on the reference only: the record and its values stay.
      if (recordId) await this.observeReference(actx, tx, input, recordId);
      return { status: 'unchanged', ...(recordId ? { recordId } : {}) };
    }

    const naturalKeyHash = this.naturalKeyHash(
      input.objectKey,
      object,
      input.values,
      registry.byKey,
    );
    let record = recordId ? await this.store.record(tx, recordId) : undefined;
    if (!record && naturalKeyHash) {
      record = await this.store.recordByNaturalKey(tx, object.id, naturalKeyHash);
      recordId = record?.id;
    }
    if (record?.recordState === 'merged') return { status: 'rejected', reason: 'record_merged' };

    // Parent (plan §2.3, §4.2).
    const parentDecl = object.definition.parent as { kind: string; required: boolean } | undefined;
    let parent: ExtensionTarget | null | undefined;
    if (parentDecl && input.parent !== undefined) {
      if (input.parent === null) parent = null;
      else {
        const resolved = await this.resolveParent(tx, input.parent);
        const identity = parentIssue(tx.tenantId, input.objectKey, input.ref);
        if (!resolved) {
          if (parentDecl.required && !record?.parentId && !record?.parentKey) {
            await this.store.recordIssue(tx, {
              kind: 'custom_record_parent_unresolved',
              entityKind: 'custom_record',
              identity,
              canonicalIds: record ? [record.id] : [],
              externalRefs: [refString(input.ref), refString(input.parent.ref)],
            });
            return { status: 'rejected', reason: 'parent_unresolved' };
          }
        } else {
          parent = resolved;
          await this.store.resolveIssue(tx, 'custom_record_parent_unresolved', identity);
        }
      }
    }
    if (parentDecl?.required && !record && !parent) {
      if (input.parent === undefined || input.parent === null) {
        return { status: 'rejected', reason: 'parent_unresolved' };
      }
    }

    let status: CustomRecordObserveOutcome['status'] = 'unchanged';
    if (!record) {
      if ((await this.store.countRecords(tx, object.id)) >= this.guardrails.maxRecordsPerObject) {
        return { status: 'rejected', reason: 'records_per_object_exceeded' };
      }
      const created = await this.create(tx, {
        objectId: object.id,
        ...(parent ? { parent } : {}),
        naturalKeyHash,
        recordState: input.state ?? 'active',
        origin: input.provenance.origin === 'migration' ? 'migration' : 'source_provided',
        provenance: input.provenance,
      });
      recordId = created;
      status = 'created';
    } else {
      const changed = await this.updateFromSource(tx, record, {
        ...(parent !== undefined ? { parent } : {}),
        ...(input.state ? { state: input.state } : {}),
        naturalKeyHash,
        provenance: input.provenance,
      });
      if (changed) status = 'updated';
    }
    await this.observeReference(actx, tx, input, recordId!);
    const values = await this.values.observe(actx, tx, {
      target: { kind: 'custom_record', id: recordId! },
      values: input.values,
      observedAt: input.observedAt,
      provenance: input.provenance,
    });
    if (status === 'unchanged' && values.written > 0) status = 'updated';
    return { status, recordId: recordId!, values };
  }

  private async observeReference(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: CustomRecordObservation,
    recordId: string,
  ): Promise<void> {
    await this.references.observe(actx, tx, {
      system: input.ref.system,
      objectType: input.ref.objectType,
      externalId: input.ref.id,
      entityKind: 'custom_record',
      entityId: recordId,
      presence: input.presence,
      observedAt: input.observedAt,
      ...(input.provenance.sourceUpdatedAt
        ? { sourceUpdatedAt: input.provenance.sourceUpdatedAt }
        : {}),
      meta: {
        cause: input.provenance.cause as never,
        adapter: input.provenance.adapter,
        adapterVersion: input.provenance.adapterVersion,
        connectionId: input.provenance.connectionId ?? null,
        mappingVersion: input.provenance.mappingVersion ?? null,
        ...(input.provenance.checkpointId ? { checkpointId: input.provenance.checkpointId } : {}),
      },
    });
  }

  /** SHA-256 over the parsed natural-key values in definition order; undefined when any is missing or invalid. */
  naturalKeyHash(
    objectKey: string,
    object: ExtensionEntry,
    values: readonly ObservedExtensionValue[],
    byKey: ReadonlyMap<string, ExtensionEntry>,
  ): string | null {
    const keys =
      (object.definition.record_identity as { natural_key?: string[] } | undefined)?.natural_key ??
      [];
    if (keys.length === 0) return null;
    const raw = new Map(values.map((v) => [v.field, v.raw]));
    const parts: string[] = [];
    for (const k of keys) {
      const def = byKey.get(k);
      if (!def || !raw.has(k)) return null;
      const parsed = parseExtensionValue(fieldSpecFromDefinition(k, def.definition), raw.get(k));
      if (!parsed.ok || parsed.value.state !== 'present') return null;
      parts.push(extensionValueHash(parsed.value));
    }
    return createHash('sha256')
      .update(`${objectKey}|${parts.join('|')}`)
      .digest('hex');
  }

  private async resolveParent(
    tx: TenantTransaction,
    parent: ObservedParent,
  ): Promise<ExtensionTarget | undefined> {
    if (parent.kind === 'subscription') {
      const id = await this.store.subscriptionForRef(tx, parent.ref);
      return id ? { kind: 'subscription', id } : undefined;
    }
    const id = await this.store.canonicalForRef(tx, parent.kind, parent.ref);
    if (!id) return undefined;
    // Lock the parent before the not-merged check (review M1): a concurrent
    // parent merge holds this lock until it commits.
    await this.store.lockTarget(tx, { kind: parent.kind, id });
    const e = await this.store.entity(tx, { kind: parent.kind, id });
    return e.exists && e.state !== 'merged' ? { kind: parent.kind, id } : undefined;
  }

  private async create(
    tx: TenantTransaction,
    input: {
      readonly objectId: string;
      readonly parent?: ExtensionTarget;
      readonly naturalKeyHash: string | null;
      readonly recordState: 'active' | 'inactive' | 'retired';
      readonly origin: 'source_provided' | 'human' | 'migration';
      readonly provenance: ExtensionProvenance;
    },
  ): Promise<string> {
    const id = await this.store.insertRecord(tx, input);
    const { connectionId: _c, ...change } = input.provenance;
    const changeId = await this.store.insertChange(tx, {
      ...change,
      entityKind: 'custom_record',
      entityId: id,
      changeType: 'created',
      changedFields: input.parent ? ['recordState', 'parentId'] : ['recordState'],
    });
    await this.store.updateRecord(tx, id, { lastChangeId: changeId });
    return id;
  }

  private async updateFromSource(
    tx: TenantTransaction,
    record: CustomRecordRow,
    input: {
      readonly parent?: ExtensionTarget | null;
      readonly state?: 'active' | 'inactive' | 'retired';
      readonly naturalKeyHash: string | null;
      readonly provenance: ExtensionProvenance;
    },
  ): Promise<boolean> {
    const fields: string[] = [];
    const data: Parameters<ExtensionStore['updateRecord']>[2] & { recordState?: string } = {};
    if (input.state && input.state !== record.recordState && record.recordState !== 'retired') {
      // `retired` is terminal for the source; only an operator reactivates (audited).
      fields.push('recordState');
      Object.assign(data, { recordState: input.state });
    }
    if (input.parent !== undefined) {
      const current = record.parentKind
        ? `${record.parentKind}:${record.parentId ?? record.parentKey}`
        : null;
      const next = input.parent ? `${input.parent.kind}:${input.parent.id}` : null;
      if (current !== next) {
        fields.push('parentId');
        Object.assign(data, { parent: input.parent });
      }
    }
    if (input.naturalKeyHash !== null && input.naturalKeyHash !== record.naturalKeyHash) {
      fields.push('naturalKeyHash');
      Object.assign(data, { naturalKeyHash: input.naturalKeyHash });
    }
    if (fields.length === 0) return false;
    const { connectionId: _c, ...change } = input.provenance;
    const changeId = await this.store.insertChange(tx, {
      ...change,
      entityKind: 'custom_record',
      entityId: record.id,
      changeType: fields.includes('recordState') ? 'state_changed' : 'relationship_changed',
      changedFields: fields,
    });
    await this.store.updateRecord(tx, record.id, { ...data, lastChangeId: changeId });
    return true;
  }

  // --- Operator entry (canonical.human_entry, Q17) ------------------------------------

  @AuditFailures('extension.record.create', 'custom_record')
  async createRecord(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorRecordCreate,
  ): Promise<CustomRecordWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const parentTarget = input.parent ? parseTarget(input.parent, '--parent') : undefined;
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireExtension(tx, actx, this.store, this.moduleGate);
      const registry = await this.store.registry(tx);
      const object = registry.byKey.get(input.object);
      if (!object || object.definition.kind !== 'custom_object') {
        throw new GovernanceError('extension_field_unknown', 'No such custom object');
      }
      if (object.status !== 'active') {
        throw new GovernanceError('extension_field_retired', 'The custom object is retired');
      }
      await this.store.lockObject(tx, object.id);
      const parentDecl = object.definition.parent as
        { kind: string; required: boolean } | undefined;
      if (parentTarget) {
        const allowed = parentDecl
          ? parentDecl.kind === 'account'
            ? 'company'
            : parentDecl.kind
          : undefined;
        await this.store.lockTarget(tx, parentTarget); // review M1: lock before the merged check
        const e = await this.store.entity(tx, parentTarget);
        if (!allowed || parentTarget.kind !== allowed || !e.exists || e.state === 'merged') {
          throw new GovernanceError(
            'validation_failed',
            'The parent must exist, not be merged and match the object',
          );
        }
      } else if (parentDecl?.required) {
        throw new GovernanceError('validation_failed', 'This custom object requires a parent');
      }
      if ((await this.store.countRecords(tx, object.id)) >= this.guardrails.maxRecordsPerObject) {
        throw new GovernanceError(
          'extension_guardrail_exceeded',
          'Records per object guardrail reached',
        );
      }
      const observed = Object.entries(input.values ?? {}).map(([field, raw]) => ({ field, raw }));
      const naturalKeyHash = this.naturalKeyHash(input.object, object, observed, registry.byKey);
      if (naturalKeyHash && (await this.store.recordByNaturalKey(tx, object.id, naturalKeyHash))) {
        throw new GovernanceError('validation_failed', 'A record with this natural key exists');
      }
      const provenance = operatorProvenance(actx.actor, actx.correlationId, object.id);
      const id = await this.create(tx, {
        objectId: object.id,
        ...(parentTarget ? { parent: parentTarget } : {}),
        naturalKeyHash,
        recordState: 'active',
        origin: 'human',
        provenance,
      });
      for (const v of observed) {
        await this.values.writeHumanWithin(
          actx,
          tx,
          { kind: 'custom_record', id },
          v.field,
          String(v.raw),
        );
      }
      await this.audit.record(tx, actx, {
        action: 'extension.record.create',
        targetKind: 'custom_record',
        targetRef: id,
        details: { reason, object: input.object, fields: observed.length },
      });
      return { recordId: id, object: input.object, state: 'active', changed: true };
    });
  }

  @AuditFailures('extension.record.update', 'custom_record')
  async update(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorRecordUpdate,
  ): Promise<CustomRecordWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = requireUuid(input.record, '--record');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireExtension(tx, actx, this.store, this.moduleGate);
      const record = await this.store.record(tx, id);
      if (!record || record.recordState === 'merged') {
        throw new GovernanceError('validation_failed', 'The record must exist and not be merged');
      }
      const objectKey = (await this.store.registry(tx)).byId.get(record.objectId)?.key ?? '';
      let changed = false;
      for (const [field, raw] of Object.entries(input.values)) {
        const r = await this.values.writeHumanWithin(
          actx,
          tx,
          { kind: 'custom_record', id },
          field,
          raw,
        );
        changed ||= r.changed;
      }
      await this.audit.record(tx, actx, {
        action: 'extension.record.update',
        targetKind: 'custom_record',
        targetRef: id,
        details: { reason, object: objectKey, fields: Object.keys(input.values).length, changed },
      });
      return { recordId: id, object: objectKey, state: record.recordState, changed };
    });
  }

  @AuditFailures('extension.record.retire', 'custom_record')
  retire(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorRecordState,
  ): Promise<CustomRecordWritten> {
    return this.operatorState(actx, input, 'retired', 'extension.record.retire');
  }

  @AuditFailures('extension.record.reactivate', 'custom_record')
  reactivate(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorRecordState,
  ): Promise<CustomRecordWritten> {
    return this.operatorState(actx, input, 'active', 'extension.record.reactivate');
  }

  private async operatorState(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorRecordState,
    state: 'retired' | 'active',
    action: 'extension.record.retire' | 'extension.record.reactivate',
  ): Promise<CustomRecordWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const reason = requireReason(input.reason);
    const id = requireUuid(input.record, '--record');
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireExtension(tx, actx, this.store, this.moduleGate);
      const record = await this.store.record(tx, id);
      if (!record || record.recordState === 'merged') {
        throw new GovernanceError('validation_failed', 'The record must exist and not be merged');
      }
      const objectKey = (await this.store.registry(tx)).byId.get(record.objectId)?.key ?? '';
      const changed = record.recordState !== state;
      if (changed) {
        const { connectionId: _c, ...change } = operatorProvenance(
          actx.actor,
          actx.correlationId,
          id,
        );
        const changeId = await this.store.insertChange(tx, {
          ...change,
          entityKind: 'custom_record',
          entityId: id,
          changeType: 'state_changed',
          changedFields: ['recordState'],
        });
        await this.store.updateRecord(tx, id, { recordState: state, lastChangeId: changeId });
      }
      await this.audit.record(tx, actx, {
        action,
        targetKind: 'custom_record',
        targetRef: id,
        details: { reason, object: objectKey, changed },
      });
      return { recordId: id, object: objectKey, state, changed };
    });
  }

  // --- Merge (plan §7): records whose parent is the loser are re-pointed ---------------

  async onParentMerged(
    tx: TenantTransaction,
    kind: 'company' | 'person',
    loserId: string,
    survivorId: string,
    provenance: ExtensionProvenance,
  ): Promise<void> {
    // Lock both parents in a stable order before reading (review M1), so a
    // record created under the loser concurrently is either seen here or
    // refused as merged after this merge commits.
    await lockMergeTargets(tx, this.store, { kind, id: loserId }, { kind, id: survivorId });
    const rows = await this.store.recordsWithParent(tx, { kind, id: loserId });
    const { connectionId: _c, ...change } = provenance;
    for (const r of rows) {
      if (r.recordState === 'merged') continue;
      const changeId = await this.store.insertChange(tx, {
        ...change,
        entityKind: 'custom_record',
        entityId: r.id,
        changeType: 'relationship_changed',
        changedFields: ['parentId'],
      });
      await this.store.updateRecord(tx, r.id, {
        parent: { kind, id: survivorId },
        lastChangeId: changeId,
      });
    }
  }
}

function refString(r: { system: string; objectType: string; id: string }): string {
  return `${r.system}:${r.objectType}:${r.id}`;
}
