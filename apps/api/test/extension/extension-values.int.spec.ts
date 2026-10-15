import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourceSyncActor } from '../../src/modules/domain';
import { ExtensionValueWriter } from '../../src/modules/extension';
import { ModuleGate } from '../../src/modules/governance';
import {
  AuditTrail,
  SecurityEventsService,
  TenantDatabase,
  WriteAuthorizer,
  type TenantContext,
} from '../../src/modules/tenancy';
import type { AppConfig } from '../../src/platform/config';
import {
  asApp,
  auditOf,
  companies,
  hs,
  ingestMeta,
  observePerson,
  personIdOf,
} from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import {
  defaultDocument,
  entryId,
  extChangesOf,
  extIssuesOf,
  extensionTenant,
  field,
  importConnectionId,
  itemsOf,
  publishExtension,
  REASON,
  registryVersion,
  services,
  sourceProvenance,
  valuesOf,
} from '../support/extension';
import { authz } from '../support/security';

/**
 * M10D `ExtensionValueWriter` on real PostgreSQL as the app role (forced RLS),
 * through the real harness app (plan §4.1, §4.3, §9, §19 V5 / V10 / V12 /
 * V18): all 13 value types end to end, idempotency, explicit empty vs absent,
 * rejections per reason (never truncation), secret-like refusal, restricted
 * values never stored, the 0.4 + module gate, unknown / merged targets (Q32),
 * reference checks, sticky operator values and the disagreement issue (Q16),
 * change records with `ext:` tokens (Q24) and opt-in value history (Q23).
 * Synthetic definitions and values only.
 */
