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
  // M10A2 governance services.
  {
    file: 'governance/application/canonical-adoption.service.ts',
    className: 'CanonicalAdoptionService',
    writes: ['adopt'],
    reads: ['history', 'plan'],
  },
  {
    file: 'governance/application/module-settings.service.ts',
    className: 'ModuleSettingsService',
    writes: ['enable', 'disable', 'configure'],
    reads: ['list'],
  },
  {
    file: 'governance/application/registry.service.ts',
    className: 'RegistryService',
    writes: ['publish', 'publishDataPolicy'],
    reads: ['dryRun', 'show'],
  },
  {
    file: 'governance/application/integrity-verification.service.ts',
    className: 'IntegrityVerificationService',
    writes: ['record'],
    reads: ['verify'],
  },
  // M10B (ADR 0028).
  {
    file: 'governance/application/source-reference.service.ts',
    className: 'SourceReferenceService',
    writes: ['observe', 'retireAbsentWithin', 'merge', 'applyDeclaredProductReferences'],
    reads: [],
  },
  {
    file: 'governance/application/evidence-link.writer.ts',
    className: 'EvidenceLinkWriter',
    writes: ['write'],
    reads: [],
  },
  {
    // The read model writes one provenance.read audit event per call.
    file: 'governance/application/provenance-query.service.ts',
    className: 'ProvenanceQueryService',
    writes: ['show'],
    reads: [],
  },
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
    reads: ['invalidate', 'refreshOutcomes', 'clearCache'],
    // accessToken may refresh (config.oauth.grant, system actor), completeInstall stores the grant.
    authorizeInside: ['completeInstall', 'accessToken'],
  },
  {
    file: 'hubspot/application/hubspot-webhook.service.ts',
    className: 'HubSpotWebhookService',
    writes: [],
    reads: [],
    // processing.receipt for the intake's system actor, per tenant batch.
    authorizeInside: ['receive'],
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
    writes: ['publish', 'retire', 'saveDraft', 'validateDraft', 'publishDraft', 'discardDraft'],
    reads: ['validate', 'show', 'states', 'showDraft'],
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
    writes: ['ingest', 'ingestMerge', 'retireAbsentWithin', 'resolvePendingParent'],
    reads: [],
  },
  // M10C (ADR 0029): the account-structure writers and read model. Merge
  // participants run inside the merge's transaction under its authorization.
  {
    file: 'context/application/account-hierarchy.writer.ts',
    className: 'AccountHierarchyWriter',
    writes: ['observeParent', 'recordUnresolved', 'set', 'clear', 'release'],
    reads: [],
    authorizeInside: ['onCompanyMerged'],
  },
  {
    file: 'context/application/person-affiliation.writer.ts',
    className: 'PersonAffiliationWriter',
    writes: ['observe', 'add', 'end'],
    reads: [],
    authorizeInside: ['onCompanyMerged', 'onPersonMerged'],
  },
  {
    // The read model writes one account_structure.read audit event per call.
    file: 'context/application/account-structure.read-model.ts',
    className: 'AccountStructureReadModel',
    writes: ['hierarchy', 'affiliations'],
    reads: [],
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

  it('M10C (V18): canonical.human_entry is accepted only by the M10C operator methods', () => {
    const accepted = new Map<string, string[]>();
    for (const spec of SERVICES) {
      for (const [name, type] of publicMethods(spec.file, spec.className)) {
        if (type.includes("'canonical.human_entry'")) {
          accepted.set(spec.className, [...(accepted.get(spec.className) ?? []), name]);
        }
      }
    }
    expect(Object.fromEntries(accepted)).toEqual({
      AccountHierarchyWriter: ['set', 'clear', 'release'],
      PersonAffiliationWriter: ['add', 'end'],
    });
  });

  it('the check fails for a write method that takes a plain TenantContext', () => {
    expect('TenantContext').not.toMatch(AUTHORIZED);
    expect("TenantContext | AuthorizedContext<'config.policy'>").toMatch(AUTHORIZED);
  });
});
