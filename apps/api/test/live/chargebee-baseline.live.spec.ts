import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
