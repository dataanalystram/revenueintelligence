import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OTHER_CONNECTION_ID,
  TEST_CONNECTION_ID,
  testAuthority,
  FIXTURE_SALES_STAGES,
  testMapping,
  testProfiles,
  testProfilingInput,
  testReviewedDomain,
  testSourceSchema,
  testSyntheticValue as defaultValue,
} from '../../../test/fixtures/source-mapping';
import { sourceSchemaHash } from './source-connector';
import {
  holdingsConfirmed,
  mappedFields,
  validateMapping,
  type MappingDocument,
  type MappingValidationContext,
} from './source-mapping';
import type { AuthorityDocument } from './source-authority';

const schema = testSourceSchema();
const hash = sourceSchemaHash(schema);
/** Fresh covering profiles for every object (M9A): built once, shared by the M8 cases. */
const PROFILING = testProfilingInput();

function ctx(overrides: Partial<MappingValidationContext> = {}): MappingValidationContext {
  return {
    connectionId: TEST_CONNECTION_ID,
    kind: 'sugar',
    schema,
    schemaHash: hash,
    latestSchemaHash: hash,
    authority: testAuthority(),
    profiling: PROFILING,
    ...overrides,
  };
}

/** Deep-copied default test mapping, edited by `edit`. */
function mapping(edit?: (doc: MappingDocument & Record<string, unknown>) => void): unknown {
  const doc = structuredClone(testMapping()) as MappingDocument & Record<string, unknown>;
  edit?.(doc);
  return doc;
}
const lines = (doc: MappingDocument) => doc.objects.find((o) => o.entity === 'subscription')!;

