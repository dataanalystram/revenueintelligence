import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authorityContentHash,
  REQUIRED_AUTHORITY_FACTS,
  type MappingDocument,
} from '../../src/modules/domain';
import { CanonicalAdoptionService } from '../../src/modules/governance';
import type { TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeSugar, type FakeSugarRecord } from '../support/fake-sugar';
import {
  publishWithAcks,
  runSync,
  sourcesServices,
  sugarTenant,
  sugarTestMapping,
  withSnapshot,
  type SourcesFixture,
} from '../support/sources';
import { authz } from '../support/security';

/**
 * M10C through a real source run (plan §2.4, §7, §19 V5 / V15 / V16 / V20):
 * the production Sugar adapter against the deterministic fake, the generic
 * mapping engine with the `account.parent` target and the `account_hierarchy`
 * authority, into the single hierarchy writer, on real PostgreSQL with the app
 * role and forced RLS. The parent field is a synthetic TEST field added to the
 * fake's Accounts module (no live Sugar, no customer decision encoded).
 */
describe('M10C account hierarchy through a source run (Sugar adapter, fake Sugar)', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const adoption = () => c.app.get(CanonicalAdoptionService);
  const PARENT_CONFIRMATION = {
    by: 'test-operator',
    note: 'TEST ONLY: synthetic parent account field',
  };

  /** The TEST mapping with the Accounts parent mapped to `account.parent`. */
  const parentMapping = (): MappingDocument =>
    sugarTestMapping((doc) => {
      const accounts = doc.objects.find((o) => o.source === 'Accounts')!;
      (accounts as { relationships: unknown[] }).relationships = [
        {
          target: 'account.parent',
          field: 'parent_id',
          object: 'Accounts',
          confirmation: PARENT_CONFIRMATION,
        },
      ];
    });

  /** A fake whose Accounts carry a synthetic `parent_id` (NULL everywhere until a test sets one). */
  async function parentFake(): Promise<FakeSugar> {
    const fake = await new FakeSugar().start();
    fake.addField('Accounts', 'parent_id', 'id', null);
    return fake;
  }
  const account = (fake: FakeSugar, id: string): FakeSugarRecord =>
    fake.data.get('Accounts')!.find((r) => r.id === id)!;
  const setParent = (fake: FakeSugar, id: string, parent: string | null) =>
    fake.upsert('Accounts', { ...account(fake, id), parent_id: parent });
  /** A new account read after every fixture account (later date_modified). */
  const addAccount = (fake: FakeSugar, id: string, parent: string | null = null) =>
    fake.upsert('Accounts', {
      id,
      name: `Synthetic ${id}`,
      website: null,
      date_modified: '2025-10-02T00:00:00+00:00',
      deleted: false,
      parent_id: parent,
    });

  async function publishAuthority(f: SourcesFixture, hierarchy: boolean) {
    const s = sourcesServices(c);
    const current = await s.authority.show(f.ctx);
    return s.authority.publish(
      await authz(f.ctx, 'config.authority.publish'),
      {
        facts: {
          account_profile: null,
          person_profile: null,
          subscription_lines: f.connectionId,
          subscription_state: null,
          subscription_terms: f.connectionId,
          ...(hierarchy ? { account_hierarchy: f.connectionId } : {}),
        },
      },
      { expectedBaseVersion: current!.version },
    );
  }
  async function publishParentMapping(f: SourcesFixture) {
    const s = sourcesServices(c);
    const snapshot = await s.snapshots.latest(f.ctx, f.connectionId);
    const latest = await c.sql<{ v: number }>(
      `SELECT max(version)::int AS v FROM tenant_source_mapping_versions WHERE tenant_id = $1`,
      [f.ctx.tenantId],
    );
    return publishWithAcks(c, f, withSnapshot(parentMapping(), snapshot!.hash), latest[0]!.v);
  }
  const companyOf = async (t: TenantContext, accountId: string) =>
    (
      await c.sql<{ company_id: string }>(
        `SELECT company_id::text FROM company_external_refs
          WHERE tenant_id = $1 AND system = 'sugar' AND object_type = 'Accounts' AND external_id = $2`,
        [t.tenantId, accountId],
      )
    )[0]?.company_id;
  const parentOf = async (t: TenantContext, accountId: string) =>
    (
      await c.sql<{ parent: string | null; origin: string | null }>(
        `SELECT parent_company_id::text AS parent, parent_company_origin AS origin FROM companies
          WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, await companyOf(t, accountId)],
      )
    )[0]!;
  const issues = (t: TenantContext) =>
    c.sql<{ kind: string; state: string; external_refs: string[] }>(
      `SELECT kind, state, external_refs FROM tenant_identity_conflicts
        WHERE tenant_id = $1 AND kind LIKE 'hierarchy_%' ORDER BY created_at`,
      [t.tenantId],
    );

  describe('V5: source hierarchy sync', () => {
    it('authority required; second pass; unresolved issue; disappearance, a failed run and a lost authority never unparent; explicit clear', async () => {
      const fake = await parentFake();
      try {
        const f = await sugarTenant(c, fake, { prefix: 'hsync' });
        const s = sourcesServices(c);
        // Without the account_hierarchy authority the mapping cannot name account.parent.
        const snapshot = await s.snapshots.latest(f.ctx, f.connectionId);
        const report = await s.mappings.validate(
          f.ctx,
          f.connectionId,
          withSnapshot(parentMapping(), snapshot!.hash),
        );
        expect(report.errors).toContainEqual(
          expect.objectContaining({
            code: 'authority_conflict',
            path: 'objects.0.relationships.0.target',
          }),
        );
        // The consequential target needs its recorded confirmation.
        const unconfirmed = sugarTestMapping((doc) => {
          const accounts = doc.objects.find((o) => o.source === 'Accounts')!;
          (accounts as { relationships: unknown[] }).relationships = [
            { target: 'account.parent', field: 'parent_id', object: 'Accounts' },
          ];
        });
        expect(
          (
            await s.mappings.validate(
              f.ctx,
              f.connectionId,
              withSnapshot(unconfirmed, snapshot!.hash),
            )
          ).errors,
        ).toContainEqual(expect.objectContaining({ code: 'unconfirmed_consequential_entry' }));

        await publishAuthority(f, true);
        const published = await publishParentMapping(f);
        const [stored] = await c.sql<{ canonical_version_min: string }>(
          `SELECT canonical_version_min FROM tenant_source_mapping_versions WHERE tenant_id = $1 AND version = $2`,
          [f.ctx.tenantId, published.version],
        );
        expect(stored!.canonical_version_min).toBe('0.5');

        setParent(fake, 'FIX-ACC-002', 'FIX-ACC-001');
        // FIX-ACC-003's parent is read after it (second pass, same run).
        setParent(fake, 'FIX-ACC-003', 'FIX-ACC-900');
        addAccount(fake, 'FIX-ACC-900');
        // FIX-ACC-004's parent never arrives in this run.
        setParent(fake, 'FIX-ACC-004', 'FIX-ACC-GHOST');
        const first = await runSync(c, f, 'full');
        expect(first.status).toBe('completed');
        expect(first.quality).toMatchObject({
          hierarchy_parent_applied: 1,
          hierarchy_parent_unresolved: 1,
        });
        const p1 = await companyOf(f.ctx, 'FIX-ACC-001');
        const p900 = await companyOf(f.ctx, 'FIX-ACC-900');
        expect(await parentOf(f.ctx, 'FIX-ACC-002')).toEqual({
          parent: p1,
          origin: 'source_provided',
        });
        expect(await parentOf(f.ctx, 'FIX-ACC-003')).toEqual({
          parent: p900,
          origin: 'source_provided',
        });
        expect((await parentOf(f.ctx, 'FIX-ACC-004')).parent).toBeNull();
        expect(await issues(f.ctx)).toEqual([
          {
            kind: 'hierarchy_parent_unresolved',
            state: 'open',
            external_refs: ['sugar:Accounts:FIX-ACC-004', 'sugar:Accounts:FIX-ACC-GHOST'],
          },
        ]);
        // The run's change records carry its provenance (checkpoint, mapping version).
        const [change] = await c.sql<{
          checkpoint_id: string;
          mapping_version: number;
          source_system: string;
        }>(
          `SELECT checkpoint_id::text, mapping_version, source_system FROM tenant_context_changes
            WHERE tenant_id = $1 AND entity_id = $2 AND 'parentCompanyId' = ANY(changed_fields)`,
          [f.ctx.tenantId, await companyOf(f.ctx, 'FIX-ACC-002')],
        );
        expect(change).toEqual({
          checkpoint_id: first.runId,
          mapping_version: published.version,
          source_system: 'sugar',
        });

        // Disappearance: the parent account is no longer returned → nothing changes.
        fake.remove('Accounts', 'FIX-ACC-001');
        expect((await runSync(c, f, 'full')).status).toBe('completed');
        expect((await parentOf(f.ctx, 'FIX-ACC-002')).parent).toBe(p1);

        // A failed run (the parent field disappears mid-run) changes nothing.
        fake.droppedFields.add('parent_id');
        setParent(fake, 'FIX-ACC-003', null);
        expect(await runSync(c, f, 'full')).toMatchObject({
          status: 'failed',
          errorCode: 'schema_drift',
        });
        fake.droppedFields.delete('parent_id');
        expect((await parentOf(f.ctx, 'FIX-ACC-003')).parent).toBe(p900);

        // An explicitly empty parent clears it (history old → NULL); the ghost arrives.
        setParent(fake, 'FIX-ACC-002', null);
        addAccount(fake, 'FIX-ACC-GHOST');
        expect((await runSync(c, f, 'full')).status).toBe('completed');
        expect((await parentOf(f.ctx, 'FIX-ACC-002')).parent).toBeNull();
        expect((await parentOf(f.ctx, 'FIX-ACC-003')).parent).toBeNull();
        expect((await parentOf(f.ctx, 'FIX-ACC-004')).parent).toBe(
          await companyOf(f.ctx, 'FIX-ACC-GHOST'),
        );
        expect((await issues(f.ctx)).map((i) => i.state)).toEqual(['resolved']);
        const history = await c.sql<{ old_value: unknown; new_value: unknown }>(
          `SELECT old_value, new_value FROM tenant_value_history
            WHERE tenant_id = $1 AND entity_kind = 'company' AND field = 'parent_company_id' AND entity_id = $2
            ORDER BY recorded_at`,
          [f.ctx.tenantId, await companyOf(f.ctx, 'FIX-ACC-002')],
        );
        expect(history.map((h) => [h.old_value, h.new_value])).toEqual([
          [null, p1],
          [p1, null],
        ]);

        // The connection loses the account_hierarchy authority: the parent is no longer read.
        await publishAuthority(f, false);
        setParent(fake, 'FIX-ACC-002', 'FIX-ACC-005');
        setParent(fake, 'FIX-ACC-004', null);
        expect((await runSync(c, f, 'full')).status).toBe('completed');
        expect((await parentOf(f.ctx, 'FIX-ACC-002')).parent).toBeNull();
        expect((await parentOf(f.ctx, 'FIX-ACC-004')).parent).toBe(
          await companyOf(f.ctx, 'FIX-ACC-GHOST'),
        );
      } finally {
        await fake.stop();
      }
    });
  });

  describe('V15 / V16: the 0.3 gate for mappings and authority versions', () => {
    it('below 0.3 a hierarchy authority and a mapping using account.parent are refused; after adoption both publish', async () => {
      const fake = await parentFake();
      try {
        const f = await sugarTenant(c, fake, { prefix: 'hsyncgate' });
        // Published at 0.3, before the rollback, so the mapping validates against it.
        await publishAuthority(f, true);
        // M10E: new tenants adopt 0.5; rollback goes one MINOR at a time (0.5 → 0.4 first).
        await adoption().adopt(await authz(f.ctx, 'config.canonical.adopt'), {
          target: '0.4',
          expectedCurrent: '0.5',
        });
        // M10D: new tenants adopt 0.4; rollback goes one MINOR at a time (0.4 → 0.3 first).
        await adoption().adopt(await authz(f.ctx, 'config.canonical.adopt'), {
          target: '0.3',
          expectedCurrent: '0.4',
        });
        await adoption().adopt(await authz(f.ctx, 'config.canonical.adopt'), {
          target: '0.2',
          expectedCurrent: '0.3',
        });
        await expect(publishParentMapping(f)).rejects.toMatchObject({
          code: 'canonical_version_too_low',
        });
        await expect(publishAuthority(f, true)).rejects.toMatchObject({
          code: 'authority_invalid',
          issues: [
            expect.objectContaining({
              code: 'canonical_version_too_low',
              path: 'facts.account_hierarchy',
            }),
          ],
        });
        // A run at 0.2 (hierarchy authority held, parent mapping refused) writes no parent.
        setParent(fake, 'FIX-ACC-002', 'FIX-ACC-001');
        expect((await runSync(c, f, 'full')).status).toBe('completed');
        expect((await parentOf(f.ctx, 'FIX-ACC-002')).parent).toBeNull();
        await adoption().adopt(await authz(f.ctx, 'config.canonical.adopt'), {
          target: '0.3',
          expectedCurrent: '0.2',
        });
        // M10D: back to the current version (0.4), where the authority version was published.
        await adoption().adopt(await authz(f.ctx, 'config.canonical.adopt'), {
          target: '0.4',
          expectedCurrent: '0.3',
        });
        // M10E: back to the current version (0.5), where the authority version was published.
        await adoption().adopt(await authz(f.ctx, 'config.canonical.adopt'), {
          target: '0.5',
          expectedCurrent: '0.4',
        });
        await expect(publishParentMapping(f)).resolves.toMatchObject({ version: 3 });
        expect((await runSync(c, f, 'full')).status).toBe('completed');
        expect((await parentOf(f.ctx, 'FIX-ACC-002')).parent).toBe(
          await companyOf(f.ctx, 'FIX-ACC-001'),
        );
      } finally {
        await fake.stop();
      }
    });

    it('V16: the new authority column; existing versions keep their hash; account_hierarchy is validated like every fact', async () => {
      const fake = await parentFake();
      try {
        const f = await sugarTenant(c, fake, { prefix: 'hsyncauth' });
        const s = sourcesServices(c);
        const before = await c.sql<{
          version: number;
          content_hash: string;
          account_hierarchy_connection_id: string | null;
        }>(
          `SELECT version, content_hash, account_hierarchy_connection_id::text FROM tenant_source_authority_versions
            WHERE tenant_id = $1 ORDER BY version`,
          [f.ctx.tenantId],
        );
        expect(before.every((v) => v.account_hierarchy_connection_id === null)).toBe(true);
        // Every existing hash equals the ADR 0020 positional rule over the five original facts.
        for (const v of before) {
          const doc = (await s.authority.show(f.ctx))!;
          expect(v.content_hash).toMatch(/^[0-9a-f]{64}$/);
          if (v.version === doc.version) {
            const legacy = createHash('sha256')
              .update(
                REQUIRED_AUTHORITY_FACTS.map((fact) => doc.document.facts[fact] ?? '-').join('|'),
              )
              .digest('hex');
            expect(v.content_hash).toBe(legacy);
            expect(authorityContentHash(doc.document)).toBe(legacy);
            expect(doc.document.facts).not.toHaveProperty('account_hierarchy');
          }
        }
        // An unknown connection for the new fact is refused like any other fact.
        await expect(
          s.authority.publish(
            await authz(f.ctx, 'config.authority.publish'),
            {
              facts: {
                account_profile: null,
                person_profile: null,
                subscription_lines: f.connectionId,
                subscription_state: null,
                subscription_terms: f.connectionId,
                account_hierarchy: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a',
              },
            },
            { expectedBaseVersion: before.at(-1)!.version },
          ),
        ).rejects.toMatchObject({
          code: 'authority_invalid',
          issues: [
            expect.objectContaining({
              code: 'unknown_connection',
              path: 'facts.account_hierarchy',
            }),
          ],
        });
        const published = await publishAuthority(f, true);
        expect(published.document.facts.account_hierarchy).toBe(f.connectionId);
        expect(published.contentHash).toBe(authorityContentHash(published.document));
        expect(published.contentHash).not.toBe(before.at(-1)!.content_hash);
        const after = await c.sql<{
          version: number;
          content_hash: string;
          account_hierarchy_connection_id: string | null;
        }>(
          `SELECT version, content_hash, account_hierarchy_connection_id::text FROM tenant_source_authority_versions
            WHERE tenant_id = $1 ORDER BY version`,
          [f.ctx.tenantId],
        );
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.at(-1)!.account_hierarchy_connection_id).toBe(f.connectionId);
      } finally {
        await fake.stop();
      }
    });
  });

  describe('V20: identical canonical results at 0.2 and 0.3 (fake Sugar, no hierarchy mapped)', () => {
    it('the same source produces the same accounts, references, lines and run quality', async () => {
      const fake = await new FakeSugar().start();
      try {
        const at03 = await sugarTenant(c, fake, { prefix: 'hpar03' });
        const at02 = await sugarTenant(c, fake, { prefix: 'hpar02' });
        // M10E: new tenants adopt 0.5; rollback goes one MINOR at a time (0.5 → 0.4 first).
        await adoption().adopt(await authz(at02.ctx, 'config.canonical.adopt'), {
          target: '0.4',
          expectedCurrent: '0.5',
        });
        // M10D: new tenants adopt 0.4; rollback goes one MINOR at a time (0.4 → 0.3 first).
        await adoption().adopt(await authz(at02.ctx, 'config.canonical.adopt'), {
          target: '0.3',
          expectedCurrent: '0.4',
        });
        await adoption().adopt(await authz(at02.ctx, 'config.canonical.adopt'), {
          target: '0.2',
          expectedCurrent: '0.3',
        });
        const r03 = await runSync(c, at03, 'full');
        const r02 = await runSync(c, at02, 'full');
        expect(r03.status).toBe('completed');
        expect(r02.status).toBe('completed');
        expect(r03.quality).toEqual(r02.quality);
        const canonical = async (t: TenantContext) => ({
          companies: await c.sql(
            `SELECT r.external_id, r.state, c.record_state, c.customer_status, c.parent_company_id
               FROM company_external_refs r JOIN companies c ON c.tenant_id = r.tenant_id AND c.id = r.company_id
              WHERE r.tenant_id = $1 ORDER BY r.external_id`,
            [t.tenantId],
          ),
          lines: await c.sql(
            `SELECT s.source_record_id, s.state, s.starts_at, s.ends_at, s.quantity, s.product_key, s.record_state,
                    r.external_id AS account
               FROM tenant_subscriptions s
               JOIN company_external_refs r ON r.tenant_id = s.tenant_id AND r.company_id = s.company_id
              WHERE s.tenant_id = $1 ORDER BY s.source_record_id, r.external_id`,
            [t.tenantId],
          ),
          affiliations: await c.sql(
            `SELECT 1 FROM tenant_person_affiliations WHERE tenant_id = $1`,
            [t.tenantId],
          ),
        });
        const a = await canonical(at03.ctx);
        expect(a.lines.length).toBeGreaterThan(0);
        expect(a).toEqual(await canonical(at02.ctx));
      } finally {
        await fake.stop();
      }
    });
  });
});
