import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommercialLineReferenceStep,
  CommercialReadModel,
  ContractWriter,
  EntitlementWriter,
  PriceOfferWriter,
  type CommercialProvenance,
} from '../../src/modules/commercial';
import { operatorActor } from '../../src/modules/domain';
import {
  CanonicalAdoptionService,
  IntegrityVerificationService,
  ModuleSettingsService,
} from '../../src/modules/governance';
import {
  AuthorizationDeniedError,
  CapabilityGrants,
  TenantDatabase,
  type TenantContext,
} from '../../src/modules/tenancy';
import { auditOf, companies, hs, ingestMeta } from '../support/account-structure';
import {
  insertLine,
  observeContext,
  publishContextTypes,
  seedProducts,
  setModule,
} from '../support/account-context';
import { startContextHarness, type ContextHarness } from '../support/context';
import {
  field,
  publishExtension,
  services as extServices,
  sourceProvenance,
} from '../support/extension';
import { authz, TEST_GRANTOR } from '../support/security';

const REASON = 'test_correction';
const CONFIDENTIAL = 'data.commercial.read_confidential';
const AC_CONFIDENTIAL = 'data.account_context.read_confidential';
const SUB = (id: string) => ({ system: 'chargebee', objectType: 'Subscriptions', id });
/** Synthetic confidential values that must never reach an audit event, error or change record (V24). */
const PROBE_LIST = 987654321;
const PROBE_TOTAL = 555444333;
const PROBE_CURRENCY = 'CHF';
const PROBE_RENEWAL = '2031-07-15';
const PROBE_EXT = 'Probecommercialextvalue';
/** A synthetic token shape the secret-like detector refuses (built, never a real credential). */
const SECRET_LIKE = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

/**
 * M10F phase 2b-2 on real PostgreSQL as the app role (forced RLS), through the
 * harness app and the real WriteAuthorizer / CapabilityGrants (no policy
 * bypass): V20 (CommercialReadModel: confidential columns withheld by default,
 * `includeConfidential` refused + `denied` audit without the explicit grant,
 * `allowed` audit naming the capability and the released keys only with it,
 * revoke; one audit event per call; batch bound), V21 (extension values on
 * commercial targets need data.commercial.read_confidential — no bypass via
 * data.extension.read or the account-context grant; the extension targets
 * need 0.6 + module commercial), V24 (secret-like strings refused; no amount,
 * date or currency in audit details or errors), V26 / V27 (rollback 0.6 → 0.5
 * and disable after use: reads allowed, operator writes refused and audited,
 * line references kept), V29 (the six §15 integrity checks pass on clean data
 * and detect seeded faults, identifiers only), V33 (contract `context_id`
 * needs module account_context; same-account guard) and a company merge
 * racing contract writes in two sessions (V19: no deadlock, nothing left on
 * the merged company). Synthetic values only.
 */
