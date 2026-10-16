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
      name: 'authorized-context-issued-only-by-security',
      severity: 'error',
      comment:
        'M10A1: only the security code of the tenancy module may import the authorized-context issuer (other code uses the tenancy index).',
      from: {
        pathNot: [
          '^src/modules/tenancy/security/',
          '^src/modules/tenancy/application/',
          '\\.spec\\.ts$',
        ],
      },
      to: { path: '^src/modules/tenancy/security/authorized-context\\.ts$' },
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
      name: 'profiling-is-advisory',
      severity: 'error',
      comment:
        'Source profiling only describes data (ADR 0022): its suggestions can never reach ' +
        'authority, ingestion or eligibility code directly, so profiling cannot decide.',
      from: { path: '^src/modules/domain/profiling/' },
      to: {
        path: [
          '^src/modules/domain/source-authority\\.ts$',
          '^src/modules/domain/source-mapping-engine\\.ts$',
          '^src/modules/domain/eligibility\\.ts$',
          '^src/modules/domain/index\\.ts$',
        ],
      },
    },
    {
      name: 'extension-data-is-never-evidence',
      severity: 'error',
      comment:
        'M10D (ADR 0030, Q21): extension values, custom records and custom relationships can ' +
        'never feed eligibility, ownership, whitespace, coverage or identity. The products ' +
        '(eligibility, ownership, coverage) and identity modules, and the pure eligibility / ' +
        'coverage / holding domain code, never import the extension module or its value parsing.',
      from: {
        path: [
          '^src/modules/(products|identity)/',
          '^src/modules/domain/(eligibility|coverage|holding-domain|source-authority)\\.ts$',
        ],
      },
      to: {
        path: [
          '^src/modules/extension/',
          '^src/modules/domain/canonical/extension-(values|use)\\.ts$',
        ],
      },
    },
    {
      name: 'commercial-never-feeds-ownership-or-eligibility',
      severity: 'error',
      comment:
        'M10F (ADR 0032, plan §13, Q27): price offers never affect ownership and entitlements ' +
        'never affect eligibility. The products module (ownership, eligibility, whitespace, ' +
        'coverage) and the pure eligibility / coverage / holding domain code never import the ' +
        'commercial module or the commercial domain vocabulary (the line sync reaches the ' +
        'commercial step only through the LineAfterWrite port wired by sources).',
      from: {
        path: [
          '^src/modules/products/',
          '^src/modules/domain/(eligibility|coverage|holding-domain)\\.ts$',
        ],
      },
      to: {
        path: ['^src/modules/commercial/', '^src/modules/domain/canonical/commercial\\.ts$'],
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
        '(ADR 0019). Only the adapter itself (Sugar, Chargebee), the composition roots and the CLI ' +
        'may import it.',
      from: {
        path: '^src/',
        pathNot: [
          '^src/modules/sugar/',
          '^src/modules/chargebee/',
          '^src/cli/',
          '^src/app\\.module\\.ts$',
          '^src/worker\\.module\\.ts$',
        ],
      },
      to: { path: '^src/modules/(sugar|chargebee)/' },
    },
    {
      name: 'core-never-depends-on-sources',
      severity: 'error',
      comment:
        'The sources module is an application layer on top of the core (ADR 0019): the pure ' +
        'domain, products/eligibility, context, identity, tenancy, CRM and the connector ' +
        'adapters (which implement the domain SourceConnector port) never import it. ' +
        'Only the composition roots and the CLI wire it in.',
      from: {
        path: '^src/modules/(domain|products|context|identity|tenancy|crm|sugar|chargebee|hubspot)/',
      },
      to: { path: '^src/modules/sources/' },
    },
    {
      name: 'sources-never-imports-concrete-adapters',
      severity: 'error',
      comment:
        'The generic source pipeline knows connectors only through the SourceConnector port and ' +
        'the adapter registry; concrete adapters are registered by the composition roots ' +
        '(ADR 0019), never imported by the sources module.',
      from: { path: '^src/modules/sources/' },
      to: { path: '^src/modules/(sugar|chargebee|hubspot)/' },
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
