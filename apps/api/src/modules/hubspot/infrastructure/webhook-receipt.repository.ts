import { Injectable } from '@nestjs/common';
import type { ReceiptListFilter, ReceiptStatus, SourceReceipt } from '../../crm';
import {
  TenantDatabase,
  tenantClient,
  type TenantContext,
  type TenantTransaction,
} from '../../tenancy';
import type { WebhookEvent } from './webhook-events';

export interface RecordedDeliveries {
  /** Events seen for the first time. */
  readonly stored: number;
  /** Redeliveries of events already recorded (counted on the existing row). */
  readonly duplicates: number;
  /** Delivery keys of the events stored for the first time (to queue them, M6). */
  readonly storedKeys: readonly string[];
}

/** A receipt with the identifiers the connector needs to plan its processing (M6). */
export interface HubSpotReceipt extends SourceReceipt {
  readonly accountId: string;
  readonly appId: string;
  readonly objectTypeId: string | undefined;
  readonly objectId: string | undefined;
  readonly merge: {
    readonly primaryObjectId: string | undefined;
    readonly newObjectId: string | undefined;
    readonly mergedObjectIds: readonly string[];
  };
  readonly association: {
    readonly fromObjectId: string | undefined;
    readonly fromObjectTypeId: string | undefined;
    readonly toObjectId: string | undefined;
    readonly toObjectTypeId: string | undefined;
  };
}

const CLAIMABLE: readonly ReceiptStatus[] = ['pending', 'retrying', 'processing'];

const RECEIPT_SELECT = {
  system: true,
  deliveryKey: true,
  subscriptionType: true,
  occurredAt: true,
  receivedAt: true,
  processingStatus: true,
  processingReason: true,
  processingAttempts: true,
  correlationId: true,
  accountId: true,
  appId: true,
  objectTypeId: true,
  objectId: true,
  primaryObjectId: true,
  newObjectId: true,
  mergedObjectIds: true,
  fromObjectId: true,
  fromObjectTypeId: true,
  toObjectId: true,
  toObjectTypeId: true,
} as const;

type ReceiptRecord = {
  system: string;
  deliveryKey: string;
  subscriptionType: string;
  occurredAt: Date;
  receivedAt: Date;
  processingStatus: string;
  processingReason: string | null;
  processingAttempts: number;
  correlationId: string | null;
  accountId: string;
  appId: string;
  objectTypeId: string | null;
  objectId: string | null;
  primaryObjectId: string | null;
  newObjectId: string | null;
  mergedObjectIds: string[];
  fromObjectId: string | null;
  fromObjectTypeId: string | null;
  toObjectId: string | null;
  toObjectTypeId: string | null;
};

function toReceipt(r: ReceiptRecord): HubSpotReceipt {
  return {
    system: 'hubspot',
    deliveryKey: r.deliveryKey,
    subscriptionType: r.subscriptionType,
    occurredAt: r.occurredAt,
    receivedAt: r.receivedAt,
    status: r.processingStatus as ReceiptStatus,
    reason: r.processingReason ?? undefined,
    attempts: r.processingAttempts,
    correlationId: r.correlationId ?? undefined,
    accountId: r.accountId,
    appId: r.appId,
    objectTypeId: r.objectTypeId ?? undefined,
    objectId: r.objectId ?? undefined,
    merge: {
      primaryObjectId: r.primaryObjectId ?? undefined,
      newObjectId: r.newObjectId ?? undefined,
      mergedObjectIds: r.mergedObjectIds,
    },
    association: {
      fromObjectId: r.fromObjectId ?? undefined,
      fromObjectTypeId: r.fromObjectTypeId ?? undefined,
      toObjectId: r.toObjectId ?? undefined,
      toObjectTypeId: r.toObjectTypeId ?? undefined,
    },
  };
}

export interface WebhookReceiptSummary {
  readonly receipts: number;
  readonly redelivered: number;
  readonly totalDeliveries: number;
  readonly maxAttemptNumber: number | null;
  readonly firstReceivedAt: Date | null;
  readonly lastReceivedAt: Date | null;
  readonly byType: readonly {
    readonly subscriptionType: string;
    readonly objectTypeId: string | null;
    readonly propertyName: string | null;
    readonly receipts: number;
  }[];
}

/** One receipt as metadata (identifiers, types, attempts, times): the report's `recent` list. */
export interface WebhookReceiptRow {
  readonly eventId: string;
  readonly subscriptionId: string;
  readonly subscriptionType: string;
  readonly objectTypeId: string | null;
  readonly objectId: string | null;
  readonly propertyName: string | null;
  readonly changeSource: string | null;
  readonly occurredAt: Date;
  readonly firstAttemptNumber: number;
  readonly lastAttemptNumber: number;
  readonly deliveries: number;
  readonly receivedAt: Date;
  readonly lastReceivedAt: Date;
}

