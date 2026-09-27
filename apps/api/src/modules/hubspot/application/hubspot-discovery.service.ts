import { Inject, Injectable } from '@nestjs/common';
import {
  CRM_OBJECT_KINDS,
  type CrmObjectKind,
  type CrmReader,
  type ExternalAssociation,
  type ExternalAssociationType,
  type ExternalFieldDefinition,
} from '../../domain';
import type { TenantContext } from '../../tenancy';
import { HubSpotError } from '../errors';
import { HUBSPOT_CONFIG, type HubSpotConfig } from '../hubspot.config';
import type { HubSpotAccount } from '../infrastructure/hubspot-reader';
import { HUBSPOT_DEFAULT_PROPERTIES, type HubSpotObjectType } from '../infrastructure/mappers';
import { HubSpotConnector } from './hubspot-connector.service';
import { HUBSPOT_OBJECT_FOR_KIND } from './hubspot-crm-reader';

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
  /** Records HubSpot reported as having no associations of this type. */
  readonly recordsWithoutAssociations: number;
  readonly associations: number;
  readonly typesSeen: readonly ExternalAssociationType[];
  /** Per-record failures HubSpot reported inside the batch response. */
  readonly failures: readonly {
    readonly category: string | undefined;
    readonly subCategory: string | undefined;
    readonly message: string | undefined;
    readonly records: number;
  }[];
  /** Which records were checked: the sampled records, or those linked from another object. */
  readonly sampledFrom: string;
  /**
   * Reverse-direction samples only: of the forward links (e.g. lead → contact),
   * how many HubSpot also returns in this direction (contact → the same lead).
   */
  readonly reciprocal?: { readonly forwardLinks: number; readonly confirmed: number };
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
  /**
   * Whether the Account Information API answers at each date-based version
   * probed (the configured one and the CRM version), so the account-info
   * version can be moved up with evidence.
   */
  readonly accountInfoVersions: Readonly<Record<string, Probe<Record<never, never>>>>;
  /** Every HubSpot request discovery made (`METHOD /path/{id}` → count). */
  readonly endpointsUsed: Readonly<Record<string, number>>;
  /**
   * How discovery read the account: through the vendor-neutral CrmReader port
   * (ADR 0010), asking for canonical kinds mapped to these HubSpot objects.
   */
  readonly readThrough: {
    readonly port: 'CrmReader';
    readonly system: string;
    readonly objectKinds: Readonly<Record<HubSpotObjectType, CrmObjectKind>>;
  };
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

type KindPair = readonly [CrmObjectKind, CrmObjectKind];

const LABEL_PAIRS: readonly KindPair[] = [
  ['lead', 'person'],
  ['lead', 'company'],
  ['person', 'lead'],
  ['company', 'lead'],
  ['person', 'company'],
  ['company', 'person'],
];

const SAMPLE_PAIRS: readonly KindPair[] = [
  ['lead', 'person'],
  ['lead', 'company'],
  ['person', 'company'],
];

/** Reverse of the Lead pairs: sampled from the records the Leads link to. */
const REVERSE_PAIRS: readonly KindPair[] = [
  ['person', 'lead'],
  ['company', 'lead'],
];

