import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChargebeeConnectionConfigSchema } from '../../src/modules/chargebee';
import {
  ChargebeeHttpClient,
  type ChargebeePath,
} from '../../src/modules/chargebee/infrastructure/chargebee-http';
import { ListEnvelopeSchema } from '../../src/modules/chargebee/infrastructure/chargebee-schemas';

/**
 * M9B live gate, read-only raw probe of the Chargebee TEST site (plan §22).
 * Prints and writes SANITIZED evidence only: counts, field names, value
 * classes, codes. Never ids, names, emails, values or key material.
 * Requires CHARGEBEE_LIVE_SITE plus the two tenant secrets; skipped otherwise.
 */
const SITE = process.env.CHARGEBEE_LIVE_SITE;
const KEY_A = 'TENANT_CBLIVE_CHARGEBEE_CHARGEBEE_API';
const KEY_B = 'TENANT_CBLIVE_CHARGEBEE_CHARGEBEE_NOCATALOG';
const OUT = process.env.CHARGEBEE_LIVE_REPORT;
const live = SITE && process.env[KEY_A] && process.env[KEY_B] ? describe : describe.skip;

type Entry = Record<string, unknown>;
const secret = (env: string) => () => Promise.resolve({ reveal: () => process.env[env] ?? '' });

function client(env: string, key: string) {
  const config = ChargebeeConnectionConfigSchema.parse({
    site: SITE,
    rateLimitPerMinute: 60,
    maxRetries: 2,
  });
  return new ChargebeeHttpClient(config, key, secret(env));
}

async function listAll(
  c: ChargebeeHttpClient,
  path: ChargebeePath,
  wrap: string,
  extra: Record<string, string> = {},
  limit = 100,
) {
  const entries: Entry[] = [];
  const offsets: string[] = [];
  let offset: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const q = new URLSearchParams({ limit: String(limit), ...extra });
    if (offset) q.set('offset', offset);
    const res = await c.get(path, q, ListEnvelopeSchema);
    for (const e of res.list) entries.push(e[wrap] as Entry);
    if (!res.next_offset) break;
    offsets.push(res.next_offset);
    offset = res.next_offset;
  }
  return { entries, offsets };
}

