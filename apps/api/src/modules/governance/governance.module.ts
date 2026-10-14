import { Module } from '@nestjs/common';
import { EVIDENCE_RELATIONS } from '../domain';
import { TenancyModule } from '../tenancy';
import { CanonicalAdoptionService } from './application/canonical-adoption.service';
import { EVIDENCE_RELATION_CATALOGUE, EvidenceLinkWriter } from './application/evidence-link.writer';
import { IntegrityVerificationService } from './application/integrity-verification.service';
import { ModuleGate, ModuleSettingsService } from './application/module-settings.service';
import { RegistryService } from './application/registry.service';
import { SourceReferenceService } from './application/source-reference.service';

/**
 * Canonical governance (M10A2, ADR 0027): canonical adoption, module
 * enablement, governed registries (data policy) and integrity verification;
 * M10B (ADR 0028): the generic source-reference writer.
 */
@Module({
  imports: [TenancyModule],
  providers: [
    CanonicalAdoptionService,
    ModuleSettingsService,
    ModuleGate,
    RegistryService,
    IntegrityVerificationService,
    SourceReferenceService,
    { provide: EVIDENCE_RELATION_CATALOGUE, useValue: EVIDENCE_RELATIONS },
    EvidenceLinkWriter,
  ],
  exports: [
    CanonicalAdoptionService,
    ModuleSettingsService,
    ModuleGate,
    RegistryService,
    IntegrityVerificationService,
    SourceReferenceService,
    EvidenceLinkWriter,
  ],
})
export class GovernanceModule {}
