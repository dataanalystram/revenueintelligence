import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TokenCipherSource } from '../../../platform/crypto';
import { TenantIdSchema } from '../../domain';
import { TenantContextService } from '../application/tenant-context.service';
import { InvalidTenantContextError, TenantNotFoundError } from '../errors';
import { TenantDatabase, tenantClient } from '../infrastructure/tenant-database';
import type { TenantContext } from '../tenant-context';
import { OAUTH_SYSTEMS, type OAuthSystem } from './oauth-grants';

/** How long an install link stays valid. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export type OAuthStateFailure =
  'malformed' | 'bad_signature' | 'wrong_system' | 'expired' | 'unknown_or_used';

/** The OAuth `state` is not one we issued, is expired, or was already redeemed. */
export class OAuthStateError extends Error {
  constructor(readonly reason: OAuthStateFailure) {
    super('The OAuth state is invalid, expired or already used');
    this.name = 'OAuthStateError';
  }
}

const PayloadSchema = z.strictObject({
  v: z.literal(1),
  t: TenantIdSchema,
  s: z.enum(OAUTH_SYSTEMS),
  n: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  e: z.number().int().positive(),
});

/**
 * OAuth install `state` (ADR 0010): a signed, tenant-bound, short-lived,
 * single-use value that ties the callback to the install we started.
 *
 * - Signed (HMAC-SHA256, key derived from PLATFORM_TOKEN_ENCRYPTION_KEY), so
 *   it cannot be forged or altered, and the callback learns the tenant from it.
 * - Persisted as a hash of its random nonce in the tenant's
 *   `tenant_oauth_states` (forced RLS).
 * - Redeemed by one atomic `DELETE … RETURNING` that also checks expiry, so it
 *   works exactly once across restarts, API instances and concurrent callbacks:
 *   PostgreSQL lets only one transaction delete the row.
 */
@Injectable()
export class OAuthStateService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly contexts: TenantContextService,
    private readonly ciphers: TokenCipherSource,
  ) {}

  async issue(
    ctx: TenantContext,
    system: OAuthSystem,
    now: Date = new Date(),
  ): Promise<{ state: string; expiresAt: Date }> {
    const cipher = await this.ciphers.get();
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);
    await this.db.transaction(ctx, async (tx) => {
      const client = tenantClient(tx);
      // Housekeeping: this tenant's expired, never-redeemed states.
      await client.tenantOAuthState.deleteMany({
        where: { tenantId: tx.tenantId, expiresAt: { lte: now } },
      });
      await client.tenantOAuthState.create({
        data: {
          tenantId: tx.tenantId,
          nonceHash: hashNonce(nonce),
          system,
          expiresAt,
          createdAt: now,
        },
      });
    });
    const payload = Buffer.from(
      JSON.stringify({ v: 1, t: ctx.tenantId, s: system, n: nonce, e: expiresAt.getTime() }),
    ).toString('base64url');
    return { state: `${payload}.${cipher.sign(payload)}`, expiresAt };
  }

  /**
   * Verifies and consumes a state; returns the tenant it was issued for.
   * Throws OAuthStateError for anything but the first redemption of a valid,
   * unexpired state issued by us for `system`.
   */
  async redeem(state: string, system: OAuthSystem, now: Date = new Date()): Promise<TenantContext> {
    const cipher = await this.ciphers.get();
    const parts = state.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1] || state.length > 1024) {
      throw new OAuthStateError('malformed');
    }
    const [payload, signature] = parts as [string, string];
    if (!cipher.verify(payload, signature)) throw new OAuthStateError('bad_signature');
    let parsed;
    try {
      parsed = PayloadSchema.safeParse(
        JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      );
    } catch {
      throw new OAuthStateError('malformed');
    }
    if (!parsed.success) throw new OAuthStateError('malformed');
    const claims = parsed.data;
    if (claims.s !== system) throw new OAuthStateError('wrong_system');
    if (claims.e <= now.getTime()) throw new OAuthStateError('expired');

    let ctx: TenantContext;
    try {
      ctx = await this.contexts.forTenantId(claims.t);
    } catch (err) {
      // A tenant that no longer exists: the state can never be redeemed. A
      // suspended tenant is a different answer (TenantInactiveError), kept as is.
      if (err instanceof TenantNotFoundError || err instanceof InvalidTenantContextError) {
        throw new OAuthStateError('unknown_or_used');
      }
      throw err;
    }
    const consumed = await this.db.transaction(ctx, async (tx) => {
      const rows = await tenantClient(tx).$queryRaw<{ n: number }[]>`
        DELETE FROM tenant_oauth_states
         WHERE tenant_id = ${tx.tenantId}::uuid
           AND nonce_hash = ${hashNonce(claims.n)}
           AND system = ${system}
           AND expires_at > ${now}
        RETURNING 1 AS n`;
      return rows.length;
    });
    if (consumed !== 1) throw new OAuthStateError('unknown_or_used');
    return ctx;
  }
}

function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}
