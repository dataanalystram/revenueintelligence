import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountContextReadModel } from '../../src/modules/context';
import type { MappingDocument } from '../../src/modules/domain';
import {
  CanonicalAdoptionService,
  IntegrityVerificationService,
  ModuleSettingsService,
  RegistryService,
} from '../../src/modules/governance';
import { EligibilityService } from '../../src/modules/products';
import type { TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeSugar } from '../support/fake-sugar';
import {
  publishWithAcks,
  runProfile,
  runSync,
  sourcesServices,
  sugarTenant,
  sugarTestMapping,
  withSnapshot,
  type SourcesFixture,
} from '../support/sources';
import { authz, grantConfidentialRead } from '../support/security';

const M10E_CHECKS = [
  'account_context_company_mismatch',
  'account_context_natural_key_drift',
  'account_context_type_mismatch',
  'account_context_dangling_merge',
  'account_context_member_role_unknown',
] as const;

/**
 * M10E through a real source run (plan §5, §14, §18 V4, V14–V16, V20, V28):
 * the production Sugar adapter against the deterministic fake, on real
 * PostgreSQL with the app role and forced RLS. The fake's Opportunities
 * module stands in for an object shaped like a Gainsight Relationship (an
 * account, a relationship type fixed per object, a product, a region, a
 * status, an owner reference and a renewal date) through synthetic TEST
 * fields only (`rel_*_src`; no Gainsight field, no customer schema, no live
 * system). Revenue line items name their context through a synthetic
 * reference field mapped as `subscription.contextRef`.
 */