describe('M10F commercial read model, confidential gate, integrity and races', () => {
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
  const reads = () => c.app.get(CommercialReadModel, { strict: false });
  const grants = () => c.app.get(CapabilityGrants);
  const db = () => c.app.get(TenantDatabase);
  const human = (t: TenantContext) => authz(t, 'canonical.human_entry');
  const sync = (t: TenantContext) => authz(t, 'canonical.source_sync');
  const reader = (t: TenantContext, id: string) =>
    authz(t, 'data.commercial.read', operatorActor(id));
  const grantor = (t: TenantContext) => authz(t, 'security.capability.grant', TEST_GRANTOR);
  const grant = async (t: TenantContext, grantee: string, capability = CONFIDENTIAL) =>
    grants().grant(await grantor(t), { grantee, capability });
  const revoke = async (t: TenantContext, grantee: string) =>
    grants().revoke(await grantor(t), { grantee, capability: CONFIDENTIAL });
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

  let portal = 4100;
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
  const agreement = async (t: TenantContext, lineId: string, ref: string) => {
    const actx = await sync(t);
    return db().transaction(t, (tx) =>
      step().applyFromSource(actx, tx, {
        lineId,
        agreementRef: { system: 'chargebee', objectType: 'Subscriptions', externalId: ref },
        provenance: prov(`line-${lineId}`),
        observedAt: new Date(),
      }),
    );
  };
  const readEvents = (t: TenantContext) => auditOf(c, t, 'commercial.read');
  const valueFree = (x: unknown) => {
    const text = JSON.stringify(x);
    for (const v of [String(PROBE_LIST), String(PROBE_TOTAL), PROBE_CURRENCY, PROBE_RENEWAL]) {
      expect(text).not.toContain(v);
    }
  };

  /** One account with a confidential-bearing offer, contract (with a line) and an entitlement. */
  async function seeded(prefix: string) {
    const t = await tenant(prefix);
    const account = (await companies(c, t, [`${portal}1`]))[`${portal}1`]!;
    const offer = await offers().write(await human(t), {
      product: 'core',
      currency: 'EUR',
      billingPeriod: 1,
      billingPeriodUnit: 'month',
      listAmountMinor: PROBE_LIST,
      reason: REASON,
    });
    const plain = await offers().write(await human(t), {
      product: 'analytics',
      currency: 'EUR',
      reason: REASON,
    });
    const contract = await observeContract(t, account, `k-${prefix}`, {
      startsAt: '2030-01-01T00:00:00.000Z',
      endsAt: '2031-12-31T00:00:00.000Z',
      renewalDate: PROBE_RENEWAL,
      totalValueMinor: PROBE_TOTAL,
      totalValueCurrency: PROBE_CURRENCY,
    });
    const renewal = await observeContract(t, account, `k2-${prefix}`, {
      links: { renews: SUB(`k-${prefix}`) },
    });
    const line = await insertLine(c, t, account);
    expect((await agreement(t, line, `k-${prefix}`)).contract).toBe('assigned');
    const ent = await entitlements().write(await human(t), {
      account,
      product: 'core',
      quantity: 7,
      status: 'active',
      reason: REASON,
    });
    return {
      t,
      account,
      offerId: offer.priceOfferId,
      plainOfferId: plain.priceOfferId,
      contractId: contract.contractId!,
      renewalId: renewal.contractId!,
      line,
      entitlementId: ent.entitlementId,
    };
  }

  describe('V20: CommercialReadModel and the confidential gate', () => {
    let s: Awaited<ReturnType<typeof seeded>>;
    beforeAll(async () => {
      s = await seeded('cmread');
    });

    it('default: every read needs only data.commercial.read, withholds the confidential columns (keys listed, values null), carries the classification and writes exactly one allowed audit event', async () => {
      const before = (await readEvents(s.t)).length;
      const r = () => reader(s.t, 'plain-reader');
      const list = await reads().priceOffersForProducts(await r(), {
        productKeys: ['core', 'analytics'],
      });
      expect(list.truncated).toBe(false);
      const offer = list.priceOffers.find((o) => o.id === s.offerId)!;
      expect(offer).toMatchObject({
        productKey: 'core',
        currency: 'EUR',
        billingPeriod: 1,
        billingPeriodUnit: 'month',
        listAmountMinor: null,
        withheld: ['listAmountMinor'],
      });
      expect(offer.classification).toMatchObject({
        listAmountMinor: 'confidential',
        currency: 'internal',
      });
      // A null confidential column is not "withheld" (nothing to release).
      expect(list.priceOffers.find((o) => o.id === s.plainOfferId)!.withheld).toEqual([]);
      const shownOffer = await reads().priceOffer(await r(), { priceOfferId: s.offerId });
      expect(shownOffer.listAmountMinor).toBeNull();
      const contractsList = await reads().contractsForAccounts(await r(), {
        companyIds: [s.account],
      });
      expect(contractsList.contracts.map((k) => k.id).sort()).toEqual(
        [s.contractId, s.renewalId].sort(),
      );
      const detail = await reads().contract(await r(), { contractId: s.contractId });
      expect(detail).toMatchObject({
        id: s.contractId,
        companyId: s.account,
        startsAt: '2030-01-01T00:00:00.000Z',
        status: 'active',
        renewalDate: null,
        totalValueMinor: null,
        totalValueCurrency: null,
        linkedFrom: [{ contractId: s.renewalId, kind: 'renews' }],
        lineIds: [s.line],
        linesTruncated: false,
      });
      expect([...detail.withheld].sort()).toEqual([
        'renewalDate',
        'totalValueCurrency',
        'totalValueMinor',
      ]);
      const lines = await reads().linesForContract(await r(), { contractId: s.contractId });
      expect(lines.lines).toEqual([
        expect.objectContaining({ id: s.line, companyId: s.account, productKey: 'core' }),
      ]);
      const ents = await reads().entitlementsForAccounts(await r(), { companyIds: [s.account] });
      expect(ents.entitlements).toEqual([
        expect.objectContaining({
          id: s.entitlementId,
          quantity: 7,
          status: 'active',
          withheld: [],
        }),
      ]);
      await reads().entitlement(await r(), { entitlementId: s.entitlementId });
      const events = (await readEvents(s.t)).slice(before);
      expect(
        events.map((e) => [e.outcome, e.capability, e.target_kind, e.details.operation]),
      ).toEqual([
        ['allowed', 'data.commercial.read', 'price_offer', 'list'],
        ['allowed', 'data.commercial.read', 'price_offer', 'show'],
        ['allowed', 'data.commercial.read', 'contract', 'list'],
        ['allowed', 'data.commercial.read', 'contract', 'show'],
        ['allowed', 'data.commercial.read', 'contract', 'lines'],
        ['allowed', 'data.commercial.read', 'entitlement', 'list'],
        ['allowed', 'data.commercial.read', 'entitlement', 'show'],
      ]);
      for (const e of events) expect(e.details).not.toHaveProperty('releasedKeys');
      valueFree(events);
    });

    it('refusal: includeConfidential without the grant is refused (not redacted) on every read, audited denied under data.commercial.read_confidential; the account-context grant does not help', async () => {
      await grant(s.t, 'ac-only', AC_CONFIDENTIAL);
      const before = (await readEvents(s.t)).length;
      for (const who of ['no-grant', 'ac-only']) {
        const r = await reader(s.t, who);
        // Lazy: each call starts only when awaited (sequential, no unhandled rejection).
        const calls = [
          () =>
            reads().priceOffersForProducts(r, { productKeys: ['core'], includeConfidential: true }),
          () => reads().priceOffer(r, { priceOfferId: s.offerId, includeConfidential: true }),
          () =>
            reads().contractsForAccounts(r, { companyIds: [s.account], includeConfidential: true }),
          () => reads().contract(r, { contractId: s.contractId, includeConfidential: true }),
          () =>
            reads().entitlementsForAccounts(r, {
              companyIds: [s.account],
              includeConfidential: true,
            }),
          () =>
            reads().entitlement(r, { entitlementId: s.entitlementId, includeConfidential: true }),
        ];
        for (const call of calls) {
          await expect(call()).rejects.toBeInstanceOf(AuthorizationDeniedError);
        }
      }
      // A forged unknown id is refused the same way (decided before anything is read).
      await expect(
        reads().contract(await reader(s.t, 'no-grant'), {
          contractId: randomUUID(),
          includeConfidential: true,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
      const events = (await readEvents(s.t)).slice(before);
      expect(events).toHaveLength(13);
      for (const e of events) {
        expect(e).toMatchObject({
          outcome: 'denied',
          capability: CONFIDENTIAL,
          reason_code: 'capability_not_granted',
          actor_kind: 'operator',
        });
        expect(e.details).toMatchObject({ includeConfidential: true });
      }
      expect(events[3]).toMatchObject({ target_kind: 'contract', target_ref: s.contractId });
      valueFree(events);
    });

    it('granted: values released; one allowed event under data.commercial.read_confidential with the released keys only; revoke refuses again', async () => {
      await grant(s.t, 'conf-reader');
      const before = (await readEvents(s.t)).length;
      const r = () => reader(s.t, 'conf-reader');
      const detail = await reads().contract(await r(), {
        contractId: s.contractId,
        includeConfidential: true,
      });
      expect(detail).toMatchObject({
        renewalDate: PROBE_RENEWAL,
        totalValueMinor: PROBE_TOTAL,
        totalValueCurrency: PROBE_CURRENCY,
        withheld: [],
      });
      const list = await reads().priceOffersForProducts(await r(), {
        productKeys: ['core', 'analytics'],
        includeConfidential: true,
      });
      expect(list.priceOffers.find((o) => o.id === s.offerId)!.listAmountMinor).toBe(PROBE_LIST);
      // Entitlements carry no confidential column: allowed, nothing released.
      await reads().entitlementsForAccounts(await r(), {
        companyIds: [s.account],
        includeConfidential: true,
      });
      const events = (await readEvents(s.t)).slice(before);
      expect(events.map((e) => [e.outcome, e.capability, e.details.releasedKeys])).toEqual([
        [
          'allowed',
          CONFIDENTIAL,
          ['contract.renewalDate', 'contract.totalValueCurrency', 'contract.totalValueMinor'],
        ],
        ['allowed', CONFIDENTIAL, ['price_offer.listAmountMinor']],
        ['allowed', CONFIDENTIAL, []],
      ]);
      for (const e of events) expect(e.details).toMatchObject({ includeConfidential: true });
      valueFree(events);
      await revoke(s.t, 'conf-reader');
      await expect(
        reads().contract(await r(), { contractId: s.contractId, includeConfidential: true }),
      ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
    });

    it('grants are tenant-scoped and the batch is bounded (≤ 500 keys, refused and audited failed)', async () => {
      const other = await tenant('cmreadb');
      await grant(other, 'cross-reader');
      await expect(
        reads().contract(await reader(s.t, 'cross-reader'), {
          contractId: s.contractId,
          includeConfidential: true,
        }),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      // The other tenant's reader sees nothing of this tenant (RLS): the contract does not exist there.
      await expect(
        reads().contract(await reader(other, 'cross-reader'), {
          contractId: s.contractId,
          includeConfidential: true,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      const many = Array.from({ length: 501 }, () => randomUUID());
      await expect(
        reads().contractsForAccounts(await reader(s.t, 'plain-reader'), { companyIds: many }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect((await readEvents(s.t)).at(-1)).toMatchObject({ outcome: 'failed' });
    });
  });

  describe('V21: extension values on commercial targets', () => {
    const document = () => ({
      schema_version: 1,
      fields: [
        field('contract_terms', 'string', {
          target: 'contract',
          sensitivity: 'confidential',
          categories: ['commercial'],
        }),
        field('contract_note', 'string', { target: 'contract' }),
      ],
    });

    it('the registry refuses commercial targets until 0.6 + module commercial; --include-confidential on a contract target needs data.commercial.read_confidential (no bypass through data.extension.read or the account-context grant)', async () => {
      const t = await tenant('cmext', false);
      await setModule(c, t, 'extension', true);
      const ext = extServices(c);
      const dry = await ext.registry.dryRun(t, 'extension', document());
      expect(dry.valid).toBe(false);
      expect(dry.issues).toContain('module_disabled');
      await setCommercial(t, true);
      await publishExtension(c, t, document());
      const account = (await companies(c, t, ['4901']))['4901']!;
      const k = await observeContract(t, account, 'k-ext');
      expect(
        await ext.values.observeSource(await sync(t), {
          target: { kind: 'contract', id: k.contractId! },
          values: [
            { field: 'contract_terms', raw: PROBE_EXT },
            { field: 'contract_note', raw: 'Plain note' },
          ],
          observedAt: new Date(),
          provenance: sourceProvenance('k-ext', {
            source: { system: 'chargebee', objectType: 'Subscriptions', id: 'k-ext' },
          }),
        }),
      ).toMatchObject({ status: 'ok', written: 2 });
      const extReader = (id: string) => authz(t, 'data.extension.read', operatorActor(id));
      const target = [`contract:${k.contractId}`];
      const plain = await ext.read.valuesFor(await extReader('ext-plain'), 'display', target);
      expect(JSON.stringify(plain)).not.toContain(PROBE_EXT);
      expect(JSON.stringify(plain)).toContain('Plain note');
      await grant(t, 'ext-ac', AC_CONFIDENTIAL);
      const before = (await auditOf(c, t, 'extension.read')).length;
      for (const who of ['ext-none', 'ext-ac']) {
        await expect(
          ext.read.valuesFor(await extReader(who), 'display', target, {
            includeConfidential: true,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied', capability: CONFIDENTIAL });
      }
      const denied = (await auditOf(c, t, 'extension.read')).slice(before);
      expect(denied.map((e) => [e.outcome, e.capability, e.details.targetKind])).toEqual([
        ['denied', CONFIDENTIAL, 'contract'],
        ['denied', CONFIDENTIAL, 'contract'],
      ]);
      await grant(t, 'ext-conf');
      const released = await ext.read.valuesFor(await extReader('ext-conf'), 'display', target, {
        includeConfidential: true,
      });
      expect(JSON.stringify(released)).toContain(PROBE_EXT);
      const allowed = (await auditOf(c, t, 'extension.read')).at(-1)!;
      expect(allowed).toMatchObject({
        outcome: 'allowed',
        capability: CONFIDENTIAL,
        details: { includeConfidential: true, commercialConfidential: true },
      });
      expect(JSON.stringify(await auditOf(c, t))).not.toContain(PROBE_EXT);
      // Module disabled after use: values on a contract target are refused, reads still work.
      await setCommercial(t, false);
      expect(
        await ext.values.observeSource(await sync(t), {
          target: { kind: 'contract', id: k.contractId! },
          values: [{ field: 'contract_note', raw: 'Changed note' }],
          observedAt: new Date(),
          provenance: sourceProvenance('k-ext'),
        }),
      ).toMatchObject({ status: 'module_disabled' });
      expect(
        JSON.stringify(await ext.read.valuesFor(await extReader('ext-plain'), 'display', target)),
      ).toContain('Plain note');
    });
  });

  it('V24: secret-like strings are refused before anything is written; no amount, date or currency in audit details, errors or change records of commercial writes', async () => {
    const s = await seeded('cmv24');
    const before = await c.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenant_price_offers WHERE tenant_id = $1`,
      [s.t.tenantId],
    );
    await expect(
      offers().write(await human(s.t), {
        product: SECRET_LIKE,
        currency: 'EUR',
        reason: REASON,
      }),
    ).rejects.toThrow();
    await expect(
      contracts().write(await human(s.t), {
        account: s.account,
        status: SECRET_LIKE,
        reason: REASON,
      }),
    ).rejects.toThrow();
    const after = await c.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenant_price_offers WHERE tenant_id = $1`,
      [s.t.tenantId],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
    // An invalid confidential value never echoes back in the error.
    const err = await contracts()
      .write(await human(s.t), {
        contract: s.contractId,
        totalValueMinor: PROBE_TOTAL,
        totalValueCurrency: 'chf',
        reason: REASON,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(JSON.stringify({ m: (err as Error).message, e: err })).not.toContain(
      String(PROBE_TOTAL),
    );
    // Operator change on the confidential columns: audit + change records value-free.
    await contracts().write(await human(s.t), {
      contract: s.contractId,
      renewalDate: '2031-07-16',
      totalValueMinor: PROBE_TOTAL + 1,
      reason: REASON,
    });
    await offers().write(await human(s.t), {
      priceOffer: s.offerId,
      listAmountMinor: PROBE_LIST + 1,
      reason: REASON,
    });
    const commercialAudit = (await auditOf(c, s.t)).filter((e) =>
      e.action.startsWith('commercial.'),
    );
    expect(commercialAudit.length).toBeGreaterThan(5);
    const text = JSON.stringify(commercialAudit);
    for (const v of [
      String(PROBE_LIST),
      String(PROBE_LIST + 1),
      String(PROBE_TOTAL),
      String(PROBE_TOTAL + 1),
      PROBE_CURRENCY,
      PROBE_RENEWAL,
      '2031-07-16',
    ]) {
      expect(text).not.toContain(v);
    }
    const history = await c.sql<{ field: string; values_recorded: boolean; v: string | null }>(
      `SELECT field, values_recorded, coalesce(old_value::text, '') || coalesce(new_value::text, '') AS v
         FROM tenant_value_history WHERE tenant_id = $1 AND field IN ('renewal_date', 'list_amount_minor')`,
      [s.t.tenantId],
    );
    expect(history.length).toBeGreaterThan(0);
    for (const h of history) {
      expect(h.values_recorded).toBe(false);
      expect(h.v ?? '').toBe('');
    }
  });

  it('V26 / V27: rollback 0.6 → 0.5 and module disable after use keep data readable, refuse operator writes (audited) and keep line references', async () => {
    const s = await seeded('cmroll');
    const adoption = c.app.get(CanonicalAdoptionService);
    expect(await adoption.plan(s.t, '0.5', '0.6')).toMatchObject({
      decision: 'rollback',
      modulesStranded: ['commercial'],
    });
    await adoption.adopt(await authz(s.t, 'config.canonical.adopt'), {
      target: '0.5',
      expectedCurrent: '0.6',
    });
    const read = async () =>
      reads().contract(await reader(s.t, 'roll-reader'), { contractId: s.contractId });
    await expect(read()).resolves.toMatchObject({ id: s.contractId, lineIds: [s.line] });
    await expect(
      contracts().write(await human(s.t), {
        contract: s.contractId,
        status: 'expired',
        reason: REASON,
      }),
    ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
    expect((await auditOf(c, s.t, 'commercial.contract.write')).at(-1)).toMatchObject({
      outcome: 'failed',
      reason_code: 'canonical_version_too_low',
    });
    await adoption.adopt(await authz(s.t, 'config.canonical.adopt'), {
      target: '0.6',
      expectedCurrent: '0.5',
    });
    // Disable after use (Q20).
    await setCommercial(s.t, false);
    await expect(read()).resolves.toMatchObject({ id: s.contractId, lineIds: [s.line] });
    for (const write of [
      async () =>
        contracts().write(await human(s.t), {
          contract: s.contractId,
          status: 'expired',
          reason: REASON,
        }),
      async () => offers().retire(await human(s.t), { priceOffer: s.offerId, reason: REASON }),
      async () =>
        entitlements().write(await human(s.t), {
          entitlement: s.entitlementId,
          quantity: 9,
          reason: REASON,
        }),
      async () =>
        step().assignContract(await human(s.t), { line: s.line, target: null, reason: REASON }),
    ]) {
      await expect(write()).rejects.toThrow(/module/i);
    }
    const [line] = await c.sql<{ contract_id: string | null }>(
      `SELECT contract_id::text FROM tenant_subscriptions WHERE id = $1`,
      [s.line],
    );
    expect(line!.contract_id).toBe(s.contractId);
    const [k] = await c.sql<{ status: string }>(
      `SELECT status FROM tenant_contracts WHERE id = $1`,
      [s.contractId],
    );
    expect(k!.status).toBe('active');
  });

  it('V29: the six §15 integrity checks pass on clean data and report seeded faults (identifiers only, nothing repaired)', async () => {
    const s = await seeded('cmint');
    const integrity = c.app.get(IntegrityVerificationService);
    const CHECKS = [
      'commercial_line_contract_company_mismatch',
      'commercial_line_price_offer_product_mismatch',
      'commercial_contract_link_cycle',
      'commercial_contract_link_cross_account',
      'commercial_line_lineage_cycle',
      'commercial_agreement_contract_drift',
    ] as const;
    const of = (r: { findings: readonly { check: string; ref: string }[] }, check: string) =>
      r.findings
        .filter((f) => f.check === check)
        .map((f) => f.ref)
        .sort();
    const clean = await integrity.verify(s.t);
    for (const check of CHECKS) expect(clean.checks[check], check).toBe(0);

    const accountB = (await companies(c, s.t, ['4999']))['4999']!;
    const kB = (await observeContract(s.t, accountB, 'kb')).contractId!;
    const k1 = (await observeContract(s.t, s.account, 'c1')).contractId!;
    const k2 = (await observeContract(s.t, s.account, 'c2')).contractId!;
    const l1 = await insertLine(c, s.t, s.account);
    const l2 = await insertLine(c, s.t, s.account, 'analytics');
    const l3 = await insertLine(c, s.t, s.account);
    const l4 = await insertLine(c, s.t, s.account);
    const l5 = await insertLine(c, s.t, s.account);
    const l6 = await insertLine(c, s.t, s.account);
    expect((await agreement(s.t, l5, 'c1')).contract).toBe('assigned');
    expect((await agreement(s.t, l6, 'c2')).contract).toBe('assigned');
    // l6: the operator clears the contract (held) — never drift.
    await step().assignContract(await human(s.t), { line: l6, target: null, reason: REASON });
    expect((await integrity.verify(s.t)).checks.commercial_agreement_contract_drift).toBe(0);
    // Owner tampering with the guards and triggers off (session_replication_role = replica).
    await c.sql(
      `SET session_replication_role = replica;
       UPDATE tenant_subscriptions SET contract_id = '${kB}' WHERE id = '${l1}';
       UPDATE tenant_subscriptions SET price_offer_id = '${s.offerId}' WHERE id = '${l2}';
       UPDATE tenant_contracts SET renews_contract_id = '${k2}' WHERE id = '${k1}';
       UPDATE tenant_contracts SET renews_contract_id = '${k1}' WHERE id = '${k2}';
       UPDATE tenant_contracts SET parent_contract_id = '${kB}' WHERE id = '${s.renewalId}';
       UPDATE tenant_subscriptions SET supersedes_line_id = '${l4}' WHERE id = '${l3}';
       UPDATE tenant_subscriptions SET supersedes_line_id = '${l3}' WHERE id = '${l4}';
       UPDATE tenant_subscriptions SET contract_id = NULL WHERE id = '${l5}';
       SET session_replication_role = origin;`,
    );
    const found = await integrity.verify(s.t);
    expect(of(found, 'commercial_line_contract_company_mismatch')).toEqual([l1]);
    expect(of(found, 'commercial_line_price_offer_product_mismatch')).toEqual([l2]);
    expect(of(found, 'commercial_contract_link_cycle')).toEqual([k1, k2].sort());
    expect(of(found, 'commercial_contract_link_cross_account')).toEqual([`${s.renewalId}/parent`]);
    expect(of(found, 'commercial_line_lineage_cycle')).toEqual([l3, l4].sort());
    expect(of(found, 'commercial_agreement_contract_drift')).toEqual([l5]);
    expect(found.outcome).toBe('findings');
    // Nothing repaired.
    const [row] = await c.sql<{ contract_id: string | null }>(
      `SELECT contract_id::text FROM tenant_subscriptions WHERE id = $1`,
      [l1],
    );
    expect(row!.contract_id).toBe(kB);
    // Drift is reported only with the module enabled.
    await setCommercial(s.t, false);
    expect((await integrity.verify(s.t)).checks.commercial_agreement_contract_drift).toBe(0);
  });

  it('V33: contract context_id needs module account_context (audited) and a context of the same account', async () => {
    const t = await tenant('cmctx');
    const [a, b] = Object.values(await companies(c, t, ['4801', '4802'])) as [string, string];
    await expect(
      contracts().write(await human(t), {
        account: a,
        context: randomUUID(),
        status: 'active',
        reason: REASON,
      }),
    ).rejects.toThrow(/module/i);
    expect((await auditOf(c, t, 'operation.denied')).at(-1)).toMatchObject({
      outcome: 'denied',
      reason_code: 'module_disabled',
    });
    await setModule(c, t, 'account_context', true);
    await publishContextTypes(c, t);
    const ctx = await observeContext(c, t, {
      companyId: a,
      record: 'rel-cm-ctx',
      dimensions: { product: 'core', region: 'emea' },
      name: 'Commercial context',
    });
    await expect(
      contracts().write(await human(t), {
        account: b,
        context: ctx.contextId!,
        status: 'active',
        reason: REASON,
      }),
    ).rejects.toThrow();
    const ok = await contracts().write(await human(t), {
      account: a,
      context: ctx.contextId!,
      status: 'active',
      reason: REASON,
    });
    const [row] = await c.sql<{ context_id: string | null }>(
      `SELECT context_id::text FROM tenant_contracts WHERE id = $1`,
      [ok.contractId],
    );
    expect(row!.context_id).toBe(ctx.contextId);
    expect(
      await c.sql(`SELECT 1 FROM tenant_contracts WHERE tenant_id = $1 AND company_id = $2`, [
        t.tenantId,
        b,
      ]),
    ).toHaveLength(0);
  });

  it('V19 race: a company merge racing contract writes on the merged account (two sessions) neither deadlocks nor leaves a contract on the merged company', async () => {
    for (let round = 0; round < 3; round += 1) {
      const t = await tenant(`cmmrace${round}`);
      const ids = await companies(c, t, [`47${round}1`, `47${round}2`]);
      const [survivor, loser] = [ids[`47${round}1`]!, ids[`47${round}2`]!];
      const k1 = (await observeContract(t, loser, `r${round}a`)).contractId!;
      const results = await Promise.allSettled([
        c.ingestion.ingestMerge(
          await sync(t),
          {
            kind: 'company',
            survivor: hs(`47${round}1`),
            merged: [hs(`47${round}2`)],
            observedAt: new Date(),
          },
          ingestMeta(),
        ),
        observeContract(t, loser, `r${round}b`, { links: { renews: SUB(`r${round}a`) } }),
        contracts().write(await human(t), {
          contract: k1,
          status: 'expired',
          reason: REASON,
        }),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') expect(String(r.reason)).not.toMatch(/deadlock|40P01/);
      }
      expect(results[0].status).toBe('fulfilled');
      const onLoser = await c.sql(
        `SELECT 1 FROM tenant_contracts WHERE tenant_id = $1 AND company_id = $2`,
        [t.tenantId, loser],
      );
      expect(onLoser).toHaveLength(0);
      const rows = await c.sql<{ company_id: string }>(
        `SELECT company_id::text FROM tenant_contracts WHERE tenant_id = $1`,
        [t.tenantId],
      );
      for (const row of rows) expect(row.company_id).toBe(survivor);
      const report = await c.app.get(IntegrityVerificationService).verify(t);
      expect(report.checks.commercial_contract_link_cross_account).toBe(0);
      expect(report.checks.commercial_line_contract_company_mismatch).toBe(0);
    }
  });
});
