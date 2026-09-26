import type {
  ExternalAssociation,
  ExternalAssociationType,
  ExternalFieldDefinition,
  Page,
} from '../../domain';
import { HubSpotError } from '../errors';
import type { HubSpotConfig } from '../hubspot.config';
import type { z } from 'zod';
import type { HubSpotAuth, HubSpotHttpClient, HubSpotRequest } from './http-client';
import {
  toAssociationType,
  toFieldDefinition,
  toRecordSnapshot,
  type HubSpotObjectType,
  type SnapshotFor,
} from './mappers';
import {
  HsAccountDetailsSchema,
  HsAssociationBatchReadSchema,
  HsAssociationLabelListSchema,
  HsObjectPageSchema,
  HsObjectSchema,
  HsPropertyListSchema,
} from './schemas';

/** The HubSpot account (portal) a token belongs to. */
export interface HubSpotAccount {
  readonly portalId: string;
  /** e.g. STANDARD, DEVELOPER_TEST, SANDBOX, APP_DEVELOPER. */
  readonly accountType: string | undefined;
  readonly timeZone: string | undefined;
  readonly currency: string | undefined;
  readonly dataHostingLocation: string | undefined;
}

export interface ListOptions {
  /** 1–100 (HubSpot's maximum page size for object lists). */
  readonly limit?: number;
  readonly after?: string;
  /** Properties to return; HubSpot's default set when omitted. */
  readonly properties?: readonly string[];
}

/** A per-input failure HubSpot reported in a batch association read. */
export interface AssociationReadFailure {
  readonly category: string | undefined;
  readonly subCategory: string | undefined;
  readonly message: string | undefined;
  /** Input record ids the failure applies to, when HubSpot says. */
  readonly ids: readonly string[];
}

export interface AssociationReadResult {
  readonly associations: ExternalAssociation[];
  /** Input records HubSpot says have no associations of this type (not a failure). */
  readonly withoutAssociations: string[];
  /** Any other per-record error HubSpot reported. */
  readonly failures: AssociationReadFailure[];
}

/** HubSpot's per-record "no associations" result inside a 207 (seen live). */
const NO_ASSOCIATIONS_FOUND = 'crm.associations.NO_ASSOCIATIONS_FOUND';

/** Largest id list per association batch read (HubSpot allows 1,000). */
const ASSOCIATION_BATCH_SIZE = 100;
/** Safety bound on association pages followed per record. */
const MAX_ASSOCIATION_PAGES = 20;

/**
 * Read-only access to one tenant's HubSpot account. Instances are created by
 * `HubSpotConnector.forTenant(ctx)` and bound to that tenant's token and rate
 * budget; they never see another tenant's credentials.
 */
export class HubSpotReader {
  private readonly requestLog = new Map<string, number>();

  constructor(
    private readonly http: HubSpotHttpClient,
    private readonly config: HubSpotConfig,
    private readonly auth: HubSpotAuth,
  ) {}

  private get v(): string {
    return this.config.apiVersion;
  }

