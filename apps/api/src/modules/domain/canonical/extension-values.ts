import { createHash } from 'node:crypto';
import { findSecretLike, findSecretLikeInJson } from '../security/secret-like';
import {
  currencyExponent,
  DEFAULT_EXTENSION_GUARDRAILS,
  EXTENSION_CODE_PATTERN,
  EXTENSION_ITEMS_CEILING,
  EXTENSION_JSON_MAX_BYTES_CEILING,
  EXTENSION_JSON_MAX_DEPTH_CEILING,
  EXTENSION_STRING_MAX_CHARS,
  EXTENSION_TEXT_MAX_CHARS,
  extensionTargetKind,
  type ExtensionArrayItemType,
  type ExtensionGuardrails,
  type ExtensionTargetKind,
  type ExtensionValueType,
  type JsonSchemaSubset,
} from './extension';
import { jsonbTextBytes } from './json-size';

/**
 * Extension value parsing (M10D plan §4.1 "type parse and constraints", V2):
 * one raw value (a source value after the closed transforms, or an operator's
 * CLI argument) against one field definition → the typed columns the writer
 * stores, or a closed rejection reason. Pure: no I/O. Reasons are codes only;
 * no value ever appears in a reason, so a reason can go into a run report,
 * a metric label or an audit detail unchanged.
 */

/** The parts of a stored field definition (registry projection) the parser reads. */
export interface ExtensionFieldSpec {
  readonly key: string;
  readonly valueType: ExtensionValueType;
  readonly constraints?: {
    readonly max_length?: number;
    readonly min?: number;
    readonly max?: number;
    readonly max_items?: number;
    readonly item_type?: ExtensionArrayItemType;
    readonly json_schema?: JsonSchemaSubset;
    readonly reference_to?: readonly string[];
    readonly currency?: string;
  };
  /** Enum codes with their status (retired codes are never written anew). */
  readonly allowedValues?: readonly { readonly code: string; readonly status: string }[];
}

/** Builds a spec from a projected registry definition (`tenant_registry_entries.definition`). */
export function fieldSpecFromDefinition(
  key: string,
  definition: Readonly<Record<string, unknown>>,
): ExtensionFieldSpec {
  const spec: {
    key: string;
    valueType: ExtensionValueType;
    constraints?: ExtensionFieldSpec['constraints'];
    allowedValues?: ExtensionFieldSpec['allowedValues'];
  } = { key, valueType: definition.value_type as ExtensionValueType };
  if (definition.constraints && typeof definition.constraints === 'object') {
    spec.constraints = definition.constraints;
  }
  if (Array.isArray(definition.allowed_values)) {
    spec.allowedValues = (definition.allowed_values as { code: string; status?: string }[]).map(
      (v) => ({ code: v.code, status: v.status ?? 'active' }),
    );
  }
  return spec;
}

/** Closed rejection reasons (`extension_value_invalid:<reason>`, run-report counters). */
export const EXTENSION_VALUE_REJECTIONS = [
  'type_invalid',
  'too_long',
  'below_min',
  'above_max',
  'not_integer',
  'number_out_of_range',
  'date_invalid',
  'currency_unknown',
  'currency_mismatch',
  'currency_required',
  'minor_not_integral',
  'enum_unknown',
  'enum_retired',
  'too_many_items',
  'duplicate_item',
  'item_invalid',
  'json_invalid',
  'json_too_large',
  'json_too_deep',
  'json_schema_mismatch',
  'reference_invalid',
  'reference_kind_not_allowed',
  'secret_like',
] as const;
export type ExtensionValueRejection = (typeof EXTENSION_VALUE_REJECTIONS)[number];

/** One collection item row (`tenant_extension_value_items`). */
export interface ParsedExtensionItem {
  readonly type: ExtensionArrayItemType;
  readonly text?: string;
  /** Canonical decimal string (number / integer items). */
  readonly number?: string;
  /** `YYYY-MM-DD`. */
  readonly date?: string;
  readonly enumCode?: string;
}

