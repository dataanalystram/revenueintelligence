import { z } from 'zod';
import type { ExternalSystem } from './external-ref';
import type {
  ExternalAssociation,
  ExternalAssociationType,
  ExternalCompanySnapshot,
  ExternalFieldDefinition,
  ExternalLeadSnapshot,
  ExternalPersonSnapshot,
  Page,
} from './external-snapshots';

/**
 * Vendor-neutral read access to a tenant's CRM (ADR 0010). Business code asks
 * for canonical object kinds and receives vendor-neutral snapshots; which CRM
 * answers (HubSpot today) and how it authenticates are connector concerns.
 */
export const CrmObjectKindSchema = z.enum(['person', 'company', 'lead']);
export type CrmObjectKind = z.infer<typeof CrmObjectKindSchema>;
export const CRM_OBJECT_KINDS = CrmObjectKindSchema.options;

export interface CrmSnapshotFor {
  person: ExternalPersonSnapshot;
  company: ExternalCompanySnapshot;
  lead: ExternalLeadSnapshot;
}

/** The CRM account a reader is bound to. */
export interface CrmAccount {
  readonly system: ExternalSystem;
  /** The CRM's own account id (HubSpot: the portal id). */
  readonly accountId: string;
  readonly accountType: string | undefined;
  readonly timeZone: string | undefined;
  readonly currency: string | undefined;
  readonly dataHostingLocation: string | undefined;
}

export interface CrmListOptions {
  /** 1–100. */
  readonly limit?: number;
  /** Opaque cursor from a previous page. */
  readonly after?: string;
  /** External field names to return; the CRM's default set when omitted. */
  readonly fields?: readonly string[];
}

/** A per-record failure the CRM reported inside an otherwise successful read. */
export interface CrmReadFailure {
  readonly category: string | undefined;
  readonly subCategory: string | undefined;
  readonly message: string | undefined;
  readonly ids: readonly string[];
}

export interface CrmAssociationReadResult {
  readonly associations: ExternalAssociation[];
  /** Requested records that have no associations of this kind (not a failure). */
  readonly withoutAssociations: string[];
  /** Any other per-record failure; never silently dropped. */
  readonly failures: CrmReadFailure[];
}

/**
 * Read-only CRM access bound to one tenant and one account. Implementations
 * never write. Failures are `ConnectorError`s.
 */
export interface CrmReader {
  readonly system: ExternalSystem;
  getAccount(): Promise<CrmAccount>;
  listRecords<K extends CrmObjectKind>(
    kind: K,
    options?: CrmListOptions,
  ): Promise<Page<CrmSnapshotFor[K]>>;
  /** undefined when the CRM has no such record. */
  getRecord<K extends CrmObjectKind>(
    kind: K,
    id: string,
    fields?: readonly string[],
  ): Promise<CrmSnapshotFor[K] | undefined>;
  listFieldDefinitions(kind: CrmObjectKind): Promise<ExternalFieldDefinition[]>;
  listAssociationTypes(from: CrmObjectKind, to: CrmObjectKind): Promise<ExternalAssociationType[]>;
  readAssociations(
    from: CrmObjectKind,
    ids: readonly string[],
    to: CrmObjectKind,
  ): Promise<CrmAssociationReadResult>;
}
