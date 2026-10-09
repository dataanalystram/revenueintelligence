import { Injectable } from '@nestjs/common';
import { TokenCipherSource, type TokenCipher } from '../../../platform/crypto';
import type { TenantContext } from '../tenant-context';
import type { OAuthGrant, OAuthSystem, TenantOAuthGrantStore } from '../oauth/oauth-grants';
import { translateDatabaseError } from './prisma-errors';
import { TenantDatabase, tenantClient, type TenantTransaction } from './tenant-database';

/**
 * Timing budget of the locked refresh (ADR 0010). The transaction timeout runs
 * from when the transaction opens, so it must cover the worst case of a
 * waiter: the whole lock wait, then one HTTP call (its timeout is at most
 * 20 s, HUBSPOT_OAUTH_TIMEOUT_MS), then the save. Otherwise HubSpot could issue
 * new tokens after the transaction was already rolled back, and a rotated
 * refresh token would be lost. A unit test enforces
 * LOCK_WAIT + max HTTP timeout + margin <= LOCKED_TRANSACTION.
 */
export const OAUTH_GRANT_LOCK_WAIT_MS = 20_000;
export const OAUTH_GRANT_SAVE_MARGIN_MS = 10_000;
export const OAUTH_GRANT_LOCKED_TRANSACTION_MS = 50_000;

type Column = 'refresh_token' | 'access_token';

/**
 * TenantOAuthGrantStore on PostgreSQL (ADR 0010). Tokens are encrypted with
 * AES-256-GCM before they reach the database; the associated data binds each
 * ciphertext to its tenant, system and column, so a row copied between tenants
 * cannot be decrypted. Rows are reachable only through
 * TenantDatabase.transaction (forced RLS).
 */
@Injectable()
export class EncryptedDatabaseOAuthGrantStore implements TenantOAuthGrantStore {
  constructor(
    private readonly db: TenantDatabase,
    private readonly ciphers: TokenCipherSource,
  ) {}

  async get(ctx: TenantContext, system: OAuthSystem): Promise<OAuthGrant | undefined> {
    const cipher = await this.ciphers.get();
    return await this.db.transaction(ctx, (tx) => this.read(tx, cipher, system));
  }

  async put(
    ctx: TenantContext,
    system: OAuthSystem,
    grant: OAuthGrant,
    afterWrite?: (tx: TenantTransaction) => Promise<void>,
  ): Promise<void> {
    const cipher = await this.ciphers.get();
    await this.db.transaction(ctx, async (tx) => {
      await this.write(tx, cipher, system, grant);
      await afterWrite?.(tx);
    });
  }

  async delete(ctx: TenantContext, system: OAuthSystem): Promise<boolean> {
    return await this.db.transaction(ctx, async (tx) => {
      const { count } = await tenantClient(tx).tenantOAuthToken.deleteMany({
        where: { tenantId: tx.tenantId, system },
      });
      return count > 0;
    });
  }

  async withLockedGrant<T>(
    ctx: TenantContext,
    system: OAuthSystem,
    work: (current: OAuthGrant | undefined) => Promise<{ save?: OAuthGrant; result: T }>,
    afterSave?: (tx: TenantTransaction) => Promise<void>,
  ): Promise<T> {
    const cipher = await this.ciphers.get();
    return await this.db.transaction(
      ctx,
      async (tx) => {
        const client = tenantClient(tx);
        await client.$queryRaw`SELECT set_config('lock_timeout', ${`${OAUTH_GRANT_LOCK_WAIT_MS}ms`}, true)`;
        try {
          // Transaction-scoped: released on commit or rollback, in every process.
          await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth-grant:${system}:${tx.tenantId}`}, 0))`;
        } catch (error) {
          translateDatabaseError(error, 'OAuth token refresh');
        }
        // Read after the lock: a previous holder's committed refresh is visible.
        const current = await this.read(tx, cipher, system);
        const { save, result } = await work(current);
        if (save) {
          await this.write(tx, cipher, system, save);
          await afterSave?.(tx);
        }
        return result;
      },
      { timeoutMs: OAUTH_GRANT_LOCKED_TRANSACTION_MS },
    );
  }

  private async read(
    tx: TenantTransaction,
    cipher: TokenCipher,
    system: OAuthSystem,
  ): Promise<OAuthGrant | undefined> {
    const row = await tenantClient(tx).tenantOAuthToken.findUnique({
      where: { tenantId_system: { tenantId: tx.tenantId, system } },
    });
    if (!row) return undefined;
    return {
      accountId: row.accountId,
      refreshToken: cipher.decrypt(row.refreshTokenEnc, aad(tx, system, 'refresh_token')),
      accessToken:
        row.accessTokenEnc && row.accessTokenExpiresAt
          ? {
              token: cipher.decrypt(row.accessTokenEnc, aad(tx, system, 'access_token')),
              expiresAt: row.accessTokenExpiresAt,
            }
          : undefined,
      scopes: row.scopes,
    };
  }

  private async write(
    tx: TenantTransaction,
    cipher: TokenCipher,
    system: OAuthSystem,
    grant: OAuthGrant,
  ): Promise<void> {
    const data = {
      accountId: grant.accountId,
      refreshTokenEnc: cipher.encrypt(grant.refreshToken, aad(tx, system, 'refresh_token')),
      accessTokenEnc: grant.accessToken
        ? cipher.encrypt(grant.accessToken.token, aad(tx, system, 'access_token'))
        : null,
      accessTokenExpiresAt: grant.accessToken?.expiresAt ?? null,
      scopes: [...grant.scopes],
    };
    try {
      await tenantClient(tx).tenantOAuthToken.upsert({
        where: { tenantId_system: { tenantId: tx.tenantId, system } },
        create: { tenantId: tx.tenantId, system, ...data },
        update: data,
      });
    } catch (error) {
      sanitised(error);
    }
  }
}

/**
 * Known database errors become tenancy errors; anything else is replaced by an
 * error carrying only the database error code, because PostgreSQL details
 * ("Failing row contains …") would echo the row being written.
 */
function sanitised(error: unknown): never {
  try {
    translateDatabaseError(error, 'OAuth grant');
  } catch (translated) {
    if (translated !== error) throw translated;
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
  throw new Error(`The OAuth grant could not be stored (database error ${code})`);
}

/** Associated data: where the ciphertext lives. Copying it anywhere else breaks decryption. */
function aad(tx: TenantTransaction, system: OAuthSystem, column: Column): string {
  return `tenant_oauth_tokens|${tx.tenantId}|${system}|${column}`;
}