const dist = (values: unknown[]) => {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
};
const keysOf = (rows: Entry[]) => [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
const idShape = (ids: string[]) => ({
  count: ids.length,
  unique: new Set(ids).size,
  minLength: Math.min(...ids.map((i) => i.length)),
  maxLength: Math.max(...ids.map((i) => i.length)),
  charset: ids.every((i) => /^[A-Za-z0-9_.@-]+$/.test(i)) ? '[A-Za-z0-9_.@-]' : 'OTHER',
  containsColon: ids.some((i) => i.includes(':')),
});
const SEC_MIN = 946_684_800;
const SEC_MAX = 4_102_444_800;
function timestampClasses(rows: Entry[], fields: string[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const f of fields) {
    out[f] = dist(
      rows.map((r) => {
        const v = r[f];
        if (v === undefined || v === null) return 'absent';
        if (typeof v !== 'number' || !Number.isInteger(v)) return typeof v;
        return v >= SEC_MIN && v < SEC_MAX
          ? 'unix_seconds'
          : v > 1e12
            ? 'milliseconds'
            : 'other_int';
      }),
    );
  }
  return out;
}
function offsetShape(o: string) {
  try {
    const parsed = JSON.parse(o) as unknown;
    return Array.isArray(parsed)
      ? `json_array[${parsed.length}](${parsed.map((x) => typeof x).join(',')})`
      : `json_${typeof parsed}`;
  } catch {
    return `opaque_string(len ${o.length})`;
  }
}

live('Chargebee TEST site — raw read-only probe (M9B live gate)', () => {
  it('collects sanitized baseline evidence with Key A and the Key B permission shape', async () => {
    const a = client(KEY_A, 'probe:a');
    const now = Math.floor(Date.now() / 1000);
    const report: Record<string, unknown> = {
      site: 'TEST',
      apiVersion: 'v2',
      observedAt: new Date().toISOString(),
    };

    // Catalogue.
    const items = await listAll(a, '/items', 'item');
    const prices = await listAll(a, '/item_prices', 'item_price');
    report.items = {
      ids: idShape(items.entries.map((i) => String(i.id))),
      type: dist(items.entries.map((i) => i.type)),
      status: dist(items.entries.map((i) => i.status)),
      fields: keysOf(items.entries),
    };
    report.itemPrices = {
      ids: idShape(prices.entries.map((i) => String(i.id))),
      itemType: dist(prices.entries.map((i) => i.item_type)),
      status: dist(prices.entries.map((i) => i.status)),
      currency: dist(prices.entries.map((i) => i.currency_code)),
      periodUnit: dist(prices.entries.map((i) => i.period_unit ?? 'none')),
      everyPriceHasKnownItem: prices.entries.every((p) =>
        items.entries.some((i) => i.id === p.item_id),
      ),
    };
    // V6: include_deleted on the catalogue lists.
    for (const [path, wrap] of [
      ['/items', 'item'],
      ['/item_prices', 'item_price'],
    ] as const) {
      try {
        const r = await listAll(a, path, wrap, { include_deleted: 'true' });
        report[`${wrap}IncludeDeleted`] = {
          accepted: true,
          count: r.entries.length,
          status: dist(r.entries.map((e) => e.status)),
          deletedFlag: dist(r.entries.map((e) => e.deleted ?? 'absent')),
        };
      } catch (err) {
        report[`${wrap}IncludeDeleted`] = { accepted: false, error: (err as Error).message };
      }
    }

    // Customers.
    const customers = await listAll(a, '/customers', 'customer', { include_deleted: 'true' });
    const customersLive = await listAll(a, '/customers', 'customer');
    report.customers = {
      ids: idShape(customers.entries.map((c) => String(c.id))),
      withIncludeDeleted: customers.entries.length,
      withoutIncludeDeleted: customersLive.entries.length,
      deletedFlag: dist(customers.entries.map((c) => c.deleted)),
      timestamps: timestampClasses(customers.entries, ['created_at', 'updated_at']),
      resourceVersion: dist(
        customers.entries.map((c) =>
          typeof c.resource_version === 'number' && c.resource_version > 1e12
            ? 'milliseconds'
            : 'other',
        ),
      ),
    };

    // Subscriptions.
    const subs = await listAll(a, '/subscriptions', 'subscription', { include_deleted: 'true' });
    const subsLive = await listAll(a, '/subscriptions', 'subscription');
    const s = subs.entries;
    const lines = s.flatMap((x) => (x.subscription_items as Entry[] | undefined) ?? []);
    const priceItem = new Map(prices.entries.map((p) => [String(p.id), String(p.item_id)]));
    report.subscriptions = {
      ids: idShape(s.map((x) => String(x.id))),
      withIncludeDeleted: s.length,
      withoutIncludeDeleted: subsLive.entries.length,
      deletedFlag: dist(s.map((x) => x.deleted)),
      status: dist(s.map((x) => x.status)),
      decommissioned: dist(s.map((x) => x.decommissioned ?? 'absent')),
      itemsPerSubscription: dist(s.map((x) => ((x.subscription_items as unknown[]) ?? []).length)),
      subscriptionItems: lines.length,
      lineItemType: dist(lines.map((l) => l.item_type)),
      everyLinePriceResolves: lines.every((l) => priceItem.has(String(l.item_price_id))),
      repeatedPriceInOneSubscription: s.some((x) => {
        const ids = ((x.subscription_items as Entry[]) ?? []).map((l) => l.item_price_id);
        return new Set(ids).size !== ids.length;
      }),
      repeatedItemInOneSubscription: s.some((x) => {
        const ids = ((x.subscription_items as Entry[]) ?? []).map((l) =>
          priceItem.get(String(l.item_price_id)),
        );
        return new Set(ids).size !== ids.length;
      }),
      timestamps: timestampClasses(s, [
        'created_at',
        'updated_at',
        'current_term_start',
        'current_term_end',
        'cancelled_at',
        'started_at',
        'trial_end',
        'next_billing_at',
      ]),
      resourceVersion: dist(
        s.map((x) =>
          typeof x.resource_version === 'number' && x.resource_version > 1e12
            ? 'milliseconds'
            : 'other',
        ),
      ),
      subscriptionFields: keysOf(s),
      lineFields: keysOf(lines),
      otherTopLevelKeysPerEntry: 'see raw list keys below',
    };
    // V4: terms of non-renewing and cancelled subscriptions.
    report.v4 = {
      nonRenewing: s
        .filter((x) => x.status === 'non_renewing')
        .map((x) => ({
          termEndInFuture: typeof x.current_term_end === 'number' && x.current_term_end > now,
          hasCancelledAt: typeof x.cancelled_at === 'number',
          cancelledAtEqualsTermEnd: x.cancelled_at === x.current_term_end,
        })),
      cancelled: s
        .filter((x) => x.status === 'cancelled')
        .map((x) => ({
          hasTermEnd: typeof x.current_term_end === 'number',
          termEndAtOrBeforeNow: typeof x.current_term_end === 'number' && x.current_term_end <= now,
          termEndVsCancelledAtSeconds:
            typeof x.current_term_end === 'number' && typeof x.cancelled_at === 'number'
              ? x.current_term_end - x.cancelled_at
              : null,
        })),
    };
    // S09 (synthetic id suffix only, never printed).
    const s09 = s.filter((x) => /s09$/.test(String(x.id)));
    report.s09 = s09.map((x) => ({
      status: x.status,
      lines: (x.subscription_items as unknown[]).length,
    }));

    // Top-level keys of a raw list entry (the card must be present-or-not; adapter drops it).
    const rawPage = await a.get(
      '/subscriptions',
      new URLSearchParams({ limit: '5' }),
      ListEnvelopeSchema,
    );
    report.subscriptionListEntryKeys = keysOf(rawPage.list);

    // V2: next_offset behaviour with a small page.
    const boundary = String(now + 1);
    const small = { 'created_at[before]': boundary, 'sort_by[asc]': 'created_at' };
    const pass1 = await listAll(
      a,
      '/subscriptions',
      'subscription',
      { ...small, include_deleted: 'true' },
      5,
    );
    const pass2 = await listAll(
      a,
      '/subscriptions',
      'subscription',
      { ...small, include_deleted: 'true' },
      5,
    );
    let replayStable: boolean | null = null;
    if (pass1.offsets[0]) {
      const q = new URLSearchParams({
        limit: '5',
        ...small,
        include_deleted: 'true',
        offset: pass1.offsets[0],
      });
      const r1 = await a.get('/subscriptions', q, ListEnvelopeSchema);
      const r2 = await a.get('/subscriptions', q, ListEnvelopeSchema);
      replayStable =
        JSON.stringify(r1.list.map((e) => (e.subscription as Entry).id)) ===
          JSON.stringify(r2.list.map((e) => (e.subscription as Entry).id)) &&
        r1.next_offset === r2.next_offset;
    }
    const ids1 = pass1.entries.map((e) => String(e.id));
    const ids2 = pass2.entries.map((e) => String(e.id));
    report.v2 = {
      pageSize: 5,
      pages: pass1.offsets.length + 1,
      offsetShapes: dist(pass1.offsets.map(offsetShape)),
      offsetsDistinct: new Set(pass1.offsets).size === pass1.offsets.length,
      sameOffsetsOnSecondPass: JSON.stringify(pass1.offsets) === JSON.stringify(pass2.offsets),
      replaySameOffsetSamePage: replayStable,
      noDuplicateAcrossPages: new Set(ids1).size === ids1.length,
      doubleEnumerationIdentical:
        ids1.length === ids2.length && ids1.every((i, n) => ids2[n] === i),
      orderedByCreatedAt: pass1.entries.every(
        (e, n) => n === 0 || Number(e.created_at) >= Number(pass1.entries[n - 1]!.created_at),
      ),
      fullListCount: s.length,
    };

    // Key B: raw shapes (status, error code, body keys only).
    const keyB = process.env[KEY_B] ?? '';
    const auth = `Basic ${Buffer.from(`${keyB}:`).toString('base64')}`;
    const shapes: Record<string, unknown> = {};
    for (const path of [
      '/customers',
      '/subscriptions',
      '/items',
      '/item_prices',
      '/item_families',
    ]) {
      const res = await fetch(`https://${SITE}.chargebee.com/api/v2${path}?limit=1`, {
        headers: { authorization: auth, accept: 'application/json' },
      });
      const body = (await res.json().catch(() => ({}))) as Entry;
      shapes[path] = {
        status: res.status,
        apiErrorCode: body.api_error_code ?? null,
        errorCode: body.error_code ?? null,
        type: body.type ?? null,
        bodyKeys: Object.keys(body).sort(),
        listed: Array.isArray(body.list) ? body.list.length : null,
      };
    }
    report.keyB = shapes;

    const text = JSON.stringify(report, null, 1);
    for (const env of [KEY_A, KEY_B]) expect(text).not.toContain(process.env[env]!);
    if (OUT) writeFileSync(OUT, text);
    console.error(text);
  }, 600_000);
});
