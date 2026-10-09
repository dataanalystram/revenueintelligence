import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveOwnership, indexProductModel } from '../../src/modules/domain';
import { EligibilityService } from '../../src/modules/products';
import { SubscriptionRunsStore } from '../../src/modules/products/infrastructure/subscription-runs.store';
import type { TenantContext } from '../../src/modules/tenancy';
import { chargebeeTestMapping, withoutState } from '../support/chargebee';
import { startContextHarness, type ContextHarness } from '../support/context';
import {
  acknowledgementsFor,
  mappingObjects,
  runProfile,
  runSync,
  sourcesServices,
  withoutTerms,
  withSnapshot,
  type SourcesFixture,
} from '../support/sources';

/**
 * M9B live gate (plan §22): the whole platform pipeline against the Chargebee
 * TEST site, read-only, on a local PostgreSQL. Records SANITIZED evidence only
 * (counts, codes, states). The product model and the ignored Legacy item are
 * TEST configuration derived from the site's own catalogue at run time.
 */
const SITE = process.env.CHARGEBEE_LIVE_SITE;
const KEY_A = 'TENANT_CBLIVE_CHARGEBEE_CHARGEBEE_API';
const KEY_B = 'TENANT_CBLIVE_CHARGEBEE_CHARGEBEE_NOCATALOG';
const OUT = process.env.CHARGEBEE_LIVE_REPORT;
const live = SITE && process.env[KEY_A] && process.env[KEY_B] ? describe : describe.skip;
// Raw, untrusted live JSON is inspected structurally only (sanitized evidence).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type E = Record<string, any>;
const fp = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);

async function raw(path: string): Promise<E[]> {
  const auth = `Basic ${Buffer.from(`${process.env[KEY_A]}:`).toString('base64')}`;
  const out: E[] = [];
  let off: string | undefined;
  do {
    const r = await fetch(
      `https://${SITE}.chargebee.com/api/v2${path}${path.includes('?') ? '&' : '?'}limit=100${off ? `&offset=${encodeURIComponent(off)}` : ''}`,
      { headers: { authorization: auth } },
    );
    const body = (await r.json()) as E;
    out.push(...(body.list as E[]));
    off = body.next_offset;
  } while (off);
  return out;
}

