import { Module } from '@nestjs/common';
import { PrismaCompanyRepository } from './infrastructure/prisma-company.repository';
import { PrismaPersonRepository } from './infrastructure/prisma-person.repository';
import { COMPANY_REPOSITORY, PERSON_REPOSITORY } from './repositories';

/** Canonical people and organisations. Identity resolution logic arrives in M11. */
@Module({
  providers: [
    { provide: PERSON_REPOSITORY, useClass: PrismaPersonRepository },
    { provide: COMPANY_REPOSITORY, useClass: PrismaCompanyRepository },
  ],
  exports: [PERSON_REPOSITORY, COMPANY_REPOSITORY],
})
export class IdentityModule {}
