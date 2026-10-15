import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CustomRecordWriter,
  type CustomRecordObservation,
  type ObservedParent,
} from '../../src/modules/extension';
import { ModuleGate, SourceReferenceService } from '../../src/modules/governance';
import { AuditTrail, TenantDatabase, type TenantContext } from '../../src/modules/tenancy';
import type { AppConfig } from '../../src/platform/config';
import { auditOf, companies, observePerson } from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import {
  changesOf,
  extIssuesOf,
  extensionTenant,
  importConnectionId,
  recordsOf,
  REASON,
  services,
  sourceProvenance,
  valuesOf,
} from '../support/extension';
import { authz } from '../support/security';

/**
 * M10D `CustomRecordWriter` on real PostgreSQL as the app role (plan §3.3,
 * §4.2, §19 V7 / V10): identity by generic source reference (kind
 * `custom_record`, Q15) then natural-key hash, required / optional /
 * unresolved parents with the open issue, lifecycle (retired terminal for
 * the source, operator reactivation audited), the records-per-object
 * guardrail, source references and the entity index, change records, and
 * fields through `ExtensionValueWriter` in the same transaction.
 */
describe('M10D custom records (CustomRecordWriter)', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const writer = () => services(c).records;
  const SITES = { system: 'hubspot', objectType: 'p_sites' } as const;
  const siteRef = (id: string) => ({ ...SITES, id });
  const accountParent = (id: string): ObservedParent => ({
    kind: 'company',
    ref: { system: 'hubspot', objectType: 'companies', id },
  });
  const observe = async (
    t: TenantContext,
    over: Partial<CustomRecordObservation> & { id: string },
    w: CustomRecordWriter = writer(),
  ) => {
    const { id, ...rest } = over;
    return w.observeSource(await authz(t, 'canonical.source_sync'), {
      objectKey: 'site',
      ref: siteRef(id),
      presence: 'present',
      values: [],
      observedAt: new Date(),
      provenance: sourceProvenance(id, {
        source: { system: 'hubspot', objectType: 'p_sites', id },
      }),
      ...rest,
    });
  };
  const refsOf = (t: TenantContext) =>
    c.sql<{
      object_type: string;
      external_id: string;
      entity_kind: string;
      entity_id: string;
      state: string;
    }>(
      `SELECT object_type, external_id, entity_kind, entity_id::text, state FROM tenant_source_references
        WHERE tenant_id = $1 AND entity_kind = 'custom_record' ORDER BY external_id`,
      [t.tenantId],
    );
  const indexed = (t: TenantContext, id: string) =>
    c.sql(
      `SELECT 1 FROM tenant_entity_index WHERE tenant_id = $1 AND kind = 'custom_record' AND entity_id = $2`,
      [t.tenantId, id],
    );

  describe('V7: identity, natural key, source references, entity index, fields', () => {
    it('creates by reference with parent and fields; re-observation is unchanged; a second reference with the same natural key resolves to the same record', async () => {
      const t = await extensionTenant(c, 'crid');
      const ids = await companies(c, t, ['3001']);
      const connectionId = await importConnectionId(c, t);
      const first = await observe(t, {
        id: 'S-1',
        parent: accountParent('3001'),
        values: [
          { field: 'site_code', raw: 'DUB-1' },
          { field: 'site_size', raw: 12 },
        ],
        provenance: sourceProvenance('S-1', {
          source: { system: 'hubspot', objectType: 'p_sites', id: 'S-1' },
          connectionId,
        }),
      });
      expect(first).toMatchObject({ status: 'created', values: { status: 'ok', written: 2 } });
      const id = first.recordId!;
      const [row] = await recordsOf(c, t);
      expect(row).toMatchObject({
        id,
        object_key: 'site',
        parent_kind: 'company',
        parent_id: ids['3001'],
        record_state: 'active',
        merged_into_id: null,
        origin: 'source_provided',
      });
      expect(row!.natural_key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await indexed(t, id)).toHaveLength(1);
      expect(await refsOf(t)).toEqual([
        {
          object_type: 'p_sites',
          external_id: 'S-1',
          entity_kind: 'custom_record',
          entity_id: id,
          state: 'active',
        },
      ]);
      const v = await valuesOf(c, t, id);
      expect(v.site_code).toMatchObject({
        target_kind: 'custom_record',
        value_text: 'DUB-1',
        source_connection_id: connectionId,
      });
      expect(v.site_size).toMatchObject({ value_number: '12' });
      // Change records: created (record), ref_added (generic reference), updated (fields).
      const changes = await changesOf(c, t, id);
      expect(changes.map((ch) => [ch.entity_kind, ch.change_type, ch.changed_fields])).toEqual([
        ['custom_record', 'created', ['recordState', 'parentId']],
        ['custom_record', 'ref_added', ['source_reference']],
        ['custom_record', 'updated', ['ext:site_code', 'ext:site_size']],
      ]);
      expect(row!.last_change_id).toBe(changes[0]!.id);

      // Unchanged re-observation.
      expect(
        await observe(t, {
          id: 'S-1',
          parent: accountParent('3001'),
          values: [
            { field: 'site_code', raw: 'DUB-1' },
            { field: 'site_size', raw: '12' },
          ],
        }),
      ).toMatchObject({ status: 'unchanged', recordId: id, values: { written: 0, unchanged: 2 } });
      expect(await changesOf(c, t, id)).toHaveLength(3);

      // Another source id with the same natural key: the same record, a second reference.
      const second = await observe(t, {
        id: 'S-1-dup',
        parent: accountParent('3001'),
        values: [{ field: 'site_code', raw: 'DUB-1' }],
      });
      expect(second).toMatchObject({ recordId: id });
      expect(await recordsOf(c, t)).toHaveLength(1);
      expect((await refsOf(t)).map((r) => [r.external_id, r.entity_id])).toEqual([
        ['S-1', id],
        ['S-1-dup', id],
      ]);
      // A field of another object is refused for this record (target_mismatch).
      expect(
        await observe(t, { id: 'S-1', values: [{ field: 'asset_tag', raw: 'x' }] }),
      ).toMatchObject({ values: { rejected: { target_mismatch: 1 } } });
      // Absence (a deletion) changes nothing on the record or its values.
      expect(await observe(t, { id: 'S-1', presence: 'absent' })).toMatchObject({
        status: 'unchanged',
        recordId: id,
      });
      expect((await recordsOf(c, t))[0]!.record_state).toBe('active');
      expect((await valuesOf(c, t, id)).site_code!.value_text).toBe('DUB-1');
    });

    it('unknown / retired objects and an unknown object field are refused; gate statuses pass through', async () => {
      const t = await extensionTenant(c, 'crobj');
      expect(await observe(t, { id: 'X', objectKey: 'nope' })).toEqual({
        status: 'rejected',
        reason: 'object_unknown',
      });
      expect(await observe(t, { id: 'X', objectKey: 'site_code' })).toEqual({
        status: 'rejected',
        reason: 'object_unknown',
      });
      const off = await c.tenant('crobjoff', 1001);
      expect(await observe(off, { id: 'X' })).toEqual({ status: 'module_disabled' });
      expect(await recordsOf(c, t)).toEqual([]);
    });
  });

  describe('V7: parents (required / optional / unresolved)', () => {
    it('a required parent that is unresolved rejects the record with an open issue; it resolves when the parent appears', async () => {
      const t = await extensionTenant(c, 'crpar');
      expect(await observe(t, { id: 'S-2', parent: accountParent('3101') })).toEqual({
        status: 'rejected',
        reason: 'parent_unresolved',
      });
      const issues = await extIssuesOf(c, t, 'custom_record_parent_unresolved');
      expect(issues).toEqual([
        {
          kind: 'custom_record_parent_unresolved',
          entity_kind: 'custom_record',
          state: 'open',
          canonical_ids: [],
          external_refs: ['hubspot:companies:3101', 'hubspot:p_sites:S-2'],
        },
      ]);
      // An unmapped or explicitly empty parent also rejects a new record (no issue).
      expect(await observe(t, { id: 'S-3' })).toMatchObject({ reason: 'parent_unresolved' });
      expect(await observe(t, { id: 'S-3', parent: null })).toMatchObject({
        reason: 'parent_unresolved',
      });
      expect(await recordsOf(c, t)).toEqual([]);
      const ids = await companies(c, t, ['3101']);
      const ok = await observe(t, { id: 'S-2', parent: accountParent('3101') });
      expect(ok.status).toBe('created');
      expect((await recordsOf(c, t))[0]).toMatchObject({ parent_id: ids['3101'] });
      expect((await extIssuesOf(c, t, 'custom_record_parent_unresolved'))[0]!.state).toBe(
        'resolved',
      );
      // An existing record keeps its parent when a later parent is unresolved.
      expect(await observe(t, { id: 'S-2', parent: accountParent('3199') })).toMatchObject({
        status: 'unchanged',
      });
      expect((await recordsOf(c, t))[0]!.parent_id).toBe(ids['3101']);
      // A resolved new parent re-points it (relationship_changed).
      const other = await companies(c, t, ['3102']);
      expect(await observe(t, { id: 'S-2', parent: accountParent('3102') })).toMatchObject({
        status: 'updated',
      });
      expect((await recordsOf(c, t))[0]!.parent_id).toBe(other['3102']);
      expect((await changesOf(c, t, ok.recordId!)).at(-1)).toMatchObject({
        change_type: 'relationship_changed',
        changed_fields: ['parentId'],
      });
    });

    it('an optional parent that is unresolved keeps the record without a parent', async () => {
      const t = await extensionTenant(c, 'crpopt');
      const out = await observe(t, {
        id: 'A-1',
        objectKey: 'asset',
        ref: { system: 'hubspot', objectType: 'p_assets', id: 'A-1' },
        parent: accountParent('3201'),
        values: [{ field: 'asset_tag', raw: 'T-1' }],
      });
      expect(out).toMatchObject({ status: 'created', values: { written: 1 } });
      expect((await recordsOf(c, t))[0]).toMatchObject({
        object_key: 'asset',
        parent_kind: null,
        parent_id: null,
      });
    });
  });

  describe('V7: lifecycle and the records-per-object guardrail', () => {
    it('active ↔ inactive from the source; retired is terminal for the source; operator reactivation is audited', async () => {
      const t = await extensionTenant(c, 'crlife');
      await companies(c, t, ['3301']);
      const p = accountParent('3301');
      const id = (await observe(t, { id: 'S-4', parent: p })).recordId!;
      expect(await observe(t, { id: 'S-4', parent: p, state: 'inactive' })).toMatchObject({
        status: 'updated',
      });
      expect((await recordsOf(c, t))[0]!.record_state).toBe('inactive');
      expect((await changesOf(c, t, id)).at(-1)).toMatchObject({
        change_type: 'state_changed',
        changed_fields: ['recordState'],
      });
      await observe(t, { id: 'S-4', parent: p, state: 'retired' });
      expect(await observe(t, { id: 'S-4', parent: p, state: 'active' })).toMatchObject({
        status: 'unchanged',
      });
      expect((await recordsOf(c, t))[0]!.record_state).toBe('retired');
      const before = (await auditOf(c, t)).length;
      expect(
        await writer().reactivate(await authz(t, 'canonical.human_entry'), {
          record: id,
          reason: REASON,
        }),
      ).toMatchObject({ recordId: id, object: 'site', state: 'active', changed: true });
      const events = (await auditOf(c, t)).slice(before);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'extension.record.reactivate',
        outcome: 'allowed',
        target_kind: 'custom_record',
        target_ref: id,
        details: { reason: REASON, object: 'site', changed: true },
      });
      expect((await recordsOf(c, t))[0]!.record_state).toBe('active');
      expect(
        await writer().retire(await authz(t, 'canonical.human_entry'), {
          record: id,
          reason: REASON,
        }),
      ).toMatchObject({ state: 'retired', changed: true });
    });

    it('records per object: the guardrail refuses a new record (source rejected, operator extension_guardrail_exceeded)', async () => {
      const t = await extensionTenant(c, 'crguard');
      await companies(c, t, ['3401']);
      const app = c.app;
      const capped = new CustomRecordWriter(
        app.get(TenantDatabase),
        services(c).store,
        services(c).values,
        app.get(SourceReferenceService),
        app.get(AuditTrail),
        app.get(ModuleGate),
        {
          canonical: { extension: { ...services(c).values.guardrails, maxRecordsPerObject: 1 } },
        } as unknown as AppConfig,
      );
      expect((await observe(t, { id: 'S-5', parent: accountParent('3401') }, capped)).status).toBe(
        'created',
      );
      expect(await observe(t, { id: 'S-6', parent: accountParent('3401') }, capped)).toEqual({
        status: 'rejected',
        reason: 'records_per_object_exceeded',
      });
      // Existing records still update.
      expect(
        (await observe(t, { id: 'S-5', parent: accountParent('3401'), state: 'inactive' }, capped))
          .status,
      ).toBe('updated');
      await expect(
        capped.createRecord(await authz(t, 'canonical.human_entry'), {
          object: 'site',
          parent: `company:${(await recordsOf(c, t))[0]!.parent_id}`,
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'extension_guardrail_exceeded' });
      expect(await recordsOf(c, t)).toHaveLength(1);
    });
  });

  describe('V10: operator record commands', () => {
    it('create / update need a matching parent, a unique natural key and canonical.human_entry; one audit event per call; values are human', async () => {
      const t = await extensionTenant(c, 'crop');
      const ids = await companies(c, t, ['3501']);
      await observePerson(c, t, '3502');
      const human = async () => authz(t, 'canonical.human_entry');
      await expect(
        writer().createRecord(await human(), { object: 'site', reason: REASON }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(
        writer().createRecord(await human(), {
          object: 'site',
          parent: `company:${randomUUID()}`,
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(
        writer().createRecord(await human(), { object: 'nope', reason: REASON }),
      ).rejects.toMatchObject({ code: 'extension_field_unknown' });
      const before = (await auditOf(c, t)).length;
      const created = await writer().createRecord(await human(), {
        object: 'site',
        parent: `company:${ids['3501']}`,
        values: { site_code: 'OP-1', site_size: '3' },
        reason: REASON,
      });
      expect(created).toMatchObject({ object: 'site', state: 'active', changed: true });
      const events = (await auditOf(c, t)).slice(before);
      expect(events.map((e) => [e.action, e.outcome])).toEqual([
        ['extension.record.create', 'allowed'],
      ]);
      expect(events[0]!.details).toEqual({ reason: REASON, object: 'site', fields: 2 });
      expect(JSON.stringify(events)).not.toContain('OP-1');
      expect((await recordsOf(c, t))[0]).toMatchObject({ origin: 'human', parent_id: ids['3501'] });
      const v = await valuesOf(c, t, created.recordId);
      expect(v.site_code).toMatchObject({ value_text: 'OP-1', origin: 'human' });
      // Natural key taken.
      await expect(
        writer().createRecord(await human(), {
          object: 'site',
          parent: `company:${ids['3501']}`,
          values: { site_code: 'OP-1' },
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      // Update: a human value per field, one audit event.
      expect(
        await writer().update(await human(), {
          record: created.recordId,
          values: { site_size: '4', site_code: null },
          reason: REASON,
        }),
      ).toMatchObject({ changed: true });
      const after = await valuesOf(c, t, created.recordId);
      expect(after.site_size).toMatchObject({ value_number: '4', origin: 'human' });
      expect(after.site_code).toMatchObject({ value_state: 'empty', origin: 'human' });
      expect((await auditOf(c, t, 'extension.record.update')).map((e) => e.outcome)).toEqual([
        'allowed',
      ]);
      // A source value for a human field does not override it.
      const src = await services(c).values.observeSource(await authz(t, 'canonical.source_sync'), {
        target: { kind: 'custom_record', id: created.recordId },
        values: [{ field: 'site_size', raw: 9 }],
        observedAt: new Date(),
        provenance: sourceProvenance('S-op'),
      });
      expect(src).toMatchObject({ humanOverride: 1, written: 0 });
    });
  });
});
