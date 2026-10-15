import { Module } from '@nestjs/common';
import { GovernanceModule } from '../governance';
import { TenancyModule } from '../tenancy';
import { CustomRecordWriter } from './application/custom-record.writer';
import { CustomRelationshipWriter } from './application/custom-relationship.writer';
import { ExtensionMergeParticipant } from './application/extension-merge.participant';
import { ExtensionValueWriter } from './application/extension-value.writer';
import { ExtensionReadModel, ExtensionUseGuard } from './application/extension.read-model';
import { ExtensionStore } from './infrastructure/extension.store';

/**
 * Extension framework (M10D, ADR 0030, canonical 0.4, module `extension`):
 * the three single writers (values, custom records, custom relationships),
 * the merge participant, the use guard and the read models. Imported by the
 * context module (merge participant), the sources module (source sync) and
 * the operator CLI. Depends on domain, tenancy and governance only; products
 * and identity never import it (dependency rule, Q21).
 */
@Module({
  imports: [TenancyModule, GovernanceModule],
  providers: [
    ExtensionStore,
    ExtensionValueWriter,
    CustomRecordWriter,
    CustomRelationshipWriter,
    ExtensionMergeParticipant,
    ExtensionUseGuard,
    ExtensionReadModel,
  ],
  exports: [
    ExtensionValueWriter,
    CustomRecordWriter,
    CustomRelationshipWriter,
    ExtensionMergeParticipant,
    ExtensionUseGuard,
    ExtensionReadModel,
  ],
})
export class ExtensionModule {}
