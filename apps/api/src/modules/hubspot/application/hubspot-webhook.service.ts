import { systemActor } from '../../domain';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { RECEIPTS_STORED_LISTENER, type ReceiptsStoredListener } from '../../crm';
import { SECRET_PROVIDER, type SecretProvider } from '../../../platform/secrets';
import {
  OAuthAccountRouter,
  RecordNotFoundError,
  TenantConfigService,
  isEnabled,
  SecurityEventsService,
  AuditTrail,
  WriteAuthorizer,
  type TenantContext,
} from '../../tenancy';
import { HUBSPOT_CONFIG, type HubSpotConfig } from '../hubspot.config';
import { WebhookReceiptRepository } from '../infrastructure/webhook-receipt.repository';
import { parseWebhookBatch, type WebhookEvent } from '../infrastructure/webhook-events';
import { externalRequestUri, verifySignatureV3 } from '../infrastructure/webhook-signature';
import { HUBSPOT_APP_CLIENT_SECRET } from './hubspot-oauth.service';

export interface WebhookRequest {
  readonly method: string;
  /** Path and query as received (e.g. `/webhooks/hubspot?x=1`). */
  readonly originalUrl: string;
  readonly rawBody: Buffer;
  readonly signatureV3: string | undefined;
  readonly timestamp: string | undefined;
  /** A v1/v2 signature header was present (never accepted; logged as the reason). */
  readonly legacySignature: boolean;
}

export type UnroutableReason = 'unknown_account' | 'ambiguous_account' | 'tenant_not_eligible';

export type WebhookOutcome =
  | {
      readonly status: 200;
      readonly body: {
        readonly status: 'accepted';
        readonly events: number;
        readonly stored: number;
        readonly duplicates: number;
        readonly unroutable: number;
      };
    }
  | {
      readonly status: 400 | 401 | 403 | 503;
      readonly body: { readonly status: 'error'; readonly reason: string };
    };

/**
 * HubSpot webhook intake (ADR 0011). Verifies, routes and records. No CRM
 * reads and no processing here: newly stored receipts are only handed to the
 * M6 listener, which queues them (processing happens in the worker).
 *
 * 1. Signature v3 only, over the raw body and the configured public URL,
 *    with timestamp freshness; v1/v2 are refused.
 * 2. Zod validation; every event must carry this app's id.
 * 3. Routing by HubSpot account: only an active tenant with an OAuth grant
 *    for that account whose HubSpot integration is enabled, in OAuth mode and
 *    configured for that account. Unknown or ambiguous accounts are never
 *    guessed: their events are acknowledged and logged as unroutable.
 * 4. One receipt per event (identifiers only), de-duplicated atomically.
 */
@Injectable()
export class HubSpotWebhookService {
  private readonly logger = new Logger(HubSpotWebhookService.name);

  constructor(
    @Inject(HUBSPOT_CONFIG) private readonly config: HubSpotConfig,
    @Inject(SECRET_PROVIDER) private readonly secrets: SecretProvider,
    private readonly router: OAuthAccountRouter,
    private readonly tenantConfig: TenantConfigService,
    private readonly receipts: WebhookReceiptRepository,
    private readonly authorizer: WriteAuthorizer,
    private readonly audit: AuditTrail,
    /** M6: queues new receipts for processing; absent in contexts that only record. */
    @Optional()
    @Inject(RECEIPTS_STORED_LISTENER)
    private readonly listener?: ReceiptsStoredListener,
    /** M10A1: security events (codes only); absent in contexts without the tenancy module. */
    @Optional() private readonly securityEvents?: SecurityEventsService,
  ) {}

