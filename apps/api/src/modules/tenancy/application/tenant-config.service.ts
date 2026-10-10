import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import {
  flowConfigurationProblems,
  FlowModeSchema,
  FlowSchema,
  type Flow,
  type FlowMode,
  type FlowSetting,
} from '../config/flows';
import {
  IntegrationAccessSchema,
  IntegrationSettingsSchemas,
  IntegrationSystemSchema,
  type IntegrationAccess,
  type IntegrationConfig,
  type IntegrationSystem,
} from '../config/integrations';
import {
  LeadSourceMappingSchema,
  type LeadSourceMapping,
  type LeadSourceMappingInput,
  type LeadSourceSystem,
} from '../config/lead-source-mappings';
import { PolicySchemas, type Policy, type PolicyKind } from '../config/policies';
import type { Product } from '../config/products';
import {
  modeRequiresJev,
  QualificationConfigInputSchema,
  type QualificationConfig,
  type QualificationConfigInput,
} from '../config/qualification';
import { TenantConfigError } from '../errors';
import { PrismaTenantConfigRepository } from '../infrastructure/prisma-tenant-config.repository';
import { TenantDatabase, type TenantTransaction } from '../infrastructure/tenant-database';
import type { TenantContext } from '../tenant-context';
import { AuditTrail } from '../security/audit-trail';
import { assertAuthorized, type AuthorizedContext } from '../security/authorized-context';
import { WriteAuthorizer } from '../security/write-authorizer.service';
import { AuditFailures } from '../security/audit-failures';

/**
 * Configuration changes that validate across settings take the per-tenant
 * lock first and must run at READ COMMITTED: each statement after the lock
 * then sees the committed result of the previous holder. Pinned explicitly so
 * a database whose default isolation level is changed cannot reintroduce the
 * race.
 */
const CONFIG_CHANGE_TX = { isolationLevel: 'ReadCommitted' } as const;

/** Plan §11: configuration documents never carry secret-like values (codes only in the error). */
function validate<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TenantConfigError(
      `Invalid ${what}`,
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}

/**
 * Tenant configuration for the application. Every method requires a
 * TenantContext and runs in a tenant transaction; inputs are validated, and
 * cross-setting rules (e.g. a flow needs its integrations enabled) are checked
 * against the current configuration inside the same transaction.
 */
