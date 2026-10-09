import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ConnectorKindSchema,
  connectorKindEntry,
  PROFILE_LIMITS,
  SourceProfileSettingsSchema,
  type ConnectionTestResult,
  type SourceConnector,
} from '../../domain';
import {
  assertAuthorized,
  AuditTrail,
  WriteAuthorizer,
  TenantCredentialsService,
  TenantDatabase,
  type AuthorizedContext,
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
  /**
   * M9B: minutes the run boundary trails the run start, so reads of an
   * eventually consistent list API stay behind writes it may not show yet.
   * Absent: 0 (the M8 behaviour).
   */
  settleMinutes: z.number().int().min(0).max(60).optional(),
});
export type SourceSyncSettings = z.infer<typeof SourceSyncSettingsSchema>;

export interface ConfigureConnectionInput {
  readonly kind: string;
  readonly label: string;
  /** Adapter configuration plus optional `sync` and `profile` blocks (non-secret only). */
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
    private readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
  ) {}

  list(ctx: TenantContext): Promise<SourceConnection[]> {
    return this.db.transaction(ctx, (tx) => this.repo.listConnections(tx));
  }

  async get(ctx: TenantContext, id: string): Promise<SourceConnection> {
    const found = await this.db.transaction(ctx, (tx) => this.repo.connection(tx, id));
    if (!found) throw new ConnectionNotFoundError(id);
    return found;
  }

  /** The connection's raw profile settings (validated per request: refuse, never clamp). */
  profileSettings(connection: SourceConnection): unknown {
    return connection.config.profile;
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
  async configure(
    actx: AuthorizedContext<'config.source.connection'>,
    input: ConfigureConnectionInput,
  ): Promise<SourceConnection> {
    assertAuthorized(actx, 'config.source.connection');
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
    // Plan §11: no secret-like values in the label or the (non-secret) configuration.
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'source_connection.configure', targetKind: 'source_connection' },
      { 'connection label': label.data, 'connection config': input.config },
    );
    if (
      input.credentialName !== undefined &&
      !CredentialName.safeParse(input.credentialName).success
    ) {
      throw new SourcesError('invalid_credential_name', 'Invalid credential name');
    }
    const { sync, profile, ...adapterConfig } = input.config;
    if (sync !== undefined && !SourceSyncSettingsSchema.safeParse(sync).success) {
      throw new SourcesError(
        'invalid_sync_settings',
        'sync.overlapMinutes must be 1–1440 (and sync.settleMinutes 0–60)',
      );
    }
    // M9A (D2): the per-connection profile limit is refused out of range, never clamped.
    if (profile !== undefined && !SourceProfileSettingsSchema.safeParse(profile).success) {
      throw new SourcesError(
        'profile_limit_out_of_range',
        `profile.maxRows must be ${PROFILE_LIMITS.minRows}–${PROFILE_LIMITS.maxRows} (suggested ${PROFILE_LIMITS.suggestedRows}); profile.freshnessDays 1–90`,
      );
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
      await this.credentials.register(actx, kind.data as IntegrationSystem, input.credentialName);
    }
    return this.db.transaction(actx.tenant, async (tx) => {
      const existing = await this.repo.connectionByKind(tx, kind.data);
      const saved = existing
        ? await this.repo.updateConnection(tx, existing.id, {
            label: label.data,
            config: input.config,
            credentialName: input.credentialName ?? null,
          })
        : await this.repo.createConnection(tx, {
            kind: kind.data,
            label: label.data,
            mappingMode: 'versioned',
            config: input.config,
            ...(input.credentialName ? { credentialName: input.credentialName } : {}),
          });
      await this.audit.record(tx, actx, {
        action: 'source_connection.configure',
        targetKind: 'source_connection',
        targetRef: saved.id,
        details: { kind: kind.data, created: !existing },
      });
      return saved;
    });
  }

  async setStatus(
    actx: AuthorizedContext<'config.source.connection'>,
    id: string,
    status: 'enabled' | 'disabled',
  ): Promise<SourceConnection> {
    assertAuthorized(actx, 'config.source.connection');
    return this.db.transaction(actx.tenant, async (tx) => {
      if (!(await this.repo.connection(tx, id))) throw new ConnectionNotFoundError(id);
      const saved = await this.repo.updateConnection(tx, id, { status });
      await this.audit.record(tx, actx, {
        action: 'source_connection.status',
        targetKind: 'source_connection',
        targetRef: id,
        details: { status },
      });
      return saved;
    });
  }

  /** Runs the adapter's connection test and records the outcome code (no payload). */
  async test(
    actx: AuthorizedContext<'config.source.connection'>,
    id: string,
  ): Promise<ConnectionTestResult> {
    assertAuthorized(actx, 'config.source.connection');
    const connection = await this.get(actx.tenant, id);
    const result = await this.connector(actx.tenant, connection).testConnection();
    await this.db.transaction(actx.tenant, async (tx) => {
      await this.repo.recordTest(tx, id, result.code, new Date());
      await this.audit.record(tx, actx, {
        action: 'source_connection.test',
        targetKind: 'source_connection',
        targetRef: id,
        details: { code: result.code },
      });
    });
    return result;
  }

  /** Whether this process can synchronise connections of a kind (ADR 0019 §4). */
  hasAdapter(kind: string): boolean {
    return this.registry.has(kind);
  }

  /** An adapter instance for this connection; credentials resolve through the SecretProvider. */
  connector(ctx: TenantContext, connection: SourceConnection): SourceConnector {
    const factory = this.registry.get(connection.kind);
    const { sync: _sync, profile: _profile, ...config } = connection.config;
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
