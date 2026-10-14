import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  canonicalHash,
  ENTITY_INDEX_SOURCES,
  INTEGRITY_MAX_FINDINGS,
  integrityCounts,
  integrityOutcome,
  type EntityIndexKind,
  type IntegrityFinding,
  type IntegrityOutcome,
} from '../../domain';
import {
  AuditFailures,
  AuditTrail,
  assertAuthorized,
  PrivilegeManifestCheck,
  SecurityEventsService,
  tenantClient,
  TenantDatabase,
  type AuthorizedContext,
  type TenantContext,
  type TenantTransaction,
} from '../../tenancy';

export interface IntegrityReport {
  readonly outcome: IntegrityOutcome;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly checks: Readonly<Record<string, number>>;
  /** Capped at INTEGRITY_MAX_FINDINGS; identifiers and codes only. */
  readonly findings: readonly IntegrityFinding[];
  readonly truncated: boolean;
}

/**
 * Integrity verification (M10 plan §18 layer 3; M10A2 plan §11). Per tenant,
 * read-only on canonical data, never across tenants (it runs in one tenant
 * transaction as the app role, so row-level security bounds every query).
 * Findings are reported and raised as a security event; nothing is repaired.
 */
@Injectable()
export class IntegrityVerificationService {
  constructor(
    private readonly db: TenantDatabase,
    readonly audit: AuditTrail,
    private readonly events: SecurityEventsService,
    private readonly privileges: PrivilegeManifestCheck,
  ) {}

  /** Dry run: the report only, nothing recorded. */
  async verify(ctx: TenantContext): Promise<IntegrityReport> {
    const startedAt = new Date();
    const findings = await this.db.transaction(ctx, (tx) => this.collect(tx));
    for (const table of await this.privileges.run()) {
      findings.push({ check: 'privilege_manifest_mismatch', ref: table });
    }
    const report = this.report(startedAt, findings);
    this.emit(ctx, report);
    return report;
  }

  /** Runs the checks and records the completed run with one audit event. */
  @AuditFailures('integrity.verify', 'integrity_run')
  async record(
    actx: AuthorizedContext<'security.integrity.run'>,
  ): Promise<IntegrityReport & { readonly runId: string }> {
    assertAuthorized(actx, 'security.integrity.run');
    const report = await this.verify(actx.tenant);
    const runId = randomUUID();
    await this.db.transaction(actx.tenant, async (tx) => {
      const auditEventId = await this.audit.recordReturningId(tx, actx, {
        action: 'integrity.verify',
        targetKind: 'integrity_run',
        targetRef: runId,
        details: { outcome: report.outcome, findings: report.findings.length },
      });
      await tenantClient(tx).tenantIntegrityRun.create({
        data: {
          tenantId: tx.tenantId,
          id: runId,
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          outcome: report.outcome,
          checks: report.checks,
          findings: report.findings.map((f) => ({ check: f.check, ref: f.ref })),
          actorKind: actx.actor.kind,
          actorId: actx.actor.id,
          actorAssurance: actx.actor.assurance,
          correlationId: actx.correlationId,
          auditEventId,
        },
      });
    });
    return { ...report, runId };
  }

  private report(startedAt: Date, findings: IntegrityFinding[]): IntegrityReport {
    return {
      outcome: integrityOutcome(findings),
      startedAt,
      finishedAt: new Date(),
      checks: integrityCounts(findings),
      findings: findings.slice(0, INTEGRITY_MAX_FINDINGS),
      truncated: findings.length > INTEGRITY_MAX_FINDINGS,
    };
  }

  private emit(ctx: TenantContext, report: IntegrityReport): void {
    if (report.outcome === 'passed') {
      this.events.emit({
        event: 'integrity_run_completed',
        outcome: 'completed',
        tenant: ctx.tenantSlug,
        reasonCode: 'passed',
      });
      return;
    }
    const codes = Object.entries(report.checks)
      .filter(([, n]) => n > 0)
      .map(([c]) => c)
      .sort();
    this.events.emit({
      event: 'integrity_violation_detected',
      outcome: 'detected',
      tenant: ctx.tenantSlug,
      reasonCode: codes[0] ?? 'findings',
      coordinates: { checks: codes.join(','), findings: String(report.findings.length) },
    });
  }