/** A reference value: an entity-index row (`target_key` only for products). */
export interface ExtensionReference {
  readonly kind: ExtensionTargetKind;
  readonly id?: string;
  readonly key?: string;
}

/** The typed columns of one value (exactly the type's columns set, plan §3.1). */
export type ParsedExtensionValue =
  | { readonly state: 'empty'; readonly type: ExtensionValueType }
  | {
      readonly state: 'present';
      readonly type: ExtensionValueType;
      readonly text?: string;
      readonly number?: string;
      readonly bool?: boolean;
      readonly date?: string;
      readonly ts?: Date;
      readonly moneyMinor?: string;
      readonly currency?: string;
      readonly enumCode?: string;
      readonly items?: readonly ParsedExtensionItem[];
      readonly json?: unknown;
      readonly ref?: ExtensionReference;
    };

export type ExtensionParseResult =
  | { readonly ok: true; readonly value: ParsedExtensionValue }
  | {
      readonly ok: false;
      readonly reason: ExtensionValueRejection;
      /** Secret-like pattern code (never the value) when `reason = secret_like`. */
      readonly pattern?: string;
    };

/** Explicitly empty (plan §4.1): `null` or an empty / whitespace-only string. `undefined` = no statement. */
export function isExplicitEmpty(raw: unknown): boolean {
  return raw === null || (typeof raw === 'string' && raw.trim() === '');
}

const reject = (reason: ExtensionValueRejection, pattern?: string): ExtensionParseResult => ({
  ok: false,
  reason,
  ...(pattern ? { pattern } : {}),
});

const DECIMAL = /^[+-]?(\d{1,40})(?:\.(\d{1,40}))?$/;
const INTEGER = /^[+-]?\d{1,40}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
/** numeric(…) has no fixed precision here; JavaScript comparison is safe within ±1e15. */
const NUMBER_LIMIT = 1e15;
const INT64_MAX = 9223372036854775807n;

/** A finite decimal in canonical form (`-0012.50` → `-12.5`), or undefined. */
export function canonicalDecimal(raw: unknown): string | undefined {
  let s: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return undefined;
    s = Math.abs(raw) >= 1e21 || (raw !== 0 && Math.abs(raw) < 1e-6) ? '' : String(raw);
    if (s === '') return undefined;
  } else if (typeof raw === 'string') {
    s = raw.trim();
  } else {
    return undefined;
  }
  const m = DECIMAL.exec(s);
  if (!m) return undefined;
  const negative = s.startsWith('-');
  const int = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  const body = frac ? `${int}.${frac}` : int;
  return negative && /[1-9]/.test(body) ? `-${body}` : body;
}

function parseDate(raw: unknown): string | undefined {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? undefined : raw.toISOString().slice(0, 10);
  }
  if (typeof raw !== 'string') return undefined;
  const m = ISO_DATE.exec(raw.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return undefined;
  }
  return raw.trim();
}

function parseDatetime(raw: unknown): Date | undefined {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw;
  if (typeof raw !== 'string' || !ISO_DATETIME.test(raw.trim())) return undefined;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function rangeCheck(
  n: number,
  c: ExtensionFieldSpec['constraints'],
): ExtensionValueRejection | undefined {
  if (c?.min !== undefined && n < c.min) return 'below_min';
  if (c?.max !== undefined && n > c.max) return 'above_max';
  return undefined;
}

function parseNumber(
  raw: unknown,
  integer: boolean,
  c: ExtensionFieldSpec['constraints'],
): { ok: true; number: string } | { ok: false; reason: ExtensionValueRejection } {
  if (typeof raw === 'boolean') return { ok: false, reason: 'type_invalid' };
  const s = canonicalDecimal(raw);
  if (s === undefined) return { ok: false, reason: 'type_invalid' };
  if (integer && !INTEGER.test(s)) return { ok: false, reason: 'not_integer' };
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > NUMBER_LIMIT) {
    return { ok: false, reason: 'number_out_of_range' };
  }
  const r = rangeCheck(n, c);
  return r ? { ok: false, reason: r } : { ok: true, number: s };
}

