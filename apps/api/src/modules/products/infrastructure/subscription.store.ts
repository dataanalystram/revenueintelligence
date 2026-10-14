import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { COMPANY_CANONICAL_LOCK_SCOPE, type CompanyMerge } from '../../context';
import type { SecurityActor, SubscriptionSource, SubscriptionState } from '../../domain';
import {
  adoptedCanonicalVersion,
  changeGovernance,
  tenantAdvisoryLock,
  tenantClient,
  type TenantTransaction,
} from '../../tenancy';
import { toRow, type SubscriptionRow } from './subscription.rows';

export type { SubscriptionRow } from './subscription.rows';

/**
 * Subscription writes (ADR 0017). Only the single writer
 * (`SubscriptionIngestionService`) and the merge participant may import this
 * file (dependency rule `subscription-store-only-from-writer`); reads go
 * through `SubscriptionQueries`.
 */

export interface SubscriptionValues {
  readonly companyId: string;
  readonly productKey: string;
  readonly state: SubscriptionState;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly quantity: number | null;
  readonly sourceUpdatedAt: Date | null;
  readonly fieldHash: string;
}

export interface SubscriptionChange {
  readonly subscriptionId: string;
  readonly changeType: 'created' | 'updated' | 'state_changed';
  readonly changedFields: readonly string[];
  readonly source: SubscriptionSource;
  readonly cause: string;
  readonly checkpointId?: string;
  readonly sourceUpdatedAt?: Date;
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly sourceConnectionId?: string;
  readonly mappingVersion?: number;
  readonly correlationId: string;
  /** M10A1: who wrote the change. */
  readonly actor?: SecurityActor;
}

@Injectable()
export class SubscriptionStore {
  /** Serialises work on one source line (first lock taken by the writer). */
  async lockLine(tx: TenantTransaction, source: SubscriptionSource): Promise<void> {
    await tenantAdvisoryLock(
      tx,
      'subscription-line',
      `${source.system}|${source.objectType}|${source.recordId}`,
    );
  }

  /**
   * The canonical-company lock shared with the M6 merge (ADR 0017 §8). Taken
   * before touching any subscription row; callers lock several ids sorted.
   */
  async lockCompanies(tx: TenantTransaction, companyIds: readonly string[]): Promise<void> {
    for (const id of [...new Set(companyIds)].sort()) {
      await tenantAdvisoryLock(tx, COMPANY_CANONICAL_LOCK_SCOPE, id);
    }
  }

  async findBySource(
    tx: TenantTransaction,
    source: SubscriptionSource,
  ): Promise<SubscriptionRow | undefined> {
    const row = await tenantClient(tx).tenantSubscription.findUnique({
      where: {
        tenantId_sourceSystem_sourceObjectType_sourceRecordId: {
          tenantId: tx.tenantId,
          sourceSystem: source.system,
          sourceObjectType: source.objectType,
          sourceRecordId: source.recordId,
        },
      },
    });
    return row ? toRow(row) : undefined;
  }

  async insert(
    tx: TenantTransaction,
    source: SubscriptionSource,
    values: SubscriptionValues,
    observedAt: Date,
  ): Promise<string> {
    const id = randomUUID();
    await tenantClient(tx).tenantSubscription.create({
      data: {
        tenantId: tx.tenantId,
        id,
        companyId: values.companyId,
        productKey: values.productKey,
        state: values.state,
        startsAt: values.startsAt,
        endsAt: values.endsAt,
        quantity: values.quantity,
        sourceSystem: source.system,
        sourceObjectType: source.objectType,
        sourceRecordId: source.recordId,
        sourceUpdatedAt: values.sourceUpdatedAt,
        observedAt,
        fieldHash: values.fieldHash,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      },
    });
    return id;
  }

