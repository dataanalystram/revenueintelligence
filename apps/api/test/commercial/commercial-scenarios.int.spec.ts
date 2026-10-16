import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommercialLineReferenceStep,
  CommercialReadModel,
  ContractWriter,
  PriceOfferWriter,
  type CommercialProvenance,
} from '../../src/modules/commercial';
import { operatorActor } from '../../src/modules/domain';
import { IntegrityVerificationService, ModuleSettingsService } from '../../src/modules/governance';
import { TenantDatabase, type TenantContext } from '../../src/modules/tenancy';
import { companies } from '../support/account-structure';
import { insertLine, seedProducts } from '../support/account-context';
import { startContextHarness, type ContextHarness } from '../support/context';
import { authz } from '../support/security';

const REASON = 'test_correction';
const SUB = (id: string) => ({ system: 'chargebee', objectType: 'Subscriptions', id });
const COMMERCIAL_CHECKS = [
  'commercial_line_contract_company_mismatch',
  'commercial_line_price_offer_product_mismatch',
  'commercial_contract_link_cycle',
  'commercial_contract_link_cross_account',
  'commercial_line_lineage_cycle',
  'commercial_agreement_contract_drift',
] as const;

/**
 * M10F V9 — the E3 §4.2 commercial scenarios as one suite on real PostgreSQL
 * as the app role (forced RLS), through the harness app: renewal with new
 * lines (old lines stay on the old term, a new line supersedes its
 * predecessor, a new product joins the renewal), amendment in place (same
 * contract, new term and an added line, history kept, no `amends` link),
 * amendment as a new contract (`amends`), replacement of a line by another
 * product (`supersedes_line_id`, same contract, offers per product) and
 * co-terming (an add-on contract under its master via `parent`, end dates
 * aligned by data, never cascaded; re-parented to the master's renewal).
 * Each scenario ends with the six §15 commercial integrity checks at zero.
 * Synthetic values only.
 */
