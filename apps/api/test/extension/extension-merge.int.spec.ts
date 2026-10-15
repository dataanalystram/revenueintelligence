import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/modules/tenancy';
import { advisoryLockKey } from '../../src/modules/tenancy/infrastructure/tenant-database';
import {
  appSession,
  companies,
  contact,
  hs,
  ingestMeta,
  observePerson,
  personIdOf,
} from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import {
  edgesOf,
  entryId,
  extChangesOf,
  extIssuesOf,
  extensionTenant,
  recordsOf,
  REASON,
  services,
  sourceProvenance,
  valuesOf,
} from '../support/extension';
import { authz } from '../support/security';

/**
 * M10D `ExtensionMergeParticipant` through the real merge (plan §7, §19 V11,
 * Q22) on the company and the person merge ports: loser-only values copied
 * (origin kept, change record `merged`, value history when enabled), equal
 * values skipped, differing values keep the survivor's and open
 * `extension_value_conflict` (never silently overwritten); loser rows stay;
 * custom records whose parent is the loser are re-pointed; reference values
 * and relationship edges are not rewritten (readers follow lineage).
 */
describe('M10D extension merge participant (company and person ports)', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const observe = async (
    t: TenantContext,
    kind: 'company' | 'person',
    id: string,
    values: Record<string, unknown>,
  ) =>
    services(c).values.observeSource(await authz(t, 'canonical.source_sync'), {
      target: { kind, id },
      values: Object.entries(values).map(([field, raw]) => ({ field, raw })),
      observedAt: new Date(),
      provenance: sourceProvenance(`m-${id.slice(0, 8)}`),
    });
  const merge = async (
    t: TenantContext,
    kind: 'company' | 'person',
    survivor: string,
    merged: string[],
  ) =>
    c.ingestion.ingestMerge(
      await authz(t, 'canonical.source_sync'),
      {
        kind,
        survivor: kind === 'company' ? hs(survivor) : contact(survivor),
        merged: merged.map(kind === 'company' ? hs : contact),
        observedAt: new Date(),
      },
      ingestMeta(),
    );

  it('V11 company merge: copy loser-only, skip equal, conflict on differ; loser rows kept; record parents re-pointed; references and edges follow lineage', async () => {
    const t = await extensionTenant(c, 'xmerge');
    const ids = await companies(c, t, ['5001', '5002', '5003']);
    const [loser, survivor, third] = [ids['5001']!, ids['5002']!, ids['5003']!];
    await observe(t, 'company', loser, {
      x_string: 'loser',
      x_text: 'only on loser',
      x_integer: 5,
      x_multi: 'a;b',
    });
    await observe(t, 'company', survivor, { x_string: 'survivor', x_integer: '5' });
    // Human origin is kept on the copy.
    await services(c).values.set(await authz(t, 'canonical.human_entry'), {
      target: `company:${loser}`,
      field: 'x_boolean',
      value: 'true',
      reason: REASON,
    });
    // A reference to the loser, a site whose parent is the loser, an edge to the loser.
    await observe(t, 'company', third, { x_ref: `account:${loser}` });
    const site = await services(c).records.createRecord(await authz(t, 'canonical.human_entry'), {
      object: 'site',
      parent: `company:${loser}`,
      values: { site_code: 'M-1' },
      reason: REASON,
    });
    const edge = await services(c).relationships.add(await authz(t, 'canonical.human_entry'), {
      relationship: 'site_owner',
      from: `custom_record:${site.recordId}`,
      to: `company:${loser}`,
      reason: REASON,
    });
    const loserBefore = await valuesOf(c, t, loser);

    await merge(t, 'company', '5002', ['5001']);

    const after = await valuesOf(c, t, survivor);
    expect(after.x_string!.value_text).toBe('survivor'); // never overwritten
    expect(after.x_integer!.value_number).toBe('5');
    expect(after.x_text).toMatchObject({ value_text: 'only on loser', origin: 'source_provided' });
    expect(after.x_boolean).toMatchObject({ value_bool: true, origin: 'human', released_at: null });
    expect(after.x_multi!.value_item_count).toBe(2);
    expect(
      (
        await c.sql<{ item_enum: string }>(
          `SELECT item_enum FROM tenant_extension_value_items WHERE tenant_id = $1 AND value_id = $2 ORDER BY ordinal`,
          [t.tenantId, after.x_multi!.id],
        )
      ).map((r) => r.item_enum),
    ).toEqual(['a', 'b']);
    // Loser rows are kept unchanged (lineage).
    expect(await valuesOf(c, t, loser)).toEqual(loserBefore);
    // The copy is one `merged` change record on the survivor with ext: tokens.
    const merged = (await extChangesOf(c, t, survivor)).filter((ch) => ch.change_type === 'merged');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.changed_fields).toEqual(['ext:x_boolean', 'ext:x_multi', 'ext:x_text']);
    for (const k of ['x_text', 'x_boolean', 'x_multi']) {
      expect(after[k]!.last_change_id).toBe(merged[0]!.id);
    }
    // Differing value → one open conflict naming both ids and the field (no values).
    const fieldId = await entryId(c, t, 'x_string');
    const conflicts = await extIssuesOf(c, t, 'extension_value_conflict');
    expect(conflicts).toEqual([
      {
        kind: 'extension_value_conflict',
        entity_kind: 'company',
        state: 'open',
        canonical_ids: [loser, survivor, fieldId].sort(),
        external_refs: ['extension:field:x_string'],
      },
    ]);
    expect(JSON.stringify(conflicts)).not.toContain('loser"');
    // The site's parent follows the survivor (relationship_changed).
    expect((await recordsOf(c, t))[0]).toMatchObject({ parent_id: survivor });
    expect((await extChangesOf(c, t, site.recordId)).at(-1)).toMatchObject({
      change_type: 'relationship_changed',
      changed_fields: ['parentId'],
    });
    // References and edges are not rewritten; readers follow lineage.
    expect((await valuesOf(c, t, third)).x_ref!.value_ref_id).toBe(loser);
    expect((await edgesOf(c, t)).map((e) => [e.id, e.to_id, e.state])).toEqual([
      [edge.edgeId, loser, 'active'],
    ]);
    const read = await services(c).read.valuesFor(
      await authz(t, 'data.extension.read'),
      'display',
      [`company:${third}`],
      { fields: ['x_ref'] },
    );
    expect(read).toEqual([
      expect.objectContaining({
        field: 'x_ref',
        value: { kind: 'company', id: loser },
        resolvedReference: `company:${survivor}`,
      }),
    ]);
    // A second merge of an already merged loser changes nothing more.
    expect(await extIssuesOf(c, t, 'extension_value_conflict')).toHaveLength(1);
  });

  it('V11 person merge: the same rules on the person port; value history for a history field', async () => {
    const t = await extensionTenant(c, 'xmergep');
    await observePerson(c, t, '5101', { email: 'shared5101@school.example' });
    await observePerson(c, t, '5102', { email: 'other5102@school.example' });
    const loser = await personIdOf(c, t, '5101');
    const survivor = await personIdOf(c, t, '5102');
    await observe(t, 'person', loser, { p_note: 'note' });
    await merge(t, 'person', '5102', ['5101']);
    const after = await valuesOf(c, t, survivor);
    expect(after.p_note).toMatchObject({ value_text: 'note', origin: 'source_provided' });
    const history = await c.sql<{ entity_id: string; values_recorded: boolean }>(
      `SELECT entity_id::text, values_recorded FROM tenant_value_history
        WHERE tenant_id = $1 AND field = 'ext:p_note' ORDER BY recorded_at`,
      [t.tenantId],
    );
    // Loser's own write and the survivor's copy; personal → value-free.
    expect(history).toEqual([
      { entity_id: loser, values_recorded: false },
      { entity_id: survivor, values_recorded: false },
    ]);
    expect(await extIssuesOf(c, t, 'extension_value_conflict')).toEqual([]);
  });

  it('V11 the merge is never blocked by the gate: a tenant rolled back to 0.3 still merges and copies', async () => {
    const t = await extensionTenant(c, 'xmergeg');
    const ids = await companies(c, t, ['5201', '5202']);
    await observe(t, 'company', ids['5201']!, { x_text: 'kept' });
    await services(c).adoption.adopt(await authz(t, 'config.canonical.adopt'), {
      target: '0.3',
      expectedCurrent: '0.4',
    });
    await merge(t, 'company', '5202', ['5201']);
    expect((await valuesOf(c, t, ids['5202'])).x_text!.value_text).toBe('kept');
  });

  it('review M1 two concurrent sessions: a value write racing a company merge leaves no value stranded on the loser and no unique-index error', async () => {
    const t = await extensionTenant(c, 'xmergerace');
    const ids = await companies(c, t, ['5301', '5302']);
    const [loser, survivor] = [ids['5301']!, ids['5302']!];
    // Session A holds the loser's extension-target lock, so the merge and the
    // writer queue behind it: the merge first, then the writer.
    const a = await appSession(c, t);
    let mergeDone = false;
    let writeDone = false;
    let pendingMerge: Promise<unknown> | undefined;
    let pendingWrite: Promise<unknown> | undefined;
    try {
      await a.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [
        advisoryLockKey(t.tenantId, 'extension-target', `company:${loser}`).toString(),
      ]);
      pendingMerge = merge(t, 'company', '5302', ['5301']).finally(() => {
        mergeDone = true;
      });
      await new Promise((r) => setTimeout(r, 500));
      pendingWrite = observe(t, 'company', loser, { x_text: 'raced' }).finally(() => {
        writeDone = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(mergeDone).toBe(false); // waiting on the target lock
      expect(writeDone).toBe(false); // waiting on the target lock, not yet past the merged check
      await a.query('COMMIT');
      await expect(pendingMerge).resolves.toBeDefined();
      await expect(pendingWrite).resolves.toBeDefined();
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await a.end();
      await Promise.allSettled([pendingMerge, pendingWrite]);
    }
    const onLoser = await valuesOf(c, t, loser);
    expect((await valuesOf(c, t, survivor)).x_text).toBeUndefined();
    expect(onLoser.x_text).toBeUndefined();
    expect(await extIssuesOf(c, t, 'extension_value_conflict')).toEqual([]);

    // A source write to the survivor racing the merge copy: no unique-index error.
    const ids2 = await companies(c, t, ['5303', '5304']);
    const [loser2, survivor2] = [ids2['5303']!, ids2['5304']!];
    await observe(t, 'company', loser2, { x_text: 'from loser' });
    const b = await appSession(c, t);
    try {
      await b.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [
        advisoryLockKey(t.tenantId, 'extension-target', `company:${survivor2}`).toString(),
      ]);
      const m2 = merge(t, 'company', '5304', ['5303']);
      await new Promise((r) => setTimeout(r, 300));
      const w2 = observe(t, 'company', survivor2, { x_text: 'from survivor' });
      await new Promise((r) => setTimeout(r, 300));
      await b.query('COMMIT');
      const [rm, rw] = await Promise.allSettled([m2, w2]);
      expect(rm.status).toBe('fulfilled');
      expect(rw.status).toBe('fulfilled');
    } finally {
      await b.query('ROLLBACK').catch(() => undefined);
      await b.end();
    }
    // Exactly one survivor row for the field (the source write updated the copy).
    expect(
      (
        await c.sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM tenant_extension_values
            WHERE tenant_id = $1 AND target_id = $2 AND field_id = $3`,
          [t.tenantId, survivor2, await entryId(c, t, 'x_text')],
        )
      )[0]!.n,
    ).toBe('1');
  });
});
