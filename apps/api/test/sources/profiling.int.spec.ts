import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProfileDocumentSchema, profileContentHash } from '../../src/modules/domain';
import { ProfilePurgeService } from '../../src/modules/sources';
import { tenantClient, type TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeSugar } from '../support/fake-sugar';
import {
  mappingObjects,
  runProfile,
  sourcesServices,
  sugarTenant,
  sugarTestMapping,
  withoutTerms,
  withSnapshot,
  type SourcesFixture,
} from '../support/sources';

/**
 * M9A source profiling end to end (ADR 0022): request validation and D2
 * limits, the run lifecycle and state machine, documents and findings,
 * drift baselines, retries, privacy, immutability and the privileged purge,
 * on real PostgreSQL with the app role and forced RLS, against the fake Sugar.
 */
describe('source profiling (fake Sugar, app role, forced RLS)', () => {
  let c: ContextHarness;
  let fake: FakeSugar;

  beforeAll(async () => {
    c = await startContextHarness();
    fake = await new FakeSugar().start();
  });
  afterAll(async () => {
    await fake?.stop();
    await c?.close();
  });

  const profileRows = (f: SourcesFixture) =>
    c.sql<{
      id: string;
      object: string;
      run_id: string | null;
      previous_profile_id: string | null;
      document: unknown;
      content_hash: string;
    }>(
      `SELECT id, object, run_id, previous_profile_id, document, content_hash FROM tenant_source_profiles
        WHERE tenant_id = $1 AND sampling_family = 'profile' ORDER BY created_at, object`,
      [f.ctx.tenantId],
    );
  const asApp = (ctx: TenantContext, sql: string) =>
    c.h.db.transaction(ctx, (tx) => tenantClient(tx).$executeRawUnsafe(sql));

  describe('lifecycle, documents and findings', () => {
    it('a full run profiles every requested object into valid, hashed, aggregate-only documents', async () => {
      const f = await sugarTenant(c, fake, { prefix: 'prfend', stopAfter: 'profile' });
      const s = sourcesServices(c);
      const [run] = await s.profiling.status(f.ctx, f.connectionId);
      expect(run).toMatchObject({ status: 'completed', requestedBy: 'test' });
      expect(run!.request).toMatchObject({ sampling: 'full', maxRows: 1000 });
      expect(Object.keys(run!.sampling!).sort()).toEqual(mappingObjects(sugarTestMapping()));
      const rows = await profileRows(f);
      expect(rows.map((r) => r.object)).toEqual(mappingObjects(sugarTestMapping()));
      for (const r of rows) {
        const doc = ProfileDocumentSchema.parse(r.document);
        expect(r.content_hash).toBe(profileContentHash(doc));
        expect(r.run_id).toBe(run!.id);
        expect(doc.sampling).toMatchObject({ method: 'full', bounded: false });
      }
      const rli = ProfileDocumentSchema.parse(
        rows.find((r) => r.object === 'RevenueLineItems')!.document,
      );
      expect(rli.sampling.coverage).toBe(1);
      // The holding-filter field is a declared enum: its values are a safe category.
      expect(rli.fields.find((x) => x.name === 'sales_stage')!.categorical.suppressed).toBe(false);
      // Identifiers never leak as categories.
      expect(rli.fields.find((x) => x.name === 'id')!.categorical).toMatchObject({
        suppressed: true,
        values: [],
      });
      const findings = await s.profiling.findings(f.ctx, f.connectionId, {});
      expect(findings.map((x) => `${x.object}.${x.field}:${x.code}`)).toContain(
        'RevenueLineItems.id:identifier_not_unique',
      );
    });

    it('a second run links each profile to its baseline and records drift', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'prfdrift', stopAfter: 'profile' });
        // A new pipeline value appears on one line: a new safe category.
        local.addEnumOption('RevenueLineItems', 'sales_stage', 'Renewal Pending');
        await sourcesServices(c).snapshots.capture(f.ctx, f.connectionId, 'test');
        for (let i = 0; i < 12; i++) {
          local.upsert('RevenueLineItems', {
            ...local.data.get('RevenueLineItems')!.find((r) => r.id === 'FIX-RLI-001')!,
            id: `FIX-RLI-DRIFT-${i}`,
            sales_stage: 'Renewal Pending',
          });
        }
        expect((await runProfile(c, f, ['RevenueLineItems'])).errorCode).toBeUndefined();
        const rows = (await profileRows(f)).filter((r) => r.object === 'RevenueLineItems');
        expect(rows).toHaveLength(2);
        expect(rows[1]!.previous_profile_id).toBe(rows[0]!.id);
        const drift = await sourcesServices(c).profiling.drift(
          f.ctx,
          f.connectionId,
          'RevenueLineItems',
        );
        expect(drift.baselineId).toBe(rows[0]!.id);
        expect(drift.findings.map((x) => x.code)).toEqual(
          expect.arrayContaining(['profile_drift_new_category']),
        );
      } finally {
        await local.stop();
      }
    });
  });

  describe('D2 limits: refused, never clamped', () => {
    it('refuses a connection without profile.maxRows', async () => {
      const f = await sugarTenant(c, fake, {
        prefix: 'prfunset',
        stopAfter: 'snapshot',
        profileMaxRows: null,
      });
      await expect(
        sourcesServices(c).profiling.request(
          f.ctx,
          f.connectionId,
          { objects: [{ object: 'RevenueLineItems' }], sampling: 'full', includeExcluded: [] },
          { actor: 'test', execute: true, enqueue: false },
        ),
      ).rejects.toMatchObject({ code: 'profile_limit_unset' });
      expect(
        await c.sql('SELECT 1 FROM tenant_source_profile_runs WHERE tenant_id = $1', [
          f.ctx.tenantId,
        ]),
      ).toEqual([]);
    });

    it('refuses connection limits below the minimum or above the ceiling at configuration', async () => {
      const f = await sugarTenant(c, fake, { prefix: 'prfrange', stopAfter: 'connection' });
      const s = sourcesServices(c);
      const conn = await s.connections.get(f.ctx, f.connectionId);
      for (const maxRows of [999, 250_001]) {
        await expect(
          s.connections.configure(f.ctx, {
            kind: 'sugar',
            label: conn.label,
            config: { ...conn.config, profile: { maxRows } },
            credentialName: 'sugar_api',
          }),
        ).rejects.toMatchObject({ code: 'profile_limit_out_of_range' });
      }
    });

    it('refuses --max-rows above the connection value or below the minimum (no clamping)', async () => {
      const f = await sugarTenant(c, fake, {
        prefix: 'prfmax',
        stopAfter: 'snapshot',
        profileMaxRows: 5000,
      });
      const s = sourcesServices(c);
      for (const maxRows of [5001, 999, 250_001]) {
        await expect(
          s.profiling.request(
            f.ctx,
            f.connectionId,
            { objects: [{ object: 'Accounts' }], sampling: 'full', maxRows, includeExcluded: [] },
            { actor: 'test', execute: true, enqueue: false },
          ),
        ).rejects.toMatchObject({ code: 'profile_limit_out_of_range' });
      }
      const ok = await s.profiling.request(
        f.ctx,
        f.connectionId,
        { objects: [{ object: 'Accounts' }], sampling: 'full', maxRows: 2000, includeExcluded: [] },
        { actor: 'test', execute: false },
      );
      expect(ok).toMatchObject({ dryRun: true, request: { maxRows: 2000 } });
    });

    it('refuses sampling methods the object does not support; systematic runs with a stride', async () => {
      const f = await sugarTenant(c, fake, { prefix: 'prfsamp', stopAfter: 'snapshot' });
      // Sugar objects page by offset and can count: head is not allowed.
      await expect(runProfile(c, f, ['Accounts'], { sampling: 'head' })).rejects.toMatchObject({
        code: 'sampling_unsupported',
      });
      expect(
        (await runProfile(c, f, ['RevenueLineItems'], { sampling: 'systematic' })).status,
      ).toBe('completed');
      const [row] = (await profileRows(f)).filter((r) => r.object === 'RevenueLineItems');
      expect(ProfileDocumentSchema.parse(row!.document).sampling).toMatchObject({
        method: 'systematic',
        stride: 1,
        evidence: ['systematic_page_clusters'],
      });
    });

    it('refuses a disabled connection and a kind with no adapter in this process (no run created)', async () => {
      const s = sourcesServices(c);
      const f = await sugarTenant(c, fake, { prefix: 'prfgate', stopAfter: 'snapshot' });
      const input = {
        objects: [{ object: 'RevenueLineItems' }],
        sampling: 'full' as const,
        includeExcluded: [],
      };
      const opts = { actor: 'test', execute: true, enqueue: false };
      await s.connections.setStatus(f.ctx, f.connectionId, 'disabled');
      await expect(
        s.profiling.request(f.ctx, f.connectionId, input, { ...opts, execute: false }),
      ).rejects.toMatchObject({ code: 'connection_disabled' });
      await s.connections.setStatus(f.ctx, f.connectionId, 'enabled');
      // A connection of a kind without an adapter (created outside the service).
      const [{ id }] = (await c.sql<{ id: string }>(
        `INSERT INTO tenant_source_connections (tenant_id, id, kind, label, status, mapping_mode)
         VALUES ($1, gen_random_uuid(), 'gainsight_cs', 'GS', 'enabled', 'versioned') RETURNING id::text`,
        [f.ctx.tenantId],
      )) as [{ id: string }];
      await expect(s.profiling.request(f.ctx, id, input, opts)).rejects.toMatchObject({
        code: 'adapter_not_registered',
      });
      expect(
        await c.sql('SELECT 1 FROM tenant_source_profile_runs WHERE tenant_id = $1', [
          f.ctx.tenantId,
        ]),
      ).toEqual([]);
    });
  });

  describe('run state machine and concurrency', () => {
    it('one active run per connection', async () => {
      const f = await sugarTenant(c, fake, { prefix: 'prfone', stopAfter: 'snapshot' });
      const s = sourcesServices(c);
      const req = { objects: [{ object: 'Accounts' }], sampling: 'full', includeExcluded: [] };
      await s.profiling.request(f.ctx, f.connectionId, req, {
        actor: 'test',
        execute: true,
        enqueue: false,
      });
      await expect(
        s.profiling.request(f.ctx, f.connectionId, req, {
          actor: 'test',
          execute: true,
          enqueue: false,
        }),
      ).rejects.toMatchObject({ code: 'profile_run_active' });
    });

    it('a transient failure leaves the run running; the retry restarts from scratch', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'prfretry', stopAfter: 'snapshot' });
        const s = sourcesServices(c);
        const requested = await s.profiling.request(
          f.ctx,
          f.connectionId,
          {
            objects: [{ object: 'Accounts' }, { object: 'RevenueLineItems' }],
            sampling: 'full',
            includeExcluded: [],
          },
          { actor: 'test', execute: true, enqueue: false },
        );
        local.fail({ match: /^GET \/RevenueLineItems$/, status: 503, times: 10 });
        // (cleared below so the retry can complete)
        await expect(s.profiling.execute(f.ctx, requested.runId!)).rejects.toMatchObject({
          kind: 'server_error',
        });
        expect((await s.profiling.status(f.ctx, f.connectionId, requested.runId))[0]!.status).toBe(
          'running',
        );
        expect(await profileRows(f)).toEqual([]);
        local.faults.length = 0;
        expect((await s.profiling.execute(f.ctx, requested.runId!)).status).toBe('completed');
        const rows = await profileRows(f);
        expect(rows.map((r) => r.object)).toEqual(['Accounts', 'RevenueLineItems']);
        // Never a mix of attempts: rows read equals the population, once.
        for (const r of rows) {
          const doc = ProfileDocumentSchema.parse(r.document);
          expect(doc.sampling.rowsRead).toBe(doc.sampling.populationEstimate);
        }
      } finally {
        await local.stop();
      }
    });

    it('a permanent failure fails the run with a code and persists nothing', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'prffail', stopAfter: 'snapshot' });
        local.fail({ match: /^GET \/RevenueLineItems$/, status: 400, times: 10 });
        const r = await runProfile(c, f, ['Accounts', 'RevenueLineItems']);
        expect(r).toMatchObject({ status: 'failed', errorCode: 'source_bad_request' });
        expect(await profileRows(f)).toEqual([]);
        expect((await sourcesServices(c).profiling.status(f.ctx, f.connectionId))[0]).toMatchObject(
          {
            status: 'failed',
            errorCode: 'source_bad_request',
          },
        );
      } finally {
        await local.stop();
      }
    });

    it('the database enforces the lifecycle: forward-only, terminal rows frozen, never deleted', async () => {
      const f = await sugarTenant(c, fake, { prefix: 'prfsm', stopAfter: 'profile' });
      await expect(
        asApp(
          f.ctx,
          `UPDATE tenant_source_profile_runs SET status = 'running', active_key = connection_id::text, finished_at = NULL`,
        ),
      ).rejects.toThrow(/is terminal/);
      await expect(
        asApp(f.ctx, `UPDATE tenant_source_profile_runs SET requested_by = 'x'`),
      ).rejects.toThrow(/is terminal/);
      await expect(asApp(f.ctx, `DELETE FROM tenant_source_profile_runs`)).rejects.toThrow(
        /permission denied/,
      );
      // A requested run can only move forward.
      const s = sourcesServices(c);
      const req = await s.profiling.request(
        f.ctx,
        f.connectionId,
        { objects: [{ object: 'Accounts' }], sampling: 'full', includeExcluded: [] },
        { actor: 'test', execute: true, enqueue: false },
      );
      await expect(
        asApp(
          f.ctx,
          `UPDATE tenant_source_profile_runs SET status = 'completed', active_key = NULL, finished_at = now() WHERE id = '${req.runId}'`,
        ),
      ).rejects.toThrow(/transition requested -> completed is not allowed/);
      await expect(
        asApp(
          f.ctx,
          `UPDATE tenant_source_profile_runs SET request = '{}' WHERE id = '${req.runId}'`,
        ),
      ).rejects.toThrow(/identity is immutable/);
    });
  });

  describe('immutability and the privileged purge', () => {
    it('profiles and findings are immutable for the app role', async () => {
      const f = await sugarTenant(c, fake, { prefix: 'prfimm', stopAfter: 'profile' });
      for (const sql of [
        `UPDATE tenant_source_profiles SET content_hash = repeat('0', 64)`,
        `DELETE FROM tenant_source_profiles`,
        `UPDATE tenant_source_profile_findings SET severity = 'info'`,
        `DELETE FROM tenant_source_profile_findings`,
        `DELETE FROM tenant_source_profile_purges`,
      ]) {
        await expect(asApp(f.ctx, sql), sql).rejects.toThrow(/permission denied/);
      }
      // Even the owner cannot change or delete outside the purge.
      await expect(
        c.sql(
          `UPDATE tenant_source_profiles SET content_hash = repeat('0', 64) WHERE tenant_id = $1`,
          [f.ctx.tenantId],
        ),
      ).rejects.toThrow(/source profiles are immutable/);
      await expect(
        c.sql(`DELETE FROM tenant_source_profile_findings WHERE tenant_id = $1`, [f.ctx.tenantId]),
      ).rejects.toThrow(/profile findings are immutable/);
    });

    it('the purge refuses the app role and, with owner credentials, keeps the newest N and referenced profiles, with an audit row', async () => {
      const f = await sugarTenant(c, fake, { prefix: 'prfpurge' });
      for (let i = 0; i < 3; i++)
        expect((await runProfile(c, f, ['Accounts'])).status).toBe('completed');
      const purge = c.app.get(ProfilePurgeService);
      await expect(
        purge.purge(f.ctx, f.connectionId, 'Accounts', {
          keep: 1,
          actor: 'ops',
          execute: true,
          ownerDatabaseUrl: c.appUrl,
        }),
      ).rejects.toMatchObject({ code: 'purge_requires_owner_credentials' });
      await expect(
        purge.purge(f.ctx, f.connectionId, 'Accounts', {
          keep: 1,
          actor: 'ops',
          execute: true,
          ownerDatabaseUrl: undefined,
        }),
      ).rejects.toMatchObject({ code: 'purge_requires_owner_credentials' });
      const before = (await profileRows(f)).filter((r) => r.object === 'Accounts');
      expect(before).toHaveLength(4);
      // Dry run changes nothing.
      const dry = await purge.purge(f.ctx, f.connectionId, 'Accounts', {
        keep: 1,
        actor: 'ops',
        execute: false,
        ownerDatabaseUrl: c.adminUrl,
      });
      expect(dry.dryRun).toBe(true);
      expect((await profileRows(f)).filter((r) => r.object === 'Accounts')).toHaveLength(4);
      const result = await purge.purge(f.ctx, f.connectionId, 'Accounts', {
        keep: 1,
        actor: 'ops',
        execute: true,
        ownerDatabaseUrl: c.adminUrl,
      });
      // Kept: the newest, its direct baseline and the published mapping's covering profile
      // (the first). The one in between is purged and its kept successor loses that link.
      const after = (await profileRows(f)).filter((r) => r.object === 'Accounts');
      expect(after.map((r) => r.id).sort()).toEqual(
        [before[0]!.id, before[2]!.id, before[3]!.id].sort(),
      );
      expect(result).toMatchObject({ deletedProfiles: 1, referenced: 2, unlinked: 1, kept: 3 });
      expect(after.find((r) => r.id === before[2]!.id)!.previous_profile_id).toBeNull();
      expect(after.find((r) => r.id === before[3]!.id)!.previous_profile_id).toBe(before[2]!.id);
      // Outside the purge, clearing a baseline link is refused like any other change.
      await expect(
        c.sql(
          `UPDATE tenant_source_profiles SET previous_profile_id = NULL WHERE tenant_id = $1 AND id = $2`,
          [f.ctx.tenantId, before[3]!.id],
        ),
      ).rejects.toThrow(/source profiles are immutable/);
      const [audit] = await c.sql<{ kept: number; deleted_profiles: number; actor: string }>(
        'SELECT kept, deleted_profiles, actor FROM tenant_source_profile_purges WHERE tenant_id = $1',
        [f.ctx.tenantId],
      );
      expect(audit).toEqual({
        kept: after.length,
        deleted_profiles: result.deletedProfiles,
        actor: 'ops',
      });
      // A purge with the app role's own connection is refused by the trigger as well.
      const app = new Client({ connectionString: c.appUrl });
      await app.connect();
      try {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.current_tenant', $1, true)`, [f.ctx.tenantId]);
        await app.query(`SELECT set_config('lip.profile_purge', 'on', true)`);
        await expect(app.query('DELETE FROM tenant_source_profile_findings')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await app.query('ROLLBACK').catch(() => undefined);
        await app.end();
      }
    });
  });

  describe('privacy (M9A §5)', () => {
    it('seeded personal and payment values never appear in documents or findings', async () => {
      const local = await new FakeSugar().start();
      try {
        const seeded = [
          'ada.lovelace@example.com',
          '+44 20 7946 0958',
          '4111 1111 1111 1111',
          'GB82 WEST 1234 5698 7654 32',
        ];
        for (let i = 0; i < 40; i++) {
          local.upsert('Accounts', {
            ...local.data.get('Accounts')!.find((r) => r.id === 'FIX-ACC-001')!,
            id: `FIX-ACC-PII-${i}`,
            name: `Private Person ${i}`,
            website: seeded[i % seeded.length]!,
          });
        }
        const f = await sugarTenant(c, local, { prefix: 'prfpii', stopAfter: 'snapshot' });
        expect((await runProfile(c, f, ['Accounts'])).errorCode).toBeUndefined();
        const docs = JSON.stringify(
          await c.sql('SELECT document FROM tenant_source_profiles WHERE tenant_id = $1', [
            f.ctx.tenantId,
          ]),
        );
        const findings = JSON.stringify(
          await c.sql('SELECT evidence FROM tenant_source_profile_findings WHERE tenant_id = $1', [
            f.ctx.tenantId,
          ]),
        );
        const accounts = readFileSync(resolve('test/fixtures/sugar/accounts.csv'), 'utf8')
          .split('\n')
          .slice(1)
          .filter(Boolean)
          .map((line) => line.split(',')[1]!)
          .filter((name) => name.length > 3);
        for (const value of [...seeded, ...accounts, 'Private Person']) {
          expect(docs.includes(value), value).toBe(false);
          expect(findings.includes(value), value).toBe(false);
        }
        const doc = ProfileDocumentSchema.parse(
          (
            await c.sql<{ document: unknown }>(
              `SELECT document FROM tenant_source_profiles WHERE tenant_id = $1 AND object = 'Accounts'`,
              [f.ctx.tenantId],
            )
          )[0]!.document,
        );
        const website = doc.fields.find((x) => x.name === 'website')!;
        expect(website.sensitivity).toBe('sensitive_by_name');
        expect(website.detectors).toMatchObject({
          email: 10,
          phone: expect.any(Number),
          card: 10,
          iban: 10,
        });
      } finally {
        await local.stop();
      }
    });
  });

  describe('mapping publication needs a covering profile (M9A §7)', () => {
    it('refuses without a profile, records covering profiles and acknowledgements, refuses overrides', async () => {
      const f = await sugarTenant(c, fake, { prefix: 'prfpub', stopAfter: 'snapshot' });
      const s = sourcesServices(c);
      const snapshot = await s.snapshots.latest(f.ctx, f.connectionId);
      const doc = withoutTerms(withSnapshot(sugarTestMapping(), snapshot!.hash));
      const none = await s.mappings.validate(f.ctx, f.connectionId, doc);
      expect(none.ok).toBe(false);
      expect(new Set(none.errors.map((e) => e.code))).toEqual(new Set(['profile_required']));
      expect((await runProfile(c, f, mappingObjects(sugarTestMapping()))).status).toBe('completed');
      // The duplicate fixture line (11) is an E finding on the identity: acknowledgement required.
      const unacked = await s.mappings.validate(f.ctx, f.connectionId, doc);
      expect(unacked.errors.map((e) => e.code)).toEqual(['finding_unacknowledged']);
      const findingId = /findings\.([0-9a-f-]{36})$/.exec(unacked.errors[0]!.path)![1]!;
      // An override attempt is refused and counted; it bypasses nothing.
      const before = c.metrics.total('lip_profile_override_total', { kind: 'refused' });
      const override = await s.mappings.validate(f.ctx, f.connectionId, doc, {
        profileOverride: { reason: 'profiling outage' },
      });
      expect(override.errors.map((e) => e.code).sort()).toEqual([
        'finding_unacknowledged',
        'override_out_of_scope',
        'override_requires_authenticated_operator',
      ]);
      expect(c.metrics.total('lip_profile_override_total', { kind: 'refused' })).toBe(before + 1);
      await expect(
        s.mappings.publish(f.ctx, f.connectionId, doc, {
          expectedBaseVersion: 0,
          actor: 'ops',
          acknowledgements: [{ findingId, reasonCode: 'accepted_known_issue' }],
          profileOverride: { reason: 'profiling outage' },
        }),
      ).rejects.toMatchObject({ code: 'mapping_invalid' });
      const published = await s.mappings.publish(f.ctx, f.connectionId, doc, {
        expectedBaseVersion: 0,
        actor: 'ops',
        acknowledgements: [{ findingId, reasonCode: 'accepted_known_issue' }],
      });
      expect(published.acknowledgements).toBe(1);
      const [version] = await c.sql<{
        validation: {
          coveringProfileIds: string[];
          acknowledgements: Array<Record<string, unknown>>;
        };
      }>('SELECT validation FROM tenant_source_mapping_versions WHERE tenant_id = $1', [
        f.ctx.tenantId,
      ]);
      expect(version!.validation.coveringProfileIds).toEqual(published.coveringProfileIds);
      expect(version!.validation.acknowledgements).toEqual([
        expect.objectContaining({
          findingId,
          code: 'identifier_not_unique',
          reasonCode: 'accepted_known_issue',
          actor: 'ops',
        }),
      ]);
    });

    it('a new schema snapshot invalidates coverage for publications against it', async () => {
      const local = await new FakeSugar().start();
      try {
        const f = await sugarTenant(c, local, { prefix: 'prfsnap', stopAfter: 'profile' });
        const s = sourcesServices(c);
        local.addEnumOption('RevenueLineItems', 'sales_stage', 'Renewal Pending');
        await s.snapshots.capture(f.ctx, f.connectionId, 'test');
        const latest = await s.snapshots.latest(f.ctx, f.connectionId);
        const report = await s.mappings.validate(
          f.ctx,
          f.connectionId,
          withoutTerms(withSnapshot(sugarTestMapping(), latest!.hash)),
        );
        // No profile of the new snapshot covers the mapping; the new declared option is also unreviewed.
        expect(new Set(report.errors.map((e) => e.code))).toEqual(
          new Set(['profile_required', 'holding_filter_domain_incomplete']),
        );
      } finally {
        await local.stop();
      }
    });
  });
});
