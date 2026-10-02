import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { SubscriptionObservation, SubscriptionSource } from '../../domain';
import { TenantDatabase, type TenantContext } from '../../tenancy';
import { SubscriptionRunsStore, type ImportMode } from '../infrastructure/subscription-runs.store';
import { SubscriptionQueries } from '../infrastructure/subscription.queries';
import { parseSubscriptionCsv, type CsvError, type CsvLine } from './subscription-csv';
import {
  SubscriptionIngestionService,
  type SubscriptionIngestOutcome,
} from './subscription-ingestion.service';

export const CSV_IMPORT_ADAPTER = 'csv_import';
export const CSV_IMPORT_ADAPTER_VERSION = 'm7.0';

const SOURCE_NAME = /^[A-Za-z0-9_]{1,100}$/;
const RESERVED_SOURCES = new Set(['legacy_company_product']);

export interface ImportRequest {
  /** Source name (`source_object_type`); a full import tombstones only this source's lines. */
  readonly source: string;
  readonly mode: 'full' | 'incremental';
  readonly execute: boolean;
  readonly correlationId: string;
  /** Allow a full import of a reserved source (the migrated legacy lines). */
  readonly allowReservedSource?: boolean;
}

export interface RowRejection {
  readonly row: number;
  readonly reason: 'unknown_account' | 'unknown_product' | 'invalid_observation';
}

export interface ImportReport {
  readonly executed: boolean;
  readonly mode: 'full' | 'incremental';
  readonly source: string;
  readonly inputHash: string;
  readonly rows: number;
  readonly parseErrors: readonly CsvError[];
  readonly rejected: readonly RowRejection[];
  readonly outcomes: Record<string, number>;
  /** Lines a full import would tombstone / did tombstone. */
  readonly tombstoned: number;
  readonly checkpointId?: string;
  readonly status: 'valid' | 'invalid' | 'completed' | 'failed';
  /** Whether the tenant's ownership coverage is known after this run. */
  readonly coverageKnown: boolean;
}

/**
 * Operator CSV import into the single subscription writer (ADR 0017 §4).
 *
 * - Dry run by default: parse, resolve accounts and products, count what a
 *   full load would tombstone; nothing written.
 * - The whole file is validated first; a malformed file writes nothing.
 * - Execute: a checkpoint (`kind = subscription`, `mode = import_full |
 *   import_incremental`) records the run; each line goes through
 *   `SubscriptionIngestionService` in its own transaction.
 * - A full run tombstones this source's lines not seen in the run, then
 *   completes — which is what makes ownership coverage known. A full run with
 *   any rejected row fails instead: no tombstone pass, coverage unchanged.
 * - A run killed midway stays `running` (coverage unchanged) until an operator
 *   cancels it.
 */
