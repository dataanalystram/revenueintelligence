import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CompanyIdSchema,
  EmailAddressSchema,
  PersonIdSchema,
  ProductKeySchema,
  type ExternalRef,
} from '../../src/modules/domain';
import {
  InvalidReferenceError,
  InvalidTenantContextError,
  RecordNotFoundError,
  TenantContext,
  TenantInactiveError,
  TenantIsolationViolationError,
  TenantMismatchError,
  TenantNotFoundError,
  tenantClient,
  translateDatabaseError,
  UniqueConstraintError,
  type TenantTransaction,
} from '../../src/modules/tenancy';
import { PrismaService } from '../../src/platform/database';
import { startInfrastructure, withAdmin, type TestInfrastructure } from '../support/containers';
import {
  company,
  person,
  provisionTenant,
  startTenancy,
  type TenancyHarness,
} from '../support/tenancy';

describe('tenant data isolation (real PostgreSQL, app role, RLS)', () => {
  let infra: TestInfrastructure;
  let h: TenancyHarness;
  let a: TenantContext;
  let b: TenantContext;

  beforeAll(async () => {
    infra = await startInfrastructure();
    h = await startTenancy(infra.config);
    a = await provisionTenant(h, 'alpha');
    b = await provisionTenant(h, 'beta');
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  const inA = <T>(work: (tx: TenantTransaction) => Promise<T>) => h.db.transaction(a, work);
  const inB = <T>(work: (tx: TenantTransaction) => Promise<T>) => h.db.transaction(b, work);
  const newPersonId = () => PersonIdSchema.parse(randomUUID());
  const newCompanyId = () => CompanyIdSchema.parse(randomUUID());

  describe('reads', () => {
    it('Tenant A cannot read Tenant B records through repositories', async () => {
      const id = newPersonId();
      await inB((tx) => h.persons.save(tx, person(b.tenantId, id)));

      await expect(inA((tx) => h.persons.findById(tx, id))).resolves.toBeUndefined();
      await expect(inB((tx) => h.persons.findById(tx, id))).resolves.toMatchObject({ id });
    });

    it('Tenant A cannot read Tenant B records even with raw SQL inside its transaction', async () => {
      const id = newPersonId();
      await inB((tx) => h.persons.save(tx, person(b.tenantId, id)));
      const rows = await inA(
        (tx) =>
          tenantClient(tx).$queryRaw<
            { id: string }[]
          >`SELECT id FROM persons WHERE id = ${id}::uuid`,
      );
      expect(rows).toEqual([]);
      const all = await inA(
        (tx) =>
          tenantClient(tx).$queryRaw<
            { tenant_id: string }[]
          >`SELECT DISTINCT tenant_id::text FROM persons`,
      );
      expect(all.every((r) => r.tenant_id === a.tenantId)).toBe(true);
    });

    it('lookups by email and external ref only find the own tenant', async () => {
      const ref: ExternalRef = {
        system: 'hubspot',
        objectType: 'contacts',
        id: `c-${randomUUID()}`,
      };
      const email = EmailAddressSchema.parse(`shared-${randomUUID().slice(0, 8)}@school.example`);
      const idB = newPersonId();
      await inB((tx) =>
        h.persons.save(tx, person(b.tenantId, idB, { primaryEmail: email, externalRefs: [ref] })),
      );

      await expect(inA((tx) => h.persons.findByEmail(tx, email))).resolves.toBeUndefined();
      await expect(inA((tx) => h.persons.findByExternalRef(tx, ref))).resolves.toBeUndefined();
      await expect(inB((tx) => h.persons.findByExternalRef(tx, ref))).resolves.toMatchObject({
        id: idB,
      });
    });
  });

  describe('updates', () => {
    it("Tenant A cannot update Tenant B records: a save with B's id fails and B is untouched", async () => {
      const id = newPersonId();
      await inB((tx) => h.persons.save(tx, person(b.tenantId, id, { firstName: 'Original' })));

      // A tries to write a record with the same id (ids are globally unique, so this collides).
      await expect(
        inA((tx) => h.persons.save(tx, person(a.tenantId, id, { firstName: 'Hijacked' }))),
      ).rejects.toBeInstanceOf(UniqueConstraintError);
      await expect(inB((tx) => h.persons.findById(tx, id))).resolves.toMatchObject({
        firstName: 'Original',
      });
    });

    it('a repository refuses to save a record belonging to another tenant', async () => {
      await expect(
        inA((tx) => h.persons.save(tx, person(b.tenantId, newPersonId()))),
      ).rejects.toBeInstanceOf(TenantMismatchError);
    });

    it("raw UPDATE of another tenant's rows affects nothing", async () => {
      const id = newPersonId();
      await inB((tx) => h.persons.save(tx, person(b.tenantId, id, { firstName: 'Original' })));
      const affected = await inA(
        (tx) =>
          tenantClient(tx)
            .$executeRaw`UPDATE persons SET first_name = 'Hijacked' WHERE id = ${id}::uuid`,
      );
      expect(affected).toBe(0);
      await expect(inB((tx) => h.persons.findById(tx, id))).resolves.toMatchObject({
        firstName: 'Original',
      });
    });

    it('a row cannot be moved into another tenant', async () => {
      const id = newPersonId();
      await inA((tx) => h.persons.save(tx, person(a.tenantId, id)));
      await expect(
        inA(
          (tx) =>
            tenantClient(tx)
              .$executeRaw`UPDATE persons SET tenant_id = ${b.tenantId}::uuid WHERE id = ${id}::uuid`,
        ),
      ).rejects.toThrow();
    });

    it('inserting a row for another tenant is rejected by the database', async () => {
      await expect(
        inA(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_products (tenant_id, key, name, updated_at)
            VALUES (${b.tenantId}::uuid, 'smuggled', 'Smuggled', now())`,
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(h.config.listProducts(b)).resolves.toEqual([]);
    });

    it('translates an RLS rejection into TenantIsolationViolationError', async () => {
      const error = await inA((tx) =>
        tenantClient(tx).tenantProduct.create({
          data: { tenantId: b.tenantId, key: 'x', name: 'X' },
        }),
      ).catch((e: unknown) => e);
      expect(() => translateDatabaseError(error, 'product')).toThrow(TenantIsolationViolationError);
    });
  });

  describe('deletes', () => {
    it('Tenant A cannot delete Tenant B records', async () => {
      const id = newPersonId();
      await inB((tx) => h.persons.save(tx, person(b.tenantId, id)));

      await expect(inA((tx) => h.persons.delete(tx, id))).rejects.toBeInstanceOf(
        RecordNotFoundError,
      );
      const affected = await inA(
        (tx) => tenantClient(tx).$executeRaw`DELETE FROM persons WHERE id = ${id}::uuid`,
      );
      expect(affected).toBe(0);
      await expect(inB((tx) => h.persons.findById(tx, id))).resolves.toBeDefined();
    });

    it('config deletes are tenant-scoped', async () => {
      const mapping = await h.config.saveFieldMapping(a, {
        system: 'sugar',
        objectType: 'Leads',
        canonicalEntity: 'lead',
        canonicalField: 'stage',
        externalField: 'status',
        direction: 'bidirectional',
        status: 'proposed',
      });
      await expect(h.config.deleteFieldMapping(b, mapping.id)).resolves.toBe(false);
      await expect(h.config.listFieldMappings(a)).resolves.toHaveLength(1);
      await expect(h.config.deleteFieldMapping(a, mapping.id)).resolves.toBe(true);
    });
  });

  describe('external ids and unique constraints', () => {
    it('identical external IDs coexist in different tenants', async () => {
      const ref: ExternalRef = { system: 'hubspot', objectType: 'contacts', id: '501' };
      const idA = newPersonId();
      const idB = newPersonId();
      await inA((tx) => h.persons.save(tx, person(a.tenantId, idA, { externalRefs: [ref] })));
      await inB((tx) => h.persons.save(tx, person(b.tenantId, idB, { externalRefs: [ref] })));

      await expect(inA((tx) => h.persons.findByExternalRef(tx, ref))).resolves.toMatchObject({
        id: idA,
      });
      await expect(inB((tx) => h.persons.findByExternalRef(tx, ref))).resolves.toMatchObject({
        id: idB,
      });
    });

    it('an external ID maps to only one record within a tenant', async () => {
      const ref: ExternalRef = { system: 'sugar', objectType: 'Contacts', id: 'dup-1' };
      await inA((tx) =>
        h.persons.save(tx, person(a.tenantId, newPersonId(), { externalRefs: [ref] })),
      );
      await expect(
        inA((tx) => h.persons.save(tx, person(a.tenantId, newPersonId(), { externalRefs: [ref] }))),
      ).rejects.toBeInstanceOf(UniqueConstraintError);
    });

    it('email uniqueness is per tenant', async () => {
      const email = `head-${randomUUID().slice(0, 8)}@abc.example`;
      await inA((tx) =>
        h.persons.save(tx, person(a.tenantId, newPersonId(), { primaryEmail: email })),
      );
      await inB((tx) =>
        h.persons.save(tx, person(b.tenantId, newPersonId(), { primaryEmail: email })),
      );
      await expect(
        inA((tx) => h.persons.save(tx, person(a.tenantId, newPersonId(), { primaryEmail: email }))),
      ).rejects.toBeInstanceOf(UniqueConstraintError);
    });

    it('product keys and mapping keys are unique per tenant only', async () => {
      await h.config.saveProduct(a, { key: 'marketplace', name: 'Marketplace (A)' });
      await h.config.saveProduct(b, { key: 'marketplace', name: 'Marketplace (B)' });
      await h.config.saveProduct(a, { key: 'marketplace', name: 'Marketplace (A, renamed)' }); // upsert, not duplicate

      await expect(h.config.listProducts(a)).resolves.toEqual([
        expect.objectContaining({ key: 'marketplace', name: 'Marketplace (A, renamed)' }),
      ]);
      await expect(h.config.listProducts(b)).resolves.toEqual([
        expect.objectContaining({ key: 'marketplace', name: 'Marketplace (B)' }),
      ]);
    });
  });

  describe('relational integrity across tenants', () => {
    it("a person cannot be linked to another tenant's company", async () => {
      const companyB = newCompanyId();
      await inB((tx) => h.companies.save(tx, company(b.tenantId, companyB)));
      await expect(
        inA((tx) => h.persons.save(tx, person(a.tenantId, newPersonId(), { companyId: companyB }))),
      ).rejects.toBeInstanceOf(InvalidReferenceError);
    });

    it("a company can only own products from its own tenant's catalogue", async () => {
      await h.config.saveProduct(b, { key: 'portal', name: 'Portal' });
      await expect(
        inA((tx) =>
          h.companies.save(
            tx,
            company(a.tenantId, newCompanyId(), {
              products: [{ productKey: 'portal', status: 'active' }],
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(InvalidReferenceError);

      await h.config.saveProduct(a, { key: 'portal', name: 'Portal' });
      const saved = await inA((tx) =>
        h.companies.save(
          tx,
          company(a.tenantId, newCompanyId(), {
            products: [{ productKey: 'portal', status: 'active' }],
          }),
        ),
      );
      expect(saved.products).toEqual([{ productKey: 'portal', status: 'active' }]);
      // In use: the catalogue entry cannot be deleted.
      await expect(
        h.config.deleteProduct(a, ProductKeySchema.parse('portal')),
      ).rejects.toBeInstanceOf(InvalidReferenceError);
    });

    it('companies: lookups, updates and deletes are tenant-scoped', async () => {
      const ref: ExternalRef = { system: 'sugar', objectType: 'Accounts', id: 'acct-1' };
      const idA = newCompanyId();
      const idB = newCompanyId();
      await inA((tx) => h.companies.save(tx, company(a.tenantId, idA, { externalRefs: [ref] })));
      await inB((tx) => h.companies.save(tx, company(b.tenantId, idB, { externalRefs: [ref] })));

      await expect(inA((tx) => h.companies.findByExternalRef(tx, ref))).resolves.toMatchObject({
        id: idA,
      });
      await expect(inB((tx) => h.companies.findByExternalRef(tx, ref))).resolves.toMatchObject({
        id: idB,
      });
      await expect(inA((tx) => h.companies.findById(tx, idB))).resolves.toBeUndefined();
      await expect(inA((tx) => h.companies.delete(tx, idB))).rejects.toBeInstanceOf(
        RecordNotFoundError,
      );
      await expect(
        inA((tx) => h.companies.save(tx, company(b.tenantId, idB))),
      ).rejects.toBeInstanceOf(TenantMismatchError);

      // Update replaces refs and products; a company with people cannot be deleted.
      await inA((tx) =>
        h.companies.save(tx, company(a.tenantId, idA, { name: 'Renamed', externalRefs: [] })),
      );
      await expect(inA((tx) => h.companies.findById(tx, idA))).resolves.toMatchObject({
        name: 'Renamed',
        externalRefs: [],
      });
      await inA((tx) => h.persons.save(tx, person(a.tenantId, newPersonId(), { companyId: idA })));
      await expect(inA((tx) => h.companies.delete(tx, idA))).rejects.toBeInstanceOf(
        InvalidReferenceError,
      );
      await expect(inB((tx) => h.companies.delete(tx, idB))).resolves.toBeUndefined();
      await expect(inB((tx) => h.companies.findById(tx, idB))).resolves.toBeUndefined();
    });

    it('the platform registry lists tenants; tenant transactions cannot', async () => {
      const all = await h.registry.list('active');
      expect(all.map((t) => t.id)).toEqual(expect.arrayContaining([a.tenantId, b.tenantId]));
      await expect(h.registry.get(a.tenantId)).resolves.toMatchObject({ slug: a.tenantSlug });
    });

    it('round-trips a full person and company', async () => {
      const companyId = newCompanyId();
      const personId = newPersonId();
      await h.config.saveProduct(a, { key: 'mis', name: 'MIS' });
      const c = company(a.tenantId, companyId, {
        domains: ['abc.sch.uk'],
        customerStatus: 'customer',
        products: [
          { productKey: 'mis', status: 'active', since: new Date('2025-01-01T00:00:00Z') },
        ],
        externalRefs: [{ system: 'gainsight_cs', objectType: 'Company', id: 'gs-1' }],
      });
      const p = person(a.tenantId, personId, {
        firstName: 'Sarah',
        lastName: 'Jones',
        jobTitle: 'Head teacher',
        companyId,
        roles: ['decision_maker'],
        additionalEmails: ['sarah@home.example'],
        externalRefs: [{ system: 'hubspot', objectType: 'contacts', id: 'rt-1' }],
      });
      await inA(async (tx) => {
        await h.companies.save(tx, c);
        await h.persons.save(tx, p);
      });
      await expect(inA((tx) => h.companies.findById(tx, companyId))).resolves.toEqual(c);
      await expect(inA((tx) => h.persons.findById(tx, personId))).resolves.toEqual(p);
    });
  });

  describe('credentials and configuration', () => {
    it('credentials cannot be resolved across tenants', async () => {
      process.env[`TENANT_${a.tenantSlug.toUpperCase()}_HUBSPOT_REFRESH_TOKEN`] = 'token-for-a';
      process.env[`TENANT_${b.tenantSlug.toUpperCase()}_HUBSPOT_REFRESH_TOKEN`] = 'token-for-b';
      await h.credentials.register(a, 'hubspot', 'refresh_token');

      await expect(h.credentials.resolve(a, 'hubspot', 'refresh_token')).resolves.toMatchObject({});
      expect((await h.credentials.resolve(a, 'hubspot', 'refresh_token')).reveal()).toBe(
        'token-for-a',
      );
      // B has a secret in the environment but no reference registered: it cannot resolve anything.
      await expect(h.credentials.resolve(b, 'hubspot', 'refresh_token')).rejects.toBeInstanceOf(
        RecordNotFoundError,
      );

      await h.credentials.register(b, 'hubspot', 'refresh_token');
      expect((await h.credentials.resolve(b, 'hubspot', 'refresh_token')).reveal()).toBe(
        'token-for-b',
      );
    });

    it("a credential reference can never point at another tenant's secret (database CHECK)", async () => {
      await expect(
        inA(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_credential_refs (tenant_id, tenant_slug, system, name, secret_key, updated_at)
            VALUES (${a.tenantId}::uuid, ${a.tenantSlug}, 'sugar', 'password',
                    ${`tenant.${b.tenantSlug}.sugar.password`}, now())`,
        ),
      ).rejects.toThrow(/tenant_credential_refs_key_owned/);
      // Nor can A claim B's slug to get around the check.
      await expect(
        inA(
          (tx) =>
            tenantClient(tx).$executeRaw`
            INSERT INTO tenant_credential_refs (tenant_id, tenant_slug, system, name, secret_key, updated_at)
            VALUES (${a.tenantId}::uuid, ${b.tenantSlug}, 'sugar', 'password',
                    ${`tenant.${b.tenantSlug}.sugar.password`}, now())`,
        ),
      ).rejects.toThrow();
    });

    it('qualification mode is isolated per tenant', async () => {
      await h.config.configureIntegration(b, 'jev', { access: 'read_only' });
      const current = await h.config.getQualificationConfig(b);
      await h.config.updateQualificationConfig(b, { mode: 'hybrid' }, current.version);

      await expect(h.config.getQualificationConfig(a)).resolves.toMatchObject({ mode: 'rules' });
      await expect(h.config.getQualificationConfig(b)).resolves.toMatchObject({ mode: 'hybrid' });
    });

    it('field mappings and lead source mappings are isolated per tenant', async () => {
      await h.config.saveFieldMapping(b, {
        system: 'sugar',
        objectType: 'Leads',
        canonicalEntity: 'lead',
        canonicalField: 'temperature',
        externalField: null,
        direction: 'bidirectional',
        status: 'tbc',
      });
      await h.config.saveLeadSourceMapping(b, {
        system: 'hubspot',
        sourceProperty: 'recent_conversion',
        matchType: 'contains',
        sourceValue: 'Demo',
        channel: 'demo_request',
      });
      expect(
        (await h.config.listFieldMappings(a)).some((m) => m.canonicalField === 'temperature'),
      ).toBe(false);
      await expect(h.config.listLeadSourceMappings(a)).resolves.toEqual([]);
      await expect(h.config.listLeadSourceMappings(b)).resolves.toHaveLength(1);
    });

    it('integration settings and policies are isolated per tenant', async () => {
      await h.config.configureIntegration(b, 'sugar', {
        access: 'read_only',
        settings: { baseUrl: 'https://beta.sugarondemand.example', apiVersion: 'v11_20' },
      });
      await h.config.savePolicy(b, 'sla', { responseMinutes: { hot: 30, warm: 600, cold: 2000 } });

      await expect(h.config.getIntegration(a, 'sugar')).resolves.toMatchObject({
        access: 'disabled',
        settings: {},
      });
      await expect(h.config.getPolicy(a, 'sla')).resolves.toBeUndefined();
      await expect(h.config.getPolicy(b, 'sla')).resolves.toMatchObject({
        document: { responseMinutes: { hot: 30 } },
      });
    });
  });

  describe('tenant context', () => {
    it('refuses a forged context', async () => {
      const forged = { tenantId: a.tenantId, tenantSlug: a.tenantSlug } as unknown as TenantContext;
      await expect(h.db.transaction(forged, () => Promise.resolve(1))).rejects.toBeInstanceOf(
        InvalidTenantContextError,
      );
      const spoofed = Object.create(TenantContext.prototype) as TenantContext;
      await expect(h.config.listProducts(spoofed)).rejects.toBeInstanceOf(
        InvalidTenantContextError,
      );
    });

    it('refuses a missing context', async () => {
      await expect(
        h.db.transaction(undefined as unknown as TenantContext, () => Promise.resolve(1)),
      ).rejects.toBeInstanceOf(InvalidTenantContextError);
    });

    it('refuses unknown or malformed tenants', async () => {
      await expect(h.contexts.forTenantId(randomUUID())).rejects.toBeInstanceOf(
        TenantNotFoundError,
      );
      await expect(h.contexts.forTenantId('juniper')).rejects.toBeInstanceOf(
        InvalidTenantContextError,
      );
      await expect(h.contexts.forSlug('Not A Slug')).rejects.toBeInstanceOf(
        InvalidTenantContextError,
      );
      await expect(h.contexts.forSlug('nosuchtenant')).rejects.toBeInstanceOf(TenantNotFoundError);
    });

    it('a transaction handle cannot be used after its transaction ends', async () => {
      let leaked: TenantTransaction | undefined;
      await inA((tx) => {
        leaked = tx;
        return Promise.resolve();
      });
      await expect(h.persons.findById(leaked!, newPersonId())).rejects.toBeInstanceOf(
        InvalidTenantContextError,
      );
    });

    it('suspension takes effect immediately, even for contexts already issued', async () => {
      const c = await provisionTenant(h, 'susp');
      await h.registry.suspend(c.tenantId);
      await expect(h.config.listProducts(c)).rejects.toBeInstanceOf(TenantInactiveError);
      await expect(h.contexts.forTenantId(c.tenantId)).rejects.toBeInstanceOf(TenantInactiveError);
      await h.registry.reactivate(c.tenantId);
      await expect(h.config.listProducts(c)).resolves.toEqual([]);
    });

    it('with no tenant set, tenant-owned data is invisible to the app role', async () => {
      await withAdmin(infra.config.databaseUrl, async (db) => {
        const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM persons');
        expect(rows[0]?.n).toBe('0');
        await expect(
          db.query(
            `INSERT INTO tenant_products (tenant_id, key, name, updated_at) VALUES ($1, 'x', 'X', now())`,
            [a.tenantId],
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });

    it('inside a tenant transaction only the own tenant is visible in the registry, and it is read-only', async () => {
      const visible = await inA(
        (tx) => tenantClient(tx).$queryRaw<{ id: string }[]>`SELECT id::text FROM tenants`,
      );
      expect(visible).toEqual([{ id: a.tenantId }]);
      await expect(
        inA(
          (tx) =>
            tenantClient(tx)
              .$executeRaw`UPDATE tenants SET name = 'x' WHERE id = ${a.tenantId}::uuid`,
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        inA(
          (tx) =>
            tenantClient(tx)
              .$executeRaw`UPDATE tenants SET name = 'x' WHERE id = ${b.tenantId}::uuid`,
        ),
      ).resolves.toBe(0);
    });
  });

  describe('transactions', () => {
    it('roll back all writes of a failed tenant transaction', async () => {
      const id = newPersonId();
      await expect(
        inA(async (tx) => {
          await h.persons.save(tx, person(a.tenantId, id));
          await h.config.saveProduct(a, { key: 'rolled', name: 'Separate transaction' }); // own tx: commits
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await expect(inA((tx) => h.persons.findById(tx, id))).resolves.toBeUndefined();
      // Service methods open their own transaction, so that write committed independently.
      // Atomic multi-step work therefore composes repositories inside one TenantDatabase.transaction.
      await expect(h.config.listProducts(a)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'rolled' })]),
      );
    });

    it('the tenant setting does not leak to later work on pooled connections', async () => {
      for (let i = 0; i < 5; i++) {
        await inA((tx) => tenantClient(tx).$queryRaw`SELECT 1`);
      }
      const rows = await withAdmin(infra.config.databaseUrl, (db) =>
        db.query<{ t: string | null }>(`SELECT current_setting('app.current_tenant', true) AS t`),
      );
      expect(rows.rows[0]?.t ?? '').toBe('');
      // And through the application's own pool, outside a tenant transaction:
      const prisma = h.app.get(PrismaService);
      const results = await Promise.all(
        Array.from(
          { length: 10 },
          () =>
            prisma.$queryRaw<
              { t: string | null }[]
            >`SELECT current_setting('app.current_tenant', true) AS t`,
        ),
      );
      expect(results.every((r) => (r[0]?.t ?? '') === '')).toBe(true);
    });

    it("stores every row with the transaction's tenant (verified as owner)", async () => {
      const id = newPersonId();
      await inA((tx) => h.persons.save(tx, person(a.tenantId, id)));
      const { rows } = await withAdmin(infra.adminUrl, (db) =>
        db.query<{ tenant_id: string }>('SELECT tenant_id::text FROM persons WHERE id = $1', [id]),
      );
      expect(rows).toEqual([{ tenant_id: a.tenantId }]);
    });
  });
});
