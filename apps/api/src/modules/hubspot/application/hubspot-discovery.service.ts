import { Inject, Injectable } from '@nestjs/common';
import type { ExternalAssociationType, ExternalFieldDefinition } from '../../domain';
import type { TenantContext } from '../../tenancy';
import { HubSpotError } from '../errors';
import { HUBSPOT_CONFIG, type HubSpotConfig } from '../hubspot.config';
import type { HubSpotAccount, HubSpotReader } from '../infrastructure/hubspot-reader';
import {
  HUBSPOT_DEFAULT_PROPERTIES,
  HUBSPOT_OBJECT_TYPES,
  type HubSpotObjectType,
} from '../infrastructure/mappers';
import { HubSpotConnector } from './hubspot-connector.service';

/**
 * Outcome of one discovery probe. A probe that HubSpot refuses is a finding
 * (e.g. the Leads object is not available, or a scope is missing), not a
 * failure of discovery itself.
 */
export type Probe<T> =
  | ({ readonly status: 'ok' } & T)
  | {
      readonly status: 'missing_scopes' | 'forbidden' | 'not_found' | 'bad_request' | 'error';
      readonly httpStatus?: number;
      readonly category?: string;
      readonly requiredScopes?: readonly string[];
      readonly message: string;
    };

export interface RecordsProbe {
  readonly pageSize: number;
  readonly pagesRead: number;
  readonly recordsRead: number;
  /** True when a later page was requested with HubSpot's cursor and returned new records. */
  readonly paginationVerified: boolean;
  /** True when HubSpot offered a further page beyond those read. */
  readonly morePages: boolean;
  /** Record ids read (used for the association samples; ids only, no field values). */
  readonly sampleIds: readonly string[];
}

export interface PropertiesProbe {
  readonly total: number;
  readonly custom: number;
  /** HubSpot default properties the connector relies on, and whether each exists. */
  readonly defaultPropertiesPresent: Readonly<Record<string, boolean>>;
  readonly fields: readonly ExternalFieldDefinition[];
}

export interface AssociationLabelsProbe {
  readonly types: readonly ExternalAssociationType[];
}

export interface AssociationSampleProbe {
  readonly recordsChecked: number;
  readonly recordsWithAssociations: number;
  readonly associations: number;
  readonly typesSeen: readonly ExternalAssociationType[];
}

export interface HubSpotDiscoveryReport {
  readonly generatedAt: string;
  readonly apiVersion: string;
  readonly apiHost: string;
  readonly account: HubSpotAccount;
  readonly objects: Readonly<
    Record<
      HubSpotObjectType,
      { readonly records: Probe<RecordsProbe>; readonly properties: Probe<PropertiesProbe> }
    >
  >;
  readonly associationLabels: readonly {
    readonly from: HubSpotObjectType;
    readonly to: HubSpotObjectType;
    readonly result: Probe<AssociationLabelsProbe>;
  }[];
  readonly associationSamples: readonly {
    readonly from: HubSpotObjectType;
    readonly to: HubSpotObjectType;
    readonly result: Probe<AssociationSampleProbe>;
  }[];
  readonly leadObject: {
    readonly available: boolean;
    readonly reason: string;
  };
  /** Union of the scopes HubSpot reported as missing. */
  readonly missingScopes: readonly string[];
}

export interface DiscoveryOptions {
  /**
   * Account types discovery may run against. Defaults to test and sandbox
   * accounts, so a production token is refused unless explicitly allowed.
   */
  readonly allowedAccountTypes?: readonly string[];
  /** Page size for the pagination probe (small, to force several pages). */
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export const TEST_ACCOUNT_TYPES = ['DEVELOPER_TEST', 'SANDBOX'] as const;

const LABEL_PAIRS: readonly (readonly [HubSpotObjectType, HubSpotObjectType])[] = [
  ['leads', 'contacts'],
  ['leads', 'companies'],
  ['contacts', 'leads'],
  ['companies', 'leads'],
  ['contacts', 'companies'],
  ['companies', 'contacts'],
];

const SAMPLE_PAIRS: readonly (readonly [HubSpotObjectType, HubSpotObjectType])[] = [
  ['leads', 'contacts'],
  ['leads', 'companies'],
  ['contacts', 'companies'],
];

/** Read-only discovery of a tenant's HubSpot account: objects, schema, associations. */
@Injectable()
export class HubSpotDiscoveryService {
  constructor(
    private readonly connector: HubSpotConnector,
    @Inject(HUBSPOT_CONFIG) private readonly config: HubSpotConfig,
  ) {}

