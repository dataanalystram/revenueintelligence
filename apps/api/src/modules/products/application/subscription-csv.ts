import type { z } from 'zod';
import { SubscriptionStateSchema } from '../../domain';

/**
 * Strict parsing of the operator subscription CSV (M7, ADR 0017 §4). Pure: no
 * database. Every row is validated; any error is reported by row number and
 * code and the whole file is refused (nothing is written). Values are never
 * echoed back in errors (they may identify accounts).
 *
 * Columns (header required, order free, no extra columns):
 *   record_id, account, product, state, starts_at, ends_at, quantity,
 *   source_updated_at, presence (optional: present | absent)
 *
 * Timestamps must carry an explicit offset (`Z` or `±hh:mm`): a date without a
 * zone is ambiguous at day boundaries and is refused rather than guessed.
 */

export const CSV_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxRows: 100_000,
  maxFieldLength: 400,
} as const;

const REQUIRED = [
  'record_id',
  'account',
  'product',
  'state',
  'starts_at',
  'ends_at',
  'quantity',
  'source_updated_at',
] as const;
const OPTIONAL = ['presence'] as const;

export type CsvErrorCode =
  | 'file_too_large'
  | 'invalid_encoding'
  | 'empty_file'
  | 'too_many_rows'
  | 'invalid_header'
  | 'unterminated_quote'
  | 'wrong_column_count'
  | 'field_too_long'
  | 'duplicate_record_id'
  | 'invalid_record_id'
  | 'missing_account'
  | 'missing_product'
  | 'invalid_state'
  | 'invalid_timestamp'
  | 'ambiguous_timezone'
  | 'invalid_period'
  | 'invalid_quantity'
  | 'invalid_presence';

export interface CsvError {
  /** 1-based line number in the file (the header is row 1); 0 = whole file. */
  readonly row: number;
  readonly code: CsvErrorCode;
  readonly column?: string;
}

export interface CsvLine {
  readonly row: number;
  readonly recordId: string;
  readonly presence: 'present' | 'absent';
  readonly account: string;
  readonly product: string;
  readonly state: z.infer<typeof SubscriptionStateSchema>;
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly quantity?: number;
  readonly sourceUpdatedAt?: Date;
}

export type CsvParseResult =
  | { readonly ok: true; readonly lines: readonly CsvLine[] }
  | { readonly ok: false; readonly errors: readonly CsvError[] };

const RECORD_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_REPORTED_ERRORS = 200;

/** Splits RFC 4180 CSV into records. Quotes may contain commas, quotes ("") and newlines. */
function records(text: string): { rows: { line: number; fields: string[] }[]; error?: CsvError } {
  const rows: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let i = 0;
  const endRecord = () => {
    fields.push(field);
    // A blank line is skipped (common at end of file).
    if (!(fields.length === 1 && fields[0] === '')) rows.push({ line: startLine, fields });
    fields = [];
    field = '';
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
      i += 1;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      fields.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      endRecord();
      i += 1;
      line += 1;
      startLine = line;
    } else if (c === '\n') {
      endRecord();
      line += 1;
      startLine = line;
    } else field += c;
    i += 1;
  }
  if (quoted) return { rows, error: { row: startLine, code: 'unterminated_quote' } };
  if (field !== '' || fields.length > 0) endRecord();
  return { rows };
}

function timestamp(value: string): Date | CsvErrorCode | undefined {
  if (value === '') return undefined;
  if (!ZONED_TIMESTAMP.test(value)) {
    return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(value)
      ? 'ambiguous_timezone'
      : 'invalid_timestamp';
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'invalid_timestamp';
  // Reject calendar overflow (e.g. 2026-02-30 silently becoming March 2).
  const [y, m, day] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== day) {
    return 'invalid_timestamp';
  }
  return d;
}

