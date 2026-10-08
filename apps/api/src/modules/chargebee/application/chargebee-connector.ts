import { z } from 'zod';
import {
  normaliseSourceSchema,
  type ConnectionTestResult,
  type ConnectorCapabilities,
  type ReadRequest,
  type ReadSelection,
  type RevealableSecret,
  type SourceAdapterFactory,
  type SourceConnectionSettings,
  type SourceConnector,
  type SourceField,
  type SourceObject,
  type SourcePage,
  type SourceRecord,
  type SourceSchema,
} from '../../domain';
import {
  ChargebeeConnectionConfigSchema,
  type ChargebeeConnectionConfig,
} from '../chargebee.config';
import { ChargebeeError } from '../errors';
import {
  ChargebeeHttpClient,
  type ChargebeeHttpDeps,
  type ChargebeePath,
  type ChargebeeTransportCounters,
} from '../infrastructure/chargebee-http';
import {
  CustomerSchema,
  ItemPriceSchema,
  ItemSchema,
  ListEnvelopeSchema,
  SubscriptionSchema,
  type ChargebeeSubscription,
} from '../infrastructure/chargebee-schemas';

export const CHARGEBEE_ADAPTER_VERSION = 'chargebee-m9b.0';
/** API v2, Product Catalog 2.0 (the only catalogue M9B supports). */
const SOURCE_VERSION = 'v2:pc2';
const CHANGE_FIELD = 'updated_at';
const MAX_IDS_PER_READ = 100;
/** Safety cap on the catalogue lookup (item prices); never loops forever. */
const MAX_LOOKUP_PAGES = 10_000;

type Value = string | number | boolean | null;

const SUBSCRIPTION_STATUSES = [
  'future',
  'in_trial',
  'active',
  'non_renewing',
  'paused',
  'cancelled',
  'transferred',
] as const;
const ITEM_TYPES = ['plan', 'addon', 'charge'] as const;
const ITEM_STATUSES = ['active', 'archived', 'deleted'] as const;

const enumField = (name: string, values: readonly string[], label?: string): SourceField => ({
  name,
  ...(label ? { label } : {}),
  type: 'enum',
  required: false,
  unique: false,
  enumOptions: values.map((value) => ({ value, active: true })),
});
const field = (
  name: string,
  type: SourceField['type'],
  extra: Partial<SourceField> = {},
): SourceField => ({ name, type, required: false, unique: false, ...extra });
/** UTC Unix seconds (F18): declared `datetime`, source type named explicitly. */
const seconds = (name: string): SourceField =>
  field(name, 'datetime', { sourceType: 'timestamp_utc_seconds' });

/**
 * The Chargebee reference adapter (ADR 0024, M9B plan §4, §16): implements the
 * generic port for five declared objects, flattens subscription items into the
 * derived `SubscriptionItems` child set (resolving `item_id` through
 * Chargebee's own item-price catalogue), never derives business meaning (no
 * status interpretation, no date inference), keeps only declared attributes
 * (cards and payment data are discarded unread) and is read-only by
 * construction (GET to four allowlisted list endpoints).
 */
export class ChargebeeConnector implements SourceConnector {
  private readonly http: ChargebeeHttpClient;
  /** item_price_id → item_id, loaded lazily from `/item_prices` for this instance (one run). */
  private itemOfPrice: Map<string, string> | undefined;

  constructor(
    private readonly config: ChargebeeConnectionConfig,
    connectionKey: string,
    credential: () => Promise<RevealableSecret>,
    deps: ChargebeeHttpDeps = {},
  ) {
    this.http = new ChargebeeHttpClient(config, connectionKey, credential, deps);
  }

  get counters(): ChargebeeTransportCounters {
    return this.http.counters;
  }