  async discover(
    ctx: TenantContext,
    options: DiscoveryOptions = {},
  ): Promise<HubSpotDiscoveryReport> {
    const { reader, account } = await this.connector.connect(ctx);
    const allowed = options.allowedAccountTypes ?? TEST_ACCOUNT_TYPES;
    if (!account.accountType || !allowed.includes(account.accountType)) {
      throw new HubSpotError(
        'account_mismatch',
        `Discovery refused: account ${account.portalId} has type ${account.accountType ?? 'unknown'}, ` +
          `expected one of ${allowed.join(', ')}`,
      );
    }
    const pageSize = options.pageSize ?? 2;
    const maxPages = options.maxPages ?? 3;
    const missing = new Set<string>();
    const run = async <T>(fn: () => Promise<T>): Promise<Probe<T>> => {
      try {
        return { status: 'ok', ...(await fn()) };
      } catch (err) {
        if (!(err instanceof HubSpotError)) throw err;
        for (const s of err.details.requiredScopes ?? []) missing.add(s);
        return {
          status: err.missingScopes
            ? 'missing_scopes'
            : err.kind === 'forbidden' || err.kind === 'not_found' || err.kind === 'bad_request'
              ? err.kind
              : 'error',
          httpStatus: err.details.status,
          category: err.details.category,
          requiredScopes: err.details.requiredScopes,
          message: err.message,
        };
      }
    };

    const objects = {} as Record<
      HubSpotObjectType,
      { records: Probe<RecordsProbe>; properties: Probe<PropertiesProbe> }
    >;
    for (const type of HUBSPOT_OBJECT_TYPES) {
      objects[type] = {
        records: await run(() => this.probeRecords(reader, type, pageSize, maxPages)),
        properties: await run(() => this.probeProperties(reader, type)),
      };
    }

    const associationLabels = [];
    for (const [from, to] of LABEL_PAIRS) {
      associationLabels.push({
        from,
        to,
        result: await run(async () => ({ types: await reader.listAssociationTypes(from, to) })),
      });
    }

    const associationSamples = [];
    for (const [from, to] of SAMPLE_PAIRS) {
      const source = objects[from].records;
      const ids = source.status === 'ok' ? source.sampleIds : [];
      associationSamples.push({
        from,
        to,
        result:
          source.status === 'ok'
            ? await run(() => this.probeAssociations(reader, from, ids, to))
            : ({
                status: 'error',
                message: `not probed: reading ${from} failed (${source.status})`,
              } as const),
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      apiVersion: this.config.apiVersion,
      apiHost: new URL(this.config.baseUrl).host,
      account,
      objects,
      associationLabels,
      associationSamples,
      leadObject: leadAvailability(objects.leads.records, objects.leads.properties),
      missingScopes: [...missing].sort(),
    };
  }

  private async probeRecords(
    reader: HubSpotReader,
    type: HubSpotObjectType,
    pageSize: number,
    maxPages: number,
  ): Promise<RecordsProbe> {
    const ids: string[] = [];
    let pagesRead = 0;
    let morePages = false;
    let paginationVerified = false;
    for await (const page of reader.iterateRecords(type, { limit: pageSize, maxPages })) {
      pagesRead += 1;
      const fresh = page.items.map((r) => r.ref.id).filter((id) => !ids.includes(id));
      if (pagesRead > 1 && fresh.length > 0) paginationVerified = true;
      if (pagesRead > 1 && fresh.length < page.items.length) {
        throw new HubSpotError('invalid_payload', `Paging returned duplicate ${type} records`);
      }
      ids.push(...fresh);
      morePages = page.nextCursor !== undefined;
    }
    return {
      pageSize,
      pagesRead,
      recordsRead: ids.length,
      paginationVerified,
      morePages,
      sampleIds: ids,
    };
  }

  private async probeProperties(
    reader: HubSpotReader,
    type: HubSpotObjectType,
  ): Promise<PropertiesProbe> {
    const fields = await reader.listProperties(type);
    const names = new Set(fields.map((f) => f.name));
    return {
      total: fields.length,
      custom: fields.filter((f) => !f.vendorDefined).length,
      defaultPropertiesPresent: Object.fromEntries(
        HUBSPOT_DEFAULT_PROPERTIES[type].map((p) => [p, names.has(p)]),
      ),
      fields,
    };
  }

  private async probeAssociations(
    reader: HubSpotReader,
    from: HubSpotObjectType,
    ids: readonly string[],
    to: HubSpotObjectType,
  ): Promise<AssociationSampleProbe> {
    const links = ids.length ? await reader.readAssociations(from, ids, to) : [];
    const types = new Map<string, ExternalAssociationType>();
    for (const link of links) for (const t of link.types) types.set(`${t.category}:${t.typeId}`, t);
    return {
      recordsChecked: ids.length,
      recordsWithAssociations: new Set(links.map((l) => l.from.id)).size,
      associations: links.length,
      typesSeen: [...types.values()].sort((a, b) => a.typeId - b.typeId),
    };
  }
}

function leadAvailability(
  records: Probe<RecordsProbe>,
  properties: Probe<PropertiesProbe>,
): { available: boolean; reason: string } {
  if (records.status === 'ok' && properties.status === 'ok') {
    return {
      available: true,
      reason: `Leads object readable (${records.recordsRead} record(s) read, ${properties.total} properties)`,
    };
  }
  const failed = records.status !== 'ok' ? records : properties;
  if (failed.status === 'ok') return { available: true, reason: 'Leads object readable' };
  if (failed.status === 'missing_scopes') {
    return {
      available: false,
      reason: `Token lacks scope(s) for Leads: ${failed.requiredScopes?.join(', ') ?? 'see message'}`,
    };
  }
  return {
    available: false,
    reason: `Leads object not readable (${failed.status}${failed.httpStatus ? ` ${failed.httpStatus}` : ''}${
      failed.category ? `, ${failed.category}` : ''
    }): ${failed.message}. The Leads object requires Sales Hub Professional or Enterprise.`,
  };
}
