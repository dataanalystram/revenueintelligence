import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M10F (ADR 0032, plan §13, Q27): price offers never affect ownership and
 * entitlements never affect eligibility — structurally. (1) The
 * dependency-cruiser rule exists and covers the products module and the pure
 * eligibility / coverage / holding domain files (CI runs `depcheck:boundaries`).
 * (2) Static scan: no source file of those areas imports the commercial module
 * or names a commercial table / column in a query (`tenant_price_offers`,
 * `tenant_entitlements`, `tenant_contracts`, `contract_id`, `price_offer_id`,
 * `supersedes_line_id`, or the Prisma model / field names). The line-sync port
 * (`LineAfterWrite`) is the only bridge and carries no commercial vocabulary.
 */
const SRC = resolve(__dirname, '..', '..');
const API = resolve(SRC, '..');

const GUARDED_DIRS = ['modules/products'];
const GUARDED_FILES = [
  'modules/domain/eligibility.ts',
  'modules/domain/coverage.ts',
  'modules/domain/holding-domain.ts',
];

/** Table / column names (SQL) and their Prisma model / field names. */
const FORBIDDEN = [
  /tenant_price_offers/,
  /tenant_entitlements/,
  /tenant_contracts/,
  /\bcontract_id\b/,
  /\bprice_offer_id\b/,
  /\bsupersedes_line_id\b/,
  /tenantPriceOffer/,
  /tenantEntitlement/,
  /tenantContract\b/,
  /\bcontractId\b/,
  /\bpriceOfferId\b/,
  /\bsupersedesLineId\b/,
  /modules\/commercial/,
  /from '\.\.\/\.\.\/commercial'/,
  /canonical\/commercial/,
];

function guardedSources(): string[] {
  const files: string[] = [...GUARDED_FILES];
  for (const dir of GUARDED_DIRS) {
    for (const f of readdirSync(resolve(SRC, dir), { recursive: true }) as string[]) {
      if (f.endsWith('.ts') && !f.endsWith('.spec.ts')) {
        files.push(`${dir}/${f.split(sep).join('/')}`);
      }
    }
  }
  return files.sort();
}

describe('M10F boundary: commercial never feeds ownership or eligibility (Q27)', () => {
  it('the dependency-cruiser rule forbids products and the eligibility / coverage / holding domain from importing commercial', () => {
    const config = createRequire(__filename)(resolve(API, '.dependency-cruiser.cjs')) as {
      forbidden: {
        name: string;
        severity: string;
        from: { path: string[] };
        to: { path: string[] };
      }[];
    };
    const rule = config.forbidden.find(
      (r) => r.name === 'commercial-never-feeds-ownership-or-eligibility',
    );
    expect(rule?.severity).toBe('error');
    const from = rule!.from.path.map((p) => new RegExp(p));
    const to = rule!.to.path.map((p) => new RegExp(p));
    for (const f of [
      'src/modules/products/application/eligibility.service.ts',
      'src/modules/products/application/subscription-ingestion.service.ts',
      'src/modules/domain/eligibility.ts',
      'src/modules/domain/coverage.ts',
      'src/modules/domain/holding-domain.ts',
    ]) {
      expect(from.some((r) => r.test(f))).toBe(true);
    }
    for (const t of [
      'src/modules/commercial/index.ts',
      'src/modules/commercial/application/commercial.read-model.ts',
      'src/modules/domain/canonical/commercial.ts',
    ]) {
      expect(to.some((r) => r.test(t))).toBe(true);
    }
  });

  it('static scan: no ownership / eligibility / coverage / holding source names a commercial table, column or module', () => {
    const files = guardedSources();
    expect(files.length).toBeGreaterThan(GUARDED_FILES.length);
    const hits = files.flatMap((f) => {
      const text = readFileSync(resolve(SRC, f), 'utf8');
      return FORBIDDEN.filter((re) => re.test(text)).map((re) => `${f}: ${re.source}`);
    });
    expect(hits).toEqual([]);
  });

  it('the scan would catch a planted reference (the scan is not vacuous)', () => {
    const planted = 'await tx.$queryRaw`SELECT price_offer_id FROM tenant_subscriptions`';
    expect(FORBIDDEN.some((re) => re.test(planted))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test("import { X } from '../../commercial';"))).toBe(true);
  });
});
