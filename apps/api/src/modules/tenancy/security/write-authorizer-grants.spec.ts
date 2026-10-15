import { describe, expect, it, vi } from 'vitest';
import type { MetricsService } from '../../../platform/metrics';
import {
  operatorActor,
  sourceSyncActor,
  systemActor,
  type Capability,
  type SecurityActor,
  type TenantId,
} from '../../domain';
import type { TenantSlug } from '../tenant';
import { issueTenantContext } from '../tenant-context';
import type { AuditTrail } from './audit-trail';
import { assertAuthorized, AuthorizationDeniedError } from './authorized-context';
import type { CapabilityGrants } from './capability-grants.service';
import type { SecurityEventsService } from './security-events.service';
import { WriteAuthorizer } from './write-authorizer.service';

const CONFIDENTIAL = 'data.account_context.read_confidential';
const tenantA = issueTenantContext({
  id: 'a0000000-0000-4000-8000-00000000000a' as TenantId,
  slug: 'grantsa' as TenantSlug,
  status: 'active',
});
const tenantB = issueTenantContext({
  id: 'b0000000-0000-4000-8000-00000000000b' as TenantId,
  slug: 'grantsb' as TenantSlug,
  status: 'active',
});

/** A WriteAuthorizer over fakes: `granted` lists the (tenant slug, kind, id, capability) grants. */
function setup(granted: readonly string[] = []) {
  const recordDenied = vi.fn(() => Promise.resolve());
  const holds = vi.fn(
    (tenant: { tenantSlug: string }, actor: SecurityActor, capability: Capability) =>
      Promise.resolve(
        granted.includes(`${tenant.tenantSlug}|${actor.kind}|${actor.id}|${capability}`),
      ),
  );
  const authorizer = new WriteAuthorizer(
    { recordDenied } as unknown as AuditTrail,
    { emit: vi.fn() } as unknown as SecurityEventsService,
    { increment: vi.fn() } as unknown as MetricsService,
    { holds } as unknown as CapabilityGrants,
  );
  return { authorizer, recordDenied, holds };
}

const attempt = { action: 'account_context.read' } as const;

/**
 * M10E hardening #90 (unit): the WriteAuthorizer allows a grantable capability
 * (granted to no actor kind by policy) only when the actor holds an explicit
 * grant in that tenant, and consults the grants for nothing else.
 */
describe('WriteAuthorizer: explicit capability grants (#90)', () => {
  it('an operator with an explicit grant in the tenant gets data.account_context.read_confidential', async () => {
    const { authorizer, holds, recordDenied } = setup([`grantsa|operator|alice|${CONFIDENTIAL}`]);
    const actx = await authorizer.authorize(tenantA, operatorActor('alice'), CONFIDENTIAL, attempt);
    assertAuthorized(actx, CONFIDENTIAL);
    expect(actx.tenant).toBe(tenantA);
    expect(holds).toHaveBeenCalledWith(tenantA, operatorActor('alice'), CONFIDENTIAL);
    expect(recordDenied).not.toHaveBeenCalled();
  });

  it('without the grant: refused (AuthorizationDeniedError) and recorded as denied with the capability code', async () => {
    const { authorizer, recordDenied } = setup();
    const refused = authorizer.authorize(tenantA, operatorActor('bob'), CONFIDENTIAL, attempt);
    await expect(refused).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(refused).rejects.toMatchObject({
      capability: CONFIDENTIAL,
      reason: 'capability_not_granted',
    });
    expect(recordDenied).toHaveBeenCalledWith(
      tenantA,
      expect.objectContaining({
        capability: CONFIDENTIAL,
        reason: 'capability_not_granted',
        action: 'account_context.read',
      }),
    );
  });

  it('a grant in tenant A does not authorize tenant B; another operator id or another kind with the granted id holds nothing', async () => {
    const { authorizer } = setup([`grantsa|operator|alice|${CONFIDENTIAL}`]);
    await expect(
      authorizer.authorize(tenantB, operatorActor('alice'), CONFIDENTIAL, attempt),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(
      authorizer.authorize(tenantA, operatorActor('alice2'), CONFIDENTIAL, attempt),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(
      authorizer.authorize(tenantA, systemActor('alice'), CONFIDENTIAL, attempt),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(
      authorizer.authorize(tenantA, sourceSyncActor('alice'), CONFIDENTIAL, attempt),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it('a capability denied by policy that is not grantable never consults the grants (no generic bypass)', async () => {
    // Even a (hypothetical) grant row naming another capability cannot be consulted.
    const { authorizer, holds } = setup([
      'grantsa|system|svc|data.account_context.read',
      'grantsa|system|svc|security.audit.read',
    ]);
    for (const capability of [
      'data.account_context.read',
      'security.audit.read',
      'data.extension.read',
      'security.capability.grant',
    ] as const) {
      await expect(
        authorizer.authorize(tenantA, systemActor('svc'), capability, attempt),
        capability,
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    }
    expect(holds).not.toHaveBeenCalled();
  });

  it('a capability the policy grants is decided by the policy alone (no grant lookup)', async () => {
    const { authorizer, holds } = setup();
    await authorizer.authorize(
      tenantA,
      operatorActor('carol'),
      'data.account_context.read',
      attempt,
    );
    await authorizer.authorize(tenantA, operatorActor('carol'), 'security.capability.grant', {
      action: 'capability.grant',
    });
    expect(holds).not.toHaveBeenCalled();
  });
});