function enumCheck(
  code: unknown,
  spec: ExtensionFieldSpec,
): { ok: true; code: string } | { ok: false; reason: ExtensionValueRejection } {
  if (typeof code !== 'string') return { ok: false, reason: 'type_invalid' };
  const c = code.trim();
  if (!EXTENSION_CODE_PATTERN.test(c)) return { ok: false, reason: 'enum_unknown' };
  const found = spec.allowedValues?.find((v) => v.code === c);
  if (!found) return { ok: false, reason: 'enum_unknown' };
  if (found.status !== 'active') return { ok: false, reason: 'enum_retired' };
  return { ok: true, code: c };
}

/** A collection's raw items: an array, or a `;`-separated string (the M10C multi-value convention). */
function rawItems(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw as unknown[];
  if (typeof raw === 'string') {
    return raw
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  return undefined;
}

/** Depth of a JSON value (a scalar is 1; `{}` / `[]` are 1; each nesting level adds 1). */
export function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(jsonDepth));
  if (value !== null && typeof value === 'object') {
    return 1 + Math.max(0, ...Object.values(value as Record<string, unknown>).map(jsonDepth));
  }
  return 0;
}

function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > EXTENSION_JSON_MAX_DEPTH_CEILING + 1) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isPlainJson(v, depth + 1));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every((v) => isPlainJson(v, depth + 1));
  }
  return false;
}

/** Q8: validates a JSON value against the schema subset (no `pattern`, no `$ref`). */
export function matchesJsonSchema(schema: JsonSchemaSubset, value: unknown): boolean {
  if (schema.enum && !schema.enum.some((e) => e === value)) return false;
  switch (schema.type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return (
        typeof value === 'string' &&
        (schema.maxLength === undefined || [...value].length <= schema.maxLength)
      );
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (schema.type === 'integer' && !Number.isInteger(value)) return false;
      if (schema.minimum !== undefined && value < schema.minimum) return false;
      if (schema.maximum !== undefined && value > schema.maximum) return false;
      return true;
    case 'array':
      if (!Array.isArray(value)) return false;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
      return schema.items ? value.every((v) => matchesJsonSchema(schema.items!, v)) : true;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const obj = value as Record<string, unknown>;
      for (const r of schema.required ?? []) if (!Object.hasOwn(obj, r)) return false;
      for (const [k, sub] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(obj, k) && !matchesJsonSchema(sub, obj[k])) return false;
      }
      return true;
    }
  }
}

