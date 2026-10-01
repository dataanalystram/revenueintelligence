import { Injectable } from '@nestjs/common';
import {
  PersonSchema,
  type EmailAddress,
  type ExternalRef,
  type Person,
  type PersonId,
} from '../../domain';
import {
  RecordNotFoundError,
  TenantMismatchError,
  tenantClient,
  translateDatabaseError,
  type TenantTransaction,
} from '../../tenancy';
import type { PersonRepository } from '../repositories';

const include = { externalRefs: true } as const;

interface PersonRow {
  id: string;
  tenantId: string;
  primaryEmail: string | null;
  additionalEmails: string[];
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  companyId: string | null;
  roles: string[];
  recordState: string;
  mergedIntoId: string | null;
  createdAt: Date;
  updatedAt: Date;
  externalRefs: { system: string; objectType: string; externalId: string }[];
}

function toPerson(row: PersonRow): Person {
  return PersonSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    primaryEmail: row.primaryEmail ?? undefined,
    additionalEmails: row.additionalEmails,
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined,
    jobTitle: row.jobTitle ?? undefined,
    companyId: row.companyId ?? undefined,
    roles: row.roles,
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
export class PrismaPersonRepository implements PersonRepository {
  async findById(tx: TenantTransaction, id: PersonId): Promise<Person | undefined> {
    const row = await tenantClient(tx).person.findFirst({
      where: { tenantId: tx.tenantId, id },
      include,
    });
    return row ? toPerson(row) : undefined;
  }

  /** Email is not identity (ADR 0014): several people may share one. */
  async listByEmail(tx: TenantTransaction, email: EmailAddress): Promise<Person[]> {
    const rows = await tenantClient(tx).person.findMany({
      where: { tenantId: tx.tenantId, primaryEmail: email },
      include,
      orderBy: { id: 'asc' },
    });
    return rows.map(toPerson);
  }

  async findByExternalRef(tx: TenantTransaction, ref: ExternalRef): Promise<Person | undefined> {
    const link = await tenantClient(tx).personExternalRef.findFirst({
      where: {
        tenantId: tx.tenantId,
        system: ref.system,
        objectType: ref.objectType,
        externalId: ref.id,
      },
    });
    return link ? this.findById(tx, link.personId as PersonId) : undefined;
  }

  async save(tx: TenantTransaction, person: Person): Promise<Person> {
    if (person.tenantId !== tx.tenantId) throw new TenantMismatchError('person');
    const db = tenantClient(tx);
    const data = {
      primaryEmail: person.primaryEmail ?? null,
      additionalEmails: [...person.additionalEmails],
      firstName: person.firstName ?? null,
      lastName: person.lastName ?? null,
      jobTitle: person.jobTitle ?? null,
      companyId: person.companyId ?? null,
      roles: [...person.roles],
      recordState: person.recordState,
      mergedIntoId: person.mergedIntoId ?? null,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    };
    try {
      const existing = await db.person.findFirst({
        where: { tenantId: tx.tenantId, id: person.id },
        select: { id: true },
      });
      if (existing) {
        await db.person.update({
          where: { tenantId_id: { tenantId: tx.tenantId, id: person.id } },
          data,
        });
        await db.personExternalRef.deleteMany({
          where: {
            tenantId: tx.tenantId,
            personId: person.id,
            NOT: person.externalRefs.map((r) => ({
              system: r.system,
              objectType: r.objectType,
              externalId: r.id,
            })),
          },
        });
      } else {
        await db.person.create({ data: { id: person.id, tenantId: tx.tenantId, ...data } });
      }
      if (person.externalRefs.length > 0) {
        // Insert only references this record does not hold yet: a reference owned
        // by another record still fails (one external id → one record).
        const held = await db.personExternalRef.findMany({
          where: { tenantId: tx.tenantId, personId: person.id },
          select: { system: true, objectType: true, externalId: true },
        });
        const heldKeys = new Set(held.map((r) => `${r.system}:${r.objectType}:${r.externalId}`));
        await db.personExternalRef.createMany({
          data: person.externalRefs
            .filter((r) => !heldKeys.has(`${r.system}:${r.objectType}:${r.id}`))
            .map((r) => ({
              tenantId: tx.tenantId,
              personId: person.id,
              system: r.system,
              objectType: r.objectType,
              externalId: r.id,
            })),
        });
      }
    } catch (error) {
      translateDatabaseError(error, 'person');
    }
    return (await this.findById(tx, person.id))!;
  }

  async delete(tx: TenantTransaction, id: PersonId): Promise<void> {
    const { count } = await tenantClient(tx).person.deleteMany({
      where: { tenantId: tx.tenantId, id },
    });
    if (count === 0) throw new RecordNotFoundError('person', id);
  }
}
