import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MappingDocument } from '../../src/modules/domain';
import type { TenantContext } from '../../src/modules/tenancy';
import { startContextHarness, type ContextHarness } from '../support/context';
import { enableExtension, publishExtension, services, valuesOf } from '../support/extension';
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
 * M10D through a real source run (plan §5, §19 V6, Q13): the production Sugar
 * adapter against the deterministic fake, `attribute` entries on Accounts
 * mapped to account extension fields of the default TEST registry, into
 * `ExtensionValueWriter` via `SourceExtensionSync`, on real PostgreSQL with
 * the app role and forced RLS. The two source fields are synthetic TEST
 * fields added to the fake's Accounts module (no live Sugar, no customer
 * schema).
 */
describe('M10D extension attribute values through a source run (Sugar adapter, fake Sugar)', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  /** The TEST mapping with two Accounts attributes (string and enum). */
  const attributeMapping = (): MappingDocument =>
    sugarTestMapping((doc) => {
      const accounts = doc.objects.find((o) => o.source === 'Accounts')!;
      (accounts as { fields: unknown[] }).fields = [
        ...accounts.fields,
        { kind: 'attribute', field: 'x_string', source: 'region_src' },
        {
          kind: 'attribute',
          field: 'x_enum',
          source: 'tier_src',
          transforms: {
            valueMap: { map: { Gold: 'gold', Silver: 'silver' }, unmapped: 'unknown' },
          },
        },
      ];
    });

  async function attributeFake(): Promise<FakeSugar> {
    const fake = await new FakeSugar().start();
    fake.addField('Accounts', 'region_src', 'varchar', 'EMEA');
    fake.addField('Accounts', 'tier_src', 'varchar', 'Gold');
    return fake;
  }
  const account = (fake: FakeSugar, id: string): FakeSugarRecord =>
    fake.data.get('Accounts')!.find((r) => r.id === id)!;
  const setSource = (fake: FakeSugar, id: string, values: Record<string, string | null>) =>
    fake.upsert('Accounts', { ...account(fake, id), ...values });

  async function publishAuthority(f: SourcesFixture, accountProfile: boolean) {
    const s = sourcesServices(c);
    const current = await s.authority.show(f.ctx);
    return s.authority.publish(
      await authz(f.ctx, 'config.authority.publish'),
      {
        facts: {
          account_profile: accountProfile ? f.connectionId : null,
          person_profile: null,
          subscription_lines: f.connectionId,
          subscription_state: null,
          subscription_terms: f.connectionId,
        },
      },
      { expectedBaseVersion: current!.version },
    );
  }
  async function publishAttributeMapping(f: SourcesFixture) {
    const s = sourcesServices(c);
    const snapshot = await s.snapshots.latest(f.ctx, f.connectionId);
    const latest = await c.sql<{ v: number }>(
      `SELECT max(version)::int AS v FROM tenant_source_mapping_versions WHERE tenant_id = $1`,
      [f.ctx.tenantId],
    );
    return publishWithAcks(c, f, withSnapshot(attributeMapping(), snapshot!.hash), latest[0]!.v);
  }
  const companyOf = async (t: TenantContext, accountId: string) =>
    (
      await c.sql<{ company_id: string }>(
        `SELECT company_id::text FROM company_external_refs
          WHERE tenant_id = $1 AND system = 'sugar' AND object_type = 'Accounts' AND external_id = $2`,
        [t.tenantId, accountId],
      )
    )[0]!.company_id;
  const valuesOfAccount = async (t: TenantContext, accountId: string) =>
    valuesOf(c, t, await companyOf(t, accountId));
  const countValues = async (t: TenantContext) =>
    (
      await c.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM tenant_extension_values WHERE tenant_id = $1`,
        [t.tenantId],
      )
    )[0]!.n;

  describe('V6: Sugar account attributes', () => {
    it('Q13 authority gate; values written with provenance; idempotent re-run; failed run, disappearance and a disabled module never clear', async () => {
      const fake = await attributeFake();
      try {
        const f = await sugarTenant(c, fake, { prefix: 'extsync' });
        await enableExtension(c, f.ctx);
        await publishExtension(c, f.ctx);
        const published = await publishAttributeMapping(f);

        // Q13: without the account_profile authority the attributes are not written.
        const unauthorized = await runSync(c, f, 'full');
        expect(unauthorized.status).toBe('completed');
        expect(unauthorized.quality).not.toHaveProperty('extension_values_written');
        expect(await countValues(f.ctx)).toBe(0);

        // With the authority, a full run writes both attributes of every account.
        await publishAuthority(f, true);
        setSource(fake, 'FIX-ACC-003', { region_src: 'APAC', tier_src: 'Silver' });
        const first = await runSync(c, f, 'full');
        expect(first.status).toBe('completed');
        const written = Number(first.quality.extension_values_written);
        expect(written).toBeGreaterThanOrEqual(4);
        expect(written % 2).toBe(0);
        const acc2 = await valuesOfAccount(f.ctx, 'FIX-ACC-002');
        expect(Object.keys(acc2)).toEqual(['x_enum', 'x_string']);
        expect(acc2.x_string).toMatchObject({
          target_kind: 'company',
          value_text: 'EMEA',
          origin: 'source_provided',
          source_connection_id: f.connectionId,
          source_object_type: 'Accounts',
          source_record_id: 'FIX-ACC-002',
        });
        expect(acc2.x_enum).toMatchObject({
          value_enum: 'gold',
          source_connection_id: f.connectionId,
          source_record_id: 'FIX-ACC-002',
        });
        const acc3 = await valuesOfAccount(f.ctx, 'FIX-ACC-003');
        expect(acc3.x_string!.value_text).toBe('APAC');
        expect(acc3.x_enum!.value_enum).toBe('silver');
        // The change records carry the run's provenance (checkpoint, mapping version).
        const [change] = await c.sql<{
          checkpoint_id: string;
          mapping_version: number;
          source_system: string;
        }>(
          `SELECT checkpoint_id::text, mapping_version, source_system FROM tenant_context_changes
            WHERE tenant_id = $1 AND entity_id = $2 AND 'ext:x_string' = ANY(changed_fields)`,
          [f.ctx.tenantId, await companyOf(f.ctx, 'FIX-ACC-002')],
        );
        expect(change).toEqual({
          checkpoint_id: first.runId,
          mapping_version: published.version,
          source_system: 'sugar',
        });
        const total = await countValues(f.ctx);
        expect(total).toBe(written);

        // A repeated run writes nothing new (field hash unchanged).
        const repeat = await runSync(c, f, 'full');
        expect(repeat.status).toBe('completed');
        expect(repeat.quality).not.toHaveProperty('extension_values_written');
        expect(await valuesOfAccount(f.ctx, 'FIX-ACC-002')).toEqual(acc2);
        expect(await countValues(f.ctx)).toBe(total);

        // A failed run (a mapped field disappears mid-run) changes nothing.
        fake.droppedFields.add('tier_src');
        setSource(fake, 'FIX-ACC-002', { region_src: 'AMER' });
        expect(await runSync(c, f, 'full')).toMatchObject({
          status: 'failed',
          errorCode: 'schema_drift',
        });
        fake.droppedFields.delete('tier_src');
        expect(await valuesOfAccount(f.ctx, 'FIX-ACC-002')).toEqual(acc2);

        // Disappearance: the account is no longer returned → its values stay.
        const acc1 = await valuesOfAccount(f.ctx, 'FIX-ACC-001');
        expect(acc1.x_string!.value_text).toBe('EMEA');
        setSource(fake, 'FIX-ACC-002', { region_src: 'EMEA' });
        fake.remove('Accounts', 'FIX-ACC-001');
        expect((await runSync(c, f, 'full')).status).toBe('completed');
        expect(await valuesOfAccount(f.ctx, 'FIX-ACC-001')).toEqual(acc1);
        expect(await countValues(f.ctx)).toBe(total);

        // Module disabled: the run completes and writes no extension value.
        const [setting] = await c.sql<{ version: number }>(
          `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'extension'`,
          [f.ctx.tenantId],
        );
        await services(c).modules.disable(await authz(f.ctx, 'config.module.change'), {
          module: 'extension',
          expectedVersion: setting!.version,
        });
        setSource(fake, 'FIX-ACC-002', { region_src: 'LATAM', tier_src: 'Silver' });
        const disabled = await runSync(c, f, 'full');
        expect(disabled.status).toBe('completed');
        expect(disabled.quality).not.toHaveProperty('extension_values_written');
        const after = await valuesOfAccount(f.ctx, 'FIX-ACC-002');
        expect(after.x_string!.value_text).toBe('EMEA');
        expect(after.x_enum!.value_enum).toBe('gold');
        expect(await countValues(f.ctx)).toBe(total);
      } finally {
        await fake.stop();
      }
    });
  });
});
