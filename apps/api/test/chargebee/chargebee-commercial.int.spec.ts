import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MappingDocument } from '../../src/modules/domain';
import { ModuleSettingsService } from '../../src/modules/governance';
import type { TenantContext } from '../../src/modules/tenancy';
import { chargebeeTenant, chargebeeTestMapping, withoutState } from '../support/chargebee';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeChargebee } from '../support/fake-chargebee';
import {
  publishWithAcks,
  runSync,
  sourcesServices,
  withoutTerms,
  withSnapshot,
  type SourcesFixture,
} from '../support/sources';
import { authz } from '../support/security';

const UNIX = { parse: { type: 'timestamp' as const, format: 'unix_seconds' as const } };
const AGREEMENT_CONFIRMATION = {
  semantics: 'agreement_header' as const,
  confirmedBy: 'test-operator',
  note: 'TEST ONLY: SubscriptionItems.subscription_id names the Chargebee subscription, the agreement header',
};

/**
 * The plan §6.5 Chargebee TEST commercial mapping (fixture only; declared
 * fields only): `ItemPrices` → price offer (`item_id` through the product
 * reference set, `currency_code`, `period` / `period_unit`, `pricing_model`
 * and `status` through TEST value maps); `Subscriptions` → contract
 * (`customer_id` → account, `status` over the seven declared codes,
 * `started_at` → starts, `current_term_end` → ends);
 * `SubscriptionItems.subscription_id` → `subscription.agreement` (confirmed
 * agreement header) and `SubscriptionItems.item_price_id` →
 * `subscription.priceOfferRef`. No renewal date, auto-renew, total value or
 * list amount is mapped (no declared source field; `next_billing_at` is
 * billing, not renewal).
 */
export function chargebeeCommercialMapping(): MappingDocument {
  return chargebeeTestMapping((doc) => {
    const lines = doc.objects.find((o) => o.source === 'SubscriptionItems')!;
    (lines as { relationships: unknown[] }).relationships = [
      ...lines.relationships,
      {
        target: 'subscription.agreement',
        field: 'subscription_id',
        object: 'Subscriptions',
        confirmation: AGREEMENT_CONFIRMATION,
      },
      { target: 'subscription.priceOfferRef', field: 'item_price_id', object: 'ItemPrices' },
    ];
    (doc as { objects: unknown[] }).objects = [
      ...doc.objects,
      {
        source: 'ItemPrices',
        entity: 'price_offer',
        identity: { field: 'id' },
        relationships: [],
        fields: [],
        priceOffer: {
          product: { field: 'item_id' },
          currency: { field: 'currency_code' },
          billingPeriod: { field: 'period' },
          billingPeriodUnit: {
            field: 'period_unit',
            valueMap: { day: 'day', week: 'week', month: 'month', year: 'year' },
          },
          pricingModel: {
            field: 'pricing_model',
            valueMap: {
              flat_fee: 'flat',
              per_unit: 'per_unit',
              tiered: 'tiered',
              volume: 'volume',
              stairstep: 'tiered',
            },
          },
          status: {
            field: 'status',
            valueMap: { active: 'active', archived: 'retired', deleted: 'retired' },
          },
        },
      },
      {
        source: 'Subscriptions',
        entity: 'contract',
        identity: { field: 'id' },
        relationships: [],
        fields: [],
        contract: {
          account: { field: 'customer_id', object: 'Customers' },
          status: {
            field: 'status',
            valueMap: {
              active: 'active',
              in_trial: 'active',
              non_renewing: 'active',
              future: 'draft',
              cancelled: 'terminated',
              paused: 'unknown',
              transferred: 'unknown',
            },
          },
          startsAt: { field: 'started_at', transforms: UNIX },
          endsAt: { field: 'current_term_end', transforms: UNIX },
        },
      },
    ];
  });
}

/**
 * V28 (plan §6.5, §20): the Chargebee TEST commercial mapping through the
 * production Chargebee adapter against the deterministic fake, on real
 * PostgreSQL as the app role (forced RLS): price offers from ItemPrices,
 * contracts from Subscriptions, the confirmed agreement_ref on every line and
 * the lines resolved to their contract and price offer; no confidential column
 * is written (nothing declared). The fake is NOT evidence of real Chargebee
 * behaviour (live verification is phase 3 / Q26).
 */
