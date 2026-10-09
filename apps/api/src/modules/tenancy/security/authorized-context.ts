import { randomUUID } from 'node:crypto';
import { POLICY_VERSION, type Capability, type SecurityActor } from '../../domain';
import { TenancyError } from '../errors';
import { assertTenantContext, type TenantContext } from '../tenant-context';

/** Module-private token: only the WriteAuthorizer can issue an authorized context. */
const ISSUE = Symbol('issue-authorized-context');
const issued = new WeakSet<object>();

/** A write was refused before anything happened (M10A1 plan §3, §6). */
export class AuthorizationDeniedError extends TenancyError {
  constructor(
    readonly capability: Capability,
    readonly reason: string,
  ) {
    super('authorization_denied', `Not authorized: ${capability} (${reason})`);
  }
}

export class InvalidAuthorizedContextError extends TenancyError {
  constructor(detail: string) {
    super('invalid_authorized_context', `Invalid authorized context: ${detail}`);
  }
}

/**
 * Proof that one actor was authorized, by policy, for one capability in one
 * tenant (M10A1 plan §3). Every privileged service method takes the context
 * typed for its own capability, so a missing or wrong authorization does not
 * compile; each method also re-checks it at runtime (`assertAuthorized`), so a
 * cast object is refused.
 */
export class AuthorizedContext<C extends Capability = Capability> {
  readonly tenant: TenantContext;
  readonly actor: SecurityActor;
  readonly capability: C;
  readonly correlationId: string;
  readonly policyVersion: number;

  constructor(
    token: typeof ISSUE,
    init: { tenant: TenantContext; actor: SecurityActor; capability: C; correlationId?: string },
  ) {
    if (token !== ISSUE) {
      throw new InvalidAuthorizedContextError(
        'authorized contexts are issued by WriteAuthorizer only',
      );
    }
    assertTenantContext(init.tenant);
    this.tenant = init.tenant;
    this.actor = init.actor;
    this.capability = init.capability;
    this.correlationId = init.correlationId ?? randomUUID();
    this.policyVersion = POLICY_VERSION;
    Object.freeze(this);
  }

  toString(): string {
    return `AuthorizedContext(${this.tenant.tenantSlug}, ${this.actor.kind}, ${this.capability})`;
  }
}

/** Internal to the security code of the tenancy module (not exported from its index). */
export function issueAuthorizedContext<C extends Capability>(init: {
  tenant: TenantContext;
  actor: SecurityActor;
  capability: C;
  correlationId?: string;
}): AuthorizedContext<C> {
  const context = new AuthorizedContext(ISSUE, init);
  issued.add(context);
  return context;
}

/** Runtime check at the entry of every privileged method. */
export function assertAuthorized<C extends Capability>(
  value: unknown,
  capability: C,
): asserts value is AuthorizedContext<C> {
  if (!(value instanceof AuthorizedContext) || !issued.has(value)) {
    throw new InvalidAuthorizedContextError('not an issued AuthorizedContext');
  }
  if (value.capability !== capability) {
    throw new InvalidAuthorizedContextError(
      `authorized for ${value.capability}, but ${capability} is required`,
    );
  }
}

/** Accepts any of several capabilities (a method serving more than one purpose). */
export function assertAuthorizedFor<C extends Capability>(
  value: unknown,
  capabilities: readonly C[],
): asserts value is AuthorizedContext<C> {
  if (!(value instanceof AuthorizedContext) || !issued.has(value)) {
    throw new InvalidAuthorizedContextError('not an issued AuthorizedContext');
  }
  const granted: Capability = (value as AuthorizedContext).capability;
  if (!(capabilities as readonly Capability[]).includes(granted)) {
    throw new InvalidAuthorizedContextError(
      `authorized for ${value.capability}, but one of ${capabilities.join(', ')} is required`,
    );
  }
}

/** Platform-level operations act before or across tenants (provisioning, tenant status). */
export type PlatformCapability = Extract<
  Capability,
  'config.tenant.provision' | 'config.tenant.status'
>;

const platformIssued = new WeakSet<object>();

/**
 * Proof that an actor was authorized for a platform-level capability. There is
 * no tenant context yet (provisioning) or the tenant may be inactive (status
 * changes); the audit event is written to the target tenant's trail.
 */
export class PlatformAuthorization<C extends PlatformCapability = PlatformCapability> {
  readonly actor: SecurityActor;
  readonly capability: C;
  readonly correlationId: string;
  readonly policyVersion: number;

  constructor(
    token: typeof ISSUE,
    init: { actor: SecurityActor; capability: C; correlationId?: string },
  ) {
    if (token !== ISSUE) {
      throw new InvalidAuthorizedContextError(
        'platform authorizations are issued by WriteAuthorizer only',
      );
    }
    this.actor = init.actor;
    this.capability = init.capability;
    this.correlationId = init.correlationId ?? randomUUID();
    this.policyVersion = POLICY_VERSION;
    Object.freeze(this);
  }
}

export function issuePlatformAuthorization<C extends PlatformCapability>(init: {
  actor: SecurityActor;
  capability: C;
  correlationId?: string;
}): PlatformAuthorization<C> {
  const auth = new PlatformAuthorization(ISSUE, init);
  platformIssued.add(auth);
  return auth;
}

export function assertPlatformAuthorized<C extends PlatformCapability>(
  value: unknown,
  capability: C,
): asserts value is PlatformAuthorization<C> {
  if (!(value instanceof PlatformAuthorization) || !platformIssued.has(value)) {
    throw new InvalidAuthorizedContextError('not an issued PlatformAuthorization');
  }
  if (value.capability !== capability) {
    throw new InvalidAuthorizedContextError(
      `authorized for ${value.capability}, but ${capability} is required`,
    );
  }
}