function parseMoney(
  raw: unknown,
  c: ExtensionFieldSpec['constraints'],
): ExtensionParseResult | { ok: true; minor: string; currency: string } {
  let amount: unknown;
  let minor: unknown;
  let currency: unknown;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    amount = o.amount;
    minor = o.minor;
    currency = o.currency;
  } else if (typeof raw === 'string') {
    // `12.34 EUR`, `EUR 12.34`, or a bare amount on a fixed-currency field.
    const s = raw.trim();
    const m = /^([A-Za-z]{3})\s+(\S+)$/.exec(s) ?? /^(\S+)\s+([A-Za-z]{3})$/.exec(s);
    if (m) {
      const [a, b] = [m[1]!, m[2]!];
      if (/^[A-Za-z]{3}$/.test(a)) [currency, amount] = [a, b];
      else [amount, currency] = [a, b];
    } else {
      amount = s;
    }
  } else if (typeof raw === 'number') {
    amount = raw;
  } else {
    return reject('type_invalid');
  }
  if (currency === undefined) currency = c?.currency;
  if (typeof currency !== 'string') return reject('currency_required');
  const code = currency.trim().toUpperCase();
  const exponent = currencyExponent(code);
  if (exponent === undefined) return reject('currency_unknown');
  if (c?.currency !== undefined && c.currency !== code) return reject('currency_mismatch');
  let minorUnits: bigint;
  if (minor !== undefined) {
    const s = typeof minor === 'number' || typeof minor === 'string' ? String(minor).trim() : '';
    if (!INTEGER.test(s)) return reject('minor_not_integral');
    minorUnits = BigInt(s);
  } else {
    const s = canonicalDecimal(amount);
    if (s === undefined) return reject('type_invalid');
    const [int, frac = ''] = s.replace('-', '').split('.');
    if (frac.length > exponent) return reject('minor_not_integral');
    minorUnits = BigInt(`${int}${frac.padEnd(exponent, '0')}`) * (s.startsWith('-') ? -1n : 1n);
  }
  if (minorUnits > INT64_MAX || minorUnits < -INT64_MAX) return reject('number_out_of_range');
  const n = Number(minorUnits);
  const r = rangeCheck(n, c);
  if (r) return reject(r);
  return { ok: true, minor: minorUnits.toString(), currency: code };
}

function parseReference(raw: unknown, spec: ExtensionFieldSpec): ExtensionParseResult {
  let kind: unknown;
  let ident: unknown;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    kind = o.kind;
    ident = o.id ?? o.key;
  } else if (typeof raw === 'string') {
    const i = raw.indexOf(':');
    if (i <= 0) return reject('reference_invalid');
    kind = raw.slice(0, i);
    ident = raw.slice(i + 1);
  } else {
    return reject('reference_invalid');
  }
  if (typeof kind !== 'string' || typeof ident !== 'string') return reject('reference_invalid');
  // `account` / `custom_object:<key>` (definition vocabulary) or the entity-index kind.
  const k = (extensionTargetKind(kind) ?? kind) as ExtensionTargetKind;
  const allowed = new Set((spec.constraints?.reference_to ?? []).map(extensionTargetKind));
  if (!allowed.has(k)) return reject('reference_kind_not_allowed');
  if (k === 'product') {
    if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(ident)) return reject('reference_invalid');
    return {
      ok: true,
      value: { state: 'present', type: 'reference', ref: { kind: k, key: ident } },
    };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ident)) {
    return reject('reference_invalid');
  }
  return {
    ok: true,
    value: { state: 'present', type: 'reference', ref: { kind: k, id: ident.toLowerCase() } },
  };
}

function parseItem(
  raw: unknown,
  itemType: ExtensionArrayItemType,
  spec: ExtensionFieldSpec,
):
  | { ok: true; item: ParsedExtensionItem }
  | { ok: false; reason: ExtensionValueRejection; pattern?: string } {
  const c = spec.constraints;
  switch (itemType) {
    case 'string': {
      if (typeof raw !== 'string' && typeof raw !== 'number')
        return { ok: false, reason: 'item_invalid' };
      const s = String(raw).trim();
      if (s === '') return { ok: false, reason: 'item_invalid' };
      const cap = Math.min(c?.max_length ?? EXTENSION_STRING_MAX_CHARS, EXTENSION_STRING_MAX_CHARS);
      if ([...s].length > cap) return { ok: false, reason: 'too_long' };
      return { ok: true, item: { type: 'string', text: s } };
    }
    case 'number':
    case 'integer': {
      const r = parseNumber(raw, itemType === 'integer', c);
      return r.ok ? { ok: true, item: { type: itemType, number: r.number } } : r;
    }
    case 'date': {
      const d = parseDate(raw);
      return d
        ? { ok: true, item: { type: 'date', date: d } }
        : { ok: false, reason: 'date_invalid' };
    }
    case 'enum': {
      const r = enumCheck(raw, spec);
      return r.ok ? { ok: true, item: { type: 'enum', enumCode: r.code } } : r;
    }
  }
}

