import { Inject, Injectable } from '@nestjs/common';
import type {
  CrmReceiptSource,
  ReceiptListFilter,
  ReceiptPlan,
  ReceiptStatus,
  SourceReceipt,
} from '../../crm';
import type { ContextKind } from '../../domain';
import {
  RecordNotFoundError,
  TenantConfigService,
  isEnabled,
  type TenantContext,
  type TenantTransaction,
} from '../../tenancy';
import { HUBSPOT_CONFIG, type HubSpotConfig } from '../hubspot.config';
import {
  WebhookReceiptRepository,
  type HubSpotReceipt,
} from '../infrastructure/webhook-receipt.repository';

/** HubSpot object type ids → canonical kinds. The only place they are interpreted. */
const KIND_FOR_OBJECT_TYPE: Readonly<Record<string, ContextKind>> = {
  '0-1': 'person',
  '0-2': 'company',
};
const LEAD_OBJECT_TYPE = '0-136';
/** Legacy (non-generic) subscription prefixes. */
const KIND_FOR_LEGACY: Readonly<Record<string, ContextKind>> = {
  contact: 'person',
  company: 'company',
};
/** Events whose subject is read back and ingested (read-back decides presence). */
const SYNC_EVENTS = new Set(['creation', 'propertyChange', 'deletion', 'restore']);

/**
 * HubSpot side of receipt processing (M6, ADR 0013/0015): eligibility and
 * translation of HubSpot event types into vendor-neutral plans. Storage is
 * the M5 receipts table.
 *
 * Eligible receipts come from this app and the tenant's own connected portal
 * and name a contact or company. Leads are deferred (out of M6 scope);
 * anything else is ineligible or irrelevant, with a reason code. A plan never
 * creates canonical data by itself: subjects are read back first.
 */
@Injectable()
export class HubSpotReceiptSource implements CrmReceiptSource {
  readonly system = 'hubspot' as const;

  constructor(
    private readonly receipts: WebhookReceiptRepository,
    private readonly tenantConfig: TenantConfigService,
    @Inject(HUBSPOT_CONFIG) private readonly config: HubSpotConfig,
  ) {}

  load(tx: TenantTransaction, deliveryKey: string): Promise<HubSpotReceipt | undefined> {
    return this.receipts.load(tx, deliveryKey);
  }

  claim(tx: TenantTransaction, deliveryKey: string): Promise<boolean> {
    return this.receipts.claim(tx, deliveryKey);
  }

  finish(
    tx: TenantTransaction,
    deliveryKey: string,
    status: ReceiptStatus,
    reason?: string,
  ): Promise<void> {
    return this.receipts.finish(tx, deliveryKey, status, reason);
  }

  reset(tx: TenantTransaction, deliveryKeys: readonly string[]): Promise<number> {
    return this.receipts.reset(tx, deliveryKeys);
  }

  list(ctx: TenantContext, filter: ReceiptListFilter): Promise<HubSpotReceipt[]> {
    return this.receipts.list(ctx, filter);
  }

  async plan(ctx: TenantContext, receipt: SourceReceipt): Promise<ReceiptPlan> {
    const r = receipt as HubSpotReceipt;
    const portalId = await this.connectedPortal(ctx);
    if (portalId === undefined) return skip('ineligible', 'not_configured');
    if (this.config.webhooks.appId === undefined || r.appId !== this.config.webhooks.appId) {
      return skip('ineligible', 'app_mismatch');
    }
    if (r.accountId !== portalId) return skip('ineligible', 'account_mismatch');
    return planFor(r);
  }

  private async connectedPortal(ctx: TenantContext): Promise<string | undefined> {
    try {
      const integration = await this.tenantConfig.getIntegration(ctx, 'hubspot');
      return isEnabled(integration) ? integration.settings.portalId : undefined;
    } catch (err) {
      if (err instanceof RecordNotFoundError) return undefined;
      throw err;
    }
  }
}

function skip(status: 'ineligible' | 'deferred' | 'irrelevant', reason: string): ReceiptPlan {
  return { action: 'skip', status, reason };
}

/** Pure translation of an eligible receipt (exported for tests). */
export function planFor(r: HubSpotReceipt): ReceiptPlan {
  const [prefix, event] = r.subscriptionType.split('.') as [string, string];
  if (r.objectTypeId === LEAD_OBJECT_TYPE || prefix === 'lead') {
    return skip('deferred', 'lead_out_of_scope');
  }
  const kind =
    prefix === 'object'
      ? r.objectTypeId === undefined
        ? undefined
        : KIND_FOR_OBJECT_TYPE[r.objectTypeId]
      : KIND_FOR_LEGACY[prefix];

  if (event === 'associationChange') {
    const a = r.association;
    const pair = [a.fromObjectTypeId, a.toObjectTypeId].sort().join('|');
    if (pair !== '0-1|0-2') return skip('irrelevant', 'association_out_of_scope');
    const contactId = a.fromObjectTypeId === '0-1' ? a.fromObjectId : a.toObjectId;
    if (contactId === undefined) return skip('ineligible', 'missing_object');
    // Read back the contact's company links; associations stay source context.
    return { action: 'sync', subjects: [{ kind: 'person', externalId: contactId }] };
  }

  if (kind === undefined) return skip('irrelevant', 'unsupported_object');

  if (event === 'merge') {
    const survivor = r.merge.newObjectId ?? r.merge.primaryObjectId;
    const merged = [
      ...new Set([...r.merge.mergedObjectIds, r.merge.primaryObjectId].filter((id) => !!id)),
    ].filter((id): id is string => id !== undefined && id !== survivor);
    if (survivor === undefined || merged.length === 0) return skip('ineligible', 'missing_object');
    return { action: 'merge', kind, survivorId: survivor, mergedIds: merged };
  }

  if (SYNC_EVENTS.has(event)) {
    if (r.objectId === undefined) return skip('ineligible', 'missing_object');
    return { action: 'sync', subjects: [{ kind, externalId: r.objectId }] };
  }
  return skip('irrelevant', 'unsupported_event');
}
