import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  compareCanonicalVersion,
  decideMerge,
  decideReferenceObservation,
  decideRetirement,
  ACCOUNT_CONTEXT_MIN_VERSION,
  ACCOUNT_STRUCTURE_MIN_VERSION,
  GENERIC_REFERENCE_KINDS,
  KEY_IDENTIFIED_REFERENCE_KINDS,
  PRODUCT_REFERENCE_ADAPTER,
  SOURCE_EXTERNAL_ID_PATTERN,
  SOURCE_OBJECT_TYPE_PATTERN,
  SOURCE_REFERENCE_CHANGED_FIELD,
  type ChangeCause,
  type ChangeType,
  type GenericReferenceKind,
  type ReferenceObservationDecision,
  type RetirementRun,
  type SourceReferenceState,
} from '../../domain';
import {
  adoptedCanonicalVersion,
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  changeGovernance,
  tenantAdvisoryLock,
  tenantClient,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import { GovernanceError } from '../errors';

/** The canonical version that enables observed generic references and evidence links (ADR 0028). */
export const GENERIC_REFERENCES_MIN_VERSION = '0.2';

/** Source coordinates of one reference: identifiers only, never values. */
export interface SourceTriple {
  readonly system: string;
  readonly objectType: string;
  readonly externalId: string;
}

/** The provenance of an observed write (who read it, how). */
export interface ReferenceWriteMeta {
  readonly cause: ChangeCause;
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly checkpointId?: string | null;
  readonly connectionId?: string | null;
  readonly mappingVersion?: number | null;
}

export interface ReferenceObservationInput extends SourceTriple {
  readonly entityKind: string;
  /** Exactly one of entityId / entityKey (entityKey iff the kind is key-identified). */
  readonly entityId?: string;
  readonly entityKey?: string;
  readonly presence: 'present' | 'absent';
  readonly observedAt: Date;
  readonly sourceUpdatedAt?: Date;
  readonly sourceCreatedAt?: Date;
  /** SHA-256 of the observed source values (idempotency; no values stored). */
  readonly fieldHash?: string;
  readonly meta: ReferenceWriteMeta;
}

export interface ReferenceObservationResult {
  readonly decision: ReferenceObservationDecision;
  readonly referenceId?: string;
  readonly changeId?: string;
}

export interface RetireAbsentReferencesInput extends RetirementRun {
  readonly system: string;
  readonly objectType: string;
  readonly runId: string;
  readonly meta: ReferenceWriteMeta;
}

export interface ReferenceMergeInput {
  readonly system: string;
  readonly objectType: string;
  readonly fromExternalId: string;
  readonly survivorExternalId: string;
  readonly observedAt: Date;
  readonly meta: ReferenceWriteMeta;
}

/** A published product-model version, as the declared projection needs it (plan §2.3). */
export interface DeclaredProductModel {
  readonly version: number;
  readonly products: readonly {
    readonly key: string;
    readonly externalRefs?: readonly {
      readonly system: string;
      readonly objectType: string;
      readonly id: string;
    }[];
  }[];
}

export interface DeclaredReferenceTransitions {
  readonly added: number;
  readonly retired: number;
  readonly reactivated: number;
  readonly repointed: number;
}

const tripleKey = (t: SourceTriple) => `${t.system}\u0000${t.objectType}\u0000${t.externalId}`;

interface ReferenceRow {
  readonly id: string;
  readonly system: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly entityKind: string;
  readonly entityId: string | null;
  readonly entityKey: string | null;
  readonly origin: string;
  readonly state: string;
  readonly mergedIntoExternalId: string | null;
  readonly sourceUpdatedAt: Date | null;
  readonly fieldHash: string | null;
  readonly deletedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly lastSeenAt: Date;
}

/**
 * The single writer of `tenant_source_references` (M10B plan §2.5, ADR 0028).
 * Every method runs inside the caller's tenant transaction, so a reference
 * change commits atomically with the write that caused it, and every real
 * change writes one change record (`last_change_id`).
 *
 * - `observe`, `retireAbsentWithin`, `merge`: observed references; require the
 *   tenant's adopted canonical version ≥ 0.2 (`canonical_version_too_low`). No
 *   production caller in M10B (the first generic kind is ingested in M10C+).
 * - `applyDeclaredProductReferences`: the declared product-reference
 *   projection, called only by product-model publish; runs at every version (Q7).
 *
 * Lifecycle decisions are the shared pure rules (plan §2.4).
 */
@Injectable()
export class SourceReferenceService {
  constructor(readonly audit: AuditTrail) {}

  /** Records one read of a generic reference (upsert under a row lock). */
  @AuditFailures('source_reference.observe', 'source_reference')
  async observe(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: ReferenceObservationInput,
  ): Promise<ReferenceObservationResult> {
    assertAuthorized(actx, 'canonical.source_sync');
    this.sameTenant(actx, tx);
    const kind = this.genericKind(input.entityKind);
    this.validTriple(input);
    const entity = this.entityOf(kind, input);
    await this.requireVersion(
      tx,
      kind === 'person_affiliation'
        ? ACCOUNT_STRUCTURE_MIN_VERSION
        : // M10E (phase 2b): an `account_context` reference needs canonical 0.5.
          kind === 'account_context'
          ? ACCOUNT_CONTEXT_MIN_VERSION
          : undefined,
    );
    await this.lock(tx, input);
    const db = tenantClient(tx);
    const stored = await this.find(tx, input);
    if (stored) {
      const sameEntity =
        stored.entityKind === kind &&
        stored.entityId === (entity.entityId ?? null) &&
        stored.entityKey === (entity.entityKey ?? null);
      // Never silently re-pointed (E5 §1): a triple resolves to exactly one record.
      if (stored.origin !== 'observed' || (!sameEntity && stored.state !== 'merged')) {
        throw new GovernanceError(
          'reference_identity_conflict',
          'The source reference is already bound to another record',
          { system: input.system, objectType: input.objectType },
        );
      }
    }
    const decision = decideReferenceObservation(
      stored ? lifecycle(stored) : undefined,
      {
        presence: input.presence,
        observedAt: input.observedAt,
        ...(input.sourceUpdatedAt ? { sourceUpdatedAt: input.sourceUpdatedAt } : {}),
      },
      input.presence === 'present' ? input.fieldHash : undefined,
    );
    const change = (changeType: ChangeType) =>
      this.insertChange(tx, actx, {
        kind,
        entity: stored ? { entityId: stored.entityId, entityKey: stored.entityKey } : entity,
        triple: input,
        changeType,
        meta: input.meta,
        sourceUpdatedAt: input.sourceUpdatedAt,
      });
    switch (decision) {
      case 'not_found':
      case 'stale':
        return { decision, ...(stored ? { referenceId: stored.id } : {}) };
      case 'unchanged': {
        const lastSeenAt =
          input.presence === 'present' && input.observedAt > stored!.lastSeenAt
            ? input.observedAt
            : stored!.lastSeenAt;
        if (lastSeenAt !== stored!.lastSeenAt) {
          await db.tenantSourceReference.update({
            where: { tenantId_id: { tenantId: tx.tenantId, id: stored!.id } },
            data: { lastSeenAt },
          });
        }
        return { decision, referenceId: stored!.id };
      }
      case 'create': {
        const changeId = await change('ref_added');
        const id = randomUUID();
        await db.tenantSourceReference.create({
          data: {
            tenantId: tx.tenantId,
            id,
            system: input.system,
            connectionId: input.meta.connectionId ?? null,
            objectType: input.objectType,
            externalId: input.externalId,
            entityKind: kind,
            entityId: entity.entityId ?? null,
            entityKey: entity.entityKey ?? null,
            origin: 'observed',
            state: 'active',
            firstSeenAt: input.observedAt,
            lastSeenAt: input.observedAt,
            sourceCreatedAt: input.sourceCreatedAt ?? null,
            sourceUpdatedAt: input.sourceUpdatedAt ?? null,
            fieldHash: input.fieldHash ?? null,
            lastChangeId: changeId,
          },
        });
        return { decision, referenceId: id, changeId };
      }
      case 'apply':
      case 'restore': {
        const changeId = await change(decision === 'restore' ? 'reactivated' : 'updated');
        await db.tenantSourceReference.update({
          where: { tenantId_id: { tenantId: tx.tenantId, id: stored!.id } },
          data: {
            state: 'active',
            deletedAt: null,
            retiredAt: null,
            retiredByRunId: null,
            lastSeenAt:
              input.observedAt > stored!.lastSeenAt ? input.observedAt : stored!.lastSeenAt,
            sourceUpdatedAt: input.sourceUpdatedAt ?? stored!.sourceUpdatedAt,
            fieldHash: input.fieldHash ?? null,
            lastChangeId: changeId,
          },
        });
        return { decision, referenceId: stored!.id, changeId };
      }
      case 'delete': {
        const changeId = await change('state_changed');
        await db.tenantSourceReference.update({
          where: { tenantId_id: { tenantId: tx.tenantId, id: stored!.id } },
          data: { state: 'deleted', deletedAt: input.observedAt, lastChangeId: changeId },
        });
        return { decision, referenceId: stored!.id, changeId };
      }
    }
  }

  /**
   * Retires the active observed references of one source object that an
   * accepted, proven, full run with no uncertainty did not see (M9B contract).
   * Called only from the sync completion transaction. Declared references are
   * never retired here.
   */
  @AuditFailures('source_reference.observe', 'source_reference')
  async retireAbsentWithin(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    run: RetireAbsentReferencesInput,
  ): Promise<number> {
    assertAuthorized(actx, 'canonical.source_sync');
    this.sameTenant(actx, tx);
    await this.requireVersion(tx);
    if (!run.accepted || !run.proven || !run.full || run.uncertain) return 0;
    const db = tenantClient(tx);
    const candidates = await db.tenantSourceReference.findMany({
      where: {
        tenantId: tx.tenantId,
        system: run.system,
        objectType: run.objectType,
        origin: 'observed',
        state: 'active',
      },
      orderBy: { externalId: 'asc' },
    });
    let retired = 0;
    for (const row of candidates) {
      const decision = decideRetirement(
        {
          externalId: row.externalId,
          origin: 'observed',
          state: row.state as SourceReferenceState,
          lastSeenAt: row.lastSeenAt,
        },
        run,
      );
      if (!decision.retire) continue;
      await this.lock(tx, row);
      const changeId = await this.insertChange(tx, actx, {
        kind: row.entityKind as GenericReferenceKind,
        entity: { entityId: row.entityId, entityKey: row.entityKey },
        triple: row,
        changeType: 'retired',
        meta: { ...run.meta, checkpointId: run.runId },
      });
      const out = await db.tenantSourceReference.updateMany({
        where: { tenantId: tx.tenantId, id: row.id, state: 'active' },
        data: {
          state: 'retired',
          retiredAt: run.observedAt,
          retiredByRunId: run.runId,
          lastChangeId: changeId,
        },
      });
      retired += out.count;
    }
    return retired;
  }

  /**
   * A source merge of generic references (ADR 0014 §5): the merged reference
   * becomes `merged` (terminal), re-pointed to the survivor's record, lineage
   * kept. For merge participants of later entity kinds.
   */
  @AuditFailures('source_reference.observe', 'source_reference')
  async merge(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: ReferenceMergeInput,
  ): Promise<'merged' | 'unchanged'> {
    assertAuthorized(actx, 'canonical.source_sync');
    this.sameTenant(actx, tx);
    const from = {
      system: input.system,
      objectType: input.objectType,
      externalId: input.fromExternalId,
    };
    const to = { ...from, externalId: input.survivorExternalId };
    this.validTriple(from);
    this.validTriple(to);
    await this.requireVersion(tx);
    for (const t of [from, to].sort((a, b) => a.externalId.localeCompare(b.externalId))) {
      await this.lock(tx, t);
    }
    const survivor = await this.find(tx, to);
    if (!survivor || survivor.state === 'merged') {
      throw new GovernanceError('validation_failed', 'The merge survivor is not a live reference');
    }
    const row = await this.find(tx, from);
    const decision = decideMerge(
      {
        externalId: input.fromExternalId,
        state: (row?.state ?? 'active') as SourceReferenceState,
        mergedIntoExternalId: row?.mergedIntoExternalId ?? null,
      },
      input.survivorExternalId,
    );
    if (decision === 'refused') {
      throw new GovernanceError(
        'reference_identity_conflict',
        'A reference cannot merge into itself',
      );
    }
    if (decision === 'unchanged') return 'unchanged';
    if (row && row.origin !== 'observed') {
      throw new GovernanceError(
        'reference_identity_conflict',
        'A declared reference is not merged',
      );
    }
    const kind = survivor.entityKind as GenericReferenceKind;
    const entity = { entityId: survivor.entityId, entityKey: survivor.entityKey };
    const changeId = await this.insertChange(tx, actx, {
      kind,
      entity,
      triple: from,
      changeType: 'merged',
      meta: input.meta,
    });
    const db = tenantClient(tx);
    if (!row) {
      await db.tenantSourceReference.create({
        data: {
          tenantId: tx.tenantId,
          id: randomUUID(),
          system: from.system,
          connectionId: input.meta.connectionId ?? null,
          objectType: from.objectType,
          externalId: from.externalId,
          entityKind: kind,
          entityId: entity.entityId,
          entityKey: entity.entityKey,
          origin: 'observed',
          state: 'merged',
          mergedIntoExternalId: input.survivorExternalId,
          firstSeenAt: input.observedAt,
          lastSeenAt: input.observedAt,
          lastChangeId: changeId,
        },
      });
      return 'merged';
    }
    await db.tenantSourceReference.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id: row.id } },
      data: {
        state: 'merged',
        mergedIntoExternalId: input.survivorExternalId,
        entityId: entity.entityId,
        entityKey: entity.entityKey,
        deletedAt: null,
        retiredAt: null,
        retiredByRunId: null,
        lastChangeId: changeId,
      },
    });
    return 'merged';
  }

  /**
   * The declared product-reference projection (plan §2.3, Q3), inside the
   * product-model publish transaction, after the product projection is
   * updated. Compares the published version's `externalRefs` with the stored
   * declared rows: newly declared → `ref_added`; removed → `retired`
   * (explicit, never inferred from a read); declared again → `reactivated`;
   * moved to another key → `updated`. Unchanged declarations are not written.
   */
  async applyDeclaredProductReferences(
    actx: AuthorizedContext<'config.product_model.publish'>,
    tx: TenantTransaction,
    model: DeclaredProductModel,
  ): Promise<DeclaredReferenceTransitions> {
    assertAuthorized(actx, 'config.product_model.publish');
    this.sameTenant(actx, tx);
    await tenantAdvisoryLock(tx, 'source-reference', 'declared-product');
    const db = tenantClient(tx);
    const desired = new Map<string, SourceTriple & { readonly key: string }>();
    for (const p of model.products) {
      for (const r of p.externalRefs ?? []) {
        const t = { system: r.system, objectType: r.objectType, externalId: r.id };
        desired.set(tripleKey(t), { ...t, key: p.key });
      }
    }
    const rows = await db.tenantSourceReference.findMany({
      where: { tenantId: tx.tenantId, entityKind: 'product' },
    });
    const byTriple = new Map(rows.map((r) => [tripleKey(r), r]));
    const now = new Date();
    const meta: ReferenceWriteMeta = {
      cause: 'human',
      adapter: PRODUCT_REFERENCE_ADAPTER,
      adapterVersion: String(model.version),
    };
    const counts = { added: 0, retired: 0, reactivated: 0, repointed: 0 };
    const change = (key: string, triple: SourceTriple, changeType: ChangeType) =>
      this.insertChange(tx, actx, {
        kind: 'product',
        entity: { entityId: null, entityKey: key },
        triple,
        changeType,
        meta,
        origin: 'human',
      });

    for (const [k, want] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
      const row = byTriple.get(k);
      if (!row) {
        const changeId = await change(want.key, want, 'ref_added');
        await db.tenantSourceReference.create({
          data: {
            tenantId: tx.tenantId,
            id: randomUUID(),
            system: want.system,
            objectType: want.objectType,
            externalId: want.externalId,
            entityKind: 'product',
            entityKey: want.key,
            origin: 'declared',
            declaredInModelVersion: model.version,
            state: 'active',
            firstSeenAt: now,
            lastSeenAt: now,
            lastChangeId: changeId,
          },
        });
        counts.added += 1;
        continue;
      }
      if (row.origin !== 'declared') {
        throw new GovernanceError(
          'reference_identity_conflict',
          'A declared product reference is already observed for another record',
          { system: want.system, objectType: want.objectType },
        );
      }
      if (row.state === 'active' && row.entityKey === want.key) continue;
      const reactivating = row.state !== 'active';
      const changeId = await change(want.key, want, reactivating ? 'reactivated' : 'updated');
      await db.tenantSourceReference.update({
        where: { tenantId_id: { tenantId: tx.tenantId, id: row.id } },
        data: {
          state: 'active',
          entityKey: want.key,
          declaredInModelVersion: model.version,
          retiredAt: null,
          retiredByModelVersion: null,
          lastSeenAt: now,
          lastChangeId: changeId,
        },
      });
      if (reactivating) counts.reactivated += 1;
      else counts.repointed += 1;
    }

    for (const row of rows) {
      if (row.origin !== 'declared' || row.state !== 'active' || desired.has(tripleKey(row))) {
        continue;
      }
      const changeId = await change(row.entityKey!, row, 'retired');
      await db.tenantSourceReference.update({
        where: { tenantId_id: { tenantId: tx.tenantId, id: row.id } },
        data: {
          state: 'retired',
          retiredAt: now,
          retiredByModelVersion: model.version,
          lastChangeId: changeId,
        },
      });
      counts.retired += 1;
    }
    return counts;
  }

  private sameTenant(actx: AuthorizedContext, tx: TenantTransaction): void {
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('source reference tenant does not match the transaction tenant');
    }
  }

  private genericKind(kind: string): GenericReferenceKind {
    if (!(GENERIC_REFERENCE_KINDS as readonly string[]).includes(kind)) {
      throw new GovernanceError(
        'reference_kind_not_generic',
        `Entity kind ${kind} is not held by the generic reference store`,
      );
    }
    return kind as GenericReferenceKind;
  }

  private validTriple(t: SourceTriple): void {
    if (
      !SOURCE_OBJECT_TYPE_PATTERN.test(t.objectType) ||
      !SOURCE_EXTERNAL_ID_PATTERN.test(t.externalId)
    ) {
      throw new GovernanceError('validation_failed', 'Source coordinates must be identifiers');
    }
  }

  private entityOf(
    kind: GenericReferenceKind,
    input: { readonly entityId?: string; readonly entityKey?: string },
  ): { readonly entityId?: string; readonly entityKey?: string } {
    const byKey = KEY_IDENTIFIED_REFERENCE_KINDS.includes(kind);
    if (byKey ? !input.entityKey || input.entityId : !input.entityId || input.entityKey) {
      throw new GovernanceError(
        'validation_failed',
        `Entity kind ${kind} is identified by ${byKey ? 'key' : 'id'}`,
      );
    }
    return byKey ? { entityKey: input.entityKey! } : { entityId: input.entityId! };
  }

  /** M10C: a `person_affiliation` reference needs canonical 0.3; M10E `account_context` 0.5; every other kind 0.2. */
  private async requireVersion(
    tx: TenantTransaction,
    min: string = GENERIC_REFERENCES_MIN_VERSION,
  ): Promise<void> {
    const adopted = await adoptedCanonicalVersion(tx);
    if (compareCanonicalVersion(adopted, min) < 0) {
      throw new GovernanceError(
        'canonical_version_too_low',
        `Observed generic references need canonical ${min} (adopted ${adopted})`,
      );
    }
  }

  private lock(tx: TenantTransaction, t: SourceTriple): Promise<void> {
    return tenantAdvisoryLock(tx, 'source-reference', tripleKey(t));
  }

  private async find(tx: TenantTransaction, t: SourceTriple): Promise<ReferenceRow | null> {
    return tenantClient(tx).tenantSourceReference.findUnique({
      where: {
        tenantId_system_objectType_externalId: {
          tenantId: tx.tenantId,
          system: t.system,
          objectType: t.objectType,
          externalId: t.externalId,
        },
      },
    });
  }

  private async insertChange(
    tx: TenantTransaction,
    actx: AuthorizedContext,
    input: {
      readonly kind: GenericReferenceKind;
      readonly entity: {
        readonly entityId?: string | null;
        readonly entityKey?: string | null;
      };
      readonly triple: SourceTriple;
      readonly changeType: ChangeType;
      readonly meta: ReferenceWriteMeta;
      readonly origin?: 'human';
      readonly sourceUpdatedAt?: Date;
    },
  ): Promise<string> {
    const governance = await changeGovernance(tx, {
      sourceConnectionId: input.meta.connectionId ?? null,
      mappingVersion: input.meta.mappingVersion ?? null,
      sourceObjectType: input.triple.objectType,
      ...(input.origin ? { origin: input.origin } : {}),
    });
    const id = randomUUID();
    await tenantClient(tx).tenantContextChange.create({
      data: {
        tenantId: tx.tenantId,
        id,
        entityKind: input.kind,
        entityId: input.entity.entityId ?? null,
        entityKey: input.entity.entityKey ?? null,
        changeType: input.changeType,
        changedFields: [SOURCE_REFERENCE_CHANGED_FIELD],
        sourceSystem: input.triple.system,
        sourceObjectType: input.triple.objectType,
        sourceRecordId: input.triple.externalId,
        cause: input.meta.cause,
        checkpointId: input.meta.checkpointId ?? null,
        sourceUpdatedAt: input.sourceUpdatedAt ?? null,
        adapter: input.meta.adapter,
        adapterVersion: input.meta.adapterVersion,
        correlationId: actx.correlationId,
        sourceConnectionId: input.meta.connectionId ?? null,
        mappingVersion: input.meta.mappingVersion ?? null,
        actorKind: actx.actor.kind,
        actorId: actx.actor.id,
        actorAssurance: actx.actor.assurance,
        origin: governance.origin,
        canonicalVersion: governance.canonicalVersion,
        schemaSnapshotHash: governance.schemaSnapshotHash,
        transforms: governance.transforms,
      },
    });
    return id;
  }
}

function lifecycle(row: ReferenceRow) {
  return {
    state: row.state as SourceReferenceState,
    ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt } : {}),
    ...(row.fieldHash ? { fieldHash: row.fieldHash } : {}),
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
    ...(row.retiredAt ? { retiredAt: row.retiredAt } : {}),
    lastSeenAt: row.lastSeenAt,
  };
}
