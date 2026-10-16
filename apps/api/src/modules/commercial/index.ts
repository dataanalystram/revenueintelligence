/**
 * Commercial (Milestone 10F, ADR 0032, canonical 0.6, module `commercial`):
 * Price/Offer, Contract (with its renews / amends / parent links),
 * Entitlement and the line commercial references. Never read by ownership,
 * eligibility, whitespace or coverage (plan §1.1, §13).
 */
export { CommercialModule } from './commercial.module';
export type { CommercialProvenance } from './application/commercial.shared';
export {
  PriceOfferWriter,
  type OperatorPriceOfferWrite,
  type PriceOfferObservation,
  type PriceOfferObserveOutcome,
  type PriceOfferRejection,
  type PriceOfferWritten,
} from './application/price-offer.writer';
export {
  ContractWriter,
  type ContractObservation,
  type ContractObserveOutcome,
  type ContractRejection,
  type ContractWritten,
  type OperatorContractLink,
  type OperatorContractWrite,
} from './application/contract.writer';
export {
  EntitlementWriter,
  type EntitlementObservation,
  type EntitlementObserveOutcome,
  type EntitlementRejection,
  type OperatorEntitlementWrite,
} from './application/entitlement.writer';
export {
  CommercialLineReferenceStep,
  LINE_REFERENCE_ATTRIBUTES,
  agreementValid,
  type AgreementRef,
  type LineReferenceObservation,
  type LineReferenceOutcome,
  type OperatorLineReference,
  type ReferenceOutcome,
} from './application/commercial-line-reference.step';
export {
  CommercialMergeParticipant,
  type CommercialEntityMerge,
} from './application/commercial-merge.participant';
export {
  CommercialSourceSync,
  type ContractSourceOutcome,
  type ContractSourceRecord,
  type EntitlementSourceRecord,
  type WaitingLineResolution,
} from './application/commercial-source.sync';
export type { SourceRef } from './infrastructure/commercial.store';
