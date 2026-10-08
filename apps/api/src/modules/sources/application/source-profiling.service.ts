import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  assertNoRawFinding,
  buildProfileDocument,
  capFindings,
  DISTINCT_EXACT_CAP,
  documentFindings,
  driftFindings,
  isConnectorError,
  isRedactedName,
  objectAccumulatorFor,
  PROFILE_LIMITS,
  profileContentHash,
  profileNames,
  SourceSchemaSchema,
  validateProfileRequest,
  type FindingSeverity,
  type ProfileRequestInput,
  type ReadSelection,
  type SourceConnector,
  type SourceObject,
  type ValidatedProfileRequest,
} from '../../domain';
import { TenantDatabase, type TenantContext } from '../../tenancy';
import { MetricsService } from '../../../platform/metrics';
import { QueueService } from '../../../platform/queue';
import { ConnectionNotFoundError, SourcesError } from '../errors';
import {
  ProfileRunActiveError,
  ProfilesRepository,
  type NewProfile,
  type ProfileRun,
  type StoredFinding,
  type StoredProfile,
} from '../infrastructure/profiles.repository';
import { SourcesRepository } from '../infrastructure/sources.repository';
import { SOURCE_PROFILE_JOB, SOURCES_QUEUE, sourceProfileJobId } from '../jobs';
import { SourceConnectionsService } from './source-connections.service';

const MAX_PAGES = 100_000;
const DEFAULT_PAGE_SIZE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProfileRequestResult {
  readonly dryRun: boolean;
  readonly runId?: string;
  readonly request: ValidatedProfileRequest;
}

export interface ProfileRunResult {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'not_running';
  readonly errorCode?: string;
  readonly profiles?: number;
}

export class ProfileRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ProfileRunError';
  }
}

/**
 * Source data profiling (ADR 0022, M9A plan §1.5, §6): request validation
 * (D2, refuse never clamp), the run lifecycle, reads through the
 * `SourceConnector` port with purpose `profile` and exactly the selected
 * fields, bounded accumulation, the privacy pass, findings and drift, and one
 * completion transaction. Raw values exist only in this worker's memory
 * during the run; nothing partial is ever persisted.
 */
@Injectable()
export class SourceProfilingService {
  private readonly logger = new Logger('SourceProfiling');

  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: SourcesRepository,
    private readonly profiles: ProfilesRepository,
    private readonly connections: SourceConnectionsService,
    @Optional() @Inject(QueueService) private readonly queues?: QueueService,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  /** Validates a request (dry run) or creates the run and queues `source.profile`. */
  async request(
    ctx: TenantContext,
    connectionId: string,
    input: ProfileRequestInput,
    options: { actor: string; execute: boolean; correlationId?: string; enqueue?: boolean },
  ): Promise<ProfileRequestResult> {
    const correlationId = options.correlationId ?? randomUUID();
    const created = await this.db.transaction(ctx, async (tx) => {
      const connection = await this.repo.connection(tx, connectionId);
      if (!connection) throw new ConnectionNotFoundError(connectionId);
      if (connection.mappingMode !== 'versioned') {
        throw new SourcesError('mapping_not_versioned', `${connection.kind} is mapped in code`);
      }
      if (connection.status !== 'enabled') {
        throw new SourcesError('connection_disabled', 'The connection is disabled');
      }
      if (!this.connections.hasAdapter(connection.kind)) {
        throw new SourcesError(
          'adapter_not_registered',
          `No source adapter is registered for ${connection.kind} in this process`,
        );
      }
      const snapshot = await this.repo.latestSnapshot(tx, connectionId);
      if (!snapshot)
        throw new SourcesError('no_schema_snapshot', 'Capture a schema snapshot first');
      const schema = SourceSchemaSchema.parse(snapshot.document);
      const verdict = validateProfileRequest(
        input,
        schema.objects,
        this.connections.profileSettings(connection),
      );
      if (!verdict.ok) {
        throw new SourcesError(
          verdict.issues[0]!.code,
          'The profile request is refused',
          verdict.issues,
        );
      }
      if (!options.execute) return { dryRun: true as const, request: verdict.request };
      try {
        const run = await this.profiles.createRun(tx, {
          connectionId,
          schemaSnapshotHash: snapshot.hash,
          request: {
            objects: verdict.request.objects,
            sampling: verdict.request.sampling,
            maxRows: verdict.request.maxRows,
            optIns: verdict.request.optIns.map((o) => ({ ...o, actor: options.actor })),
          },
          requestedBy: options.actor,
          correlationId,
        });
        return { dryRun: false as const, request: verdict.request, run };
      } catch (err) {
        if (err instanceof ProfileRunActiveError) {
          throw new SourcesError(
            'profile_run_active',
            'A profile run is already active for this connection',
          );
        }
        throw err;
      }
    });
    if (created.dryRun) return { dryRun: true, request: created.request };
    if (options.enqueue !== false) {
      try {
        if (!this.queues) throw new SourcesError('queue_unavailable', 'No queue in this process');
        await this.queues.add(
          SOURCES_QUEUE,
          SOURCE_PROFILE_JOB,
          { v: 1, tenantId: ctx.tenantId, runId: created.run.id, correlationId },
          { jobId: sourceProfileJobId(created.run.id) },
        );
      } catch (err) {
        // Never queued: the run is abandoned so the connection is free again.
        await this.db.transaction(ctx, (tx) =>
          this.profiles.failRun(tx, created.run.id, 'abandoned', 'queue_unavailable', new Date()),
        );
        throw err;
      }
    }
    return { dryRun: false, runId: created.run.id, request: created.request };
  }

