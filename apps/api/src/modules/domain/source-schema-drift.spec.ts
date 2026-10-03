import { describe, expect, it } from 'vitest';
import { testMapping, testSourceSchema } from '../../../test/fixtures/source-mapping';
import { AuthorityDocumentSchema, factsHeldBy, UNASSIGNED_AUTHORITY } from './source-authority';
import {
  normaliseSourceSchema,
  SourceSchemaSchema,
  sourceSchemaHash,
  type SourceSchema,
} from './source-connector';
import { detectSchemaDrift, mappedSurface } from './source-schema-drift';

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

function edited(edit: (s: Mutable<SourceSchema>) => void): SourceSchema {
  const s: Mutable<SourceSchema> = structuredClone(testSourceSchema());
  edit(s);
  return s;
}
const field = (s: Mutable<SourceSchema>, object: string, name: string) =>
  s.objects.find((o) => o.name === object)!.fields.find((f) => f.name === name)!;

describe('schema snapshots', () => {
  it('hash is independent of object, field and option order, and changes with content', () => {
    const base = testSourceSchema();
    const shuffled = edited((s) => {
      s.objects.reverse();
      s.objects.forEach((o) => o.fields.reverse());
      field(s, 'RevenueLineItems', 'sales_stage').enumOptions!.reverse();
    });
    expect(sourceSchemaHash(shuffled)).toBe(sourceSchemaHash(base));
    expect(normaliseSourceSchema(shuffled)).toEqual(normaliseSourceSchema(base));
    const changed = edited((s) => {
      field(s, 'RevenueLineItems', 'quantity').type = 'string';
    });
    expect(sourceSchemaHash(changed)).not.toBe(sourceSchemaHash(base));
  });

  it('is metadata only: no slot for record values, defaults or formulas', () => {
    const withValues = edited((s) => {
      (field(s, 'Accounts', 'name') as Record<string, unknown>).sampleValues = ['Acme'];
    });
    expect(SourceSchemaSchema.safeParse(withValues).success).toBe(false);
    const withDefault = edited((s) => {
      (field(s, 'Accounts', 'name') as Record<string, unknown>).default = 'x';
    });
    expect(SourceSchemaSchema.safeParse(withDefault).success).toBe(false);
  });

  it('refuses duplicate objects and fields', () => {
    const dup = edited((s) => {
      s.objects.push(s.objects[0]!);
    });
    expect(SourceSchemaSchema.safeParse(dup).success).toBe(false);
  });
});

describe('schema drift on the mapped surface (fixture C3)', () => {
  const doc = testMapping();
  const before = testSourceSchema();

  it('the mapped surface includes fallback hop fields and the product identity', () => {
    const surface = mappedSurface(doc);
    expect([...surface.get('Opportunities')!]).toEqual(['account_id']);
    expect([...surface.get('ProductTemplates')!]).toEqual(['id']);
  });

  it('no drift on an identical schema', () => {
    expect(detectSchemaDrift(doc, before, before)).toEqual([]);
  });

  it('a removed or retyped mapped field, or a removed object, is blocking', () => {
    expect(
      detectSchemaDrift(
        doc,
        before,
        edited((s) => {
          const o = s.objects.find((x) => x.name === 'RevenueLineItems')!;
          o.fields = o.fields.filter((f) => f.name !== 'service_end_date');
        }),
      ),
    ).toEqual([
      {
        code: 'mapped_field_removed',
        object: 'RevenueLineItems',
        field: 'service_end_date',
        blocking: true,
      },
    ]);
    expect(
      detectSchemaDrift(
        doc,
        before,
        edited((s) => {
          field(s, 'RevenueLineItems', 'service_start_date').type = 'string';
        }),
      ),
    ).toEqual([
      {
        code: 'mapped_field_type_changed',
        object: 'RevenueLineItems',
        field: 'service_start_date',
        blocking: true,
      },
    ]);
    expect(
      detectSchemaDrift(
        doc,
        before,
        edited((s) => {
          s.objects = s.objects.filter((o) => o.name !== 'ProductTemplates');
        }),
      ),
    ).toEqual([{ code: 'mapped_object_removed', object: 'ProductTemplates', blocking: true }]);
  });

  it('a new enum option is reported but not blocking; removing a filter value is blocking', () => {
    expect(
      detectSchemaDrift(
        doc,
        before,
        edited((s) => {
          field(s, 'RevenueLineItems', 'sales_stage').enumOptions!.push({
            value: 'Credited',
            active: true,
          });
        }),
      ),
    ).toEqual([
      {
        code: 'enum_option_added',
        object: 'RevenueLineItems',
        field: 'sales_stage',
        blocking: false,
      },
    ]);
    expect(
      detectSchemaDrift(
        doc,
        before,
        edited((s) => {
          const f = field(s, 'RevenueLineItems', 'sales_stage');
          f.enumOptions = f.enumOptions!.filter((o) => o.value !== 'Closed Won');
        }),
      ),
    ).toEqual([
      {
        code: 'enum_option_removed',
        object: 'RevenueLineItems',
        field: 'sales_stage',
        blocking: true,
      },
    ]);
  });

  it('changes outside the mapped surface are ignored', () => {
    expect(
      detectSchemaDrift(
        doc,
        before,
        edited((s) => {
          const o = s.objects.find((x) => x.name === 'RevenueLineItems')!;
          o.fields = o.fields.filter((f) => f.name !== 'mrr_c');
          field(s, 'Accounts', 'website').type = 'text';
        }),
      ),
    ).toEqual([]);
  });

  it('a changed relationship target is blocking', () => {
    expect(
      detectSchemaDrift(
        doc,
        before,
        edited((s) => {
          field(s, 'RevenueLineItems', 'account_id').relatesTo = 'Contacts';
        }),
      ),
    ).toEqual([
      {
        code: 'relationship_target_changed',
        object: 'RevenueLineItems',
        field: 'account_id',
        blocking: true,
      },
    ]);
  });
});

describe('source authority document', () => {
  it('states every one of the five facts and nothing else', () => {
    expect(AuthorityDocumentSchema.safeParse(UNASSIGNED_AUTHORITY).success).toBe(true);
    const { subscription_state: _omitted, ...missing } = UNASSIGNED_AUTHORITY.facts;
    expect(AuthorityDocumentSchema.safeParse({ facts: missing }).success).toBe(false);
    expect(
      AuthorityDocumentSchema.safeParse({
        facts: { ...UNASSIGNED_AUTHORITY.facts, product_identity: null },
      }).success,
    ).toBe(false);
    // No precedence lists or voting: a fact holds one connection id or null.
    expect(
      AuthorityDocumentSchema.safeParse({
        facts: {
          ...UNASSIGNED_AUTHORITY.facts,
          subscription_state: ['0c0c0c0c-0c0c-40c0-80c0-0c0c0c0c0c0c'],
        },
      }).success,
    ).toBe(false);
  });

  it('lists the facts a connection holds', () => {
    const id = '0c0c0c0c-0c0c-40c0-80c0-0c0c0c0c0c0c';
    expect(
      factsHeldBy(
        {
          facts: { ...UNASSIGNED_AUTHORITY.facts, subscription_lines: id, subscription_terms: id },
        },
        id,
      ),
    ).toEqual(['subscription_lines', 'subscription_terms']);
  });
});
