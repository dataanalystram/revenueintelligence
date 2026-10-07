import type { ObservedType, Representation } from './classifiers';

/**
 * Field-level technical suggestions (M9A plan §4.3). Advisory only: a
 * suggestion names a technical interpretation, never a canonical target, and
 * this module cannot reach mapping, authority or eligibility code
 * (`profiling-is-advisory`). Below n = 20 nothing is above `low`.
 */

export const INTERPRETATIONS = [
  'boolean',
  'single_select',
  'multi_select',
  'json_array',
  'json_object',
  'date',
  'timestamp',
  'integer',
  'decimal',
  'identifier',
  'free_text',
] as const;
export type Interpretation = (typeof INTERPRETATIONS)[number];
export type Confidence = 'high' | 'medium' | 'low';

export interface Suggestion {
  readonly interpretation: Interpretation;
  readonly confidence: Confidence;
  readonly evidence: string[];
}

export const SUGGESTION_MIN_VALUES = 20;

export interface SuggestionInput {
  /** Non-null, non-empty values. */
  readonly n: number;
  readonly declaredType: string;
  readonly declaredUnique: boolean;
  readonly types: ReadonlyMap<ObservedType, number>;
  readonly representations: ReadonlyMap<Representation, number>;
  readonly distinct: number;
  readonly cardinalityClass: CardinalityClass | null;
  readonly integers: number;
  readonly zeroOneOnly: boolean;
  readonly ambiguousDates: number;
  readonly leadingZero: number;
  readonly mixedRepresentation: boolean;
  readonly nonScalar: number;
  readonly listValues: number;
  readonly elementDistinct: number | null;
  readonly identifierLike: number;
  readonly lengthP50: number | null;
}

export type CardinalityClass = 'constant' | 'low' | 'medium' | 'high' | 'unique';

/** §3.2: constant (1) | unique (ratio ≥ 0.99) | high (> 0.5) | low (≤ 50 and ≤ 0.05) | medium. */
export function cardinalityClassOf(distinct: number, n: number): CardinalityClass | null {
  if (n === 0) return null;
  if (distinct === 1) return 'constant';
  const ratio = distinct / n;
  if (ratio >= 0.99) return 'unique';
  if (ratio > 0.5) return 'high';
  if (distinct <= 50 && ratio <= 0.05) return 'low';
  return 'medium';
}

const share = (count: number, n: number) => (n === 0 ? 0 : count / n);

function sumWhere<K extends string>(map: ReadonlyMap<K, number>, pred: (k: K) => boolean): number {
  let t = 0;
  for (const [k, v] of map) if (pred(k)) t += v;
  return t;
}

/** The dominant representation with a prefix, and its count. */
function dominant(
  reps: ReadonlyMap<Representation, number>,
  prefix: string,
): [Representation | undefined, number] {
  let best: Representation | undefined;
  let count = 0;
  for (const [k, v] of [...reps].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (k.startsWith(prefix) && v > count) {
      best = k;
      count = v;
    }
  }
  return [best, count];
}

