import type {
  ExternalSystem,
  Subscription,
  SubscriptionSource,
  SubscriptionState,
} from '../../domain';

/** A `tenant_subscriptions` row as the products module sees it. */
export interface SubscriptionRow {
  readonly id: string;
  readonly companyId: string;
  readonly productKey: string;
  readonly state: SubscriptionState;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly quantity: number | null;
  readonly source: SubscriptionSource;
  readonly recordState: 'active' | 'deleted';
  readonly sourceUpdatedAt: Date | null;
  readonly observedAt: Date;
  readonly deletedAt: Date | null;
  readonly fieldHash: string | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export type DbRow = {
  id: string;
  companyId: string;
  productKey: string;
  state: string;
  startsAt: Date | null;
  endsAt: Date | null;
  quantity: number | null;
  sourceSystem: string;
  sourceObjectType: string;
  sourceRecordId: string;
  recordState: string;
  sourceUpdatedAt: Date | null;
  observedAt: Date;
  deletedAt: Date | null;
  fieldHash: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

export function toRow(r: DbRow): SubscriptionRow {
  return {
    id: r.id,
    companyId: r.companyId,
    productKey: r.productKey,
    state: r.state as SubscriptionState,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    quantity: r.quantity,
    source: {
      system: r.sourceSystem as ExternalSystem | 'import',
      objectType: r.sourceObjectType,
      recordId: r.sourceRecordId,
    },
    recordState: r.recordState as 'active' | 'deleted',
    sourceUpdatedAt: r.sourceUpdatedAt,
    observedAt: r.observedAt,
    deletedAt: r.deletedAt,
    fieldHash: r.fieldHash,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
  };
}

export function toSubscription(r: SubscriptionRow): Subscription {
  return {
    id: r.id,
    companyId: r.companyId as Subscription['companyId'],
    productKey: r.productKey as Subscription['productKey'],
    state: r.state,
    ...(r.startsAt ? { startsAt: r.startsAt } : {}),
    ...(r.endsAt ? { endsAt: r.endsAt } : {}),
    ...(r.quantity !== null ? { quantity: r.quantity } : {}),
    source: r.source,
    recordState: r.recordState,
    ...(r.sourceUpdatedAt ? { sourceUpdatedAt: r.sourceUpdatedAt } : {}),
    observedAt: r.observedAt,
    ...(r.deletedAt ? { deletedAt: r.deletedAt } : {}),
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
  };
}
