import { Module } from '@nestjs/common';
import { GovernanceModule } from '../governance';
import { TenancyModule } from '../tenancy';
import { AccountContextMembershipWriter } from './application/account-context-membership.writer';
import { AccountContextMergeParticipant } from './application/account-context-merge.participant';
import { AccountContextReadModel } from './application/account-context.read-model';
import { AccountContextWriter } from './application/account-context.writer';
import { AccountContextStore } from './infrastructure/account-context.store';

/**
 * AccountContext (M10E, ADR 0031, canonical 0.5, module `account_context`):
 * the context writer (contexts and the line's context), the membership
 * writer, the merge participant and the read model. Imported by
 * `ContextModule` (merges) and, in phase 2b, by the sources module and the
 * operator CLI. Depends on domain, tenancy and governance only; never on
 * products (dependency rule `context-never-depends-on-products`).
 */
@Module({
  imports: [TenancyModule, GovernanceModule],
  providers: [
    AccountContextStore,
    AccountContextWriter,
    AccountContextMembershipWriter,
    AccountContextMergeParticipant,
    AccountContextReadModel,
  ],
  exports: [
    AccountContextWriter,
    AccountContextMembershipWriter,
    AccountContextMergeParticipant,
    AccountContextReadModel,
  ],
})
export class AccountContextModule {}
