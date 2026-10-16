import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EvidenceRelation, EvidenceSetInput } from '../../src/modules/domain';
import {
  CanonicalAdoptionService,
  EvidenceLinkWriter,
  IntegrityVerificationService,
  ModuleGate,
  ProvenanceQueryService,
} from '../../src/modules/governance';
import {
  PrivilegeManifestCheck,
  SecurityEventsService,
  TenantDatabase,
  type TenantContext,
} from '../../src/modules/tenancy';
import { CLASSIFICATION_MANIFEST } from '../../src/modules/tenancy/security';
import { startContextHarness, type ContextHarness } from '../support/context';
import { genericModel } from '../support/product-models';
import { authz, TEST_OPERATOR, TEST_RUN, TEST_SYSTEM } from '../support/security';

/** Test relation catalogue (the production catalogue is empty in M10B, Q13). */
const TEST_RELATIONS: readonly EvidenceRelation[] = [
  {
    subjectKind: 'company',
    evidenceType: 'entity',
    evidenceKind: 'company',
    roles: ['supports', 'context'],
  },
  { subjectKind: 'company', evidenceType: 'change_record', roles: ['derived_from'] },
  { subjectKind: 'product', evidenceType: 'entity', evidenceKind: 'company', roles: ['supports'] },
];
const INPUTS_HASH = 'c'.repeat(64);

/**
 * M10B (plan §19) on real PostgreSQL, app role, forced RLS: EvidenceLinkWriter
 * with a test relation catalogue (V9), evidence immutability (V10),
 * adversarial cross-tenant evidence by raw SQL (V11), the provenance read
 * model (V13), the 0.2 gate for evidence (V15), planted findings of the M10B
 * integrity checks (V17) and the policy v3 capabilities (V18).
 */
