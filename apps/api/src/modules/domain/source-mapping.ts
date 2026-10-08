import type { ConnectorKind } from './connector-kinds';
import { isAuthoritative, type AuthorityDocument, type AuthorityFact } from './source-authority';
import {
  findSourceField,
  findSourceObject,
  type SourceField,
  type SourceFieldType,
  type SourceSchema,
} from './source-connector';
import {
  MappingDocumentSchema,
  MappingEntitySchema,
  mappingContentHash,
  MAPPING_LIMITS,
  type MappedFieldEntrySchema,
  type MappingDocument,
  type MappingEntity,
  type ObjectMapping,
} from './source-mapping-document';
import {
  validateMappingProfiles,
  type Acknowledgement,
  type ProfileIssue,
  type ProfilingValidationInput,
} from './source-mapping-profiles';
import type { Transforms } from './source-transforms';
import { SubscriptionStateSchema } from './subscription';
import type { z } from 'zod';

export * from './source-mapping-document';
export * from './source-mapping-profiles';

/**
 * Versioned source mapping documents (ADR 0020): how one source connection's
 * objects and fields become canonical observations. Governed configuration,
 * not a language: targets are code catalogue entries, transforms are the
 * closed set, and every consequential choice carries a recorded confirmation.
 */

type ValueType = 'string' | 'email' | 'domain' | 'subscription_state' | 'instant' | 'quantity';

interface CoreTargetSpec {
  readonly entity: MappingEntity;
  readonly kind: 'core';
  readonly valueType: ValueType;
  readonly fact: AuthorityFact;
  /** `explicit: unknown` allowed (the target has an `unknown` value). */
  readonly allowsUnknown: boolean;
  /** Must be mapped or explicitly stated (never defaulted silently). */
  readonly mustBeStated: boolean;
  /** Mapping it from a source field needs a recorded confirmation. */
  readonly consequential: boolean;
}

interface RelationshipTargetSpec {
  readonly entity: MappingEntity;
  readonly kind: 'relationship';
  readonly fact: AuthorityFact;
  readonly to: 'account' | 'product';
  readonly required: boolean;
}

/** The code catalogue of mapping targets. There are no free paths. */
export const MAPPING_TARGETS = {
  'account.name': core('account', 'string', 'account_profile'),
  'account.domain': core('account', 'domain', 'account_profile'),
  'person.email': core('person', 'email', 'person_profile'),
  'person.firstName': core('person', 'string', 'person_profile'),
  'person.lastName': core('person', 'string', 'person_profile'),
  'person.jobTitle': core('person', 'string', 'person_profile'),
  'subscription.state': {
    entity: 'subscription',
    kind: 'core',
    valueType: 'subscription_state',
    fact: 'subscription_state',
    allowsUnknown: true,
    mustBeStated: true,
    consequential: true,
  },
  'subscription.startsAt': {
    entity: 'subscription',
    kind: 'core',
    valueType: 'instant',
    fact: 'subscription_terms',
    allowsUnknown: false,
    mustBeStated: true,
    consequential: true,
  },
  'subscription.endsAt': {
    entity: 'subscription',
    kind: 'core',
    valueType: 'instant',
    fact: 'subscription_terms',
    allowsUnknown: false,
    mustBeStated: true,
    consequential: true,
  },
  'subscription.quantity': core('subscription', 'quantity', 'subscription_lines'),
  'subscription.account': {
    entity: 'subscription',
    kind: 'relationship',
    fact: 'subscription_lines',
    to: 'account',
    required: true,
  },
  'subscription.product': {
    entity: 'subscription',
    kind: 'relationship',
    fact: 'subscription_lines',
    to: 'product',
    required: true,
  },
  'person.primaryCompany': {
    entity: 'person',
    kind: 'relationship',
    fact: 'person_profile',
    to: 'account',
    required: false,
  },
} as const satisfies Record<string, CoreTargetSpec | RelationshipTargetSpec>;

function core(entity: MappingEntity, valueType: ValueType, fact: AuthorityFact): CoreTargetSpec {
  return {
    entity,
    kind: 'core',
    valueType,
    fact,
    allowsUnknown: false,
    mustBeStated: false,
    consequential: false,
  };
}

