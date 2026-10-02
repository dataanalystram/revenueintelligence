import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { tenantClient, type TenantTransaction } from '../../tenancy';

/**
 * Frozen eligibility evidence (ADR 0018 §5). Append-only: a database trigger
 * refuses UPDATE and DELETE. `result` holds the checks and the frozen input
 * facts (identifiers, codes, dates — never names or other record values).
 */

export interface SnapshotRow {
  readonly id: string;
  readonly requestedCompanyId: string;
  readonly evaluatedCompanyId: string;
  readonly productKey: string;
  readonly asOf: Date;
  readonly evaluatedAt: Date;
  readonly status: string;
  readonly ownership: string;
  readonly modelVersion: number;
  readonly modelHash: string;
  readonly evaluatorVersion: number;
  readonly factsHash: string;
  readonly result: unknown;
  readonly purpose: string;
  readonly correlationId: string;
}

export type NewSnapshot = Omit<SnapshotRow, 'id' | 'evaluatedAt'>;

@Injectable()
export class EligibilitySnapshotStore {
  async insert(tx: TenantTransaction, snapshot: NewSnapshot): Promise<SnapshotRow> {
    const row = await tenantClient(tx).tenantEligibilitySnapshot.create({
      data: {
        tenantId: tx.tenantId,
        id: randomUUID(),
        ...snapshot,
        result: JSON.parse(JSON.stringify(snapshot.result)) as Prisma.InputJsonValue,
      },
    });
    return row;
  }

  async byId(tx: TenantTransaction, id: string): Promise<SnapshotRow | undefined> {
    const row = await tenantClient(tx).tenantEligibilitySnapshot.findUnique({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
    });
    return row ?? undefined;
  }

  async list(
    tx: TenantTransaction,
    filter: { companyId?: string; productKey?: string; limit?: number } = {},
  ): Promise<SnapshotRow[]> {
    return tenantClient(tx).tenantEligibilitySnapshot.findMany({
      where: {
        tenantId: tx.tenantId,
        ...(filter.companyId ? { evaluatedCompanyId: filter.companyId } : {}),
        ...(filter.productKey ? { productKey: filter.productKey } : {}),
      },
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'asc' }],
      take: filter.limit ?? 50,
    });
  }

  async count(tx: TenantTransaction): Promise<number> {
    return tenantClient(tx).tenantEligibilitySnapshot.count({ where: { tenantId: tx.tenantId } });
  }
}
