import {
  classifyValue,
  isSubstantive,
  type ObservedType,
  type Representation,
} from './profiling/classifiers';
import { identityAbsentTrips, incompatibleTrips, type GuardStage } from './profiling/drift';
import type { ObjectMapping } from './source-mapping-document';
import type { SourceRecord } from './source-connector';

/**
 * Structural B guards for sync runs (M9A plan §8): fixed thresholds, never
 * configurable, evaluated before writes (once 20 records have been seen) and
 * before tombstones/coverage (whole run). Record-level protection (§9) is
 * separate and has no threshold.
 *
 * - `identity_field_absent`: the identity field, the account reference
 *   (primary and fallback both empty) or the product reference is null or
 *   empty in ≥ 50% of records;
 * - `type_incompatible`: ≥ 50% of a consequential field's values are in a
 *   class its mapping target cannot read;
 * - `representation_incompatible`: ≥ 50% of a representation-dependent field's
 *   values (explicit date formats) are in a representation it cannot read.
 */

export type RunGuardCode =
  'identity_field_absent' | 'type_incompatible' | 'representation_incompatible';

export interface RunGuardTrip {
  readonly code: RunGuardCode;
  readonly field: string;
  readonly seen: number;
  readonly failing: number;
}

interface Counter {
  seen: number;
  failing: number;
}

interface ValueRule {
  readonly field: string;
  readonly types: ReadonlySet<ObservedType>;
  readonly representations?: ReadonlySet<Representation>;
}

function empty(value: unknown): boolean {
  return (
    value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
  );
}

const DATE_REPS: ReadonlySet<Representation> = new Set(['date.iso']);
const DATETIME_REPS: ReadonlySet<Representation> = new Set([
  'timestamp.iso_z',
  'timestamp.iso_offset',
  'timestamp.iso_naive',
]);

/** The value rules a mapping implies (consequential, source-value-dependent entries). */
export function valueRulesFor(obj: ObjectMapping): ValueRule[] {
  const rules: ValueRule[] = [];
  for (const entry of obj.fields) {
    if (entry.kind !== 'core' || !('source' in entry)) continue;
    const parse = entry.transforms?.parse;
    if (entry.target === 'subscription.quantity') {
      rules.push({ field: entry.source, types: new Set<ObservedType>(['integer']) });
    } else if (
      (entry.target === 'subscription.startsAt' || entry.target === 'subscription.endsAt') &&
      parse?.type === 'timestamp'
    ) {
      // M9B: Unix seconds are integers (natively or as digit strings).
      rules.push({ field: entry.source, types: new Set<ObservedType>(['integer']) });
    } else if (entry.target === 'subscription.startsAt' || entry.target === 'subscription.endsAt') {
      rules.push({
        field: entry.source,
        types: new Set<ObservedType>(['date', 'timestamp']),
        ...(parse?.type === 'date'
          ? { representations: DATE_REPS }
          : parse?.type === 'datetime'
            ? { representations: DATETIME_REPS }
            : {}),
      });
    }
  }
  return rules;
}

/** Per-object guard counters for one run (counts only; values are discarded). */
export class RunGuards {
  private readonly identity: Counter = { seen: 0, failing: 0 };
  private readonly account: Counter = { seen: 0, failing: 0 };
  private readonly product: Counter = { seen: 0, failing: 0 };
  private readonly types = new Map<string, Counter>();
  private readonly reps = new Map<string, Counter>();
  private readonly rules: ValueRule[];
  private preWriteEvaluated = false;

  constructor(private readonly obj: ObjectMapping) {
    this.rules = valueRulesFor(obj);
  }

  observe(record: SourceRecord): void {
    if (record.deleted) return;
    const v = record.values;
    this.identity.seen += 1;
    if (empty(v[this.obj.identity.field])) this.identity.failing += 1;
    const accountRel = this.obj.relationships.find((r) => r.target === 'subscription.account');
    if (accountRel) {
      this.account.seen += 1;
      const fallback = accountRel.fallbackVia ? v[accountRel.fallbackVia.field] : undefined;
      if (empty(v[accountRel.field]) && empty(fallback)) this.account.failing += 1;
    }
    const productRel = this.obj.relationships.find((r) => r.target === 'subscription.product');
    if (productRel) {
      this.product.seen += 1;
      if (empty(v[productRel.field])) this.product.failing += 1;
    }
    for (const rule of this.rules) {
      const c = classifyValue(v[rule.field]);
      if (!isSubstantive(c.cls)) continue;
      const t = this.types.get(rule.field) ?? { seen: 0, failing: 0 };
      t.seen += 1;
      if (!rule.types.has(c.cls)) t.failing += 1;
      this.types.set(rule.field, t);
      if (rule.representations) {
        const r = this.reps.get(rule.field) ?? { seen: 0, failing: 0 };
        r.seen += 1;
        if (!c.rep || !rule.representations.has(c.rep)) r.failing += 1;
        this.reps.set(rule.field, r);
      }
    }
  }

  /**
   * The first tripped guard, or undefined. `pre_write` is evaluated once, the
   * first time 20 records have been seen; `pre_tombstone` covers the run.
   */
  check(stage: GuardStage): RunGuardTrip | undefined {
    if (stage === 'pre_write') {
      if (this.preWriteEvaluated || this.identity.seen < 20) return undefined;
      this.preWriteEvaluated = true;
    }
    const accountRel = this.obj.relationships.find((r) => r.target === 'subscription.account');
    const productRel = this.obj.relationships.find((r) => r.target === 'subscription.product');
    const identityChecks: Array<[string, Counter]> = [
      [this.obj.identity.field, this.identity],
      ...(accountRel ? ([[accountRel.field, this.account]] as Array<[string, Counter]>) : []),
      ...(productRel ? ([[productRel.field, this.product]] as Array<[string, Counter]>) : []),
    ];
    for (const [field, c] of identityChecks) {
      if (identityAbsentTrips(stage, c)) return { code: 'identity_field_absent', field, ...c };
    }
    for (const [field, c] of [...this.types].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (incompatibleTrips(stage, c)) return { code: 'type_incompatible', field, ...c };
    }
    for (const [field, c] of [...this.reps].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (incompatibleTrips(stage, c)) return { code: 'representation_incompatible', field, ...c };
    }
    return undefined;
  }
}
