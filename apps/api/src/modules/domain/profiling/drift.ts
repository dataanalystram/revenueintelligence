import type { ObservedType } from './classifiers';
import type { FieldProfile, ProfileDocument } from './document';
import { finding, type Finding } from './findings';

/**
 * Profile drift (M9A plan §8) and the fixed-threshold B guards used by sync.
 * Drift compares a profile with its baseline in the same sampling family.
 * Thresholds are constants in code: B thresholds are never configurable
 * (changing one needs an ADR note). Record-level protection (§9, §10) has no
 * threshold at all and does not live here.
 */

export const DRIFT_THRESHOLDS = Object.freeze({
  nullRatioShift: 0.1,
  newClassShare: 0.01,
  newRepresentationShare: 0.01,
  vanishedShare: 0.05,
  rowCountChange: 0.2,
  parseFailureRise: 0.01,
});

/** B guards (§8): fixed, not configurable. */
export const B_GUARD_THRESHOLDS = Object.freeze({
  /** Identity/reference null or empty share that fails the run. */
  identityAbsentShare: 0.5,
  /** Incompatible observed class (or unreadable representation) share that fails the run. */
  incompatibleShare: 0.5,
  /** The pre-write check runs once this many records (values) have been seen. */
  preWriteMinimum: 20,
});

export interface DriftContext {
  /** Fields a published mapping depends on (B classification applies to them). */
  readonly consequentialFields?: ReadonlySet<string>;
  /** Identity and reference fields (no null-ratio advisory). */
  readonly identityFields?: ReadonlySet<string>;
  /** Consequential fields whose mapping reads a representation (date format, value map, list parsing). */
  readonly representationDependent?: ReadonlySet<string>;
  /** Observed classes the mapping target can read, per consequential field. */
  readonly readableTypes?: Readonly<Record<string, ReadonlySet<ObservedType>>>;
}

/** Compatible observed-type changes (advisory). */
const COMPATIBLE_CHANGES: ReadonlyArray<[ObservedType, ObservedType]> = [
  ['integer', 'decimal'],
  ['date', 'timestamp'],
  ['string', 'text'],
];

function totals(f: FieldProfile): { n: number; types: Map<string, number> } {
  const types = new Map(
    Object.entries(f.observedTypes).map(([k, v]) => [k, v ?? 0] as [string, number]),
  );
  let n = 0;
  for (const v of types.values()) n += v;
  return { n, types };
}

function dominantOf(types: Map<string, number>): string | undefined {
  return [...types].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
}

function parseFailureRatio(f: FieldProfile, rows: number): number {
  if (rows === 0) return 0;
  const sum = Object.values(f.parseFailures).reduce((a, b) => a + (b ?? 0), 0);
  return sum / rows;
}

function populationOf(doc: ProfileDocument): number | null {
  if (doc.sampling.populationEstimate !== null) return doc.sampling.populationEstimate;
  return doc.sampling.method === 'full' && !doc.sampling.bounded ? doc.sampling.rowsRead : null;
}

