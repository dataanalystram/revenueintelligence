import { createHash } from 'node:crypto';
import {
  classifyValue,
  isSubstantive,
  logicalClassOf,
  MAX_PARSED_LENGTH,
  type ClassifyContext,
  type ObservedType,
  type ParseFailure,
  type Representation,
} from './classifiers';
import type { SourceObject } from '../source-connector';
import { isIdentifierLike, piiHits, SAFE_CATEGORY, type PiiDetector } from './privacy';

/**
 * Bounded, mergeable per-field accumulators (M9A plan §3, §14). Every
 * component is a function of the multiset of values only, so any page split
 * and any merge order give the same result (property-tested). Raw values are
 * kept only as ≤ 51 categorical candidates of ≤ 64 characters; distinct
 * counting uses 52-bit hashes (exact up to the cap) and a HyperLogLog sketch.
 * Neither the hashes nor the sketch are ever persisted.
 */

export const ABSENT: unique symbol = Symbol('absent');
/** A field value as read, or `ABSENT` when the record has no such key. */
export type FieldInput = unknown;

export const DISTINCT_EXACT_CAP = 10_000;
const ELEMENT_EXACT_CAP = 1_000;
const LENGTH_EXACT = 1024;
/** Month buckets are shown only for spans under 2 years: more than 24 months means years. */
const MONTH_CAP = 24;
const YEAR_CAP = 200;

/** 52 bits of SHA-256 as a safe integer, plus 32 independent bits for the sketch. */
function hashOf(key: string): { h52: number; hi: number; lo: number } {
  const d = createHash('sha256').update(key).digest();
  const hi = d.readUInt32BE(0);
  const lo = d.readUInt32BE(4);
  const h52 = (hi & 0xfffff) * 0x100000000 + lo;
  return { h52, hi, lo };
}

/** Open-addressing set of 52-bit hashes in a Float64Array (8 bytes per slot). */
class HashSet52 {
  private slots = new Float64Array(64).fill(-1);
  size = 0;

  has(h: number): boolean {
    const mask = this.slots.length - 1;
    for (let i = h % this.slots.length; ; i = (i + 1) & mask) {
      const v = this.slots[i]!;
      if (v === -1) return false;
      if (v === h) return true;
    }
  }

  add(h: number): void {
    if ((this.size + 1) / this.slots.length > 0.7) this.grow();
    const mask = this.slots.length - 1;
    for (let i = h % this.slots.length; ; i = (i + 1) & mask) {
      const v = this.slots[i]!;
      if (v === h) return;
      if (v === -1) {
        this.slots[i] = h;
        this.size++;
        return;
      }
    }
  }

  values(): number[] {
    const out: number[] = [];
    for (const v of this.slots) if (v !== -1) out.push(v);
    return out;
  }

  private grow(): void {
    const old = this.slots;
    this.slots = new Float64Array(old.length * 2).fill(-1);
    this.size = 0;
    for (const v of old) if (v !== -1) this.add(v);
  }
}

/** HyperLogLog with 2^p registers (p = 14: 16 KiB, ~0.8% standard error). */
class HyperLogLog {
  readonly registers: Uint8Array;
  constructor(readonly p: number) {
    this.registers = new Uint8Array(1 << p);
  }

  add(hi: number, lo: number): void {
    const index = hi >>> (32 - this.p);
    // The remaining (32 - p) bits of `hi` followed by `lo`.
    const restHi = (hi << this.p) >>> 0;
    let rank: number;
    if (restHi !== 0) rank = Math.clz32(restHi) + 1;
    else rank = 32 - this.p + (lo !== 0 ? Math.clz32(lo) + 1 : 33);
    if (rank > this.registers[index]!) this.registers[index] = rank;
  }

  merge(other: HyperLogLog): void {
    for (let i = 0; i < this.registers.length; i++) {
      if (other.registers[i]! > this.registers[i]!) this.registers[i] = other.registers[i]!;
    }
  }

  estimate(): number {
    const m = this.registers.length;
    let sum = 0;
    let zeros = 0;
    for (const r of this.registers) {
      sum += 2 ** -r;
      if (r === 0) zeros++;
    }
    const alpha = 0.7213 / (1 + 1.079 / m);
    const raw = (alpha * m * m) / sum;
    if (raw <= 2.5 * m && zeros > 0) return Math.round(m * Math.log(m / zeros));
    return Math.round(raw);
  }
}

/** Exact up to `cap` distinct hashes, then the sketch estimate. */
class DistinctCounter {
  private exact: HashSet52 | undefined = new HashSet52();
  private readonly hll: HyperLogLog;
  constructor(
    private readonly cap: number,
    p: number,
  ) {
    this.hll = new HyperLogLog(p);
  }

