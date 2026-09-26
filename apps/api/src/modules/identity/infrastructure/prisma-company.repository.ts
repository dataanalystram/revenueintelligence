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

const include = { externalRefs: true, products: true } as const;

interface CompanyRow {
  id: string;
  tenantId: string;
  name: string;
  domains: string[];
  customerStatus: string;
  createdAt: Date;
  updatedAt: Date;
  externalRefs: { system: string; objectType: string; externalId: string }[];
  products: { productKey: string; status: string; since: Date | null; until: Date | null }[];
}

function toCompany(row: CompanyRow): Company {
  return CompanySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    domains: row.domains,
    customerStatus: row.customerStatus,
    products: [...row.products]
      .sort((a, b) => a.productKey.localeCompare(b.productKey))
      .map((p) => ({
        productKey: p.productKey,
        status: p.status,
        since: p.since ?? undefined,
        until: p.until ?? undefined,
      })),
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
      name: company.name,
      domains: [...company.domains],
      customerStatus: company.customerStatus,
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
        await db.companyExternalRef.deleteMany({
          where: { tenantId: tx.tenantId, companyId: company.id },
        });
        await db.companyProduct.deleteMany({
          where: { tenantId: tx.tenantId, companyId: company.id },
        });
      } else {
        await db.company.create({ data: { id: company.id, tenantId: tx.tenantId, ...data } });
      }
      if (company.externalRefs.length > 0) {
        await db.companyExternalRef.createMany({
          data: company.externalRefs.map((r) => ({
            tenantId: tx.tenantId,
            companyId: company.id,
            system: r.system,
            objectType: r.objectType,
            externalId: r.id,
          })),
        });
      }
      if (company.products.length > 0) {
        await db.companyProduct.createMany({
          data: company.products.map((p) => ({
            tenantId: tx.tenantId,
            companyId: company.id,
            productKey: p.productKey,
            status: p.status,
            since: p.since ?? null,
            until: p.until ?? null,
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