  /**
   * Executes a run from the first page. A retried attempt restarts from
   * scratch (accumulators rebuilt), so a profile never mixes attempts.
   * Transient source errors are rethrown (the job retries); anything else
   * fails the run with a stable code and persists nothing.
   */
  async execute(
    ctx: TenantContext,
    runId: string,
    now: () => Date = () => new Date(),
  ): Promise<ProfileRunResult> {
    const loaded = await this.db.transaction(ctx, async (tx) => {
      const run = await this.profiles.run(tx, runId);
      if (!run || (run.status !== 'requested' && run.status !== 'running')) return undefined;
      const connection = await this.repo.connection(tx, run.connectionId);
      const snapshot = await this.repo.snapshot(tx, run.connectionId, run.schemaSnapshotHash);
      const started = await this.profiles.markRunning(tx, run.id, now());
      return { run: started, connection, snapshot };
    });
    if (!loaded) return { runId, status: 'not_running' };
    const { run } = loaded;
    const startedAt = now().getTime();
    try {
      if (!loaded.connection || !loaded.snapshot)
        throw new ProfileRunError('profile_source_missing');
      const schema = SourceSchemaSchema.parse(loaded.snapshot.document);
      const connector = this.connections.connector(ctx, loaded.connection);
      const built: NewProfile[] = [];
      const sampling: Record<string, unknown> = {};
      for (const req of run.request.objects) {
        const object = schema.objects.find((o) => o.name === req.object);
        if (!object) throw new ProfileRunError('profile_object_missing');
        const result = await this.profileObject(
          ctx,
          connector,
          object,
          req.fields,
          run,
          startedAt,
          now,
        );
        sampling[req.object] = {
          method: result.document.sampling.method,
          rowsRead: result.document.sampling.rowsRead,
          populationEstimate: result.document.sampling.populationEstimate,
          coverage: result.document.sampling.coverage,
          bounded: result.document.sampling.bounded,
        };
        built.push(result);
      }
      const stored = await this.db.transaction(ctx, async (tx) => {
        const current = await this.profiles.run(tx, run.id);
        if (current?.status !== 'running') throw new ProfileRunError('profile_run_not_running');
        return this.profiles.completeRun(tx, run, sampling, built, now());
      });
      this.metrics?.increment('lip_profile_runs', {
        kind: loaded.connection.kind,
        outcome: 'completed',
      });
      return { runId, status: 'completed', profiles: stored.length };
    } catch (err) {
      if (isConnectorError(err) && err.retryable) throw err;
      const code = profileErrorCode(err);
      await this.db.transaction(ctx, async (tx) => {
        const current = await this.profiles.run(tx, run.id);
        if (current && (current.status === 'running' || current.status === 'requested')) {
          await this.profiles.failRun(tx, run.id, 'failed', code, now());
        }
      });
      this.metrics?.increment('lip_profile_runs', {
        kind: loaded.connection?.kind ?? 'unknown',
        outcome: 'failed',
      });
      this.logger.warn({ runId, code }, 'Profile run failed');
      return { runId, status: 'failed', errorCode: code };
    }
  }

