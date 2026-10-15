import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_LIKE_TOKENS } from '../../src/modules/domain';
import {
  CustomRecordWriter,
  CustomRelationshipWriter,
  ExtensionReadModel,
  ExtensionValueWriter,
} from '../../src/modules/extension';
import {
  CanonicalAdoptionService,
  IntegrityVerificationService,
  ModuleSettingsService,
  RegistryService,
} from '../../src/modules/governance';
import { SecurityEventsService, type TenantContext } from '../../src/modules/tenancy';
import { companies } from '../support/account-structure';
import { startContextHarness, type ContextHarness } from '../support/context';
import { authz } from '../support/security';

/** Pattern-shaped test strings are assembled at runtime: no real secret is in the repository. */
const AWS_SHAPED = 'AKIA' + 'Q'.repeat(16);

const M10D_CHECKS = [
  'extension_value_type_mismatch',
  'extension_value_restricted',
  'extension_value_target_kind',
  'extension_items_parity',
  'extension_value_secret_like',
  'custom_record_parent_missing',
  'custom_relationship_cardinality',
  'extension_history_parity',
] as const;

type Doc = {
  schema_version: 1;
  fields?: Record<string, unknown>[];
  objects?: Record<string, unknown>[];
  relationships?: Record<string, unknown>[];
};

/** A field definition (account, internal / commercial, display only) with overrides. */
const field = (key: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key,
  target: 'account',
  display_name: `Field ${key}`,
  description: `Extension field ${key}`,
  value_type: 'string',
  sensitivity: 'internal',
  categories: ['commercial'],
  ...over,
});
const object = (key: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key,
  display_name: `Object ${key}`,
  description: `Custom object ${key}`,
  sensitivity: 'internal',
  categories: ['operational'],
  ...over,
});
const relationship = (
  key: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  key,
  display_name: `Relationship ${key}`,
  description: `Custom relationship ${key}`,
  from: 'custom_object:site',
  to: 'account',
  cardinality: 'many_to_many',
  sensitivity: 'internal',
  categories: ['operational'],
  ...over,
});

/**
 * M10D extension governance on real PostgreSQL (plan §2, §10, §13, §14, §16;
 * ADR 0030): registry publish of kind `extension` end to end (V3) — dry run
 * and reviewed hash, credential-like refusal (Q12), classification (control
 * 8), X1–X4, X5 narrowing probes against planted values, R-X6 monotonic
 * classification including tightening to `restricted` refused while data
 * exists (Q10 / Q11), guardrails incl. the 2 MiB document cap (Q3) and
 * retired definitions counted, `promoted` refused (Q28); data-policy `ext:`
 * allow entries (R-DP-EXT, Q23); no per-tenant DDL during a 600-field publish
 * and value writes (V15, §13); adoption dry run with `modulesStranded` and
 * the rollback to 0.3 that keeps reads and refuses writes (V18, Q19); the
 * eight integrity checks with planted findings (V20).
 */
