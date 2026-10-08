import { Injectable } from '@nestjs/common';
import type { CompanyMerge } from '../../context';
import type { ProtectionGapReason } from '../../domain';
import { tenantClient, type TenantTransaction } from '../../tenancy';

export interface OwnershipGap {
  /** Canonical company of the line's account. */
  readonly companyId: string;
  readonly sourceObjectType: string;
  readonly sourceRecordId: string;
  /** M8 product-reference reasons, plus the M9A seen-but-rejected reasons (ADR 0023). */
  readonly reason: ProtectionGapReason;
}

/** Per-account ownership gaps (ADR 0020 §15): derived state, never evidence. */
@Injectable()
export class OwnershipGapStore {
  /** Replaces one connection's gaps with a completed full run's set (same transaction). */
  async replace(
    tx: TenantTransaction,
    connectionId: string,
    gaps: readonly OwnershipGap[],
    checkpointId: string,
  ): Promise<number> {
    const db = tenantClient(tx);
    await db.tenantOwnershipGap.deleteMany({ where: { tenantId: tx.tenantId, connectionId } });
    if (gaps.length === 0) return 0;
    const result = await db.tenantOwnershipGap.createMany({
      data: gaps.map((g) => ({
        tenantId: tx.tenantId,
        connectionId,
        sourceObjectType: g.sourceObjectType,
        sourceRecordId: g.sourceRecordId,
        companyId: g.companyId,
        reason: g.reason,
        checkpointId,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  /** Adds gaps seen by an incremental run (never removes: only full runs replace). */
  async add(
    tx: TenantTransaction,
    connectionId: string,
    gaps: readonly OwnershipGap[],
    checkpointId: string,
  ): Promise<number> {
    if (gaps.length === 0) return 0;
    const result = await tenantClient(tx).tenantOwnershipGap.createMany({
      data: gaps.map((g) => ({
        tenantId: tx.tenantId,
        connectionId,
        sourceObjectType: g.sourceObjectType,
        sourceRecordId: g.sourceRecordId,
        companyId: g.companyId,
        reason: g.reason,
        checkpointId,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  /** Account merge: the merged-away company's gaps follow the survivor. */
  async repointCompany(tx: TenantTransaction, merge: CompanyMerge): Promise<number> {
    const result = await tenantClient(tx).tenantOwnershipGap.updateMany({
      where: { tenantId: tx.tenantId, companyId: merge.loserId },
      data: { companyId: merge.survivorId },
    });
    return result.count;
  }

  async list(tx: TenantTransaction, connectionId?: string) {
    return tenantClient(tx).tenantOwnershipGap.findMany({
      where: { tenantId: tx.tenantId, ...(connectionId ? { connectionId } : {}) },
      orderBy: [{ companyId: 'asc' }, { sourceRecordId: 'asc' }],
      select: {
        connectionId: true,
        companyId: true,
        sourceObjectType: true,
        sourceRecordId: true,
        reason: true,
        checkpointId: true,
      },
    });
  }
}
