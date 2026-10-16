import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommercialLineReferenceStep,
  ContractWriter,
  EntitlementWriter,
  PriceOfferWriter,
  type CommercialProvenance,
} from '../../src/modules/commercial';
import { ModuleSettingsService } from '../../src/modules/governance';
import { TenantDatabase, type TenantContext } from '../../src/modules/tenancy';
import { auditOf, companies, hs, ingestMeta } from '../support/account-structure';
import { insertLine, seedProducts } from '../support/account-context';
import { startContextHarness, type ContextHarness } from '../support/context';
import { authz } from '../support/security';

const REASON = 'test_correction';
const SUB = (id: string) => ({ system: 'chargebee', objectType: 'Subscriptions', id });
const PRICE = (id: string) => ({ system: 'chargebee', objectType: 'ItemPrices', id });

/**
 * M10F commercial writers on real PostgreSQL as the app role (forced RLS),
 * through the harness app (plan §5, §6.3, §8; V5–V11, V14, V17, V18, V19,
 * V32, V34): the module gate (Core `agreement_ref` without the module, Q2),
 * price offers (validation, retirement refusing new line assignments),
 * contracts (status never cascades, value-free history of the renewal date),
 * links (union-cycle and cross-account refusals with conflict rows, operator
 * refusals by code), line references (E3 §4.2 renewal moving `contract_id`
 * with history, unresolved → conflict then resolved, same-product, lineage),
 * the human hold until release (Q17), the company merge re-pointing contracts
 * and entitlements, and two-session races resolving to named codes without
 * deadlock. Synthetic values only.
 */
