import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RECEIPTS_STORED_LISTENER, type ReceiptsStoredListener } from '../../src/modules/crm';
import {
  BulkSyncService,
  ContextIngestionService,
  ContextOperationsService,
  ContextProcessingService,
} from '../../src/modules/context';
import { WebhookReceiptRepository, parseWebhookBatch } from '../../src/modules/hubspot';
import type { TenantContext } from '../../src/modules/tenancy';
import { loadConfig, type AppConfig } from '../../src/platform/config';
import { MetricsService } from '../../src/platform/metrics';
import { QueueService } from '../../src/platform/queue';
import { EnvSecretProvider } from '../../src/platform/secrets';
import { WorkerModule } from '../../src/worker.module';
import { startInfrastructure, withAdmin, type TestInfrastructure } from './containers';
import { ALL_READ_SCOPES, FakeHubSpot, sampleData, type FakeHubSpotOptions } from './fake-hubspot';
import { webhookEvent } from './hubspot-webhooks';
import { provisionTenant, startTenancy, type TenancyHarness } from './tenancy';

export const APP_ID = '22222';

/**
 * Harness for M6 context-processing integration tests: real PostgreSQL,
 * Redis and BullMQ workers (the worker module), a fake HubSpot with records,
 * and tenants on static tokens (each its own portal; same record ids).
 */
export interface ContextHarness {
  readonly infra: TestInfrastructure;
  readonly fake: FakeHubSpot;
  readonly h: TenancyHarness;
  readonly app: INestApplicationContext;
  readonly ingestion: ContextIngestionService;
  readonly processing: ContextProcessingService;
  readonly operations: ContextOperationsService;
  readonly bulk: BulkSyncService;
  readonly queues: QueueService;
  readonly metrics: MetricsService;
  readonly receipts: WebhookReceiptRepository;
  tenant(prefix: string, portalId: number): Promise<TenantContext>;
  /** Stores webhook events as receipts and hands them to the intake listener (like the API). */
  deliver(
    ctx: TenantContext,
    events: Record<string, unknown>[],
    enqueue?: boolean,
  ): Promise<string[]>;
  event(portalId: number, over: Record<string, unknown>): Record<string, unknown>;
  waitForReceipt(
    ctx: TenantContext,
    deliveryKey: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  sql<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  until(check: () => Promise<boolean> | boolean, timeoutMs?: number, label?: string): Promise<void>;
  close(): Promise<void>;
}

const envSet = new Map<string, string | undefined>();
function setEnv(name: string, value: string): void {
  if (!envSet.has(name)) envSet.set(name, process.env[name]);
  process.env[name] = value;
}
function restoreEnv(): void {
  for (const [name, value] of envSet) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  envSet.clear();
}

export async function startContextHarness(
  options: { env?: NodeJS.ProcessEnv; fake?: Partial<FakeHubSpotOptions>; portals?: number[] } = {},
): Promise<ContextHarness> {
  const portals = options.portals ?? [1001, 2002, 3003];
  const fake = await new FakeHubSpot({
    accounts: Object.fromEntries(
      portals.map((p) => [
        `token-${p}`,
        { portalId: p, accountType: 'DEVELOPER_TEST', scopes: ALL_READ_SCOPES, leadsEnabled: true },
      ]),
    ),
    ...sampleData(),
    ...options.fake,
  }).start();
  setEnv('HUBSPOT_API_BASE_URL', fake.url);
  setEnv('HUBSPOT_APP_ID', APP_ID);
  setEnv('HUBSPOT_MAX_RETRIES', '0');
  setEnv('PLATFORM_TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  const infra = await startInfrastructure();
  const config: AppConfig = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: infra.config.databaseUrl,
    REDIS_URL: infra.config.redisUrl,
    CONTEXT_SWEEP_STALE_MS: '1000',
    CONTEXT_RECONCILE_INTERVAL_MS: '0',
    CONTEXT_RECONCILE_LOOKBACK_MS: '0',
    ...options.env,
  });
  const h = await startTenancy(config);
  const app = h.app;
  const receipts = app.get(WebhookReceiptRepository);
  const listener = app.get<ReceiptsStoredListener>(RECEIPTS_STORED_LISTENER);

  const sql = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    withAdmin(infra.adminUrl, async (db) => (await db.query<T>(text, params)).rows);

  const until = async (
    check: () => Promise<boolean> | boolean,
    timeoutMs = 20_000,
    label = 'condition',
  ) => {
    const end = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  return {
    infra,
    fake,
    h,
    app,
    ingestion: app.get(ContextIngestionService),
    processing: app.get(ContextProcessingService),
    operations: app.get(ContextOperationsService),
    bulk: app.get(BulkSyncService),
    queues: app.get(QueueService),
    metrics: app.get(MetricsService),
    receipts,
    async tenant(prefix, portalId) {
      const ctx = await provisionTenant(h, prefix);
      await h.config.configureIntegration(ctx, 'hubspot', {
        access: 'read_only',
        settings: { portalId: String(portalId) },
      });
      await h.credentials.register(ctx, 'hubspot', 'access_token');
      setEnv(
        EnvSecretProvider.toEnvName(`tenant.${ctx.tenantSlug}.hubspot.access_token`),
        `token-${portalId}`,
      );
      return ctx;
    },
    event(portalId, over) {
      return webhookEvent({ portalId, appId: Number(APP_ID), ...over });
    },
    async deliver(ctx, events, enqueue = true) {
      const parsed = parseWebhookBatch(Buffer.from(JSON.stringify(events)));
      if (!parsed.ok) throw new Error(`invalid test events: ${parsed.issues}`);
      const correlationId = randomUUID();
      const recorded = await receipts.record(ctx, parsed.events, new Date(), correlationId);
      if (enqueue && recorded.storedKeys.length) {
        await listener.receiptsStored(ctx, 'hubspot', recorded.storedKeys, correlationId);
      }
      return parsed.events.map((e) => e.deliveryKey);
    },
    async waitForReceipt(ctx, deliveryKey, timeoutMs = 20_000) {
      let row: Record<string, unknown> | undefined;
      await until(
        async () => {
          [row] = await sql(
            'SELECT * FROM tenant_webhook_receipts WHERE tenant_id = $1 AND delivery_key = $2',
            [ctx.tenantId, deliveryKey],
          );
          return (
            row !== undefined &&
            !['pending', 'processing', 'retrying'].includes(row.processing_status as string)
          );
        },
        timeoutMs,
        `receipt ${deliveryKey.slice(0, 8)}`,
      );
      return row!;
    },
    sql,
    until,
    async close() {
      await h.close();
      await infra.stop();
      await fake.stop();
      restoreEnv();
    },
  };
}

/** A second worker-module app (e.g. with the runtime switch off), sharing the infrastructure. */
export async function startWorkerApp(
  infra: TestInfrastructure,
  env: NodeJS.ProcessEnv,
): Promise<INestApplicationContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: infra.config.databaseUrl,
    REDIS_URL: infra.config.redisUrl,
    ...env,
  });
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    logger: false,
  });
  await app.init();
  return app;
}