  capabilities(): ConnectorCapabilities {
    return {
      kind: 'chargebee',
      adapterVersion: CHARGEBEE_ADAPTER_VERSION,
      readOnly: true,
      singleRecordRead: false,
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const probe = new URLSearchParams({ limit: '1' });
      await this.http.get('/items', probe, ListEnvelopeSchema);
      await this.http.get('/subscriptions', probe, ListEnvelopeSchema);
      return { ok: true, code: 'ok', sourceVersion: SOURCE_VERSION };
    } catch (err) {
      if (!(err instanceof ChargebeeError)) throw err;
      return { ok: false, code: testCode(err) };
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the port is async
  async describeSchema(): Promise<SourceSchema> {
    const page = this.config.pageSize;
    const lineIncremental = this.config.incrementalLines === 'verified';
    const objects: SourceObject[] = [
      {
        name: 'Customers',
        classification: 'record',
        capabilities: {
          pagination: 'cursor',
          changeField: CHANGE_FIELD,
          deleteVisibility: 'flag',
          count: false,
          maxPageSize: page,
        },
        fields: [
          field('id', 'id', { unique: true, required: true }),
          field('company', 'string'),
          seconds('created_at'),
          seconds('updated_at'),
          field('deleted', 'boolean'),
          field('business_entity_id', 'string'),
        ],
      },
      {
        name: 'Items',
        classification: 'reference',
        capabilities: {
          pagination: 'cursor',
          changeField: CHANGE_FIELD,
          deleteVisibility: 'none',
          count: false,
          maxPageSize: page,
          fullReadProof: 'double_enumeration',
        },
        fields: [
          field('id', 'id', { unique: true, required: true }),
          field('name', 'string'),
          enumField('type', ITEM_TYPES),
          enumField('status', ITEM_STATUSES),
          field('item_family_id', 'string'),
          field('metered', 'boolean'),
          seconds('updated_at'),
          seconds('archived_at'),
        ],
      },
      {
        name: 'ItemPrices',
        classification: 'reference',
        capabilities: {
          pagination: 'cursor',
          changeField: CHANGE_FIELD,
          deleteVisibility: 'none',
          count: false,
          maxPageSize: page,
          fullReadProof: 'double_enumeration',
        },
        fields: [
          field('id', 'id', { unique: true, required: true }),
          field('item_id', 'relate', { relatesTo: 'Items' }),
          enumField('item_type', ITEM_TYPES),
          enumField('status', ITEM_STATUSES),
          field('currency_code', 'string'),
          field('period', 'integer'),
          field('period_unit', 'string'),
          field('price_variant_id', 'string'),
          field('pricing_model', 'string'),
          seconds('updated_at'),
        ],
      },
      {
        name: 'Subscriptions',
        classification: 'record',
        capabilities: {
          pagination: 'cursor',
          changeField: CHANGE_FIELD,
          deleteVisibility: 'flag',
          count: false,
          maxPageSize: page,
          fullReadProof: 'double_enumeration',
          ...(lineIncremental ? {} : { incrementalReads: false as const }),
        },
        fields: [
          field('id', 'id', { unique: true, required: true }),
          field('customer_id', 'relate', { relatesTo: 'Customers' }),
          enumField('status', SUBSCRIPTION_STATUSES),
          seconds('start_date'),
          seconds('started_at'),
          seconds('activated_at'),
          seconds('trial_start'),
          seconds('trial_end'),
          seconds('current_term_start'),
          seconds('current_term_end'),
          seconds('next_billing_at'),
          seconds('cancelled_at'),
          field('cancel_reason', 'string'),
          seconds('pause_date'),
          seconds('resume_date'),
          seconds('created_at'),
          seconds('updated_at'),
          field('deleted', 'boolean'),
          field('decommissioned', 'boolean'),
          field('business_entity_id', 'string'),
          field('item_count', 'integer'),
        ],
      },
      {
        name: 'SubscriptionItems',
        classification: 'record',
        capabilities: {
          pagination: 'cursor',
          changeField: CHANGE_FIELD,
          deleteVisibility: 'flag',
          count: false,
          maxPageSize: page,
          fullReadProof: 'double_enumeration',
          childOf: { object: 'Subscriptions', parentKeyField: 'subscription_id' },
          ...(lineIncremental ? {} : { incrementalReads: false as const }),
        },
        fields: [
          // Two identity candidates: the published mapping chooses one (V3, decision B9).
          field('line_key_item_price', 'id', { unique: true }),
          field('line_key_item', 'id', { unique: true }),
          field('subscription_id', 'relate', { relatesTo: 'Subscriptions' }),
          field('customer_id', 'relate', { relatesTo: 'Customers' }),
          field('item_price_id', 'relate', { relatesTo: 'ItemPrices' }),
          field('item_id', 'relate', { relatesTo: 'Items' }),
          enumField('item_type', ITEM_TYPES),
          field('quantity', 'integer'),
          field('quantity_in_decimal', 'string'),
          seconds('item_current_term_start'),
          seconds('item_current_term_end'),
          enumField('status', SUBSCRIPTION_STATUSES),
          seconds('current_term_start'),
          seconds('current_term_end'),
          seconds('started_at'),
          seconds('cancelled_at'),
          seconds('trial_end'),
          seconds('next_billing_at'),
          seconds('updated_at'),
          field('deleted', 'boolean'),
        ],
      },
    ];
    return normaliseSourceSchema({ sourceVersion: SOURCE_VERSION, objects });
  }

  async readRecords(request: ReadRequest): Promise<SourcePage> {
    request.fields.forEach(assertApiName);
    const pageSize = Math.max(1, Math.min(request.pageSize, this.config.pageSize));
    if (request.selection.mode === 'ids' && request.selection.ids.length > MAX_IDS_PER_READ) {
      throw new ChargebeeError('bad_request', `At most ${MAX_IDS_PER_READ} ids per read`);
    }
    if (request.position !== undefined && !/^[\x21-\x7e]{1,2000}$/.test(request.position)) {
      throw new ChargebeeError('bad_request', 'Invalid read position');
    }
    switch (request.object) {
      case 'Customers': {
        const page = await this.list('/customers', request, pageSize, true, true);
        return {
          records: page.list.map((e) => this.customer(e.customer, request.fields)),
          ...next(page.next_offset),
        };
      }
      case 'Items': {
        const page = await this.list('/items', request, pageSize, false, false);
        return {
          records: page.list.map((e) => catalogueRecord('Items', e.item, ItemSchema, request)),
          ...next(page.next_offset),
        };
      }
      case 'ItemPrices': {
        const page = await this.list('/item_prices', request, pageSize, false, false);
        return {
          records: page.list.map((e) =>
            catalogueRecord('ItemPrices', e.item_price, ItemPriceSchema, request),
          ),
          ...next(page.next_offset),
        };
      }
      case 'Subscriptions': {
        const page = await this.list('/subscriptions', request, pageSize, true, true);
        return {
          records: page.list.map((e) => subscriptionRecord(e.subscription, request.fields)),
          ...next(page.next_offset),
        };
      }
      case 'SubscriptionItems': {
        const page = await this.list('/subscriptions', request, pageSize, true, true);
        const records: SourceRecord[] = [];
        for (const entry of page.list) {
          records.push(...(await this.subscriptionItems(entry.subscription, request.fields)));
        }
        return { records, ...next(page.next_offset) };
      }
      default:
        throw new ChargebeeError('bad_request', 'Unknown Chargebee object');
    }
  }

  /** One list page of an allowlisted resource for a bounded selection. */
  private list(
    path: ChargebeePath,
    request: ReadRequest,
    pageSize: number,
    includeDeleted: boolean,
    createdBounded: boolean,
  ) {
    const query = selectionQuery(request.selection, createdBounded);
    query.set('limit', String(pageSize));
    if (request.position) query.set('offset', request.position);
    if (includeDeleted) query.set('include_deleted', 'true');
    if (this.config.businessEntityId && path !== '/items' && path !== '/item_prices') {
      query.set('business_entity_id[is]', this.config.businessEntityId);
    }
    return this.http.get(path, query, ListEnvelopeSchema);
  }

  private customer(raw: unknown, fields: readonly string[]): SourceRecord {
    const parsed = CustomerSchema.safeParse(raw);
    if (!parsed.success) return rejection('Customers', raw, fields, 'id', undefined);
    const c = parsed.data;
    const all: Record<string, Value> = {
      id: c.id,
      company: c.company ?? null,
      created_at: c.created_at,
      updated_at: c.updated_at ?? null,
      deleted: c.deleted,
      business_entity_id: c.business_entity_id ?? null,
    };
    return {
      object: 'Customers',
      id: c.id,
      ...(c.updated_at !== undefined ? { modifiedAt: new Date(c.updated_at * 1000) } : {}),
      ...(c.deleted ? { deleted: true } : {}),
      values: project('Customers', all, fields),
    };
  }

  /**
   * Flattens one subscription into its child records (M9B plan §4, §7). A
   * structurally invalid subscription becomes one rejection row carrying only
   * its parent key and account reference when they are readable.
   */
  private async subscriptionItems(raw: unknown, fields: readonly string[]) {
    const parsed = SubscriptionSchema.safeParse(raw);
    if (!parsed.success) {
      return [rejection('SubscriptionItems', raw, fields, 'subscription_id', 'customer_id')];
    }
    const s = parsed.data;
    const items = await this.itemIds(s);
    return s.subscription_items.map((item, i): SourceRecord => {
      const itemId = items.get(item.item_price_id) ?? null;
      const all: Record<string, Value> = {
        line_key_item_price: `${s.id}:${item.item_price_id}`,
        line_key_item: itemId === null ? null : `${s.id}:${itemId}`,
        subscription_id: s.id,
        customer_id: s.customer_id,
        item_price_id: item.item_price_id,
        item_id: itemId,
        item_type: item.item_type,
        quantity: item.quantity ?? null,
        quantity_in_decimal: item.quantity_in_decimal ?? null,
        item_current_term_start: item.current_term_start ?? null,
        item_current_term_end: item.current_term_end ?? null,
        status: s.status,
        current_term_start: s.current_term_start ?? null,
        current_term_end: s.current_term_end ?? null,
        started_at: s.started_at ?? null,
        cancelled_at: s.cancelled_at ?? null,
        trial_end: s.trial_end ?? null,
        next_billing_at: s.next_billing_at ?? null,
        updated_at: s.updated_at ?? null,
        deleted: s.deleted,
      };
      return {
        object: 'SubscriptionItems',
        // A row id, unique per page; the line identity is the mapping's choice.
        id: `${s.id}:${i}`,
        ...(s.updated_at !== undefined ? { modifiedAt: new Date(s.updated_at * 1000) } : {}),
        ...(s.deleted ? { deleted: true } : {}),
        values: project('SubscriptionItems', all, fields),
      };
    });
  }

  /**
   * Resolves item prices to items through Chargebee's own catalogue (a pure
   * join on `item_prices.item_id`). Loaded once per adapter instance and
   * reloaded once when a subscription references an unknown price; a price
   * still unknown resolves to null (the line is then rejected and protected).
   */
  private async itemIds(s: ChargebeeSubscription): Promise<Map<string, string>> {
    if (!this.itemOfPrice) this.itemOfPrice = await this.loadItemPrices();
    if (s.subscription_items.some((i) => !this.itemOfPrice!.has(i.item_price_id))) {
      this.itemOfPrice = await this.loadItemPrices();
    }
    return this.itemOfPrice;
  }

  private async loadItemPrices(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const used = new Set<string>();
    let offset: string | undefined;
    for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(this.config.pageSize) });
      if (offset) query.set('offset', offset);
      const result = await this.http.get('/item_prices', query, ListEnvelopeSchema);
      for (const entry of result.list) {
        const price = ItemPriceLinkSchema.safeParse(entry.item_price);
        if (price.success && price.data.item_id) out.set(price.data.id, price.data.item_id);
      }
      if (!result.next_offset) return out;
      if (used.has(result.next_offset)) {
        throw new ChargebeeError('invalid_payload', 'Chargebee repeated a page position', {
          path: '/item_prices',
        });
      }
      used.add(result.next_offset);
      offset = result.next_offset;
    }
    throw new ChargebeeError('invalid_payload', 'The item price catalogue exceeded the page cap', {
      path: '/item_prices',
    });
  }
}

