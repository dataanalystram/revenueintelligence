import { Inject, Injectable } from '@nestjs/common';
import { SECRET_PROVIDER, type Secret, type SecretProvider } from '../../../platform/secrets';
import {
  CredentialRefInputSchema,
  credentialSecretKey,
  isOwnedSecretKey,
  type CredentialName,
  type CredentialRef,
} from '../config/credentials';
import type { IntegrationSystem } from '../config/integrations';
import { RecordNotFoundError, TenantConfigError, TenantIsolationViolationError } from '../errors';
import { PrismaTenantConfigRepository } from '../infrastructure/prisma-tenant-config.repository';
import { TenantDatabase } from '../infrastructure/tenant-database';
import type { TenantContext } from '../tenant-context';

/**
 * Per-tenant credentials. The database stores only references; values live
 * in the SecretProvider (env / Key Vault). Keys are derived from the tenant's
 * own slug, so one tenant can never be configured to use another's secret.
 */
@Injectable()
export class TenantCredentialsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: PrismaTenantConfigRepository,
    @Inject(SECRET_PROVIDER) private readonly secrets: SecretProvider,
  ) {}

  /** Registers (idempotently) that `system`/`name` is a credential of this tenant. */
  async register(
    ctx: TenantContext,
    system: IntegrationSystem,
    name: string,
  ): Promise<CredentialRef> {
    const input = CredentialRefInputSchema.safeParse({ system, name });
    if (!input.success) {
      throw new TenantConfigError(
        'Invalid credential reference',
        input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    return await this.db.transaction(ctx, (tx) =>
      this.repo.saveCredentialRef(tx, {
        system: input.data.system,
        name: input.data.name,
        secretKey: credentialSecretKey(tx.tenantSlug, input.data.system, input.data.name),
      }),
    );
  }

  async list(ctx: TenantContext): Promise<CredentialRef[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listCredentialRefs(tx));
  }

  async remove(
    ctx: TenantContext,
    system: IntegrationSystem,
    name: CredentialName,
  ): Promise<boolean> {
    return await this.db.transaction(ctx, (tx) => this.repo.deleteCredentialRef(tx, system, name));
  }

  /**
   * Resolves the secret value for this tenant only. Fails if the tenant has
   * no such credential registered, or if the secret is not configured.
   */
  async resolve(ctx: TenantContext, system: IntegrationSystem, name: string): Promise<Secret> {
    const input = CredentialRefInputSchema.safeParse({ system, name });
    if (!input.success) throw new TenantConfigError('Invalid credential reference');
    const ref = await this.db.transaction(ctx, (tx) =>
      this.repo.findCredentialRef(tx, input.data.system, input.data.name),
    );
    if (!ref) throw new RecordNotFoundError('credential', `${system}.${name}`);
    // Defence in depth: the database CHECK constraint enforces the same rule.
    if (!isOwnedSecretKey(ctx.tenantSlug, ref.secretKey)) throw new TenantIsolationViolationError();
    return await this.secrets.get(ref.secretKey);
  }
}
