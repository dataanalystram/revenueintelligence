import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_PURGE_EXECUTION_APPROVED,
  isSensitiveForHistory,
  SecretLikeValueError,
  sourceSyncActor,
  valueHistoryColumn,
} from '../../src/modules/domain';
import {
  CanonicalAdoptionService,
  IntegrityVerificationService,
  ModuleDisabledError,
  ModuleGate,
  ModuleSettingsService,
  RegistryService,
} from '../../src/modules/governance';
import {
  AuthorizationDeniedError,
  SecurityEventsService,
  SecurityOperationsService,
  TenantDatabase,
  tenantRetention,
  type TenantContext,
} from '../../src/modules/tenancy';
import { CLASSIFICATION_MANIFEST } from '../../src/modules/tenancy/security';
import { withAdmin } from '../support/containers';
import { startContextHarness, type ContextHarness } from '../support/context';
import { FakeSugar } from '../support/fake-sugar';
import { genericModel } from '../support/product-models';
import { authz } from '../support/security';
import { sourcesServices, sugarTenant } from '../support/sources';

/** Pattern-shaped test strings are assembled at runtime: no real secret is in the repository. */
const AWS_SHAPED = 'AKIA' + 'Q'.repeat(16);

/**
 * M10A2 governance on real PostgreSQL (app role, forced RLS): canonical
 * adoption (V4), independence of adoption and modules (V5), module rules (V6),
 * the module gate (V7), registry and data policy publication (V8, V9), the
 * entity index (V10), cross-tenant polymorphic references (V11), value history
 * (V12, V13), change-record governance columns (V14), integrity verification
 * (V17) and secret-like refusal (V18).
 */