describe('M10D extension values (ExtensionValueWriter)', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const writer = () => services(c).values;
  const observe = async (
    t: TenantContext,
    targetId: string,
    values: Record<string, unknown>,
    options: { connectionId?: string; kind?: 'company' | 'person'; record?: string } = {},
  ) =>
    writer().observeSource(await authz(t, 'canonical.source_sync'), {
      target: { kind: options.kind ?? 'company', id: targetId },
      values: Object.entries(values).map(([f, raw]) => ({ field: f, raw })),
      observedAt: new Date(),
      provenance: sourceProvenance(options.record ?? 'rec-1', {
        ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      }),
    });
  const set = async (t: TenantContext, target: string, f: string, value: string) =>
    writer().set(await authz(t, 'canonical.human_entry'), {
      target,
      field: f,
      value,
      reason: REASON,
    });
  const merge = async (t: TenantContext, survivor: string, merged: string[]) =>
    c.ingestion.ingestMerge(
      await authz(t, 'canonical.source_sync'),
      { kind: 'company', survivor: hs(survivor), merged: merged.map(hs), observedAt: new Date() },
      ingestMeta(),
    );

  describe('V5: the 13 value types end to end', () => {
    it('writes every type into exactly its typed columns, items in order, one change record; a re-run writes nothing', async () => {
      const t = await extensionTenant(c, 'xtypes');
      const ids = await companies(c, t, ['1001', '1002']);
      const company = ids['1001']!;
      const connectionId = await importConnectionId(c, t);
      const out = await observe(
        t,
        company,
        {
          x_string: 'Alpha',
          x_text: 'Long synthetic text',
          x_number: '12.50',
          x_integer: 42,
          x_boolean: 'true',
          x_date: '2026-06-30',
          x_datetime: '2026-06-30T10:15:00.000Z',
          x_money: 'EUR 12.34',
          x_enum: 'gold',
          x_multi: 'c;a',
          x_array: [3, 1, 2],
          x_json: { tier: 'a', nested: { n: 1 } },
          x_ref: `account:${ids['1002']}`,
        },
        { connectionId, record: 'co-1001' },
      );
      expect(out).toMatchObject({
        status: 'ok',
        written: 13,
        unchanged: 0,
        withheld: 0,
        humanOverride: 0,
        rejected: {},
      });
      const v = await valuesOf(c, t, company);
      expect(Object.keys(v).sort()).toHaveLength(13);
      const typed = (key: string) => {
        const r = v[key]!;
        return Object.fromEntries(
          Object.entries(r).filter(
            ([k, val]) =>
              k.startsWith('value_') && k !== 'value_type' && k !== 'value_state' && val !== null,
          ),
        );
      };
      expect(typed('x_string')).toEqual({ value_text: 'Alpha' });
      expect(typed('x_text')).toEqual({ value_text: 'Long synthetic text' });
      expect(typed('x_number')).toEqual({ value_number: '12.5' });
      expect(typed('x_integer')).toEqual({ value_number: '42' });
      expect(typed('x_boolean')).toEqual({ value_bool: true });
      expect(typed('x_date')).toEqual({ value_date: '2026-06-30' });
      expect(typed('x_datetime')).toEqual({ value_ts: new Date('2026-06-30T10:15:00.000Z') });
      expect(typed('x_money')).toEqual({ value_money_minor: '1234', value_currency: 'EUR' });
      expect(typed('x_enum')).toEqual({ value_enum: 'gold' });
      expect(typed('x_multi')).toEqual({ value_item_count: 2 });
      expect(typed('x_array')).toEqual({ value_item_count: 3 });
      expect(typed('x_json')).toEqual({ value_json: { tier: 'a', nested: { n: 1 } } });
      expect(typed('x_ref')).toEqual({ value_ref_kind: 'company', value_ref_id: ids['1002'] });
      for (const r of Object.values(v)) {
        expect(r).toMatchObject({
          target_kind: 'company',
          target_id: company,
          target_key: null,
          value_state: 'present',
          origin: 'source_provided',
          source_connection_id: connectionId,
          source_object_type: 'companies',
          source_record_id: 'co-1001',
          registry_version: 1,
          released_at: null,
        });
        expect(r.field_hash).toMatch(/^[0-9a-f]{64}$/);
      }
      // multi_enum: set semantics, normalised order; array: stated order.
      expect(
        (await itemsOf(c, t, v.x_multi!.id)).map((i) => [i.ordinal, i.item_type, i.item_enum]),
      ).toEqual([
        [0, 'enum', 'a'],
        [1, 'enum', 'c'],
      ]);
      expect(
        (await itemsOf(c, t, v.x_array!.id)).map((i) => [i.ordinal, i.item_type, i.item_number]),
      ).toEqual([
        [0, 'integer', '3'],
        [1, 'integer', '1'],
        [2, 'integer', '2'],
      ]);
      // One change record for the call: `ext:` tokens, sorted, no values.
      const changes = await extChangesOf(c, t, company);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        entity_kind: 'company',
        change_type: 'updated',
        source_system: 'hubspot',
        source_record_id: 'co-1001',
        origin: 'source_provided',
        canonical_version: '0.4',
      });
      expect(changes[0]!.changed_fields).toEqual(
        [
          'ext:x_array',
          'ext:x_boolean',
          'ext:x_date',
          'ext:x_datetime',
          'ext:x_enum',
          'ext:x_integer',
          'ext:x_json',
          'ext:x_money',
          'ext:x_multi',
          'ext:x_number',
          'ext:x_ref',
          'ext:x_string',
          'ext:x_text',
        ].sort(),
      );
      for (const r of Object.values(v)) expect(r.last_change_id).toBe(changes[0]!.id);

      // Idempotent: equivalent statements (other spellings) hash the same; nothing written.
      const again = await observe(t, company, {
        x_number: 12.5,
        x_multi: ['a', 'c'],
        x_money: '12.34 EUR',
        x_boolean: true,
      });
      expect(again).toMatchObject({ status: 'ok', written: 0, unchanged: 4 });
      expect(again.changeId).toBeUndefined();
      expect(await extChangesOf(c, t, company)).toHaveLength(1);
      const after = await valuesOf(c, t, company);
      expect(after.x_number!.updated_at).toEqual(v.x_number!.updated_at);
    });

    it('explicit empty clears to value_state empty (all columns NULL, items removed); absence never clears', async () => {
      const t = await extensionTenant(c, 'xempty');
      const company = (await companies(c, t, ['1101']))['1101']!;
      await observe(t, company, { x_string: 'Kept', x_multi: 'a;b', x_enum: 'silver' });
      const before = await valuesOf(c, t, company);
      // Absence: a later statement of another field leaves the others untouched.
      expect(await observe(t, company, { x_integer: 7 })).toMatchObject({ written: 1 });
      const mid = await valuesOf(c, t, company);
      expect(mid.x_string).toEqual(before.x_string);
      expect(mid.x_multi).toEqual(before.x_multi);
      // Items replace on change.
      await observe(t, company, { x_multi: 'c' });
      expect((await itemsOf(c, t, before.x_multi!.id)).map((i) => i.item_enum)).toEqual(['c']);
      // Explicit empty: null, '' and [] are statements of "no value".
      expect(
        await observe(t, company, { x_string: null, x_multi: [], x_enum: '  ' }),
      ).toMatchObject({ written: 3 });
      const cleared = await valuesOf(c, t, company);
      for (const key of ['x_string', 'x_multi', 'x_enum']) {
        expect(cleared[key]).toMatchObject({
          value_state: 'empty',
          value_text: null,
          value_enum: null,
          value_item_count: null,
        });
        expect(cleared[key]!.id).toBe(before[key]?.id ?? cleared[key]!.id);
      }
      expect(await itemsOf(c, t, before.x_multi!.id)).toEqual([]);
      // Empty again: unchanged.
      expect(await observe(t, company, { x_string: '' })).toMatchObject({
        written: 0,
        unchanged: 1,
      });
    });
  });

  describe('V5 / V2: rejections (codes only, never truncation, nothing stored)', () => {
    it('counts each rejection by reason and stores nothing for it', async () => {
      const t = await extensionTenant(c, 'xreject');
      const ids = await companies(c, t, ['1201']);
      const company = ids['1201']!;
      const out = await observe(t, company, {
        x_string: 'x'.repeat(21),
        x_number: -1,
        x_integer: '1.5',
        x_boolean: 'yes',
        x_date: '2026-02-30',
        x_datetime: '2026-06-30',
        x_money: 'XXX 1',
        x_enum: 'bronze',
        x_multi: 'a;a',
        x_array: [1, 2, 3, 4],
        x_json: '{not json',
        x_ref: `person:${randomUUID()}`,
        p_note: 'person field on an account',
        nope: 'unknown field',
      });
      expect(out).toMatchObject({ status: 'ok', written: 0 });
      expect(out.rejected).toEqual({
        too_long: 1,
        below_min: 1,
        not_integer: 1,
        type_invalid: 1,
        date_invalid: 2,
        currency_unknown: 1,
        enum_retired: 1,
        duplicate_item: 1,
        too_many_items: 1,
        json_invalid: 1,
        reference_kind_not_allowed: 1,
        target_mismatch: 1,
        field_unknown: 1,
      });
      expect(await valuesOf(c, t, company)).toEqual({});
      expect(await extChangesOf(c, t, company)).toEqual([]);
      // A mixed batch writes the valid statements only.
      expect(await observe(t, company, { x_string: 'ok', x_enum: 'nope' })).toMatchObject({
        written: 1,
        rejected: { enum_unknown: 1 },
      });
      expect(Object.keys(await valuesOf(c, t, company))).toEqual(['x_string']);
    });

    it('JSON size / depth and array items guardrails refuse at write time (writer with lower guardrails)', async () => {
      const t = await extensionTenant(c, 'xguard');
      const company = (await companies(c, t, ['1301']))['1301']!;
      const app = c.app;
      const strict = new ExtensionValueWriter(
        app.get(TenantDatabase),
        services(c).store,
        app.get(AuditTrail),
        app.get(WriteAuthorizer),
        app.get(ModuleGate),
        app.get(SecurityEventsService),
        {
          canonical: {
            extension: {
              ...writer().guardrails,
              maxJsonBytes: 64,
              maxJsonDepth: 2,
              maxArrayItems: 2,
            },
          },
        } as unknown as AppConfig,
      );
      const out = await strict.observeSource(await authz(t, 'canonical.source_sync'), {
        target: { kind: 'company', id: company },
        values: [
          { field: 'x_json', raw: { a: { b: { c: 1 } } } },
          { field: 'x_multi', raw: 'a;b;c' },
        ],
        observedAt: new Date(),
        provenance: sourceProvenance('g-1'),
      });
      expect(out.rejected).toEqual({ json_too_deep: 1, too_many_items: 1 });
      const big = await strict.observeSource(await authz(t, 'canonical.source_sync'), {
        target: { kind: 'company', id: company },
        values: [{ field: 'x_json', raw: { a: 'y'.repeat(100) } }],
        observedAt: new Date(),
        provenance: sourceProvenance('g-1'),
      });
      expect(big.rejected).toEqual({ json_too_large: 1 });
      expect(await valuesOf(c, t, company)).toEqual({});
      // The operator path names the guardrail.
      await expect(
        strict.set(await authz(t, 'canonical.human_entry'), {
          target: `company:${company}`,
          field: 'x_multi',
          value: 'a;b;c',
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'extension_guardrail_exceeded' });
      // The default writer accepts the same values.
      expect(await observe(t, company, { x_multi: 'a;b;c' })).toMatchObject({ written: 1 });
    });

    it('a retired field is refused (field_retired) after republishing it retired', async () => {
      const t = await extensionTenant(c, 'xretire');
      const company = (await companies(c, t, ['1401']))['1401']!;
      // A sticky operator value set while the field was active (review m8).
      await set(t, `company:${company}`, 'x_text', 'human');
      const doc = defaultDocument() as { fields: Record<string, unknown>[] };
      doc.fields = doc.fields.map((f) => (f.key === 'x_text' ? { ...f, status: 'retired' } : f));
      await publishExtension(c, t, doc);
      expect(await observe(t, company, { x_text: 'late' })).toMatchObject({
        written: 0,
        rejected: { field_retired: 1 },
      });
      await expect(set(t, `company:${company}`, 'x_text', 'late')).rejects.toMatchObject({
        code: 'extension_field_retired',
      });
      // Review m8: the sticky value on the retired field can still be released (no new value).
      expect(
        await writer().release(await authz(t, 'canonical.human_entry'), {
          target: `company:${company}`,
          field: 'x_text',
          reason: REASON,
        }),
      ).toMatchObject({ state: 'released', changed: true });
      const v = (await valuesOf(c, t, company)).x_text!;
      expect(v.origin).toBe('human');
      expect(v.released_at).not.toBeNull();
    });
  });

  describe('V5 / V16: secret-like values and restricted fields are never stored', () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

    it('a secret-like string, array item or JSON value is refused (counted, no row, no value in the security event)', async () => {
      const t = await extensionTenant(c, 'xsecret');
      const company = (await companies(c, t, ['1501']))['1501']!;
      const emitted: unknown[] = [];
      const events = c.app.get(SecurityEventsService);
      const original = events.emit.bind(events);
      events.emit = (e) => {
        emitted.push(e);
        original(e);
      };
      try {
        const out = await observe(t, company, {
          x_text: `note ${token}`,
          x_json: { nested: { value: token } },
        });
        expect(out.written).toBe(0);
        expect(out.rejected.secret_like).toBeGreaterThanOrEqual(2);
      } finally {
        events.emit = original;
      }
      const v = await valuesOf(c, t, company);
      expect(v.x_text).toBeUndefined();
      expect(v.x_json).toBeUndefined();
      const refused = emitted.filter(
        (e) => (e as { event?: string }).event === 'secret_like_refused',
      );
      expect(refused.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(refused)).not.toContain(token);
      expect(JSON.stringify(refused)).toContain('extension:field:x_text');
      // Operator entry: an audited denial before anything is stored.
      await expect(set(t, `company:${company}`, 'x_text', token)).rejects.toMatchObject({
        name: 'SecretLikeValueError',
      });
      const denied = (await auditOf(c, t)).filter((a) => a.reason_code === 'secret_like_value');
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        outcome: 'denied',
        action: 'extension.value.set',
        target_kind: 'extension_value',
      });
      expect(JSON.stringify(await auditOf(c, t))).not.toContain(token);
      expect(await valuesOf(c, t, company)).toEqual({});
    });

    it('restricted fields: withheld (counted, no row); operator set refused restricted_value_withheld', async () => {
      const t = await extensionTenant(c, 'xrestr');
      const company = (await companies(c, t, ['1601']))['1601']!;
      expect(await observe(t, company, { x_restricted: 'never', x_string: 'ok' })).toMatchObject({
        written: 1,
        withheld: 1,
        rejected: {},
      });
      expect(Object.keys(await valuesOf(c, t, company))).toEqual(['x_string']);
      await expect(set(t, `company:${company}`, 'x_restricted', 'never')).rejects.toMatchObject({
        code: 'restricted_value_withheld',
      });
      expect((await auditOf(c, t, 'extension.value.set')).at(-1)).toMatchObject({
        outcome: 'failed',
        reason_code: 'restricted_value_withheld',
      });
      const rows = await c.sql(
        `SELECT 1 FROM tenant_extension_values v JOIN tenant_registry_entries e ON e.id = v.field_id
          WHERE v.tenant_id = $1 AND e.sensitivity = 'restricted'`,
        [t.tenantId],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('V18: the 0.4 + module gate; V5: unknown and merged targets (Q32)', () => {
    it('module disabled, registry unpublished, below 0.4: nothing written, operator refused (audited)', async () => {
      const t = await c.tenant('xgate', 1001);
      const company = (await companies(c, t, ['1701']))['1701']!;
      expect(await observe(t, company, { x_string: 'a' })).toMatchObject({
        status: 'module_disabled',
        written: 0,
      });
      await expect(set(t, `company:${company}`, 'x_string', 'a')).rejects.toMatchObject({
        code: 'module_disabled',
      });
      expect((await auditOf(c, t, 'extension.value.set')).at(-1)).toMatchObject({
        reason_code: 'module_disabled',
      });
      const s = services(c);
      await s.modules.enable(await authz(t, 'config.module.change'), {
        module: 'extension',
        expectedVersion: 0,
      });
      expect(await observe(t, company, { x_string: 'a' })).toMatchObject({
        status: 'registry_not_published',
      });
      await publishExtension(c, t);
      expect(await observe(t, company, { x_string: 'a' })).toMatchObject({
        status: 'ok',
        written: 1,
      });
      // Rollback to 0.3 with the module enabled (Q19): data kept, writes refused.
      await s.adoption.adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.3',
        expectedCurrent: '0.4',
      });
      expect(await observe(t, company, { x_string: 'b' })).toMatchObject({
        status: 'canonical_version_too_low',
        written: 0,
      });
      await expect(set(t, `company:${company}`, 'x_string', 'b')).rejects.toMatchObject({
        code: 'canonical_version_too_low',
      });
      expect((await valuesOf(c, t, company)).x_string).toMatchObject({ value_text: 'a' });
      const read = await s.read.valuesFor(await authz(t, 'data.extension.read'), 'display', [
        `company:${company}`,
      ]);
      expect(read.map((r) => [r.field, r.value])).toEqual([['x_string', 'a']]);
    });

    it('an unknown or merged target writes nothing; a reference to a merged / foreign-object target is refused with an issue', async () => {
      const t = await extensionTenant(c, 'xtarget');
      const ids = await companies(c, t, ['1801', '1802', '1803']);
      expect(await observe(t, randomUUID(), { x_string: 'a' })).toMatchObject({
        status: 'target_unknown',
      });
      await merge(t, '1802', ['1801']);
      expect(await observe(t, ids['1801']!, { x_string: 'a' })).toMatchObject({
        status: 'target_merged',
      });
      await expect(set(t, `company:${ids['1801']}`, 'x_string', 'a')).rejects.toMatchObject({
        code: 'validation_failed',
      });
      // Reference to the merged loser → reference_unresolved + open issue.
      const out = await observe(t, ids['1803']!, { x_ref: `account:${ids['1801']}` });
      expect(out).toMatchObject({ written: 0, rejected: { reference_unresolved: 1 } });
      expect(await extIssuesOf(c, t, 'extension_reference_unresolved')).toEqual([
        expect.objectContaining({
          state: 'open',
          entity_kind: 'company',
          canonical_ids: expect.arrayContaining([ids['1803']]),
          external_refs: ['extension:field:x_ref'],
        }),
      ]);
      // An unknown id of an allowed kind is refused the same way.
      expect(await observe(t, ids['1803']!, { x_ref: `account:${randomUUID()}` })).toMatchObject({
        rejected: { reference_unresolved: 1 },
      });
      // A custom record of an object not in reference_to (asset) is refused.
      const asset = await services(c).records.createRecord(
        await authz(t, 'canonical.human_entry'),
        {
          object: 'asset',
          reason: REASON,
        },
      );
      expect(
        await observe(t, ids['1803']!, { x_ref: `custom_record:${asset.recordId}` }),
      ).toMatchObject({ rejected: { reference_unresolved: 1 } });
      // The survivor resolves the issue.
      expect(await observe(t, ids['1803']!, { x_ref: `account:${ids['1802']}` })).toMatchObject({
        written: 1,
      });
      expect((await extIssuesOf(c, t, 'extension_reference_unresolved'))[0]!.state).toBe(
        'resolved',
      );
    });
  });

  describe('V10: operator set / clear / release; sticky human value and the disagreement issue (Q16)', () => {
    it('human values are sticky until release; disagreement is an open issue (identifiers only); one audit event per call', async () => {
      const t = await extensionTenant(c, 'xhuman');
      const company = (await companies(c, t, ['1901']))['1901']!;
      const target = `company:${company}`;
      await observe(t, company, { x_string: 'source-1' });
      const auditBefore = (await auditOf(c, t)).length;
      const r = await set(t, target, 'x_string', 'human-1');
      expect(r).toMatchObject({ target, field: 'x_string', state: 'present', changed: true });
      let v = (await valuesOf(c, t, company)).x_string!;
      expect(v).toMatchObject({
        value_text: 'human-1',
        origin: 'human',
        released_at: null,
        source_connection_id: null,
      });
      const events = (await auditOf(c, t)).slice(auditBefore);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'extension.value.set',
        outcome: 'allowed',
        capability: 'canonical.human_entry',
        target_kind: 'extension_value',
        target_ref: r.valueId,
        actor_kind: 'operator',
      });
      expect(events[0]!.details).toEqual({
        reason: REASON,
        field: 'x_string',
        targetKind: 'company',
        changed: true,
      });
      expect(JSON.stringify(events)).not.toContain('human-1');
      const humanChange = (await extChangesOf(c, t, company)).at(-1)!;
      expect(humanChange).toMatchObject({
        origin: 'human',
        source_system: 'import',
        source_object_type: 'operator_entry',
        actor_kind: 'operator',
      });

      // A differing source value is not applied: open issue, counted.
      expect(await observe(t, company, { x_string: 'source-2' })).toMatchObject({
        written: 0,
        humanOverride: 1,
      });
      expect((await valuesOf(c, t, company)).x_string!.value_text).toBe('human-1');
      const issues = await extIssuesOf(c, t, 'extension_human_override_disagrees');
      expect(issues).toEqual([
        {
          kind: 'extension_human_override_disagrees',
          entity_kind: 'company',
          state: 'open',
          canonical_ids: expect.arrayContaining([company]),
          external_refs: ['extension:field:x_string'],
        },
      ]);
      expect(JSON.stringify(issues)).not.toContain('source-2');
      // The source agreeing resolves it.
      expect(await observe(t, company, { x_string: 'human-1' })).toMatchObject({ unchanged: 1 });
      expect((await extIssuesOf(c, t, 'extension_human_override_disagrees'))[0]!.state).toBe(
        'resolved',
      );
      // Same operator value again: changed=false, still one audit event.
      expect(await set(t, target, 'x_string', 'human-1')).toMatchObject({ changed: false });

      // Release: the next source value applies (origin source_provided again).
      const released = await writer().release(await authz(t, 'canonical.human_entry'), {
        target,
        field: 'x_string',
        reason: REASON,
      });
      expect(released).toMatchObject({ state: 'released', changed: true });
      v = (await valuesOf(c, t, company)).x_string!;
      expect(v.origin).toBe('human');
      expect(v.released_at).not.toBeNull();
      expect((await auditOf(c, t, 'extension.value.release')).at(-1)).toMatchObject({
        outcome: 'allowed',
        details: { reason: REASON, field: 'x_string', targetKind: 'company' },
      });
      // Even an equal source value takes the row back after a release.
      expect(await observe(t, company, { x_string: 'source-3' })).toMatchObject({ written: 1 });
      v = (await valuesOf(c, t, company)).x_string!;
      expect(v).toMatchObject({
        value_text: 'source-3',
        origin: 'source_provided',
        released_at: null,
      });
      // Nothing left to release.
      await expect(
        writer().release(await authz(t, 'canonical.human_entry'), {
          target,
          field: 'x_string',
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });

      // Clear: an explicit human empty, sticky as well.
      expect(
        await writer().clear(await authz(t, 'canonical.human_entry'), {
          target,
          field: 'x_string',
          reason: REASON,
        }),
      ).toMatchObject({ state: 'empty', changed: true });
      expect(await observe(t, company, { x_string: 'source-4' })).toMatchObject({
        humanOverride: 1,
      });
      expect((await valuesOf(c, t, company)).x_string).toMatchObject({
        value_state: 'empty',
        origin: 'human',
      });
    });

    it('needs canonical.human_entry, a reason code and a valid target / field; refusals are audited failed', async () => {
      const t = await extensionTenant(c, 'xhumanref');
      const company = (await companies(c, t, ['1951']))['1951']!;
      // The source-sync actor is never granted human entry (policy v5).
      await expect(
        authz(t, 'canonical.human_entry', sourceSyncActor('run:x')),
      ).rejects.toMatchObject({ reason: 'capability_not_granted' });
      // The writer checks the capability itself (S2): a context issued for another
      // capability is refused before anything is stored.
      const other = (await authz(t, 'data.extension.read')) as never;
      const req = { target: `company:${company}`, field: 'x_string', reason: REASON };
      for (const call of [
        () => writer().set(other, { ...req, value: 'a' }),
        () => writer().clear(other, req),
        () => writer().release(other, req),
      ]) {
        await expect(call()).rejects.toThrow(/canonical\.human_entry is required/);
      }
      await expect(
        writer().set(await authz(t, 'canonical.human_entry'), {
          target: `company:${company}`,
          field: 'x_string',
          value: 'a',
          reason: 'Free text reason',
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(set(t, `company:${company}`, 'nope', 'a')).rejects.toMatchObject({
        code: 'extension_field_unknown',
      });
      await expect(set(t, `company:${company}`, 'p_note', 'a')).rejects.toMatchObject({
        code: 'extension_field_unknown',
      });
      await expect(set(t, `company:${company}`, 'x_integer', 'abc')).rejects.toMatchObject({
        code: 'extension_value_invalid',
      });
      await expect(set(t, `company:not-a-uuid`, 'x_string', 'a')).rejects.toMatchObject({
        code: 'validation_failed',
      });
      const failed = (await auditOf(c, t, 'extension.value.set')).filter(
        (a) => a.outcome === 'failed',
      );
      expect(failed.map((a) => a.reason_code)).toEqual(
        expect.arrayContaining([
          'validation_failed',
          'extension_field_unknown',
          'extension_value_invalid',
        ]),
      );
      expect(await valuesOf(c, t, company)).toEqual({});
    });
  });

  describe('V12: opt-in value history (Q23)', () => {
    it('history only for value_history fields; full for non-sensitive, value-free for personal', async () => {
      const t = await extensionTenant(c, 'xhist');
      const company = (await companies(c, t, ['2001']))['2001']!;
      await observe(t, company, { x_string: 'one', x_text: 'no history' });
      await observe(t, company, { x_string: 'two' });
      const history = await c.sql<{
        entity_kind: string;
        field: string;
        values_recorded: boolean;
        old_value: unknown;
        new_value: unknown;
        change_id: string;
      }>(
        `SELECT entity_kind, field, values_recorded, old_value, new_value, change_id::text FROM tenant_value_history
          WHERE tenant_id = $1 AND field LIKE 'ext:%' ORDER BY recorded_at, effective_at`,
        [t.tenantId],
      );
      expect(
        history.map((h) => [h.entity_kind, h.field, h.values_recorded, h.old_value, h.new_value]),
      ).toEqual([
        ['company', 'ext:x_string', true, null, 'one'],
        ['company', 'ext:x_string', true, 'one', 'two'],
      ]);
      const changes = await extChangesOf(c, t, company);
      expect(history.map((h) => h.change_id)).toEqual(changes.map((ch) => ch.id));

      // Personal (confidential / personal) person field: value-free history.
      await observePerson(c, t, '2002');
      const [person] = await c.sql<{ id: string }>(
        `SELECT person_id::text AS id FROM person_external_refs WHERE tenant_id = $1 AND external_id = '2002'`,
        [t.tenantId],
      );
      expect(
        await observe(t, person!.id, { p_note: 'private note' }, { kind: 'person' }),
      ).toMatchObject({ written: 1 });
      const personal = await c.sql<{
        values_recorded: boolean;
        old_value: unknown;
        new_value: unknown;
      }>(
        `SELECT values_recorded, old_value, new_value FROM tenant_value_history
          WHERE tenant_id = $1 AND entity_kind = 'person' AND field = 'ext:p_note'`,
        [t.tenantId],
      );
      expect(personal).toEqual([{ values_recorded: false, old_value: null, new_value: null }]);
    });
  });

  describe('Q13 / Q14: authority and owning connection stay with the caller', () => {
    it('observe needs canonical.source_sync; the source triple names the writing connection only for source writes', async () => {
      const t = await extensionTenant(c, 'xauth');
      const company = (await companies(c, t, ['2101']))['2101']!;
      const human = await authz(t, 'canonical.human_entry');
      await expect(async () =>
        writer().observeSource(human as never, {
          target: { kind: 'company', id: company },
          values: [{ field: 'x_string', raw: 'a' }],
          observedAt: new Date(),
          provenance: sourceProvenance('r'),
        }),
      ).rejects.toThrow('canonical.source_sync is required');
      // A source write without a connection carries no source triple (all-or-none CHECK holds).
      expect(await observe(t, company, { x_string: 'a' })).toMatchObject({ written: 1 });
      expect((await valuesOf(c, t, company)).x_string).toMatchObject({
        source_connection_id: null,
        source_object_type: null,
        source_record_id: null,
      });
      // A connection of another tenant cannot be named (composite FK, tenant-scoped).
      const other = await extensionTenant(c, 'xauthb', { portal: 2002 });
      const foreignConnection = await importConnectionId(c, other);
      await expect(
        observe(t, company, { x_string: 'b' }, { connectionId: foreignConnection }),
      ).rejects.toThrow();
      expect((await valuesOf(c, t, company)).x_string!.value_text).toBe('a');
    });
  });

  it('a field definition added later applies from its registry version (registry_version recorded)', async () => {
    const t = await extensionTenant(c, 'xregv');
    const company = (await companies(c, t, ['2201']))['2201']!;
    expect(await observe(t, company, { x_late: 'a' })).toMatchObject({
      rejected: { field_unknown: 1 },
    });
    const doc = defaultDocument() as { fields: Record<string, unknown>[] };
    doc.fields.push(field('x_late', 'string'));
    await publishExtension(c, t, doc);
    expect(await observe(t, company, { x_late: 'a' })).toMatchObject({ written: 1 });
    expect((await valuesOf(c, t, company)).x_late!.registry_version).toBe(2);
  });

  describe('V4 / V13: the database refuses wrong typed columns and cross-tenant links (raw SQL as the app role)', () => {
    type Db = Parameters<Parameters<typeof asApp>[2]>[0];
    /** Inserts one value row as the app role; `cols` override the valid base row. */
    const insertValue = async (
      db: Db,
      base: Record<string, unknown>,
      cols: Record<string, unknown>,
    ) => {
      const row = { ...base, ...cols };
      const names = Object.keys(row);
      const rows = await db.query<{ id: string }>(
        `INSERT INTO tenant_extension_values (${names.join(', ')})
         VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text`,
        names.map((n) => row[n]),
      );
      return rows.rows[0]!.id;
    };
    const baseRow = async (t: TenantContext, targetId: string, key: string, valueType: string) => ({
      tenant_id: t.tenantId,
      target_kind: 'company',
      target_id: targetId,
      field_id: await entryId(c, t, key),
      value_type: valueType,
      value_state: 'present',
      origin: 'human',
      registry_version: await registryVersion(c, t),
    });

    it('V4: the typed CHECK refuses every wrong column combination; scale / currency / identity guarded; no DELETE on values, records or edges', async () => {
      const t = await extensionTenant(c, 'xv4db', { portal: 4401 });
      const company = (await companies(c, t, ['4401']))['4401']!;
      const integer = await baseRow(t, company, 'x_integer', 'integer');
      const money = await baseRow(t, company, 'x_money', 'money');
      const reference = await baseRow(t, company, 'x_ref', 'reference');
      const boolean = await baseRow(t, company, 'x_boolean', 'boolean');
      const typedRefused = { code: '23514', constraint: 'tenant_extension_values_typed' };

      // Positive controls: the right column(s) per type, and an empty value with none.
      await asApp(c, t, async (db) => {
        await insertValue(db, integer, { value_number: '42' });
        await insertValue(db, money, { value_money_minor: '1234', value_currency: 'EUR' });
        await insertValue(db, boolean, { value_state: 'empty' });
      });
      const wrong: [Record<string, unknown>, Record<string, unknown>][] = [
        [integer, { value_text: '42' }], // another type's column
        [integer, {}], // no value column
        [integer, { value_number: '42', value_text: '42' }], // two columns
        [boolean, { value_text: 'true' }],
        [boolean, { value_state: 'empty', value_bool: true }], // empty with a value
        [money, { value_money_minor: '1234' }], // money without its currency
        [money, { value_money_minor: '1234', value_currency: 'EUR', value_number: '12.34' }],
        [reference, { value_ref_kind: 'company' }], // reference without its id / key
      ];
      for (const [base, cols] of wrong) {
        await asApp(c, t, async (db) => {
          await expect(insertValue(db, base, cols), JSON.stringify(cols)).rejects.toMatchObject(
            typedRefused,
          );
        });
      }
      await asApp(c, t, async (db) => {
        await expect(insertValue(db, integer, { value_number: '1.5' })).rejects.toMatchObject({
          code: '23514',
          constraint: 'tenant_extension_values_integer_scale',
        });
      });
      await asApp(c, t, async (db) => {
        await expect(
          insertValue(db, money, { value_money_minor: '1', value_currency: 'eur' }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'tenant_extension_values_currency_format',
        });
      });
      // Identity (target, field, value type) never changes.
      await asApp(c, t, async (db) => {
        const id = await insertValue(db, integer, { value_number: '7' });
        await expect(
          db.query(`UPDATE tenant_extension_values SET value_type = 'number' WHERE id = $1`, [id]),
        ).rejects.toMatchObject({ code: '23514', message: 'extension_value_identity_immutable' });
      });
      // No DELETE for the app role on values, records or edges (items only).
      for (const table of [
        'tenant_extension_values',
        'tenant_custom_records',
        'tenant_custom_relationships',
      ]) {
        await asApp(c, t, async (db) => {
          await expect(db.query(`DELETE FROM ${table}`), table).rejects.toMatchObject({
            code: '42501',
          });
        });
      }
      await asApp(c, t, async (db) => {
        await db.query(`DELETE FROM tenant_extension_value_items WHERE false`);
      });
      // Nothing was committed.
      expect(await valuesOf(c, t, company)).toEqual({});
    });

    it('V13: a target, reference, field, record parent or relationship end in another tenant is refused (23503); RLS and the entity index hold; the writer writes nothing', async () => {
      const a = await extensionTenant(c, 'xv13a', { portal: 4402 });
      const b = await extensionTenant(c, 'xv13b', { portal: 4403 });
      const companyA = (await companies(c, a, ['4402']))['4402']!;
      const companyB = (await companies(c, b, ['4403']))['4403']!;
      await observePerson(c, b, '4403');
      const personB = await personIdOf(c, b, '4403');
      const stringA = await baseRow(a, companyA, 'x_string', 'string');
      const refA = await baseRow(a, companyA, 'x_ref', 'reference');
      const fkRefused = (constraint: string) => ({ code: '23503', constraint });

      // Positive control: the same rows inside tenant A are accepted.
      await asApp(c, a, async (db) => {
        await insertValue(db, stringA, { value_text: 'ok' });
      });
      await asApp(c, a, async (db) => {
        await expect(
          insertValue(db, stringA, { target_id: companyB, value_text: 'x' }),
        ).rejects.toMatchObject(fkRefused('tenant_extension_values_target_id_fkey'));
      });
      await asApp(c, a, async (db) => {
        await expect(
          insertValue(db, refA, { value_ref_kind: 'company', value_ref_id: companyB }),
        ).rejects.toMatchObject(fkRefused('tenant_extension_values_ref_id_fkey'));
      });
      await asApp(c, a, async (db) => {
        await expect(
          insertValue(db, stringA, { field_id: await entryId(c, b, 'x_string'), value_text: 'x' }),
        ).rejects.toMatchObject(
          fkRefused('tenant_extension_values_tenant_id_field_registry_kind_fiel_fkey'),
        );
      });
      const siteA = await entryId(c, a, 'site');
      await asApp(c, a, async (db) => {
        await expect(
          db.query(
            `INSERT INTO tenant_custom_records (tenant_id, object_id, parent_kind, parent_id, origin)
             VALUES ($1, $2, 'company', $3, 'human')`,
            [a.tenantId, siteA, companyB],
          ),
        ).rejects.toMatchObject(fkRefused('tenant_custom_records_parent_id_fkey'));
      });
      const contactA = await entryId(c, a, 'site_contact');
      await asApp(c, a, async (db) => {
        const rec = await db.query<{ id: string }>(
          `INSERT INTO tenant_custom_records (tenant_id, object_id, parent_kind, parent_id, origin)
           VALUES ($1, $2, 'company', $3, 'human') RETURNING id::text`,
          [a.tenantId, siteA, companyA],
        );
        await expect(
          db.query(
            `INSERT INTO tenant_custom_relationships (tenant_id, rel_def_id, from_kind, from_id, to_kind, to_id, origin)
             VALUES ($1, $2, 'custom_record', $3, 'person', $4, 'human')`,
            [a.tenantId, contactA, rec.rows[0]!.id, personB],
          ),
        ).rejects.toMatchObject(fkRefused('tenant_custom_relationships_to_id_fkey'));
      });
      // A row stamped with tenant B is refused by RLS; the entity index cannot be forged.
      await asApp(c, a, async (db) => {
        await expect(
          insertValue(db, stringA, { tenant_id: b.tenantId, value_text: 'x' }),
        ).rejects.toMatchObject({ code: '42501' });
      });
      await asApp(c, a, async (db) => {
        await expect(
          db.query(
            `INSERT INTO tenant_entity_index (tenant_id, kind, entity_id) VALUES ($1, 'company', $2)`,
            [a.tenantId, companyB],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      });

      // Through the writer: refused, nothing written in either tenant.
      expect(await observe(a, companyA, { x_ref: `account:${companyB}` })).toMatchObject({
        written: 0,
        rejected: { reference_unresolved: 1 },
      });
      expect(await observe(a, companyB, { x_string: 'a' })).toMatchObject({
        status: 'target_unknown',
      });
      expect(await valuesOf(c, a)).toEqual({});
      expect(await valuesOf(c, b)).toEqual({});
    });
  });
});