@Injectable()
export class SubscriptionImportService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly writer: SubscriptionIngestionService,
    private readonly queries: SubscriptionQueries,
    private readonly runs: SubscriptionRunsStore,
  ) {}

  async import(
    ctx: TenantContext,
    file: Uint8Array,
    request: ImportRequest,
  ): Promise<ImportReport> {
    if (!SOURCE_NAME.test(request.source))
      throw new Error('--source must match [A-Za-z0-9_]{1,100}');
    if (RESERVED_SOURCES.has(request.source) && !request.allowReservedSource) {
      throw new Error(`source "${request.source}" is reserved for migrated lines`);
    }
    const inputHash = createHash('sha256').update(file).digest('hex');
    const base = { mode: request.mode, source: request.source, inputHash };
    const parsed = parseSubscriptionCsv(file);
    if (!parsed.ok) {
      return {
        ...base,
        executed: false,
        rows: 0,
        parseErrors: parsed.errors,
        rejected: [],
        outcomes: {},
        tombstoned: 0,
        status: 'invalid',
        coverageKnown: await this.coverageKnown(ctx),
      };
    }
    const lines = parsed.lines;
    return request.execute
      ? this.execute(ctx, lines, request, base)
      : this.dryRun(ctx, lines, request, base);
  }

  /** Marks a run that was killed midway as cancelled (coverage stays as it was). */
  async cancel(ctx: TenantContext, checkpointId: string): Promise<{ cancelled: boolean }> {
    return this.db.transaction(ctx, async (tx) => {
      const running = await this.runs.running(tx);
      if (!running || running.id !== checkpointId) return { cancelled: false };
      await this.runs.finish(tx, checkpointId, {
        status: 'cancelled',
        seen: running.recordsSeen,
        changed: running.recordsChanged,
        skipped: running.recordsSkipped,
        failed: running.recordsFailed,
        errorCode: 'cancelled_by_operator',
      });
      return { cancelled: true };
    });
  }

  private async dryRun(
    ctx: TenantContext,
    lines: readonly CsvLine[],
    request: ImportRequest,
    base: { mode: 'full' | 'incremental'; source: string; inputHash: string },
  ): Promise<ImportReport> {
    return this.db.transaction(ctx, async (tx) => {
      const rejected: RowRejection[] = [];
      for (const line of lines) {
        if (line.presence === 'absent') continue;
        if (!(await this.queries.resolveCompany(tx, line.account)))
          rejected.push({ row: line.row, reason: 'unknown_account' });
        else if (!(await this.writer.resolvesProduct(tx, line.product)))
          rejected.push({ row: line.row, reason: 'unknown_product' });
      }
      let tombstoned = 0;
      if (request.mode === 'full') {
        const ids = new Set(lines.filter((l) => l.presence === 'present').map((l) => l.recordId));
        const existing = await this.queries.activeRecordIds(tx, 'import', request.source);
        tombstoned = existing.filter((id) => !ids.has(id)).length;
      }
      return {
        ...base,
        executed: false,
        rows: lines.length,
        parseErrors: [],
        rejected,
        outcomes: {},
        tombstoned,
        status: 'valid',
        coverageKnown: (await this.runs.coverageKnownAsOf(tx)) !== undefined,
      };
    });
  }

  private async execute(
    ctx: TenantContext,
    lines: readonly CsvLine[],
    request: ImportRequest,
    base: { mode: 'full' | 'incremental'; source: string; inputHash: string },
  ): Promise<ImportReport> {
    const mode: ImportMode = request.mode === 'full' ? 'import_full' : 'import_incremental';
    // One read time for every line of the run: each line seen here gets
    // lastSeenAt >= runObservedAt, so the tombstone pass (lastSeenAt <
    // runObservedAt) can only hit lines this file did not contain.
    const runObservedAt = new Date();
    const checkpointId = await this.db.transaction(ctx, (tx) =>
      this.runs.start(tx, {
        mode,
        inputHash: base.inputHash,
        correlationId: request.correlationId,
      }),
    );
    const meta = {
      cause: 'import' as const,
      correlationId: request.correlationId,
      checkpointId,
      adapter: CSV_IMPORT_ADAPTER,
      adapterVersion: CSV_IMPORT_ADAPTER_VERSION,
    };
    const outcomes: Record<string, number> = {};
    const rejected: RowRejection[] = [];
    const count = (o: SubscriptionIngestOutcome) => {
      outcomes[o.outcome] = (outcomes[o.outcome] ?? 0) + 1;
    };
    try {
      for (const line of lines) {
        const result = await this.writer.ingest(
          ctx,
          this.observation(line, request.source, runObservedAt),
          meta,
        );
        count(result);
        if (result.outcome === 'rejected') rejected.push({ row: line.row, reason: result.reason });
      }
      let tombstoned = 0;
      let status: 'completed' | 'failed' = 'completed';
      if (request.mode === 'full') {
        if (rejected.length > 0) status = 'failed';
        else {
          const unseen = await this.db.transaction(ctx, (tx) =>
            this.queries.unseenSince(tx, 'import', request.source, runObservedAt),
          );
          for (const row of unseen) {
            const result = await this.writer.ingest(
              ctx,
              { presence: 'absent', source: row.source, observedAt: new Date() },
              meta,
            );
            if (result.outcome === 'deleted') tombstoned += 1;
          }
        }
      }
      const changed =
        ['created', 'updated', 'restored', 'deleted'].reduce((n, k) => n + (outcomes[k] ?? 0), 0) +
        tombstoned;
      await this.db.transaction(ctx, (tx) =>
        this.runs.finish(tx, checkpointId, {
          status,
          seen: lines.length,
          changed,
          skipped:
            (outcomes['unchanged'] ?? 0) + (outcomes['stale'] ?? 0) + (outcomes['not_found'] ?? 0),
          failed: rejected.length,
          ...(status === 'failed' ? { errorCode: 'rows_rejected' } : {}),
        }),
      );
      return {
        ...base,
        executed: true,
        rows: lines.length,
        parseErrors: [],
        rejected,
        outcomes,
        tombstoned,
        checkpointId,
        status,
        coverageKnown: await this.coverageKnown(ctx),
      };
    } catch (error) {
      await this.db
        .transaction(ctx, (tx) =>
          this.runs.finish(tx, checkpointId, {
            status: 'failed',
            seen: lines.length,
            changed: 0,
            skipped: 0,
            failed: rejected.length,
            errorCode: 'import_error',
          }),
        )
        .catch(() => undefined);
      throw error;
    }
  }

  private observation(line: CsvLine, source: string, observedAt: Date): SubscriptionObservation {
    const ref: SubscriptionSource = {
      system: 'import',
      objectType: source,
      recordId: line.recordId,
    };
    if (line.presence === 'absent') {
      return {
        presence: 'absent',
        source: ref,
        observedAt,
        ...(line.sourceUpdatedAt ? { sourceUpdatedAt: line.sourceUpdatedAt } : {}),
      };
    }
    return {
      presence: 'present',
      source: ref,
      companyRef: line.account,
      productRef: line.product,
      state: line.state,
      ...(line.startsAt ? { startsAt: line.startsAt } : {}),
      ...(line.endsAt ? { endsAt: line.endsAt } : {}),
      ...(line.quantity !== undefined ? { quantity: line.quantity } : {}),
      ...(line.sourceUpdatedAt ? { sourceUpdatedAt: line.sourceUpdatedAt } : {}),
      observedAt,
    };
  }

  private async coverageKnown(ctx: TenantContext): Promise<boolean> {
    return this.db.transaction(
      ctx,
      async (tx) => (await this.runs.coverageKnownAsOf(tx)) !== undefined,
    );
  }
}
