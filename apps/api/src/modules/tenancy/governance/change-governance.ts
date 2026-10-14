import { transformTrace, type ChangeOrigin, type FieldEntry } from '../../domain';
import { tenantClient, type TenantTransaction } from '../infrastructure/tenant-database';
import { adoptedCanonicalVersion } from './canonical-version';

/** The M10A2 governance columns of a change record (plan §9). */
export interface ChangeGovernanceColumns {
  readonly origin: ChangeOrigin;
  readonly canonicalVersion: string;
  readonly schemaSnapshotHash: string | null;
  readonly transforms: string[];
}

interface MappingFacts {
  readonly snapshotHash: string;
  readonly objects: readonly { readonly source: string; readonly fields: readonly FieldEntry[] }[];
}

const mappingCache = new WeakMap<TenantTransaction, Map<string, MappingFacts | null>>();

async function mappingFacts(
  tx: TenantTransaction,
  connectionId: string,
  version: number,
): Promise<MappingFacts | null> {
  let perTx = mappingCache.get(tx);
  if (!perTx) {
    perTx = new Map();
    mappingCache.set(tx, perTx);
  }
  const key = `${connectionId}|${version}`;
  if (perTx.has(key)) return perTx.get(key)!;
  const row = await tenantClient(tx).tenantSourceMappingVersion.findUnique({
    where: { tenantId_connectionId_version: { tenantId: tx.tenantId, connectionId, version } },
    select: { schemaSnapshotHash: true, document: true },
  });
  const doc = row?.document as { objects?: { source: string; fields?: FieldEntry[] }[] } | null;
  const facts = row
    ? {
        snapshotHash: row.schemaSnapshotHash,
        objects: (doc?.objects ?? []).map((o) => ({ source: o.source, fields: o.fields ?? [] })),
      }
    : null;
  perTx.set(key, facts);
  return facts;
}

/**
 * Fills the governance columns for a change record written by a source-fed
 * writer (sync, webhook, reconciliation, import): origin `source_provided`, the
 * adopted canonical version (fail closed when unknown, Q19), and for versioned
 * connections the mapping version's schema snapshot hash and the transforms
 * the mapping declares on the object's mapped fields (names only).
 */
export async function changeGovernance(
  tx: TenantTransaction,
  input: {
    readonly sourceConnectionId: string | null;
    readonly mappingVersion?: number | null;
    readonly sourceObjectType: string;
    readonly origin?: ChangeOrigin;
  },
): Promise<ChangeGovernanceColumns> {
  const canonicalVersion = await adoptedCanonicalVersion(tx);
  let schemaSnapshotHash: string | null = null;
  let transforms: string[] = [];
  if (input.sourceConnectionId && input.mappingVersion != null) {
    const facts = await mappingFacts(tx, input.sourceConnectionId, input.mappingVersion);
    if (facts) {
      schemaSnapshotHash = facts.snapshotHash;
      const obj = facts.objects.find((o) => o.source === input.sourceObjectType);
      transforms = obj
        ? transformTrace(
            obj.fields.filter(
              (f): f is FieldEntry & { target: string; transforms?: object } =>
                'target' in f && typeof f.target === 'string',
            ),
          )
        : [];
    }
  }
  return {
    origin: input.origin ?? 'source_provided',
    canonicalVersion,
    schemaSnapshotHash,
    transforms,
  };
}
