import { Module } from '@nestjs/common';
import { GovernanceModule } from '../governance';
import { TenancyModule } from '../tenancy';
import {
  AccountHierarchyMergeParticipant,
  AccountHierarchyWriter,
} from './application/account-hierarchy.writer';
import { AccountStructureReadModel } from './application/account-structure.read-model';
import {
  AffiliationCompanyMergeParticipant,
  AffiliationPersonMergeParticipant,
  PersonAffiliationWriter,
} from './application/person-affiliation.writer';
import { AccountStructureStore } from './infrastructure/account-structure.store';

/**
 * Account hierarchy and Person–Account affiliation (M10C, ADR 0029): the two
 * single writers, their merge participants and the read models. Imported by
 * `ContextModule` (ingestion and merges) and by the operator CLI on its own.
 * Not a business module (M10A2 plan §4: core is not a module).
 */
@Module({
  imports: [TenancyModule, GovernanceModule],
  providers: [
    AccountStructureStore,
    AccountHierarchyWriter,
    PersonAffiliationWriter,
    AccountHierarchyMergeParticipant,
    AffiliationCompanyMergeParticipant,
    AffiliationPersonMergeParticipant,
    AccountStructureReadModel,
  ],
  exports: [
    AccountHierarchyWriter,
    PersonAffiliationWriter,
    AccountHierarchyMergeParticipant,
    AffiliationCompanyMergeParticipant,
    AffiliationPersonMergeParticipant,
    AccountStructureReadModel,
  ],
})
export class AccountStructureModule {}
