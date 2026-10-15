import type { INestApplicationContext } from '@nestjs/common';
import {
  operatorActor,
  POLICY,
  sourceSyncActor,
  systemActor,
  type AuditAction,
  type Capability,
  type SecurityActor,
} from '../../src/modules/domain';
import {
  CapabilityGrants,
  WriteAuthorizer,
  type AuthorizedContext,
  type PlatformAuthorization,
  type PlatformCapability,
  type TenantContext,
} from '../../src/modules/tenancy';

/**
 * M10A1 test helper: authorized contexts for integration tests, issued by the
 * real WriteAuthorizer of the harness app (the policy is not bypassed). The
 * default actor is the first kind the policy grants the capability to.
 */
let app: INestApplicationContext | undefined;

/** Called by every harness after `app.init()`. */
export function registerSecurityApp(a: INestApplicationContext): void {
  app = a;
}

export const TEST_OPERATOR = operatorActor('test-operator');
export const TEST_RUN = sourceSyncActor('run:test');
export const TEST_SYSTEM = systemActor('test-system');

export function defaultActorFor(capability: Capability): SecurityActor {
  const kinds = POLICY[capability];
  if (kinds.includes('operator')) return TEST_OPERATOR;
  if (kinds.includes('source_sync')) return TEST_RUN;
  return TEST_SYSTEM;
}

function authorizer(): WriteAuthorizer {
  if (!app) throw new Error('registerSecurityApp(app) was not called by the harness');
  return app.get(WriteAuthorizer);
}

/** An authorized context for `capability` in `ctx`'s tenant. */
export function authz<C extends Capability>(
  ctx: TenantContext,
  capability: C,
  actor: SecurityActor = defaultActorFor(capability),
  action: AuditAction = 'operation.denied',
): Promise<AuthorizedContext<C>> {
  return authorizer().authorize(ctx, actor, capability, { action });
}

/** A platform authorization (provisioning, tenant status) for the test operator. */
export function platformAuthz<C extends PlatformCapability>(
  capability: C,
  actor: SecurityActor = TEST_OPERATOR,
): PlatformAuthorization<C> {
  return authorizer().authorizePlatform(actor, capability);
}

/** M10E hardening #90: the operator that grants explicit capabilities in tests (never the grantee). */
export const TEST_GRANTOR = operatorActor('test-grantor');

/**
 * Grants `data.account_context.read_confidential` to `grantee` in `ctx`'s tenant
 * through the real CapabilityGrants service (authorized by TEST_GRANTOR with
 * `security.capability.grant`; one audit event). The policy is not bypassed.
 */
export async function grantConfidentialRead(
  ctx: TenantContext,
  grantee: SecurityActor = TEST_OPERATOR,
): Promise<void> {
  if (!app) throw new Error('registerSecurityApp(app) was not called by the harness');
  await app
    .get(CapabilityGrants)
    .grant(await authz(ctx, 'security.capability.grant', TEST_GRANTOR), {
      grantee: grantee.id,
      capability: 'data.account_context.read_confidential',
    });
}