  /** Marks a run failed after its job exhausted its retries (dead-lettered). */
  async abandon(ctx: TenantContext, runId: string, code: string): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      const run = await this.profiles.run(tx, runId);
      if (!run || (run.status !== 'requested' && run.status !== 'running')) return;
      await this.profiles.failRun(tx, runId, 'failed', code, new Date());
    });
  }

  private async profileObject(
    ctx: TenantContext,
    connector: SourceConnector,
    object: SourceObject,
    requestedFields: readonly string[],
    run: ProfileRun,
    startedAt: number,
    now: () => Date,
  ): Promise<NewProfile> {
    const maxRows = run.request.maxRows;
    const method = run.request.sampling;
    // The stored request holds profile names; the source is read by source name.
    const names = profileNames(object.fields.map((f) => f.name));
    const toSource = (name: string): string => {
      const source = names.toSource(name);
      if (source === undefined) throw new ProfileRunError('profile_field_missing');
      return source;
    };
    const fields = requestedFields.map(toSource);
    const acc = objectAccumulatorFor(object, fields);
    const boundary = new Date(startedAt);
    const full: ReadSelection = { mode: 'full', boundary };
    const canCount = object.capabilities.count && connector.countRecords !== undefined;
    const count = (selection: ReadSelection) =>
      canCount
        ? connector.countRecords!({ object: object.name, selection })
        : Promise.resolve(null);
    let population = await count(full);
    let selection: ReadSelection = full;
    let stride: number | null = null;
    let orderedBy: string | null = null;
    const evidence: string[] = [];
    if (method === 'systematic') {
      stride = Math.max(1, Math.ceil((population ?? 0) / maxRows));
      evidence.push('systematic_page_clusters');
    } else if (method === 'recent') {
      orderedBy = object.capabilities.changeField ?? null;
      evidence.push('recency_bias');
      // The largest window, doubling from one day, whose count stays within maxRows.
      let days = 1;
      selection = { mode: 'since', since: new Date(startedAt - days * DAY_MS), boundary };
      if (canCount) {
        while (days < 36_500) {
          const wider: ReadSelection = {
            mode: 'since',
            since: new Date(startedAt - days * 2 * DAY_MS),
            boundary,
          };
          const n = await count(wider);
          if (n === null || n > maxRows) break;
          days *= 2;
          selection = wider;
          if (n === population) break;
        }
      }
    } else if (method === 'head') {
      evidence.push('head_sample_biased');
    }
    const pageSize = Math.max(1, Math.min(DEFAULT_PAGE_SIZE, object.capabilities.maxPageSize));
    let position: string | undefined;
    let bounded = false;
    // M9B: opaque positions; a repeated one is non-progress (never a loop).
    const used = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (now().getTime() - startedAt > PROFILE_LIMITS.maxRunMinutes * 60_000) {
        throw new ProfileRunError('profile_limit_reached');
      }
      const result = await connector.readRecords({
        purpose: 'profile',
        object: object.name,
        fields,
        selection,
        pageSize,
        ...(position ? { position } : {}),
      });
      // Systematic: every k-th page is folded; the others are discarded unread by the accumulators.
      if (stride === null || page % stride === 0) {
        for (const record of result.records) {
          // Deleted and structurally rejected records are not profiled (M9B rejection rows).
          if (record.deleted || record.rejection) continue;
          if (acc.rows >= maxRows) {
            bounded = true;
            break;
          }
          acc.addRecord(record.values);
        }
      }
      if (bounded || !result.next) {
        if (result.next && acc.rows >= maxRows) bounded = true;
        break;
      }
      if (acc.rows >= maxRows) {
        bounded = true;
        break;
      }
      if (used.has(result.next) || result.next === position) {
        throw new ProfileRunError('pagination_stalled');
      }
      used.add(result.next);
      position = result.next;
      if (page === MAX_PAGES - 1) throw new ProfileRunError('page_limit_exceeded');
    }
    if (method === 'recent' && population !== null) population = Math.max(population, acc.rows);
    const document = buildProfileDocument({
      object,
      connectionKind: connector.capabilities().kind,
      schemaSnapshotHash: run.schemaSnapshotHash,
      accumulator: acc,
      sampling: { method, populationEstimate: population, bounded, stride, orderedBy, evidence },
      maxRows,
      distinctCap: DISTINCT_EXACT_CAP,
      optedIn: new Set(
        run.request.optIns.filter((o) => o.object === object.name).map((o) => toSource(o.field)),
      ),
    });
    const baseline = await this.db.transaction(ctx, (tx) =>
      this.profiles.latestProfile(tx, run.connectionId, object.name, 'profile'),
    );
    const identity = new Set(
      object.fields.filter((f) => f.type === 'id' || f.unique).map((f) => names.toProfile(f.name)),
    );
    const findings = capFindings([
      ...documentFindings(document, { identityFields: identity }),
      ...(baseline ? driftFindings(document, baseline.document, { identityFields: identity }) : []),
    ]);
    // Findings (field name and evidence) pass the same independent scan as documents.
    for (const f of findings) assertNoRawFinding(f);
    return {
      object: object.name,
      document,
      contentHash: profileContentHash(document),
      ...(baseline ? { previousProfileId: baseline.id } : {}),
      findings,
    };
  }

  // --- Reads (CLI) ------------------------------------------------------------

  status(ctx: TenantContext, connectionId: string, runId?: string): Promise<ProfileRun[]> {
    return this.db.transaction(ctx, async (tx) => {
      if (runId) {
        const run = await this.profiles.run(tx, runId);
        return run && run.connectionId === connectionId ? [run] : [];
      }
      return this.profiles.listRuns(tx, connectionId);
    });
  }

  /** A profile (latest profile-family profile of the object unless an id is given). */
  show(
    ctx: TenantContext,
    connectionId: string,
    object: string,
    profileId?: string,
  ): Promise<StoredProfile | undefined> {
    return this.db.transaction(ctx, async (tx) => {
      const p = profileId
        ? await this.profiles.profile(tx, profileId)
        : await this.profiles.latestProfile(tx, connectionId, object, 'profile');
      return p && p.connectionId === connectionId && p.object === object ? p : undefined;
    });
  }

  /** Findings of the latest profile of each requested object (or of the latest completed run). */
  findings(
    ctx: TenantContext,
    connectionId: string,
    filter: { object?: string; severity?: FindingSeverity },
  ): Promise<StoredFinding[]> {
    return this.db.transaction(ctx, async (tx) => {
      let ids: string[];
      if (filter.object) {
        const latest = await this.profiles.latestProfile(
          tx,
          connectionId,
          filter.object,
          'profile',
        );
        ids = latest ? [latest.id] : [];
      } else {
        const run = (await this.profiles.listRuns(tx, connectionId, 50)).find(
          (r) => r.status === 'completed',
        );
        ids = run ? (await this.profiles.profilesOfRun(tx, run.id)).map((p) => p.id) : [];
      }
      if (ids.length === 0) return [];
      return this.profiles.findings(tx, {
        profileIds: ids,
        ...(filter.severity ? { severity: filter.severity } : {}),
      });
    });
  }

  /** Drift findings of the latest profile of an object against its baseline. */
  async drift(
    ctx: TenantContext,
    connectionId: string,
    object: string,
  ): Promise<{ profileId?: string; baselineId?: string; findings: StoredFinding[] }> {
    return this.db.transaction(ctx, async (tx) => {
      const latest = await this.profiles.latestProfile(tx, connectionId, object, 'profile');
      if (!latest) return { findings: [] };
      const all = await this.profiles.findings(tx, { profileIds: [latest.id] });
      return {
        profileId: latest.id,
        ...(latest.previousProfileId ? { baselineId: latest.previousProfileId } : {}),
        findings: all.filter((f) => f.code.startsWith('profile_drift_')),
      };
    });
  }

  /**
   * A DRAFT mapping skeleton from the latest profiles (§1.4): technical
   * suggestions only. It names no canonical target, never publishes, and
   * leaves every consequential choice for the operator (`entity: "tbc"`,
   * every field `ignored` with reason `not_reviewed`).
   */
  async draftMapping(ctx: TenantContext, connectionId: string): Promise<Record<string, unknown>> {
    return this.db.transaction(ctx, async (tx) => {
      const snapshot = await this.repo.latestSnapshot(tx, connectionId);
      if (!snapshot)
        throw new SourcesError('no_schema_snapshot', 'Capture a schema snapshot first');
      const schema = SourceSchemaSchema.parse(snapshot.document);
      const objects: Array<Record<string, unknown>> = [];
      const suggestions: Record<string, Record<string, unknown>> = {};
      const profileIds: string[] = [];
      // Names that cannot be stored never reach a draft: a redacted field is not a
      // source name a mapping could read, so it is left out and counted.
      const redactedFields: Record<string, number> = {};
      for (const object of schema.objects) {
        if (isRedactedName(object.name)) continue; // never profiled (refused at request)
        const p = await this.profiles.latestProfile(tx, connectionId, object.name, 'profile');
        if (!p || p.schemaSnapshotHash !== snapshot.hash) continue;
        profileIds.push(p.id);
        const plain = p.document.fields.filter((f) => !f.nameRedacted);
        if (plain.length < p.document.fields.length)
          redactedFields[object.name] = p.document.fields.length - plain.length;
        const declaredId = object.fields.find((f) => f.type === 'id')?.name;
        const idField =
          declaredId !== undefined
            ? isRedactedName(declaredId)
              ? undefined
              : declaredId
            : plain.find((f) =>
                f.suggestions.some(
                  (s) => s.interpretation === 'identifier' && s.confidence === 'high',
                ),
              )?.name;
        objects.push({
          source: object.name,
          entity: 'tbc',
          identity: { field: idField ?? 'tbc' },
          relationships: [],
          fields: plain.map((f) => ({
            kind: 'ignored',
            source: f.name,
            reason: 'not_reviewed',
          })),
        });
        suggestions[object.name] = Object.fromEntries(
          plain.map((f) => [
            f.name,
            f.suggestions.map((s) => `${s.interpretation}:${s.confidence}`),
          ]),
        );
      }
      return {
        draft: true,
        note: 'DRAFT: not publishable as is. Choose entities, targets, holding filters and reviewed domains explicitly.',
        schemaSnapshotHash: snapshot.hash,
        basedOnProfiles: profileIds,
        document: { objects },
        fieldSuggestions: suggestions,
        ...(Object.keys(redactedFields).length > 0
          ? {
              redactedFields,
              redactedNote:
                'Fields whose source names cannot be stored are left out; map them by their source name from the schema snapshot.',
            }
          : {}),
      };
    });
  }
}

function profileErrorCode(err: unknown): string {
  if (err instanceof ProfileRunError) return err.code;
  if (err instanceof SourcesError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'profile_privacy_violation' || code === 'profile_document_invalid') return code;
  if (isConnectorError(err)) return `source_${err.kind}`;
  return 'internal_error';
}
