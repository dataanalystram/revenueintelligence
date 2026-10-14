import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeSugar } from '../support/fake-sugar';
import { authz } from '../support/security';
import {
  acknowledgementsFor,
  publishWithAcks,
  sourcesServices,
  sugarTenant,
  type SourcesFixture,
} from '../support/sources';

/**
 * M10A2 V15: the mapping lifecycle end to end with the production Sugar
 * adapter against the deterministic fake, on real PostgreSQL (app role,
 * forced RLS): draft → validate → publish (supersedes the previous version),
 * retire (sync refused with `mapping_not_published` until a new version is
 * published), and the database refusing illegal transitions.
 */
describe('M10A2 V15: mapping lifecycle (fake Sugar)', () => {
  let c: ContextHarness;
  let fake: FakeSugar;
  let f: SourcesFixture;

  beforeAll(async () => {
    c = await startContextHarness();
    fake = await new FakeSugar().start();
    // v1 (terms pending) → authority → v2: v1 superseded, v2 published.
    f = await sugarTenant(c, fake, { prefix: 'v15' });
  });
  afterAll(async () => {
    await fake?.stop();
    await c?.close();
  });

  const s = () => sourcesServices(c);
  const states = async () =>
    (await s().mappings.states(f.ctx, f.connectionId)).map((x) => ({
      version: x.version,
      state: x.state,
    }));
  const lifecycle = (t: TenantContext) =>
    c.sql<{
      version: number;
      seq: number;
      state: string;
      reason_code: string | null;
      audit_event_id: string | null;
    }>(
      `SELECT version, seq, state, reason_code, audit_event_id::text
         FROM tenant_source_mapping_lifecycle
        WHERE tenant_id = $1 AND connection_id = $2
        ORDER BY version, seq`,
      [t.tenantId, f.connectionId],
    );
  const auditOf = (id: string) =>
    c.sql<{ action: string; outcome: string; target_ref: string }>(
      `SELECT action, outcome, target_ref FROM tenant_audit_events WHERE id = $1`,
      [id],
    );
  const currentDocument = async () =>
    (await s().mappings.show(f.ctx, f.connectionId))!.document as unknown;
  const insertLifecycle = (version: number, seq: number, state: string, reason?: string) =>
    c.sql(
      `INSERT INTO tenant_source_mapping_lifecycle
         (tenant_id, connection_id, version, seq, state, actor_kind, actor_id, actor_assurance, reason_code, audit_event_id)
       VALUES ($1, $2, $3, $4, $5, 'operator', 'test-operator', 'asserted', $6, $7)`,
      [f.ctx.tenantId, f.connectionId, version, seq, state, reason ?? null, randomUUID()],
    );

  it('starts with v1 superseded and v2 published, each change carrying its audit event', async () => {
    expect(await states()).toEqual([
      { version: 1, state: 'superseded' },
      { version: 2, state: 'published' },
    ]);
    const rows = await lifecycle(f.ctx);
    const superseded = rows.find((r) => r.version === 1 && r.state === 'superseded')!;
    const published = rows.find((r) => r.version === 2 && r.state === 'published')!;
    // Supersession and publication are one change: one audit event for both.
    expect(superseded.audit_event_id).toBe(published.audit_event_id);
    expect(await auditOf(published.audit_event_id!)).toEqual([
      { action: 'mapping.publish', outcome: 'allowed', target_ref: `${f.connectionId}/v2` },
    ]);
  });

  it('draft → validate → publish; an edit returns the draft to draft and publication needs validation', async () => {
    const draftAuth = () => authz(f.ctx, 'config.mapping.draft');
    const publishAuth = () => authz(f.ctx, 'config.mapping.publish');
    const doc = await currentDocument();

    // No draft at all: nothing to publish.
    await expect(
      s().mappings.publishDraft(await publishAuth(), f.connectionId, 2),
    ).rejects.toMatchObject({ code: 'mapping_not_validated' });

    const saved = await s().mappings.saveDraft(await draftAuth(), f.connectionId, doc, 0);
    expect(saved).toMatchObject({ state: 'draft', version: 1 });
    // A stale draft version is refused.
    await expect(
      s().mappings.saveDraft(await draftAuth(), f.connectionId, doc, 0),
    ).rejects.toMatchObject({ code: 'stale_base_version' });
    // Saved but not validated: publication refused.
    await expect(
      s().mappings.publishDraft(await publishAuth(), f.connectionId, 2),
    ).rejects.toMatchObject({ code: 'mapping_not_validated' });

    // Without the acknowledgements its covering profiles require, validation fails
    // and the draft stays a draft (M9A §7.4 applies to drafts too).
    const needed = acknowledgementsFor(await s().mappings.validate(f.ctx, f.connectionId, doc));
    if (needed.length > 0) {
      await expect(
        s().mappings.validateDraft(await draftAuth(), f.connectionId, 1),
      ).rejects.toMatchObject({ code: 'mapping_invalid' });
      expect((await s().mappings.showDraft(f.ctx, f.connectionId))!.state).toBe('draft');
    }
    const validated = await s().mappings.validateDraft(await draftAuth(), f.connectionId, 1, {
      acknowledgements: needed,
    });
    expect(validated.draft.state).toBe('validated');
    expect(validated.report.ok).toBe(true);

    // Any edit returns the working copy to draft (database trigger).
    const edited = await s().mappings.saveDraft(await draftAuth(), f.connectionId, doc, 1);
    expect(edited).toMatchObject({ state: 'draft', version: 2 });
    await expect(
      s().mappings.publishDraft(await publishAuth(), f.connectionId, 2),
    ).rejects.toMatchObject({ code: 'mapping_not_validated' });
    expect(await states()).toEqual([
      { version: 1, state: 'superseded' },
      { version: 2, state: 'published' },
    ]);

    await s().mappings.validateDraft(await draftAuth(), f.connectionId, 2, {
      acknowledgements: needed,
    });
    // A stale publication base is refused even with a validated draft.
    await expect(
      s().mappings.publishDraft(await publishAuth(), f.connectionId, 1),
    ).rejects.toMatchObject({ code: 'concurrent_publish' });
    const published = await s().mappings.publishDraft(await publishAuth(), f.connectionId, 2);
    expect(published.version).toBe(3);
    // The working copy is consumed.
    expect(await s().mappings.showDraft(f.ctx, f.connectionId)).toBeUndefined();
    expect(await states()).toEqual([
      { version: 1, state: 'superseded' },
      { version: 2, state: 'superseded' },
      { version: 3, state: 'published' },
    ]);
  });

  it('retire: sync is refused (mapping_not_published) until a new version is published', async () => {
    const retireAuth = () => authz(f.ctx, 'config.mapping.retire');
    const syncAuth = () => authz(f.ctx, 'data.sync.run');

    const retired = await s().mappings.retire(
      await retireAuth(),
      f.connectionId,
      3,
      'operator_retired',
    );
    expect(retired).toEqual({ version: 3, previousState: 'published' });
    const row = (await lifecycle(f.ctx)).find((r) => r.version === 3 && r.state === 'retired')!;
    expect(row.reason_code).toBe('operator_retired');
    expect(await auditOf(row.audit_event_id!)).toEqual([
      { action: 'mapping.retire', outcome: 'allowed', target_ref: `${f.connectionId}/v3` },
    ]);
    expect(await s().mappings.show(f.ctx, f.connectionId, 3)).toBeDefined();

    await expect(
      s().sync.start(await syncAuth(), f.connectionId, 'full', {
        enqueue: false,
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'mapping_not_published' });

    // Already retired, unknown version, unknown reason.
    await expect(
      s().mappings.retire(await retireAuth(), f.connectionId, 3, 'operator_retired'),
    ).rejects.toMatchObject({ code: 'no_change' });
    await expect(
      s().mappings.retire(await retireAuth(), f.connectionId, 99, 'operator_retired'),
    ).rejects.toMatchObject({ code: 'mapping_not_found' });
    await expect(
      s().mappings.retire(
        await retireAuth(),
        f.connectionId,
        1,
        'because' as unknown as 'operator_retired',
      ),
    ).rejects.toMatchObject({ code: 'invalid_reason' });

    // A superseded version may be retired too.
    expect(
      await s().mappings.retire(await retireAuth(), f.connectionId, 1, 'connection_disabled'),
    ).toEqual({ version: 1, previousState: 'superseded' });

    // A new publication restores a published mapping and sync starts again.
    const republished = await publishWithAcks(
      c,
      f,
      (await s().mappings.show(f.ctx, f.connectionId, 3))!.document,
      3,
    );
    expect(republished.version).toBe(4);
    expect(await states()).toEqual([
      { version: 1, state: 'retired' },
      { version: 2, state: 'superseded' },
      { version: 3, state: 'retired' },
      { version: 4, state: 'published' },
    ]);
    const started = await s().sync.start(await syncAuth(), f.connectionId, 'full', {
      enqueue: false,
      correlationId: randomUUID(),
    });
    expect(started.runId).toBeDefined();
  });

  it('the database refuses illegal transitions and a second published version', async () => {
    const illegal = /illegal mapping lifecycle transition/;
    // Nothing leaves retired.
    await expect(insertLifecycle(3, 3, 'published')).rejects.toThrow(illegal);
    await expect(insertLifecycle(3, 3, 'superseded')).rejects.toThrow(illegal);
    // published → published, and a gap in seq.
    await expect(insertLifecycle(4, 2, 'published')).rejects.toThrow(illegal);
    await expect(insertLifecycle(4, 5, 'superseded')).rejects.toThrow(illegal);
    // superseded → published (no resurrection).
    await expect(insertLifecycle(2, 3, 'published')).rejects.toThrow(illegal);
    // A retirement needs one of the known reasons (CHECK).
    await expect(insertLifecycle(4, 2, 'retired', 'because')).rejects.toThrow(
      /tenant_source_mapping_lifecycle_retire_reason/,
    );
    expect(await states()).toEqual([
      { version: 1, state: 'retired' },
      { version: 2, state: 'superseded' },
      { version: 3, state: 'retired' },
      { version: 4, state: 'published' },
    ]);
  });

  it('the lifecycle is append-only for the app role', async () => {
    const client = new Client({ connectionString: c.appUrl });
    await client.connect();
    try {
      for (const statement of [
        `UPDATE tenant_source_mapping_lifecycle SET state = 'published' WHERE version = 3`,
        `DELETE FROM tenant_source_mapping_lifecycle WHERE version = 3`,
      ]) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [f.ctx.tenantId]);
        await expect(client.query(statement)).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK');
      }
    } finally {
      await client.end();
    }
  });
});