  add(key: string): void {
    const { h52, hi, lo } = hashOf(key);
    this.hll.add(hi, lo);
    if (this.exact) {
      this.exact.add(h52);
      if (this.exact.size > this.cap) this.exact = undefined;
    }
  }

  merge(other: DistinctCounter): void {
    this.hll.merge(other.hll);
    if (this.exact && other.exact) {
      for (const h of other.exact.values()) this.exact.add(h);
      if (this.exact.size > this.cap) this.exact = undefined;
    } else {
      this.exact = undefined;
    }
  }

  result(): { value: number; method: 'exact' | 'estimate'; capped: boolean } {
    if (this.exact) return { value: this.exact.size, method: 'exact', capped: false };
    // The estimate is never reported below the cap it exceeded.
    return { value: Math.max(this.hll.estimate(), this.cap + 1), method: 'estimate', capped: true };
  }
}

/** Exact counts for small integers, then power-of-two buckets (lower bound reported). */
class LengthHistogram {
  private readonly exact = new Uint32Array(LENGTH_EXACT + 1);
  private readonly log = new Uint32Array(32);
  n = 0;
  min = Number.POSITIVE_INFINITY;
  max = 0;

  add(len: number): void {
    this.n++;
    if (len < this.min) this.min = len;
    if (len > this.max) this.max = len;
    if (len <= LENGTH_EXACT) this.exact[len]!++;
    else this.log[Math.min(31, Math.floor(Math.log2(len)))]!++;
  }

  merge(o: LengthHistogram): void {
    for (let i = 0; i < this.exact.length; i++) this.exact[i]! += o.exact[i]!;
    for (let i = 0; i < this.log.length; i++) this.log[i]! += o.log[i]!;
    this.n += o.n;
    this.min = Math.min(this.min, o.min);
    this.max = Math.max(this.max, o.max);
  }

  quantile(q: number): number {
    const target = Math.max(1, Math.ceil(q * this.n));
    let seen = 0;
    for (let i = 0; i < this.exact.length; i++) {
      seen += this.exact[i]!;
      if (seen >= target) return i;
    }
    for (let i = 0; i < this.log.length; i++) {
      seen += this.log[i]!;
      if (seen >= target) return 2 ** i;
    }
    return this.max;
  }

  summary(): { min: number; p50: number; p95: number; max: number } | null {
    if (this.n === 0) return null;
    return { min: this.min, p50: this.quantile(0.5), p95: this.quantile(0.95), max: this.max };
  }
}

function addCount<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function mergeCounts<K>(into: Map<K, number>, from: Map<K, number>): void {
  for (const [k, v] of from) addCount(into, k, v);
}

/** Bounded value→count map: dropped (overflow) once it exceeds `cap` distinct keys. */
class BoundedCounts {
  counts: Map<string, number> | undefined = new Map();
  constructor(private readonly cap: number) {}

  add(key: string, by = 1): void {
    if (!this.counts) return;
    addCount(this.counts, key, by);
    if (this.counts.size > this.cap) this.counts = undefined;
  }

  merge(o: BoundedCounts): void {
    if (!this.counts) return;
    if (!o.counts) {
      this.counts = undefined;
      return;
    }
    for (const [k, v] of o.counts) addCount(this.counts, k, v);
    if (this.counts.size > this.cap) this.counts = undefined;
  }
}

/** The string form a value is counted and (if safe) shown under: trimmed text. */
export function valueKey(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  try {
    return JSON.stringify(value)?.slice(0, MAX_PARSED_LENGTH) ?? '';
  } catch {
    return '';
  }
}

export interface AccumulatorOptions {
  readonly context?: ClassifyContext;
  /** List-element sub-accumulators are lighter and never nest further. */
  readonly element?: boolean;
  /** Declared enum option values: values outside them are counted (never kept). */
  readonly enumValues?: ReadonlySet<string>;
}

export class FieldAccumulator {
  rows = 0;
  absent = 0;
  nulls = 0;
  emptyString = 0;
  whitespaceOnly = 0;
  readonly types = new Map<ObservedType, number>();
  readonly representations = new Map<Representation, number>();
  readonly failures = new Map<ParseFailure, number>();
  readonly distinct: DistinctCounter;
  readonly candidates: BoundedCounts;
  anyValueTooLong = false;
  nonScalar = 0;
  readonly pii = new Map<PiiDetector, number>();
  identifierLike = 0;
  readonly lengths = new LengthHistogram();
  readonly numberBuckets = new Map<string, number>();
  years: Map<number, number> | undefined = new Map();
  readonly centuries = new Map<number, number>();
  months: Map<string, number> | undefined = new Map();
  /** Integers seen (native or string) and whether all are 0 or 1. */
  integers = 0;
  zeroOneOnly = true;
  // Lists and JSON objects.
  listValues = 0;
  readonly listElementCounts = new LengthHistogram();
  readonly delimiters = new Map<Representation, number>();
  readonly elements: FieldAccumulator | undefined;
  objectValues = 0;
  readonly keys = new BoundedCounts(SAFE_CATEGORY.candidateCap);
  maxDepth = 0;
  /** Substantive values outside the declared enum options (enum fields only). */
  notInEnum = 0;

