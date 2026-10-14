import { Injectable } from '@nestjs/common';
import { ENTITY_INDEX_SOURCES, type EntityIndexKind } from '../../domain';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  tenantClient,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import { GovernanceError } from '../errors';

/** Read limits: identifiers only, bounded output. */
const MAX_ROWS = 200;
const FIELD_PATTERN = /^[A-Za-z0-9_.]{1,100}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProvenanceQuery {
  readonly kind: EntityIndexKind;
  readonly id?: string;
  readonly key?: string;
  /** When set, the latest change record naming the field and its value history. */
  readonly field?: string;
}

export interface ProvenanceReference {
  readonly store: string;
  readonly system: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly state: string;
  readonly origin: string;
  readonly firstSeenAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly sourceUpdatedAt: Date | null;
  readonly retiredAt: Date | null;
}

export interface ProvenanceField {
  readonly field: string;
  readonly change: {
    readonly id: string;
    readonly changeType: string;
    readonly source: {
      readonly system: string;
      readonly objectType: string;
      readonly recordId: string;
    };
    readonly cause: string;
    readonly checkpointId: string | null;
    readonly connectionId: string | null;
    readonly mappingVersion: number | null;
    readonly schemaSnapshotHash: string | null;
    readonly transforms: readonly string[];
    readonly origin: string | null;
    readonly derivation: unknown;
    readonly actor: {
      readonly kind: string | null;
      readonly id: string | null;
      readonly assurance: string | null;
    };
    readonly canonicalVersion: string | null;
    readonly ingestedAt: Date;
  } | null;
  /** Value history of that change; values only where `values_recorded` (M10A2 rule). */
  readonly history: readonly {
    readonly effectiveAt: Date;
    readonly valuesRecorded: boolean;
    readonly oldValue?: unknown;
    readonly newValue?: unknown;
    readonly retentionClass: string;
  }[];
}

export interface ProvenanceLinkSet {
  readonly linkSetId: string;
  readonly supersedesLinkSetId: string | null;
  readonly origin: string;
  readonly canonicalVersion: string;
  readonly createdAt: Date;
  readonly links: readonly {
    readonly ordinal: number;
    readonly evidenceType: string;
    readonly evidenceKind: string | null;
    readonly evidenceId: string | null;
    readonly evidenceKey: string | null;
    readonly evidenceChangeId: string | null;
    readonly evidenceSnapshotId: string | null;
    readonly role: string;
    readonly weight: string | null;
  }[];
}

export interface ProvenanceReport {
  readonly subject: { readonly kind: EntityIndexKind; readonly id?: string; readonly key?: string };
  readonly references: readonly ProvenanceReference[];
  readonly field?: ProvenanceField;
  readonly evidence: {
    readonly current: readonly ProvenanceLinkSet[];
    readonly superseded: readonly ProvenanceLinkSet[];
  };
  readonly citedBy: readonly {
    readonly linkSetId: string;
    readonly subjectKind: string;
    readonly subjectId: string | null;
    readonly subjectKey: string | null;
    readonly role: string;
  }[];
}

/**
 * The provenance read model (M10B plan §5, ADR 0028). Read-only on canonical
 * data: references from the `source_reference_index` view, the latest change
 * record naming a field (and its value history, values only where recorded),
 * evidence link sets of the subject (current and superseded) and the reverse
 * lookup. Never reads a value from a canonical row. Each call writes one
 * `provenance.read` audit event (allowed; counts only).
 */
@Injectable()
export class ProvenanceQueryService {
  constructor(
    private readonly db: TenantDatabase,
    readonly audit: AuditTrail,
  ) {}

  @AuditFailures('provenance.read', 'provenance')
  async show(
    actx: AuthorizedContext<'data.provenance.read'>,
    query: ProvenanceQuery,
  ): Promise<ProvenanceReport> {
    assertAuthorized(actx, 'data.provenance.read');
    const subject = this.subject(query);
    return this.db.transaction(actx.tenant, async (tx) => {
      const references = await this.references(tx, subject);
      const field = query.field ? await this.field(tx, subject, query.field) : undefined;
      const evidence = await this.evidence(tx, subject);
      const citedBy = await this.citedBy(tx, subject);
      await this.audit.record(tx, actx, {
        action: 'provenance.read',
        targetKind: 'provenance',
        targetRef: `${subject.kind}:${subject.id ?? subject.key}`,
        details: {
          references: references.length,
          currentSets: evidence.current.length,
          supersededSets: evidence.superseded.length,
          citedBy: citedBy.length,
          field: field !== undefined,
          history: field?.history.length ?? 0,
        },
      });
      return { subject, references, ...(field ? { field } : {}), evidence, citedBy };
    });
  }

  private subject(q: ProvenanceQuery): ProvenanceReport['subject'] {
    const src = ENTITY_INDEX_SOURCES[q.kind];
    if (!src) throw new GovernanceError('validation_failed', `Unknown entity kind ${q.kind}`);
    if (src.column === 'key') {
      if (!q.key || q.id || !KEY_PATTERN.test(q.key)) {
        throw new GovernanceError('validation_failed', `Kind ${q.kind} is identified by --key`);
      }
      return { kind: q.kind, key: q.key };
    }
    if (!q.id || q.key || !UUID_PATTERN.test(q.id)) {
      throw new GovernanceError('validation_failed', `Kind ${q.kind} is identified by --id <uuid>`);
    }
    if (q.field !== undefined && !FIELD_PATTERN.test(q.field)) {
      throw new GovernanceError('validation_failed', 'The field must be an identifier');
    }
    return { kind: q.kind, id: q.id };
  }

