import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { MetricsService } from '../../../platform/metrics';
import { decide, type AuditReasonCode, type Capability, type SecurityActor } from '../../domain';
import type { TenantContext } from '../tenant-context';
import { AuditTrail, type AuditEntry } from './audit-trail';
import {
  AuthorizationDeniedError,
  issueAuthorizedContext,
  issuePlatformAuthorization,
  type AuthorizedContext,
  type PlatformAuthorization,
  type PlatformCapability,
} from './authorized-context';
import { SecurityEventsService } from './security-events.service';

/** Identical denials within this window are written once; the rest are counted (§6). */
const DENIAL_COALESCE_MS = 60_000;

/**
 * The only issuer of AuthorizedContext (M10A1 plan §3, §6). Deny by default:
 * the versioned policy (`decide`) must grant the capability to the actor's
 * kind. A denial is decided before any business transaction, written as a
 * `denied` audit event in its own transaction, emitted as a security event,
 * and thrown as AuthorizationDeniedError.
 */
@Injectable()
export class WriteAuthorizer {
  private readonly recentDenials = new Map<string, { at: number; suppressed: number }>();

  constructor(
    private readonly audit: AuditTrail,
    private readonly events: SecurityEventsService,
    private readonly metrics: MetricsService,
  ) {}

  async authorize<C extends Capability>(
    tenant: TenantContext,
    actor: SecurityActor,
    capability: C,
    attempt: AuditEntry & { readonly correlationId?: string },
  ): Promise<AuthorizedContext<C>> {
    const correlationId = attempt.correlationId ?? randomUUID();
    const decision = decide(actor.kind, capability);
    if (!decision.allowed) {
      await this.deny(tenant, actor, capability, decision.reason, { ...attempt, correlationId });
    }
    return issueAuthorizedContext({ tenant, actor, capability, correlationId });
  }

  /**
   * Platform-level capability (provisioning, tenant status). A denial has no
   * tenant trail to go to: it is a security event only (plan §6).
   */
  authorizePlatform<C extends PlatformCapability>(
    actor: SecurityActor,
    capability: C,
    correlationId: string = randomUUID(),
  ): PlatformAuthorization<C> {
    const decision = decide(actor.kind, capability);
    if (!decision.allowed) {
      this.events.emit({
        event: 'authz_denied',
        outcome: 'refused',
        actorKind: actor.kind,
        capability,
        reasonCode: decision.reason,
        correlationId,
      });
      throw new AuthorizationDeniedError(capability, decision.reason);
    }
    return issuePlatformAuthorization({ actor, capability, correlationId });
  }

  /**
   * Refuses an attempt for a reason found before authorization (e.g. Q1: no
   * operator id on `--execute`). Same recording as a policy denial.
   */
  async refuse(
    tenant: TenantContext,
    actor: SecurityActor,
    capability: Capability,
    reason: AuditReasonCode,
    attempt: AuditEntry & { readonly correlationId?: string },
  ): Promise<never> {
    return this.deny(tenant, actor, capability, reason, {
      ...attempt,
      correlationId: attempt.correlationId ?? randomUUID(),
    });
  }

  private async deny(
    tenant: TenantContext,
    actor: SecurityActor,
    capability: Capability,
    reason: AuditReasonCode,
    attempt: AuditEntry & { readonly correlationId: string },
  ): Promise<never> {
    this.events.emit({
      event: 'authz_denied',
      outcome: 'refused',
      tenant: tenant.tenantSlug,
      actorKind: actor.kind,
      capability,
      reasonCode: reason,
      correlationId: attempt.correlationId,
    });
    const key = [tenant.tenantId, actor.kind, actor.id, capability, attempt.action, reason].join(
      '|',
    );
    const now = Date.now();
    const recent = this.recentDenials.get(key);
    if (recent && now - recent.at < DENIAL_COALESCE_MS) {
      recent.suppressed += 1;
      this.metrics.increment('lip_audit_denials_coalesced_total', { capability });
    } else {
      this.recentDenials.set(key, { at: now, suppressed: 0 });
      try {
        await this.audit.recordDenied(tenant, {
          actor,
          capability,
          reason,
          correlationId: attempt.correlationId,
          action: attempt.action,
          ...(attempt.targetKind ? { targetKind: attempt.targetKind } : {}),
          ...(attempt.targetRef ? { targetRef: attempt.targetRef } : {}),
          details: { ...(attempt.details ?? {}), coalescedBefore: recent?.suppressed ?? 0 },
        });
      } catch {
        // The denial stands either way; the failure to record it is itself an event.
        this.events.emit({
          event: 'audit_write_failed',
          outcome: 'failed',
          tenant: tenant.tenantSlug,
          capability,
          reasonCode: 'denial_not_recorded',
          correlationId: attempt.correlationId,
        });
      }
    }
    throw new AuthorizationDeniedError(capability, reason);
  }
}
