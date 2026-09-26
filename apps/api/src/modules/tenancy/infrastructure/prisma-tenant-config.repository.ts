import { Injectable } from '@nestjs/common';
import type { ProductKey } from '../../domain';
import {
  CredentialNameSchema,
  type CredentialName,
  type CredentialRef,
} from '../config/credentials';
import { FieldMappingSchema, type FieldMapping, type MappedSystem } from '../config/field-mappings';
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

/** Stored rows are re-validated on read, so bad data can never enter the application. */
@Injectable()
export class PrismaTenantConfigRepository {
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

  async findProduct(tx: TenantTransaction, key: ProductKey): Promise<Product | undefined> {
    const row = await tenantClient(tx).tenantProduct.findUnique({
      where: { tenantId_key: { tenantId: tx.tenantId, key } },
    });
    return row ? toProduct(row) : undefined;
  }

  async saveProduct(tx: TenantTransaction, product: Product): Promise<Product> {
    const data = {
      name: product.name,
      description: product.description,
      active: product.active,
    };
    const row = await guard('product', () =>
      tenantClient(tx).tenantProduct.upsert({
        where: { tenantId_key: { tenantId: tx.tenantId, key: product.key } },
        create: { tenantId: tx.tenantId, key: product.key, ...data },
        update: data,
      }),
    );
    return toProduct(row);
  }

  /** Fails with InvalidReferenceError while any company still owns the product. */
  async deleteProduct(tx: TenantTransaction, key: ProductKey): Promise<boolean> {
    const { count } = await guard('product', () =>
      tenantClient(tx).tenantProduct.deleteMany({ where: { tenantId: tx.tenantId, key } }),
    );
    return count > 0;
  }

  // --- Field mappings -------------------------------------------------------

  async listFieldMappings(
    tx: TenantTransaction,
    filter: { system?: MappedSystem; objectType?: string } = {},
  ): Promise<(FieldMapping & { id: string })[]> {
    const rows = await tenantClient(tx).tenantFieldMapping.findMany({
      where: { tenantId: tx.tenantId, ...filter },
      orderBy: [{ system: 'asc' }, { objectType: 'asc' }, { canonicalField: 'asc' }],
    });
    return rows.map(toFieldMapping);
  }

  async saveFieldMapping(
    tx: TenantTransaction,
    mapping: FieldMapping,
  ): Promise<FieldMapping & { id: string }> {
    const key = {
      tenantId: tx.tenantId,
      system: mapping.system,
      objectType: mapping.objectType,
      canonicalEntity: mapping.canonicalEntity,
      canonicalField: mapping.canonicalField,
    };
    const data = {
      externalField: mapping.externalField,
      direction: mapping.direction,
      status: mapping.status,
      valueMap: mapping.valueMap,
      notes: mapping.notes,
    };
    const row = await guard('field mapping', () =>
      tenantClient(tx).tenantFieldMapping.upsert({
        where: { tenantId_system_objectType_canonicalEntity_canonicalField: key },
        create: { ...key, ...data },
        update: data,
      }),
    );
    return toFieldMapping(row);
  }

  async deleteFieldMapping(tx: TenantTransaction, id: string): Promise<boolean> {
    const { count } = await tenantClient(tx).tenantFieldMapping.deleteMany({
      where: { tenantId: tx.tenantId, id },
    });
    return count > 0;
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

function toFieldMapping(row: {
  id: string;
  system: string;
  objectType: string;
  canonicalEntity: string;
  canonicalField: string;
  externalField: string | null;
  direction: string;
  status: string;
  valueMap: unknown;
  notes: string | null;
}): FieldMapping & { id: string } {
  return {
    id: row.id,
    ...FieldMappingSchema.parse({
      system: row.system,
      objectType: row.objectType,
      canonicalEntity: row.canonicalEntity,
      canonicalField: row.canonicalField,
      externalField: row.externalField,
      direction: row.direction,
      status: row.status,
      valueMap: row.valueMap,
      notes: row.notes,
    }),
  };
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
