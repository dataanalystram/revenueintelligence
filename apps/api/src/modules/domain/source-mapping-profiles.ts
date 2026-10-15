import { z } from 'zod';
import { validateReviewedDomain } from './holding-domain';
import type { FieldProfile, ProfileDocument } from './profiling/document';
import type { FindingClass, FindingSeverity } from './profiling/findings';
import { displayName, isExcludedName, profileNames, type ProfileNames } from './profiling/privacy';
import { findSourceField, type SourceSchema } from './source-connector';
import type { MappingDocument, ObjectMapping } from './source-mapping-document';

/**
 * Profile-aware publish checks (ADR 0022, M9A plan §7, §10.2). A mapping
 * version publishes only when a completed, fresh, non-head profile of the
 * same schema snapshot covers every consequential, source-value-dependent
 * entry, every open review-required finding on those fields is acknowledged,
 * and every holding filter carries a complete reviewed domain. Pure: the
 * service loads the candidate profiles; this module decides.
 */

export const PROFILE_FRESHNESS = { defaultDays: 30, minDays: 1, maxDays: 90 } as const;
export const MIN_PROFILE_COVERAGE = 0.5;

export const ACK_REASON_CODES = [
  'accepted_known_issue',
  'source_fix_pending',
  'business_confirmed',
  'not_applicable',
] as const;
export type AckReasonCode = (typeof ACK_REASON_CODES)[number];

export const AcknowledgementSchema = z.strictObject({
  findingId: z.uuid(),
  reasonCode: z.enum(ACK_REASON_CODES),
});
export type Acknowledgement = z.infer<typeof AcknowledgementSchema>;

/**
 * The validation stamp a mapping draft carries once validated (M10A2 review
 * m8). It is read back from a jsonb column at publication, so it is parsed,
 * never cast: a stamp that does not match fails closed (`mapping_not_validated`).
 */
export const MappingDraftValidationStampSchema = z.object({
  contentHash: z.string().min(1),
  warnings: z.record(z.string(), z.number().int().nonnegative()).optional(),
  acknowledgements: z.array(AcknowledgementSchema).optional(),
});
export type MappingDraftValidationStamp = z.infer<typeof MappingDraftValidationStampSchema>;

export interface CandidateFinding {
  readonly id: string;
  readonly code: string;
  readonly class: FindingClass;
  readonly severity: FindingSeverity;
  readonly field: string | null;
}

/** A profile the service found for the connection (any run state; the checks here decide). */
export interface CandidateProfile {
  readonly id: string;
  readonly family: 'profile' | 'sync';
  readonly runStatus: string;
  readonly finishedAt: Date | null;
  readonly schemaSnapshotHash: string;
  readonly document: ProfileDocument;
  /** Excluded fields the run opted in to (names). */
  /** Opted-in excluded fields, as profile names. */
  readonly optedIn: readonly string[];
  readonly findings: readonly CandidateFinding[];
}

/** The request for the emergency override (D5). Disabled: always refused (decision A1). */
export interface ProfileOverrideRequest {
  readonly reason: string;
}

/**
 * The operator channel an override would need. M9A has none (free-text CLI
 * actor, no sources API), so the only value is `unauthenticated`: there is no
 * flag or configuration that can produce an authenticated operator.
 */
export type OperatorChannel = { readonly authenticated: false; readonly actor: string };

export interface ProfilingValidationInput {
  readonly profiles: readonly CandidateProfile[];
  readonly now: Date;
  /** Per-connection freshness (1–90 days; default 30). */
  readonly freshnessDays: number;
  readonly acknowledgements: readonly Acknowledgement[];
  readonly override?: ProfileOverrideRequest;
  readonly operator?: OperatorChannel;
}

export type ProfileIssueCode =
  | 'profile_required'
  | 'profile_stale'
  | 'profile_field_excluded'
  | 'profile_low_coverage'
  | 'profile_freshness_out_of_range'
  | 'finding_unacknowledged'
  | 'acknowledgement_invalid'
  | 'identity_unsuitable'
  | 'date_format_required'
  | 'holding_filter_domain_incomplete'
  | 'holding_filter_domain_inconsistent'
  | 'holding_filter_domain_stale'
  | 'holding_filter_domain_unknown'
  | 'override_requires_authenticated_operator'
  | 'override_out_of_scope'
  | 'override_reason_invalid';