/** Drift findings of `current` against `baseline` (same connection, object and family). */
export function driftFindings(
  current: ProfileDocument,
  baseline: ProfileDocument,
  ctx: DriftContext = {},
): Finding[] {
  const out: Finding[] = [];
  const r = (x: number) => Number(x.toFixed(4));
  const before = new Map(baseline.fields.map((f) => [f.name, f]));
  const fullBoth = current.sampling.method === 'full' && baseline.sampling.method === 'full';
  const popNow = populationOf(current);
  const popThen = populationOf(baseline);
  if (fullBoth && popNow !== null && popThen !== null && popThen > 0) {
    const change = Math.abs(popNow - popThen) / popThen;
    if (change >= DRIFT_THRESHOLDS.rowCountChange) {
      out.push(
        finding('profile_drift_row_count', null, {
          before: popThen,
          after: popNow,
          change: r(change),
        }),
      );
    }
  }
  for (const f of current.fields) {
    const name = f.name;
    const old = before.get(name);
    if (!old) continue;
    const consequential = ctx.consequentialFields?.has(name) ?? false;
    const identity = ctx.identityFields?.has(name) ?? false;
    // Null-rate shift (non-identity fields).
    const shift = Math.abs(f.nullRatio - old.nullRatio);
    if (!identity && shift >= DRIFT_THRESHOLDS.nullRatioShift) {
      out.push(
        finding('profile_drift_null_ratio', name, {
          before: r(old.nullRatio),
          after: r(f.nullRatio),
        }),
      );
    }
    // Observed types.
    const now = totals(f);
    const then = totals(old);
    const domNow = dominantOf(now.types);
    const domThen = dominantOf(then.types);
    const readable = ctx.readableTypes?.[name];
    if (consequential && readable && now.n > 0) {
      let incompatible = 0;
      for (const [t, c] of now.types) if (!readable.has(t as ObservedType)) incompatible += c;
      if (incompatible / now.n >= B_GUARD_THRESHOLDS.incompatibleShare) {
        out.push(
          finding('profile_drift_type_incompatible', name, {
            incompatible,
            values: now.n,
            share: r(incompatible / now.n),
          }),
        );
      }
    }
    if (domNow && domThen && domNow !== domThen) {
      const compatible = COMPATIBLE_CHANGES.some(([a, b]) => a === domThen && b === domNow);
      out.push(
        finding(
          compatible ? 'profile_drift_type_compatible' : 'profile_drift_type_distribution',
          name,
          {
            before: domThen,
            after: domNow,
          },
        ),
      );
    } else if (!consequential && now.n > 0) {
      const added = [...now.types].filter(
        ([t, c]) => !then.types.has(t) && c / now.n >= DRIFT_THRESHOLDS.newClassShare,
      );
      if (added.length > 0) {
        out.push(
          finding('profile_drift_type_distribution', name, { added: added.map(([t]) => t).sort() }),
        );
      }
    }
    // Representations: a new representation ≥ 1% (B when the mapping reads it and ≥ 50% is unreadable).
    if (now.n > 0) {
      const added = Object.entries(f.representations)
        .filter(
          ([rep, c]) =>
            old.representations[rep as keyof typeof old.representations] === undefined &&
            (c ?? 0) / now.n >= DRIFT_THRESHOLDS.newRepresentationShare,
        )
        .map(([rep, c]) => [rep, c ?? 0] as const);
      if (added.length > 0) {
        const addedTotal = added.reduce((a, [, c]) => a + c, 0);
        const blocking =
          (ctx.representationDependent?.has(name) ?? false) &&
          addedTotal / now.n >= B_GUARD_THRESHOLDS.incompatibleShare;
        out.push(
          finding(
            'profile_drift_representation',
            name,
            { added: added.map(([rep]) => rep).sort(), share: r(addedTotal / now.n) },
            blocking ? { class: 'm9a_fail_closed', severity: 'review_required' } : undefined,
          ),
        );
      }
    }
    // Categories: only between unsuppressed safe-category value sets.
    if (!f.categorical.suppressed && !old.categorical.suppressed) {
      const oldValues = new Map(old.categorical.values.map((v) => [v.value, v.count]));
      const newValues = new Set(f.categorical.values.map((v) => v.value));
      const appeared = f.categorical.values
        .filter((v) => !oldValues.has(v.value))
        .map((v) => v.value);
      if (appeared.length > 0) {
        out.push(
          finding('profile_drift_new_category', name, {
            values: appeared.slice(0, 20),
            count: appeared.length,
          }),
        );
      }
      const oldTotal = old.categorical.values.reduce((a, v) => a + v.count, 0);
      const vanished = old.categorical.values
        .filter(
          (v) =>
            !newValues.has(v.value) &&
            oldTotal > 0 &&
            v.count / oldTotal >= DRIFT_THRESHOLDS.vanishedShare,
        )
        .map((v) => v.value);
      if (vanished.length > 0) {
        out.push(
          finding('profile_drift_category_vanished', name, {
            values: vanished.slice(0, 20),
            count: vanished.length,
          }),
        );
      }
    }
    if (f.cardinalityClass && old.cardinalityClass && f.cardinalityClass !== old.cardinalityClass) {
      out.push(
        finding('profile_drift_cardinality', name, {
          before: old.cardinalityClass,
          after: f.cardinalityClass,
        }),
      );
    }
    const rise =
      parseFailureRatio(f, current.sampling.rowsRead) -
      parseFailureRatio(old, baseline.sampling.rowsRead);
    if (rise >= DRIFT_THRESHOLDS.parseFailureRise) {
      out.push(finding('profile_drift_parse_failures', name, { rise: r(rise) }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// B guards used by sync (pre-write and pre-tombstone)
// ---------------------------------------------------------------------------

export type GuardStage = 'pre_write' | 'pre_tombstone';

export interface GuardCounter {
  /** Records (identity guard) or substantive values (type/representation guards) seen. */
  readonly seen: number;
  /** Those missing the identity, or in an unreadable class/representation. */
  readonly failing: number;
}

/**
 * Pre-write: evaluated once at least 20 records/values have been seen.
 * Pre-tombstone: over the whole run (any non-zero count).
 */
export function guardTrips(stage: GuardStage, counter: GuardCounter, share: number): boolean {
  if (counter.seen === 0) return false;
  if (stage === 'pre_write' && counter.seen < B_GUARD_THRESHOLDS.preWriteMinimum) return false;
  return counter.failing / counter.seen >= share;
}

export const identityAbsentTrips = (stage: GuardStage, c: GuardCounter) =>
  guardTrips(stage, c, B_GUARD_THRESHOLDS.identityAbsentShare);
export const incompatibleTrips = (stage: GuardStage, c: GuardCounter) =>
  guardTrips(stage, c, B_GUARD_THRESHOLDS.incompatibleShare);
