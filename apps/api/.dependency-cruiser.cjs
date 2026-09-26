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
