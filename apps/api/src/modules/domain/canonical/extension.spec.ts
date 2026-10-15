import { describe, expect, it } from 'vitest';
import { EXTENSION_GUARDRAIL_ENV } from '../../../platform/config/config.schema';
import {
  credentialLikeTokens,
  currencyExponent,
  DEFAULT_EXTENSION_GUARDRAILS,
  EXTENSION_GUARDRAIL_SPECS,
  extensionRuleViolations,
  isExtensionHistoryField,
  keysTighteningToRestricted,
  validateExtensionDocument,
  type ExtensionEntryDraft,
} from './extension';

/** M10D plan §2 (V1, phase 1): pure validation of the extension registry document. */
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
const project = (over: Record<string, unknown> = {}) => ({
  key: 'project',
  display_name: 'Project',
  description: 'Implementation projects',
  sensitivity: 'internal',
  categories: ['commercial'],
  allowed_uses: ['display', 'analytics'],
  parent: { kind: 'account', required: true },
  ...over,
});
const doc = (parts: Record<string, unknown[]>) => ({ schema_version: 1, ...parts });
const codes = (raw: unknown) => {
  const v = validateExtensionDocument(raw);
  return v.ok ? [] : v.issues.map((i) => `${i.key}:${i.code}`);
};
const entries = (raw: unknown): readonly ExtensionEntryDraft[] => {
  const v = validateExtensionDocument(raw);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return v.entries;
};

describe('extension registry document (plan §2)', () => {
  it('accepts fields, custom objects and relationships and projects one entry per definition', () => {
    const out = entries(
      doc({
        objects: [project({ record_identity: { natural_key: ['code'] } })],
        fields: [
          field(),
          field({
            key: 'code',
            target: 'custom_object:project',
            value_type: 'string',
            allowed_values: undefined,
            constraints: { max_length: 50 },
            allowed_uses: ['display'],
          }),
        ],
        relationships: [
          {
            key: 'project_owner',
            display_name: 'Owner',
            description: 'Project owner',
            from: 'custom_object:project',
            to: 'person',
            cardinality: 'many_to_one',
            sensitivity: 'confidential',
            categories: ['commercial', 'personal'],
          },
        ],
      }),
    );
    expect(out.map((e) => [e.key, e.definition.kind, e.sensitivity])).toEqual([
      ['project', 'custom_object', 'internal'],
      ['tier', 'field', 'internal'],
      ['code', 'field', 'internal'],
      ['project_owner', 'custom_relationship', 'confidential'],
    ]);
    // R-X3 reads `codes`; the not_evidence_of floor is always present (Q21).
    expect(out[1]!.definition.codes).toEqual(['gold']);
    expect(out[1]!.definition.not_evidence_of).toEqual([
      'account_identity',
      'person_identity',
      'subscription_ownership',
    ]);
  });

  it('control 8: classification is required, floors hold, and a field is never weaker than its object', () => {
    expect(codes(doc({ fields: [field({ sensitivity: undefined })] }))).toEqual([
      'tier:classification_required',
    ]);
    expect(codes(doc({ fields: [field({ categories: [] })] }))).toEqual([
      'tier:classification_required',
    ]);
    expect(codes(doc({ fields: [field({ categories: ['personal'] })] }))).toEqual([
      'tier:classification_below_floor',
    ]);
    expect(
      codes(
        doc({
          objects: [project({ sensitivity: 'confidential' })],
          fields: [field({ target: 'custom_object:project', allowed_uses: ['display'] })],
        }),
      ),
    ).toEqual(['tier:classification_weaker_than_object']);
  });

  it('Q12: credential-like keys, names and descriptions are refused (whole words only)', () => {
    for (const over of [
      { key: 'api_key' },
      { display_name: 'Refresh token' },
      { description: 'Customer portal password' },
      { key: 'client_secret' },
    ]) {
      expect(codes(doc({ fields: [field(over)] }))).toContain(
        `${(over as { key?: string }).key ?? 'tier'}:credential_like_definition`,
      );
    }
    expect(credentialLikeTokens('tokenizer passwords')).toEqual([]);
    expect(credentialLikeTokens('API-Key')).toEqual(['api_key']);
    expect(codes(doc({ fields: [field({ description: 'Tokenizer settings' })] }))).toEqual([]);
  });

  it('types and constraints: closed per type, enum values required for enum types, currency known', () => {
    expect(codes(doc({ fields: [field({ allowed_values: [] })] }))).toEqual([
      'tier:allowed_values_required',
    ]);
    expect(
      codes(
        doc({
          fields: [
            field({ value_type: 'string', allowed_values: undefined, constraints: { min: 1 } }),
          ],
        }),
      ),
    ).toEqual(['tier:constraint_not_allowed']);
    expect(
      codes(
        doc({
          fields: [
            field({
              value_type: 'money',
              allowed_values: undefined,
              constraints: { currency: 'XXX' },
              sensitivity: 'confidential',
              categories: ['financial'],
            }),
          ],
        }),
      ),
    ).toEqual(['tier:currency_unknown']);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('KWD')).toBe(3);
    expect(
      codes(doc({ fields: [field({ value_type: 'array', allowed_values: undefined })] })),
    ).toEqual(['tier:item_type_required']);
  });

  it('consequential uses need a confirmation; promotion and canonical-to-canonical relationships are refused', () => {
    expect(codes(doc({ fields: [field({ allowed_uses: ['eligibility'] })] }))).toEqual([
      'tier:unconfirmed_consequential_use',
    ]);
    expect(
      codes(
        doc({
          fields: [
            field({
              allowed_uses: ['eligibility'],
              confirmation: { by: 'ops', note: 'Reviewed with sales operations' },
            }),
          ],
        }),
      ),
    ).toEqual([]);
    expect(codes(doc({ fields: [field({ status: 'promoted' })] }))).toEqual([
      'tier:promotion_not_supported',
    ]);
    expect(
      codes(
        doc({
          relationships: [
            {
              key: 'a_to_p',
              display_name: 'A',
              description: 'B',
              from: 'account',
              to: 'person',
              cardinality: 'many_to_many',
              sensitivity: 'internal',
              categories: ['commercial'],
            },
          ],
        }),
      ),
    ).toEqual(['a_to_p:canonical_relationship_not_extension']);
  });

  it('one key namespace (Q2), reserved object keys, captured prefix', () => {
    expect(codes(doc({ objects: [project({ key: 'tier' })], fields: [field()] }))).toContain(
      'tier:duplicate_key',
    );
    expect(codes(doc({ objects: [project({ key: 'opportunity' })] }))).toEqual([
      'opportunity:object_key_reserved',
    ]);
    expect(codes(doc({ fields: [field({ key: 'src_sugar_accounts_tier' })] }))).toEqual([
      'src_sugar_accounts_tier:captured_prefix_mismatch',
    ]);
  });

  it('guardrails: 1,000 fields on one target publish; 1,001 are refused (never truncated)', () => {
    const many = (n: number) =>
      doc({
        fields: Array.from({ length: n }, (_, i) =>
          field({ key: `f${i}`, value_type: 'boolean', allowed_values: undefined }),
        ),
      });
    expect(validateExtensionDocument(many(1000)).ok).toBe(true);
    expect(codes(many(1001))).toEqual(['account:extension_guardrail_exceeded']);
    expect(DEFAULT_EXTENSION_GUARDRAILS.maxFieldsPerTarget).toBe(1000);
  });
});

