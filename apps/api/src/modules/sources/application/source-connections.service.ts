import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ConnectorKindSchema,
  connectorKindEntry,
  type ConnectionTestResult,
  type SourceConnector,
} from '../../domain';
import {
  TenantCredentialsService,
  TenantDatabase,
  type IntegrationSystem,
  type TenantContext,
} from '../../tenancy';
import { ConnectionNotFoundError, SourcesError } from '../errors';
import { SourceAdapterRegistry } from '../source-adapters';
import { SourcesRepository, type SourceConnection } from '../infrastructure/sources.repository';

/**
 * Platform-level synchronisation settings kept with the connection (not the
 * adapter's): the incremental overlap is configured per connection and has no
 * production default (10 minutes is a test value only).
 */
export const SourceSyncSettingsSchema = z.strictObject({
  overlapMinutes: z.number().int().min(1).max(1440),
});
export type SourceSyncSettings = z.infer<typeof SourceSyncSettingsSchema>;

export interface ConfigureConnectionInput {
  readonly kind: string;
  readonly label: string;
  /** Adapter configuration plus an optional `sync` block (non-secret only). */
  readonly config: Record<string, unknown>;
  /** A credential name registered for this tenant and kind (values: SecretProvider). */
  readonly credentialName?: string;
}

const Label = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}]+$/u);
const CredentialName = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);

/** Tenant source connections (ADR 0019 §2): one per kind, non-secret configuration. */
@Injectable()
export class SourceConnectionsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: SourcesRepository,
    private readonly registry: SourceAdapterRegistry,
    private readonly credentials: TenantCredentialsService,
  ) {}

  list(ctx: TenantContext): Promise<SourceConnection[]> {
    return this.db.transaction(ctx, (tx) => this.repo.listConnections(tx));
  }

  async get(ctx: TenantContext, id: string): Promise<SourceConnection> {
    const found = await this.db.transaction(ctx, (tx) => this.repo.connection(tx, id));
    if (!found) throw new ConnectionNotFoundError(id);
    return found;
  }

  /** The connection's sync settings, if configured. */
  syncSettings(connection: SourceConnection): SourceSyncSettings | undefined {
    const parsed = SourceSyncSettingsSchema.safeParse(connection.config.sync);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Creates or updates the tenant's connection of a versioned kind. The
   * configuration is validated by the adapter; credentials are names only.
   * A new connection starts disabled.
   */
  async configure(ctx: TenantContext, input: ConfigureConnectionInput): Promise<SourceConnection> {
    const kind = ConnectorKindSchema.safeParse(input.kind);
    if (!kind.success)
      throw new SourcesError('unknown_kind', `Unknown connector kind ${input.kind}`);
    if (connectorKindEntry(kind.data).mappingMode !== 'versioned') {
      throw new SourcesError(
        'kind_not_configurable',
        `${kind.data} connections are created by the platform and mapped in code`,
      );
    }
    const label = Label.safeParse(input.label);
    if (!label.success) throw new SourcesError('invalid_label', 'Invalid connection label');
    if (
      input.credentialName !== undefined &&
      !CredentialName.safeParse(input.credentialName).success
    ) {
      throw new SourcesError('invalid_credential_name', 'Invalid credential name');
    }
    const { sync, ...adapterConfig } = input.config;
    if (sync !== undefined && !SourceSyncSettingsSchema.safeParse(sync).success) {
      throw new SourcesError('invalid_sync_settings', 'sync.overlapMinutes must be 1–1440');
    }
    const factory = this.registry.get(kind.data);
    const verdict = factory.validateConfig(adapterConfig);
    if (!verdict.ok) {
      throw new SourcesError(
        'invalid_config',
        'The connection configuration is invalid',
        verdict.issues.map((message) => ({ code: 'invalid_config', path: 'config', message })),
      );
    }
    if (input.credentialName) {
      // Registers the NAME (idempotent); the key is derived from this tenant's
      // slug, so a connection can only ever resolve its own tenant's secret.
      await this.credentials.register(ctx, kind.data as IntegrationSystem, input.credentialName);
    }
    return this.db.transaction(ctx, async (tx) => {
      const existing = await this.repo.connectionByKind(tx, kind.data);
      if (existing) {
        return this.repo.updateConnection(tx, existing.id, {
          label: label.data,
          config: input.config,
          credentialName: input.credentialName ?? null,
        });
      }
      return this.repo.createConnection(tx, {
        kind: kind.data,
        label: label.data,
        mappingMode: 'versioned',
        config: input.config,
        ...(input.credentialName ? { credentialName: input.credentialName } : {}),
      });
    });
  }

  async setStatus(
    ctx: TenantContext,
    id: string,
    status: 'enabled' | 'disabled',
  ): Promise<SourceConnection> {
    return this.db.transaction(ctx, async (tx) => {
      if (!(await this.repo.connection(tx, id))) throw new ConnectionNotFoundError(id);
      return this.repo.updateConnection(tx, id, { status });
    });
  }

  /** Runs the adapter's connection test and records the outcome code (no payload). */
  async test(ctx: TenantContext, id: string): Promise<ConnectionTestResult> {
    const connection = await this.get(ctx, id);
    const result = await this.connector(ctx, connection).testConnection();
    await this.db.transaction(ctx, (tx) => this.repo.recordTest(tx, id, result.code, new Date()));
    return result;
  }

  /** Whether this process can synchronise connections of a kind (ADR 0019 §4). */
  hasAdapter(kind: string): boolean {
    return this.registry.has(kind);
  }

  /** An adapter instance for this connection; credentials resolve through the SecretProvider. */
  connector(ctx: TenantContext, connection: SourceConnection): SourceConnector {
    const factory = this.registry.get(connection.kind);
    const { sync: _sync, ...config } = connection.config;
    return factory.create(
      {
        tenantId: ctx.tenantId,
        tenantSlug: ctx.tenantSlug,
        connectionId: connection.id,
        kind: connection.kind,
        config,
        ...(connection.credentialName ? { credentialName: connection.credentialName } : {}),
      },
      {
        // Only this tenant's registered credential of this kind can resolve.
        resolveCredential: (name) =>
          this.credentials.resolve(ctx, connection.kind as IntegrationSystem, name),
      },
    );
  }
}
