import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { authorityContentHash } from '../../domain';
import {
  CredentialNameSchema,
  type CredentialName,
  type CredentialRef,
} from '../config/credentials';
import {
  FlowModeSchema,
  FlowSchema,
  type Flow,
  type FlowMode,
  type FlowSetting,
} from '../config/flows';
import {
  IntegrationAccessSchema,
  IntegrationSystemSchema,
  parseIntegrationSettings,
  type IntegrationAccess,
  type IntegrationConfig,
  type IntegrationSettings,
  type IntegrationSystem,
} from '../config/integrations';
import {
  LeadSourceMappingSchema,
  type LeadSourceMapping,
  type LeadSourceSystem,
} from '../config/lead-source-mappings';
import {
  parsePolicyDocument,
  type Policy,
  type PolicyDocument,
  type PolicyKind,
} from '../config/policies';
import { ProductSchema, type Product } from '../config/products';
import { QualificationConfigInputSchema, type QualificationConfig } from '../config/qualification';
import { ConcurrencyConflictError, RecordNotFoundError } from '../errors';
import { translateDatabaseError } from './prisma-errors';
import { tenantClient, type TenantTransaction } from './tenant-database';

/** Labels of the connections the platform creates itself (match the M8 backfill). */
const CODE_CONNECTION_LABELS = { import: 'Operator import (CSV)', hubspot: 'HubSpot' } as const;

/** Stored rows are re-validated on read, so bad data can never enter the application. */
@Injectable()
export class PrismaTenantConfigRepository {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Serialises configuration changes for one tenant until the transaction
   * ends. Changes whose validity depends on other settings (flows need
   * integration access; qualification modes need Jev) must take this lock
   * before reading, so two concurrent admin requests cannot each validate
   * against state the other is about to change (a check-then-act race).
   *
   * A transaction-scoped advisory lock: released automatically on commit or
   * rollback, independent of which rows exist, and keyed per tenant so
   * tenants do not contend for it. Callers must run at READ COMMITTED (see
   * TenantConfigService) so reads after the lock see the previous holder's
   * committed changes.
   */
  async lockTenantConfiguration(tx: TenantTransaction): Promise<void> {
    const db = tenantClient(tx);
    // Bound the wait (transaction-local): a busy tenant fails fast with a
    // retryable LockTimeoutError instead of holding a pooled connection.
    await db.$queryRaw`SELECT set_config('lock_timeout', ${`${this.config.database.lockTimeoutMs}ms`}, true)`;
    await guard(
      'tenant configuration',
      () =>
        db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant-config:${tx.tenantId}`}, 0))`,
    );
  }

  // --- Integrations ---------------------------------------------------------

  async listIntegrations(tx: TenantTransaction): Promise<IntegrationConfig[]> {
    const rows = await tenantClient(tx).tenantIntegration.findMany({
      where: { tenantId: tx.tenantId },
      orderBy: { system: 'asc' },
    });
    return rows.map((r) => toIntegration(r));
  }

  async getIntegration<S extends IntegrationSystem>(
    tx: TenantTransaction,
    system: S,
  ): Promise<IntegrationConfig<S>> {
    const row = await tenantClient(tx).tenantIntegration.findUnique({
      where: { tenantId_system: { tenantId: tx.tenantId, system } },
    });
    if (!row) throw new RecordNotFoundError('integration', system);
    return toIntegration(row) as IntegrationConfig<S>;
  }

  async saveIntegration<S extends IntegrationSystem>(
    tx: TenantTransaction,
    system: S,
    access: IntegrationAccess,
    settings: IntegrationSettings<S>,
  ): Promise<IntegrationConfig<S>> {
    const row = await guard('integration', () =>
      tenantClient(tx).tenantIntegration.upsert({
        where: { tenantId_system: { tenantId: tx.tenantId, system } },
        create: { tenantId: tx.tenantId, system, access, settings },
        update: { access, settings, version: { increment: 1 } },
      }),
    );
    return toIntegration(row) as IntegrationConfig<S>;
  }

