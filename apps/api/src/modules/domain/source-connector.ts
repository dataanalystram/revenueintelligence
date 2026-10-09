import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorKind } from './connector-kinds';

/**
 * The generic source connector port (ADR 0019). Every source adapter (Sugar
 * now; Salesforce, Snowflake… later) implements it; business code never sees a
 * vendor payload. Coverage is deliberately NOT part of the port: whether a
 * read was complete is a platform decision (ADR 0020).
 */

const ApiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
const Label = z.string().trim().min(1).max(200);

/** Generic field types the mapping engine understands. */
export const SourceFieldTypeSchema = z.enum([
  'id',
  'string',
  'text',
  'enum',
  'date',
  'datetime',
  'number',
  'integer',
  'boolean',
  'relate',
  'other',
]);
export type SourceFieldType = z.infer<typeof SourceFieldTypeSchema>;

/**
 * How the platform treats an object: `record` (business data), `reference`
 * (a catalogue such as products), `internal_principal` (the source's own
 * users/staff: never a person or account).
 */
export const SourceObjectClassSchema = z.enum(['record', 'reference', 'internal_principal']);
export type SourceObjectClass = z.infer<typeof SourceObjectClassSchema>;

export const SourceFieldSchema = z
  .strictObject({
    name: ApiName,
    label: Label.optional(),
    type: SourceFieldTypeSchema,
    /** The source's own type name (metadata only). */
    sourceType: z.string().max(100).optional(),
    required: z.boolean().default(false),
    unique: z.boolean().default(false),
    enumOptions: z
      .array(
        z.strictObject({
          value: z.string().max(200),
          label: z.string().max(200).optional(),
          active: z.boolean().default(true),
        }),
      )
      .max(2000)
      .optional(),
    /** For `relate` fields: the object the value points at. */
    relatesTo: ApiName.optional(),
    /** The value is natively structured (M9A): profiled as a structure, not a string. */
    nested: z.enum(['array', 'object']).optional(),
  })
  .readonly();
export type SourceField = z.infer<typeof SourceFieldSchema>;

export const ObjectCapabilitiesSchema = z
  .strictObject({
    pagination: z.enum(['offset', 'keyset', 'cursor']),
    /** The field holding the record's last modification time (incremental reads). */
    changeField: ApiName.optional(),
    /** `none` until a connector proves how deletions are visible. */
    deleteVisibility: z.enum(['none', 'flag', 'deleted_feed']).default('none'),
    /** The source can count a bounded set (full-read proof). */
    count: z.boolean().default(false),
    maxPageSize: z.number().int().min(1).max(1000),
    /**
     * M9B: how a full read of the object is proven when it cannot count.
     * `double_enumeration` lists the bounded set twice and requires identical
     * membership (tier `stable_snapshot`, never `externally_grounded`).
     * Absent: the object can only be proven by `count`.
     */
    fullReadProof: z.literal('double_enumeration').optional(),
    /**
     * M9B (parent-scoped child reconciliation): the object is a derived child
     * set of `object`. Every record carries its parent's key in
     * `parentKeyField`, its identity is `<parentKey>:<suffix>`, and one page
     * always carries a parent's complete child set (never split). Absent: a
     * plain object.
     */
    childOf: z.strictObject({ object: ApiName, parentKeyField: ApiName }).optional(),
    /**
     * M9B: `false` when incremental reads of the object are not proven safe
     * (e.g. a child change may not move the parent's change field). Such an
     * object is read by full runs only. Absent: incremental reads allowed.
     */
    incrementalReads: z.literal(false).optional(),
    /**
     * M9B (governed correction after live M08): references of this account
     * object may be retired when a successful full run whose read of the
     * object was proven (count or double enumeration) and, where the proof
     * requires it, operator-accepted, did not see them. Retirement is a
     * reference lifecycle state only (never an account deletion). Absent: a
     * reference is never retired from absence.
     */
    referenceRetirement: z.literal('accepted_full_read').optional(),
  })
  .readonly();
export type ObjectCapabilities = z.infer<typeof ObjectCapabilitiesSchema>;

export const SourceObjectSchema = z
  .strictObject({
    name: ApiName,
    label: Label.optional(),
    classification: SourceObjectClassSchema,
    /** Payment-like objects (cards, transactions) are excluded from profiling (M9A). */
    sensitivity: z.literal('payment').optional(),
    capabilities: ObjectCapabilitiesSchema,
    fields: z.array(SourceFieldSchema).min(1).max(2000),
  })
  .readonly();
export type SourceObject = z.infer<typeof SourceObjectSchema>;

/**
 * Normalised schema metadata (a snapshot document). Metadata only: no record
 * values, no per-value counts, no defaults, no formula bodies.
 */
export const SourceSchemaSchema = z
  .strictObject({
    sourceVersion: z.string().max(100).optional(),
    objects: z.array(SourceObjectSchema).min(1).max(200),
  })
  .superRefine((schema, ctx) => {
    const objects = new Set<string>();
    schema.objects.forEach((o, i) => {
      if (objects.has(o.name))
        ctx.addIssue({ code: 'custom', path: ['objects', i, 'name'], message: 'duplicate object' });
      objects.add(o.name);
      const fields = new Set<string>();
      o.fields.forEach((f, j) => {
        if (fields.has(f.name))
          ctx.addIssue({
            code: 'custom',
            path: ['objects', i, 'fields', j, 'name'],
            message: 'duplicate field',
          });
        fields.add(f.name);
      });
    });
  })
  .readonly();