export interface ProfileIssue {
  readonly code: ProfileIssueCode | 'observed_value_unmapped';
  readonly path: string;
  readonly message: string;
}

export type ConsequentialKind =
  'identity' | 'reference' | 'holding_filter' | 'state' | 'terms' | 'quantity' | 'profile';

export interface ConsequentialEntry {
  readonly object: string;
  readonly field: string;
  readonly kind: ConsequentialKind;
  readonly path: string;
}

/**
 * The consequential, source-value-dependent entries of a mapping (§7.1).
 * Exempt by construction: `ignored` entries, `explicit: null|unknown`
 * entries, and value-independent declarations (`productReferences.ignored`,
 * time zones and date formats, all-holdings statements, unmapped policies).
 */
export function consequentialEntries(doc: MappingDocument): ConsequentialEntry[] {
  const out: ConsequentialEntry[] = [];
  const add = (object: string, field: string, kind: ConsequentialKind, path: string) => {
    if (!out.some((e) => e.object === object && e.field === field && e.kind === kind))
      out.push({ object, field, kind, path });
  };
  doc.objects.forEach((obj: ObjectMapping, i) => {
    const at = `objects.${i}`;
    add(obj.source, obj.identity.field, 'identity', `${at}.identity.field`);
    if (obj.holdingFilter)
      add(obj.source, obj.holdingFilter.field, 'holding_filter', `${at}.holdingFilter.field`);
    obj.relationships.forEach((rel, j) => {
      add(obj.source, rel.field, 'reference', `${at}.relationships.${j}.field`);
      if (rel.fallbackVia)
        add(
          obj.source,
          rel.fallbackVia.field,
          'reference',
          `${at}.relationships.${j}.fallbackVia.field`,
        );
    });
    obj.fields.forEach((entry, j) => {
      if (entry.kind !== 'core' || !('source' in entry)) return; // ignored / explicit / attribute: exempt
      const path = `${at}.fields.${j}.source`;
      const kind: ConsequentialKind =
        entry.target === 'subscription.state'
          ? 'state'
          : entry.target === 'subscription.startsAt' || entry.target === 'subscription.endsAt'
            ? 'terms'
            : entry.target === 'subscription.quantity'
              ? 'quantity'
              : 'profile';
      add(obj.source, entry.source, kind, path);
    });
  });
  if (doc.productReferences) {
    add(
      doc.productReferences.object,
      doc.productReferences.identity.field,
      'identity',
      'productReferences.identity.field',
    );
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const namesCache = new WeakMap<SourceSchema, Map<string, ProfileNames>>();

/**
 * The profile entry of a source field. Profiles store profile names (a source
 * name that cannot be stored is `redacted_field_<n>`), derived from the
 * snapshot's declared names exactly as the profile builder did.
 */
function profileNameOf(schema: SourceSchema, object: string, field: string): string {
  let byObject = namesCache.get(schema);
  if (!byObject) namesCache.set(schema, (byObject = new Map<string, ProfileNames>()));
  let names = byObject.get(object);
  if (!names) {
    const declared = schema.objects.find((o) => o.name === object)?.fields ?? [];
    names = profileNames(declared.map((f) => f.name));
    byObject.set(object, names);
  }
  return names.toProfile(field);
}

function fieldOf(
  doc: ProfileDocument,
  schema: SourceSchema,
  object: string,
  field: string,
): FieldProfile | undefined {
  const name = profileNameOf(schema, object, field);
  return doc.fields.find((f) => f.name === name);
}

function substantive(f: FieldProfile): number {
  return Object.values(f.observedTypes).reduce((a, b) => a + (b ?? 0), 0);
}

function lowCoverage(doc: ProfileDocument): boolean {
  if (doc.sampling.method === 'full' && !doc.sampling.bounded) return false;
  return doc.sampling.coverage === null || doc.sampling.coverage < MIN_PROFILE_COVERAGE;
}

export interface ProfileValidationResult {
  readonly errors: ProfileIssue[];
  readonly warnings: ProfileIssue[];
  readonly coveringProfileIds: string[];
  readonly acknowledgements: Array<Acknowledgement & { readonly code: string }>;
}

/** Profile checks for a candidate mapping document (pure). */
export function validateMappingProfiles(
  doc: MappingDocument,
  schema: SourceSchema,
  schemaHash: string,
  input: ProfilingValidationInput,
): ProfileValidationResult {
  const errors: ProfileIssue[] = [];
  const warnings: ProfileIssue[] = [];
  const err = (code: ProfileIssueCode, path: string, message: string) =>
    errors.push({ code, path, message });

  const freshnessOk =
    Number.isInteger(input.freshnessDays) &&
    input.freshnessDays >= PROFILE_FRESHNESS.minDays &&
    input.freshnessDays <= PROFILE_FRESHNESS.maxDays;
  if (!freshnessOk) {
    err(
      'profile_freshness_out_of_range',
      '',
      `profile freshness must be ${PROFILE_FRESHNESS.minDays}-${PROFILE_FRESHNESS.maxDays} days`,
    );
  }

  // Candidates that can cover at all: completed profile-family runs on this snapshot.
  const sameSnapshot = input.profiles.filter((p) => p.schemaSnapshotHash === schemaHash);
  const usable = sameSnapshot.filter(
    (p) => p.family === 'profile' && p.runStatus === 'completed' && p.finishedAt,
  );
  const fresh = (p: CandidateProfile) =>
    freshnessOk && input.now.getTime() - p.finishedAt!.getTime() <= input.freshnessDays * DAY_MS;

  const covering = new Map<string, CandidateProfile>();
  const coverFor = new Map<string, CandidateProfile>();
  for (const entry of consequentialEntries(doc)) {
    const forObject = usable
      .filter((p) => p.document.object === entry.object)
      .sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
    const withField = forObject.filter((p) =>
      fieldOf(p.document, schema, entry.object, entry.field),
    );
    const notHead = withField.filter((p) => p.document.sampling.method !== 'head');
    const best = notHead.find(fresh);
    const key = `${entry.object}.${entry.field}`;
    const label = `${displayName(entry.object)}.${displayName(entry.field)}`;
    if (!best) {
      if (
        isExcludedName(entry.field) &&
        !forObject.some((p) => p.optedIn.includes(profileNameOf(schema, entry.object, entry.field)))
      ) {
        err(
          'profile_field_excluded',
          entry.path,
          `${label} is excluded from profiling; profile it with an audited opt-in`,
        );
      } else if (notHead.length > 0) {
        err(
          'profile_stale',
          entry.path,
          `the profile covering ${label} is older than ${input.freshnessDays} days`,
        );
      } else if (withField.length > 0) {
        err('profile_required', entry.path, `${label} is covered only by a head-sampled profile`);
      } else if (sameSnapshot.length === 0 && input.profiles.length > 0) {
        err(
          'profile_required',
          entry.path,
          `no completed profile of this schema snapshot covers ${label}`,
        );
      } else {
        err('profile_required', entry.path, `no completed profile covers ${label}`);
      }
      continue;
    }
    covering.set(best.id, best);
    coverFor.set(`${entry.kind}|${key}`, best);
  }

  // Acknowledgements: each names a finding of a covering profile.
  const acknowledged = new Map<string, Acknowledgement & { code: string }>();
  const allFindings = new Map<string, CandidateFinding>();
  for (const p of covering.values()) for (const f of p.findings) allFindings.set(f.id, f);
  input.acknowledgements.forEach((ack, i) => {
    const parsed = AcknowledgementSchema.safeParse(ack);
    const f = parsed.success ? allFindings.get(parsed.data.findingId) : undefined;
    if (!parsed.success || !f) {
      err(
        'acknowledgement_invalid',
        `acknowledgements.${i}`,
        'an acknowledgement names a finding of a covering profile and a closed reason code',
      );
      return;
    }
    acknowledged.set(f.id, { ...parsed.data, code: f.code });
  });

  // Field-level publish checks on the covering profiles.
  const consequentialFields = new Map<string, Set<string>>();
  for (const e of consequentialEntries(doc)) {
    consequentialFields.set(
      e.object,
      (consequentialFields.get(e.object) ?? new Set()).add(e.field),
    );
  }
  for (const p of covering.values()) {
    const fields = consequentialFields.get(p.document.object) ?? new Set<string>();
    for (const f of p.findings) {
      const relevant = f.field === null ? true : fields.has(f.field);
      const needsAck =
        f.severity === 'review_required' ||
        (f.severity === 'warning' && f.field !== null && fields.has(f.field));
      if (!relevant || !needsAck || acknowledged.has(f.id)) continue;
      const path = `profiles.${p.id}.findings.${f.id}`;
      if (f.code === 'low_coverage_sample') {
        err(
          'profile_low_coverage',
          path,
          `profile ${p.id} covers ${p.document.sampling.coverage ?? 'an unknown share'} of the population; acknowledge finding ${f.id}`,
        );
      } else {
        err(
          'finding_unacknowledged',
          path,
          `finding ${f.id} (${f.code}${f.field ? ` on ${f.field}` : ''}) needs an acknowledgement`,
        );
      }
    }
    // A low-coverage profile without its finding row is still refused.
    if (lowCoverage(p.document) && !p.findings.some((f) => f.code === 'low_coverage_sample')) {
      err('profile_low_coverage', `profiles.${p.id}`, `profile ${p.id} has low coverage`);
    }
  }

  doc.objects.forEach((obj, i) => {
    const at = `objects.${i}`;
    // Identity with duplicates in the profile (§7.3). A field the snapshot does not
    // declare id/unique (a confirmed identity) is refused: its values do not
    // identify records. For a declared id, duplicates are a source/read anomaly
    // handled per record by M8 (`duplicate_external_id`, one row per source id);
    // the E-class `identifier_not_unique` finding then needs an acknowledgement.
    const idCover = coverFor.get(`identity|${obj.source}.${obj.identity.field}`);
    const idField = idCover
      ? fieldOf(idCover.document, schema, obj.source, obj.identity.field)
      : undefined;
    const declaredId = findSourceField(schema, obj.source, obj.identity.field);
    if (
      idField &&
      declaredId?.type !== 'id' &&
      declaredId?.unique !== true &&
      idField.distinct.method === 'exact' &&
      idField.distinct.value < substantive(idField)
    ) {
      err(
        'identity_unsuitable',
        `${at}.identity.field`,
        'the profile shows duplicate identity values',
      );
    }
    // Date entries need a format that reads every observed representation.
    obj.fields.forEach((entry, j) => {
      if (entry.kind !== 'core' || !('source' in entry)) return;
      if (entry.target !== 'subscription.startsAt' && entry.target !== 'subscription.endsAt')
        return;
      const cover = coverFor.get(`terms|${obj.source}.${entry.source}`);
      const f = cover ? fieldOf(cover.document, schema, obj.source, entry.source) : undefined;
      if (!f) return;
      if (entry.transforms?.parse?.type === 'timestamp') {
        // M9B: Unix seconds read only integer seconds; any other class or representation
        // (strings, ISO dates, milliseconds) is unreadable.
        const otherTypes = Object.entries(f.observedTypes).filter(
          ([type, c]) =>
            type !== 'integer' && type !== 'timestamp' && type !== 'null' && (c ?? 0) > 0,
        );
        const otherReps = Object.entries(f.representations).filter(
          ([rep, c]) =>
            (rep.startsWith('date.') || rep.startsWith('timestamp.')) &&
            rep !== 'timestamp.unix_s' &&
            (c ?? 0) > 0,
        );
        if (otherTypes.length > 0 || otherReps.length > 0) {
          err(
            'date_format_required',
            `${at}.fields.${j}.transforms.parse`,
            `${displayName(entry.source)} holds values a Unix-seconds timestamp cannot read`,
          );
        }
        return;
      }
      const reps = Object.entries(f.representations).filter(
        ([rep, c]) => (rep.startsWith('date.') || rep.startsWith('timestamp.')) && (c ?? 0) > 0,
      );
      if ((f.parseFailures.ambiguous_date ?? 0) > 0 || reps.length > 1) {
        err(
          'date_format_required',
          `${at}.fields.${j}.transforms.parse`,
          `${displayName(entry.source)} holds ambiguous or mixed date representations the declared format cannot read`,
        );
      }
    });
    // State value maps: observed safe-category values not mapped (warning; unmapped: unknown keeps safety).
    obj.fields.forEach((entry, j) => {
      if (entry.kind !== 'core' || !('source' in entry) || entry.target !== 'subscription.state')
        return;
      const cover = coverFor.get(`state|${obj.source}.${entry.source}`);
      const f = cover ? fieldOf(cover.document, schema, obj.source, entry.source) : undefined;
      const map = entry.transforms?.valueMap?.map ?? {};
      const unmapped =
        f && !f.categorical.suppressed
          ? f.categorical.values.filter((v) => !Object.hasOwn(map, v.value))
          : [];
      if (unmapped.length > 0) {
        warnings.push({
          code: 'observed_value_unmapped',
          path: `${at}.fields.${j}.transforms.valueMap`,
          message: `${unmapped.length} observed value(s) are not in the value map`,
        });
      }
    });
    // Holding filter: a known domain, and a complete reviewed domain.
    const filter = obj.holdingFilter;
    if (!filter) return;
    const path = `${at}.holdingFilter`;
    const declared = findSourceField(schema, obj.source, filter.field);
    const cover = coverFor.get(`holding_filter|${obj.source}.${filter.field}`);
    const f = cover ? fieldOf(cover.document, schema, obj.source, filter.field) : undefined;
    const declaredOptions =
      declared?.type === 'enum' ? (declared.enumOptions ?? []).map((o) => o.value) : [];
    const observedKnown = f !== undefined && !f.categorical.suppressed;
    const enumComplete =
      declared?.type === 'enum' && f !== undefined && (f.counts.notInDeclaredEnum ?? 0) === 0;
    if (cover && !observedKnown && !enumComplete) {
      err(
        'holding_filter_domain_unknown',
        `${path}.field`,
        `${displayName(filter.field)} has neither a declared enum nor an unsuppressed safe-category domain in the profile`,
      );
    }
    for (const issue of validateReviewedDomain({
      path,
      operator: filter.operator,
      values: filter.values,
      domain: filter.reviewedDomain,
      declaredOptions,
      observedValues: observedKnown ? f.categorical.values.map((v) => v.value) : [],
      snapshotHash: schemaHash,
      coveringProfileIds: [...covering.keys()],
    })) {
      err(issue.code, issue.path, issue.message);
    }
  });

  // The emergency override (D5) ships disabled (A1): always refused, never bypasses anything.
  if (input.override) {
    for (const issue of overrideDecision(input.override, input.operator, errors))
      errors.push(issue);
  }

  return {
    errors,
    warnings,
    coveringProfileIds: [...covering.keys()].sort(),
    acknowledgements: [...acknowledged.values()].sort((a, b) =>
      a.findingId < b.findingId ? -1 : 1,
    ),
  };
}

/**
 * The override's validation and scope (D5 safeguards). Returns the issues an
 * override request adds; it never removes an existing error. With no
 * authenticated operator channel in M9A, the first issue is always
 * `override_requires_authenticated_operator`.
 */
export function overrideDecision(
  request: ProfileOverrideRequest,
  operator: OperatorChannel | undefined,
  existing: readonly ProfileIssue[],
): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  // `OperatorChannel.authenticated` is the literal `false`: nothing can enable this branch.
  if (!operator?.authenticated) {
    issues.push({
      code: 'override_requires_authenticated_operator',
      path: 'override',
      message:
        'the profile override needs an authenticated operator channel, which does not exist yet (decision A1)',
    });
  }
  const reason = request.reason.trim();
  if (
    reason.length < 1 ||
    reason.length > 500 ||
    /(secret|password|token|apikey|bearer)/i.test(reason)
  ) {
    issues.push({
      code: 'override_reason_invalid',
      path: 'override.reason',
      message: 'a reason of 1-500 characters without secrets is required',
    });
  }
  // Scope: only `profile_required` may ever be overridden; nothing else is in scope.
  if (existing.some((e) => e.code !== 'profile_required')) {
    issues.push({
      code: 'override_out_of_scope',
      path: 'override',
      message:
        'the override covers only a missing profile caused by profiling infrastructure; other checks still apply',
    });
  }
  return issues;
}

/** Pre-M9A mapping versions: a holding filter without a reviewed domain must be republished (§10.4). */
export function requiresRepublish(doc: MappingDocument): boolean {
  return doc.objects.some(
    (o) => o.holdingFilter !== undefined && o.holdingFilter.reviewedDomain === undefined,
  );
}

/**
 * M10D (plan §5.1, §5.4): the M9A sensitivity of a source field in the newest
 * finished candidate profile of its object, if one profiles it.
 */
export function profiledSensitivity(
  schema: SourceSchema,
  profiles: readonly CandidateProfile[],
  object: string,
  field: string,
): string | undefined {
  const newest = profiles
    .filter((p) => p.document.object === object && p.finishedAt !== null)
    .sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime())[0];
  if (!newest) return undefined;
  const name = profileNameOf(schema, object, field);
  return newest.document.fields.find((f) => f.name === name)?.sensitivity;
}