  // --- Source connections (M8, ADR 0019) -------------------------------------

  /**
   * Ensures the tenant's code-mapped source connection of `kind` exists
   * (`import` at provisioning, `hubspot` once the integration is enabled).
   * Idempotent: an existing connection is left exactly as it is.
   */
  async ensureCodeConnection(tx: TenantTransaction, kind: 'import' | 'hubspot'): Promise<void> {
    await guard('source connection', () =>
      tenantClient(tx).tenantSourceConnection.createMany({
        data: [
          {
            tenantId: tx.tenantId,
            id: randomUUID(),
            kind,
            label: CODE_CONNECTION_LABELS[kind],
            status: 'enabled',
            mappingMode: 'code',
          },
        ],
        skipDuplicates: true,
      }),
    );
  }

  /**
   * Seeds authority version 1 at provisioning (ADR 0020 §8): subscription
   * facts to the tenant's `import` connection (the M7 default), profiles
   * unassigned. Later changes are publications with a base version.
   */
  async seedDefaultAuthority(tx: TenantTransaction): Promise<void> {
    const client = tenantClient(tx);
    const imported = await client.tenantSourceConnection.findUnique({
      where: { tenantId_kind: { tenantId: tx.tenantId, kind: 'import' } },
      select: { id: true },
    });
    if (!imported) throw new RecordNotFoundError('source connection', 'import');
    const doc = {
      facts: {
        account_profile: null,
        person_profile: null,
        subscription_lines: imported.id,
        subscription_state: imported.id,
        subscription_terms: imported.id,
      },
    };
    await guard('source authority', () =>
      client.tenantSourceAuthorityVersion.create({
        data: {
          tenantId: tx.tenantId,
          version: 1,
          baseVersion: 0,
          subscriptionLinesConnectionId: imported.id,
          subscriptionStateConnectionId: imported.id,
          subscriptionTermsConnectionId: imported.id,
          contentHash: authorityContentHash(doc),
          publishedBy: 'provisioning',
        },
      }),
    );
  }

  // --- Flows ----------------------------------------------------------------

  async listFlows(tx: TenantTransaction): Promise<FlowSetting[]> {
    const rows = await tenantClient(tx).tenantFlowSetting.findMany({
      where: { tenantId: tx.tenantId },
      orderBy: { flow: 'asc' },
    });
    return rows.map(toFlow);
  }

  async saveFlow(tx: TenantTransaction, flow: Flow, mode: FlowMode): Promise<FlowSetting> {
    const row = await guard('flow', () =>
      tenantClient(tx).tenantFlowSetting.upsert({
        where: { tenantId_flow: { tenantId: tx.tenantId, flow } },
        create: { tenantId: tx.tenantId, flow, mode },
        update: { mode, version: { increment: 1 } },
      }),
    );
    return toFlow(row);
  }

  // --- Credential references --------------------------------------------------

  async findCredentialRef(
    tx: TenantTransaction,
    system: IntegrationSystem,
    name: CredentialName,
  ): Promise<CredentialRef | undefined> {
    const row = await tenantClient(tx).tenantCredentialRef.findUnique({
      where: { tenantId_system_name: { tenantId: tx.tenantId, system, name } },
    });
    return row ? toCredentialRef(row) : undefined;
  }

