/**
 * Governance (M10A2, ADR 0027): canonical adoption, module enablement and the
 * module gate, governed registries (data policy) and integrity verification.
 * Write-path helpers used by every canonical writer (adopted version, change
 * governance columns, value history, data policy) live in the tenancy module.
 */
export {
  CanonicalAdoptionService,
  type AdoptionImpact,
  type AdoptionResult,
} from './application/canonical-adoption.service';
export {
  EVIDENCE_RELATION_CATALOGUE,
  EvidenceLinkWriter,
  type EvidenceLinkSetWritten,
} from './application/evidence-link.writer';
export {
  IntegrityVerificationService,
  type IntegrityReport,
} from './application/integrity-verification.service';
export {
  ModuleConfigSchema,
  ModuleGate,
  ModuleSettingsService,
  type ModuleChangeInput,
  type ModuleState,
} from './application/module-settings.service';
export {
  RegistryService,
  type RegistryDryRun,
  type RegistryPublished,
  type RegistryPublishInput,
} from './application/registry.service';
export {
  ProvenanceQueryService,
  type ProvenanceField,
  type ProvenanceLinkSet,
  type ProvenanceQuery,
  type ProvenanceReference,
  type ProvenanceReport,
} from './application/provenance-query.service';
export {
  GENERIC_REFERENCES_MIN_VERSION,
  SourceReferenceService,
  type DeclaredProductModel,
  type DeclaredReferenceTransitions,
  type ReferenceMergeInput,
  type ReferenceObservationInput,
  type ReferenceObservationResult,
  type ReferenceWriteMeta,
  type RetireAbsentReferencesInput,
  type SourceTriple,
} from './application/source-reference.service';
export * from './errors';
export { GovernanceModule } from './governance.module';