describe('extension cross-version rules (plan §2.5)', () => {
  const stored = (raw: unknown) =>
    entries(raw).map((e) => ({
      key: e.key,
      definition: e.definition,
      sensitivity: e.sensitivity,
      categories: e.categories,
    }));

  it('X2: value type never changes; R-X6: never weaker, no category dropped; tightening is fine', () => {
    const before = stored(doc({ fields: [field()] }));
    expect(
      extensionRuleViolations(
        before,
        entries(doc({ fields: [field({ value_type: 'multi_enum' })] })),
      ),
    ).toEqual([{ rule: 'R-X2', key: 'tier' }]);
    expect(
      extensionRuleViolations(before, entries(doc({ fields: [field({ sensitivity: 'public' })] }))),
    ).toEqual([{ rule: 'R-X6', key: 'tier' }]);
    expect(
      extensionRuleViolations(
        before,
        entries(doc({ fields: [field({ categories: ['operational'] })] })),
      ),
    ).toEqual([{ rule: 'R-X6', key: 'tier' }]);
    const stricter = entries(
      doc({
        fields: [field({ sensitivity: 'restricted', categories: ['commercial', 'financial'] })],
      }),
    );
    expect(extensionRuleViolations(before, stricter)).toEqual([]);
    expect(keysTighteningToRestricted(before, stricter)).toEqual(['tier']);
  });
});

describe('extension vocabulary', () => {
  it('value-history tokens are ext:<key> on extension target kinds only (Q23)', () => {
    expect(isExtensionHistoryField('company', 'ext:tier')).toBe(true);
    expect(isExtensionHistoryField('custom_record', 'ext:code')).toBe(true);
    expect(isExtensionHistoryField('company', 'ext:Tier')).toBe(false);
    expect(isExtensionHistoryField('tenant', 'ext:tier')).toBe(false);
  });

  it('the platform configuration copy of the guardrail specs equals the domain specs', () => {
    expect(EXTENSION_GUARDRAIL_ENV).toEqual(EXTENSION_GUARDRAIL_SPECS);
  });
});