/**
 * Parses one raw value for one field (plan §4.1 order: type parse and
 * constraints → guardrails → secret-like). `undefined` is not a statement
 * and must not reach the parser (the caller skips it); `null` / empty string
 * is an explicit empty.
 */
export function parseExtensionValue(
  spec: ExtensionFieldSpec,
  raw: unknown,
  guardrails: ExtensionGuardrails = DEFAULT_EXTENSION_GUARDRAILS,
): ExtensionParseResult {
  const type = spec.valueType;
  if (isExplicitEmpty(raw)) return { ok: true, value: { state: 'empty', type } };
  const c = spec.constraints;
  const present = (
    v: Omit<Extract<ParsedExtensionValue, { state: 'present' }>, 'state' | 'type'>,
  ) => ({ ok: true, value: { state: 'present', type, ...v } }) as ExtensionParseResult;
  switch (type) {
    case 'string':
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
        return reject('type_invalid');
      }
      const s = typeof raw === 'string' ? raw : String(raw);
      const ceiling = type === 'text' ? EXTENSION_TEXT_MAX_CHARS : EXTENSION_STRING_MAX_CHARS;
      const cap = Math.min(c?.max_length ?? ceiling, ceiling);
      if ([...s].length > cap) return reject('too_long');
      return present({ text: s });
    }
    case 'number':
    case 'integer': {
      const r = parseNumber(raw, type === 'integer', c);
      return r.ok ? present({ number: r.number }) : reject(r.reason);
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return present({ bool: raw });
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (s === 'true') return present({ bool: true });
        if (s === 'false') return present({ bool: false });
      }
      return reject('type_invalid');
    }
    case 'date': {
      const d = parseDate(raw);
      return d ? present({ date: d }) : reject('date_invalid');
    }
    case 'datetime': {
      const d = parseDatetime(raw);
      return d ? present({ ts: d }) : reject('date_invalid');
    }
    case 'money': {
      const r = parseMoney(raw, c);
      if (!r.ok) return r;
      if ('minor' in r) return present({ moneyMinor: r.minor, currency: r.currency });
      return reject('type_invalid');
    }
    case 'enum': {
      const r = enumCheck(raw, spec);
      return r.ok ? present({ enumCode: r.code }) : reject(r.reason);
    }
    case 'multi_enum':
    case 'array': {
      const items = rawItems(raw);
      if (!items) return reject('type_invalid');
      if (items.length === 0) return { ok: true, value: { state: 'empty', type } };
      const cap = Math.min(
        c?.max_items ?? guardrails.maxArrayItems,
        guardrails.maxArrayItems,
        EXTENSION_ITEMS_CEILING,
      );
      if (items.length > cap) return reject('too_many_items');
      const itemType: ExtensionArrayItemType =
        type === 'multi_enum' ? 'enum' : (c?.item_type ?? 'string');
      const parsed: ParsedExtensionItem[] = [];
      for (const it of items) {
        const r = parseItem(it, itemType, spec);
        if (!r.ok)
          return reject(r.reason === 'type_invalid' ? 'item_invalid' : r.reason, r.pattern);
        parsed.push(r.item);
      }
      if (type === 'multi_enum') {
        // Set semantics (plan §3.2): duplicates refused, order normalised.
        const codes = parsed.map((p) => p.enumCode!);
        if (new Set(codes).size !== codes.length) return reject('duplicate_item');
        parsed.sort((a, b) => (a.enumCode! < b.enumCode! ? -1 : a.enumCode! > b.enumCode! ? 1 : 0));
      }
      return present({ items: parsed });
    }
    case 'json': {
      let v: unknown = raw;
      if (typeof raw === 'string') {
        try {
          v = JSON.parse(raw);
        } catch {
          return reject('json_invalid');
        }
      }
      // A JSON `null` states "no value": an explicit empty (jsonb null is never stored).
      if (v === null) return { ok: true, value: { state: 'empty', type } };
      if (!isPlainJson(v)) return reject('json_invalid');
      const maxBytes = Math.min(guardrails.maxJsonBytes, EXTENSION_JSON_MAX_BYTES_CEILING);
      const maxDepth = Math.min(guardrails.maxJsonDepth, EXTENSION_JSON_MAX_DEPTH_CEILING);
      if (jsonDepth(v) > maxDepth) return reject('json_too_deep');
      if (jsonbTextBytes(v) > maxBytes) return reject('json_too_large');
      if (c?.json_schema && !matchesJsonSchema(c.json_schema, v)) {
        return reject('json_schema_mismatch');
      }
      return present({ json: v });
    }
    case 'reference':
      return parseReference(raw, spec);
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * SHA-256 of a parsed value (idempotency only, never a value): an unchanged
 * hash writes nothing (plan §4.1). Covers the state, the type and the typed
 * columns in a stable form.
 */
