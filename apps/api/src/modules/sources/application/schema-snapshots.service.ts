import { Injectable } from '@nestjs/common';
import {
  detectSchemaDrift,
  MappingDocumentSchema,
  normaliseSourceSchema,
  SourceSchemaSchema,
  sourceSchemaHash,
  type DriftIssue,
  type SourceSchema,
} from '../../domain';
import {
  assertAuthorized,
  AuditTrail,
  TenantDatabase,
  type AuthorizedContext,
  type TenantContext,
} from '../../tenancy';
import { SourcesError } from '../errors';
import { SourcesRepository } from '../infrastructure/sources.repository';
import { SourceConnectionsService } from './source-connections.service';
import { AuditFailures } from '../../tenancy';

export interface CapturedSnapshot {
  readonly hash: string;
  readonly created: boolean;
  readonly objects: number;
  readonly fields: number;
}

/** Metadata-only schema snapshots (ADR 0019 §5–6). */
@Injectable()
export class SchemaSnapshotsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: SourcesRepository,
    private readonly connections: SourceConnectionsService,
    private readonly audit: AuditTrail,
  ) {}

  /** Reads the source's metadata (never records) and stores it if new. */
  @AuditFailures('source_schema.capture', 'source_connection')
  async capture(
    actx: AuthorizedContext<'config.source.schema'>,
    connectionId: string,
  ): Promise<CapturedSnapshot> {
    assertAuthorized(actx, 'config.source.schema');
    const ctx = actx.tenant;
    const connection = await this.connections.get(ctx, connectionId);
    const schema = normaliseSourceSchema(
      await this.connections.connector(ctx, connection).describeSchema(),
    );
    const hash = sourceSchemaHash(schema);
    const { created } = await this.db.transaction(ctx, async (tx) => {
      const inserted = await this.repo.insertSnapshot(tx, {
        connectionId,
        hash,
        ...(schema.sourceVersion ? { sourceVersion: schema.sourceVersion } : {}),
        document: schema,
        capturedBy: actx.actor.id,
      });
      await this.audit.record(tx, actx, {
        action: 'source_schema.capture',
        targetKind: 'source_connection',
        targetRef: connectionId,
        details: { hash, created: inserted.created, objects: schema.objects.length },
      });
      return inserted;
    });
    return {
      hash,
      created,
      objects: schema.objects.length,
      fields: schema.objects.reduce((n, o) => n + o.fields.length, 0),
    };
  }

  async latest(
    ctx: TenantContext,
    connectionId: string,
  ): Promise<{ hash: string; schema: SourceSchema; capturedAt: Date } | undefined> {
    const row = await this.db.transaction(ctx, (tx) => this.repo.latestSnapshot(tx, connectionId));
    return row
      ? {
          hash: row.hash,
          schema: SourceSchemaSchema.parse(row.document),
          capturedAt: row.capturedAt,
        }
      : undefined;
  }

  /**
   * Drift of the source's current schema against the published mapping's
   * snapshot, on the mapped surface only. Reads metadata, writes nothing.
   */
  async drift(ctx: TenantContext, connectionId: string): Promise<readonly DriftIssue[]> {
    const connection = await this.connections.get(ctx, connectionId);
    const { mapping, snapshot } = await this.db.transaction(ctx, async (tx) => {
      const mapping = await this.repo.publishedMapping(tx, connectionId);
      return {
        mapping,
        snapshot: mapping
          ? await this.repo.snapshot(tx, connectionId, mapping.schemaSnapshotHash)
          : undefined,
      };
    });
    if (!mapping || !snapshot)
      throw new SourcesError('mapping_not_published', 'No published mapping');
    const current = await this.connections.connector(ctx, connection).describeSchema();
    return detectSchemaDrift(
      MappingDocumentSchema.parse(mapping.document),
      SourceSchemaSchema.parse(snapshot.document),
      current,
    );
  }
}
