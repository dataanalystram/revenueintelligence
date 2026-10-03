/**
 * Synthetic source schema and TEST-ONLY mapping configuration for M8 tests.
 *
 * The object and field API names follow the sanitized Sugar discovery
 * evidence (fixtures/sugarcrm/sanitized); enum options are the synthetic
 * fixture values. Business choices encoded here (holding stages = Closed Won,
 * the service_* date pair, UTC, inclusive end dates, state = explicit
 * unknown) are TEST CONFIGURATION ONLY: none is a confirmed Juniper decision.
 */
import type {
  AuthorityDocument,
  MappingDocument,
  SourceField,
  SourceObject,
  SourceSchema,
} from '../../src/modules/domain';

export const TEST_CONNECTION_ID = '0c0c0c0c-0c0c-40c0-80c0-0c0c0c0c0c0c';
export const OTHER_CONNECTION_ID = '0d0d0d0d-0d0d-40d0-80d0-0d0d0d0d0d0d';

/** Synthetic pipeline stages used by the fixtures (not a customer picklist). */
export const FIXTURE_SALES_STAGES = [
  'Prospecting',
  'Qualification',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
  'Pending Cancellation',
];

const f = (
  name: string,
  type: SourceField['type'],
  extra: Partial<Omit<SourceField, 'name' | 'type'>> = {},
): SourceField => ({ name, type, required: false, unique: false, ...extra });

const obj = (
  name: string,
  fields: SourceField[],
  classification: SourceObject['classification'] = 'record',
): SourceObject => ({
  name,
  classification,
  capabilities: {
    pagination: 'offset',
    changeField: 'date_modified',
    deleteVisibility: 'none',
    count: true,
    maxPageSize: 200,
  },
  fields,
});

export function testSourceSchema(): SourceSchema {
  return {
    sourceVersion: 'fixture-v1',
    objects: [
      obj('Accounts', [
        f('id', 'id', { unique: true }),
        f('name', 'string'),
        f('website', 'string'),
        f('date_modified', 'datetime'),
        f('deleted', 'boolean'),
      ]),
      obj('Contacts', [
        f('id', 'id', { unique: true }),
        f('email1', 'string'),
        f('first_name', 'string'),
        f('last_name', 'string'),
        f('title', 'string'),
        f('account_id', 'relate', { relatesTo: 'Accounts' }),
        f('date_modified', 'datetime'),
      ]),
      obj('Opportunities', [
        f('id', 'id', { unique: true }),
        f('name', 'string'),
        f('account_id', 'relate', { relatesTo: 'Accounts' }),
        f('sales_stage', 'enum', {
          enumOptions: FIXTURE_SALES_STAGES.map((value) => ({ value, active: true })),
        }),
        f('date_closed', 'date'),
        f('date_modified', 'datetime'),
      ]),
      obj('RevenueLineItems', [
        f('id', 'id', { unique: true }),
        f('name', 'string'),
        f('account_id', 'relate', { relatesTo: 'Accounts' }),
        f('opportunity_id', 'relate', { relatesTo: 'Opportunities' }),
        f('product_template_id', 'relate', { relatesTo: 'ProductTemplates' }),
        f('quantity', 'number'),
        f('sales_stage', 'enum', {
          enumOptions: FIXTURE_SALES_STAGES.map((value) => ({ value, active: true })),
        }),
        f('status', 'enum', {
          enumOptions: [
            { value: 'Active', active: true },
            { value: 'Expired', active: true },
          ],
        }),
        f('renewal', 'boolean'),
        f('renewal_rli_id', 'relate', { relatesTo: 'RevenueLineItems' }),
        f('recurring_one_off_c', 'enum', {
          enumOptions: ['Recurring', 'Non Recurring', 'One Off'].map((value) => ({
            value,
            active: true,
          })),
        }),
        f('service', 'boolean'),
        f('service_start_date', 'date'),
        f('service_end_date', 'date'),
        f('date_closed', 'date'),
        f('date_entered', 'datetime'),
        f('date_modified', 'datetime'),
        f('deleted', 'boolean'),
        f('mrr_c', 'number'),
      ]),
      obj(
        'ProductTemplates',
        [
          f('id', 'id', { unique: true }),
          f('name', 'string'),
          f('type_name', 'string'),
          f('date_modified', 'datetime'),
        ],
        'reference',
      ),
      obj(
        'Users',
        [f('id', 'id', { unique: true }), f('user_name', 'string'), f('date_modified', 'datetime')],
        'internal_principal',
      ),
    ],
  };
}

const confirmed = (note: string) => ({ by: 'test-operator', note });

/** The default TEST mapping (see the module comment: test configuration only). */
export function testMapping(): MappingDocument {
  return {
    objects: [
      {
        source: 'Accounts',
        entity: 'account',
        identity: { field: 'id' },
        relationships: [],
        fields: [{ kind: 'ignored', source: 'name', reason: 'not_authoritative' }],
      },
      {
        source: 'RevenueLineItems',
        entity: 'subscription',
        identity: { field: 'id' },
        holdingFilter: {
          field: 'sales_stage',
          operator: 'in',
          values: ['Closed Won'],
          confirmation: confirmed('TEST ONLY: holding stage for fixtures'),
        },
        relationships: [
          {
            target: 'subscription.account',
            field: 'account_id',
            object: 'Accounts',
            fallbackVia: {
              field: 'opportunity_id',
              object: 'Opportunities',
              targetField: 'account_id',
              confirmation: confirmed('TEST ONLY: opportunity account as fallback'),
            },
          },
          { target: 'subscription.product', field: 'product_template_id', productReference: true },
        ],
        fields: [
          {
            kind: 'core',
            target: 'subscription.state',
            explicit: 'unknown',
            reason: 'no_reliable_source_state',
          },
          {
            kind: 'core',
            target: 'subscription.startsAt',
            source: 'service_start_date',
            transforms: {
              parse: { type: 'date', format: 'iso_date', timeZone: 'UTC', inclusiveEnd: false },
            },
            confirmation: confirmed('TEST ONLY: service term start'),
          },
          {
            kind: 'core',
            target: 'subscription.endsAt',
            source: 'service_end_date',
            transforms: {
              parse: { type: 'date', format: 'iso_date', timeZone: 'UTC', inclusiveEnd: true },
            },
            confirmation: confirmed('TEST ONLY: service term end, inclusive'),
          },
          {
            kind: 'core',
            target: 'subscription.quantity',
            source: 'quantity',
            transforms: { parse: { type: 'integer' } },
          },
          { kind: 'ignored', source: 'renewal', reason: 'semantics_unconfirmed' },
          { kind: 'ignored', source: 'renewal_rli_id', reason: 'semantics_unconfirmed' },
          { kind: 'ignored', source: 'status', reason: 'not_populated' },
        ],
      },
    ],
    productReferences: {
      object: 'ProductTemplates',
      identity: { field: 'id' },
      ignored: [],
    },
  };
}

export function testAuthority(
  overrides: Partial<AuthorityDocument['facts']> = {},
): AuthorityDocument {
  return {
    facts: {
      account_profile: null,
      person_profile: null,
      subscription_lines: TEST_CONNECTION_ID,
      subscription_state: null,
      subscription_terms: TEST_CONNECTION_ID,
      ...overrides,
    },
  };
}