export function extensionValueHash(value: ParsedExtensionValue): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

/** The stored row's typed columns → the parsed form (for hashing a stored value and for reads). */
export interface StoredExtensionColumns {
  readonly valueType: string;
  readonly valueState: string;
  readonly valueText: string | null;
  readonly valueNumber: string | null;
  readonly valueBool: boolean | null;
  readonly valueDate: string | null;
  readonly valueTs: Date | null;
  readonly valueMoneyMinor: string | null;
  readonly valueCurrency: string | null;
  readonly valueEnum: string | null;
  readonly valueJson: unknown;
  readonly valueRefKind: string | null;
  readonly valueRefId: string | null;
  readonly valueRefKey: string | null;
}

export function parsedFromStored(
  row: StoredExtensionColumns,
  items: readonly ParsedExtensionItem[] = [],
): ParsedExtensionValue {
  const type = row.valueType as ExtensionValueType;
  if (row.valueState === 'empty') return { state: 'empty', type };
  const v: Record<string, unknown> = {};
  if (row.valueText !== null) v.text = row.valueText;
  if (row.valueNumber !== null) v.number = canonicalDecimal(row.valueNumber) ?? row.valueNumber;
  if (row.valueBool !== null) v.bool = row.valueBool;
  if (row.valueDate !== null) v.date = row.valueDate;
  if (row.valueTs !== null) v.ts = row.valueTs;
  if (row.valueMoneyMinor !== null) v.moneyMinor = row.valueMoneyMinor;
  if (row.valueCurrency !== null) v.currency = row.valueCurrency;
  if (row.valueEnum !== null) v.enumCode = row.valueEnum;
  if (type === 'multi_enum' || type === 'array') v.items = items;
  if (row.valueJson !== null && row.valueJson !== undefined) v.json = row.valueJson;
  if (row.valueRefKind !== null) {
    v.ref = {
      kind: row.valueRefKind,
      ...(row.valueRefId !== null ? { id: row.valueRefId } : {}),
      ...(row.valueRefKey !== null ? { key: row.valueRefKey } : {}),
    };
  }
  return { state: 'present', type, ...v };
}

/** A value as it may be shown (CLI / read model): plain JSON, money as minor units + currency. */
export function displayExtensionValue(value: ParsedExtensionValue): unknown {
  if (value.state === 'empty') return null;
  switch (value.type) {
    case 'string':
    case 'text':
      return value.text;
    case 'number':
    case 'integer':
      return value.number;
    case 'boolean':
      return value.bool;
    case 'date':
      return value.date;
    case 'datetime':
      return value.ts?.toISOString();
    case 'money':
      return { minor: value.moneyMinor, currency: value.currency };
    case 'enum':
      return value.enumCode;
    case 'multi_enum':
    case 'array':
      return (value.items ?? []).map((i) => i.text ?? i.number ?? i.date ?? i.enumCode);
    case 'json':
      return value.json;
    case 'reference':
      return value.ref;
  }
}
