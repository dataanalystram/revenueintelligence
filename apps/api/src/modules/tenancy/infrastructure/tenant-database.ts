import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import { PrismaService } from '../../../platform/database';
import type { TenantId } from '../../domain';
import { InvalidTenantContextError, TenantInactiveError, TenantNotFoundError } from '../errors';
import { TenantSchema, type Tenant, type TenantSlug } from '../tenant';
import { assertTenantContext, type TenantContext } from '../tenant-context';

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

@Injectable()
export class TenantDatabase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Runs `work` in a database transaction scoped to the context's tenant.
   * Row-level security limits every statement to that tenant; the tenant's
   * status is re-checked, so a suspension takes effect immediately.
   * Everything inside commits or rolls back together.
   */
  async transaction<T>(
    context: TenantContext,
    work: (tx: TenantTransaction) => Promise<T>,
    options: { isolationLevel?: Prisma.TransactionIsolationLevel } = {},
  ): Promise<T> {
    assertTenantContext(context);
    return this.prisma.$transaction(
      async (client) => {
        const status = await bindTenant(client, context.tenantId);
        if (status === null) throw new TenantNotFoundError(context.tenantId);
        if (status !== 'active') throw new TenantInactiveError(context.tenantId, status);
        return runBound(client, { id: context.tenantId, slug: context.tenantSlug }, work);
      },
      { timeout: this.config.database.transactionTimeoutMs, ...options },
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
      { timeout: this.config.database.transactionTimeoutMs },
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
