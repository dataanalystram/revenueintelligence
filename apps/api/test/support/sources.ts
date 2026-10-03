import { randomUUID } from 'node:crypto';
import type { MappingDocument } from '../../src/modules/domain';
import {
  MappingPreviewService,
  SchemaSnapshotsService,
  SourceAuthorityService,
  SourceConnectionsService,
  SourceMappingsService,
  SourceReportService,
  SourceSyncService,
} from '../../src/modules/sources';
import type { TenantContext } from '../../src/modules/tenancy';
import { EnvSecretProvider } from '../../src/platform/secrets';
import { testMapping } from '../fixtures/source-mapping';
import type { ContextHarness } from './context';
import { FAKE_SUGAR_CREDENTIALS, type FakeSugar } from './fake-sugar';
import { provisionTenant } from './tenancy';

/** Every product id the discovery and companion lines reference (not the orphan, not FIX-PROD-900). */
export const MODELLED_SUGAR_PRODUCTS = [
  1, 10, 11, 12, 20, 30, 40, 50, 60, 70, 90, 110, 120, 130, 140,
].map((n) => `FIX-PROD-${String(n).padStart(3, '0')}`);

/** A TEST product model whose products carry the fixture catalogue ids as external references. */
export function sugarProductModel(ids: readonly string[] = MODELLED_SUGAR_PRODUCTS) {
  return {
    products: ids.map((id) => ({
      key: id.toLowerCase(),
      name: `Test product ${id.slice(-3)}`,
      externalRefs: [{ system: 'sugar' as const, objectType: 'ProductTemplates', id }],
    })),
    relationships: [],
  };
}

/** The TEST mapping used end to end: the default test mapping plus FIX-PROD-900 ignored. */
export function sugarTestMapping(
  over: (doc: MappingDocument) => void = () => undefined,
): MappingDocument {
  const doc = structuredClone(testMapping());
  doc.productReferences = {
    ...doc.productReferences!,
    ignored: [{ id: 'FIX-PROD-900', reason: 'test_not_offered' }],
  };
  over(doc);
  return doc;
}

export interface SourcesFixture {
  readonly ctx: TenantContext;
  readonly connectionId: string;
  readonly importConnectionId: string;
}

export interface SourcesServices {
  readonly connections: SourceConnectionsService;
  readonly snapshots: SchemaSnapshotsService;
  readonly mappings: SourceMappingsService;
  readonly authority: SourceAuthorityService;
  readonly sync: SourceSyncService;
  readonly preview: MappingPreviewService;
  readonly report: SourceReportService;
}

export function sourcesServices(c: ContextHarness): SourcesServices {
  return {
    connections: c.app.get(SourceConnectionsService),
    snapshots: c.app.get(SchemaSnapshotsService),
    mappings: c.app.get(SourceMappingsService),
    authority: c.app.get(SourceAuthorityService),
    sync: c.app.get(SourceSyncService),
    preview: c.app.get(MappingPreviewService),
    report: c.app.get(SourceReportService),
  };
}

/**
 * A tenant with a Sugar connection to the fake, a captured snapshot, the test
 * product model and (unless stopped earlier) the published test mapping and
 * an authority version assigning subscription lines and terms to Sugar.
 */
export async function sugarTenant(
  c: ContextHarness,
  fake: FakeSugar,
  options: {
    prefix?: string;
    mapping?: MappingDocument;
    productIds?: readonly string[];
    stopAfter?: 'connection' | 'snapshot' | 'mapping';
    overlapMinutes?: number;
  } = {},
): Promise<SourcesFixture> {
  const s = sourcesServices(c);
  const ctx = await provisionTenant(c.h, options.prefix ?? 'src');
  await c.h.catalogue.publish(ctx, sugarProductModel(options.productIds), {
    actor: 'test',
    basedOnVersion: 0,
  });
  await c.h.credentials.register(ctx, 'sugar', 'sugar_api');
  process.env[EnvSecretProvider.toEnvName(`tenant.${ctx.tenantSlug}.sugar.sugar_api`)] =
    JSON.stringify(FAKE_SUGAR_CREDENTIALS);
  const connection = await s.connections.configure(ctx, {
    kind: 'sugar',
    label: 'Sugar (fake)',
    config: {
      instanceUrl: fake.url,
      apiVersion: fake.version,
      modules: ['Accounts', 'Opportunities', 'RevenueLineItems', 'ProductTemplates', 'Users'],
      referenceModules: ['ProductTemplates'],
      maxRetries: 2,
      // TEST value only: the overlap has no production default.
      sync: { overlapMinutes: options.overlapMinutes ?? 10 },
    },
    credentialName: 'sugar_api',
  });
  await s.connections.setStatus(ctx, connection.id, 'enabled');
  const importConnectionId = (await s.connections.list(ctx)).find((x) => x.kind === 'import')!.id;
  const fixture = { ctx, connectionId: connection.id, importConnectionId };
  if (options.stopAfter === 'connection') return fixture;
  await s.snapshots.capture(ctx, connection.id, 'test');
  if (options.stopAfter === 'snapshot') return fixture;
  // Governance order (ADR 0020): a mapping cannot map terms before its
  // connection holds `subscription_terms`, and authority over lines needs a
  // published mapping with confirmed holdings. So: v1 with terms stated as
  // null → authority → v2 with the confirmed (TEST) date mapping.
  const mapping = options.mapping ?? sugarTestMapping();
  await s.mappings.publish(ctx, connection.id, withoutTerms(mapping), {
    expectedBaseVersion: 0,
    actor: 'test',
  });
  if (options.stopAfter === 'mapping') return fixture;
  const current = await s.authority.show(ctx);
  await s.authority.publish(
    ctx,
    {
      facts: {
        account_profile: null,
        person_profile: null,
        subscription_lines: connection.id,
        subscription_state: null,
        subscription_terms: connection.id,
      },
    },
    { expectedBaseVersion: current!.version, actor: 'test' },
  );
  await s.mappings.publish(ctx, connection.id, mapping, { expectedBaseVersion: 1, actor: 'test' });
  return fixture;
}

/** The mapping with both terms stated as explicit null (first publication). */
export function withoutTerms(doc: MappingDocument): MappingDocument {
  const copy = structuredClone(doc);
  for (const obj of copy.objects) {
    obj.fields = obj.fields.map((f) =>
      'target' in f && (f.target === 'subscription.startsAt' || f.target === 'subscription.endsAt')
        ? {
            kind: 'core' as const,
            target: f.target,
            explicit: 'null' as const,
            reason: 'pending_authority',
          }
        : f,
    );
  }
  return copy;
}

/** Starts and executes a run in-process (the worker path is tested separately). */
export async function runSync(
  c: ContextHarness,
  f: SourcesFixture,
  mode: 'full' | 'incremental' = 'full',
) {
  const s = sourcesServices(c);
  const started = await s.sync.start(f.ctx, f.connectionId, mode, {
    enqueue: false,
    correlationId: randomUUID(),
  });
  return s.sync.execute(f.ctx, started.runId);
}
