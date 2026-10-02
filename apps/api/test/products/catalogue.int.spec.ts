import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConcurrentPublishError,
  NoProductModelError,
  ProductModelInvalidError,
} from '../../src/modules/products';
import { tenantClient, type TenantContext } from '../../src/modules/tenancy';
import { startInfrastructure, withAdmin, type TestInfrastructure } from '../support/containers';
import { genericModel } from '../support/product-models';
import { provisionTenant, startTenancy, type TenancyHarness } from '../support/tenancy';

/**
 * M7 product catalogue (ADR 0016): immutable versions, atomic publish with the
 * `tenant_products` projection, version selection by effective time, key
 * permanence (K1–K4) and concurrent publication. Real PostgreSQL, app role.
 */
describe('product catalogue: versions, projection, publication', () => {
  let infra: TestInfrastructure;
  let h: TenancyHarness;

  beforeAll(async () => {
    infra = await startInfrastructure();
    h = await startTenancy(infra.config);
  });
  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  const admin = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    withAdmin(infra.adminUrl, async (db) => (await db.query<T>(text, params)).rows);
  const projection = (t: TenantContext) =>
    admin<{ key: string; active: boolean; family: string | null; model_version: number | null }>(
      'SELECT key, active, family, model_version FROM tenant_products WHERE tenant_id = $1 ORDER BY key',
      [t.tenantId],
    );

  it('publishes atomically: version, projection and selection by effective time', async () => {
    const t = await provisionTenant(h, 'cat');
    await expect(h.catalogue.modelAt(t, new Date())).resolves.toBeUndefined();
    const v1 = await h.catalogue.publish(t, genericModel(), {
      actor: 'ops:test',
      now: new Date('2026-01-01T00:00:00Z'),
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    expect(v1.version).toBe(1);
    expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const rows = await projection(t);
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.key === 'legacy-reports')).toEqual({
      key: 'legacy-reports',
      active: false,
      family: 'addons',
      model_version: 1,
    });

    // v2 retires `onprem`, effective in the future: v1 stays in force until then.
    const doc2 = genericModel({
      products: genericModel().products.map((p) =>
        p.key === 'onprem' ? { ...p, status: 'retired' as const } : p,
      ),
    });
    const future = new Date(Date.now() + 86_400_000);
    const v2 = await h.catalogue.publish(t, doc2, { actor: 'ops:test', effectiveFrom: future });
    expect(v2.version).toBe(2);
    expect((await h.catalogue.modelAt(t, new Date()))!.version).toBe(1);
    expect((await h.catalogue.modelAt(t, new Date(future.getTime() + 1)))!.version).toBe(2);
    expect(await h.catalogue.modelAt(t, new Date('2025-06-01T00:00:00Z'))).toBeUndefined();
    // The projection reflects the latest published version (retired row kept, never deleted).
    expect((await projection(t)).find((r) => r.key === 'onprem')).toMatchObject({
      active: false,
      model_version: 2,
    });
    await expect(h.catalogue.versions(t)).resolves.toHaveLength(2);
    const diff = await h.catalogue.diff(t, 1, 2);
    expect(diff).toMatchObject({
      productsAdded: [],
      productsChanged: [{ key: 'onprem', fields: ['status'] }],
    });
    await expect(
      h.catalogue.listProducts(t, { asOf: new Date(future.getTime() + 1) }),
    ).resolves.toMatchObject({ modelVersion: 2 });
    expect(NoProductModelError).toBeDefined();
  });

  it('stored versions are immutable and catalogue rows are never deleted, even with raw SQL', async () => {
    const t = await provisionTenant(h, 'imm');
    await h.catalogue.publish(t, genericModel(), { actor: 'ops:test' });
    const inT = <R>(work: (db: ReturnType<typeof tenantClient>) => Promise<R>) =>
      h.db.transaction(t, (tx) => work(tenantClient(tx)));
    await expect(
      inT((db) => db.$executeRaw`UPDATE tenant_product_models SET published_by = 'x'`),
    ).rejects.toThrow(/UPDATE on tenant_product_models is not allowed/);
    await expect(inT((db) => db.$executeRaw`DELETE FROM tenant_product_models`)).rejects.toThrow(
      /DELETE on tenant_product_models is not allowed/,
    );
    await expect(
      inT((db) => db.$executeRaw`DELETE FROM tenant_products WHERE key = 'core'`),
    ).rejects.toThrow(/DELETE on tenant_products is not allowed/);
    // A duplicate version number is refused by the key, not just by the service.
    await expect(
      inT(
        (db) =>
          db.$executeRaw`INSERT INTO tenant_product_models (tenant_id, version, document, content_hash, effective_from, published_by)
          SELECT tenant_id, version, document, content_hash, effective_from, 'dup' FROM tenant_product_models`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('a failed publish writes nothing; K1–K3 are enforced against the stored latest version', async () => {
    const t = await provisionTenant(h, 'kkk');
    await h.catalogue.publish(t, genericModel(), { actor: 'ops:test' });
    const before = await projection(t);
    const attempts: [unknown, string][] = [
      [
        genericModel({
          products: genericModel().products.filter((p) => p.key !== 'reporting'),
          relationships: genericModel().relationships!.filter(
            (r) => r.id !== 'suite-has-reporting',
          ),
        }),
        'product_key_removed',
      ],
      [
        genericModel({
          products: genericModel().products.map((p) =>
            p.key === 'core' ? { ...p, name: 'Core Renamed' } : p,
          ),
        }),
        'undeclared_rename',
      ],
      [
        genericModel({
          products: genericModel().products.map((p) =>
            p.key === 'legacy-reports' ? { ...p, status: 'active' as const } : p,
          ),
        }),
        'undeclared_reactivation',
      ],
      [
        genericModel({
          products: genericModel().products.map((p) =>
            p.key === 'legacy-reports' ? { ...p, family: 'platform' } : p,
          ),
        }),
        'retired_product_identity_change',
      ],
      [
        {
          products: [{ key: 'a', name: 'A' }],
          relationships: [{ id: 'r', type: 'requires', product: 'a', allOf: ['a'] }],
        },
        'unsupported_relationship_form',
      ],
    ];
    for (const [doc, code] of attempts) {
      const err = await h.catalogue.publish(t, doc, { actor: 'ops:test' }).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(ProductModelInvalidError);
      expect(
        (err as ProductModelInvalidError).errors.map((e) => e.code),
        code,
      ).toContain(code);
    }
    await expect(h.catalogue.versions(t)).resolves.toHaveLength(1);
    expect(await projection(t)).toEqual(before);
    const report = await h.catalogue.validate(t, attempts[0]![0]);
    expect(report).toMatchObject({ ok: false, latestVersion: 1, nextVersion: 2 });
  });

  it('the first model must keep catalogue rows created before M7 (K1 against the legacy projection)', async () => {
    const t = await provisionTenant(h, 'leg');
    await admin(
      `INSERT INTO tenant_products (tenant_id, key, name, active, updated_at) VALUES ($1, 'core', 'Core', true, now()), ($1, 'old', 'Old', false, now())`,
      [t.tenantId],
    );
    const err = await h.catalogue
      .publish(t, genericModel(), { actor: 'ops:test' })
      .catch((e: unknown) => e);
    expect((err as ProductModelInvalidError).errors.map((e) => e.code)).toContain(
      'product_key_removed',
    );
    const ok = await h.catalogue.publish(
      t,
      genericModel({
        products: [...genericModel().products, { key: 'old', name: 'Old', status: 'retired' }],
      }),
      { actor: 'ops:test' },
    );
    expect(ok.version).toBe(1);
  });

  it('concurrent publishes serialise: one version each, and an optimistic publish gets a clear conflict', async () => {
    const t = await provisionTenant(h, 'conc');
    await h.catalogue.publish(t, genericModel(), { actor: 'ops:test' });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        h.catalogue.publish(t, genericModel(), { actor: 'ops:test' }),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const versions = results
      .map((r) => (r as PromiseFulfilledResult<{ version: number }>).value.version)
      .sort();
    expect(versions).toEqual([2, 3, 4, 5, 6]);

    const optimistic = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        h.catalogue.publish(t, genericModel(), { actor: 'ops:test', basedOnVersion: 6 }),
      ),
    );
    expect(optimistic.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = optimistic.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => r.reason instanceof ConcurrentPublishError)).toBe(true);
    await expect(h.catalogue.versions(t)).resolves.toHaveLength(7);
  });

  it('a corrupt stored model fails loudly instead of being evaluated', async () => {
    const t = await provisionTenant(h, 'corrupt');
    await h.catalogue.publish(t, genericModel(), { actor: 'ops:test' });
    // Simulate corruption as the owner, bypassing the immutability trigger.
    await withAdmin(infra.adminUrl, async (db) => {
      await db.query('BEGIN');
      await db.query('ALTER TABLE tenant_product_models DISABLE TRIGGER USER');
      await db.query(
        `UPDATE tenant_product_models SET document = jsonb_set(document, '{relationships}', document->'relationships' || '[{"id":"loop","type":"requires","product":"core","anyOf":["analytics"]}]'::jsonb) WHERE tenant_id = $1`,
        [t.tenantId],
      );
      await db.query('ALTER TABLE tenant_product_models ENABLE TRIGGER USER');
      await db.query('COMMIT');
    });
    await expect(h.catalogue.modelAt(t, new Date())).rejects.toThrow(
      /corrupt|content hash|requires_cycle/i,
    );
  });

  it("tenants never see each other's catalogue versions", async () => {
    const a = await provisionTenant(h, 'cata');
    const b = await provisionTenant(h, 'catb');
    await h.catalogue.publish(b, genericModel(), { actor: 'ops:test' });
    await expect(h.catalogue.modelAt(a, new Date())).resolves.toBeUndefined();
    await expect(h.catalogue.versions(a)).resolves.toEqual([]);
    // Publishing in A does not see B's version as "previous" (no cross-tenant K1).
    await expect(
      h.catalogue.publish(a, { products: [{ key: 'x', name: 'X' }] }, { actor: 'ops:test' }),
    ).resolves.toMatchObject({ version: 1 });
  });
});