export type SourceSchema = z.infer<typeof SourceSchemaSchema>;

/** Deterministic form of a schema: objects and fields sorted, so equal metadata hashes equally. */
export function normaliseSourceSchema(schema: SourceSchema): SourceSchema {
  const parsed = SourceSchemaSchema.parse(schema);
  return SourceSchemaSchema.parse({
    ...(parsed.sourceVersion ? { sourceVersion: parsed.sourceVersion } : {}),
    objects: [...parsed.objects]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => ({
        ...o,
        fields: [...o.fields]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((f) =>
            f.enumOptions
              ? {
                  ...f,
                  enumOptions: [...f.enumOptions].sort((a, b) => a.value.localeCompare(b.value)),
                }
              : f,
          ),
      })),
  });
}

/** SHA-256 of the normalised schema (the snapshot identity). */
export function sourceSchemaHash(schema: SourceSchema): string {
  return createHash('sha256')
    .update(stableJson(normaliseSourceSchema(schema)))
    .digest('hex');
}

/** JSON with object keys sorted at every depth. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function findSourceObject(schema: SourceSchema, name: string): SourceObject | undefined {
  return schema.objects.find((o) => o.name === name);
}

export function findSourceField(
  schema: SourceSchema,
  object: string,
  field: string,
): SourceField | undefined {
  return findSourceObject(schema, object)?.fields.find((f) => f.name === field);
}

// ---------------------------------------------------------------------------
// Reading records
// ---------------------------------------------------------------------------

/** One record as the adapter returns it, validated at the adapter boundary. */
export interface SourceRecord {
  readonly object: string;
  readonly id: string;
  readonly modifiedAt?: Date;
  /** Only when the object's delete visibility is `flag`. */
  readonly deleted?: boolean;
  /**
   * M9B: the adapter observed this record but it failed boundary validation
   * (structurally invalid). It is never mapped: the platform counts it,
   * protects what it may have represented and, for a child set, never
   * reconciles its parent. `values` then holds only what could be read safely
   * (for a child set at least the parent key).
   */
  readonly rejection?: 'invalid_payload';
  /** Mapped fields only, keyed by API name. Never logged. */
  readonly values: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * A bounded read. `full`: records modified at or before `boundary`, ordered by
 * (change field, id). `since`: records modified at or after `since` (the
 * watermark minus the overlap), same order. `ids`: those records only (batched
 * reference lookups).
 */
export type ReadSelection =
  | { readonly mode: 'full'; readonly boundary: Date }
  | { readonly mode: 'since'; readonly since: Date; readonly boundary: Date }
  | { readonly mode: 'ids'; readonly ids: readonly string[] };

/**
 * Why a read happens (M9A). `sync` and `preview` read the published mapping's
 * fields only; `profile` reads exactly the fields selected in a profile
 * request. Adapters may log the purpose code, never values.
 */
export const ReadPurposeSchema = z.enum(['sync', 'preview', 'profile']);
export type ReadPurpose = z.infer<typeof ReadPurposeSchema>;

export interface ReadRequest {
  readonly object: string;
  /** Absent means `sync` (adapters written before M9A never set it). */
  readonly purpose?: ReadPurpose;
  /** Exactly the fields allowed for the purpose; the adapter never reads other fields. */
  readonly fields: readonly string[];
  readonly selection: ReadSelection;
  /** Opaque position from the previous page; undefined for the first page. */
  readonly position?: string;
  readonly pageSize: number;
}

export interface SourcePage {
  readonly records: readonly SourceRecord[];
  /** Undefined when the bounded set is exhausted. */
  readonly next?: string;
}

export interface ConnectorCapabilities {
  readonly kind: ConnectorKind;
  readonly adapterVersion: string;
  /** Adapters are read-only in M8; a transport guard enforces it. */
  readonly readOnly: true;
  readonly singleRecordRead: boolean;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  /** Stable code (`ok`, `auth_failed`, `unreachable`, …); never a payload. */
  readonly code: string;
  readonly sourceVersion?: string;
}

export interface SourceConnector {
  capabilities(): ConnectorCapabilities;
  testConnection(): Promise<ConnectionTestResult>;
  describeSchema(): Promise<SourceSchema>;
  readRecords(request: ReadRequest): Promise<SourcePage>;
  /** Count of a bounded selection; only for objects whose capabilities declare `count`. */
  countRecords?(request: Pick<ReadRequest, 'object' | 'selection'>): Promise<number>;
  /** Optional; normal synchronisation never depends on it. */
  readRecord?(
    object: string,
    id: string,
    fields: readonly string[],
  ): Promise<SourceRecord | undefined>;
}

/** Non-secret connection settings an adapter factory receives. */
export interface SourceConnectionSettings {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly connectionId: string;
  readonly kind: ConnectorKind;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialName?: string;
}

/** A secret as adapters see it: revealed only at the point of use, never logged. */
export interface RevealableSecret {
  reveal(): string;
}

/**
 * How an adapter is registered under its kind (ADR 0019 §4). The composition
 * root provides the factories; a process refuses to synchronise a connection
 * whose kind has none.
 */
export interface SourceAdapterFactory {
  readonly kind: ConnectorKind;
  readonly adapterVersion: string;
  /** Validates the adapter's non-secret connection configuration. */
  validateConfig(config: unknown): { ok: true } | { ok: false; issues: readonly string[] };
  create(
    settings: SourceConnectionSettings,
    deps: { readonly resolveCredential: (name: string) => Promise<RevealableSecret> },
  ): SourceConnector;
}
