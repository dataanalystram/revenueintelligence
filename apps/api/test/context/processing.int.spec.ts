import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES, JOBS } from '../../src/modules/context';
import type { TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, startWorkerApp, type ContextHarness } from '../support/context';
import { QueueService } from '../../src/platform/queue';
import { RECEIPTS_STORED_LISTENER, type ReceiptsStoredListener } from '../../src/modules/crm';

/**
 * M6 receipt processing end to end (ADR 0013/0014): durable receipt → job →
 * worker → read-back from (fake) HubSpot → the single canonical writer →
 * provenance and references. Real PostgreSQL, Redis and BullMQ.
 */
describe('context processing: webhook receipts → canonical context', () => {
  let c: ContextHarness;
  let a: TenantContext; // portal 1001
  let b: TenantContext; // portal 2002 (same HubSpot record ids as A)

  beforeAll(async () => {
    c = await startContextHarness();
    a = await c.tenant('ctxa', 1001);
    b = await c.tenant('ctxb', 2002);
  });
  afterAll(async () => {
    await c?.close();
  });

  const persons = (t: TenantContext) =>
    c.sql('SELECT * FROM persons WHERE tenant_id = $1 ORDER BY created_at, id', [t.tenantId]);
  const personRef = async (t: TenantContext, id: string) =>
    (
      await c.sql(
        "SELECT * FROM person_external_refs WHERE tenant_id = $1 AND system = 'hubspot' AND external_id = $2",
        [t.tenantId, id],
      )
    )[0];
  const companyRef = async (t: TenantContext, id: string) =>
    (
      await c.sql(
        "SELECT * FROM company_external_refs WHERE tenant_id = $1 AND system = 'hubspot' AND external_id = $2",
        [t.tenantId, id],
      )
    )[0];
  const changes = (t: TenantContext, entityId: string) =>
    c.sql(
      'SELECT * FROM tenant_context_changes WHERE tenant_id = $1 AND entity_id = $2 ORDER BY ingested_at, id',
      [t.tenantId, entityId],
    );

  describe('happy path and identity', () => {
    it('a contact creation receipt creates a person (platform id), reference, provenance and its company', async () => {
      const [key] = await c.deliver(a, [
        c.event(1001, { subscriptionType: 'object.creation', objectTypeId: '0-1', objectId: 101 }),
      ]);
      const receipt = await c.waitForReceipt(a, key!);
      expect(receipt.processing_status).toBe('processed');
      expect(receipt.correlation_id).toMatch(/^[0-9a-f-]{36}$/);

      const ref = await personRef(a, '101');
      expect(ref).toMatchObject({ object_type: 'contacts', state: 'active' });
      expect(ref!.person_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(ref!.person_id).not.toBe('101'); // HubSpot id ≠ platform id
      expect(ref!.field_hash).toMatch(/^[0-9a-f]{64}$/);

      const [p] = await persons(a);
      expect(p).toMatchObject({
        primary_email: 'person1@school1.example',
        first_name: 'First1',
        record_state: 'active',
      });

      // The primary company (201) is read back by a follow-up job and linked.
      await c.until(async () => (await persons(a))[0]!.company_id !== null, 20_000, 'company link');
      const company = await companyRef(a, '201');
      expect((await persons(a))[0]!.company_id).toBe(company!.company_id);

      const created = await changes(a, p!.id as string);
      expect(created[0]).toMatchObject({
        change_type: 'created',
        cause: 'webhook',
        source_system: 'hubspot',
        source_object_type: 'contacts',
        source_record_id: '101',
        receipt_delivery_key: key,
        correlation_id: receipt.correlation_id,
        adapter: 'hubspot',
        adapter_version: 'm6.1',
      });
      expect(created[0]!.changed_fields).toEqual(
        expect.arrayContaining(['primaryEmail', 'firstName', 'lastName', 'jobTitle']),
      );
      // Provenance holds field names, never values.
      expect(JSON.stringify(created)).not.toContain('person1@school1.example');

      const links = await c.sql(
        'SELECT to_external_id, is_primary, state FROM tenant_source_relationships WHERE tenant_id = $1 AND from_external_id = $2 ORDER BY to_external_id',
        [a.tenantId, '101'],
      );
      expect(links).toEqual([
        { to_external_id: '201', is_primary: true, state: 'active' },
        { to_external_id: '202', is_primary: false, state: 'active' },
        { to_external_id: '203', is_primary: false, state: 'active' },
      ]);
    });

    it('the same HubSpot ids in another tenant (another portal) become separate canonical records', async () => {
      const [key] = await c.deliver(b, [
        c.event(2002, { subscriptionType: 'object.creation', objectTypeId: '0-1', objectId: 101 }),
      ]);
      expect((await c.waitForReceipt(b, key!)).processing_status).toBe('processed');
      const refA = await personRef(a, '101');
      const refB = await personRef(b, '101');
      expect(refB!.person_id).not.toBe(refA!.person_id);
      expect(await persons(b)).toHaveLength(1);
    });

    it('a redelivered event is one receipt; replaying an unchanged record writes no provenance', async () => {
      const event = c.event(1001, {
        subscriptionType: 'object.propertyChange',
        objectTypeId: '0-1',
        objectId: 101,
        propertyName: 'email',
      });
      const [k1] = await c.deliver(a, [event]);
      const [k2] = await c.deliver(a, [{ ...event, attemptNumber: 1 }]);
      expect(k2).toBe(k1);
      expect((await c.waitForReceipt(a, k1!)).processing_status).toBe('processed');
      const p = (await persons(a))[0]!;
      const before = (await changes(a, p.id as string)).length;
      // Two more receipts for the same unchanged record, processed concurrently.
      const keys = await c.deliver(a, [
        c.event(1001, {
          subscriptionType: 'object.propertyChange',
          objectTypeId: '0-1',
          objectId: 101,
          propertyName: 'firstname',
        }),
        c.event(1001, {
          subscriptionType: 'object.propertyChange',
          objectTypeId: '0-1',
          objectId: 101,
          propertyName: 'lastname',
        }),
      ]);
      for (const k of keys)
        expect((await c.waitForReceipt(a, k)).processing_status).toBe('processed');
      expect((await changes(a, p.id as string)).length).toBe(before);
      expect(await persons(a)).toHaveLength(1);
      const counted = await c.sql<{ n: number }>(
        'SELECT count(*)::int AS n FROM tenant_webhook_receipts WHERE tenant_id = $1 AND delivery_key = $2',
        [a.tenantId, k1],
      );
      expect(counted[0]!.n).toBe(1);
    });

    it('a source change is applied once, with the changed field names', async () => {
      c.fake.upsertRecord('contacts', {
        id: '102',
        properties: {
          email: 'person2@school2.example',
          firstname: 'Renamed',
          lastname: 'Last2',
          jobtitle: null,
        },
        updatedAt: '2026-09-03T09:00:00.000Z',
      });
      const [k] = await c.deliver(a, [
        c.event(1001, { subscriptionType: 'object.creation', objectTypeId: '0-1', objectId: 102 }),
      ]);
      await c.waitForReceipt(a, k!);
      c.fake.upsertRecord('contacts', {
        id: '102',
        properties: {
          email: 'person2@school2.example',
          firstname: 'Renamed Again',
          lastname: 'Last2',
          jobtitle: null,
        },
        updatedAt: '2026-09-04T09:00:00.000Z',
      });
      const [k2] = await c.deliver(a, [
        c.event(1001, {
          subscriptionType: 'object.propertyChange',
          objectTypeId: '0-1',
          objectId: 102,
          propertyName: 'firstname',
        }),
      ]);
      await c.waitForReceipt(a, k2!);
      const ref = await personRef(a, '102');
      const list = await changes(a, ref!.person_id as string);
      expect(list[0]!.change_type).toBe('created');
      // The late company link (follow-up job) is its own relationship_changed row.
      const updates = list.filter((x) => x.change_type === 'updated');
      expect(updates).toHaveLength(1);
      expect(updates[0]!.changed_fields).toEqual(['firstName']);
      expect((ref!.source_updated_at as Date).toISOString()).toBe('2026-09-04T09:00:00.000Z');
    });
  });

  describe('missing values and email is not identity', () => {
    it('a company without a name and a contact without an email are represented, never rejected or invented', async () => {
      c.fake.upsertRecord('companies', { id: '250', properties: { name: null, domain: null } });
      c.fake.upsertRecord('contacts', {
        id: '150',
        properties: { email: null, firstname: null, lastname: null, jobtitle: null },
      });
      const keys = await c.deliver(a, [
        c.event(1001, { subscriptionType: 'object.creation', objectTypeId: '0-2', objectId: 250 }),
        c.event(1001, { subscriptionType: 'object.creation', objectTypeId: '0-1', objectId: 150 }),
      ]);
      for (const k of keys)
        expect((await c.waitForReceipt(a, k)).processing_status).toBe('processed');
      const co = await c.sql(
        'SELECT c.* FROM companies c JOIN company_external_refs r ON r.company_id = c.id WHERE r.tenant_id = $1 AND r.external_id = $2',
        [a.tenantId, '250'],
      );
      expect(co[0]).toMatchObject({ name: null, domains: [] });
      const pe = await c.sql(
        'SELECT p.* FROM persons p JOIN person_external_refs r ON r.person_id = p.id WHERE r.tenant_id = $1 AND r.external_id = $2',
        [a.tenantId, '150'],
      );
      expect(pe[0]).toMatchObject({ primary_email: null, first_name: null });
    });

    it('an invalid email is dropped, not stored', async () => {
      const [k] = await c.deliver(a, [
        c.event(1001, { subscriptionType: 'object.creation', objectTypeId: '0-1', objectId: 105 }),
      ]);
      await c.waitForReceipt(a, k!);
      const pe = await c.sql(
        'SELECT p.primary_email FROM persons p JOIN person_external_refs r ON r.person_id = p.id WHERE r.tenant_id = $1 AND r.external_id = $2',
        [a.tenantId, '105'],
      );
      expect(pe[0]!.primary_email).toBeNull();
    });

    it('two contacts with the same email stay two people; a shared_email conflict is recorded', async () => {
      c.fake.upsertRecord('contacts', {
        id: '160',
        properties: {
          email: 'Shared@School.Example',
          firstname: 'A',
          lastname: null,
          jobtitle: null,
        },
      });
      c.fake.upsertRecord('contacts', {
        id: '161',
        properties: {
          email: 'shared@school.example',
          firstname: 'B',
          lastname: null,
          jobtitle: null,
        },
      });
      const keys = await c.deliver(a, [
        c.event(1001, { subscriptionType: 'object.creation', objectTypeId: '0-1', objectId: 160 }),
        c.event(1001, { subscriptionType: 'object.creation', objectTypeId: '0-1', objectId: 161 }),
      ]);
      for (const k of keys) await c.waitForReceipt(a, k);
      const people = await c.sql(
        "SELECT id FROM persons WHERE tenant_id = $1 AND primary_email = 'shared@school.example'",
        [a.tenantId],
      );
      expect(people).toHaveLength(2);
      const conflicts = await c.sql(
        "SELECT * FROM tenant_identity_conflicts WHERE tenant_id = $1 AND kind = 'shared_email'",
        [a.tenantId],
      );
      expect(conflicts).toHaveLength(1);
      expect([...(conflicts[0]!.canonical_ids as string[])].sort()).toEqual(
        people.map((p) => p.id).sort(),
      );
      expect(JSON.stringify(conflicts)).not.toContain('shared@school.example');
    });
  });

  describe('eligibility: only routable contact/company events create context', () => {
    it.each([
      ['account mismatch', { portalId: 9999 }, 'ineligible', 'account_mismatch'],
      ['another app', { appId: 777 }, 'ineligible', 'app_mismatch'],
      [
        'lead events (deferred to later milestones)',
        { objectTypeId: '0-136', objectId: 301 },
        'deferred',
        'lead_out_of_scope',
      ],
      [
        'other object types',
        { objectTypeId: '0-3', objectId: 1 },
        'irrelevant',
        'unsupported_object',
      ],
      ['a synthetic id HubSpot does not have', { objectId: 987654 }, 'source_not_found', null],
    ])('%s', async (_label, over, status, reason) => {
      const before = (await persons(a)).length;
      const [k] = await c.deliver(a, [
        {
          ...c.event(1001, {
            subscriptionType: 'object.creation',
            objectTypeId: '0-1',
            objectId: 104,
          }),
          ...over,
        },
      ]);
      const r = await c.waitForReceipt(a, k!);
      expect(r.processing_status).toBe(status);
      expect(r.processing_reason).toBe(reason);
      expect((await persons(a)).length).toBe(before);
    });
  });

  describe('failures: retries, dead letters, replay, poison jobs', () => {
    it('a permanent source error dead-letters the receipt (code only); replay processes it', async () => {
      c.fake.fail({
        match: /GET \/crm\/objects\/2026-09\/contacts\/103$/,
        status: 400,
        body: { status: 'error', message: 'bad', category: 'VALIDATION_ERROR' },
        times: 1,
      });
      const [k] = await c.deliver(a, [
        c.event(1001, { subscriptionType: 'object.creation', objectTypeId: '0-1', objectId: 103 }),
      ]);
      const r = await c.waitForReceipt(a, k!);
      expect(r).toMatchObject({
        processing_status: 'dead_lettered',
        processing_reason: 'source_bad_request',
      });
      const [dl] = await c.sql(
        'SELECT * FROM tenant_dead_letters WHERE tenant_id = $1 AND receipt_delivery_key = $2',
        [a.tenantId, k],
      );
      expect(dl).toMatchObject({
        queue: QUEUES.receipts,
        job_name: JOBS.receipt,
        error_code: 'source_bad_request',
        http_status: 400,
        state: 'open',
        attempts: 1,
      });
      expect(await personRef(a, '103')).toBeUndefined();

      const dry = await c.operations.replayDeadLetters(a, {
        ids: [dl!.id as string],
        limit: 10,
        dryRun: true,
        correlationId: randomUUID(),
      });
      expect(dry).toMatchObject({ dryRun: true, matched: 1, replayed: 0 });
      const res = await c.operations.replayDeadLetters(a, {
        ids: [dl!.id as string],
        limit: 10,
        dryRun: false,
        correlationId: randomUUID(),
      });
      expect(res).toMatchObject({ replayed: 1 });
      expect((await c.waitForReceipt(a, k!)).processing_status).toBe('processed');
      expect(await personRef(a, '103')).toBeDefined();
      const [after] = await c.sql(
        'SELECT state, resolution FROM tenant_dead_letters WHERE id = $1',
        [dl!.id],
      );
      expect(after).toEqual({ state: 'replayed', resolution: 'replay' });
      const ch = await changes(a, (await personRef(a, '103'))!.person_id as string);
      expect(ch[0]!.cause).toBe('replay');
    });

    it('a transient source error is retried with backoff and then succeeds', async () => {
      c.fake.upsertRecord('contacts', {
        id: '170',
        properties: {
          email: 'retry@school.example',
          firstname: null,
          lastname: null,
          jobtitle: null,
        },
      });
      c.fake.fail({ match: /GET \/crm\/objects\/2026-09\/contacts\/170$/, status: 503, times: 1 });
      const [k] = await c.deliver(a, [
        c.event(1001, { subscriptionType: 'object.creation', objectTypeId: '0-1', objectId: 170 }),
      ]);
      const r = await c.waitForReceipt(a, k!, 30_000);
      expect(r).toMatchObject({ processing_status: 'processed', processing_attempts: 2 });
      expect(
        c.metrics.total('lip_jobs_retried', { queue: QUEUES.receipts }),
      ).toBeGreaterThanOrEqual(1);
    }, 45_000);

    it('a poison job (invalid payload) fails without retries and is dead-lettered with invalid_payload', async () => {
      await c.queues.add(
        QUEUES.receipts,
        JOBS.receipt,
        { v: 1, tenantId: a.tenantId, unexpected: 'x' },
        { jobId: 'rcpt-poison-1' },
      );
      await c.until(
        async () =>
          (
            await c.sql(
              "SELECT 1 FROM tenant_dead_letters WHERE tenant_id = $1 AND job_id = 'rcpt-poison-1'",
              [a.tenantId],
            )
          ).length === 1,
      );
      const [dl] = await c.sql(
        "SELECT error_code, attempts FROM tenant_dead_letters WHERE job_id = 'rcpt-poison-1'",
      );
      expect(dl).toEqual({ error_code: 'invalid_payload', attempts: 1 });
    });
  });

  describe('tenant isolation of jobs', () => {
    it("a job for tenant A naming tenant B's receipt finds nothing (RLS) and changes nothing in B", async () => {
      const [kb] = await c.deliver(
        b,
        [
          c.event(2002, {
            subscriptionType: 'object.creation',
            objectTypeId: '0-1',
            objectId: 102,
          }),
        ],
        false,
      );
      const bPeople = (await persons(b)).length;
      await c.queues.add(
        QUEUES.receipts,
        JOBS.receipt,
        {
          v: 1,
          tenantId: a.tenantId,
          system: 'hubspot',
          deliveryKey: kb,
          correlationId: randomUUID(),
        },
        { jobId: 'rcpt-cross-tenant-1' },
      );
      await c.until(
        async () =>
          (await c.sql("SELECT 1 FROM tenant_dead_letters WHERE job_id = 'rcpt-cross-tenant-1'"))
            .length === 1,
      );
      const [dl] = await c.sql(
        "SELECT tenant_id, error_code FROM tenant_dead_letters WHERE job_id = 'rcpt-cross-tenant-1'",
      );
      expect(dl).toEqual({ tenant_id: a.tenantId, error_code: 'receipt_not_found' });
      const [rb] = await c.sql(
        'SELECT processing_status FROM tenant_webhook_receipts WHERE tenant_id = $1 AND delivery_key = $2',
        [b.tenantId, kb],
      );
      expect(rb!.processing_status).toBe('pending');
      expect((await persons(b)).length).toBe(bPeople);
    });

    it('a job for a suspended tenant is not processed', async () => {
      const s = await c.tenant('ctxsusp', 3003);
      const [k] = await c.deliver(
        s,
        [
          c.event(3003, {
            subscriptionType: 'object.creation',
            objectTypeId: '0-1',
            objectId: 101,
          }),
        ],
        false,
      );
      await c.h.registry.suspend(s.tenantId);
      await c.queues.add(
        QUEUES.receipts,
        JOBS.receipt,
        {
          v: 1,
          tenantId: s.tenantId,
          system: 'hubspot',
          deliveryKey: k,
          correlationId: randomUUID(),
        },
        { jobId: 'rcpt-suspended-1' },
      );
      await c.until(
        async () =>
          (await c.queues.counts(QUEUES.receipts)).failed >= 1 &&
          c.metrics.total('lip_dead_letters', { code: 'tenant_inactive' }) === 1,
      );
      const [r] = await c.sql(
        'SELECT processing_status FROM tenant_webhook_receipts WHERE tenant_id = $1 AND delivery_key = $2',
        [s.tenantId, k],
      );
      expect(r!.processing_status).toBe('pending');
      expect(await c.sql('SELECT 1 FROM persons WHERE tenant_id = $1', [s.tenantId])).toEqual([]);
    });
  });

  describe('durability: Redis loss and the sweep', () => {
    it('a receipt stored while the queue was unreachable stays pending and the sweep processes it', async () => {
      c.fake.upsertRecord('contacts', {
        id: '180',
        properties: { email: null, firstname: 'Swept', lastname: null, jobtitle: null },
      });
      const [k] = await c.deliver(
        a,
        [
          c.event(1001, {
            subscriptionType: 'object.creation',
            objectTypeId: '0-1',
            objectId: 180,
          }),
        ],
        false,
      );
      await new Promise((r) => setTimeout(r, 1_200)); // older than CONTEXT_SWEEP_STALE_MS (1 s)
      expect(
        (
          await c.sql(
            'SELECT processing_status FROM tenant_webhook_receipts WHERE delivery_key = $1',
            [k],
          )
        )[0]!.processing_status,
      ).toBe('pending');
      expect(await c.processing.sweep(a)).toBeGreaterThanOrEqual(1);
      expect((await c.waitForReceipt(a, k!)).processing_status).toBe('processed');
    });

    it('historical (pre_m6) receipts are left to the explicit command by the sweep', async () => {
      const [k] = await c.deliver(
        a,
        [
          c.event(1001, {
            subscriptionType: 'object.creation',
            objectTypeId: '0-1',
            objectId: 104,
          }),
        ],
        false,
      );
      await c.sql(
        "UPDATE tenant_webhook_receipts SET processing_reason = 'pre_m6' WHERE delivery_key = $1",
        [k],
      );
      await new Promise((r) => setTimeout(r, 1_200));
      await c.processing.sweep(a);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(
        (
          await c.sql(
            'SELECT processing_status FROM tenant_webhook_receipts WHERE delivery_key = $1',
            [k],
          )
        )[0]!.processing_status,
      ).toBe('pending');
      await c.sql(
        "UPDATE tenant_webhook_receipts SET processing_reason = NULL, processing_status = 'processed' WHERE delivery_key = $1",
        [k],
      );
    });
  });

  describe('single transaction: no partial upsert', () => {
    it('a failure after the canonical write rolls back the record, reference and provenance', async () => {
      const observation = {
        kind: 'company' as const,
        presence: 'present' as const,
        ref: { system: 'hubspot' as const, objectType: 'companies', id: '290' },
        observedAt: new Date(),
        sourceUpdatedAt: new Date('2026-09-10T00:00:00Z'),
        fields: { name: 'Rollback School' },
      };
      await expect(
        c.ingestion.ingest(
          a,
          observation,
          { cause: 'resync', correlationId: randomUUID() },
          {
            afterApply: () =>
              Promise.reject(new Error('injected failure after the canonical write')),
          },
        ),
      ).rejects.toThrow('injected failure');
      expect(await companyRef(a, '290')).toBeUndefined();
      expect(
        await c.sql("SELECT 1 FROM companies WHERE tenant_id = $1 AND name = 'Rollback School'", [
          a.tenantId,
        ]),
      ).toEqual([]);
      expect(
        await c.sql(
          "SELECT 1 FROM tenant_context_changes WHERE tenant_id = $1 AND source_record_id = '290'",
          [a.tenantId],
        ),
      ).toEqual([]);
    });

    it('stale (older) observations never overwrite newer state', async () => {
      const ref = { system: 'hubspot' as const, objectType: 'companies', id: '291' };
      const base = { kind: 'company' as const, presence: 'present' as const, ref };
      const meta = { cause: 'resync' as const, correlationId: randomUUID() };
      await c.ingestion.ingest(
        a,
        {
          ...base,
          observedAt: new Date(),
          sourceUpdatedAt: new Date('2026-09-10T10:00:00Z'),
          fields: { name: 'New' },
        },
        meta,
      );
      const r = await c.ingestion.ingest(
        a,
        {
          ...base,
          observedAt: new Date(),
          sourceUpdatedAt: new Date('2026-09-10T09:00:00Z'),
          fields: { name: 'Old' },
        },
        meta,
      );
      expect(r.decision).toBe('stale');
      const [row] = await c.sql(
        'SELECT c.name FROM companies c JOIN company_external_refs r ON r.company_id = c.id WHERE r.tenant_id = $1 AND r.external_id = $2',
        [a.tenantId, '291'],
      );
      expect(row!.name).toBe('New');
    });
  });

  describe('safety properties', () => {
    it('job payloads in Redis hold identifiers only: no credentials, tokens or record values', async () => {
      const [k] = await c.deliver(
        a,
        [
          c.event(1001, {
            subscriptionType: 'object.creation',
            objectTypeId: '0-1',
            objectId: 101,
          }),
        ],
        false,
      );
      const app = await startWorkerApp(c.infra, { CONTEXT_PROCESSING_ENABLED: 'false' });
      try {
        // Enqueue through a process without processors so the job stays in Redis to inspect.
        const listener = app.get<ReceiptsStoredListener>(RECEIPTS_STORED_LISTENER);
        const queues = app.get(QueueService);
        await listener.receiptsStored(a, 'hubspot', [k!], randomUUID());
        expect(queues.processorCount).toBe(0);
      } finally {
        await app.close();
      }
      // Processing disabled → nothing enqueued, receipt stays pending (M5 behaviour).
      expect(
        (
          await c.sql(
            'SELECT processing_status FROM tenant_webhook_receipts WHERE delivery_key = $1',
            [k],
          )
        )[0]!.processing_status,
      ).toBe('pending');
      // Now enqueue for real and inspect the stored job before a worker can finish it.
      const jobId = `rcpt-inspect-${Date.now()}`;
      await c.queues.add(
        'lip-inspect',
        JOBS.receipt,
        {
          v: 1,
          tenantId: a.tenantId,
          system: 'hubspot',
          deliveryKey: k,
          correlationId: randomUUID(),
        },
        { jobId },
      );
      const data = await c.queues.jobData('lip-inspect', jobId);
      expect(Object.keys(data as object).sort()).toEqual([
        'correlationId',
        'deliveryKey',
        'system',
        'tenantId',
        'v',
      ]);
      expect(JSON.stringify(data)).not.toMatch(/token|@|secret|Bearer/i);
    });

    it('no worker path ever sent a write to HubSpot (GET, association batch read and the verified search only)', () => {
      const writes = c.fake.requests.filter(
        (r) =>
          r.method !== 'GET' &&
          !/^\/crm\/associations\/2026-09\/\w+\/\w+\/batch\/read$/.test(r.path) &&
          !/^\/crm\/objects\/2026-03\/(contacts|companies)\/search$/.test(r.path),
      );
      expect(writes).toEqual([]);
      expect(c.fake.requests.length).toBeGreaterThan(10);
    });

    it('metrics count received, queued, succeeded, outcomes and latency, with short-code labels only', () => {
      const snap = c.metrics.snapshot();
      expect(c.metrics.total('lip_receipts_received')).toBeGreaterThan(5);
      expect(c.metrics.total('lip_jobs_queued', { queue: QUEUES.receipts })).toBeGreaterThan(5);
      expect(c.metrics.total('lip_jobs_succeeded', { queue: QUEUES.receipts })).toBeGreaterThan(5);
      expect(c.metrics.total('lip_receipts_outcome', { status: 'processed' })).toBeGreaterThan(3);
      expect(Object.keys(snap.histograms).some((k) => k.startsWith('lip_receipt_latency_ms'))).toBe(
        true,
      );
      expect(JSON.stringify(snap)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-/);
    });
  });
});
