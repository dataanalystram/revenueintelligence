import { z } from 'zod';
import type { SourceObject } from '../source-connector';
import { FIELD_MEMORY_BOUND_BYTES } from './accumulators';
import { isExcludedName } from './privacy';

/**
 * Profile request limits (approved D2, M9A plan §6.2): refuse, never clamp.
 * The hard ceiling is a code constant: changing it needs a code change and
 * an ADR note; configuration can never raise it.
 */
export const PROFILE_LIMITS = Object.freeze({
  /** Platform minimum rows per object per run. */
  minRows: 1_000,
  /** Platform maximum (hard ceiling) rows per object per run. */
  maxRows: 250_000,
  /** Planning value for documentation and help text only (never applied implicitly). */
  suggestedRows: 50_000,
  maxFieldsPerObject: 500,
  maxRunMinutes: 60,
  memoryBudgetBytes: 128 * 1024 * 1024,
});

export const PROFILING_SAMPLING = ['full', 'systematic', 'recent', 'head'] as const;
export type ProfilingSampling = (typeof PROFILING_SAMPLING)[number];

/**
 * Per-connection profiling settings (kept with the connection, not the
 * adapter). `maxRows` is required to profile; there is no implicit default.
 */
export const SourceProfileSettingsSchema = z.strictObject({
  maxRows: z.number().int().min(PROFILE_LIMITS.minRows).max(PROFILE_LIMITS.maxRows),
  freshnessDays: z.number().int().min(1).max(90).optional(),
});
export type SourceProfileSettings = z.infer<typeof SourceProfileSettingsSchema>;

export type ProfileRequestErrorCode =
  | 'profile_limit_unset'
  | 'profile_limit_out_of_range'
  | 'profile_field_limit'
  | 'profile_memory_budget_exceeded'
  | 'sampling_unsupported'
  | 'profile_field_excluded'
  | 'unknown_source_object'
  | 'unknown_source_field'
  | 'profile_request_invalid';

export interface ProfileRequestIssue {
  readonly code: ProfileRequestErrorCode;
  readonly path: string;
  readonly message: string;
}

export interface ProfileRequestInput {
  readonly objects: ReadonlyArray<{ readonly object: string; readonly fields?: readonly string[] }>;
  readonly sampling: string;
  readonly maxRows?: number;
  /** Excluded fields explicitly opted in (`object.field`). */
  readonly includeExcluded: readonly string[];
}

export interface ValidatedProfileRequest {
  readonly objects: ReadonlyArray<{ readonly object: string; readonly fields: readonly string[] }>;
  readonly sampling: ProfilingSampling;
  readonly maxRows: number;
  readonly optIns: ReadonlyArray<{ readonly object: string; readonly field: string }>;
  /** Accumulator memory estimate (bytes) for the largest object. */
  readonly memoryEstimate: number;
  /** Excluded fields left out of a whole-object request (`object.field`). */
  readonly excludedLeftOut: readonly string[];
}

/** The sampling methods an object's declared capabilities allow (§6.1). */
export function samplingAllowed(object: SourceObject, method: ProfilingSampling): boolean {
  switch (method) {
    case 'full':
      return true;
    case 'systematic':
      return object.capabilities.pagination === 'offset' && object.capabilities.count;
    case 'recent':
      return object.capabilities.changeField !== undefined;
    case 'head':
      // Only when no other bounded-bias method applies.
      return !(
        (object.capabilities.pagination === 'offset' && object.capabilities.count) ||
        object.capabilities.changeField !== undefined
      );
  }
}

