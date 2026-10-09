import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConcurrencyConflictError,
  DuplicateTenantError,
  FlowSchema,
  IntegrationSystemSchema,
  RecordNotFoundError,
  TenantConfigError,
  TenantNotFoundError,
  TenantTemplateSchema,
  type TenantContext,
} from '../../src/modules/tenancy';
import { ProductModelInvalidError } from '../../src/modules/products';
import { PrismaTenantConfigRepository } from '../../src/modules/tenancy/infrastructure/prisma-tenant-config.repository';
import { startInfrastructure, withAdmin, type TestInfrastructure } from '../support/containers';
import { provisionTenant, startTenancy, uniqueSlug, type TenancyHarness } from '../support/tenancy';
import { authz, platformAuthz } from '../support/security';

describe('tenant provisioning and configuration rules', () => {
  let infra: TestInfrastructure;
  let h: TenancyHarness;
  let t: TenantContext;

  beforeAll(async () => {
    infra = await startInfrastructure();
    h = await startTenancy(infra.config);
    t = await provisionTenant(h, 'cfg');
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  describe('provisioning', () => {
    it('creates safe defaults: every integration disabled, every flow off, rules-only qualification', async () => {
      const integrations = await h.config.listIntegrations(t);
      expect(integrations.map((i) => i.system).sort()).toEqual(
        [...IntegrationSystemSchema.options].sort(),
      );
      expect(integrations.every((i) => i.access === 'disabled')).toBe(true);

      const flows = await h.config.listFlows(t);
      expect(flows.map((f) => f.flow).sort()).toEqual([...FlowSchema.options].sort());
      expect(flows.every((f) => f.mode === 'off')).toBe(true);

      await expect(h.config.getQualificationConfig(t)).resolves.toMatchObject({
        mode: 'rules',
        rulesetVersion: null,
        version: 1,
        settings: { jev: { minConfidence: 0.6 } },
      });
      await expect(h.config.getPolicy(t, 'sla')).resolves.toBeUndefined();
      await expect(h.credentials.list(t)).resolves.toEqual([]);
      // M8: every tenant can import subscriptions: its `import` connection exists.
      const connections = await withAdmin(infra.adminUrl, (db) =>
        db.query<{ kind: string; status: string; mapping_mode: string }>(
          'SELECT kind, status, mapping_mode FROM tenant_source_connections WHERE tenant_id = $1',
          [t.tenantId],
        ),
      );
      expect(connections.rows).toEqual([
        { kind: 'import', status: 'enabled', mapping_mode: 'code' },
      ]);
    });

    it('applies the Juniper template (values from the brief only)', async () => {
      const template = TenantTemplateSchema.parse(
        JSON.parse(readFileSync(resolve('config/tenant-templates/juniper.json'), 'utf8')),
      );
      const tenant = await h.registry.provision(platformAuthz('config.tenant.provision'), {
        slug: uniqueSlug('juniper'),
        name: 'Juniper Education',
        template,
      });
      const ctx = await h.contexts.forTenantId(tenant.id);

      await expect(h.config.getPolicy(ctx, 'sla')).resolves.toMatchObject({
        document: { responseMinutes: { hot: 60, warm: 1440, cold: 4320 } },
      });
      const sources = await h.config.listLeadSourceMappings(ctx, 'hubspot');
      expect(sources.map((s) => s.channel)).toContain('demo_request');
      expect(sources[0]).toMatchObject({ sourceValue: 'Checklist', priority: 10 });

      // Still safe: nothing enabled.
      expect((await h.config.listIntegrations(ctx)).every((i) => i.access === 'disabled')).toBe(
        true,
      );
    });

    it('rejects duplicate slugs and invalid input', async () => {
      const slug = uniqueSlug('dup');
      await h.registry.provision(platformAuthz('config.tenant.provision'), { slug, name: 'First' });
      await expect(
        h.registry.provision(platformAuthz('config.tenant.provision'), { slug, name: 'Second' }),
      ).rejects.toBeInstanceOf(DuplicateTenantError);
      await expect(
        h.registry.provision(platformAuthz('config.tenant.provision'), {
          slug: 'Bad-Slug',
          name: 'x',
        }),
      ).rejects.toBeInstanceOf(TenantConfigError);
      await expect(
        h.registry.provision(platformAuthz('config.tenant.provision'), {
          slug: uniqueSlug('ok'),
          name: '  ',
        }),
      ).rejects.toBeInstanceOf(TenantConfigError);
    });

    it('is atomic: a failure mid-provisioning leaves no tenant and no config behind', async () => {
      const slug = uniqueSlug('atomic');
      await expect(
        h.db.provision({ slug: slug as never, name: 'Atomic' }, async (tx) => {
          await h.app.get(PrismaTenantConfigRepository).saveFlow(tx, 'hubspot_enrichment', 'off');
          throw new Error('failure after the tenant row and a config row were written');
        }),
      ).rejects.toThrow('failure after');
      await expect(h.contexts.forSlug(slug)).rejects.toBeInstanceOf(TenantNotFoundError);
      const orphans = await withAdmin(infra.adminUrl, (db) =>
        db.query(
          'SELECT count(*)::int AS n FROM tenant_flow_settings WHERE tenant_id NOT IN (SELECT id FROM tenants)',
        ),
      );
      expect(orphans.rows[0]).toEqual({ n: 0 });
    });

    it('rejects an invalid template before writing anything', async () => {
      const slug = uniqueSlug('badtpl');
      await expect(
        h.registry.provision(platformAuthz('config.tenant.provision'), {
          slug,
          name: 'Bad',
          template: { policies: { sla: { responseMinutes: { hot: 0, warm: 1, cold: 1 } } } },
        }),
      ).rejects.toBeInstanceOf(TenantConfigError);
      await expect(h.contexts.forSlug(slug)).rejects.toBeInstanceOf(TenantNotFoundError);
    });

    it('enforces the lifecycle: offboarded is terminal', async () => {
      const ctx = await provisionTenant(h, 'life');
      await h.registry.offboard(platformAuthz('config.tenant.status'), ctx.tenantId);
      await expect(
        h.registry.reactivate(platformAuthz('config.tenant.status'), ctx.tenantId),
      ).rejects.toBeInstanceOf(TenantConfigError);
      await expect(h.contexts.forTenantId(ctx.tenantId)).rejects.toThrow(/offboarded/);
    });
  });

  describe('integrations and flows (coexistence / replacement)', () => {
    it('refuses to enable a flow whose integrations are not enabled', async () => {
      await expect(
        h.config.setFlowMode(
          await authz(t, 'config.integration'),
          'hubspot_to_sugar_handover',
          'active',
        ),
      ).rejects.toBeInstanceOf(TenantConfigError);
    });

    it('supports coexistence with an existing integration: read-only access is enough', async () => {
      await h.config.configureIntegration(await authz(t, 'config.integration'), 'hubspot', {
        access: 'read_only',
        settings: { portalId: '123456' },
      });
      await h.config.configureIntegration(await authz(t, 'config.integration'), 'sugar', {
        access: 'read_only',
      });
      // Enabling HubSpot registers its code-mapped source connection once; Sugar
      // needs an explicit, configured connection (never created implicitly).
      await h.config.configureIntegration(await authz(t, 'config.integration'), 'hubspot', {
        access: 'read_only',
      });
      const connections = await withAdmin(infra.adminUrl, (db) =>
        db.query<{ kind: string }>(
          'SELECT kind FROM tenant_source_connections WHERE tenant_id = $1 ORDER BY kind',
          [t.tenantId],
        ),
      );
      expect(connections.rows.map((r) => r.kind)).toEqual(['hubspot', 'import']);
      await expect(
        h.config.setFlowMode(
          await authz(t, 'config.integration'),
          'hubspot_to_sugar_handover',
          'coexist',
        ),
      ).resolves.toMatchObject({
        mode: 'coexist',
      });
      // Taking over (replacement) needs write access.
      await expect(
        h.config.setFlowMode(
          await authz(t, 'config.integration'),
          'hubspot_to_sugar_handover',
          'active',
        ),
      ).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.stringMatching(/needs hubspot access "read_write"/),
        ]),
      });
      await h.config.configureIntegration(await authz(t, 'config.integration'), 'hubspot', {
        access: 'read_write',
      });
      await h.config.configureIntegration(await authz(t, 'config.integration'), 'sugar', {
        access: 'read_write',
      });
      await expect(
        h.config.setFlowMode(
          await authz(t, 'config.integration'),
          'hubspot_to_sugar_handover',
          'active',
        ),
      ).resolves.toMatchObject({ mode: 'active' });
    });

    it('refuses to reduce access while a flow depends on it', async () => {
      await expect(
        h.config.configureIntegration(await authz(t, 'config.integration'), 'sugar', {
          access: 'read_only',
        }),
      ).rejects.toThrow(/other settings depend on it/);
      await h.config.setFlowMode(
        await authz(t, 'config.integration'),
        'hubspot_to_sugar_handover',
        'off',
      );
      await expect(
        h.config.configureIntegration(await authz(t, 'config.integration'), 'sugar', {
          access: 'disabled',
        }),
      ).resolves.toMatchObject({
        access: 'disabled',
      });
    });

    it('rejects modes a flow does not support, and unknown settings (no secrets in settings)', async () => {
      await expect(
        h.config.setFlowMode(
          await authz(t, 'config.integration'),
          'gainsight_lead_creation',
          'coexist',
        ),
      ).rejects.toMatchObject({
        issues: ['gainsight_lead_creation does not support mode "coexist"'],
      });
      await expect(
        h.config.configureIntegration(await authz(t, 'config.integration'), 'sugar', {
          access: 'disabled',
          settings: { password: 'hunter2' },
        }),
      ).rejects.toBeInstanceOf(TenantConfigError);
      await expect(
        h.config.configureIntegration(await authz(t, 'config.integration'), 'sugar', {
          access: 'disabled',
          settings: { baseUrl: 'http://insecure.example' },
        }),
      ).rejects.toBeInstanceOf(TenantConfigError);
    });

    it('keeps existing settings when only access changes, and versions each change', async () => {
      const before = await h.config.getIntegration(t, 'hubspot');
      const after = await h.config.configureIntegration(
        await authz(t, 'config.integration'),
        'hubspot',
        { access: 'read_only' },
      );
      expect(after.settings).toEqual({ portalId: '123456' });
      expect(after.version).toBe(before.version + 1);
    });
  });

  describe('qualification configuration', () => {
    it('jev and hybrid modes require the jev integration', async () => {
      const current = await h.config.getQualificationConfig(t);
      await expect(
        h.config.updateQualificationConfig(
          await authz(t, 'config.policy'),
          { mode: 'jev' },
          current.version,
        ),
      ).rejects.toThrow(/requires the jev integration/);
      await h.config.configureIntegration(await authz(t, 'config.integration'), 'jev', {
        access: 'read_only',
        settings: { endpoint: 'https://jev.example' },
      });
      await expect(
        h.config.updateQualificationConfig(
          await authz(t, 'config.policy'),
          { mode: 'hybrid', settings: { jev: { minConfidence: 0.75 } } },
          current.version,
        ),
      ).resolves.toMatchObject({
        mode: 'hybrid',
        version: current.version + 1,
        settings: { jev: { minConfidence: 0.75 } },
      });
    });

    it('detects stale updates (optimistic concurrency)', async () => {
      const current = await h.config.getQualificationConfig(t);
      await h.config.updateQualificationConfig(
        await authz(t, 'config.policy'),
        { mode: 'rules' },
        current.version,
      );
      await expect(
        h.config.updateQualificationConfig(
          await authz(t, 'config.policy'),
          { mode: 'jev' },
          current.version,
        ),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    });

    it('validates input', async () => {
      const current = await h.config.getQualificationConfig(t);
      await expect(
        h.config.updateQualificationConfig(
          await authz(t, 'config.policy'),
          { mode: 'rules', settings: { jev: { minConfidence: 2 } } },
          current.version,
        ),
      ).rejects.toBeInstanceOf(TenantConfigError);
      await expect(
        h.config.updateQualificationConfig(
          await authz(t, 'config.policy'),
          { mode: 'magic' } as never,
          current.version,
        ),
      ).rejects.toBeInstanceOf(TenantConfigError);
    });
  });

  describe('catalogue, mappings and policies', () => {
    it('lists the product catalogue as the projection of the published model', async () => {
      await h.catalogue.publish(
        await authz(t, 'config.product_model.publish'),
        {
          products: [
            { key: 'marketplace', name: 'Marketplace', description: 'Buying platform' },
            { key: 'legacy', name: 'Legacy', status: 'retired' },
          ],
        },
        { basedOnVersion: 0 },
      );
      await expect(h.config.listProducts(t, { activeOnly: true })).resolves.toEqual([
        { key: 'marketplace', name: 'Marketplace', description: 'Buying platform', active: true },
      ]);
      await expect(
        h.catalogue.publish(
          await authz(t, 'config.product_model.publish'),
          { products: [{ key: 'Bad Key', name: 'x' }] },
          { basedOnVersion: 1 },
        ),
      ).rejects.toBeInstanceOf(ProductModelInvalidError);
    });

    it('lead source mappings validate the channel against the source system', async () => {
      await expect(
        h.config.saveLeadSourceMapping(await authz(t, 'config.integration'), {
          system: 'gainsight_px',
          sourceProperty: 'event',
          matchType: 'equals',
          sourceValue: 'x',
          channel: 'demo_request',
        }),
      ).rejects.toBeInstanceOf(TenantConfigError);
      await expect(
        h.config.saveLeadSourceMapping(await authz(t, 'config.integration'), {
          system: 'gainsight_px',
          sourceProperty: 'event',
          matchType: 'equals',
          sourceValue: 'feature_adopted',
          channel: 'product_usage',
        }),
      ).resolves.toMatchObject({ channel: 'product_usage', priority: 100 });
    });

    it('policies are versioned with optimistic concurrency', async () => {
      const created = await h.config.savePolicy(await authz(t, 'config.policy'), 'sla', {
        responseMinutes: { hot: 60, warm: 1440, cold: 4320 },
      });
      expect(created.version).toBe(1);
      const updated = await h.config.savePolicy(
        await authz(t, 'config.policy'),
        'sla',
        { responseMinutes: { hot: 45, warm: 1440, cold: 4320 } },
        1,
      );
      expect(updated).toMatchObject({ version: 2, document: { responseMinutes: { hot: 45 } } });
      await expect(
        h.config.savePolicy(
          await authz(t, 'config.policy'),
          'sla',
          { responseMinutes: { hot: 30, warm: 1440, cold: 4320 } },
          1,
        ),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);
      await expect(
        h.config.savePolicy(await authz(t, 'config.policy'), 'routing', { placeholder: true }, 3),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
      await expect(
        h.config.savePolicy(await authz(t, 'config.policy'), 'sla', {
          responseMinutes: { hot: 60 },
        }),
      ).rejects.toBeInstanceOf(TenantConfigError);
    });

    it('credential names are validated and registration is idempotent', async () => {
      await expect(
        h.credentials.register(await authz(t, 'config.integration'), 'sugar', 'Bad Name'),
      ).rejects.toBeInstanceOf(TenantConfigError);
      const first = await h.credentials.register(
        await authz(t, 'config.integration'),
        'sugar',
        'password',
      );
      const again = await h.credentials.register(
        await authz(t, 'config.integration'),
        'sugar',
        'password',
      );
      expect(again).toEqual(first);
      expect(first.secretKey).toBe(`tenant.${t.tenantSlug}.sugar.password`);
      await expect(h.credentials.resolve(t, 'sugar', 'password')).rejects.toThrow(/not configured/);
      await expect(
        h.credentials.remove(await authz(t, 'config.integration'), 'sugar', 'password'),
      ).resolves.toBe(true);
      await expect(h.credentials.list(t)).resolves.toEqual([]);
    });
  });
});
