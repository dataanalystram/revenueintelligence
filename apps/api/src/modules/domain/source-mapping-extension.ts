import { capturedFieldKey } from './canonical/extension-use';
import { CAPTURED_FIELD_USES, EXTENSION_CUSTOM_OBJECT_PREFIX } from './canonical/extension';
import type {
  AttributeEntry,
  CaptureEntry,
  MappingDocument,
  ObjectMapping,
  RelationshipEntry,
} from './source-mapping-document';
import type { SourceField, SourceSchema } from './source-connector';

/**
 * M10D (plan §5): validation of the extension mapping entry kinds —
 * `attribute`, `custom_object` objects, `custom_relationship` relationships
 * and `capture` — against the tenant's current published extension registry.
 * Pure; the caller (`validateMapping`) reports the issues it returns.
 */

/** One published extension definition, as mapping validation reads it. */
export interface ExtensionMappingDefinition {
  readonly kind: 'field' | 'custom_object' | 'custom_relationship';
  readonly status: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly sensitivity: string;
  readonly categories: readonly string[];
}

export interface ExtensionMappingContext {
  /** Adopted ≥ 0.4 and module `extension` enabled; otherwise why not. */
  readonly gate: 'ok' | 'canonical_version_too_low' | 'module_disabled';
  /** The current published extension registry, by key. */
  readonly definitions: ReadonlyMap<string, ExtensionMappingDefinition>;
  /** Custom object key → the connection whose published mapping maps it (Q14). */
  readonly objectOwners: ReadonlyMap<string, string>;
}

export interface ExtensionMappingIssue {
  readonly code:
    | 'attribute_mappings_not_enabled'
    | 'extension_field_unknown'
    | 'extension_target_mismatch'
    | 'invalid_target'
    | 'invalid_entity'
    | 'unknown_source_field'
    | 'unsupported_source_type'
    | 'invalid_enum_map'
    | 'unconfirmed_consequential_entry'
    | 'attribute_classification_below_profile'
    | 'custom_object_owned_by_other_connection'
    | 'capture_field_not_published'
    | 'capture_sensitive_refused'
    | 'missing_relationship_target'
    | 'holding_filter_not_allowed'
    | 'duplicate_target';
  readonly path: string;
  readonly message: string;
}

/** Profile sensitivity per `object.field` (M9A), when a covering profile exists. */
export type ProfileSensitivityLookup = (object: string, field: string) => string | undefined;

const CUSTOM_RELATIONSHIP_PREFIX = 'custom_relationship:';

export function isCustomObjectEntity(entity: string): boolean {
  return /^custom_object:[a-z][a-z0-9_]{0,62}$/.test(entity);
}
export function isCustomRelationshipTarget(target: string): boolean {
  return target.startsWith(CUSTOM_RELATIONSHIP_PREFIX);
}

/** True when the document uses any M10D entry kind (its `canonical_version_min` is 0.4). */
export function usesExtensionKinds(doc: {
  readonly objects: readonly {
    readonly entity?: string;
    readonly customObject?: unknown;
    readonly fields: readonly { readonly kind: string }[];
    readonly relationships: readonly { readonly target: string }[];
  }[];
}): boolean {
  return doc.objects.some(
    (o) =>
      isCustomObjectEntity(o.entity ?? '') ||
      o.customObject !== undefined ||
      o.fields.some((f) => f.kind === 'attribute' || f.kind === 'capture') ||
      o.relationships.some((r) => isCustomRelationshipTarget(r.target)),
  );
}

/** The definition target an object mapping's entity writes to (`account`, `person`, `subscription`, `custom_object:x`). */
function entityTarget(entity: string): string {
  return entity;
}

const COMPATIBLE: Readonly<Record<string, readonly string[]>> = {
  string: ['string', 'text', 'enum', 'id', 'relate', 'number', 'integer'],
  text: ['string', 'text', 'enum', 'id', 'other'],
  number: ['number', 'integer', 'string'],
  integer: ['integer', 'number', 'string'],
  boolean: ['boolean', 'string'],
  date: ['date', 'datetime', 'string'],
  datetime: ['datetime', 'date', 'string'],
  money: ['number', 'integer', 'string'],
  enum: ['enum', 'string'],
  multi_enum: ['enum', 'string', 'text'],
  array: ['string', 'text', 'enum'],
  json: ['text', 'string', 'other'],
  reference: ['relate', 'id', 'string'],
};

