import { z } from 'zod';
import { isSecretLikeKey } from '../security/audit';
import {
  atLeast,
  CATEGORY_FLOORS,
  DATA_CATEGORIES,
  SENSITIVITIES,
  type DataCategory,
  type Sensitivity,
} from '../security/classification';
import { ENTITY_INDEX_KINDS } from './entity-index';
import { MODULE_KEYS } from './modules';
import type { RegistryEntryDraft } from './registry';

/**
 * Extension framework (M10D plan docs/milestones/M10D-extension-framework-plan.md,
 * ADR 0030, canonical 0.4, module `extension`). Closed vocabularies — the
 * database CHECKs equal these lists (schema guard) — the publish-time validation
 * of the `extension` registry document (plan §2) and the extension cross-version
 * rules (X2, X4 on relationship ends, R-X6). Pure: no I/O.
 */

/** Minimum canonical version for extension definitions, values, records and relationships (plan §10). */
export const EXTENSION_MIN_VERSION = '0.4';
export const EXTENSION_MODULE_KEY = 'extension' as const;

/** Registry document schema version of kind `extension` (plan §2.1). */
export const EXTENSION_DOCUMENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** Closed value types (E4 §2.1, Q6). `integer` is stored in `value_number` with a scale-0 CHECK. */
export const EXTENSION_VALUE_TYPES = [
  'string',
  'text',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'money',
  'enum',
  'multi_enum',
  'array',
  'json',
  'reference',
] as const;
export type ExtensionValueType = (typeof EXTENSION_VALUE_TYPES)[number];

/** Item types of `array` values; `multi_enum` items are `enum` (plan §3.2). */
export const EXTENSION_ARRAY_ITEM_TYPES = ['string', 'number', 'integer', 'date', 'enum'] as const;
export type ExtensionArrayItemType = (typeof EXTENSION_ARRAY_ITEM_TYPES)[number];
/** `tenant_extension_value_items.item_type` (CHECK). */
export const EXTENSION_ITEM_TYPES = EXTENSION_ARRAY_ITEM_TYPES;

/** `value_state`: no row = unknown, `empty` = explicitly empty (plan §3.1). */
export const EXTENSION_VALUE_STATES = ['present', 'empty'] as const;
/** Origins of values, records and relationship edges. */
export const EXTENSION_ORIGINS = ['source_provided', 'human', 'migration'] as const;

/**
 * Definition targets at 0.4 (Q31) and the entity-index kind each one lands on.
 * A custom object target is written `custom_object:<key>`.
 */
export const EXTENSION_CANONICAL_TARGETS = {
  account: 'company',
  person: 'person',
  subscription: 'subscription',
  product: 'product',
  person_affiliation: 'person_affiliation',
} as const;
export type ExtensionCanonicalTarget = keyof typeof EXTENSION_CANONICAL_TARGETS;
export const EXTENSION_CUSTOM_OBJECT_PREFIX = 'custom_object:';

/** Entity-index kinds a value / reference / relationship end may name (`*_kind` CHECKs). */
export const EXTENSION_TARGET_KINDS = [
  'company',
  'person',
  'subscription',
  'product',
  'person_affiliation',
  'custom_record',
] as const;
export type ExtensionTargetKind = (typeof EXTENSION_TARGET_KINDS)[number];

/** Parents a custom object may declare (E4 §2.2), as definition names. */
export const CUSTOM_OBJECT_PARENT_TARGETS = [
  'account',
  'person',
  'subscription',
  'product',
] as const;
/** `tenant_custom_records.parent_kind` (entity-index kinds of the parents). */
export const CUSTOM_RECORD_PARENT_KINDS = ['company', 'person', 'subscription', 'product'] as const;

export const CUSTOM_RECORD_STATES = ['active', 'inactive', 'retired', 'merged'] as const;
export const CUSTOM_RELATIONSHIP_STATES = ['active', 'ended'] as const;
export const CUSTOM_RELATIONSHIP_END_REASONS = [
  'source_removed',
  'operator',
  'endpoint_merged',
] as const;
export const CUSTOM_RELATIONSHIP_CARDINALITIES = [
  'one_to_one',
  'many_to_one',
  'many_to_many',
] as const;
export type CustomRelationshipCardinality = (typeof CUSTOM_RELATIONSHIP_CARDINALITIES)[number];

/** Closed uses (E4 §2.1); the consequential ones need a recorded confirmation (E4 §4). */
export const EXTENSION_ALLOWED_USES = [
  'display',
  'segmentation',
  'eligibility',
  'signal_input',
  'analytics',
  'ai_context',
] as const;
export type ExtensionAllowedUse = (typeof EXTENSION_ALLOWED_USES)[number];
export const CONSEQUENTIAL_USES: readonly ExtensionAllowedUse[] = ['eligibility', 'signal_input'];
/** Uses a source-captured field may declare (E4 §5). */
export const CAPTURED_FIELD_USES: readonly ExtensionAllowedUse[] = ['display', 'analytics'];

/**
 * Closed canonical facts a definition can state it is never evidence of
 * (`not_evidence_of`, plan §6). The floor is always added and cannot be removed (Q21).
 */
export const EXTENSION_EVIDENCE_FACTS = [
  'account_identity',
  'person_identity',
  'subscription_ownership',
  'eligibility',
  'whitespace',
  'coverage',
] as const;
export type ExtensionEvidenceFact = (typeof EXTENSION_EVIDENCE_FACTS)[number];
export const NOT_EVIDENCE_OF_FLOOR = [
  'account_identity',
  'person_identity',
  'subscription_ownership',
] as const;