const ItemPriceLinkSchema = z.looseObject({
  id: z.string().min(1).max(100),
  item_id: z.string().min(1).max(100).optional(),
});

function next(offset: string | undefined): { next?: string } {
  return offset ? { next: offset } : {};
}

function assertApiName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(name)) {
    throw new ChargebeeError('bad_request', 'Invalid API name');
  }
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Chargebee list filters for a bounded selection. Full reads of records are
 * bounded by creation (`created_at` ascending: stable under updates); catalogue
 * reads are unbounded (small, double-enumerated). Incremental reads use
 * `updated_at` within [since, boundary]. Timestamps are UTC seconds (F18);
 * `[after]`/`[before]` are widened by one second to stay inclusive.
 */
function selectionQuery(selection: ReadSelection, createdBounded: boolean): URLSearchParams {
  const q = new URLSearchParams();
  switch (selection.mode) {
    case 'full':
      if (createdBounded) {
        q.set('created_at[before]', String(sec(selection.boundary) + 1));
        q.set('sort_by[asc]', 'created_at');
      }
      break;
    case 'since':
      q.set('updated_at[after]', String(sec(selection.since) - 1));
      q.set('updated_at[before]', String(sec(selection.boundary) + 1));
      q.set('sort_by[asc]', 'updated_at');
      break;
    case 'ids':
      for (const id of selection.ids) {
        if (!/^[A-Za-z0-9_.@-]{1,100}$/.test(id)) {
          throw new ChargebeeError('bad_request', 'Invalid record id');
        }
      }
      q.set('id[in]', JSON.stringify(selection.ids));
      break;
  }
  return q;
}