describe('M10B evidence links and provenance', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  const db = () => c.app.get(TenantDatabase);
  const production = () => c.app.get(EvidenceLinkWriter);
  const writer = () =>
    new EvidenceLinkWriter(production().audit, c.app.get(ModuleGate), TEST_RELATIONS);
  const provenance = () => c.app.get(ProvenanceQueryService);
  const integrity = () => c.app.get(IntegrityVerificationService);
  const adoption = () => c.app.get(CanonicalAdoptionService);

  async function companyOf(t: TenantContext, id: string, name = `Company ${id}`) {
    const r = await c.ingestion.ingest(
      await authz(t, 'canonical.source_sync'),
      {
        kind: 'company',
        presence: 'present',
        ref: { system: 'hubspot', objectType: 'companies', id },
        observedAt: new Date(),
        fields: { name },
      },
      { cause: 'webhook', correlationId: randomUUID() },
    );
    return r.entityId!;
  }
  const changeOf = async (t: TenantContext, entityId: string) =>
    (
      await c.sql<{ id: string }>(
        `SELECT id::text FROM tenant_context_changes WHERE tenant_id = $1 AND entity_id = $2
          ORDER BY ingested_at DESC LIMIT 1`,
        [t.tenantId, entityId],
      )
    )[0]!.id;
  async function write(t: TenantContext, set: EvidenceSetInput, w: EvidenceLinkWriter = writer()) {
    const actx = await authz(t, 'canonical.evidence.link');
    return db().transaction(t, (tx) => w.write(actx, tx, set));
  }
  const linkRows = (t: TenantContext) =>
    c.sql<{
      link_set_id: string;
      ordinal: number;
      subject_id: string | null;
      evidence_type: string;
      role: string;
      origin: string;
      canonical_version: string;
      actor_kind: string;
      supersedes_link_set_id: string | null;
    }>(
      `SELECT link_set_id::text, ordinal, subject_id::text, evidence_type, role, origin, canonical_version,
              actor_kind, supersedes_link_set_id::text
         FROM tenant_evidence_links WHERE tenant_id = $1 ORDER BY created_at, link_set_id, ordinal`,
      [t.tenantId],
    );
  const auditOf = (t: TenantContext, action: string) =>
    c.sql<{ outcome: string; reason_code: string | null; details: unknown }>(
      `SELECT outcome, reason_code, details FROM tenant_audit_events
        WHERE tenant_id = $1 AND action = $2 ORDER BY seq`,
      [t.tenantId, action],
    );
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
  const securityEvents = () => {
    const service = c.app.get(SecurityEventsService, { strict: false });
    const emitted: Record<string, unknown>[] = [];
    vi.spyOn(service, 'emit').mockImplementation((e) => void emitted.push({ ...e }));
    return emitted;
  };
  const supportSet = (subject: string, evidence: string, change: string): EvidenceSetInput => ({
    subjectKind: 'company',
    subjectId: subject,
    origin: 'deterministic',
    derivation: { key: 'test.rule', version: '1', inputsHash: INPUTS_HASH },
    links: [
      {
        ordinal: 0,
        evidenceType: 'entity',
        evidenceKind: 'company',
        evidenceId: evidence,
        role: 'supports',
        weight: 0.5,
      },
      { ordinal: 1, evidenceType: 'change_record', evidenceChangeId: change, role: 'derived_from' },
    ],
  });

  describe('V9: EvidenceLinkWriter', () => {
    it('writes a valid set of the test catalogue; refuses relations outside it, invalid sets, bad derivations, foreign supersession and missing / merged targets (audited)', async () => {
      const t = await c.tenant('evw', 1001);
      const subject = await companyOf(t, '8101');
      const evidence = await companyOf(t, '8102');
      const change = await changeOf(t, evidence);
      const first = await write(t, supportSet(subject, evidence, change));
      expect(first.links).toBe(2);
      const written = await linkRows(t);
      expect(written).toHaveLength(2);
      for (const l of written) {
        expect(l).toMatchObject({
          link_set_id: first.linkSetId,
          subject_id: subject,
          origin: 'deterministic',
          canonical_version: '0.6',
          actor_kind: 'system',
          supersedes_link_set_id: null,
        });
      }

      // The production catalogue is empty: the same set is refused (the catalogue is consulted).
      await expect(
        write(t, supportSet(subject, evidence, change), production()),
      ).rejects.toMatchObject({
        code: 'evidence_relation_not_allowed',
      });
      const refusals: [string, EvidenceSetInput, string][] = [
        [
          'role outside the catalogue',
          {
            ...supportSet(subject, evidence, change),
            links: [
              {
                ordinal: 0,
                evidenceType: 'entity',
                evidenceKind: 'company',
                evidenceId: evidence,
                role: 'contradicts',
              },
            ],
          },
          'evidence_relation_not_allowed',
        ],
        [
          'an empty set',
          { ...supportSet(subject, evidence, change), links: [] },
          'evidence_set_invalid',
        ],
        [
          'duplicate ordinals',
          {
            ...supportSet(subject, evidence, change),
            links: supportSet(subject, evidence, change).links.map((l) => ({ ...l, ordinal: 0 })),
          },
          'evidence_set_invalid',
        ],
        [
          'deterministic without a derivation',
          {
            subjectKind: 'company',
            subjectId: subject,
            origin: 'deterministic',
            links: supportSet(subject, evidence, change).links,
          },
          'evidence_set_invalid',
        ],
        [
          'human with a derivation',
          { ...supportSet(subject, evidence, change), origin: 'human' },
          'evidence_set_invalid',
        ],
        [
          'a missing evidence entity',
          supportSet(subject, randomUUID(), change),
          'evidence_target_not_allowed',
        ],
        [
          'a missing change record',
          supportSet(subject, evidence, randomUUID()),
          'evidence_target_not_allowed',
        ],
        [
          'supersession of an unknown set',
          { ...supportSet(subject, evidence, change), supersedesLinkSetId: randomUUID() },
          'evidence_set_invalid',
        ],
      ];
      for (const [label, set, code] of refusals) {
        await expect(write(t, set), label).rejects.toMatchObject({ code });
      }
      // Supersession: same subject accepted; another subject refused.
      const second = await write(t, {
        ...supportSet(subject, evidence, change),
        supersedesLinkSetId: first.linkSetId,
      });
      await expect(
        write(t, {
          ...supportSet(evidence, subject, change),
          supersedesLinkSetId: first.linkSetId,
        }),
      ).rejects.toMatchObject({ code: 'evidence_set_invalid' });
      // A set is superseded at most once (linear chain, review m3).
      await expect(
        write(t, {
          ...supportSet(subject, evidence, change),
          supersedesLinkSetId: first.linkSetId,
        }),
      ).rejects.toMatchObject({
        code: 'evidence_set_invalid',
        message: expect.stringMatching(/already superseded/) as unknown,
      });
      // Merged target refused (planted as owner, triggers off).
      const merged = await companyOf(t, '8103');
      await c.sql(
        `SET session_replication_role = replica;
         UPDATE companies SET record_state = 'merged', merged_into_id = '${evidence}' WHERE tenant_id = '${t.tenantId}' AND id = '${merged}';
         SET session_replication_role = origin;`,
      );
      await expect(write(t, supportSet(subject, merged, change))).rejects.toMatchObject({
        code: 'evidence_target_not_allowed',
      });
      // Nothing of a refused set was written; the old set is kept after supersession.
      expect(new Set((await linkRows(t)).map((l) => l.link_set_id))).toEqual(
        new Set([first.linkSetId, second.linkSetId]),
      );
      const audited = await auditOf(t, 'evidence.link');
      expect(audited.length).toBeGreaterThanOrEqual(refusals.length + 3);
      expect(audited.every((e) => e.outcome !== 'allowed')).toBe(true);
      expect(JSON.stringify(audited)).toMatch(/evidence_relation_not_allowed/);
      expect(JSON.stringify(audited)).toMatch(/evidence_target_not_allowed/);
    });

    it('V15: at 0.1 the writer refuses (canonical_version_too_low, audited); after re-adoption it writes', async () => {
      const t = await c.tenant('evgate', 2002);
      const subject = await companyOf(t, '8201');
      const evidence = await companyOf(t, '8202');
      const change = await changeOf(t, evidence);
      // M10C: new tenants adopt 0.3; rollback goes one MINOR at a time (0.3 → 0.2 → 0.1).
      // M10F: new tenants adopt 0.6; step back to 0.5 first.
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.5',
        expectedCurrent: '0.6',
      });
      // M10E: new tenants adopt 0.5; rollback goes one MINOR at a time (0.5 → 0.4 first).
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      // M10D: new tenants adopt 0.4; rollback goes one MINOR at a time (0.4 → 0.3 first).
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.3',
        expectedCurrent: '0.4',
      });
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.2',
        expectedCurrent: '0.3',
      });
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.1',
        expectedCurrent: '0.2',
      });
      await expect(write(t, supportSet(subject, evidence, change))).rejects.toMatchObject({
        code: 'canonical_version_too_low',
      });
      expect(JSON.stringify(await auditOf(t, 'evidence.link'))).toMatch(
        /canonical_version_too_low/,
      );
      expect(await linkRows(t)).toEqual([]);
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.2',
        expectedCurrent: '0.1',
      });
      await expect(write(t, supportSet(subject, evidence, change))).resolves.toMatchObject({
        links: 2,
      });
    });
  });

  describe('V10: evidence and change records are tamper-protected', () => {
    it('app role UPDATE / DELETE denied; owner UPDATE / DELETE refused by the trigger', async () => {
      const t = await c.tenant('evimm', 3003);
      const subject = await companyOf(t, '8301');
      const evidence = await companyOf(t, '8302');
      const change = await changeOf(t, evidence);
      await write(t, supportSet(subject, evidence, change));
      for (const sql of [
        `UPDATE tenant_evidence_links SET role = 'context'`,
        `DELETE FROM tenant_evidence_links`,
        `UPDATE tenant_context_changes SET cause = 'backfill'`,
        `DELETE FROM tenant_context_changes`,
      ]) {
        await expect(
          asApp(t, (client) => client.query(sql)),
          sql,
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        c.sql(`UPDATE tenant_evidence_links SET role = 'context' WHERE tenant_id = $1`, [
          t.tenantId,
        ]),
      ).rejects.toThrow(/evidence links are append-only/);
      await expect(
        c.sql(`DELETE FROM tenant_evidence_links WHERE tenant_id = $1`, [t.tenantId]),
      ).rejects.toThrow(/evidence links are append-only/);
      expect(await linkRows(t)).toHaveLength(2);
      expect(
        await c.sql(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'lip_app' AND table_name = 'tenant_evidence_links' ORDER BY 1`,
        ),
      ).toEqual([{ privilege_type: 'INSERT' }, { privilege_type: 'SELECT' }]);
    });
  });

  describe('V11: adversarial cross-tenant evidence (app role, raw SQL, writer bypassed)', () => {
    it('refuses citing or naming another tenant by entity id, change record or tenant id; RLS hides it', async () => {
      const a = await c.tenant('evadva', 1001);
      const b = await c.tenant('evadvb', 2002);
      const subjectA = await companyOf(a, '8401');
      const companyB = await companyOf(b, '8402');
      const changeB = await changeOf(b, companyB);
      const changeA = await changeOf(a, subjectA);
      const insert = (tenant: string, cols: string, vals: string) =>
        asApp(a, (client) =>
          client.query(
            `INSERT INTO tenant_evidence_links (tenant_id, link_set_id, ordinal, subject_kind, origin, canonical_version,
               actor_kind, actor_id, actor_assurance, correlation_id, subject_id, evidence_type, role${cols})
             VALUES ('${tenant}', gen_random_uuid(), 0, 'company', 'human', '0.2', 'system', 'test', 'system',
               gen_random_uuid(), ${vals})`,
          ),
        );
      // Positive control: a same-tenant link is accepted by the database.
      await expect(
        insert(
          a.tenantId,
          ', evidence_change_id',
          `'${subjectA}', 'change_record', 'supports', '${changeA}'`,
        ),
      ).resolves.toBeDefined();
      await expect(
        insert(
          a.tenantId,
          ', evidence_kind, evidence_id',
          `'${subjectA}', 'entity', 'supports', 'company', '${companyB}'`,
        ),
      ).rejects.toThrow(/tenant_evidence_links_tenant_id_evidence_kind_evidence_id_fkey/);
      await expect(
        insert(
          a.tenantId,
          ', evidence_change_id',
          `'${subjectA}', 'change_record', 'supports', '${changeB}'`,
        ),
      ).rejects.toThrow(/tenant_evidence_links_tenant_id_evidence_change_id_fkey/);
      await expect(
        insert(
          a.tenantId,
          ', evidence_change_id',
          `'${companyB}', 'change_record', 'supports', '${changeA}'`,
        ),
      ).rejects.toThrow(/tenant_evidence_links_tenant_id_subject_kind_subject_id_fkey/);
      await expect(
        insert(
          a.tenantId,
          ', evidence_snapshot_id',
          `'${subjectA}', 'eligibility_snapshot', 'supports', gen_random_uuid()`,
        ),
      ).rejects.toThrow(/tenant_evidence_links_tenant_id_evidence_snapshot_id_fkey/);
      await expect(
        insert(
          b.tenantId,
          ', evidence_change_id',
          `'${companyB}', 'change_record', 'supports', '${changeB}'`,
        ),
      ).rejects.toThrow(/row-level security/);
      // B's links are invisible to A.
      await write(b, supportSet(companyB, await companyOf(b, '8403'), changeB));
      expect(
        await asApp(
          a,
          async (client) =>
            (await client.query<{ n: number }>(`SELECT 1 AS n FROM tenant_evidence_links`)).rows,
        ),
      ).toEqual([]);
      // The FK on the change record is composite (tenant included), not single-column.
      const [fk] = await c.sql<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'tenant_evidence_links_tenant_id_evidence_change_id_fkey'`,
      );
      expect(fk!.def).toMatch(/FOREIGN KEY \(tenant_id, evidence_change_id\)/);
    });
  });

  describe('V13: provenance read model', () => {
    it('answers the E5 questions for a company field and a product key; value-free; one audit event; capability required', async () => {
      const t = await c.tenant('evprov', 3003);
      const subject = await companyOf(t, '8501', 'Prov Co Name');
      const evidence = await companyOf(t, '8502');
      const change = await changeOf(t, evidence);
      const first = await write(t, supportSet(subject, evidence, change));
      const second = await write(t, {
        ...supportSet(subject, evidence, change),
        supersedesLinkSetId: first.linkSetId,
      });
      await c.h.catalogue.publish(
        await authz(t, 'config.product_model.publish'),
        genericModel({
          products: genericModel().products.map((p) =>
            p.key === 'core'
              ? {
                  ...p,
                  externalRefs: [{ system: 'sugar', objectType: 'ProductTemplates', id: 'prov-1' }],
                }
              : p,
          ),
        }),
        { basedOnVersion: 0 },
      );
      const before = (await auditOf(t, 'provenance.read')).length;
      const report = await provenance().show(await authz(t, 'data.provenance.read'), {
        kind: 'company',
        id: subject,
        field: 'name',
      });
      expect(report.references).toEqual([
        expect.objectContaining({
          store: 'company_external_refs',
          system: 'hubspot',
          objectType: 'companies',
          externalId: '8501',
          state: 'active',
          origin: 'observed',
        }),
      ]);
      expect(report.field!.change).toMatchObject({
        source: { system: 'hubspot', objectType: 'companies', recordId: '8501' },
        cause: 'webhook',
        origin: 'source_provided',
        canonicalVersion: '0.6',
        actor: { kind: 'source_sync' },
      });
      for (const h of report.field!.history) {
        if (!h.valuesRecorded) {
          expect(h).not.toHaveProperty('oldValue');
          expect(h).not.toHaveProperty('newValue');
        }
      }
      if (!report.field!.history.some((h) => h.valuesRecorded)) {
        expect(JSON.stringify(report)).not.toContain('Prov Co Name');
      }
      expect(report.evidence.current.map((s) => s.linkSetId)).toEqual([second.linkSetId]);
      expect(report.evidence.superseded.map((s) => s.linkSetId)).toEqual([first.linkSetId]);
      expect(
        report.evidence.current[0]!.links.map((l) => [l.ordinal, l.evidenceType, l.role]),
      ).toEqual([
        [0, 'entity', 'supports'],
        [1, 'change_record', 'derived_from'],
      ]);
      const after = await auditOf(t, 'provenance.read');
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toMatchObject({ outcome: 'allowed' });
      expect(JSON.stringify(after.at(-1))).not.toContain('Prov Co Name');

      // Reverse lookup: the evidence company is cited by both sets.
      const cited = await provenance().show(await authz(t, 'data.provenance.read'), {
        kind: 'company',
        id: evidence,
      });
      expect(cited.citedBy.map((x) => x.linkSetId).sort()).toEqual(
        [first.linkSetId, second.linkSetId].sort(),
      );
      // A product key: the declared reference.
      const product = await provenance().show(await authz(t, 'data.provenance.read'), {
        kind: 'product',
        key: 'core',
      });
      expect(product.references).toEqual([
        expect.objectContaining({
          store: 'tenant_source_references',
          system: 'sugar',
          objectType: 'ProductTemplates',
          externalId: 'prov-1',
          origin: 'declared',
          state: 'active',
        }),
      ]);
      // V18: data.provenance.read is operator-only; canonical.evidence.link system-only.
      await expect(authz(t, 'data.provenance.read', TEST_RUN)).rejects.toThrow();
      await expect(authz(t, 'data.provenance.read', TEST_SYSTEM)).rejects.toThrow();
      await expect(authz(t, 'canonical.evidence.link', TEST_OPERATOR)).rejects.toThrow();
      await expect(authz(t, 'canonical.evidence.link', TEST_RUN)).rejects.toThrow();
      expect((await auditOf(t, 'provenance.read')).length).toBe(before + 3);
    });

    it('value-free history rows never carry values; show refuses a context without data.provenance.read', async () => {
      // No catalogued field is sensitive yet, so history is otherwise always value-bearing
      // (VM19 survived without this). Raise company.name to `restricted` for the test (M10A2 V12 pattern).
      const manifest = CLASSIFICATION_MANIFEST as Record<string, Record<string, unknown>>;
      const original = manifest.companies!.name;
      manifest.companies!.name = { ...(original as object), sensitivity: 'restricted' };
      try {
        const t = await c.tenant('evprovvf', 3004);
        const subject = await companyOf(t, '8601', 'Hidden One');
        await companyOf(t, '8601', 'Hidden Two');
        const report = await provenance().show(await authz(t, 'data.provenance.read'), {
          kind: 'company',
          id: subject,
          field: 'name',
        });
        expect(report.field!.history.length).toBeGreaterThan(0);
        for (const h of report.field!.history) {
          expect(h.valuesRecorded).toBe(false);
          expect(h).not.toHaveProperty('oldValue');
          expect(h).not.toHaveProperty('newValue');
        }
        expect(JSON.stringify(report)).not.toMatch(/Hidden (One|Two)/);
        // The service checks the capability itself (VM18 survived without this):
        // a context authorized for another capability is refused.
        await expect(
          provenance().show((await authz(t, 'config.product_model.publish')) as never, {
            kind: 'company',
            id: subject,
          }),
        ).rejects.toThrow();
      } finally {
        manifest.companies!.name = original;
      }
    });
  });

  describe('V17: M10B integrity checks', () => {
    it('a clean tenant passes; planted drift, ambiguity, change mismatch, unknown relation and invalid supersession are found, raised and never repaired', async () => {
      const t = await c.tenant('evint', 1001);
      const other = await c.tenant('evintb', 2002);
      const company = await companyOf(t, '8601', 'Integrity Name');
      const second = await companyOf(t, '8602');
      const change = await changeOf(t, company);
      await c.h.catalogue.publish(
        await authz(t, 'config.product_model.publish'),
        genericModel({
          products: genericModel().products.map((p) =>
            p.key === 'core'
              ? {
                  ...p,
                  externalRefs: [{ system: 'sugar', objectType: 'ProductTemplates', id: 'int-1' }],
                }
              : p,
          ),
        }),
        { basedOnVersion: 0 },
      );
      securityEvents();
      const clean = await integrity().record(await authz(t, 'security.integrity.run'));
      expect(clean.outcome).toBe('passed');
      const [run] = await c.sql<{ checks: unknown }>(
        `SELECT checks FROM tenant_integrity_runs WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, clean.runId],
      );
      for (const check of [
        'declared_reference_drift',
        'source_reference_ambiguous',
        'source_reference_change_mismatch',
        'evidence_relation_unknown',
        'evidence_supersession_invalid',
        'source_reference_index_parity',
      ]) {
        expect(JSON.stringify(run!.checks)).toContain(check);
      }

      // Plant (owner, test database).
      await c.sql(
        `UPDATE tenant_source_references SET entity_key = 'suite' WHERE tenant_id = $1 AND external_id = 'int-1'`,
        [t.tenantId],
      );
      const [ambiguous] = await c.sql<{ id: string }>(
        `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_key, origin)
         VALUES ($1, 'hubspot', 'companies', '8601', 'product', 'core', 'observed') RETURNING id::text`,
        [t.tenantId],
      );
      await c.sql(
        `UPDATE tenant_source_references SET last_change_id = $2 WHERE tenant_id = $1 AND id = $3`,
        [t.tenantId, change, ambiguous!.id],
      );
      const unknownSet = randomUUID();
      const badSupersession = randomUUID();
      await c.sql(
        `INSERT INTO tenant_evidence_links (tenant_id, link_set_id, ordinal, subject_kind, subject_id, evidence_type,
           evidence_kind, evidence_id, role, origin, canonical_version, actor_kind, actor_id, actor_assurance,
           correlation_id, supersedes_link_set_id)
         VALUES ($1, $2, 0, 'company', $3, 'entity', 'company', $4, 'supports', 'human', '0.2', 'system', 'test', 'system',
                 gen_random_uuid(), NULL),
                ($1, $5, 0, 'company', $3, 'entity', 'company', $4, 'supports', 'human', '0.2', 'system', 'test', 'system',
                 gen_random_uuid(), $6)`,
        [t.tenantId, unknownSet, company, second, badSupersession, randomUUID()],
      );
      // A fork: two sets supersede the same set (review m3).
      await c.sql(
        `INSERT INTO tenant_evidence_links (tenant_id, link_set_id, ordinal, subject_kind, subject_id, evidence_type,
           evidence_kind, evidence_id, role, origin, canonical_version, actor_kind, actor_id, actor_assurance,
           correlation_id, supersedes_link_set_id)
         SELECT $1, gen_random_uuid(), 0, 'company', $3, 'entity', 'company', $4, 'supports', 'human', '0.2', 'system',
                'test', 'system', gen_random_uuid(), $2::uuid
           FROM generate_series(1, 2)`,
        [t.tenantId, unknownSet, company, second],
      );
      vi.restoreAllMocks();
      const emitted = securityEvents();
      const found = await integrity().record(await authz(t, 'security.integrity.run'));
      expect(found.outcome).toBe('findings');
      expect(found.findings).toEqual(
        expect.arrayContaining([
          { check: 'declared_reference_drift', ref: 'sugar:ProductTemplates:int-1' },
          { check: 'source_reference_ambiguous', ref: 'hubspot:companies:8601' },
          { check: 'source_reference_change_mismatch', ref: ambiguous!.id },
          { check: 'evidence_relation_unknown', ref: unknownSet },
          { check: 'evidence_supersession_invalid', ref: badSupersession },
          { check: 'evidence_supersession_invalid', ref: unknownSet },
        ]),
      );
      // The view is a union of the stores: parity holds by construction.
      expect(found.findings.filter((f) => f.check === 'source_reference_index_parity')).toEqual([]);
      expect(emitted).toContainEqual(
        expect.objectContaining({ event: 'integrity_violation_detected', outcome: 'detected' }),
      );
      expect(JSON.stringify(emitted)).not.toMatch(/Integrity Name/);
      // Nothing repaired.
      expect(
        await c.sql(
          `SELECT entity_key FROM tenant_source_references WHERE tenant_id = $1 AND external_id = 'int-1'`,
          [t.tenantId],
        ),
      ).toEqual([{ entity_key: 'suite' }]);
      expect(
        await c.sql(`SELECT 1 FROM tenant_evidence_links WHERE tenant_id = $1`, [t.tenantId]),
      ).toHaveLength(4);
      // Another tenant is untouched and clean.
      expect((await integrity().verify(other)).outcome).toBe('passed');
    });

    it('evidence_relation_unknown finds an unknown relation in a late set behind more than 1,000 valid sets (review M1)', async () => {
      const t = await c.tenant('evintbig', 1001);
      const company = await companyOf(t, '8701');
      const second = await companyOf(t, '8702');
      const checker = new IntegrityVerificationService(
        db(),
        integrity().audit,
        c.app.get(SecurityEventsService, { strict: false }),
        c.app.get(PrivilegeManifestCheck, { strict: false }),
        TEST_RELATIONS,
      );
      // Plant (owner, test database): 1,100 valid sets, then one unknown
      // relation in the set that sorts last by link_set_id.
      await c.sql(
        `INSERT INTO tenant_evidence_links (tenant_id, link_set_id, ordinal, subject_kind, subject_id, evidence_type,
           evidence_kind, evidence_id, role, origin, canonical_version, actor_kind, actor_id, actor_assurance,
           correlation_id)
         SELECT $1, gen_random_uuid(), 0, 'company', $2, 'entity', 'company', $3, 'supports', 'human', '0.2', 'system',
                'test', 'system', gen_random_uuid()
           FROM generate_series(1, 1100)`,
        [t.tenantId, company, second],
      );
      const relationFindings = async () =>
        (await checker.verify(t)).findings.filter((f) => f.check === 'evidence_relation_unknown');
      expect(await relationFindings()).toEqual([]);
      const lateSet = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
      await c.sql(
        `INSERT INTO tenant_evidence_links (tenant_id, link_set_id, ordinal, subject_kind, subject_id, evidence_type,
           evidence_kind, evidence_id, role, origin, canonical_version, actor_kind, actor_id, actor_assurance,
           correlation_id)
         VALUES ($1, $2, 0, 'company', $3, 'entity', 'company', $4, 'contradicts', 'human', '0.2', 'system',
                 'test', 'system', gen_random_uuid())`,
        [t.tenantId, lateSet, company, second],
      );
      expect(await relationFindings()).toEqual([
        { check: 'evidence_relation_unknown', ref: lateSet },
      ]);
    });
  });
});
