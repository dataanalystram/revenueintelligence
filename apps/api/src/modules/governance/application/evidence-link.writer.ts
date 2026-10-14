import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  compareCanonicalVersion,
  ENTITY_INDEX_SOURCES,
  EVIDENCE_KIND_MODULES,
  validateEvidenceSet,
  type EntityIndexKind,
  type EvidenceRelation,
  type EvidenceSetInput,
} from '../../domain';
import {
  adoptedCanonicalVersion,
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  tenantClient,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import { GovernanceError } from '../errors';
import { ModuleGate } from './module-settings.service';
import { GENERIC_REFERENCES_MIN_VERSION } from './source-reference.service';

/**
 * The relation catalogue the writer enforces. Production binds the domain
 * `EVIDENCE_RELATIONS` (empty in M10B, Q13); tests bind their own.
 */
export const EVIDENCE_RELATION_CATALOGUE = Symbol('EVIDENCE_RELATION_CATALOGUE');

export interface EvidenceLinkSetWritten {
  readonly linkSetId: string;
  readonly links: number;
}

/**
 * The single writer of `tenant_evidence_links` (M10B plan §3.2, ADR 0028).
 * One call = one link set, in the caller's transaction (the subject write).
 * Layer-1 validation gives precise errors; the database constraints, the
 * composite index FKs and the append-only trigger are the boundary.
 * No `allowed` audit event per set (canonical data, Q17); failures and
 * refusals are audited (`evidence.link`).
 */
@Injectable()
export class EvidenceLinkWriter {
  constructor(
    readonly audit: AuditTrail,
    private readonly gate: ModuleGate,
    @Inject(EVIDENCE_RELATION_CATALOGUE) private readonly relations: readonly EvidenceRelation[],
  ) {}

  @AuditFailures('evidence.link', 'evidence_link_set')
  async write(
    actx: AuthorizedContext<'canonical.evidence.link'>,
    tx: TenantTransaction,
    set: EvidenceSetInput,
  ): Promise<EvidenceLinkSetWritten> {
    assertAuthorized(actx, 'canonical.evidence.link');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('evidence tenant does not match the transaction tenant');
    }
    const issues = [] as ReturnType<typeof validateEvidenceSet>;
    const first = issues.find((i) => i.code === 'evidence_set_invalid') ?? issues[0];
    if (first) {
      throw new GovernanceError(first.code, `Evidence link set refused (${first.reason})`, {
        reason: first.reason,
        ...(first.ordinal !== undefined ? { ordinal: first.ordinal } : {}),
      });
    }
    const canonicalVersion = await adoptedCanonicalVersion(tx);
    if (compareCanonicalVersion(canonicalVersion, GENERIC_REFERENCES_MIN_VERSION) < 0) {
      throw new GovernanceError(
        'canonical_version_too_low',
        `Evidence links need canonical ${GENERIC_REFERENCES_MIN_VERSION} (adopted ${canonicalVersion})`,
      );
    }
    const kinds = new Set<EntityIndexKind>([set.subjectKind]);
    for (const l of set.links) if (l.evidenceKind) kinds.add(l.evidenceKind);
    for (const kind of [...kinds].sort()) {
      const moduleKey = EVIDENCE_KIND_MODULES[kind];
      if (moduleKey) await this.gate.require(tx, actx, moduleKey);
    }
    const db = tenantClient(tx);
    for (const l of set.links) {
      if (l.evidenceType === 'entity') {
        await this.requireLive(tx, l.evidenceKind!, l.evidenceId, l.evidenceKey);
      } else if (l.evidenceType === 'change_record') {
        const found = await db.tenantContextChange.findUnique({
          where: { tenantId_id: { tenantId: tx.tenantId, id: l.evidenceChangeId! } },
          select: { id: true },
        });
        if (!found) this.targetNotAllowed('change_record');
      } else {
        const found = await db.tenantEligibilitySnapshot.findUnique({
          where: { tenantId_id: { tenantId: tx.tenantId, id: l.evidenceSnapshotId! } },
          select: { id: true },
        });
        if (!found) this.targetNotAllowed('eligibility_snapshot');
      }
    }
    if (set.supersedesLinkSetId) {
      const superseded = await db.tenantEvidenceLink.findFirst({
        where: {
          tenantId: tx.tenantId,
          linkSetId: set.supersedesLinkSetId,
          subjectKind: set.subjectKind,
          subjectId: set.subjectId ?? null,
          subjectKey: set.subjectKey ?? null,
        },
        select: { id: true },
      });
      if (!superseded) {
        throw new GovernanceError(
          'evidence_set_invalid',
          'supersedes_link_set_id names no set of the same subject',
          { reason: 'supersedes' },
        );
      }
    }
    const linkSetId = randomUUID();
    await db.tenantEvidenceLink.createMany({
      data: set.links.map((l) => ({
        tenantId: tx.tenantId,
        id: randomUUID(),
        linkSetId,
        ordinal: l.ordinal,
        subjectKind: set.subjectKind,
        subjectId: set.subjectId ?? null,
        subjectKey: set.subjectKey ?? null,
        evidenceType: l.evidenceType,
        evidenceKind: l.evidenceKind ?? null,
        evidenceId: l.evidenceId ?? null,
        evidenceKey: l.evidenceKey ?? null,
        evidenceChangeId: l.evidenceChangeId ?? null,
        evidenceSnapshotId: l.evidenceSnapshotId ?? null,
        role: l.role,
        weight: l.weight ?? null,
        origin: set.origin,
        ...(set.derivation
          ? {
              derivation: {
                key: set.derivation.key,
                version: set.derivation.version,
                inputs_hash: set.derivation.inputsHash,
              },
            }
          : {}),
        supersedesLinkSetId: set.supersedesLinkSetId ?? null,
        changeId: set.changeId ?? null,
        canonicalVersion,
        actorKind: actx.actor.kind,
        actorId: actx.actor.id,
        actorAssurance: actx.actor.assurance,
        correlationId: actx.correlationId,
      })),
    });
    return { linkSetId, links: set.links.length };
  }

  /** The record exists in the tenant (entity index) and is not merged. */
  private async requireLive(
    tx: TenantTransaction,
    kind: EntityIndexKind,
    id: string | undefined,
    key: string | undefined,
  ): Promise<void> {
    const db = tenantClient(tx);
    const indexed = await db.tenantEntityIndex.findFirst({
      where: {
        tenantId: tx.tenantId,
        kind,
        ...(id !== undefined ? { entityId: id } : { entityKey: key ?? null }),
      },
      select: { id: true },
    });
    if (!indexed) this.targetNotAllowed(kind);
    const src = ENTITY_INDEX_SOURCES[kind];
    if (src.column === 'key') return; // products are never merged (K4)
    const rows = await db.$queryRawUnsafe<{ state: string }[]>(
      `SELECT record_state AS state FROM "${src.table}" WHERE tenant_id = $1::uuid AND "${src.column}" = $2::uuid`,
      tx.tenantId,
      id,
    );
    if (rows[0]?.state === 'merged') this.targetNotAllowed(kind);
  }

  private targetNotAllowed(kind: string): never {
    throw new GovernanceError(
      'evidence_target_not_allowed',
      `Evidence target (${kind}) does not exist in the tenant or is merged`,
      { kind },
    );
  }
}