/** Decodes bytes as strict UTF-8 (BOM stripped) and parses the CSV. */
export function parseSubscriptionCsv(input: Uint8Array): CsvParseResult {
  if (input.byteLength > CSV_LIMITS.maxBytes) {
    return { ok: false, errors: [{ row: 0, code: 'file_too_large' }] };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(input);
  } catch {
    return { ok: false, errors: [{ row: 0, code: 'invalid_encoding' }] };
  }
  if (text.includes('\u0000')) return { ok: false, errors: [{ row: 0, code: 'invalid_encoding' }] };

  const { rows, error } = records(text);
  if (error) return { ok: false, errors: [error] };
  if (rows.length === 0) return { ok: false, errors: [{ row: 0, code: 'empty_file' }] };
  if (rows.length - 1 > CSV_LIMITS.maxRows)
    return { ok: false, errors: [{ row: 0, code: 'too_many_rows' }] };

  const header = rows[0]!.fields.map((h) => h.trim().toLowerCase());
  const allowed = new Set<string>([...REQUIRED, ...OPTIONAL]);
  if (
    new Set(header).size !== header.length ||
    header.some((h) => !allowed.has(h)) ||
    REQUIRED.some((r) => !header.includes(r))
  ) {
    return { ok: false, errors: [{ row: rows[0]!.line, code: 'invalid_header' }] };
  }
  const col = (name: string) => header.indexOf(name);

  const errors: CsvError[] = [];
  const lines: CsvLine[] = [];
  const seen = new Set<string>();
  for (const { line, fields } of rows.slice(1)) {
    if (errors.length >= MAX_REPORTED_ERRORS) break;
    if (fields.length !== header.length) {
      errors.push({ row: line, code: 'wrong_column_count' });
      continue;
    }
    const long = header.find((h, idx) => fields[idx]!.length > CSV_LIMITS.maxFieldLength);
    if (long) {
      errors.push({ row: line, code: 'field_too_long', column: long });
      continue;
    }
    const get = (name: string) => (col(name) >= 0 ? fields[col(name)]!.trim() : '');
    const rowErrors: CsvError[] = [];
    const fail = (code: CsvErrorCode, column?: string) =>
      rowErrors.push({ row: line, code, ...(column ? { column } : {}) });

    const recordId = get('record_id');
    if (!RECORD_ID.test(recordId)) fail('invalid_record_id', 'record_id');
    else if (seen.has(recordId)) fail('duplicate_record_id', 'record_id');
    else seen.add(recordId);

    const presenceRaw = get('presence') || 'present';
    const presence =
      presenceRaw === 'present' || presenceRaw === 'absent' ? presenceRaw : undefined;
    if (!presence) fail('invalid_presence', 'presence');

    const account = get('account');
    const product = get('product');
    const stateParse = SubscriptionStateSchema.safeParse(get('state'));
    const dates: Record<string, Date | undefined> = {};
    for (const name of ['starts_at', 'ends_at', 'source_updated_at']) {
      const t = timestamp(get(name));
      if (typeof t === 'string') fail(t, name);
      else dates[name] = t;
    }
    let quantity: number | undefined;
    const q = get('quantity');
    if (q !== '') {
      quantity = /^\d{1,8}$/.test(q) ? Number(q) : NaN;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000_000)
        fail('invalid_quantity', 'quantity');
    }
    if (presence !== 'absent') {
      if (!account) fail('missing_account', 'account');
      if (!product) fail('missing_product', 'product');
      if (!stateParse.success) fail('invalid_state', 'state');
      const s = dates['starts_at'];
      const e = dates['ends_at'];
      if (s && e && s > e) fail('invalid_period', 'ends_at');
    }
    if (rowErrors.length) {
      errors.push(...rowErrors);
      continue;
    }
    lines.push({
      row: line,
      recordId,
      presence: presence!,
      account,
      product,
      state: stateParse.success ? stateParse.data : 'unknown',
      ...(dates['starts_at'] ? { startsAt: dates['starts_at'] } : {}),
      ...(dates['ends_at'] ? { endsAt: dates['ends_at'] } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(dates['source_updated_at'] ? { sourceUpdatedAt: dates['source_updated_at'] } : {}),
    });
  }
  return errors.length
    ? { ok: false, errors: errors.slice(0, MAX_REPORTED_ERRORS) }
    : { ok: true, lines };
}