  private async collect(tx: TenantTransaction): Promise<IntegrityFinding[]> {
    const db = tenantClient(tx);
    const t = tx.tenantId;
    const findings: IntegrityFinding[] = [];
    const add = (check: IntegrityFinding['check'], refs: readonly string[]) =>
      refs.forEach((ref) => findings.push({ check, ref }));

    // 1. Entity index ↔ entity tables, both directions, per kind, tenant equality explicit.
    for (const [kind, src] of Object.entries(ENTITY_INDEX_SOURCES) as [
      EntityIndexKind,
      (typeof ENTITY_INDEX_SOURCES)[EntityIndexKind],
    ][]) {
      const idCol = src.column === 'key' ? 'entity_key' : 'entity_id';
      const cast = src.column === 'key' ? '' : '::uuid';
      const missing = await db.$queryRawUnsafe<{ ref: string }[]>(
        `SELECT e."${src.column}"::text AS ref FROM "${src.table}" e
          WHERE e.tenant_id = $1::uuid AND NOT EXISTS (
            SELECT 1 FROM tenant_entity_index i
             WHERE i.tenant_id = e.tenant_id AND i.kind = $2 AND i.${idCol} = e."${src.column}"${cast})
          ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`,
        t,
        kind,
      );
      add(
        'entity_index_missing',
        missing.map((r) => `${kind}:${r.ref}`),
      );
      const orphans = await db.$queryRawUnsafe<{ ref: string; tenant_ok: boolean }[]>(
        `SELECT i.${idCol}::text AS ref, i.tenant_id = $1::uuid AS tenant_ok FROM tenant_entity_index i
          WHERE i.kind = $2 AND NOT EXISTS (
            SELECT 1 FROM "${src.table}" e
             WHERE e.tenant_id = i.tenant_id AND e."${src.column}"${cast} = i.${idCol})
          ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`,
        t,
        kind,
      );
      add(
        'entity_index_orphan',
        orphans.filter((r) => r.tenant_ok).map((r) => `${kind}:${r.ref}`),
      );
      add(
        'entity_index_tenant_mismatch',
        orphans.filter((r) => !r.tenant_ok).map((r) => `${kind}:${r.ref}`),
      );
    }

    // 2. Value history rows are anchored in the index.
    const unindexed = await db.$queryRaw<{ ref: string }[]>`
      SELECT h.id::text AS ref FROM tenant_value_history h
       WHERE NOT EXISTS (SELECT 1 FROM tenant_entity_index i
                          WHERE i.tenant_id = h.tenant_id AND i.kind = h.entity_kind
                            AND (i.entity_id = h.entity_id OR i.entity_key = h.entity_key))
       ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'value_history_unindexed',
      unindexed.map((r) => r.ref),
    );

    // 3. Adoption chain: dense from 1, linked, only baseline rows without an audit event.
    const chain = await db.tenantCanonicalAdoption.findMany({ orderBy: { seq: 'asc' } });
    if (chain.length === 0) add('adoption_chain_invalid', ['empty']);
    chain.forEach((row, i) => {
      const prev = chain[i - 1];
      if (
        row.seq !== i + 1 ||
        (prev ? row.previousVersion !== prev.version : row.previousVersion !== null)
      ) {
        add('adoption_chain_invalid', [`seq:${row.seq}`]);
      }
      if (row.auditEventId === null && row.reason !== 'baseline') {
        add('adoption_audit_missing', [`seq:${row.seq}`]);
      }
    });

    // 4. Module settings equal their last setting event.
    const settings = await db.tenantModuleSetting.findMany();
    for (const s of settings) {
      const last = await db.tenantModuleSettingEvent.findFirst({
        where: { moduleKey: s.moduleKey },
        orderBy: { seq: 'desc' },
      });
      if (!last || last.toEnabled !== s.enabled || last.toConfigHash !== canonicalHash(s.config)) {
        add('module_setting_mismatch', [s.moduleKey]);
      }
    }

    // 5. Registry projection keys equal the union of version keys (X1); versions exist.
    const versions = await db.tenantRegistryVersion.findMany({
      select: { kind: true, version: true, document: true },
    });
    const entries = await db.tenantRegistryEntry.findMany({
      select: { kind: true, key: true, lastChangedIn: true },
    });
    const expected = new Set(
      versions.map((v) => (v.kind === 'data_policy' ? `data_policy:data_policy` : `${v.kind}:?`)),
    );
    for (const key of expected) {
      if (!key.endsWith(':?') && !entries.some((e) => `${e.kind}:${e.key}` === key)) {
        add('registry_projection_mismatch', [key]);
      }
    }
    for (const e of entries) {
      if (!versions.some((v) => v.kind === e.kind && v.version === e.lastChangedIn)) {
        add('registry_projection_mismatch', [`${e.kind}:${e.key}`]);
      }
    }

    // 6. Mapping lifecycle: every version has a state, at most one published per connection.
    const lifecycle = await db.$queryRaw<{ ref: string }[]>`
      SELECT v.connection_id::text || '/v' || v.version AS ref
        FROM tenant_source_mapping_versions v
       WHERE NOT EXISTS (SELECT 1 FROM tenant_source_mapping_lifecycle l
                          WHERE l.tenant_id = v.tenant_id AND l.connection_id = v.connection_id
                            AND l.version = v.version)
      UNION ALL
      SELECT s.connection_id::text AS ref FROM tenant_source_mapping_states s
       WHERE s.state = 'published' GROUP BY s.connection_id HAVING count(*) > 1
       ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'mapping_lifecycle_invalid',
      lifecycle.map((r) => r.ref),
    );
    return findings;
  }
}
