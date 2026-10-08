import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableJson, type SourceField, type SourceObject } from '../source-connector';
import type { FieldAccumulator, ObjectAccumulator } from './accumulators';
import {
  logicalClassOf,
  OBSERVED_TYPES,
  PARSE_FAILURES,
  REPRESENTATIONS,
  type ObservedType,
  type Representation,
} from './classifiers';
import {
  assertNoRawValues,
  isExcludedName,
  isRedactedName,
  isSafeKeyName,
  PII_DETECTORS,
  profileNames,
  safeCategoryVerdict,
  sensitivityOf,
  SUPPRESSION_REASONS,
  type FieldSensitivity,
} from './privacy';
import { cardinalityClassOf, INTERPRETATIONS, suggestionsFor } from './suggestions';

/**
 * The profile document, version 1 (M9A plan §3). Aggregates only: counts,
 * ratios, classes, representation codes, buckets and — only under the
 * safe-category gate — categorical values. A document that fails this schema
 * or the raw-value scan is never persisted.
 */

export const PROFILE_DOCUMENT_VERSION = 1;
export const SAMPLING_METHODS = ['full', 'systematic', 'recent', 'head', 'sync'] as const;
export type SamplingMethod = (typeof SAMPLING_METHODS)[number];

const Count = z.number().int().min(0);
const Ratio = z.number().min(0).max(1);
const ApiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
const Code = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);
const countsOf = <T extends readonly [string, ...string[]]>(keys: T) =>
  z.partialRecord(z.enum(keys), Count);

const CategoricalSchema = z.strictObject({
  values: z.array(z.strictObject({ value: z.string().max(64), count: Count })).max(2000),
  suppressed: z.boolean(),
  reason: z.enum(SUPPRESSION_REASONS).nullable(),
});

const BucketsSchema = z
  .array(z.strictObject({ bucket: z.string().max(16), count: Count }))
  .max(200);

const FieldProfileSchema = z.strictObject({
  /**
   * The field's profile name, a value, not a key: field names may contain
   * secret-like words. A source name that cannot be stored (schema-name
   * detectors) is replaced by `redacted_field_<n>` and `nameRedacted` is set.
   */
  name: ApiName,
  nameRedacted: z.literal(true).optional(),
  declared: z.strictObject({
    type: z.string().max(32),
    sourceType: z.string().max(100).optional(),
    required: z.boolean(),
    unique: z.boolean(),
    nested: z.enum(['array', 'object']).nullable(),
    enumOptionCount: Count,
  }),
  sensitivity: z.enum(['normal', 'sensitive_by_name', 'sensitive_by_value', 'excluded_opt_in']),
  counts: z.strictObject({
    present: Count,
    null: Count,
    absent: Count,
    emptyString: Count,
    whitespaceOnly: Count,
    notInDeclaredEnum: Count.nullable(),
  }),
  nullRatio: Ratio,
  emptyRatio: Ratio,
  distinct: z.strictObject({
    value: Count,
    method: z.enum(['exact', 'estimate']),
    capped: z.boolean(),
  }),
  cardinalityClass: z.enum(['constant', 'low', 'medium', 'high', 'unique']).nullable(),
  observedTypes: countsOf(OBSERVED_TYPES),
  representations: countsOf(REPRESENTATIONS),
  parseFailures: countsOf(PARSE_FAILURES),
  detectors: z.strictObject({
    email: Count,
    phone: Count,
    card: Count,
    iban: Count,
    identifierLike: Count,
  }),
  length: z.strictObject({ min: Count, p50: Count, p95: Count, max: Count }).nullable(),
  range: z
    .strictObject({
      kind: z.enum(['date', 'number']),
      granularity: z.enum(['month', 'year', 'century', 'magnitude']),
      buckets: BucketsSchema,
    })
    .nullable(),
  categorical: CategoricalSchema,
  list: z
    .strictObject({
      share: Ratio,
      elements: z.strictObject({ min: Count, p50: Count, max: Count }),
      delimiter: z.enum(REPRESENTATIONS).nullable(),
      elementTypes: countsOf(OBSERVED_TYPES),
      elementDistinct: z.strictObject({
        value: Count,
        method: z.enum(['exact', 'estimate']),
        capped: z.boolean(),
      }),
      elementCategorical: CategoricalSchema,
    })
    .optional(),
  json: z
    .strictObject({
      share: Ratio,
      topLevelKeys: z.union([
        z.array(z.string().max(64)).max(51),
        z.strictObject({ count: Count, suppressed: z.literal(true) }),
      ]),
      maxDepth: Count,
    })
    .optional(),
  suggestions: z
    .array(
      z.strictObject({
        interpretation: z.enum(INTERPRETATIONS),
        confidence: z.enum(['high', 'medium', 'low']),
        evidence: z.array(Code).max(8),
      }),
    )
    .max(INTERPRETATIONS.length),
});
export type FieldProfile = z.infer<typeof FieldProfileSchema>;

