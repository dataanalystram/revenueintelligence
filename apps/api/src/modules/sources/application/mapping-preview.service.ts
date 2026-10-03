import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  isAuthoritative,
  mapSubscriptionRecord,
  mappedFields,
  type ExternalSystem,
  type FallbackAccount,
  type MappingDocument,
  type SourceConnector,
  type SourceRecord,
} from '../../domain';
import { ProductCatalogueService } from '../../products';
import type { TenantContext } from '../../tenancy';
import { MappingInvalidError, SourcesError } from '../errors';
import { SourceConnectionsService } from './source-connections.service';
import { SourceMappingsService } from './source-mappings.service';
import { SourceAuthorityService } from './source-authority.service';

export const PREVIEW_LIMIT = 20;

export interface PreviewLine {
  /** SHA-256 prefix of the source id: never the id itself. */
  readonly ref: string;
  readonly outcome: string;
  readonly code?: string;
  readonly quality: readonly string[];
  /** Masked mapped values: codes and dates as is, text truncated. */
  readonly values: Readonly<Record<string, string>>;
}

export interface PreviewReport {
  readonly object: string;
  readonly read: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly lines: readonly PreviewLine[];
}

/**
 * Mapping preview (ADR 0020, plan §35): reads at most 20 records of each
 * mapped subscription object, maps them in memory, and returns masked output.
 * Nothing is written, persisted or logged.
 */
@Injectable()
export class MappingPreviewService {
  constructor(
    private readonly connections: SourceConnectionsService,
    private readonly mappings: SourceMappingsService,
    private readonly authority: SourceAuthorityService,
    private readonly catalogue: ProductCatalogueService,
  ) {}

  async preview(
    ctx: TenantContext,
    connectionId: string,
    raw: unknown,
    limit = PREVIEW_LIMIT,
  ): Promise<PreviewReport[]> {
    const report = await this.mappings.validate(ctx, connectionId, raw);
    if (!report.ok) throw new MappingInvalidError(report.errors);
    const doc = raw as MappingDocument;
    const connection = await this.connections.get(ctx, connectionId);
    const connector = this.connections.connector(ctx, connection);
    const kind = connection.kind as ExternalSystem;
    const authority = (await this.authority.show(ctx))?.document;
    if (!authority) throw new SourcesError('authority_missing', 'No authority version');
    const model = await this.catalogue.modelAt(ctx, new Date());
    const refs = doc.productReferences;
    const modelled = new Set(
      (model?.document.products ?? []).flatMap((p) =>
        p.externalRefs
          .filter((r) => r.system === kind && r.objectType === refs?.object)
          .map((r) => r.id),
      ),
    );
    const ignored = new Set((refs?.ignored ?? []).map((i) => i.id));
    const out: PreviewReport[] = [];
    for (const obj of doc.objects.filter((o) => o.entity === 'subscription')) {
      const page = await connector.readRecords({
        object: obj.source,
        fields: mappedFields(obj),
        selection: { mode: 'full', boundary: new Date() },
        pageSize: Math.min(Math.max(1, limit), PREVIEW_LIMIT),
      });
      const records = page.records.slice(0, PREVIEW_LIMIT);
      const accountRel = obj.relationships.find((r) => r.target === 'subscription.account')!;
      const productRel = obj.relationships.find((r) => r.target === 'subscription.product')!;
      const accountIds = unique(records.map((r) => r.values[accountRel.field]));
      const foundAccounts = await readIds(connector, accountRel.object!, accountIds);
      const productIds = unique(records.map((r) => r.values[productRel.field])).filter(
        (id) => !modelled.has(id) && !ignored.has(id),
      );
      const inCatalogue = refs
        ? await readIds(connector, refs.object, productIds)
        : new Set<string>();
      const fb = accountRel.fallbackVia;
      const hops = new Map<string, FallbackAccount>();
      if (fb) {
        const values = unique(records.map((r) => r.values[fb.field]));
        const page2 = values.length
          ? await connector.readRecords({
              object: fb.object,
              fields: [fb.targetField],
              selection: { mode: 'ids', ids: values.slice(0, 100) },
              pageSize: 100,
            })
          : { records: [] };
        values.forEach((v) => hops.set(v, { kind: 'orphan' }));
        for (const r of page2.records) {
          const target = r.values[fb.targetField];
          hops.set(r.id, target ? { kind: 'account', id: String(target) } : { kind: 'none' });
        }
      }
      const outcomes: Record<string, number> = {};
      const lines = records.map((record: SourceRecord): PreviewLine => {
        const result = mapSubscriptionRecord(obj, record, {
          kind,
          productReferences: refs!,
          authority: {
            state: isAuthoritative(authority, 'subscription_state', connectionId),
            terms: isAuthoritative(authority, 'subscription_terms', connectionId),
          },
          observedAt: new Date(),
          accountStatus: (id) => (foundAccounts.has(id) ? 'known' : 'orphan'),
          fallbackAccount: (v) => hops.get(v) ?? { kind: 'orphan' },
          productStatus: (id) =>
            ignored.has(id)
              ? 'ignored'
              : modelled.has(id)
                ? 'modelled'
                : inCatalogue.has(id)
                  ? 'unmodelled'
                  : 'orphan',
        });
        const label = 'code' in result ? `${result.outcome}:${result.code}` : result.outcome;
        outcomes[label] = (outcomes[label] ?? 0) + 1;
        const values: Record<string, string> = {};
        if (result.outcome === 'ingest' && result.observation.presence === 'present') {
          const o = result.observation;
          values.state = o.state;
          if (o.startsAt) values.startsAt = o.startsAt.toISOString();
          if (o.endsAt) values.endsAt = o.endsAt.toISOString();
          if (o.quantity !== undefined) values.quantity = String(o.quantity);
          values.account = hash(o.companyRef);
          values.product = hash(o.productRef);
        }
        return {
          ref: hash(record.id),
          outcome: result.outcome,
          ...('code' in result ? { code: result.code } : {}),
          quality: result.outcome === 'ingest' ? result.quality : [],
          values,
        };
      });
      out.push({ object: obj.source, read: records.length, outcomes, lines });
    }
    return out;
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function unique(values: readonly (string | number | boolean | null | undefined)[]): string[] {
  return [
    ...new Set(
      values
        .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
        .filter((v) => v !== ''),
    ),
  ];
}

async function readIds(
  connector: SourceConnector,
  object: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const page = await connector.readRecords({
      object,
      fields: [],
      selection: { mode: 'ids', ids: ids.slice(i, i + 100) },
      pageSize: 100,
    });
    page.records.forEach((r) => found.add(r.id));
  }
  return found;
}