/**
 * Validates every extension entry of a structurally valid document. `fieldOf`
 * resolves a source field in the snapshot.
 */
export function validateExtensionMapping(
  doc: MappingDocument,
  ctx: {
    readonly connectionId: string;
    readonly connectionKind: string;
    readonly schema: SourceSchema;
    readonly extension: ExtensionMappingContext | undefined;
    readonly profileSensitivity: ProfileSensitivityLookup;
    readonly isSensitiveName: (field: string) => boolean;
  },
  fieldOf: (object: string, field: string) => SourceField | undefined,
): ExtensionMappingIssue[] {
  const issues: ExtensionMappingIssue[] = [];
  const add = (code: ExtensionMappingIssue['code'], path: string, message: string) =>
    issues.push({ code, path, message });
  if (!usesExtensionKinds(doc)) return issues;
  const ext = ctx.extension;
  if (!ext || ext.gate !== 'ok') {
    add(
      'attribute_mappings_not_enabled',
      '',
      ext?.gate === 'module_disabled'
        ? 'extension mapping entries need module extension enabled'
        : 'extension mapping entries need canonical 0.4 (attribute registry)',
    );
    return issues;
  }
  const def = (key: string, kind: ExtensionMappingDefinition['kind']) => {
    const d = ext.definitions.get(key);
    return d && d.kind === kind ? d : undefined;
  };

  const customEntities = new Set<string>();
  doc.objects.forEach((obj, i) => {
    const at = `objects.${i}`;
    const custom = isCustomObjectEntity(obj.entity);
    if (custom) {
      const key = obj.entity.slice(EXTENSION_CUSTOM_OBJECT_PREFIX.length);
      const object = def(key, 'custom_object');
      if (!object || object.status !== 'active') {
        add('invalid_entity', `${at}.entity`, `${obj.entity} is not an active custom object`);
        return;
      }
      if (customEntities.has(obj.entity)) {
        add('duplicate_target', `${at}.entity`, `${obj.entity} is mapped by more than one object`);
      }
      customEntities.add(obj.entity);
      const owner = ext.objectOwners.get(key);
      if (owner !== undefined && owner !== ctx.connectionId) {
        add(
          'custom_object_owned_by_other_connection',
          `${at}.entity`,
          `${obj.entity} is written by another connection's published mapping (Q14)`,
        );
      }
      if (obj.holdingFilter || obj.allRecordsAreHoldings) {
        add('holding_filter_not_allowed', at, 'custom objects carry no holdings');
      }
      validateCustomObjectOptions(obj, object, at);
    } else if (obj.customObject) {
      add(
        'invalid_target',
        `${at}.customObject`,
        'only custom_object entities have record options',
      );
    }
    const claimed = new Set<string>();
    obj.fields.forEach((entry, j) => {
      const path = `${at}.fields.${j}`;
      if (entry.kind === 'attribute') validateAttribute(obj, entry, path, claimed);
      else if (entry.kind === 'capture') validateCapture(obj, entry, path, claimed);
    });
    obj.relationships.forEach((rel, j) => {
      if (isCustomRelationshipTarget(rel.target)) {
        validateRelationship(obj, rel, `${at}.relationships.${j}`);
      }
    });
  });
  return issues;

  function validateCustomObjectOptions(
    obj: ObjectMapping,
    object: ExtensionMappingDefinition,
    at: string,
  ): void {
    const parentDecl = object.definition.parent as
      { kind?: string; required?: boolean } | undefined;
    const opts = obj.customObject;
    if (opts?.parent) {
      if (!parentDecl) {
        add('invalid_target', `${at}.customObject.parent`, 'the custom object declares no parent');
      } else if (parentDecl.kind === 'product') {
        add(
          'invalid_target',
          `${at}.customObject.parent`,
          'product parents are operator-entered in 0.4',
        );
      } else {
        if (!fieldOf(obj.source, opts.parent.field)) {
          add(
            'unknown_source_field',
            `${at}.customObject.parent.field`,
            `${obj.source}.${opts.parent.field} is not in the snapshot`,
          );
        }
        const target = doc.objects.find((o) => o.source === opts.parent!.object);
        if (!target || target.entity !== parentDecl.kind) {
          add(
            'missing_relationship_target',
            `${at}.customObject.parent.object`,
            `${opts.parent.object} is not mapped as ${parentDecl.kind}`,
          );
        }
      }
    } else if (parentDecl?.required) {
      add(
        'missing_relationship_target',
        `${at}.customObject`,
        'the custom object requires a parent mapping',
      );
    }
    if (opts?.recordState && !fieldOf(obj.source, opts.recordState.field)) {
      add(
        'unknown_source_field',
        `${at}.customObject.recordState.field`,
        `${obj.source}.${opts.recordState.field} is not in the snapshot`,
      );
    }
  }

  function validateAttribute(
    obj: ObjectMapping,
    entry: AttributeEntry,
    path: string,
    claimed: Set<string>,
  ): void {
    const field = def(entry.field, 'field');
    if (!field || field.status !== 'active') {
      add(
        'extension_field_unknown',
        `${path}.field`,
        `${entry.field} is not an active extension field`,
      );
      return;
    }
    if (field.definition.target !== entityTarget(obj.entity)) {
      add(
        'extension_target_mismatch',
        `${path}.field`,
        `${entry.field} does not extend ${obj.entity}`,
      );
      return;
    }
    if (field.definition.origin === 'source_captured') {
      add('invalid_target', `${path}.field`, 'captured fields are mapped with a capture entry');
    }
    if (claimed.has(entry.field))
      add('duplicate_target', path, `${entry.field} is written by more than one entry`);
    claimed.add(entry.field);
    const src = fieldOf(obj.source, entry.source);
    if (!src) {
      add(
        'unknown_source_field',
        `${path}.source`,
        `${obj.source}.${entry.source} is not in the snapshot`,
      );
      return;
    }
    const valueType = String(field.definition.value_type);
    const compatible = COMPATIBLE[valueType] ?? [];
    if (!compatible.includes(src.type) && !entry.transforms?.parse) {
      add('unsupported_source_type', `${path}.source`, `${src.type} cannot hold ${valueType}`);
    }
    if (valueType === 'enum' || valueType === 'multi_enum') {
      const codes = new Set(
        ((field.definition.allowed_values as { code: string; status?: string }[] | undefined) ?? [])
          .filter((v) => (v.status ?? 'active') === 'active')
          .map((v) => v.code),
      );
      const map = entry.transforms?.valueMap?.map;
      if (!map)
        add(
          'invalid_enum_map',
          `${path}.transforms`,
          `${valueType} attributes need a valueMap into the allowed codes`,
        );
      else if (Object.values(map).some((code) => !codes.has(code))) {
        add(
          'invalid_enum_map',
          `${path}.transforms.valueMap`,
          'every mapped value must be an active allowed code',
        );
      }
    }
    const uses = (field.definition.allowed_uses as string[] | undefined) ?? [];
    const consequential =
      uses.includes('eligibility') ||
      uses.includes('signal_input') ||
      (uses.includes('ai_context') && field.categories.includes('personal'));
    if (consequential && !entry.confirmation) {
      add(
        'unconfirmed_consequential_entry',
        path,
        `${entry.field} has a consequential use and needs a recorded confirmation`,
      );
    }
    const profiled = ctx.profileSensitivity(obj.source, entry.source);
    if (
      profiled === 'sensitive_by_value' &&
      !['confidential', 'restricted'].includes(field.sensitivity)
    ) {
      add(
        'attribute_classification_below_profile',
        path,
        `${obj.source}.${entry.source} is profiled sensitive_by_value; ${entry.field} is below confidential`,
      );
    }
  }

  function validateCapture(
    obj: ObjectMapping,
    entry: CaptureEntry,
    path: string,
    claimed: Set<string>,
  ): void {
    const src = fieldOf(obj.source, entry.source);
    if (!src) {
      add(
        'unknown_source_field',
        `${path}.source`,
        `${obj.source}.${entry.source} is not in the snapshot`,
      );
      return;
    }
    const profiled = ctx.profileSensitivity(obj.source, entry.source);
    if (
      profiled === 'sensitive_by_name' ||
      profiled === 'sensitive_by_value' ||
      (profiled === undefined && ctx.isSensitiveName(entry.source))
    ) {
      // E4 §5: a sensitive source field is never captured (never stored).
      add(
        'capture_sensitive_refused',
        path,
        `${obj.source}.${entry.source} is sensitive and cannot be captured`,
      );
      return;
    }
    const key = capturedFieldKey(ctx.connectionKind, obj.source, entry.source);
    const field = def(key, 'field');
    if (
      !field ||
      field.status !== 'active' ||
      field.definition.origin !== 'source_captured' ||
      field.definition.target !== entityTarget(obj.entity)
    ) {
      add('capture_field_not_published', path, `publish ${key} first (extension capture-draft)`);
      return;
    }
    const uses = (field.definition.allowed_uses as string[] | undefined) ?? [];
    if (uses.some((u) => !CAPTURED_FIELD_USES.includes(u as never))) {
      add('capture_field_not_published', path, `${key} must be limited to display / analytics`);
    }
    if (claimed.has(key)) add('duplicate_target', path, `${key} is written by more than one entry`);
    claimed.add(key);
  }

  function validateRelationship(obj: ObjectMapping, rel: RelationshipEntry, path: string): void {
    const key = rel.target.slice(CUSTOM_RELATIONSHIP_PREFIX.length);
    const r = def(key, 'custom_relationship');
    if (!r || r.status !== 'active') {
      add('invalid_target', `${path}.target`, `${rel.target} is not an active custom relationship`);
      return;
    }
    if (r.definition.from !== entityTarget(obj.entity)) {
      add(
        'invalid_target',
        `${path}.target`,
        `${rel.target} is mapped on its from object (${String(r.definition.from)})`,
      );
    }
    if (!fieldOf(obj.source, rel.field)) {
      add(
        'unknown_source_field',
        `${path}.field`,
        `${obj.source}.${rel.field} is not in the snapshot`,
      );
    }
    const to = doc.objects.find((o) => o.source === rel.object);
    if (!rel.object || !to || to.entity !== r.definition.to) {
      add(
        'missing_relationship_target',
        `${path}.object`,
        `the object must be mapped as ${String(r.definition.to)}`,
      );
    }
    // Q14: relationships follow their custom objects' owner.
    for (const end of [r.definition.from, r.definition.to]) {
      if (typeof end !== 'string' || !end.startsWith(EXTENSION_CUSTOM_OBJECT_PREFIX)) continue;
      const owner = ext!.objectOwners.get(end.slice(EXTENSION_CUSTOM_OBJECT_PREFIX.length));
      const mappedHere = doc.objects.some((o) => o.entity === end);
      if (
        (owner !== undefined && owner !== ctx.connectionId) ||
        (owner === undefined && !mappedHere)
      ) {
        add(
          'custom_object_owned_by_other_connection',
          `${path}.target`,
          `${end} is not written by this connection`,
        );
      }
    }
    if (rel.role) {
      const declared = typeof r.definition.role === 'string' ? r.definition.role : undefined;
      if (!fieldOf(obj.source, rel.role.field)) {
        add(
          'unknown_source_field',
          `${path}.role.field`,
          `${obj.source}.${rel.role.field} is not in the snapshot`,
        );
      }
      if (!declared || Object.values(rel.role.valueMap).some((c) => c !== declared)) {
        add(
          'invalid_enum_map',
          `${path}.role.valueMap`,
          'a role maps only into the definition role code',
        );
      }
    }
    if (rel.productReference || rel.fallbackVia || rel.affiliation) {
      add(
        'invalid_target',
        path,
        'custom relationships have no product reference, fallback or affiliation',
      );
    }
  }
}