describe('V28: Chargebee TEST commercial mapping (fake Chargebee)', () => {
  let c: ContextHarness;
  let fake: FakeChargebee;
  let f: SourcesFixture;

  async function enableCommercial(t: TenantContext): Promise<void> {
    const [row] = await c.sql<{ version: number }>(
      `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'commercial'`,
      [t.tenantId],
    );
    await c.app.get(ModuleSettingsService).enable(await authz(t, 'config.module.change'), {
      module: 'commercial',
      expectedVersion: row?.version ?? 0,
    });
  }

  beforeAll(async () => {
    c = await startContextHarness();
    fake = await new FakeChargebee().start();
    const doc = chargebeeCommercialMapping();
    // Profile covers every object of the commercial document; nothing published yet.
    f = await chargebeeTenant(c, fake, { prefix: 'cbcomm', mapping: doc, stopAfter: 'profile' });
    const s = sourcesServices(c);
    const snapshot = await s.snapshots.latest(f.ctx, f.connectionId);
    // Governance order (ADR 0020): v1 without state / terms / commercial → authority → v2.
    await publishWithAcks(
      c,
      f,
      withSnapshot(withoutState(withoutTerms(chargebeeTestMapping())), snapshot!.hash),
      0,
    );
    await enableCommercial(f.ctx);
    const current = await s.authority.show(f.ctx);
    await s.authority.publish(
      await authz(f.ctx, 'config.authority.publish'),
      {
        facts: {
          account_profile: null,
          person_profile: null,
          subscription_lines: f.connectionId,
          subscription_state: f.connectionId,
          subscription_terms: f.connectionId,
          price_offer: f.connectionId,
          contract: f.connectionId,
          entitlement: null,
        },
      },
      { expectedBaseVersion: current!.version },
    );
    await publishWithAcks(c, f, withSnapshot(doc, snapshot!.hash), 1);
  });
  afterAll(async () => {
    await fake?.stop();
    await c?.close();
  });

  const entityOf = async (object: string, id: string, kind: string) =>
    (
      await c.sql<{ entity_id: string }>(
        `SELECT entity_id::text FROM tenant_source_references
          WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = $2 AND external_id = $3
            AND entity_kind = $4`,
        [f.ctx.tenantId, object, id, kind],
      )
    )[0]?.entity_id;
  const companyOf = async (customer: string) =>
    (
      await c.sql<{ company_id: string }>(
        `SELECT company_id::text FROM company_external_refs
          WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers' AND external_id = $2`,
        [f.ctx.tenantId, customer],
      )
    )[0]?.company_id;

  it('a full run writes the offers and contracts, stores the confirmed agreement_ref and resolves every line to its contract and price offer', async () => {
    const run = await runSync(c, f, 'full');
    expect(run.status).toBe('completed');
    const q = (k: string) => Number((run.quality as Record<string, unknown>)[k] ?? 0);
    // Seven item prices of modelled items (the legacy add-on's price is unmodelled).
    expect(q('price_offer_created')).toBe(7);
    expect(q('contract_created')).toBeGreaterThanOrEqual(17);

    const offer = (
      await c.sql<Record<string, unknown>>(
        `SELECT product_key, currency, billing_period, billing_period_unit, pricing_model, status,
              list_amount_minor FROM tenant_price_offers WHERE tenant_id = $1 AND id = $2`,
        [f.ctx.tenantId, await entityOf('ItemPrices', 'plan-pro-USD-monthly', 'price_offer')],
      )
    )[0];
    expect(offer).toEqual({
      product_key: 'plan-pro',
      currency: 'USD',
      billing_period: 1,
      billing_period_unit: 'month',
      pricing_model: 'per_unit',
      status: 'active',
      list_amount_minor: null,
    });
    const setup = (
      await c.sql<Record<string, unknown>>(
        `SELECT billing_period, billing_period_unit, pricing_model FROM tenant_price_offers
        WHERE tenant_id = $1 AND id = $2`,
        [f.ctx.tenantId, await entityOf('ItemPrices', 'charge-setup-USD', 'price_offer')],
      )
    )[0];
    expect(setup).toEqual({
      billing_period: null,
      billing_period_unit: null,
      pricing_model: 'flat',
    });

    const k02 = (await entityOf('Subscriptions', 'sub-02', 'contract'))!;
    const contract = (
      await c.sql<Record<string, unknown>>(
        `SELECT company_id::text, status, starts_at IS NOT NULL AS has_start, ends_at IS NOT NULL AS has_end,
              renewal_date, total_value_minor, total_value_currency, auto_renew
         FROM tenant_contracts WHERE tenant_id = $1 AND id = $2`,
        [f.ctx.tenantId, k02],
      )
    )[0];
    expect(contract).toEqual({
      company_id: await companyOf('cus-02'),
      status: 'active',
      has_start: true,
      has_end: true,
      renewal_date: null,
      total_value_minor: null,
      total_value_currency: null,
      auto_renew: null,
    });
    const statusOf = async (sub: string) =>
      (
        await c.sql<{ status: string }>(`SELECT status FROM tenant_contracts WHERE id = $1`, [
          await entityOf('Subscriptions', sub, 'contract'),
        ])
      )[0]?.status;
    expect(await statusOf('sub-05')).toBe('draft');
    expect(await statusOf('sub-07')).toBe('terminated');
    expect(await statusOf('sub-08')).toBe('unknown');
    // An unknown customer: no contract (account_unknown), counted.
    expect(await entityOf('Subscriptions', 'sub-19', 'contract')).toBeUndefined();

    // sub-02's three lines: the confirmed agreement_ref, the contract and each line's own offer.
    const lines = await c.sql<{
      product_key: string;
      contract_id: string | null;
      price_offer_id: string | null;
      agreement_ref_system: string | null;
      agreement_ref_object_type: string | null;
      agreement_ref_external_id: string | null;
    }>(
      `SELECT product_key, contract_id::text, price_offer_id::text, agreement_ref_system,
              agreement_ref_object_type, agreement_ref_external_id
         FROM tenant_subscriptions WHERE tenant_id = $1 AND company_id = $2 ORDER BY product_key`,
      [f.ctx.tenantId, await companyOf('cus-02')],
    );
    expect(lines.map((l) => l.product_key)).toEqual(['addon-seats', 'addon-support', 'plan-pro']);
    for (const l of lines) {
      expect(l).toMatchObject({
        contract_id: k02,
        agreement_ref_system: 'chargebee',
        agreement_ref_object_type: 'Subscriptions',
        agreement_ref_external_id: 'sub-02',
      });
    }
    expect(lines.map((l) => l.price_offer_id)).toEqual([
      await entityOf('ItemPrices', 'addon-seats-USD-monthly', 'price_offer'),
      await entityOf('ItemPrices', 'addon-support-USD-monthly', 'price_offer'),
      await entityOf('ItemPrices', 'plan-pro-USD-monthly', 'price_offer'),
    ]);
    // Every Chargebee line with a contract is resolved: none left awaiting its contract.
    const waiting = await c.sql(
      `SELECT 1 FROM tenant_subscriptions s
        WHERE s.tenant_id = $1 AND s.agreement_ref_external_id IS NOT NULL AND s.contract_id IS NULL
          AND EXISTS (SELECT 1 FROM tenant_source_references r
                       WHERE r.tenant_id = s.tenant_id AND r.system = 'chargebee'
                         AND r.object_type = 'Subscriptions' AND r.external_id = s.agreement_ref_external_id
                         AND r.entity_kind = 'contract')`,
      [f.ctx.tenantId],
    );
    expect(waiting).toHaveLength(0);
    // Nothing confidential is written from Chargebee (Q9: no declared amount field).
    expect(
      await c.sql(
        `SELECT 1 FROM tenant_price_offers WHERE tenant_id = $1 AND list_amount_minor IS NOT NULL
         UNION ALL
         SELECT 1 FROM tenant_contracts WHERE tenant_id = $1
            AND (total_value_minor IS NOT NULL OR renewal_date IS NOT NULL)`,
        [f.ctx.tenantId],
      ),
    ).toHaveLength(0);
    // A second run changes nothing commercial.
    const again = await runSync(c, f, 'full');
    expect(again.status).toBe('completed');
    const q2 = (k: string) => Number((again.quality as Record<string, unknown>)[k] ?? 0);
    expect(q2('price_offer_created')).toBe(0);
    expect(q2('contract_created')).toBe(0);
  });
});
