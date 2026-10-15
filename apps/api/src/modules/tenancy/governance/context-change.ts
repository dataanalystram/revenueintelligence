import { randomUUID } from 'node:crypto';
import type { ChangeOrigin, ConnectorKind, ContextKind, SecurityActor } from '../../domain';
import { tenantClient, type TenantTransaction } from '../infrastructure/tenant-database';
import { changeGovernance } from './change-governance';

/**
 * One canonical change record (M6 provenance, M10A2 governance columns).
 * Shared by the single canonical writer's store, the M10C account-structure
 * store and the M10D extension writers, so there is one implementation of how
 * a change record is written (moved here from the context module in M10D so
 * the extension module does not depend on context).
 */
export interface ChangeWrite {
  /**
   * M10C: `person_affiliation` for affiliation rows; M10D: extension targets
   * (`subscription`, `product`, `custom_record`) and `custom_relationship`
   * (CHANGE_ENTITY_KINDS).
   */
  readonly entityKind:
    | ContextKind
    | 'person_affiliation'
    | 'subscription'
    | 'product'
    | 'custom_record'
    | 'custom_relationship'
    // M10E (Q24): account contexts and their person memberships.
    | 'account_context'
    | 'account_context_person';
  /** Exactly one of `entityId` / `entityKey` (products are key-identified, M10B). */
  readonly entityId: string;
  readonly changeType:
    'created' | 'updated' | 'state_changed' | 'merged' | 'ref_added' | 'relationship_changed';
  readonly changedFields: readonly string[];
  /**
   * The source coordinates of the write. Operator entry (M10C) names the
   * `import` connector kind with object type `operator_entry` and the target's
   * canonical id (identifiers only).
   */
  readonly source: {
    readonly system: ConnectorKind;
    readonly objectType: string;
    readonly id: string;
  };
  readonly cause: string;
  readonly receiptDeliveryKey?: string;
  readonly checkpointId?: string;
  readonly sourceUpdatedAt?: Date;
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly correlationId: string;
  /** M8: the versioned mapping that produced the change (versioned connections only). */
  readonly mappingVersion?: number;
  /** M10A1: who wrote the change. */
  readonly actor?: SecurityActor;
  /** M10A2: defaults to `source_provided`; M10C operator entry writes `human`. */
  readonly origin?: ChangeOrigin;
}

export async function insertContextChange(
  tx: TenantTransaction,
  change: ChangeWrite,
): Promise<string> {
  const id = randomUUID();
  const connectionId = await sourceConnectionId(tx, change.source.system);
  // M10A2: origin, adopted canonical version (fail closed), snapshot hash, transforms.
  const governance = await changeGovernance(tx, {
    sourceConnectionId: connectionId,
    mappingVersion: change.mappingVersion ?? null,
    sourceObjectType: change.source.objectType,
    ...(change.origin ? { origin: change.origin } : {}),
  });
  await tenantClient(tx).tenantContextChange.create({
    data: {
      tenantId: tx.tenantId,
      id,
      entityKind: change.entityKind,
      ...(change.entityKind === 'product'
        ? { entityKey: change.entityId }
        : { entityId: change.entityId }),
      changeType: change.changeType,
      changedFields: [...change.changedFields],
      sourceSystem: change.source.system,
      sourceObjectType: change.source.objectType,
      sourceRecordId: change.source.id,
      cause: change.cause,
      receiptDeliveryKey: change.receiptDeliveryKey ?? null,
      checkpointId: change.checkpointId ?? null,
      sourceUpdatedAt: change.sourceUpdatedAt ?? null,
      adapter: change.adapter,
      adapterVersion: change.adapterVersion,
      correlationId: change.correlationId,
      // M8: every write names the tenant's connection of its source system.
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
  return id;
}

/** The tenant's source connection of a kind (one per kind in M8), if registered. */
export async function sourceConnectionId(
  tx: TenantTransaction,
  kind: string,
): Promise<string | null> {
  const row = await tenantClient(tx).tenantSourceConnection.findUnique({
    where: { tenantId_kind: { tenantId: tx.tenantId, kind } },
    select: { id: true },
  });
  return row?.id ?? null;
}
