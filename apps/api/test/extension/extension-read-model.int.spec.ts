import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sourceSyncActor, type EvidenceRelation } from '../../src/modules/domain';
import { EvidenceLinkWriter, ModuleGate } from '../../src/modules/governance';
import {
  SecurityEventsService,
  TenantDatabase,
  type TenantContext,
} from '../../src/modules/tenancy';
import { auditOf, companies } from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import {
  defaultDocument,
  extensionTenant,
  REASON,
  services,
  sourceProvenance,
} from '../support/extension';
import { authz } from '../support/security';

/**
 * M10D read side and use enforcement on real PostgreSQL (plan §6, §8, §19
 * V14 / V16 / V19): `ExtensionReadModel` batch loads (one values query per
 * target kind, no N+1), filters by use (`ExtensionUseGuard`, explicit
 * request refused), shows confidential values only with the audited flag,
 * audits every read (`extension.read`, identifiers and counts only), needs
 * `data.extension.read`, paginates records; `EvidenceLinkWriter` refuses a
 * custom record as evidence of a `not_evidence_of` fact (Q21); and a privacy
 * scan finds no extension value in audit details, issues, change records or
 * security events.
 */
describe('M10D extension read model, use guard, evidence refusal, privacy', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  const read = () => services(c).read;
  const observe = async (t: TenantContext, id: string, values: Record<string, unknown>) =>
    services(c).values.observeSource(await authz(t, 'canonical.source_sync'), {
      target: { kind: 'company', id },
      values: Object.entries(values).map(([field, raw]) => ({ field, raw })),
      observedAt: new Date(),
      provenance: sourceProvenance(`r-${id.slice(0, 8)}`),
    });

  describe('V19 / V14: values read model', () => {
    it('batch loads many targets (one values query per kind), filters by use, refuses an explicit request, hides confidential values unless asked; every read audited', async () => {
      const t = await extensionTenant(c, 'rmvals');
      const ids = Object.values(
        await companies(
          c,
          t,
          Array.from({ length: 12 }, (_, i) => String(6000 + i)),
        ),
      );
      for (const [i, id] of ids.entries()) {
        await observe(t, id, { x_string: `v${i}`, x_conf: `c${i}`, x_analytics: `a${i}` });
      }
      const targets = ids.map((id) => `company:${id}`);
      const store = services(c).store;
      const batch = vi.spyOn(store, 'valuesForTargets');
      const items = vi.spyOn(store, 'items');
      const before = (await auditOf(c, t, 'extension.read')).length;

      const display = await read().valuesFor(
        await authz(t, 'data.extension.read'),
        'display',
        targets,
      );
      expect(batch).toHaveBeenCalledTimes(1);
      expect(items).toHaveBeenCalledTimes(1);
      expect(display).toHaveLength(24); // x_string + x_conf per target; x_analytics lacks display
      expect(new Set(display.map((v) => v.field))).toEqual(new Set(['x_string', 'x_conf']));
      const conf = display.find((v) => v.field === 'x_conf')!;
      expect(conf).toMatchObject({ sensitivity: 'confidential', shown: false });
      expect(conf).not.toHaveProperty('value');
      const str = display.find((v) => v.target === targets[0] && v.field === 'x_string')!;
      expect(str).toMatchObject({
        shown: true,
        value: 'v0',
        state: 'present',
        origin: 'source_provided',
      });

      const withConf = await read().valuesFor(
        await authz(t, 'data.extension.read'),
        'display',
        [targets[0]!],
        { includeConfidential: true },
      );
      expect(withConf.find((v) => v.field === 'x_conf')).toMatchObject({
        shown: true,
        value: 'c0',
      });

      const analytics = await read().valuesFor(await authz(t, 'data.extension.read'), 'analytics', [
        targets[0]!,
      ]);
      expect(analytics.map((v) => v.field).sort()).toEqual(['x_analytics', 'x_conf', 'x_string']);
      // No field allows eligibility: nothing is returned (no consumer path).
      expect(
        await read().valuesFor(await authz(t, 'data.extension.read'), 'eligibility', targets),
      ).toEqual([]);
      // An explicit request for a field lacking the use is refused (audited failed).
      await expect(
        read().valuesFor(await authz(t, 'data.extension.read'), 'display', [targets[0]!], {
          fields: ['x_analytics'],
        }),
      ).rejects.toMatchObject({ code: 'extension_use_not_allowed' });
      await expect(
        read().valuesFor(await authz(t, 'data.extension.read'), 'bogus', [targets[0]!]),
      ).rejects.toMatchObject({ code: 'validation_failed' });

      const events = (await auditOf(c, t, 'extension.read')).slice(before);
      expect(events.map((e) => [e.outcome, e.reason_code])).toEqual([
        ['allowed', null],
        ['allowed', null],
        ['allowed', null],
        ['allowed', null],
        ['failed', 'extension_use_not_allowed'],
        ['failed', 'validation_failed'],
      ]);
      expect(events[0]).toMatchObject({
        capability: 'data.extension.read',
        target_kind: 'extension_value',
        target_ref: '12_targets',
        details: { use: 'display', targets: 12, values: 24, includeConfidential: false },
      });
      expect(events[1]!.details).toMatchObject({ includeConfidential: true });
      expect(JSON.stringify(events)).not.toMatch(/"v0"|"c0"|"a0"/);
    });

    it('reference values resolve merge lineage (two hops) in one batch, not per row (no N+1)', async () => {
      const t = await extensionTenant(c, 'rmrefs');
      const ids = await companies(
        c,
        t,
        Array.from({ length: 10 }, (_, i) => String(6500 + i)).concat(['6590', '6591', '6592']),
      );
      const holders = Array.from({ length: 10 }, (_, i) => ids[String(6500 + i)]!);
      for (const id of holders) await observe(t, id, { x_ref: `account:${ids['6590']}` });
      const mergeInto = async (survivor: string, loser: string) =>
        c.ingestion.ingestMerge(
          await authz(t, 'canonical.source_sync'),
          {
            kind: 'company',
            survivor: { system: 'hubspot', objectType: 'companies', id: survivor },
            merged: [{ system: 'hubspot', objectType: 'companies', id: loser }],
            observedAt: new Date(),
          },
          { cause: 'webhook', correlationId: randomUUID() },
        );
      await mergeInto('6591', '6590');
      await mergeInto('6592', '6591');
      const store = services(c).store;
      const single = vi.spyOn(store, 'resolveLineage');
      const many = vi.spyOn(store, 'resolveLineageMany');
      const views = await read().valuesFor(
        await authz(t, 'data.extension.read'),
        'display',
        holders.map((id) => `company:${id}`),
        { fields: ['x_ref'] },
      );
      expect(views).toHaveLength(10);
      for (const v of views) {
        expect(v).toMatchObject({
          value: { kind: 'company', id: ids['6590'] },
          resolvedReference: `company:${ids['6592']}`,
        });
      }
      expect(single).not.toHaveBeenCalled();
      expect(many).toHaveBeenCalledTimes(1);
    });

    it('needs data.extension.read (operator); another tenant reads nothing (RLS); the use guard filters or refuses', async () => {
      const t = await extensionTenant(c, 'rmcap');
      const other = await extensionTenant(c, 'rmcapb', { portal: 2002 });
      const id = (await companies(c, t, ['6101']))['6101']!;
      await observe(t, id, { x_string: 'mine' });
      await expect(authz(t, 'data.extension.read', sourceSyncActor('run:x'))).rejects.toMatchObject(
        { reason: 'capability_not_granted' },
      );
      expect(
        await read().valuesFor(await authz(other, 'data.extension.read'), 'display', [
          `company:${id}`,
        ]),
      ).toEqual([]);
      const guard = services(c).guard;
      const registry = await c.app
        .get(TenantDatabase)
        .transaction(t, (tx) => services(c).store.registry(tx));
      const fields = [...registry.byKey.values()].filter((e) => e.definition.kind === 'field');
      const displayKeys = guard.require('display', fields);
      expect(displayKeys).toContain('x_string');
      expect(displayKeys).not.toContain('x_analytics');
      expect(() => guard.require('display', fields, ['x_analytics'])).toThrow(
        expect.objectContaining({ code: 'extension_use_not_allowed' }),
      );
      expect(guard.require('analytics', fields, ['x_analytics'])).toEqual(['x_analytics']);
    });
  });

  describe('V19: custom record read models', () => {
    it('keyset pagination over an object; a record with its values and relationships; one audit event per call', async () => {
      const t = await extensionTenant(c, 'rmrec');
      const ids = await companies(c, t, ['6201']);
      const human = async () => authz(t, 'canonical.human_entry');
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        created.push(
          (
            await services(c).records.createRecord(await human(), {
              object: 'asset',
              values: { asset_tag: `T-${i}` },
              reason: REASON,
            })
          ).recordId,
        );
      }
      const pages: string[][] = [];
      let after: string | undefined;
      const before = (await auditOf(c, t, 'extension.read')).length;
      do {
        const page = await read().records(await authz(t, 'data.extension.read'), {
          object: 'asset',
          limit: 2,
          ...(after ? { after } : {}),
        });
        pages.push(page.records.map((r) => r.id));
        after = page.next;
      } while (after);
      expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
      expect(pages.flat().sort()).toEqual([...created].sort());
      expect((await auditOf(c, t, 'extension.read')).length - before).toBe(3);

      const site = await services(c).records.createRecord(await human(), {
        object: 'site',
        parent: `company:${ids['6201']}`,
        values: { site_code: 'RM-1', site_size: '2' },
        reason: REASON,
      });
      await services(c).relationships.add(await human(), {
        relationship: 'site_asset',
        from: `custom_record:${site.recordId}`,
        to: `custom_record:${created[0]}`,
        reason: REASON,
      });
      const detail = await read().record(await authz(t, 'data.extension.read'), {
        record: site.recordId,
      });
      expect(detail).toMatchObject({
        id: site.recordId,
        object: 'site',
        recordState: 'active',
        parent: `company:${ids['6201']}`,
        origin: 'human',
      });
      expect(detail.values.map((v) => [v.field, v.value]).sort()).toEqual([
        ['site_code', 'RM-1'],
        ['site_size', '2'],
      ]);
      expect(detail.relationships).toEqual([
        expect.objectContaining({
          relationship: 'site_asset',
          from: `custom_record:${site.recordId}`,
          to: `custom_record:${created[0]}`,
          state: 'active',
        }),
      ]);
      expect((await auditOf(c, t, 'extension.read')).at(-1)).toMatchObject({
        outcome: 'allowed',
        target_kind: 'custom_record',
        target_ref: site.recordId,
        details: { values: 2, relationships: 1, includeConfidential: false },
      });
      await expect(
        read().records(await authz(t, 'data.extension.read'), { object: 'nope' }),
      ).rejects.toMatchObject({ code: 'extension_field_unknown' });
    });
  });

  describe('V14: not_evidence_of (EvidenceLinkWriter, Q21)', () => {
    const RELATIONS: readonly EvidenceRelation[] = [
      {
        subjectKind: 'company',
        evidenceType: 'entity',
        evidenceKind: 'custom_record',
        roles: ['supports'],
        fact: 'account_identity',
      },
      {
        subjectKind: 'company',
        evidenceType: 'entity',
        evidenceKind: 'custom_record',
        roles: ['context'],
        fact: 'coverage',
      },
    ];

    it('a custom record is refused as evidence of a floor fact and of a fact its object lists; allowed otherwise', async () => {
      const doc = defaultDocument() as { objects: Record<string, unknown>[] };
      doc.objects = doc.objects.map((o) =>
        o.key === 'site' ? { ...o, not_evidence_of: ['coverage'] } : o,
      );
      const t = await extensionTenant(c, 'rmevid', { document: doc });
      const ids = await companies(c, t, ['6301']);
      const human = async () => authz(t, 'canonical.human_entry');
      const site = (
        await services(c).records.createRecord(await human(), {
          object: 'site',
          parent: `company:${ids['6301']}`,
          reason: REASON,
        })
      ).recordId;
      const asset = (
        await services(c).records.createRecord(await human(), { object: 'asset', reason: REASON })
      ).recordId;
      const production = c.app.get(EvidenceLinkWriter);
      const writer = new EvidenceLinkWriter(production.audit, c.app.get(ModuleGate), RELATIONS);
      const write = async (evidenceId: string, role: 'supports' | 'context') => {
        const actx = await authz(t, 'canonical.evidence.link');
        return c.app.get(TenantDatabase).transaction(t, (tx) =>
          writer.write(actx, tx, {
            subjectKind: 'company',
            subjectId: ids['6301']!,
            origin: 'deterministic',
            derivation: { key: 'test.rule', version: '1', inputsHash: 'c'.repeat(64) },
            links: [
              {
                ordinal: 0,
                evidenceType: 'entity',
                evidenceKind: 'custom_record',
                evidenceId,
                role,
              },
            ],
          }),
        );
      };
      // The floor (account_identity) is always listed, whatever the object says.
      await expect(write(asset, 'supports')).rejects.toMatchObject({
        code: 'evidence_relation_not_allowed',
        detail: { reason: 'not_evidence_of' },
      });
      // `coverage` is listed by site, not by asset.
      await expect(write(site, 'context')).rejects.toMatchObject({
        code: 'evidence_relation_not_allowed',
      });
      await expect(write(asset, 'context')).resolves.toMatchObject({ links: 1 });
    });
  });

  describe('V16: privacy scan', () => {
    it('no extension value reaches audit details, issues, change records or security events', async () => {
      const t = await extensionTenant(c, 'rmpriv');
      const ids = await companies(c, t, ['6401', '6402']);
      const canary = (n: number) => `canary${n}${randomUUID().slice(0, 8)}`;
      const values = [canary(1), canary(2), canary(3), canary(4)];
      const emitted: unknown[] = [];
      const events = c.app.get(SecurityEventsService);
      const original = events.emit.bind(events);
      vi.spyOn(events, 'emit').mockImplementation((e) => {
        emitted.push(e);
        original(e);
      });
      await observe(t, ids['6401']!, {
        x_string: values[0],
        x_conf: values[1],
        x_restricted: values[2],
      });
      await services(c).values.set(await authz(t, 'canonical.human_entry'), {
        target: `company:${ids['6402']}`,
        field: 'x_string',
        value: values[3]!,
        reason: REASON,
      });
      await observe(t, ids['6402']!, { x_string: canary(5) }); // disagreement issue
      await services(c).read.valuesFor(
        await authz(t, 'data.extension.read'),
        'display',
        [`company:${ids['6401']}`, `company:${ids['6402']}`],
        { includeConfidential: true },
      );
      await expect(
        services(c).values.set(await authz(t, 'canonical.human_entry'), {
          target: `company:${ids['6402']}`,
          field: 'x_restricted',
          value: canary(6),
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'restricted_value_withheld' });
      const dump = JSON.stringify([
        await c.sql(
          `SELECT details, target_ref, reason_code FROM tenant_audit_events WHERE tenant_id = $1`,
          [t.tenantId],
        ),
        await c.sql(
          `SELECT canonical_ids::text[], external_refs, conflict_key FROM tenant_identity_conflicts WHERE tenant_id = $1`,
          [t.tenantId],
        ),
        await c.sql(
          `SELECT changed_fields, source_record_id, source_object_type FROM tenant_context_changes WHERE tenant_id = $1`,
          [t.tenantId],
        ),
        emitted,
      ]);
      expect(dump).not.toContain('canary');
      // The restricted value is not stored anywhere.
      const stored = await c.sql(
        `SELECT 1 FROM tenant_extension_values WHERE tenant_id = $1 AND value_text = $2`,
        [t.tenantId, values[2]],
      );
      expect(stored).toEqual([]);
    });
  });
});
