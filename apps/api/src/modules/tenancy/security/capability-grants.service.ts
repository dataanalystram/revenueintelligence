import { Injectable } from '@nestjs/common';
import {
  GRANTABLE_ACTOR_KINDS,
  isGrantableCapability,
  operatorActor,
  type AuditReasonCode,
  type GrantableCapability,
  type SecurityActor,
} from '../../domain';
import { TenancyError } from '../errors';
import { TenantDatabase, tenantClient } from '../infrastructure/tenant-database';
import type { TenantContext } from '../tenant-context';
import { AuditFailures } from './audit-failures';
import { AuditTrail } from './audit-trail';
import { assertAuthorized, type AuthorizedContext } from './authorized-context';

/**
 * A grant or revoke that cannot be made. `code` is a closed audit reason code, so the
 * `failed` audit event written by AuditFailures carries it (never input values).
 */
export class CapabilityGrantRefusedError extends TenancyError {
  constructor(
    readonly reason: Extract<
      AuditReasonCode,
      'capability_not_grantable' | 'self_grant_refused' | 'no_change'
    >,
    message: string,
  ) {
    super(reason, message);
  }
}

export interface CapabilityGrantResult {
  readonly capability: GrantableCapability;
  readonly grantee: string;
  readonly active: boolean;
  readonly version: number;
}

const isGrantableKind = (kind: string): boolean =>
  (GRANTABLE_ACTOR_KINDS as readonly string[]).includes(kind);

/**
 * M10E hardening #90 (ADR 0031 addendum): explicit, tenant-scoped grants of the
 * capabilities no actor kind holds by policy (GRANTABLE_CAPABILITIES — only
 * `data.account_context.read_confidential`). A grant names one operator id in one
 * tenant (forced RLS; the row carries the tenant). Grant and revoke need
 * `security.capability.grant`, write one audit event each (identifiers and codes
 * only) and refuse a self-grant, a non-grantable capability and a no-op. The
 * WriteAuthorizer consults `holds` only for a grantable capability the policy
 * denied with `capability_not_granted` — never for any other capability, so no
 * other grant reaches through this table.
 */
@Injectable()
export class CapabilityGrants {
  constructor(
    private readonly db: TenantDatabase,
    readonly audit: AuditTrail,
  ) {}

  /** Whether `actor` holds an active explicit grant of `capability` in `tenant` (only). */
  async holds(
    tenant: TenantContext,
    actor: SecurityActor,
    capability: GrantableCapability,
  ): Promise<boolean> {
    if (!isGrantableCapability(capability) || !isGrantableKind(actor.kind)) return false;
    return this.db.transaction(tenant, async (tx) => {
      const row = await tenantClient(tx).tenantCapabilityGrant.findUnique({
        where: {
          tenantId_actorKind_actorId_capability: {
            tenantId: tx.tenantId,
            actorKind: actor.kind,
            actorId: actor.id,
            capability,
          },
        },
        select: { active: true },
      });
      return row?.active === true;
    });
  }

  @AuditFailures('capability.grant', 'capability_grant')
  async grant(
    actx: AuthorizedContext<'security.capability.grant'>,
    input: { readonly grantee: string; readonly capability: string },
  ): Promise<CapabilityGrantResult> {
    assertAuthorized(actx, 'security.capability.grant');
    const { grantee, capability } = this.validate(actx, input);
    return this.db.transaction(actx.tenant, async (tx) => {
      const client = tenantClient(tx);
      const key = {
        tenantId: tx.tenantId,
        actorKind: grantee.kind,
        actorId: grantee.id,
        capability,
      };
      const existing = await client.tenantCapabilityGrant.findUnique({
        where: { tenantId_actorKind_actorId_capability: key },
      });
      if (existing?.active) {
        throw new CapabilityGrantRefusedError('no_change', 'The operator already holds this grant');
      }
      const now = new Date();
      const granted = {
        active: true,
        grantedAt: now,
        grantedByKind: actx.actor.kind,
        grantedById: actx.actor.id,
        grantedByAssurance: actx.actor.assurance,
        revokedAt: null,
        revokedByKind: null,
        revokedById: null,
        revokedByAssurance: null,
      };
      let version: number;
      if (existing) {
        version = existing.version + 1;
        const { count } = await client.tenantCapabilityGrant.updateMany({
          where: { ...key, version: existing.version },
          data: { ...granted, version },
        });
        if (count !== 1) throw new TenancyError('stale_base_version', 'The grant changed');
      } else {
        version = 1;
        await client.tenantCapabilityGrant.create({ data: { ...key, ...granted, version } });
      }
      await this.audit.record(tx, actx, {
        action: 'capability.grant',
        targetKind: 'capability_grant',
        targetRef: `${capability}:${grantee.id}`,
        details: { capability, granteeKind: grantee.kind, grantee: grantee.id, version },
      });
      return { capability, grantee: grantee.id, active: true, version };
    });
  }

  @AuditFailures('capability.revoke', 'capability_grant')
  async revoke(
    actx: AuthorizedContext<'security.capability.grant'>,
    input: { readonly grantee: string; readonly capability: string },
  ): Promise<CapabilityGrantResult> {
    assertAuthorized(actx, 'security.capability.grant');
    const { grantee, capability } = this.validate(actx, input, { allowSelf: true });
    return this.db.transaction(actx.tenant, async (tx) => {
      const client = tenantClient(tx);
      const key = {
        tenantId: tx.tenantId,
        actorKind: grantee.kind,
        actorId: grantee.id,
        capability,
      };
      const existing = await client.tenantCapabilityGrant.findUnique({
        where: { tenantId_actorKind_actorId_capability: key },
      });
      if (!existing?.active) {
        throw new CapabilityGrantRefusedError('no_change', 'The operator holds no such grant');
      }
      const version = existing.version + 1;
      const { count } = await client.tenantCapabilityGrant.updateMany({
        where: { ...key, version: existing.version },
        data: {
          active: false,
          version,
          revokedAt: new Date(),
          revokedByKind: actx.actor.kind,
          revokedById: actx.actor.id,
          revokedByAssurance: actx.actor.assurance,
        },
      });
      if (count !== 1) throw new TenancyError('stale_base_version', 'The grant changed');
      await this.audit.record(tx, actx, {
        action: 'capability.revoke',
        targetKind: 'capability_grant',
        targetRef: `${capability}:${grantee.id}`,
        details: { capability, granteeKind: grantee.kind, grantee: grantee.id, version },
      });
      return { capability, grantee: grantee.id, active: false, version };
    });
  }

  private validate(
    actx: AuthorizedContext<'security.capability.grant'>,
    input: { readonly grantee: string; readonly capability: string },
    options: { readonly allowSelf?: boolean } = {},
  ): { grantee: SecurityActor; capability: GrantableCapability } {
    if (!isGrantableCapability(input.capability)) {
      throw new CapabilityGrantRefusedError(
        'capability_not_grantable',
        'Only data.account_context.read_confidential is granted explicitly',
      );
    }
    // Throws InvalidActorError (validation_failed) for an id outside the pattern.
    const grantee = operatorActor(input.grantee);
    // Two people: the granting operator never grants to itself (a revoke of one's own grant is allowed).
    if (!options.allowSelf && grantee.id === actx.actor.id) {
      throw new CapabilityGrantRefusedError(
        'self_grant_refused',
        'An operator cannot grant a capability to itself',
      );
    }
    return { grantee, capability: input.capability };
  }
}
