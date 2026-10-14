import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MappingDocument } from '../../src/modules/domain';
import { SecurityEventsService } from '../../src/modules/tenancy';
import { chargebeeTenant } from '../support/chargebee';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeChargebee } from '../support/fake-chargebee';
import { FakeSugar } from '../support/fake-sugar';
import { authz } from '../support/security';
import {
  publishWithAcks,
  runSync,
  sourcesServices,
  sugarTenant,
  type SourcesFixture,
} from '../support/sources';

/**
 * S22 (M10A1 amendment A1): a secret-shaped value arriving from a source is
 * never silently dropped and never stored. The affected field is rejected and
 * held (the previous accepted value stays), the run records the reason code
 * and the source coordinates, a security event is emitted, and no table, log
 * line, metric or run diagnostic contains the value.
 *
 * The secret-shaped value is assembled at runtime from a random marker (no
 * real credential, nothing for a repository scanner to find).
 */
describe('S22: secret-shaped source values are held, recorded and never persisted', () => {
  let c: ContextHarness;
  let sugar: FakeSugar;
  let chargebee: FakeChargebee;

  beforeAll(async () => {
    c = await startContextHarness();
    sugar = await new FakeSugar().start();
    chargebee = await new FakeChargebee().start();
  });
  afterAll(async () => {
    await chargebee?.stop();
    await sugar?.stop();
    await c?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  /** A JWT-shaped value whose random marker is what every scan looks for. */
  const secretShaped = () => {
    const marker = randomBytes(12).toString('hex');
    return { marker, value: ['eyJ' + marker, 'eyJ' + 'q'.repeat(12), 'r'.repeat(16)].join('.') };
  };

  /** The mapping with the account object's name field mapped as a profile field. */
  const withAccountName = (doc: MappingDocument, object: string, field: string) => {
    const copy = structuredClone(doc);
    const obj = copy.objects.find((o) => o.source === object)!;
    obj.fields = [
      ...obj.fields.filter((f) => !('source' in f) || f.source !== field),
      { kind: 'core', target: 'account.name', source: field },
    ];
    return copy;
  };

  /** Gives the source connection profile authority over accounts (keeps the other facts). */
  const grantAccountProfile = async (f: SourcesFixture) => {
    const s = sourcesServices(c);
    const current = (await s.authority.show(f.ctx))!;
    await s.authority.publish(
      await authz(f.ctx, 'config.authority.publish'),
      {
        facts: {
          account_profile: f.connectionId,
          person_profile: null,
          subscription_lines: current.document.facts.subscription_lines,
          subscription_state: current.document.facts.subscription_state,
          subscription_terms: current.document.facts.subscription_terms,
        },
      },
      { expectedBaseVersion: current.version },
    );
  };

  const companyName = async (f: SourcesFixture, system: string, object: string, id: string) =>
    (
      await c.sql<{ name: string | null }>(
        `SELECT c.name FROM companies c JOIN company_external_refs r
            ON r.tenant_id = c.tenant_id AND r.company_id = c.id
          WHERE r.tenant_id = $1 AND r.system = $2 AND r.object_type = $3 AND r.external_id = $4`,
        [f.ctx.tenantId, system, object, id],
      )
    )[0]?.name;

  /** Every row of every table in the schema, as text, searched for the marker (owner, all tenants). */
  const tablesContaining = async (marker: string) => {
    const tables = await c.sql<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    expect(tables.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const { t } of tables) {
      const [row] = await c.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${t}" x WHERE x::text LIKE $1`,
        [`%${marker}%`],
      );
      if (row!.n > 0) hits.push(t);
    }
    return hits;
  };

  /** Captures every Nest log call and every emitted security event during `work`. */
  const observe = async <T>(work: () => Promise<T>) => {
    const logs: unknown[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(function (...args: unknown[]) {
        logs.push(args);
      });
    }
    const events = c.app.get(SecurityEventsService, { strict: false });
    const emitted: unknown[] = [];
    const original = events.emit.bind(events);
    vi.spyOn(events, 'emit').mockImplementation((e) => {
      emitted.push(e);
      original(e);
    });
    const result = await work();
    return { result, logs, emitted };
  };

  const cases = [
    {
      name: 'Sugar (fake)',
      system: 'sugar',
      object: 'Accounts',
      field: 'name',
      tenant: () => sugarTenant(c, sugar, { prefix: 's22sugar' }),
      plant: (value: string) => {
        const row = sugar.data.get('Accounts')![0]!;
        row.name = value;
        return String(row.id);
      },
    },
    {
      name: 'Chargebee (fake)',
      system: 'chargebee',
      object: 'Customers',
      field: 'company',
      tenant: () => chargebeeTenant(c, chargebee, { prefix: 's22cb' }),
      plant: (value: string) => {
        const row = chargebee.customers[0]!;
        row.company = value;
        row.updated_at += 1;
        row.resource_version = row.updated_at * 1000 + 1;
        return row.id;
      },
    },
  ] as const;

  it.each(cases)('$name: field held, reason and coordinates recorded, no trace', async (k) => {
    const f = await k.tenant();
    await grantAccountProfile(f);
    // Governance order: authority first, then a mapping version that maps the name.
    const s = sourcesServices(c);
    const published = (await s.mappings.show(f.ctx, f.connectionId))!;
    await publishWithAcks(
      c,
      f,
      withAccountName(published.document, k.object, k.field),
      published.version,
    );
    const first = await runSync(c, f, 'full');
    expect(first.status).toBe('completed');

    const { marker, value } = secretShaped();
    const recordId = k.plant(value);
    const before = await companyName(f, k.system, k.object, recordId);
    expect(before, 'the first run stored the accepted name').toBeTruthy();

    const metricsBefore = JSON.stringify(c.metrics.snapshot());
    const { result: second, logs, emitted } = await observe(() => runSync(c, f, 'full'));

    // Soft assertions: a regression reports every check it breaks, not only the first.
    // Not silently dropped: the run completes and records reason code and coordinates.
    expect.soft(second.status).toBe('completed');
    expect.soft(second.quality).toMatchObject({
      secret_like_value: 1,
      secret_like_held: [{ object: k.object, recordId, field: 'name', pattern: 'jwt' }],
    });
    const [stored] = await c.sql<{ quality: Record<string, unknown> }>(
      'SELECT quality FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND id = $2',
      [f.ctx.tenantId, second.runId],
    );
    expect.soft(stored!.quality).toMatchObject({ secret_like_value: 1 });

    // Change records written by the runs carry the source-sync actor (M10A1).
    // M10B (plan §6, Q8): the product-model publish of the setup writes
    // operator-authored product-reference change records; they are not the runs'.
    expect
      .soft(
        await c.sql<{ actor_kind: string | null; actor_assurance: string | null }>(
          `SELECT DISTINCT actor_kind, actor_assurance FROM tenant_context_changes
            WHERE tenant_id = $1 AND entity_kind <> 'product'`,
          [f.ctx.tenantId],
        ),
      )
      .toEqual([{ actor_kind: 'source_sync', actor_assurance: 'system' }]);

    // Held: the previous accepted value stays.
    expect.soft(await companyName(f, k.system, k.object, recordId)).toBe(before);

    // A security event with coordinates only.
    expect.soft(emitted).toEqual([
      expect.objectContaining({
        event: 'secret_like_refused',
        outcome: 'refused',
        reasonCode: 'secret_like_value',
        tenant: f.ctx.tenantSlug,
        actorKind: 'source_sync',
        coordinates: {
          system: k.system,
          objectType: k.object,
          recordId,
          field: 'name',
          pattern: 'jwt',
        },
      }),
    ]);

    // No trace anywhere: tables (every tenant, every row), logs, metrics, events, run output.
    expect.soft(await tablesContaining(marker)).toEqual([]);
    expect.soft(JSON.stringify(logs)).not.toContain(marker);
    expect.soft(JSON.stringify(emitted)).not.toContain(marker);
    expect.soft(metricsBefore).not.toContain(marker);
    expect.soft(JSON.stringify(c.metrics.snapshot())).not.toContain(marker);
    expect.soft(JSON.stringify(second)).not.toContain(marker);
    expect.soft(logs.length).toBeGreaterThan(0);
  });
});