function catalogueRecord(
  object: 'Items' | 'ItemPrices',
  raw: unknown,
  schema: typeof ItemSchema | typeof ItemPriceSchema,
  request: ReadRequest,
): SourceRecord {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return rejection(object, raw, request.fields, 'id', undefined);
  const data = parsed.data as Record<string, unknown>;
  const all: Record<string, Value> = {};
  for (const name of DECLARED[object]) all[name] = scalar(data[name]);
  const updated = data.updated_at;
  return {
    object,
    id: String(data.id),
    ...(typeof updated === 'number' ? { modifiedAt: new Date(updated * 1000) } : {}),
    values: project(object, all, request.fields),
  };
}

function subscriptionRecord(raw: unknown, fields: readonly string[]): SourceRecord {
  const parsed = SubscriptionSchema.safeParse(raw);
  if (!parsed.success) return rejection('Subscriptions', raw, fields, 'id', 'customer_id');
  const s = parsed.data as Record<string, unknown> & ChargebeeSubscription;
  const all: Record<string, Value> = {};
  for (const name of DECLARED.Subscriptions) {
    all[name] = name === 'item_count' ? s.subscription_items.length : scalar(s[name]);
  }
  return {
    object: 'Subscriptions',
    id: s.id,
    ...(s.updated_at !== undefined ? { modifiedAt: new Date(s.updated_at * 1000) } : {}),
    ...(s.deleted ? { deleted: true } : {}),
    values: project('Subscriptions', all, fields),
  };
}

