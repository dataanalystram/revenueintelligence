import { z } from 'zod';

/**
 * Zod schemas for the HubSpot responses the connector consumes. Required
 * fields are enforced; unknown fields are ignored (HubSpot adds fields over
 * time), so an additive change never breaks us but a missing or retyped field
 * is caught at the boundary instead of deep in business logic.
 */

const IsoDateTime = z.iso.datetime({ offset: true });

/** CRM property values are strings (or null) in every HubSpot object response. */
export const HsPropertiesSchema = z.record(z.string(), z.string().nullable());

export const HsObjectSchema = z.object({
  id: z.string().min(1),
  properties: HsPropertiesSchema,
  createdAt: IsoDateTime.optional(),
  updatedAt: IsoDateTime.optional(),
  archived: z.boolean().default(false),
});
export type HsObject = z.infer<typeof HsObjectSchema>;

export const HsPagingSchema = z
  .object({
    next: z.object({ after: z.string().min(1), link: z.string().optional() }).optional(),
  })
  .optional();

export const HsObjectPageSchema = z.object({
  results: z.array(HsObjectSchema),
  paging: HsPagingSchema,
});

/** CRM search response (ADR 0015); `paging.next.after` is a numeric offset. */
export const HsSearchPageSchema = z.object({
  total: z.number().int().nonnegative(),
  results: z.array(HsObjectSchema),
  paging: z
    .object({ next: z.object({ after: z.string().regex(/^[0-9]{1,10}$/) }).optional() })
    .optional(),
});

export const HsPropertyDefinitionSchema = z.object({
  name: z.string().min(1),
  label: z.string(),
  type: z.string().min(1),
  fieldType: z.string().optional(),
  groupName: z.string().optional(),
  options: z
    .array(z.object({ value: z.string(), label: z.string(), hidden: z.boolean().optional() }))
    .default([]),
  hubspotDefined: z.boolean().optional(),
  archived: z.boolean().optional(),
  modificationMetadata: z.object({ readOnlyValue: z.boolean().optional() }).optional(),
});
export type HsPropertyDefinition = z.infer<typeof HsPropertyDefinitionSchema>;

export const HsPropertyListSchema = z.object({ results: z.array(HsPropertyDefinitionSchema) });

export const HsAssociationTypeSchema = z.object({
  /** Open: a category HubSpot adds later maps to `other` instead of failing the read. */
  category: z.string().min(1),
  typeId: z.number().int(),
  label: z.string().nullable().optional(),
});

export const HsAssociationLabelListSchema = z.object({ results: z.array(HsAssociationTypeSchema) });

const HsObjectIdSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform(String);

/**
 * `POST /crm/associations/{version}/{from}/{to}/batch/read`. Inputs without
 * associations are omitted from `results`; per-input failures are reported in
 * `errors` (HTTP 207).
 */
export const HsAssociationBatchReadSchema = z.object({
  results: z.array(
    z.object({
      from: z.object({ id: HsObjectIdSchema }),
      to: z.array(
        z.object({
          toObjectId: HsObjectIdSchema,
          associationTypes: z.array(HsAssociationTypeSchema).min(1),
        }),
      ),
      paging: HsPagingSchema,
    }),
  ),
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        category: z.string().optional(),
        /** e.g. `crm.associations.NO_ASSOCIATIONS_FOUND` (seen live). */
        subCategory: z.string().optional(),
        /**
         * Which inputs the error applies to. Live HubSpot sends
         * `{ fromObjectId: ["123"], fromObjectType: [...], toObjectType: [...] }`;
         * `ids` is accepted too. Other keys are ignored; malformed values are
         * dropped rather than failing the batch.
         */
        context: z
          .object({
            fromObjectId: z.array(HsObjectIdSchema).optional().catch(undefined),
            ids: z.array(HsObjectIdSchema).optional().catch(undefined),
          })
          .optional()
          .catch(undefined),
      }),
    )
    .optional(),
});

export const HsAccountDetailsSchema = z.object({
  portalId: z.number().int().positive(),
  accountType: z.string().optional(),
  timeZone: z.string().optional(),
  companyCurrency: z.string().optional(),
  dataHostingLocation: z.string().optional(),
  uiDomain: z.string().optional(),
});
export type HsAccountDetails = z.infer<typeof HsAccountDetailsSchema>;

/** HubSpot's error body (all fields optional: proxies can return anything). */
export const HsErrorBodySchema = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  correlationId: z.string().optional(),
  category: z.string().optional(),
  errorType: z.string().optional(),
  policyName: z.string().optional(),
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        context: z.object({ requiredGranularScopes: z.array(z.string()).optional() }).optional(),
      }),
    )
    .optional(),
});
