import {
  DataPolicyDocumentSchema,
  resolveRetention,
  type DataPolicyDocument,
  type ResolvedRetention,
  type RetentionClass,
} from '../../domain';
import { tenantClient, type TenantTransaction } from '../infrastructure/tenant-database';

export interface PublishedDataPolicy {
  readonly version: number;
  readonly document: DataPolicyDocument;
}

const cache = new WeakMap<TenantTransaction, PublishedDataPolicy | null>();

/**
 * The tenant's published data policy (highest `data_policy` registry version),
 * validated again on read. `undefined` = no policy published: platform defaults
 * apply (M10A2 plan §6: no policy row is ever invented).
 */
export async function publishedDataPolicy(
  tx: TenantTransaction,
): Promise<PublishedDataPolicy | undefined> {
  if (cache.has(tx)) return cache.get(tx) ?? undefined;
  const row = await tenantClient(tx).tenantRegistryVersion.findFirst({
    where: { tenantId: tx.tenantId, kind: 'data_policy' },
    orderBy: { version: 'desc' },
    select: { version: true, document: true },
  });
  const policy = row
    ? { version: row.version, document: DataPolicyDocumentSchema.parse(row.document) }
    : null;
  cache.set(tx, policy);
  return policy ?? undefined;
}

export function forgetDataPolicy(tx: TenantTransaction): void {
  cache.delete(tx);
}

/**
 * `RetentionPolicyProvider` (M10A1 deferral closed by M10A2): per tenant,
 * `published data policy ?? platform defaults`. Audit purge execution stays
 * disabled whatever the policy says (AUDIT_PURGE_EXECUTION_APPROVED).
 */
export async function tenantRetention(
  tx: TenantTransaction,
): Promise<
  Readonly<Record<RetentionClass, ResolvedRetention>> & { readonly policyVersion: number | null }
> {
  const policy = await publishedDataPolicy(tx);
  return Object.assign({}, resolveRetention(policy?.document), {
    policyVersion: policy?.version ?? null,
  });
}