live('Chargebee TEST site — baseline live pipeline (M9B)', () => {
  let c: ContextHarness;
  const report: E = {};
  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    const text = JSON.stringify(report, null, 1);
    for (const env of [KEY_A, KEY_B]) expect(text).not.toContain(process.env[env]!);
    if (OUT) writeFileSync(OUT, text);
    console.error('BASELINE ' + text);
    await c?.close();
  });

  async function tenant(
    slug: string,
    keyEnv: string,
    config: E,
  ): Promise<SourcesFixture & { legacy: string[] }> {
    const s = sourcesServices(c);
    const t = await c.h.registry.provision({ slug, name: `Live ${slug}` });
    const ctx = await c.h.contexts.forTenantId(t.id);
    // In-process only: the tenant's credential name resolves to the given key.
    process.env[`TENANT_${slug.toUpperCase()}_CHARGEBEE_CHARGEBEE_API`] = process.env[keyEnv];
    const items = (await raw('/items')).map((e) => e.item as E);
    const legacy = items.filter((i) => /legacy/i.test(String(i.name))).map((i) => String(i.id));
    await c.h.catalogue.publish(
      ctx,
      {
        products: items
          .filter((i) => !legacy.includes(String(i.id)))
          .map((i) => ({
            key: `cb-${fp(String(i.id))}`,
            name: `Live test product ${fp(String(i.id)).slice(0, 4)}`,
            externalRefs: [{ system: 'chargebee' as const, objectType: 'Items', id: String(i.id) }],
          })),
        relationships: [],
      },
      { actor: 'live-test', basedOnVersion: 0 },
    );
    report.productModel = { modelled: items.length - legacy.length, ignoredLegacy: legacy.length };
    await c.h.credentials.register(ctx, 'chargebee', 'chargebee_api');
    const connection = await s.connections.configure(ctx, {
      kind: 'chargebee',
      label: 'Chargebee (live test site)',
      config: {
        site: SITE,
        rateLimitPerMinute: 60,
        maxRetries: 2,
        sync: { overlapMinutes: 10 },
        profile: { maxRows: 1000 },
        ...config,
      },
      credentialName: 'chargebee_api',
    });
    await s.connections.setStatus(ctx, connection.id, 'enabled');
    const f = {
      ctx,
      connectionId: connection.id,
      importConnectionId: (await s.connections.list(ctx)).find((x) => x.kind === 'import')!.id,
    };
    return Object.assign(f, { legacy });
  }

  async function publish(f: SourcesFixture & { legacy: string[] }, accept: boolean, key: string) {
    const s = sourcesServices(c);
    const captured = await s.snapshots.capture(f.ctx, f.connectionId, 'live-test');
    const latest = await s.snapshots.latest(f.ctx, f.connectionId);
    report[`${key}Schema`] = {
      sourceVersion: latest!.schema.sourceVersion,
      objects: latest!.schema.objects.map((o) => ({
        name: o.name,
        fields: o.fields.length,
        proof: o.capabilities.fullReadProof ?? (o.capabilities.count ? 'count' : 'none'),
        childOf: o.capabilities.childOf?.object ?? null,
        incrementalReads: o.capabilities.incrementalReads ?? 'allowed',
      })),
    };
    const base = chargebeeTestMapping((d) => {
      d.productReferences!.ignored = f.legacy.map((id) => ({ id, reason: 'test_not_offered' }));
    });
    const profiled = await runProfile(c, f, mappingObjects(base));
    const findings = await c.sql<{ code: string; n: number }>(
      `SELECT code, count(*)::int AS n FROM tenant_source_profile_findings WHERE tenant_id = $1 GROUP BY code ORDER BY code`,
      [f.ctx.tenantId],
    );
    report[`${key}Profile`] = {
      status: profiled.status,
      errorCode: profiled.errorCode ?? null,
      findings: Object.fromEntries(findings.map((r) => [r.code, r.n])),
    };
    const mapping = withSnapshot(base, captured.hash);
    const v1 = withoutState(withoutTerms(mapping));
    const r1 = await s.mappings.validate(f.ctx, f.connectionId, v1);
    report[`${key}ValidateV1`] = {
      ok: r1.ok,
      errors: [...new Set(r1.errors.map((e) => e.code))],
      warnings: [...new Set(r1.warnings.map((w) => w.code))],
    };
    await s.mappings.publish(f.ctx, f.connectionId, v1, {
      expectedBaseVersion: 0,
      actor: 'live-test',
      acknowledgements: acknowledgementsFor(r1),
    });
    const current = await s.authority.show(f.ctx);
    await s.authority.publish(
      f.ctx,
      {
        facts: {
          account_profile: null,
          person_profile: null,
          subscription_lines: f.connectionId,
          subscription_state: f.connectionId,
          subscription_terms: f.connectionId,
        },
      },
      {
        expectedBaseVersion: current!.version,
        actor: 'live-test',
        ...(accept
          ? { proofAcceptances: [{ connectionId: f.connectionId, reason: 'live test site' }] }
          : {}),
      },
    );
    const r2 = await s.mappings.validate(f.ctx, f.connectionId, mapping);
    report[`${key}ValidateV2`] = {
      ok: r2.ok,
      errors: [...new Set(r2.errors.map((e) => e.code))],
      warnings: [...new Set(r2.warnings.map((w) => w.code))],
    };
    await s.mappings.publish(f.ctx, f.connectionId, mapping, {
      expectedBaseVersion: 1,
      actor: 'live-test',
      acknowledgements: acknowledgementsFor(r2),
    });
  }

  const linesOf = (ctx: TenantContext) =>
    c.sql<{
      source_record_id: string;
      state: string;
      record_state: string;
      product_key: string;
      starts_at: Date | null;
      ends_at: Date | null;
      quantity: number | null;
      company_id: string;
    }>(
      `SELECT source_record_id, state, record_state, product_key, starts_at, ends_at, quantity, company_id
         FROM tenant_subscriptions WHERE tenant_id = $1 AND source_system = 'chargebee'`,
      [ctx.tenantId],
    );

  it('Key A: connection, schema, profile, publication and a stable full run', async () => {
    const s = sourcesServices(c);
    const f = await tenant('cblive', KEY_A, {});
    report.keyATest = await s.connections.test(f.ctx, f.connectionId);
    await publish(f, true, 'keyA');
    const run = await runSync(c, f, 'full');
    report.keyAFull = run;
    const again = await runSync(c, f, 'full');
    report.keyAFullRepeat = {
      status: again.status,
      proof: again.quality.proof ?? null,
      changed: (
        await c.sql<{ records_changed: number }>(
          `SELECT records_changed FROM tenant_sync_checkpoints WHERE id = $1`,
          [again.runId],
        )
      )[0]!.records_changed,
    };

    const subsRaw = (await raw('/subscriptions?include_deleted=true')).map(
      (e) => e.subscription as E,
    );
    const live = subsRaw.filter((x) => !x.deleted);
    const prices = new Map(
      (await raw('/item_prices')).map((e) => [
        String(e.item_price.id),
        String(e.item_price.item_id),
      ]),
    );
    const lines = await linesOf(f.ctx);
    const byKey = new Map(lines.map((l) => [l.source_record_id, l]));
    const expectedKeys = live.flatMap((x) =>
      (x.subscription_items as E[])
        .filter((i) => i.item_type !== 'charge')
        .map((i) => ({ key: `${x.id}:${i.item_price_id}`, sub: x, item: i })),
    );
    const reusedIds = new Set<string>(
      subsRaw
        .filter((x) => x.deleted)
        .map((x) => String(x.id))
        .filter((id) => live.some((l) => l.id === id)),
    );
    const STATE: E = {
      active: 'active',
      in_trial: 'trial',
      non_renewing: 'active',
      cancelled: 'cancelled',
      future: 'unknown',
      paused: 'unknown',
      transferred: 'unknown',
    };
    const check = expectedKeys.map(({ key, sub, item }) => {
      const l = byKey.get(key);
      const itemId = prices.get(String(item.item_price_id))!;
      return {
        sub: /_s\d\d$/.test(String(sub.id))
          ? String(sub.id).slice(-3).toUpperCase()
          : `other-${fp(String(sub.id)).slice(0, 4)}`,
        reusedId: reusedIds.has(String(sub.id)),
        written: !!l,
        statusIn: sub.status,
        stateOut: l?.state ?? null,
        stateAsMapped: l ? l.state === (STATE[sub.status] ?? 'unknown') : null,
        productResolved: l ? l.product_key === `cb-${fp(itemId)}` : null,
        ignoredProduct: f.legacy.includes(itemId),
        termsMatch: l
          ? (l.starts_at?.getTime() ?? null) ===
              (typeof sub.current_term_start === 'number' ? sub.current_term_start * 1000 : null) &&
            (l.ends_at?.getTime() ?? null) ===
              (typeof sub.current_term_end === 'number' ? sub.current_term_end * 1000 : null)
          : null,
        quantityMatch: l ? l.quantity === (item.quantity ?? null) : null,
      };
    });
    report.lineCheck = check;
    // Per-mutation evidence (sanitized): S02 parent change markers and its lines; key fingerprints.
    const s02 = live.find((x) => /_s02$/.test(String(x.id)));
    if (s02) {
      report.s02 = {
        parentUpdatedAt: s02.updated_at,
        parentResourceVersion: s02.resource_version,
        status: s02.status,
        lines: lines
          .filter((l) => l.source_record_id.startsWith(`${String(s02.id)}:`))
          .map((l) => ({
            keyFp: fp(l.source_record_id),
            productKey: l.product_key,
            itemType: (s02.subscription_items as E[]).find(
              (i) => `${String(s02.id)}:${String(i.item_price_id)}` === l.source_record_id,
            )?.item_type,
            quantity: l.quantity,
            state: l.state,
            recordState: l.record_state,
            termsMatchRaw:
              (l.starts_at?.getTime() ?? null) === s02.current_term_start * 1000 &&
              (l.ends_at?.getTime() ?? null) === s02.current_term_end * 1000,
          }))
          .sort((a, b) => String(a.itemType).localeCompare(String(b.itemType))),
      };
    }
    report.lineKeyFps = lines
      .map(
        (l) =>
          `${fp(l.source_record_id)}:${l.record_state}:${l.state}:${l.quantity}:${l.product_key}`,
      )
      .sort();
    report.lineSummary = {
      liveSubscriptions: live.length,
      deletedSubscriptionRecords: subsRaw.length - live.length,
      reusedIds: reusedIds.size,
      expectedNonChargeLines: expectedKeys.length,
      written: lines.length,
      active: lines.filter((l) => l.record_state === 'active').length,
      byState: lines.reduce((o: E, l) => ((o[l.state] = (o[l.state] ?? 0) + 1), o), {}),
      allKeysAreSubscriptionColonItemPrice: lines.every(
        (l) =>
          /^[^:]+:[^:]+$/.test(l.source_record_id) && prices.has(l.source_record_id.split(':')[1]!),
      ),
    };
    const gaps = await c.sql<{ reason: string; n: number }>(
      `SELECT reason, count(*)::int AS n FROM tenant_ownership_gaps WHERE tenant_id = $1 GROUP BY reason`,
      [f.ctx.tenantId],
    );
    report.gaps = Object.fromEntries(gaps.map((g) => [g.reason, g.n]));
    const runs = c.app.get(SubscriptionRunsStore);
    const cov = await c.h.db.transaction(f.ctx, (tx) => runs.coverage(tx));
    report.coverage = cov.known
      ? {
          known: true,
          tier: cov.coverageTier,
          method: cov.proof.method,
          accepted: cov.proof.acceptedInAuthorityVersion ?? null,
        }
      : cov;
    // Whitespace: the S01 customer's company.
    const s01 = live.find((x) => /_s01$/.test(String(x.id)));
    if (s01) {
      const company = (
        await c.sql<{ company_id: string }>(
          `SELECT company_id FROM company_external_refs WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers' AND external_id = $2`,
          [f.ctx.tenantId, s01.customer_id],
        )
      )[0]?.company_id;
      if (company) {
        const ws = await c.app.get(EligibilityService).whitespace(f.ctx, company);
        report.whitespaceS01 = {
          owned: ws.categories.owned.length,
          eligibleWhitespace: ws.categories.eligible_whitespace.length,
          unknown: (ws.categories as E).unknown?.length ?? null,
        };
      }
    }

    // Key B on the same connection: credential swapped (Key B's own env variable).
    await c.h.credentials.register(f.ctx, 'chargebee', 'chargebee_nocatalog');
    const conn = await s.connections.get(f.ctx, f.connectionId);
    await s.connections.configure(f.ctx, {
      kind: 'chargebee',
      label: conn.label,
      config: conn.config,
      credentialName: 'chargebee_nocatalog',
    });
    const before = (await linesOf(f.ctx)).filter((l) => l.record_state === 'active').length;
    const snapshotLines = async () =>
      JSON.stringify(
        (await linesOf(f.ctx))
          .map((l) => [l.source_record_id, l.state, l.record_state, l.quantity, l.product_key])
          .sort(),
      );
    const linesBeforeB = await snapshotLines();
    const covBefore = await c.h.db.transaction(f.ctx, (tx) => runs.coverage(tx));
    report.keyBTest = await s.connections.test(f.ctx, f.connectionId);
    const runB = await runSync(c, f, 'full');
    report.keyBFull = {
      status: runB.status,
      errorCode: runB.errorCode ?? null,
      proof: runB.quality.proof ?? null,
      tombstoned: runB.quality.tombstoned ?? 0,
    };
    report.keyBActiveLinesBeforeAfter = [
      before,
      (await linesOf(f.ctx)).filter((l) => l.record_state === 'active').length,
    ];
    const covAfter = await c.h.db.transaction(f.ctx, (tx) => runs.coverage(tx));
    report.keyBNoChange = {
      linesIdentical: (await snapshotLines()) === linesBeforeB,
      coverageUnchanged:
        covBefore.known && covAfter.known
          ? covBefore.proof.runId === covAfter.proof.runId &&
            covAfter.coverageTier === covBefore.coverageTier
          : covBefore.known === covAfter.known,
      changedRecords: (
        await c.sql<{ records_changed: number }>(
          `SELECT records_changed FROM tenant_sync_checkpoints WHERE id = $1`,
          [runB.runId],
        )
      )[0]!.records_changed,
    };
    const incr = await s.sync
      .start(f.ctx, f.connectionId, 'incremental', { enqueue: false, correlationId: randomUUID() })
      .then(() => 'started')
      .catch((e: { code?: string }) => e.code ?? 'error');
    report.incrementalStart = incr;
  }, 900_000);

  it('Pagination: page size 10 (>= 3 pages per pass) with the same TEST mapping', async () => {
    const f = await tenant('cblivepg', KEY_A, { pageSize: 10 });
    await publish(f, true, 'page10');
    const run = await runSync(c, f, 'full');
    report.page10Full = {
      status: run.status,
      errorCode: run.errorCode ?? null,
      proof: run.quality.proof ?? null,
      detail: (run.quality as E).read ?? null,
    };
    const pageLines = await linesOf(f.ctx);
    report.page10Lines = pageLines.length;
    report.page10DuplicateExternalId = run.quality.duplicate_external_id ?? 0;
    report.page10S02Lines = pageLines.filter((l) =>
      /_s02$/.test(l.source_record_id.split(':')[0]!),
    ).length;
    const again = await runSync(c, f, 'full');
    report.page10Repeat = { status: again.status, proof: again.quality.proof ?? null };
  }, 900_000);

  /**
   * M02 child reconciliation (G4) with a before -> after on the platform: run 1 replays S02's
   * pre-M02 child set (the live data plus the removed Support line, proven identical to the
   * post-M01 evidence by its key fingerprint); run 2 reads the live site unchanged.
   */
  const m02 = process.env.CHARGEBEE_M02_SUPPORT_FP ? it : it.skip;
  m02(
    'M02: G4 retires the removed Support line (replayed pre-M02 child set, then the live read)',
    async () => {
      const f = await tenant('cblivem02', KEY_A, {});
      await publish(f, true, 'm02');
      const subs = (await raw('/subscriptions')).map((e) => e.subscription as E);
      const s02 = subs.find((x) => /_s02$/.test(String(x.id)))!;
      const items = (await raw('/items')).map((e) => e.item as E);
      const support = items.find((i) => /support/i.test(String(i.name)) && i.type === 'addon')!;
      const prices = (await raw('/item_prices')).map((e) => e.item_price as E);
      const supportPrice = prices.find(
        (p) =>
          p.item_id === support.id &&
          p.currency_code === s02.currency_code &&
          p.period_unit === s02.billing_period_unit,
      )!;
      const supportKey = `${String(s02.id)}:${String(supportPrice.id)}`;
      const report02: E = {
        replayedSupportKeyMatchesPostM01: fp(supportKey) === process.env.CHARGEBEE_M02_SUPPORT_FP,
        liveS02Items: (s02.subscription_items as E[]).length,
        liveHasSupport: (s02.subscription_items as E[]).some(
          (i) => i.item_price_id === supportPrice.id,
        ),
      };
      const original = globalThis.fetch;
      globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const res = await original(input, init);
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (!url.pathname.endsWith('/api/v2/subscriptions') || !res.ok) return res;
        const body = (await res.json()) as E;
        for (const e of body.list as E[]) {
          if (e.subscription?.id === s02.id) {
            e.subscription.subscription_items = [
              ...(e.subscription.subscription_items as E[]),
              {
                item_price_id: supportPrice.id,
                item_type: 'addon',
                quantity: 1,
                object: 'subscription_item',
              },
            ];
          }
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      let before: Awaited<ReturnType<typeof runSync>>;
      try {
        before = await runSync(c, f, 'full');
      } finally {
        globalThis.fetch = original;
      }
      const s02Lines = async () =>
        (await linesOf(f.ctx))
          .filter((l) => l.source_record_id.startsWith(`${String(s02.id)}:`))
          .map((l) => ({
            keyFp: fp(l.source_record_id),
            support: l.source_record_id === supportKey,
            quantity: l.quantity,
            state: l.state,
            recordState: l.record_state,
            productKey: l.product_key,
            termsMatchRaw:
              (l.starts_at?.getTime() ?? null) === s02.current_term_start * 1000 &&
              (l.ends_at?.getTime() ?? null) === s02.current_term_end * 1000,
          }))
          .sort((a, b) => a.keyFp.localeCompare(b.keyFp));
      const allActive = async () =>
        (await linesOf(f.ctx))
          .filter((l) => l.record_state === 'active')
          .map((l) => fp(l.source_record_id))
          .sort();
      report02.run1 = { status: before.status, quality: before.quality };
      report02.s02Before = await s02Lines();
      const activeBefore = await allActive();
      const after = await runSync(c, f, 'full');
      report02.run2 = { status: after.status, quality: after.quality };
      report02.s02After = await s02Lines();
      const activeAfter = await allActive();
      report02.activeBeforeAfter = [activeBefore.length, activeAfter.length];
      report02.retiredKeys = activeBefore.filter((k) => !activeAfter.includes(k));
      report02.retiredOnlySupport =
        report02.retiredKeys.length === 1 && report02.retiredKeys[0] === fp(supportKey);
      const gaps = await c.sql<{ reason: string; n: number }>(
        `SELECT reason, count(*)::int AS n FROM tenant_ownership_gaps WHERE tenant_id = $1 GROUP BY reason`,
        [f.ctx.tenantId],
      );
      report02.gaps = Object.fromEntries(gaps.map((g) => [g.reason, g.n]));
      const runs = c.app.get(SubscriptionRunsStore);
      const cov = await c.h.db.transaction(f.ctx, (tx) => runs.coverage(tx));
      report02.coverage = cov.known
        ? {
            tier: cov.coverageTier,
            method: cov.proof.method,
            runIsLatest: cov.proof.runId === after.runId,
          }
        : cov;
      const company = (
        await c.sql<{ company_id: string }>(
          `SELECT company_id FROM company_external_refs WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers' AND external_id = $2`,
          [f.ctx.tenantId, s02.customer_id],
        )
      )[0]!.company_id;
      const ws = await c.app.get(EligibilityService).whitespace(f.ctx, company);
      report02.whitespaceS02 = {
        owned: ws.categories.owned.length,
        eligibleWhitespace: ws.categories.eligible_whitespace.length,
      };
      report02.parent = {
        updatedAt: s02.updated_at,
        resourceVersion: s02.resource_version,
        status: s02.status,
      };
      report.m02 = report02;
    },
    900_000,
  );

  /**
   * Generic live mutation check (M03+): run 1 replays the target subscription's pre-mutation item
   * list (CHARGEBEE_REPLAY_ITEMS, from the evidence recorded before the mutation), run 2 reads the
   * live site unchanged. Reports the target's lines before/after and every key that changed.
   */
  const replay =
    process.env.CHARGEBEE_REPLAY_SUB && process.env.CHARGEBEE_REPLAY_ITEMS ? it : it.skip;
  replay(
    'Mutation: replayed pre-mutation subscription, then the live read',
    async () => {
      const suffix = process.env.CHARGEBEE_REPLAY_SUB!;
      const preItems = JSON.parse(process.env.CHARGEBEE_REPLAY_ITEMS!) as E[];
      const parentOverrides = JSON.parse(process.env.CHARGEBEE_REPLAY_PARENT ?? '{}') as E;
      const evalProduct = process.env.CHARGEBEE_REPLAY_PRODUCT;
      const f = await tenant('cblivemut', KEY_A, {});
      await publish(f, true, 'mut');
      const target = (await raw('/subscriptions'))
        .map((e) => e.subscription as E)
        .find((x) => String(x.id).endsWith(`_${suffix}`))!;
      const prices = new Map(
        (await raw('/item_prices')).map((e) => [
          String(e.item_price.id),
          String(e.item_price.item_id),
        ]),
      );
      const original = globalThis.fetch;
      globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const res = await original(input, init);
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (!url.pathname.endsWith('/api/v2/subscriptions') || !res.ok) return res;
        const body = (await res.json()) as E;
        for (const e of body.list as E[]) {
          if (e.subscription?.id === target.id) {
            e.subscription.subscription_items = preItems;
            // Optional pre-mutation parent fields (null removes the attribute).
            for (const [k, v] of Object.entries(parentOverrides)) {
              if (v === null) delete e.subscription[k];
              else e.subscription[k] = v;
            }
          }
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      let run1: Awaited<ReturnType<typeof runSync>>;
      try {
        run1 = await runSync(c, f, 'full');
      } finally {
        globalThis.fetch = original;
      }
      const all = async () =>
        new Map(
          (await linesOf(f.ctx)).map((l) => [
            l.source_record_id,
            `${l.record_state}:${l.state}:${l.quantity}:${l.product_key}`,
          ]),
        );
      const targetLines = async () =>
        (await linesOf(f.ctx))
          .filter((l) => l.source_record_id.startsWith(`${String(target.id)}:`))
          .map((l) => {
            const price = l.source_record_id.slice(String(target.id).length + 1);
            return {
              keyFp: fp(l.source_record_id),
              priceFp: fp(price),
              itemFp: fp(prices.get(price) ?? 'unknown'),
              productKeyIsItem: l.product_key === `cb-${fp(prices.get(price) ?? 'unknown')}`,
              quantity: l.quantity,
              state: l.state,
              recordState: l.record_state,
              termsMatchRaw:
                (l.starts_at?.getTime() ?? null) === target.current_term_start * 1000 &&
                (l.ends_at?.getTime() ?? null) === target.current_term_end * 1000,
            };
          })
          .sort((a, b) => a.keyFp.localeCompare(b.keyFp));
      const before = await all();
      const companyOfTarget = async () =>
        (
          await c.sql<{ company_id: string }>(
            `SELECT company_id FROM company_external_refs WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers' AND external_id = $2`,
            [f.ctx.tenantId, target.customer_id],
          )
        )[0]!.company_id;
      const owned = async () => {
        const w = await c.app.get(EligibilityService).whitespace(f.ctx, await companyOfTarget());
        return {
          owned: w.categories.owned.map((x) => x.productKey).sort(),
          eligibleWhitespace: w.categories.eligible_whitespace.length,
        };
      };
      const ownedBefore = await owned();
      const evaluate = async () => {
        if (!evalProduct) return null;
        const r = await c.app
          .get(EligibilityService)
          .evaluate(f.ctx, await companyOfTarget(), `cb-${fp(evalProduct)}`);
        return {
          ownership: r.ownership,
          status: r.status,
          coverageTier: r.coverageTier,
          checks: r.checks.map((ch) => `${ch.check}:${ch.outcome}:${ch.reason ?? ''}`),
        };
      };
      const evalBefore = await evaluate();
      const out: E = {
        run1: { status: run1.status, quality: run1.quality },
        targetBefore: await targetLines(),
      };
      const run2 = await runSync(c, f, 'full');
      const after = await all();
      out.run2 = { status: run2.status, quality: run2.quality };
      out.targetAfter = await targetLines();
      out.changedKeys = [...new Set([...before.keys(), ...after.keys()])]
        .filter((k) => before.get(k) !== after.get(k))
        .map((k) => ({
          keyFp: fp(k),
          target: k.startsWith(`${String(target.id)}:`),
          before: before.get(k) ?? null,
          after: after.get(k) ?? null,
        }));
      out.activeBeforeAfter = [
        [...before.values()].filter((v) => v.startsWith('active:')).length,
        [...after.values()].filter((v) => v.startsWith('active:')).length,
      ];
      const gaps = await c.sql<{ reason: string; n: number }>(
        `SELECT reason, count(*)::int AS n FROM tenant_ownership_gaps WHERE tenant_id = $1 GROUP BY reason`,
        [f.ctx.tenantId],
      );
      out.gaps = Object.fromEntries(gaps.map((g) => [g.reason, g.n]));
      const runs = c.app.get(SubscriptionRunsStore);
      const cov = await c.h.db.transaction(f.ctx, (tx) => runs.coverage(tx));
      out.coverage = cov.known
        ? {
            tier: cov.coverageTier,
            method: cov.proof.method,
            runIsLatest: cov.proof.runId === run2.runId,
          }
        : cov;
      const company = (
        await c.sql<{ company_id: string }>(
          `SELECT company_id FROM company_external_refs WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers' AND external_id = $2`,
          [f.ctx.tenantId, target.customer_id],
        )
      )[0]!.company_id;
      const ws = await c.app.get(EligibilityService).whitespace(f.ctx, company);
      out.whitespaceTarget = {
        owned: ws.categories.owned.length,
        eligibleWhitespace: ws.categories.eligible_whitespace.length,
      };
      out.ownershipTransition = { before: ownedBefore, after: await owned() };
      // The target subscription's own lines, alone (another subscription of the same account
      // could otherwise decide ownership): pure platform ownership rule at "now".
      const modelRow = (
        await c.sql<{
          version: number;
          document: unknown;
          content_hash: string;
          effective_from: Date;
        }>(
          `SELECT version, document, content_hash, effective_from FROM tenant_product_models WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`,
          [f.ctx.tenantId],
        )
      )[0]!;
      const model = indexProductModel({
        version: modelRow.version,
        effectiveFrom: modelRow.effective_from,
        document: modelRow.document,
        contentHash: modelRow.content_hash,
      });
      const targetFacts = (
        await c.sql<{
          id: string;
          product_key: string;
          state: string;
          starts_at: Date | null;
          ends_at: Date | null;
          quantity: number | null;
          record_state: string;
          source_record_id: string;
        }>(
          `SELECT id, product_key, state, starts_at, ends_at, quantity, record_state, source_record_id FROM tenant_subscriptions WHERE tenant_id = $1 AND source_record_id LIKE $2`,
          [f.ctx.tenantId, `${String(target.id)}:%`],
        )
      ).filter((l) => l.record_state === 'active');
      const isolated = deriveOwnership(
        model,
        {
          coverage: 'known',
          coverageTier: 'stable_snapshot',
          knownAsOf: new Date(),
          subscriptions: targetFacts.map((l) => ({
            id: l.id,
            productKey: l.product_key,
            state: l.state,
            ...(l.starts_at ? { startsAt: l.starts_at } : {}),
            ...(l.ends_at ? { endsAt: l.ends_at } : {}),
            ...(l.quantity ? { quantity: l.quantity } : {}),
          })) as never,
        },
        new Date(),
      );
      out.isolatedTargetOwnership = targetFacts.map((l) => {
        const o = isolated.get(l.product_key as never);
        return { keyFp: fp(l.source_record_id), status: o?.status, reason: o?.reason };
      });
      out.evaluation = {
        product: evalProduct ? 'given' : null,
        before: evalBefore,
        after: await evaluate(),
      };
      out.targetCustomerSubscriptions = (await raw('/subscriptions'))
        .map((e) => e.subscription as E)
        .filter((x) => x.customer_id === target.customer_id)
        .map((x) =>
          /_s\d\d$/.test(String(x.id)) ? String(x.id).slice(-3).toUpperCase() : 'other',
        );
      // Read-only probe of the exact incremental window query the adapter would send.
      const since = Number(process.env.CHARGEBEE_REPLAY_SINCE ?? target.updated_at - 3600);
      const window = (
        await raw(
          `/subscriptions?updated_at[after]=${since - 1}&updated_at[before]=${Math.floor(Date.now() / 1000) + 1}&sort_by[asc]=updated_at`,
        )
      ).map((e) => e.subscription as E);
      out.incrementalWindowProbe = {
        sinceIsBeforeMutation: true,
        returned: window.length,
        includesTarget: window.some((x) => x.id === target.id),
        orderedByUpdatedAt: window.every(
          (x, n) => n === 0 || Number(x.updated_at) >= Number(window[n - 1]!.updated_at),
        ),
        allWithinWindow: window.every((x) => Number(x.updated_at) >= since - 1),
        labels: window.map((x) =>
          /_s\d\d$/.test(String(x.id)) ? String(x.id).slice(-3).toUpperCase() : 'other',
        ),
      };
      out.parent = {
        updatedAt: target.updated_at,
        resourceVersion: target.resource_version,
        status: target.status,
        liveItems: (target.subscription_items as E[]).map((i) => ({
          priceFp: fp(String(i.item_price_id)),
          itemFp: fp(prices.get(String(i.item_price_id)) ?? 'unknown'),
          quantity: i.quantity,
        })),
      };
      out.replayedItems = preItems.map((i) => ({
        priceFp: fp(String(i.item_price_id)),
        itemFp: fp(prices.get(String(i.item_price_id)) ?? 'unknown'),
        quantity: i.quantity,
      }));
      report.mutation = out;
    },
    900_000,
  );

  /**
   * M07 — safe full-run deletion. The pre-M07 S04 record is replayed from the deleted list row
   * (TEST REPLAY DATA ONLY, `deleted` forced false); the platform itself reads live records only.
   * Tenant without acceptance: absence alone must not retire. Then an acceptance is published and
   * the accepted full run (double enumeration) retires S04 exactly once via the tombstone pass,
   * while a structurally rejected S03 in the same run stays protected (seen-but-rejected).
   */
  const m07 = process.env.CHARGEBEE_M07 ? it : it.skip;
  m07(
    'M07: deleted S04 is retired only by the next accepted full run',
    async () => {
      const s = sourcesServices(c);
      const f = await tenant('cblivem07', KEY_A, {});
      await publish(f, false, 'm07');
      const all = (await raw('/subscriptions?include_deleted=true')).map(
        (e) => e.subscription as E,
      );
      const deleted04 = all.filter((x) => String(x.id).endsWith('_s04') && x.deleted === true);
      const live04 = all.filter((x) => String(x.id).endsWith('_s04') && x.deleted !== true);
      const id04 = String(deleted04[0]?.id ?? '');
      const auth = `Basic ${Buffer.from(`${process.env[KEY_A]}:`).toString('base64')}`;
      const get404 = async (q: string) =>
        (
          await fetch(
            `https://${SITE}.chargebee.com/api/v2/subscriptions/${encodeURIComponent(id04)}${q}`,
            {
              headers: { authorization: auth },
            },
          )
        ).status;
      const out: E = {
        source: {
          deletedRowsInIncludeDeletedList: deleted04.length,
          liveRecordsWithSameId: live04.length,
          absentFromNormalList: !(await raw('/subscriptions')).some(
            (e) => (e.subscription as E).id === id04,
          ),
          singleGet: await get404(''),
          singleGetIncludeDeleted: await get404('?include_deleted=true'),
          deletedRowStatus: deleted04[0]?.status ?? null,
          deletedRowItems: ((deleted04[0]?.subscription_items as E[]) ?? []).length,
        },
      };
      const replay04: E = { ...structuredClone(deleted04[0]!), deleted: false };
      const s03 = all.find((x) => String(x.id).endsWith('_s03') && x.deleted !== true)!;
      const queries: string[] = [];
      const original = globalThis.fetch;
      const patch = (opts: { inject04: boolean; reject03: boolean }) => {
        globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.hostname.endsWith('chargebee.com')) queries.push(url.search);
          const res = await original(input, init);
          if (!url.pathname.endsWith('/api/v2/subscriptions') || !res.ok) return res;
          const body = (await res.json()) as E;
          let list = body.list as E[];
          if (opts.reject03) {
            list = list.map((e) =>
              e.subscription?.id === s03.id
                ? { ...e, subscription: { ...e.subscription, customer_id: undefined } }
                : e,
            );
          }
          if (opts.inject04 && !body.next_offset && !url.searchParams.has('offset')) {
            // Single-page reads (page size 100): insert in created_at order.
            list = [...list, { subscription: replay04, customer: null }].sort(
              (a, b) => Number(a.subscription.created_at) - Number(b.subscription.created_at),
            );
          }
          return new Response(JSON.stringify({ ...body, list }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
      };
      const run = async (opts: { inject04: boolean; reject03: boolean }) => {
        patch(opts);
        try {
          return await runSync(c, f, 'full');
        } finally {
          globalThis.fetch = original;
        }
      };
      const snapshot = async () =>
        new Map(
          (await linesOf(f.ctx)).map((l) => [
            l.source_record_id,
            `${l.record_state}:${l.state}:${l.quantity}:${l.product_key}`,
          ]),
        );
      const s04Lines = async () =>
        (await linesOf(f.ctx))
          .filter((l) => l.source_record_id.startsWith(`${id04}:`))
          .map((l) => ({
            keyFp: fp(l.source_record_id),
            state: l.state,
            recordState: l.record_state,
            quantity: l.quantity,
          }));
      const diff = (a: Map<string, string>, b: Map<string, string>) =>
        [...new Set([...a.keys(), ...b.keys()])]
          .filter((k) => a.get(k) !== b.get(k))
          .map((k) => ({
            keyFp: fp(k),
            s04: k.startsWith(`${id04}:`),
            s03: k.startsWith(`${String(s03.id)}:`),
            before: a.get(k) ?? null,
            after: b.get(k) ?? null,
          }));
      const runs = c.app.get(SubscriptionRunsStore);
      const coverage = async () => {
        const cov = await c.h.db.transaction(f.ctx, (tx) => runs.coverage(tx));
        return cov.known ? { tier: cov.coverageTier, method: cov.proof.method } : cov;
      };
      // 1. Pre-M07 state (replayed S04).
      const r1 = await run({ inject04: true, reject03: false });
      const p1 = await snapshot();
      out.run1Replay = { status: r1.status, quality: r1.quality, s04: await s04Lines() };
      // 2. Live read without acceptance: absence alone must not retire.
      const r2 = await run({ inject04: false, reject03: false });
      const p2 = await snapshot();
      out.run2NoAcceptance = {
        status: r2.status,
        quality: r2.quality,
        s04: await s04Lines(),
        changed: diff(p1, p2),
        coverage: await coverage(),
      };
      // 3. Acceptance published; accepted full run, with S03 structurally rejected in the same run.
      const current = await s.authority.show(f.ctx);
      await s.authority.publish(f.ctx, current!.document, {
        expectedBaseVersion: current!.version,
        actor: 'live-test',
        proofAcceptances: [{ connectionId: f.connectionId, reason: 'live test site' }],
      });
      const r3 = await run({ inject04: false, reject03: true });
      const p3 = await snapshot();
      const gaps3 = await c.sql<{ reason: string; n: number }>(
        `SELECT reason, count(*)::int AS n FROM tenant_ownership_gaps WHERE tenant_id = $1 GROUP BY reason`,
        [f.ctx.tenantId],
      );
      out.run3Accepted = {
        status: r3.status,
        quality: r3.quality,
        s04: await s04Lines(),
        changed: diff(p2, p3),
        gaps: Object.fromEntries(gaps3.map((g) => [g.reason, g.n])),
        coverage: await coverage(),
      };
      // 4. Clean accepted rerun: nothing further retired (exactly once), S03 normal again.
      const r4 = await run({ inject04: false, reject03: false });
      const p4 = await snapshot();
      const gaps4 = await c.sql<{ reason: string; n: number }>(
        `SELECT reason, count(*)::int AS n FROM tenant_ownership_gaps WHERE tenant_id = $1 GROUP BY reason`,
        [f.ctx.tenantId],
      );
      out.run4Rerun = {
        status: r4.status,
        quality: r4.quality,
        changed: diff(p3, p4),
        gaps: Object.fromEntries(gaps4.map((g) => [g.reason, g.n])),
        coverage: await coverage(),
      };
      out.connectorNeverSentIncludeDeleted = !queries.some((q) => q.includes('include_deleted'));
      out.connectorRequests = queries.length;
      const company = (
        await c.sql<{ company_id: string }>(
          `SELECT company_id FROM company_external_refs WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers' AND external_id = $2`,
          [f.ctx.tenantId, replay04.customer_id],
        )
      )[0]?.company_id;
      if (company) {
        const ws = await c.app.get(EligibilityService).whitespace(f.ctx, company);
        out.whitespaceS04Account = {
          owned: ws.categories.owned.map((x) => x.productKey),
          eligibleWhitespace: ws.categories.eligible_whitespace.length,
        };
      }
      report.m07 = out;
    },
    900_000,
  );

  const m08 = process.env.CHARGEBEE_M08_CUSTOMER ? it : it.skip;
  m08(
    'M08: deleted customer + cascaded S09: line and customer reference retired only by the next accepted full run',
    async () => {
      const customer08 = process.env.CHARGEBEE_M08_CUSTOMER!;
      const s = sourcesServices(c);
      const f = await tenant('cblivem08', KEY_A, {});
      await publish(f, false, 'm08');
      const all = (await raw('/subscriptions?include_deleted=true')).map(
        (e) => e.subscription as E,
      );
      const deleted04 = all.filter((x) => String(x.id).endsWith('_s09') && x.deleted === true);
      const live04 = all.filter((x) => String(x.id).endsWith('_s09') && x.deleted !== true);
      const id04 = String(deleted04[0]?.id ?? '');
      const auth = `Basic ${Buffer.from(`${process.env[KEY_A]}:`).toString('base64')}`;
      const get404 = async (q: string) =>
        (
          await fetch(
            `https://${SITE}.chargebee.com/api/v2/subscriptions/${encodeURIComponent(id04)}${q}`,
            {
              headers: { authorization: auth },
            },
          )
        ).status;
      const out: E = {
        source: {
          deletedRowsInIncludeDeletedList: deleted04.length,
          liveRecordsWithSameId: live04.length,
          absentFromNormalList: !(await raw('/subscriptions')).some(
            (e) => (e.subscription as E).id === id04,
          ),
          singleGet: await get404(''),
          singleGetIncludeDeleted: await get404('?include_deleted=true'),
          deletedRowStatus: deleted04[0]?.status ?? null,
          deletedRowItems: ((deleted04[0]?.subscription_items as E[]) ?? []).length,
        },
      };
      const replay04: E = { ...structuredClone(deleted04[0]!), deleted: false };
      const customersAll = (await raw('/customers?include_deleted=true')).map(
        (e) => e.customer as E,
      );
      const deletedCustomer = customersAll.filter((x) => x.id === customer08 && x.deleted === true);
      out.source.customerDeletedRows = deletedCustomer.length;
      out.source.customerLiveRecords = customersAll.filter(
        (x) => x.id === customer08 && x.deleted !== true,
      ).length;
      out.source.customerAbsentFromNormalList = !(await raw('/customers')).some(
        (e) => (e.customer as E).id === customer08,
      );
      out.source.customerSingleGet = (
        await fetch(
          `https://${SITE}.chargebee.com/api/v2/customers/${encodeURIComponent(customer08)}`,
          {
            headers: { authorization: auth },
          },
        )
      ).status;
      out.source.subscriptionCustomerIsTarget = replay04.customer_id === customer08;
      out.source.deletionTimesAlignedSeconds = Math.abs(
        Number(deletedCustomer[0]?.updated_at) - Number(deleted04[0]?.updated_at),
      );
      const replayCustomer: E = { ...structuredClone(deletedCustomer[0]!), deleted: false };
      const s03 = all.find((x) => String(x.id).endsWith('_s03') && x.deleted !== true)!;
      const queries: string[] = [];
      const original = globalThis.fetch;
      const patch = (opts: { inject04: boolean; reject03: boolean }) => {
        globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.hostname.endsWith('chargebee.com')) queries.push(url.search);
          const res = await original(input, init);
          if (url.pathname.endsWith('/api/v2/customers') && res.ok && opts.inject04) {
            const cb = (await res.json()) as E;
            let cl = cb.list as E[];
            if (
              !cb.next_offset &&
              !url.searchParams.has('offset') &&
              !url.searchParams.has('id[in]')
            ) {
              cl = [...cl, { customer: replayCustomer }].sort(
                (x, y) => Number(x.customer.created_at) - Number(y.customer.created_at),
              );
            }
            return new Response(JSON.stringify({ ...cb, list: cl }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (!url.pathname.endsWith('/api/v2/subscriptions') || !res.ok) return res;
          const body = (await res.json()) as E;
          let list = body.list as E[];
          if (opts.reject03) {
            list = list.map((e) =>
              e.subscription?.id === s03.id
                ? { ...e, subscription: { ...e.subscription, customer_id: undefined } }
                : e,
            );
          }
          if (opts.inject04 && !body.next_offset && !url.searchParams.has('offset')) {
            // Single-page reads (page size 100): insert in created_at order.
            list = [...list, { subscription: replay04, customer: null }].sort(
              (a, b) => Number(a.subscription.created_at) - Number(b.subscription.created_at),
            );
          }
          return new Response(JSON.stringify({ ...body, list }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
      };
      const run = async (opts: { inject04: boolean; reject03: boolean }) => {
        patch(opts);
        try {
          return await runSync(c, f, 'full');
        } finally {
          globalThis.fetch = original;
        }
      };
      // Sanitized run labels (no run ids in the report).
      const runLabels = new Map<string, string>();
      const customerRef = async () =>
        (
          await c.sql<{
            state: string;
            deleted_at: Date | null;
            retired_at: Date | null;
            retired_by_run_id: string | null;
          }>(
            `SELECT state, deleted_at, retired_at, retired_by_run_id FROM company_external_refs WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers' AND external_id = $2`,
            [f.ctx.tenantId, customer08],
          )
        ).map((x) => ({
          present: true,
          state: x.state,
          retired: x.state === 'retired',
          deletedAt: x.deleted_at !== null,
          retiredAt: x.retired_at !== null,
          retiredBy:
            x.retired_by_run_id === null
              ? null
              : (runLabels.get(x.retired_by_run_id) ?? 'unknown_run'),
        }))[0] ?? { present: false };
      const companyRows = async () => {
        const rows = await c.sql<{ record_state: string }>(
          `SELECT co.record_state FROM companies co JOIN company_external_refs x ON x.tenant_id = co.tenant_id AND x.company_id = co.id WHERE x.tenant_id = $1 AND x.system = 'chargebee' AND x.external_id = $2`,
          [f.ctx.tenantId, customer08],
        );
        return { rows: rows.length, recordStates: rows.map((r) => r.record_state) };
      };
      const rowCounts = async () =>
        (
          await c.sql<{ companies: number; refs: number; lines: number; changes: number }>(
            `SELECT (SELECT count(*)::int FROM companies WHERE tenant_id = $1) AS companies,
                    (SELECT count(*)::int FROM company_external_refs WHERE tenant_id = $1) AS refs,
                    (SELECT count(*)::int FROM tenant_subscriptions WHERE tenant_id = $1) AS lines,
                    (SELECT count(*)::int FROM tenant_context_changes WHERE tenant_id = $1) AS changes`,
            [f.ctx.tenantId],
          )
        )[0]!;
      const otherRefs = async () =>
        new Map(
          (
            await c.sql<{ external_id: string; state: string; company_id: string }>(
              `SELECT external_id, state, company_id FROM company_external_refs WHERE tenant_id = $1 AND external_id <> $2`,
              [f.ctx.tenantId, customer08],
            )
          ).map((r) => [r.external_id, `${r.state}:${r.company_id}`]),
        );
      const refDiff = (a: Map<string, string>, b: Map<string, string>) => ({
        compared: new Set([...a.keys(), ...b.keys()]).size,
        changed: [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k))
          .length,
        allActive: [...b.values()].every((v) => v.startsWith('active:')),
      });
      const customerSnapshot = async () => ({
        ref: await customerRef(),
        company: await companyRows(),
        rows: await rowCounts(),
      });
      const snapshot = async () =>
        new Map(
          (await linesOf(f.ctx)).map((l) => [
            l.source_record_id,
            `${l.record_state}:${l.state}:${l.quantity}:${l.product_key}`,
          ]),
        );
      const s04Lines = async () =>
        (await linesOf(f.ctx))
          .filter((l) => l.source_record_id.startsWith(`${id04}:`))
          .map((l) => ({
            keyFp: fp(l.source_record_id),
            state: l.state,
            recordState: l.record_state,
            quantity: l.quantity,
          }));
      const diff = (a: Map<string, string>, b: Map<string, string>) =>
        [...new Set([...a.keys(), ...b.keys()])]
          .filter((k) => a.get(k) !== b.get(k))
          .map((k) => ({
            keyFp: fp(k),
            s04: k.startsWith(`${id04}:`),
            s03: k.startsWith(`${String(s03.id)}:`),
            before: a.get(k) ?? null,
            after: b.get(k) ?? null,
          }));
      const runs = c.app.get(SubscriptionRunsStore);
      const coverage = async () => {
        const cov = await c.h.db.transaction(f.ctx, (tx) => runs.coverage(tx));
        return cov.known ? { tier: cov.coverageTier, method: cov.proof.method } : cov;
      };
      // 1. Pre-M07 state (replayed S04).
      const r1 = await run({ inject04: true, reject03: false });
      runLabels.set(r1.runId, 'run1');
      const p1 = await snapshot();
      const o1 = await otherRefs();
      out.run1ReplayCustomer = await customerSnapshot();
      out.run1Replay = { status: r1.status, quality: r1.quality, s04: await s04Lines() };
      // 2. Live read without acceptance: absence alone must not retire.
      const r2 = await run({ inject04: false, reject03: false });
      runLabels.set(r2.runId, 'run2');
      const p2 = await snapshot();
      const o2 = await otherRefs();
      out.run2NoAcceptanceCustomer = { ...(await customerSnapshot()), otherRefs: refDiff(o1, o2) };
      out.run2NoAcceptance = {
        status: r2.status,
        quality: r2.quality,
        s04: await s04Lines(),
        changed: diff(p1, p2),
        coverage: await coverage(),
      };
      // 3. Acceptance published; accepted full run, with S03 structurally rejected in the same run.
      const current = await s.authority.show(f.ctx);
      await s.authority.publish(f.ctx, current!.document, {
        expectedBaseVersion: current!.version,
        actor: 'live-test',
        proofAcceptances: [{ connectionId: f.connectionId, reason: 'live test site' }],
      });
      const r3 = await run({ inject04: false, reject03: true });
      runLabels.set(r3.runId, 'run3');
      const p3 = await snapshot();
      const o3 = await otherRefs();
      const gaps3 = await c.sql<{ reason: string; n: number }>(
        `SELECT reason, count(*)::int AS n FROM tenant_ownership_gaps WHERE tenant_id = $1 GROUP BY reason`,
        [f.ctx.tenantId],
      );
      const provenance = await c.sql<{ change_type: string; changed_fields: string[] }>(
        `SELECT change_type, changed_fields FROM tenant_context_changes WHERE tenant_id = $1 AND source_object_type = 'Customers' AND source_record_id = $2 AND checkpoint_id = $3`,
        [f.ctx.tenantId, customer08, r3.runId],
      );
      out.run3AcceptedCustomer = {
        ...(await customerSnapshot()),
        otherRefs: refDiff(o2, o3),
        provenance,
      };
      out.run3Accepted = {
        status: r3.status,
        quality: r3.quality,
        s04: await s04Lines(),
        changed: diff(p2, p3),
        gaps: Object.fromEntries(gaps3.map((g) => [g.reason, g.n])),
        coverage: await coverage(),
      };
      // 4. Clean accepted rerun: nothing further retired (exactly once), S03 normal again.
      const r4 = await run({ inject04: false, reject03: false });
      runLabels.set(r4.runId, 'run4');
      const p4 = await snapshot();
      const o4 = await otherRefs();
      const gaps4 = await c.sql<{ reason: string; n: number }>(
        `SELECT reason, count(*)::int AS n FROM tenant_ownership_gaps WHERE tenant_id = $1 GROUP BY reason`,
        [f.ctx.tenantId],
      );
      out.run4RerunCustomer = {
        ...(await customerSnapshot()),
        otherRefs: refDiff(o3, o4),
        otherRefsRun1VsRun4: refDiff(o1, o4),
      };
      out.run4Rerun = {
        status: r4.status,
        quality: r4.quality,
        changed: diff(p3, p4),
        gaps: Object.fromEntries(gaps4.map((g) => [g.reason, g.n])),
        coverage: await coverage(),
      };
      out.connectorNeverSentIncludeDeleted = !queries.some((q) => q.includes('include_deleted'));
      out.connectorRequests = queries.length;
      const company = (
        await c.sql<{ company_id: string }>(
          `SELECT company_id FROM company_external_refs WHERE tenant_id = $1 AND system = 'chargebee' AND object_type = 'Customers' AND external_id = $2`,
          [f.ctx.tenantId, replay04.customer_id],
        )
      )[0]?.company_id;
      if (company) {
        const ws = await c.app.get(EligibilityService).whitespace(f.ctx, company);
        out.whitespaceS04Account = {
          owned: ws.categories.owned.map((x) => x.productKey),
          eligibleWhitespace: ws.categories.eligible_whitespace.length,
        };
      }
      report.m08 = out;
      // Governed correction: the reference retires only on the accepted run, the company stays.
      expect(out.connectorNeverSentIncludeDeleted).toBe(true);
      expect((out.run2NoAcceptanceCustomer as E).ref).toMatchObject({ state: 'active' });
      expect((out.run3AcceptedCustomer as E).ref).toMatchObject({
        state: 'retired',
        retiredBy: 'run3',
      });
      expect((out.run3AcceptedCustomer as E).company).toEqual({
        rows: 1,
        recordStates: ['active'],
      });
      expect((out.run4RerunCustomer as E).ref).toMatchObject({
        state: 'retired',
        retiredBy: 'run3',
      });
    },
    900_000,
  );
});
