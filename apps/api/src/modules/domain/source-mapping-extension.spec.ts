import { describe, expect, it } from 'vitest';
import type { SourceField, SourceRecord, SourceSchema } from './source-connector';
import type { MappingDocument, ObjectMapping } from './source-mapping-document';
import { mapCustomObjectRecord, mapExtensionStatements } from './source-mapping-engine';
import {
  usesExtensionKinds,
  validateExtensionMapping,
  type ExtensionMappingContext,
  type ExtensionMappingDefinition,
} from './source-mapping-extension';
import { mappingMinCanonicalVersion } from './source-mapping';
import type { QualityCode } from './source-mapping-engine';

/** M10D plan §5 (pure part of V6 / V7 / V9): extension mapping entry kinds. */

const field = (name: string, type: SourceField['type'] = 'string'): SourceField => ({
  name,
  type,
  required: false,
  unique: name === 'id',
});

const schema = {
  objects: [
    {
      name: 'Accounts',
      classification: 'record',
      fields: [field('id', 'id'), field('Tier'), field('Region'), field('ssn'), field('Notes')],
    },
    {
      name: 'Projects',
      classification: 'record',
      fields: [
        field('id', 'id'),
        field('Account_id', 'relate'),
        field('Status'),
        field('Budget', 'number'),
      ],
    },
  ],
} as unknown as SourceSchema;

const def = (
  kind: ExtensionMappingDefinition['kind'],
  definition: Record<string, unknown>,
  sensitivity = 'internal',
): ExtensionMappingDefinition => ({
  kind,
  status: 'active',
  definition: { kind, ...definition },
  sensitivity,
  categories: ['operational'],
});

const definitions = new Map<string, ExtensionMappingDefinition>([
  [
    'tier',
    def('field', {
      target: 'account',
      value_type: 'enum',
      allowed_values: [{ code: 'gold' }, { code: 'silver' }],
      allowed_uses: ['display'],
    }),
  ],
  [
    'budget',
    def('field', {
      target: 'custom_object:project',
      value_type: 'number',
      allowed_uses: ['display'],
    }),
  ],
  ['project', def('custom_object', { parent: { kind: 'account', required: true } })],
  [
    'src_sugar_accounts_region',
    def('field', {
      target: 'account',
      value_type: 'string',
      origin: 'source_captured',
      allowed_uses: ['display'],
    }),
  ],
  [
    'project_account',
    def('custom_relationship', {
      from: 'custom_object:project',
      to: 'account',
      cardinality: 'many_to_one',
    }),
  ],
]);

const ctx = (
  extension: ExtensionMappingContext | undefined,
  profile: Record<string, string> = {},
) => ({
  connectionId: 'conn-a',
  connectionKind: 'sugar',
  schema,
  extension,
  profileSensitivity: (o: string, f: string) => profile[`${o}.${f}`],
  isSensitiveName: (f: string) => f === 'ssn',
});

const ok: ExtensionMappingContext = { gate: 'ok', definitions, objectOwners: new Map() };

const accounts = (fields: ObjectMapping['fields']): ObjectMapping => ({
  source: 'Accounts',
  entity: 'account',
  identity: { field: 'id' },
  relationships: [],
  fields,
});
const projects = (extra: Partial<ObjectMapping> = {}): ObjectMapping => ({
  source: 'Projects',
  entity: 'custom_object:project',
  identity: { field: 'id' },
  relationships: [],
  fields: [{ kind: 'attribute', field: 'budget', source: 'Budget' }],
  customObject: { parent: { field: 'Account_id', object: 'Accounts' } },
  ...extra,
});

const fieldOf = (o: string, f: string) =>
  schema.objects.find((x) => x.name === o)?.fields.find((x) => x.name === f);
const codes = (doc: MappingDocument, c = ctx(ok)) =>
  validateExtensionMapping(doc, c, fieldOf).map((i) => i.code);

const tierEntry = {
  kind: 'attribute' as const,
  field: 'tier',
  source: 'Tier',
  transforms: { valueMap: { map: { Gold: 'gold' }, unmapped: 'unknown' as const } },
};

