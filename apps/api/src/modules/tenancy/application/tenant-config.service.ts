import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { ProductKey } from '../../domain';
import {
  FieldMappingSchema,
  type FieldMapping,
  type FieldMappingInput,
  type MappedSystem,
} from '../config/field-mappings';
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
import { ProductSchema, type Product, type ProductInput } from '../config/products';
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

/**
 * Configuration changes that validate across settings take the per-tenant
 * lock first and must run at READ COMMITTED: each statement after the lock
 * then sees the committed result of the previous holder. Pinned explicitly so
 * a database whose default isolation level is changed cannot reintroduce the
 * race.
 */
const CONFIG_CHANGE_TX = { isolationLevel: 'ReadCommitted' } as const;

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
  async configureIntegration<S extends IntegrationSystem>(
    ctx: TenantContext,
    system: S,
    change: { access: IntegrationAccess; settings?: unknown },
  ): Promise<IntegrationConfig<S>> {
    const s = validate(IntegrationSystemSchema, system, 'integration system') as S;
    const access = validate(IntegrationAccessSchema, change.access, 'integration access');
    return await this.db.transaction(
      ctx,
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
        return this.repo.saveIntegration(tx, s, access, settings as never);
      },
      CONFIG_CHANGE_TX,
    );
  }

  async listFlows(ctx: TenantContext): Promise<FlowSetting[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listFlows(tx));
  }

  /** Sets a flow's mode (off / shadow / coexist / active) after checking integration access. */
  async setFlowMode(ctx: TenantContext, flow: Flow, mode: FlowMode): Promise<FlowSetting> {
    const f = validate(FlowSchema, flow, 'flow');
    const m = validate(FlowModeSchema, mode, 'flow mode');
    return await this.db.transaction(
      ctx,
      async (tx) => {
        await this.repo.lockTenantConfiguration(tx);
        const problems = flowConfigurationProblems(f, m, await this.accessMap(tx));
        if (problems.length > 0) throw new TenantConfigError(`Cannot set ${f} to ${m}`, problems);
        return this.repo.saveFlow(tx, f, m);
      },
      CONFIG_CHANGE_TX,
    );
  }

  // --- Qualification --------------------------------------------------------

  async getQualificationConfig(ctx: TenantContext): Promise<QualificationConfig> {
    return await this.db.transaction(ctx, (tx) => this.repo.getQualificationConfig(tx));
  }

  /** Optimistic concurrency: `expectedVersion` must match the stored version. */
  async updateQualificationConfig(
    ctx: TenantContext,
    input: QualificationConfigInput,
    expectedVersion: number,
  ): Promise<QualificationConfig> {
    const config = validate(QualificationConfigInputSchema, input, 'qualification config');
    return await this.db.transaction(
      ctx,
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
        return this.repo.updateQualificationConfig(tx, config, expectedVersion);
      },
      CONFIG_CHANGE_TX,
    );
  }

  // --- Products ---------------------------------------------------------------

  async listProducts(
    ctx: TenantContext,
    options: { activeOnly?: boolean } = {},
  ): Promise<Product[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listProducts(tx, options));
  }

  async saveProduct(ctx: TenantContext, input: ProductInput): Promise<Product> {
    const product = validate(ProductSchema, input, 'product');
    return await this.db.transaction(ctx, (tx) => this.repo.saveProduct(tx, product));
  }

  async deleteProduct(ctx: TenantContext, key: ProductKey): Promise<boolean> {
    return await this.db.transaction(ctx, (tx) => this.repo.deleteProduct(tx, key));
  }

  // --- Mappings ---------------------------------------------------------------

  async listFieldMappings(
    ctx: TenantContext,
    filter: { system?: MappedSystem; objectType?: string } = {},
  ): Promise<(FieldMapping & { id: string })[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listFieldMappings(tx, filter));
  }

  async saveFieldMapping(
    ctx: TenantContext,
    input: FieldMappingInput,
  ): Promise<FieldMapping & { id: string }> {
    const mapping = validate(FieldMappingSchema, input, 'field mapping');
    return await this.db.transaction(ctx, (tx) => this.repo.saveFieldMapping(tx, mapping));
  }

  async deleteFieldMapping(ctx: TenantContext, id: string): Promise<boolean> {
    return await this.db.transaction(ctx, (tx) => this.repo.deleteFieldMapping(tx, id));
  }

  async listLeadSourceMappings(
    ctx: TenantContext,
    system?: LeadSourceSystem,
  ): Promise<(LeadSourceMapping & { id: string })[]> {
    return await this.db.transaction(ctx, (tx) => this.repo.listLeadSourceMappings(tx, system));
  }

  async saveLeadSourceMapping(
    ctx: TenantContext,
    input: LeadSourceMappingInput,
  ): Promise<LeadSourceMapping & { id: string }> {
    const mapping = validate(LeadSourceMappingSchema, input, 'lead source mapping');
    return await this.db.transaction(ctx, (tx) => this.repo.saveLeadSourceMapping(tx, mapping));
  }

  async deleteLeadSourceMapping(ctx: TenantContext, id: string): Promise<boolean> {
    return await this.db.transaction(ctx, (tx) => this.repo.deleteLeadSourceMapping(tx, id));
  }

  // --- Policies (SLA / routing / requalification) ------------------------------

  async getPolicy<K extends PolicyKind>(
    ctx: TenantContext,
    kind: K,
  ): Promise<Policy<K> | undefined> {
    return await this.db.transaction(ctx, (tx) => this.repo.findPolicy(tx, kind));
  }

  /** Creates the policy when `expectedVersion` is omitted; otherwise replaces that version. */
  async savePolicy<K extends PolicyKind>(
    ctx: TenantContext,
    kind: K,
    document: unknown,
    expectedVersion?: number,
  ): Promise<Policy<K>> {
    const doc = validate(PolicySchemas[kind], document, `${kind} policy`);
    return await this.db.transaction(ctx, (tx) =>
      this.repo.savePolicy(tx, kind, doc as never, expectedVersion),
    );
  }

  private async accessMap(
    tx: TenantTransaction,
  ): Promise<Partial<Record<IntegrationSystem, IntegrationAccess>>> {
    const integrations = await this.repo.listIntegrations(tx);
    return Object.fromEntries(integrations.map((i) => [i.system, i.access]));
  }
}
