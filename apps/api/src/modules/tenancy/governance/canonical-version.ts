import type { SecurityActor } from '../../domain';
import { randomUUID } from 'node:crypto';
import { TenancyError } from '../errors';
import { tenantClient, type TenantTransaction } from '../infrastructure/tenant-database';

/**
 * Q19: a tenant without an adoption row cannot write canonical data. The
 * migration baseline and provisioning make this impossible in normal
 * operation; if it happens, writers fail closed.
 */
export class CanonicalVersionUnknownError extends TenancyError {
  constructor(tenantId: string) {
    super('canonical_version_unknown', `Tenant ${tenantId} has no canonical adoption`);
  }
}

const cache = new WeakMap<TenantTransaction, string>();

/**
 * The tenant's adopted canonical version: the adoption row with the highest
 * `seq` (M10A2 plan §3). Cached for the transaction; the adoption service
 * calls `forgetAdoptedVersion` after it appends a row.
 */
export async function adoptedCanonicalVersion(tx: TenantTransaction): Promise<string> {
  const cached = cache.get(tx);
  if (cached) return cached;
  const row = await tenantClient(tx).tenantCanonicalAdoption.findFirst({
    where: { tenantId: tx.tenantId },
    orderBy: { seq: 'desc' },
    select: { version: true },
  });
  if (!row) throw new CanonicalVersionUnknownError(tx.tenantId);
  cache.set(tx, row.version);
  return row.version;
}

export function forgetAdoptedVersion(tx: TenantTransaction): void {
  cache.delete(tx);
}

/** The platform's `current` canonical version (the database row; equal to the code catalogue). */
export async function platformCurrentCanonicalVersion(tx: TenantTransaction): Promise<string> {
  const row = await tenantClient(tx).canonicalModelVersion.findFirst({
    where: { status: 'current' },
    select: { version: true },
  });
  if (!row) throw new CanonicalVersionUnknownError(tx.tenantId);
  return row.version;
}

/**
 * M10A2 plan §3: a new tenant adopts the current version at provisioning
 * (`seq 1`, reason `new_tenant`), inside the provisioning transaction and
 * referencing the `tenant.provision` audit event.
 */
export async function recordNewTenantAdoption(
  tx: TenantTransaction,
  input: {
    readonly version: string;
    readonly actor: SecurityActor;
    readonly correlationId: string;
    readonly auditEventId: string;
  },
): Promise<void> {
  await tenantClient(tx).tenantCanonicalAdoption.create({
    data: {
      tenantId: tx.tenantId,
      id: randomUUID(),
      seq: 1,
      version: input.version,
      previousVersion: null,
      reason: 'new_tenant',
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      actorAssurance: input.actor.assurance,
      correlationId: input.correlationId,
      auditEventId: input.auditEventId,
    },
  });
  forgetAdoptedVersion(tx);
}

/** The tenant's module settings (M10A2): read by writers and the mapping hook. */
export async function moduleSettings(
  tx: TenantTransaction,
): Promise<{ readonly moduleKey: string; readonly enabled: boolean }[]> {
  return tenantClient(tx).tenantModuleSetting.findMany({
    select: { moduleKey: true, enabled: true },
  });
}