/**
 * Tenant-scoped webhook receipts (forced RLS, ADR 0008/0011). De-duplication
 * is atomic: one INSERT … ON CONFLICT per event on the primary key (tenant,
 * system, delivery key), so concurrent deliveries of the same event leave
 * exactly one row; redeliveries only update its counters.
 */
@Injectable()
export class WebhookReceiptRepository {
  constructor(private readonly db: TenantDatabase) {}

  async record(
    ctx: TenantContext,
    events: readonly WebhookEvent[],
    receivedAt: Date,
    correlationId?: string,
    /** M10A1: runs in the same transaction (the batch's audit event). */
    afterWrite?: (tx: TenantTransaction, recorded: RecordedDeliveries) => Promise<void>,
  ): Promise<RecordedDeliveries> {
    return await this.db.transaction(ctx, async (tx) => {
      const client = tenantClient(tx);
      let stored = 0;
      let duplicates = 0;
      const storedKeys: string[] = [];
      for (const e of events) {
        const m = e.merge;
        const a = e.association;
        const rows = await client.$queryRaw<{ inserted: boolean }[]>`
          INSERT INTO tenant_webhook_receipts AS r (
            tenant_id, system, delivery_key, event_id, subscription_id, account_id, app_id,
            subscription_type, object_type_id, object_id, property_name, change_source,
            occurred_at, first_attempt_number, last_attempt_number, received_at, last_received_at,
            correlation_id, primary_object_id, new_object_id, merged_object_ids,
            from_object_id, from_object_type_id, to_object_id, to_object_type_id,
            association_type_id, association_category, association_removed, is_primary_association)
          VALUES (
            ${tx.tenantId}::uuid, 'hubspot', ${e.deliveryKey}, ${e.eventId}, ${e.subscriptionId},
            ${e.accountId}, ${e.appId}, ${e.subscriptionType}, ${e.objectTypeId ?? null},
            ${e.objectId ?? null}, ${e.propertyName ?? null}, ${e.changeSource ?? null},
            ${e.occurredAt}, ${e.attemptNumber}, ${e.attemptNumber}, ${receivedAt}, ${receivedAt},
            ${correlationId ?? null}::uuid, ${m?.primaryObjectId ?? null}, ${m?.newObjectId ?? null},
            ${m ? [...m.mergedObjectIds] : []}::text[],
            ${a?.fromObjectId ?? null}, ${a?.fromObjectTypeId ?? null}, ${a?.toObjectId ?? null},
            ${a?.toObjectTypeId ?? null}, ${a?.associationTypeId ?? null}::int,
            ${a?.associationCategory ?? null}, ${a?.associationRemoved ?? null}::boolean,
            ${a?.isPrimaryAssociation ?? null}::boolean)
          ON CONFLICT (tenant_id, system, delivery_key) DO UPDATE SET
            deliveries = r.deliveries + 1,
            first_attempt_number = LEAST(r.first_attempt_number, EXCLUDED.first_attempt_number),
            last_attempt_number = GREATEST(r.last_attempt_number, EXCLUDED.last_attempt_number),
            last_received_at = GREATEST(r.last_received_at, EXCLUDED.last_received_at)
          RETURNING (xmax = 0) AS inserted`;
        if (rows[0]?.inserted) {
          stored += 1;
          storedKeys.push(e.deliveryKey);
        } else duplicates += 1;
      }
      const recorded = { stored, duplicates, storedKeys };
      await afterWrite?.(tx, recorded);
      return recorded;
    });
  }

  // --- M6 processing state (CrmReceiptSource storage, ADR 0013) -------------

  async load(tx: TenantTransaction, deliveryKey: string): Promise<HubSpotReceipt | undefined> {
    const row = await tenantClient(tx).tenantWebhookReceipt.findFirst({
      where: { tenantId: tx.tenantId, system: 'hubspot', deliveryKey },
      select: RECEIPT_SELECT,
    });
    return row ? toReceipt(row) : undefined;
  }

  /** Atomic: only one concurrent claimer wins; finished receipts are never claimed. */
  async claim(tx: TenantTransaction, deliveryKey: string): Promise<boolean> {
    const { count } = await tenantClient(tx).tenantWebhookReceipt.updateMany({
      where: {
        tenantId: tx.tenantId,
        system: 'hubspot',
        deliveryKey,
        processingStatus: { in: [...CLAIMABLE] },
      },
      data: { processingStatus: 'processing', processingAttempts: { increment: 1 } },
    });
    return count === 1;
  }

  async finish(
    tx: TenantTransaction,
    deliveryKey: string,
    status: ReceiptStatus,
    reason?: string,
  ): Promise<void> {
    const terminal = status !== 'pending' && status !== 'processing' && status !== 'retrying';
    await tenantClient(tx).tenantWebhookReceipt.updateMany({
      where: { tenantId: tx.tenantId, system: 'hubspot', deliveryKey },
      data: {
        processingStatus: status,
        processingReason: reason ?? null,
        processedAt: terminal ? new Date() : null,
      },
    });
  }