export type MappingTarget = keyof typeof MAPPING_TARGETS;
export type CoreTarget = {
  [K in MappingTarget]: (typeof MAPPING_TARGETS)[K] extends { kind: 'core' } ? K : never;
}[MappingTarget];
export type RelationshipTarget = Exclude<MappingTarget, CoreTarget>;

export function mappingTargetsFor(entity: MappingEntity): MappingTarget[] {
  return (Object.keys(MAPPING_TARGETS) as MappingTarget[]).filter(
    (t) => MAPPING_TARGETS[t].entity === entity,
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const MAPPING_ERROR_CODES = [
  'invalid_document',
  'document_too_large',
  'identity_missing',
  'identity_unsuitable',
  'invalid_target',
  'invalid_entity',
  'duplicate_entity',
  'duplicate_target',
  'unknown_source_object',
  'unknown_source_field',
  'unsupported_source_type',
  'missing_relationship_target',
  'product_reference_required',
  'required_target_unstated',
  'invalid_enum_map',
  'unconfirmed_consequential_entry',
  'authority_conflict',
  'schema_snapshot_stale',
  'attribute_mappings_not_enabled',
  'holding_filter_unconfirmed',
  'holding_filter_required',
  'holding_filter_not_allowed',
  'invalid_explicit_value',
  // M9A (ADR 0022, 0023): profile-aware publish checks and reviewed holding domains.
  'profile_required',
  'profile_stale',
  'profile_field_excluded',
  'profile_low_coverage',
  'profile_freshness_out_of_range',
  'finding_unacknowledged',
  'acknowledgement_invalid',
  'date_format_required',
  'holding_filter_domain_incomplete',
  'holding_filter_domain_inconsistent',
  'holding_filter_domain_stale',
  'holding_filter_domain_unknown',
  'override_requires_authenticated_operator',
  'override_out_of_scope',
  'override_reason_invalid',
] as const;
export type MappingErrorCode = (typeof MAPPING_ERROR_CODES)[number];
export type MappingWarningCode =
  'field_not_reviewed' | 'enum_option_unmapped' | 'observed_value_unmapped';

export interface MappingIssue {
  readonly code: MappingErrorCode | MappingWarningCode;
  readonly path: string;
  readonly message: string;
}

export interface MappingValidationContext {
  readonly connectionId: string;
  readonly kind: ConnectorKind;
  /** The snapshot the document is validated against … */
  readonly schema: SourceSchema;
  readonly schemaHash: string;
  /** … and the connection's latest snapshot (stale when they differ). */
  readonly latestSchemaHash: string;
  readonly authority: AuthorityDocument;
  /**
   * M9A: the candidate profiles, acknowledgements and override request.
   * Required: there is no publish path that skips the covering-profile rules.
   */
  readonly profiling: ProfilingValidationInput;
}

export type MappingValidation =
  | {
      readonly ok: true;
      readonly document: MappingDocument;
      readonly contentHash: string;
      readonly warnings: readonly MappingIssue[];
      /** The profiles that covered the consequential entries (recorded in `validation`). */
      readonly coveringProfileIds: readonly string[];
      readonly acknowledgements: ReadonlyArray<Acknowledgement & { readonly code: string }>;
    }
  | {
      readonly ok: false;
      readonly errors: readonly MappingIssue[];
      readonly warnings: readonly MappingIssue[];
    };

const NAME_LIKE = /(^|_)(name|title|label|description)(_c)?$/i;

const SOURCE_TYPES: Record<ValueType, readonly SourceFieldType[]> = {
  string: ['string', 'text', 'enum', 'id'],
  email: ['string', 'text'],
  domain: ['string', 'text'],
  subscription_state: ['enum', 'string'],
  instant: ['date', 'datetime', 'string'],
  quantity: ['integer', 'number', 'string'],
};

/** Pure validation of a candidate mapping document (publish-blocking errors). */
export function validateMapping(raw: unknown, ctx: MappingValidationContext): MappingValidation {
  const errors: MappingIssue[] = [];
  const warnings: MappingIssue[] = [];
  const err = (code: MappingErrorCode, path: string, message: string) =>
    errors.push({ code, path, message });
  const warn = (code: MappingWarningCode, path: string, message: string) =>
    warnings.push({ code, path, message });

  if (JSON.stringify(raw ?? null).length > MAPPING_LIMITS.documentBytes) {
    err('document_too_large', '', `document exceeds ${MAPPING_LIMITS.documentBytes} bytes`);
    return { ok: false, errors, warnings };
  }
  const parsed = MappingDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      err('invalid_document', issue.path.join('.'), issue.message);
    }
    return { ok: false, errors, warnings };
  }
  const doc = parsed.data;

  if (ctx.schemaHash !== ctx.latestSchemaHash) {
    err(
      'schema_snapshot_stale',
      '',
      'the document was validated against a snapshot that is not the latest',
    );
  }

  const entities = new Map<string, number>();
  doc.objects.forEach((obj, i) => {
    const at = `objects.${i}`;
    const entity = MappingEntitySchema.safeParse(obj.entity);
    const sourceObject = findSourceObject(ctx.schema, obj.source);
    if (!sourceObject) {
      err('unknown_source_object', `${at}.source`, `object ${obj.source} is not in the snapshot`);
    }
    if (!entity.success) {
      err('invalid_entity', `${at}.entity`, `${obj.entity} is not a mapping entity`);
      return;
    }
    if (entities.has(entity.data)) {
      err('duplicate_entity', `${at}.entity`, `${entity.data} is mapped by more than one object`);
    }
    entities.set(entity.data, i);
    if (sourceObject?.classification === 'internal_principal') {
      err(
        'invalid_entity',
        `${at}.entity`,
        `${obj.source} holds the source's internal users and cannot map to ${entity.data}`,
      );
    }
    if (!sourceObject) return;
    validateObject(obj, entity.data, at);
  });

  // Product references: a reference set only, by id (never name).
  if (doc.productReferences) {
    const pr = doc.productReferences;
    const field = findSourceField(ctx.schema, pr.object, pr.identity.field);
    if (!findSourceObject(ctx.schema, pr.object)) {
      err(
        'unknown_source_object',
        'productReferences.object',
        `${pr.object} is not in the snapshot`,
      );
    } else if (!field) {
      err(
        'unknown_source_field',
        'productReferences.identity.field',
        `${pr.object}.${pr.identity.field} is not in the snapshot`,
      );
    } else if (!identitySuitable(field) || NAME_LIKE.test(field.name)) {
      err(
        'identity_unsuitable',
        'productReferences.identity.field',
        'products are referenced by a unique id field, never a name',
      );
    }
    const ids = new Set<string>();
    pr.ignored.forEach((p, j) => {
      if (ids.has(p.id)) {
        err('duplicate_target', `productReferences.ignored.${j}`, `product ${p.id} listed twice`);
      }
      ids.add(p.id);
    });
  }

  // Profile-aware checks (§7, §10.2) on the structurally valid document.
  const profiles = validateMappingProfiles(doc, ctx.schema, ctx.schemaHash, ctx.profiling);
  for (const issue of profiles.errors) errors.push(asMappingIssue(issue));
  for (const issue of profiles.warnings) warnings.push(asMappingIssue(issue));

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    document: doc,
    contentHash: mappingContentHash(doc),
    warnings,
    coveringProfileIds: profiles.coveringProfileIds,
    acknowledgements: profiles.acknowledgements,
  };

  function validateObject(obj: ObjectMapping, entity: MappingEntity, at: string): void {
    // Identity: exactly one, unique or confirmed, never name-like.
    const idField = findSourceField(ctx.schema, obj.source, obj.identity.field);
    if (!idField) {
      err(
        'identity_missing',
        `${at}.identity.field`,
        `${obj.source}.${obj.identity.field} is not in the snapshot`,
      );
    } else if (NAME_LIKE.test(idField.name)) {
      err('identity_unsuitable', `${at}.identity.field`, 'a name-like field is not an identity');
    } else if (!identitySuitable(idField) && !obj.identity.confirmation) {
      err(
        'identity_unsuitable',
        `${at}.identity.field`,
        'the identity field is neither an id nor unique, and is not confirmed',
      );
    }

    validateHolding(obj, entity, at);

    const stated = new Map<string, string>();
    const reviewed = new Set<string>([obj.identity.field]);
    const claim = (target: string, path: string) => {
      if (stated.has(target)) {
        err('duplicate_target', path, `${target} is written by more than one entry`);
      }
      stated.set(target, path);
    };

    // Relationships.
    obj.relationships.forEach((rel, j) => {
      const path = `${at}.relationships.${j}`;
      const spec = targetSpec(rel.target);
      if (!spec || spec.kind !== 'relationship' || spec.entity !== entity) {
        err('invalid_target', `${path}.target`, `${rel.target} is not a ${entity} relationship`);
        return;
      }
      claim(rel.target, path);
      reviewed.add(rel.field);
      const field = findSourceField(ctx.schema, obj.source, rel.field);
      if (!field) {
        err(
          'unknown_source_field',
          `${path}.field`,
          `${obj.source}.${rel.field} is not in the snapshot`,
        );
      } else if (!['relate', 'id', 'string'].includes(field.type)) {
        err('unsupported_source_type', `${path}.field`, `${field.type} cannot hold a reference`);
      }
      authorityCheck(spec.fact, `${path}.target`, rel.target);
      if (spec.to === 'product') {
        if (!rel.productReference || rel.object) {
          err('invalid_target', path, 'a product relationship is a product reference');
        }
        if (!doc.productReferences) {
          err('product_reference_required', path, 'productReferences must declare the catalogue');
        }
      } else {
        if (!rel.object) {
          err('missing_relationship_target', `${path}.object`, 'the referenced object is required');
        } else {
          const targetObject = doc.objects.find((o) => o.source === rel.object);
          if (!targetObject || targetObject.entity !== spec.to) {
            err(
              'missing_relationship_target',
              `${path}.object`,
              `${rel.object} is not mapped as ${spec.to} with an identity`,
            );
          }
          if (field?.relatesTo && field.relatesTo !== rel.object) {
            err(
              'unsupported_source_type',
              `${path}.field`,
              `${rel.field} relates to ${field.relatesTo}, not ${rel.object}`,
            );
          }
        }
        if (rel.productReference) err('invalid_target', path, 'not a product relationship');
      }
      if (rel.fallbackVia) {
        const fb = rel.fallbackVia;
        if (spec.to !== 'account') {
          err(
            'invalid_target',
            `${path}.fallbackVia`,
            'only account relationships have a fallback',
          );
        }
        if (!findSourceField(ctx.schema, obj.source, fb.field)) {
          err(
            'unknown_source_field',
            `${path}.fallbackVia.field`,
            `${obj.source}.${fb.field} is not in the snapshot`,
          );
        }
        if (!findSourceObject(ctx.schema, fb.object)) {
          err(
            'unknown_source_object',
            `${path}.fallbackVia.object`,
            `${fb.object} is not in the snapshot`,
          );
        } else if (!findSourceField(ctx.schema, fb.object, fb.targetField)) {
          err(
            'unknown_source_field',
            `${path}.fallbackVia.targetField`,
            `${fb.object}.${fb.targetField} is not in the snapshot`,
          );
        }
        if (!fb.confirmation) {
          err(
            'unconfirmed_consequential_entry',
            `${path}.fallbackVia`,
            'a relationship fallback needs a recorded confirmation',
          );
        }
        reviewed.add(fb.field);
      }
    });

    // Field entries.
    obj.fields.forEach((entry, j) => {
      const path = `${at}.fields.${j}`;
      if (entry.kind === 'attribute') {
        err(
          'attribute_mappings_not_enabled',
          path,
          'attribute mappings need the attribute registry',
        );
        return;
      }
      if (entry.kind === 'ignored') {
        if (!findSourceField(ctx.schema, obj.source, entry.source)) {
          err(
            'unknown_source_field',
            `${path}.source`,
            `${obj.source}.${entry.source} is not in the snapshot`,
          );
        }
        reviewed.add(entry.source);
        return;
      }
      const spec = targetSpec(entry.target);
      if (!spec || spec.kind !== 'core' || spec.entity !== entity) {
        err('invalid_target', `${path}.target`, `${entry.target} is not a ${entity} field target`);
        return;
      }
      claim(entry.target, path);
      if ('explicit' in entry) {
        if (entry.explicit === 'unknown' && !spec.allowsUnknown) {
          err('invalid_explicit_value', path, `${entry.target} has no unknown value; state null`);
        }
        if (entry.explicit === 'null' && spec.allowsUnknown) {
          err('invalid_explicit_value', path, `${entry.target} cannot be null; state unknown`);
        }
        return;
      }
      reviewed.add(entry.source);
      const field = findSourceField(ctx.schema, obj.source, entry.source);
      if (!field) {
        err(
          'unknown_source_field',
          `${path}.source`,
          `${obj.source}.${entry.source} is not in the snapshot`,
        );
        return;
      }
      authorityCheck(spec.fact, `${path}.target`, entry.target);
      checkCoreEntry(entry, spec, field, path);
    });

    // Required targets must be mapped or stated.
    for (const target of mappingTargetsFor(entity)) {
      const spec = MAPPING_TARGETS[target];
      const required = spec.kind === 'core' ? spec.mustBeStated : spec.required;
      if (required && !stated.has(target)) {
        err(
          spec.kind === 'relationship' && spec.to === 'product'
            ? 'product_reference_required'
            : 'required_target_unstated',
          at,
          `${target} must be mapped or explicitly stated`,
        );
      }
    }

    const sourceObject = findSourceObject(ctx.schema, obj.source);
    const unreviewed = sourceObject?.fields.filter((f) => !reviewed.has(f.name)).length ?? 0;
    if (unreviewed > 0) warn('field_not_reviewed', at, `${unreviewed} source fields not reviewed`);
  }

  function validateHolding(obj: ObjectMapping, entity: MappingEntity, at: string): void {
    const filter = obj.holdingFilter;
    const all = obj.allRecordsAreHoldings;
    if (entity !== 'subscription') {
      if (filter || all) {
        err('holding_filter_not_allowed', at, 'only subscription objects declare holdings');
      }
      return;
    }
    if (filter && all) {
      err('holding_filter_not_allowed', at, 'declare a holding filter or all-holdings, not both');
    }
    if (filter) {
      const path = `${at}.holdingFilter`;
      const field = findSourceField(ctx.schema, obj.source, filter.field);
      if (!field) {
        err(
          'unknown_source_field',
          `${path}.field`,
          `${obj.source}.${filter.field} is not in the snapshot`,
        );
      } else if (field.type === 'relate') {
        err(
          'unsupported_source_type',
          `${path}.field`,
          'a holding filter tests a value, not a reference',
        );
      } else if (field.enumOptions) {
        const options = new Set(field.enumOptions.map((o) => o.value));
        filter.values.forEach((v, k) => {
          if (!options.has(v)) {
            err(
              'holding_filter_unconfirmed',
              `${path}.values.${k}`,
              'value is not an option of the field',
            );
          }
        });
      }
      if (new Set(filter.values).size !== filter.values.length) {
        err('holding_filter_unconfirmed', `${path}.values`, 'values must be unique');
      }
      if (!filter.confirmation) {
        err(
          'holding_filter_unconfirmed',
          path,
          'a holding filter needs a recorded business confirmation',
        );
      }
    }
    if (all && !all.confirmation) {
      err(
        'holding_filter_unconfirmed',
        `${at}.allRecordsAreHoldings`,
        'the all-holdings declaration needs a recorded business confirmation',
      );
    }
    const confirmed =
      (filter?.confirmation !== undefined && !all) || (all?.confirmation !== undefined && !filter);
    if (isAuthoritative(ctx.authority, 'subscription_lines', ctx.connectionId) && !confirmed) {
      err(
        'holding_filter_required',
        at,
        'the connection is authoritative for subscription_lines: declare a confirmed holding filter or a confirmed all-holdings statement',
      );
    }
  }

  function checkCoreEntry(
    entry: z.infer<typeof MappedFieldEntrySchema>,
    spec: CoreTargetSpec,
    field: SourceField,
    path: string,
  ): void {
    const t: Transforms = entry.transforms ?? {};
    if (!SOURCE_TYPES[spec.valueType].includes(field.type)) {
      err(
        'unsupported_source_type',
        `${path}.source`,
        `${field.type} cannot reach ${entry.target}`,
      );
      return;
    }
    if (spec.consequential && !entry.confirmation) {
      err(
        'unconfirmed_consequential_entry',
        path,
        `${entry.target} from a source field needs a recorded confirmation`,
      );
    }
    switch (spec.valueType) {
      case 'instant':
        if (
          t.parse?.type !== 'date' &&
          t.parse?.type !== 'datetime' &&
          t.parse?.type !== 'timestamp'
        ) {
          err(
            'unsupported_source_type',
            `${path}.transforms.parse`,
            'dates need a date or datetime parse with a declared time zone, or a Unix-seconds timestamp',
          );
        }
        if (t.valueMap)
          err(
            'unsupported_source_type',
            `${path}.transforms.valueMap`,
            'dates are not value-mapped',
          );
        if (
          t.parse?.type === 'date' &&
          t.parse.inclusiveEnd &&
          entry.target !== 'subscription.endsAt'
        ) {
          err(
            'unsupported_source_type',
            `${path}.transforms.parse.inclusiveEnd`,
            'only an end date can be inclusive',
          );
        }
        break;
      case 'quantity':
        if (field.type !== 'integer' && t.parse?.type !== 'integer') {
          err(
            'unsupported_source_type',
            `${path}.transforms.parse`,
            'quantities need an integer parse',
          );
        }
        if (t.valueMap)
          err(
            'unsupported_source_type',
            `${path}.transforms.valueMap`,
            'quantities are not value-mapped',
          );
        break;
      case 'subscription_state': {
        if (!t.valueMap) {
          err(
            'invalid_enum_map',
            `${path}.transforms.valueMap`,
            'a state needs a complete value map',
          );
          break;
        }
        if (t.parse)
          err('unsupported_source_type', `${path}.transforms.parse`, 'states are not parsed');
        Object.entries(t.valueMap.map).forEach(([from, to]) => {
          if (!SubscriptionStateSchema.safeParse(to).success) {
            err(
              'invalid_enum_map',
              `${path}.transforms.valueMap.map.${from}`,
              `${to} is not a subscription state`,
            );
          }
        });
        for (const option of field.enumOptions ?? []) {
          if (!Object.hasOwn(t.valueMap.map, option.value)) {
            if (option.active) {
              err(
                'invalid_enum_map',
                `${path}.transforms.valueMap`,
                `option ${option.value} is not mapped`,
              );
            } else {
              warn(
                'enum_option_unmapped',
                `${path}.transforms.valueMap`,
                `inactive option ${option.value} is not mapped`,
              );
            }
          }
        }
        break;
      }
      default:
        if (t.parse)
          err('unsupported_source_type', `${path}.transforms.parse`, `${entry.target} is text`);
        if (t.valueMap)
          err('unsupported_source_type', `${path}.transforms.valueMap`, `${entry.target} is text`);
    }
  }

  function authorityCheck(fact: AuthorityFact, path: string, target: string): void {
    // Lines are gated at run start (pre-flight); profiles, state and terms here.
    if (fact === 'subscription_lines') return;
    if (!isAuthoritative(ctx.authority, fact, ctx.connectionId)) {
      err(
        'authority_conflict',
        path,
        `${target} writes ${fact}, for which this connection is not the authority`,
      );
    }
  }
}

