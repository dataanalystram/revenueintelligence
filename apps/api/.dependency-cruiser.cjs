/**
 * Architectural boundary rules for the modular monolith. Run with
 * `pnpm depcheck:boundaries`; CI fails on any violation.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make module boundaries meaningless.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'platform-must-not-depend-on-modules',
      severity: 'error',
      comment: 'Infrastructure (src/platform) is shared plumbing and must stay business-agnostic.',
      from: { path: '^src/platform/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'modules-use-public-api-only',
      severity: 'error',
      comment: 'Import another module only through its index.ts, never its internals.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/.+',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'root-database-client-only-in-tenancy',
      severity: 'error',
      comment:
        'Tenant data is reached only through TenantDatabase.transaction(ctx, ...). Business modules ' +
        'never receive the root PrismaService, so unscoped queries cannot be written (ADR 0008).',
      from: {
        path: '^src/modules/',
        pathNot: ['^src/modules/tenancy/infrastructure/', '\\.spec\\.ts$'],
      },
      to: { path: '^src/platform/database/' },
    },
    {
      name: 'tenant-context-issued-only-by-tenancy',
      severity: 'error',
      comment: 'Only the tenancy module may import the context issuer.',
      from: { pathNot: '^src/modules/tenancy/' },
      to: { path: '^src/modules/tenancy/tenant-context\\.ts$' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'The canonical domain model depends only on itself, zod and node:crypto: no framework, ' +
        'persistence, platform or vendor code (ADR 0007).',
      from: { path: '^src/modules/domain/', pathNot: '\\.spec\\.ts$' },
      to: {
        pathNot: ['^src/modules/domain/', 'node_modules/zod/', '^crypto$', '^node:crypto$'],
      },
    },
    {
      name: 'hubspot-sdk-only-in-hubspot-connector',
      severity: 'error',
      comment: 'External systems are accessed only through connector modules.',
      from: { pathNot: '^src/modules/hubspot/' },
      to: { path: 'node_modules/@hubspot/' },
    },
    {
      name: 'business-code-uses-crm-port',
      severity: 'error',
      comment:
        'Business code reaches a CRM only through CRM_CONNECTOR / CrmReader (src/modules/crm, ADR 0010). ' +
        'Only the connector itself, the composition roots and the CLI may import a CRM connector module.',
      from: {
        path: '^src/',
        pathNot: [
          '^src/modules/hubspot/',
          '^src/cli/',
          '^src/app\\.module\\.ts$',
          '^src/worker\\.module\\.ts$',
        ],
      },
      to: { path: '^src/modules/hubspot/' },
    },
    {
      name: 'business-code-uses-source-port',
      severity: 'error',
      comment:
        'Business code reaches a source system only through the generic SourceConnector port ' +
        '(ADR 0019). Only the Sugar adapter itself, the composition roots and the CLI may import it.',
      from: {
        path: '^src/',
        pathNot: [
          '^src/modules/sugar/',
          '^src/cli/',
          '^src/app\\.module\\.ts$',
          '^src/worker\\.module\\.ts$',
        ],
      },
      to: { path: '^src/modules/sugar/' },
    },
    {
      name: 'gainsight-access-only-in-gainsight-connector',
      severity: 'error',
      from: { pathNot: '^src/modules/gainsight/' },
      to: { path: 'node_modules/.*gainsight' },
    },
    {
      name: 'prisma-client-only-in-persistence-layers',
      severity: 'error',
      comment: 'Domain and application code use repositories, not the ORM directly.',
      from: {
        path: '^src/',
        pathNot: [
          '^src/platform/database/',
          '^src/modules/[^/]+/infrastructure/',
          '^src/generated/',
        ],
      },
      to: { path: '^src/generated/prisma/' },
    },
    {
      name: 'bullmq-only-in-platform-queue',
      severity: 'error',
      comment:
        'Job coordination goes through QueueService (ADR 0013); BullMQ types never reach business code.',
      from: { pathNot: '^src/platform/queue/' },
      to: { path: 'node_modules/bullmq/' },
    },
    {
      name: 'context-store-only-from-ingestion',
      severity: 'error',
      comment:
        'ContextIngestionService is the single canonical writer (ADR 0014): webhooks, backfill and ' +
        'reconciliation reach canonical tables only through it.',
      from: {
        pathNot: [
          '^src/modules/context/application/context-ingestion\\.service\\.ts$',
          '^src/modules/context/context\\.module\\.ts$',
          '\\.spec\\.ts$',
        ],
      },
      to: { path: '^src/modules/context/infrastructure/context-store\\.ts$' },
    },
    {
      name: 'subscription-store-only-from-writer',
      severity: 'error',
      comment:
        'SubscriptionIngestionService is the single subscription writer (ADR 0017): imports and ' +
        'connectors reach tenant_subscriptions only through it. The account-merge participant is ' +
        'the one other writer (it repoints lines inside the M6 merge transaction).',
      from: {
        pathNot: [
          '^src/modules/products/application/subscription-ingestion\\.service\\.ts$',
          '^src/modules/products/application/subscription-merge\\.participant\\.ts$',
          '^src/modules/products/products\\.module\\.ts$',
          '^src/modules/products/subscription-merge\\.module\\.ts$',
          '\\.spec\\.ts$',
        ],
      },
      to: { path: '^src/modules/products/infrastructure/subscription\\.store\\.ts$' },
    },
    {
      name: 'context-never-depends-on-products',
      severity: 'error',
      comment:
        'Account merge is one workflow in the context module; products plugs in through the ' +
        'CompanyMergeParticipant port (dependency inversion), never the other way round.',
      from: { path: '^src/modules/context/' },
      to: { path: '^src/modules/products/' },
    },
    {
      name: 'eligibility-is-not-qualification',
      severity: 'error',
      comment:
        'Qualification (AI) classifies; deterministic code decides. Eligibility is deterministic ' +
        'and must not depend on any AI/qualification code (charter, ADR 0018).',
      from: {
        path: [
          '^src/modules/products/',
          '^src/modules/domain/(eligibility|product-model|subscription)\\.ts$',
        ],
      },
      to: { path: ['^src/modules/qualification/', '^src/modules/domain/qualification'] },
    },
    {
      name: 'qualification-never-reevaluates-eligibility',
      severity: 'error',
      comment:
        'Qualification judges the strength of an eligible candidate; it never re-evaluates ' +
        'eligibility or reads product relationships (ADR 0018 §7).',
      from: { path: ['^src/modules/qualification/', '^src/modules/domain/qualification'] },
      to: {
        path: [
          '^src/modules/products/',
          '^src/modules/domain/(eligibility|product-model|subscription)\\.ts$',
        ],
      },
    },
    {
      name: 'no-test-code-in-production',
      severity: 'error',
      from: { pathNot: '\\.spec\\.ts$' },
      to: { path: '(\\.spec\\.ts$|^test/)' },
    },
  ],
  options: {
    // Generated code is a dependency target (so rules can police who imports it)
    // but is not itself analysed.
    doNotFollow: { path: ['node_modules', '^src/generated/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
