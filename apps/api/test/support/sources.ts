import { randomUUID } from 'node:crypto';
import type { MappingDocument } from '../../src/modules/domain';
import {
  MappingPreviewService,
  SourceProfilingService,
  type MappingValidationReport,
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
  readonly profiling: SourceProfilingService;
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
    profiling: c.app.get(SourceProfilingService),
  };
}

/** The mapping's reviewed domains stamped with the snapshot they were reviewed against. */
export function withSnapshot(doc: MappingDocument, snapshotHash: string): MappingDocument {
  const copy = structuredClone(doc);
  for (const obj of copy.objects) {
    if (obj.holdingFilter?.reviewedDomain)
      obj.holdingFilter.reviewedDomain.snapshotHash = snapshotHash;
  }
  return copy;
}

/** The objects a mapping reads (mapped objects and the product catalogue). */
export function mappingObjects(doc: MappingDocument): string[] {
  return [
    ...new Set([
      ...doc.objects.map((o) => o.source),
      ...(doc.productReferences ? [doc.productReferences.object] : []),
    ]),
  ].sort();
}

/** Requests and executes a full profile run in-process (the worker path is tested separately). */
export async function runProfile(
  c: ContextHarness,
  f: SourcesFixture,
  objects: readonly string[],
  options: {
    sampling?: 'full' | 'systematic' | 'recent' | 'head';
    maxRows?: number;
    includeExcluded?: string[];
  } = {},
) {
  const s = sourcesServices(c);
  const requested = await s.profiling.request(
    f.ctx,
    f.connectionId,
    {
      objects: objects.map((object) => ({ object })),
      sampling: options.sampling ?? 'full',
      ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      includeExcluded: options.includeExcluded ?? [],
    },
    { actor: 'test', execute: true, enqueue: false },
  );
  return s.profiling.execute(f.ctx, requested.runId!);
}

/**
 * TEST helper: acknowledgements for exactly the findings a validation report
 * names as unacknowledged (reason `accepted_known_issue`). Dedicated tests
 * cover the refusal itself.
 */
export function acknowledgementsFor(report: MappingValidationReport) {
  return report.errors
    .filter((e) => e.code === 'finding_unacknowledged' || e.code === 'profile_low_coverage')
    .map((e) => /findings\.([0-9a-f-]{36})$/.exec(e.path)?.[1])
    .filter((id): id is string => id !== undefined)
    .map((findingId) => ({ findingId, reasonCode: 'accepted_known_issue' as const }));
}

/** Publishes a mapping version, acknowledging the findings its covering profiles require. */
export async function publishWithAcks(
  c: ContextHarness,
  f: SourcesFixture,
  mapping: MappingDocument,
  expectedBaseVersion: number,
) {
  const s = sourcesServices(c);
  const report = await s.mappings.validate(f.ctx, f.connectionId, mapping);
  const acknowledgements = acknowledgementsFor(report);
  return s.mappings.publish(f.ctx, f.connectionId, mapping, {
    expectedBaseVersion,
    actor: 'test',
    acknowledgements,
  });
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
    stopAfter?: 'connection' | 'snapshot' | 'profile' | 'mapping';
    overlapMinutes?: number;
    /** TEST value (D2 minimum); the connection limit has no production default. */
    profileMaxRows?: number | null;
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
      ...(options.profileMaxRows === null
        ? {}
        : { profile: { maxRows: options.profileMaxRows ?? 1000 } }),
    },
    credentialName: 'sugar_api',
  });
  await s.connections.setStatus(ctx, connection.id, 'enabled');
  const importConnectionId = (await s.connections.list(ctx)).find((x) => x.kind === 'import')!.id;
  const fixture = { ctx, connectionId: connection.id, importConnectionId };
  if (options.stopAfter === 'connection') return fixture;
  const captured = await s.snapshots.capture(ctx, connection.id, 'test');
  if (options.stopAfter === 'snapshot') return fixture;
  // M9A: a completed, fresh profile of the mapped objects covers the publication.
  const base = options.mapping ?? sugarTestMapping();
  const profiled = await runProfile(c, fixture, mappingObjects(base));
  if (profiled.status !== 'completed')
    throw new Error(`profile run ${profiled.status}: ${profiled.errorCode}`);
  if (options.stopAfter === 'profile') return fixture;
  // Governance order (ADR 0020): a mapping cannot map terms before its
  // connection holds `subscription_terms`, and authority over lines needs a
  // published mapping with confirmed holdings. So: v1 with terms stated as
  // null → authority → v2 with the confirmed (TEST) date mapping.
  const mapping = withSnapshot(base, captured.hash);
  await publishWithAcks(c, fixture, withoutTerms(mapping), 0);
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
  await publishWithAcks(c, fixture, mapping, 1);
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
