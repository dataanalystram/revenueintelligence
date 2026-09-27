import type {
  CrmAccount,
  CrmAssociationReadResult,
  CrmListOptions,
  CrmObjectKind,
  CrmReader,
  CrmSnapshotFor,
  ExternalAssociationType,
  ExternalFieldDefinition,
  Page,
} from '../../domain';
import type { HubSpotReader } from '../infrastructure/hubspot-reader';
import type { HubSpotObjectType } from '../infrastructure/mappers';

/** Canonical object kind → HubSpot object type. The only place this mapping lives. */
export const HUBSPOT_OBJECT_FOR_KIND = {
  person: 'contacts',
  company: 'companies',
  lead: 'leads',
} as const satisfies Record<CrmObjectKind, HubSpotObjectType>;

/**
 * HubSpot behind the vendor-neutral CrmReader port. A thin translation: HubSpot
 * object names, record ids and payloads stay inside the connector module.
 */
export class HubSpotCrmReader implements CrmReader {
  readonly system = 'hubspot' as const;

  constructor(private readonly reader: HubSpotReader) {}

  /** Requests made so far (`METHOD /path/{id}` → count), for discovery reports. */
  endpointsUsed(): Readonly<Record<string, number>> {
    return this.reader.endpointsUsed();
  }

  /**
   * HubSpot-specific diagnostic (not part of CrmReader): whether the Account
   * Information API answers at another date-based version.
   */
  async probeAccountInfoVersion(version: string): Promise<void> {
    await this.reader.getAccount(version);
  }

  async getAccount(): Promise<CrmAccount> {
    const a = await this.reader.getAccount();
    return {
      system: 'hubspot',
      accountId: a.portalId,
      accountType: a.accountType,
      timeZone: a.timeZone,
      currency: a.currency,
      dataHostingLocation: a.dataHostingLocation,
    };
  }

  async listRecords<K extends CrmObjectKind>(
    kind: K,
    options: CrmListOptions = {},
  ): Promise<Page<CrmSnapshotFor[K]>> {
    const page = await this.reader.listRecords(HUBSPOT_OBJECT_FOR_KIND[kind], {
      limit: options.limit,
      after: options.after,
      properties: options.fields,
    });
    return page;
  }

  async getRecord<K extends CrmObjectKind>(
    kind: K,
    id: string,
    fields?: readonly string[],
  ): Promise<CrmSnapshotFor[K] | undefined> {
    const record = await this.reader.getRecord(HUBSPOT_OBJECT_FOR_KIND[kind], id, fields);
    return record;
  }

  listFieldDefinitions(kind: CrmObjectKind): Promise<ExternalFieldDefinition[]> {
    return this.reader.listProperties(HUBSPOT_OBJECT_FOR_KIND[kind]);
  }

  listAssociationTypes(from: CrmObjectKind, to: CrmObjectKind): Promise<ExternalAssociationType[]> {
    return this.reader.listAssociationTypes(
      HUBSPOT_OBJECT_FOR_KIND[from],
      HUBSPOT_OBJECT_FOR_KIND[to],
    );
  }

  readAssociations(
    from: CrmObjectKind,
    ids: readonly string[],
    to: CrmObjectKind,
  ): Promise<CrmAssociationReadResult> {
    return this.reader.readAssociations(
      HUBSPOT_OBJECT_FOR_KIND[from],
      ids,
      HUBSPOT_OBJECT_FOR_KIND[to],
    );
  }
}