describe('M10F V9: E3 §4.2 commercial scenarios', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const offers = () => c.app.get(PriceOfferWriter, { strict: false });
  const contracts = () => c.app.get(ContractWriter, { strict: false });
  const step = () => c.app.get(CommercialLineReferenceStep, { strict: false });
  const reads = () => c.app.get(CommercialReadModel, { strict: false });
  const db = () => c.app.get(TenantDatabase);
  const human = (t: TenantContext) => authz(t, 'canonical.human_entry');
  const sync = (t: TenantContext) => authz(t, 'canonical.source_sync');
  const reader = (t: TenantContext) => authz(t, 'data.commercial.read', operatorActor('v9-reader'));
  const prov = (id: string): CommercialProvenance => ({
    source: { system: 'chargebee', objectType: 'Subscriptions', id },
    cause: 'backfill',
    adapter: 'chargebee',
    adapterVersion: '1',
    correlationId: randomUUID(),
  });

  async function setCommercial(t: TenantContext): Promise<void> {
    const [row] = await c.sql<{ version: number }>(
      `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = $2`,
      [t.tenantId, 'commercial'],
    );
    await c.app.get(ModuleSettingsService).enable(await authz(t, 'config.module.change'), {
      module: 'commercial',
      expectedVersion: row?.version ?? 0,
    });
  }

  let portal = 5100;
  async function account(prefix: string): Promise<{ t: TenantContext; account: string }> {
    const t = await c.tenant(prefix, (portal += 1));
    await seedProducts(c, t);
    await setCommercial(t);
    const key = `${portal}1`;
    return { t, account: (await companies(c, t, [key]))[key]! };
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
  /** The line sync's commercial step (agreement and / or predecessor as the source states them). */
  const lineRefs = async (
    t: TenantContext,
    lineId: string,
    input: { agreement?: string; supersedes?: string },
  ) => {
    const actx = await sync(t);
    return db().transaction(t, (tx) =>
      step().applyFromSource(actx, tx, {
        lineId,
        ...(input.agreement !== undefined
          ? {
              agreementRef: {
                system: 'chargebee',
                objectType: 'Subscriptions',
                externalId: input.agreement,
              },
            }
          : {}),
        ...(input.supersedes !== undefined
          ? {
              supersedesRef: {
                system: 'hubspot',
                objectType: 'line_items',
                id: `line-${input.supersedes}`,
              },
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
        product_key: string;
      }>(
        `SELECT contract_id::text, price_offer_id::text, supersedes_line_id::text, product_key
           FROM tenant_subscriptions WHERE id = $1`,
        [id],
      )
    )[0]!;
  const contractCount = async (t: TenantContext) =>
    Number(
      (
        await c.sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM tenant_contracts WHERE tenant_id = $1`,
          [t.tenantId],
        )
      )[0]!.n,
    );
  const history = (t: TenantContext, entityId: string, field: string) =>
    c.sql<{ old_value: unknown; new_value: unknown }>(
      `SELECT old_value, new_value FROM tenant_value_history
        WHERE tenant_id = $1 AND entity_id = $2 AND field = $3 ORDER BY effective_at, id`,
      [t.tenantId, entityId, field],
    );
  async function integrityClean(t: TenantContext): Promise<void> {
    const report = await c.app.get(IntegrityVerificationService).verify(t);
    for (const check of COMMERCIAL_CHECKS) {
      expect({ check, findings: report.checks[check] }).toEqual({ check, findings: 0 });
    }
  }

  it('renewal with new lines: the old line stays on the old term, the renewed line supersedes it on the renewal, a new product joins the renewal; renews link visible from both ends', async () => {
    const { t, account: a } = await account('v9renew');
    const k1 = await observeContract(t, a, 'r1', {
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-12-31T00:00:00.000Z',
    });
    const l1 = await insertLine(c, t, a, 'core');
    expect((await lineRefs(t, l1, { agreement: 'r1' })).contract).toBe('assigned');

    const k2 = await observeContract(t, a, 'r2', {
      startsAt: '2027-01-01T00:00:00.000Z',
      endsAt: '2027-12-31T00:00:00.000Z',
      links: { renews: SUB('r1') },
    });
    expect(k2).toMatchObject({ status: 'created' });
    expect(k2.linksRefused ?? 0).toBe(0);
    // The renewed seat line: a new line on the renewal superseding the old one.
    const l2 = await insertLine(c, t, a, 'core');
    expect(await lineRefs(t, l2, { agreement: 'r2', supersedes: l1 })).toMatchObject({
      contract: 'assigned',
      supersedes: 'assigned',
    });
    // A product added at renewal: a new line with no predecessor.
    const l3 = await insertLine(c, t, a, 'analytics');
    expect((await lineRefs(t, l3, { agreement: 'r2' })).contract).toBe('assigned');

    expect(await lineRow(l1)).toMatchObject({
      contract_id: k1.contractId,
      supersedes_line_id: null,
    });
    expect(await lineRow(l2)).toMatchObject({
      contract_id: k2.contractId,
      supersedes_line_id: l1,
    });
    expect(await lineRow(l3)).toMatchObject({
      contract_id: k2.contractId,
      supersedes_line_id: null,
    });
    // The old contract keeps its lines and its own status (nothing cascades).
    const old = await reads().contract(await reader(t), { contractId: k1.contractId! });
    expect(old.status).toBe('active');
    expect(old.lineIds).toEqual([l1]);
    expect(old.linkedFrom).toEqual([{ contractId: k2.contractId, kind: 'renews' }]);
    const renewal = await reads().contract(await reader(t), { contractId: k2.contractId! });
    expect(renewal.renewsContractId).toBe(k1.contractId);
    expect([...renewal.lineIds].sort()).toEqual([l2, l3].sort());
    const lines = await reads().linesForContract(await reader(t), {
      contractId: k2.contractId!,
    });
    expect(lines.lines.map((l) => `${l.productKey}:${l.supersedesLineId ?? '-'}`).sort()).toEqual([
      'analytics:-',
      `core:${l1}`,
    ]);
    await integrityClean(t);
  });

  it('amendment in place: the same contract takes the new term and an added line; history records the change; no amends link and no second contract', async () => {
    const { t, account: a } = await account('v9inplace');
    const k = await observeContract(t, a, 'ip1', {
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-12-31T00:00:00.000Z',
    });
    const l1 = await insertLine(c, t, a, 'core');
    expect((await lineRefs(t, l1, { agreement: 'ip1' })).contract).toBe('assigned');
    // The source amends the header itself: a longer term.
    const amended = await observeContract(t, a, 'ip1', {
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2027-06-30T00:00:00.000Z',
    });
    expect(amended).toMatchObject({ status: 'updated', contractId: k.contractId });
    // A line added by the amendment belongs to the same header.
    const l2 = await insertLine(c, t, a, 'reporting');
    expect((await lineRefs(t, l2, { agreement: 'ip1' })).contract).toBe('assigned');

    expect(await contractCount(t)).toBe(1);
    expect((await lineRow(l1)).contract_id).toBe(k.contractId);
    expect((await lineRow(l2)).contract_id).toBe(k.contractId);
    const view = await reads().contract(await reader(t), { contractId: k.contractId! });
    expect(view.amendsContractId).toBeNull();
    expect(view.renewsContractId).toBeNull();
    expect(view.linkedFrom).toEqual([]);
    expect(Date.parse(view.endsAt!)).toBe(Date.parse('2027-06-30T00:00:00.000Z'));
    expect([...view.lineIds].sort()).toEqual([l1, l2].sort());
    // The term change is in the value history (two entries: creation, amendment).
    expect(await history(t, k.contractId!, 'ends_at')).toHaveLength(2);
    // An operator amendment in place is the same contract too (no new row).
    const op = await contracts().write(await human(t), {
      contract: k.contractId!,
      endsAt: '2027-12-31T00:00:00.000Z',
      reason: REASON,
    });
    expect(op).toMatchObject({ contractId: k.contractId, created: false, changed: true });
    expect(await contractCount(t)).toBe(1);
    expect(await history(t, k.contractId!, 'ends_at')).toHaveLength(3);
    await integrityClean(t);
  });

  it('amendment as a new contract: the amendment header amends the original; its lines are its own; the original keeps its lines and status', async () => {
    const { t, account: a } = await account('v9amends');
    const k1 = await observeContract(t, a, 'am1', {
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2027-12-31T00:00:00.000Z',
    });
    const l1 = await insertLine(c, t, a, 'core');
    expect((await lineRefs(t, l1, { agreement: 'am1' })).contract).toBe('assigned');
    const k2 = await observeContract(t, a, 'am2', {
      startsAt: '2026-06-01T00:00:00.000Z',
      endsAt: '2027-12-31T00:00:00.000Z',
      links: { amends: SUB('am1') },
    });
    expect(k2).toMatchObject({ status: 'created' });
    expect(k2.linksRefused ?? 0).toBe(0);
    const l2 = await insertLine(c, t, a, 'analytics');
    expect((await lineRefs(t, l2, { agreement: 'am2' })).contract).toBe('assigned');

    expect(await contractCount(t)).toBe(2);
    expect((await lineRow(l1)).contract_id).toBe(k1.contractId);
    expect((await lineRow(l2)).contract_id).toBe(k2.contractId);
    const original = await reads().contract(await reader(t), { contractId: k1.contractId! });
    expect(original.status).toBe('active');
    expect(original.lineIds).toEqual([l1]);
    expect(original.linkedFrom).toEqual([{ contractId: k2.contractId, kind: 'amends' }]);
    const amendment = await reads().contract(await reader(t), { contractId: k2.contractId! });
    expect(amendment).toMatchObject({
      amendsContractId: k1.contractId,
      renewsContractId: null,
      parentContractId: null,
    });
    expect(amendment.lineIds).toEqual([l2]);
    // The operator can record the same amendment relation (and refuses the reverse: a cycle).
    await expect(
      contracts().link(await human(t), {
        contract: k1.contractId!,
        kind: 'amends',
        target: k2.contractId!,
        reason: REASON,
      }),
    ).rejects.toThrow(/contract_link_cycle/);
    await integrityClean(t);
  });

  it('replacement: a line of another product replaces the old line on the same contract (supersedes_line_id); offers stay per product; the old line keeps its references', async () => {
    const { t, account: a } = await account('v9replace');
    const k = await observeContract(t, a, 'rp1', {
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2027-12-31T00:00:00.000Z',
    });
    const coreOffer = await offers().write(await human(t), {
      product: 'core',
      currency: 'EUR',
      billingPeriod: 1,
      billingPeriodUnit: 'month',
      reason: REASON,
    });
    const reportingOffer = await offers().write(await human(t), {
      product: 'reporting',
      currency: 'EUR',
      billingPeriod: 1,
      billingPeriodUnit: 'year',
      reason: REASON,
    });
    const old = await insertLine(c, t, a, 'core');
    expect((await lineRefs(t, old, { agreement: 'rp1' })).contract).toBe('assigned');
    await step().assignPriceOffer(await human(t), {
      line: old,
      target: coreOffer.priceOfferId,
      reason: REASON,
    });
    // The replacement line: another product on the same contract.
    const repl = await insertLine(c, t, a, 'reporting');
    expect((await lineRefs(t, repl, { agreement: 'rp1' })).contract).toBe('assigned');
    await expect(
      step().assignPriceOffer(await human(t), {
        line: repl,
        target: coreOffer.priceOfferId,
        reason: REASON,
      }),
    ).rejects.toThrow(/line_price_offer_product_mismatch/);
    expect(
      await step().assignPriceOffer(await human(t), {
        line: repl,
        target: reportingOffer.priceOfferId,
        reason: REASON,
      }),
    ).toMatchObject({ changed: true });
    expect(
      await step().setSupersedes(await human(t), { line: repl, target: old, reason: REASON }),
    ).toMatchObject({ changed: true });

    expect(await lineRow(repl)).toEqual({
      contract_id: k.contractId,
      price_offer_id: reportingOffer.priceOfferId,
      supersedes_line_id: old,
      product_key: 'reporting',
    });
    expect(await lineRow(old)).toEqual({
      contract_id: k.contractId,
      price_offer_id: coreOffer.priceOfferId,
      supersedes_line_id: null,
      product_key: 'core',
    });
    // The replacement cannot be reversed into a cycle.
    await expect(
      step().setSupersedes(await human(t), { line: old, target: repl, reason: REASON }),
    ).rejects.toThrow(/line_lineage_cycle/);
    const lines = await reads().linesForContract(await reader(t), { contractId: k.contractId! });
    expect(
      lines.lines
        .map((l) => `${l.productKey}:${l.priceOfferId}:${l.supersedesLineId ?? '-'}`)
        .sort(),
    ).toEqual(
      [
        `core:${coreOffer.priceOfferId}:-`,
        `reporting:${reportingOffer.priceOfferId}:${old}`,
      ].sort(),
    );
    expect((await history(t, repl, 'price_offer_id')).map((h) => h.new_value)).toEqual([
      reportingOffer.priceOfferId,
    ]);
    await integrityClean(t);
  });

  it('co-terming: an add-on contract under its master (parent) ends with the master; dates align by data, never by cascade; re-parented to the master renewal; cycles refused', async () => {
    const { t, account: a } = await account('v9coterm');
    const master = await observeContract(t, a, 'ms1', {
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-12-31T00:00:00.000Z',
    });
    const addon = await observeContract(t, a, 'ad1', {
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-12-31T00:00:00.000Z',
      links: { parent: SUB('ms1') },
    });
    expect(addon).toMatchObject({ status: 'created' });
    expect(addon.linksRefused ?? 0).toBe(0);
    const line = await insertLine(c, t, a, 'analytics');
    expect((await lineRefs(t, line, { agreement: 'ad1' })).contract).toBe('assigned');

    const m = await reads().contract(await reader(t), { contractId: master.contractId! });
    const ad = await reads().contract(await reader(t), { contractId: addon.contractId! });
    expect(m.linkedFrom).toEqual([{ contractId: addon.contractId, kind: 'parent' }]);
    expect(ad.parentContractId).toBe(master.contractId);
    expect(Date.parse(ad.endsAt!)).toBe(Date.parse(m.endsAt!));
    expect(ad.lineIds).toEqual([line]);
    expect(m.lineIds).toEqual([]);

    // The master is extended; the add-on's end is not cascaded (co-terming is recorded data).
    await observeContract(t, a, 'ms1', {
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2027-12-31T00:00:00.000Z',
    });
    const adAfter = await reads().contract(await reader(t), { contractId: addon.contractId! });
    expect(Date.parse(adAfter.endsAt!)).toBe(Date.parse('2026-12-31T00:00:00.000Z'));
    // The source re-terms the add-on to the master's new end.
    expect(
      await observeContract(t, a, 'ad1', {
        startsAt: '2026-07-01T00:00:00.000Z',
        endsAt: '2027-12-31T00:00:00.000Z',
        links: { parent: SUB('ms1') },
      }),
    ).toMatchObject({ status: 'updated' });

    // The master parented under its own add-on closes a cycle: refused (operator code).
    await expect(
      contracts().link(await human(t), {
        contract: master.contractId!,
        kind: 'parent',
        target: addon.contractId!,
        reason: REASON,
      }),
    ).rejects.toThrow(/contract_link_cycle/);
    // The master renews; the operator re-parents the add-on under the renewal (acyclic).
    const renewal = await observeContract(t, a, 'ms2', {
      startsAt: '2028-01-01T00:00:00.000Z',
      endsAt: '2028-12-31T00:00:00.000Z',
      links: { renews: SUB('ms1') },
    });
    expect(
      await contracts().link(await human(t), {
        contract: addon.contractId!,
        kind: 'parent',
        target: renewal.contractId!,
        reason: REASON,
      }),
    ).toMatchObject({ changed: true });
    const reparented = await reads().contract(await reader(t), {
      contractId: renewal.contractId!,
    });
    expect(reparented.renewsContractId).toBe(master.contractId);
    expect(reparented.linkedFrom).toEqual([{ contractId: addon.contractId, kind: 'parent' }]);
    expect((await lineRow(line)).contract_id).toBe(addon.contractId);
    await integrityClean(t);
  });
});
