import { Injectable } from '@nestjs/common';
import {
  MappingDocumentSchema,
  SourceSchemaSchema,
  UNASSIGNED_AUTHORITY,
  validateMapping,
  type MappingDocument,
  type MappingIssue,
  type MappingValidation,
} from '../../domain';
import {
  tenantAdvisoryLock,
  TenantDatabase,
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
import { SourcesRepository, type StoredMappingVersion } from '../infrastructure/sources.repository';

export interface PublishMappingOptions {
  /** The version the document was edited from: required (0 for the first). */
  readonly expectedBaseVersion: number;
  readonly actor: string;
  /** The snapshot the operator validated against; stale when not the latest. */
  readonly validatedAgainst?: string;
}

export interface MappingValidationReport {
  readonly ok: boolean;
  readonly snapshotHash: string;
  readonly authorityVersion: number;
  readonly contentHash?: string;
  readonly errors: readonly MappingIssue[];
  readonly warnings: readonly MappingIssue[];
}

export interface PublishedMapping {
  readonly version: number;
  readonly contentHash: string;
  readonly snapshotHash: string;
  readonly authorityVersion: number;
  readonly warnings: readonly MappingIssue[];
}

const ACTOR = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** Versioned, immutable source mappings (ADR 0020 §1–5, §11). */
@Injectable()
export class SourceMappingsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: SourcesRepository,
  ) {}

  /** Validates a candidate against the latest snapshot and the current authority. */
  async validate(
    ctx: TenantContext,
    connectionId: string,
    raw: unknown,
    validatedAgainst?: string,
  ): Promise<MappingValidationReport> {
    return this.db.transaction(ctx, async (tx) => {
      const { report } = await this.check(tx, connectionId, raw, validatedAgainst);
      return report;
    });
  }

  /**
   * Publishes a new immutable version. `expectedBaseVersion` is required: a
   * stale base is refused (`concurrent_publish`), so an edit made from version
   * N can never silently replace a version N+1 published meanwhile.
   */
  async publish(
    ctx: TenantContext,
    connectionId: string,
    raw: unknown,
    options: PublishMappingOptions,
  ): Promise<PublishedMapping> {
    const base = (options as { expectedBaseVersion?: number }).expectedBaseVersion;
    if (base === undefined || !Number.isInteger(base) || base < 0) {
      throw new PublishBaseVersionRequiredError('a mapping');
    }
    if (!ACTOR.test(options.actor)) throw new SourcesError('invalid_actor', 'Invalid actor');
    return this.db.transaction(ctx, async (tx) => {
      // One publication per connection at a time.
      await tenantAdvisoryLock(tx, 'source-mapping', connectionId);
      const latest = await this.repo.latestMapping(tx, connectionId);
      const latestVersion = latest?.version ?? 0;
      if (base !== latestVersion) {
        throw new ConcurrentSourcePublishError('The mapping', base, latestVersion);
      }
      const { report, validation } = await this.check(
        tx,
        connectionId,
        raw,
        options.validatedAgainst,
      );
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
        },
        publishedBy: options.actor,
      });
      return {
        version: stored.version,
        contentHash: stored.contentHash,
        snapshotHash: stored.schemaSnapshotHash,
        authorityVersion: stored.authorityVersion,
        warnings: validation.warnings,
      };
    });
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
    validatedAgainst: string | undefined,
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
    const validation = validateMapping(raw, {
      connectionId,
      kind: connection.kind,
      schema: SourceSchemaSchema.parse(snapshot.document),
      schemaHash: validatedAgainst ?? snapshot.hash,
      latestSchemaHash: snapshot.hash,
      authority: authority?.document ?? UNASSIGNED_AUTHORITY,
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
      },
    };
  }
}

function countBy(codes: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of codes) out.set(c, (out.get(c) ?? 0) + 1);
  return out;
}
