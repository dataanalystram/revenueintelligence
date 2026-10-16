import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MappingDocument } from '../../src/modules/domain';
import { CanonicalAdoptionService, ModuleSettingsService } from '../../src/modules/governance';
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
import { authz } from '../support/security';

/**
 * M10F phase 2b-1 through a real source run (plan §6, §20 V4, V5, V13, V14,
 * V15, V16, Q14): the production Sugar adapter against the deterministic
 * fake, on real PostgreSQL with the app role and forced RLS. Three synthetic
 * TEST modules stand in for commercial objects (`Agreements` → contract,
 * `PriceBooks` → price offer, `Grants` → entitlement; synthetic `ag_*` /
 * `pb_*` / `gr_*` fields, no customer schema, no live system). Revenue line
 * items name their agreement header and price offer through synthetic
 * reference fields; `renewal_rli_id` (fixture lineage) is mapped as
 * `subscription.supersedesRef`.
 */
describe('M10F commercial mapping and sync (Sugar adapter, fake Sugar)', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const EXTRA = ['Agreements', 'PriceBooks', 'Grants'];
  const UTC = { type: 'datetime' as const, format: 'iso_datetime' as const, timeZone: 'UTC' };
  const AGREEMENT_CONFIRMATION = {
    semantics: 'agreement_header' as const,
    confirmedBy: 'test-operator',
    note: 'TEST ONLY: the synthetic agreement field names the agreement header',
  };

  const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
    name,
    type,
    label: 'Synthetic',
    ...extra,
  });
  const at = (day: string) => `${day}T00:00:00+00:00`;
  const agreement = (
    id: string,
    account: string,
    status: string,
    start: string,
    end: string,
    renews: string | null = null,
  ) => ({
    id,
    name: `Synthetic agreement ${id}`,
    account_id: account,
    ag_status: status,
    ag_start: `${start}T00:00:00Z`,
    ag_end: `${end}T00:00:00Z`,
    ag_renews: renews,
    date_modified: at('2025-10-01'),
    deleted: false,
  });

  /** The fake with the synthetic commercial modules and line references. */
  async function commercialFake(): Promise<FakeSugar> {
    const fake = await new FakeSugar().start();
    const fields = fake.fields as Record<string, { fields: Record<string, unknown> }>;
    fields.Agreements = {
      fields: {
        id: field('id', 'id'),
        name: field('name', 'name'),
        account_id: field('account_id', 'id', { module: 'Accounts' }),
        ag_status: field('ag_status', 'varchar'),
        ag_start: field('ag_start', 'datetime'),
        ag_end: field('ag_end', 'datetime'),
        ag_renews: field('ag_renews', 'varchar'),
        date_modified: field('date_modified', 'datetime'),
        deleted: field('deleted', 'bool'),
      },
    };
    fields.PriceBooks = {
      fields: {
        id: field('id', 'id'),
        pb_product: field('pb_product', 'varchar'),
        pb_currency: field('pb_currency', 'varchar'),
        pb_status: field('pb_status', 'varchar'),
        date_modified: field('date_modified', 'datetime'),
        deleted: field('deleted', 'bool'),
      },
    };
    fields.Grants = {
      fields: {
        id: field('id', 'id'),
        account_id: field('account_id', 'id', { module: 'Accounts' }),
        gr_product: field('gr_product', 'varchar'),
        gr_qty: field('gr_qty', 'int'),
        gr_status: field('gr_status', 'varchar'),
        date_modified: field('date_modified', 'datetime'),
        deleted: field('deleted', 'bool'),
      },
    };
    fake.data.set('Agreements', [
      agreement('AG-001', 'FIX-ACC-001', 'Live', '2026-01-01', '2027-01-01'),
      agreement('AG-002', 'FIX-ACC-002', 'Live', '2026-01-01', '2027-01-01'),
      agreement('AG-030', 'FIX-ACC-004', 'Ended', '2024-01-01', '2025-01-01'),
      agreement('AG-031', 'FIX-ACC-004', 'Paused', '2025-01-01', '2026-01-01', 'AG-030'),
    ]);
    const offer = (id: string, product: string) => ({
      id,
      pb_product: product,
      pb_currency: 'eur',
      pb_status: 'on',
      date_modified: at('2025-10-01'),
      deleted: false,
    });
    fake.data.set('PriceBooks', [
      offer('PB-001', 'FIX-PROD-001'),
      offer('PB-030', 'FIX-PROD-030'),
      offer('PB-010', 'FIX-PROD-010'),
    ]);
    fake.data.set('Grants', [
      {
        id: 'GR-001',
        account_id: 'FIX-ACC-001',
        gr_product: 'FIX-PROD-001',
        gr_qty: '5',
        gr_status: 'on',
        date_modified: at('2025-10-01'),
        deleted: false,
      },
    ]);
    fake.addField('RevenueLineItems', 'ag_ref_src', 'varchar', null);
    fake.addField('RevenueLineItems', 'pb_ref_src', 'varchar', null);
    const setLine = (id: string, values: Record<string, string | null>) =>
      fake.upsert('RevenueLineItems', {
        ...fake.data.get('RevenueLineItems')!.find((r) => r.id === id)!,
        ...values,
      });
    setLine('FIX-RLI-001', { ag_ref_src: 'AG-001', pb_ref_src: 'PB-001' });
    setLine('FIX-RLI-010', { ag_ref_src: 'AG-002', pb_ref_src: 'PB-001' }); // other product
    setLine('FIX-RLI-011', { ag_ref_src: 'AG-LATE' }); // contract not synced yet
    setLine('FIX-RLI-012', { ag_ref_src: 'AG-001' }); // another account's contract
    setLine('FIX-RLI-030', { ag_ref_src: 'AG-030', pb_ref_src: 'PB-030' });
    setLine('FIX-RLI-031', { ag_ref_src: 'AG-031', pb_ref_src: 'PB-030' });
    return fake;
  }

  const contractObject = (over: Record<string, unknown> = {}) => ({
    source: 'Agreements',
    entity: 'contract',
    identity: { field: 'id' },
    relationships: [],
    fields: [],
    contract: {
      account: { field: 'account_id', object: 'Accounts' },
      status: { field: 'ag_status', valueMap: { Live: 'active', Ended: 'expired' } },
      startsAt: { field: 'ag_start', transforms: { parse: UTC } },
      endsAt: { field: 'ag_end', transforms: { parse: UTC } },
      renewsRef: { field: 'ag_renews' },
      ...over,
    },
  });
  const offerObject = {
    source: 'PriceBooks',
    entity: 'price_offer',
    identity: { field: 'id' },
    relationships: [],
    fields: [],
    priceOffer: {
      product: { field: 'pb_product' },
      currency: { field: 'pb_currency' },
      status: { field: 'pb_status', valueMap: { on: 'active', off: 'retired' } },
    },
  };
  const entitlementObject = {
    source: 'Grants',
    entity: 'entitlement',
    identity: { field: 'id' },
    relationships: [],
    fields: [],
    entitlement: {
      account: { field: 'account_id', object: 'Accounts' },
      product: { field: 'gr_product' },
      quantity: { field: 'gr_qty' },
      status: { field: 'gr_status', valueMap: { on: 'active', off: 'inactive' } },
    },
  };

  /** The TEST mapping plus the chosen commercial statements. */
  const commercialMapping = (
    options: {
      objects?: boolean;
      agreement?: Record<string, unknown> | false;
      offerRef?: boolean;
      supersedes?: boolean;
    } = {},
  ): MappingDocument =>
    sugarTestMapping((doc) => {
      const lines = doc.objects.find((o) => o.source === 'RevenueLineItems')!;
      const rels: unknown[] = [...lines.relationships];
      if (options.agreement !== false) {
        rels.push({
          target: 'subscription.agreement',
          field: 'ag_ref_src',
          object: 'Agreements',
          confirmation: AGREEMENT_CONFIRMATION,
          ...(options.agreement ?? {}),
        });
      }
      if (options.offerRef ?? true) {
        rels.push({
          target: 'subscription.priceOfferRef',
          field: 'pb_ref_src',
          object: 'PriceBooks',
        });
      }
      if (options.supersedes ?? true) {
        rels.push({
          target: 'subscription.supersedesRef',
          field: 'renewal_rli_id',
          object: 'RevenueLineItems',
        });
      }
      (lines as { relationships: unknown[] }).relationships = rels;
      if (options.objects ?? true) {
        (doc as { objects: unknown[] }).objects = [
          ...doc.objects,
          contractObject(),
          offerObject,
          entitlementObject,
        ];
      }
    });

  const stamped = async (f: SourcesFixture, doc: MappingDocument) => {
    const snapshot = await sourcesServices(c).snapshots.latest(f.ctx, f.connectionId);
    return withSnapshot(doc, snapshot!.hash);
  };
  const errorCodes = async (f: SourcesFixture, doc: MappingDocument) =>
    (
      await sourcesServices(c).mappings.validate(f.ctx, f.connectionId, await stamped(f, doc))
    ).errors.map((e) => e.code);
  const mappingVersion = async (t: TenantContext): Promise<number> =>
    (
      await c.sql<{ v: number }>(
        `SELECT max(version)::int AS v FROM tenant_source_mapping_versions WHERE tenant_id = $1`,
        [t.tenantId],
      )
    )[0]!.v;
  const publish = async (f: SourcesFixture, doc: MappingDocument) =>
    publishWithAcks(c, f, await stamped(f, doc), await mappingVersion(f.ctx));

  async function setModule(t: TenantContext, module: string, enabled: boolean): Promise<void> {
    const [row] = await c.sql<{ version: number }>(
      `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = $2`,
      [t.tenantId, module],
    );
    const input = { module, expectedVersion: row?.version ?? 0 };
    const actx = await authz(t, 'config.module.change');
    if (enabled) await c.app.get(ModuleSettingsService).enable(actx, input);
    else await c.app.get(ModuleSettingsService).disable(actx, input);
  }
  async function publishAuthority(
    f: SourcesFixture,
    facts: { price_offer?: boolean; contract?: boolean; entitlement?: boolean },
  ) {
    const s = sourcesServices(c);
    const current = await s.authority.show(f.ctx);
    const own = (on: boolean | undefined) => (on ? f.connectionId : null);
    return s.authority.publish(
      await authz(f.ctx, 'config.authority.publish'),
      {
        facts: {
          account_profile: null,
          person_profile: null,
          subscription_lines: f.connectionId,
          subscription_state: null,
          subscription_terms: f.connectionId,
          price_offer: own(facts.price_offer),
          contract: own(facts.contract),
          entitlement: own(facts.entitlement),
        },
      },
      { expectedBaseVersion: current!.version },
    );
  }

  const count = async (sql: string, params: unknown[]): Promise<number> =>
    (await c.sql<{ n: number }>(sql, params))[0]?.n ?? -1;
  const q = (quality: Record<string, unknown>, key: string) => Number(quality[key] ?? 0);
  type LineRow = {
    id: string;
    company_id: string;
    contract_id: string | null;
    price_offer_id: string | null;
    supersedes_line_id: string | null;
    agreement_ref_system: string | null;
    agreement_ref_object_type: string | null;
    agreement_ref_external_id: string | null;
    field_hash: string | null;
  };
  const lineOf = async (t: TenantContext, rli: string): Promise<LineRow> =>
    (
      await c.sql<LineRow>(
        `SELECT id::text, company_id::text, contract_id::text, price_offer_id::text,
                supersedes_line_id::text, agreement_ref_system, agreement_ref_object_type,
                agreement_ref_external_id, field_hash
           FROM tenant_subscriptions WHERE tenant_id = $1 AND source_record_id = $2`,
        [t.tenantId, rli],
      )
    )[0]!;
  const entityOf = async (t: TenantContext, kind: string, object: string, id: string) =>
    (
      await c.sql<{ entity_id: string }>(
        `SELECT entity_id::text FROM tenant_source_references
          WHERE tenant_id = $1 AND system = 'sugar' AND object_type = $2 AND external_id = $3
            AND entity_kind = $4`,
        [t.tenantId, object, id, kind],
      )
    )[0]?.entity_id;
  const contractRow = async (t: TenantContext, id: string) =>
    (
      await c.sql<{ status: string; renews_contract_id: string | null; company_id: string }>(
        `SELECT status, renews_contract_id::text, company_id::text FROM tenant_contracts
          WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, id],
      )
    )[0]!;
  const issues = (t: TenantContext, kind: string) =>
    c.sql<{ state: string; entity_kind: string; canonical_ids: string[] }>(
      `SELECT state, entity_kind, canonical_ids::text[] AS canonical_ids FROM tenant_identity_conflicts
        WHERE tenant_id = $1 AND kind = $2 ORDER BY created_at, conflict_key`,
      [t.tenantId, kind],
    );
  const commercialRows = async (t: TenantContext) => ({
    offers: await count(`SELECT count(*)::int AS n FROM tenant_price_offers WHERE tenant_id = $1`, [
      t.tenantId,
    ]),
    contracts: await count(`SELECT count(*)::int AS n FROM tenant_contracts WHERE tenant_id = $1`, [
      t.tenantId,
    ]),
    entitlements: await count(
      `SELECT count(*)::int AS n FROM tenant_entitlements WHERE tenant_id = $1`,
      [t.tenantId],
    ),
  });
  const m10fQuality = (quality: Record<string, unknown>) =>
    Object.keys(quality).filter((k) =>
      /^(price_offer|contract|entitlement|agreement_ref|line_contract|line_price_offer|line_supersedes|commercial_reference)/.test(
        k,
      ),
    );

  describe('V4: module disabled and no 0.6 target ⇒ no behavioural change', () => {
    it('a tenant at 0.6 with the module disabled syncs exactly like a tenant at 0.5: same lines (field_hash included), quality, change records and mapping hashes; nothing commercial is written', async () => {
      const fakeA = await new FakeSugar().start();
      const fakeB = await new FakeSugar().start();
      try {
        const a = await sugarTenant(c, fakeA, { prefix: 'cmv4old' });
        await c.app
          .get(CanonicalAdoptionService)
          .adopt(await authz(a.ctx, 'config.canonical.adopt'), {
            target: '0.5',
            expectedCurrent: '0.6',
          });
        const b = await sugarTenant(c, fakeB, { prefix: 'cmv4new' });
        const runA = await runSync(c, a, 'full');
        const runB = await runSync(c, b, 'full');
        expect(runA.status).toBe('completed');
        expect(runB.status).toBe('completed');
        expect(runB.quality).toEqual(runA.quality);
        expect(m10fQuality(runB.quality)).toEqual([]);
        const lines = (t: TenantContext) =>
          c.sql(
            `SELECT source_record_id, product_key, state, starts_at, ends_at, quantity, record_state,
                    field_hash, agreement_ref_system, contract_id, price_offer_id, supersedes_line_id
               FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY source_record_id, id`,
            [t.tenantId],
          );
        const linesA = await lines(a.ctx);
        expect(linesA.length).toBeGreaterThan(0);
        expect(await lines(b.ctx)).toEqual(linesA);
        const changes = (t: TenantContext) =>
          c.sql(
            `SELECT entity_kind, change_type, changed_fields, count(*)::int AS n FROM tenant_context_changes
              WHERE tenant_id = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3::text`,
            [t.tenantId],
          );
        expect(await changes(b.ctx)).toEqual(await changes(a.ctx));
        const versions = (t: TenantContext) =>
          c.sql<{ content_hash: string }>(
            `SELECT content_hash FROM tenant_source_mapping_versions WHERE tenant_id = $1 ORDER BY version`,
            [t.tenantId],
          );
        expect((await versions(b.ctx)).map((v) => v.content_hash)).toEqual(
          (await versions(a.ctx)).map((v) => v.content_hash),
        );
        expect(await commercialRows(b.ctx)).toEqual({ offers: 0, contracts: 0, entitlements: 0 });
      } finally {
        await fakeA.stop();
        await fakeB.stop();
      }
    });
  });

  describe('V5 / V13 / V14 / V15 / V16 / Q14: the commercial objects and line references', () => {
    let fake: FakeSugar;
    let f: SourcesFixture;
    const eligibilityOf = async () => {
      const eligibility = c.app.get(EligibilityService);
      const out: unknown[] = [];
      for (const [account, product] of [
        ['FIX-ACC-001', 'fix-prod-001'],
        ['FIX-ACC-002', 'fix-prod-010'],
        ['FIX-ACC-004', 'fix-prod-030'],
      ] as const) {
        const [ref] = await c.sql<{ company_id: string }>(
          `SELECT company_id::text FROM company_external_refs
            WHERE tenant_id = $1 AND system = 'sugar' AND object_type = 'Accounts' AND external_id = $2`,
          [f.ctx.tenantId, account],
        );
        const report = await eligibility.evaluate(f.ctx, ref!.company_id, product);
        const ws = await eligibility.whitespace(f.ctx, ref!.company_id);
        out.push({
          ownership: report.ownership,
          checks: report.checks.map((ch) => [ch.check, ch.outcome, ch.reason ?? null]),
          whitespace: Object.fromEntries(
            Object.entries(ws.categories).map(([k, v]) => [k, (v as unknown[]).length]),
          ),
        });
      }
      return out;
    };
    let eligibilityBefore: unknown[];

    beforeAll(async () => {
      fake = await commercialFake();
      f = await sugarTenant(c, fake, { prefix: 'cmsync', extraModules: EXTRA });
      const profiled = await runProfile(c, f, [...EXTRA, 'RevenueLineItems']);
      if (profiled.status !== 'completed') throw new Error(`profile ${profiled.status}`);
      const first = await runSync(c, f, 'full');
      if (first.status !== 'completed') throw new Error(`baseline run ${first.errorCode}`);
      eligibilityBefore = await eligibilityOf();
    });
    afterAll(async () => {
      await fake?.stop();
    });

    it('V5 / V13 / V16: publish refuses without the module, without the agreement confirmation, for a deal grouping and without the authority facts; subscription.agreement alone publishes with the module disabled', async () => {
      // Module disabled: every object and module reference refused; the agreement is Core (Q2).
      const disabled = await errorCodes(f, commercialMapping());
      expect(disabled.filter((x) => x === 'commercial_mappings_not_enabled')).toHaveLength(5);
      // V13: no confirmation / an ordinary confirmation is not the agreement-header control.
      expect(
        await errorCodes(
          f,
          commercialMapping({
            objects: false,
            offerRef: false,
            supersedes: false,
            agreement: { confirmation: undefined },
          }),
        ),
      ).toContain('unconfirmed_consequential_entry');
      expect(
        await errorCodes(
          f,
          commercialMapping({
            objects: false,
            offerRef: false,
            supersedes: false,
            agreement: { confirmation: { by: 'test-operator', note: 'ordinary confirmation' } },
          }),
        ),
      ).toContain('unconfirmed_consequential_entry');
      // V13: grouping lines by their opportunity is refused (Q4 guardrail).
      const grouping = await errorCodes(
        f,
        commercialMapping({
          objects: false,
          offerRef: false,
          supersedes: false,
          agreement: { field: 'opportunity_id', object: 'Opportunities' },
        }),
      );
      expect(grouping).toContain('agreement_ref_deal_grouping');
      const base = await mappingVersion(f.ctx);
      await expect(
        publishWithAcks(
          c,
          f,
          await stamped(
            f,
            commercialMapping({
              objects: false,
              offerRef: false,
              supersedes: false,
              agreement: { field: 'opportunity_id', object: 'Opportunities' },
            }),
          ),
          base,
        ),
      ).rejects.toMatchObject({ code: 'mapping_invalid' });

      // subscription.agreement alone (module disabled, 0.6): publishes; the run stores agreement_ref only.
      const before = await lineOf(f.ctx, 'FIX-RLI-001');
      await publish(f, commercialMapping({ objects: false, offerRef: false, supersedes: false }));
      const run = await runSync(c, f, 'full');
      expect(run.status).toBe('completed');
      expect(q(run.quality, 'agreement_ref_set')).toBeGreaterThanOrEqual(6);
      expect(q(run.quality, 'commercial_reference_skipped')).toBeGreaterThan(0);
      const after = await lineOf(f.ctx, 'FIX-RLI-001');
      expect(after).toMatchObject({
        agreement_ref_system: 'sugar',
        agreement_ref_object_type: 'Agreements',
        agreement_ref_external_id: 'AG-001',
        contract_id: null,
      });
      // V4: the agreement enters the line field_hash only because the target is mapped.
      expect(after.field_hash).not.toBe(before.field_hash);
      expect(after.id).toBe(before.id);
      expect(await commercialRows(f.ctx)).toEqual({ offers: 0, contracts: 0, entitlements: 0 });
      // V12: agreement_ref never creates a source reference or a contract.
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_source_references
            WHERE tenant_id = $1 AND object_type = 'Agreements'`,
          [f.ctx.tenantId],
        ),
      ).toBe(0);

      // V16: module enabled, no commercial authority: the objects are refused.
      await setModule(f.ctx, 'commercial', true);
      const unauthorized = await errorCodes(f, commercialMapping());
      expect(unauthorized).not.toContain('commercial_mappings_not_enabled');
      expect(unauthorized.filter((x) => x === 'authority_conflict')).toHaveLength(3);
      await publishAuthority(f, { price_offer: true, contract: true, entitlement: true });
      const authorized = await errorCodes(f, commercialMapping());
      expect(authorized).not.toContain('authority_conflict');
      expect(authorized).not.toContain('commercial_mappings_not_enabled');
      await publish(f, commercialMapping());
    });

    it('V14 / V6 / V8 / V11: a full run writes offers, contracts (renews link), entitlements and the line references; unresolved, mismatched and cross-account references leave conflicts', async () => {
      const run = await runSync(c, f, 'full');
      expect(run.status).toBe('completed');
      expect(q(run.quality, 'price_offer_created')).toBe(3);
      expect(q(run.quality, 'contract_created')).toBe(4);
      expect(q(run.quality, 'entitlement_created')).toBe(1);
      expect(q(run.quality, 'contract_status_unmapped')).toBe(1); // AG-031 'Paused' → unknown
      expect(await commercialRows(f.ctx)).toEqual({ offers: 3, contracts: 4, entitlements: 1 });

      const ag001 = (await entityOf(f.ctx, 'contract', 'Agreements', 'AG-001'))!;
      const ag030 = (await entityOf(f.ctx, 'contract', 'Agreements', 'AG-030'))!;
      const ag031 = (await entityOf(f.ctx, 'contract', 'Agreements', 'AG-031'))!;
      expect(await contractRow(f.ctx, ag031)).toMatchObject({
        status: 'unknown',
        renews_contract_id: ag030,
      });
      expect((await contractRow(f.ctx, ag030)).status).toBe('expired');
      const pb001 = await entityOf(f.ctx, 'price_offer', 'PriceBooks', 'PB-001');
      const pb030 = await entityOf(f.ctx, 'price_offer', 'PriceBooks', 'PB-030');

      // Resolved: contract and offer of the same account / product.
      expect(await lineOf(f.ctx, 'FIX-RLI-001')).toMatchObject({
        contract_id: ag001,
        price_offer_id: pb001,
      });
      const l030 = await lineOf(f.ctx, 'FIX-RLI-030');
      expect(l030).toMatchObject({ contract_id: ag030, price_offer_id: pb030 });
      // Lineage stated by the source (renewal_rli_id), same account.
      expect((await lineOf(f.ctx, 'FIX-RLI-031')).contract_id).toBe(ag031);
      // V11: another product's offer and another account's contract are refused with conflicts.
      expect((await lineOf(f.ctx, 'FIX-RLI-010')).price_offer_id).toBeNull();
      expect((await lineOf(f.ctx, 'FIX-RLI-012')).contract_id).toBeNull();
      expect(q(run.quality, 'line_price_offer_product_mismatch')).toBe(1);
      expect(q(run.quality, 'line_contract_company_mismatch')).toBe(1);
      expect((await issues(f.ctx, 'price_offer_product_mismatch')).map((i) => i.state)).toEqual([
        'open',
      ]);
      expect((await issues(f.ctx, 'contract_company_mismatch')).map((i) => i.state)).toEqual([
        'open',
      ]);
      // V14: the agreement of a contract not synced yet: NULL + open conflict, nothing created.
      expect((await lineOf(f.ctx, 'FIX-RLI-011')).contract_id).toBeNull();
      expect(q(run.quality, 'line_contract_unresolved')).toBe(1);
      const unresolved = await issues(f.ctx, 'contract_reference_unresolved');
      expect(
        unresolved.filter((i) => i.state === 'open' && i.entity_kind === 'subscription'),
      ).toHaveLength(1);
      expect(await entityOf(f.ctx, 'contract', 'Agreements', 'AG-LATE')).toBeUndefined();
      // Value history on contract_id / price_offer_id (V18), no commercial audit rows from the sync (M10E parity).
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_value_history
            WHERE tenant_id = $1 AND entity_kind = 'subscription' AND field IN ('contract_id', 'price_offer_id')`,
          [f.ctx.tenantId],
        ),
      ).toBeGreaterThanOrEqual(4);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_audit_events
            WHERE tenant_id = $1 AND action LIKE 'commercial.%'`,
          [f.ctx.tenantId],
        ),
      ).toBe(0);
      // A repeated run is idempotent for the commercial entities.
      const again = await runSync(c, f, 'full');
      expect(again.status).toBe('completed');
      expect(q(again.quality, 'contract_created') + q(again.quality, 'contract_updated')).toBe(0);
      expect(
        q(again.quality, 'price_offer_created') + q(again.quality, 'price_offer_updated'),
      ).toBe(0);
      // Every fixture line stating renewal_rli_id is assigned once (a predecessor read later
      // in the first run is assigned by the rerun); a third run assigns nothing.
      expect(
        q(again.quality, 'line_supersedes_assigned') + q(run.quality, 'line_supersedes_assigned'),
      ).toBeGreaterThanOrEqual(1);
      expect((await lineOf(f.ctx, 'FIX-RLI-031')).supersedes_line_id).toBe(l030.id);
      const third = await runSync(c, f, 'full');
      expect(third.status).toBe('completed');
      expect(q(third.quality, 'line_supersedes_assigned')).toBe(0);
      expect(q(third.quality, 'line_contract_assigned')).toBe(0);
      expect(q(third.quality, 'line_price_offer_assigned')).toBe(0);
    });

    it('V14: a late-arriving contract is resolved by the second pass of the same run, which creates nothing for lines it cannot resolve', async () => {
      fake.upsert(
        'Agreements',
        agreement('AG-LATE', 'FIX-ACC-002', 'Live', '2026-02-01', '2027-02-01'),
      );
      const run = await runSync(c, f, 'full');
      expect(run.status).toBe('completed');
      expect(q(run.quality, 'contract_created')).toBe(1);
      // The pass after the contracts (before the line read) assigned the waiting line.
      expect(q(run.quality, 'contract_resolution_assigned')).toBe(1);
      const late = (await entityOf(f.ctx, 'contract', 'Agreements', 'AG-LATE'))!;
      expect((await lineOf(f.ctx, 'FIX-RLI-011')).contract_id).toBe(late);
      expect(
        (await issues(f.ctx, 'contract_reference_unresolved')).filter(
          (i) => i.state === 'open' && i.entity_kind === 'subscription',
        ),
      ).toHaveLength(0);
      // FIX-RLI-012 (another account's contract) is not waiting: it keeps no contract.
      expect((await lineOf(f.ctx, 'FIX-RLI-012')).contract_id).toBeNull();
    });

    it('Q14: the same account and term from another source system is recorded as contract_duplicate_source (nothing merged)', async () => {
      const ag001 = (await entityOf(f.ctx, 'contract', 'Agreements', 'AG-001'))!;
      // A contract of the same account and term known only through another system (operator SQL as owner).
      const [other] = await c.sql<{ id: string }>(
        `INSERT INTO tenant_contracts (tenant_id, id, company_id, starts_at, ends_at, status)
         SELECT tenant_id, gen_random_uuid(), company_id, starts_at, ends_at, 'active'
           FROM tenant_contracts WHERE tenant_id = $1 AND id = $2 RETURNING id::text`,
        [f.ctx.tenantId, ag001],
      );
      await c.sql(
        `INSERT INTO tenant_source_references (tenant_id, system, object_type, external_id, entity_kind, entity_id, origin)
         VALUES ($1, 'chargebee', 'Subscriptions', 'SYN-DUP-1', 'contract', $2, 'observed')`,
        [f.ctx.tenantId, other!.id],
      );
      fake.upsert('Agreements', {
        ...agreement('AG-001', 'FIX-ACC-001', 'Live', '2026-01-01', '2027-01-01'),
        name: 'Synthetic agreement AG-001 (touched)',
        date_modified: at('2025-10-02'),
      });
      const run = await runSync(c, f, 'full');
      expect(run.status).toBe('completed');
      expect(q(run.quality, 'contract_duplicate_source')).toBe(1);
      const dup = await issues(f.ctx, 'contract_duplicate_source');
      expect(dup).toHaveLength(1);
      expect(dup[0]!.state).toBe('open');
      expect([...dup[0]!.canonical_ids].sort()).toEqual([ag001, other!.id].sort());
      expect(await commercialRows(f.ctx)).toMatchObject({ contracts: 6 });
    });

    it('V16 / V15 / V27: without a fact the run writes none of its entities; offers and entitlements never change eligibility; module disabled after use keeps the line references', async () => {
      const ag002 = (await entityOf(f.ctx, 'contract', 'Agreements', 'AG-002'))!;
      fake.upsert('Agreements', {
        ...agreement('AG-002', 'FIX-ACC-002', 'Ended', '2026-01-01', '2027-01-01'),
        date_modified: at('2025-10-03'),
      });
      fake.upsert('Grants', {
        id: 'GR-002',
        account_id: 'FIX-ACC-002',
        gr_product: 'FIX-PROD-010',
        gr_qty: '1',
        gr_status: 'on',
        date_modified: at('2025-10-03'),
        deleted: false,
      });
      await publishAuthority(f, { price_offer: true, contract: false, entitlement: false });
      const before = await commercialRows(f.ctx);
      const run = await runSync(c, f, 'full');
      expect(run.status).toBe('completed');
      expect(q(run.quality, 'contract_not_authoritative')).toBe(1);
      expect(q(run.quality, 'entitlement_not_authoritative')).toBe(1);
      expect(run.quality).not.toHaveProperty('contract_updated');
      expect(await commercialRows(f.ctx)).toEqual(before);
      expect((await contractRow(f.ctx, ag002)).status).toBe('active');
      // V15: the commercial entities never move ownership or eligibility.
      expect(await eligibilityOf()).toEqual(eligibilityBefore);

      // V27: module disabled after use — writes refused (counted), line references kept.
      await publishAuthority(f, { price_offer: true, contract: true, entitlement: true });
      const kept = await lineOf(f.ctx, 'FIX-RLI-001');
      await setModule(f.ctx, 'commercial', false);
      const off = await runSync(c, f, 'full');
      expect(off.status).toBe('completed');
      expect(q(off.quality, 'contract_module_disabled')).toBe(5);
      expect(q(off.quality, 'price_offer_module_disabled')).toBe(3);
      expect(q(off.quality, 'commercial_reference_skipped')).toBeGreaterThan(0);
      expect(await lineOf(f.ctx, 'FIX-RLI-001')).toEqual(kept);
      expect((await contractRow(f.ctx, ag002)).status).toBe('active');
      expect(await eligibilityOf()).toEqual(eligibilityBefore);
    });
  });
});