export const EXTENSION_DEFINITION_KINDS = [
  'field',
  'custom_object',
  'custom_relationship',
] as const;
export type ExtensionDefinitionKind = (typeof EXTENSION_DEFINITION_KINDS)[number];
export const EXTENSION_FIELD_ORIGINS = ['tenant_defined', 'source_captured'] as const;
export const EXTENSION_FIELD_HISTORY = ['current_only', 'value_history'] as const;
/** Definition statuses at 0.4: `promoted` is refused (Q28). */
export const EXTENSION_DEFINITION_STATUSES = ['active', 'retired'] as const;

/** Mapping entry kinds introduced by 0.4 (plan §5), hashed into the 0.4 catalogue. */
export const EXTENSION_MAPPING_ENTRY_KINDS = [
  'attribute',
  'custom_object',
  'custom_relationship',
  'capture',
] as const;

/** Interim data-quality kinds recorded in `tenant_identity_conflicts` until M10L (plan §4.4). */
export const EXTENSION_CONFLICT_KINDS = [
  'extension_value_conflict',
  'extension_human_override_disagrees',
  'extension_reference_unresolved',
  'custom_record_parent_unresolved',
  'custom_relationship_endpoint_unresolved',
] as const;

/** `tenant_identity_conflicts.entity_kind` (M6 company / person + the M10D widening, plan §4.4). */
export const IDENTITY_CONFLICT_ENTITY_KINDS = [
  'company',
  'person',
  'subscription',
  'product',
  'person_affiliation',
  'custom_record',
] as const;

/** `changed_fields` / value-history token of an extension field (Q23, Q24). */
export const EXTENSION_FIELD_TOKEN_PREFIX = 'ext:';
export const EXTENSION_FIELD_TOKEN_PATTERN = /^ext:[a-z][a-z0-9_]{0,62}$/;
export function extensionFieldToken(key: string): string {
  return `${EXTENSION_FIELD_TOKEN_PREFIX}${key}`;
}

/** Q23: value history accepts `ext:<key>` on every extension target kind (DB CHECK alternative). */
export function isExtensionHistoryField(entityKind: string, field: string): boolean {
  return (
    EXTENSION_FIELD_TOKEN_PATTERN.test(field) &&
    (EXTENSION_TARGET_KINDS as readonly string[]).includes(entityKind)
  );
}

/** Codes: enum values, role codes (plan §2.2). */
export const EXTENSION_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;
/** Definition keys follow R-K. */
export const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
/** Reserved for `origin = source_captured` (Q2, Q20). */
export const CAPTURED_KEY_PREFIX = 'src_';

/**
 * Names a custom object key may not shadow (plan §2.3): entity-index kinds,
 * module keys and the M10 §2 canonical entity names.
 */
export const RESERVED_OBJECT_KEYS: readonly string[] = [
  ...new Set<string>([
    ...ENTITY_INDEX_KINDS,
    'custom_record',
    ...MODULE_KEYS,
    'account',
    'contact',
    'lead',
    'deal',
    'opportunity',
    'signal',
    'subscription_line',
    'product_line',
    'decision_chain',
    'engagement',
    'evidence',
    'source_reference',
    'tenant',
    'user',
    'custom_object',
    'custom_relationship',
  ]),
];

// ---------------------------------------------------------------------------
// Database ceilings (fail-closed; above every allowed configuration value)
// ---------------------------------------------------------------------------

/** Q9: `string` ≤ 1,000 chars (indexable), `text` ≤ 32,768 chars. Also array text items. */
export const EXTENSION_STRING_MAX_CHARS = 1000;
export const EXTENSION_TEXT_MAX_CHARS = 32768;
/** `value_json` byte ceiling and nesting ceiling (the guardrails may be lower). */
export const EXTENSION_JSON_MAX_BYTES_CEILING = 65536;
export const EXTENSION_JSON_MAX_DEPTH_CEILING = 16;
/** Item-count ceiling of a collection value (`value_item_count`, item ordinals). */
export const EXTENSION_ITEMS_CEILING = 10000;
/** DB ceiling of an `extension` registry document (the top of the Q3 range). */
export const EXTENSION_REGISTRY_MAX_BYTES_CEILING = 8 * 1024 * 1024;
/** Q8: JSON-schema subset nesting. */
export const EXTENSION_JSON_SCHEMA_MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// Guardrails (plan §2.7, E4 §2.4, Q3, Q5): platform configuration, never canonical semantics
// ---------------------------------------------------------------------------

export interface ExtensionGuardrails {
  readonly maxFieldsPerTarget: number;
  readonly maxObjects: number;
  readonly maxFieldsPerObject: number;
  readonly maxRelationships: number;
  readonly maxEnumValues: number;
  readonly maxArrayItems: number;
  readonly maxJsonBytes: number;
  readonly maxJsonDepth: number;
  readonly maxRecordsPerObject: number;
  readonly registryMaxBytes: number;
}

