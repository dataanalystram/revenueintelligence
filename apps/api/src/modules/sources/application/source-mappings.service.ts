import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../../../platform/metrics';
import {
  MappingDocumentSchema,
  PROFILE_FRESHNESS,
  SourceProfileSettingsSchema,
  SourceSchemaSchema,
  UNASSIGNED_AUTHORITY,
  validateMapping,
  type Acknowledgement,
  type MappingDocument,
  type MappingIssue,
  type MappingValidation,
} from '../../domain';
import {
  assertAuthorized,
  AuditTrail,
  WriteAuthorizer,
  tenantAdvisoryLock,
  TenantDatabase,
  type AuthorizedContext,
  type TenantContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  ConcurrentSourcePublishError,
  ConnectionNotFoundError,
  MappingInvalidError,
  PublishBaseVersionRequiredError,
  SourcesError,
} from '../errors';
import { ProfilesRepository } from '../infrastructure/profiles.repository';
import { SourcesRepository, type StoredMappingVersion } from '../infrastructure/sources.repository';
import { AuditFailures } from '../../tenancy';

export interface PublishMappingOptions {
  /** The version the document was edited from: required (0 for the first). */
  readonly expectedBaseVersion: number;
  /** The snapshot the operator validated against; stale when not the latest. */
  readonly validatedAgainst?: string;
  /** Acknowledged findings of the covering profiles (M9A §7.4). */
  readonly acknowledgements?: readonly Acknowledgement[];
  /** Emergency profile override (D5): disabled in M9A, always refused (decision A1). */
  readonly profileOverride?: { readonly reason: string };
}

export interface ValidateMappingOptions {
  readonly validatedAgainst?: string;
  readonly acknowledgements?: readonly Acknowledgement[];
  readonly profileOverride?: { readonly reason: string };
  readonly actor?: string;
}

export interface MappingValidationReport {
  readonly ok: boolean;
  readonly snapshotHash: string;
  readonly authorityVersion: number;
  readonly contentHash?: string;
  readonly errors: readonly MappingIssue[];
  readonly warnings: readonly MappingIssue[];
  /** The profiles that cover the consequential entries (M9A). */
  readonly coveringProfileIds: readonly string[];
}

export interface PublishedMapping {
  readonly version: number;
  readonly contentHash: string;
  readonly snapshotHash: string;
  readonly authorityVersion: number;
  readonly warnings: readonly MappingIssue[];
  readonly coveringProfileIds: readonly string[];
  readonly acknowledgements: number;
}

const ACTOR = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** Versioned, immutable source mappings (ADR 0020 §1–5, §11). */
@Injectable()
export class SourceMappingsService {
  private readonly logger = new Logger('SourceMappings');

  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: SourcesRepository,
    private readonly profiles: ProfilesRepository,
    private readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  /** Validates a candidate against the latest snapshot and the current authority. */
  async validate(
    ctx: TenantContext,
    connectionId: string,
    raw: unknown,
    options: ValidateMappingOptions = {},
  ): Promise<MappingValidationReport> {
    const report = await this.db.transaction(ctx, async (tx) => {
      const { report } = await this.check(tx, connectionId, raw, options);
      return report;
    });
    this.auditOverride(ctx, connectionId, options, options.actor ?? 'cli');
    return report;
  }

