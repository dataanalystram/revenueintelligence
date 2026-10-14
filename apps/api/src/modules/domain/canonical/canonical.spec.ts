import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_PURGE_EXECUTION_APPROVED,
  RETENTION_CLASSES,
  RETENTION_DEFAULTS,
  type ColumnClassification,
} from '../security';
import {
  CANONICAL_MODULES,
  CANONICAL_VERSIONS,
  CANONICAL_VERSION_PATTERN,
  DATA_POLICY_MAX_DAYS,
  DataPolicyDocumentSchema,
  ENTITY_INDEX_KINDS,
  ENTITY_INDEX_SOURCES,
  MODULE_KEYS,
  REGISTRY_KINDS,
  AVAILABLE_REGISTRY_KINDS,
  canonicalCatalogueFor,
  canonicalCatalogueHash,
  compareCanonicalVersion,
  currentCanonicalVersion,
  decideAdoption,
  decideModuleChange,
  decideValueHistory,
  disabledModuleTargets,
  formatCanonicalVersion,
  integrityCounts,
  integrityOutcome,
  isLegalLifecycleTransition,
  parseCanonicalVersion,
  policyAllowsValues,
  registryContentHash,
  registryRuleViolations,
  resolveRetention,
  transformTrace,
  valueHistoryPairs,
  type CanonicalModuleEntry,
  type MappingLifecycleState,
} from './index';

const version = fc
  .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 9999 }))
  .map(([major, minor]) => ({ major, minor, label: `${major}.${minor}` }));

