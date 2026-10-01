import {
  EmailAddressSchema,
  ExternalCompanySnapshotSchema,
  ExternalFieldDefinitionSchema,
  ExternalLeadSnapshotSchema,
  ExternalPersonSnapshotSchema,
  type AssociationCategorySchema,
  type ExternalAssociationType,
  type ExternalCompanySnapshot,
  type ExternalFieldDefinition,
  type ExternalLeadSnapshot,
  type ExternalPersonSnapshot,
} from '../../domain';
import type { z } from 'zod';
import type { HsAssociationTypeSchema, HsObject, HsPropertyDefinition } from './schemas';

/**
 * Translation from HubSpot payloads (already validated at the boundary) into
 * vendor-neutral read models. Only HubSpot's own default properties are named
 * here; customer-specific fields stay in `attributes` and are interpreted by
 * tenant field mappings (Milestone 9). The discovery report checks that these
 * default properties exist in the connected account.
 */
export const HUBSPOT_DEFAULT_PROPERTIES = {
  contacts: ['email', 'firstname', 'lastname', 'jobtitle'],
  companies: ['name', 'domain'],
  leads: [],
} as const satisfies Record<HubSpotObjectType, readonly string[]>;

export const HUBSPOT_OBJECT_TYPES = ['contacts', 'companies', 'leads'] as const;
export type HubSpotObjectType = (typeof HUBSPOT_OBJECT_TYPES)[number];

export interface SnapshotFor {
  contacts: ExternalPersonSnapshot;
  companies: ExternalCompanySnapshot;
  leads: ExternalLeadSnapshot;
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function meta(objectType: HubSpotObjectType, o: HsObject) {
  return {
    ref: { system: 'hubspot' as const, objectType, id: o.id },
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    archived: o.archived,
    attributes: o.properties,
  };
}

const toSnapshot: { [K in HubSpotObjectType]: (o: HsObject) => SnapshotFor[K] } = {
  contacts: (o) => {
    const email = EmailAddressSchema.safeParse(text(o.properties.email));
    return ExternalPersonSnapshotSchema.parse({
      ...meta('contacts', o),
      email: email.success ? email.data : undefined,
      firstName: text(o.properties.firstname),
      lastName: text(o.properties.lastname),
      jobTitle: text(o.properties.jobtitle),
    });
  },
  companies: (o) =>
    ExternalCompanySnapshotSchema.parse({
      ...meta('companies', o),
      name: text(o.properties.name),
      domain: text(o.properties.domain)?.toLowerCase(),
    }),
  leads: (o) => ExternalLeadSnapshotSchema.parse(meta('leads', o)),
};

export function toRecordSnapshot<K extends HubSpotObjectType>(
  objectType: K,
  o: HsObject,
): SnapshotFor[K] {
  return toSnapshot[objectType](o);
}

export function toFieldDefinition(
  objectType: string,
  p: HsPropertyDefinition,
): ExternalFieldDefinition {
  return ExternalFieldDefinitionSchema.parse({
    system: 'hubspot',
    objectType,
    name: p.name,
    label: p.label,
    type: p.type,
    fieldType: p.fieldType,
    group: p.groupName,
    options: p.options.map((o) => ({ value: o.value, label: o.label, hidden: o.hidden })),
    vendorDefined: p.hubspotDefined === true,
    readOnlyValue: p.modificationMetadata?.readOnlyValue,
    archived: p.archived,
  });
}

/**
 * HubSpot-defined association types that mean "primary": contact→company 1
 * (reverse 2) and the Lead primary contact/company types 578/580 (reverse
 * 579/581), as seen live on the test account (M3) and listed by HubSpot.
 */
const PRIMARY_ASSOCIATION_TYPE_IDS: ReadonlySet<number> = new Set([1, 2, 578, 579, 580, 581]);

const CATEGORY: Readonly<Record<string, z.infer<typeof AssociationCategorySchema>>> = {
  HUBSPOT_DEFINED: 'standard',
  USER_DEFINED: 'user_defined',
  INTEGRATOR_DEFINED: 'integrator_defined',
};

export function toAssociationType(
  t: z.infer<typeof HsAssociationTypeSchema>,
): ExternalAssociationType {
  const category = Object.hasOwn(CATEGORY, t.category) ? CATEGORY[t.category]! : 'other';
  return {
    category,
    typeId: t.typeId,
    label: t.label ?? null,
    primary: t.category === 'HUBSPOT_DEFINED' && PRIMARY_ASSOCIATION_TYPE_IDS.has(t.typeId),
  };
}