  private async references(
    tx: TenantTransaction,
    s: ProvenanceReport['subject'],
  ): Promise<ProvenanceReference[]> {
    const rows = await tenantClient(tx).$queryRaw<
      {
        store: string;
        system: string;
        object_type: string;
        external_id: string;
        state: string;
        origin: string;
        first_seen_at: Date | null;
        last_seen_at: Date | null;
        source_updated_at: Date | null;
        retired_at: Date | null;
      }[]
    >`
      SELECT store, system, object_type, external_id, state, origin,
             first_seen_at, last_seen_at, source_updated_at, retired_at
        FROM source_reference_index
       WHERE tenant_id = ${tx.tenantId}::uuid AND entity_kind = ${s.kind}
         AND (entity_id = ${s.id ?? null}::uuid OR entity_key = ${s.key ?? null})
       ORDER BY store, system, object_type, external_id
       LIMIT ${MAX_ROWS}`;
    return rows.map((r) => ({
      store: r.store,
      system: r.system,
      objectType: r.object_type,
      externalId: r.external_id,
      state: r.state,
      origin: r.origin,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      sourceUpdatedAt: r.source_updated_at,
      retiredAt: r.retired_at,
    }));
  }

  private async field(
    tx: TenantTransaction,
    s: ProvenanceReport['subject'],
    field: string,
  ): Promise<ProvenanceField> {
    if (!FIELD_PATTERN.test(field)) {
      throw new GovernanceError('validation_failed', 'The field must be an identifier');
    }
    const db = tenantClient(tx);
    const change = await db.tenantContextChange.findFirst({
      where: {
        tenantId: tx.tenantId,
        entityKind: s.kind,
        ...(s.id ? { entityId: s.id } : { entityKey: s.key! }),
        changedFields: { has: field },
      },
      orderBy: [{ ingestedAt: 'desc' }, { id: 'desc' }],
    });
    if (!change) return { field, change: null, history: [] };
    const history = await db.tenantValueHistory.findMany({
      where: { tenantId: tx.tenantId, changeId: change.id, field },
      orderBy: { effectiveAt: 'asc' },
      take: MAX_ROWS,
    });
    return {
      field,
      change: {
        id: change.id,
        changeType: change.changeType,
        source: {
          system: change.sourceSystem,
          objectType: change.sourceObjectType,
          recordId: change.sourceRecordId,
        },
        cause: change.cause,
        checkpointId: change.checkpointId,
        connectionId: change.sourceConnectionId,
        mappingVersion: change.mappingVersion,
        schemaSnapshotHash: change.schemaSnapshotHash,
        transforms: change.transforms,
        origin: change.origin,
        derivation: change.derivation,
        actor: { kind: change.actorKind, id: change.actorId, assurance: change.actorAssurance },
        canonicalVersion: change.canonicalVersion,
        ingestedAt: change.ingestedAt,
      },
      history: history.map((h) => ({
        effectiveAt: h.effectiveAt,
        valuesRecorded: h.valuesRecorded,
        retentionClass: h.retentionClass,
        ...(h.valuesRecorded ? { oldValue: h.oldValue, newValue: h.newValue } : {}),
      })),
    };
  }

  private async evidence(
    tx: TenantTransaction,
    s: ProvenanceReport['subject'],
  ): Promise<ProvenanceReport['evidence']> {
    const rows = await tenantClient(tx).tenantEvidenceLink.findMany({
      where: {
        tenantId: tx.tenantId,
        subjectKind: s.kind,
        ...(s.id ? { subjectId: s.id } : { subjectKey: s.key! }),
      },
      orderBy: [{ createdAt: 'desc' }, { linkSetId: 'asc' }, { ordinal: 'asc' }],
      take: MAX_ROWS,
    });
    const sets = new Map<
      string,
      ProvenanceLinkSet & { links: ProvenanceLinkSet['links'][number][] }
    >();
    for (const r of rows) {
      let set = sets.get(r.linkSetId);
      if (!set) {
        set = {
          linkSetId: r.linkSetId,
          supersedesLinkSetId: r.supersedesLinkSetId,
          origin: r.origin,
          canonicalVersion: r.canonicalVersion,
          createdAt: r.createdAt,
          links: [],
        };
        sets.set(r.linkSetId, set);
      }
      set.links.push({
        ordinal: r.ordinal,
        evidenceType: r.evidenceType,
        evidenceKind: r.evidenceKind,
        evidenceId: r.evidenceId,
        evidenceKey: r.evidenceKey,
        evidenceChangeId: r.evidenceChangeId,
        evidenceSnapshotId: r.evidenceSnapshotId,
        role: r.role,
        weight: r.weight === null ? null : r.weight.toString(),
      });
    }
    const supersededIds = new Set(
      [...sets.values()].map((x) => x.supersedesLinkSetId).filter((x): x is string => !!x),
    );
    const all = [...sets.values()];
    return {
      current: all.filter((x) => !supersededIds.has(x.linkSetId)),
      superseded: all.filter((x) => supersededIds.has(x.linkSetId)),
    };
  }

  private async citedBy(tx: TenantTransaction, s: ProvenanceReport['subject']) {
    const rows = await tenantClient(tx).tenantEvidenceLink.findMany({
      where: {
        tenantId: tx.tenantId,
        evidenceType: 'entity',
        evidenceKind: s.kind,
        ...(s.id ? { evidenceId: s.id } : { evidenceKey: s.key! }),
      },
      select: { linkSetId: true, subjectKind: true, subjectId: true, subjectKey: true, role: true },
      orderBy: [{ createdAt: 'desc' }, { linkSetId: 'asc' }],
      take: MAX_ROWS,
    });
    return rows;
  }
}