describe('M10F commercial writers', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const offers = () => c.app.get(PriceOfferWriter, { strict: false });
  const contracts = () => c.app.get(ContractWriter, { strict: false });
  const entitlements = () => c.app.get(EntitlementWriter, { strict: false });
  const step = () => c.app.get(CommercialLineReferenceStep, { strict: false });
  const db = () => c.app.get(TenantDatabase);
  const human = (t: TenantContext) => authz(t, 'canonical.human_entry');
  const sync = (t: TenantContext) => authz(t, 'canonical.source_sync');
  const prov = (id: string): CommercialProvenance => ({
    source: { system: 'chargebee', objectType: 'Subscriptions', id },
    cause: 'backfill',
    adapter: 'chargebee',
    adapterVersion: '1',
    correlationId: randomUUID(),
  });

  async function setCommercial(t: TenantContext, enabled: boolean): Promise<void> {
    const [row] = await c.sql<{ version: number }>(
      `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = $2`,
      [t.tenantId, 'commercial'],
    );
    const svc = c.app.get(ModuleSettingsService);
    const actx = await authz(t, 'config.module.change');
    const input = { module: 'commercial' as const, expectedVersion: row?.version ?? 0 };
    if (enabled) await svc.enable(actx, input);
    else await svc.disable(actx, input);
  }

  let portal = 3100;
  async function tenant(prefix: string, enable = true): Promise<TenantContext> {
    const t = await c.tenant(prefix, (portal += 1));
    await seedProducts(c, t);
    if (enable) await setCommercial(t, true);
    return t;
  }

  const observeContract = async (
    t: TenantContext,
    companyId: string,
    id: string,
    over: Partial<Parameters<ContractWriter['observeSource']>[1]> = {},
  ) =>
    contracts().observeSource(await sync(t), {
      companyId,
      ref: SUB(id),
      presence: 'present',
      status: 'active',
      observedAt: new Date(),
      provenance: prov(id),
      ...over,
    });
  const observeOffer = async (
    t: TenantContext,
    id: string,
    productKey = 'core',
    status = 'active',
  ) =>
    offers().observeSource(await sync(t), {
      ref: PRICE(id),
      presence: 'present',
      productKey,
      currency: 'EUR',
      billingPeriod: 1,
      billingPeriodUnit: 'month',
      status,
      observedAt: new Date(),
      provenance: prov(id),
    });
  const lineRefs = async (
    t: TenantContext,
    lineId: string,
    input: { agreement?: string | null; offer?: string | null; supersedes?: string | null },
  ) => {
    const actx = await sync(t);
    return db().transaction(t, (tx) =>
      step().applyFromSource(actx, tx, {
        lineId,
        ...(input.agreement !== undefined
          ? {
              agreementRef:
                input.agreement === null
                  ? null
                  : {
                      system: 'chargebee',
                      objectType: 'Subscriptions',
                      externalId: input.agreement,
                    },
            }
          : {}),
        ...(input.offer !== undefined
          ? { priceOfferRef: input.offer === null ? null : PRICE(input.offer) }
          : {}),
        ...(input.supersedes !== undefined
          ? {
              supersedesRef:
                input.supersedes === null
                  ? null
                  : { system: 'hubspot', objectType: 'line_items', id: `line-${input.supersedes}` },
            }
          : {}),
        provenance: prov(`line-${lineId}`),
        observedAt: new Date(),
      }),
    );
  };
  const lineRow = async (id: string) =>
    (
      await c.sql<{
        contract_id: string | null;
        price_offer_id: string | null;
        supersedes_line_id: string | null;
        agreement_ref_external_id: string | null;
        company_id: string;
      }>(
        `SELECT contract_id::text, price_offer_id::text, supersedes_line_id::text, agreement_ref_external_id,
                company_id::text FROM tenant_subscriptions WHERE id = $1`,
        [id],
      )
    )[0]!;
  const conflicts = (t: TenantContext, kind: string) =>
    c.sql<{ kind: string; entity_kind: string; state: string; canonical_ids: string[] }>(
      `SELECT kind, entity_kind, state, canonical_ids FROM tenant_identity_conflicts
        WHERE tenant_id = $1 AND kind = $2 ORDER BY created_at`,
      [t.tenantId, kind],
    );
  const history = (t: TenantContext, entityId: string, field: string) =>
    c.sql<{ values_recorded: boolean; old_value: unknown; new_value: unknown }>(
      `SELECT values_recorded, old_value, new_value FROM tenant_value_history
        WHERE tenant_id = $1 AND entity_id = $2 AND field = $3 ORDER BY effective_at, id`,
      [t.tenantId, entityId, field],
    );

  it('V5: module disabled → source writes return module_disabled and operator writes are refused and audited; Core agreement_ref is written without the module (Q2)', async () => {
    const t = await tenant('cmgate', false);
    const account = (await companies(c, t, ['9001']))['9001']!;
    const outcome = await observeContract(t, account, 'sub_gate');
    expect(outcome).toEqual({ status: 'module_disabled' });
    await expect(
      offers().write(await human(t), { product: 'core', currency: 'EUR', reason: REASON }),
    ).rejects.toThrow(/module/i);
    const denied = await auditOf(c, t, 'operation.denied');
    expect(denied.at(-1)).toMatchObject({ outcome: 'denied', reason_code: 'module_disabled' });
    const line = await insertLine(c, t, account);
    const refs = await lineRefs(t, line, { agreement: 'sub_gate', offer: 'p1' });
    expect(refs).toMatchObject({
      status: 'applied',
      agreement: 'set',
      contract: 'skipped',
      priceOffer: 'skipped',
    });
    expect(await lineRow(line)).toMatchObject({
      agreement_ref_external_id: 'sub_gate',
      contract_id: null,
    });
    // agreement_ref never creates a contract or a source reference (V12).
    expect(
      await c.sql(`SELECT 1 FROM tenant_contracts WHERE tenant_id = $1`, [t.tenantId]),
    ).toHaveLength(0);
    expect(
      await c.sql(
        `SELECT 1 FROM tenant_source_references WHERE tenant_id = $1 AND entity_kind = 'contract'`,
        [t.tenantId],
      ),
    ).toHaveLength(0);
  });

  it('V6: price offers — operator create and validation, source create; a retired offer refuses new line assignments (operator and source)', async () => {
    const t = await tenant('cmoffer');
    const account = (await companies(c, t, ['9101']))['9101']!;
    await expect(
      offers().write(await human(t), { product: 'core', currency: 'eur', reason: REASON }),
    ).rejects.toThrow(/currency_invalid/);
    await expect(
      offers().write(await human(t), { product: 'legacy', currency: 'EUR', reason: REASON }),
    ).rejects.toThrow(/active/);
    const op = await offers().write(await human(t), {
      product: 'core',
      currency: 'EUR',
      listAmountMinor: 1999,
      reason: REASON,
    });
    expect(op).toMatchObject({ created: true });
    // List amount history is value-free (Q18).
    expect(await history(t, op.priceOfferId, 'list_amount_minor')).toEqual([
      { values_recorded: false, old_value: null, new_value: null },
    ]);
    const src = await observeOffer(t, 'price-1');
    expect(src.status).toBe('created');
    expect((await observeOffer(t, 'price-1')).status).toBe('unchanged');
    await offers().retire(await human(t), { priceOffer: op.priceOfferId, reason: REASON });
    const line = await insertLine(c, t, account);
    await expect(
      step().assignPriceOffer(await human(t), {
        line,
        target: op.priceOfferId,
        reason: REASON,
      }),
    ).rejects.toThrow(/price_offer_retired/);
    await observeOffer(t, 'price-1', 'core', 'retired');
    expect((await lineRefs(t, line, { offer: 'price-1' })).priceOffer).toBe('offer_retired');
    // Audit details carry no amount.
    const writes = await auditOf(c, t, 'commercial.price_offer.write');
    expect(JSON.stringify(writes)).not.toMatch(/1999/);
  });

  it('V11 / Q10: a line is assigned only an offer of its own product (mismatch recorded)', async () => {
    const t = await tenant('cmprod');
    const account = (await companies(c, t, ['9201']))['9201']!;
    await observeOffer(t, 'price-a', 'analytics');
    const line = await insertLine(c, t, account, 'core');
    expect((await lineRefs(t, line, { offer: 'price-a' })).priceOffer).toBe('product_mismatch');
    expect(await conflicts(t, 'price_offer_product_mismatch')).toHaveLength(1);
    await observeOffer(t, 'price-c', 'core');
    expect((await lineRefs(t, line, { offer: 'price-c' })).priceOffer).toBe('assigned');
    expect((await lineRow(line)).price_offer_id).not.toBeNull();
  });

  it('V7 / V8 / V14 / V18: contracts and the E3 §4.2 renewal — unresolved then resolved, contract_id moves with history, status never cascades, renewal date value-free', async () => {
    const t = await tenant('cmrenew');
    const account = (await companies(c, t, ['9301']))['9301']!;
    const line = await insertLine(c, t, account);
    // The contract is not synced yet: contract_id stays NULL, conflict opened.
    expect((await lineRefs(t, line, { agreement: 'sub_1' })).contract).toBe('unresolved');
    expect(await conflicts(t, 'contract_reference_unresolved')).toMatchObject([{ state: 'open' }]);
    const k1 = await observeContract(t, account, 'sub_1', { renewalDate: '2027-12-01' });
    expect(k1.status).toBe('created');
    // The re-resolution resolves it (phase 2b runs this pass after the contract sync).
    expect((await lineRefs(t, line, { agreement: 'sub_1' })).contract).toBe('assigned');
    expect((await lineRow(line)).contract_id).toBe(k1.contractId);
    expect(await conflicts(t, 'contract_reference_unresolved')).toMatchObject([
      { state: 'resolved' },
    ]);
    // Renewal: a new header that renews the first; the same line moves.
    const k2 = await observeContract(t, account, 'sub_2', { links: { renews: SUB('sub_1') } });
    expect(k2.status).toBe('created');
    expect((await lineRefs(t, line, { agreement: 'sub_2' })).contract).toBe('assigned');
    expect((await lineRow(line)).contract_id).toBe(k2.contractId);
    const moved = await history(t, line, 'contract_id');
    expect(moved.map((h) => [h.old_value, h.new_value])).toEqual([
      [null, k1.contractId],
      [k1.contractId, k2.contractId],
    ]);
    const [k2row] = await c.sql<{ renews: string }>(
      `SELECT renews_contract_id::text AS renews FROM tenant_contracts WHERE id = $1`,
      [k2.contractId],
    );
    expect(k2row!.renews).toBe(k1.contractId);
    // Terminating the first contract never touches the lines (no cascade).
    await observeContract(t, account, 'sub_1', { status: 'terminated', renewalDate: '2028-01-01' });
    expect((await lineRow(line)).contract_id).toBe(k2.contractId);
    expect((await history(t, k1.contractId!, 'status')).map((h) => h.new_value)).toEqual([
      'active',
      'terminated',
    ]);
    expect(await history(t, k1.contractId!, 'renewal_date')).toEqual([
      { values_recorded: false, old_value: null, new_value: null },
      { values_recorded: false, old_value: null, new_value: null },
    ]);
  });

  it('V10 / Q7 / Q12: source links closing a union cycle or reaching another account are refused with conflict rows; the contract is written without them; operator refusals carry the code', async () => {
    const t = await tenant('cmlinks');
    const ids = await companies(c, t, ['9401', '9402']);
    const [a1, a2] = [ids['9401']!, ids['9402']!];
    const ka = await observeContract(t, a1, 'ka');
    const kb = await observeContract(t, a1, 'kb', { links: { renews: SUB('ka') } });
    const kc = await observeContract(t, a1, 'kc', { links: { amends: SUB('kb') } });
    // ka parent → kc closes ka ← kb ← kc across kinds.
    const cyc = await observeContract(t, a1, 'ka', { links: { parent: SUB('kc') } });
    expect(cyc).toMatchObject({ status: 'unchanged', linksRefused: 1 });
    expect(await conflicts(t, 'contract_link_cycle_refused')).toHaveLength(1);
    const other = await observeContract(t, a2, 'kother');
    const cross = await observeContract(t, a1, 'kc', { links: { parent: SUB('kother') } });
    expect(cross).toMatchObject({ linksRefused: 1 });
    expect(await conflicts(t, 'contract_link_cross_account')).toHaveLength(1);
    await expect(
      contracts().link(await human(t), {
        contract: ka.contractId!,
        kind: 'parent',
        target: kc.contractId!,
        reason: REASON,
      }),
    ).rejects.toThrow(/contract_link_cycle/);
    await expect(
      contracts().link(await human(t), {
        contract: ka.contractId!,
        kind: 'parent',
        target: other.contractId!,
        reason: REASON,
      }),
    ).rejects.toThrow(/contract_link_cross_account/);
    expect(kb.status).toBe('created');
    const link = await contracts().link(await human(t), {
      contract: kc.contractId!,
      kind: 'parent',
      target: ka.contractId!,
      reason: REASON,
    });
    // kc → ka is acyclic (ka links nowhere): accepted.
    expect(link.changed).toBe(true);
  });

  it('V17 / Q17: an operator value is held until release; the differing source value is recorded as a disagreement', async () => {
    const t = await tenant('cmhold');
    const account = (await companies(c, t, ['9501']))['9501']!;
    const k = await observeContract(t, account, 'sub_h');
    await contracts().write(await human(t), {
      contract: k.contractId!,
      status: 'terminated',
      reason: REASON,
    });
    const again = await observeContract(t, account, 'sub_h', { status: 'active' });
    expect(again).toMatchObject({ status: 'unchanged', humanOverride: 1 });
    expect(await conflicts(t, 'commercial_human_override_disagrees')).toMatchObject([
      { state: 'open', entity_kind: 'contract' },
    ]);
    const released = await contracts().release(await human(t), {
      contract: k.contractId!,
      reason: REASON,
    });
    expect(released.released).toBe(1);
    expect((await observeContract(t, account, 'sub_h', { status: 'active' })).status).toBe(
      'updated',
    );
    expect(await conflicts(t, 'commercial_human_override_disagrees')).toMatchObject([
      { state: 'resolved' },
    ]);
  });

  it('V32 / Q11: supersedes — same account, no cycle (source outcome codes, operator refusals)', async () => {
    const t = await tenant('cmlineage');
    const ids = await companies(c, t, ['9601', '9602']);
    const l1 = await insertLine(c, t, ids['9601']!);
    const l2 = await insertLine(c, t, ids['9601']!);
    const l3 = await insertLine(c, t, ids['9602']!);
    expect((await lineRefs(t, l2, { supersedes: l1 })).supersedes).toBe('assigned');
    expect((await lineRefs(t, l1, { supersedes: l2 })).supersedes).toBe('lineage_cycle');
    expect((await lineRefs(t, l1, { supersedes: l3 })).supersedes).toBe('lineage_cross_account');
    await expect(
      step().setSupersedes(await human(t), { line: l1, target: l2, reason: REASON }),
    ).rejects.toThrow(/line_lineage_cycle/);
  });

  it('V19: a company merge re-points contracts, entitlements and lines in one transaction; links stay valid', async () => {
    const t = await tenant('cmmerge');
    const ids = await companies(c, t, ['9701', '9702']);
    const [survivor, loser] = [ids['9701']!, ids['9702']!];
    const k1 = await observeContract(t, loser, 'm1');
    const k2 = await observeContract(t, loser, 'm2', { links: { renews: SUB('m1') } });
    const e = await entitlements().observeSource(await sync(t), {
      companyId: loser,
      ref: { system: 'chargebee', objectType: 'Entitlements', id: 'e1' },
      presence: 'present',
      productKey: 'core',
      quantity: 5,
      status: 'active',
      observedAt: new Date(),
      provenance: prov('e1'),
    });
    expect(e.status).toBe('created');
    const line = await insertLine(c, t, loser);
    expect((await lineRefs(t, line, { agreement: 'm2' })).contract).toBe('assigned');
    await c.ingestion.ingestMerge(
      await sync(t),
      { kind: 'company', survivor: hs('9701'), merged: [hs('9702')], observedAt: new Date() },
      ingestMeta(),
    );
    const rows = await c.sql<{ id: string; company_id: string; renews: string | null }>(
      `SELECT id::text, company_id::text, renews_contract_id::text AS renews FROM tenant_contracts
        WHERE tenant_id = $1 ORDER BY created_at`,
      [t.tenantId],
    );
    expect(rows).toEqual([
      { id: k1.contractId, company_id: survivor, renews: null },
      { id: k2.contractId, company_id: survivor, renews: k1.contractId },
    ]);
    const [ent] = await c.sql<{ company_id: string }>(
      `SELECT company_id::text FROM tenant_entitlements WHERE id = $1`,
      [e.entitlementId],
    );
    expect(ent!.company_id).toBe(survivor);
    expect(await lineRow(line)).toMatchObject({ company_id: survivor, contract_id: k2.contractId });
  });

  it('two-session races resolve to named codes without deadlock: crossing operator links (contract_link_cycle) and crossing predecessors (lineage_cycle)', async () => {
    const t = await tenant('cmrace');
    const account = (await companies(c, t, ['9801']))['9801']!;
    const a = await observeContract(t, account, 'ra');
    const b = await observeContract(t, account, 'rb');
    const results = await Promise.allSettled([
      contracts().link(await human(t), {
        contract: a.contractId!,
        kind: 'renews',
        target: b.contractId!,
        reason: REASON,
      }),
      contracts().link(await human(t), {
        contract: b.contractId!,
        kind: 'amends',
        target: a.contractId!,
        reason: REASON,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/contract_link_cycle/);
    expect(String(refused.reason)).not.toMatch(/deadlock/);

    const l1 = await insertLine(c, t, account);
    const l2 = await insertLine(c, t, account);
    const lineage = await Promise.all([
      lineRefs(t, l1, { supersedes: l2 }),
      lineRefs(t, l2, { supersedes: l1 }),
    ]);
    expect(lineage.map((o) => o.supersedes).sort()).toEqual(['assigned', 'lineage_cycle']);
  });

  it('V34: concurrent source syncs of the same header create one contract', async () => {
    const t = await tenant('cmdup');
    const account = (await companies(c, t, ['9901']))['9901']!;
    const out = await Promise.all([
      observeContract(t, account, 'dup'),
      observeContract(t, account, 'dup'),
    ]);
    expect(out.map((o) => o.status).sort()).toEqual(['created', 'unchanged']);
    expect(out[0].contractId).toBe(out[1].contractId);
    expect(
      await c.sql(`SELECT 1 FROM tenant_contracts WHERE tenant_id = $1`, [t.tenantId]),
    ).toHaveLength(1);
  });
});