  async reset(tx: TenantTransaction, deliveryKeys: readonly string[]): Promise<number> {
    const { count } = await tenantClient(tx).tenantWebhookReceipt.updateMany({
      where: { tenantId: tx.tenantId, system: 'hubspot', deliveryKey: { in: [...deliveryKeys] } },
      data: { processingStatus: 'pending', processedAt: null },
    });
    return count;
  }

  async list(ctx: TenantContext, filter: ReceiptListFilter): Promise<HubSpotReceipt[]> {
    return await this.db.transaction(ctx, async (tx) => {
      const rows = await tenantClient(tx).tenantWebhookReceipt.findMany({
        where: {
          tenantId: tx.tenantId,
          system: 'hubspot',
          processingStatus: { in: [...filter.statuses] },
          ...(filter.receivedFrom || filter.receivedTo
            ? {
                receivedAt: {
                  ...(filter.receivedFrom ? { gte: filter.receivedFrom } : {}),
                  ...(filter.receivedTo ? { lte: filter.receivedTo } : {}),
                },
              }
            : {}),
          ...(filter.onlyReason !== undefined ? { processingReason: filter.onlyReason } : {}),
          ...(filter.excludeReason !== undefined
            ? {
                OR: [
                  { processingReason: null },
                  { processingReason: { not: filter.excludeReason } },
                ],
              }
            : {}),
        },
        orderBy: [{ receivedAt: 'asc' }, { deliveryKey: 'asc' }],
        take: Math.max(1, Math.min(filter.limit, 10_000)),
        select: RECEIPT_SELECT,
      });
      return rows.map(toReceipt);
    });
  }

  /** Receipt counts by processing status (reports). */
  async statusCounts(ctx: TenantContext): Promise<Record<string, number>> {
    return await this.db.transaction(ctx, async (tx) => {
      const groups = await tenantClient(tx).tenantWebhookReceipt.groupBy({
        by: ['processingStatus'],
        where: { tenantId: tx.tenantId, system: 'hubspot' },
        _count: { _all: true },
        orderBy: { processingStatus: 'asc' },
      });
      return Object.fromEntries(groups.map((g) => [g.processingStatus, g._count._all]));
    });
  }

  /** The newest receipts of a tenant, as metadata only (no values exist to return). */
  async recent(ctx: TenantContext, limit: number, since?: Date): Promise<WebhookReceiptRow[]> {
    return await this.db.transaction(ctx, async (tx) => {
      const rows = await tenantClient(tx).tenantWebhookReceipt.findMany({
        where: {
          tenantId: tx.tenantId,
          system: 'hubspot',
          ...(since ? { receivedAt: { gte: since } } : {}),
        },
        orderBy: [{ receivedAt: 'desc' }, { eventId: 'desc' }],
        take: Math.max(1, Math.min(limit, 200)),
        select: {
          eventId: true,
          subscriptionId: true,
          subscriptionType: true,
          objectTypeId: true,
          objectId: true,
          propertyName: true,
          changeSource: true,
          occurredAt: true,
          firstAttemptNumber: true,
          lastAttemptNumber: true,
          deliveries: true,
          receivedAt: true,
          lastReceivedAt: true,
        },
      });
      return rows;
    });
  }

  /** Safe metadata about a tenant's receipts (counts, types, times): the webhook report. */
  async summary(ctx: TenantContext, since?: Date): Promise<WebhookReceiptSummary> {
    return await this.db.transaction(ctx, async (tx) => {
      const client = tenantClient(tx);
      const where = {
        tenantId: tx.tenantId,
        system: 'hubspot',
        ...(since ? { receivedAt: { gte: since } } : {}),
      };
      // Sequential: one connection per transaction.
      const agg = await client.tenantWebhookReceipt.aggregate({
        where,
        _count: { _all: true },
        _sum: { deliveries: true },
        _max: { lastAttemptNumber: true, lastReceivedAt: true },
        _min: { receivedAt: true },
      });
      const redelivered = await client.tenantWebhookReceipt.count({
        where: { ...where, deliveries: { gt: 1 } },
      });
      const groups = await client.tenantWebhookReceipt.groupBy({
        by: ['subscriptionType', 'objectTypeId', 'propertyName'],
        where,
        _count: { _all: true },
        orderBy: [{ subscriptionType: 'asc' }, { objectTypeId: 'asc' }, { propertyName: 'asc' }],
      });
      return {
        receipts: agg._count._all,
        redelivered,
        totalDeliveries: agg._sum.deliveries ?? 0,
        maxAttemptNumber: agg._max.lastAttemptNumber,
        firstReceivedAt: agg._min.receivedAt,
        lastReceivedAt: agg._max.lastReceivedAt,
        byType: groups.map((g) => ({
          subscriptionType: g.subscriptionType,
          objectTypeId: g.objectTypeId,
          propertyName: g.propertyName,
          receipts: g._count._all,
        })),
      };
    });
  }
}
