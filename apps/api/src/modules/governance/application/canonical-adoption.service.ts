import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  canonicalFeatureChanges,
  compareCanonicalVersion,
  decideAdoption,
  type CanonicalVersionStatus,
} from '../../domain';
import {
  AuditFailures,
  AuditTrail,
  assertAuthorized,
  forgetAdoptedVersion,
  tenantAdvisoryLock,
  tenantClient,
  TenantDatabase,
  type AuthorizedContext,
  type TenantContext,
  type TenantTransaction,
} from '../../tenancy';
import { GovernanceError } from '../errors';

export interface AdoptionImpact {
  readonly current: string;
  readonly target: string;
  readonly decision: 'operator_adoption' | 'rollback' | 'refused';
  readonly refusal?: string;
  /** Modules whose minimum version the target reaches and the current does not. */
  readonly modulesNewlyAvailable: readonly string[];
  /** Registry versions validated against a version above the target. */
  readonly registriesAboveTarget: number;
  /** Mapping versions validated against a version above the target. */
  readonly mappingsAboveTarget: number;
  /** M10B plan §7: what the target enables beyond the current version (forward adoption). */
  readonly enables: readonly string[];
  /**
   * What a rollback withdraws: data is kept and stays readable; writers refuse
   * new writes of these with `canonical_version_too_low`.
   */
  readonly disables: readonly string[];
}

export interface AdoptionResult {
  readonly seq: number;
  readonly version: string;
  readonly previousVersion: string;
  readonly reason: 'operator_adoption' | 'rollback';
}

/**
 * Tenant canonical adoption (M10A2 plan §3, Q2, Q3): explicit, append-only and
 * audited. Adoption never rewrites tenant data and never changes a module
 * setting; it only appends the adoption chain.
 */
@Injectable()
export class CanonicalAdoptionService {
  constructor(
    private readonly db: TenantDatabase,
    readonly audit: AuditTrail,
  ) {}

  /** The adoption history, oldest first. */
  async history(ctx: TenantContext) {
    return this.db.transaction(ctx, (tx) =>
      tenantClient(tx).tenantCanonicalAdoption.findMany({
        orderBy: { seq: 'asc' },
        select: { seq: true, version: true, previousVersion: true, reason: true, adoptedAt: true },
      }),
    );
  }

  /** Dry run: what adopting `target` would do. Read-only. */
  async plan(ctx: TenantContext, target: string, expectedCurrent: string): Promise<AdoptionImpact> {
    return this.db.transaction(ctx, (tx) => this.impact(tx, target, expectedCurrent));
  }

  @AuditFailures('canonical.adopt', 'canonical_version')
  async adopt(
    actx: AuthorizedContext<'config.canonical.adopt'>,
    input: { readonly target: string; readonly expectedCurrent: string },
  ): Promise<AdoptionResult> {
    assertAuthorized(actx, 'config.canonical.adopt');
    return this.db.transaction(actx.tenant, async (tx) => {
      await tenantAdvisoryLock(tx, 'canonical-adoption', 'chain');
      const { head, catalogue } = await this.state(tx);
      const decision = decideAdoption({
        current: head.version,
        expectedCurrent: input.expectedCurrent,
        target: input.target,
        catalogue,
      });
      if (!decision.ok) {
        throw new GovernanceError(
          decision.code,
          `Adoption of ${input.target} refused (${decision.code})`,
        );
      }
      const seq = head.seq + 1;
      const auditEventId = await this.audit.recordReturningId(tx, actx, {
        action: 'canonical.adopt',
        targetKind: 'canonical_version',
        targetRef: input.target,
        details: { seq, from: head.version, to: input.target, reason: decision.reason },
      });
      await tenantClient(tx).tenantCanonicalAdoption.create({
        data: {
          tenantId: tx.tenantId,
          id: randomUUID(),
          seq,
          version: input.target,
          previousVersion: head.version,
          reason: decision.reason,
          actorKind: actx.actor.kind,
          actorId: actx.actor.id,
          actorAssurance: actx.actor.assurance,
          correlationId: actx.correlationId,
          auditEventId,
        },
      });
      forgetAdoptedVersion(tx);
      return { seq, version: input.target, previousVersion: head.version, reason: decision.reason };
    });
  }

  private async state(tx: TenantTransaction) {
    const db = tenantClient(tx);
    const head = await db.tenantCanonicalAdoption.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true, version: true },
    });
    if (!head) throw new GovernanceError('canonical_version_unknown', 'The tenant has no adoption');
    const catalogue = (
      await db.canonicalModelVersion.findMany({ select: { version: true, status: true } })
    ).map((v) => ({ version: v.version, status: v.status as CanonicalVersionStatus }));
    return { head, catalogue };
  }

  private async impact(
    tx: TenantTransaction,
    target: string,
    expectedCurrent: string,
  ): Promise<AdoptionImpact> {
    const db = tenantClient(tx);
    const { head, catalogue } = await this.state(tx);
    const decision = decideAdoption({ current: head.version, expectedCurrent, target, catalogue });
    const modules = await db.canonicalModule.findMany({
      where: { available: true },
      select: { moduleKey: true, minimumCanonicalVersion: true },
    });
    const known = catalogue.some((v) => v.version === target);
    const above = (v: string | null) =>
      known && v !== null && compareCanonicalVersion(v, target) > 0;
    const registries = await db.tenantRegistryVersion.findMany({
      select: { canonicalVersionMin: true },
    });
    const mappings = await db.tenantSourceMappingVersion.findMany({
      select: { canonicalVersionMin: true },
    });
    return {
      current: head.version,
      target,
      decision: decision.ok ? decision.reason : 'refused',
      ...(decision.ok ? {} : { refusal: decision.code }),
      modulesNewlyAvailable: known
        ? modules
            .filter(
              (m) =>
                m.minimumCanonicalVersion !== null &&
                compareCanonicalVersion(m.minimumCanonicalVersion, target) <= 0 &&
                compareCanonicalVersion(m.minimumCanonicalVersion, head.version) > 0,
            )
            .map((m) => m.moduleKey)
            .sort()
        : [],
      registriesAboveTarget: registries.filter((r) => above(r.canonicalVersionMin)).length,
      // Q7: a NULL on a pre-M10A2 mapping version means 0.1.
      mappingsAboveTarget: mappings.filter((m) => above(m.canonicalVersionMin ?? '0.1')).length,
      ...(known ? canonicalFeatureChanges(head.version, target) : { enables: [], disables: [] }),
    };
  }
}