  constructor(private readonly options: AccumulatorOptions = {}) {
    this.distinct = options.element
      ? new DistinctCounter(ELEMENT_EXACT_CAP, 10)
      : new DistinctCounter(DISTINCT_EXACT_CAP, 14);
    // A declared enum may legitimately show every option (§5.4: the enum bypasses the
    // cardinality condition), so its cap grows by the declared option count (≤ 2,000).
    this.candidates = new BoundedCounts(
      SAFE_CATEGORY.candidateCap + (options.enumValues?.size ?? 0),
    );
    this.elements = options.element ? undefined : new FieldAccumulator({ element: true });
  }

  /** Non-null, non-empty values (the `n` of §4.3 and §5.4). */
  get n(): number {
    let n = 0;
    for (const v of this.types.values()) n += v;
    return n;
  }

  add(input: FieldInput): void {
    this.rows++;
    if (input === ABSENT) {
      this.absent++;
      this.nulls++;
      return;
    }
    const c = classifyValue(input, this.options.context);
    for (const f of c.failures) addCount(this.failures, f);
    if (c.cls === 'null') {
      this.nulls++;
      return;
    }
    if (typeof c.length === 'number') this.lengths.add(c.length);
    if (c.cls === 'empty_string') {
      this.emptyString++;
      return;
    }
    if (c.cls === 'whitespace_only') {
      this.whitespaceOnly++;
      return;
    }
    if (!isSubstantive(c.cls)) return;
    addCount(this.types, c.cls);
    if (c.rep) addCount(this.representations, c.rep);
    const key = valueKey(input);
    this.distinct.add(key);
    if (this.options.enumValues && !this.options.enumValues.has(key)) this.notInEnum++;
    const scalar = c.cls !== 'array' && c.cls !== 'object';
    if (!scalar) this.nonScalar++;
    else if (key.length > SAFE_CATEGORY.maxValueLength) this.anyValueTooLong = true;
    else this.candidates.add(key);
    if (scalar && typeof input !== 'boolean' && key.length <= MAX_PARSED_LENGTH) {
      for (const d of piiHits(key)) addCount(this.pii, d);
      if (isIdentifierLike(key)) this.identifierLike++;
    }
    if (c.cls === 'integer') {
      this.integers++;
      if (c.number !== 0 && c.number !== 1) this.zeroOneOnly = false;
    }
    if (typeof c.number === 'number' && (c.cls === 'integer' || c.cls === 'decimal')) {
      addCount(this.numberBuckets, numberBucket(c.number));
    }
    if (c.yearMonth) {
      addCount(this.centuries, Math.floor(c.yearMonth.year / 100));
      if (this.years) {
        addCount(this.years, c.yearMonth.year);
        if (this.years.size > YEAR_CAP) this.years = undefined;
      }
      if (this.months) {
        addCount(this.months, `${c.yearMonth.year}-${String(c.yearMonth.month).padStart(2, '0')}`);
        if (this.months.size > MONTH_CAP) this.months = undefined;
      }
    }
    if (c.rep && logicalClassOf(c.rep) === 'list' && c.elements) {
      this.listValues++;
      this.listElementCounts.add(c.elements.length);
      if (c.rep.startsWith('list.delimited.')) addCount(this.delimiters, c.rep);
      if (this.elements) for (const e of c.elements) this.elements.add(e);
    }
    if (c.keys) {
      this.objectValues++;
      for (const k of c.keys) this.keys.add(k.slice(0, SAFE_CATEGORY.maxValueLength + 1));
    }
    if (c.depth && c.depth > this.maxDepth) this.maxDepth = c.depth;
  }

