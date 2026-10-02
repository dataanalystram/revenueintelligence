import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import type { ProductModelDocument } from '../../domain';
import { tenantAdvisoryLock, tenantClient, type TenantTransaction } from '../../tenancy';

/**
 * Immutable product model versions and the `tenant_products` projection
 * (ADR 0016). Publishing inserts a version and updates the projection in the
 * caller's transaction; a database trigger refuses any UPDATE/DELETE of a
 * version and any DELETE of a projection row.
 */

export interface StoredModelVersion {
  readonly version: number;
  readonly document: unknown;
  readonly contentHash: string;
  readonly effectiveFrom: Date;
  readonly publishedAt: Date;
  readonly publishedBy: string;
}

export interface ProjectionRow {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly family: string | null;
  readonly modelVersion: number | null;
}

@Injectable()
export class ProductModelStore {
  /** Serialises publication per tenant (version numbers are also unique). */
  async lockPublication(tx: TenantTransaction): Promise<void> {
    await tenantAdvisoryLock(tx, 'product-model-publish', tx.tenantId);
  }

  async latest(tx: TenantTransaction): Promise<StoredModelVersion | undefined> {
    const row = await tenantClient(tx).tenantProductModel.findFirst({
      where: { tenantId: tx.tenantId },
      orderBy: { version: 'desc' },
    });
    return row ?? undefined;
  }

  /** The version in force at `asOf`: highest version with effectiveFrom ≤ asOf. */
  async inForceAt(tx: TenantTransaction, asOf: Date): Promise<StoredModelVersion | undefined> {
    const row = await tenantClient(tx).tenantProductModel.findFirst({
      where: { tenantId: tx.tenantId, effectiveFrom: { lte: asOf } },
      orderBy: { version: 'desc' },
    });
    return row ?? undefined;
  }

  async byVersion(tx: TenantTransaction, version: number): Promise<StoredModelVersion | undefined> {
    const row = await tenantClient(tx).tenantProductModel.findUnique({
      where: { tenantId_version: { tenantId: tx.tenantId, version } },
    });
    return row ?? undefined;
  }

  async versions(tx: TenantTransaction): Promise<Omit<StoredModelVersion, 'document'>[]> {
    return tenantClient(tx).tenantProductModel.findMany({
      where: { tenantId: tx.tenantId },
      orderBy: { version: 'asc' },
      select: {
        version: true,
        contentHash: true,
        effectiveFrom: true,
        publishedAt: true,
        publishedBy: true,
      },
    });
  }

  async insertVersion(
    tx: TenantTransaction,
    v: {
      version: number;
      document: ProductModelDocument;
      contentHash: string;
      effectiveFrom: Date;
      publishedBy: string;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantProductModel.create({
      data: {
        tenantId: tx.tenantId,
        version: v.version,
        document: JSON.parse(JSON.stringify(v.document)) as Prisma.InputJsonValue,
        contentHash: v.contentHash,
        effectiveFrom: v.effectiveFrom,
        publishedBy: v.publishedBy,
      },
    });
  }

  async projection(tx: TenantTransaction): Promise<ProjectionRow[]> {
    return tenantClient(tx).tenantProduct.findMany({
      where: { tenantId: tx.tenantId },
      orderBy: { key: 'asc' },
      select: {
        key: true,
        name: true,
        description: true,
        active: true,
        family: true,
        modelVersion: true,
      },
    });
  }

  /** Upsert every product of a published version (never deletes: K4). */
  async upsertProjection(
    tx: TenantTransaction,
    document: ProductModelDocument,
    version: number,
  ): Promise<void> {
    const db = tenantClient(tx);
    for (const p of document.products) {
      const data = {
        name: p.name,
        description: p.description ?? null,
        active: p.status === 'active',
        family: p.family ?? null,
        modelVersion: version,
      };
      await db.tenantProduct.upsert({
        where: { tenantId_key: { tenantId: tx.tenantId, key: p.key } },
        create: { tenantId: tx.tenantId, key: p.key, ...data },
        update: data,
      });
    }
  }
}
