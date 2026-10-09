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
import { AuditTrail } from '../security/audit-trail';
import { assertAuthorizedFor, type AuthorizedContext } from '../security/authorized-context';
import { SecurityEventsService } from '../security/security-events.service';

/** Registering a credential reference is integration configuration, also done by source-connection setup. */
type CredentialConfigContext = AuthorizedContext<'config.integration' | 'config.source.connection'>;
const CREDENTIAL_CAPABILITIES = ['config.integration', 'config.source.connection'] as const;

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
    private readonly audit: AuditTrail,
    private readonly events: SecurityEventsService,
  ) {}

  /** Registers (idempotently) that `system`/`name` is a credential of this tenant. */
  async register(
    actx: CredentialConfigContext,
    system: IntegrationSystem,
    name: string,
  ): Promise<CredentialRef> {
    assertAuthorizedFor(actx, CREDENTIAL_CAPABILITIES);
    const input = CredentialRefInputSchema.safeParse({ system, name });
    if (!input.success) {
      throw new TenantConfigError(
        'Invalid credential reference',
        input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    return await this.db.transaction(actx.tenant, async (tx) => {
      const saved = await this.repo.saveCredentialRef(tx, {
        system: input.data.system,
        name: input.data.name,
        secretKey: credentialSecretKey(tx.tenantSlug, input.data.system, input.data.name),
      });
      await this.audit.record(tx, actx, {
        action: 'credential_ref.save',
        targetKind: 'credential_ref',
        targetRef: `${input.data.system}.${input.data.name}`,
      });
      return saved;
    });
  }

  async list(ctx: TenantContext): Promise<CredentialRef[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listCredentialRefs(tx));
  }

  async remove(
    actx: CredentialConfigContext,
    system: IntegrationSystem,
    name: CredentialName,
  ): Promise<boolean> {
    assertAuthorizedFor(actx, CREDENTIAL_CAPABILITIES);
    return await this.db.transaction(actx.tenant, async (tx) => {
      const removed = await this.repo.deleteCredentialRef(tx, system, name);
      await this.audit.record(tx, actx, {
        action: 'credential_ref.delete',
        targetKind: 'credential_ref',
        targetRef: `${system}.${name}`,
        details: { removed },
      });
      return removed;
    });
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
    if (!ref) {
      this.resolutionFailed(ctx, 'credential_not_found', system);
      throw new RecordNotFoundError('credential', `${system}.${name}`);
    }
    // Defence in depth: the database CHECK constraint enforces the same rule.
    if (!isOwnedSecretKey(ctx.tenantSlug, ref.secretKey)) {
      this.resolutionFailed(ctx, 'credential_not_owned', system);
      throw new TenantIsolationViolationError();
    }
    try {
      return await this.secrets.get(ref.secretKey);
    } catch (error) {
      this.resolutionFailed(ctx, 'secret_not_configured', system);
      throw error;
    }
  }

  /** Plan §12: codes only; the secret key and any value are never part of the event. */
  private resolutionFailed(ctx: TenantContext, reasonCode: string, system: string): void {
    this.events.emit({
      event: 'credential_resolution_failed',
      outcome: 'failed',
      tenant: ctx.tenantSlug,
      reasonCode,
      coordinates: { system },
    });
  }
}
