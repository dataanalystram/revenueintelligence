import { Injectable } from '@nestjs/common';
import { CompanySchema, type Company, type CompanyId, type ExternalRef } from '../../domain';
import {
  RecordNotFoundError,
  TenantMismatchError,
  tenantClient,
  translateDatabaseError,
  type TenantTransaction,
} from '../../tenancy';
import type { CompanyRepository } from '../repositories';

const include = { externalRefs: true } as const;

interface CompanyRow {
  id: string;
  tenantId: string;
  name: string | null;
  domains: string[];
  customerStatus: string;
  recordState: string;
  mergedIntoId: string | null;
  createdAt: Date;
  updatedAt: Date;
  externalRefs: { system: string; objectType: string; externalId: string }[];
}

function toCompany(row: CompanyRow): Company {
  return CompanySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name ?? undefined,
    domains: row.domains,
    customerStatus: row.customerStatus,
    recordState: row.recordState,
    mergedIntoId: row.mergedIntoId ?? undefined,
    externalRefs: [...row.externalRefs]
      .sort((a, b) =>
        `${a.system}${a.objectType}${a.externalId}`.localeCompare(
          `${b.system}${b.objectType}${b.externalId}`,
        ),
      )
      .map((r) => ({ system: r.system, objectType: r.objectType, id: r.externalId })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

@Injectable()
export class PrismaCompanyRepository implements CompanyRepository {
  async findById(tx: TenantTransaction, id: CompanyId): Promise<Company | undefined> {
    const row = await tenantClient(tx).company.findFirst({
      where: { tenantId: tx.tenantId, id },
      include,
    });
    return row ? toCompany(row) : undefined;
  }

  async findByExternalRef(tx: TenantTransaction, ref: ExternalRef): Promise<Company | undefined> {
    const link = await tenantClient(tx).companyExternalRef.findFirst({
      where: {
        tenantId: tx.tenantId,
        system: ref.system,
        objectType: ref.objectType,
        externalId: ref.id,
      },
    });
    return link ? this.findById(tx, link.companyId as CompanyId) : undefined;
  }

  async save(tx: TenantTransaction, company: Company): Promise<Company> {
    if (company.tenantId !== tx.tenantId) throw new TenantMismatchError('company');
    const db = tenantClient(tx);
    const data = {
      name: company.name ?? null,
      domains: [...company.domains],
      customerStatus: company.customerStatus,
      recordState: company.recordState,
      mergedIntoId: company.mergedIntoId ?? null,
      createdAt: company.createdAt,
      updatedAt: company.updatedAt,
    };
    try {
      const existing = await db.company.findFirst({
        where: { tenantId: tx.tenantId, id: company.id },
        select: { id: true },
      });
      if (existing) {
        await db.company.update({
          where: { tenantId_id: { tenantId: tx.tenantId, id: company.id } },
          data,
        });
        // References keep their source state (ADR 0014): remove only those no
        // longer listed; listed ones are inserted below if missing.
        await db.companyExternalRef.deleteMany({
          where: {
            tenantId: tx.tenantId,
            companyId: company.id,
            NOT: company.externalRefs.map((r) => ({
              system: r.system,
              objectType: r.objectType,
              externalId: r.id,
            })),
          },
        });
      } else {
        await db.company.create({ data: { id: company.id, tenantId: tx.tenantId, ...data } });
      }
      if (company.externalRefs.length > 0) {
        // Insert only references this record does not hold yet: a reference owned
        // by another record still fails (one external id → one record).
        const held = await db.companyExternalRef.findMany({
          where: { tenantId: tx.tenantId, companyId: company.id },
          select: { system: true, objectType: true, externalId: true },
        });
        const heldKeys = new Set(held.map((r) => `${r.system}:${r.objectType}:${r.externalId}`));
        await db.companyExternalRef.createMany({
          data: company.externalRefs
            .filter((r) => !heldKeys.has(`${r.system}:${r.objectType}:${r.id}`))
            .map((r) => ({
              tenantId: tx.tenantId,
              companyId: company.id,
              system: r.system,
              objectType: r.objectType,
              externalId: r.id,
            })),
        });
      }
    } catch (error) {
      translateDatabaseError(error, 'company');
    }
    return (await this.findById(tx, company.id))!;
  }

  /** Refused (InvalidReferenceError) while people still belong to the company. */
  async delete(tx: TenantTransaction, id: CompanyId): Promise<void> {
    let count: number;
    try {
      ({ count } = await tenantClient(tx).company.deleteMany({
        where: { tenantId: tx.tenantId, id },
      }));
    } catch (error) {
      translateDatabaseError(error, 'company');
    }
    if (count === 0) throw new RecordNotFoundError('company', id);
  }
}