function asMappingIssue(issue: ProfileIssue): MappingIssue {
  return { code: issue.code, path: issue.path, message: issue.message };
}

function identitySuitable(field: SourceField): boolean {
  return field.type === 'id' || field.unique;
}

function targetSpec(target: string): CoreTargetSpec | RelationshipTargetSpec | undefined {
  return Object.hasOwn(MAPPING_TARGETS, target)
    ? (MAPPING_TARGETS as Record<string, CoreTargetSpec | RelationshipTargetSpec>)[target]
    : undefined;
}

/** The fields a published mapping reads from an object (identity, relationships, mapped fields, filter). */
export function mappedFields(obj: ObjectMapping): string[] {
  const fields = new Set<string>([obj.identity.field]);
  if (obj.holdingFilter) fields.add(obj.holdingFilter.field);
  for (const rel of obj.relationships) {
    fields.add(rel.field);
    if (rel.fallbackVia) fields.add(rel.fallbackVia.field);
  }
  for (const entry of obj.fields) {
    if (entry.kind === 'core' && 'source' in entry) fields.add(entry.source);
  }
  return [...fields].sort();
}

/** True when the object's holdings are confirmed (filter or all-holdings statement). */
export function holdingsConfirmed(obj: ObjectMapping): boolean {
  if (obj.holdingFilter && obj.allRecordsAreHoldings) return false;
  return (
    obj.holdingFilter?.confirmation !== undefined ||
    obj.allRecordsAreHoldings?.confirmation !== undefined
  );
}