export function suggestionsFor(s: SuggestionInput): Suggestion[] {
  const out: Suggestion[] = [];
  const n = s.n;
  if (n === 0) return out;
  const type = (t: ObservedType) => s.types.get(t) ?? 0;

  // boolean: ≥ 99% boolean tokens/natives, or exactly the integers {0, 1}; distinct ≥ 2; n ≥ 20.
  const boolCount = type('boolean');
  const boolReps = [...s.representations.keys()].filter((r) => r.startsWith('boolean.')).length;
  const viaTokens = share(boolCount, n) >= 0.99;
  const viaZeroOne =
    !viaTokens &&
    s.zeroOneOnly &&
    s.integers > 0 &&
    share(s.integers, n) >= 0.99 &&
    s.distinct === 2;
  if ((viaTokens || viaZeroOne) && s.distinct >= 2 && n >= SUGGESTION_MIN_VALUES) {
    out.push({
      interpretation: 'boolean',
      confidence: viaTokens && boolReps === 1 ? 'high' : 'medium',
      evidence: viaZeroOne
        ? ['integer_zero_one']
        : boolReps === 1
          ? ['boolean_single_representation']
          : ['boolean_mixed_representation'],
    });
  }

  // multi_select: ≥ 95% list-shaped, element distinct ≤ 50.
  const listShare = share(s.listValues, n);
  const multi = listShare >= 0.95 && s.elementDistinct !== null && s.elementDistinct <= 50;
  if (multi) {
    const structured = sumWhere(s.representations, (r) => r === 'list.native' || r === 'list.json');
    out.push({
      interpretation: 'multi_select',
      confidence: structured >= s.listValues / 2 ? 'high' : 'medium',
      evidence: [structured >= s.listValues / 2 ? 'list_structured' : 'list_delimited'],
    });
  }

  // single_select: scalar values; declared enum, or low cardinality.
  const scalar = s.nonScalar === 0 && listShare < 0.5;
  if (scalar && (s.declaredType === 'enum' || s.cardinalityClass === 'low')) {
    out.push({
      interpretation: 'single_select',
      confidence: s.declaredType === 'enum' ? 'high' : 'medium',
      evidence: [s.declaredType === 'enum' ? 'declared_enum' : 'cardinality_low'],
    });
  }

  if (!multi && share(type('json_array'), n) >= 0.95) {
    out.push({ interpretation: 'json_array', confidence: 'high', evidence: ['json_array_share'] });
  }
  if (share(type('json_object') + type('object'), n) >= 0.95) {
    out.push({
      interpretation: 'json_object',
      confidence: 'high',
      evidence: ['json_object_share'],
    });
  }

  // date: ≥ 99% dates in one representation.
  const [dateRep, dateCount] = dominant(s.representations, 'date.');
  if (dateRep && share(dateCount, n) >= 0.99) {
    let confidence: Confidence = dateRep === 'date.iso' ? 'high' : 'medium';
    if (s.mixedRepresentation && confidence === 'high') confidence = 'medium';
    if (s.ambiguousDates > 0) confidence = 'low';
    out.push({
      interpretation: 'date',
      confidence,
      evidence: [dateRep, ...(s.ambiguousDates > 0 ? ['ambiguous_date'] : [])],
    });
  }

  // timestamp: ≥ 99% timestamps.
  if (share(type('timestamp'), n) >= 0.99) {
    const naive = s.representations.get('timestamp.iso_naive') ?? 0;
    out.push({
      interpretation: 'timestamp',
      confidence: naive > type('timestamp') / 2 ? 'medium' : 'high',
      evidence: [naive > type('timestamp') / 2 ? 'timestamp_naive' : 'timestamp_zoned'],
    });
  }

  // integer / decimal: ≥ 99% of that class; leading zeros exclude.
  for (const cls of ['integer', 'decimal'] as const) {
    if (s.leadingZero > 0 || share(type(cls), n) < 0.99) continue;
    const native = s.representations.get(`${cls}.native`) ?? 0;
    out.push({
      interpretation: cls,
      confidence: native >= type(cls) / 2 ? 'high' : 'medium',
      evidence: [native >= type(cls) / 2 ? `${cls}_native` : `${cls}_string`],
    });
  }

  // identifier: ratio ≥ 0.99, declared id/unique, or ≥ 99% identifier-like.
  const idByRatio = n > 1 && share(s.distinct, n) >= 0.99;
  const idByDecl = s.declaredType === 'id' || s.declaredUnique;
  const idByShape = share(s.identifierLike, n) >= 0.99;
  if (idByRatio || idByDecl || idByShape) {
    out.push({
      interpretation: 'identifier',
      confidence: 'high',
      evidence: [
        ...(idByRatio ? ['distinct_ratio'] : []),
        ...(idByDecl ? ['declared_identifier'] : []),
        ...(idByShape ? ['identifier_shape'] : []),
      ],
    });
  }

  // free_text: high cardinality and p50 length > 32.
  if (
    (s.cardinalityClass === 'high' || s.cardinalityClass === 'unique') &&
    (s.lengthP50 ?? 0) > 32
  ) {
    out.push({ interpretation: 'free_text', confidence: 'medium', evidence: ['long_varied_text'] });
  }

  if (n < SUGGESTION_MIN_VALUES) return out.map((x) => ({ ...x, confidence: 'low' as const }));
  return out;
}
