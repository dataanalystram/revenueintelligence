import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretLikeValueError } from '../../src/modules/domain';
import {
  AccountContextMembershipWriter,
  AccountContextReadModel,
  AccountContextWriter,
} from '../../src/modules/context';
import {
  CanonicalAdoptionService,
  ModuleSettingsService,
  RegistryService,
} from '../../src/modules/governance';
import type { TenantContext } from '../../src/modules/tenancy';
import { companies } from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import {
  field as extensionField,
  enableExtension,
  publishExtension,
  registryVersion,
  services as extensionServices,
  sourceProvenance,
} from '../support/extension';
import { authz } from '../support/security';

/** Pattern-shaped test strings are assembled at runtime: no real secret is in the repository. */
const AWS_SHAPED = 'AKIA' + 'Q'.repeat(16);
const REASON = 'governance_test';
const CONTEXT_FEATURES = [
  'account_context',
  'context_type_registry',
  'context_membership',
  'line_context',
];

type Dim = Record<string, unknown>;
type TypeDef = Record<string, unknown>;

/** A `code` dimension (internal / operational) with overrides. */
const region = (over: Dim = {}): Dim => ({
  key: 'region',
  type: 'code',
  required: true,
  codes: ['emea', 'amer', 'apac'],
  sensitivity: 'internal',
  categories: ['operational'],
  ...over,
});
const tier = (over: Dim = {}): Dim => ({
  key: 'tier',
  type: 'string',
  required: false,
  sensitivity: 'internal',
  categories: ['commercial'],
  ...over,
});
/** A synthetic context type (no customer vocabulary): one region of an account. */
const scopeType = (over: TypeDef = {}): TypeDef => ({
  key: 'region_scope',
  title: 'Regional scope',
  description: 'One region of the account (synthetic test type)',
  dimensions: [region()],
  member_roles: ['csm', 'sponsor'],
  ...over,
});
const doc = (...types: TypeDef[]) => ({ schema_version: 1, types });

/**
 * M10E AccountContext governance on real PostgreSQL (app role, forced RLS;
 * plan §2, §10, §18; ADR 0031): the 0.5 + module gate on every operator entry
 * point, each refusal audited with its reason code (V5); the `context_type`
 * registry publish rules R-C1–R-C6, credential-like / secret-like refusal and
 * the classification requirement (V6); adoption 0.4 → 0.5 dry run and apply,
 * then the rollback 0.5 → 0.4 with the module still enabled: data kept and
 * readable, writes refused and audited, 0.5 again restores writes (V25).
 * Synthetic context types and accounts only.
 */