@Injectable()
export class TenantConfigService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: PrismaTenantConfigRepository,
    private readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
  ) {}

  // --- Integrations & flows ---------------------------------------------------

  async listIntegrations(ctx: TenantContext): Promise<IntegrationConfig[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listIntegrations(tx));
  }

  async getIntegration<S extends IntegrationSystem>(
    ctx: TenantContext,
    system: S,
  ): Promise<IntegrationConfig<S>> {
    const s = validate(IntegrationSystemSchema, system, 'integration system') as S;
    return await this.db.transaction(ctx, (tx) => this.repo.getIntegration(tx, s));
  }

  /**
   * Changes an integration. Lowering access is refused while an enabled flow
   * still needs it (turn the flow off first), and Jev cannot be disabled while
   * the qualification mode uses it. Serialised per tenant (see
   * lockTenantConfiguration) so concurrent requests cannot break these rules.
   */
  @AuditFailures('integration.configure', 'integration')
  async configureIntegration<S extends IntegrationSystem>(
    actx: AuthorizedContext<'config.integration'>,
    system: S,
    change: { access: IntegrationAccess; settings?: unknown },
  ): Promise<IntegrationConfig<S>> {
    assertAuthorized(actx, 'config.integration');
    const s = validate(IntegrationSystemSchema, system, 'integration system') as S;
    const access = validate(IntegrationAccessSchema, change.access, 'integration access');
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'integration.configure', targetKind: 'integration', targetRef: s },
      { 'integration settings': change.settings },
    );
    return await this.db.transaction(
      actx.tenant,
      async (tx) => {
        await this.repo.lockTenantConfiguration(tx);
        const current = await this.repo.getIntegration(tx, s);
        const settings = validate(
          IntegrationSettingsSchemas[s],
          change.settings ?? current.settings,
          `${s} settings`,
        );
        const accessMap = await this.accessMap(tx);
        accessMap[s] = access;
        const problems = (await this.repo.listFlows(tx)).flatMap((f) =>
          flowConfigurationProblems(f.flow, f.mode, accessMap),
        );
        if (s === 'jev' && access === 'disabled') {
          const qualification = await this.repo.getQualificationConfig(tx);
          if (modeRequiresJev(qualification.mode)) {
            problems.push(`qualification mode "${qualification.mode}" needs the jev integration`);
          }
        }
        if (problems.length > 0) {
          throw new TenantConfigError(
            `Cannot change ${s} access while other settings depend on it`,
            problems,
          );
        }
        const saved = await this.repo.saveIntegration(tx, s, access, settings as never);
        // An enabled HubSpot integration is a code-mapped source connection (ADR 0019).
        if (s === 'hubspot' && access !== 'disabled') {
          await this.repo.ensureCodeConnection(tx, 'hubspot');
        }
        await this.audit.record(tx, actx, {
          action: 'integration.configure',
          targetKind: 'integration',
          targetRef: s,
          details: { access },
        });
        return saved;
      },
      CONFIG_CHANGE_TX,
    );
  }

  async listFlows(ctx: TenantContext): Promise<FlowSetting[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listFlows(tx));
  }

  /** Sets a flow's mode (off / shadow / coexist / active) after checking integration access. */
  @AuditFailures('flow.set', 'flow')
  async setFlowMode(
    actx: AuthorizedContext<'config.integration'>,
    flow: Flow,
    mode: FlowMode,
  ): Promise<FlowSetting> {
    assertAuthorized(actx, 'config.integration');
    const f = validate(FlowSchema, flow, 'flow');
    const m = validate(FlowModeSchema, mode, 'flow mode');
    return await this.db.transaction(
      actx.tenant,
      async (tx) => {
        await this.repo.lockTenantConfiguration(tx);
        const problems = flowConfigurationProblems(f, m, await this.accessMap(tx));
        if (problems.length > 0) throw new TenantConfigError(`Cannot set ${f} to ${m}`, problems);
        const saved = await this.repo.saveFlow(tx, f, m);
        await this.audit.record(tx, actx, {
          action: 'flow.set',
          targetKind: 'flow',
          targetRef: f,
          details: { mode: m },
        });
        return saved;
      },
      CONFIG_CHANGE_TX,
    );
  }

  // --- Qualification --------------------------------------------------------

  async getQualificationConfig(ctx: TenantContext): Promise<QualificationConfig> {
    return await this.db.transaction(ctx, (tx) => this.repo.getQualificationConfig(tx));
  }

  /** Optimistic concurrency: `expectedVersion` must match the stored version. */
  @AuditFailures('qualification.update', 'policy')
  async updateQualificationConfig(
    actx: AuthorizedContext<'config.policy'>,
    input: QualificationConfigInput,
    expectedVersion: number,
  ): Promise<QualificationConfig> {
    assertAuthorized(actx, 'config.policy');
    const config = validate(QualificationConfigInputSchema, input, 'qualification config');
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'qualification.update', targetKind: 'policy', targetRef: 'qualification' },
      { 'qualification config': config },
    );
    return await this.db.transaction(
      actx.tenant,
      async (tx) => {
        await this.repo.lockTenantConfiguration(tx);
        if (modeRequiresJev(config.mode)) {
          const jev = await this.repo.getIntegration(tx, 'jev');
          if (jev.access === 'disabled') {
            throw new TenantConfigError(
              `Qualification mode "${config.mode}" requires the jev integration`,
            );
          }
        }
        const saved = await this.repo.updateQualificationConfig(tx, config, expectedVersion);
        await this.audit.record(tx, actx, {
          action: 'qualification.update',
          targetKind: 'qualification',
          details: { mode: config.mode, version: saved.version },
        });
        return saved;
      },
      CONFIG_CHANGE_TX,
    );
  }

  // --- Products ---------------------------------------------------------------
  // Read-only view of the `tenant_products` projection. Products are written
  // only by publishing a product model version (products module, ADR 0016).

  async listProducts(
    ctx: TenantContext,
    options: { activeOnly?: boolean } = {},
  ): Promise<Product[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listProducts(tx, options));
  }

  // --- Lead source mappings ---------------------------------------------------

  async listLeadSourceMappings(
    ctx: TenantContext,
    system?: LeadSourceSystem,
  ): Promise<(LeadSourceMapping & { id: string })[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listLeadSourceMappings(tx, system));
  }

  @AuditFailures('lead_source_mapping.save', 'lead_source_mapping')
  async saveLeadSourceMapping(
    actx: AuthorizedContext<'config.integration'>,
    input: LeadSourceMappingInput,
  ): Promise<LeadSourceMapping & { id: string }> {
    assertAuthorized(actx, 'config.integration');
    const mapping = validate(LeadSourceMappingSchema, input, 'lead source mapping');
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'lead_source_mapping.save', targetKind: 'lead_source_mapping' },
      { 'lead source mapping': mapping },
    );
    return await this.db.transaction(actx.tenant, async (tx) => {
      const saved = await this.repo.saveLeadSourceMapping(tx, mapping);
      await this.audit.record(tx, actx, {
        action: 'lead_source_mapping.save',
        targetKind: 'lead_source_mapping',
        targetRef: saved.id,
      });
      return saved;
    });
  }

  @AuditFailures('lead_source_mapping.delete', 'lead_source_mapping')
  async deleteLeadSourceMapping(
    actx: AuthorizedContext<'config.integration'>,
    id: string,
  ): Promise<boolean> {
    assertAuthorized(actx, 'config.integration');
    return await this.db.transaction(actx.tenant, async (tx) => {
      const deleted = await this.repo.deleteLeadSourceMapping(tx, id);
      await this.audit.record(tx, actx, {
        action: 'lead_source_mapping.delete',
        targetKind: 'lead_source_mapping',
        targetRef: id,
        details: { deleted },
      });
      return deleted;
    });
  }

  // --- Policies (SLA / routing / requalification) ------------------------------

  async getPolicy<K extends PolicyKind>(
    ctx: TenantContext,
    kind: K,
  ): Promise<Policy<K> | undefined> {
    return await this.db.transaction(ctx, (tx) => this.repo.findPolicy(tx, kind));
  }

  /** Creates the policy when `expectedVersion` is omitted; otherwise replaces that version. */
  @AuditFailures('policy.save', 'policy')
  async savePolicy<K extends PolicyKind>(
    actx: AuthorizedContext<'config.policy'>,
    kind: K,
    document: unknown,
    expectedVersion?: number,
  ): Promise<Policy<K>> {
    assertAuthorized(actx, 'config.policy');
    const doc = validate(PolicySchemas[kind], document, `${kind} policy`);
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'policy.save', targetKind: 'policy', targetRef: kind },
      { [`${kind} policy`]: doc },
    );
    return await this.db.transaction(actx.tenant, async (tx) => {
      const saved = await this.repo.savePolicy(tx, kind, doc as never, expectedVersion);
      await this.audit.record(tx, actx, {
        action: 'policy.save',
        targetKind: 'policy',
        targetRef: kind,
        details: { version: saved.version },
      });
      return saved;
    });
  }

  private async accessMap(
    tx: TenantTransaction,
  ): Promise<Partial<Record<IntegrationSystem, IntegrationAccess>>> {
    const integrations = await this.repo.listIntegrations(tx);
    return Object.fromEntries(integrations.map((i) => [i.system, i.access]));
  }
}