describe('V1: canonical versions', () => {
  it('accepts exactly MAJOR.MINOR labels without leading zeros', () => {
    for (const ok of ['0.1', '0.10', '0.0', '1.0', '999.9999']) {
      expect(CANONICAL_VERSION_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      '0',
      '01.1',
      '0.01',
      '1.0.0',
      'v0.1',
      '0.1 ',
      '1000.0',
      '0.10000',
      '-1.0',
    ]) {
      expect(CANONICAL_VERSION_PATTERN.test(bad), bad).toBe(false);
      expect(() => parseCanonicalVersion(bad)).toThrow(/Invalid canonical version/);
    }
  });

  it('orders numerically, never lexically (0.10 > 0.9)', () => {
    expect(compareCanonicalVersion('0.10', '0.9')).toBeGreaterThan(0);
    expect(compareCanonicalVersion('0.9', '0.10')).toBeLessThan(0);
    expect(compareCanonicalVersion('1.0', '0.999')).toBeGreaterThan(0);
    expect(compareCanonicalVersion('0.2', '0.2')).toBe(0);
  });

  it('property: comparison equals (major, minor) tuple order and round-trips the label', () => {
    fc.assert(
      fc.property(version, version, (a, b) => {
        const expected = a.major !== b.major ? a.major - b.major : a.minor - b.minor;
        expect(Math.sign(compareCanonicalVersion(a.label, b.label))).toBe(Math.sign(expected));
        expect(formatCanonicalVersion(parseCanonicalVersion(a.label))).toBe(a.label);
      }),
    );
  });

  it('property: comparison is antisymmetric and transitive', () => {
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(Math.sign(compareCanonicalVersion(a.label, b.label))).toBe(
          -Math.sign(compareCanonicalVersion(b.label, a.label)) || 0,
        );
        if (
          compareCanonicalVersion(a.label, b.label) <= 0 &&
          compareCanonicalVersion(b.label, c.label) <= 0
        ) {
          expect(compareCanonicalVersion(a.label, c.label)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('the catalogue holds exactly one current version, 0.2 (ADR 0028), 0.1 supported (ADR 0027), and nothing at 1.0 or above', () => {
    expect(currentCanonicalVersion()).toBe('0.2');
    expect(CANONICAL_VERSIONS).toEqual([
      { version: '0.1', status: 'supported', adr: '0027' },
      { version: '0.2', status: 'current', adr: '0028' },
    ]);
    for (const v of CANONICAL_VERSIONS) expect(parseCanonicalVersion(v.version).major).toBe(0);
  });

  it('M10B Q19: the stored 0.1 catalogue hash is reproduced unchanged; 0.2 hashes the new members', () => {
    expect(canonicalCatalogueHash(canonicalCatalogueFor('0.1'))).toBe(
      '2fd4f7e575633de7cac4aea394a71c73adc9b73e5e18b67c0b0ee404572faf5b',
    );
    expect(canonicalCatalogueHash(canonicalCatalogueFor('0.2'))).toBe(
      'db7c0fc245cae469e8cddae88b89077c017805c7b87586b9d3e71f1936c96c98',
    );
    expect(() => canonicalCatalogueFor('0.3')).toThrow(/no catalogue/);
  });
});

describe('canonical adoption rules (Q3)', () => {
  const catalogue = [
    { version: '0.1', status: 'supported' as const },
    { version: '0.2', status: 'supported' as const },
    { version: '0.3', status: 'current' as const },
    { version: '0.4', status: 'deprecated' as const },
  ];
  const decide = (current: string, target: string, expectedCurrent = current) =>
    decideAdoption({ current, expectedCurrent, target, catalogue });

  it('forward to any adoptable newer version; rollback only to the immediately previous MINOR', () => {
    expect(decide('0.1', '0.3')).toEqual({ ok: true, reason: 'operator_adoption' });
    expect(decide('0.3', '0.2')).toEqual({ ok: true, reason: 'rollback' });
    expect(decide('0.3', '0.1')).toEqual({ ok: false, code: 'canonical_version_not_supported' });
  });

  it('refuses a stale expected version, an unknown or unsupported target and a no-op', () => {
    expect(decide('0.1', '0.2', '0.2')).toEqual({ ok: false, code: 'stale_base_version' });
    expect(decide('0.1', '0.9')).toEqual({ ok: false, code: 'canonical_version_unknown' });
    expect(decide('0.3', '0.4')).toEqual({ ok: false, code: 'canonical_version_not_supported' });
    expect(decide('0.2', '0.2')).toEqual({ ok: false, code: 'no_change' });
  });
});

describe('module rules (M10 §17)', () => {
  const mod = (
    key: CanonicalModuleEntry['key'],
    over: Partial<CanonicalModuleEntry> = {},
  ): CanonicalModuleEntry => ({
    key,
    title: key,
    available: true,
    minimumCanonicalVersion: '0.2',
    dependsOn: [],
    configSchemaVersion: 1,
    entityKinds: [],
    ...over,
  });
  const catalogue = [mod('commercial'), mod('opportunities', { dependsOn: ['commercial'] })];
  const base = {
    catalogue,
    adoptedVersion: '0.2',
    currentVersion: 0,
    expectedVersion: 0,
    configChanged: false,
  };

  it('the code catalogue has the nine keys, all unavailable in M10A2, dependencies inside the catalogue', () => {
    expect(CANONICAL_MODULES.map((m) => m.key)).toEqual([...MODULE_KEYS]);
    for (const m of CANONICAL_MODULES) {
      expect(m.available).toBe(false);
      expect(m.minimumCanonicalVersion).toBeNull();
      for (const d of m.dependsOn) expect(MODULE_KEYS).toContain(d);
      expect(m.dependsOn).not.toContain(m.key);
    }
  });

  it('enable needs availability, the minimum version and every dependency', () => {
    const enable = (module: CanonicalModuleEntry, enabled: string[], adoptedVersion = '0.2') =>
      decideModuleChange({
        ...base,
        module,
        enabled: new Set(enabled),
        adoptedVersion,
        targetEnabled: true,
      });
    expect(enable(mod('commercial'), [])).toEqual({ ok: true });
    expect(
      enable(mod('commercial', { available: false, minimumCanonicalVersion: null }), []),
    ).toEqual({ ok: false, code: 'module_not_available' });
    expect(enable(mod('commercial'), [], '0.1')).toEqual({
      ok: false,
      code: 'canonical_version_too_low',
    });
    expect(enable(catalogue[1]!, [])).toEqual({
      ok: false,
      code: 'module_dependency_missing',
      module: 'commercial',
    });
    expect(enable(catalogue[1]!, ['commercial'])).toEqual({ ok: true });
  });

  it('disable is refused while an enabled module depends on it; base version and no-op checks', () => {
    const disable = (enabled: string[]) =>
      decideModuleChange({
        ...base,
        module: catalogue[0]!,
        enabled: new Set(enabled),
        targetEnabled: false,
      });
    expect(disable(['commercial', 'opportunities'])).toEqual({
      ok: false,
      code: 'module_required_by_other',
      module: 'opportunities',
    });
    expect(disable(['commercial'])).toEqual({ ok: true });
    expect(disable([])).toEqual({ ok: false, code: 'no_change' });
    expect(
      decideModuleChange({
        ...base,
        module: catalogue[0]!,
        enabled: new Set(),
        targetEnabled: true,
        expectedVersion: 3,
      }),
    ).toEqual({ ok: false, code: 'stale_base_version' });
  });

  it('mapping hook: targets of a disabled module are reported (synthetic catalogue)', () => {
    const synthetic = [mod('commercial', { entityKinds: ['opportunity'] })];
    expect(disabledModuleTargets(['company', 'opportunity'], synthetic, new Set())).toEqual([
      { entityKind: 'opportunity', module: 'commercial' },
    ]);
    expect(disabledModuleTargets(['opportunity'], synthetic, new Set(['commercial']))).toEqual([]);
  });
});

describe('V8: registry rules (R-K, R-X1, R-X3, R-X4)', () => {
  const entry = (key: string, definition: Record<string, unknown> = {}) => ({ key, definition });

  it('the catalogue has six kinds; only data_policy is available in M10A2', () => {
    expect(REGISTRY_KINDS).toEqual([
      'data_policy',
      'signal_type',
      'metric',
      'action_type',
      'context_type',
      'extension',
    ]);
    expect(AVAILABLE_REGISTRY_KINDS).toEqual(['data_policy']);
  });

  it('R-X1: a key never disappears', () => {
    expect(registryRuleViolations([entry('a'), entry('b')], [entry('a')])).toEqual([
      { rule: 'R-X1', key: 'b' },
    ]);
  });

  it('R-X3: codes never disappear (new codes may be added)', () => {
    expect(
      registryRuleViolations([entry('a', { codes: ['x', 'y'] })], [entry('a', { codes: ['x'] })]),
    ).toEqual([{ rule: 'R-X3', key: 'a' }]);
    expect(
      registryRuleViolations([entry('a', { codes: ['x'] })], [entry('a', { codes: ['x', 'z'] })]),
    ).toEqual([]);
  });

  it("R-X4: a key's kind or target never changes", () => {
    expect(
      registryRuleViolations([entry('a', { kind: 'count' })], [entry('a', { kind: 'sum' })]),
    ).toEqual([{ rule: 'R-X4', key: 'a' }]);
    expect(
      registryRuleViolations(
        [entry('a', { target: 'company' })],
        [entry('a', { target: 'person' })],
      ),
    ).toEqual([{ rule: 'R-X4', key: 'a' }]);
  });

  it('R-K: keys match ^[a-z][a-z0-9_]{0,62}$', () => {
    expect(registryRuleViolations([], [entry('Bad-Key'), entry('ok_key')])).toEqual([
      { rule: 'R-K', key: 'Bad-Key' },
    ]);
  });

  it('property: a superset republication with unchanged kinds never violates a rule', () => {
    const key = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(key, { maxLength: 8 }),
        fc.uniqueArray(key, { maxLength: 4 }),
        (before, extra) => {
          const previous = before.map((k) => entry(k, { kind: 'k', codes: ['c1'] }));
          const next = [...new Set([...before, ...extra])].map((k) =>
            entry(k, { kind: 'k', codes: ['c1', 'c2'] }),
          );
          expect(registryRuleViolations(previous, next)).toEqual([]);
        },
      ),
    );
  });

  it('property: dropping any existing key is always an R-X1 violation for that key', () => {
    const key = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);
    fc.assert(
      fc.property(fc.uniqueArray(key, { minLength: 1, maxLength: 8 }), fc.nat(), (keys, i) => {
        const dropped = keys[i % keys.length]!;
        const violations = registryRuleViolations(
          keys.map((k) => entry(k)),
          keys.filter((k) => k !== dropped).map((k) => entry(k)),
        );
        expect(violations).toContainEqual({ rule: 'R-X1', key: dropped });
      }),
    );
  });

  it('the content hash is canonical (key order does not matter)', () => {
    expect(registryContentHash({ a: 1, b: [1, 2] })).toBe(registryContentHash({ b: [1, 2], a: 1 }));
    expect(registryContentHash({ a: 1 })).not.toBe(registryContentHash({ a: 2 }));
  });
});

describe('V9: data policy document v1', () => {
  const valid = { schema: 1, raw_retention: false };

  it('accepts the minimal document and applies defaults', () => {
    expect(DataPolicyDocumentSchema.parse(valid)).toEqual({
      schema: 1,
      retention: {},
      raw_retention: false,
      value_history: { allow: [] },
    });
  });

  it('cannot express raw retention', () => {
    expect(DataPolicyDocumentSchema.safeParse({ ...valid, raw_retention: true }).success).toBe(
      false,
    );
    expect(DataPolicyDocumentSchema.safeParse({ schema: 1 }).success).toBe(false);
  });

  it('classes whose product default is disabled or lifecycle cannot appear', () => {
    for (const cls of RETENTION_CLASSES.filter((c) => RETENTION_DEFAULTS[c].kind !== 'days')) {
      expect(
        DataPolicyDocumentSchema.safeParse({ ...valid, retention: { [cls]: { days: 30 } } })
          .success,
        cls,
      ).toBe(false);
    }
  });

  it('enforces the day bounds (1–3650; security_audit at least 90)', () => {
    const r = (retention: unknown) =>
      DataPolicyDocumentSchema.safeParse({ ...valid, retention }).success;
    expect(r({ operational_diagnostics: { days: 1 } })).toBe(true);
    expect(r({ operational_diagnostics: { days: 0 } })).toBe(false);
    expect(r({ operational_diagnostics: { days: DATA_POLICY_MAX_DAYS } })).toBe(true);
    expect(r({ operational_diagnostics: { days: DATA_POLICY_MAX_DAYS + 1 } })).toBe(false);
    expect(r({ operational_diagnostics: { days: 1.5 } })).toBe(false);
    expect(r({ security_audit: { days: 89 } })).toBe(false);
    expect(r({ security_audit: { days: 90 } })).toBe(true);
  });

  it('value_history.allow names only value-history fields, once each; unknown members are refused', () => {
    const allow = (entries: unknown[]) =>
      DataPolicyDocumentSchema.safeParse({ ...valid, value_history: { allow: entries } }).success;
    expect(allow([{ entity_kind: 'company', field: 'name', days: 30 }])).toBe(true);
    expect(allow([{ entity_kind: 'person', field: 'primary_email', days: 30 }])).toBe(false);
    expect(
      allow([
        { entity_kind: 'company', field: 'name', days: 30 },
        { entity_kind: 'company', field: 'name', days: 60 },
      ]),
    ).toBe(false);
    expect(DataPolicyDocumentSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it('resolution: published policy ?? product defaults, per class', () => {
    const defaults = resolveRetention(undefined);
    expect(defaults.security_audit).toEqual({ kind: 'days', days: 365, source: 'default' });
    expect(defaults.sensitive_value_history).toEqual({ kind: 'disabled', source: 'default' });
    const policy = DataPolicyDocumentSchema.parse({
      ...valid,
      retention: { security_audit: { days: 400 } },
      value_history: { allow: [{ entity_kind: 'company', field: 'name', days: 30 }] },
    });
    const resolved = resolveRetention(policy);
    expect(resolved.security_audit).toEqual({ kind: 'days', days: 400, source: 'policy' });
    expect(resolved.operational_diagnostics).toEqual({ kind: 'days', days: 90, source: 'default' });
    expect(policyAllowsValues(policy, 'company', 'name')).toBe(true);
    expect(policyAllowsValues(policy, 'company', 'customer_status')).toBe(false);
    expect(policyAllowsValues(undefined, 'company', 'name')).toBe(false);
  });

  it('audit purge execution stays disabled whatever the policy says', () => {
    expect(AUDIT_PURGE_EXECUTION_APPROVED).toBe(false);
  });
});

describe('value history decision (restricted history, control 12)', () => {
  const cls = (over: Partial<ColumnClassification>): ColumnClassification => ({
    sensitivity: 'internal',
    categories: ['commercial'],
    kind: 'free_text',
    retention: 'canonical_lifecycle',
    history: 'full',
    ...over,
  });

  it('the field catalogue is the six M10A2 fields (Q14, without company.customer_status), none of them a person field', () => {
    expect(valueHistoryPairs().map((p) => `${p.entityKind}.${p.field}`)).toEqual([
      'company.name',
      'subscription.state',
      'subscription.starts_at',
      'subscription.ends_at',
      'subscription.product_key',
      'subscription.quantity',
    ]);
  });

  it('non-catalogue fields record nothing; non-sensitive fields record values', () => {
    expect(
      decideValueHistory({
        entityKind: 'company',
        field: 'domains',
        classification: cls({}),
        policyAllows: false,
        policyVersion: null,
      }),
    ).toEqual({ record: false });
    expect(
      decideValueHistory({
        entityKind: 'company',
        field: 'name',
        classification: cls({}),
        policyAllows: false,
        policyVersion: null,
      }),
    ).toEqual({
      record: true,
      valuesRecorded: true,
      retentionClass: 'canonical_lifecycle',
      policyVersion: null,
    });
  });

  it('a sensitive field is value-free unless the published policy allows it', () => {
    for (const sensitive of [
      cls({ sensitivity: 'restricted' }),
      cls({ sensitivity: 'confidential', categories: ['personal'] }),
      cls({ sensitivity: 'confidential', categories: ['communication'] }),
      cls({ sensitivity: 'confidential', categories: ['security'] }),
      cls({ tbc: { reason: 'owner to confirm this', owner: 'ops' } }),
    ]) {
      expect(
        decideValueHistory({
          entityKind: 'company',
          field: 'name',
          classification: sensitive,
          policyAllows: false,
          policyVersion: null,
        }),
      ).toEqual({ record: true, valuesRecorded: false, retentionClass: 'canonical_lifecycle' });
      expect(
        decideValueHistory({
          entityKind: 'company',
          field: 'name',
          classification: sensitive,
          policyAllows: true,
          policyVersion: 3,
        }),
      ).toEqual({
        record: true,
        valuesRecorded: true,
        retentionClass: 'sensitive_value_history',
        policyVersion: 3,
      });
    }
  });
});

describe('entity index, change records, lifecycle and integrity vocabulary', () => {
  it('every index kind names its table and identity column (products by key, D3)', () => {
    expect(ENTITY_INDEX_KINDS).toEqual(['company', 'person', 'product', 'subscription']);
    expect(ENTITY_INDEX_SOURCES.product).toEqual({ table: 'tenant_products', column: 'key' });
  });

  it('transform traces are field:transform names only, sorted and de-duplicated', () => {
    expect(
      transformTrace([
        { target: 'company.name', transforms: { normalise: {}, nullValues: ['-'] } },
        { target: 'state', transforms: { valueMap: { a: 'b' } } },
        { target: 'company.name', transforms: { normalise: {} } },
        { target: 'quantity' },
      ]),
    ).toEqual(['name:normalise', 'name:nullValues', 'state:valueMap']);
  });

  it('lifecycle transitions: none → published → superseded | retired; superseded → retired; nothing leaves retired', () => {
    const states: (MappingLifecycleState | null)[] = [null, 'published', 'superseded', 'retired'];
    const legal = new Set([
      'null>published',
      'published>superseded',
      'published>retired',
      'superseded>retired',
    ]);
    for (const from of states) {
      for (const to of ['published', 'superseded', 'retired'] as const) {
        expect(isLegalLifecycleTransition(from, to), `${from}>${to}`).toBe(
          legal.has(`${from}>${to}`),
        );
      }
    }
  });

  it('integrity outcome and counts', () => {
    expect(integrityOutcome([])).toBe('passed');
    const findings = [
      { check: 'entity_index_orphan' as const, ref: 'company:x' },
      { check: 'entity_index_orphan' as const, ref: 'company:y' },
    ];
    expect(integrityOutcome(findings)).toBe('findings');
    expect(integrityCounts(findings).entity_index_orphan).toBe(2);
    expect(integrityCounts(findings).entity_index_missing).toBe(0);
  });
});