export const ProfileDocumentSchema = z.strictObject({
  v: z.literal(PROFILE_DOCUMENT_VERSION),
  object: ApiName,
  connectionKind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  schemaSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  sampling: z.strictObject({
    method: z.enum(SAMPLING_METHODS),
    rowsRead: Count,
    populationEstimate: Count.nullable(),
    coverage: Ratio.nullable(),
    bounded: z.boolean(),
    stride: z.number().int().min(1).nullable(),
    orderedBy: ApiName.nullable(),
    evidence: z.array(Code).max(8),
  }),
  limits: z.strictObject({ maxRows: Count, fieldsProfiled: Count, distinctCap: Count }),
  /** Sorted by name. */
  fields: z.array(FieldProfileSchema).max(500),
  /** Field names seen in data but not declared by the snapshot (names only, storable names only). */
  undeclaredFields: z.array(ApiName).max(200),
  /** Undeclared names that cannot be stored (schema-name detectors): counted, never listed. */
  undeclaredFieldsRedacted: Count.optional(),
});
export type ProfileDocument = z.infer<typeof ProfileDocumentSchema>;

export class ProfileDocumentInvalidError extends Error {
  readonly code = 'profile_document_invalid';
  constructor(readonly issues: string[]) {
    super(`profile document failed validation: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'ProfileDocumentInvalidError';
  }
}

/** SHA-256 of the stable JSON of a document (the persisted content hash). */
export function profileContentHash(document: ProfileDocument): string {
  return createHash('sha256').update(stableJson(document)).digest('hex');
}

function sortedRecord<K extends string>(map: ReadonlyMap<K, number>): Partial<Record<K, number>> {
  return Object.fromEntries(
    [...map].filter(([, v]) => v > 0).sort(([a], [b]) => (a < b ? -1 : 1)),
  ) as Partial<Record<K, number>>;
}

function hasMixedRepresentation(reps: ReadonlyMap<Representation, number>, n: number): boolean {
  const byClass = new Map<string, number>();
  for (const [rep, count] of reps) {
    const logical = logicalClassOf(rep);
    if (logical === 'other') continue;
    if (count >= 5 && count / n >= 0.01) byClass.set(logical, (byClass.get(logical) ?? 0) + 1);
  }
  return [...byClass.values()].some((c) => c >= 2);
}

function categorical(
  acc: FieldAccumulator,
  sensitivity: FieldSensitivity,
  declaredEnum: boolean,
): z.infer<typeof CategoricalSchema> {
  const distinct = acc.distinct.result();
  const n = acc.n;
  const reason = safeCategoryVerdict({
    sensitivity,
    declaredEnum,
    n,
    distinct: distinct.value,
    candidatesComplete: acc.candidates.counts !== undefined && acc.nonScalar === 0,
    anyValueTooLong: acc.anyValueTooLong,
    piiValueHits: acc.piiTotal(),
    identifierLikeHits: acc.identifierLike,
  });
  if (reason !== null || !acc.candidates.counts) {
    return { values: [], suppressed: true, reason: reason ?? 'cardinality' };
  }
  const values = [...acc.candidates.counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([value, count]) => ({ value, count }));
  return { values, suppressed: false, reason: null };
}

function dateRange(acc: FieldAccumulator): FieldProfile['range'] {
  if (acc.months && acc.months.size > 0) {
    const keys = [...acc.months.keys()].sort();
    const toIndex = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7));
    if (toIndex(keys[keys.length - 1]!) - toIndex(keys[0]!) < 24) {
      return {
        kind: 'date',
        granularity: 'month',
        buckets: keys.map((bucket) => ({ bucket, count: acc.months!.get(bucket)! })),
      };
    }
  }
  if (acc.years && acc.years.size > 0) {
    return {
      kind: 'date',
      granularity: 'year',
      buckets: [...acc.years]
        .sort(([a], [b]) => a - b)
        .map(([y, count]) => ({ bucket: String(y).padStart(4, '0'), count })),
    };
  }
  if (acc.centuries.size > 0) {
    return {
      kind: 'date',
      granularity: 'century',
      buckets: [...acc.centuries]
        .sort(([a], [b]) => a - b)
        .map(([c, count]) => ({ bucket: `${String(c).padStart(2, '0')}xx`, count })),
    };
  }
  return null;
}

function numberRange(acc: FieldAccumulator): FieldProfile['range'] {
  if (acc.numberBuckets.size === 0) return null;
  const exponent = (b: string) => (b === '0' ? Number.NEGATIVE_INFINITY : Number(b.slice(3)));
  const sign = (b: string) => (b === '0' ? 0 : b.startsWith('-') ? -1 : 1);
  let entries = [...acc.numberBuckets];
  if (entries.length > 200) {
    // Coarsen to decades of magnitude (bounded document, still no exact values).
    const coarse = new Map<string, number>();
    for (const [b, count] of entries) {
      const key = b === '0' ? '0' : `${b[0]}1e${Math.floor(exponent(b) / 10) * 10}`;
      coarse.set(key, (coarse.get(key) ?? 0) + count);
    }
    entries = [...coarse];
  }
  // Ascending by value: large negatives, …, 0, …, large positives.
  const order = (k: string) => (sign(k) === 0 ? 0 : sign(k) * (1000 + exponent(k)));
  entries.sort(([a], [b]) => order(a) - order(b));
  return {
    kind: 'number',
    granularity: 'magnitude',
    buckets: entries.slice(0, 200).map(([bucket, count]) => ({ bucket, count })),
  };
}

export interface BuildProfileInput {
  readonly object: SourceObject;
  readonly connectionKind: string;
  readonly schemaSnapshotHash: string;
  readonly accumulator: ObjectAccumulator;
  readonly sampling: {
    readonly method: SamplingMethod;
    readonly populationEstimate: number | null;
    readonly bounded: boolean;
    readonly stride: number | null;
    readonly orderedBy: string | null;
    readonly evidence: readonly string[];
  };
  readonly maxRows: number;
  readonly distinctCap: number;
  /** Excluded fields the operator opted in to (shape and counts only). */
  readonly optedIn: ReadonlySet<string>;
}

function fieldProfile(
  field: SourceField,
  acc: FieldAccumulator,
  optedIn: boolean,
  rows: number,
): FieldProfile {
  const n = acc.n;
  const distinct = acc.distinct.result();
  const declaredEnum = field.type === 'enum';
  const sensitivity = sensitivityOf({
    name: field.name,
    optedIn: optedIn || isExcludedName(field.name),
    piiValueHits: acc.piiTotal(),
    n,
  });
  const cardinality = cardinalityClassOf(distinct.value, n);
  const mixedRepresentation = n > 0 && hasMixedRepresentation(acc.representations, n);
  const length = acc.lengths.summary();
  const range =
    (acc.types.get('date') ?? 0) + (acc.types.get('timestamp') ?? 0) > 0
      ? dateRange(acc)
      : numberRange(acc);
  const elements = acc.elements;
  const elementDistinct = elements ? elements.distinct.result() : undefined;
  const profile: FieldProfile = {
    name: field.name,
    declared: {
      type: field.type,
      ...(field.sourceType ? { sourceType: field.sourceType } : {}),
      required: field.required,
      unique: field.unique,
      nested: field.nested ?? null,
      enumOptionCount: field.enumOptions?.length ?? 0,
    },
    sensitivity,
    counts: {
      present: acc.rows - acc.nulls,
      null: acc.nulls,
      absent: acc.absent,
      emptyString: acc.emptyString,
      whitespaceOnly: acc.whitespaceOnly,
      notInDeclaredEnum: field.enumOptions ? acc.notInEnum : null,
    },
    nullRatio: rows === 0 ? 0 : acc.nulls / rows,
    emptyRatio: rows === 0 ? 0 : (acc.emptyString + acc.whitespaceOnly) / rows,
    distinct,
    cardinalityClass: cardinality,
    observedTypes: sortedRecord(acc.types),
    representations: sortedRecord(acc.representations),
    parseFailures: sortedRecord(acc.failures),
    detectors: {
      ...(Object.fromEntries(PII_DETECTORS.map((d) => [d, acc.pii.get(d) ?? 0])) as Record<
        (typeof PII_DETECTORS)[number],
        number
      >),
      identifierLike: acc.identifierLike,
    },
    length,
    range,
    categorical: categorical(acc, sensitivity, declaredEnum),
    suggestions: suggestionsFor({
      n,
      declaredType: field.type,
      declaredUnique: field.unique,
      types: acc.types,
      representations: acc.representations,
      distinct: distinct.value,
      cardinalityClass: cardinality,
      integers: acc.integers,
      zeroOneOnly: acc.zeroOneOnly,
      ambiguousDates: acc.failures.get('ambiguous_date') ?? 0,
      leadingZero: acc.failures.get('leading_zero_numeric') ?? 0,
      mixedRepresentation,
      nonScalar: acc.nonScalar,
      listValues: acc.listValues,
      elementDistinct: elementDistinct?.value ?? null,
      identifierLike: acc.identifierLike,
      lengthP50: length?.p50 ?? null,
    }),
  };
  if (acc.listValues > 0 && elements && elementDistinct) {
    const counts = acc.listElementCounts.summary();
    const delimiter =
      [...acc.delimiters].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0]?.[0] ?? null;
    return {
      ...profile,
      list: {
        share: acc.listValues / n,
        elements: counts
          ? { min: counts.min, p50: counts.p50, max: counts.max }
          : { min: 0, p50: 0, max: 0 },
        delimiter,
        elementTypes: sortedRecord(elements.types),
        elementDistinct,
        // Elements pass the same gate; a field-level sensitivity applies to its elements.
        elementCategorical: categorical(
          elements,
          sensitivity === 'normal'
            ? sensitivityOf({
                name: field.name,
                optedIn: false,
                piiValueHits: elements.piiTotal(),
                n: elements.n,
              })
            : sensitivity,
          false,
        ),
      },
      ...(acc.objectValues > 0 ? { json: jsonSummary(acc, sensitivity) } : {}),
    };
  }
  if (acc.objectValues > 0) return { ...profile, json: jsonSummary(acc, sensitivity) };
  return profile;
}

function jsonSummary(
  acc: FieldAccumulator,
  sensitivity: FieldSensitivity,
): NonNullable<FieldProfile['json']> {
  const keys = acc.keys.counts ? [...acc.keys.counts.keys()].sort() : undefined;
  const safe = sensitivity === 'normal' && keys !== undefined && keys.every(isSafeKeyName);
  return {
    share: acc.n === 0 ? 0 : acc.objectValues / acc.n,
    topLevelKeys: safe ? keys : { count: keys?.length ?? 52, suppressed: true },
    maxDepth: acc.maxDepth,
  };
}

/**
 * Builds and checks one object's profile: privacy pass (gate) → Zod → the
 * independent raw-value scan. Throws `ProfileDocumentInvalidError` or
 * `ProfilePrivacyViolationError`; the caller then fails the run.
 */
export function buildProfileDocument(input: BuildProfileInput): ProfileDocument {
  const acc = input.accumulator;
  const rows = acc.rows;
  // Source names are source-controlled content: every stored name is a profile name.
  const names = profileNames(input.object.fields.map((f) => f.name));
  const fields: FieldProfile[] = [];
  for (const name of acc.fields.keys()) {
    const field = input.object.fields.find((f) => f.name === name);
    if (!field) throw new ProfileDocumentInvalidError(['a profiled field is not declared']);
    const profile = fieldProfile(field, acc.fields.get(name)!, input.optedIn.has(name), rows);
    const profileName = names.toProfile(name);
    fields.push(
      profileName === name ? profile : { ...profile, name: profileName, nameRedacted: true },
    );
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const undeclared = acc.undeclared.counts ? [...acc.undeclared.counts.keys()] : [];
  const undeclaredSafe = undeclared.filter((n) => !isRedactedName(n)).sort();
  const undeclaredRedacted = undeclared.length - undeclaredSafe.length;
  const population = input.sampling.populationEstimate;
  const coverage =
    population === null ? null : population === 0 ? 1 : Math.min(1, rows / population);
  const document = {
    v: PROFILE_DOCUMENT_VERSION,
    object: input.object.name,
    connectionKind: input.connectionKind,
    schemaSnapshotHash: input.schemaSnapshotHash,
    sampling: {
      method: input.sampling.method,
      rowsRead: rows,
      populationEstimate: population,
      coverage,
      bounded: input.sampling.bounded,
      stride: input.sampling.stride,
      orderedBy:
        input.sampling.orderedBy === null ? null : names.toProfile(input.sampling.orderedBy),
      evidence: [...input.sampling.evidence].sort(),
    },
    limits: {
      maxRows: input.maxRows,
      fieldsProfiled: acc.fields.size,
      distinctCap: input.distinctCap,
    },
    fields,
    undeclaredFields: undeclaredSafe,
    ...(undeclaredRedacted > 0 ? { undeclaredFieldsRedacted: undeclaredRedacted } : {}),
  };
  const parsed = ProfileDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new ProfileDocumentInvalidError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  assertNoRawValues(parsed.data);
  return parsed.data;
}

/** The observed classes of a field profile as a map (for drift and guards). */
export function observedTypesOf(f: FieldProfile): Map<ObservedType, number> {
  return new Map(Object.entries(f.observedTypes) as Array<[ObservedType, number]>);
}