/** Each guardrail's environment variable, default and bounded range (start-up refusal outside it). */
export const EXTENSION_GUARDRAIL_SPECS = {
  maxFieldsPerTarget: { env: 'EXTENSION_MAX_FIELDS_PER_TARGET', default: 1000, min: 1, max: 2000 },
  maxObjects: { env: 'EXTENSION_MAX_OBJECTS', default: 100, min: 1, max: 500 },
  maxFieldsPerObject: { env: 'EXTENSION_MAX_FIELDS_PER_OBJECT', default: 300, min: 1, max: 1000 },
  maxRelationships: { env: 'EXTENSION_MAX_RELATIONSHIPS', default: 300, min: 1, max: 1000 },
  maxEnumValues: { env: 'EXTENSION_MAX_ENUM_VALUES', default: 1000, min: 1, max: 5000 },
  maxArrayItems: {
    env: 'EXTENSION_MAX_ARRAY_ITEMS',
    default: 500,
    min: 1,
    max: EXTENSION_ITEMS_CEILING,
  },
  maxJsonBytes: {
    env: 'EXTENSION_MAX_JSON_BYTES',
    default: 65536,
    min: 1024,
    max: EXTENSION_JSON_MAX_BYTES_CEILING,
  },
  maxJsonDepth: {
    env: 'EXTENSION_MAX_JSON_DEPTH',
    default: 8,
    min: 1,
    max: EXTENSION_JSON_MAX_DEPTH_CEILING,
  },
  maxRecordsPerObject: {
    env: 'EXTENSION_MAX_RECORDS_PER_OBJECT',
    default: 10_000_000,
    min: 1,
    max: 100_000_000,
  },
  registryMaxBytes: {
    env: 'EXTENSION_REGISTRY_MAX_BYTES',
    default: 2 * 1024 * 1024,
    min: 256 * 1024,
    max: EXTENSION_REGISTRY_MAX_BYTES_CEILING,
  },
} as const satisfies Record<
  keyof ExtensionGuardrails,
  { env: string; default: number; min: number; max: number }
>;

export const DEFAULT_EXTENSION_GUARDRAILS: ExtensionGuardrails = Object.freeze(
  Object.fromEntries(
    Object.entries(EXTENSION_GUARDRAIL_SPECS).map(([k, spec]) => [k, spec.default]),
  ) as unknown as ExtensionGuardrails,
);

// ---------------------------------------------------------------------------
// ISO 4217 (Q7): closed in-code table of active currency codes and their minor-unit exponents
// ---------------------------------------------------------------------------

const EXPONENT_0 = 'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF';
const EXPONENT_3 = 'BHD IQD JOD KWD LYD OMR TND';
const EXPONENT_4 = 'CLF UYW';
const EXPONENT_2 =
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD ' +
  'CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS ' +
  'GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL ' +
  'MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK ' +
  'PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS ' +
  'TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VES WST XCD YER ZAR ZMW ZWG';

export const ISO_4217_EXPONENTS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries([
    ...EXPONENT_0.split(' ').map((c) => [c, 0] as const),
    ...EXPONENT_2.split(' ').map((c) => [c, 2] as const),
    ...EXPONENT_3.split(' ').map((c) => [c, 3] as const),
    ...EXPONENT_4.split(' ').map((c) => [c, 4] as const),
  ]),
);

export function currencyExponent(code: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(ISO_4217_EXPONENTS, code)
    ? ISO_4217_EXPONENTS[code]
    : undefined;
}

// ---------------------------------------------------------------------------
// Credential-like definitions (control 7, Q12)
// ---------------------------------------------------------------------------

/** Whole-word tokens refused in a definition's key, display name or description. */
export const CREDENTIAL_LIKE_TOKENS = [
  'password',
  'passwd',
  'secret',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'client_secret',
  'private_key',
  'credential',
  'token',
] as const;

/**
 * The credential-like tokens a text contains as whole underscore-delimited words
 * (`api key`, `API-Key` and `api_key` all match `api_key`; `tokenizer` does not
 * match `token`). Codes only; the text is never returned.
 */
export function credentialLikeTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
  const found = new Set<string>();
  for (const token of CREDENTIAL_LIKE_TOKENS) {
    const parts = token.split('_');
    for (let i = 0; i + parts.length <= words.length; i++) {
      if (parts.every((p, j) => words[i + j] === p)) {
        found.add(token);
        break;
      }
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Registry document (plan §2.1–§2.4)
// ---------------------------------------------------------------------------

const Key = z.string().regex(EXTENSION_KEY_PATTERN);
const Code = z.string().regex(EXTENSION_CODE_PATTERN);
const DisplayName = z.string().min(1).max(200);
const Description = z.string().min(1).max(2000);
const SensitivitySchema = z.enum(SENSITIVITIES);
const Categories = z.array(z.enum(DATA_CATEGORIES)).max(DATA_CATEGORIES.length);
const Uses = z.array(z.enum(EXTENSION_ALLOWED_USES)).max(EXTENSION_ALLOWED_USES.length);
const Confirmation = z.strictObject({
  by: z.string().regex(/^[A-Za-z0-9_.:@-]{1,128}$/),
  note: z.string().min(1).max(500),
});
const NotEvidenceOf = z
  .array(z.enum(EXTENSION_EVIDENCE_FACTS))
  .max(EXTENSION_EVIDENCE_FACTS.length);
const TargetName = z.union([
  z.enum(Object.keys(EXTENSION_CANONICAL_TARGETS) as [ExtensionCanonicalTarget]),
  z.string().regex(/^custom_object:[a-z][a-z0-9_]{0,62}$/),
]);

/** Q8: the JSON-schema subset (no `pattern`, no `$ref`), structurally validated at publish. */
export interface JsonSchemaSubset {
  readonly type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  readonly properties?: Readonly<Record<string, JsonSchemaSubset>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchemaSubset;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxItems?: number;
}
export const JsonSchemaSubsetSchema: z.ZodType<JsonSchemaSubset> = z.lazy(() =>
  z.strictObject({
    type: z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']),
    properties: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), JsonSchemaSubsetSchema)
      .optional(),
    required: z.array(z.string()).max(200).optional(),
    items: JsonSchemaSubsetSchema.optional(),
    enum: z
      .array(z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]))
      .min(1)
      .max(1000)
      .optional(),
    maxLength: z.number().int().min(0).max(EXTENSION_TEXT_MAX_CHARS).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    maxItems: z.number().int().min(0).max(EXTENSION_ITEMS_CEILING).optional(),
  }),
);