function codes(raw: unknown, c: MappingValidationContext = ctx()): string[] {
  const r = validateMapping(raw, c);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe('mapping validation (ADR 0020)', () => {
  it('the default test mapping is valid and hashes deterministically', () => {
    const a = validateMapping(mapping(), ctx());
    const b = validateMapping(mapping(), ctx());
    expect(a.ok).toBe(true);
    expect(a.ok && b.ok && a.contentHash === b.contentHash).toBe(true);
    expect(a.ok && a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('entry kinds', () => {
    it('refuses the reserved attribute kind', () => {
      const raw = mapping((d) => {
        lines(d).fields.push({ kind: 'attribute', source: 'mrr_c', attribute: 'mrr' } as never);
      });
      expect(codes(raw)).toEqual(['attribute_mappings_not_enabled']);
    });

    it('refuses free target paths and unknown entities', () => {
      expect(
        codes(
          mapping((d) => {
            lines(d).fields.push({
              kind: 'core',
              target: 'subscription.metadata.mrr',
              source: 'mrr_c',
            } as never);
          }),
        ),
      ).toContain('invalid_target');
      expect(
        codes(
          mapping((d) => {
            d.objects[0]!.entity = 'opportunity';
          }),
        ),
      ).toContain('invalid_entity');
    });

    it('refuses unknown source objects and fields (validated against the snapshot)', () => {
      expect(
        codes(
          mapping((d) => {
            lines(d).fields.push({ kind: 'ignored', source: 'not_a_field', reason: 'x_y' });
          }),
        ),
      ).toEqual(['unknown_source_field']);
      expect(
        codes(
          mapping((d) => {
            d.objects[0]!.source = 'Leads';
          }),
        ),
      ).toContain('unknown_source_object');
    });

    it('refuses two entries writing the same target', () => {
      expect(
        codes(
          mapping((d) => {
            lines(d).fields.push({
              kind: 'core',
              target: 'subscription.quantity',
              explicit: 'null',
              reason: 'twice',
            });
          }),
        ),
      ).toContain('duplicate_target');
    });

    it('refuses mapping the source internal users to a person (fixture C5)', () => {
      expect(
        codes(
          mapping((d) => {
            d.objects.push({
              source: 'Users',
              entity: 'person',
              identity: { field: 'id' },
              relationships: [],
              fields: [],
            });
          }),
        ),
      ).toContain('invalid_entity');
    });
  });

  describe('identity', () => {
    it('refuses a name as identity, confirmed or not', () => {
      expect(
        codes(
          mapping((d) => {
            d.objects[0]!.identity = { field: 'name', confirmation: { by: 'x', note: 'y' } };
          }),
        ),
      ).toContain('identity_unsuitable');
    });

    it('refuses product identity by name (8.8% duplicate names in the evidence)', () => {
      expect(
        codes(
          mapping((d) => {
            d.productReferences!.identity = { field: 'name' };
          }),
        ),
      ).toEqual(['identity_unsuitable']);
    });

    it('a non-unique identity needs a confirmation', () => {
      const raw = (confirmation?: { by: string; note: string }) =>
        mapping((d) => {
          d.objects[0]!.identity = { field: 'website', ...(confirmation ? { confirmation } : {}) };
        });
      // Profiles where the website values are unique (M9A: the profile is checked too).
      const unique = ctx({
        profiling: testProfilingInput({
          profiles: testProfiles(schema, {
            values: (object, field, i) =>
              object === 'Accounts' && field.name === 'website'
                ? `site${i}`
                : defaultValue(field, i),
          }),
        }),
      });
      expect(codes(raw(), unique)).toEqual(['identity_unsuitable']);
      expect(codes(raw({ by: 'ops', note: 'website is unique for this tenant' }), unique)).toEqual(
        [],
      );
    });

    it('M9A: a confirmed identity is still refused when the profile shows duplicate values', () => {
      const raw = mapping((d) => {
        d.objects[0]!.identity = { field: 'website', confirmation: { by: 'ops', note: 'unique' } };
      });
      // The default synthetic profile repeats website values (v0, v1, v2).
      expect(codes(raw)).toEqual(['identity_unsuitable']);
    });
  });

  describe('holding filter', () => {
    it('accepts one field, one membership predicate, values from the enum, confirmed', () => {
      for (const operator of ['in', 'not_in'] as const) {
        expect(
          codes(
            mapping((d) => {
              lines(d).holdingFilter!.operator = operator;
              // M9A: the reviewed domain must agree with the operator (not_in lists non-holdings).
              if (operator === 'not_in') {
                lines(d).holdingFilter!.reviewedDomain = testReviewedDomain(
                  hash,
                  FIXTURE_SALES_STAGES.filter((v) => v !== 'Closed Won'),
                );
              }
            }),
          ),
        ).toEqual([]);
      }
    });

    it('refuses values that are not options of the field', () => {
      expect(
        codes(
          mapping((d) => {
            lines(d).holdingFilter!.values = ['Closed Won', 'Closed-Won'];
          }),
        ),
        // M9A: the extra value is also missing from the reviewed domain.
      ).toEqual(['holding_filter_unconfirmed', 'holding_filter_domain_incomplete']);
    });

    it('refuses a filter without a recorded business confirmation', () => {
      expect(
        codes(
          mapping((d) => {
            delete lines(d).holdingFilter!.confirmation;
          }),
        ),
      ).toEqual(expect.arrayContaining(['holding_filter_unconfirmed', 'holding_filter_required']));
    });

    it.each([
      [
        'a nested condition',
        { field: 'sales_stage', operator: 'in', values: ['Closed Won'], and: [] },
      ],
      [
        'an expression',
        { field: 'sales_stage', operator: 'in', values: ['Closed Won'], expression: 'x' },
      ],
      [
        'a SQL fragment as operator',
        { field: 'sales_stage', operator: "= 'x' OR 1=1", values: ['a'] },
      ],
      ['a comparison operator', { field: 'sales_stage', operator: 'gt', values: ['a'] }],
      ['a cross-field comparison', { field: 'sales_stage', operator: 'in', valuesFrom: 'status' }],
      [
        'a parent-object field',
        { field: 'Opportunity.sales_stage', operator: 'in', values: ['a'] },
      ],
      ['an empty value set', { field: 'sales_stage', operator: 'in', values: [] }],
    ])('refuses %s (schema-level)', (_label, holdingFilter) => {
      expect(
        codes(
          mapping((d) => {
            lines(d).holdingFilter = holdingFilter as never;
          }),
        ),
      ).toContain('invalid_document');
    });

    it('works only on fields of the mapped object itself (parent fields are not supported)', () => {
      // `amount` exists on Opportunities, not on the line object.
      expect(
        codes(
          mapping((d) => {
            lines(d).holdingFilter!.field = 'amount';
          }),
        ),
      ).toContain('unknown_source_field');
      // A relationship field holds a reference, not a holding qualifier.
      expect(
        codes(
          mapping((d) => {
            lines(d).holdingFilter = {
              field: 'opportunity_id',
              operator: 'in',
              values: ['x'],
              confirmation: { by: 'x', note: 'y' },
            };
          }),
        ),
      ).toContain('unsupported_source_type');
    });

    it('is allowed on subscription objects only, and not together with all-holdings', () => {
      expect(
        codes(
          mapping((d) => {
            d.objects[0]!.holdingFilter = lines(d).holdingFilter;
          }),
        ),
      ).toContain('holding_filter_not_allowed');
      expect(
        codes(
          mapping((d) => {
            lines(d).allRecordsAreHoldings = { confirmation: { by: 'x', note: 'y' } };
          }),
        ),
      ).toContain('holding_filter_not_allowed');
    });

    it('authority for subscription_lines needs a confirmed filter or a confirmed all-holdings statement', () => {
      const withoutFilter = mapping((d) => {
        delete lines(d).holdingFilter;
      });
      expect(codes(withoutFilter)).toEqual(['holding_filter_required']);
      // Not the authority: the mapping may be published (lines are gated at run start).
      expect(
        codes(
          withoutFilter,
          ctx({ authority: testAuthority({ subscription_lines: OTHER_CONNECTION_ID }) }),
        ),
      ).toEqual([]);
      const declared = (confirmation?: { by: string; note: string }) =>
        mapping((d) => {
          delete lines(d).holdingFilter;
          lines(d).allRecordsAreHoldings = confirmation ? { confirmation } : {};
        });
      expect(codes(declared({ by: 'ops', note: 'every record is a holding' }))).toEqual([]);
      expect(codes(declared())).toEqual(
        expect.arrayContaining(['holding_filter_unconfirmed', 'holding_filter_required']),
      );
    });

    it('holdingsConfirmed mirrors the rule', () => {
      const doc = testMapping();
      expect(holdingsConfirmed(lines(doc))).toBe(true);
      expect(holdingsConfirmed({ ...lines(doc), holdingFilter: undefined })).toBe(false);
    });
  });

  describe('state, dates and required targets', () => {
    it('state, terms, account and product must be mapped or explicitly stated', () => {
      expect(
        codes(
          mapping((d) => {
            lines(d).fields = lines(d).fields.filter(
              (f) => !('target' in f) || f.target !== 'subscription.state',
            );
          }),
        ),
      ).toEqual(['required_target_unstated']);
      expect(
        codes(
          mapping((d) => {
            lines(d).fields = lines(d).fields.filter(
              (f) => !('target' in f) || f.target !== 'subscription.endsAt',
            );
          }),
        ),
      ).toEqual(['required_target_unstated']);
      expect(
        codes(
          mapping((d) => {
            lines(d).relationships = lines(d).relationships.filter(
              (r) => r.target !== 'subscription.product',
            );
          }),
        ),
      ).toEqual(['product_reference_required']);
    });

    it('explicit unknown only for targets with an unknown value; explicit null otherwise', () => {
      expect(
        codes(
          mapping((d) => {
            const state = lines(d).fields.find(
              (f) => 'target' in f && f.target === 'subscription.state',
            )!;
            Object.assign(state, { explicit: 'null' });
          }),
        ),
      ).toEqual(['invalid_explicit_value']);
      expect(
        codes(
          mapping((d) => {
            lines(d).fields = lines(d).fields.map((f) =>
              'target' in f && f.target === 'subscription.startsAt'
                ? {
                    kind: 'core',
                    target: 'subscription.startsAt',
                    explicit: 'unknown',
                    reason: 'x_y',
                  }
                : f,
            );
          }),
        ),
      ).toEqual(['invalid_explicit_value']);
    });

    it('an unconfirmed date mapping is refused; explicit null is the alternative', () => {
      expect(
        codes(
          mapping((d) => {
            const start = lines(d).fields.find(
              (f) => 'target' in f && f.target === 'subscription.startsAt',
            ) as { confirmation?: unknown };
            delete start.confirmation;
          }),
        ),
      ).toEqual(['unconfirmed_consequential_entry']);
      expect(
        codes(
          mapping((d) => {
            lines(d).fields = lines(d).fields.map((f) =>
              'target' in f &&
              (f.target === 'subscription.startsAt' || f.target === 'subscription.endsAt')
                ? { kind: 'core', target: f.target, explicit: 'null', reason: 'term_unconfirmed' }
                : f,
            );
          }),
        ),
      ).toEqual([]);
    });

    it('dates need a declared parse; an inclusive start is refused', () => {
      expect(
        codes(
          mapping((d) => {
            const start = lines(d).fields.find(
              (f) => 'target' in f && f.target === 'subscription.startsAt',
            ) as { transforms?: unknown };
            delete start.transforms;
          }),
        ),
      ).toEqual(['unsupported_source_type']);
      expect(
        codes(
          mapping((d) => {
            const start = lines(d).fields.find(
              (f) => 'target' in f && f.target === 'subscription.startsAt',
            ) as { transforms: { parse: { inclusiveEnd: boolean } } };
            start.transforms.parse.inclusiveEnd = true;
          }),
        ),
      ).toEqual(['unsupported_source_type']);
    });

    it('a source type that cannot reach the target is refused', () => {
      expect(
        codes(
          mapping((d) => {
            lines(d).fields = lines(d).fields.map((f) =>
              'target' in f && f.target === 'subscription.startsAt'
                ? { ...f, source: 'renewal' }
                : f,
            );
          }),
        ),
      ).toContain('unsupported_source_type');
    });

    it('a mapped state needs authority, a confirmation and a complete value map into canonical states', () => {
      const stateFrom = (
        map: Record<string, string>,
        authority: AuthorityDocument = testAuthority({ subscription_state: TEST_CONNECTION_ID }),
        confirmation = true,
      ) =>
        codes(
          mapping((d) => {
            lines(d).fields = lines(d).fields.map((f) =>
              'target' in f && f.target === 'subscription.state'
                ? {
                    kind: 'core',
                    target: 'subscription.state',
                    source: 'status',
                    transforms: { valueMap: { map, unmapped: 'unknown' } },
                    ...(confirmation
                      ? { confirmation: { by: 'ops', note: 'TEST: status meaning' } }
                      : {}),
                  }
                : f,
            );
            lines(d).fields = lines(d).fields.filter(
              (f) => !(f.kind === 'ignored' && f.source === 'status'),
            );
          }),
          ctx({ authority }),
        );
      expect(stateFrom({ Active: 'active', Expired: 'expired' })).toEqual([]);
      expect(stateFrom({ Active: 'active' })).toEqual(['invalid_enum_map']);
      expect(stateFrom({ Active: 'live', Expired: 'expired' })).toEqual(['invalid_enum_map']);
      expect(stateFrom({ Active: 'active', Expired: 'expired' }, testAuthority())).toEqual([
        'authority_conflict',
      ]);
      expect(stateFrom({ Active: 'active', Expired: 'expired' }, undefined, false)).toEqual([
        'unconfirmed_consequential_entry',
      ]);
    });
  });

  describe('authority and relationships', () => {
    it('terms from a connection that is not their authority are refused (authority_conflict)', () => {
      expect(
        codes(mapping(), ctx({ authority: testAuthority({ subscription_terms: null }) })),
      ).toEqual(['authority_conflict', 'authority_conflict']);
    });

    it('account profile fields need account_profile authority', () => {
      const raw = mapping((d) => {
        d.objects[0]!.fields = [{ kind: 'core', target: 'account.name', source: 'name' }];
      });
      expect(codes(raw)).toEqual(['authority_conflict']);
      expect(
        codes(raw, ctx({ authority: testAuthority({ account_profile: TEST_CONNECTION_ID }) })),
      ).toEqual([]);
    });

    it('an account relationship must point at an object mapped as account', () => {
      expect(
        codes(
          mapping((d) => {
            d.objects = d.objects.filter((o) => o.entity !== 'account');
          }),
        ),
      ).toContain('missing_relationship_target');
    });

    it('a relationship fallback needs a recorded confirmation', () => {
      expect(
        codes(
          mapping((d) => {
            delete lines(d).relationships[0]!.fallbackVia!.confirmation;
          }),
        ),
      ).toEqual(['unconfirmed_consequential_entry']);
    });

    it('product relationships need declared product references', () => {
      expect(
        codes(
          mapping((d) => {
            delete d.productReferences;
          }),
        ),
      ).toContain('product_reference_required');
    });
  });

  it('the runtime TEST mapping file equals the test configuration (plus the ignored companion product) and is valid', () => {
    const file = JSON.parse(
      readFileSync(resolve(__dirname, '../../../test/fixtures/sugar/mapping.test.json'), 'utf8'),
    ) as unknown;
    const expected = testMapping();
    expected.productReferences = {
      ...expected.productReferences!,
      ignored: [{ id: 'FIX-PROD-900', reason: 'test_not_offered' }],
    };
    expect(file).toEqual(expected);
    expect(codes(file)).toEqual([]);
  });

  describe('snapshot and document limits', () => {
    it('refuses a document validated against a snapshot that is not the latest', () => {
      expect(codes(mapping(), ctx({ latestSchemaHash: 'f'.repeat(64) }))).toEqual([
        'schema_snapshot_stale',
      ]);
    });

    it('refuses unknown document keys (no secret or free-form slots)', () => {
      expect(
        codes(
          mapping((d) => {
            d.apiToken = 'x';
          }),
        ),
      ).toContain('invalid_document');
    });

    it('lists the fields a mapping reads (identity, filter, relationships, fallback, mapped fields)', () => {
      expect(mappedFields(lines(testMapping()))).toEqual([
        'account_id',
        'id',
        'opportunity_id',
        'product_template_id',
        'quantity',
        'sales_stage',
        'service_end_date',
        'service_start_date',
      ]);
    });
  });
});
