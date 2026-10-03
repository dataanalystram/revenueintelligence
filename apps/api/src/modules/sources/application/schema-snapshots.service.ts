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
import { TenantDatabase, type TenantContext } from '../../tenancy';
import { SourcesError } from '../errors';
import { SourcesRepository } from '../infrastructure/sources.repository';
import { SourceConnectionsService } from './source-connections.service';

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
  ) {}

  /** Reads the source's metadata (never records) and stores it if new. */
  async capture(
    ctx: TenantContext,
    connectionId: string,
    actor: string,
  ): Promise<CapturedSnapshot> {
    const connection = await this.connections.get(ctx, connectionId);
    const schema = normaliseSourceSchema(
      await this.connections.connector(ctx, connection).describeSchema(),
    );
    const hash = sourceSchemaHash(schema);
    const { created } = await this.db.transaction(ctx, (tx) =>
      this.repo.insertSnapshot(tx, {
        connectionId,
        hash,
        ...(schema.sourceVersion ? { sourceVersion: schema.sourceVersion } : {}),
        document: schema,
        capturedBy: actor,
      }),
    );
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
      const mapping = await this.repo.latestMapping(tx, connectionId);
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
