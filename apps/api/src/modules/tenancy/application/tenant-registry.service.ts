import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { TenantId } from '../../domain';
import { FlowSchema } from '../config/flows';
import { IntegrationSystemSchema } from '../config/integrations';
import {
  DEFAULT_QUALIFICATION_CONFIG,
  QualificationConfigInputSchema,
} from '../config/qualification';
import { TenantTemplateSchema, type TenantTemplateInput } from '../config/template';
import {
  DuplicateTenantError,
  TenancyError,
  TenantConfigError,
  TenantNotFoundError,
  UniqueConstraintError,
} from '../errors';
import { translateDatabaseError } from '../infrastructure/prisma-errors';
import { PrismaTenantConfigRepository } from '../infrastructure/prisma-tenant-config.repository';
import { PrismaTenantRegistryRepository } from '../infrastructure/prisma-tenant-registry.repository';
import { TenantDatabase } from '../infrastructure/tenant-database';
import { TenantSlugSchema, type Tenant, type TenantStatus } from '../tenant';
import { AuditTrail } from '../security/audit-trail';
import {
  assertPlatformAuthorized,
  type PlatformAuthorization,
} from '../security/authorized-context';

const ProvisionInputSchema = z.strictObject({
  slug: TenantSlugSchema,
  name: z.string().trim().min(1).max(200),
  template: TenantTemplateSchema.optional(),
});

export type ProvisionTenantInput = { slug: string; name: string; template?: TenantTemplateInput };

/** Allowed lifecycle changes; `offboarded` is terminal. */
const TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantStatus[]>> = {
  active: ['suspended', 'offboarded'],
  suspended: ['active', 'offboarded'],
  offboarded: [],
};

/**
 * Platform administration of tenants: provisioning and lifecycle. Operates
 * across tenants by design, so it is never exposed to tenant-scoped callers.
 */
@Injectable()
export class TenantRegistryService {
  private readonly logger = new Logger(TenantRegistryService.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly registry: PrismaTenantRegistryRepository,
    private readonly config: PrismaTenantConfigRepository,
    private readonly audit: AuditTrail,
  ) {}

  /**
   * Creates a tenant with safe defaults in one transaction: every integration
   * disabled, every flow off, rules-only qualification, plus the optional
   * template's catalogue, mappings and policies.
   */
  async provision(
    auth: PlatformAuthorization<'config.tenant.provision'>,
    input: ProvisionTenantInput,
  ): Promise<Tenant> {
    assertPlatformAuthorized(auth, 'config.tenant.provision');
    const parsed = ProvisionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new TenantConfigError(
        'Invalid tenant provisioning input',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    const { slug, name, template } = parsed.data;
    try {
      const { tenant } = await this.db.provision({ slug, name }, async (tx) => {
        for (const system of IntegrationSystemSchema.options) {
          await this.config.saveIntegration(
            tx,
            system,
            'disabled',
            template?.integrationSettings[system] ?? {},
          );
        }
        for (const flow of FlowSchema.options) {
          await this.config.saveFlow(tx, flow, 'off');
        }
        // Every tenant can import subscriptions from an operator file (M7/M8).
        await this.config.ensureCodeConnection(tx, 'import');
        await this.config.seedDefaultAuthority(tx);
        await this.config.createQualificationConfig(
          tx,
          template?.qualification
            ? QualificationConfigInputSchema.parse(template.qualification)
            : DEFAULT_QUALIFICATION_CONFIG,
        );
        for (const mapping of template?.leadSourceMappings ?? []) {
          await this.config.saveLeadSourceMapping(tx, mapping);
        }
        const policies = template?.policies ?? {};
        if (policies.sla) await this.config.savePolicy(tx, 'sla', policies.sla);
        if (policies.routing) await this.config.savePolicy(tx, 'routing', policies.routing);
        if (policies.requalification) {
          await this.config.savePolicy(tx, 'requalification', policies.requalification);
        }
        await this.audit.recordPlatform(tx, auth, {
          action: 'tenant.provision',
          targetKind: 'tenant',
          targetRef: slug,
          details: { template: template !== undefined },
        });
      });
      this.logger.log({ tenantId: tenant.id, slug: tenant.slug }, 'Tenant provisioned');
      return tenant;
    } catch (error) {
      throw this.provisioningError(error, slug);
    }
  }

  private provisioningError(error: unknown, slug: string): unknown {
    if (error instanceof TenancyError) return error;
    try {
      translateDatabaseError(error, 'tenant');
    } catch (translated) {
      if (translated instanceof UniqueConstraintError) return new DuplicateTenantError(slug);
      return translated;
    }
  }

  get(tenantId: TenantId): Promise<Tenant | undefined> {
    return this.registry.findById(tenantId);
  }

  list(status?: TenantStatus): Promise<Tenant[]> {
    return this.registry.list(status);
  }

  suspend(
    auth: PlatformAuthorization<'config.tenant.status'>,
    tenantId: TenantId,
  ): Promise<Tenant> {
    return this.transition(auth, tenantId, 'suspended');
  }

  reactivate(
    auth: PlatformAuthorization<'config.tenant.status'>,
    tenantId: TenantId,
  ): Promise<Tenant> {
    return this.transition(auth, tenantId, 'active');
  }

  /** Terminal. Data retention and deletion are a separate, audited process. */
  offboard(
    auth: PlatformAuthorization<'config.tenant.status'>,
    tenantId: TenantId,
  ): Promise<Tenant> {
    return this.transition(auth, tenantId, 'offboarded');
  }

  private async transition(
    auth: PlatformAuthorization<'config.tenant.status'>,
    tenantId: TenantId,
    to: TenantStatus,
  ): Promise<Tenant> {
    assertPlatformAuthorized(auth, 'config.tenant.status');
    const tenant = await this.registry.findById(tenantId);
    if (!tenant) throw new TenantNotFoundError(tenantId);
    if (tenant.status === to) return tenant;
    if (!TRANSITIONS[tenant.status].includes(to)) {
      throw new TenantConfigError(`Tenant cannot move from ${tenant.status} to ${to}`);
    }
    const updated = await this.db.platformChange(
      { id: tenant.id, slug: tenant.slug },
      (root) => this.registry.setStatusWithin(root, tenantId, to),
      async (tx, result) => {
        if (!result) return;
        await this.audit.recordPlatform(tx, auth, {
          action: 'tenant.status',
          targetKind: 'tenant',
          targetRef: tenant.slug,
          details: { from: tenant.status, to },
        });
      },
    );
    if (!updated) throw new TenantNotFoundError(tenantId);
    this.logger.log({ tenantId, from: tenant.status, to }, 'Tenant status changed');
    return updated;
  }
}