describe('M10E account contexts through a source run (Sugar adapter, fake Sugar)', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const modules = () => c.app.get(ModuleSettingsService);
  const registry = () => c.app.get(RegistryService);

  /** The TEST context type: one product of the account in one region (synthetic). */
  const contextTypes = () => ({
    schema_version: 1,
    types: [
      {
        key: 'product_region',
        title: 'Product in a region',
        description: 'One product of the account in one region (synthetic test type)',
        dimensions: [
          {
            key: 'product',
            type: 'product_key',
            required: true,
            sensitivity: 'internal',
            categories: ['commercial'],
          },
          {
            key: 'region',
            type: 'code',
            required: true,
            codes: ['emea', 'amer', 'apac'],
            sensitivity: 'internal',
            categories: ['operational'],
          },
        ],
        member_roles: ['csm'],
      },
    ],
  });

  /** The Relationship-shaped object, mapped as `account_context`. */
  const relationshipObject = (over: Record<string, unknown> = {}) => ({
    source: 'Opportunities',
    entity: 'account_context',
    identity: { field: 'id' },
    relationships: [],
    fields: [],
    accountContext: {
      type: 'product_region',
      account: { field: 'account_id', object: 'Accounts' },
      name: { field: 'name' },
      status: {
        field: 'rel_status_src',
        valueMap: { Active: 'active', Paused: 'inactive' },
      },
      ownerRef: { field: 'rel_csm_src' },
      renewalDate: { field: 'rel_renewal_src' },
      dimensions: [
        { key: 'product', field: 'rel_product_src' },
        {
          key: 'region',
          field: 'rel_region_src',
          valueMap: { EMEA: 'emea', AMER: 'amer', APAC: 'apac' },
        },
      ],
      ...over,
    },
  });

  /** The TEST mapping plus the Relationship-shaped object and the lines' context reference. */
  const contextMapping = (
    object: Record<string, unknown> = relationshipObject(),
    contextRef = true,
  ): MappingDocument =>
    sugarTestMapping((doc) => {
      if (contextRef) {
        const lines = doc.objects.find((o) => o.source === 'RevenueLineItems')!;
        (lines as { relationships: unknown[] }).relationships = [
          ...lines.relationships,
          { target: 'subscription.contextRef', field: 'rel_ref_src', object: 'Opportunities' },
        ];
      }
      (doc as { objects: unknown[] }).objects = [...doc.objects, object];
    });

  const setRecord = (
    fake: FakeSugar,
    module: string,
    id: string,
    values: Record<string, string | null>,
  ) => fake.upsert(module, { ...fake.data.get(module)!.find((r) => r.id === id)!, ...values });

  /** The fake with the synthetic Relationship fields and line references. */
  async function contextFake(): Promise<FakeSugar> {
    const fake = await new FakeSugar().start();
    fake.addField('Opportunities', 'rel_product_src', 'varchar', 'fix-prod-001');
    fake.addField('Opportunities', 'rel_region_src', 'varchar', 'EMEA');
    fake.addField('Opportunities', 'rel_status_src', 'varchar', 'Active');
    fake.addField('Opportunities', 'rel_csm_src', 'varchar', 'FIX-USR-001');
    fake.addField('Opportunities', 'rel_renewal_src', 'varchar', '2026-06-30');
    // Same account, same product, two regions: two contexts (FIX-ACC-004, FIX-ACC-005).
    setRecord(fake, 'Opportunities', 'FIX-OPP-005', { rel_region_src: 'AMER' });
    setRecord(fake, 'Opportunities', 'FIX-OPP-007', { rel_region_src: 'AMER' });
    fake.addField('RevenueLineItems', 'rel_ref_src', 'varchar', null);
    setRecord(fake, 'RevenueLineItems', 'FIX-RLI-001', { rel_ref_src: 'FIX-OPP-001' });
    setRecord(fake, 'RevenueLineItems', 'FIX-RLI-030', { rel_ref_src: 'FIX-OPP-004' });
    setRecord(fake, 'RevenueLineItems', 'FIX-RLI-031', { rel_ref_src: 'FIX-OPP-005' });
    // A line of FIX-ACC-002 naming a context of FIX-ACC-001: refused, issue.
    setRecord(fake, 'RevenueLineItems', 'FIX-RLI-010', { rel_ref_src: 'FIX-OPP-001' });
    // A line naming a context that does not exist: unresolved, issue.
    setRecord(fake, 'RevenueLineItems', 'FIX-RLI-020', { rel_ref_src: 'FIX-OPP-999' });
    return fake;
  }

  async function enableContexts(t: TenantContext, enabled = true): Promise<void> {
    const [row] = await c.sql<{ version: number }>(
      `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'account_context'`,
      [t.tenantId],
    );
    const input = { module: 'account_context', expectedVersion: row?.version ?? 0 };
    const actx = await authz(t, 'config.module.change');
    if (enabled) await modules().enable(actx, input);
    else await modules().disable(actx, input);
  }
  async function publishContextTypes(t: TenantContext) {
    const document = contextTypes();
    const dry = await registry().dryRun(t, 'context_type', document);
    if (!dry.valid) throw new Error(`context types invalid: ${JSON.stringify(dry.issues)}`);
    return registry().publish(await authz(t, 'config.registry.publish'), 'context_type', {
      document,
      expectedBaseVersion: 0,
      expectedContentHash: dry.contentHash!,
    });
  }
  async function publishAuthority(f: SourcesFixture, accountContext: boolean) {
    const s = sourcesServices(c);
    const current = await s.authority.show(f.ctx);
    return s.authority.publish(
      await authz(f.ctx, 'config.authority.publish'),
      {
        facts: {
          account_profile: null,
          person_profile: null,
          subscription_lines: f.connectionId,
          subscription_state: null,
          subscription_terms: f.connectionId,
          account_context: accountContext ? f.connectionId : null,
        },
      },
      { expectedBaseVersion: current!.version },
    );
  }
  const mappingVersion = async (t: TenantContext): Promise<number> =>
    (
      await c.sql<{ v: number }>(
        `SELECT max(version)::int AS v FROM tenant_source_mapping_versions WHERE tenant_id = $1`,
        [t.tenantId],
      )
    )[0]!.v;
  const stamped = async (f: SourcesFixture, doc: MappingDocument) => {
    const snapshot = await sourcesServices(c).snapshots.latest(f.ctx, f.connectionId);
    return withSnapshot(doc, snapshot!.hash);
  };
  const errorCodes = async (f: SourcesFixture, doc: MappingDocument) =>
    (await sourcesServices(c).mappings.validate(f.ctx, f.connectionId, doc)).errors.map(
      (e) => e.code,
    );

  const companyOf = async (t: TenantContext, accountId: string) =>
    (
      await c.sql<{ company_id: string }>(
        `SELECT company_id::text FROM company_external_refs
          WHERE tenant_id = $1 AND system = 'sugar' AND object_type = 'Accounts' AND external_id = $2`,
        [t.tenantId, accountId],
      )
    )[0]!.company_id;
  type ContextRow = {
    id: string;
    company_id: string;
    name: string;
    status: string;
    owner_ref: string | null;
    renewal_date: string | null;
    dimensions: Record<string, unknown>;
    natural_key_hash: string;
    record_state: string;
  };
  const contextsOf = (t: TenantContext) =>
    c.sql<ContextRow>(
      `SELECT id::text, company_id::text, name, status, owner_ref, renewal_date::text, dimensions,
              natural_key_hash, record_state
         FROM tenant_account_contexts WHERE tenant_id = $1 ORDER BY created_at, id`,
      [t.tenantId],
    );
  /** The context a Sugar Opportunities id resolves to (generic source reference). */
  const contextOf = async (t: TenantContext, oppId: string): Promise<ContextRow | undefined> => {
    const [ref] = await c.sql<{ entity_id: string }>(
      `SELECT entity_id::text FROM tenant_source_references
        WHERE tenant_id = $1 AND system = 'sugar' AND object_type = 'Opportunities' AND external_id = $2
          AND entity_kind = 'account_context'`,
      [t.tenantId, oppId],
    );
    return (await contextsOf(t)).find((r) => r.id === ref?.entity_id);
  };
  const lineOf = async (t: TenantContext, rliId: string) =>
    (
      await c.sql<{ id: string; company_id: string; context_id: string | null }>(
        `SELECT id::text, company_id::text, context_id::text FROM tenant_subscriptions
          WHERE tenant_id = $1 AND source_record_id = $2`,
        [t.tenantId, rliId],
      )
    )[0]!;
  const issuesOf = (t: TenantContext, kind: string) =>
    c.sql<{ state: string; canonical_ids: string[]; external_refs: string[] }>(
      `SELECT state, canonical_ids::text[] AS canonical_ids, external_refs FROM tenant_identity_conflicts
        WHERE tenant_id = $1 AND kind = $2 ORDER BY created_at, conflict_key`,
      [t.tenantId, kind],
    );
  const count = async (sql: string, params: unknown[]): Promise<number> =>
    (await c.sql<{ n: number }>(sql, params))[0]?.n ?? -1;
  const m10eQuality = (quality: Record<string, unknown>) =>
    Object.keys(quality).filter(
      (k) => k.startsWith('account_context') || k.startsWith('context_assignment'),
    );

  describe('V4: module disabled ⇒ no behavioural change', () => {
    it('a tenant at 0.5 with the module disabled syncs exactly like a tenant at 0.4: same lines, quality, change records, mapping hash and eligibility; nothing M10E is written', async () => {
      const fakeA = await new FakeSugar().start();
      const fakeB = await new FakeSugar().start();
      try {
        // A: the pre-M10E world (adopted 0.4); B: 0.5 with module account_context disabled.
        const a = await sugarTenant(c, fakeA, { prefix: 'acv4old' });
        await c.app
          .get(CanonicalAdoptionService)
          .adopt(await authz(a.ctx, 'config.canonical.adopt'), {
            target: '0.4',
            expectedCurrent: '0.5',
          });
        const b = await sugarTenant(c, fakeB, { prefix: 'acv4new' });
        const runA = await runSync(c, a, 'full');
        const runB = await runSync(c, b, 'full');
        expect(runA.status).toBe('completed');
        expect(runB.status).toBe('completed');
        expect(runB.quality).toEqual(runA.quality);
        expect(m10eQuality(runB.quality)).toEqual([]);

        const lines = (t: TenantContext) =>
          c.sql(
            `SELECT source_record_id, product_key, state, starts_at, ends_at, quantity, record_state, context_id
               FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY source_record_id, id`,
            [t.tenantId],
          );
        const linesA = await lines(a.ctx);
        expect(linesA.length).toBeGreaterThan(0);
        expect(await lines(b.ctx)).toEqual(linesA);
        expect(linesA.every((l) => l.context_id === null)).toBe(true);

        const changes = (t: TenantContext) =>
          c.sql(
            `SELECT entity_kind, change_type, changed_fields, count(*)::int AS n FROM tenant_context_changes
              WHERE tenant_id = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3::text`,
            [t.tenantId],
          );
        expect(await changes(b.ctx)).toEqual(await changes(a.ctx));
        expect(
          (await changes(b.ctx)).filter(
            (r) =>
              String(r.entity_kind).startsWith('account_context') ||
              (r.changed_fields as string[]).includes('contextId'),
          ),
        ).toEqual([]);

        // The published mapping hashes are the same (the module adds nothing to them).
        const versions = (t: TenantContext) =>
          c.sql<{ version: number; content_hash: string }>(
            `SELECT version, content_hash FROM tenant_source_mapping_versions
              WHERE tenant_id = $1 ORDER BY version`,
            [t.tenantId],
          );
        expect((await versions(b.ctx)).map((v) => v.content_hash)).toEqual(
          (await versions(a.ctx)).map((v) => v.content_hash),
        );

        // Eligibility answers are the same (a gapped account and a covered one).
        const eligibility = c.app.get(EligibilityService);
        const answer = async (f: SourcesFixture, account: string, product: string) => {
          const company = await companyOf(f.ctx, account);
          const report = await eligibility.evaluate(f.ctx, company, product);
          const ws = await eligibility.whitespace(f.ctx, company);
          return {
            ownership: report.ownership,
            checks: report.checks.map((ch) => [ch.check, ch.outcome, ch.reason ?? null]),
            whitespace: Object.fromEntries(
              Object.entries(ws.categories).map(([k, v]) => [k, (v as unknown[]).length]),
            ),
          };
        };
        for (const [account, product] of [
          ['FIX-ACC-001', 'fix-prod-001'],
          ['FIX-ACC-001', 'fix-prod-140'],
          ['FIX-ACC-009', 'fix-prod-001'],
        ] as const) {
          expect(await answer(b, account, product)).toEqual(await answer(a, account, product));
        }

        // Nothing M10E exists for B.
        for (const table of [
          'tenant_account_contexts',
          'tenant_account_context_persons',
          'tenant_account_context_products',
        ]) {
          expect(
            await count(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [
              b.ctx.tenantId,
            ]),
          ).toBe(0);
        }
        expect(
          await count(
            `SELECT count(*)::int AS n FROM tenant_value_history WHERE tenant_id = $1
                AND (entity_kind = 'account_context' OR (entity_kind = 'subscription' AND field = 'context_id'))`,
            [b.ctx.tenantId],
          ),
        ).toBe(0);
        expect(
          await count(
            `SELECT count(*)::int AS n FROM tenant_identity_conflicts WHERE tenant_id = $1 AND kind LIKE 'account_context%'`,
            [b.ctx.tenantId],
          ),
        ).toBe(0);
        // A repeated run on B stays idempotent.
        const again = await runSync(c, b, 'full');
        expect(again.status).toBe('completed');
        expect(m10eQuality(again.quality)).toEqual([]);
      } finally {
        await fakeA.stop();
        await fakeB.stop();
      }
    });
  });

  describe('V14 / V15 / V16 / V20 / V28: a Relationship-shaped object and line references', () => {
    let fake: FakeSugar;
    let f: SourcesFixture;

    beforeAll(async () => {
      fake = await contextFake();
      f = await sugarTenant(c, fake, { prefix: 'acsync' });
      // M9A: a completed profile of the Opportunities module covers its mapped fields.
      const profiled = await runProfile(c, f, ['Opportunities']);
      if (profiled.status !== 'completed') throw new Error(`profile ${profiled.status}`);
    });
    afterAll(async () => {
      await fake?.stop();
    });

    it('V14 / V16: publish needs 0.5 + the module, published context types, dimensions and the account_context authority; then validates and publishes at canonical 0.5', async () => {
      const s = sourcesServices(c);
      const mapping = await stamped(f, contextMapping());
      const base = await mappingVersion(f.ctx);

      // Module disabled: refused (both the object and the line reference).
      const disabled = await errorCodes(f, mapping);
      expect(disabled).toContain('account_context_mappings_not_enabled');
      expect(
        disabled.filter((code) => code === 'account_context_mappings_not_enabled').length,
      ).toBe(2);
      await expect(publishWithAcks(c, f, mapping, base)).rejects.toMatchObject({
        code: 'mapping_invalid',
      });

      // Module enabled, no context type published yet.
      await enableContexts(f.ctx);
      const untyped = await errorCodes(f, mapping);
      expect(untyped).not.toContain('account_context_mappings_not_enabled');
      expect(untyped).toContain('context_type_unknown');
      await publishContextTypes(f.ctx);

      // V16: without the account_context authority the publish is refused.
      const unauthorized = await errorCodes(f, mapping);
      expect(unauthorized).not.toContain('context_type_unknown');
      expect(unauthorized).toContain('authority_conflict');
      await expect(publishWithAcks(c, f, mapping, base)).rejects.toMatchObject({
        code: 'mapping_invalid',
      });
      await publishAuthority(f, true);

      // Type, dimension and identity rules of the accountContext block.
      const variant = async (over: Record<string, unknown>) =>
        errorCodes(f, await stamped(f, contextMapping(relationshipObject(over))));
      expect(await variant({ type: 'unknown_type' })).toContain('context_type_unknown');
      expect(
        await variant({
          dimensions: [
            { key: 'product', field: 'rel_product_src' },
            { key: 'region', field: 'rel_region_src' },
            { key: 'ghost', field: 'rel_csm_src' },
          ],
        }),
      ).toContain('context_dimension_unknown');
      expect(
        await variant({ dimensions: [{ key: 'product', field: 'rel_product_src' }] }),
      ).toContain('context_dimension_required');
      expect(await variant({ ownerRef: { field: 'no_such_src' } })).toContain(
        'unknown_source_field',
      );
      expect(
        await errorCodes(
          f,
          await stamped(
            f,
            contextMapping({ ...relationshipObject(), identity: { field: 'name' } }),
          ),
        ),
      ).toContain('identity_unsuitable');

      // Valid now (only the profile findings to acknowledge remain): published at canonical 0.5.
      const report = await s.mappings.validate(f.ctx, f.connectionId, mapping);
      expect(
        report.errors.filter(
          (e) => !['finding_unacknowledged', 'profile_low_coverage'].includes(e.code),
        ),
      ).toEqual([]);
      const published = await publishWithAcks(c, f, mapping, base);
      expect(published.version).toBe(base + 1);
      expect(
        await c.sql(
          `SELECT canonical_version_min FROM tenant_source_mapping_versions WHERE tenant_id = $1 AND version = $2`,
          [f.ctx.tenantId, published.version],
        ),
      ).toEqual([{ canonical_version_min: '0.5' }]);
    });

    it('V14 / V15: a run creates one context per Relationship record (natural key), unresolved accounts and references become issues, line references are assigned or refused; re-run idempotent; changes update; absence never clears', async () => {
      const first = await runSync(c, f, 'full');
      expect(first.status).toBe('completed');
      const q = first.quality;
      const contexts = await contextsOf(f.ctx);
      expect(Number(q.account_context_created)).toBe(contexts.length);
      // 20 records: FIX-OPP-020 has no account, FIX-OPP-011's account does not exist.
      expect(contexts).toHaveLength(18);
      expect(Number(q.account_context_account_missing)).toBe(1);
      expect(Number(q.account_context_rejected_account_unknown)).toBe(1);

      const ctx1 = (await contextOf(f.ctx, 'FIX-OPP-001'))!;
      expect(ctx1).toMatchObject({
        company_id: await companyOf(f.ctx, 'FIX-ACC-001'),
        name: 'Fixture Opportunity 1',
        status: 'active',
        owner_ref: 'FIX-USR-001',
        renewal_date: '2026-06-30',
        dimensions: { product: 'fix-prod-001', region: 'emea' },
        record_state: 'active',
      });
      expect(ctx1.natural_key_hash).toMatch(/^[0-9a-f]{64}$/);
      // Same account and product, two regions: two contexts with distinct natural keys.
      const ctx4 = (await contextOf(f.ctx, 'FIX-OPP-004'))!;
      const ctx5 = (await contextOf(f.ctx, 'FIX-OPP-005'))!;
      expect(ctx4.company_id).toBe(ctx5.company_id);
      expect(ctx4.dimensions).toEqual({ product: 'fix-prod-001', region: 'emea' });
      expect(ctx5.dimensions).toEqual({ product: 'fix-prod-001', region: 'amer' });
      expect(ctx4.natural_key_hash).not.toBe(ctx5.natural_key_hash);
      // The product dimension makes a product membership; the entity index knows the contexts.
      expect(
        await c.sql(
          `SELECT product_key, origin FROM tenant_account_context_products WHERE tenant_id = $1 AND context_id = $2`,
          [f.ctx.tenantId, ctx1.id],
        ),
      ).toEqual([{ product_key: 'fix-prod-001', origin: 'dimension' }]);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_entity_index WHERE tenant_id = $1 AND kind = 'account_context'`,
          [f.ctx.tenantId],
        ),
      ).toBe(18);
      // The context's change record carries the run's provenance.
      const [change] = await c.sql<{
        change_type: string;
        source_system: string;
        source_record_id: string;
        checkpoint_id: string;
      }>(
        `SELECT change_type, source_system, source_record_id, checkpoint_id::text FROM tenant_context_changes
          WHERE tenant_id = $1 AND entity_kind = 'account_context' AND entity_id = $2 ORDER BY ingested_at LIMIT 1`,
        [f.ctx.tenantId, ctx1.id],
      );
      expect(change).toMatchObject({
        change_type: 'created',
        source_system: 'sugar',
        source_record_id: 'FIX-OPP-001',
        checkpoint_id: first.runId,
      });
      // The unknown account: an issue naming the source references only.
      const unresolvedAccount = (
        await issuesOf(f.ctx, 'account_context_reference_unresolved')
      ).filter((i) => i.external_refs.includes('sugar:Opportunities:FIX-OPP-011'));
      expect(unresolvedAccount).toEqual([
        {
          state: 'open',
          canonical_ids: [],
          external_refs: [
            'sugar:Accounts:FIX-ACC-DOES-NOT-EXIST',
            'sugar:Opportunities:FIX-OPP-011',
          ],
        },
      ]);

      // V15: line references.
      expect(Number(q.context_assignment_assigned)).toBe(3);
      expect(Number(q.context_assignment_company_mismatch)).toBe(1);
      expect(Number(q.context_assignment_unresolved)).toBe(1);
      expect((await lineOf(f.ctx, 'FIX-RLI-001')).context_id).toBe(ctx1.id);
      expect((await lineOf(f.ctx, 'FIX-RLI-030')).context_id).toBe(ctx4.id);
      expect((await lineOf(f.ctx, 'FIX-RLI-031')).context_id).toBe(ctx5.id);
      const mismatched = await lineOf(f.ctx, 'FIX-RLI-010');
      expect(mismatched.context_id).toBeNull();
      expect(await issuesOf(f.ctx, 'account_context_company_mismatch')).toEqual([
        {
          state: 'open',
          canonical_ids: [mismatched.id, ctx1.id].sort(),
          external_refs: ['sugar:Opportunities:FIX-OPP-001'],
        },
      ]);
      const dangling = await lineOf(f.ctx, 'FIX-RLI-020');
      expect(dangling.context_id).toBeNull();
      const unresolvedLine = (await issuesOf(f.ctx, 'account_context_reference_unresolved')).filter(
        (i) => i.canonical_ids.includes(dangling.id),
      );
      expect(unresolvedLine).toEqual([
        {
          state: 'open',
          canonical_ids: [dangling.id],
          external_refs: ['sugar:Opportunities:FIX-OPP-999'],
        },
      ]);
      // The assignment is a change record of the line and value history of subscription.context_id.
      const line1 = await lineOf(f.ctx, 'FIX-RLI-001');
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_context_changes
            WHERE tenant_id = $1 AND entity_kind = 'subscription' AND entity_id = $2 AND 'contextId' = ANY(changed_fields)`,
          [f.ctx.tenantId, line1.id],
        ),
      ).toBe(1);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_value_history
            WHERE tenant_id = $1 AND entity_kind = 'subscription' AND field = 'context_id'`,
          [f.ctx.tenantId],
        ),
      ).toBe(3);

      // A repeated run creates and assigns nothing new.
      const before = await contextsOf(f.ctx);
      const repeat = await runSync(c, f, 'full');
      expect(repeat.status).toBe('completed');
      expect(repeat.quality).not.toHaveProperty('account_context_created');
      expect(repeat.quality).not.toHaveProperty('account_context_updated');
      expect(repeat.quality).not.toHaveProperty('context_assignment_assigned');
      expect(Number(repeat.quality.account_context_unchanged)).toBe(18);
      expect(Number(repeat.quality.context_assignment_unchanged)).toBe(3);
      expect(await contextsOf(f.ctx)).toEqual(before);

      // Source changes: status and owner update; corrected references assign and resolve the issues;
      // an emptied reference keeps the line's context (absence never clears).
      setRecord(fake, 'Opportunities', 'FIX-OPP-001', {
        rel_status_src: 'Paused',
        rel_csm_src: 'FIX-USR-002',
      });
      setRecord(fake, 'RevenueLineItems', 'FIX-RLI-010', { rel_ref_src: 'FIX-OPP-002' });
      setRecord(fake, 'RevenueLineItems', 'FIX-RLI-020', { rel_ref_src: 'FIX-OPP-003' });
      setRecord(fake, 'RevenueLineItems', 'FIX-RLI-001', { rel_ref_src: null });
      const changed = await runSync(c, f, 'full');
      expect(changed.status).toBe('completed');
      expect(Number(changed.quality.account_context_updated)).toBe(1);
      expect(Number(changed.quality.context_assignment_assigned)).toBe(2);
      expect(await contextOf(f.ctx, 'FIX-OPP-001')).toMatchObject({
        id: ctx1.id,
        status: 'inactive',
        owner_ref: 'FIX-USR-002',
      });
      expect(
        await c.sql(
          `SELECT field FROM tenant_value_history
            WHERE tenant_id = $1 AND entity_kind = 'account_context' AND entity_id = $2 ORDER BY field`,
          [f.ctx.tenantId, ctx1.id],
        ),
      ).toEqual(expect.arrayContaining([{ field: 'owner_ref' }, { field: 'status' }]));
      expect((await lineOf(f.ctx, 'FIX-RLI-010')).context_id).toBe(
        (await contextOf(f.ctx, 'FIX-OPP-002'))!.id,
      );
      expect((await lineOf(f.ctx, 'FIX-RLI-020')).context_id).toBe(
        (await contextOf(f.ctx, 'FIX-OPP-003'))!.id,
      );
      expect((await lineOf(f.ctx, 'FIX-RLI-001')).context_id).toBe(ctx1.id);
      expect(
        (await issuesOf(f.ctx, 'account_context_company_mismatch')).map((i) => i.state),
      ).toEqual(['resolved']);
      expect(
        (await issuesOf(f.ctx, 'account_context_reference_unresolved'))
          .filter((i) => i.canonical_ids.includes(dangling.id))
          .map((i) => i.state),
      ).toEqual(['resolved']);
      expect(await contextsOf(f.ctx)).toHaveLength(18);
    });

    it('V20: the read model lists the contexts of a batch of accounts in one call, honours the optional scope, withholds the renewal date unless asked, and audits every read', async () => {
      const read = c.app.get(AccountContextReadModel);
      const acc1 = await companyOf(f.ctx, 'FIX-ACC-001');
      const acc4 = await companyOf(f.ctx, 'FIX-ACC-004');
      const acc5 = await companyOf(f.ctx, 'FIX-ACC-005');
      const ctx1 = (await contextOf(f.ctx, 'FIX-OPP-001'))!;
      const ctx4 = (await contextOf(f.ctx, 'FIX-OPP-004'))!;
      const ctx5 = (await contextOf(f.ctx, 'FIX-OPP-005'))!;
      const auditOf = () =>
        c.sql<{
          action: string;
          outcome: string;
          target_ref: string;
          details: Record<string, unknown>;
        }>(
          `SELECT action, outcome, target_ref, details FROM tenant_audit_events
            WHERE tenant_id = $1 AND action = 'account_context.read' ORDER BY seq`,
          [f.ctx.tenantId],
        );
      const auditBefore = (await auditOf()).length;

      // One call, three accounts: every context of each (FIX-ACC-005 has two as well).
      const list = await read.listForAccounts(await authz(f.ctx, 'data.account_context.read'), {
        companyIds: [acc1, acc4, acc5],
      });
      expect(list.truncated).toBe(false);
      expect(list.contexts.map((v) => v.companyId).sort()).toEqual(
        [acc1, acc4, acc4, acc5, acc5].sort(),
      );
      const view1 = list.contexts.find((v) => v.id === ctx1.id)!;
      expect(view1).toMatchObject({
        companyId: acc1,
        type: 'product_region',
        name: 'Fixture Opportunity 1',
        status: 'inactive',
        ownerRef: 'FIX-USR-002',
        renewalDate: null,
        recordState: 'active',
        dimensions: { product: 'fix-prod-001', region: 'emea' },
        persons: [],
        products: [{ productKey: 'fix-prod-001', origin: 'dimension' }],
        withheld: ['renewalDate'],
      });
      // The optional scope filter (the future authorization hook): only the named contexts.
      const scoped = await read.listForAccounts(await authz(f.ctx, 'data.account_context.read'), {
        companyIds: [acc1, acc4],
        scope: [ctx4.id],
      });
      expect(scoped.contexts.map((v) => v.id)).toEqual([ctx4.id]);
      const none = await read.listForAccounts(await authz(f.ctx, 'data.account_context.read'), {
        companyIds: [acc1],
        scope: [ctx5.id],
      });
      expect(none.contexts).toEqual([]);
      // Asked explicitly (and audited as such), the renewal date is shown — hardening #90:
      // only to an operator holding the explicit data.account_context.read_confidential grant.
      await grantConfidentialRead(f.ctx);
      const shown = await read.get(await authz(f.ctx, 'data.account_context.read'), {
        contextId: ctx1.id,
        includeConfidential: true,
      });
      expect(shown).toMatchObject({ renewalDate: '2026-06-30', withheld: [] });
      const lines = await read.linesForContext(await authz(f.ctx, 'data.account_context.read'), {
        contextId: ctx4.id,
      });
      expect(lines.lines.map((l) => l.id)).toEqual([(await lineOf(f.ctx, 'FIX-RLI-030')).id]);
      // Batch bound: more than 500 accounts is refused (audited failed).
      await expect(
        read.listForAccounts(await authz(f.ctx, 'data.account_context.read'), {
          companyIds: Array.from({ length: 501 }, () => randomUUID()),
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });

      // One audit event per call: identifiers and counts only, never values.
      const events = (await auditOf()).slice(auditBefore);
      expect(events.map((e) => [e.outcome, e.details.operation ?? null])).toEqual([
        ['allowed', 'list'],
        ['allowed', 'list'],
        ['allowed', 'list'],
        ['allowed', 'show'],
        ['allowed', 'lines'],
        ['failed', null],
      ]);
      expect(events[0]!.details).toMatchObject({
        accounts: 3,
        scoped: false,
        contexts: 5,
        truncated: false,
        includeConfidential: false,
      });
      expect(events[1]!.details).toMatchObject({ accounts: 2, scoped: true, contexts: 1 });
      expect(events[3]).toMatchObject({
        target_ref: ctx1.id,
        details: { includeConfidential: true },
      });
      const text = JSON.stringify(events);
      for (const value of ['Fixture Opportunity 1', 'FIX-USR-002', '2026-06-30', 'emea']) {
        expect(text).not.toContain(value);
      }
    });

    it('V16 / V4: without the account_context authority a run writes no context and assigns no line; with the module disabled the run skips contexts and assignments and writes the lines as before', async () => {
      const ctx2 = (await contextOf(f.ctx, 'FIX-OPP-002'))!;
      const snapshot = async () => ({
        contexts: await contextsOf(f.ctx),
        lines: await c.sql(
          `SELECT source_record_id, context_id::text FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY 1, 2`,
          [f.ctx.tenantId],
        ),
        changes: await count(
          `SELECT count(*)::int AS n FROM tenant_context_changes
            WHERE tenant_id = $1 AND (entity_kind = 'account_context' OR 'contextId' = ANY(changed_fields))`,
          [f.ctx.tenantId],
        ),
      });
      setRecord(fake, 'Opportunities', 'FIX-OPP-002', { name: 'Renamed in the source' });
      setRecord(fake, 'RevenueLineItems', 'FIX-RLI-011', { rel_ref_src: 'FIX-OPP-002' });

      // V16: the authority withdrawn.
      await publishAuthority(f, false);
      const before = await snapshot();
      const unauthorized = await runSync(c, f, 'full');
      expect(unauthorized.status).toBe('completed');
      expect(Number(unauthorized.quality.account_context_not_authoritative)).toBe(1);
      expect(Number(unauthorized.quality.context_assignment_not_authoritative)).toBeGreaterThan(0);
      expect(unauthorized.quality).not.toHaveProperty('account_context_updated');
      expect(unauthorized.quality).not.toHaveProperty('context_assignment_assigned');
      expect(await snapshot()).toEqual(before);
      expect((await contextOf(f.ctx, 'FIX-OPP-002'))!.name).toBe(ctx2.name);

      // V4: the authority back, the module disabled after use: data kept, nothing written.
      await publishAuthority(f, true);
      await enableContexts(f.ctx, false);
      const disabled = await runSync(c, f, 'full');
      expect(disabled.status).toBe('completed');
      expect(Number(disabled.quality.account_context_module_disabled)).toBeGreaterThan(0);
      expect(Number(disabled.quality.context_assignment_skipped)).toBeGreaterThan(0);
      expect(disabled.quality).not.toHaveProperty('account_context_updated');
      expect(disabled.quality).not.toHaveProperty('context_assignment_assigned');
      expect(await snapshot()).toEqual(before);

      // Enabled again: the pending source changes are written.
      await enableContexts(f.ctx, true);
      const resumed = await runSync(c, f, 'full');
      expect(resumed.status).toBe('completed');
      expect(Number(resumed.quality.account_context_updated)).toBe(1);
      expect(Number(resumed.quality.context_assignment_assigned)).toBe(1);
      expect((await contextOf(f.ctx, 'FIX-OPP-002'))!.name).toBe('Renamed in the source');
      expect((await lineOf(f.ctx, 'FIX-RLI-011')).context_id).toBe(ctx2.id);
    });

    it('V28: the five M10E integrity checks find seeded faults (identifiers only, nothing repaired)', async () => {
      const integrity = c.app.get(IntegrityVerificationService);
      const clean = await integrity.record(await authz(f.ctx, 'security.integrity.run'));
      for (const check of M10E_CHECKS) {
        expect(Object.keys(clean.checks)).toContain(check);
        expect(clean.findings.filter((x) => x.check === check)).toEqual([]);
      }
      const ctx = async (opp: string) => (await contextOf(f.ctx, opp))!.id;
      const [c2, c3, c6, c8, c9] = [
        await ctx('FIX-OPP-002'),
        await ctx('FIX-OPP-003'),
        await ctx('FIX-OPP-006'),
        await ctx('FIX-OPP-008'),
        await ctx('FIX-OPP-009'),
      ];
      const line1 = (await lineOf(f.ctx, 'FIX-RLI-001')).id;
      const ghostPerson = randomUUID();
      const ghostSurvivor = randomUUID();
      const t = f.ctx.tenantId;
      // Plant (owner, test database; replica mode bypasses the guard and constraint triggers).
      await c.sql(
        `SET session_replication_role = replica;
         UPDATE tenant_subscriptions SET context_id = '${c2}' WHERE tenant_id = '${t}' AND id = '${line1}';
         UPDATE tenant_account_contexts SET natural_key_hash = repeat('0', 64) WHERE tenant_id = '${t}' AND id = '${c3}';
         UPDATE tenant_account_contexts SET dimensions = dimensions || '{"ghost": "x"}'::jsonb WHERE tenant_id = '${t}' AND id = '${c6}';
         UPDATE tenant_account_contexts SET record_state = 'merged', merged_into_id = '${ghostSurvivor}' WHERE tenant_id = '${t}' AND id = '${c8}';
         INSERT INTO tenant_account_context_persons (tenant_id, context_id, person_id, role_code)
           VALUES ('${t}', '${c9}', '${ghostPerson}', 'ghost_role');
         SET session_replication_role = origin;`,
      );
      const found = await integrity.record(await authz(f.ctx, 'security.integrity.run'));
      expect(found.outcome).toBe('findings');
      const of = (check: string) => found.findings.filter((x) => x.check === check);
      expect(of('account_context_company_mismatch')).toEqual([
        { check: 'account_context_company_mismatch', ref: line1 },
      ]);
      expect(of('account_context_natural_key_drift')).toEqual([
        { check: 'account_context_natural_key_drift', ref: c3 },
      ]);
      expect(of('account_context_type_mismatch')).toEqual([
        { check: 'account_context_type_mismatch', ref: c6 },
      ]);
      expect(of('account_context_dangling_merge')).toEqual([
        { check: 'account_context_dangling_merge', ref: c8 },
      ]);
      expect(of('account_context_member_role_unknown')).toEqual([
        { check: 'account_context_member_role_unknown', ref: `${c9}/${ghostPerson}/ghost_role` },
      ]);
      // Identifiers only in the stored run.
      const [stored] = await c.sql<{ findings: unknown }>(
        `SELECT findings FROM tenant_integrity_runs WHERE tenant_id = $1 AND id = $2`,
        [t, found.runId],
      );
      expect(JSON.stringify(stored!.findings)).not.toContain('Fixture Opportunity');
      // Nothing repaired.
      expect((await lineOf(f.ctx, 'FIX-RLI-001')).context_id).toBe(c2);
      expect(
        await c.sql(
          `SELECT id::text, natural_key_hash, record_state, dimensions ? 'ghost' AS ghost
             FROM tenant_account_contexts WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
          [t, [c3, c6, c8]],
        ),
      ).toEqual(
        [
          { id: c3, natural_key_hash: '0'.repeat(64), record_state: 'active', ghost: false },
          {
            id: c6,
            natural_key_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            record_state: 'active',
            ghost: true,
          },
          {
            id: c8,
            natural_key_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            record_state: 'merged',
            ghost: false,
          },
        ].sort((x, y) => (x.id < y.id ? -1 : 1)),
      );
    });
  });
});