const native = (kind: CrmObjectKind): HubSpotObjectType => HUBSPOT_OBJECT_FOR_KIND[kind];

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

    // Every read below goes through the vendor-neutral CrmReader port.
    const crm: CrmReader = reader;
    const objects = {} as Record<
      HubSpotObjectType,
      { records: Probe<RecordsProbe>; properties: Probe<PropertiesProbe> }
    >;
    for (const kind of CRM_OBJECT_KINDS) {
      objects[native(kind)] = {
        records: await run(() => this.probeRecords(crm, kind, pageSize, maxPages)),
        properties: await run(() => this.probeProperties(crm, kind)),
      };
    }

    const associationLabels = [];
    for (const [from, to] of LABEL_PAIRS) {
      associationLabels.push({
        from: native(from),
        to: native(to),
        result: await run(async () => ({ types: await crm.listAssociationTypes(from, to) })),
      });
    }

    const associationSamples = [];
    const forwardLinks = new Map<string, ExternalAssociation[]>();
    for (const [from, to] of SAMPLE_PAIRS) {
      const source = objects[native(from)].records;
      const ids = source.status === 'ok' ? source.sampleIds : [];
      associationSamples.push({
        from: native(from),
        to: native(to),
        result:
          source.status === 'ok'
            ? await run(async () => {
                const { probe, links } = await this.probeAssociations(crm, from, ids, to);
                forwardLinks.set(`${from}->${to}`, links);
                return { ...probe, sampledFrom: `sampled ${native(from)} records` };
              })
            : ({
                status: 'error',
                message: `not probed: reading ${native(from)} failed (${source.status})`,
              } as const),
      });
    }
    // Reverse directions, checked on exactly the records the sampled Leads are
    // linked to, so a Lead's contact and company are always among those read.
    for (const [from, to] of REVERSE_PAIRS) {
      const forward = forwardLinks.get(`${to}->${from}`);
      associationSamples.push({
        from: native(from),
        to: native(to),
        result: forward
          ? await run(async () => {
              const ids = [...new Set(forward.map((l) => l.to.id))];
              const { probe, links } = await this.probeAssociations(crm, from, ids, to);
              const reverse = new Set(links.map((l) => `${l.from.id}->${l.to.id}`));
              return {
                ...probe,
                sampledFrom: `${native(from)} linked from sampled ${native(to)}`,
                reciprocal: {
                  forwardLinks: forward.length,
                  confirmed: forward.filter((l) => reverse.has(`${l.to.id}->${l.from.id}`)).length,
                },
              };
            })
          : ({
              status: 'error',
              message: `not probed: ${native(to)} → ${native(from)} was not read`,
            } as const),
      });
    }

    const accountInfoVersions: Record<string, Probe<Record<never, never>>> = {
      [this.config.accountInfoApiVersion]: { status: 'ok' },
    };
    if (this.config.apiVersion !== this.config.accountInfoApiVersion) {
      accountInfoVersions[this.config.apiVersion] = await run(async () => {
        await reader.probeAccountInfoVersion(this.config.apiVersion);
        return {};
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
      accountInfoVersions,
      endpointsUsed: reader.endpointsUsed(),
      readThrough: {
        port: 'CrmReader',
        system: crm.system,
        objectKinds: Object.fromEntries(CRM_OBJECT_KINDS.map((k) => [native(k), k])) as Record<
          HubSpotObjectType,
          CrmObjectKind
        >,
      },
    };
  }

  private async probeRecords(
    crm: CrmReader,
    kind: CrmObjectKind,
    pageSize: number,
    maxPages: number,
  ): Promise<RecordsProbe> {
    const type = native(kind);
    const ids: string[] = [];
    let pagesRead = 0;
    let morePages = false;
    let paginationVerified = false;
    let after: string | undefined;
    for (let n = 0; n < maxPages; n += 1) {
      const page = await crm.listRecords(kind, { limit: pageSize, after });
      pagesRead += 1;
      const fresh = page.items.map((r) => r.ref.id).filter((id) => !ids.includes(id));
      if (pagesRead > 1 && fresh.length > 0) paginationVerified = true;
      if (pagesRead > 1 && fresh.length < page.items.length) {
        throw new HubSpotError('invalid_payload', `Paging returned duplicate ${type} records`);
      }
      ids.push(...fresh);
      morePages = page.nextCursor !== undefined;
      if (!page.nextCursor) break;
      after = page.nextCursor;
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

  private async probeProperties(crm: CrmReader, kind: CrmObjectKind): Promise<PropertiesProbe> {
    const type = native(kind);
    const fields = await crm.listFieldDefinitions(kind);
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
    crm: CrmReader,
    from: CrmObjectKind,
    ids: readonly string[],
    to: CrmObjectKind,
  ): Promise<{
    probe: Omit<AssociationSampleProbe, 'sampledFrom' | 'reciprocal'>;
    links: ExternalAssociation[];
  }> {
    const {
      associations: links,
      withoutAssociations,
      failures,
    } = ids.length
      ? await crm.readAssociations(from, ids, to)
      : { associations: [], withoutAssociations: [], failures: [] };
    const types = new Map<string, ExternalAssociationType>();
    for (const link of links) for (const t of link.types) types.set(`${t.category}:${t.typeId}`, t);
    const probe = {
      recordsChecked: ids.length,
      recordsWithAssociations: new Set(links.map((l) => l.from.id)).size,
      recordsWithoutAssociations: withoutAssociations.length,
      associations: links.length,
      typesSeen: [...types.values()].sort((a, b) => a.typeId - b.typeId),
      failures: failures.map((f) => ({
        category: f.category,
        subCategory: f.subCategory,
        message: f.message,
        records: f.ids.length,
      })),
    };
    return { probe, links };
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