  async listCredentialRefs(tx: TenantTransaction): Promise<CredentialRef[]> {
    const rows = await tenantClient(tx).tenantCredentialRef.findMany({
      where: { tenantId: tx.tenantId },
      orderBy: [{ system: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toCredentialRef);
  }

  async saveCredentialRef(tx: TenantTransaction, ref: CredentialRef): Promise<CredentialRef> {
    const row = await guard('credential reference', () =>
      tenantClient(tx).tenantCredentialRef.upsert({
        where: {
          tenantId_system_name: { tenantId: tx.tenantId, system: ref.system, name: ref.name },
        },
        create: {
          tenantId: tx.tenantId,
          tenantSlug: tx.tenantSlug,
          system: ref.system,
          name: ref.name,
          secretKey: ref.secretKey,
        },
        update: { secretKey: ref.secretKey },
      }),
    );
    return toCredentialRef(row);
  }

  async deleteCredentialRef(
    tx: TenantTransaction,
    system: IntegrationSystem,
    name: CredentialName,
  ): Promise<boolean> {
    const { count } = await tenantClient(tx).tenantCredentialRef.deleteMany({
      where: { tenantId: tx.tenantId, system, name },
    });
    return count > 0;
  }

  // --- Qualification --------------------------------------------------------

  async getQualificationConfig(tx: TenantTransaction): Promise<QualificationConfig> {
    const row = await tenantClient(tx).tenantQualificationConfig.findUnique({
      where: { tenantId: tx.tenantId },
    });
    if (!row) throw new RecordNotFoundError('qualification config', tx.tenantSlug);
    return toQualification(row);
  }

  async createQualificationConfig(
    tx: TenantTransaction,
    config: Omit<QualificationConfig, 'version'>,
  ): Promise<QualificationConfig> {
    const row = await guard('qualification config', () =>
      tenantClient(tx).tenantQualificationConfig.create({
        data: {
          tenantId: tx.tenantId,
          mode: config.mode,
          rulesetVersion: config.rulesetVersion,
          settings: config.settings,
        },
      }),
    );
    return toQualification(row);
  }

  async updateQualificationConfig(
    tx: TenantTransaction,
    config: Omit<QualificationConfig, 'version'>,
    expectedVersion: number,
  ): Promise<QualificationConfig> {
    const { count } = await guard('qualification config', () =>
      tenantClient(tx).tenantQualificationConfig.updateMany({
        where: { tenantId: tx.tenantId, version: expectedVersion },
        data: {
          mode: config.mode,
          rulesetVersion: config.rulesetVersion,
          settings: config.settings,
          version: { increment: 1 },
        },
      }),
    );
    if (count === 0) {
      await this.getQualificationConfig(tx); // NotFound if absent
      throw new ConcurrencyConflictError('qualification config', expectedVersion);
    }
    return this.getQualificationConfig(tx);
  }

  // --- Products ---------------------------------------------------------------

  async listProducts(
    tx: TenantTransaction,
    options: { activeOnly?: boolean } = {},
  ): Promise<Product[]> {
    const rows = await tenantClient(tx).tenantProduct.findMany({
      where: { tenantId: tx.tenantId, ...(options.activeOnly ? { active: true } : {}) },
      orderBy: { key: 'asc' },
    });
    return rows.map(toProduct);
  }

  // --- Lead source mappings ---------------------------------------------------

  async listLeadSourceMappings(
    tx: TenantTransaction,
    system?: LeadSourceSystem,
  ): Promise<(LeadSourceMapping & { id: string })[]> {
    const rows = await tenantClient(tx).tenantLeadSourceMapping.findMany({
      where: { tenantId: tx.tenantId, ...(system ? { system } : {}) },
      orderBy: [{ system: 'asc' }, { priority: 'asc' }, { sourceValue: 'asc' }],
    });
    return rows.map(toLeadSourceMapping);
  }

  async saveLeadSourceMapping(
    tx: TenantTransaction,
    mapping: LeadSourceMapping,
  ): Promise<LeadSourceMapping & { id: string }> {
    const key = {
      tenantId: tx.tenantId,
      system: mapping.system,
      sourceProperty: mapping.sourceProperty,
      matchType: mapping.matchType,
      sourceValue: mapping.sourceValue,
    };
    const data = { channel: mapping.channel, label: mapping.label, priority: mapping.priority };
    const row = await guard('lead source mapping', () =>
      tenantClient(tx).tenantLeadSourceMapping.upsert({
        where: { tenantId_system_sourceProperty_matchType_sourceValue: key },
        create: { ...key, ...data },
        update: data,
      }),
    );
    return toLeadSourceMapping(row);
  }

  async deleteLeadSourceMapping(tx: TenantTransaction, id: string): Promise<boolean> {
    const { count } = await tenantClient(tx).tenantLeadSourceMapping.deleteMany({
      where: { tenantId: tx.tenantId, id },
    });
    return count > 0;
  }

  // --- Policies ---------------------------------------------------------------

  async findPolicy<K extends PolicyKind>(
    tx: TenantTransaction,
    kind: K,
  ): Promise<Policy<K> | undefined> {
    const row = await tenantClient(tx).tenantPolicy.findUnique({
      where: { tenantId_kind: { tenantId: tx.tenantId, kind } },
    });
    return row
      ? { kind, document: parsePolicyDocument(kind, row.document), version: row.version }
      : undefined;
  }

  /**
   * Creates the policy (expectedVersion undefined) or replaces it if the
   * stored version still equals expectedVersion.
   */
  async savePolicy<K extends PolicyKind>(
    tx: TenantTransaction,
    kind: K,
    document: PolicyDocument<K>,
    expectedVersion?: number,
  ): Promise<Policy<K>> {
    const db = tenantClient(tx);
    if (expectedVersion === undefined) {
      const row = await guard('policy', () =>
        db.tenantPolicy.create({ data: { tenantId: tx.tenantId, kind, document } }),
      );
      return { kind, document: parsePolicyDocument(kind, row.document), version: row.version };
    }
    const { count } = await db.tenantPolicy.updateMany({
      where: { tenantId: tx.tenantId, kind, version: expectedVersion },
      data: { document, version: { increment: 1 } },
    });
    if (count === 0) {
      if (!(await this.findPolicy(tx, kind))) throw new RecordNotFoundError('policy', kind);
      throw new ConcurrencyConflictError(`${kind} policy`, expectedVersion);
    }
    return (await this.findPolicy(tx, kind))!;
  }
}

async function guard<T>(entity: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    translateDatabaseError(error, entity);
  }
}

function toIntegration(row: {
  system: string;
  access: string;
  settings: unknown;
  version: number;
}): IntegrationConfig {
  const system = IntegrationSystemSchema.parse(row.system);
  return {
    system,
    access: IntegrationAccessSchema.parse(row.access),
    settings: parseIntegrationSettings(system, row.settings),
    version: row.version,
  };
}

function toFlow(row: { flow: string; mode: string; version: number }): FlowSetting {
  return {
    flow: FlowSchema.parse(row.flow),
    mode: FlowModeSchema.parse(row.mode),
    version: row.version,
  };
}

function toCredentialRef(row: { system: string; name: string; secretKey: string }): CredentialRef {
  return {
    system: IntegrationSystemSchema.parse(row.system),
    name: CredentialNameSchema.parse(row.name),
    secretKey: row.secretKey,
  };
}

function toQualification(row: {
  mode: string;
  rulesetVersion: string | null;
  settings: unknown;
  version: number;
}): QualificationConfig {
  return {
    ...QualificationConfigInputSchema.parse({
      mode: row.mode,
      rulesetVersion: row.rulesetVersion,
      settings: row.settings,
    }),
    version: row.version,
  };
}

function toProduct(row: {
  key: string;
  name: string;
  description: string | null;
  active: boolean;
}): Product {
  return ProductSchema.parse({
    key: row.key,
    name: row.name,
    description: row.description,
    active: row.active,
  });
}

function toLeadSourceMapping(row: {
  id: string;
  system: string;
  sourceProperty: string;
  matchType: string;
  sourceValue: string;
  channel: string;
  label: string | null;
  priority: number;
}): LeadSourceMapping & { id: string } {
  return {
    id: row.id,
    ...LeadSourceMappingSchema.parse({
      system: row.system,
      sourceProperty: row.sourceProperty,
      matchType: row.matchType,
      sourceValue: row.sourceValue,
      channel: row.channel,
      label: row.label,
      priority: row.priority,
    }),
  };
}
