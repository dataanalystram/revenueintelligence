import { Injectable } from '@nestjs/common';
import { TenantDatabase, tenantClient, type TenantContext } from '../../tenancy';
import type { WebhookEvent } from './webhook-events';

export interface RecordedDeliveries {
  /** Events seen for the first time. */
  readonly stored: number;
  /** Redeliveries of events already recorded (counted on the existing row). */
  readonly duplicates: number;
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
  ): Promise<RecordedDeliveries> {
    return await this.db.transaction(ctx, async (tx) => {
      const client = tenantClient(tx);
      let stored = 0;
      let duplicates = 0;
      for (const e of events) {
        const rows = await client.$queryRaw<{ inserted: boolean }[]>`
          INSERT INTO tenant_webhook_receipts AS r (
            tenant_id, system, delivery_key, event_id, subscription_id, account_id, app_id,
            subscription_type, object_type_id, object_id, property_name, change_source,
            occurred_at, first_attempt_number, last_attempt_number, received_at, last_received_at)
          VALUES (
            ${tx.tenantId}::uuid, 'hubspot', ${e.deliveryKey}, ${e.eventId}, ${e.subscriptionId},
            ${e.accountId}, ${e.appId}, ${e.subscriptionType}, ${e.objectTypeId ?? null},
            ${e.objectId ?? null}, ${e.propertyName ?? null}, ${e.changeSource ?? null},
            ${e.occurredAt}, ${e.attemptNumber}, ${e.attemptNumber}, ${receivedAt}, ${receivedAt})
          ON CONFLICT (tenant_id, system, delivery_key) DO UPDATE SET
            deliveries = r.deliveries + 1,
            first_attempt_number = LEAST(r.first_attempt_number, EXCLUDED.first_attempt_number),
            last_attempt_number = GREATEST(r.last_attempt_number, EXCLUDED.last_attempt_number),
            last_received_at = GREATEST(r.last_received_at, EXCLUDED.last_received_at)
          RETURNING (xmax = 0) AS inserted`;
        if (rows[0]?.inserted) stored += 1;
        else duplicates += 1;
      }
      return { stored, duplicates };
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
