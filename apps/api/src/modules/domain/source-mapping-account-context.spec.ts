import { describe, expect, it } from 'vitest';
import {
  TEST_CONNECTION_ID,
  testAuthority,
  testSourceSchema,
} from '../../../test/fixtures/source-mapping';
import {
  contextRenewalDate,
  mapAccountContextRecord,
  mapLineContextRef,
  usesAccountContextMapping,
  validateAccountContextMapping,
  type AccountContextMappingContext,
} from './source-mapping-account-context';
import { mappedFields, mappingMinCanonicalVersion } from './source-mapping';
import type { MappingDocument, ObjectMapping } from './source-mapping-document';

const schema = testSourceSchema();

const contextObject = (edit?: (o: ObjectMapping) => void): ObjectMapping => {
  const o: ObjectMapping = {
    source: 'Opportunities',
    entity: 'account_context',
    identity: { field: 'id' },
    relationships: [],
    fields: [],
    accountContext: {
      type: 'deal_desk',
      account: { field: 'account_id', object: 'Accounts' },
      name: { field: 'name' },
      status: {
        field: 'sales_stage',
        valueMap: { Prospecting: 'active', 'Closed Lost': 'retired' },
      },
      renewalDate: { field: 'date_closed' },
      dimensions: [{ key: 'region', field: 'name' }],
      persons: [{ field: 'account_id', object: 'Contacts', role: { constant: 'champion' } }],
    },
  };
  edit?.(o);
  return o;
};

const doc = (ctxObj: ObjectMapping = contextObject()): MappingDocument => ({
  objects: [
    {
      source: 'Accounts',
      entity: 'account',
      identity: { field: 'id' },
      relationships: [],
      fields: [],
    },
    {
      source: 'Contacts',
      entity: 'person',
      identity: { field: 'id' },
      relationships: [],
      fields: [],
    },
    ctxObj,
  ],
});

const types = (status = 'active'): AccountContextMappingContext => ({
  gate: 'ok',
  types: new Map([
    [
      'deal_desk',
      {
        status,
        dimensions: [
          { key: 'region', required: true },
          { key: 'segment', required: false },
        ],
        memberRoles: ['champion'],
      },
    ],
  ]),
});

const codes = (
  d: MappingDocument,
  accountContext: AccountContextMappingContext | null = types(),
  authority = testAuthority({ account_context: TEST_CONNECTION_ID }),
) =>
  validateAccountContextMapping(d, {
    connectionId: TEST_CONNECTION_ID,
    schema,
    authority,
    ...(accountContext ? { accountContext } : {}),
  }).map((i) => i.code);

describe('account_context mapping validation (M10E plan §5)', () => {
  it('accepts a complete account_context object', () => {
    expect(codes(doc())).toEqual([]);
  });

  it('refuses without the 0.5 + module gate', () => {
    expect(codes(doc(), null)).toContain('account_context_mappings_not_enabled');
    expect(codes(doc(), { ...types(), gate: 'module_disabled' })).toContain(
      'account_context_mappings_not_enabled',
    );
  });

  it('refuses a connection without the account_context authority', () => {
    expect(codes(doc(), types(), testAuthority())).toContain('authority_conflict');
  });

  it('refuses an unknown or retired type', () => {
    expect(
      codes(doc(contextObject((o) => (o.accountContext = { ...o.accountContext!, type: 'nope' })))),
    ).toContain('context_type_unknown');
    expect(codes(doc(), types('retired'))).toContain('context_type_unknown');
  });

  it('refuses unknown dimensions and missing required dimensions', () => {
    const unknown = contextObject((o) => {
      o.accountContext = { ...o.accountContext!, dimensions: [{ key: 'zone', field: 'name' }] };
    });
    const c = codes(doc(unknown));
    expect(c).toContain('context_dimension_unknown');
    expect(c).toContain('context_dimension_required');
  });

  it('refuses a role outside the type, an unmapped account object and unknown fields', () => {
    const bad = contextObject((o) => {
      o.accountContext = {
        ...o.accountContext!,
        account: { field: 'account_id', object: 'Leads' },
        name: { field: 'missing_field' },
        persons: [{ field: 'account_id', object: 'Contacts', role: { constant: 'sponsor' } }],
      };
    });
    const c = codes(doc(bad));
    expect(c).toContain('context_role_unknown');
    expect(c).toContain('missing_relationship_target');
    expect(c).toContain('unknown_source_field');
  });

  it('refuses core entries, relationships and a missing accountContext block', () => {
    const core = contextObject((o) => {
      o.fields = [{ kind: 'core', target: 'account.name', source: 'name' }];
    });
    expect(codes(doc(core))).toContain('invalid_target');
    const none = contextObject((o) => {
      delete (o as { accountContext?: unknown }).accountContext;
    });
    expect(codes(doc(none))).toContain('invalid_target');
  });

  it('refuses an accountContext block on another entity and two objects of one type', () => {
    const d = doc();
    (d.objects[0] as { accountContext?: unknown }).accountContext = contextObject().accountContext;
    expect(codes(d)).toContain('invalid_target');
    const twice: MappingDocument = {
      objects: [...doc().objects, contextObject((o) => (o.source = 'RevenueLineItems'))],
    };
    expect(codes(twice)).toContain('duplicate_entity');
  });

  it('gates subscription.contextRef', () => {
    const d = doc();
    const line: ObjectMapping = {
      source: 'RevenueLineItems',
      entity: 'subscription',
      identity: { field: 'id' },
      relationships: [
        { target: 'subscription.contextRef', field: 'opportunity_id', object: 'Opportunities' },
      ],
      fields: [],
    };
    expect(codes({ objects: [...d.objects, line] }, null)).toContain(
      'account_context_mappings_not_enabled',
    );
  });

  it('needs canonical 0.5 and reads the statement fields', () => {
    expect(usesAccountContextMapping(doc())).toBe(true);
    expect(mappingMinCanonicalVersion(doc())).toBe('0.5');
    expect(mappedFields(contextObject())).toEqual(
      ['account_id', 'date_closed', 'id', 'name', 'sales_stage'].sort(),
    );
  });
});

