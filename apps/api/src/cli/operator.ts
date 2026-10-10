import type { INestApplicationContext } from '@nestjs/common';
import {
  operatorActor,
  operatorIdFrom,
  type AuditAction,
  type AuditTargetKind,
  type Capability,
  type SecurityActor,
} from '../modules/domain';
import {
  SecurityEventsService,
  WriteAuthorizer,
  type AuthorizedContext,
  type PlatformAuthorization,
  type PlatformCapability,
  type TenantContext,
} from '../modules/tenancy';

/** Q1: the actor id used to record a refused attempt that named no operator. */
const UNIDENTIFIED = 'unidentified';

/** Thrown (and recorded) when a writing CLI command names no operator. */
export class OperatorIdRequiredError extends Error {
  constructor() {
    super(
      'This command writes: --actor <id> or LIP_OPERATOR_ID is required (owner decision Q1). The id is recorded as asserted, not authenticated.',
    );
    this.name = 'OperatorIdRequiredError';
  }
}

/** The operator named by `--actor` / `LIP_OPERATOR_ID`, if any. */
export function namedOperator(flag: string | undefined): SecurityActor | undefined {
  const id = operatorIdFrom(flag, process.env.LIP_OPERATOR_ID);
  return id === undefined ? undefined : operatorActor(id);
}

/**
 * Authorizes a writing CLI command (M10A1 plan §2, §3; owner decision Q1).
 * Without an operator id the attempt is refused before any write, recorded as a
 * `denied` audit event (`operator_id_required`) and a security event.
 */
export async function authorizeOperator<C extends Capability>(
  app: INestApplicationContext,
  tenant: TenantContext,
  capability: C,
  attempt: {
    readonly actorFlag: string | undefined;
    readonly action: AuditAction;
    readonly targetKind?: AuditTargetKind;
    readonly targetRef?: string;
    readonly correlationId?: string;
  },
): Promise<AuthorizedContext<C>> {
  const authorizer = app.get(WriteAuthorizer);
  const { actorFlag, ...entry } = attempt;
  const actor = namedOperator(actorFlag);
  if (!actor) {
    try {
      await authorizer.refuse(
        tenant,
        operatorActor(UNIDENTIFIED),
        capability,
        'operator_id_required',
        entry,
      );
    } catch {
      // refuse() always throws; the CLI reports the specific reason below.
    }
    throw new OperatorIdRequiredError();
  }
  return authorizer.authorize(tenant, actor, capability, entry);
}

/** Platform-level writes (provisioning): no tenant trail exists for a refusal yet. */
export function authorizePlatformOperator<C extends PlatformCapability>(
  app: INestApplicationContext,
  capability: C,
  actorFlag: string | undefined,
): PlatformAuthorization<C> {
  const actor = namedOperator(actorFlag);
  if (!actor) {
    app.get(SecurityEventsService).emit({
      event: 'authz_denied',
      outcome: 'refused',
      actorKind: 'operator',
      capability,
      reasonCode: 'operator_id_required',
    });
    throw new OperatorIdRequiredError();
  }
  return app.get(WriteAuthorizer).authorizePlatform(actor, capability);
}
