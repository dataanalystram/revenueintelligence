import type { ContextKind, CrmReader, ExternalSystem } from '../domain';
import type { TenantContext, TenantTransaction } from '../tenancy';

/**
 * CRM connector port (ADR 0010). Business code injects `CRM_CONNECTOR` and
 * receives a tenant-bound, read-only `CrmReader`; it never imports a CRM
 * connector module (dependency-cruiser enforces this). The connector module
 * registered at the composition root (HubSpot today) provides the token.
 */
export interface CrmConnector {
  /**
   * A reader bound to this tenant's configured CRM account. Rejects with a
   * ConnectorError when the integration is disabled, not configured, not
   * authorised, or the credentials belong to a different account.
   */
  forTenant(ctx: TenantContext): Promise<CrmReader>;
}

export const CRM_CONNECTOR = Symbol('CRM_CONNECTOR');

// ---------------------------------------------------------------------------
// Durable source-event receipts (M6, ADR 0013). The connector owns its
// receipts table and its vendor's event vocabulary; context processing sees
// only these vendor-neutral shapes.
// ---------------------------------------------------------------------------

export type ReceiptStatus =
  | 'pending'
  | 'processing'
  | 'retrying'
  | 'processed'
  | 'ineligible'
  | 'deferred'
  | 'irrelevant'
  | 'source_not_found'
  | 'dead_lettered';

/** Statuses that end processing; a receipt in one of these is never claimed again. */
export const TERMINAL_RECEIPT_STATUSES: readonly ReceiptStatus[] = [
  'processed',
  'ineligible',
  'deferred',
  'irrelevant',
  'source_not_found',
  'dead_lettered',
];

/** A stored receipt: identifiers, times and processing state only. */
export interface SourceReceipt {
  readonly system: ExternalSystem;
  readonly deliveryKey: string;
  readonly subscriptionType: string;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly status: ReceiptStatus;
  readonly reason: string | undefined;
  readonly attempts: number;
  readonly correlationId: string | undefined;
}

/** What processing a receipt means, decided by the connector (eligibility + translation). */
export type ReceiptPlan =
  | {
      readonly action: 'sync';
      /** Records to read back and ingest (deletions and restores included: read-back decides). */
      readonly subjects: readonly { readonly kind: ContextKind; readonly externalId: string }[];
    }
  | {
      readonly action: 'merge';
      readonly kind: ContextKind;
      readonly survivorId: string;
      readonly mergedIds: readonly string[];
    }
  | {
      readonly action: 'skip';
      readonly status: Extract<ReceiptStatus, 'ineligible' | 'deferred' | 'irrelevant'>;
      /** Short reason code, e.g. account_mismatch, lead_out_of_scope. */
      readonly reason: string;
    };

export interface ReceiptListFilter {
  readonly statuses: readonly ReceiptStatus[];
  readonly receivedFrom?: Date;
  readonly receivedTo?: Date;
  /** Exclude receipts with this processing reason (e.g. pre_m6 from the sweep). */
  readonly excludeReason?: string;
  /** Only receipts with this processing reason. */
  readonly onlyReason?: string;
  readonly limit: number;
}

export interface CrmReceiptSource {
  readonly system: ExternalSystem;
  load(tx: TenantTransaction, deliveryKey: string): Promise<SourceReceipt | undefined>;
  /** pending/retrying/processing → processing, attempts + 1; false if already finished. */
  claim(tx: TenantTransaction, deliveryKey: string): Promise<boolean>;
  finish(
    tx: TenantTransaction,
    deliveryKey: string,
    status: ReceiptStatus,
    reason?: string,
  ): Promise<void>;
  /** Resets finished or failed receipts to pending (explicit replay only). */
  reset(tx: TenantTransaction, deliveryKeys: readonly string[]): Promise<number>;
  list(ctx: TenantContext, filter: ReceiptListFilter): Promise<SourceReceipt[]>;
  plan(ctx: TenantContext, receipt: SourceReceipt): Promise<ReceiptPlan>;
}

export const CRM_RECEIPT_SOURCE = Symbol('CRM_RECEIPT_SOURCE');

/** Told after new receipts commit, so they can be queued (best effort; the sweep is the safety net). */
export interface ReceiptsStoredListener {
  receiptsStored(
    ctx: TenantContext,
    system: ExternalSystem,
    deliveryKeys: readonly string[],
    correlationId: string,
  ): Promise<void>;
}

export const RECEIPTS_STORED_LISTENER = Symbol('RECEIPTS_STORED_LISTENER');
