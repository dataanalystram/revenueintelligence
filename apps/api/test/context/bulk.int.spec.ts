import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SourceObservation } from '../../src/modules/domain';
import type { TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, APP_ID, type ContextHarness } from '../support/context';

/**
 * M6 backfill, reconciliation and historical M5 receipt processing (ADR
 * 0013/0015). Every path feeds the same ContextIngestionService; checkpoints
 * live in PostgreSQL; the search endpoint is the Gate-1-verified 2026-03 path.
 */
describe('context bulk sync: backfill, reconciliation, historical receipts', () => {
  let c: ContextHarness;
  let t: TenantContext; // portal 1001

  beforeAll(async () => {
    c = await startContextHarness();
    t = await c.tenant('bulk', 1001);
  });
  afterAll(async () => {
    await c?.close();
  });

  const checkpoint = async (id: string) =>
    (await c.sql('SELECT * FROM tenant_sync_checkpoints WHERE id = $1', [id]))[0]!;
  const waitDone = (id: string) =>
    c.until(
      async () => (await checkpoint(id)).status !== 'running',
      30_000,
      `checkpoint ${id.slice(0, 8)}`,
    );
  const count = async (table: string) =>
    (
      await c.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [
        t.tenantId,
      ])
    )[0]!.n;

  it('reconciliation needs a baseline (a completed backfill) first', async () => {
    const run = await c.bulk.startReconcile(t, 'company', { correlationId: randomUUID() });
    expect(run).toEqual({ kind: 'company', resumed: false, skipped: 'needs_backfill' });
  });

  it('backfill pages companies and contacts into canonical context through the same writer', async () => {
    const runs = await c.bulk.startBackfill(t, ['company', 'person'], {
      pageSize: 2,
      correlationId: randomUUID(),
    });
    for (const r of runs) await waitDone(r.checkpointId!);
    const companies = await checkpoint(runs[0]!.checkpointId!);
    const persons = await checkpoint(runs[1]!.checkpointId!);
    expect(companies).toMatchObject({
      status: 'completed',
      mode: 'backfill',
      kind: 'company',
      records_seen: 3,
      page_no: 2,
    });
    expect(persons).toMatchObject({
      status: 'completed',
      kind: 'person',
      records_seen: 5,
      page_no: 3,
    });
    expect(await count('company_external_refs')).toBe(3);
    expect(await count('person_external_refs')).toBe(5);
    const prov = await c.sql(
      "SELECT DISTINCT cause, checkpoint_id FROM tenant_context_changes WHERE tenant_id = $1 AND change_type = 'created'",
      [t.tenantId],
    );
    expect(prov.every((p) => p.cause === 'backfill' && typeof p.checkpoint_id === 'string')).toBe(
      true,
    );
    // Every person with a primary company is linked (company created by the other run or a follow-up).
    await c.until(
      async () =>
        (
          await c.sql('SELECT 1 FROM persons WHERE tenant_id = $1 AND company_id IS NULL', [
            t.tenantId,
          ])
        ).length <= 2,
    );
    // Read-only list endpoint only, mapped properties requested.
    const lists = c.fake.requests.filter(
      (r) => r.method === 'GET' && /\/crm\/objects\/2026-09\/(companies|contacts)$/.test(r.path),
    );
    expect(lists.length).toBeGreaterThanOrEqual(5);
    // A completed backfill starts a reconciliation from its start time.
    await c.until(
      async () =>
        (
          await c.sql(
            "SELECT 1 FROM tenant_sync_checkpoints WHERE tenant_id = $1 AND mode = 'reconcile' AND status = 'completed'",
            [t.tenantId],
          )
        ).length === 2,
    );
  });

  it('re-running the backfill changes nothing (idempotent) and the state hash is identical', async () => {
    const before = await c.operations.stateHash(t);
    const changes = await count('tenant_context_changes');
    const runs = await c.bulk.startBackfill(t, ['company', 'person'], {
      pageSize: 2,
      correlationId: randomUUID(),
    });
    for (const r of runs) await waitDone(r.checkpointId!);
    expect((await checkpoint(runs[1]!.checkpointId!)).records_changed).toBe(0);
    expect(await count('tenant_context_changes')).toBe(changes);
    expect((await c.operations.stateHash(t)).hash).toBe(before.hash);
  });

  it('a backfill that fails on a later page resumes from its stored cursor without duplicates', async () => {
    for (let i = 0; i < 4; i += 1) {
      c.fake.upsertRecord('companies', {
        id: String(400 + i),
        properties: { name: `Resume ${i}`, domain: null },
      });
    }
    c.fake.fail({
      match: /GET \/crm\/objects\/2026-09\/companies$/,
      status: 400,
      body: { status: 'error', message: 'bad page', category: 'VALIDATION_ERROR' },
      when: (r) => r.query.after !== undefined,
      times: 1,
    });
    const [run] = await c.bulk.startBackfill(t, ['company'], {
      pageSize: 3,
      correlationId: randomUUID(),
    });
    await waitDone(run!.checkpointId!);
    const failed = await checkpoint(run!.checkpointId!);
    expect(failed).toMatchObject({
      status: 'failed',
      last_error_code: 'source_bad_request',
      page_no: 1,
      records_seen: 3,
    });
    expect(failed.cursor).not.toBeNull();
    const resumed = await c.bulk.resume(t, run!.checkpointId!);
    expect(resumed.resumed).toBe(true);
    await waitDone(run!.checkpointId!);
    expect(await checkpoint(run!.checkpointId!)).toMatchObject({
      status: 'completed',
      records_seen: 7,
    });
    expect(await count('company_external_refs')).toBe(7);
    const dupes = await c.sql(
      'SELECT external_id FROM company_external_refs WHERE tenant_id = $1 GROUP BY external_id HAVING count(*) > 1',
      [t.tenantId],
    );
    expect(dupes).toEqual([]);
  });

  describe('webhook and backfill races converge on the latest source state', () => {
    const ref = { system: 'hubspot' as const, objectType: 'companies', id: '500' };
    const present = (observedAt: Date, updated: string, name: string): SourceObservation => ({
      kind: 'company',
      presence: 'present',
      ref,
      observedAt,
      sourceUpdatedAt: new Date(updated),
      fields: { name },
    });
    const meta = { cause: 'backfill' as const, correlationId: randomUUID() };

    it('a newer webhook read-back wins over an older backfill snapshot processed later', async () => {
      const snapshotReadAt = new Date();
      await c.ingestion.ingest(t, present(new Date(), '2026-09-20T12:00:00Z', 'From webhook'), {
        ...meta,
        cause: 'webhook',
      });
      const r = await c.ingestion.ingest(
        t,
        present(snapshotReadAt, '2026-09-20T11:00:00Z', 'From old page'),
        meta,
      );
      expect(r.decision).toBe('stale');
      const [row] = await c.sql(
        'SELECT c.name FROM companies c JOIN company_external_refs r ON r.company_id = c.id WHERE r.tenant_id = $1 AND r.external_id = $2',
        [t.tenantId, '500'],
      );
      expect(row!.name).toBe('From webhook');
    });

    it('an old snapshot cannot resurrect a record whose deletion was recorded after it was read', async () => {
      const pageReadAt = new Date();
      await new Promise((r) => setTimeout(r, 5));
      const del = await c.ingestion.ingest(
        t,
        { kind: 'company', presence: 'absent', ref, observedAt: new Date() },
        { ...meta, cause: 'webhook' },
      );
      expect(del.decision).toBe('delete');
      const r = await c.ingestion.ingest(
        t,
        present(pageReadAt, '2026-09-21T00:00:00Z', 'Zombie'),
        meta,
      );
      expect(r.decision).toBe('stale');
      const [refRow] = await c.sql(
        'SELECT state FROM company_external_refs WHERE tenant_id = $1 AND external_id = $2',
        [t.tenantId, '500'],
      );
      expect(refRow!.state).toBe('deleted');
    });
  });

  describe('reconciliation (verified search path 2026-03, watermark in source time)', () => {
    it('pages through changes since the watermark and advances it to the newest source time', async () => {
      for (let i = 0; i < 5; i += 1) {
        c.fake.upsertRecord('companies', {
          id: String(600 + i),
          properties: { name: `Changed ${i}`, domain: null },
          updatedAt: `2026-11-0${i + 1}T10:00:00.000Z`,
        });
      }
      const run = await c.bulk.startReconcile(t, 'company', {
        since: new Date('2026-11-01T00:00:00Z'),
        pageSize: 2,
        correlationId: randomUUID(),
      });
      await waitDone(run.checkpointId!);
      const cp = await checkpoint(run.checkpointId!);
      expect(cp).toMatchObject({
        status: 'completed',
        mode: 'reconcile',
        records_seen: 5,
        records_changed: 5,
        page_no: 3,
      });
      expect((cp.high_watermark as Date).toISOString()).toBe('2026-11-05T10:00:00.000Z');
      const searches = c.fake.requests.filter(
        (r) => r.method === 'POST' && r.path.endsWith('/search'),
      );
      expect(
        searches.every(
          (r) =>
            r.path === '/crm/objects/2026-03/companies/search' ||
            r.path === '/crm/objects/2026-03/contacts/search',
        ),
      ).toBe(true);
      // The next run starts from the watermark minus the lookback (0 in tests): nothing new to apply.
      const next = await c.bulk.startReconcile(t, 'company', { correlationId: randomUUID() });
      await waitDone(next.checkpointId!);
      const cp2 = await checkpoint(next.checkpointId!);
      expect((cp2.window_since as Date).toISOString()).toBe('2026-11-05T10:00:00.000Z');
      expect(cp2.records_changed).toBe(0);
    });

    it('when a query reaches the 10,000-result window it continues with a new window from the last time', async () => {
      c.fake.fail({
        match: /POST \/crm\/objects\/2026-03\/companies\/search$/,
        status: 200,
        body: {
          total: 15_000,
          results: [
            {
              id: '600',
              properties: { name: 'Changed 0' },
              updatedAt: '2026-11-01T10:00:00.000Z',
              archived: false,
            },
            {
              id: '601',
              properties: { name: 'Changed 1' },
              updatedAt: '2026-11-02T10:00:00.000Z',
              archived: false,
            },
          ],
          paging: { next: { after: '9950' } },
        },
        times: 1,
      });
      const run = await c.bulk.startReconcile(t, 'company', {
        since: new Date('2026-11-01T00:00:00Z'),
        pageSize: 100,
        correlationId: randomUUID(),
      });
      await waitDone(run.checkpointId!);
      const cp = await checkpoint(run.checkpointId!);
      expect(cp.status).toBe('completed');
      // Second window started at the last record's time (inclusive): 601..604 re-read.
      expect((cp.window_since as Date).toISOString()).toBe('2026-11-02T10:00:00.000Z');
      expect(cp.records_seen).toBe(2 + 4);
    });
  });

  describe('historical M5 receipts', () => {
    async function insertHistorical(over: Record<string, unknown>, key: string) {
      await c.sql(
        `INSERT INTO tenant_webhook_receipts (tenant_id, system, delivery_key, event_id, subscription_id, account_id, app_id,
           subscription_type, object_type_id, object_id, occurred_at, first_attempt_number, last_attempt_number,
           received_at, processing_reason)
         VALUES ($1, 'hubspot', $2, '1', '2', $3, $4, $5, $6, $7, now() - interval '3 days', 0, 0, now() - interval '3 days', 'pre_m6')`,
        [
          t.tenantId,
          key,
          over.account ?? '1001',
          over.app ?? APP_ID,
          over.type ?? 'object.creation',
          over.objectTypeId ?? '0-1',
          over.objectId ?? '101',
        ],
      );
    }

    it('are processed explicitly through the same path; a second replay changes nothing (equal state hash)', async () => {
      const keys = {
        contact: 'a'.repeat(63) + '1',
        company: 'a'.repeat(63) + '2',
        lead: 'a'.repeat(63) + '3',
        otherApp: 'a'.repeat(63) + '4',
        synthetic: 'a'.repeat(63) + '5',
        propertyChange: 'a'.repeat(63) + '6',
      };
      await insertHistorical({ objectId: '104' }, keys.contact);
      await insertHistorical({ objectTypeId: '0-2', objectId: '203' }, keys.company);
      await insertHistorical({ objectTypeId: '0-136', objectId: '301' }, keys.lead);
      await insertHistorical({ app: '99999', objectId: '102' }, keys.otherApp);
      await insertHistorical({ objectId: '9876543' }, keys.synthetic);
      await insertHistorical(
        { type: 'object.propertyChange', objectId: '104' },
        keys.propertyChange,
      );

      const dry = await c.operations.processReceipts(t, {
        onlyReason: 'pre_m6',
        limit: 100,
        includeFinished: false,
        dryRun: true,
        correlationId: randomUUID(),
      });
      expect(dry).toMatchObject({ dryRun: true, matched: 6, queued: 0, byStatus: { pending: 6 } });

      const first = await c.operations.processReceipts(t, {
        onlyReason: 'pre_m6',
        limit: 100,
        includeFinished: false,
        dryRun: false,
        correlationId: randomUUID(),
      });
      expect(first.queued).toBe(6);
      const status = async (): Promise<Record<string, string>> =>
        Object.fromEntries(
          (
            await c.sql(
              'SELECT delivery_key, processing_status, processing_reason FROM tenant_webhook_receipts WHERE tenant_id = $1 AND delivery_key LIKE $2',
              [t.tenantId, 'aaaa%'],
            )
          ).map((r): [string, string] => [
            r.delivery_key as string,
            `${r.processing_status as string}${r.processing_reason ? `:${r.processing_reason as string}` : ''}`,
          ]),
        );
      await c.until(async () =>
        Object.values(await status()).every(
          (s) =>
            !s.startsWith('pending') && !s.startsWith('processing') && !s.startsWith('retrying'),
        ),
      );
      expect(await status()).toEqual({
        [keys.contact]: 'processed',
        [keys.company]: 'processed',
        [keys.lead]: 'deferred:lead_out_of_scope',
        [keys.otherApp]: 'ineligible:app_mismatch',
        [keys.synthetic]: 'source_not_found',
        [keys.propertyChange]: 'processed',
      });
      await c.until(
        async () =>
          (await c.queues.counts('lip-sync')).waiting +
            (await c.queues.counts('lip-sync')).active ===
          0,
      );
      const h1 = await c.operations.stateHash(t);
      const changes1 = await count('tenant_context_changes');

      const second = await c.operations.processReceipts(t, {
        from: new Date(Date.now() - 4 * 86_400_000),
        to: new Date(Date.now() - 2 * 86_400_000),
        limit: 100,
        includeFinished: true,
        dryRun: false,
        correlationId: randomUUID(),
      });
      expect(second.queued).toBe(6);
      await c.until(async () =>
        Object.values(await status()).every(
          (s) =>
            !s.startsWith('pending') && !s.startsWith('processing') && !s.startsWith('retrying'),
        ),
      );
      await c.until(
        async () =>
          (await c.queues.counts('lip-sync')).waiting +
            (await c.queues.counts('lip-sync')).active ===
          0,
      );
      const h2 = await c.operations.stateHash(t);
      expect(h2.hash).toBe(h1.hash);
      expect(await count('tenant_context_changes')).toBe(changes1);
      // The synthetic id never created a canonical record.
      expect(
        await c.sql(
          "SELECT 1 FROM person_external_refs WHERE tenant_id = $1 AND external_id = '9876543'",
          [t.tenantId],
        ),
      ).toEqual([]);
    });
  });
});
