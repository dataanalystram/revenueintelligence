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
  type SourceObject,
  type SourcePage,
  type SourceRecord,
  type SourceSchema,
} from '../../domain';
import { SugarError } from '../errors';
import {
  SugarHttpClient,
  type SugarHttpDeps,
  type SugarTransportCounters,
} from '../infrastructure/sugar-http';
import {
  normaliseSugarField,
  SugarCountResponseSchema,
  SugarFieldsResponseSchema,
  SugarListResponseSchema,
  SugarPingResponseSchema,
  SugarPrimitiveSchema,
  SugarRecordResponseSchema,
} from '../infrastructure/sugar-schemas';
import { SugarConnectionConfigSchema, type SugarConnectionConfig } from '../sugar.config';

export const SUGAR_ADAPTER_VERSION = 'sugar-m8.0';
/** Sugar's modification-time field (LIVE: precision and time zone). */
const CHANGE_FIELD = 'date_modified';
const MAX_IDS_PER_READ = 100;

/**
 * The SugarCRM reference adapter (ADR 0021): implements the generic port,
 * never derives business meaning (no state inference, no Closed Won ⇒
 * active), reads mapped fields only, and is read-only by construction.
 */
export class SugarConnector implements SourceConnector {
  private readonly http: SugarHttpClient;

  constructor(
    private readonly config: SugarConnectionConfig,
    connectionKey: string,
    credentials: () => Promise<RevealableSecret>,
    deps: SugarHttpDeps = {},
  ) {
    this.http = new SugarHttpClient(config, connectionKey, credentials, deps);
  }

  get counters(): SugarTransportCounters {
    return this.http.counters;
  }

  capabilities(): ConnectorCapabilities {
    return {
      kind: 'sugar',
      adapterVersion: SUGAR_ADAPTER_VERSION,
      readOnly: true,
      singleRecordRead: true,
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      await this.http.get('/ping', undefined, SugarPingResponseSchema);
      return { ok: true, code: 'ok', sourceVersion: this.config.apiVersion };
    } catch (err) {
      if (!(err instanceof SugarError)) throw err;
      const code =
        err.kind === 'unauthorized' || err.kind === 'not_configured'
          ? 'auth_failed'
          : err.kind === 'forbidden'
            ? 'forbidden'
            : err.kind === 'timeout' || err.kind === 'network'
              ? 'unreachable'
              : err.kind === 'invalid_payload'
                ? 'invalid_response'
                : 'failed';
      return { ok: false, code };
    }
  }

  async describeSchema(): Promise<SourceSchema> {
    const objects: SourceObject[] = [];
    for (const module of this.config.modules) {
      const response = await this.http.get(
        `/${module}/fields`,
        undefined,
        SugarFieldsResponseSchema,
      );
      const fields = Object.values(response.fields)
        .map((def) => normaliseSugarField(module, def))
        .filter((f) => f !== undefined);
      objects.push({
        name: module,
        classification: this.config.internalModules.includes(module)
          ? 'internal_principal'
          : this.config.referenceModules.includes(module)
            ? 'reference'
            : 'record',
        capabilities: {
          pagination: 'offset',
          ...(fields.some((f) => f.name === CHANGE_FIELD) ? { changeField: CHANGE_FIELD } : {}),
          // Unproven until the live gate: deletions come from the full-run tombstone pass.
          deleteVisibility: 'none',
          count: this.config.countSupported,
          maxPageSize: this.config.pageSize,
        },
        fields,
      });
    }
    return normaliseSourceSchema({ sourceVersion: this.config.apiVersion, objects });
  }

