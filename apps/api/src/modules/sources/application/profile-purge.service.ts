import { Injectable } from '@nestjs/common';
import type { TenantContext } from '../../tenancy';
import { SourcesError } from '../errors';
import {
  ProfilePurgeStore,
  PurgeRefusedError,
  type PurgeResult,
} from '../infrastructure/profile-purge.store';

/**
 * Privileged profile retention (M9A §2.4, D3: keep the last N per connection,
 * object and family). The caller passes the schema owner's database URL; the
 * app role is refused. Never part of a request path: CLI only.
 */
@Injectable()
export class ProfilePurgeService {
  constructor(private readonly store: ProfilePurgeStore) {}

  async purge(
    ctx: TenantContext,
    connectionId: string,
    object: string,
    options: {
      keep: number;
      actor: string;
      execute: boolean;
      ownerDatabaseUrl: string | undefined;
    },
  ): Promise<PurgeResult> {
    if (!options.ownerDatabaseUrl) {
      throw new SourcesError(
        'purge_requires_owner_credentials',
        'Set MIGRATION_DATABASE_URL (schema owner) to purge profiles',
      );
    }
    try {
      return await this.store.purge({
        ownerDatabaseUrl: options.ownerDatabaseUrl,
        tenantId: ctx.tenantId,
        connectionId,
        object,
        keep: options.keep,
        actor: options.actor,
        execute: options.execute,
      });
    } catch (err) {
      if (err instanceof PurgeRefusedError) throw new SourcesError(err.code, err.message);
      throw err;
    }
  }
}
