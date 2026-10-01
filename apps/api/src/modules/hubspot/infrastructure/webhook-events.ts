import { createHash } from 'node:crypto';
import { z } from 'zod';

/** HubSpot batches up to 100 events per webhook request. */
export const WEBHOOK_MAX_EVENTS = 100;

/** A numeric HubSpot id (JSON number or digit string); unsafe integers are refused, never rounded. */
const Id = z
  .union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^[0-9]{1,20}$/),
  ])
  .transform(String);

const EventType = z.string().regex(/^[A-Za-z_]{1,40}\.[A-Za-z_]{1,40}$/);

const ObjectTypeId = z.string().regex(/^[0-9]{1,5}-[0-9]{1,12}$/);

/**
 * One webhook event, as HubSpot documents it (legacy `contact.creation` style
 * and generic `object.*` subscriptions with `objectTypeId`). Only metadata is
 * kept: `propertyValue` and every other field are dropped by the parser and
 * never reach storage or logs. Optional metadata in an unexpected format is
 * dropped rather than failing the whole batch.
 */
const HsWebhookEventSchema = z
  .object({
    eventId: Id,
    subscriptionId: Id,
    portalId: Id,
    appId: Id,
    occurredAt: z.number().int().positive().max(8_640_000_000_000_000), // largest valid Date
    subscriptionType: EventType.optional(),
    eventType: EventType.optional(),
    attemptNumber: z.number().int().min(0).max(1000),
    objectId: Id.optional().catch(undefined),
    objectTypeId: ObjectTypeId.optional().catch(undefined),
    propertyName: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,100}$/)
      .optional()
      .catch(undefined),
    changeSource: z
      .string()
      .regex(/^[A-Z0-9_]{1,64}$/)
      .optional()
      .catch(undefined),
    // object.merge (M6): identifiers only
    primaryObjectId: Id.optional().catch(undefined),
    newObjectId: Id.optional().catch(undefined),
    mergedObjectIds: z.array(Id).max(100).optional().catch(undefined),
    // object.associationChange (M6): identifiers only
    fromObjectId: Id.optional().catch(undefined),
    toObjectId: Id.optional().catch(undefined),
    fromObjectTypeId: ObjectTypeId.optional().catch(undefined),
    toObjectTypeId: ObjectTypeId.optional().catch(undefined),
    associationTypeId: z.number().int().min(0).max(1_000_000).optional().catch(undefined),
    associationCategory: z
      .string()
      .regex(/^[A-Z_]{1,40}$/)
      .optional()
      .catch(undefined),
    associationRemoved: z.boolean().optional().catch(undefined),
    isPrimaryAssociation: z.boolean().optional().catch(undefined),
  })
  .refine((e) => e.subscriptionType !== undefined || e.eventType !== undefined, {
    message: 'subscriptionType or eventType is required',
  });

export const HsWebhookBatchSchema = z.array(HsWebhookEventSchema).min(1).max(WEBHOOK_MAX_EVENTS);

/** A received webhook event: identifiers only, never values. */
export interface WebhookEvent {
  /** SHA-256 of the event's identity; the same for every redelivery of the event. */
  readonly deliveryKey: string;
  readonly eventId: string;
  readonly subscriptionId: string;
  readonly accountId: string;
  readonly appId: string;
  readonly subscriptionType: string;
  readonly objectTypeId: string | undefined;
  readonly objectId: string | undefined;
  readonly propertyName: string | undefined;
  readonly changeSource: string | undefined;
  readonly occurredAt: Date;
  readonly attemptNumber: number;
  /** object.merge identifiers (M6). */
  readonly merge?: {
    readonly primaryObjectId: string | undefined;
    readonly newObjectId: string | undefined;
    readonly mergedObjectIds: readonly string[];
  };
  /** object.associationChange identifiers (M6). */
  readonly association?: {
    readonly fromObjectId: string | undefined;
    readonly fromObjectTypeId: string | undefined;
    readonly toObjectId: string | undefined;
    readonly toObjectTypeId: string | undefined;
    readonly associationTypeId: number | undefined;
    readonly associationCategory: string | undefined;
    readonly associationRemoved: boolean | undefined;
    readonly isPrimaryAssociation: boolean | undefined;
  };
}

export type ParsedBatch =
  | { readonly ok: true; readonly events: readonly WebhookEvent[] }
  | { readonly ok: false; readonly issues: string };

/** Parses a verified request body. Never includes body content in the result. */
export function parseWebhookBatch(rawBody: Buffer): ParsedBatch {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, issues: 'body is not JSON' };
  }
  const parsed = HsWebhookBatchSchema.safeParse(json);
  if (!parsed.success) {
    // Paths and codes only: messages could quote input.
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}:${i.code}`)
      .join(', ');
    return { ok: false, issues };
  }
  return {
    ok: true,
    events: parsed.data.map((e) => {
      const subscriptionType = (e.subscriptionType ?? e.eventType)!;
      const merge =
        e.primaryObjectId !== undefined || e.newObjectId !== undefined || e.mergedObjectIds
          ? {
              primaryObjectId: e.primaryObjectId,
              newObjectId: e.newObjectId,
              mergedObjectIds: e.mergedObjectIds ?? [],
            }
          : undefined;
      const association =
        e.fromObjectId !== undefined || e.toObjectId !== undefined
          ? {
              fromObjectId: e.fromObjectId,
              fromObjectTypeId: e.fromObjectTypeId,
              toObjectId: e.toObjectId,
              toObjectTypeId: e.toObjectTypeId,
              associationTypeId: e.associationTypeId,
              associationCategory: e.associationCategory,
              associationRemoved: e.associationRemoved,
              isPrimaryAssociation: e.isPrimaryAssociation,
            }
          : undefined;
      const identity: unknown[] = [
        e.portalId,
        e.appId,
        e.subscriptionId,
        e.eventId,
        subscriptionType,
        e.objectTypeId ?? '',
        e.objectId ?? '',
        e.propertyName ?? '',
        e.occurredAt,
      ];
      // Appended only when present, so keys of M5-style events are unchanged.
      if (merge)
        identity.push([
          'merge',
          merge.primaryObjectId ?? '',
          merge.newObjectId ?? '',
          merge.mergedObjectIds,
        ]);
      if (association) {
        identity.push([
          'association',
          association.fromObjectId ?? '',
          association.toObjectId ?? '',
          association.associationTypeId ?? '',
          association.associationRemoved ?? '',
        ]);
      }
      return {
        // attemptNumber is deliberately not part of the identity: retries share it.
        deliveryKey: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
        eventId: e.eventId,
        subscriptionId: e.subscriptionId,
        accountId: e.portalId,
        appId: e.appId,
        subscriptionType,
        objectTypeId: e.objectTypeId,
        objectId: e.objectId,
        propertyName: e.propertyName,
        changeSource: e.changeSource,
        occurredAt: new Date(e.occurredAt),
        attemptNumber: e.attemptNumber,
        ...(merge ? { merge } : {}),
        ...(association ? { association } : {}),
      };
    }),
  };
}
