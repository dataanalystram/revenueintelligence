import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountHierarchyWriter } from '../../src/modules/context';
import {
  CanonicalAdoptionService,
  IntegrityVerificationService,
  SourceReferenceService,
  type ReferenceObservationInput,
} from '../../src/modules/governance';
import {
  SecurityEventsService,
  TenantDatabase,
  type TenantContext,
} from '../../src/modules/tenancy';
import {
  affiliationsOf,
  companies,
  hs,
  ingestMeta,
  link,
  observeCompany,
  observePerson,
  parentOf,
} from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import { authz } from '../support/security';

const M10C_CHECKS = [
  'hierarchy_cycle',
  'hierarchy_depth_exceeded',
  'hierarchy_parent_merged',
  'hierarchy_history_parity',
  'affiliation_endpoint_merged',
  'affiliation_reference_parity',
];

/**
 * M10C governance on real PostgreSQL (plan §7, §11, §19): the adoption dry run
 * and generic `person_affiliation` references at the 0.3 gate (V14 / V15), and
 * the six integrity checks — a clean tenant passes, planted findings (owner,
 * test database) are found and raised as a security event, nothing is
 * repaired (V17).
 */
describe('M10C account-structure governance', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  const adoption = () => c.app.get(CanonicalAdoptionService);
  const integrity = () => c.app.get(IntegrityVerificationService);
  const refs = () => c.app.get(SourceReferenceService);
  const db = () => c.app.get(TenantDatabase);
  const securityEvents = () => {
    const service = c.app.get(SecurityEventsService, { strict: false });
    const emitted: Record<string, unknown>[] = [];
    vi.spyOn(service, 'emit').mockImplementation((e) => void emitted.push({ ...e }));
    return emitted;
  };
  const reference = (externalId: string, entityId: string): ReferenceObservationInput => ({
    system: 'sugar',
    objectType: 'AccountContactRelation',
    externalId,
    entityKind: 'person_affiliation',
    entityId,
    presence: 'present',
    observedAt: new Date(),
    fieldHash: 'a'.repeat(64),
    meta: { cause: 'backfill', adapter: 'sugar', adapterVersion: 'test' },
  });
  async function observeReference(t: TenantContext, input: ReferenceObservationInput) {
    const actx = await authz(t, 'canonical.source_sync');
    return db().transaction(t, (tx) => refs().observe(actx, tx, input));
  }

  describe('V14 / V15: catalogue and adoption', () => {
    it('the adoption dry run lists the 0.3 features both ways and writes nothing', async () => {
      const t = await c.tenant('govplan', 1001);
      expect(await adoption().plan(t, '0.2', '0.3')).toMatchObject({
        current: '0.3',
        target: '0.2',
        decision: 'rollback',
        enables: [],
        disables: ['account_hierarchy', 'person_affiliations', 'hierarchy_operator_entry'],
      });
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.2',
        expectedCurrent: '0.3',
      });
      expect(await adoption().plan(t, '0.3', '0.2')).toMatchObject({
        decision: 'operator_adoption',
        enables: ['account_hierarchy', 'person_affiliations', 'hierarchy_operator_entry'],
        disables: [],
      });
      expect(await adoption().plan(t, '1.0', '0.2')).toMatchObject({ decision: 'refused' });
      const [{ n }] = (await c.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM tenant_canonical_adoptions WHERE tenant_id = $1`,
        [t.tenantId],
      )) as [{ n: number }];
      expect(n).toBe(2);
    });

    it('a generic person_affiliation reference needs canonical 0.3 and resolves to its affiliation', async () => {
      const t = await c.tenant('govref', 1001);
      await companies(c, t, ['1401']);
      const person = (await observePerson(c, t, '14001', { links: [link('1401', true)] }))
        .entityId!;
      const [row] = await affiliationsOf(c, t, person);
      const out = await observeReference(t, reference('acr-1', row!.id));
      expect(out.decision).toBe('create');
      const [stored] = await c.sql<{
        entity_kind: string;
        entity_id: string;
        origin: string;
        state: string;
      }>(
        `SELECT entity_kind, entity_id::text, origin, state FROM tenant_source_references
          WHERE tenant_id = $1 AND external_id = 'acr-1'`,
        [t.tenantId],
      );
      expect(stored).toEqual({
        entity_kind: 'person_affiliation',
        entity_id: row!.id,
        origin: 'observed',
        state: 'active',
      });
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.2',
        expectedCurrent: '0.3',
      });
      await expect(observeReference(t, reference('acr-2', row!.id))).rejects.toMatchObject({
        code: 'canonical_version_too_low',
      });
      expect(
        (await integrity().verify(t)).findings.filter(
          (f) => f.check === 'affiliation_reference_parity',
        ),
      ).toEqual([]);
    });
  });

  describe('V17: M10C integrity checks', () => {
    it('a clean tenant passes; planted cycle, depth overshoot, merged parent, history mismatch, merged endpoint and orphan reference are found and raised; nothing repaired', async () => {
      const t = await c.tenant('govint', 1001);
      const other = await c.tenant('govintb', 2002);
      // A clean structure through the writers.
      const ids = await companies(c, t, ['1701', '1702', '1703', '1704', '1705', '1706', '1707']);
      await observeCompany(c, t, '1702', { parent: '1701' });
      await observeCompany(c, t, '1703', { parent: '1702' });
      const person = (
        await observePerson(c, t, '17001', { links: [link('1701', true), link('1704')] })
      ).entityId!;
      const otherPerson = (await observePerson(c, t, '17002')).entityId!;
      const [aff] = (await affiliationsOf(c, t, person)).filter(
        (r) => r.company_id === ids['1704'],
      );
      await observeReference(t, reference('acr-int-1', aff!.id));
      await c.app.get(AccountHierarchyWriter).set(await authz(t, 'canonical.human_entry'), {
        companyId: ids['1705']!,
        parentId: ids['1701']!,
        reason: 'integrity_baseline',
      });
      const clean = await integrity().record(await authz(t, 'security.integrity.run'));
      expect(clean.outcome).toBe('passed');
      for (const check of M10C_CHECKS) expect(Object.keys(clean.checks)).toContain(check);
      const [run] = await c.sql<{ checks: unknown }>(
        `SELECT checks FROM tenant_integrity_runs WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, clean.runId],
      );
      for (const check of M10C_CHECKS) expect(JSON.stringify(run!.checks)).toContain(check);

      // Plant (owner, test database; replica mode bypasses the triggers where they would refuse).
      const ON = 'SET session_replication_role = replica;';
      const OFF = 'SET session_replication_role = origin;';
      // 1. A cycle 1706 ↔ 1707.
      await c.sql(
        `${ON}
         UPDATE companies SET parent_company_id = '${ids['1707']}' WHERE tenant_id = '${t.tenantId}' AND id = '${ids['1706']}';
         UPDATE companies SET parent_company_id = '${ids['1706']}' WHERE tenant_id = '${t.tenantId}' AND id = '${ids['1707']}';
         ${OFF}`,
      );
      // 2. A chain of depth 11 (the guardrail is 10): the trigger allows it, the writer never would.
      const deep = Object.values(
        await companies(
          c,
          t,
          Array.from({ length: 12 }, (_, i) => `18${String(i).padStart(2, '0')}`),
        ),
      );
      for (let i = 1; i < deep.length; i += 1) {
        await c.sql(
          `UPDATE companies SET parent_company_id = $3 WHERE tenant_id = $1 AND id = $2`,
          [t.tenantId, deep[i], deep[i - 1]],
        );
      }
      // 3. A live account under a merged parent.
      const merged = await companies(c, t, ['1901', '1902', '1903']);
      await c.ingestion.ingestMerge(
        await authz(t, 'canonical.source_sync'),
        { kind: 'company', survivor: hs('1902'), merged: [hs('1901')], observedAt: new Date() },
        ingestMeta(),
      );
      await c.sql(
        `${ON} UPDATE companies SET parent_company_id = '${merged['1901']}' WHERE tenant_id = '${t.tenantId}' AND id = '${merged['1903']}'; ${OFF}`,
      );
      // 4. The current parent differs from the latest history row (1703: history says 1702).
      await c.sql(`UPDATE companies SET parent_company_id = $3 WHERE tenant_id = $1 AND id = $2`, [
        t.tenantId,
        ids['1703'],
        ids['1701'],
      ]);
      // 5. An active affiliation whose person was merged without the participant.
      await c.sql(
        `UPDATE persons SET record_state = 'merged', merged_into_id = $3 WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, person, otherPerson],
      );
      // 6. A person_affiliation reference whose affiliation does not exist.
      await c.sql(
        `${ON} INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_id, origin)
         VALUES ('${t.tenantId}', 'sugar', 'AccountContactRelation', 'acr-orphan', 'person_affiliation', gen_random_uuid(), 'observed'); ${OFF}`,
      );
      const [orphan] = await c.sql<{ id: string }>(
        `SELECT id::text FROM tenant_source_references WHERE tenant_id = $1 AND external_id = 'acr-orphan'`,
        [t.tenantId],
      );

      const emitted = securityEvents();
      const found = await integrity().record(await authz(t, 'security.integrity.run'));
      expect(found.outcome).toBe('findings');
      const activeAffiliations = (await affiliationsOf(c, t, person)).filter(
        (r) => r.status === 'active',
      );
      expect(found.findings).toEqual(
        expect.arrayContaining([
          { check: 'hierarchy_cycle', ref: ids['1706'] },
          { check: 'hierarchy_cycle', ref: ids['1707'] },
          { check: 'hierarchy_depth_exceeded', ref: deep[11] },
          { check: 'hierarchy_parent_merged', ref: merged['1903'] },
          { check: 'hierarchy_history_parity', ref: ids['1703'] },
          ...activeAffiliations.map((r) => ({ check: 'affiliation_endpoint_merged', ref: r.id })),
          { check: 'affiliation_reference_parity', ref: orphan!.id },
        ]),
      );
      expect(activeAffiliations).toHaveLength(2);
      // Only the planted rows: the clean parts of the structure raise nothing.
      expect(found.findings.filter((f) => f.check === 'hierarchy_depth_exceeded')).toEqual([
        { check: 'hierarchy_depth_exceeded', ref: deep[11] },
      ]);
      expect(found.findings.filter((f) => f.check === 'hierarchy_history_parity')).toEqual([
        { check: 'hierarchy_history_parity', ref: ids['1703'] },
      ]);
      expect(emitted).toContainEqual(
        expect.objectContaining({ event: 'integrity_violation_detected', outcome: 'detected' }),
      );
      // Nothing repaired.
      expect((await parentOf(c, t, ids['1706']!)).parent_company_id).toBe(ids['1707']);
      expect((await parentOf(c, t, merged['1903']!)).parent_company_id).toBe(merged['1901']);
      expect((await parentOf(c, t, ids['1703']!)).parent_company_id).toBe(ids['1701']);
      expect(
        await c.sql(
          `SELECT 1 FROM tenant_source_references WHERE tenant_id = $1 AND external_id = 'acr-orphan'`,
          [t.tenantId],
        ),
      ).toHaveLength(1);
      // Another tenant is untouched and clean.
      expect((await integrity().verify(other)).outcome).toBe('passed');
    });
  });
});