const DECLARED = {
  Customers: ['id', 'company', 'created_at', 'updated_at', 'deleted', 'business_entity_id'],
  Items: ['id', 'name', 'type', 'status', 'item_family_id', 'metered', 'updated_at', 'archived_at'],
  ItemPrices: [
    'id',
    'item_id',
    'item_type',
    'status',
    'currency_code',
    'period',
    'period_unit',
    'price_variant_id',
    'pricing_model',
    'updated_at',
  ],
  Subscriptions: [
    'id',
    'customer_id',
    'status',
    'start_date',
    'started_at',
    'activated_at',
    'trial_start',
    'trial_end',
    'current_term_start',
    'current_term_end',
    'next_billing_at',
    'cancelled_at',
    'cancel_reason',
    'pause_date',
    'resume_date',
    'created_at',
    'updated_at',
    'deleted',
    'decommissioned',
    'business_entity_id',
    'item_count',
  ],
  SubscriptionItems: [
    'line_key_item_price',
    'line_key_item',
    'subscription_id',
    'customer_id',
    'item_price_id',
    'item_id',
    'item_type',
    'quantity',
    'quantity_in_decimal',
    'item_current_term_start',
    'item_current_term_end',
    'status',
    'current_term_start',
    'current_term_end',
    'started_at',
    'cancelled_at',
    'trial_end',
    'next_billing_at',
    'updated_at',
    'deleted',
  ],
} as const satisfies Record<string, readonly string[]>;