  /** Every request this reader made, as `METHOD /path/with/{id}` → count. */
  endpointsUsed(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.requestLog);
  }

  private async send<T>(req: HubSpotRequest, schema: z.ZodType<T>): Promise<T> {
    const template = req.path
      .split('/')
      .map((segment) => (/^\d+$/.test(segment) ? '{id}' : segment))
      .join('/');
    const key = `${req.method} ${template}`;
    this.requestLog.set(key, (this.requestLog.get(key) ?? 0) + 1);
    return await this.http.send(req, schema, this.auth);
  }

  /** Account details, from the Account Information API (date-based version). */
  async getAccount(version: string = this.config.accountInfoApiVersion): Promise<HubSpotAccount> {
    const d = await this.send(
      { method: 'GET', path: `/account-info/${version}/details` },
      HsAccountDetailsSchema,
    );
    return {
      portalId: String(d.portalId),
      accountType: d.accountType,
      timeZone: d.timeZone,
      currency: d.companyCurrency,
      dataHostingLocation: d.dataHostingLocation,
    };
  }

  async listRecords<K extends HubSpotObjectType>(
    objectType: K,
    options: ListOptions = {},
  ): Promise<Page<SnapshotFor[K]>> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('limit must be an integer from 1 to 100');
    }
    const page = await this.send(
      {
        method: 'GET',
        path: `/crm/objects/${this.v}/${objectType}`,
        query: {
          limit: String(limit),
          after: options.after,
          properties: options.properties?.length ? options.properties : undefined,
          archived: 'false',
        },
      },
      HsObjectPageSchema,
    );
    const nextCursor = page.paging?.next?.after;
    if (nextCursor !== undefined && nextCursor === options.after) {
      throw new HubSpotError('invalid_payload', 'HubSpot returned the same paging cursor twice', {
        path: `/crm/objects/${this.v}/${objectType}`,
      });
    }
    return {
      items: page.results.map((o) => toRecordSnapshot(objectType, o)),
      nextCursor,
    };
  }

  /** Follows paging cursors, at most `maxPages` pages. */
  async *iterateRecords<K extends HubSpotObjectType>(
    objectType: K,
    options: ListOptions & { readonly maxPages: number },
  ): AsyncGenerator<Page<SnapshotFor[K]>> {
    let after = options.after;
    for (let page = 0; page < options.maxPages; page += 1) {
      const result = await this.listRecords(objectType, { ...options, after });
      yield result;
      if (!result.nextCursor) return;
      after = result.nextCursor;
    }
  }

  /** One record by id, or undefined if HubSpot has no such record. */
  async getRecord<K extends HubSpotObjectType>(
    objectType: K,
    id: string,
    properties?: readonly string[],
  ): Promise<SnapshotFor[K] | undefined> {
    if (!/^\d{1,20}$/.test(id)) throw new RangeError('HubSpot record ids are numeric');
    try {
      const o = await this.send(
        {
          method: 'GET',
          path: `/crm/objects/${this.v}/${objectType}/${id}`,
          query: { properties: properties?.length ? properties : undefined, archived: 'false' },
        },
        HsObjectSchema,
      );
      return toRecordSnapshot(objectType, o);
    } catch (err) {
      if (err instanceof HubSpotError && err.kind === 'not_found') return undefined;
      throw err;
    }
  }

  async listProperties(objectType: HubSpotObjectType): Promise<ExternalFieldDefinition[]> {
    const list = await this.send(
      {
        method: 'GET',
        path: `/crm/properties/${this.v}/${objectType}`,
        query: { archived: 'false' },
      },
      HsPropertyListSchema,
    );
    return list.results.map((p) => toFieldDefinition(objectType, p));
  }

  /** Association types (labels) defined between two object types. */
  async listAssociationTypes(
    from: HubSpotObjectType,
    to: HubSpotObjectType,
  ): Promise<ExternalAssociationType[]> {
    const list = await this.send(
      { method: 'GET', path: `/crm/associations/${this.v}/${from}/${to}/labels` },
      HsAssociationLabelListSchema,
    );
    return list.results.map(toAssociationType);
  }

  /**
   * Associations of the given records to records of another type (all pages).
   * HubSpot reports per-input failures inside a successful (207) response;
   * they are returned as `failures`, never silently dropped.
   */
  async readAssociations(
    from: HubSpotObjectType,
    ids: readonly string[],
    to: HubSpotObjectType,
  ): Promise<AssociationReadResult> {
    for (const id of ids) {
      if (!/^\d{1,20}$/.test(id)) throw new RangeError('HubSpot record ids are numeric');
    }
    const path = `/crm/associations/${this.v}/${from}/${to}/batch/read`;
    const out: ExternalAssociation[] = [];
    const failures: AssociationReadFailure[] = [];
    const withoutAssociations: string[] = [];
    for (let i = 0; i < ids.length; i += ASSOCIATION_BATCH_SIZE) {
      let inputs = ids
        .slice(i, i + ASSOCIATION_BATCH_SIZE)
        .map((id) => ({ id, after: undefined as string | undefined }));
      for (let page = 0; inputs.length > 0; page += 1) {
        if (page >= MAX_ASSOCIATION_PAGES) {
          throw new HubSpotError('invalid_payload', 'Too many association pages; aborting', {
            path,
          });
        }
        const batch = await this.send(
          {
            method: 'POST',
            path,
            body: { inputs: inputs.map((x) => (x.after ? x : { id: x.id })) },
          },
          HsAssociationBatchReadSchema,
        );
        for (const e of batch.errors ?? []) {
          const errorIds = e.context?.fromObjectId ?? e.context?.ids ?? [];
          if (e.subCategory === NO_ASSOCIATIONS_FOUND && errorIds.length > 0) {
            for (const id of errorIds)
              if (!withoutAssociations.includes(id)) withoutAssociations.push(id);
            continue;
          }
          const failure = {
            category: e.category,
            subCategory: e.subCategory,
            message: e.message,
            ids: errorIds,
          };
          // The same record can fail again on a later paging round: report it once.
          const key = JSON.stringify(failure);
          if (!failures.some((f) => JSON.stringify(f) === key)) failures.push(failure);
        }
        const next: typeof inputs = [];
        for (const result of batch.results) {
          for (const link of result.to) {
            out.push({
              from: { system: 'hubspot', objectType: from, id: result.from.id },
              to: { system: 'hubspot', objectType: to, id: link.toObjectId },
              types: link.associationTypes.map(toAssociationType),
            });
          }
          const after = result.paging?.next?.after;
          if (after) next.push({ id: result.from.id, after });
        }
        inputs = next;
      }
    }
    return { associations: out, withoutAssociations, failures };
  }
}