  async receive(req: WebhookRequest, now: number = Date.now()): Promise<WebhookOutcome> {
    const { appId, targetUrl } = this.config.webhooks;
    const clientSecret = await this.secrets.find(HUBSPOT_APP_CLIENT_SECRET);
    if (!appId || !targetUrl || !clientSecret) {
      this.logger.error({
        msg: 'HubSpot webhook refused: not configured (HUBSPOT_APP_ID, HUBSPOT_WEBHOOK_TARGET_URL, HUBSPOT_APP_CLIENT_SECRET)',
      });
      return fail(503, 'not_configured');
    }

    const check = verifySignatureV3({
      clientSecret: clientSecret.reveal(),
      method: req.method,
      uri: externalRequestUri(targetUrl, req.originalUrl),
      rawBody: req.rawBody,
      signature: req.signatureV3,
      timestamp: req.timestamp,
      now,
    });
    if (!check.ok) {
      const reason =
        check.reason === 'missing_signature' && req.legacySignature
          ? 'unsupported_signature_version'
          : check.reason;
      this.logger.warn({
        msg: 'HubSpot webhook refused: signature',
        reason,
        bytes: req.rawBody.length,
      });
      this.securityEvents?.emit({
        event: 'webhook_signature_invalid',
        outcome: 'refused',
        reasonCode: reason,
      });
      return fail(401, 'invalid_signature');
    }

    const batch = parseWebhookBatch(req.rawBody);
    if (!batch.ok) {
      this.logger.warn({ msg: 'HubSpot webhook refused: payload', issues: batch.issues });
      return fail(400, 'invalid_payload');
    }
    if (batch.events.some((e) => e.appId !== appId)) {
      this.logger.warn({
        msg: 'HubSpot webhook refused: events for another app',
        appIds: [...new Set(batch.events.map((e) => e.appId))],
      });
      return fail(403, 'app_mismatch');
    }

    let stored = 0;
    let duplicates = 0;
    let unroutable = 0;
    // One id per delivery request, carried on every receipt, job, log line and
    // provenance row it leads to (M6).
    const correlationId = randomUUID();
    for (const [accountId, events] of groupByAccount(batch.events)) {
      const target = await this.target(accountId);
      if (!target.ok) {
        unroutable += events.length;
        this.logger.warn({
          msg: 'HubSpot webhook events not routed',
          accountId,
          reason: target.reason,
          events: events.length,
        });
        continue;
      }
      // M10A1 (plan §4, §5): the intake's system actor is authorized for
      // processing.receipt; one audit event per tenant batch, in the same transaction.
      const actx = await this.authorizer.authorize(
        target.ctx,
        systemActor('api:webhook-intake'),
        'processing.receipt',
        { action: 'webhook.receipts.store', targetKind: 'context', correlationId },
      );
      const recorded = await this.receipts.record(
        target.ctx,
        events,
        new Date(now),
        correlationId,
        (tx, r) =>
          this.audit.record(tx, actx, {
            action: 'webhook.receipts.store',
            targetKind: 'context',
            details: { events: events.length, stored: r.stored, duplicates: r.duplicates },
          }),
      );
      if (recorded.storedKeys.length > 0 && this.listener) {
        // Best effort after commit: a failure leaves the receipts pending for the sweep.
        await this.listener
          .receiptsStored(target.ctx, 'hubspot', recorded.storedKeys, correlationId)
          .catch((err: unknown) =>
            this.logger.warn({ err, correlationId }, 'Receipts stored but not queued'),
          );
      }
      stored += recorded.stored;
      duplicates += recorded.duplicates;
      this.logger.log({
        msg: 'HubSpot webhook events recorded',
        tenantId: target.ctx.tenantId,
        correlationId,
        accountId,
        events: events.length,
        stored: recorded.stored,
        duplicates: recorded.duplicates,
        types: [...new Set(events.map((e) => e.subscriptionType))],
        attempts: [...new Set(events.map((e) => e.attemptNumber))],
      });
    }
    return {
      status: 200,
      body: { status: 'accepted', events: batch.events.length, stored, duplicates, unroutable },
    };
  }

  private async target(
    accountId: string,
  ): Promise<{ ok: true; ctx: TenantContext } | { ok: false; reason: UnroutableReason }> {
    const route = await this.router.route('hubspot', accountId);
    if (route.kind === 'unknown') return { ok: false, reason: 'unknown_account' };
    if (route.kind === 'ambiguous') return { ok: false, reason: 'ambiguous_account' };
    // The grant alone is not enough: the tenant must still use OAuth for this very account.
    try {
      const integration = await this.tenantConfig.getIntegration(route.ctx, 'hubspot');
      if (
        !isEnabled(integration) ||
        integration.settings.auth !== 'oauth' ||
        integration.settings.portalId !== accountId
      ) {
        return { ok: false, reason: 'tenant_not_eligible' };
      }
    } catch (err) {
      if (err instanceof RecordNotFoundError) return { ok: false, reason: 'tenant_not_eligible' };
      throw err;
    }
    return { ok: true, ctx: route.ctx };
  }
}

function fail(status: 400 | 401 | 403 | 503, reason: string): WebhookOutcome {
  return { status, body: { status: 'error', reason } };
}

function groupByAccount(events: readonly WebhookEvent[]): Map<string, WebhookEvent[]> {
  const groups = new Map<string, WebhookEvent[]>();
  for (const e of events) {
    const list = groups.get(e.accountId);
    if (list) list.push(e);
    else groups.set(e.accountId, [e]);
  }
  return groups;
}