describe('extension mapping validation (plan §5)', () => {
  it('documents without extension kinds are untouched (and keep canonical_version_min)', () => {
    const doc = { objects: [accounts([])] } as MappingDocument;
    expect(usesExtensionKinds(doc)).toBe(false);
    expect(codes(doc, ctx(undefined))).toEqual([]);
    expect(mappingMinCanonicalVersion(doc)).toBeUndefined();
  });

  it('below 0.4 / module disabled: attribute_mappings_not_enabled; the kinds need 0.4', () => {
    const doc = { objects: [accounts([tierEntry])] } as MappingDocument;
    expect(codes(doc, ctx(undefined))).toEqual(['attribute_mappings_not_enabled']);
    expect(codes(doc, ctx({ ...ok, gate: 'module_disabled' }))).toEqual([
      'attribute_mappings_not_enabled',
    ]);
    expect(mappingMinCanonicalVersion(doc)).toBe('0.4');
  });

  it('accepts a valid attribute; refuses unknown fields, target mismatch, missing value maps', () => {
    expect(codes({ objects: [accounts([tierEntry])] })).toEqual([]);
    expect(codes({ objects: [accounts([{ ...tierEntry, field: 'nope' }])] })).toEqual([
      'extension_field_unknown',
    ]);
    expect(
      codes({
        objects: [accounts([{ kind: 'attribute', field: 'budget', source: 'Budget' }])],
      }),
    ).toEqual(['extension_target_mismatch']);
    expect(
      codes({
        objects: [accounts([{ kind: 'attribute', field: 'tier', source: 'Tier' }])],
      }),
    ).toEqual(['invalid_enum_map']);
    expect(
      codes({
        objects: [
          accounts([
            {
              ...tierEntry,
              transforms: { valueMap: { map: { Gold: 'platinum' }, unmapped: 'unknown' } },
            },
          ]),
        ],
      }),
    ).toEqual(['invalid_enum_map']);
  });

  it('a sensitive_by_value source into a field below confidential is refused', () => {
    expect(
      codes(
        { objects: [accounts([tierEntry])] },
        ctx(ok, { 'Accounts.Tier': 'sensitive_by_value' }),
      ),
    ).toEqual(['attribute_classification_below_profile']);
  });

  it('capture: needs the published src_ field; sensitive fields refused (never stored)', () => {
    expect(codes({ objects: [accounts([{ kind: 'capture', source: 'Region' }])] })).toEqual([]);
    expect(codes({ objects: [accounts([{ kind: 'capture', source: 'Notes' }])] })).toEqual([
      'capture_field_not_published',
    ]);
    expect(codes({ objects: [accounts([{ kind: 'capture', source: 'ssn' }])] })).toEqual([
      'capture_sensitive_refused',
    ]);
    expect(
      codes(
        { objects: [accounts([{ kind: 'capture', source: 'Region' }])] },
        ctx(ok, { 'Accounts.Region': 'sensitive_by_name' }),
      ),
    ).toEqual(['capture_sensitive_refused']);
  });

  it('custom objects: parent mapping, single owner connection (Q14), no holdings', () => {
    expect(codes({ objects: [accounts([]), projects()] })).toEqual([]);
    expect(codes({ objects: [accounts([]), projects({ customObject: {} })] })).toEqual([
      'missing_relationship_target',
    ]);
    expect(
      codes(
        { objects: [accounts([]), projects()] },
        ctx({ ...ok, objectOwners: new Map([['project', 'conn-b']]) }),
      ),
    ).toEqual(['custom_object_owned_by_other_connection']);
    expect(
      codes({
        objects: [accounts([]), projects({ allRecordsAreHoldings: {} })],
      }),
    ).toEqual(['holding_filter_not_allowed']);
  });

  it('custom relationships: on the from object, to object mapped, role into the definition code', () => {
    const rel = {
      target: 'custom_relationship:project_account',
      field: 'Account_id',
      object: 'Accounts',
    };
    expect(codes({ objects: [accounts([]), projects({ relationships: [rel] })] })).toEqual([]);
    expect(
      codes({
        objects: [accounts([]), projects({ relationships: [{ ...rel, object: 'Projects' }] })],
      }),
    ).toEqual(['missing_relationship_target']);
    expect(
      codes({
        objects: [
          accounts([]),
          projects({
            relationships: [{ ...rel, role: { field: 'Status', valueMap: { a: 'owner' } } }],
          }),
        ],
      }),
    ).toEqual(['invalid_enum_map']);
  });
});

describe('extension statements of a record (engine)', () => {
  const record = (values: Record<string, string | null>, deleted = false): SourceRecord =>
    ({ id: String(values.id ?? 'r1'), values, deleted }) as unknown as SourceRecord;
  const key = (o: string, f: string) => `src_sugar_${o.toLowerCase()}_${f.toLowerCase()}`;

  it('a missing field states nothing; an empty value is an explicit empty; value maps apply', () => {
    const q: QualityCode[] = [];
    const out = mapExtensionStatements(
      accounts([tierEntry, { kind: 'capture', source: 'Region' }]),
      record({ id: 'A1', Tier: 'Gold', Region: '' }),
      'sugar',
      q,
      key,
    );
    expect(out.values).toEqual([
      { field: 'tier', raw: 'gold' },
      { field: 'src_sugar_accounts_region', raw: null },
    ]);
    const absent = mapExtensionStatements(
      accounts([tierEntry]),
      record({ id: 'A1' }),
      'sugar',
      q,
      key,
    );
    expect(absent.values).toEqual([]);
  });

  it('custom object records: identity, parent, state value map, relationships', () => {
    const obj = projects({
      relationships: [
        { target: 'custom_relationship:project_account', field: 'Account_id', object: 'Accounts' },
      ],
      customObject: {
        parent: { field: 'Account_id', object: 'Accounts' },
        recordState: { field: 'Status', valueMap: { Open: 'active', Closed: 'retired' } },
      },
    });
    const out = mapCustomObjectRecord(
      obj,
      record({ id: 'P1', Account_id: 'A1', Status: 'Closed', Budget: '12.5' }),
      'sugar',
      key,
    );
    expect(out).toMatchObject({
      outcome: 'ingest',
      objectKey: 'project',
      ref: { system: 'sugar', objectType: 'Projects', id: 'P1' },
      presence: 'present',
      parent: { system: 'sugar', objectType: 'Accounts', id: 'A1' },
      state: 'retired',
    });
    expect(out.outcome === 'ingest' && out.extensions.values).toEqual([
      { field: 'budget', raw: '12.5' },
    ]);
    expect(out.outcome === 'ingest' && out.extensions.relationships).toEqual([
      { key: 'project_account', to: { system: 'sugar', objectType: 'Accounts', id: 'A1' } },
    ]);
    const cleared = mapCustomObjectRecord(obj, record({ id: 'P1', Account_id: '' }), 'sugar', key);
    expect(cleared.outcome === 'ingest' && cleared.parent).toBeNull();
    expect(cleared.outcome === 'ingest' && cleared.extensions.relationships).toEqual([
      { key: 'project_account', to: null },
    ]);
    const deleted = mapCustomObjectRecord(obj, record({ id: 'P1' }, true), 'sugar', key);
    expect(deleted).toMatchObject({ outcome: 'ingest', presence: 'absent' });
  });
});
