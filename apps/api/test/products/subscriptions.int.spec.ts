import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COMPANY_MERGE_PARTICIPANTS, ContextModule } from '../../src/modules/context';
import type { ExternalRef } from '../../src/modules/domain';
import { HubSpotModule } from '../../src/modules/hubspot';
import {
  ImportAlreadyRunningError,
  SubscriptionMergeParticipant,
  type SubscriptionIngestMeta,
} from '../../src/modules/products';
import { tenantClient, type TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { genericModel } from '../support/product-models';
import { authz } from '../support/security';

/**
 * M7 subscriptions (ADR 0017): the single writer, the CSV import and
 * ownership coverage, and account merge participation inside the M6 merge
 * transaction. Real PostgreSQL with the app role and forced RLS.
 */
describe('subscriptions: single writer, CSV import, coverage, account merge', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const enc = (text: string) => new TextEncoder().encode(text);
  const HEADER = 'record_id,account,product,state,starts_at,ends_at,quantity,source_updated_at';
  const csv = (...rows: string[]) => enc([HEADER, ...rows].join('\n') + '\n');
  const meta = (over: Partial<SubscriptionIngestMeta> = {}): SubscriptionIngestMeta => ({
    cause: 'import',
    correlationId: randomUUID(),
    adapter: 'test',
    adapterVersion: '1',
    ...over,
  });
  const hs = (id: string): ExternalRef => ({ system: 'hubspot', objectType: 'companies', id });

  /** A tenant with the generic model published and HubSpot companies by id. */
  async function tenantWithCompanies(prefix: string, ids: string[]): Promise<TenantContext> {
    const t = await c.tenant(prefix, 1001);
    await c.h.catalogue.publish(await authz(t, 'config.product_model.publish'), genericModel(), {
      basedOnVersion: 0,
    });
    for (const id of ids) await company(t, id);
    return t;
  }
  async function company(t: TenantContext, id: string, ref: ExternalRef = hs(id)): Promise<string> {
    const r = await c.ingestion.ingest(
      await authz(t, 'canonical.source_sync'),
      {
        kind: 'company',
        presence: 'present',
        ref,
        observedAt: new Date(),
        fields: { name: `Company ${id}` },
      },
      { cause: 'webhook', correlationId: randomUUID() },
    );
    return r.entityId!;
  }
  const companyId = async (t: TenantContext, id: string) =>
    (
      await c.sql<{ company_id: string }>(
        "SELECT company_id::text FROM company_external_refs WHERE tenant_id = $1 AND system = 'hubspot' AND external_id = $2",
        [t.tenantId, id],
      )
    )[0]!.company_id;
  const lines = (t: TenantContext) =>
    c.sql<{
      id: string;
      company_id: string;
      product_key: string;
      record_state: string;
      source_record_id: string;
    }>(
      'SELECT id::text, company_id::text, product_key, record_state, source_record_id FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY source_record_id',
      [t.tenantId],
    );
  const hashes = async (t: TenantContext) =>
    Object.fromEntries(
      (
        await c.sql<{ source_record_id: string; field_hash: string }>(
          'SELECT source_record_id, field_hash FROM tenant_subscriptions WHERE tenant_id = $1',
          [t.tenantId],
        )
      ).map((r) => [r.source_record_id, r.field_hash]),
    );
  const provenance = (t: TenantContext, entityId?: string) =>
    c.sql<{
      entity_id: string;
      change_type: string;
      changed_fields: string[];
      cause: string;
      adapter: string;
    }>(
      `SELECT entity_id::text, change_type, changed_fields, cause, adapter FROM tenant_context_changes
        WHERE tenant_id = $1 AND entity_kind = 'subscription' ${entityId ? 'AND entity_id = $2' : ''} ORDER BY ingested_at, id`,
      entityId ? [t.tenantId, entityId] : [t.tenantId],
    );
  const present = (
    recordId: string,
    companyRef: string,
    productRef: string,
    over: Record<string, unknown> = {},
  ) => ({
    presence: 'present' as const,
    source: { system: 'import' as const, objectType: 'test_lines', recordId },
    companyRef,
    productRef,
    state: 'active' as const,
    observedAt: new Date(),
    ...over,
  });

  describe('CSV import and coverage', () => {
    it('coverage is unknown before a full load; a dry run writes nothing; a full load makes it known', async () => {
      const t = await tenantWithCompanies('imp', ['601', '602']);
      await expect(c.h.subscriptionReads.coverage(t)).resolves.toEqual({
        coverage: 'unknown',
        scope: 'tenant',
      });
      const file = csv(
        'L1,hubspot:companies:601,core,active,2026-01-01T00:00:00Z,2027-01-01T00:00:00Z,10,2026-01-01T00:00:00Z',
        'L2,hubspot:companies:601,analytics,trial,,,,',
        'L3,hubspot:companies:602,core-pro,cancelled,2025-01-01T00:00:00+01:00,2026-01-01T00:00:00+01:00,,',
      );
      const dry = await c.h.imports.import(t, file, {
        source: 'billing',
        mode: 'full',
        execute: false,
        correlationId: randomUUID(),
      });
      expect(dry).toMatchObject({
        executed: false,
        status: 'valid',
        rows: 3,
        rejected: [],
        tombstoned: 0,
        coverageKnown: false,
      });
      expect(await lines(t)).toEqual([]);
      expect(
        await c.sql('SELECT 1 FROM tenant_sync_checkpoints WHERE tenant_id = $1', [t.tenantId]),
      ).toEqual([]);

      const run = await c.h.imports.import(await authz(t, 'canonical.import'), file, {
        source: 'billing',
        mode: 'full',
        execute: true,
        correlationId: randomUUID(),
      });
      expect(run).toMatchObject({
        executed: true,
        status: 'completed',
        outcomes: { created: 3 },
        tombstoned: 0,
        coverageKnown: true,
      });
      expect(
        (await lines(t)).map((l) => [l.source_record_id, l.product_key, l.record_state]),
      ).toEqual([
        ['L1', 'core', 'active'],
        ['L2', 'analytics', 'active'],
        ['L3', 'core-pro', 'active'],
      ]);
      const [checkpoint] = await c.sql(
        'SELECT system, kind, mode, status, records_seen, records_changed, input_hash, active_key FROM tenant_sync_checkpoints WHERE tenant_id = $1',
        [t.tenantId],
      );
      expect(checkpoint).toMatchObject({
        system: 'import',
        kind: 'subscription',
        mode: 'import_full',
        status: 'completed',
        records_seen: 3,
        records_changed: 3,
        input_hash: run.inputHash,
        active_key: null,
      });
      const coverage = await c.h.subscriptionReads.coverage(t);
      expect(coverage.coverage).toBe('known');

      // Provenance: field names only, cause import, adapter csv_import.
      const prov = await provenance(t);
      expect(prov).toHaveLength(3);
      expect(
        prov.every(
          (p) => p.change_type === 'created' && p.cause === 'import' && p.adapter === 'csv_import',
        ),
      ).toBe(true);
      expect(prov.flatMap((p) => p.changed_fields).every((f) => /^[a-zA-Z]+$/.test(f))).toBe(true);

      // Idempotent: the same file again changes nothing and writes no provenance.
      const again = await c.h.imports.import(await authz(t, 'canonical.import'), file, {
        source: 'billing',
        mode: 'full',
        execute: true,
        correlationId: randomUUID(),
      });
      expect(again).toMatchObject({
        status: 'completed',
        outcomes: { unchanged: 3 },
        tombstoned: 0,
      });
      expect(await provenance(t)).toHaveLength(3);

      // A full load without L2 tombstones it (kept for audit); an incremental one never tombstones.
      const fewer = csv(
        'L1,hubspot:companies:601,core,active,2026-01-01T00:00:00Z,2027-01-01T00:00:00Z,10,2026-01-01T00:00:00Z',
        'L3,hubspot:companies:602,core-pro,cancelled,2025-01-01T00:00:00+01:00,2026-01-01T00:00:00+01:00,,',
      );
      const incr = await c.h.imports.import(await authz(t, 'canonical.import'), fewer, {
        source: 'billing',
        mode: 'incremental',
        execute: true,
        correlationId: randomUUID(),
      });
      expect(incr).toMatchObject({ status: 'completed', tombstoned: 0 });
      const dryFull = await c.h.imports.import(t, fewer, {
        source: 'billing',
        mode: 'full',
        execute: false,
        correlationId: randomUUID(),
      });
      expect(dryFull.tombstoned).toBe(1);
      const full = await c.h.imports.import(await authz(t, 'canonical.import'), fewer, {
        source: 'billing',
        mode: 'full',
        execute: true,
        correlationId: randomUUID(),
      });
      expect(full).toMatchObject({ status: 'completed', tombstoned: 1 });
      const l2 = (await lines(t)).find((l) => l.source_record_id === 'L2')!;
      expect(l2.record_state).toBe('deleted');
      expect((await provenance(t, l2.id)).map((p) => [p.change_type, p.changed_fields])).toEqual([
        ['created', expect.any(Array)],
        ['state_changed', ['recordState']],
      ]);

      // Reappearing in a later load restores the same row (no duplicate).
      const restored = await c.h.imports.import(await authz(t, 'canonical.import'), file, {
        source: 'billing',
        mode: 'full',
        execute: true,
        correlationId: randomUUID(),
      });
      expect(restored.outcomes).toMatchObject({ restored: 1, unchanged: 2 });
      expect((await lines(t)).find((l) => l.source_record_id === 'L2')).toMatchObject({
        id: l2.id,
        record_state: 'active',
      });

      // An explicit absent row in an incremental load tombstones that line only.
      const absent = enc(`${HEADER},presence\nL1,,,,,,,,absent\n`);
      const del = await c.h.imports.import(await authz(t, 'canonical.import'), absent, {
        source: 'billing',
        mode: 'incremental',
        execute: true,
        correlationId: randomUUID(),
      });
      expect(del.outcomes).toEqual({ deleted: 1 });
    });

    it('a full load scoped to one source never tombstones another source (including migrated legacy lines)', async () => {
      const t = await tenantWithCompanies('src', ['611']);
      const a = csv('A1,hubspot:companies:611,core,active,,,,');
      const b = csv('B1,hubspot:companies:611,reporting,active,,,,');
      await c.h.imports.import(await authz(t, 'canonical.import'), a, {
        source: 'source_a',
        mode: 'full',
        execute: true,
        correlationId: randomUUID(),
      });
      await c.h.imports.import(await authz(t, 'canonical.import'), b, {
        source: 'source_b',
        mode: 'full',
        execute: true,
        correlationId: randomUUID(),
      });
      expect((await lines(t)).map((l) => l.record_state)).toEqual(['active', 'active']);
      await expect(
        c.h.imports.import(await authz(t, 'canonical.import'), a, {
          source: 'legacy_company_product',
          mode: 'full',
          execute: true,
          correlationId: randomUUID(),
        }),
      ).rejects.toThrow(/reserved/);
    });

    it('unknown accounts and products are rejected; a full load with rejections fails and leaves coverage unknown', async () => {
      const t = await tenantWithCompanies('rej', ['621']);
      const file = csv(
        'R1,hubspot:companies:621,core,active,,,,',
        'R2,hubspot:companies:999999,core,active,,,,',
        'R3,hubspot:companies:621,no-such-product,active,,,,',
        `R4,${randomUUID()},core,active,,,,`,
      );
      const dry = await c.h.imports.import(t, file, {
        source: 'billing',
        mode: 'full',
        execute: false,
        correlationId: randomUUID(),
      });
      expect(dry.rejected).toEqual([
        { row: 3, reason: 'unknown_account' },
        { row: 4, reason: 'unknown_product' },
        { row: 5, reason: 'unknown_account' },
      ]);
      const run = await c.h.imports.import(await authz(t, 'canonical.import'), file, {
        source: 'billing',
        mode: 'full',
        execute: true,
        correlationId: randomUUID(),
      });
      expect(run).toMatchObject({
        status: 'failed',
        tombstoned: 0,
        coverageKnown: false,
        outcomes: { created: 1, rejected: 3 },
      });
      const [cp] = await c.sql(
        'SELECT status, last_error_code, records_failed FROM tenant_sync_checkpoints WHERE tenant_id = $1',
        [t.tenantId],
      );
      expect(cp).toEqual({ status: 'failed', last_error_code: 'rows_rejected', records_failed: 3 });
      // Lines written before the failure are valid facts; coverage stays unknown.
      expect((await lines(t)).map((l) => l.source_record_id)).toEqual(['R1']);
      await expect(c.h.subscriptionReads.coverage(t)).resolves.toMatchObject({
        coverage: 'unknown',
      });
      // The incremental equivalent completes but never establishes coverage.
      const incr = await c.h.imports.import(await authz(t, 'canonical.import'), file, {
        source: 'billing',
        mode: 'incremental',
        execute: true,
        correlationId: randomUUID(),
      });
      expect(incr).toMatchObject({ status: 'completed', coverageKnown: false });
    });

    it('a malformed file, wrong encoding or oversize file is reported and nothing is written', async () => {
      const t = await tenantWithCompanies('bad', ['631']);
      const cases: [Uint8Array, string][] = [
        [csv('X1,hubspot:companies:631,core,owned,,,,'), 'invalid_state'],
        [csv('X1,hubspot:companies:631,core,active,2026-01-01,,,'), 'ambiguous_timezone'],
        [csv('X1,hubspot:companies:631,core,active,2026-02-30T00:00:00Z,,,'), 'invalid_timestamp'],
        [
          csv('X1,hubspot:companies:631,core,active,2027-01-01T00:00:00Z,2026-01-01T00:00:00Z,,'),
          'invalid_period',
        ],
        [csv('X1,hubspot:companies:631,core,active,,,0,'), 'invalid_quantity'],
        [
          csv(
            'X1,hubspot:companies:631,core,active,,,,',
            'X1,hubspot:companies:631,core,active,,,,',
          ),
          'duplicate_record_id',
        ],
        [csv('X1,hubspot:companies:631,core'), 'wrong_column_count'],
        [enc('record_id,account\nX1,a\n'), 'invalid_header'],
        [new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x41]), 'invalid_encoding'],
        [new Uint8Array(10 * 1024 * 1024 + 1), 'file_too_large'],
      ];
      for (const [file, code] of cases) {
        const r = await c.h.imports.import(await authz(t, 'canonical.import'), file, {
          source: 'billing',
          mode: 'full',
          execute: true,
          correlationId: randomUUID(),
        });
        expect(r.status, code).toBe('invalid');
        expect(
          r.parseErrors.map((e) => e.code),
          code,
        ).toContain(code);
        expect(JSON.stringify(r.parseErrors)).not.toContain('hubspot:companies');
      }
      // A BOM-prefixed valid file is accepted.
      const bom = new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...csv('X1,hubspot:companies:631,core,active,,,,'),
      ]);
      await expect(
        c.h.imports.import(t, bom, {
          source: 'billing',
          mode: 'full',
          execute: false,
          correlationId: randomUUID(),
        }),
      ).resolves.toMatchObject({ status: 'valid', rows: 1 });
      expect(await lines(t)).toEqual([]);
      expect(
        await c.sql('SELECT 1 FROM tenant_sync_checkpoints WHERE tenant_id = $1', [t.tenantId]),
      ).toEqual([]);
    });

    it('an import that dies midway leaves coverage unknown; a stuck run blocks others until cancelled', async () => {
      const t = await tenantWithCompanies('kill', ['641']);
      const file = csv(
        'K1,hubspot:companies:641,core,active,,,,',
        'K2,hubspot:companies:641,reporting,active,,,,',
      );
      const original = c.h.subscriptions.ingest.bind(c.h.subscriptions);
      let calls = 0;
      const spy = vi.spyOn(c.h.subscriptions, 'ingest').mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error('simulated crash');
        return original(...args);
      });
      try {
        await expect(
          c.h.imports.import(await authz(t, 'canonical.import'), file, {
            source: 'billing',
            mode: 'full',
            execute: true,
            correlationId: randomUUID(),
          }),
        ).rejects.toThrow('simulated crash');
      } finally {
        spy.mockRestore();
      }
      expect((await lines(t)).map((l) => l.source_record_id)).toEqual(['K1']);
      await expect(c.h.subscriptionReads.coverage(t)).resolves.toMatchObject({
        coverage: 'unknown',
      });

      // A process killed outright leaves its checkpoint running: nothing else may start.
      await c.sql(
        `INSERT INTO tenant_sync_checkpoints (tenant_id, id, system, kind, mode, status, active_key, correlation_id, updated_at)
         VALUES ($1, gen_random_uuid(), 'import', 'subscription', 'import_full', 'running', 'import:subscription:import', gen_random_uuid(), now())`,
        [t.tenantId],
      );
      const [stuck] = await c.sql<{ id: string }>(
        "SELECT id::text FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND status = 'running'",
        [t.tenantId],
      );
      await expect(
        c.h.imports.import(await authz(t, 'canonical.import'), file, {
          source: 'billing',
          mode: 'full',
          execute: true,
          correlationId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ImportAlreadyRunningError);
      await expect(c.h.subscriptionReads.coverage(t)).resolves.toMatchObject({
        coverage: 'unknown',
      });
      await expect(
        c.h.imports.cancel(await authz(t, 'canonical.import'), stuck!.id),
      ).resolves.toEqual({ cancelled: true });
      await expect(
        c.h.imports.import(await authz(t, 'canonical.import'), file, {
          source: 'billing',
          mode: 'full',
          execute: true,
          correlationId: randomUUID(),
        }),
      ).resolves.toMatchObject({ status: 'completed', coverageKnown: true });
    });
  });

  describe('concurrent imports', () => {
    it('only one import runs at a time; the others are refused cleanly', async () => {
      const t = await tenantWithCompanies('cimp', ['661']);
      const file = csv(
        'P1,hubspot:companies:661,core,active,,,,',
        'P2,hubspot:companies:661,reporting,active,,,,',
      );
      const runs = await Promise.allSettled(
        Array.from({ length: 4 }, async () =>
          c.h.imports.import(await authz(t, 'canonical.import'), file, {
            source: 'billing',
            mode: 'full',
            execute: true,
            correlationId: randomUUID(),
          }),
        ),
      );
      const done = runs.filter((r) => r.status === 'fulfilled');
      const refused = runs.filter((r) => r.status === 'rejected');
      expect(done.length).toBeGreaterThanOrEqual(1);
      expect(refused.every((r) => r.reason instanceof ImportAlreadyRunningError)).toBe(true);
      expect(await lines(t)).toHaveLength(2);
      await expect(c.h.subscriptionReads.coverage(t)).resolves.toMatchObject({ coverage: 'known' });
    });
  });

  describe('single writer', () => {
    it('orders by source time: a stale update is a no-op; concurrent duplicates create one row', async () => {
      const t = await tenantWithCompanies('wr', ['651']);
      const ref = await companyId(t, '651');
      const newer = new Date('2026-05-01T00:00:00Z');
      const older = new Date('2026-04-01T00:00:00Z');
      const results = await Promise.all(
        Array.from({ length: 6 }, async () =>
          c.h.subscriptions.ingest(
            await authz(t, 'canonical.source_sync'),
            present('D1', ref, 'core', { sourceUpdatedAt: newer }),
            meta(),
          ),
        ),
      );
      expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'unchanged')).toHaveLength(5);
      expect(await lines(t)).toHaveLength(1);
      await expect(
        c.h.subscriptions.ingest(
          await authz(t, 'canonical.source_sync'),
          present('D1', ref, 'core', { state: 'cancelled', sourceUpdatedAt: older }),
          meta(),
        ),
      ).resolves.toMatchObject({ outcome: 'stale' });
      await expect(
        c.h.subscriptions.ingest(
          await authz(t, 'canonical.source_sync'),
          present('D1', ref, 'core', {
            state: 'cancelled',
            sourceUpdatedAt: new Date('2026-06-01T00:00:00Z'),
          }),
          meta(),
        ),
      ).resolves.toMatchObject({ outcome: 'updated', changedFields: ['state'] });
      // An invalid observation is rejected before any transaction.
      await expect(
        c.h.subscriptions.ingest(
          await authz(t, 'canonical.source_sync'),
          { ...present('D2', ref, 'core'), state: 'owned' } as never,
          meta(),
        ),
      ).resolves.toEqual({ outcome: 'rejected', reason: 'invalid_observation' });
      // Product refs resolve through the model's externalRefs too.
      await c.h.catalogue.publish(
        await authz(t, 'config.product_model.publish'),
        genericModel({
          products: genericModel().products.map((p) =>
            p.key === 'reporting'
              ? {
                  ...p,
                  externalRefs: [{ system: 'gainsight_cs', objectType: 'Product', id: 'GS-REP' }],
                }
              : p,
          ),
        }),
        { basedOnVersion: 1 },
      );
      await expect(
        c.h.subscriptions.ingest(
          await authz(t, 'canonical.source_sync'),
          present('D3', ref, 'gainsight_cs:Product:GS-REP'),
          meta(),
        ),
      ).resolves.toMatchObject({
        outcome: 'created',
      });
      expect((await lines(t)).find((l) => l.source_record_id === 'D3')!.product_key).toBe(
        'reporting',
      );
    });
  });

  describe('per-line lock', () => {
    it('concurrent copies of one line naming different accounts converge on one row without errors', async () => {
      const t = await tenantWithCompanies('lock', ['671', '672']);
      const a = await companyId(t, '671');
      const b = await companyId(t, '672');
      // Different accounts take different company locks: only the line lock serialises them.
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, async (_, i) =>
          c.h.subscriptions.ingest(
            await authz(t, 'canonical.source_sync'),
            present('LK1', i % 2 ? a : b, 'core'),
            meta(),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      const outcomes = results.map(
        (r) => (r as PromiseFulfilledResult<{ outcome: string }>).value.outcome,
      );
      expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
      expect(await lines(t)).toHaveLength(1);
    });
  });

  describe('account merge participation (ADR 0017 §8)', () => {
    const merge = async (t: TenantContext, survivor: string, merged: string[]) =>
      c.ingestion.ingestMerge(
        await authz(t, 'canonical.source_sync'),
        { kind: 'company', survivor: hs(survivor), merged: merged.map(hs), observedAt: new Date() },
        { cause: 'webhook', correlationId: randomUUID() },
      );

    it('moves the same rows to the survivor with one provenance row each; replay and chains are safe', async () => {
      const t = await tenantWithCompanies('mrg', ['701', '702', '703']);
      await c.h.imports.import(
        await authz(t, 'canonical.import'),
        csv(
          'M1,hubspot:companies:701,core,active,,,,',
          'M2,hubspot:companies:702,analytics,active,,,,',
          'M3,hubspot:companies:702,reporting,cancelled,,,,',
        ),
        { source: 'billing', mode: 'full', execute: true, correlationId: randomUUID() },
      );
      // A tombstoned line of the loser moves too (history stays with the account).
      await c.h.imports.import(
        await authz(t, 'canonical.import'),
        enc(`${HEADER},presence\nM3,,,,,,,,absent\n`),
        {
          source: 'billing',
          mode: 'incremental',
          execute: true,
          correlationId: randomUUID(),
        },
      );
      const before = await lines(t);
      const hashesBefore = await hashes(t);
      const c701 = await companyId(t, '701');
      const c702 = await companyId(t, '702');

      await merge(t, '701', ['702']);
      const after = await lines(t);
      expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id)); // same rows
      expect(after.every((l) => l.company_id === c701)).toBe(true);
      expect(after.map((l) => l.record_state)).toEqual(before.map((l) => l.record_state));
      const moved = before.filter((l) => l.company_id === c702);
      for (const l of moved) {
        const merged = (await provenance(t, l.id)).filter((p) => p.change_type === 'merged');
        expect(merged).toEqual([
          {
            entity_id: l.id,
            change_type: 'merged',
            changed_fields: ['companyId'],
            cause: 'webhook',
            adapter: expect.any(String),
          },
        ]);
      }
      await expect(c.h.subscriptionReads.orphanedOnMergedCompanies(t)).resolves.toEqual([]);

      // Replay: nothing moves again, no extra provenance.
      const provCount = (await provenance(t)).length;
      await merge(t, '701', ['702']);
      expect((await provenance(t)).length).toBe(provCount);

      // A line delivered later for the merged-away account lands on the survivor.
      await expect(
        c.h.subscriptions.ingest(
          await authz(t, 'canonical.source_sync'),
          present('M4', 'hubspot:companies:702', 'reporting'),
          meta(),
        ),
      ).resolves.toMatchObject({
        outcome: 'created',
      });
      expect((await lines(t)).find((l) => l.source_record_id === 'M4')!.company_id).toBe(c701);
      // Re-delivered unchanged source lines are unchanged after the merge (the
      // field hash covers source values, never the resolved canonical company).
      const redelivered = await c.h.imports.import(
        await authz(t, 'canonical.import'),
        csv(
          'M1,hubspot:companies:701,core,active,,,,',
          'M2,hubspot:companies:702,analytics,active,,,,',
        ),
        { source: 'billing', mode: 'incremental', execute: true, correlationId: randomUUID() },
      );
      expect(redelivered.outcomes).toEqual({ unchanged: 2 });
      expect(await hashes(t)).toMatchObject(hashesBefore); // stored hashes never depend on the canonical company

      // Chained merge: 701 into 703 carries every line, including those from 702.
      await merge(t, '703', ['701']);
      const c703 = await companyId(t, '703');
      expect((await lines(t)).every((l) => l.company_id === c703)).toBe(true);
      await expect(c.h.subscriptionReads.orphanedOnMergedCompanies(t)).resolves.toEqual([]);
      await expect(c.h.subscriptionReads.accountSubscriptions(t, c702)).resolves.toMatchObject({
        requestedCompanyId: c702,
        companyId: c703,
      });
    });

    it('a merge refused across systems moves nothing', async () => {
      const t = await tenantWithCompanies('xsys', ['711']);
      const loser = await company(t, '712');
      // The loser is also known to another system: M6 records a conflict instead of merging.
      await c.sql(
        `INSERT INTO company_external_refs (tenant_id, company_id, system, object_type, external_id, state)
         VALUES ($1, $2, 'sugar', 'Accounts', 'acc-712', 'active')`,
        [t.tenantId, loser],
      );
      await c.h.imports.import(
        await authz(t, 'canonical.import'),
        csv('X1,hubspot:companies:712,core,active,,,,'),
        {
          source: 'billing',
          mode: 'full',
          execute: true,
          correlationId: randomUUID(),
        },
      );
      await merge(t, '711', ['712']);
      expect((await lines(t)).map((l) => l.company_id)).toEqual([loser]);
      expect(await provenance(t)).toHaveLength(1);
      const [conflict] = await c.sql(
        'SELECT kind FROM tenant_identity_conflicts WHERE tenant_id = $1',
        [t.tenantId],
      );
      expect(conflict).toEqual({ kind: 'merge_across_systems' });
    });

    it('a write racing a merge waits for it and lands on the survivor (forced interleaving)', async () => {
      const t = await tenantWithCompanies('race', ['721', '722']);
      const c721 = await companyId(t, '721');
      let release!: () => void;
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const gate = new Promise<void>((r) => (release = r));
      const merging = c.ingestion.ingestMerge(
        await authz(t, 'canonical.source_sync'),
        { kind: 'company', survivor: hs('721'), merged: [hs('722')], observedAt: new Date() },
        { cause: 'webhook', correlationId: randomUUID() },
        async () => {
          entered();
          await gate; // hold the merge transaction (and its company locks) open
        },
      );
      await inside;
      let settled = false;
      const writing = c.h.subscriptions
        .ingest(
          await authz(t, 'canonical.source_sync'),
          present('R1', 'hubspot:companies:722', 'core'),
          meta(),
        )
        .finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the canonical-company lock
      release();
      await merging;
      await expect(writing).resolves.toMatchObject({ outcome: 'created' });
      expect((await lines(t)).map((l) => l.company_id)).toEqual([c721]);
      await expect(c.h.subscriptionReads.orphanedOnMergedCompanies(t)).resolves.toEqual([]);
    });

    it('concurrent imports and merges neither deadlock nor leave lines on a merged company', async () => {
      const ids = Array.from({ length: 8 }, (_, i) => String(730 + i));
      const t = await tenantWithCompanies('storm', ids);
      const writes = ids.flatMap((id, i) =>
        Array.from({ length: 4 }, async (_, j) =>
          c.h.subscriptions.ingest(
            await authz(t, 'canonical.source_sync'),
            present(`S${i}-${j}`, `hubspot:companies:${id}`, j % 2 ? 'core' : 'reporting'),
            meta(),
          ),
        ),
      );
      const merges = [
        merge(t, '730', ['731']),
        merge(t, '732', ['733']),
        merge(t, '734', ['735']),
        merge(t, '736', ['737']),
      ];
      const settled = await Promise.allSettled([...writes, ...merges]);
      expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
      await merge(t, '730', ['732']); // chain after the storm
      await expect(c.h.subscriptionReads.orphanedOnMergedCompanies(t)).resolves.toEqual([]);
      expect(await lines(t)).toHaveLength(32);
    });

    it('every merge-capable composition registers the participant; startup fails without one', () => {
      const participants = c.app.get<unknown[]>(COMPANY_MERGE_PARTICIPANTS);
      expect(participants.some((p) => p instanceof SubscriptionMergeParticipant)).toBe(true);
      expect(() =>
        ContextModule.register({
          connector: HubSpotModule,
          processors: false,
          merge: { imports: [], participants: [] },
        }),
      ).toThrow(/merge\.participants is required/);
    });
  });

  describe('tenant isolation (RLS)', () => {
    it("tenants cannot read or write each other's models, subscriptions or runs", async () => {
      const a = await tenantWithCompanies('isoa', ['801']);
      const b = await tenantWithCompanies('isob', ['801']);
      await c.h.imports.import(
        await authz(b, 'canonical.import'),
        csv('I1,hubspot:companies:801,core,active,,,,'),
        {
          source: 'billing',
          mode: 'full',
          execute: true,
          correlationId: randomUUID(),
        },
      );
      const [bLine] = await lines(b);
      const inA = <T>(sql: (db: ReturnType<typeof tenantClient>) => Promise<T>) =>
        c.h.db.transaction(a, (tx) => sql(tenantClient(tx)));
      for (const table of [
        'tenant_subscriptions',
        'tenant_product_models',
        'tenant_sync_checkpoints',
      ]) {
        const rows = await inA((db) =>
          db.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1::uuid`,
            b.tenantId,
          ),
        );
        expect(rows, table).toEqual([{ n: 0 }]);
      }
      await expect(
        inA(
          (db) =>
            db.$executeRaw`UPDATE tenant_subscriptions SET state = 'cancelled' WHERE id = ${bLine!.id}::uuid`,
        ),
      ).resolves.toBe(0);
      await expect(
        inA((db) => db.$executeRaw`DELETE FROM tenant_subscriptions WHERE id = ${bLine!.id}::uuid`),
      ).resolves.toBe(0);
      const aCompany = await companyId(a, '801');
      await expect(
        inA(
          (db) =>
            db.$executeRaw`
            INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system, source_object_type,
              source_record_id, observed_at, first_seen_at, last_seen_at)
            VALUES (${b.tenantId}::uuid, gen_random_uuid(), ${aCompany}::uuid, 'core', 'active', 'import', 'x', 'y', now(), now(), now())`,
        ),
      ).rejects.toThrow(/row-level security/);
      // Re-homing an own row to another tenant is refused.
      await c.h.subscriptions.ingest(
        await authz(a, 'canonical.source_sync'),
        present('I2', aCompany, 'core'),
        meta(),
      );
      await expect(
        inA(
          (db) =>
            db.$executeRaw`UPDATE tenant_subscriptions SET tenant_id = ${b.tenantId}::uuid WHERE tenant_id = ${a.tenantId}::uuid`,
        ),
      ).rejects.toThrow(/tenant_id is immutable|row-level security/);
      expect(await lines(b)).toHaveLength(1);
    });
  });
});
