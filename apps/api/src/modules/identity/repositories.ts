import type { Company, CompanyId, EmailAddress, ExternalRef, Person, PersonId } from '../domain';
import type { TenantTransaction } from '../tenancy';

/**
 * Persistence for canonical people. Every method needs an open
 * TenantTransaction, so it can only ever see the transaction's tenant.
 */
export interface PersonRepository {
  findById(tx: TenantTransaction, id: PersonId): Promise<Person | undefined>;
  /** Email is not identity (ADR 0014): several people may share one address. */
  listByEmail(tx: TenantTransaction, email: EmailAddress): Promise<Person[]>;
  findByExternalRef(tx: TenantTransaction, ref: ExternalRef): Promise<Person | undefined>;
  /** Inserts or replaces the person (including external refs). */
  save(tx: TenantTransaction, person: Person): Promise<Person>;
  /** Deletes the person; throws RecordNotFoundError if it is not in this tenant. */
  delete(tx: TenantTransaction, id: PersonId): Promise<void>;
}

/** Persistence for canonical companies, their product ownership and external refs. */
export interface CompanyRepository {
  findById(tx: TenantTransaction, id: CompanyId): Promise<Company | undefined>;
  findByExternalRef(tx: TenantTransaction, ref: ExternalRef): Promise<Company | undefined>;
  save(tx: TenantTransaction, company: Company): Promise<Company>;
  delete(tx: TenantTransaction, id: CompanyId): Promise<void>;
}

export const PERSON_REPOSITORY = Symbol('PERSON_REPOSITORY');
export const COMPANY_REPOSITORY = Symbol('COMPANY_REPOSITORY');
