import { Module } from '@nestjs/common';
import { GovernanceModule } from '../governance';
import { TenancyModule } from '../tenancy';
import { CommercialLineReferenceStep } from './application/commercial-line-reference.step';
import { CommercialMergeParticipant } from './application/commercial-merge.participant';
import { CommercialSourceSync } from './application/commercial-source.sync';
import { ContractWriter } from './application/contract.writer';
import { EntitlementWriter } from './application/entitlement.writer';
import { PriceOfferWriter } from './application/price-offer.writer';
import { CommercialStore } from './infrastructure/commercial.store';

/**
 * Commercial (M10F, ADR 0032, canonical 0.6, module `commercial`): the single
 * writers of price offers, contracts (with their links) and entitlements, the
 * line commercial-reference step and the company merge participant. Imported
 * by the context module (merge participant) and by the sources module
 * (`CommercialSourceSync`, phase 2b). Depends on domain, tenancy and governance
 * only; products (ownership, eligibility, whitespace, coverage) never import
 * it (plan §13; the dependency-cruiser rule arrives with phase 2b).
 */
@Module({
  imports: [TenancyModule, GovernanceModule],
  providers: [
    CommercialStore,
    PriceOfferWriter,
    ContractWriter,
    EntitlementWriter,
    CommercialLineReferenceStep,
    CommercialMergeParticipant,
    CommercialSourceSync,
  ],
  exports: [
    PriceOfferWriter,
    ContractWriter,
    EntitlementWriter,
    CommercialLineReferenceStep,
    CommercialMergeParticipant,
    CommercialSourceSync,
  ],
})
export class CommercialModule {}
