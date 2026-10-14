import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy';
import { CanonicalAdoptionService } from './application/canonical-adoption.service';
import { IntegrityVerificationService } from './application/integrity-verification.service';
import { ModuleGate, ModuleSettingsService } from './application/module-settings.service';
import { RegistryService } from './application/registry.service';

/**
 * Canonical governance (M10A2, ADR 0027): canonical adoption, module
 * enablement, governed registries (data policy) and integrity verification.
 */
@Module({
  imports: [TenancyModule],
  providers: [
    CanonicalAdoptionService,
    ModuleSettingsService,
    ModuleGate,
    RegistryService,
    IntegrityVerificationService,
  ],
  exports: [
    CanonicalAdoptionService,
    ModuleSettingsService,
    ModuleGate,
    RegistryService,
    IntegrityVerificationService,
  ],
})
export class GovernanceModule {}