describe('M10A2 canonical versioning and governance', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
    // The production catalogue publishes 0.1–0.4 (supported) and 0.5
    // (current, M10E); test database only (Q16 / plan §17): a deprecated 0.6
    // lets the refusal of an unsupported target be exercised.
    await c.sql(
      `INSERT INTO canonical_model_versions (version, major, minor, status, released_at, catalogue_hash, adr)
       VALUES ('0.6', 0, 6, 'deprecated', now(), repeat('c', 64), '0031')`,
    );
  });
  afterAll(async () => {
    await c?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  const adoption = () => c.app.get(CanonicalAdoptionService);
  const modules = () => c.app.get(ModuleSettingsService);
  const gate = () => c.app.get(ModuleGate);
  const registry = () => c.app.get(RegistryService);
  const integrity = () => c.app.get(IntegrityVerificationService);
  const db = () => c.app.get(TenantDatabase);

  const audit = (t: TenantContext) =>
    c.sql<{
      id: string;
      action: string;
      outcome: string;
      reason_code: string | null;
      capability: string;
      details: Record<string, unknown>;
    }>(
      `SELECT id::text, action, outcome, reason_code, capability, details
         FROM tenant_audit_events WHERE tenant_id = $1 ORDER BY seq`,
      [t.tenantId],
    );
  const adoptions = (t: TenantContext) =>
    c.sql<{
      seq: number;
      version: string;
      previous_version: string | null;
      reason: string;
      audit_event_id: string | null;
    }>(
      `SELECT seq, version, previous_version, reason, audit_event_id::text
         FROM tenant_canonical_adoptions WHERE tenant_id = $1 ORDER BY seq`,
      [t.tenantId],
    );
  const settingEvents = (t: TenantContext) =>
    c.sql<{ module_key: string; seq: number; to_enabled: boolean; audit_event_id: string }>(
      `SELECT module_key, seq, to_enabled, audit_event_id::text
         FROM tenant_module_setting_events WHERE tenant_id = $1 ORDER BY module_key, seq`,
      [t.tenantId],
    );
  const securityEvents = () => {
    const service = c.app.get(SecurityEventsService, { strict: false });
    const emitted: Record<string, unknown>[] = [];
    vi.spyOn(service, 'emit').mockImplementation((e) => void emitted.push({ ...e }));
    return emitted;
  };
  /** Runs SQL as the application login with a tenant bound (raw SQL, bypassing writers). */
  async function asApp<T>(t: TenantContext, work: (db: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: c.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [t.tenantId]);
      const out = await work(client);
      await client.query('ROLLBACK');
      return out;
    } finally {
      await client.end();
    }
  }
  async function companyOf(t: TenantContext, id: string, name = `Company ${id}`) {
    const r = await c.ingestion.ingest(
      await authz(t, 'canonical.source_sync'),
      {
        kind: 'company',
        presence: 'present',
        ref: { system: 'hubspot', objectType: 'companies', id },
        observedAt: new Date(),
        fields: { name },
      },
      { cause: 'webhook', correlationId: randomUUID() },
    );
    return r.entityId!;
  }

  describe('V3/V4: canonical adoption', () => {
    it('a new tenant adopts the current version (new_tenant, covered by tenant.provision)', async () => {
      const t = await c.tenant('adnew', 1001);
      const rows = await adoptions(t);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        seq: 1,
        version: '0.5',
        previous_version: null,
        reason: 'new_tenant',
      });
      const provision = (await audit(t)).find((e) => e.action === 'tenant.provision')!;
      expect(provision.details).toMatchObject({ canonicalVersion: '0.5' });
      expect(rows[0]!.audit_event_id).toBe(provision.id);
    });

    it('dry run reports the impact and writes nothing', async () => {
      const t = await c.tenant('addry', 1001);
      const before = await audit(t);
      const plan = await adoption().plan(t, '0.4', '0.5');
      expect(plan).toMatchObject({
        current: '0.5',
        target: '0.4',
        decision: 'rollback',
        modulesNewlyAvailable: [],
        // M10D (Q19): nothing is enabled for this tenant, so nothing is stranded.
        modulesStranded: [],
        registriesAboveTarget: 0,
        mappingsAboveTarget: 0,
        // M10B / M10C / M10D / M10E plan: the dry run lists what the rollback withdraws.
        enables: [],
        disables: [
          'account_context',
          'context_type_registry',
          'context_membership',
          'line_context',
        ],
      });
      expect(await adoption().plan(t, '0.6', '0.5')).toMatchObject({
        decision: 'refused',
        refusal: 'canonical_version_not_supported',
      });
      expect(await adoptions(t)).toHaveLength(1);
      expect(await audit(t)).toEqual(before);
    });

    it('forward, then rollback to the previous MINOR only; each writes one allowed audit event in its transaction', async () => {
      const t = await c.tenant('adopt', 1001);
      const before = (await audit(t)).length;
      await expect(
        adoption().adopt(await authz(t, 'config.canonical.adopt'), {
          target: '0.4',
          expectedCurrent: '0.5',
        }),
      ).resolves.toEqual({
        seq: 2,
        version: '0.4',
        previousVersion: '0.5',
        reason: 'rollback',
      });
      let events = await audit(t);
      expect(events).toHaveLength(before + 1);
      expect(events.at(-1)).toMatchObject({
        action: 'canonical.adopt',
        outcome: 'allowed',
        capability: 'config.canonical.adopt',
      });
      expect((await adoptions(t)).at(-1)!.audit_event_id).toBe(events.at(-1)!.id);

      await expect(
        adoption().adopt(await authz(t, 'config.canonical.adopt'), {
          target: '0.5',
          expectedCurrent: '0.4',
        }),
      ).resolves.toMatchObject({ seq: 3, version: '0.5', reason: 'operator_adoption' });
      events = await audit(t);
      expect(events).toHaveLength(before + 2);
      expect((await adoptions(t)).map((r) => [r.seq, r.version, r.reason])).toEqual([
        [1, '0.5', 'new_tenant'],
        [2, '0.4', 'rollback'],
        [3, '0.5', 'operator_adoption'],
      ]);
    });

    it.each([
      ['a stale expected current version', '0.1', '0.1', 'stale_base_version'],
      ['an unsupported (deprecated) target', '0.6', '0.5', 'canonical_version_not_supported'],
      ['a rollback past the previous MINOR', '0.3', '0.5', 'canonical_version_not_supported'],
      ['an unknown target', '0.9', '0.5', 'canonical_version_unknown'],
      ['the version already adopted', '0.5', '0.5', 'no_change'],
    ])('refuses %s (recorded failed, nothing appended)', async (_l, target, expected, code) => {
      const t = await c.tenant('adref', 1001);
      await expect(
        adoption().adopt(await authz(t, 'config.canonical.adopt'), {
          target,
          expectedCurrent: expected,
        }),
      ).rejects.toMatchObject({ code });
      expect(await adoptions(t)).toHaveLength(1);
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'canonical.adopt',
        outcome: 'failed',
        reason_code: code,
      });
    });

    it('the adoption chain is append-only for the app role (privilege and trigger)', async () => {
      const t = await c.tenant('adapp', 1001);
      await expect(
        asApp(t, (db) => db.query(`UPDATE tenant_canonical_adoptions SET reason = 'rollback'`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asApp(t, (db) => db.query(`DELETE FROM tenant_canonical_adoptions`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        c.sql(`UPDATE tenant_canonical_adoptions SET reason = 'rollback' WHERE tenant_id = $1`, [
          t.tenantId,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it('the app role can never write a migration baseline adoption row (trigger, even on a fresh chain)', async () => {
      const t = await c.tenant('adbase', 1001);
      // Own tenant (RLS passes); the trigger refuses before the chain or CHECKs are reached.
      await expect(
        asApp(t, (db) =>
          db.query(
            `INSERT INTO tenant_canonical_adoptions (tenant_id, id, seq, version, previous_version, reason, actor_kind, actor_id, actor_assurance, correlation_id)
             VALUES ($1, gen_random_uuid(), 2, '0.2', '0.1', 'baseline', 'system', 'system:migration:m10a2', 'system', gen_random_uuid())`,
            [t.tenantId],
          ),
        ),
      ).rejects.toThrow(/baseline adoptions are written by the migration only/);
      expect(await adoptions(t)).toHaveLength(1);
    });
  });

  describe('V5/V6/V7: modules', () => {
    beforeAll(async () => {
      // Owner-only availability toggle in the test database (Q16).
      await c.sql(
        `UPDATE canonical_modules SET available = true, minimum_canonical_version = '0.1'
          WHERE module_key IN ('commercial', 'opportunities', 'signals', 'account_context')`,
      );
      await c.sql(
        `UPDATE canonical_modules SET available = true, minimum_canonical_version = '0.6'
          WHERE module_key = 'engagement'`,
      );
    });
    afterAll(async () => {
      // M10D / M10E: extension (0.4) and account_context (0.5) are available in production;
      // only the test toggles are undone.
      await c.sql(
        `UPDATE canonical_modules SET available = false, minimum_canonical_version = NULL
          WHERE module_key NOT IN ('extension', 'account_context')`,
      );
      await c.sql(
        `UPDATE canonical_modules SET available = true, minimum_canonical_version = '0.5'
          WHERE module_key = 'account_context'`,
      );
    });

    it('V6: enable/disable round trip with dependencies; one setting event and one audit event per change', async () => {
      const t = await c.tenant('modrt', 1001);
      const change = async () => authz(t, 'config.module.change');
      await expect(
        modules().enable(await change(), { module: 'opportunities', expectedVersion: 0 }),
      ).rejects.toMatchObject({ code: 'module_dependency_missing' });
      const auditBefore = (await audit(t)).length;
      await expect(
        modules().enable(await change(), { module: 'commercial', expectedVersion: 0 }),
      ).resolves.toMatchObject({ module: 'commercial', enabled: true, version: 1 });
      const afterEnable = await audit(t);
      expect(afterEnable).toHaveLength(auditBefore + 1);
      expect(afterEnable.at(-1)).toMatchObject({ action: 'module.enable', outcome: 'allowed' });
      expect(await settingEvents(t)).toEqual([
        {
          module_key: 'commercial',
          seq: 1,
          to_enabled: true,
          audit_event_id: afterEnable.at(-1)!.id,
        },
      ]);
      // Base version: a change from version 0 again is stale.
      await expect(
        modules().disable(await change(), { module: 'commercial', expectedVersion: 0 }),
      ).rejects.toMatchObject({ code: 'stale_base_version' });
      await modules().enable(await change(), { module: 'opportunities', expectedVersion: 0 });
      await expect(
        modules().disable(await change(), { module: 'commercial', expectedVersion: 1 }),
      ).rejects.toMatchObject({ code: 'module_required_by_other' });
      await modules().disable(await change(), { module: 'opportunities', expectedVersion: 1 });
      await modules().disable(await change(), { module: 'commercial', expectedVersion: 1 });
      // Re-enable needs no migration; disable never deleted the setting.
      await modules().enable(await change(), { module: 'commercial', expectedVersion: 2 });
      expect(
        (await settingEvents(t)).map((e) => `${e.module_key}:${e.seq}:${e.to_enabled}`),
      ).toEqual([
        'commercial:1:true',
        'commercial:2:false',
        'commercial:3:true',
        'opportunities:1:true',
        'opportunities:2:false',
      ]);
      const settings = await c.sql<{ module_key: string; enabled: boolean; version: number }>(
        `SELECT module_key, enabled, version FROM tenant_module_settings WHERE tenant_id = $1 ORDER BY 1`,
        [t.tenantId],
      );
      expect(settings).toEqual([
        { module_key: 'commercial', enabled: true, version: 3 },
        { module_key: 'opportunities', enabled: false, version: 2 },
      ]);
      // Disable is never a delete, for the app role either.
      await expect(
        asApp(t, (db) => db.query(`DELETE FROM tenant_module_settings`)),
      ).rejects.toThrow(/permission denied/);
    });

    it('V6: refuses an unavailable module and one whose minimum version is above the adopted one', async () => {
      const t = await c.tenant('modmin', 1001);
      await expect(
        modules().enable(await authz(t, 'config.module.change'), {
          module: 'data_quality',
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({ code: 'module_not_available' });
      await expect(
        modules().enable(await authz(t, 'config.module.change'), {
          module: 'engagement',
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'module.enable',
        outcome: 'failed',
        reason_code: 'canonical_version_too_low',
      });
      expect(await settingEvents(t)).toEqual([]);
    });

    it('V5: adoption never changes module settings and a module change never touches the adoption chain', async () => {
      const t = await c.tenant('modind', 1001);
      await modules().enable(await authz(t, 'config.module.change'), {
        module: 'account_context',
        expectedVersion: 0,
      });
      const chain = await adoptions(t);
      const settingsBefore = await c.sql(
        `SELECT module_key, enabled, version, config FROM tenant_module_settings WHERE tenant_id = $1`,
        [t.tenantId],
      );
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      expect(
        await c.sql(
          `SELECT module_key, enabled, version, config FROM tenant_module_settings WHERE tenant_id = $1`,
          [t.tenantId],
        ),
      ).toEqual(settingsBefore);
      const chainAfterAdopt = await adoptions(t);
      expect(chainAfterAdopt).toHaveLength(chain.length + 1);
      await modules().enable(await authz(t, 'config.module.change'), {
        module: 'signals',
        expectedVersion: 0,
      });
      expect(await adoptions(t)).toEqual(chainAfterAdopt);
    });

    it('V7: the module gate refuses writes for a disabled module (audited denied, security event) and passes when enabled', async () => {
      const t = await c.tenant('modgate', 1001);
      const emitted = securityEvents();
      const actx = await authz(t, 'canonical.source_sync');
      await expect(
        db().transaction(t, (tx) => gate().require(tx, actx, 'commercial')),
      ).rejects.toBeInstanceOf(ModuleDisabledError);
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'operation.denied',
        outcome: 'denied',
        reason_code: 'module_disabled',
      });
      expect(emitted).toContainEqual(
        expect.objectContaining({
          event: 'module_disabled_write_refused',
          reasonCode: 'module_disabled',
        }),
      );
      await modules().enable(await authz(t, 'config.module.change'), {
        module: 'commercial',
        expectedVersion: 0,
      });
      await expect(
        db().transaction(t, (tx) => gate().require(tx, actx, 'commercial')),
      ).resolves.toBeUndefined();
    });

    it('V18: secret-like module configuration is refused (audited denied) before anything is written', async () => {
      const t = await c.tenant('modsec', 1001);
      await modules().enable(await authz(t, 'config.module.change'), {
        module: 'commercial',
        expectedVersion: 0,
      });
      await expect(
        modules().configure(await authz(t, 'config.module.change'), {
          module: 'commercial',
          expectedVersion: 1,
          config: { note: AWS_SHAPED },
        }),
      ).rejects.toBeInstanceOf(SecretLikeValueError);
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'module.configure',
        outcome: 'denied',
        reason_code: 'secret_like_value',
      });
      const [setting] = await c.sql<{ version: number; config: unknown }>(
        `SELECT version, config FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'commercial'`,
        [t.tenantId],
      );
      expect(setting).toEqual({ version: 1, config: {} });
    });
  });

  describe('V8/V9: registries and the data policy', () => {
    const policy = (over: Record<string, unknown> = {}) => ({
      schema: 1,
      raw_retention: false,
      retention: { operational_diagnostics: { days: 30 } },
      ...over,
    });

    it('publishes only what the dry run hashed, at the expected base version; projection follows', async () => {
      const t = await c.tenant('regpub', 1001);
      const dry = await registry().dryRun(t, 'data_policy', policy());
      expect(dry).toMatchObject({ available: true, valid: true, currentVersion: 0 });
      const publish = async (document: unknown, expectedBaseVersion: number, hash: string) =>
        registry().publishDataPolicy(await authz(t, 'config.data_policy.publish'), {
          document,
          expectedBaseVersion,
          expectedContentHash: hash,
        });
      await expect(publish(policy({ retention: {} }), 0, dry.contentHash!)).rejects.toMatchObject({
        code: 'expected_hash_mismatch',
      });
      await expect(publish(policy(), 1, dry.contentHash!)).rejects.toMatchObject({
        code: 'stale_base_version',
      });
      const before = (await audit(t)).length;
      await expect(publish(policy(), 0, dry.contentHash!)).resolves.toMatchObject({
        kind: 'data_policy',
        version: 1,
        contentHash: dry.contentHash,
        canonicalVersionMin: '0.5',
      });
      const events = await audit(t);
      // Two failed attempts and one allowed publication.
      expect(events.slice(before)).toEqual([
        expect.objectContaining({ action: 'data_policy.publish', outcome: 'allowed' }),
      ]);
      await expect(publish(policy(), 1, dry.contentHash!)).rejects.toMatchObject({
        code: 'no_change',
      });
      const entries = await c.sql<{ key: string; introduced_in: number; last_changed_in: number }>(
        `SELECT key, introduced_in, last_changed_in FROM tenant_registry_entries WHERE tenant_id = $1`,
        [t.tenantId],
      );
      expect(entries).toEqual([{ key: 'data_policy', introduced_in: 1, last_changed_in: 1 }]);
      const second = await registry().dryRun(t, 'data_policy', policy({ retention: {} }));
      await publish(policy({ retention: {} }), 1, second.contentHash!);
      expect(
        await c.sql(
          `SELECT key, introduced_in, last_changed_in FROM tenant_registry_entries WHERE tenant_id = $1`,
          [t.tenantId],
        ),
      ).toEqual([{ key: 'data_policy', introduced_in: 1, last_changed_in: 2 }]);
      // Versions are immutable for the app role.
      await expect(
        asApp(t, (db) => db.query(`UPDATE tenant_registry_versions SET effective_from = now()`)),
      ).rejects.toThrow(/permission denied/);
    });

    it('kinds without a document schema are refused; data_policy needs its own capability', async () => {
      const t = await c.tenant('regkind', 1001);
      expect(await registry().dryRun(t, 'metric', {})).toMatchObject({
        available: false,
        issues: ['registry_kind_not_available'],
      });
      await expect(
        registry().publish(await authz(t, 'config.registry.publish'), 'metric', {
          document: {},
          expectedBaseVersion: 0,
          expectedContentHash: 'a'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'registry_kind_not_available' });
      await expect(
        registry().publish(await authz(t, 'config.registry.publish'), 'data_policy', {
          document: policy(),
          expectedBaseVersion: 0,
          expectedContentHash: 'a'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'capability_not_granted' });
    });

    it('M10D: kind extension needs 0.4 and the module, refuses unclassified / credential-like definitions, projects classification and enforces R-X6', async () => {
      const t = await c.tenant('regext', 1001);
      const field = (over: Record<string, unknown> = {}) => ({
        key: 'tier',
        target: 'account',
        display_name: 'Tier',
        description: 'Commercial tier',
        value_type: 'enum',
        allowed_values: [{ code: 'gold', label: 'Gold' }],
        sensitivity: 'internal',
        categories: ['commercial'],
        ...over,
      });
      const doc = (over: Record<string, unknown> = {}) => ({
        schema_version: 1,
        fields: [field(over)],
      });
      const publish = async (document: unknown, base: number) => {
        const dry = await registry().dryRun(t, 'extension', document);
        return registry().publish(await authz(t, 'config.registry.publish'), 'extension', {
          document,
          expectedBaseVersion: base,
          expectedContentHash: dry.contentHash ?? 'a'.repeat(64),
        });
      };
      // Module disabled (Q18): the dry run says so; publish is refused and audited.
      expect(await registry().dryRun(t, 'extension', doc())).toMatchObject({
        available: true,
        valid: false,
        issues: ['module_disabled'],
      });
      await expect(publish(doc(), 0)).rejects.toMatchObject({ code: 'module_disabled' });
      await modules().enable(await authz(t, 'config.module.change'), {
        module: 'extension',
        expectedVersion: 0,
      });
      // Control 8 / Q12: classification required; credential-like definitions refused.
      await expect(
        publish(doc({ sensitivity: undefined, categories: undefined }), 0),
      ).rejects.toMatchObject({ code: 'classification_required' });
      await expect(
        publish(doc({ key: 'api_key', display_name: 'API key' }), 0),
      ).rejects.toMatchObject({ code: 'credential_like_definition' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'registry.publish',
        outcome: 'failed',
        reason_code: 'credential_like_definition',
      });
      await expect(publish(doc(), 0)).resolves.toMatchObject({
        kind: 'extension',
        version: 1,
        canonicalVersionMin: '0.5',
        entries: 1,
      });
      expect(
        await c.sql(
          `SELECT key, status, sensitivity, categories, definition->>'kind' AS kind, definition->'codes' AS codes
             FROM tenant_registry_entries WHERE tenant_id = $1 AND kind = 'extension'`,
          [t.tenantId],
        ),
      ).toEqual([
        {
          key: 'tier',
          status: 'active',
          sensitivity: 'internal',
          categories: ['commercial'],
          kind: 'field',
          codes: ['gold'],
        },
      ]);
      // R-X6 (Q11): never weaker; X2: the value type never changes; X3: codes never disappear.
      await expect(publish(doc({ sensitivity: 'public' }), 1)).rejects.toMatchObject({
        code: 'registry_rule_violation',
        detail: { rule: 'R-X6', key: 'tier' },
      });
      await expect(
        publish(doc({ value_type: 'string', allowed_values: undefined }), 1),
      ).rejects.toMatchObject({ code: 'registry_rule_violation' });
      await expect(
        publish(doc({ allowed_values: [{ code: 'silver', label: 'Silver' }] }), 1),
      ).rejects.toMatchObject({ code: 'registry_rule_violation', detail: { rule: 'R-X3' } });
      // Tightening is allowed while no value is stored.
      await expect(
        publish(doc({ sensitivity: 'restricted', categories: ['commercial', 'financial'] }), 1),
      ).resolves.toMatchObject({ version: 2 });
      // Below 0.4 (rollback, Q19) a publish is refused even with the module enabled.
      // M10E: new tenants adopt 0.5; rollback goes one MINOR at a time (0.5 → 0.4 first).
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.3',
        expectedCurrent: '0.4',
      });
      await expect(
        publish(
          doc({ sensitivity: 'restricted', categories: ['commercial', 'financial', 'personal'] }),
          2,
        ),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
    });

    it('M10E (V6 subset): kind context_type needs 0.5 and the module, refuses restricted dimensions, projects classification and enforces R-C1 / R-C2 / R-C4', async () => {
      const t = await c.tenant('regctx', 1001);
      const dim = (over: Record<string, unknown> = {}) => ({
        key: 'region',
        type: 'code',
        required: true,
        codes: ['emea', 'amer'],
        sensitivity: 'internal',
        categories: ['operational'],
        ...over,
      });
      const product = {
        key: 'product',
        type: 'product_key',
        required: true,
        sensitivity: 'internal',
        categories: ['commercial'],
      };
      const doc = (dimensions: unknown[], extra: Record<string, unknown>[] = []) => ({
        schema_version: 1,
        types: [
          {
            key: 'product_region',
            title: 'Product in a region',
            description: 'One product of the account in one region',
            dimensions,
            member_roles: ['csm'],
          },
          ...extra,
        ],
      });
      const publish = async (document: unknown, base: number) => {
        const dry = await registry().dryRun(t, 'context_type', document);
        return registry().publish(await authz(t, 'config.registry.publish'), 'context_type', {
          document,
          expectedBaseVersion: base,
          expectedContentHash: dry.contentHash ?? 'a'.repeat(64),
        });
      };
      // Module disabled (Q17): the dry run says so; publish is refused and audited.
      expect(await registry().dryRun(t, 'context_type', doc([product, dim()]))).toMatchObject({
        available: true,
        valid: false,
        issues: ['module_disabled'],
      });
      await expect(publish(doc([product, dim()]), 0)).rejects.toMatchObject({
        code: 'module_disabled',
      });
      await modules().enable(await authz(t, 'config.module.change'), {
        module: 'account_context',
        expectedVersion: 0,
      });
      // R-C5 (Q11): restricted dimensions are refused with their own reason code.
      await expect(
        publish(doc([product, dim({ sensitivity: 'restricted', categories: ['commercial'] })]), 0),
      ).rejects.toMatchObject({ code: 'restricted_dimension_refused' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'registry.publish',
        outcome: 'failed',
        reason_code: 'restricted_dimension_refused',
      });
      await expect(publish(doc([product, dim()]), 0)).resolves.toMatchObject({
        kind: 'context_type',
        version: 1,
        canonicalVersionMin: '0.5',
        entries: 1,
      });
      expect(
        await c.sql(
          `SELECT key, status, sensitivity, categories, definition->>'kind' AS kind, definition->'codes' AS codes
             FROM tenant_registry_entries WHERE tenant_id = $1 AND kind = 'context_type'`,
          [t.tenantId],
        ),
      ).toEqual([
        {
          key: 'product_region',
          status: 'active',
          sensitivity: 'internal',
          categories: ['operational', 'commercial'],
          kind: 'context_type',
          codes: ['csm'],
        },
      ]);
      // R-C1: dimension order never changes; R-C2: a code never disappears.
      await expect(publish(doc([dim(), product]), 1)).rejects.toMatchObject({
        code: 'registry_rule_violation',
        detail: { rule: 'R-C1', key: 'product_region' },
      });
      await expect(publish(doc([product, dim({ codes: ['emea'] })]), 1)).rejects.toMatchObject({
        code: 'registry_rule_violation',
        detail: { rule: 'R-C2', key: 'product_region' },
      });
      // R-C4: an extension_ref dimension needs module extension.
      const segmented = {
        key: 'segmented',
        title: 'Segment',
        description: 'Account segment from an extension field',
        dimensions: [
          dim({
            key: 'segment',
            type: 'extension_ref',
            codes: undefined,
            extension_field: 'segment',
          }),
        ],
      };
      await expect(publish(doc([product, dim()], [segmented]), 1)).rejects.toMatchObject({
        code: 'module_disabled',
      });
      // A new code is allowed.
      await expect(
        publish(doc([product, dim({ codes: ['emea', 'amer', 'apac'] })]), 1),
      ).resolves.toMatchObject({ version: 2 });
      // Below 0.5 (rollback, Q18) a publish is refused even with the module enabled.
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      await expect(
        publish(doc([product, dim({ codes: ['emea', 'amer', 'apac', 'latam'] })]), 2),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
    });

    it('V9: the schema refuses raw retention and disabled classes; the provider resolves policy ?? defaults; purge stays disabled', async () => {
      const t = await c.tenant('regdp', 1001);
      expect(
        (await registry().dryRun(t, 'data_policy', policy({ raw_retention: true }))).valid,
      ).toBe(false);
      expect(
        (
          await registry().dryRun(
            t,
            'data_policy',
            policy({ retention: { raw_rejected_value: { days: 10 } } }),
          )
        ).valid,
      ).toBe(false);
      const defaults = await db().transaction(t, (tx) => tenantRetention(tx));
      expect(defaults.policyVersion).toBeNull();
      expect(defaults.operational_diagnostics).toEqual({
        kind: 'days',
        days: 90,
        source: 'default',
      });
      const dry = await registry().dryRun(t, 'data_policy', policy());
      await registry().publishDataPolicy(await authz(t, 'config.data_policy.publish'), {
        document: policy(),
        expectedBaseVersion: 0,
        expectedContentHash: dry.contentHash!,
      });
      const resolved = await db().transaction(t, (tx) => tenantRetention(tx));
      expect(resolved.policyVersion).toBe(1);
      expect(resolved.operational_diagnostics).toEqual({
        kind: 'days',
        days: 30,
        source: 'policy',
      });
      expect(resolved.raw_rejected_value).toEqual({ kind: 'disabled', source: 'default' });
      expect(AUDIT_PURGE_EXECUTION_APPROVED).toBe(false);
    });

    it('V9: the audit-purge report reads the security_audit retention from the published policy', async () => {
      const t = await c.tenant('regpurge', 1001);
      const ops = c.app.get(SecurityOperationsService);
      await expect(ops.purge(t, { execute: false })).resolves.toMatchObject({
        dryRun: true,
        retentionDays: 365,
        retentionSource: 'default',
        policyVersion: null,
      });
      const doc = policy({ retention: { security_audit: { days: 400 } } });
      const dry = await registry().dryRun(t, 'data_policy', doc);
      await registry().publishDataPolicy(await authz(t, 'config.data_policy.publish'), {
        document: doc,
        expectedBaseVersion: 0,
        expectedContentHash: dry.contentHash!,
      });
      const now = new Date();
      const report = await ops.purge(t, { execute: false, now });
      expect(report).toMatchObject({
        dryRun: true,
        retentionDays: 400,
        retentionSource: 'policy',
        policyVersion: 1,
        purged: 0,
      });
      expect(new Date(report.cutoff).getTime()).toBe(now.getTime() - 400 * 86_400_000);
      // Execution stays refused whatever the policy says.
      await expect(
        ops.purge(await authz(t, 'data.purge'), { execute: true }),
      ).rejects.toMatchObject({ code: 'audit_purge_disabled' });
    });

    it('V18: secret-like values in a registry document are refused (audited denied)', async () => {
      const t = await c.tenant('regsec', 1001);
      await expect(
        registry().publishDataPolicy(await authz(t, 'config.data_policy.publish'), {
          document: policy({ note: AWS_SHAPED }),
          expectedBaseVersion: 0,
          expectedContentHash: 'a'.repeat(64),
        }),
      ).rejects.toBeInstanceOf(SecretLikeValueError);
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'data_policy.publish',
        outcome: 'denied',
        reason_code: 'secret_like_value',
      });
      expect(
        await c.sql(`SELECT 1 FROM tenant_registry_versions WHERE tenant_id = $1`, [t.tenantId]),
      ).toEqual([]);
    });
  });

  describe('V10/V11: entity index and polymorphic references', () => {
    const index = (t: TenantContext) =>
      c.sql<{ kind: string; entity_id: string | null; entity_key: string | null }>(
        `SELECT kind, entity_id::text, entity_key FROM tenant_entity_index WHERE tenant_id = $1 ORDER BY kind, entity_id, entity_key`,
        [t.tenantId],
      );

    it('V10: inserts and deletes keep the index consistent; identity updates are refused', async () => {
      const t = await c.tenant('idx', 1001);
      const id = await companyOf(t, '701');
      expect(await index(t)).toEqual([{ kind: 'company', entity_id: id, entity_key: null }]);
      await c.h.catalogue.publish(await authz(t, 'config.product_model.publish'), genericModel(), {
        basedOnVersion: 0,
      });
      const products = (await index(t)).filter((r) => r.kind === 'product');
      expect(products.map((p) => p.entity_key).sort()).toEqual(
        genericModel()
          .products.map((p) => p.key)
          .sort(),
      );
      await expect(
        c.sql(`UPDATE companies SET id = gen_random_uuid() WHERE tenant_id = $1 AND id = $2`, [
          t.tenantId,
          id,
        ]),
      ).rejects.toThrow(/id is immutable on companies/);
      await expect(
        c.sql(`UPDATE tenant_products SET key = 'renamed' WHERE tenant_id = $1 AND key = 'core'`, [
          t.tenantId,
        ]),
      ).rejects.toThrow(/key is immutable on tenant_products/);
      // A physical delete (owner; no history references it) removes the index row.
      const other = randomUUID();
      await c.sql(
        `INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES ($1, $2, 'Tmp', now(), now())`,
        [other, t.tenantId],
      );
      expect((await index(t)).some((r) => r.entity_id === other)).toBe(true);
      await c.sql(`DELETE FROM companies WHERE tenant_id = $1 AND id = $2`, [t.tenantId, other]);
      expect((await index(t)).some((r) => r.entity_id === other)).toBe(false);
    });

    it('V10: the app role can read but never write the index', async () => {
      const t = await c.tenant('idxapp', 1001);
      const id = await companyOf(t, '702');
      await expect(
        asApp(t, (db) =>
          db.query(`SELECT kind FROM tenant_entity_index WHERE entity_id = $1`, [id]),
        ),
      ).resolves.toMatchObject({ rows: [{ kind: 'company' }] });
      for (const sql of [
        `INSERT INTO tenant_entity_index (tenant_id, kind, entity_id) VALUES ('${t.tenantId}', 'company', gen_random_uuid())`,
        `DELETE FROM tenant_entity_index`,
        `UPDATE tenant_entity_index SET kind = 'person'`,
      ]) {
        await expect(
          asApp(t, (db) => db.query(sql)),
          sql,
        ).rejects.toThrow(/permission denied/);
      }
    });

    it('V11: a value-history row cannot reference another tenant’s entity (by id or by product key)', async () => {
      const a = await c.tenant('isoa', 1001);
      const b = await c.tenant('isob', 2002);
      const companyB = await companyOf(b, '801');
      await c.h.catalogue.publish(await authz(b, 'config.product_model.publish'), genericModel(), {
        basedOnVersion: 0,
      });
      const companyA = await companyOf(a, '802');
      const [changeA] = await c.sql<{ id: string }>(
        `SELECT id::text FROM tenant_context_changes WHERE tenant_id = $1 AND entity_id = $2`,
        [a.tenantId, companyA],
      );
      const insert = (kind: string, idCol: string, value: string, field: string) =>
        c.sql(
          `INSERT INTO tenant_value_history (tenant_id, id, entity_kind, ${idCol}, field, values_recorded,
             effective_at, change_id, retention_class, actor_kind, actor_id, actor_assurance)
           VALUES ($1, gen_random_uuid(), $2, $3, $4, false, now(), $5, 'canonical_lifecycle', 'system', 'test', 'system')`,
          [a.tenantId, kind, value, field, changeA!.id],
        );
      // The owner bypasses RLS: only the composite FK stands in the way.
      await expect(insert('company', 'entity_id', companyB, 'name')).rejects.toThrow(
        /tenant_value_history_tenant_id_entity_kind_entity_id_fkey/,
      );
      // No product field has value history in M10A2 (Q14), so the key FK is
      // exercised with the field CHECK lifted inside a rolled-back transaction
      // (test database only). Tenant A has no product model: 'core' exists only
      // in tenant B's index.
      await expect(
        withAdmin(c.adminUrl, async (db) => {
          await db.query('BEGIN');
          try {
            await db.query(
              'ALTER TABLE tenant_value_history DROP CONSTRAINT tenant_value_history_field_valid',
            );
            await db.query(
              `INSERT INTO tenant_value_history (tenant_id, id, entity_kind, entity_key, field, values_recorded,
                 effective_at, change_id, retention_class, actor_kind, actor_id, actor_assurance)
               VALUES ($1, gen_random_uuid(), 'product', 'core', 'name', false, now(), $2, 'canonical_lifecycle', 'system', 'test', 'system')`,
              [a.tenantId, changeA!.id],
            );
          } finally {
            await db.query('ROLLBACK');
          }
        }),
      ).rejects.toThrow(/tenant_value_history_tenant_id_entity_kind_entity_key_fkey/);
      // Seed governance rows in every table for tenant B (and, for the
      // mapping tables, a second foreign tenant with a Sugar connection), so
      // the zero counts below are meaningful.
      await c.sql(
        `UPDATE canonical_modules SET available = true, minimum_canonical_version = '0.1'
          WHERE module_key = 'account_context'`,
      );
      await modules().enable(await authz(b, 'config.module.change'), {
        module: 'account_context',
        expectedVersion: 0,
      });
      const policyB = { schema: 1, raw_retention: false, retention: {} };
      const dryB = await registry().dryRun(b, 'data_policy', policyB);
      await registry().publishDataPolicy(await authz(b, 'config.data_policy.publish'), {
        document: policyB,
        expectedBaseVersion: 0,
        expectedContentHash: dryB.contentHash!,
      });
      // No M10A2 path writes registry entries yet: the owner plants one.
      await c.sql(
        `INSERT INTO tenant_registry_entries (tenant_id, id, kind, key, definition, introduced_in, last_changed_in, updated_at)
         VALUES ($1, gen_random_uuid(), 'data_policy', 'v11_seed', '{}', 1, 1, now())`,
        [b.tenantId],
      );
      await integrity().record(await authz(b, 'security.integrity.run'));
      const fake = await new FakeSugar().start();
      try {
        const sugarB = await sugarTenant(c, fake, { prefix: 'isosugar' });
        const mappings = sourcesServices(c).mappings;
        const doc = (await mappings.show(sugarB.ctx, sugarB.connectionId))!.document;
        await mappings.saveDraft(
          await authz(sugarB.ctx, 'config.mapping.draft'),
          sugarB.connectionId,
          doc,
          0,
        );
      } finally {
        await fake.stop();
      }
      const tables = [
        'tenant_canonical_adoptions',
        'tenant_entity_index',
        'tenant_value_history',
        'tenant_module_settings',
        'tenant_module_setting_events',
        'tenant_registry_versions',
        'tenant_registry_entries',
        'tenant_source_mapping_lifecycle',
        'tenant_source_mapping_drafts',
        'tenant_integrity_runs',
      ];
      const foreignRows = async (query: (sql: string) => Promise<number>) => {
        const out: Record<string, number> = {};
        for (const table of tables) {
          out[table] = await query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id <> $1`);
        }
        return out;
      };
      // The owner (no RLS) sees foreign rows in every table…
      const planted = await foreignRows(
        async (sql) => (await c.sql<{ n: number }>(sql, [a.tenantId]))[0]!.n,
      );
      for (const table of tables) expect(planted[table], table).toBeGreaterThan(0);
      // …and as the app role, tenant A sees none of them.
      const seen = await asApp(a, (db) =>
        foreignRows(async (sql) => (await db.query<{ n: number }>(sql, [a.tenantId])).rows[0]!.n),
      );
      expect(seen).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
      await expect(
        asApp(a, (db) =>
          db.query(
            `INSERT INTO tenant_canonical_adoptions (tenant_id, id, seq, version, reason, actor_kind, actor_id, actor_assurance, correlation_id)
             VALUES ($1, gen_random_uuid(), 1, '0.1', 'new_tenant', 'system', 'x', 'system', gen_random_uuid())`,
            [b.tenantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('V12/V13/V14: value history and change-record governance', () => {
    const history = (t: TenantContext) =>
      c.sql<{
        entity_kind: string;
        field: string;
        values_recorded: boolean;
        old_value: unknown;
        new_value: unknown;
        retention_class: string;
        policy_version: number | null;
        change_id: string;
      }>(
        `SELECT entity_kind, field, values_recorded, old_value, new_value, retention_class, policy_version, change_id::text
           FROM tenant_value_history WHERE tenant_id = $1 ORDER BY recorded_at, field`,
        [t.tenantId],
      );

    it('V12/V14: a company create and rename record history and governance columns in the same transaction', async () => {
      const t = await c.tenant('vh', 1001);
      const id = await companyOf(t, '901', 'First Name');
      await companyOf(t, '901', 'Second Name');
      const rows = await history(t);
      expect(rows.map((r) => [r.field, r.values_recorded, r.old_value, r.new_value])).toEqual([
        ['name', true, null, 'First Name'],
        ['name', true, 'First Name', 'Second Name'],
      ]);
      expect(rows.every((r) => r.retention_class === 'canonical_lifecycle')).toBe(true);
      const changes = await c.sql<{
        id: string;
        origin: string;
        canonical_version: string;
        transforms: string[] | null;
      }>(
        `SELECT id::text, origin, canonical_version, transforms FROM tenant_context_changes
          WHERE tenant_id = $1 AND entity_id = $2 ORDER BY ingested_at`,
        [t.tenantId, id],
      );
      expect(changes.length).toBeGreaterThanOrEqual(2);
      expect(changes.every((ch) => ch.origin === 'source_provided')).toBe(true);
      expect(changes.every((ch) => ch.canonical_version === '0.5')).toBe(true);
      // Every history row points at a change record of this entity.
      for (const r of rows) expect(changes.map((ch) => ch.id)).toContain(r.change_id);
    });

    it('V12: subscription lines record the catalogued fields', async () => {
      const t = await c.tenant('vhsub', 1001);
      await c.h.catalogue.publish(await authz(t, 'config.product_model.publish'), genericModel(), {
        basedOnVersion: 0,
      });
      await companyOf(t, '911');
      const file = new TextEncoder().encode(
        [
          'record_id,account,product,state,starts_at,ends_at,quantity,source_updated_at',
          'V1,hubspot:companies:911,core,active,2026-01-01T00:00:00Z,2027-01-01T00:00:00Z,10,2026-01-01T00:00:00Z',
        ].join('\n') + '\n',
      );
      await c.h.imports.import(await authz(t, 'canonical.import'), file, {
        source: 'billing',
        mode: 'full',
        execute: true,
        correlationId: randomUUID(),
      });
      const rows = (await history(t)).filter((r) => r.entity_kind === 'subscription');
      expect(rows.map((r) => r.field).sort()).toEqual([
        'ends_at',
        'product_key',
        'quantity',
        'starts_at',
        'state',
      ]);
      expect(rows.find((r) => r.field === 'product_key')!.new_value).toBe('core');
      const [change] = await c.sql<{ origin: string; canonical_version: string }>(
        `SELECT origin, canonical_version FROM tenant_context_changes
          WHERE tenant_id = $1 AND entity_kind = 'subscription'`,
        [t.tenantId],
      );
      expect(change).toEqual({ origin: 'source_provided', canonical_version: '0.5' });
    });

    it('V12: a failed write leaves neither the projection, the change record nor the history row', async () => {
      const t = await c.tenant('vhtx', 1001);
      const ingestion = c.ingestion as unknown as { store: { insertRef: () => Promise<void> } };
      vi.spyOn(ingestion.store, 'insertRef').mockRejectedValueOnce(new Error('boom'));
      await expect(companyOf(t, '921')).rejects.toThrow(/boom/);
      expect(await c.sql(`SELECT 1 FROM companies WHERE tenant_id = $1`, [t.tenantId])).toEqual([]);
      expect(
        await c.sql(`SELECT 1 FROM tenant_context_changes WHERE tenant_id = $1`, [t.tenantId]),
      ).toEqual([]);
      expect(await history(t)).toEqual([]);
    });

    it('V12: a sensitive field is recorded value-free unless the published data policy allows values', async () => {
      // None of the seven catalogued fields is sensitive in M10A2 (Q14), so the
      // real classification never exercises restricted history end to end. The
      // test raises company.name to `restricted` for its duration (VM15 proved
      // that without this the suppression was covered by unit tests only).
      const manifest = CLASSIFICATION_MANIFEST as Record<string, Record<string, unknown>>;
      const original = manifest.companies!.name;
      manifest.companies!.name = {
        ...(original as object),
        sensitivity: 'restricted',
      };
      try {
        const t = await c.tenant('vhsens', 1001);
        await companyOf(t, '941', 'Restricted One');
        await companyOf(t, '941', 'Restricted Two');
        expect(
          (await history(t)).map((r) => [
            r.field,
            r.values_recorded,
            r.old_value,
            r.new_value,
            r.policy_version,
          ]),
        ).toEqual([
          ['name', false, null, null, null],
          ['name', false, null, null, null],
        ]);
        // A published data policy that allows company.name values turns them on.
        const document = {
          schema: 1,
          raw_retention: false,
          value_history: { allow: [{ entity_kind: 'company', field: 'name', days: 30 }] },
        };
        const dry = await registry().dryRun(t, 'data_policy', document);
        await registry().publishDataPolicy(await authz(t, 'config.data_policy.publish'), {
          document,
          expectedBaseVersion: 0,
          expectedContentHash: dry.contentHash!,
        });
        await companyOf(t, '941', 'Restricted Three');
        const rows = await history(t);
        expect(rows).toHaveLength(3);
        expect(rows[2]).toMatchObject({
          field: 'name',
          values_recorded: true,
          old_value: 'Restricted Two',
          new_value: 'Restricted Three',
          retention_class: 'sensitive_value_history',
          policy_version: 1,
        });
      } finally {
        manifest.companies!.name = original;
      }
    });

    it('V13: no value of a sensitive column is ever kept in value history (scan of every row)', async () => {
      const rows = await c.sql<{
        entity_kind: string;
        field: string;
        values_recorded: boolean;
        policy_version: number | null;
      }>(`SELECT entity_kind, field, values_recorded, policy_version FROM tenant_value_history`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        const col = valueHistoryColumn(r.entity_kind, r.field)!;
        const cls = CLASSIFICATION_MANIFEST[col.table]![col.column]!;
        if (isSensitiveForHistory(cls)) {
          expect(
            r.values_recorded && r.policy_version === null,
            `${r.entity_kind}.${r.field}`,
          ).toBe(false);
        }
      }
    });

    it('V14: a tenant with no adoption row fails closed (canonical_version_unknown), writing nothing', async () => {
      const t = await c.tenant('vhnone', 1001);
      await c.sql(
        `SET session_replication_role = replica;
         DELETE FROM tenant_canonical_adoptions WHERE tenant_id = '${t.tenantId}';
         SET session_replication_role = origin`,
      );
      await expect(companyOf(t, '931')).rejects.toThrow(/has no canonical adoption/);
      expect(await c.sql(`SELECT 1 FROM companies WHERE tenant_id = $1`, [t.tenantId])).toEqual([]);
    });
  });

  describe('V17: integrity verification', () => {
    it('a clean tenant passes; planted orphan, missing row and cross-tenant index row (an orphan in A only) are found, raised and never repaired', async () => {
      const a = await c.tenant('inta', 1001);
      const b = await c.tenant('intb', 2002);
      await companyOf(a, '951');
      const companyB = await companyOf(b, '952');
      let emitted = securityEvents();
      const clean = await integrity().record(await authz(a, 'security.integrity.run'));
      expect(clean.outcome).toBe('passed');
      expect(emitted).toContainEqual(expect.objectContaining({ event: 'integrity_run_completed' }));
      const [run] = await c.sql<{ outcome: string; audit_event_id: string }>(
        `SELECT outcome, audit_event_id::text FROM tenant_integrity_runs WHERE tenant_id = $1 AND id = $2`,
        [a.tenantId, clean.runId],
      );
      expect(run!.outcome).toBe('passed');
      expect((await audit(a)).at(-1)).toMatchObject({
        id: run!.audit_event_id,
        action: 'integrity.verify',
        outcome: 'allowed',
      });

      // Plant (owner, test database): an orphan index row, a company without
      // its index row, and an index row in A naming B's company.
      const orphan = randomUUID();
      const unindexed = randomUUID();
      await c.sql(
        `INSERT INTO tenant_entity_index (tenant_id, kind, entity_id) VALUES ($1, 'company', $2), ($1, 'company', $3)`,
        [a.tenantId, orphan, companyB],
      );
      await c.sql(
        `INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES ($1, $2, 'Planted', now(), now())`,
        [unindexed, a.tenantId],
      );
      await c.sql(`DELETE FROM tenant_entity_index WHERE tenant_id = $1 AND entity_id = $2`, [
        a.tenantId,
        unindexed,
      ]);
      vi.restoreAllMocks();
      emitted = securityEvents();
      const found = await integrity().record(await authz(a, 'security.integrity.run'));
      expect(found.outcome).toBe('findings');
      expect(found.findings).toEqual(
        expect.arrayContaining([
          { check: 'entity_index_orphan', ref: `company:${orphan}` },
          // Under RLS another tenant's entity is invisible: the mismatch surfaces as an orphan in A.
          { check: 'entity_index_orphan', ref: `company:${companyB}` },
          { check: 'entity_index_missing', ref: `company:${unindexed}` },
        ]),
      );
      expect(emitted).toContainEqual(
        expect.objectContaining({ event: 'integrity_violation_detected', outcome: 'detected' }),
      );
      // Codes and identifiers only, never values.
      expect(JSON.stringify(emitted)).not.toMatch(/Planted|Company 95/);
      // Nothing repaired.
      expect(
        await c.sql(
          `SELECT 1 FROM tenant_entity_index WHERE tenant_id = $1 AND entity_id = ANY($2::uuid[])`,
          [a.tenantId, [orphan, companyB]],
        ),
      ).toHaveLength(2);
      // Tenant B is untouched and still clean.
      expect((await integrity().verify(b)).outcome).toBe('passed');
      // Integrity runs are append-only.
      await expect(
        c.sql(`UPDATE tenant_integrity_runs SET outcome = 'passed' WHERE tenant_id = $1`, [
          a.tenantId,
        ]),
      ).rejects.toThrow(/append-only/);
    });
    it('a purge anchor exempts only audit pointers on rows before its cutoff', async () => {
      const t = await c.tenant('intanchor', 1001);
      await companyOf(t, '961');
      const old = await integrity().record(await authz(t, 'security.integrity.run'));
      const recent = await integrity().record(await authz(t, 'security.integrity.run'));
      // Plant (owner, test database): an anchor with a past cutoff, and dangling
      // audit pointers on one run older than the cutoff and one recent run.
      await c.sql(
        `SET session_replication_role = replica;
         INSERT INTO tenant_audit_anchors (tenant_id, id, anchor_seq, anchor_hash, purged, cutoff, actor, correlation_id)
           VALUES ('${t.tenantId}', '${randomUUID()}', 1, '${'a'.repeat(64)}', 1, now() - interval '1 day', 'system:test', '${randomUUID()}');
         UPDATE tenant_integrity_runs SET audit_event_id = '${randomUUID()}', started_at = now() - interval '2 days'
           WHERE tenant_id = '${t.tenantId}' AND id = '${old.runId}';
         UPDATE tenant_integrity_runs SET audit_event_id = '${randomUUID()}'
           WHERE tenant_id = '${t.tenantId}' AND id = '${recent.runId}';
         SET session_replication_role = origin`,
      );
      const report = await integrity().verify(t);
      const refs = report.findings
        .filter((f) => f.check === 'audit_reference_missing')
        .map((f) => f.ref);
      expect(refs).toEqual([`integrity_run:${recent.runId}`]);
    });
  });

  it('source_sync actors cannot adopt a canonical version (policy v2)', async () => {
    const t = await c.tenant('pol', 1001);
    await expect(
      authz(t, 'config.canonical.adopt', sourceSyncActor('run:x')),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });
});