describe('account_context record mapping', () => {
  const record = (values: Record<string, string | number | boolean | null>, deleted = false) => ({
    object: 'Opportunities',
    id: 'o1',
    values: { id: 'o1', account_id: 'a1', ...values },
    ...(deleted ? { deleted: true } : {}),
  });

  it('maps statements, value maps and persons', () => {
    const m = mapAccountContextRecord(
      contextObject(),
      record({ name: 'EMEA', sales_stage: 'Prospecting', date_closed: '2027-03-01T00:00:00Z' }),
      'sugar',
    );
    expect(m).toMatchObject({
      outcome: 'mapped',
      typeKey: 'deal_desk',
      presence: 'present',
      ref: { system: 'sugar', objectType: 'Opportunities', id: 'o1' },
      accountRef: { system: 'sugar', objectType: 'Accounts', id: 'a1' },
      name: 'EMEA',
      status: 'active',
      renewalDate: '2027-03-01',
      dimensions: { region: 'EMEA' },
      persons: [{ ref: { system: 'sugar', objectType: 'Contacts', id: 'a1' }, role: 'champion' }],
      quality: [],
    });
  });

  it('drops unmapped status and invalid dates with value-free codes; empty states nothing', () => {
    const m = mapAccountContextRecord(
      contextObject(),
      record({ name: '', sales_stage: 'Other', date_closed: '2027-02-30' }),
      'sugar',
    );
    expect(m.outcome).toBe('mapped');
    if (m.outcome !== 'mapped') return;
    expect(m.status).toBeUndefined();
    expect(m.name).toBeUndefined();
    expect(m.dimensions).toEqual({});
    expect(m.quality).toEqual([
      'account_context_status_unmapped',
      'account_context_renewal_date_invalid',
    ]);
  });

  it('a deleted record is absent; a record without an account is skipped', () => {
    const del = mapAccountContextRecord(contextObject(), record({}, true), 'sugar');
    expect(del).toMatchObject({
      outcome: 'mapped',
      presence: 'absent',
      dimensions: {},
      persons: [],
    });
    expect(mapAccountContextRecord(contextObject(), record({ account_id: null }), 'sugar')).toEqual(
      {
        outcome: 'skipped',
        code: 'account_context_account_missing',
      },
    );
  });

  it('a line names its context only by a non-empty reference', () => {
    const line: ObjectMapping = {
      source: 'RevenueLineItems',
      entity: 'subscription',
      identity: { field: 'id' },
      relationships: [
        { target: 'subscription.contextRef', field: 'opportunity_id', object: 'Opportunities' },
      ],
      fields: [],
    };
    const r = (v: string | null) => ({
      object: 'RevenueLineItems',
      id: 'l1',
      values: { opportunity_id: v },
    });
    expect(mapLineContextRef(line, r('o1'), 'sugar')).toEqual({
      system: 'sugar',
      objectType: 'Opportunities',
      id: 'o1',
    });
    expect(mapLineContextRef(line, r(''), 'sugar')).toBeUndefined();
    expect(mapLineContextRef(line, r(null), 'sugar')).toBeUndefined();
  });

  it('renewal dates are calendar dates only', () => {
    expect(contextRenewalDate('2027-01-31')).toBe('2027-01-31');
    expect(contextRenewalDate('2027-13-01')).toBeUndefined();
    expect(contextRenewalDate('31/01/2027')).toBeUndefined();
  });
});