describe('M10D extension governance', () => {
  let c: ContextHarness;

  beforeAll(async () => {
    c = await startContextHarness();
  });
  afterAll(async () => {
    await c?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  const adoption = () => c.app.get(CanonicalAdoptionService);
  const modules = () => c.app.get(ModuleSettingsService);
  const registry = () => c.app.get(RegistryService);
  const integrity = () => c.app.get(IntegrityVerificationService);
  const values = () => c.app.get(ExtensionValueWriter);
  const records = () => c.app.get(CustomRecordWriter);
  const edges = () => c.app.get(CustomRelationshipWriter);
  const reads = () => c.app.get(ExtensionReadModel);

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
  const securityEvents = () => {
    const service = c.app.get(SecurityEventsService, { strict: false });
    const emitted: Record<string, unknown>[] = [];
    vi.spyOn(service, 'emit').mockImplementation((e) => void emitted.push({ ...e }));
    return emitted;
  };
  const count = async (sql: string, params: unknown[]): Promise<number> =>
    (await c.sql<{ n: number }>(sql, params))[0]?.n ?? -1;

  /** A tenant at 0.4 with module `extension` enabled. */
  async function extensionTenant(prefix: string): Promise<TenantContext> {
    const t = await c.tenant(prefix, 1001);
    await modules().enable(await authz(t, 'config.module.change'), {
      module: 'extension',
      expectedVersion: 0,
    });
    return t;
  }
  async function publish(t: TenantContext, document: Doc, base: number) {
    const dry = await registry().dryRun(t, 'extension', document);
    return registry().publish(await authz(t, 'config.registry.publish'), 'extension', {
      document,
      expectedBaseVersion: base,
      expectedContentHash: dry.contentHash ?? 'a'.repeat(64),
    });
  }
  /** The refusal of a publish: its code and (for rule violations) the rule and key. */
  async function refusal(t: TenantContext, document: Doc, base: number) {
    try {
      await publish(t, document, base);
    } catch (e) {
      const err = e as { code?: string; detail?: Record<string, unknown>; message?: string };
      return { code: err.code, detail: err.detail, message: err.message ?? '' };
    }
    throw new Error('publish was not refused');
  }
  const versions = (t: TenantContext) =>
    count(
      `SELECT count(*)::int AS n FROM tenant_registry_versions WHERE tenant_id = $1 AND kind = 'extension'`,
      [t.tenantId],
    );
  async function setValue(t: TenantContext, target: string, key: string, value: string) {
    return values().set(await authz(t, 'canonical.human_entry'), {
      target,
      field: key,
      value,
      reason: 'governance_test',
    });
  }
  const valueIdOf = async (t: TenantContext, key: string): Promise<string> => {
    const [row] = await c.sql<{ id: string }>(
      `SELECT v.id::text AS id FROM tenant_extension_values v
         JOIN tenant_registry_entries e ON e.tenant_id = v.tenant_id AND e.kind = 'extension' AND e.id = v.field_id
        WHERE v.tenant_id = $1 AND e.key = $2`,
      [t.tenantId, key],
    );
    if (!row) throw new Error(`no value of ${key}`);
    return row.id;
  };
  const entryIdOf = async (t: TenantContext, key: string): Promise<string> => {
    const [row] = await c.sql<{ id: string }>(
      `SELECT id::text FROM tenant_registry_entries WHERE tenant_id = $1 AND kind = 'extension' AND key = $2`,
      [t.tenantId, key],
    );
    return row!.id;
  };

  describe('V3: registry publish of kind extension', () => {
    it('the dry run writes nothing; publish needs the reviewed hash and the base version; an unchanged document is no_change', async () => {
      const t = await extensionTenant('xpub');
      const doc: Doc = { schema_version: 1, fields: [field('tier')] };
      const before = (await audit(t)).length;
      const dry = await registry().dryRun(t, 'extension', doc);
      expect(dry).toMatchObject({
        kind: 'extension',
        available: true,
        valid: true,
        issues: [],
        currentVersion: 0,
        canonicalVersionMin: '0.4',
      });
      expect(dry.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await registry().dryRun(t, 'extension', structuredClone(doc))).toMatchObject({
        contentHash: dry.contentHash,
      });
      expect(await versions(t)).toBe(0);
      expect(await audit(t)).toHaveLength(before);
      const publishAs = async (hash: string, base: number) =>
        registry().publish(await authz(t, 'config.registry.publish'), 'extension', {
          document: doc,
          expectedBaseVersion: base,
          expectedContentHash: hash,
        });
      await expect(publishAs('b'.repeat(64), 0)).rejects.toMatchObject({
        code: 'expected_hash_mismatch',
      });
      await expect(publishAs(dry.contentHash!, 1)).rejects.toMatchObject({
        code: 'stale_base_version',
      });
      expect(await versions(t)).toBe(0);
      await expect(publishAs(dry.contentHash!, 0)).resolves.toMatchObject({
        version: 1,
        contentHash: dry.contentHash,
        entries: 1,
      });
      await expect(publishAs(dry.contentHash!, 1)).rejects.toMatchObject({ code: 'no_change' });
      expect(await versions(t)).toBe(1);
      expect((await audit(t)).filter((e) => e.action === 'registry.publish')).toEqual([
        expect.objectContaining({ outcome: 'failed', reason_code: 'expected_hash_mismatch' }),
        expect.objectContaining({ outcome: 'failed', reason_code: 'stale_base_version' }),
        expect.objectContaining({ outcome: 'allowed', reason_code: null }),
        expect.objectContaining({ outcome: 'failed', reason_code: 'no_change' }),
      ]);
    });

    it.each(
      CREDENTIAL_LIKE_TOKENS.map((token, i) => [
        token,
        ['key', 'display_name', 'description'][i % 3]!,
      ]),
    )(
      'Q12: the credential-like token %s in the %s is refused (credential_like_definition, audited, nothing published)',
      async (token, where) => {
        const t = await extensionTenant(`xcred${CREDENTIAL_LIKE_TOKENS.indexOf(token)}`);
        const word = token.replace(/_/g, ' ');
        const over: Record<string, unknown> =
          where === 'key'
            ? { key: `crm_${token}` }
            : where === 'display_name'
              ? { display_name: `Customer ${word}` }
              : { description: `The ${word} of the customer portal` };
        const doc: Doc = { schema_version: 1, fields: [field('portal_ref', over)] };
        const dry = await registry().dryRun(t, 'extension', doc);
        expect(dry.valid).toBe(false);
        expect(dry.issues.some((i) => i.endsWith(': credential_like_definition'))).toBe(true);
        expect(await refusal(t, doc, 0)).toMatchObject({ code: 'credential_like_definition' });
        expect((await audit(t)).at(-1)).toMatchObject({
          action: 'registry.publish',
          outcome: 'failed',
          reason_code: 'credential_like_definition',
        });
        expect(await versions(t)).toBe(0);
      },
    );

    it('Q12 is whole-word only; classification is required on fields, objects and relationships; floors and object ≥ field hold; promoted is refused', async () => {
      const t = await extensionTenant('xclass');
      // Whole words only: tokenizer / secretariat / passwordless are not the tokens.
      const lookalikes: Doc = {
        schema_version: 1,
        fields: [
          field('tokenizer_mode', { display_name: 'Tokenizer mode' }),
          field('secretariat', { description: 'The secretariat that handles the account' }),
        ],
      };
      expect((await registry().dryRun(t, 'extension', lookalikes)).valid).toBe(true);
      const unclassified = (d: Record<string, unknown>) => ({
        ...d,
        sensitivity: undefined,
        categories: undefined,
      });
      const site = object('site');
      for (const doc of [
        { schema_version: 1, fields: [unclassified(field('tier'))] },
        { schema_version: 1, fields: [field('tier', { categories: [] })] },
        { schema_version: 1, objects: [unclassified(site)] },
        {
          schema_version: 1,
          objects: [site],
          relationships: [unclassified(relationship('site_account'))],
        },
      ] as Doc[]) {
        expect(await refusal(t, doc, 0)).toMatchObject({ code: 'classification_required' });
      }
      // Category floor: personal needs at least confidential.
      expect(
        (
          await registry().dryRun(t, 'extension', {
            schema_version: 1,
            fields: [field('pref', { categories: ['personal'], sensitivity: 'internal' })],
          })
        ).issues,
      ).toEqual(['pref: classification_below_floor']);
      // A field on a custom object is never weaker than the object (sensitivity or categories).
      const strictSite = object('site', {
        sensitivity: 'confidential',
        categories: ['commercial'],
      });
      for (const over of [
        { sensitivity: 'internal', categories: ['commercial'] },
        { sensitivity: 'confidential', categories: ['operational'] },
      ]) {
        expect(
          (
            await registry().dryRun(t, 'extension', {
              schema_version: 1,
              objects: [strictSite],
              fields: [field('site_code', { target: 'custom_object:site', ...over })],
            })
          ).issues,
        ).toEqual(['site_code: classification_weaker_than_object']);
      }
      // Q28: promoted is refused at publish.
      expect(
        (
          await registry().dryRun(t, 'extension', {
            schema_version: 1,
            fields: [field('tier', { status: 'promoted' })],
          })
        ).issues,
      ).toEqual(['tier: promotion_not_supported']);
      expect(await versions(t)).toBe(0);
      expect(
        (await audit(t)).filter(
          (e) => e.action === 'registry.publish' && e.reason_code === 'classification_required',
        ),
      ).toHaveLength(4);
    });

    it('X1 (keys never disappear), X2 (value / item type), X3 (codes), X4 (target, kind, relationship ends) refuse with rule and key only', async () => {
      const t = await extensionTenant('xrules');
      const base: Doc = {
        schema_version: 1,
        objects: [object('site'), object('room')],
        fields: [
          field('tier', {
            value_type: 'enum',
            allowed_values: [
              { code: 'gold', label: 'Gold' },
              { code: 'silver', label: 'Silver' },
            ],
          }),
          field('tags', { value_type: 'array', constraints: { item_type: 'string' } }),
          field('note'),
        ],
        relationships: [relationship('site_account')],
      };
      await publish(t, base, 0);
      const edit = (f: (d: Doc) => void): Doc => {
        const d = structuredClone(base);
        f(d);
        return d;
      };
      const cases: [string, Doc, string, string][] = [
        ['X1 key removed', edit((d) => d.fields!.splice(1, 1)), 'R-X1', 'tags'],
        [
          'X2 value type',
          edit((d) => Object.assign(d.fields![2]!, { value_type: 'text' })),
          'R-X2',
          'note',
        ],
        [
          'X2 item type',
          edit((d) => Object.assign(d.fields![1]!, { constraints: { item_type: 'number' } })),
          'R-X2',
          'tags',
        ],
        [
          'X3 code removed',
          edit((d) => (d.fields![0]!.allowed_values as unknown[]).splice(1, 1)),
          'R-X3',
          'tier',
        ],
        [
          'X4 target',
          edit((d) => Object.assign(d.fields![0]!, { target: 'person' })),
          'R-X4',
          'tier',
        ],
        [
          'X4 definition kind (field → object, same key)',
          edit((d) => {
            d.fields!.splice(1, 1);
            d.objects!.push(object('tags'));
          }),
          'R-X4',
          'tags',
        ],
        [
          'X4 relationship end',
          edit((d) => Object.assign(d.relationships![0]!, { from: 'custom_object:room' })),
          'R-X4',
          'site_account',
        ],
      ];
      for (const [label, doc, rule, key] of cases) {
        const r = await refusal(t, doc, 1);
        expect(r, label).toMatchObject({ code: 'registry_rule_violation', detail: { rule, key } });
      }
      // Retiring a code instead of removing it is allowed (X3).
      await expect(
        publish(
          t,
          edit((d) => {
            (d.fields![0]!.allowed_values as Record<string, unknown>[])[1]!.status = 'retired';
          }),
          1,
        ),
      ).resolves.toMatchObject({ version: 2 });
      expect(await versions(t)).toBe(2);
    });

    it('X5: a narrowed constraint is refused while a stored value violates it (bounded probes, no value in the refusal) and allowed otherwise', async () => {
      const t = await extensionTenant('xnarrow');
      const ids = await companies(c, t, ['5101', '5102']);
      const acc1 = `account:${ids['5101']}`;
      const codes = (list: string[], retired: string[] = []) =>
        list.map((code) => ({
          code,
          label: code,
          status: retired.includes(code) ? 'retired' : 'active',
        }));
      const fields = (over: Record<string, Record<string, unknown>> = {}) => [
        field('n_text', { constraints: { max_length: 50 }, ...over.n_text }),
        field('n_int', { value_type: 'integer', constraints: { min: 0, max: 100 }, ...over.n_int }),
        field('n_enum', {
          value_type: 'enum',
          allowed_values: codes(['a', 'b', 'c']),
          ...over.n_enum,
        }),
        field('n_multi', {
          value_type: 'multi_enum',
          allowed_values: codes(['x', 'y', 'z']),
          constraints: { max_items: 3 },
          ...over.n_multi,
        }),
        field('n_json', { value_type: 'json', ...over.n_json }),
        field('n_ref', {
          value_type: 'reference',
          constraints: { reference_to: ['account', 'person'] },
          ...over.n_ref,
        }),
        field('n_money', {
          value_type: 'money',
          sensitivity: 'confidential',
          categories: ['financial'],
          ...over.n_money,
        }),
      ];
      const doc = (
        over: Record<string, Record<string, unknown>> = {},
        cardinality = 'many_to_many',
      ): Doc => ({
        schema_version: 1,
        objects: [object('site')],
        fields: fields(over),
        relationships: [relationship('site_link', { cardinality })],
      });
      await publish(t, doc(), 0);
      const secretish = 'x'.repeat(30);
      await setValue(t, acc1, 'n_text', secretish);
      await setValue(t, acc1, 'n_int', '70');
      await setValue(t, acc1, 'n_enum', 'b');
      await setValue(t, acc1, 'n_multi', 'x;y');
      await setValue(t, acc1, 'n_json', '{"n": 5}');
      await setValue(t, acc1, 'n_ref', acc1);
      await setValue(t, acc1, 'n_money', '12.50 USD');
      const rec = await records().createRecord(await authz(t, 'canonical.human_entry'), {
        object: 'site',
        reason: 'governance_test',
      });
      for (const acc of ['5101', '5102']) {
        await edges().add(await authz(t, 'canonical.human_entry'), {
          relationship: 'site_link',
          from: `custom_record:${rec.recordId}`,
          to: `account:${ids[acc]}`,
          reason: 'governance_test',
        });
      }
      const refused: [string, Doc, string][] = [
        ['max_length 50 → 20', doc({ n_text: { constraints: { max_length: 20 } } }), 'n_text'],
        ['max 100 → 50', doc({ n_int: { constraints: { min: 0, max: 50 } } }), 'n_int'],
        ['min 0 → 80', doc({ n_int: { constraints: { min: 80, max: 100 } } }), 'n_int'],
        [
          'enum code b retired',
          doc({ n_enum: { allowed_values: codes(['a', 'b', 'c'], ['b']) } }),
          'n_enum',
        ],
        [
          'multi_enum item code y retired',
          doc({
            n_multi: {
              allowed_values: codes(['x', 'y', 'z'], ['y']),
              constraints: { max_items: 3 },
            },
          }),
          'n_multi',
        ],
        ['max_items 3 → 1', doc({ n_multi: { constraints: { max_items: 1 } } }), 'n_multi'],
        [
          'json schema added',
          doc({
            n_json: {
              constraints: {
                json_schema: { type: 'object', properties: { n: { type: 'number', maximum: 3 } } },
              },
            },
          }),
          'n_json',
        ],
        [
          'reference_to drops account',
          doc({ n_ref: { constraints: { reference_to: ['person'] } } }),
          'n_ref',
        ],
        [
          'fixed currency EUR added',
          doc({ n_money: { constraints: { currency: 'EUR' } } }),
          'n_money',
        ],
        ['cardinality many_to_many → many_to_one', doc({}, 'many_to_one'), 'site_link'],
        ['cardinality many_to_many → one_to_one', doc({}, 'one_to_one'), 'site_link'],
      ];
      for (const [label, d, key] of refused) {
        const r = await refusal(t, d, 1);
        expect(r, label).toMatchObject({
          code: 'registry_rule_violation',
          detail: { rule: 'R-X5', key },
        });
        expect(r.message, label).not.toContain(secretish);
        expect(JSON.stringify(r.detail), label).not.toMatch(/xxxx|USD|"n"/);
      }
      expect(await versions(t)).toBe(1);
      expect(
        (await audit(t)).filter(
          (e) => e.action === 'registry.publish' && e.reason_code === 'registry_rule_violation',
        ),
      ).toHaveLength(refused.length);
      for (const e of (await audit(t)).filter((x) => x.action === 'registry.publish')) {
        expect(JSON.stringify(e.details)).not.toContain(secretish);
      }
      // The same narrowings where no stored value violates them are allowed.
      await expect(
        publish(
          t,
          doc({
            n_text: { constraints: { max_length: 40 } },
            n_int: { constraints: { min: 10, max: 90 } },
            n_enum: { allowed_values: codes(['a', 'b', 'c'], ['c']) },
            n_multi: {
              allowed_values: codes(['x', 'y', 'z'], ['z']),
              constraints: { max_items: 2 },
            },
            n_json: {
              constraints: {
                json_schema: { type: 'object', properties: { n: { type: 'number', maximum: 10 } } },
              },
            },
            n_ref: { constraints: { reference_to: ['account'] } },
            n_money: { constraints: { currency: 'USD' } },
          }),
          1,
        ),
      ).resolves.toMatchObject({ version: 2 });
    });

    it('R-X6: classification never weakens; tightening to restricted is refused while values, records or edges exist (Q10 / Q11), allowed without them', async () => {
      const t = await extensionTenant('xrx6');
      const ids = await companies(c, t, ['5201']);
      const acc = `account:${ids['5201']}`;
      const doc = (
        tier: Record<string, unknown> = {},
        site: Record<string, unknown> = {},
        link: Record<string, unknown> = {},
        spare: Record<string, unknown> = {},
      ): Doc => ({
        schema_version: 1,
        objects: [object('site', site)],
        fields: [
          field('tier', { sensitivity: 'confidential', categories: ['commercial'], ...tier }),
          field('spare', spare),
        ],
        relationships: [relationship('site_link', { sensitivity: 'confidential', ...link })],
      });
      await publish(t, doc(), 0);
      // Weakening (sensitivity or a dropped category) is refused whether or not data exists.
      for (const [d, key] of [
        [doc({ sensitivity: 'internal' }), 'tier'],
        [doc({ categories: ['operational'] }), 'tier'],
        [doc({}, { sensitivity: 'public' }), 'site'],
        [doc({}, {}, { sensitivity: 'internal' }), 'site_link'],
      ] as [Doc, string][]) {
        expect(await refusal(t, d, 1)).toMatchObject({
          code: 'registry_rule_violation',
          detail: { rule: 'R-X6', key },
        });
      }
      // Data: a value of tier, a record of site with an edge of site_link.
      const planted = 'gold tier note';
      await setValue(t, acc, 'tier', planted);
      const rec = await records().createRecord(await authz(t, 'canonical.human_entry'), {
        object: 'site',
        reason: 'governance_test',
      });
      await edges().add(await authz(t, 'canonical.human_entry'), {
        relationship: 'site_link',
        from: `custom_record:${rec.recordId}`,
        to: acc,
        reason: 'governance_test',
      });
      const restricted = { sensitivity: 'restricted' };
      for (const [d, keys] of [
        [doc(restricted), ['tier']],
        // The object and (never weaker) its relationship: both hold data; either is named.
        [doc({}, restricted, restricted), ['site', 'site_link']],
        [doc({}, {}, restricted), ['site_link']],
      ] as [Doc, string[]][]) {
        const r = await refusal(t, d, 1);
        expect(r).toMatchObject({ code: 'registry_rule_violation', detail: { rule: 'R-X6' } });
        expect(keys).toContain(r.detail!.key);
        expect(r.message).not.toContain(planted);
      }
      // An explicit empty is not a stored value: once cleared, tier may become restricted.
      await values().clear(await authz(t, 'canonical.human_entry'), {
        target: acc,
        field: 'tier',
        reason: 'governance_test',
      });
      // Tightening short of restricted with data, and to restricted without data, are allowed.
      await expect(
        publish(
          t,
          doc(
            restricted,
            { sensitivity: 'confidential' },
            { sensitivity: 'confidential' },
            restricted,
          ),
          1,
        ),
      ).resolves.toMatchObject({ version: 2 });
      const projected = await c.sql<{ key: string; sensitivity: string }>(
        `SELECT key, sensitivity FROM tenant_registry_entries WHERE tenant_id = $1 AND kind = 'extension' ORDER BY key`,
        [t.tenantId],
      );
      expect(projected).toEqual([
        { key: 'site', sensitivity: 'confidential' },
        { key: 'site_link', sensitivity: 'confidential' },
        { key: 'spare', sensitivity: 'restricted' },
        { key: 'tier', sensitivity: 'restricted' },
      ]);
      // A restricted field never stores a value (Q10).
      await expect(setValue(t, acc, 'spare', 'anything')).rejects.toMatchObject({
        code: 'restricted_value_withheld',
      });
    });

    it('guardrails (Q3): 1,000 fields per target within the 2 MiB cap publish; 1,001 (retired ones counted) or a document above 2 MiB is refused, never truncated', async () => {
      const t = await extensionTenant('xguard');
      const many = (n: number, over: (i: number) => Record<string, unknown> = () => ({})) =>
        Array.from({ length: n }, (_, i) => field(`f_${String(i).padStart(4, '0')}`, over(i)));
      // 1,000 fields on account plus 5 on person: within every guardrail.
      const ok: Doc = {
        schema_version: 1,
        fields: [...many(1000), field('p_one', { target: 'person' })],
      };
      await expect(publish(t, ok, 0)).resolves.toMatchObject({ version: 1, entries: 1001 });
      // Retiring one and adding one keeps 1,001 definitions on account: refused (keys never disappear).
      const retiredPlusOne: Doc = {
        schema_version: 1,
        fields: [
          ...many(1000, (i) => (i === 0 ? { status: 'retired' } : {})),
          field('f_extra'),
          field('p_one', { target: 'person' }),
        ],
      };
      expect(await refusal(t, retiredPlusOne, 1)).toMatchObject({
        code: 'extension_guardrail_exceeded',
      });
      expect((await registry().dryRun(t, 'extension', retiredPlusOne)).issues).toEqual([
        'account: extension_guardrail_exceeded',
      ]);
      // Objects, fields per object and enum values are bounded too (E4 §2.4 defaults).
      const objects = Array.from({ length: 101 }, (_, i) => object(`o_${i}`));
      expect(
        (await registry().dryRun(t, 'extension', { schema_version: 1, objects })).issues,
      ).toEqual(['(document): extension_guardrail_exceeded']);
      // A document above EXTENSION_REGISTRY_MAX_BYTES (2 MiB) is refused before validation.
      const big: Doc = {
        schema_version: 1,
        fields: many(1000, () => ({ description: 'd'.repeat(2000) })),
      };
      expect(JSON.stringify(big).length).toBeGreaterThan(2 * 1024 * 1024);
      expect((await registry().dryRun(t, 'extension', big)).issues).toEqual([
        '(document): extension_guardrail_exceeded',
      ]);
      expect(await refusal(t, big, 1)).toMatchObject({ code: 'extension_guardrail_exceeded' });
      expect(await versions(t)).toBe(1);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_registry_entries WHERE tenant_id = $1 AND kind = 'extension'`,
          [t.tenantId],
        ),
      ).toBe(1001);
    });
  });

  describe('R-DP-EXT: data-policy ext: allow entries (Q23)', () => {
    it('an ext:<key> entry must name a current history-enabled field of that target kind; anything else refuses the publish with the entry only', async () => {
      const t = await extensionTenant('xdpol');
      await publish(
        t,
        {
          schema_version: 1,
          objects: [object('site')],
          fields: [
            field('tier', { history: 'value_history' }),
            field('plain'),
            field('site_code', {
              target: 'custom_object:site',
              history: 'value_history',
              categories: ['operational'],
            }),
          ],
        },
        0,
      );
      const policy = (allow: { entity_kind: string; field: string }[]) => ({
        schema: 1,
        raw_retention: false,
        value_history: { allow: allow.map((a) => ({ ...a, days: 365 })) },
      });
      const publishPolicy = async (document: unknown, base: number) => {
        const dry = await registry().dryRun(t, 'data_policy', document);
        return registry().publishDataPolicy(await authz(t, 'config.data_policy.publish'), {
          document,
          expectedBaseVersion: base,
          expectedContentHash: dry.contentHash ?? 'a'.repeat(64),
        });
      };
      for (const [entity_kind, f, key] of [
        ['company', 'ext:plain', 'company.ext:plain'], // no value history
        ['company', 'ext:nope', 'company.ext:nope'], // unknown key
        ['person', 'ext:tier', 'person.ext:tier'], // wrong target kind
        ['company', 'ext:site', 'company.ext:site'], // an object, not a field
        ['company', 'ext:site_code', 'company.ext:site_code'], // a custom-record field
      ] as const) {
        await expect(publishPolicy(policy([{ entity_kind, field: f }]), 0)).rejects.toMatchObject({
          code: 'registry_rule_violation',
          detail: { rule: 'R-DP-EXT', key },
        });
      }
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_registry_versions WHERE tenant_id = $1 AND kind = 'data_policy'`,
          [t.tenantId],
        ),
      ).toBe(0);
      await expect(
        publishPolicy(
          policy([
            { entity_kind: 'company', field: 'ext:tier' },
            { entity_kind: 'custom_record', field: 'ext:site_code' },
          ]),
          0,
        ),
      ).resolves.toMatchObject({ kind: 'data_policy', version: 1 });
    });
  });

  describe('V15: no per-tenant DDL (plan §13)', () => {
    it('a 600-field publish, value writes and a record create issue no DDL (event-trigger capture); the capture itself sees owner DDL', async () => {
      // Test database only: a superuser event trigger records every DDL command start.
      await c.sql(
        `CREATE TABLE IF NOT EXISTS m10d_ddl_capture (tag text NOT NULL, role text NOT NULL)`,
      );
      await c.sql(`CREATE OR REPLACE FUNCTION m10d_ddl_capture_fn() RETURNS event_trigger
                     LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
                   BEGIN INSERT INTO m10d_ddl_capture (tag, role) VALUES (tg_tag, session_user); END $$`);
      await c.sql(`CREATE EVENT TRIGGER m10d_ddl_capture ON ddl_command_start
                     EXECUTE FUNCTION m10d_ddl_capture_fn()`);
      try {
        const t = await extensionTenant('xddl');
        const ids = await companies(c, t, ['5301']);
        await c.sql(`TRUNCATE m10d_ddl_capture`);
        const fields = Array.from({ length: 600 }, (_, i) =>
          field(`d_${String(i).padStart(3, '0')}`, i % 3 === 0 ? { value_type: 'integer' } : {}),
        );
        await publish(
          t,
          {
            schema_version: 1,
            objects: [object('site')],
            fields: [
              ...fields,
              field('site_code', { target: 'custom_object:site', categories: ['operational'] }),
            ],
          },
          0,
        );
        for (let i = 0; i < 10; i += 1) {
          await setValue(t, `account:${ids['5301']}`, `d_${String(i).padStart(3, '0')}`, `${i}`);
        }
        await records().createRecord(await authz(t, 'canonical.human_entry'), {
          object: 'site',
          values: { site_code: 'north' },
          reason: 'governance_test',
        });
        expect(await c.sql(`SELECT tag, role FROM m10d_ddl_capture`)).toEqual([]);
        // The registry and the stores grew by rows, not by objects.
        expect(
          await count(
            `SELECT count(*)::int AS n FROM tenant_registry_entries WHERE tenant_id = $1 AND kind = 'extension'`,
            [t.tenantId],
          ),
        ).toBe(602);
        // Positive control: the capture is live.
        await c.sql(`CREATE TABLE m10d_ddl_probe (x int); DROP TABLE m10d_ddl_probe`);
        expect(
          (await c.sql<{ tag: string }>(`SELECT tag FROM m10d_ddl_capture`)).map((r) => r.tag),
        ).toEqual(['CREATE TABLE', 'DROP TABLE']);
      } finally {
        await c.sql(`DROP EVENT TRIGGER IF EXISTS m10d_ddl_capture`);
        await c.sql(`DROP FUNCTION IF EXISTS m10d_ddl_capture_fn()`);
        await c.sql(`DROP TABLE IF EXISTS m10d_ddl_capture`);
      }
    });
  });

  describe('V18: adoption and module (Q18 / Q19)', () => {
    it('a new tenant is at 0.4 with the module disabled; the rollback dry run lists the stranded module; at 0.3 reads work and writes are refused (audited); 0.4 again restores writes', async () => {
      const t = await c.tenant('xadopt', 1001);
      expect(
        await c.sql(
          `SELECT version, reason FROM tenant_canonical_adoptions WHERE tenant_id = $1 ORDER BY seq`,
          [t.tenantId],
        ),
      ).toEqual([{ version: '0.4', reason: 'new_tenant' }]);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'extension' AND enabled`,
          [t.tenantId],
        ),
      ).toBe(0);
      const ids = await companies(c, t, ['5401']);
      const acc = `account:${ids['5401']}`;
      // Module disabled: operator writes refused (module_disabled, audited).
      await expect(setValue(t, acc, 'tier', 'x')).rejects.toMatchObject({
        code: 'module_disabled',
      });
      expect((await audit(t)).filter((e) => e.reason_code === 'module_disabled')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'extension.value.set', outcome: 'failed' }),
        ]),
      );
      expect(await adoption().plan(t, '0.3', '0.4')).toMatchObject({ modulesStranded: [] });
      await modules().enable(await authz(t, 'config.module.change'), {
        module: 'extension',
        expectedVersion: 0,
      });
      await publish(
        t,
        { schema_version: 1, objects: [object('site')], fields: [field('tier')] },
        0,
      );
      await setValue(t, acc, 'tier', 'gold');
      const rec = await records().createRecord(await authz(t, 'canonical.human_entry'), {
        object: 'site',
        reason: 'governance_test',
      });
      const plan = await adoption().plan(t, '0.3', '0.4');
      expect(plan).toMatchObject({
        current: '0.4',
        target: '0.3',
        decision: 'rollback',
        modulesStranded: ['extension'],
        disables: [
          'extension_registry',
          'extension_values',
          'custom_objects',
          'custom_relationships',
          'source_attribute_capture',
        ],
      });
      // Adoption never changes module settings (M10 §17): the rollback is allowed with the module on.
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.3',
        expectedCurrent: '0.4',
      });
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'extension' AND enabled`,
          [t.tenantId],
        ),
      ).toBe(1);
      // Data kept and readable.
      const read = await reads().valuesFor(await authz(t, 'data.extension.read'), 'display', [acc]);
      expect(read).toEqual([
        expect.objectContaining({ field: 'tier', state: 'present', value: 'gold', shown: true }),
      ]);
      expect(
        (
          await reads().records(await authz(t, 'data.extension.read'), { object: 'site' })
        ).records.map((r) => r.id),
      ).toEqual([rec.recordId]);
      // Writes refused (canonical_version_too_low, audited), nothing changed.
      const auditBefore = (await audit(t)).length;
      await expect(setValue(t, acc, 'tier', 'silver')).rejects.toMatchObject({
        code: 'canonical_version_too_low',
      });
      await expect(
        records().createRecord(await authz(t, 'canonical.human_entry'), {
          object: 'site',
          reason: 'governance_test',
        }),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      await expect(
        publish(
          t,
          { schema_version: 1, objects: [object('site')], fields: [field('tier'), field('more')] },
          1,
        ),
      ).rejects.toMatchObject({ code: 'canonical_version_too_low' });
      const failed = (await audit(t)).slice(auditBefore);
      expect(failed.map((e) => [e.action, e.outcome, e.reason_code])).toEqual(
        expect.arrayContaining([
          ['extension.value.set', 'failed', 'canonical_version_too_low'],
          ['extension.record.create', 'failed', 'canonical_version_too_low'],
          ['registry.publish', 'failed', 'canonical_version_too_low'],
        ]),
      );
      expect(
        await c.sql(`SELECT value_text FROM tenant_extension_values WHERE tenant_id = $1`, [
          t.tenantId,
        ]),
      ).toEqual([{ value_text: 'gold' }]);
      expect(
        await count(`SELECT count(*)::int AS n FROM tenant_custom_records WHERE tenant_id = $1`, [
          t.tenantId,
        ]),
      ).toBe(1);
      // The dry run back to 0.4 enables the features again; writes resume.
      expect(await adoption().plan(t, '0.4', '0.3')).toMatchObject({
        decision: 'operator_adoption',
        modulesStranded: [],
      });
      await adoption().adopt(await authz(t, 'config.canonical.adopt'), {
        target: '0.4',
        expectedCurrent: '0.3',
      });
      await expect(setValue(t, acc, 'tier', 'silver')).resolves.toMatchObject({ changed: true });
    });
  });

  describe('V20: M10D integrity checks', () => {
    it('a clean tenant passes; planted type mismatch, restricted value, target-kind mismatch, items mismatch, secret-like value, missing parent, cardinality violation and history mismatch are found and raised; nothing repaired', async () => {
      const t = await extensionTenant('xinteg');
      const other = await extensionTenant('xintegb');
      const ids = await companies(c, t, ['5501', '5502']);
      const acc = `account:${ids['5501']}`;
      await publish(
        t,
        {
          schema_version: 1,
          objects: [object('site', { parent: { kind: 'account', required: true } })],
          fields: [
            field('note_a'),
            field('note_b'),
            field('note_c'),
            field('note_d'),
            field('tags', {
              value_type: 'multi_enum',
              allowed_values: ['red', 'blue'].map((code) => ({ code, label: code })),
            }),
            field('tier', {
              value_type: 'enum',
              history: 'value_history',
              allowed_values: ['gold', 'silver'].map((code) => ({ code, label: code })),
            }),
          ],
          relationships: [relationship('site_owner', { cardinality: 'many_to_one' })],
        },
        0,
      );
      for (const key of ['note_a', 'note_b', 'note_c', 'note_d'])
        await setValue(t, acc, key, `v ${key}`);
      await setValue(t, acc, 'tags', 'red;blue');
      await setValue(t, acc, 'tier', 'gold');
      const rec = await records().createRecord(await authz(t, 'canonical.human_entry'), {
        object: 'site',
        parent: acc,
        reason: 'governance_test',
      });
      await edges().add(await authz(t, 'canonical.human_entry'), {
        relationship: 'site_owner',
        from: `custom_record:${rec.recordId}`,
        to: acc,
        reason: 'governance_test',
      });
      const clean = await integrity().record(await authz(t, 'security.integrity.run'));
      expect(clean.outcome).toBe('passed');
      for (const check of M10D_CHECKS) expect(Object.keys(clean.checks)).toContain(check);
      const [run] = await c.sql<{ checks: unknown }>(
        `SELECT checks FROM tenant_integrity_runs WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, clean.runId],
      );
      for (const check of M10D_CHECKS) expect(JSON.stringify(run!.checks)).toContain(check);

      // Plant (owner, test database; replica mode bypasses the guard triggers where they would refuse).
      const ON = 'SET session_replication_role = replica;';
      const OFF = 'SET session_replication_role = origin;';
      const v = {
        a: await valueIdOf(t, 'note_a'),
        b: await valueIdOf(t, 'note_b'),
        c: await valueIdOf(t, 'note_c'),
        d: await valueIdOf(t, 'note_d'),
        tags: await valueIdOf(t, 'tags'),
        tier: await valueIdOf(t, 'tier'),
      };
      const entry = async (key: string, set: string) =>
        c.sql(
          `UPDATE tenant_registry_entries SET ${set} WHERE tenant_id = $1 AND kind = 'extension' AND key = $2`,
          [t.tenantId, key],
        );
      // 1. The definition's value type differs from the stored value's.
      await entry('note_a', `definition = jsonb_set(definition, '{value_type}', '"text"')`);
      // 2. A stored value of a field whose effective sensitivity is restricted.
      await entry('note_b', `sensitivity = 'restricted'`);
      // 3. The field's target no longer matches the value's target kind.
      await entry('note_c', `definition = jsonb_set(definition, '{target}', '"person"')`);
      // 4. An item row missing (count parity).
      await c.sql(
        `DELETE FROM tenant_extension_value_items WHERE tenant_id = $1 AND value_id = $2 AND ordinal = 1`,
        [t.tenantId, v.tags],
      );
      // 5. A secret-like text value (the writer would have refused it).
      await c.sql(
        `UPDATE tenant_extension_values SET value_text = $3 WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, v.d, AWS_SHAPED],
      );
      // 6. A record of an object with a required parent, without one.
      await c.sql(
        `${ON} UPDATE tenant_custom_records SET parent_kind = NULL, parent_id = NULL
                WHERE tenant_id = '${t.tenantId}' AND id = '${rec.recordId}'; ${OFF}`,
      );
      // 7. A second active edge from the same record of a many_to_one definition.
      const linkDef = await entryIdOf(t, 'site_owner');
      await c.sql(
        `${ON} INSERT INTO tenant_custom_relationships (tenant_id, rel_def_id, from_kind, from_id, to_kind, to_id, origin)
               VALUES ('${t.tenantId}', '${linkDef}', 'custom_record', '${rec.recordId}', 'company', '${ids['5502']}', 'human'); ${OFF}`,
      );
      // 8. The current value differs from the latest value-history row.
      await c.sql(
        `UPDATE tenant_extension_values SET value_enum = 'silver' WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, v.tier],
      );

      const emitted = securityEvents();
      const found = await integrity().record(await authz(t, 'security.integrity.run'));
      expect(found.outcome).toBe('findings');
      const of = (check: string) => found.findings.filter((f) => f.check === check);
      expect(of('extension_value_type_mismatch')).toEqual([
        { check: 'extension_value_type_mismatch', ref: v.a },
      ]);
      expect(of('extension_value_restricted')).toEqual([
        { check: 'extension_value_restricted', ref: v.b },
      ]);
      expect(of('extension_value_target_kind')).toEqual([
        { check: 'extension_value_target_kind', ref: v.c },
      ]);
      expect(of('extension_items_parity')).toEqual([
        { check: 'extension_items_parity', ref: v.tags },
      ]);
      expect(of('extension_value_secret_like')).toEqual([
        { check: 'extension_value_secret_like', ref: v.d },
      ]);
      expect(of('custom_record_parent_missing')).toEqual([
        { check: 'custom_record_parent_missing', ref: rec.recordId },
      ]);
      expect(of('custom_relationship_cardinality')).toEqual([
        {
          check: 'custom_relationship_cardinality',
          ref: `${linkDef}:from:custom_record:${rec.recordId}`,
        },
      ]);
      expect(of('extension_history_parity')).toEqual([
        { check: 'extension_history_parity', ref: v.tier },
      ]);
      // Findings carry identifiers only: no planted value reaches the run record.
      const [stored] = await c.sql<{ findings: unknown }>(
        `SELECT findings FROM tenant_integrity_runs WHERE tenant_id = $1 AND id = $2`,
        [t.tenantId, found.runId],
      );
      expect(JSON.stringify(stored!.findings)).not.toContain(AWS_SHAPED);
      expect(JSON.stringify(emitted)).not.toContain(AWS_SHAPED);
      expect(emitted).toContainEqual(
        expect.objectContaining({ event: 'integrity_violation_detected', outcome: 'detected' }),
      );
      // Nothing repaired.
      expect(
        await c.sql(
          `SELECT value_text, value_enum, value_item_count FROM tenant_extension_values
            WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY value_text NULLS LAST, value_enum NULLS LAST`,
          [t.tenantId, [v.d, v.tier, v.tags]],
        ),
      ).toEqual([
        { value_text: AWS_SHAPED, value_enum: null, value_item_count: null },
        { value_text: null, value_enum: 'silver', value_item_count: null },
        { value_text: null, value_enum: null, value_item_count: 2 },
      ]);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM tenant_custom_relationships WHERE tenant_id = $1 AND state = 'active'`,
          [t.tenantId],
        ),
      ).toBe(2);
      // Another tenant is untouched and clean.
      expect((await integrity().verify(other)).outcome).toBe('passed');
    });
  });
});
