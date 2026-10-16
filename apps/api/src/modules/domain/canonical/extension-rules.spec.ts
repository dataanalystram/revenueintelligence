import { describe, expect, it } from 'vitest';
import {
  evidenceRelationFacts,
  extensionNarrowings,
  INTEGRITY_CHECKS,
  type EvidenceRelation,
  type ExtensionEntryDraft,
} from '.';

const field = (
  key: string,
  definition: Record<string, unknown>,
  status: 'active' | 'retired' = 'active',
): ExtensionEntryDraft => ({
  key,
  status,
  sensitivity: 'internal',
  categories: ['operational'],
  definition: { kind: 'field', key, target: 'account', ...definition },
});
const stored = (d: ExtensionEntryDraft) => ({
  key: d.key,
  definition: d.definition,
  sensitivity: d.sensitivity,
  categories: d.categories,
});

/** X5 (plan §2.5): narrowing a constraint is probed against stored values at publish. */
describe('extensionNarrowings (R-X5)', () => {
  it('finds nothing when the constraints are unchanged or widened', () => {
    const before = field('tier', {
      value_type: 'string',
      constraints: { max_length: 50 },
    });
    expect(extensionNarrowings([stored(before)], [before])).toEqual([]);
    const wider = field('tier', { value_type: 'string', constraints: { max_length: 80 } });
    expect(extensionNarrowings([stored(before)], [wider])).toEqual([]);
    const dropped = field('tier', { value_type: 'string' });
    expect(extensionNarrowings([stored(before)], [dropped])).toEqual([]);
  });

  it('a lowered or newly set max_length, max_items, max and a raised min are narrowings', () => {
    const before = field('score', { value_type: 'number', constraints: { min: 0, max: 100 } });
    const after = field('score', { value_type: 'number', constraints: { min: 10, max: 90 } });
    expect(extensionNarrowings([stored(before)], [after])).toEqual([
      { key: 'score', check: 'max', limit: 90 },
      { key: 'score', check: 'min', limit: 10 },
    ]);
    const text = field('note', { value_type: 'text' });
    const capped = field('note', { value_type: 'text', constraints: { max_length: 20 } });
    expect(extensionNarrowings([stored(text)], [capped])).toEqual([
      { key: 'note', check: 'max_length', limit: 20 },
    ]);
    const tags = field('tags', { value_type: 'multi_enum', constraints: { max_items: 5 } });
    const fewer = field('tags', { value_type: 'multi_enum', constraints: { max_items: 3 } });
    expect(extensionNarrowings([stored(tags)], [fewer])).toEqual([
      { key: 'tags', check: 'max_items', limit: 3 },
    ]);
  });

  it('retiring an enum code is a narrowing (removal is the generic R-X3)', () => {
    const codes = (retired: boolean) => [
      { code: 'gold', label: 'Gold', status: 'active' },
      { code: 'silver', label: 'Silver', status: retired ? 'retired' : 'active' },
    ];
    const before = field('tier', { value_type: 'enum', allowed_values: codes(false) });
    const after = field('tier', { value_type: 'enum', allowed_values: codes(true) });
    expect(extensionNarrowings([stored(before)], [after])).toEqual([
      { key: 'tier', check: 'enum_codes', codes: ['silver'] },
    ]);
  });

  it('a changed JSON schema and a narrowed reference_to are probed', () => {
    const before = field('meta', {
      value_type: 'json',
      constraints: { json_schema: { type: 'object' } },
    });
    const after = field('meta', {
      value_type: 'json',
      constraints: {
        json_schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      },
    });
    expect(extensionNarrowings([stored(before)], [after])).toEqual([
      {
        key: 'meta',
        check: 'json_schema',
        schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      },
    ]);
    const ref = (to: string[]) =>
      field('owner', { value_type: 'reference', constraints: { reference_to: to } });
    expect(
      extensionNarrowings(
        [stored(ref(['account', 'person', 'custom_object:site', 'custom_object:plant']))],
        [ref(['account', 'custom_object:site'])],
      ),
    ).toEqual([
      {
        key: 'owner',
        check: 'reference_to',
        kinds: ['company', 'custom_record'],
        objectKeys: ['site'],
      },
    ]);
  });

  it('a narrower relationship cardinality is probed; a wider one is not', () => {
    const rel = (cardinality: string): ExtensionEntryDraft => ({
      key: 'uses',
      status: 'active',
      sensitivity: 'internal',
      categories: ['operational'],
      definition: {
        kind: 'custom_relationship',
        key: 'uses',
        from: 'account',
        to: 'person',
        cardinality,
      },
    });
    expect(extensionNarrowings([stored(rel('many_to_many'))], [rel('many_to_one')])).toEqual([
      { key: 'uses', check: 'cardinality', cardinality: 'many_to_one' },
    ]);
    expect(extensionNarrowings([stored(rel('one_to_one'))], [rel('many_to_many')])).toEqual([]);
  });

  it('a key absent from the next version is left to the generic R-X1', () => {
    const before = field('gone', { value_type: 'string', constraints: { max_length: 5 } });
    expect(extensionNarrowings([stored(before)], [])).toEqual([]);
  });
});

describe('M10D integrity checks (plan §14)', () => {
  it('adds the eight extension checks after the M10C checks', () => {
    // M10E appends five checks after the eight M10D ones, then M10D hardening #83 one,
    // then the six M10F checks.
    expect(INTEGRITY_CHECKS.slice(-20, -12)).toEqual([
      'extension_value_type_mismatch',
      'extension_value_restricted',
      'extension_value_target_kind',
      'extension_items_parity',
      'extension_value_secret_like',
      'custom_record_parent_missing',
      'custom_relationship_cardinality',
      'extension_history_parity',
    ]);
    expect(new Set(INTEGRITY_CHECKS).size).toBe(INTEGRITY_CHECKS.length);
  });

  it('tech debt #83 appends the custom object owner drift check after the M10E checks', () => {
    expect(INTEGRITY_CHECKS.at(-7)).toBe('custom_object_owner_drift');
  });

  it('M10F appends the six commercial checks last (plan §15)', () => {
    expect(INTEGRITY_CHECKS.slice(-6)).toEqual([
      'commercial_line_contract_company_mismatch',
      'commercial_line_price_offer_product_mismatch',
      'commercial_contract_link_cycle',
      'commercial_contract_link_cross_account',
      'commercial_line_lineage_cycle',
      'commercial_agreement_contract_drift',
    ]);
  });
});

describe('EvidenceRelation.fact (plan §6, #71)', () => {
  const relations: EvidenceRelation[] = [
    {
      subjectKind: 'company',
      evidenceType: 'entity',
      evidenceKind: 'custom_record',
      roles: ['supports'],
      fact: 'account_identity',
    },
    {
      subjectKind: 'company',
      evidenceType: 'entity',
      evidenceKind: 'custom_record',
      roles: ['context'],
    },
  ];
  it('names the facts of the relations a link matches', () => {
    const link = { evidenceType: 'entity', evidenceKind: 'custom_record', role: 'supports' };
    expect(evidenceRelationFacts(relations, 'company', link)).toEqual(['account_identity']);
    expect(evidenceRelationFacts(relations, 'company', { ...link, role: 'context' })).toEqual([]);
    expect(evidenceRelationFacts(relations, 'person', link)).toEqual([]);
  });
});