/** Validates a profile request against D2 and the snapshot. Pure; never clamps. */
export function validateProfileRequest(
  input: ProfileRequestInput,
  objects: readonly SourceObject[],
  settings: unknown,
): { ok: true; request: ValidatedProfileRequest } | { ok: false; issues: ProfileRequestIssue[] } {
  const issues: ProfileRequestIssue[] = [];
  const issue = (code: ProfileRequestErrorCode, path: string, message: string) =>
    issues.push({ code, path, message });

  // The connection's limit: required, within the platform range.
  let connectionMax: number | undefined;
  if (
    settings === undefined ||
    settings === null ||
    (settings as { maxRows?: unknown }).maxRows === undefined
  ) {
    issue(
      'profile_limit_unset',
      'connection.config.profile.maxRows',
      'the connection has no profile.maxRows; configure one (suggested 50,000)',
    );
  } else {
    const parsed = SourceProfileSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      issue(
        'profile_limit_out_of_range',
        'connection.config.profile',
        `profile.maxRows must be ${PROFILE_LIMITS.minRows}-${PROFILE_LIMITS.maxRows}`,
      );
    } else {
      connectionMax = parsed.data.maxRows;
    }
  }
  // The request: within [minimum, connection value]; never clamped.
  const maxRows = input.maxRows ?? connectionMax;
  if (input.maxRows !== undefined) {
    if (
      !Number.isInteger(input.maxRows) ||
      input.maxRows < PROFILE_LIMITS.minRows ||
      input.maxRows > PROFILE_LIMITS.maxRows
    ) {
      issue(
        'profile_limit_out_of_range',
        'maxRows',
        `--max-rows must be ${PROFILE_LIMITS.minRows}-${PROFILE_LIMITS.maxRows}`,
      );
    } else if (connectionMax !== undefined && input.maxRows > connectionMax) {
      issue(
        'profile_limit_out_of_range',
        'maxRows',
        `--max-rows exceeds the connection limit (${connectionMax})`,
      );
    }
  }
  const sampling = (PROFILING_SAMPLING as readonly string[]).includes(input.sampling)
    ? (input.sampling as ProfilingSampling)
    : undefined;
  if (!sampling)
    issue(
      'profile_request_invalid',
      'sampling',
      'sampling must be full, systematic, recent or head',
    );
  if (input.objects.length === 0)
    issue('profile_request_invalid', 'objects', 'name at least one object');

  const optIns: Array<{ object: string; field: string }> = [];
  const excludedLeftOut: string[] = [];
  const optInSet = new Set(input.includeExcluded);
  const out: Array<{ object: string; fields: string[] }> = [];
  let memoryEstimate = 0;
  const seen = new Set<string>();
  input.objects.forEach((req, i) => {
    const path = `objects.${i}`;
    if (seen.has(req.object))
      issue('profile_request_invalid', path, `${req.object} is listed twice`);
    seen.add(req.object);
    const object = objects.find((o) => o.name === req.object);
    if (!object) {
      issue('unknown_source_object', path, `${req.object} is not in the snapshot`);
      return;
    }
    const payment = object.sensitivity === 'payment';
    const requested = req.fields ?? object.fields.map((f) => f.name);
    const fields: string[] = [];
    for (const name of requested) {
      if (!object.fields.some((f) => f.name === name)) {
        issue(
          'unknown_source_field',
          `${path}.fields`,
          `${object.name}.${name} is not in the snapshot`,
        );
        continue;
      }
      const excluded = payment || isExcludedName(name);
      if (excluded) {
        if (optInSet.has(`${object.name}.${name}`)) {
          optIns.push({ object: object.name, field: name });
        } else if (req.fields) {
          // Explicitly requested without opt-in: refused.
          issue(
            'profile_field_excluded',
            `${path}.fields`,
            `${object.name}.${name} is excluded; use --include-excluded ${object.name}.${name}`,
          );
          continue;
        } else {
          // Not requested explicitly: left out and reported back (never profiled silently).
          excludedLeftOut.push(`${object.name}.${name}`);
          continue;
        }
      }
      fields.push(name);
    }
    if (fields.length > PROFILE_LIMITS.maxFieldsPerObject) {
      issue(
        'profile_field_limit',
        `${path}.fields`,
        `at most ${PROFILE_LIMITS.maxFieldsPerObject} fields per object`,
      );
    }
    if (fields.length === 0)
      issue(
        'profile_request_invalid',
        `${path}.fields`,
        `no profilable field selected on ${object.name}`,
      );
    if (sampling && !samplingAllowed(object, sampling)) {
      issue('sampling_unsupported', path, `${object.name} does not support ${sampling} sampling`);
    }
    // Declared enums keep up to one candidate per option (≤ 64 chars each, ~128 B).
    const enumExtra = fields.reduce(
      (sum, name) =>
        sum + (object.fields.find((f) => f.name === name)?.enumOptions?.length ?? 0) * 128,
      0,
    );
    memoryEstimate = Math.max(memoryEstimate, fields.length * FIELD_MEMORY_BOUND_BYTES + enumExtra);
    out.push({ object: object.name, fields: fields.sort() });
  });
  for (const optIn of optInSet) {
    if (!optIns.some((o) => `${o.object}.${o.field}` === optIn)) {
      issue(
        'profile_request_invalid',
        'includeExcluded',
        `${optIn} is not an excluded field of a requested object`,
      );
    }
  }
  if (memoryEstimate > PROFILE_LIMITS.memoryBudgetBytes) {
    issue(
      'profile_memory_budget_exceeded',
      'objects',
      `the accumulator estimate exceeds ${PROFILE_LIMITS.memoryBudgetBytes} bytes`,
    );
  }
  if (issues.length > 0 || !sampling || maxRows === undefined) return { ok: false, issues };
  return {
    ok: true,
    request: { objects: out, sampling, maxRows, optIns, memoryEstimate, excludedLeftOut },
  };
}