  merge(o: FieldAccumulator): this {
    this.rows += o.rows;
    this.absent += o.absent;
    this.nulls += o.nulls;
    this.emptyString += o.emptyString;
    this.whitespaceOnly += o.whitespaceOnly;
    mergeCounts(this.types, o.types);
    mergeCounts(this.representations, o.representations);
    mergeCounts(this.failures, o.failures);
    this.distinct.merge(o.distinct);
    this.candidates.merge(o.candidates);
    this.anyValueTooLong ||= o.anyValueTooLong;
    this.nonScalar += o.nonScalar;
    mergeCounts(this.pii, o.pii);
    this.identifierLike += o.identifierLike;
    this.lengths.merge(o.lengths);
    mergeCounts(this.numberBuckets, o.numberBuckets);
    mergeCounts(this.centuries, o.centuries);
    if (this.years && o.years) {
      mergeCounts(this.years, o.years);
      if (this.years.size > YEAR_CAP) this.years = undefined;
    } else {
      this.years = undefined;
    }
    if (this.months && o.months) {
      mergeCounts(this.months, o.months);
      if (this.months.size > MONTH_CAP) this.months = undefined;
    } else {
      this.months = undefined;
    }
    this.integers += o.integers;
    this.zeroOneOnly &&= o.zeroOneOnly;
    this.listValues += o.listValues;
    this.listElementCounts.merge(o.listElementCounts);
    mergeCounts(this.delimiters, o.delimiters);
    if (this.elements && o.elements) this.elements.merge(o.elements);
    this.objectValues += o.objectValues;
    this.keys.merge(o.keys);
    this.maxDepth = Math.max(this.maxDepth, o.maxDepth);
    this.notInEnum += o.notInEnum;
    return this;
  }

  piiTotal(): number {
    let t = 0;
    for (const v of this.pii.values()) t += v;
    return t;
  }
}

/** Sign and decimal order of magnitude; never the value. */
export function numberBucket(v: number): string {
  if (v === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(v)));
  return `${v < 0 ? '-' : '+'}1e${exp}`;
}

/** One object's accumulators: the selected fields, plus field names seen in data but not selected. */
export class ObjectAccumulator {
  rows = 0;
  readonly fields = new Map<string, FieldAccumulator>();
  /** Undeclared field names seen in data (names only; bounded). */
  readonly undeclared = new BoundedCounts(200);

  constructor(
    readonly fieldNames: readonly string[],
    options: Readonly<Record<string, AccumulatorOptions>> = {},
  ) {
    for (const f of fieldNames) this.fields.set(f, new FieldAccumulator(options[f] ?? {}));
  }

  addRecord(values: Readonly<Record<string, unknown>>, declared?: ReadonlySet<string>): void {
    this.rows++;
    for (const [name, acc] of this.fields) {
      acc.add(Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ABSENT);
    }
    if (declared) {
      for (const k of Object.keys(values)) {
        // Every undeclared key is tracked (bounded); names that cannot be stored are
        // counted, never listed, by the document builder (schema-name privacy).
        if (!this.fields.has(k) && !declared.has(k)) this.undeclared.add(k);
      }
    }
  }

  merge(o: ObjectAccumulator): this {
    this.rows += o.rows;
    for (const [name, acc] of this.fields) {
      const other = o.fields.get(name);
      if (other) acc.merge(other);
    }
    this.undeclared.merge(o.undeclared);
    return this;
  }
}

/** Worst-case accumulator bytes per field (§14.1), used for the request memory estimate. */
export const FIELD_MEMORY_BOUND_BYTES =
  // exact set (16,384 slots × 8 B at 10,000 entries) + HLL p14 + length histogram
  16_384 * 8 +
  16_384 +
  (LENGTH_EXACT + 33) * 4 +
  // candidates and JSON keys (51 × 64 chars each), month buckets, counters
  2 * 51 * 128 +
  (MONTH_CAP + YEAR_CAP + 100) * 48 +
  4_096 +
  // list-element sub-accumulator (exact set 2,048 slots + HLL p10 + candidates)
  2_048 * 8 +
  1_024 +
  51 * 128 +
  (LENGTH_EXACT + 33) * 4;

/** Accumulator options from the snapshot's declarations: declared type and enum values. */
export function accumulatorOptionsFor(
  object: SourceObject,
  fields: readonly string[],
): Record<string, AccumulatorOptions> {
  const out: Record<string, AccumulatorOptions> = {};
  for (const name of fields) {
    const f = object.fields.find((x) => x.name === name);
    if (!f) continue;
    out[name] = {
      context: { declaredType: f.type },
      ...(f.type === 'enum' && f.enumOptions
        ? { enumValues: new Set(f.enumOptions.map((o) => o.value.trim())) }
        : {}),
    };
  }
  return out;
}

/** A fresh object accumulator for the selected fields of a snapshot object. */
export function objectAccumulatorFor(
  object: SourceObject,
  fields: readonly string[],
): ObjectAccumulator {
  return new ObjectAccumulator(fields, accumulatorOptionsFor(object, fields));
}
