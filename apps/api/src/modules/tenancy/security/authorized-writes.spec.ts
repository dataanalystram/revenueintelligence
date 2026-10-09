import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * S2 (M10A1 plan §3): every public write method of the privileged services
 * takes an authorized context as its first parameter. Static: the source is
 * parsed, so a new public method must be classified here, and a write method
 * that takes a plain TenantContext fails (the typecheck catches callers too).
 */
const MODULES = resolve(__dirname, '..', '..');

interface ServiceSpec {
  readonly file: string;
  readonly className: string;
  /** Write methods: first parameter must be an authorized context. */
  readonly writes: readonly string[];
  /** Read-only methods (tenant context or none). */
  readonly reads: readonly string[];
  /**
   * Worker and callback entry points that authorize their own actor inside
   * (the system or source-sync actor, policy-checked) before any write.
   */
  readonly authorizeInside?: readonly string[];
}

const SERVICES: readonly ServiceSpec[] = [
  {
    file: 'tenancy/application/tenant-config.service.ts',
    className: 'TenantConfigService',
    writes: [
      'configureIntegration',
      'setFlowMode',
      'updateQualificationConfig',
      'saveLeadSourceMapping',
      'deleteLeadSourceMapping',
      'savePolicy',
    ],
    reads: [
      'listIntegrations',
      'getIntegration',
      'listFlows',
      'getQualificationConfig',
      'listProducts',
      'listLeadSourceMappings',
      'getPolicy',
    ],
  },
  {
    file: 'tenancy/application/tenant-credentials.service.ts',
    className: 'TenantCredentialsService',
    writes: ['register', 'remove'],
    reads: ['list', 'resolve'],
  },
  {
    file: 'tenancy/application/tenant-registry.service.ts',
    className: 'TenantRegistryService',
    writes: ['provision', 'suspend', 'reactivate', 'offboard'],
    reads: ['get', 'list'],
  },
  {
    file: 'hubspot/application/hubspot-oauth.service.ts',
    className: 'HubSpotOAuthService',
    writes: ['installUrl', 'expireStoredAccessToken'],
    reads: ['accessToken', 'invalidate', 'refreshOutcomes', 'clearCache'],
    authorizeInside: ['completeInstall'],
  },
  {
    file: 'sources/application/source-connections.service.ts',
    className: 'SourceConnectionsService',
    writes: ['configure', 'setStatus', 'test'],
    reads: ['list', 'get', 'profileSettings', 'syncSettings', 'hasAdapter', 'connector'],
  },
  {
    file: 'sources/application/schema-snapshots.service.ts',
    className: 'SchemaSnapshotsService',
    writes: ['capture'],
    reads: ['latest', 'drift'],
  },
  {
    file: 'sources/application/source-mappings.service.ts',
    className: 'SourceMappingsService',
    writes: ['publish'],
    reads: ['validate', 'show'],
  },
  {
    file: 'sources/application/source-authority.service.ts',
    className: 'SourceAuthorityService',
    writes: ['publish'],
    reads: ['show'],
  },
  {
    file: 'sources/application/source-sync.service.ts',
    className: 'SourceSyncService',
    writes: ['start', 'execute', 'abandon'],
    reads: [],
  },
  {
    file: 'sources/application/source-profiling.service.ts',
    className: 'SourceProfilingService',
    writes: ['request', 'execute', 'abandon'],
    reads: ['status', 'show', 'findings', 'drift', 'draftMapping'],
  },
  {
    file: 'sources/application/profile-purge.service.ts',
    className: 'ProfilePurgeService',
    writes: ['purge'],
    reads: [],
  },
  {
    file: 'products/application/product-catalogue.service.ts',
    className: 'ProductCatalogueService',
    writes: ['publish'],
    reads: [
      'validate',
      'modelAt',
      'modelAtTx',
      'modelVersionTx',
      'versions',
      'show',
      'listProducts',
      'getProduct',
      'diff',
    ],
  },
  {
    file: 'products/application/subscription-ingestion.service.ts',
    className: 'SubscriptionIngestionService',
    writes: ['ingest'],
    reads: ['activeSourceRecordIds', 'lineCompanyFor', 'resolvesProduct'],
  },
  {
    file: 'products/application/subscription-import.service.ts',
    className: 'SubscriptionImportService',
    writes: ['import', 'cancel'],
    reads: [],
  },
  {
    file: 'products/application/eligibility.service.ts',
    className: 'EligibilityService',
    writes: ['evaluate'],
    reads: ['whitespace', 'snapshot', 'listSnapshots', 'replay'],
  },
  {
    file: 'context/application/context-ingestion.service.ts',
    className: 'ContextIngestionService',
    writes: ['ingest', 'ingestMerge'],
    // Runs inside the caller's (authorized) transaction only.
    reads: ['retireAbsentWithin'],
  },
  {
    file: 'context/application/context-operations.service.ts',
    className: 'ContextOperationsService',
    writes: ['processReceipts', 'replayDeadLetters', 'discardDeadLetters', 'resync'],
    reads: ['listDeadLetters', 'report', 'show', 'stateHash'],
  },
  {
    file: 'context/application/bulk-sync.service.ts',
    className: 'BulkSyncService',
    writes: ['startBackfill', 'startReconcile', 'resume'],
    reads: [],
    authorizeInside: ['startDueReconciliations', 'processPage'],
  },
  {
    file: 'context/application/context-processing.service.ts',
    className: 'ContextProcessingService',
    writes: [],
    reads: [],
    authorizeInside: ['processReceipt', 'processSubject', 'tick', 'sweep', 'onFinalFailure'],
  },
];