describe('M10E account context governance', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });

  const adoption = () => c.app.get(CanonicalAdoptionService);
  const modules = () => c.app.get(ModuleSettingsService);
  const registry = () => c.app.get(RegistryService);
  const writer = () => c.app.get(AccountContextWriter);
  const members = () => c.app.get(AccountContextMembershipWriter);
  const reads = () => c.app.get(AccountContextReadModel);

  const audit = (t: TenantContext) =>
    c.sql<{
      action: string;
      outcome: string;
      reason_code: string | null;
      details: Record<string, unknown>;
    }>(
      `SELECT action, outcome, reason_code, details FROM tenant_audit_events
        WHERE tenant_id = $1 ORDER BY seq`,
      [t.tenantId],
    );
  const count = async (sql: string, params: unknown[]): Promise<number> =>
    (await c.sql<{ n: number }>(sql, params))[0]?.n ?? -1;
  const typeVersion = async (t: TenantContext): Promise<number> =>
    (
      await c.sql<{ v: number | null }>(
        `SELECT max(version)::int AS v FROM tenant_registry_versions WHERE tenant_id = $1 AND kind = 'context_type'`,
        [t.tenantId],
      )
    )[0]?.v ?? 0;

  async function enableContexts(t: TenantContext): Promise<void> {
    const [row] = await c.sql<{ version: number }>(
      `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'account_context'`,
      [t.tenantId],
    );
    await modules().enable(await authz(t, 'config.module.change'), {
      module: 'account_context',
      expectedVersion: row?.version ?? 0,
    });
  }
  /** Dry run → reviewed hash → publish on the current base version. */
  async function publish(t: TenantContext, document: unknown) {
    const dry = await registry().dryRun(t, 'context_type', document);
    return registry().publish(await authz(t, 'config.registry.publish'), 'context_type', {
      document,
      expectedBaseVersion: await typeVersion(t),
      expectedContentHash: dry.contentHash ?? 'a'.repeat(64),
    });
  }
  /** The refusal of a publish: its code and (for rule violations) the rule and key. */
  async function refusal(t: TenantContext, document: unknown) {
    try {
      await publish(t, document);
    } catch (e) {
      const err = e as { code?: string; detail?: Record<string, unknown> };
      return { code: err.code, detail: err.detail };
    }
    throw new Error('publish was not refused');
  }
  const contextsOf = (t: TenantContext) =>
    c.sql<{
      id: string;
      company_id: string;
      name: string;
      status: string;
      owner_ref: string | null;
      dimensions: Record<string, unknown>;
    }>(
      `SELECT id::text, company_id::text, name, status, owner_ref, dimensions
         FROM tenant_account_contexts WHERE tenant_id = $1 ORDER BY created_at, id`,
      [t.tenantId],
    );

  /**
   * Every operator entry point of AccountContext, each refused with `code`
   * and audited (`failed`, reason = code) under its own action.
   */
  async function expectAllRefused(
    t: TenantContext,
    accountId: string,
    contextId: string,
    code: 'canonical_version_too_low' | 'module_disabled',
  ): Promise<void> {
    const human = () => authz(t, 'canonical.human_entry');
    const attempts: [string, () => Promise<unknown>][] = [
      [
        'account_context.write',
        async () =>
          writer().write(await human(), {
            account: accountId,
            type: 'region_scope',
            dimensions: { region: 'apac' },
            name: 'Synthetic APAC scope',
            reason: REASON,
          }),
      ],
      [
        'account_context.write',
        async () =>
          writer().write(await human(), { context: contextId, name: 'Renamed', reason: REASON }),
      ],
      [
        'account_context.retire',
        async () => writer().retire(await human(), { context: contextId, reason: REASON }),
      ],
      [
        'account_context.write',
        async () => writer().reactivate(await human(), { context: contextId, reason: REASON }),
      ],
      [
        'account_context.release',
        async () => writer().release(await human(), { context: contextId, reason: REASON }),
      ],
      [
        'account_context.line.assign',
        async () =>
          writer().assignLine(await human(), {
            line: randomUUID(),
            context: contextId,
            reason: REASON,
          }),
      ],
      [
        'account_context.member.set',
        async () =>
          members().add(await human(), {
            context: contextId,
            person: randomUUID(),
            role: 'csm',
            reason: REASON,
          }),
      ],
      [
        'account_context.member.set',
        async () =>
          members().end(await human(), {
            context: contextId,
            person: randomUUID(),
            role: 'csm',
            reason: REASON,
          }),
      ],
      [
        'account_context.member.set',
        async () =>
          members().addProduct(await human(), {
            context: contextId,
            product: 'core',
            reason: REASON,
          }),
      ],
    ];
    for (const [action, attempt] of attempts) {
      await expect(attempt(), action).rejects.toMatchObject({ code });
      expect((await audit(t)).at(-1), action).toMatchObject({
        action,
        outcome: 'failed',
        reason_code: code,
      });
    }
  }

  describe('V5: the 0.5 + module gate, refusals audited', () => {
    it('below 0.5 every write is canonical_version_too_low (module enable too); at 0.5 with the module disabled every write is module_disabled; reads stay allowed; nothing is written', async () => {
      // Below 0.5 (a tenant rolled back to 0.4): version first, whatever the module says.
      const low = await c.tenant('acgatelow', 1001);
      const lowIds = await companies(c, low, ['6101']);
      await adoption().adopt(await authz(low, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      await expect(
        modules().enable(await authz(low, 'config.module.change'), {
          module: 'account_context',
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      expect((await audit(low)).at(-1)).toMatchObject({
        action: 'module.enable',
        outcome: 'failed',
        reason_code: 'canonical_version_too_low',
      });
      await expectAllRefused(low, lowIds['6101']!, randomUUID(), 'canonical_version_too_low');
      await expect(publish(low, doc(scopeType()))).rejects.toMatchObject({
        code: 'canonical_version_too_low',
      });

      // At 0.5 with the module disabled.
      const off = await c.tenant('acgateoff', 1001);
      const offIds = await companies(c, off, ['6201']);
      expect(await registry().dryRun(off, 'context_type', doc(scopeType()))).toMatchObject({
        valid: false,
        issues: ['module_disabled'],
      });
      await expect(publish(off, doc(scopeType()))).rejects.toMatchObject({
        code: 'module_disabled',
      });
      expect(
        (await audit(off)).filter(
          (e) => e.action === 'registry.publish' && e.reason_code === 'module_disabled',
        ),
      ).not.toHaveLength(0);
      await expectAllRefused(off, offIds['6201']!, randomUUID(), 'module_disabled');

      // Reads are allowed whatever the gate (Q18 / Q20) and audited.
      for (const [t, id] of [
        [low, lowIds['6101']!],
        [off, offIds['6201']!],
      ] as const) {
        await expect(
          reads().listForAccounts(await authz(t, 'data.account_context.read'), {
            companyIds: [id],
          }),
        ).resolves.toEqual({ contexts: [], truncated: false });
        expect((await audit(t)).at(-1)).toMatchObject({
          action: 'account_context.read',
          outcome: 'allowed',
        });
        expect(await contextsOf(t)).toEqual([]);
        expect(
          await count(
            `SELECT count(*)::int AS n FROM tenant_registry_versions WHERE tenant_id = $1 AND kind = 'context_type'`,
            [t.tenantId],
          ),
        ).toBe(0);
        expect(
          await count(
            `SELECT count(*)::int AS n FROM tenant_context_changes
              WHERE tenant_id = $1 AND entity_kind IN ('account_context', 'account_context_person')`,
            [t.tenantId],
          ),
        ).toBe(0);
      }

      // Enabled: the same write succeeds and is audited once.
      await enableContexts(off);
      await publish(off, doc(scopeType()));
      const written = await writer().write(await authz(off, 'canonical.human_entry'), {
        account: offIds['6201']!,
        type: 'region_scope',
        dimensions: { region: 'emea' },
        name: 'Synthetic EMEA scope',
        reason: REASON,
      });
      expect(written).toMatchObject({ type: 'region_scope', created: true, changed: true });
      expect((await audit(off)).at(-1)).toMatchObject({
        action: 'account_context.write',
        outcome: 'allowed',
      });
    });
  });

  describe('V6: context type publish rules', () => {
    it('classification required and floored, credential-like and secret-like refused, restricted refused (R-C5); R-C1 / R-C2 / R-C3 / R-X3; R-C6 retire never delete, no new context of a retired type; R-C4 extension_ref', async () => {
      const t = await c.tenant('actypes', 1001);
      await enableContexts(t);
      const ids = await companies(c, t, ['6301', '6302']);

      // Classification is required on every dimension (dry run lists it; publish refuses with its own code).
      const unclassified = doc(
        scopeType({ dimensions: [region({ sensitivity: undefined, categories: undefined })] }),
      );
      expect((await registry().dryRun(t, 'context_type', unclassified)).issues).toEqual([
        'region_scope.region: classification_required',
      ]);
      expect(await refusal(t, unclassified)).toMatchObject({ code: 'classification_required' });
      expect(
        await refusal(t, doc(scopeType({ dimensions: [region({ categories: [] })] }))),
      ).toMatchObject({ code: 'classification_required' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'registry.publish',
        outcome: 'failed',
        reason_code: 'classification_required',
      });
      // Category floor: personal needs at least confidential.
      expect(
        (
          await registry().dryRun(
            t,
            'context_type',
            doc(scopeType({ dimensions: [region({ categories: ['personal'] })] })),
          )
        ).issues,
      ).toEqual(['region_scope.region: classification_below_floor']);
      // R-C5: credential-like titles and dimension keys (whole words), restricted dimensions.
      expect(await refusal(t, doc(scopeType({ title: 'Password reset scope' })))).toMatchObject({
        code: 'credential_like_definition',
      });
      expect(
        await refusal(t, doc(scopeType({ dimensions: [region(), tier({ key: 'secret' })] }))),
      ).toMatchObject({ code: 'credential_like_definition' });
      expect(
        await refusal(t, doc(scopeType({ dimensions: [region({ sensitivity: 'restricted' })] }))),
      ).toMatchObject({ code: 'restricted_dimension_refused' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'registry.publish',
        outcome: 'failed',
        reason_code: 'restricted_dimension_refused',
      });
      // A secret-like value anywhere in the document is refused before parsing (audited denied, never stored).
      await expect(
        publish(t, doc(scopeType({ description: `Scope ${AWS_SHAPED}` }))),
      ).rejects.toBeInstanceOf(SecretLikeValueError);
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'registry.publish',
        outcome: 'denied',
        reason_code: 'secret_like_value',
      });
      expect(JSON.stringify(await audit(t))).not.toContain(AWS_SHAPED);
      expect(await typeVersion(t)).toBe(0);

      // v1: region + optional tier; the entry projects the strictest classification and the roles.
      const v1 = scopeType({ dimensions: [region(), tier()] });
      await expect(publish(t, doc(v1))).resolves.toMatchObject({
        kind: 'context_type',
        version: 1,
        canonicalVersionMin: '0.5',
        entries: 1,
      });
      expect(
        await c.sql(
          `SELECT key, status, sensitivity, categories, definition->'codes' AS codes
             FROM tenant_registry_entries WHERE tenant_id = $1 AND kind = 'context_type'`,
          [t.tenantId],
        ),
      ).toEqual([
        {
          key: 'region_scope',
          status: 'active',
          sensitivity: 'internal',
          categories: ['operational', 'commercial'],
          codes: ['csm', 'sponsor'],
        },
      ]);

      // R-C1: dimensions never added, removed, reordered or retyped.
      const rc1: TypeDef[] = [
        scopeType({ dimensions: [region(), tier(), tier({ key: 'segment' })] }),
        scopeType({ dimensions: [region()] }),
        scopeType({ dimensions: [tier(), region()] }),
        scopeType({ dimensions: [region(), tier({ type: 'code', codes: ['gold'] })] }),
      ];
      for (const changed of rc1) {
        expect(await refusal(t, doc(changed))).toEqual({
          code: 'registry_rule_violation',
          detail: { rule: 'R-C1', key: 'region_scope' },
        });
      }
      // R-C2: a code never disappears.
      expect(
        await refusal(
          t,
          doc(scopeType({ dimensions: [region({ codes: ['emea', 'amer'] }), tier()] })),
        ),
      ).toEqual({ code: 'registry_rule_violation', detail: { rule: 'R-C2', key: 'region_scope' } });
      // R-C3: classification never weakens and never drops a category.
      for (const weaker of [
        region({ sensitivity: 'public' }),
        region({ categories: ['commercial'] }),
      ]) {
        expect(await refusal(t, doc(scopeType({ dimensions: [weaker, tier()] })))).toEqual({
          code: 'registry_rule_violation',
          detail: { rule: 'R-C3', key: 'region_scope' },
        });
      }
      // Member roles never disappear (generic R-X3 over the projected codes).
      expect(
        await refusal(t, doc(scopeType({ dimensions: [region(), tier()], member_roles: ['csm'] }))),
      ).toEqual({ code: 'registry_rule_violation', detail: { rule: 'R-X3', key: 'region_scope' } });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'registry.publish',
        outcome: 'failed',
        reason_code: 'registry_rule_violation',
      });
      expect(await typeVersion(t)).toBe(1);
      // Allowed: a new code, a stricter classification, a new role.
      await expect(
        publish(
          t,
          doc(
            scopeType({
              dimensions: [
                region({ codes: ['emea', 'amer', 'apac', 'latam'] }),
                tier({ sensitivity: 'confidential' }),
              ],
              member_roles: ['csm', 'sponsor', 'owner'],
            }),
          ),
        ),
      ).resolves.toMatchObject({ version: 2 });
      const live = scopeType({
        dimensions: [
          region({ codes: ['emea', 'amer', 'apac', 'latam'] }),
          tier({ sensitivity: 'confidential' }),
        ],
        member_roles: ['csm', 'sponsor', 'owner'],
      });

      // R-C6: a type with live contexts is retired, never deleted; no new context of a retired type.
      const human = () => authz(t, 'canonical.human_entry');
      const kept = await writer().write(await human(), {
        account: ids['6301']!,
        type: 'region_scope',
        dimensions: { region: 'emea' },
        name: 'Synthetic EMEA scope',
        reason: REASON,
      });
      expect(kept.created).toBe(true);
      const other = scopeType({ key: 'other_scope', title: 'Other scope' });
      await publish(t, doc(live, other));
      expect(await refusal(t, doc(other))).toEqual({
        code: 'registry_rule_violation',
        detail: { rule: 'R-X1', key: 'region_scope' },
      });
      await expect(publish(t, doc({ ...live, status: 'retired' }, other))).resolves.toMatchObject({
        version: 4,
      });
      expect(
        await c.sql(
          `SELECT key, status FROM tenant_registry_entries WHERE tenant_id = $1 AND kind = 'context_type' ORDER BY key`,
          [t.tenantId],
        ),
      ).toEqual([
        { key: 'other_scope', status: 'active' },
        { key: 'region_scope', status: 'retired' },
      ]);
      await expect(
        writer().write(await human(), {
          account: ids['6302']!,
          type: 'region_scope',
          dimensions: { region: 'amer' },
          name: 'Synthetic AMER scope',
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'account_context.write',
        outcome: 'failed',
        reason_code: 'validation_failed',
      });
      // The live context is untouched by the retirement.
      expect(await contextsOf(t)).toEqual([
        expect.objectContaining({
          id: kept.contextId,
          company_id: ids['6301'],
          status: 'active',
          dimensions: { region: 'emea' },
        }),
      ]);
      const retiredLive = { ...live, status: 'retired' };

      // R-C4: an extension_ref dimension needs module extension and an active
      // string / enum / integer extension field targeting account_context.
      const segmented = (fieldKey: string) =>
        scopeType({
          key: `seg_${fieldKey}`,
          title: `Segment by ${fieldKey}`,
          dimensions: [
            {
              key: 'segment',
              type: 'extension_ref',
              required: true,
              extension_field: fieldKey,
              sensitivity: 'internal',
              categories: ['commercial'],
            },
          ],
        });
      expect(await refusal(t, doc(retiredLive, other, segmented('segment')))).toMatchObject({
        code: 'module_disabled',
      });
      await enableExtension(c, t);
      await publishExtension(c, t, {
        schema_version: 1,
        fields: [
          extensionField('segment', 'enum', {
            target: 'account_context',
            allowed_values: [
              { code: 'smb', label: 'SMB' },
              { code: 'ent', label: 'Enterprise' },
            ],
          }),
          extensionField('seats', 'integer', { target: 'account_context' }),
          extensionField('notes', 'text', { target: 'account_context' }),
          extensionField('acct_code', 'string'),
        ],
      });
      for (const [key, expected] of [
        ['notes', 'R-C4'], // text is not a dimension value type
        ['acct_code', 'R-C4'], // targets account, not account_context
        ['missing', 'R-C4'], // no such field
      ] as const) {
        expect(await refusal(t, doc(retiredLive, other, segmented(key)))).toEqual({
          code: 'registry_rule_violation',
          detail: { rule: expected, key: `seg_${key}.segment` },
        });
      }
      await expect(
        publish(t, doc(retiredLive, other, segmented('segment'), segmented('seats'))),
      ).resolves.toMatchObject({ version: 5, entries: 4 });
      // The referenced field is part of the dimension's meaning (R-C1).
      const repointed = segmented('segment');
      (repointed.dimensions as Dim[])[0]!.extension_field = 'seats';
      expect(
        await refusal(t, doc(retiredLive, other, repointed, segmented('seats'))),
      ).toMatchObject({
        code: 'registry_rule_violation',
        detail: { rule: 'R-C1', key: 'seg_segment' },
      });
      expect(await typeVersion(t)).toBe(5);
    });
  });

  describe('V25: adoption 0.4 → 0.5 and rollback with the module enabled', () => {
    it('the dry run lists the newly available module and the enabled features; apply; the rollback dry run lists the stranded module; at 0.4 data is kept and readable and every write is refused (audited); 0.5 again restores writes', async () => {
      const t = await c.tenant('acadopt', 1001);
      const ids = await companies(c, t, ['6401']);
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      // Forward dry run 0.4 → 0.5.
      expect(await adoption().plan(t, '0.5', '0.4')).toMatchObject({
        current: '0.4',
        target: '0.5',
        decision: 'operator_adoption',
        modulesNewlyAvailable: ['account_context'],
        modulesStranded: [],
        enables: CONTEXT_FEATURES,
        disables: [],
      });
      const auditBeforeAdopt = (await audit(t)).length;
      await expect(
        adoption().adopt(await authz(t, 'config.canonical.adopt'), {
          target: '0.5',
          expectedCurrent: '0.4',
        }),
      ).resolves.toMatchObject({ version: '0.5', previousVersion: '0.4' });
      expect((await audit(t)).slice(auditBeforeAdopt)).toEqual([
        expect.objectContaining({ action: 'canonical.adopt', outcome: 'allowed' }),
      ]);
      // Adoption never changes module settings: the module is still disabled.
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'account_context' AND enabled`,
          [t.tenantId],
        ),
      ).toBe(0);
      await enableContexts(t);
      await publish(t, doc(scopeType()));
      const human = () => authz(t, 'canonical.human_entry');
      const ctx = await writer().write(await human(), {
        account: ids['6401']!,
        type: 'region_scope',
        dimensions: { region: 'emea' },
        name: 'Synthetic EMEA scope',
        ownerRef: 'owner-6401',
        reason: REASON,
      });
      const before = await contextsOf(t);
      expect(before).toHaveLength(1);

      // Rollback dry run 0.5 → 0.4: the enabled module is stranded, the features withdrawn.
      expect(await adoption().plan(t, '0.4', '0.5')).toMatchObject({
        current: '0.5',
        target: '0.4',
        decision: 'rollback',
        modulesNewlyAvailable: [],
        modulesStranded: ['account_context'],
        registriesAboveTarget: 1,
        enables: [],
        disables: CONTEXT_FEATURES,
      });
      // The rollback is allowed with the module on and keeps the setting.
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'account_context' AND enabled`,
          [t.tenantId],
        ),
      ).toBe(1);
      // Data kept and readable (list + show), audited.
      const read = await reads().listForAccounts(await authz(t, 'data.account_context.read'), {
        companyIds: [ids['6401']!],
      });
      expect(read.contexts).toEqual([
        expect.objectContaining({
          id: ctx.contextId,
          type: 'region_scope',
          name: 'Synthetic EMEA scope',
          ownerRef: 'owner-6401',
          dimensions: { region: 'emea' },
        }),
      ]);
      await expect(
        reads().get(await authz(t, 'data.account_context.read'), { contextId: ctx.contextId }),
      ).resolves.toMatchObject({ id: ctx.contextId, status: 'active' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'account_context.read',
        outcome: 'allowed',
      });
      // Writes refused, each audited canonical_version_too_low; the registry too.
      await expectAllRefused(t, ids['6401']!, ctx.contextId, 'canonical_version_too_low');
      await expect(
        publish(t, doc(scopeType({ member_roles: ['csm', 'sponsor', 'owner'] }))),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'registry.publish',
        outcome: 'failed',
        reason_code: 'canonical_version_too_low',
      });
      expect(await contextsOf(t)).toEqual(before);
      expect(await typeVersion(t)).toBe(1);

      // Forward again: writes resume on the kept data.
      expect(await adoption().plan(t, '0.5', '0.4')).toMatchObject({
        decision: 'operator_adoption',
        modulesStranded: [],
      });
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.5',
        expectedCurrent: '0.4',
      });
      await expect(
        writer().write(await human(), {
          context: ctx.contextId,
          name: 'Synthetic EMEA scope renamed',
          reason: REASON,
        }),
      ).resolves.toMatchObject({ contextId: ctx.contextId, created: false, changed: true });
      expect((await contextsOf(t))[0]).toMatchObject({ name: 'Synthetic EMEA scope renamed' });
    });
  });

  describe('Review M2: relationship ends and reference values naming account_context are gated (Q19)', () => {
    const ctxRel = {
      key: 'acct_scope',
      display_name: 'Account scope',
      description: 'Synthetic relationship from an account to one of its contexts',
      from: 'account',
      to: 'account_context',
      cardinality: 'many_to_many',
      sensitivity: 'internal',
      categories: ['operational'],
    };
    const ctxRelReversed = { ...ctxRel, key: 'scope_acct', from: 'account_context', to: 'account' };
    const ctxRef = extensionField('scope_ref', 'reference', {
      constraints: { reference_to: ['account_context'] },
    });
    const extDoc = (over: Record<string, unknown>) => ({
      schema_version: 1,
      fields: [],
      objects: [],
      relationships: [],
      ...over,
    });
    async function extRefusal(t: TenantContext, document: unknown) {
      try {
        await registry().publish(await authz(t, 'config.registry.publish'), 'extension', {
          document,
          expectedBaseVersion: await registryVersion(c, t),
          expectedContentHash: 'a'.repeat(64),
        });
      } catch (e) {
        return (e as { code?: string }).code;
      }
      throw new Error('publish was not refused');
    }

    it('publish: a relationship end or a reference_to naming account_context needs 0.5 + module account_context (dry run issues, refusals audited)', async () => {
      const low = await c.tenant('acm2low', 1001);
      await enableExtension(c, low);
      await adoption().adopt(await authz(low, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      const off = await c.tenant('acm2off', 1001);
      await enableExtension(c, off);
      for (const document of [
        extDoc({ relationships: [ctxRel] }),
        extDoc({ relationships: [ctxRelReversed] }),
        extDoc({ fields: [ctxRef] }),
      ]) {
        for (const [t, code] of [
          [low, 'canonical_version_too_low'],
          [off, 'module_disabled'],
        ] as const) {
          expect(await registry().dryRun(t, 'extension', document)).toMatchObject({
            valid: false,
            issues: expect.arrayContaining([code]) as unknown,
          });
          expect(await extRefusal(t, document)).toBe(code);
          expect((await audit(t)).at(-1)).toMatchObject({
            outcome: 'failed',
            reason_code: code,
          });
        }
      }
      expect(await registryVersion(c, low)).toBe(0);
      expect(await registryVersion(c, off)).toBe(0);
      // With the gate open the same definitions publish.
      await enableContexts(off);
      await expect(
        publishExtension(c, off, extDoc({ fields: [ctxRef], relationships: [ctxRel] })),
      ).resolves.toMatchObject({ version: 1 });
    });

    it('writers: with the gate closed after publish, relationship edges and reference values naming a context are refused (operator audited, source counted by code)', async () => {
      const t = await c.tenant('acm2wr', 1001);
      const ids = await companies(c, t, ['6301']);
      const account = ids['6301']!;
      await enableExtension(c, t);
      await enableContexts(t);
      await publishExtension(c, t, extDoc({ fields: [ctxRef], relationships: [ctxRel] }));
      const [row] = await c.sql<{ version: number }>(
        `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'account_context'`,
        [t.tenantId],
      );
      await modules().disable(await authz(t, 'config.module.change'), {
        module: 'account_context',
        expectedVersion: row!.version,
      });
      const ext = extensionServices(c);
      const human = () => authz(t, 'canonical.human_entry');
      const ctxId = randomUUID();

      await expect(
        ext.relationships.add(await human(), {
          relationship: 'acct_scope',
          from: `account:${account}`,
          to: `account_context:${ctxId}`,
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'module_disabled' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'extension.relationship.add',
        outcome: 'failed',
        reason_code: 'module_disabled',
      });
      await expect(
        ext.relationships.observeSource(await authz(t, 'canonical.source_sync'), {
          relationshipKey: 'acct_scope',
          from: { kind: 'company', id: account },
          to: null,
          observedAt: new Date(),
          provenance: sourceProvenance('m2-rel'),
        }),
      ).resolves.toEqual({ status: 'module_disabled' });

      await expect(
        ext.values.set(await human(), {
          target: `account:${account}`,
          field: 'scope_ref',
          value: `account_context:${ctxId}`,
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'module_disabled' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'extension.value.set',
        outcome: 'failed',
        reason_code: 'module_disabled',
      });
      await expect(
        ext.values.observeSource(await authz(t, 'canonical.source_sync'), {
          target: { kind: 'company', id: account },
          values: [{ field: 'scope_ref', raw: `account_context:${ctxId}` }],
          observedAt: new Date(),
          provenance: sourceProvenance('m2-val'),
        }),
      ).resolves.toMatchObject({ status: 'ok', written: 0, rejected: { module_disabled: 1 } });

      // Below 0.5 the code is canonical_version_too_low.
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.5',
      });
      await expect(
        ext.relationships.add(await human(), {
          relationship: 'acct_scope',
          from: `account:${account}`,
          to: `account_context:${ctxId}`,
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      expect((await audit(t)).at(-1)).toMatchObject({
        action: 'extension.relationship.add',
        outcome: 'failed',
        reason_code: 'canonical_version_too_low',
      });
      await expect(
        ext.values.set(await human(), {
          target: `account:${account}`,
          field: 'scope_ref',
          value: `account_context:${ctxId}`,
          reason: REASON,
        }),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_custom_relationships WHERE tenant_id = $1`,
          [t.tenantId],
        ),
      ).toBe(0);
      expect(
        await count(`SELECT count(*)::int AS n FROM tenant_extension_values WHERE tenant_id = $1`, [
          t.tenantId,
        ]),
      ).toBe(0);
    });
  });
});
