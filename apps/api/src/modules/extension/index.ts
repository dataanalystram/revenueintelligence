/**
 * Extension framework (M10D plan docs/milestones/M10D-extension-framework-plan.md,
 * ADR 0030): typed extension values, custom records and custom relationships
 * behind the 0.4 + module `extension` gate.
 */
export { ExtensionModule } from './extension.module';
export {
  ExtensionValueWriter,
  type ExtensionObservation,
  type ExtensionObserveOutcome,
  type ObservedExtensionValue,
  type OperatorValueInput,
  type OperatorValueResult,
} from './application/extension-value.writer';
export {
  CustomRecordWriter,
  type CustomRecordObservation,
  type CustomRecordObserveOutcome,
  type CustomRecordWritten,
  type ObservedParent,
} from './application/custom-record.writer';
export {
  CustomRelationshipWriter,
  type CustomRelationshipObservation,
  type CustomRelationshipObserveOutcome,
  type CustomRelationshipWritten,
  type ObservedEndpoint,
} from './application/custom-relationship.writer';
export {
  ExtensionMergeParticipant,
  type EntityMerge,
} from './application/extension-merge.participant';
export {
  ExtensionReadModel,
  ExtensionUseGuard,
  type CustomRecordDetail,
  type CustomRecordView,
  type ExtensionValueView,
} from './application/extension.read-model';
export { type ExtensionProvenance } from './application/extension-shared';
