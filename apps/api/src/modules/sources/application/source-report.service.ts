import { Injectable } from '@nestjs/common';
import { factsHeldBy, MappingDocumentSchema, type DriftIssue } from '../../domain';
import {
  OwnershipGapService,
  ProductCatalogueService,
  SubscriptionReadModel,
} from '../../products';
import { TenantDatabase, type TenantContext } from '../../tenancy';
import { SourcesRepository, type SourceRun } from '../infrastructure/sources.repository';
import { SchemaSnapshotsService } from './schema-snapshots.service';
import { SourceConnectionsService } from './source-connections.service';

export interface SourceReport {
  readonly connection: { id: string; kind: string; status: string; mappingMode: string };
  readonly mappingVersion?: number;
  readonly authority: { version?: number; facts: readonly string[] };
  readonly coverage: unknown;
  readonly ownershipGaps: { accounts: number; lines: number };
  readonly latestRuns: readonly Pick<
    SourceRun,
    | 'id'
    | 'mode'
    | 'status'
    | 'lastErrorCode'
    | 'startedAt'
    | 'completedAt'
    | 'recordsSeen'
    | 'quality'
  >[];
  readonly drift?: readonly DriftIssue[];
  /** Source product ids neither modelled nor ignored (ids only). */
  readonly unmodelledProducts?: readonly string[];
}

/** Read-only operator reporting (status, quality, drift, coverage, products). Codes, ids and counts only. */
@Injectable()
export class SourceReportService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: SourcesRepository,
    private readonly connections: SourceConnectionsService,
    private readonly snapshots: SchemaSnapshotsService,
    private readonly gaps: OwnershipGapService,
    private readonly readModel: SubscriptionReadModel,
    private readonly catalogue: ProductCatalogueService,
  ) {}

  async status(ctx: TenantContext, connectionId: string, limit = 10): Promise<SourceRun[]> {
    await this.connections.get(ctx, connectionId);
    return this.db.transaction(ctx, (tx) => this.repo.listRuns(tx, connectionId, limit));
  }

  async report(
    ctx: TenantContext,
    connectionId: string,
    options: { drift?: boolean; products?: boolean } = {},
  ): Promise<SourceReport> {
    const connection = await this.connections.get(ctx, connectionId);
    const { mapping, authority, runs } = await this.db.transaction(ctx, async (tx) => ({
      mapping: await this.repo.latestMapping(tx, connectionId),
      authority: await this.repo.latestAuthority(tx),
      runs: await this.repo.listRuns(tx, connectionId, 5),
    }));
    const gaps = await this.gaps.list(ctx, connectionId);
    const report: SourceReport = {
      connection: {
        id: connection.id,
        kind: connection.kind,
        status: connection.status,
        mappingMode: connection.mappingMode,
      },
      ...(mapping ? { mappingVersion: mapping.version } : {}),
      authority: {
        ...(authority ? { version: authority.version } : {}),
        facts: authority ? factsHeldBy(authority.document, connectionId) : [],
      },
      coverage: await this.readModel.coverage(ctx),
      ownershipGaps: { accounts: new Set(gaps.map((g) => g.companyId)).size, lines: gaps.length },
      latestRuns: runs.map((r) => ({
        id: r.id,
        mode: r.mode,
        status: r.status,
        ...(r.lastErrorCode ? { lastErrorCode: r.lastErrorCode } : {}),
        startedAt: r.startedAt,
        ...(r.completedAt ? { completedAt: r.completedAt } : {}),
        recordsSeen: r.recordsSeen,
        quality: r.quality,
      })),
    };
    if (options.drift && mapping) {
      Object.assign(report, { drift: await this.snapshots.drift(ctx, connectionId) });
    }
    if (options.products && mapping) {
      const doc = MappingDocumentSchema.parse(mapping.document);
      const refs = doc.productReferences;
      if (refs) {
        const connector = this.connections.connector(ctx, connection);
        const model = await this.catalogue.modelAt(ctx, new Date());
        const modelled = new Set(
          (model?.document.products ?? []).flatMap((p) =>
            p.externalRefs
              .filter((r) => r.system === connection.kind && r.objectType === refs.object)
              .map((r) => r.id),
          ),
        );
        const ignored = new Set(refs.ignored.map((i) => i.id));
        const ids = new Set<string>();
        let position: string | undefined;
        do {
          const page = await connector.readRecords({
            object: refs.object,
            fields: [refs.identity.field],
            selection: { mode: 'full', boundary: new Date() },
            pageSize: 200,
            ...(position ? { position } : {}),
          });
          page.records.forEach((r) => ids.add(r.id));
          position = page.next;
        } while (position);
        Object.assign(report, {
          unmodelledProducts: [...ids].filter((id) => !modelled.has(id) && !ignored.has(id)).sort(),
        });
      }
    }
    return report;
  }
}