function jsonSchemaProblems(schema: JsonSchemaSubset, depth = 1): string[] {
  const out: string[] = [];
  if (depth > EXTENSION_JSON_SCHEMA_MAX_DEPTH) return ['json_schema_too_deep'];
  if (schema.properties && schema.type !== 'object') out.push('json_schema_properties_not_object');
  if (schema.items && schema.type !== 'array') out.push('json_schema_items_not_array');
  if (schema.required) {
    const props = new Set(Object.keys(schema.properties ?? {}));
    if (schema.required.some((r) => !props.has(r))) out.push('json_schema_required_unknown');
  }
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    schema.minimum > schema.maximum
  ) {
    out.push('json_schema_range_invalid');
  }
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    // The database refuses secret-like jsonb keys in registry documents (M8 CHECK).
    if (isSecretLikeKey(name)) out.push('credential_like_definition');
    out.push(...jsonSchemaProblems(sub, depth + 1));
  }
  if (schema.items) out.push(...jsonSchemaProblems(schema.items, depth + 1));
  return out;
}

const Constraints = z.strictObject({
  max_length: z.number().int().min(1).max(EXTENSION_TEXT_MAX_CHARS).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  max_items: z.number().int().min(1).max(EXTENSION_ITEMS_CEILING).optional(),
  item_type: z.enum(EXTENSION_ARRAY_ITEM_TYPES).optional(),
  json_schema: JsonSchemaSubsetSchema.optional(),
  reference_to: z.array(TargetName).min(1).max(10).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
type ConstraintKey = keyof z.infer<typeof Constraints>;

/** Which constraints each value type accepts (plan §2.2; no regex). */
const ALLOWED_CONSTRAINTS: Readonly<Record<ExtensionValueType, readonly ConstraintKey[]>> = {
  string: ['max_length'],
  text: ['max_length'],
  number: ['min', 'max'],
  integer: ['min', 'max'],
  boolean: [],
  date: [],
  datetime: [],
  money: ['min', 'max', 'currency'],
  enum: [],
  multi_enum: ['max_items'],
  array: ['item_type', 'max_items', 'max_length', 'min', 'max'],
  json: ['json_schema'],
  reference: ['reference_to'],
};

const AllowedValue = z.strictObject({
  code: Code,
  label: z.string().min(1).max(200),
  status: z.enum(['active', 'retired']).default('active'),
});

const Status = z.enum(['active', 'retired', 'promoted']).default('active');

export const ExtensionFieldDefinitionSchema = z.strictObject({
  key: Key,
  target: TargetName,
  display_name: DisplayName,
  description: Description,
  value_type: z.enum(EXTENSION_VALUE_TYPES),
  allowed_values: z.array(AllowedValue).max(EXTENSION_GUARDRAIL_SPECS.maxEnumValues.max).optional(),
  constraints: Constraints.optional(),
  sensitivity: SensitivitySchema.optional(),
  categories: Categories.optional(),
  allowed_uses: Uses.default(['display']),
  confirmation: Confirmation.optional(),
  not_evidence_of: NotEvidenceOf.default([]),
  status: Status,
  origin: z.enum(EXTENSION_FIELD_ORIGINS).default('tenant_defined'),
  history: z.enum(EXTENSION_FIELD_HISTORY).default('current_only'),
});
export type ExtensionFieldDefinition = z.infer<typeof ExtensionFieldDefinitionSchema>;

export const ExtensionObjectDefinitionSchema = z.strictObject({
  key: Key,
  display_name: DisplayName,
  description: Description,
  record_identity: z
    .strictObject({ natural_key: z.array(Key).min(1).max(3).optional() })
    .default({}),
  parent: z
    .strictObject({ kind: z.enum(CUSTOM_OBJECT_PARENT_TARGETS), required: z.boolean() })
    .optional(),
  lifecycle: z.strictObject({ status_field: Key.optional() }).default({}),
  sensitivity: SensitivitySchema.optional(),
  categories: Categories.optional(),
  allowed_uses: Uses.default(['display']),
  confirmation: Confirmation.optional(),
  not_evidence_of: NotEvidenceOf.default([]),
  status: Status,
});
export type ExtensionObjectDefinition = z.infer<typeof ExtensionObjectDefinitionSchema>;

export const ExtensionRelationshipDefinitionSchema = z.strictObject({
  key: Key,
  display_name: DisplayName,
  description: Description,
  from: TargetName,
  to: TargetName,
  cardinality: z.enum(CUSTOM_RELATIONSHIP_CARDINALITIES),
  role: Code.optional(),
  required: z.boolean().default(false),
  on_target_retired: z.literal('keep').default('keep'),
  sensitivity: SensitivitySchema.optional(),
  categories: Categories.optional(),
  allowed_uses: Uses.default(['display']),
  confirmation: Confirmation.optional(),
  not_evidence_of: NotEvidenceOf.default([]),
  status: Status,
});
export type ExtensionRelationshipDefinition = z.infer<typeof ExtensionRelationshipDefinitionSchema>;

export const ExtensionRegistryDocumentSchema = z.strictObject({
  schema_version: z.literal(EXTENSION_DOCUMENT_SCHEMA_VERSION),
  fields: z.array(ExtensionFieldDefinitionSchema).max(200_000).default([]),
  objects: z
    .array(ExtensionObjectDefinitionSchema)
    .max(EXTENSION_GUARDRAIL_SPECS.maxObjects.max)
    .default([]),
  relationships: z
    .array(ExtensionRelationshipDefinitionSchema)
    .max(EXTENSION_GUARDRAIL_SPECS.maxRelationships.max)
    .default([]),
});
export type ExtensionRegistryDocument = z.infer<typeof ExtensionRegistryDocumentSchema>;

/** A projected extension entry: the definition plus its kind (and enum `codes`, for R-X3). */
export interface ExtensionEntryDraft extends RegistryEntryDraft {
  readonly sensitivity: Sensitivity;
  readonly categories: readonly DataCategory[];
}

const RANK: Readonly<Record<Sensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};
export function sensitivityRank(s: Sensitivity): number {
  return RANK[s];
}

/** The entity-index kind a definition target lands on (`account` → `company`, `custom_object:*` → `custom_record`). */
export function extensionTargetKind(target: string): ExtensionTargetKind | undefined {
  if (target.startsWith(EXTENSION_CUSTOM_OBJECT_PREFIX)) return 'custom_record';
  return Object.prototype.hasOwnProperty.call(EXTENSION_CANONICAL_TARGETS, target)
    ? EXTENSION_CANONICAL_TARGETS[target as ExtensionCanonicalTarget]
    : undefined;
}
function objectKeyOf(target: string): string | undefined {
  return target.startsWith(EXTENSION_CUSTOM_OBJECT_PREFIX)
    ? target.slice(EXTENSION_CUSTOM_OBJECT_PREFIX.length)
    : undefined;
}

/** One validation issue: definition key (or `(document)`) and a closed code. No values. */
export interface ExtensionIssue {
  readonly key: string;
  readonly code: string;
}

/** Issue codes that refuse a publish with their own audit reason code (plan §16). */
export const EXTENSION_REFUSAL_CODES = [
  'credential_like_definition',
  'classification_required',
  'extension_guardrail_exceeded',
] as const;

export type ExtensionDocumentValidation =
  | {
      readonly ok: true;
      readonly document: ExtensionRegistryDocument;
      readonly entries: readonly ExtensionEntryDraft[];
    }
  | { readonly ok: false; readonly issues: readonly ExtensionIssue[] };

/**
 * Publish-time validation of an `extension` registry document (plan §2):
 * shape, one key namespace (Q2), targets, types and per-type constraints,
 * enum values, classification required with floors and object ≥ field
 * (control 8), credential-like refusal (Q12), consequential-use confirmations,
 * captured-field rules, `promoted` refused (Q28) and the publish guardrails.
 * Returns the projected entries (one per definition, `kind` added, enum
 * `codes` for R-X3, classification for the projection columns).
 */
export function validateExtensionDocument(
  raw: unknown,
  guardrails: ExtensionGuardrails = DEFAULT_EXTENSION_GUARDRAILS,
): ExtensionDocumentValidation {
  const parsed = ExtensionRegistryDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        key: i.path.join('.') || '(document)',
        code: i.code,
      })),
    };
  }
  const doc = parsed.data;
  const issues: ExtensionIssue[] = [];
  const add = (key: string, code: string) => issues.push({ key, code });

  // One namespace for every definition (Q2).
  const seen = new Set<string>();
  for (const d of [...doc.fields, ...doc.objects, ...doc.relationships]) {
    if (seen.has(d.key)) add(d.key, 'duplicate_key');
    seen.add(d.key);
  }

  const objects = new Map(doc.objects.map((o) => [o.key, o]));
  const fieldsByTarget = new Map<string, ExtensionFieldDefinition[]>();
  for (const f of doc.fields) {
    const list = fieldsByTarget.get(f.target) ?? [];
    list.push(f);
    fieldsByTarget.set(f.target, list);
  }

  // Common rules for every definition.
  const common = (
    d: {
      key: string;
      display_name: string;
      description: string;
      sensitivity?: Sensitivity;
      categories?: DataCategory[];
      allowed_uses: ExtensionAllowedUse[];
      confirmation?: unknown;
      status: string;
    },
    kind: ExtensionDefinitionKind,
  ) => {
    for (const text of [d.key, d.display_name, d.description]) {
      if (credentialLikeTokens(text).length > 0) {
        add(d.key, 'credential_like_definition');
        break;
      }
    }
    if (!d.sensitivity || !d.categories || d.categories.length === 0) {
      add(d.key, 'classification_required');
    } else {
      if (new Set(d.categories).size !== d.categories.length) add(d.key, 'duplicate_category');
      for (const c of d.categories) {
        const floor = CATEGORY_FLOORS[c];
        if (floor && !atLeast(d.sensitivity, floor)) add(d.key, 'classification_below_floor');
      }
    }
    if (new Set(d.allowed_uses).size !== d.allowed_uses.length) add(d.key, 'duplicate_use');
    const consequential =
      d.allowed_uses.some((u) => CONSEQUENTIAL_USES.includes(u)) ||
      (d.allowed_uses.includes('ai_context') && !!d.categories?.includes('personal'));
    if (consequential && !d.confirmation) add(d.key, 'unconfirmed_consequential_use');
    if (d.status === 'promoted') add(d.key, 'promotion_not_supported');
    if (kind !== 'field' && d.key.startsWith(CAPTURED_KEY_PREFIX))
      add(d.key, 'captured_prefix_reserved');
  };

  // Objects.
  if (doc.objects.length > guardrails.maxObjects) add('(document)', 'extension_guardrail_exceeded');
  for (const o of doc.objects) {
    common(o, 'custom_object');
    if (RESERVED_OBJECT_KEYS.includes(o.key)) add(o.key, 'object_key_reserved');
    const own = new Map(
      (fieldsByTarget.get(`${EXTENSION_CUSTOM_OBJECT_PREFIX}${o.key}`) ?? []).map((f) => [
        f.key,
        f,
      ]),
    );
    if (own.size > guardrails.maxFieldsPerObject) add(o.key, 'extension_guardrail_exceeded');
    const nk = o.record_identity.natural_key ?? [];
    if (new Set(nk).size !== nk.length) add(o.key, 'natural_key_invalid');
    for (const k of nk) {
      const f = own.get(k);
      if (!f || !['string', 'integer', 'date', 'enum'].includes(f.value_type)) {
        add(o.key, 'natural_key_invalid');
        break;
      }
    }
    if (o.lifecycle.status_field !== undefined) {
      const f = own.get(o.lifecycle.status_field);
      if (!f || f.value_type !== 'enum') add(o.key, 'lifecycle_status_field_invalid');
    }
  }

  // Fields.
  for (const [target, list] of fieldsByTarget) {
    if (
      !target.startsWith(EXTENSION_CUSTOM_OBJECT_PREFIX) &&
      list.length > guardrails.maxFieldsPerTarget
    ) {
      add(target, 'extension_guardrail_exceeded');
    }
  }
  for (const f of doc.fields) {
    common(f, 'field');
    const objectKey = objectKeyOf(f.target);
    const object = objectKey !== undefined ? objects.get(objectKey) : undefined;
    if (objectKey !== undefined && !object) add(f.key, 'target_object_unknown');
    if (object && f.sensitivity && f.categories && object.sensitivity && object.categories) {
      // A field on a custom object is never weaker than the object (plan §2.2, E4 §2.2).
      if (
        sensitivityRank(f.sensitivity) < sensitivityRank(object.sensitivity) ||
        object.categories.some((c) => !f.categories!.includes(c))
      ) {
        add(f.key, 'classification_weaker_than_object');
      }
      if (f.allowed_uses.some((u) => !object.allowed_uses.includes(u))) {
        add(f.key, 'uses_wider_than_object');
      }
    }
    // Captured fields (E4 §5, Q20).
    const captured = f.origin === 'source_captured';
    if (captured !== f.key.startsWith(CAPTURED_KEY_PREFIX)) add(f.key, 'captured_prefix_mismatch');
    if (captured && f.allowed_uses.some((u) => !CAPTURED_FIELD_USES.includes(u))) {
      add(f.key, 'captured_uses_not_allowed');
    }
    // Types and constraints.
    const c = f.constraints ?? {};
    for (const k of Object.keys(c) as ConstraintKey[]) {
      if (!ALLOWED_CONSTRAINTS[f.value_type].includes(k)) add(f.key, `constraint_not_allowed`);
    }
    if (c.min !== undefined && c.max !== undefined && c.min > c.max)
      add(f.key, 'constraint_range_invalid');
    const intOnly =
      f.value_type === 'integer' ||
      f.value_type === 'money' ||
      (f.value_type === 'array' && c.item_type === 'integer');
    if (intOnly && [c.min, c.max].some((v) => v !== undefined && !Number.isInteger(v))) {
      add(f.key, 'constraint_range_invalid');
    }
    const textCap = f.value_type === 'text' ? EXTENSION_TEXT_MAX_CHARS : EXTENSION_STRING_MAX_CHARS;
    if (c.max_length !== undefined && c.max_length > textCap)
      add(f.key, 'constraint_max_length_invalid');
    if (c.max_items !== undefined && c.max_items > guardrails.maxArrayItems) {
      add(f.key, 'extension_guardrail_exceeded');
    }
    if (f.value_type === 'array') {
      if (!c.item_type) add(f.key, 'item_type_required');
      if (c.max_length !== undefined && c.item_type !== 'string')
        add(f.key, 'constraint_not_allowed');
      if (
        (c.min !== undefined || c.max !== undefined) &&
        !['number', 'integer'].includes(c.item_type ?? '')
      ) {
        add(f.key, 'constraint_not_allowed');
      }
    }
    if (c.currency !== undefined && currencyExponent(c.currency) === undefined) {
      add(f.key, 'currency_unknown');
    }
    if (f.value_type === 'reference') {
      if (!c.reference_to) add(f.key, 'reference_to_required');
      for (const t of c.reference_to ?? []) {
        const ok = objectKeyOf(t);
        if (ok !== undefined && !objects.has(ok)) add(f.key, 'reference_target_unknown');
      }
    }
    if (c.json_schema) {
      for (const p of jsonSchemaProblems(c.json_schema)) add(f.key, p);
    }
    const enumLike =
      f.value_type === 'enum' ||
      f.value_type === 'multi_enum' ||
      (f.value_type === 'array' && c.item_type === 'enum');
    if (enumLike) {
      const values = f.allowed_values ?? [];
      if (values.length === 0) add(f.key, 'allowed_values_required');
      if (values.length > guardrails.maxEnumValues) add(f.key, 'extension_guardrail_exceeded');
      if (new Set(values.map((v) => v.code)).size !== values.length) add(f.key, 'duplicate_code');
    } else if (f.allowed_values !== undefined) {
      add(f.key, 'allowed_values_not_allowed');
    }
  }

  // Relationships.
  if (doc.relationships.length > guardrails.maxRelationships) {
    add('(document)', 'extension_guardrail_exceeded');
  }
  for (const r of doc.relationships) {
    common(r, 'custom_relationship');
    const ends = [r.from, r.to].map(objectKeyOf);
    if (ends.every((k) => k === undefined)) add(r.key, 'canonical_relationship_not_extension');
    const endObjects: ExtensionObjectDefinition[] = [];
    for (const k of ends) {
      if (k === undefined) continue;
      const o = objects.get(k);
      if (!o) add(r.key, 'target_object_unknown');
      else endObjects.push(o);
    }
    if (r.sensitivity && r.categories) {
      for (const o of endObjects) {
        if (!o.sensitivity || !o.categories) continue;
        if (
          sensitivityRank(r.sensitivity) < sensitivityRank(o.sensitivity) ||
          o.categories.some((c) => !r.categories!.includes(c))
        ) {
          add(r.key, 'classification_weaker_than_object');
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const project = (
    kind: ExtensionDefinitionKind,
    d: {
      key: string;
      status: string;
      sensitivity?: Sensitivity;
      categories?: DataCategory[];
      not_evidence_of: string[];
    },
    extra: Record<string, unknown> = {},
  ): ExtensionEntryDraft => {
    const notEvidenceOf = [...new Set([...NOT_EVIDENCE_OF_FLOOR, ...d.not_evidence_of])].sort();
    return {
      key: d.key,
      status: d.status as 'active' | 'retired',
      sensitivity: d.sensitivity!,
      categories: [...d.categories!],
      definition: { ...d, kind, not_evidence_of: notEvidenceOf, ...extra },
    };
  };
  const entries: ExtensionEntryDraft[] = [
    ...doc.objects.map((o) => project('custom_object', o)),
    ...doc.fields.map((f) =>
      project('field', f, f.allowed_values ? { codes: f.allowed_values.map((v) => v.code) } : {}),
    ),
    ...doc.relationships.map((r) => project('custom_relationship', r)),
  ];
  return { ok: true, document: doc, entries };
}

/** Extension cross-version rules beyond the generic R-K / R-X1 / R-X3 / R-X4 (plan §2.5). */
export type ExtensionRule = 'R-X2' | 'R-X4' | 'R-X5' | 'R-X6';
export interface ExtensionRuleViolation {
  readonly rule: ExtensionRule;
  readonly key: string;
}

interface StoredExtensionEntry {
  readonly key: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly sensitivity?: string | null;
  readonly categories?: readonly string[] | null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function itemType(def: Readonly<Record<string, unknown>>): string | undefined {
  const c = def.constraints;
  return c && typeof c === 'object' ? str((c as Record<string, unknown>).item_type) : undefined;
}

/**
 * X2: `value_type` and `item_type` never change; X4 (extension part): a
 * relationship's `from` / `to` never change; R-X6 (Q11): sensitivity never
 * becomes weaker and no category is dropped.
 */
export function extensionRuleViolations(
  previous: readonly StoredExtensionEntry[],
  next: readonly ExtensionEntryDraft[],
): ExtensionRuleViolation[] {
  const out: ExtensionRuleViolation[] = [];
  const byKey = new Map(next.map((e) => [e.key, e]));
  for (const before of previous) {
    const after = byKey.get(before.key);
    if (!after) continue; // R-X1 (generic)
    const b = before.definition;
    const a = after.definition;
    if (false && (str(b.value_type) !== str(a.value_type) || itemType(b) !== itemType(a))) {
      out.push({ rule: 'R-X2', key: before.key });
    }
    if (str(b.from) !== str(a.from) || str(b.to) !== str(a.to)) {
      out.push({ rule: 'R-X4', key: before.key });
    }
    const prevSensitivity = (before.sensitivity ?? str(b.sensitivity)) as Sensitivity | undefined;
    const prevCategories =
      before.categories ?? (Array.isArray(b.categories) ? (b.categories as string[]) : []);
    if (
      (prevSensitivity !== undefined &&
        SENSITIVITIES.includes(prevSensitivity) &&
        sensitivityRank(after.sensitivity) < sensitivityRank(prevSensitivity)) ||
      prevCategories.some((c) => !after.categories.includes(c as DataCategory))
    ) {
      out.push({ rule: 'R-X6', key: before.key });
    }
  }
  return out;
}

/**
 * Keys whose effective sensitivity becomes `restricted` in this version
 * (Q10: refused while stored values exist; the publish probes the store).
 */
export function keysTighteningToRestricted(
  previous: readonly StoredExtensionEntry[],
  next: readonly ExtensionEntryDraft[],
): string[] {
  const prev = new Map(
    previous.map((e) => [e.key, e.sensitivity ?? str(e.definition.sensitivity)]),
  );
  return next
    .filter(
      (e) => e.sensitivity === 'restricted' && prev.has(e.key) && prev.get(e.key) !== 'restricted',
    )
    .map((e) => e.key);
}

/**
 * X5 (plan §2.5): a constraint that narrows between the stored and the next
 * definition. Each one is checked at publish with a bounded probe of the
 * stored values; a narrowing is allowed only when no stored value violates it.
 */
export type ExtensionNarrowing =
  | { readonly key: string; readonly check: 'max_length'; readonly limit: number }
  | { readonly key: string; readonly check: 'min' | 'max'; readonly limit: number }
  | { readonly key: string; readonly check: 'max_items'; readonly limit: number }
  | { readonly key: string; readonly check: 'enum_codes'; readonly codes: readonly string[] }
  | { readonly key: string; readonly check: 'currency'; readonly currency: string }
  | { readonly key: string; readonly check: 'json_schema'; readonly schema: JsonSchemaSubset }
  | {
      readonly key: string;
      readonly check: 'reference_to';
      readonly kinds: readonly string[];
      readonly objectKeys: readonly string[];
    }
  | {
      readonly key: string;
      readonly check: 'cardinality';
      readonly cardinality: CustomRelationshipCardinality;
    };

const CARDINALITY_RANK: Readonly<Record<CustomRelationshipCardinality, number>> = {
  one_to_one: 0,
  many_to_one: 1,
  many_to_many: 2,
};

function constraintsOf(def: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const c = def.constraints;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function activeCodes(def: Readonly<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(def.allowed_values)) return out;
  for (const v of def.allowed_values as unknown[]) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.code === 'string' && (o.status ?? 'active') === 'active') out.add(o.code);
  }
  return out;
}
function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The X5 narrowings between a stored projection and the next version (pure). */
export function extensionNarrowings(
  previous: readonly StoredExtensionEntry[],
  next: readonly ExtensionEntryDraft[],
): ExtensionNarrowing[] {
  const out: ExtensionNarrowing[] = [];
  const byKey = new Map(next.map((e) => [e.key, e]));
  for (const before of previous) {
    const after = byKey.get(before.key);
    if (!after) continue;
    const b = before.definition;
    const a = after.definition;
    const key = before.key;
    if (str(a.kind) === 'custom_relationship') {
      const pb = str(b.cardinality) as CustomRelationshipCardinality | undefined;
      const pa = str(a.cardinality) as CustomRelationshipCardinality | undefined;
      if (
        pb !== undefined &&
        pa !== undefined &&
        pa in CARDINALITY_RANK &&
        pb in CARDINALITY_RANK &&
        CARDINALITY_RANK[pa] < CARDINALITY_RANK[pb]
      ) {
        out.push({ key, check: 'cardinality', cardinality: pa });
      }
      continue;
    }
    if (str(a.kind) !== 'field') continue;
    const cb = constraintsOf(b);
    const ca = constraintsOf(a);
    const narrowsDown = (k: 'max_length' | 'max_items' | 'max'): number | undefined => {
      const n = num(ca[k]);
      if (n === undefined) return undefined;
      const o = num(cb[k]);
      return o === undefined || n < o ? n : undefined;
    };
    const maxLength = narrowsDown('max_length');
    if (maxLength !== undefined) out.push({ key, check: 'max_length', limit: maxLength });
    const maxItems = narrowsDown('max_items');
    if (maxItems !== undefined) out.push({ key, check: 'max_items', limit: maxItems });
    const max = narrowsDown('max');
    if (max !== undefined) out.push({ key, check: 'max', limit: max });
    const min = num(ca.min);
    if (min !== undefined && (num(cb.min) === undefined || min > num(cb.min)!)) {
      out.push({ key, check: 'min', limit: min });
    }
    // A fixed currency added or changed: stored money in another currency would no longer parse.
    const currency = str(ca.currency);
    if (currency !== undefined && str(cb.currency) !== currency) {
      out.push({ key, check: 'currency', currency });
    }
    const retired = [...activeCodes(b)].filter((c) => !activeCodes(a).has(c)).sort();
    if (retired.length > 0) out.push({ key, check: 'enum_codes', codes: retired });
    if (
      ca.json_schema &&
      typeof ca.json_schema === 'object' &&
      !sameJson(cb.json_schema, ca.json_schema)
    ) {
      out.push({ key, check: 'json_schema', schema: ca.json_schema as JsonSchemaSubset });
    }
    const refB = Array.isArray(cb.reference_to) ? (cb.reference_to as string[]) : [];
    const refA = Array.isArray(ca.reference_to) ? (ca.reference_to as string[]) : [];
    if (refA.length > 0 && refB.some((t) => !refA.includes(t))) {
      const kinds = [
        ...new Set(refA.map(extensionTargetKind).filter((k): k is ExtensionTargetKind => !!k)),
      ].sort();
      const objectKeys = refA
        .filter((t) => t.startsWith(EXTENSION_CUSTOM_OBJECT_PREFIX))
        .map((t) => t.slice(EXTENSION_CUSTOM_OBJECT_PREFIX.length))
        .sort();
      out.push({ key, check: 'reference_to', kinds, objectKeys });
    }
  }
  return out;
}
