import { Injectable } from '@nestjs/common';
import {
  assertAuthorized,
  AuditTrail,
  AuthorizedContext,
  TenantDatabase,
  type TenantContext,
} from '../../tenancy';
import { SourcesError } from '../errors';
import {
  ProfilePurgeStore,
  PurgeRefusedError,
  type PurgeResult,
} from '../infrastructure/profile-purge.store';

/**
 * Privileged profile retention (M9A §2.4, D3: keep the last N per connection,
 * object and family). The caller passes the schema owner's database URL; the
 * app role is refused. Never part of a request path: CLI only. Executing needs
 * an operator authorized for `data.purge` and is audited (M10A1); a dry run
 * needs only a tenant context.
 */
@Injectable()
export class ProfilePurgeService {
  constructor(
    private readonly store: ProfilePurgeStore,
    private readonly db: TenantDatabase,
    private readonly audit: AuditTrail,
  ) {}

  async purge(
    target: TenantContext | AuthorizedContext<'data.purge'>,
    connectionId: string,
    object: string,
    options: {
      keep: number;
      execute: boolean;
      ownerDatabaseUrl: string | undefined;
    },
  ): Promise<PurgeResult> {
    if (options.execute) assertAuthorized(target, 'data.purge');
    const actx = target instanceof AuthorizedContext ? target : undefined;
    const ctx = actx ? actx.tenant : (target as TenantContext);
    if (!options.ownerDatabaseUrl) {
      throw new SourcesError(
        'purge_requires_owner_credentials',
        'Set MIGRATION_DATABASE_URL (schema owner) to purge profiles',
      );
    }
    let result: PurgeResult;
    try {
      result = await this.store.purge({
        ownerDatabaseUrl: options.ownerDatabaseUrl,
        tenantId: ctx.tenantId,
        connectionId,
        object,
        keep: options.keep,
        actor: actx?.actor.id ?? 'dry_run',
        execute: options.execute,
      });
    } catch (err) {
      if (err instanceof PurgeRefusedError) throw new SourcesError(err.code, err.message);
      throw err;
    }
    if (options.execute && actx) {
      await this.db.transaction(ctx, (tx) =>
        this.audit.record(
          tx,
          actx,
          {
            action: 'profile.purge',
            targetKind: 'source_connection',
            targetRef: connectionId,
            details: { object, keep: options.keep },
          },
          'completed',
        ),
      );
    }
    return result;
  }
}
