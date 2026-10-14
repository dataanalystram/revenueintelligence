import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { PrismaService } from '../../../platform/database';
import type { TenantId } from '../../domain';
import { InvalidTenantContextError, TenantInactiveError, TenantNotFoundError } from '../errors';
import { TenantSchema, type Tenant, type TenantSlug } from '../tenant';
import { assertTenantContext, type TenantContext } from '../tenant-context';
import { SecurityEventsService } from '../security/security-events.service';

/**
 * A database transaction bound to exactly one tenant. Repositories take one of
 * these instead of a database client, so tenant-scoped data cannot be reached
 * without first entering a tenant transaction.
 */
export interface TenantTransaction {
  readonly tenantId: TenantId;
  readonly tenantSlug: TenantSlug;
}

type Client = Prisma.TransactionClient;

/** A JSON column value, for modules that write JSON through `tenantClient` (M10A2). */
export type TenantJsonInput = Prisma.InputJsonValue;

const openTransactions = new WeakMap<TenantTransaction, Client>();

/**
 * The Prisma client for an open tenant transaction, for repository
 * implementations. Throws if `tx` was not issued by TenantDatabase or has
 * already finished.
 */
export function tenantClient(tx: TenantTransaction): Client {
  const client = openTransactions.get(tx);
  if (!client) {
    throw new InvalidTenantContextError('not an open tenant transaction');
  }
  return client;
}

/**
 * A transaction-scoped advisory lock on `(tenant, scope, value)`, released at
 * commit or rollback. Shared by every module that must serialise work on the
 * same tenant-scoped key (e.g. the canonical-company lock taken by the M6
 * merge and the M7 subscription writer), so they always compute the same key.
 */
export async function tenantAdvisoryLock(
  tx: TenantTransaction,
  scope: string,
  value: string,
): Promise<void> {
  const key = advisoryLockKey(tx.tenantId, scope, value);
  await tenantClient(tx).$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
}

/** The 64-bit key of a tenant-scoped advisory lock (also used by owner-path operations). */
export function advisoryLockKey(tenantId: string, scope: string, value: string): bigint {
  return createHash('sha256').update(`${tenantId}|${scope}|${value}`).digest().readBigInt64BE(0);
}

async function bindTenant(client: Client, tenantId: string): Promise<string | null> {
  // One round trip: sets the transaction-local tenant (read by the RLS
  // policies) and returns the tenant's status. `true` = local to this
  // transaction, so it can never leak to another request on a pooled connection.
  const rows = await client.$queryRaw<{ status: string | null }[]>`
    SELECT set_config('app.current_tenant', ${tenantId}, true) AS applied,
           (SELECT status FROM tenants WHERE id = ${tenantId}::uuid) AS status`;
  return rows[0]?.status ?? null;
}

async function runBound<T>(
  client: Client,
  scope: { id: TenantId; slug: TenantSlug },
  work: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  const tx: TenantTransaction = Object.freeze({ tenantId: scope.id, tenantSlug: scope.slug });
  openTransactions.set(tx, client);
  try {
    return await work(tx);
  } finally {
    openTransactions.delete(tx);
  }
}

/** Explicit, never inherited from the role or server default (M10A1). */
const DEFAULT_ISOLATION = 'ReadCommitted' as const satisfies Prisma.TransactionIsolationLevel;

@Injectable()
export class TenantDatabase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly events?: SecurityEventsService,
  ) {}

  /**
   * Runs `work` in a database transaction scoped to the context's tenant.
   * READ COMMITTED unless the caller asks otherwise, stated explicitly so a
   * role or server default (e.g. REPEATABLE READ) never changes behaviour:
   * audit appends (M10A1) must read the committed chain head after locking.
   * Row-level security limits every statement to that tenant; the tenant's
   * status is re-checked, so a suspension takes effect immediately.
   * Everything inside commits or rolls back together.
   */
  async transaction<T>(
    context: TenantContext,
    work: (tx: TenantTransaction) => Promise<T>,
    options: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      /** Overrides DATABASE_TRANSACTION_TIMEOUT_MS (e.g. work that includes one external call). */
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    assertTenantContext(context);
    const { timeoutMs, isolationLevel } = options;
    return this.prisma.$transaction(
      async (client) => {
        const status = await bindTenant(client, context.tenantId);
        if (status === null) throw new TenantNotFoundError(context.tenantId);
        if (status !== 'active') {
          this.events?.emit({
            event: 'tenant_inactive_access',
            outcome: 'refused',
            tenant: context.tenantSlug,
            reasonCode: `tenant_${status}`,
          });
          throw new TenantInactiveError(context.tenantId, status);
        }
        return runBound(client, { id: context.tenantId, slug: context.tenantSlug }, work);
      },
      {
        timeout: timeoutMs ?? this.config.database.transactionTimeoutMs,
        isolationLevel: isolationLevel ?? DEFAULT_ISOLATION,
      },
    );
  }

  /**
   * M10A1: a platform-level change of the `tenants` row (no tenant bound, as
   * the registry policy requires), then `record` in the same transaction bound
   * to that tenant (its audit trail). Either both commit or neither does. The
   * tenant's status is deliberately not checked: suspension and offboarding
   * must still be audited.
   */
  async platformChange<T>(
    tenant: { id: TenantId; slug: TenantSlug },
    change: (root: Client) => Promise<T>,
    record: (tx: TenantTransaction, result: T) => Promise<void>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (client) => {
        const result = await change(client);
        await client.$queryRaw`SELECT set_config('app.current_tenant', ${tenant.id}, true)`;
        await runBound(client, tenant, (tx) => record(tx, result));
        return result;
      },
      { timeout: this.config.database.transactionTimeoutMs, isolationLevel: DEFAULT_ISOLATION },
    );
  }

  /**
   * Creates a tenant and runs `work` for it in the same transaction, so a
   * tenant never exists without its default configuration. Platform-level:
   * used only by tenant provisioning.
   */
  async provision<T>(
    tenant: { slug: TenantSlug; name: string },
    work: (tx: TenantTransaction, tenant: Tenant) => Promise<T>,
  ): Promise<{ tenant: Tenant; result: T }> {
    return this.prisma.$transaction(
      async (client) => {
        const row = await client.tenant.create({ data: { slug: tenant.slug, name: tenant.name } });
        const created = toTenant(row);
        await bindTenant(client, created.id);
        const result = await runBound(client, { id: created.id, slug: created.slug }, (tx) =>
          work(tx, created),
        );
        return { tenant: created, result };
      },
      { timeout: this.config.database.transactionTimeoutMs, isolationLevel: DEFAULT_ISOLATION },
    );
  }
}

/** Maps (and validates) a tenants row. */
export function toTenant(row: {
  id: string;
  slug: string;
  name: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): Tenant {
  return TenantSchema.parse(row);
}
