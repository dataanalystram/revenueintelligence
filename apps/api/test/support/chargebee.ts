import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MappingDocument } from '../../src/modules/domain';
import { EnvSecretProvider } from '../../src/platform/secrets';
import type { ContextHarness } from './context';
import { FAKE_CHARGEBEE_API_KEY, type FakeChargebee } from './fake-chargebee';
import {
  mappingObjects,
  publishWithAcks,
  runProfile,
  sourcesServices,
  withoutTerms,
  withSnapshot,
  type SourcesFixture,
} from './sources';
import { provisionTenant } from './tenancy';

/** Every catalogue item of the fake except the ignored legacy add-on (CB18). */
export const MODELLED_CHARGEBEE_ITEMS = [
  'plan-basic',
  'plan-pro',
  'addon-seats',
  'addon-support',
  'charge-setup',
];

/** TEST product model: Product = Chargebee Item (external reference `Items/<item id>`). */
export function chargebeeProductModel(ids: readonly string[] = MODELLED_CHARGEBEE_ITEMS) {
  return {
    products: ids.map((id) => ({
      key: id,
      name: `Test product ${id}`,
      externalRefs: [{ system: 'chargebee' as const, objectType: 'Items', id }],
    })),
    relationships: [],
  };
}

/** The TEST mapping (`test/fixtures/chargebee/mapping.test.json`). */
export function chargebeeTestMapping(
  over: (doc: MappingDocument) => void = () => undefined,
): MappingDocument {
  const doc = JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/chargebee/mapping.test.json'), 'utf8'),
  ) as MappingDocument;
  over(doc);
  return doc;
}

/** The mapping with state stated as explicit unknown (before the connection holds state). */
export function withoutState(doc: MappingDocument): MappingDocument {
  const copy = structuredClone(doc);
  for (const obj of copy.objects) {
    obj.fields = obj.fields.map((f) =>
      'target' in f && f.target === 'subscription.state'
        ? {
            kind: 'core' as const,
            target: 'subscription.state',
            explicit: 'unknown' as const,
            reason: 'pending_authority',
          }
        : f,
    );
  }
  return copy;
}

export const CHARGEBEE_CREDENTIAL = 'chargebee_api';

/** The environment variable the EnvSecretProvider reads for a tenant's Chargebee key. */
export function chargebeeSecretEnv(tenantSlug: string, name = CHARGEBEE_CREDENTIAL): string {
  return EnvSecretProvider.toEnvName(`tenant.${tenantSlug}.chargebee.${name}`);
}

/**
 * A tenant with a Chargebee connection to the fake, a captured snapshot, the
 * TEST product model, a covering profile and (unless stopped earlier) the
 * published TEST mapping under an authority version that assigns lines, state
 * and terms to Chargebee. The double-enumeration proof is accepted only when
 * `accept` is true (CB29 vs CB30).
 */
export async function chargebeeTenant(
  c: ContextHarness,
  fake: FakeChargebee,
  options: {
    prefix?: string;
    mapping?: MappingDocument;
    productIds?: readonly string[];
    stopAfter?: 'connection' | 'snapshot' | 'profile' | 'mapping';
    accept?: boolean;
    config?: Record<string, unknown>;
  } = {},
): Promise<SourcesFixture> {
  const s = sourcesServices(c);
  const ctx = await provisionTenant(c.h, options.prefix ?? 'cb');
  await c.h.catalogue.publish(ctx, chargebeeProductModel(options.productIds), {
    actor: 'test',
    basedOnVersion: 0,
  });
  await c.h.credentials.register(ctx, 'chargebee', CHARGEBEE_CREDENTIAL);
  process.env[chargebeeSecretEnv(ctx.tenantSlug)] = FAKE_CHARGEBEE_API_KEY;
  const connection = await s.connections.configure(ctx, {
    kind: 'chargebee',
    label: 'Chargebee (fake)',
    config: {
      site: 'synthetic-test',
      endpoint: fake.url,
      maxRetries: 2,
      // TEST values only: the overlap and the profile limit have no production default.
      sync: { overlapMinutes: 10 },
      profile: { maxRows: 1000 },
      ...options.config,
    },
    credentialName: CHARGEBEE_CREDENTIAL,
  });
  await s.connections.setStatus(ctx, connection.id, 'enabled');
  const importConnectionId = (await s.connections.list(ctx)).find((x) => x.kind === 'import')!.id;
  const fixture = { ctx, connectionId: connection.id, importConnectionId };
  if (options.stopAfter === 'connection') return fixture;
  const captured = await s.snapshots.capture(ctx, connection.id, 'test');
  if (options.stopAfter === 'snapshot') return fixture;
  const base = options.mapping ?? chargebeeTestMapping();
  const profiled = await runProfile(c, fixture, mappingObjects(base));
  if (profiled.status !== 'completed')
    throw new Error(`profile run ${profiled.status}: ${profiled.errorCode}`);
  if (options.stopAfter === 'profile') return fixture;
  // Governance order (ADR 0020): v1 without state or terms → authority → v2.
  const mapping = withSnapshot(base, captured.hash);
  await publishWithAcks(c, fixture, withoutState(withoutTerms(mapping)), 0);
  if (options.stopAfter === 'mapping') return fixture;
  const current = await s.authority.show(ctx);
  await s.authority.publish(
    ctx,
    {
      facts: {
        account_profile: null,
        person_profile: null,
        subscription_lines: connection.id,
        subscription_state: connection.id,
        subscription_terms: connection.id,
      },
    },
    {
      expectedBaseVersion: current!.version,
      actor: 'test',
      ...(options.accept
        ? {
            proofAcceptances: [
              { connectionId: connection.id, reason: 'TEST: double enumeration reviewed' },
            ],
          }
        : {}),
    },
  );
  await publishWithAcks(c, fixture, mapping, 1);
  return fixture;
}