/** An authorized-context type: AuthorizedContext<…>, a union with a dry-run TenantContext, or a named alias of one. */
const AUTHORIZED =
  /^(TenantContext \| )?(AuthorizedContext<[^>]+>|PlatformAuthorization<[^>]+>|CredentialConfigContext|SubscriptionWriteContext)$/;
const DRY_RUN_WRITES = new Set([
  'SourceProfilingService.request',
  'ProfilePurgeService.purge',
  'SubscriptionImportService.import',
  'EligibilityService.evaluate',
  'ContextOperationsService.processReceipts',
  'ContextOperationsService.replayDeadLetters',
]);

function publicMethods(file: string, className: string): Map<string, string> {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(MODULES, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const methods = new Map<string, string>();
  source.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== className) return;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || ts.isPrivateIdentifier(member.name)) continue;
      const flags = ts.getCombinedModifierFlags(member);
      if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static))
        continue;
      const first = member.parameters[0];
      methods.set(member.name.getText(), first?.type?.getText().replace(/\s+/g, ' ') ?? '');
    }
  });
  if (methods.size === 0) throw new Error(`${className} not found in ${file}`);
  return methods;
}

describe('S2: privileged service writes take an authorized context (static)', () => {
  it.each(SERVICES)('$className', (spec) => {
    const methods = publicMethods(spec.file, spec.className);
    const classified = [...spec.writes, ...spec.reads, ...(spec.authorizeInside ?? [])];
    expect(
      [...methods.keys()].filter((m) => !classified.includes(m)),
      'unclassified',
    ).toEqual([]);
    for (const write of spec.writes) {
      const type = methods.get(write);
      expect(type, `${spec.className}.${write} exists`).toBeDefined();
      expect(type, `${spec.className}.${write}`).toMatch(AUTHORIZED);
      if (type!.startsWith('TenantContext | ')) {
        expect(DRY_RUN_WRITES.has(`${spec.className}.${write}`), `${write}: dry run allowed`).toBe(
          true,
        );
      }
    }
    for (const read of spec.reads) {
      expect(methods.get(read) ?? '', `${spec.className}.${read}`).not.toMatch(/AuthorizedContext/);
    }
  });

  it('the check fails for a write method that takes a plain TenantContext', () => {
    expect('TenantContext').not.toMatch(AUTHORIZED);
    expect("TenantContext | AuthorizedContext<'config.policy'>").toMatch(AUTHORIZED);
  });
});
