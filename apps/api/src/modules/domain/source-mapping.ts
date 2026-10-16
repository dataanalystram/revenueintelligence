import { EXTENSION_MIN_VERSION } from './canonical/extension';
import {
  ACCOUNT_CONTEXT_MAPPING_MIN_VERSION,
  accountContextFields,
  isAccountContextEntity,
  usesAccountContextMapping,
  validateAccountContextMapping,
  type AccountContextMappingContext,
} from './source-mapping-account-context';
import { jsonbTextBytes } from './canonical/json-size';
import {
  COMMERCIAL_MAPPING_MIN_VERSION,
  commercialFields,
  isCommercialEntity,
  isCommercialLineTarget,
  usesCommercialMapping,
  validateCommercialMapping,
  type CommercialMappingContext,
} from './source-mapping-commercial';
import { isSensitiveName } from './profiling/privacy';
import {
  isCustomObjectEntity,
  isCustomRelationshipTarget,
  usesExtensionKinds,
  validateExtensionMapping,
  type ExtensionMappingContext,
} from './source-mapping-extension';
import { compareCanonicalVersion } from './canonical/versions';
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
  profiledSensitivity,
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
export * from './source-mapping-extension';
export * from './source-mapping-account-context';
export * from './source-mapping-commercial';

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
  readonly to:
    'account' | 'product' | 'account_context' | 'contract' | 'price_offer' | 'subscription';
  readonly required: boolean;
  /** M10C: mapping it needs a recorded confirmation (`account.parent`). */
  readonly consequential?: boolean;
  /** M10C: the minimum adopted canonical version for a mapping that uses it. */
  readonly minCanonicalVersion?: string;
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
  // M10C (ADR 0029, canonical 0.3): the account's parent, a consequential,
  // human-confirmed choice written under the `account_hierarchy` authority.
  'account.parent': {
    entity: 'account',
    kind: 'relationship',
    fact: 'account_hierarchy',
    to: 'account',
    required: false,
    consequential: true,
    minCanonicalVersion: '0.3',
  },
  // M10C (Q5): a further person–account affiliation, a person_profile fact.
  'person.affiliation': {
    entity: 'person',
    kind: 'relationship',
    fact: 'person_profile',
    to: 'account',
    required: false,
    minCanonicalVersion: '0.3',
  },
  // M10E (plan §5.2, canonical 0.5): the line's account context, a source id of
  // an object mapped as `account_context`, written under the `account_context` authority.
  'subscription.contextRef': {
    entity: 'subscription',
    kind: 'relationship',
    fact: 'account_context',
    to: 'account_context',
    required: false,
    minCanonicalVersion: '0.5',
  },
  // M10F (plan §6.2, canonical 0.6): the line's agreement header (Core, Q2; a
  // confirmed agreement_header statement, Q4), its price offer and its
  // predecessor line. All three follow `subscription_lines` (Q24); the
  // referenced objects are checked by validateCommercialMapping.
  'subscription.agreement': {
    entity: 'subscription',
    kind: 'relationship',
    fact: 'subscription_lines',
    to: 'contract',
    required: false,
    minCanonicalVersion: '0.6',
  },
  'subscription.priceOfferRef': {
    entity: 'subscription',
    kind: 'relationship',
    fact: 'subscription_lines',
    to: 'price_offer',
    required: false,
    minCanonicalVersion: '0.6',
  },
  'subscription.supersedesRef': {
    entity: 'subscription',
    kind: 'relationship',
    fact: 'subscription_lines',
    to: 'subscription',
    required: false,
    minCanonicalVersion: '0.6',
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
  // M10D (plan §5): extension entry kinds.
  'extension_field_unknown',
  'extension_target_mismatch',
  'attribute_classification_below_profile',
  'custom_object_owned_by_other_connection',
  'capture_field_not_published',
  'capture_sensitive_refused',
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
  // M10E (plan §5): account-context statements.
  'account_context_mappings_not_enabled',
  'context_type_unknown',
  'context_dimension_unknown',
  'context_dimension_required',
  'context_role_unknown',
  // M10F (plan §6): commercial statements.
  'commercial_mappings_not_enabled',
  'agreement_ref_deal_grouping',
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
  /**
   * M10D: the 0.4 + module gate, the current published extension registry and
   * the custom-object owners. Absent = extension entries are refused
   * `attribute_mappings_not_enabled`.
   */
  readonly extension?: ExtensionMappingContext;
  /**
   * M10E: the 0.5 + module gate and the published context types. Absent =
   * account-context statements are refused `account_context_mappings_not_enabled`.
   */
  readonly accountContext?: AccountContextMappingContext;
  /**
   * M10F: the 0.6 + module gate. Absent = commercial statements are refused
   * `commercial_mappings_not_enabled`.
   */
  readonly commercial?: CommercialMappingContext;
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

  if (jsonbTextBytes(raw ?? null) > MAPPING_LIMITS.documentBytes) {
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
    if (isCustomObjectEntity(obj.entity)) {
      // M10D (plan §5.2): the extension rules are checked below.
      if (sourceObject?.classification === 'internal_principal') {
        err('invalid_entity', `${at}.entity`, `${obj.source} holds the source's internal users`);
      }
      if (sourceObject) validateCustomObject(obj, at);
      return;
    }
    if (isAccountContextEntity(obj.entity) || isCommercialEntity(obj.entity)) {
      // M10E (plan §5.1) / M10F (plan §6.1): the account-context and commercial rules are checked below.
      if (sourceObject?.classification === 'internal_principal') {
        err('invalid_entity', `${at}.entity`, `${obj.source} holds the source's internal users`);
      }
      return;
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

  // M10D (plan §5): extension entry kinds against the published extension registry.
  for (const issue of validateExtensionMapping(
    doc,
    {
      connectionId: ctx.connectionId,
      connectionKind: ctx.kind,
      schema: ctx.schema,
      extension: ctx.extension,
      profileSensitivity: (object, field) =>
        profiledSensitivity(ctx.schema, ctx.profiling.profiles, object, field),
      isSensitiveName,
    },
    (object, field) => findSourceField(ctx.schema, object, field),
  )) {
    err(issue.code, issue.path, issue.message);
  }

  // M10E (plan §5): account-context objects and the line's context reference.
  for (const issue of validateAccountContextMapping(doc, {
    connectionId: ctx.connectionId,
    schema: ctx.schema,
    authority: ctx.authority,
    ...(ctx.accountContext ? { accountContext: ctx.accountContext } : {}),
  })) {
    err(issue.code, issue.path, issue.message);
  }

  // M10F (plan §6): commercial objects and the line commercial references.
  for (const issue of validateCommercialMapping(doc, {
    connectionId: ctx.connectionId,
    schema: ctx.schema,
    authority: ctx.authority,
    ...(ctx.commercial ? { commercial: ctx.commercial } : {}),
  })) {
    err(issue.code, issue.path, issue.message);
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

  /** M10D: identity and plain entries of a `custom_object:<key>` object (extension rules: above). */
  function validateCustomObject(obj: ObjectMapping, at: string): void {
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
    obj.fields.forEach((entry, j) => {
      const path = `${at}.fields.${j}`;
      if (entry.kind === 'core') {
        err('invalid_target', `${path}.target`, 'custom objects have no core targets');
      } else if (
        entry.kind === 'ignored' &&
        !findSourceField(ctx.schema, obj.source, entry.source)
      ) {
        err(
          'unknown_source_field',
          `${path}.source`,
          `${obj.source}.${entry.source} is not in the snapshot`,
        );
      }
    });
    obj.relationships.forEach((rel, j) => {
      if (!isCustomRelationshipTarget(rel.target)) {
        err(
          'invalid_target',
          `${at}.relationships.${j}.target`,
          'custom objects carry custom relationships only',
        );
      }
    });
  }

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
      if (isCustomRelationshipTarget(rel.target)) {
        // M10D: validated against the extension registry (validateExtensionMapping).
        reviewed.add(rel.field);
        if (rel.role) reviewed.add(rel.role.field);
        return;
      }
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
          // M10F: the commercial line targets' objects are checked by validateCommercialMapping.
          if (
            !isCommercialLineTarget(rel.target) &&
            (!targetObject || targetObject.entity !== spec.to)
          ) {
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
      if (spec.consequential && (!rel.confirmation || 'semantics' in rel.confirmation)) {
        err('unconfirmed_consequential_entry', path, `${rel.target} needs a recorded confirmation`);
      }
      if (rel.affiliation) {
        if (rel.target !== 'person.affiliation') {
          err(
            'invalid_target',
            `${path}.affiliation`,
            'only person.affiliation has affiliation fields',
          );
        } else {
          const a = rel.affiliation;
          for (const [key, name] of [
            ['roleField', a.roleField],
            ['startsAtField', a.startsAtField],
            ['endsAtField', a.endsAtField],
          ] as const) {
            if (name === undefined) continue;
            reviewed.add(name);
            if (!findSourceField(ctx.schema, obj.source, name)) {
              err(
                'unknown_source_field',
                `${path}.affiliation.${key}`,
                `${obj.source}.${name} is not in the snapshot`,
              );
            }
          }
          if ((a.roleField === undefined) !== (a.roleValueMap === undefined)) {
            err(
              'invalid_target',
              `${path}.affiliation`,
              'a role field needs an explicit value map (and a value map a role field)',
            );
          }
        }
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
      if (entry.kind === 'attribute' || entry.kind === 'capture') {
        // M10D: validated against the extension registry (validateExtensionMapping).
        reviewed.add(entry.source);
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
    for (const f of [
      rel.affiliation?.roleField,
      rel.affiliation?.startsAtField,
      rel.affiliation?.endsAtField,
    ]) {
      if (f) fields.add(f);
    }
  }
  for (const entry of obj.fields) {
    if (entry.kind === 'core' && 'source' in entry) fields.add(entry.source);
    // M10D: attribute and capture entries read their source field.
    if (entry.kind === 'attribute' || entry.kind === 'capture') fields.add(entry.source);
  }
  for (const rel of obj.relationships) if (rel.role) fields.add(rel.role.field);
  if (obj.customObject?.parent) fields.add(obj.customObject.parent.field);
  if (obj.customObject?.recordState) fields.add(obj.customObject.recordState.field);
  // M10E: the account-context statements read their source fields.
  for (const f of accountContextFields(obj)) fields.add(f);
  // M10F: the commercial blocks read their source fields.
  for (const f of commercialFields(obj)) fields.add(f);
  return [...fields].sort();
}

/**
 * M10C (plan §7): the minimum adopted canonical version a mapping document
 * needs — the highest `minCanonicalVersion` of the targets it uses, else
 * undefined (no requirement beyond the M8–M10B baseline).
 */
export function mappingMinCanonicalVersion(doc: {
  readonly objects: readonly (Pick<ObjectMapping, 'relationships' | 'fields'> &
    Partial<
      Pick<
        ObjectMapping,
        'entity' | 'customObject' | 'accountContext' | 'priceOffer' | 'contract' | 'entitlement'
      >
    >)[];
}): string | undefined {
  let min: string | undefined;
  // M10D (plan §5.5): any extension entry kind needs canonical 0.4.
  if (usesExtensionKinds(doc)) min = EXTENSION_MIN_VERSION;
  // M10E (plan §5): account-context statements need canonical 0.5.
  if (usesAccountContextMapping(doc)) min = ACCOUNT_CONTEXT_MAPPING_MIN_VERSION;
  // M10F (plan §6): commercial statements need canonical 0.6.
  if (usesCommercialMapping(doc)) min = COMMERCIAL_MAPPING_MIN_VERSION;
  for (const obj of doc.objects) {
    const targets = [
      ...obj.relationships.map((r) => r.target),
      ...obj.fields.flatMap((f) =>
        'target' in f && typeof f.target === 'string' ? [f.target] : [],
      ),
    ];
    for (const t of targets) {
      const spec = targetSpec(t);
      const v = spec && 'minCanonicalVersion' in spec ? spec.minCanonicalVersion : undefined;
      if (v && (min === undefined || compareCanonicalVersion(v, min) > 0)) min = v;
    }
  }
  return min;
}

/** True when the object's holdings are confirmed (filter or all-holdings statement). */
export function holdingsConfirmed(obj: ObjectMapping): boolean {
  if (obj.holdingFilter && obj.allRecordsAreHoldings) return false;
  return (
    obj.holdingFilter?.confirmation !== undefined ||
    obj.allRecordsAreHoldings?.confirmation !== undefined
  );
}