  /**
   * Publishes a new immutable version. `expectedBaseVersion` is required: a
   * stale base is refused (`concurrent_publish`), so an edit made from version
   * N can never silently replace a version N+1 published meanwhile.
   */
  @AuditFailures('mapping.publish', 'source_connection')
  async publish(
    actx: AuthorizedContext<'config.mapping.publish'>,
    connectionId: string,
    raw: unknown,
    options: PublishMappingOptions,
  ): Promise<PublishedMapping> {
    assertAuthorized(actx, 'config.mapping.publish');
    const ctx = actx.tenant;
    const actor = actx.actor.id;
    const base = (options as { expectedBaseVersion?: number }).expectedBaseVersion;
    if (base === undefined || !Number.isInteger(base) || base < 0) {
      throw new PublishBaseVersionRequiredError('a mapping');
    }
    if (!ACTOR.test(actor)) throw new SourcesError('invalid_actor', 'Invalid actor');
    // Plan §11: reasons and confirmations are stored free text.
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'mapping.publish', targetKind: 'source_connection', targetRef: connectionId },
      { mapping: raw, options },
    );
    // An override attempt is audited as refused before anything else happens.
    this.auditOverride(ctx, connectionId, options, actor);
    return this.db.transaction(ctx, async (tx) => {
      // One publication per connection at a time.
      await tenantAdvisoryLock(tx, 'source-mapping', connectionId);
      const latest = await this.repo.latestMapping(tx, connectionId);
      const latestVersion = latest?.version ?? 0;
      if (base !== latestVersion) {
        throw new ConcurrentSourcePublishError('The mapping', base, latestVersion);
      }
      const { report, validation } = await this.check(tx, connectionId, raw, options);
      if (!validation.ok) throw new MappingInvalidError(validation.errors);
      if (report.authorityVersion === 0) {
        throw new SourcesError('authority_missing', 'The tenant has no authority version');
      }
      const stored = await this.repo.insertMapping(tx, {
        connectionId,
        version: latestVersion + 1,
        baseVersion: latestVersion,
        document: validation.document,
        contentHash: validation.contentHash,
        schemaSnapshotHash: report.snapshotHash,
        authorityVersion: report.authorityVersion,
        validation: {
          warnings: Object.fromEntries(countBy(validation.warnings.map((w) => w.code))),
          // M9A (§7.1, §7.4): the evidence the publication relied on.
          coveringProfileIds: validation.coveringProfileIds,
          acknowledgements: validation.acknowledgements.map((a) => ({
            findingId: a.findingId,
            code: a.code,
            reasonCode: a.reasonCode,
            actor,
            at: new Date().toISOString(),
          })),
        },
        publishedBy: actor,
      });
      await this.audit.record(tx, actx, {
        action: 'mapping.publish',
        targetKind: 'mapping',
        targetRef: `${connectionId}/v${stored.version}`,
        details: {
          version: stored.version,
          baseVersion: latestVersion,
          contentHash: stored.contentHash,
          authorityVersion: stored.authorityVersion,
          acknowledgements: validation.acknowledgements.length,
        },
      });
      return {
        version: stored.version,
        contentHash: stored.contentHash,
        snapshotHash: stored.schemaSnapshotHash,
        authorityVersion: stored.authorityVersion,
        warnings: validation.warnings,
        coveringProfileIds: validation.coveringProfileIds,
        acknowledgements: validation.acknowledgements.length,
      };
    });
  }

  /** D5 safeguards: an override attempt is always logged and counted (refused in M9A). */
  private auditOverride(
    ctx: TenantContext,
    connectionId: string,
    options: { profileOverride?: { reason: string } },
    actor: string,
  ): void {
    if (!options.profileOverride) return;
    this.metrics?.increment('lip_profile_override_total', { kind: 'refused' });
    this.logger.warn(
      {
        tenant: ctx.tenantSlug,
        connectionId,
        actor,
        code: 'override_requires_authenticated_operator',
      },
      'Profile override attempt refused',
    );
  }

  async show(
    ctx: TenantContext,
    connectionId: string,
    version?: number,
  ): Promise<(Omit<StoredMappingVersion, 'document'> & { document: MappingDocument }) | undefined> {
    const row = await this.db.transaction(ctx, (tx) =>
      version === undefined
        ? this.repo.latestMapping(tx, connectionId)
        : this.repo.mappingVersion(tx, connectionId, version),
    );
    return row ? { ...row, document: MappingDocumentSchema.parse(row.document) } : undefined;
  }

  private async check(
    tx: TenantTransaction,
    connectionId: string,
    raw: unknown,
    options: ValidateMappingOptions,
  ): Promise<{ report: MappingValidationReport; validation: MappingValidation }> {
    const connection = await this.repo.connection(tx, connectionId);
    if (!connection) throw new ConnectionNotFoundError(connectionId);
    if (connection.mappingMode !== 'versioned') {
      throw new SourcesError('mapping_not_versioned', `${connection.kind} is mapped in code`);
    }
    const snapshot = await this.repo.latestSnapshot(tx, connectionId);
    if (!snapshot) {
      throw new SourcesError('no_schema_snapshot', 'Capture a schema snapshot before mapping');
    }
    const authority = await this.repo.latestAuthority(tx);
    const schemaHash = options.validatedAgainst ?? snapshot.hash;
    const settings = SourceProfileSettingsSchema.safeParse(connection.config.profile);
    const validation = validateMapping(raw, {
      connectionId,
      kind: connection.kind,
      schema: SourceSchemaSchema.parse(snapshot.document),
      schemaHash,
      latestSchemaHash: snapshot.hash,
      authority: authority?.document ?? UNASSIGNED_AUTHORITY,
      profiling: {
        profiles: await this.profiles.candidateProfiles(tx, connectionId, schemaHash),
        now: new Date(),
        freshnessDays: settings.success
          ? (settings.data.freshnessDays ?? PROFILE_FRESHNESS.defaultDays)
          : PROFILE_FRESHNESS.defaultDays,
        acknowledgements: options.acknowledgements ?? [],
        ...(options.profileOverride ? { override: options.profileOverride } : {}),
        // No authenticated operator channel exists (A1): the CLI actor is unauthenticated.
        operator: { authenticated: false, actor: options.actor ?? 'cli' },
      },
    });
    return {
      validation,
      report: {
        ok: validation.ok,
        snapshotHash: snapshot.hash,
        authorityVersion: authority?.version ?? 0,
        ...(validation.ok ? { contentHash: validation.contentHash } : {}),
        errors: validation.ok ? [] : validation.errors,
        warnings: validation.warnings,
        coveringProfileIds: validation.ok ? validation.coveringProfileIds : [],
      },
    };
  }
}

function countBy(codes: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of codes) out.set(c, (out.get(c) ?? 0) + 1);
  return out;
}