  async readRecords(request: ReadRequest): Promise<SourcePage> {
    assertApiName(request.object);
    request.fields.forEach(assertApiName);
    const pageSize = Math.min(request.pageSize, this.config.pageSize);
    const offset = request.position === undefined ? 0 : Number(request.position);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new SugarError('bad_request', 'Invalid read position');
    }
    if (request.selection.mode === 'ids' && request.selection.ids.length > MAX_IDS_PER_READ) {
      throw new SugarError('bad_request', `At most ${MAX_IDS_PER_READ} ids per read`);
    }
    const query = filterQuery(request.selection);
    query.set('fields', [...new Set(['id', CHANGE_FIELD, ...request.fields])].join(','));
    query.set('order_by', `${CHANGE_FIELD}:ASC,id:ASC`);
    query.set('max_num', String(pageSize));
    query.set('offset', String(offset));
    const page = await this.http.get(`/${request.object}`, query, SugarListResponseSchema);
    const records = page.records.map((raw) => toRecord(request.object, raw, request.fields));
    const done = page.next_offset < 0 || records.length < pageSize;
    return { records, ...(done ? {} : { next: String(page.next_offset) }) };
  }

  async countRecords(request: Pick<ReadRequest, 'object' | 'selection'>): Promise<number> {
    assertApiName(request.object);
    if (!this.config.countSupported) {
      throw new SugarError('unsupported_endpoint', 'Counting is not enabled for this connection');
    }
    const response = await this.http.get(
      `/${request.object}/count`,
      filterQuery(request.selection),
      SugarCountResponseSchema,
    );
    return response.record_count;
  }

  async readRecord(
    object: string,
    id: string,
    fields: readonly string[],
  ): Promise<SourceRecord | undefined> {
    assertApiName(object);
    fields.forEach(assertApiName);
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(id))
      throw new SugarError('bad_request', 'Invalid record id');
    const query = new URLSearchParams({ fields: ['id', CHANGE_FIELD, ...fields].join(',') });
    try {
      const raw = await this.http.get(`/${object}/${id}`, query, SugarRecordResponseSchema);
      return toRecord(object, raw, fields);
    } catch (err) {
      if (err instanceof SugarError && err.kind === 'not_found') return undefined;
      throw err;
    }
  }
}

function assertApiName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(name)) {
    throw new SugarError('bad_request', 'Invalid API name');
  }
}

/** Sugar filter syntax for a bounded selection (LIVE: operators and timestamp format). */
function filterQuery(selection: ReadSelection): URLSearchParams {
  const q = new URLSearchParams();
  const ts = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  switch (selection.mode) {
    case 'full':
      q.set(`filter[0][${CHANGE_FIELD}][$lte]`, ts(selection.boundary));
      break;
    case 'since':
      q.set(`filter[0][${CHANGE_FIELD}][$gte]`, ts(selection.since));
      q.set(`filter[1][${CHANGE_FIELD}][$lte]`, ts(selection.boundary));
      break;
    case 'ids':
      for (const id of selection.ids) {
        if (!/^[A-Za-z0-9_-]{1,255}$/.test(id))
          throw new SugarError('bad_request', 'Invalid record id');
        q.append('filter[0][id][$in][]', id);
      }
      break;
  }
  return q;
}

/** Validates one record at the boundary: requested fields present, primitive values only. */
function toRecord(
  object: string,
  raw: Record<string, unknown>,
  fields: readonly string[],
): SourceRecord {
  const values: Record<string, string | number | boolean | null> = {};
  for (const field of new Set(['id', ...fields])) {
    if (!(field in raw)) {
      // A mapped field missing from the source's answer: drift mid-run, never reinterpreted.
      throw new SugarError('schema_drift', `${object} records no longer carry a mapped field`, {
        path: `/${object}`,
      });
    }
    const value = SugarPrimitiveSchema.safeParse(raw[field]);
    if (!value.success) {
      throw new SugarError('invalid_payload', `${object}.${field} is not a scalar value`, {
        path: `/${object}`,
      });
    }
    values[field] = value.data;
  }
  const modified = raw[CHANGE_FIELD];
  let modifiedAt: Date | undefined;
  if (typeof modified === 'string' && modified !== '') {
    // An explicit offset is required: a zone-less timestamp is ambiguous (LIVE).
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(modified) || Number.isNaN(Date.parse(modified))) {
      throw new SugarError('invalid_payload', `${object}.${CHANGE_FIELD} has no usable time zone`, {
        path: `/${object}`,
      });
    }
    modifiedAt = new Date(modified);
  }
  return {
    object,
    id: String(raw.id),
    ...(modifiedAt ? { modifiedAt } : {}),
    values,
  };
}

/** Registration of the Sugar adapter under its kind (composition roots only). */
export function sugarAdapterFactory(deps: SugarHttpDeps = {}): SourceAdapterFactory {
  return {
    kind: 'sugar',
    adapterVersion: SUGAR_ADAPTER_VERSION,
    validateConfig(config) {
      const parsed = SugarConnectionConfigSchema.safeParse(config);
      return parsed.success
        ? { ok: true }
        : {
            ok: false,
            issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
          };
    },
    create(settings: SourceConnectionSettings, { resolveCredential }) {
      const config = SugarConnectionConfigSchema.parse(settings.config);
      const name = settings.credentialName;
      return new SugarConnector(
        config,
        `${settings.tenantId}:${settings.connectionId}`,
        () => {
          if (!name)
            throw new SugarError('not_configured', 'The connection has no credential name');
          return resolveCredential(name);
        },
        deps,
      );
    },
  };
}
