import { Injectable } from '@nestjs/common';
import type { SubscriptionFact, SubscriptionState } from '../../domain';
import { tenantClient, type TenantTransaction } from '../../tenancy';
import { toRow, type SubscriptionRow } from './subscription.rows';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read-only subscription queries (no writes): resolution, facts, read model, invariants. */
@Injectable()
export class SubscriptionQueries {
  /**
   * Resolve an account reference to a canonical company: a platform company id,
   * or `system:objectType:id` (an M6 external reference). Follows merge lineage.
   * Undefined when unknown or not usable.
   */
  async resolveCompany(tx: TenantTransaction, ref: string): Promise<string | undefined> {
    const db = tenantClient(tx);
    let start: string | undefined;
    if (UUID.test(ref)) {
      start = (
        await db.company.findUnique({
          where: { tenantId_id: { tenantId: tx.tenantId, id: ref } },
          select: { id: true },
        })
      )?.id;
    } else {
      const m = /^([a-z_]+):([A-Za-z0-9_]+):([A-Za-z0-9_.-]+)$/.exec(ref);
      if (!m) return undefined;
      const extRef = await db.companyExternalRef.findUnique({
        where: {
          tenantId_system_objectType_externalId: {
            tenantId: tx.tenantId,
            system: m[1]!,
            objectType: m[2]!,
            externalId: m[3]!,
          },
        },
        select: { companyId: true },
      });
      start = extRef?.companyId;
    }
    return start ? this.canonicalCompany(tx, start) : undefined;
  }

  /** Follow `merged_into_id` to the surviving company. */
  async canonicalCompany(tx: TenantTransaction, companyId: string): Promise<string> {
    const db = tenantClient(tx);
    let current = companyId;
    for (let hops = 0; hops < 20; hops += 1) {
      const row = await db.company.findUnique({
        where: { tenantId_id: { tenantId: tx.tenantId, id: current } },
        select: { recordState: true, mergedIntoId: true },
      });
      if (!row || row.recordState !== 'merged' || !row.mergedIntoId) return current;
      current = row.mergedIntoId;
    }
    throw new Error('merge lineage too deep');
  }

  async productExists(tx: TenantTransaction, key: string): Promise<boolean> {
    return (
      (await tenantClient(tx).tenantProduct.count({ where: { tenantId: tx.tenantId, key } })) > 0
    );
  }

  /** Non-deleted lines of one company: the facts the evaluator reads. */
  async factsForCompany(
    tx: TenantTransaction,
    companyId: string,
    sourceSystem?: string,
  ): Promise<SubscriptionFact[]> {
    const rows = await tenantClient(tx).tenantSubscription.findMany({
      where: {
        tenantId: tx.tenantId,
        companyId,
        recordState: 'active',
        ...(sourceSystem ? { sourceSystem } : {}),
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      productKey: r.productKey as SubscriptionFact['productKey'],
      state: r.state as SubscriptionState,
      ...(r.startsAt ? { startsAt: r.startsAt } : {}),
      ...(r.endsAt ? { endsAt: r.endsAt } : {}),
      ...(r.quantity !== null ? { quantity: r.quantity } : {}),
    }));
  }

  /** Every line of one company, including tombstones (read model / UI). */
  async linesForCompany(tx: TenantTransaction, companyId: string): Promise<SubscriptionRow[]> {
    const rows = await tenantClient(tx).tenantSubscription.findMany({
      where: { tenantId: tx.tenantId, companyId },
      orderBy: [{ productKey: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toRow);
  }

  /** Lines of one source not seen since `since` (a full load tombstones them). */
  async unseenSince(
    tx: TenantTransaction,
    system: string,
    objectType: string,
    since: Date,
  ): Promise<SubscriptionRow[]> {
    const rows = await tenantClient(tx).tenantSubscription.findMany({
      where: {
        tenantId: tx.tenantId,
        sourceSystem: system,
        sourceObjectType: objectType,
        recordState: 'active',
        lastSeenAt: { lt: since },
      },
      orderBy: { id: 'asc' },
    });
    return rows.map(toRow);
  }

  /** Source record ids of one source's non-deleted lines (full-import dry run). */
  async activeRecordIds(
    tx: TenantTransaction,
    system: string,
    objectType: string,
  ): Promise<string[]> {
    const rows = await tenantClient(tx).tenantSubscription.findMany({
      where: {
        tenantId: tx.tenantId,
        sourceSystem: system,
        sourceObjectType: objectType,
        recordState: 'active',
      },
      select: { sourceRecordId: true },
    });
    return rows.map((r) => r.sourceRecordId);
  }

  /** Invariant (ADR 0017 §8): non-deleted lines on a merged company. Must be empty. */
  async orphanedOnMergedCompanies(
    tx: TenantTransaction,
  ): Promise<{ id: string; companyId: string }[]> {
    return tenantClient(tx).$queryRaw<{ id: string; companyId: string }[]>`
      SELECT s.id::text AS "id", s.company_id::text AS "companyId"
        FROM tenant_subscriptions s
        JOIN companies c ON c.tenant_id = s.tenant_id AND c.id = s.company_id
       WHERE s.tenant_id = ${tx.tenantId}::uuid AND s.record_state = 'active' AND c.record_state = 'merged'
       ORDER BY s.id`;
  }

  async counts(tx: TenantTransaction): Promise<Record<string, number>> {
    const rows = await tenantClient(tx).tenantSubscription.groupBy({
      by: ['recordState', 'state'],
      where: { tenantId: tx.tenantId },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[`${r.recordState}:${r.state}`] = r._count._all;
    return out;
  }

  /** Open ownership gaps of one company for one connection (ADR 0020 §15). */
  async ownershipGapCount(
    tx: TenantTransaction,
    connectionId: string,
    companyId: string,
  ): Promise<number> {
    return tenantClient(tx).tenantOwnershipGap.count({
      where: { tenantId: tx.tenantId, connectionId, companyId },
    });
  }

  /** Source record ids of a system's non-deleted lines (full-run tombstone pass). */
  async activeSourceRecordIds(
    tx: TenantTransaction,
    system: string,
    objectType: string,
  ): Promise<string[]> {
    const rows = await tenantClient(tx).tenantSubscription.findMany({
      where: {
        tenantId: tx.tenantId,
        sourceSystem: system,
        sourceObjectType: objectType,
        recordState: 'active',
      },
      select: { sourceRecordId: true },
      orderBy: { sourceRecordId: 'asc' },
    });
    return rows.map((r) => r.sourceRecordId);
  }
}
