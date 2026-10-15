import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import {
  canonicalHash,
  HIERARCHY_MAX_DEPTH_CEILING,
  ENTITY_INDEX_SOURCES,
  evidenceRelationAllowed,
  INTEGRITY_MAX_FINDINGS,
  integrityCounts,
  integrityOutcome,
  type EntityIndexKind,
  type EvidenceRelation,
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
import { EVIDENCE_RELATION_CATALOGUE } from './evidence-link.writer';

/** Clock-skew tolerance past a purge anchor's cutoff (audit_reference_missing exemption). */
const AUDIT_PURGE_SKEW_MS = 5 * 60 * 1000;

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
    @Inject(EVIDENCE_RELATION_CATALOGUE) private readonly relations: readonly EvidenceRelation[],
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
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

    // 1. Entity index ↔ entity tables, both directions, per kind. There is no FK
    // between them: tenant equality comes from the index triggers copying
    // NEW.tenant_id, and under RLS a planted cross-tenant row is an orphan here.
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
      const orphans = await db.$queryRawUnsafe<{ ref: string }[]>(
        `SELECT i.${idCol}::text AS ref FROM tenant_entity_index i
          WHERE i.tenant_id = $1::uuid AND i.kind = $2 AND NOT EXISTS (
            SELECT 1 FROM "${src.table}" e
             WHERE e.tenant_id = i.tenant_id AND e."${src.column}"${cast} = i.${idCol})
          ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`,
        t,
        kind,
      );
      add(
        'entity_index_orphan',
        orphans.map((r) => `${kind}:${r.ref}`),
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

    // 3b. Audit pointers (no foreign key, see ADR 0027): every governance row's
    // audit event exists. Only rows older than the latest purge anchor's cutoff
    // (plus AUDIT_PURGE_SKEW) are exempt, since only their events can have been
    // purged; purge execution is disabled today.
    const anchor = await db.tenantAuditAnchor.findFirst({
      orderBy: { anchorSeq: 'desc' },
      select: { cutoff: true },
    });
    const exemptBefore = anchor ? new Date(anchor.cutoff.getTime() + AUDIT_PURGE_SKEW_MS) : null;
    const dangling = await db.$queryRaw<{ ref: string }[]>`
      SELECT 'adoption:' || x.seq AS ref FROM tenant_canonical_adoptions x
       WHERE x.audit_event_id IS NOT NULL
         AND (${exemptBefore}::timestamptz IS NULL OR x.adopted_at >= ${exemptBefore}::timestamptz)
         AND NOT EXISTS (
         SELECT 1 FROM tenant_audit_events e WHERE e.tenant_id = x.tenant_id AND e.id = x.audit_event_id)
      UNION ALL
      SELECT 'module:' || x.module_key || ':' || x.seq FROM tenant_module_setting_events x
       WHERE (${exemptBefore}::timestamptz IS NULL OR x.occurred_at >= ${exemptBefore}::timestamptz)
         AND NOT EXISTS (
         SELECT 1 FROM tenant_audit_events e WHERE e.tenant_id = x.tenant_id AND e.id = x.audit_event_id)
      UNION ALL
      SELECT 'registry:' || x.kind || ':' || x.version FROM tenant_registry_versions x
       WHERE (${exemptBefore}::timestamptz IS NULL OR x.published_at >= ${exemptBefore}::timestamptz)
         AND NOT EXISTS (
         SELECT 1 FROM tenant_audit_events e WHERE e.tenant_id = x.tenant_id AND e.id = x.audit_event_id)
      UNION ALL
      SELECT 'mapping:' || x.connection_id || '/v' || x.version || ':' || x.seq FROM tenant_source_mapping_lifecycle x
       WHERE x.audit_event_id IS NOT NULL
         AND (${exemptBefore}::timestamptz IS NULL OR x.occurred_at >= ${exemptBefore}::timestamptz)
         AND NOT EXISTS (
         SELECT 1 FROM tenant_audit_events e WHERE e.tenant_id = x.tenant_id AND e.id = x.audit_event_id)
      UNION ALL
      SELECT 'integrity_run:' || x.id FROM tenant_integrity_runs x
       WHERE (${exemptBefore}::timestamptz IS NULL OR x.started_at >= ${exemptBefore}::timestamptz)
         AND NOT EXISTS (
         SELECT 1 FROM tenant_audit_events e WHERE e.tenant_id = x.tenant_id AND e.id = x.audit_event_id)
      ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'audit_reference_missing',
      dangling.map((r) => r.ref),
    );

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

    // M10B plan §11 (ADR 0028).
    await this.referenceChecks(tx, add);
    // M10C plan §11 (ADR 0029).
    await this.accountStructureChecks(tx, add);
    return findings;
  }

  /** The six M10C checks: read-only, identifiers only, nothing repaired. */
  private async accountStructureChecks(
    tx: TenantTransaction,
    add: (check: IntegrityFinding['check'], refs: readonly string[]) => void,
  ): Promise<void> {
    const db = tenantClient(tx);
    const t = tx.tenantId;
    const maxDepth =
      (this.config as Partial<AppConfig> | undefined)?.canonical?.hierarchyMaxDepth ?? 10;
    // Walk ancestors from every account with a parent, bounded by the trigger ceiling.
    const walk = await db.$queryRaw<{ id: string; reached: boolean; steps: number }[]>`
      WITH RECURSIVE up (start_id, cur, steps, reached) AS (
        SELECT c.id, c.parent_company_id, 1, c.parent_company_id = c.id FROM companies c
         WHERE c.tenant_id = ${t}::uuid AND c.parent_company_id IS NOT NULL
        UNION ALL
        SELECT up.start_id, c.parent_company_id, up.steps + 1, c.parent_company_id = up.start_id
          FROM up JOIN companies c ON c.tenant_id = ${t}::uuid AND c.id = up.cur
         WHERE NOT up.reached AND c.parent_company_id IS NOT NULL AND up.steps < ${HIERARCHY_MAX_DEPTH_CEILING + 1}
      )
      SELECT start_id::text AS id, bool_or(reached) AS reached, max(steps)::int AS steps
        FROM up GROUP BY start_id ORDER BY 1`;
    // 13. No account reaches itself (impossible with the trigger; detects owner tampering).
    add(
      'hierarchy_cycle',
      walk
        .filter((r) => r.reached)
        .slice(0, INTEGRITY_MAX_FINDINGS)
        .map((r) => r.id),
    );
    // 14. No account deeper than the current guardrail (depth = edges to the root).
    add(
      'hierarchy_depth_exceeded',
      walk
        .filter((r) => !r.reached && r.steps > maxDepth)
        .slice(0, INTEGRITY_MAX_FINDINGS)
        .map((r) => r.id),
    );
    // 15. No live account has a merged parent.
    const mergedParent = await db.$queryRaw<{ ref: string }[]>`
      SELECT c.id::text AS ref FROM companies c
        JOIN companies p ON p.tenant_id = c.tenant_id AND p.id = c.parent_company_id
       WHERE c.tenant_id = ${t}::uuid AND c.record_state <> 'merged' AND p.record_state = 'merged'
       ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'hierarchy_parent_merged',
      mergedParent.map((r) => r.ref),
    );
    // 16. The current parent equals the new value of its latest value-history row (when one exists).
    const parity = await db.$queryRaw<{ ref: string }[]>`
      SELECT c.id::text AS ref FROM companies c
        JOIN LATERAL (
          SELECT h.new_value, h.values_recorded FROM tenant_value_history h
           WHERE h.tenant_id = c.tenant_id AND h.entity_kind = 'company' AND h.entity_id = c.id
             AND h.field = 'parent_company_id'
           ORDER BY h.recorded_at DESC, h.id DESC LIMIT 1) last ON true
       WHERE c.tenant_id = ${t}::uuid AND last.values_recorded
         AND (last.new_value #>> '{}') IS DISTINCT FROM c.parent_company_id::text
       ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'hierarchy_history_parity',
      parity.map((r) => r.ref),
    );
    // 17. No active affiliation points at a merged person or company.
    const endpoint = await db.$queryRaw<{ ref: string }[]>`
      SELECT a.id::text AS ref FROM tenant_person_affiliations a
        JOIN persons p ON p.tenant_id = a.tenant_id AND p.id = a.person_id
        JOIN companies c ON c.tenant_id = a.tenant_id AND c.id = a.company_id
       WHERE a.tenant_id = ${t}::uuid AND a.status = 'active'
         AND (p.record_state = 'merged' OR c.record_state = 'merged')
       ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'affiliation_endpoint_merged',
      endpoint.map((r) => r.ref),
    );
    // 18. Every person_affiliation generic reference resolves to an affiliation of the tenant.
    const orphanRefs = await db.$queryRaw<{ ref: string }[]>`
      SELECT r.id::text AS ref FROM tenant_source_references r
       WHERE r.tenant_id = ${t}::uuid AND r.entity_kind = 'person_affiliation'
         AND NOT EXISTS (SELECT 1 FROM tenant_person_affiliations a
                          WHERE a.tenant_id = r.tenant_id AND a.id = r.entity_id)
       ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'affiliation_reference_parity',
      orphanRefs.map((r) => r.ref),
    );
  }

  private async referenceChecks(
    tx: TenantTransaction,
    add: (check: IntegrityFinding['check'], refs: readonly string[]) => void,
  ): Promise<void> {
    const db = tenantClient(tx);
    const triple = (s: string, o: string, e: string) => `${s}:${o}:${e}`;

    // 7. Declared product references = the externalRefs of the latest published
    // model, both directions, same key (the projection never drifts from the model).
    const latest = await db.tenantProductModel.findFirst({
      orderBy: { version: 'desc' },
      select: { document: true },
    });
    const doc = latest?.document as {
      products?: {
        key: string;
        externalRefs?: { system: string; objectType: string; id: string }[];
      }[];
    } | null;
    const declared = new Map<string, string>();
    for (const p of doc?.products ?? []) {
      for (const r of p.externalRefs ?? [])
        declared.set(triple(r.system, r.objectType, r.id), p.key);
    }
    const active = await db.tenantSourceReference.findMany({
      where: { origin: 'declared', state: 'active' },
      select: { system: true, objectType: true, externalId: true, entityKey: true },
    });
    const stored = new Map(
      active.map((r) => [triple(r.system, r.objectType, r.externalId), r.entityKey]),
    );
    const drift: string[] = [];
    for (const [t, key] of declared) if (stored.get(t) !== key) drift.push(t);
    for (const t of stored.keys()) if (!declared.has(t)) drift.push(t);
    add('declared_reference_drift', [...new Set(drift)].sort().slice(0, INTEGRITY_MAX_FINDINGS));

    // 8. One (system, object_type, external_id) lives in at most one store.
    const ambiguous = await db.$queryRaw<{ ref: string }[]>`
      SELECT system || ':' || object_type || ':' || external_id AS ref
        FROM source_reference_index WHERE tenant_id = ${tx.tenantId}::uuid
       GROUP BY system, object_type, external_id HAVING count(DISTINCT store) > 1
       ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'source_reference_ambiguous',
      ambiguous.map((r) => r.ref),
    );

    // 9. last_change_id names a change record of the same triple and entity.
    const mismatch = await db.$queryRaw<{ ref: string }[]>`
      SELECT r.id::text AS ref FROM tenant_source_references r
        JOIN tenant_context_changes c ON c.tenant_id = r.tenant_id AND c.id = r.last_change_id
       WHERE c.source_system <> r.system OR c.source_object_type <> r.object_type
          OR c.source_record_id <> r.external_id OR c.entity_kind <> r.entity_kind
          OR c.entity_id IS DISTINCT FROM r.entity_id OR c.entity_key IS DISTINCT FROM r.entity_key
       ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'source_reference_change_mismatch',
      mismatch.map((r) => r.ref),
    );

    // 10. Every link's relation is in the code catalogue (catches raw-SQL writes).
    // Distinct relation tuples first (no set id, so no bound can hide a late
    // set; the columns are CHECK-constrained, so the tuple set is small), the
    // catalogue filter in code, then up to INTEGRITY_MAX_FINDINGS set ids of
    // the unknown tuples only.
    const tuples = await db.$queryRaw<
      { subject_kind: string; evidence_type: string; evidence_kind: string | null; role: string }[]
    >`SELECT DISTINCT subject_kind, evidence_type, evidence_kind, role FROM tenant_evidence_links`;
    const unknown = tuples.filter(
      (r) =>
        !evidenceRelationAllowed(this.relations, r.subject_kind, {
          evidenceType: r.evidence_type,
          evidenceKind: r.evidence_kind,
          role: r.role,
        }),
    );
    let unknownSets: { ref: string }[] = [];
    if (unknown.length > 0) {
      const params: string[] = [];
      const where = unknown
        .map((r) => {
          params.push(r.subject_kind, r.evidence_type, r.evidence_kind ?? '', r.role);
          const n = params.length;
          return `(subject_kind = $${n - 3} AND evidence_type = $${n - 2} AND coalesce(evidence_kind, '') = $${n - 1} AND role = $${n})`;
        })
        .join(' OR ');
      unknownSets = await db.$queryRawUnsafe<{ ref: string }[]>(
        `SELECT DISTINCT link_set_id::text AS ref FROM tenant_evidence_links WHERE ${where} ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`,
        ...params,
      );
    }
    add(
      'evidence_relation_unknown',
      unknownSets.map((r) => r.ref),
    );

    // 11. supersedes_link_set_id names an existing set of the same subject, and
    // a set is superseded at most once (a linear chain, ADR 0028); a fork
    // reports the superseded set.
    const supersession = await db.$queryRaw<{ ref: string }[]>`
      SELECT l.link_set_id::text AS ref FROM tenant_evidence_links l
       WHERE l.supersedes_link_set_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM tenant_evidence_links p
          WHERE p.tenant_id = l.tenant_id AND p.link_set_id = l.supersedes_link_set_id
            AND p.subject_kind = l.subject_kind
            AND p.subject_id IS NOT DISTINCT FROM l.subject_id
            AND p.subject_key IS NOT DISTINCT FROM l.subject_key)
      UNION
      SELECT supersedes_link_set_id::text FROM tenant_evidence_links
       WHERE supersedes_link_set_id IS NOT NULL
       GROUP BY supersedes_link_set_id HAVING count(DISTINCT link_set_id) > 1
       ORDER BY 1 LIMIT ${INTEGRITY_MAX_FINDINGS}`;
    add(
      'evidence_supersession_invalid',
      supersession.map((r) => r.ref),
    );

    // 12. The view returns every row of every store, nothing copied or lost.
    const parity = await db.$queryRaw<{ ref: string }[]>`
      WITH expected AS (
        SELECT 'company_external_refs' AS store, count(*) AS n FROM company_external_refs
        UNION ALL SELECT 'person_external_refs', count(*) FROM person_external_refs
        UNION ALL SELECT 'tenant_subscriptions', count(*) FROM tenant_subscriptions
        UNION ALL SELECT 'tenant_source_references', count(*) FROM tenant_source_references
      ), actual AS (
        SELECT store, count(*) AS n FROM source_reference_index GROUP BY store
      )
      SELECT e.store AS ref FROM expected e LEFT JOIN actual a USING (store)
       WHERE e.n <> coalesce(a.n, 0) ORDER BY 1`;
    add(
      'source_reference_index_parity',
      parity.map((r) => r.ref),
    );
  }
}
