import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CanonicalAdoptionService,
  IntegrityVerificationService,
  SourceReferenceService,
  type ReferenceObservationInput,
  type ReferenceWriteMeta,
} from '../../src/modules/governance';
import { TenantDatabase, type TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { genericModel } from '../support/product-models';
import { authz } from '../support/security';

type Ref = { system: string; objectType: string; id: string };

const T0 = Date.parse('2026-11-01T00:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const PT = 'ProductTemplates';
const META: ReferenceWriteMeta = { cause: 'backfill', adapter: 'sugar', adapterVersion: 'test' };

/**
 * M10B (plan §19) on real PostgreSQL, app role, forced RLS: the generic store
 * constraints (V2), the declared product-reference projection of product-model
 * publish (V4, V5), `observe` / `retireAbsentWithin` / `merge` on undeclared
 * product triples (V6–V8), cross-tenant refusal by raw SQL (V11, references),
 * the `source_reference_index` view (V12), the 0.2 version gate (V15) and the
 * widened change records (V16).
 */
describe('M10B generic source references', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const refs = () => c.app.get(SourceReferenceService);
  const db = () => c.app.get(TenantDatabase);
  const adoption = () => c.app.get(CanonicalAdoptionService);
  const integrity = () => c.app.get(IntegrityVerificationService);

  /** genericModel() with externalRefs attached to the named product keys. */
  const modelWith = (byKey: Record<string, Ref[]>, extra: string[] = []) => {
    const base = genericModel();
    return genericModel({
      products: [
        ...base.products.map((p) =>
          byKey[p.key]?.length ? { ...p, externalRefs: byKey[p.key] } : p,
        ),
        ...extra.map((key) => ({
          key,
          name: `Extra ${key}`,
          family: 'platform',
          ...(byKey[key]?.length ? { externalRefs: byKey[key] } : {}),
        })),
      ],
    });
  };
  const versions = new Map<string, number>();
  async function publish(t: TenantContext, byKey: Record<string, Ref[]>, extra: string[] = []) {
    const base = versions.get(t.tenantId) ?? 0;
    const v = await c.h.catalogue.publish(
      await authz(t, 'config.product_model.publish'),
      modelWith(byKey, extra),
      { basedOnVersion: base },
    );
    versions.set(t.tenantId, v.version);
    return v.version;
  }
  const pt = (id: string): Ref => ({ system: 'sugar', objectType: PT, id });

  const rows = (t: TenantContext) =>
    c.sql<{
      id: string;
      external_id: string;
      entity_key: string | null;
      origin: string;
      state: string;
      declared_in_model_version: number | null;
      retired_by_model_version: number | null;
      retired_by_run_id: string | null;
      merged_into_external_id: string | null;
      last_change_id: string | null;
    }>(
      `SELECT id::text, external_id, entity_key, origin, state, declared_in_model_version,
              retired_by_model_version, retired_by_run_id::text, merged_into_external_id, last_change_id::text
         FROM tenant_source_references WHERE tenant_id = $1 ORDER BY external_id`,
      [t.tenantId],
    );
  const changes = (t: TenantContext, externalId?: string) =>
    c.sql<{
      id: string;
      entity_kind: string;
      entity_id: string | null;
      entity_key: string | null;
      change_type: string;
      source_record_id: string;
      cause: string;
      origin: string | null;
      actor_kind: string | null;
      canonical_version: string | null;
    }>(
      `SELECT id::text, entity_kind, entity_id::text, entity_key, change_type, source_record_id, cause, origin,
              actor_kind, canonical_version
         FROM tenant_context_changes
        WHERE tenant_id = $1 AND entity_kind = 'product' AND ($2::text IS NULL OR source_record_id = $2)
        ORDER BY ingested_at, source_record_id`,
      [t.tenantId, externalId ?? null],
    );
  /** Active declared rows, as the model must project them. */
  const activeDeclared = async (t: TenantContext) =>
    (await rows(t))
      .filter((r) => r.origin === 'declared' && r.state === 'active')
      .map((r) => `${r.external_id}=${r.entity_key}`)
      .sort();
  const expectedOf = (byKey: Record<string, Ref[]>) =>
    Object.entries(byKey)
      .flatMap(([key, rs]) => rs.map((r) => `${r.id}=${key}`))
      .sort();

  async function asApp<T>(t: TenantContext, work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: c.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [t.tenantId]);
      const out = await work(client);
      await client.query('ROLLBACK');
      return out;
    } finally {
      await client.end();
    }
  }

  const observeInput = (
    externalId: string,
    entityKey: string,
    over: Partial<ReferenceObservationInput> = {},
  ): ReferenceObservationInput => ({
    system: 'sugar',
    objectType: PT,
    externalId,
    entityKind: 'product',
    entityKey,
    presence: 'present',
    observedAt: at(1),
    sourceUpdatedAt: at(1),
    fieldHash: HASH_A,
    meta: META,
    ...over,
  });
  async function observe(t: TenantContext, input: ReferenceObservationInput) {
    const actx = await authz(t, 'canonical.source_sync');
    return db().transaction(t, (tx) => refs().observe(actx, tx, input));
  }
  async function checkpoint(t: TenantContext): Promise<string> {
    const id = randomUUID();
    await c.sql(
      `INSERT INTO tenant_sync_checkpoints (tenant_id, id, system, kind, mode, status, correlation_id, completed_at)
       VALUES ($1, $2, 'sugar', 'company', 'backfill', 'completed', gen_random_uuid(), now())`,
      [t.tenantId, id],
    );
    return id;
  }
  const auditOf = (t: TenantContext, action: string) =>
    c.sql<{ outcome: string; reason_code: string | null; details: unknown }>(
      `SELECT outcome, reason_code, details FROM tenant_audit_events
        WHERE tenant_id = $1 AND action = $2 ORDER BY seq`,
      [t.tenantId, action],
    );

  describe('V4/V5: product-model publish projects declared references', () => {
    it('add → ref_added; remove → retired; re-add → reactivated (same row); move → re-pointed; unchanged → no write', async () => {
      const t = await c.tenant('srpub', 1001);
      const v1Refs = { core: [pt('pt-1')], analytics: [pt('pt-2')], reporting: [pt('pt-3')] };
      const v1 = await publish(t, v1Refs);
      let r = await rows(t);
      expect(
        r.map((x) => [x.external_id, x.entity_key, x.origin, x.state, x.declared_in_model_version]),
      ).toEqual([
        ['pt-1', 'core', 'declared', 'active', v1],
        ['pt-2', 'analytics', 'declared', 'active', v1],
        ['pt-3', 'reporting', 'declared', 'active', v1],
      ]);
      const added = await changes(t);
      expect(added.map((ch) => [ch.source_record_id, ch.change_type])).toEqual([
        ['pt-1', 'ref_added'],
        ['pt-2', 'ref_added'],
        ['pt-3', 'ref_added'],
      ]);
      // V16: key-identified, operator-authored change records at 0.2.
      for (const ch of added) {
        expect(ch).toMatchObject({
          entity_kind: 'product',
          entity_id: null,
          cause: 'human',
          origin: 'human',
          actor_kind: 'operator',
          canonical_version: '0.2',
        });
      }
      for (const row of r) expect(added.map((ch) => ch.id)).toContain(row.last_change_id);
      const publishAudit = (await auditOf(t, 'product_model.publish')).at(-1)!;
      expect(publishAudit.details).toMatchObject({ referencesAdded: 3, referencesRetired: 0 });
      const pt1Before = r.find((x) => x.external_id === 'pt-1')!;

      // v2: pt-2 removed, pt-3 moved to suite, pt-1 unchanged.
      const v2Refs = { core: [pt('pt-1')], suite: [pt('pt-3')] };
      const v2 = await publish(t, v2Refs);
      r = await rows(t);
      const pt2 = r.find((x) => x.external_id === 'pt-2')!;
      expect(pt2).toMatchObject({ state: 'retired', retired_by_model_version: v2 });
      expect(r.find((x) => x.external_id === 'pt-3')).toMatchObject({
        entity_key: 'suite',
        state: 'active',
        declared_in_model_version: v2,
      });
      // V5: the surviving reference is not written and gets no change record.
      expect(r.find((x) => x.external_id === 'pt-1')).toEqual(pt1Before);
      expect((await changes(t, 'pt-1')).map((ch) => ch.change_type)).toEqual(['ref_added']);
      expect((await changes(t, 'pt-2')).map((ch) => ch.change_type)).toEqual([
        'ref_added',
        'retired',
      ]);
      expect((await changes(t, 'pt-3')).map((ch) => [ch.change_type, ch.entity_key])).toEqual([
        ['ref_added', 'reporting'],
        ['updated', 'suite'],
      ]);
      expect(await activeDeclared(t)).toEqual(expectedOf(v2Refs));

      // v3: pt-2 declared again → reactivated on the same row, never a duplicate.
      const v3Refs = { core: [pt('pt-1')], analytics: [pt('pt-2')], suite: [pt('pt-3')] };
      const v3 = await publish(t, v3Refs);
      r = await rows(t);
      expect(r).toHaveLength(3);
      expect(r.find((x) => x.external_id === 'pt-2')).toMatchObject({
        id: pt2.id,
        state: 'active',
        retired_by_model_version: null,
        declared_in_model_version: v3,
      });
      expect((await changes(t, 'pt-2')).map((ch) => ch.change_type)).toEqual([
        'ref_added',
        'retired',
        'reactivated',
      ]);
      expect((await auditOf(t, 'product_model.publish')).at(-1)!.details).toMatchObject({
        referencesAdded: 0,
        referencesRetired: 0,
        referencesReactivated: 1,
        referencesRepointed: 0,
      });
      const report = await integrity().verify(t);
      expect(report.findings.filter((f) => f.check === 'declared_reference_drift')).toEqual([]);
    });

    it('property: after a random publish sequence the active declared rows equal the latest model', async () => {
      const t = await c.tenant('srprop', 2002);
      const keys = ['core', 'analytics', 'reporting', 'suite', 'onprem'];
      const ids = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
      let seed = 0x5eed;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      for (let step = 0; step < 6; step += 1) {
        const byKey: Record<string, Ref[]> = {};
        for (const id of ids) {
          const k = rnd(keys.length + 2); // some ids undeclared in some steps
          if (k < keys.length) (byKey[keys[k]!] ??= []).push(pt(id));
        }
        await publish(t, byKey);
        expect(await activeDeclared(t)).toEqual(expectedOf(byKey));
        // Never a duplicate row per triple; never a DELETE.
        expect(new Set((await rows(t)).map((x) => x.external_id)).size).toBe(
          (await rows(t)).length,
        );
      }
      expect((await rows(t)).every((x) => x.origin === 'declared')).toBe(true);
    });
  });

  describe('V6: observe on undeclared product triples', () => {
    it('insert, unchanged, newer, stale, tombstone not revived by an older read, reactivation by a later read, one change record per real change', async () => {
      const t = await c.tenant('srobs', 3003);
      await publish(t, {});
      const created = await observe(t, observeInput('obs-1', 'onprem'));
      expect(created.decision).toBe('create');
      const [row] = await rows(t);
      expect(row).toMatchObject({
        external_id: 'obs-1',
        entity_key: 'onprem',
        origin: 'observed',
        state: 'active',
      });
      expect(row!.last_change_id).toBe(created.changeId);

      // Same source time and hash, later read: unchanged, no change record, last_seen advanced.
      const same = await observe(t, observeInput('obs-1', 'onprem', { observedAt: at(2) }));
      expect(same).toMatchObject({ decision: 'unchanged', referenceId: row!.id });
      const [seen] = await c.sql<{ last_seen_at: Date }>(
        `SELECT last_seen_at FROM tenant_source_references WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, row!.id],
      );
      expect(seen!.last_seen_at.getTime()).toBe(at(2).getTime());

      // Newer source time: apply.
      const newer = await observe(
        t,
        observeInput('obs-1', 'onprem', {
          observedAt: at(3),
          sourceUpdatedAt: at(3),
          fieldHash: HASH_B,
        }),
      );
      expect(newer.decision).toBe('apply');
      // Older source time: stale, nothing written.
      const stale = await observe(
        t,
        observeInput('obs-1', 'onprem', {
          observedAt: at(4),
          sourceUpdatedAt: at(0),
          fieldHash: HASH_A,
        }),
      );
      expect(stale.decision).toBe('stale');

      // Absent after the last read: tombstone.
      const gone = await observe(
        t,
        observeInput('obs-1', 'onprem', { presence: 'absent', observedAt: at(5) }),
      );
      expect(gone.decision).toBe('delete');
      expect((await rows(t))[0]).toMatchObject({ state: 'deleted' });
      // A read older than the tombstone does not revive it.
      const older = await observe(
        t,
        observeInput('obs-1', 'onprem', {
          observedAt: at(4),
          sourceUpdatedAt: at(4),
          fieldHash: HASH_B,
        }),
      );
      expect(older.decision).toBe('stale');
      expect((await rows(t))[0]).toMatchObject({ state: 'deleted' });
      // A later read reactivates the same row.
      const back = await observe(
        t,
        observeInput('obs-1', 'onprem', {
          observedAt: at(6),
          sourceUpdatedAt: at(6),
          fieldHash: HASH_B,
        }),
      );
      expect(back).toMatchObject({ decision: 'restore', referenceId: row!.id });
      expect(await rows(t)).toHaveLength(1);
      expect((await rows(t))[0]).toMatchObject({ id: row!.id, state: 'active' });

      expect((await changes(t, 'obs-1')).map((ch) => ch.change_type)).toEqual([
        'ref_added',
        'updated',
        'state_changed',
        'reactivated',
      ]);
      for (const ch of await changes(t, 'obs-1')) {
        expect(ch).toMatchObject({
          entity_kind: 'product',
          entity_key: 'onprem',
          entity_id: null,
          cause: 'backfill',
        });
      }
    });

    it('refuses an identity conflict (another key, or a declared triple) and a legacy kind', async () => {
      const t = await c.tenant('srconf', 1001);
      await publish(t, { core: [pt('decl-1')] });
      await observe(t, observeInput('obs-2', 'onprem'));
      await expect(
        observe(t, observeInput('obs-2', 'suite', { observedAt: at(9), sourceUpdatedAt: at(9) })),
      ).rejects.toMatchObject({ code: 'reference_identity_conflict' });
      await expect(observe(t, observeInput('decl-1', 'core'))).rejects.toMatchObject({
        code: 'reference_identity_conflict',
      });
      await expect(
        observe(t, { ...observeInput('obs-3', 'onprem'), entityKind: 'company' }),
      ).rejects.toMatchObject({ code: 'reference_kind_not_generic' });
      expect((await rows(t)).find((x) => x.external_id === 'obs-2')).toMatchObject({
        entity_key: 'onprem',
      });
      expect(await changes(t, 'obs-3')).toEqual([]);
    });
  });

  describe('V7: retireAbsentWithin', () => {
    it('retires only on accepted proven full runs without uncertainty; seen, rejected, protected and declared rows never', async () => {
      const t = await c.tenant('srret', 2002);
      await publish(t, { core: [pt('d-1')] });
      for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) await observe(t, observeInput(id, 'onprem'));
      const runId = await checkpoint(t);
      const actx = await authz(t, 'canonical.source_sync');
      const retire = (over: Partial<Parameters<SourceReferenceService['retireAbsentWithin']>[2]>) =>
        db().transaction(t, (tx) =>
          refs().retireAbsentWithin(actx, tx, {
            system: 'sugar',
            objectType: PT,
            runId,
            meta: { ...META, checkpointId: runId },
            accepted: true,
            proven: true,
            full: true,
            uncertain: false,
            observedAt: at(10),
            seen: new Set(['r1']),
            rejected: new Set(['r2']),
            protectedIds: new Set(['r3']),
            ...over,
          }),
        );
      for (const ineligible of [
        { accepted: false },
        { proven: false },
        { full: false },
        { uncertain: true },
      ]) {
        await expect(retire(ineligible)).resolves.toBe(0);
        expect((await rows(t)).every((x) => x.state === 'active')).toBe(true);
      }
      await expect(retire({})).resolves.toBe(2);
      const after = await rows(t);
      expect(after.map((x) => [x.external_id, x.state, x.retired_by_run_id])).toEqual([
        ['d-1', 'active', null],
        ['r1', 'active', null],
        ['r2', 'active', null],
        ['r3', 'active', null],
        ['r4', 'retired', runId],
        ['r5', 'retired', runId],
      ]);
      expect((await changes(t, 'r4')).map((ch) => ch.change_type)).toEqual([
        'ref_added',
        'retired',
      ]);
      expect((await changes(t, 'r1')).map((ch) => ch.change_type)).toEqual(['ref_added']);
      // A reference read after the run's read time is not retired.
      await observe(
        t,
        observeInput('r6', 'onprem', { observedAt: at(20), sourceUpdatedAt: at(20) }),
      );
      await expect(retire({ seen: new Set(['r1', 'r2', 'r3']) })).resolves.toBe(0);
    });

    it('V2: the database retirement gate refuses retirement without a run (observed) or without a model version (declared)', async () => {
      const t = await c.tenant('srgate', 3003);
      await publish(t, { core: [pt('g-1')] });
      await observe(t, observeInput('g-2', 'onprem'));
      await expect(
        c.sql(
          `UPDATE tenant_source_references SET state = 'retired', retired_at = now()
            WHERE tenant_id = $1 AND external_id = 'g-2'`,
          [t.tenantId],
        ),
      ).rejects.toThrow(/tenant_source_references_retirement_gate/);
      await expect(
        c.sql(
          `UPDATE tenant_source_references SET state = 'retired', retired_at = now()
            WHERE tenant_id = $1 AND external_id = 'g-1'`,
          [t.tenantId],
        ),
      ).rejects.toThrow(/tenant_source_references_retirement_gate/);
      // An observed row cannot carry a model-version retirement either.
      await expect(
        c.sql(
          `UPDATE tenant_source_references SET state = 'retired', retired_at = now(), retired_by_model_version = 1
            WHERE tenant_id = $1 AND external_id = 'g-2'`,
          [t.tenantId],
        ),
      ).rejects.toThrow(/tenant_source_references_retirement_gate/);
    });
  });

  describe('V8: merge', () => {
    it('re-points to the survivor, marks merged with lineage and one change record; idempotent; self-merge refused', async () => {
      const t = await c.tenant('srmrg', 1001);
      await publish(t, {});
      await observe(t, observeInput('m-1', 'onprem'));
      await observe(t, observeInput('m-2', 'suite'));
      const actx = await authz(t, 'canonical.source_sync');
      const merge = (from: string, to: string) =>
        db().transaction(t, (tx) =>
          refs().merge(actx, tx, {
            system: 'sugar',
            objectType: PT,
            fromExternalId: from,
            survivorExternalId: to,
            observedAt: at(5),
            meta: META,
          }),
        );
      await expect(merge('m-1', 'm-2')).resolves.toBe('merged');
      const m1 = (await rows(t)).find((x) => x.external_id === 'm-1')!;
      expect(m1).toMatchObject({
        state: 'merged',
        merged_into_external_id: 'm-2',
        entity_key: 'suite',
      });
      const mergedChanges = await changes(t, 'm-1');
      expect(mergedChanges.map((ch) => [ch.change_type, ch.entity_key])).toEqual([
        ['ref_added', 'onprem'],
        ['merged', 'suite'],
      ]);
      expect(m1.last_change_id).toBe(mergedChanges.at(-1)!.id);
      await expect(merge('m-1', 'm-2')).resolves.toBe('unchanged');
      expect(await changes(t, 'm-1')).toHaveLength(2);
      await expect(merge('m-2', 'm-2')).rejects.toMatchObject({
        code: 'reference_identity_conflict',
      });
      // A merged reference is terminal for observations.
      await expect(
        observe(t, observeInput('m-1', 'suite', { observedAt: at(9), sourceUpdatedAt: at(9) })),
      ).resolves.toMatchObject({ decision: 'stale' });
    });

    it('V2: identity columns are immutable; an observed row is re-pointed only by a merge', async () => {
      const t = await c.tenant('srimm', 2002);
      await publish(t, {});
      await observe(t, observeInput('i-1', 'onprem'));
      for (const set of [
        `external_id = 'i-9'`,
        `system = 'hubspot'`,
        `object_type = 'Other'`,
        `origin = 'declared', declared_in_model_version = 1`,
      ]) {
        await expect(
          c.sql(`UPDATE tenant_source_references SET ${set} WHERE tenant_id = $1`, [t.tenantId]),
        ).rejects.toThrow(/source reference identity is immutable/);
      }
      await expect(
        c.sql(`UPDATE tenant_source_references SET entity_key = 'suite' WHERE tenant_id = $1`, [
          t.tenantId,
        ]),
      ).rejects.toThrow(/re-pointed only by a merge or a re-declaration/);
    });
  });

  describe('V2: generic store constraints', () => {
    it('exactly one entity form, legacy kinds refused (named CHECK present), declared needs a version, identifiers only, no DELETE for the app role', async () => {
      const t = await c.tenant('srcon', 3003);
      await publish(t, {});
      const insert = (cols: string, vals: string) =>
        asApp(t, (client) =>
          client.query(
            `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, origin${cols})
             VALUES ('${t.tenantId}', 'sugar', '${PT}', 'c-1', 'product', 'observed'${vals})`,
          ),
        );
      await expect(insert('', '')).rejects.toThrow(/one_identity|key_only_for_products/);
      await expect(
        insert(', entity_key, entity_id', `, 'core', gen_random_uuid()`),
      ).rejects.toThrow(/one_identity|key_only_for_products/);
      await expect(
        asApp(t, (client) =>
          client.query(
            `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_key, origin)
             VALUES ($1, 'sugar', '${PT}', 'c-2', 'product', 'core', 'declared')`,
            [t.tenantId],
          ),
        ),
      ).rejects.toThrow(/tenant_source_references_declared_version/);
      await expect(
        insert(', entity_key', `, 'core'`).then(() => undefined),
      ).resolves.toBeUndefined();
      // Identifiers only (pattern CHECKs).
      await expect(
        asApp(t, (client) =>
          client.query(
            `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_key, origin)
             VALUES ($1, 'sugar', '${PT}', 'has a space', 'product', 'core', 'observed')`,
            [t.tenantId],
          ),
        ),
      ).rejects.toThrow(/tenant_source_references_external_id_format/);
      for (const legacy of ['company', 'person', 'subscription']) {
        await expect(
          asApp(t, (client) =>
            client.query(
              `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_id, origin)
               VALUES ($1, 'sugar', 'Accounts', 'l-1', $2, gen_random_uuid(), 'observed')`,
              [t.tenantId, legacy],
            ),
          ),
        ).rejects.toThrow(/entity_kind_valid|not_legacy_kind/);
      }
      const [legacyCheck] = await c.sql<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'tenant_source_references_not_legacy_kind'`,
      );
      expect(legacyCheck!.def).toMatch(/company.*person.*subscription/);
      // References change state, never disappear.
      await observe(t, observeInput('c-3', 'onprem'));
      await expect(
        asApp(t, (client) => client.query(`DELETE FROM tenant_source_references`)),
      ).rejects.toThrow(/permission denied/);
      expect(await rows(t)).toHaveLength(1);
    });
  });

  describe('V11/V12: tenant isolation of references and the view', () => {
    it('raw SQL as the app role cannot bind a reference to another tenant; RLS hides other tenants in table and view', async () => {
      const a = await c.tenant('srisoa', 1001);
      const b = await c.tenant('srisob', 2002);
      await publish(a, { core: [pt('a-1')] });
      await publish(b, { core: [pt('b-1')], 'b-only': [pt('b-2')] }, ['b-only']);
      // A names B's product key (absent in A): the composite index FK refuses.
      await expect(
        asApp(a, (client) =>
          client.query(
            `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_key, origin)
             VALUES ($1, 'sugar', '${PT}', 'x-1', 'product', 'b-only', 'observed')`,
            [a.tenantId],
          ),
        ),
      ).rejects.toThrow(/tenant_source_references_tenant_id_entity_kind_entity_key_fkey/);
      // A writes a row for B: RLS WITH CHECK refuses.
      await expect(
        asApp(a, (client) =>
          client.query(
            `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_key, origin)
             VALUES ($1, 'sugar', '${PT}', 'x-2', 'product', 'core', 'observed')`,
            [b.tenantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      const seen = await asApp(a, async (client) => ({
        table: (
          await client.query(`SELECT DISTINCT tenant_id::text AS t FROM tenant_source_references`)
        ).rows,
        view: (
          await client.query(`SELECT DISTINCT tenant_id::text AS t FROM source_reference_index`)
        ).rows,
        bUpdate: (
          await client.query(
            `UPDATE tenant_source_references SET last_seen_at = now() WHERE tenant_id = $1`,
            [b.tenantId],
          )
        ).rowCount,
      }));
      expect(seen).toEqual({ table: [{ t: a.tenantId }], view: [{ t: a.tenantId }], bUpdate: 0 });
      expect(await rows(b)).toHaveLength(2);
    });

    it('V12: security_invoker view, read-only for the app role, union per store equals the stores', async () => {
      const t = await c.tenant('srview', 3003);
      await publish(t, { core: [pt('v-1'), pt('v-2')] });
      await c.ingestion.ingest(
        await authz(t, 'canonical.source_sync'),
        {
          kind: 'company',
          presence: 'present',
          ref: { system: 'hubspot', objectType: 'companies', id: '7101' },
          observedAt: new Date(),
          fields: { name: 'View Co' },
        },
        { cause: 'webhook', correlationId: randomUUID() },
      );
      const [rel] = await c.sql<{ reloptions: string[] }>(
        `SELECT reloptions FROM pg_class WHERE relname = 'source_reference_index'`,
      );
      expect(rel!.reloptions).toContain('security_invoker=true');
      for (const sql of [
        `INSERT INTO source_reference_index (tenant_id) VALUES ('${t.tenantId}')`,
        `UPDATE source_reference_index SET state = 'retired'`,
        `DELETE FROM source_reference_index`,
      ]) {
        await expect(asApp(t, (client) => client.query(sql))).rejects.toThrow(
          /permission denied|cannot (insert into|update|delete from) view/,
        );
      }
      expect(
        await c.sql(
          `SELECT p, has_table_privilege('lip_app', 'source_reference_index', p) AS ok
             FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p`,
        ),
      ).toEqual([
        { p: 'SELECT', ok: true },
        { p: 'INSERT', ok: false },
        { p: 'UPDATE', ok: false },
        { p: 'DELETE', ok: false },
        { p: 'TRUNCATE', ok: false },
      ]);
      const perStore = await asApp(
        t,
        async (client) =>
          (
            await client.query<{ store: string; entity_kind: string; n: number }>(
              `SELECT store, entity_kind, count(*)::int AS n FROM source_reference_index GROUP BY 1, 2 ORDER BY 1`,
            )
          ).rows,
      );
      const [companyRefs] = await c.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM company_external_refs WHERE tenant_id = $1`,
        [t.tenantId],
      );
      expect(perStore).toEqual([
        { store: 'company_external_refs', entity_kind: 'company', n: companyRefs!.n },
        { store: 'tenant_source_references', entity_kind: 'product', n: 2 },
      ]);
      expect(companyRefs!.n).toBeGreaterThan(0);
    });
  });

  describe('V15: the 0.2 adoption gate for observed references', () => {
    it('at 0.1 observe / retire / merge are refused and audited; declared projection still runs; data kept; after adoption accepted; module settings untouched', async () => {
      const t = await c.tenant('srgate2', 1001);
      await publish(t, {});
      await observe(t, observeInput('k-1', 'onprem'));
      const settingsBefore = await c.sql(
        `SELECT module_key, enabled, version FROM tenant_module_settings WHERE tenant_id = $1 ORDER BY 1`,
        [t.tenantId],
      );
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.1',
        expectedCurrent: '0.2',
      });
      await expect(observe(t, observeInput('k-2', 'onprem'))).rejects.toMatchObject({
        code: 'canonical_version_too_low',
      });
      const actx = await authz(t, 'canonical.source_sync');
      const runId = await checkpoint(t);
      await expect(
        db().transaction(t, (tx) =>
          refs().retireAbsentWithin(actx, tx, {
            system: 'sugar',
            objectType: PT,
            runId,
            meta: META,
            accepted: true,
            proven: true,
            full: true,
            uncertain: false,
            observedAt: at(10),
            seen: new Set(),
          }),
        ),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      await expect(
        db().transaction(t, (tx) =>
          refs().merge(actx, tx, {
            system: 'sugar',
            objectType: PT,
            fromExternalId: 'k-3',
            survivorExternalId: 'k-1',
            observedAt: at(5),
            meta: META,
          }),
        ),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      const refusals = await auditOf(t, 'source_reference.observe');
      expect(refusals.length).toBeGreaterThanOrEqual(3);
      expect(refusals.every((e) => JSON.stringify(e).includes('canonical_version_too_low'))).toBe(
        true,
      );
      // Rollback keeps data: the observed row is still there, unretired.
      expect((await rows(t)).map((x) => [x.external_id, x.state])).toEqual([['k-1', 'active']]);
      // The declared projection runs at every version (Q7).
      await publish(t, { core: [pt('k-decl')] });
      expect((await rows(t)).map((x) => x.external_id)).toEqual(['k-1', 'k-decl']);
      expect((await changes(t, 'k-decl')).map((ch) => ch.canonical_version)).toEqual(['0.1']);

      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.2',
        expectedCurrent: '0.1',
      });
      await expect(observe(t, observeInput('k-2', 'onprem'))).resolves.toMatchObject({
        decision: 'create',
      });
      expect(
        await c.sql(
          `SELECT module_key, enabled, version FROM tenant_module_settings WHERE tenant_id = $1 ORDER BY 1`,
          [t.tenantId],
        ),
      ).toEqual(settingsBefore);
    });
  });

  describe('V16: change-record widening', () => {
    it('exactly one of entity_id / entity_key; key only for products; pre-M10B kinds keep entity_id', async () => {
      const t = await c.tenant('srchg', 2002);
      await publish(t, { core: [pt('w-1')] });
      const plant = (kind: string, id: string, key: string) =>
        c.sql(
          `INSERT INTO tenant_context_changes (tenant_id, id, entity_kind, entity_id, entity_key, change_type, source_system,
             source_object_type, source_record_id, cause, adapter, adapter_version, correlation_id)
           VALUES ($1, gen_random_uuid(), $2, ${id}, ${key}, 'updated', 'sugar', 'X', 'x1', 'backfill', 'sugar', 't',
             gen_random_uuid())`,
          [t.tenantId, kind],
        );
      await expect(plant('product', 'NULL', 'NULL')).rejects.toThrow(
        /tenant_context_changes_one_identity/,
      );
      await expect(plant('product', 'gen_random_uuid()', `'core'`)).rejects.toThrow(
        /tenant_context_changes_one_identity/,
      );
      await expect(plant('product', 'gen_random_uuid()', 'NULL')).rejects.toThrow(
        /tenant_context_changes_key_only_for_products/,
      );
      await expect(plant('company', 'NULL', `'core'`)).rejects.toThrow(
        /tenant_context_changes_key_only_for_products/,
      );
      await expect(plant('widget', 'gen_random_uuid()', 'NULL')).rejects.toThrow(
        /tenant_context_changes_entity_kind_valid/,
      );
      await c.ingestion.ingest(
        await authz(t, 'canonical.source_sync'),
        {
          kind: 'company',
          presence: 'present',
          ref: { system: 'hubspot', objectType: 'companies', id: '7201' },
          observedAt: new Date(),
          fields: { name: 'Change Co' },
        },
        { cause: 'webhook', correlationId: randomUUID() },
      );
      const byKind = await c.sql<{ entity_kind: string; with_id: number; with_key: number }>(
        `SELECT entity_kind, count(entity_id)::int AS with_id, count(entity_key)::int AS with_key
           FROM tenant_context_changes WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`,
        [t.tenantId],
      );
      expect(byKind.find((r) => r.entity_kind === 'product')).toEqual({
        entity_kind: 'product',
        with_id: 0,
        with_key: 1,
      });
      const company = byKind.find((r) => r.entity_kind === 'company')!;
      expect(company.with_id).toBeGreaterThan(0);
      expect(company.with_key).toBe(0);
    });
  });
});