function scalar(value: unknown): Value {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null;
}

/** Exactly the requested fields; a field the adapter does not declare is schema drift. */
function project(
  object: string,
  all: Record<string, Value>,
  fields: readonly string[],
): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const name of fields) {
    const declared = (DECLARED as Record<string, readonly string[] | undefined>)[object] ?? [];
    if (!declared.includes(name)) {
      throw new ChargebeeError('schema_drift', `${object} does not declare a requested field`);
    }
    out[name] = all[name] ?? null;
  }
  return out;
}

const SAFE_ID = /^[A-Za-z0-9_.@-]{1,100}$/;

/**
 * A structurally invalid entry (M9B CB35): never mapped. Carries only its own
 * key and account reference when those are readable ids; every other
 * requested field is null.
 */
function rejection(
  object: string,
  raw: unknown,
  fields: readonly string[],
  keyField: string,
  accountField: string | undefined,
): SourceRecord {
  const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const id = typeof entry.id === 'string' && SAFE_ID.test(entry.id) ? entry.id : undefined;
  const account =
    accountField && typeof entry.customer_id === 'string' && SAFE_ID.test(entry.customer_id)
      ? entry.customer_id
      : undefined;
  const values: Record<string, Value> = {};
  for (const name of fields) values[name] = null;
  if (id && fields.includes(keyField)) values[keyField] = id;
  if (account && accountField && fields.includes(accountField)) values[accountField] = account;
  return {
    object,
    id: `${id ?? 'unreadable'}:invalid`,
    rejection: 'invalid_payload',
    values,
  };
}

function testCode(err: ChargebeeError): string {
  if (err.details.apiErrorCode === 'configuration_incompatible') {
    return 'catalog_version_unsupported';
  }
  switch (err.kind) {
    case 'unauthorized':
    case 'not_configured':
      return 'auth_failed';
    case 'forbidden':
      return 'forbidden';
    case 'not_found':
      return 'site_not_found';
    case 'rate_limited':
      return 'rate_limited';
    case 'timeout':
    case 'network':
      return 'unreachable';
    case 'invalid_payload':
      return 'invalid_response';
    default:
      return 'failed';
  }
}

/** Registration of the Chargebee adapter under its kind (composition roots only). */
export function chargebeeAdapterFactory(deps: ChargebeeHttpDeps = {}): SourceAdapterFactory {
  return {
    kind: 'chargebee',
    adapterVersion: CHARGEBEE_ADAPTER_VERSION,
    validateConfig(config) {
      const parsed = ChargebeeConnectionConfigSchema.safeParse(config);
      return parsed.success
        ? { ok: true }
        : {
            ok: false,
            issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
          };
    },
    create(settings: SourceConnectionSettings, { resolveCredential }) {
      const config = ChargebeeConnectionConfigSchema.parse(settings.config);
      const name = settings.credentialName;
      return new ChargebeeConnector(
        config,
        `${settings.tenantId}:${settings.connectionId}`,
        () => {
          if (!name) {
            throw new ChargebeeError('not_configured', 'The connection has no credential name');
          }
          return resolveCredential(name);
        },
        deps,
      );
    },
  };
}