  async update(
    tx: TenantTransaction,
    id: string,
    patch: Partial<SubscriptionValues> & {
      recordState?: 'active' | 'deleted';
      deletedAt?: Date | null;
      observedAt?: Date;
      lastSeenAt?: Date;
      lastChangeId?: string;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantSubscription.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: patch,
    });
  }

  /** Provenance in the M6 table: field names only, never values. */
  async insertChange(tx: TenantTransaction, change: SubscriptionChange): Promise<string> {
    const id = randomUUID();
    const connectionId =
      change.sourceConnectionId ??
      (
        await tenantClient(tx).tenantSourceConnection.findUnique({
          where: { tenantId_kind: { tenantId: tx.tenantId, kind: change.source.system } },
          select: { id: true },
        })
      )?.id ??
      null;
    // M10A2: origin, adopted canonical version (fail closed), snapshot hash, transforms.
    const governance = await changeGovernance(tx, {
      sourceConnectionId: connectionId,
      mappingVersion: change.mappingVersion ?? null,
      sourceObjectType: change.source.objectType,
    });
    await tenantClient(tx).tenantContextChange.create({
      data: {
        tenantId: tx.tenantId,
        id,
        entityKind: 'subscription',
        entityId: change.subscriptionId,
        changeType: change.changeType,
        changedFields: [...change.changedFields],
        sourceSystem: change.source.system,
        sourceObjectType: change.source.objectType,
        sourceRecordId: change.source.recordId,
        cause: change.cause,
        checkpointId: change.checkpointId ?? null,
        sourceUpdatedAt: change.sourceUpdatedAt ?? null,
        adapter: change.adapter,
        adapterVersion: change.adapterVersion,
        correlationId: change.correlationId,
        sourceConnectionId: connectionId,
        mappingVersion: change.mappingVersion ?? null,
        actorKind: change.actor?.kind ?? null,
        actorId: change.actor?.id ?? null,
        actorAssurance: change.actor?.assurance ?? null,
        origin: governance.origin,
        canonicalVersion: governance.canonicalVersion,
        schemaSnapshotHash: governance.schemaSnapshotHash,
        transforms: governance.transforms,
      },
    });
    await this.update(tx, change.subscriptionId, { lastChangeId: id });
    return id;
  }

  /**
   * Account merge (ADR 0017 §8): the same rows move to the survivor in one
   * set-based statement, each with one `merged` provenance row carrying the
   * merge's own cause and source. No row is created or deleted.
   */
  async repointCompany(tx: TenantTransaction, merge: CompanyMerge): Promise<number> {
    const p = merge.provenance;
    // M10A2: a merge is source-provided provenance at the adopted version.
    const canonicalVersion = await adoptedCanonicalVersion(tx);
    return tenantClient(tx).$executeRaw`
      WITH target AS (
        SELECT id FROM tenant_subscriptions
         WHERE tenant_id = ${tx.tenantId}::uuid AND company_id = ${merge.loserId}::uuid
         FOR UPDATE
      ), prov AS (
        INSERT INTO tenant_context_changes (
          tenant_id, id, entity_kind, entity_id, change_type, changed_fields,
          source_system, source_object_type, source_record_id, cause,
          receipt_delivery_key, checkpoint_id, source_updated_at,
          adapter, adapter_version, correlation_id,
          actor_kind, actor_id, actor_assurance, origin, canonical_version, transforms)
        SELECT ${tx.tenantId}::uuid, gen_random_uuid(), 'subscription', target.id, 'merged', ARRAY['companyId'],
               ${p.source.system}, ${p.source.objectType}, ${p.source.id}, ${p.cause},
               ${p.receiptDeliveryKey ?? null}, ${p.checkpointId ?? null}::uuid, ${p.sourceUpdatedAt ?? null}::timestamptz,
               ${p.adapter}, ${p.adapterVersion}, ${p.correlationId}::uuid,
               ${p.actor?.kind ?? null}, ${p.actor?.id ?? null}, ${p.actor?.assurance ?? null},
               'source_provided', ${canonicalVersion}, ARRAY[]::text[]
          FROM target
        RETURNING id, entity_id
      )
      UPDATE tenant_subscriptions s
         SET company_id = ${merge.survivorId}::uuid, last_change_id = prov.id
        FROM prov
       WHERE s.tenant_id = ${tx.tenantId}::uuid AND s.id = prov.entity_id`;
  }
}
