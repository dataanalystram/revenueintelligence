import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CustomRelationshipObservation } from '../../src/modules/extension';
import type { TenantContext } from '../../src/modules/tenancy';
import {
  appSession,
  asApp,
  auditOf,
  companies,
  observePerson,
  personIdOf,
} from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import {
  changesOf,
  edgesOf,
  entryId,
  extIssuesOf,
  extensionTenant,
  REASON,
  services,
  sourceProvenance,
} from '../support/extension';
import { authz } from '../support/security';

/**
 * M10D `CustomRelationshipWriter` and the guard trigger on real PostgreSQL as
 * the app role (plan §3.4, §4.2, §19 V8 / V10): cardinality enforced by the
 * writer and again by the trigger (two concurrent sessions, Q27), REPEATABLE
 * READ refused, unresolved endpoints as open issues retried on the next
 * observation, authoritative removal ends an edge, absence never does, the
 * operator edge is sticky, edges are terminal once ended and never deleted.
 */
describe('M10D custom relationships (CustomRelationshipWriter + guard trigger)', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const writer = () => services(c).relationships;
  const contactRef = (id: string) => ({ system: 'hubspot', objectType: 'contacts', id });
  const companyRef = (id: string) => ({ system: 'hubspot', objectType: 'companies', id });

  /** A site record (operator, parent = the company) and its id. */
  async function site(t: TenantContext, companyId: string, code: string): Promise<string> {
    return (
      await services(c).records.createRecord(await authz(t, 'canonical.human_entry'), {
        object: 'site',
        parent: `company:${companyId}`,
        values: { site_code: code },
        reason: REASON,
      })
    ).recordId;
  }
  async function asset(t: TenantContext): Promise<string> {
    return (
      await services(c).records.createRecord(await authz(t, 'canonical.human_entry'), {
        object: 'asset',
        reason: REASON,
      })
    ).recordId;
  }
  const observe = async (
    t: TenantContext,
    input: Omit<CustomRelationshipObservation, 'observedAt' | 'provenance'>,
  ) =>
    writer().observeSource(await authz(t, 'canonical.source_sync'), {
      ...input,
      observedAt: new Date(),
      provenance: sourceProvenance('rel-1', {
        source: { system: 'hubspot', objectType: 'p_sites', id: 'rel-1' },
      }),
    });

  describe('V8: writer behaviour', () => {
    it('many_to_one: add, unchanged, replace (source_removed), authoritative removal ends; absence never ends', async () => {
      const t = await extensionTenant(c, 'relm1');
      const ids = await companies(c, t, ['4001']);
      await observePerson(c, t, '4002');
      await observePerson(c, t, '4003');
      const s = await site(t, ids['4001']!, 'R-1');
      const from = { kind: 'custom_record' as const, id: s };
      const p2 = await personIdOf(c, t, '4002');
      const p3 = await personIdOf(c, t, '4003');
      expect(
        await observe(t, {
          relationshipKey: 'site_contact',
          from,
          to: { kind: 'person', ref: contactRef('4002') },
          role: 'primary',
        }),
      ).toEqual({ status: 'added' });
      let edges = await edgesOf(c, t);
      expect(edges).toEqual([
        expect.objectContaining({
          rel_key: 'site_contact',
          from_kind: 'custom_record',
          from_id: s,
          to_kind: 'person',
          to_id: p2,
          role_code: 'primary',
          state: 'active',
          end_reason: null,
          origin: 'source_provided',
        }),
      ]);
      expect((await changesOf(c, t, edges[0]!.id))[0]).toMatchObject({
        entity_kind: 'custom_relationship',
        change_type: 'relationship_changed',
        changed_fields: ['state'],
      });
      expect(
        await observe(t, {
          relationshipKey: 'site_contact',
          from,
          to: { kind: 'person', ref: contactRef('4002') },
        }),
      ).toEqual({ status: 'unchanged' });
      expect(
        await observe(t, {
          relationshipKey: 'site_contact',
          from,
          to: { kind: 'person', ref: contactRef('4003') },
        }),
      ).toEqual({ status: 'replaced' });
      edges = await edgesOf(c, t);
      expect(edges.map((e) => [e.to_id, e.state, e.end_reason])).toEqual([
        [p2, 'ended', 'source_removed'],
        [p3, 'active', null],
      ]);
      // Absence: other observations of the record (no statement) never end the edge.
      expect(
        await observe(t, {
          relationshipKey: 'site_owner',
          from,
          to: { kind: 'company', ref: companyRef('4001') },
        }),
      ).toEqual({ status: 'added' });
      expect((await edgesOf(c, t)).filter((e) => e.state === 'active')).toHaveLength(2);
      // Authoritative removal (explicit empty) ends the source edge.
      expect(await observe(t, { relationshipKey: 'site_contact', from, to: null })).toEqual({
        status: 'ended',
      });
      expect(await observe(t, { relationshipKey: 'site_contact', from, to: null })).toEqual({
        status: 'unchanged',
      });
      expect(
        (await edgesOf(c, t)).filter((e) => e.rel_key === 'site_contact').map((e) => e.state),
      ).toEqual(['ended', 'ended']);
    });

    it('unresolved endpoints are open issues retried on the next observation; unknown definitions and wrong ends are rejected', async () => {
      const t = await extensionTenant(c, 'relunr');
      const ids = await companies(c, t, ['4101']);
      const s = await site(t, ids['4101']!, 'R-2');
      const from = { kind: 'custom_record' as const, id: s };
      expect(
        await observe(t, {
          relationshipKey: 'site_contact',
          from,
          to: { kind: 'person', ref: contactRef('4102') },
        }),
      ).toEqual({ status: 'unresolved' });
      expect(await extIssuesOf(c, t, 'custom_relationship_endpoint_unresolved')).toEqual([
        {
          kind: 'custom_relationship_endpoint_unresolved',
          entity_kind: 'custom_record',
          state: 'open',
          canonical_ids: expect.arrayContaining([s]),
          external_refs: ['hubspot:contacts:4102'],
        },
      ]);
      await observePerson(c, t, '4102');
      expect(
        await observe(t, {
          relationshipKey: 'site_contact',
          from,
          to: { kind: 'person', ref: contactRef('4102') },
        }),
      ).toEqual({ status: 'added' });
      expect((await extIssuesOf(c, t, 'custom_relationship_endpoint_unresolved'))[0]!.state).toBe(
        'resolved',
      );
      expect(
        await observe(t, {
          relationshipKey: 'nope',
          from,
          to: { kind: 'person', ref: contactRef('4102') },
        }),
      ).toEqual({ status: 'rejected', reason: 'relationship_unknown' });
      // A from-end of the wrong kind / object.
      expect(
        await observe(t, {
          relationshipKey: 'site_contact',
          from: { kind: 'company', id: ids['4101']! },
          to: { kind: 'person', ref: contactRef('4102') },
        }),
      ).toEqual({ status: 'rejected', reason: 'endpoint_not_allowed' });
      const a = await asset(t);
      expect(
        await observe(t, {
          relationshipKey: 'site_contact',
          from: { kind: 'custom_record', id: a },
          to: { kind: 'person', ref: contactRef('4102') },
        }),
      ).toEqual({ status: 'rejected', reason: 'endpoint_not_allowed' });
      const off = await c.tenant('relunroff', 1001);
      expect(await observe(off, { relationshipKey: 'site_contact', from, to: null })).toEqual({
        status: 'module_disabled',
      });
    });

    it('one_to_one refuses a second edge to the same target; many_to_many keeps several targets', async () => {
      const t = await extensionTenant(c, 'relcard');
      const ids = await companies(c, t, ['4201', '4202']);
      const s1 = await site(t, ids['4201']!, 'R-3');
      const s2 = await site(t, ids['4201']!, 'R-4');
      expect(
        await observe(t, {
          relationshipKey: 'site_owner',
          from: { kind: 'custom_record', id: s1 },
          to: { kind: 'company', ref: companyRef('4201') },
        }),
      ).toEqual({ status: 'added' });
      expect(
        await observe(t, {
          relationshipKey: 'site_owner',
          from: { kind: 'custom_record', id: s2 },
          to: { kind: 'company', ref: companyRef('4201') },
        }),
      ).toEqual({ status: 'rejected', reason: 'endpoint_not_allowed' });
      const [a1, a2] = [await asset(t), await asset(t)];
      for (const a of [a1, a2]) {
        await services(c).relationships.add(await authz(t, 'canonical.human_entry'), {
          relationship: 'site_asset',
          from: `custom_record:${s1}`,
          to: `custom_record:${a}`,
          reason: REASON,
        });
      }
      const m2m = (await edgesOf(c, t)).filter((e) => e.rel_key === 'site_asset');
      expect(m2m.map((e) => [e.to_id, e.state])).toEqual([
        [a1, 'active'],
        [a2, 'active'],
      ]);
      // The same pair again: unchanged (no second active edge).
      expect(
        await services(c).relationships.add(await authz(t, 'canonical.human_entry'), {
          relationship: 'site_asset',
          from: `custom_record:${s1}`,
          to: `custom_record:${a1}`,
          reason: REASON,
        }),
      ).toMatchObject({ changed: false });
      expect((await edgesOf(c, t)).filter((e) => e.rel_key === 'site_asset')).toHaveLength(2);
    });
  });

  describe('V10: operator edges (sticky) and end', () => {
    it('an operator edge is not replaced by the source; ending is audited once; ends must match the definition', async () => {
      const t = await extensionTenant(c, 'relop');
      const ids = await companies(c, t, ['4301']);
      await observePerson(c, t, '4302');
      await observePerson(c, t, '4303');
      const s = await site(t, ids['4301']!, 'R-5');
      const p2 = await personIdOf(c, t, '4302');
      const before = (await auditOf(c, t)).length;
      const added = await writer().add(await authz(t, 'canonical.human_entry'), {
        relationship: 'site_contact',
        from: `custom_record:${s}`,
        to: `person:${p2}`,
        role: 'primary',
        reason: REASON,
      });
      expect(added).toMatchObject({ relationship: 'site_contact', state: 'active', changed: true });
      const events = (await auditOf(c, t)).slice(before);
      expect(events.map((e) => [e.action, e.outcome, e.target_ref])).toEqual([
        ['extension.relationship.add', 'allowed', added.edgeId],
      ]);
      expect(
        await observe(t, {
          relationshipKey: 'site_contact',
          from: { kind: 'custom_record', id: s },
          to: { kind: 'person', ref: contactRef('4303') },
        }),
      ).toEqual({ status: 'unchanged' });
      expect(
        await observe(t, {
          relationshipKey: 'site_contact',
          from: { kind: 'custom_record', id: s },
          to: null,
        }),
      ).toEqual({ status: 'unchanged' });
      expect((await edgesOf(c, t)).map((e) => [e.to_id, e.state, e.origin])).toEqual([
        [p2, 'active', 'human'],
      ]);
      await expect(
        writer().add(await authz(t, 'canonical.human_entry'), {
          relationship: 'site_contact',
          from: `company:${ids['4301']}`,
          to: `person:${p2}`,
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(
        writer().add(await authz(t, 'canonical.human_entry'), {
          relationship: 'site_contact',
          from: `custom_record:${s}`,
          to: `person:${p2}`,
          role: 'other',
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(
        await writer().endEdge(await authz(t, 'canonical.human_entry'), {
          edge: added.edgeId,
          reason: REASON,
        }),
      ).toMatchObject({ state: 'ended', changed: true });
      expect((await edgesOf(c, t))[0]).toMatchObject({ state: 'ended', end_reason: 'operator' });
      await expect(
        writer().endEdge(await authz(t, 'canonical.human_entry'), {
          edge: added.edgeId,
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect((await auditOf(c, t, 'extension.relationship.end')).map((e) => e.outcome)).toEqual([
        'allowed',
        'failed',
      ]);
    });
  });

  describe('V8 (adversarial): the guard trigger as the app role', () => {
    async function fixture(prefix: string) {
      const t = await extensionTenant(c, prefix);
      const ids = await companies(c, t, ['4401', '4402']);
      await observePerson(c, t, '4403');
      await observePerson(c, t, '4404');
      const s = await site(t, ids['4401']!, 'G-1');
      const def = await entryId(c, t, 'site_contact');
      const owner = await entryId(c, t, 'site_owner');
      return {
        t,
        ids,
        s,
        def,
        owner,
        p3: await personIdOf(c, t, '4403'),
        p4: await personIdOf(c, t, '4404'),
      };
    }
    const insertEdge = (
      tenantId: string,
      def: string,
      fromId: string,
      toKind: string,
      toId: string,
    ) => ({
      text: `INSERT INTO tenant_custom_relationships
               (tenant_id, id, rel_registry_kind, rel_def_id, from_kind, from_id, to_kind, to_id, state, origin, created_at, updated_at)
             VALUES ($1, $2, 'extension', $3, 'custom_record', $4, $5, $6, 'active', 'human', now(), now())`,
      values: [tenantId, randomUUID(), def, fromId, toKind, toId],
    });

    it('a second active edge (many_to_one, one_to_one) is refused; REPEATABLE READ is refused; ended edges are terminal; no DELETE', async () => {
      const f = await fixture('relgrd');
      await asApp(c, f.t, async (db) => {
        const first = insertEdge(f.t.tenantId, f.def, f.s, 'person', f.p3);
        await db.query(first.text, first.values);
        await db.query('SAVEPOINT a');
        const second = insertEdge(f.t.tenantId, f.def, f.s, 'person', f.p4);
        await expect(db.query(second.text, second.values)).rejects.toMatchObject({
          code: '23505',
          message: 'custom_relationship_cardinality',
        });
        await db.query('ROLLBACK TO SAVEPOINT a');
        // Ended edges are terminal (state cannot come back).
        await db.query(
          `UPDATE tenant_custom_relationships SET state = 'ended', ended_at = now(), end_reason = 'operator' WHERE id = $1`,
          [first.values[1]],
        );
        await db.query('SAVEPOINT b');
        await expect(
          db.query(
            `UPDATE tenant_custom_relationships SET state = 'active', ended_at = NULL, end_reason = NULL WHERE id = $1`,
            [first.values[1]],
          ),
        ).rejects.toMatchObject({ message: 'custom_relationship_terminal' });
        await db.query('ROLLBACK TO SAVEPOINT b');
        // Ends are immutable.
        await db.query('SAVEPOINT c');
        await expect(
          db.query(`UPDATE tenant_custom_relationships SET to_id = $2 WHERE id = $1`, [
            first.values[1],
            f.p4,
          ]),
        ).rejects.toMatchObject({ message: 'custom_relationship_identity_immutable' });
        await db.query('ROLLBACK TO SAVEPOINT c');
        await expect(db.query(`DELETE FROM tenant_custom_relationships`)).rejects.toMatchObject({
          code: '42501',
        });
      });
      // one_to_one: two sites to the same account.
      const s2 = await site(f.t, f.ids['4401']!, 'G-2');
      await asApp(c, f.t, async (db) => {
        const a = insertEdge(f.t.tenantId, f.owner, f.s, 'company', f.ids['4402']!);
        await db.query(a.text, a.values);
        const b = insertEdge(f.t.tenantId, f.owner, s2, 'company', f.ids['4402']!);
        await expect(db.query(b.text, b.values)).rejects.toMatchObject({
          message: 'custom_relationship_cardinality',
        });
      });
      // A registry entry that is not a relationship definition is refused.
      const fieldDef = await entryId(c, f.t, 'site_code');
      await asApp(c, f.t, async (db) => {
        const x = insertEdge(f.t.tenantId, fieldDef, f.s, 'person', f.p3);
        await expect(db.query(x.text, x.values)).rejects.toMatchObject({
          message: 'custom_relationship_definition_invalid',
        });
      });
      const rr = await appSession(c, f.t, 'REPEATABLE READ');
      try {
        const e = insertEdge(f.t.tenantId, f.def, f.s, 'person', f.p3);
        await expect(rr.query(e.text, e.values)).rejects.toMatchObject({
          code: '0A000',
          message: 'custom_relationship_isolation_unsupported',
        });
      } finally {
        await rr.query('ROLLBACK').catch(() => undefined);
        await rr.end();
      }
      expect(await edgesOf(c, f.t)).toEqual([]);
    });

    it('two concurrent sessions: the second blocks on the per-(definition, from) lock and is refused after the first commits', async () => {
      const f = await fixture('relconc');
      const a = await appSession(c, f.t);
      const b = await appSession(c, f.t);
      try {
        const ea = insertEdge(f.t.tenantId, f.def, f.s, 'person', f.p3);
        const eb = insertEdge(f.t.tenantId, f.def, f.s, 'person', f.p4);
        await a.query(ea.text, ea.values);
        let bDone = false;
        const pending = b.query(eb.text, eb.values).finally(() => {
          bDone = true;
        });
        await new Promise((r) => setTimeout(r, 300));
        expect(bDone).toBe(false); // waiting on the advisory lock
        await a.query('COMMIT');
        await expect(pending).rejects.toMatchObject({ message: 'custom_relationship_cardinality' });
      } finally {
        await b.query('ROLLBACK').catch(() => undefined);
        await Promise.all([a.end(), b.end()]);
      }
      expect((await edgesOf(c, f.t)).map((e) => e.to_id)).toEqual([f.p3]);
    });

    it('two concurrent writer calls for the same from-end leave one active edge (many_to_one)', async () => {
      const f = await fixture('relconcw');
      const results = await Promise.all([
        observe(f.t, {
          relationshipKey: 'site_contact',
          from: { kind: 'custom_record', id: f.s },
          to: { kind: 'person', ref: contactRef('4403') },
        }),
        observe(f.t, {
          relationshipKey: 'site_contact',
          from: { kind: 'custom_record', id: f.s },
          to: { kind: 'person', ref: contactRef('4404') },
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['added', 'replaced']);
      expect((await edgesOf(c, f.t)).filter((e) => e.state === 'active')).toHaveLength(1);
    });
  });
});
