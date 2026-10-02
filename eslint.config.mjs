import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/api/src/generated/**',
      '**/*.cjs',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unawaited promises silently drop errors — unacceptable in queue/sync code.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Plain ESM tooling outside any TypeScript project (hubspot-app/render.mjs).
    files: ['hubspot-app/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Tenant configuration tables are written only through TenantConfigService,
    // which enforces cross-setting invariants under the per-tenant lock
    // (ADR 0008). Other modules must not touch these Prisma delegates directly.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/modules/tenancy/infrastructure/**', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        // Dot access, bracket access and destructuring of the configuration
        // delegates. (Raw SQL cannot be linted; see ADR 0008.)
        {
          selector:
            'MemberExpression[property.name=/^tenant(Integration|FlowSetting|QualificationConfig|CredentialRef|Policy|Product|FieldMapping|LeadSourceMapping)$/]',
          message:
            'Tenant configuration is accessed only through TenantConfigService / TenantCredentialsService (ADR 0008).',
        },
        {
          selector:
            'MemberExpression[computed=true][property.value=/^tenant(Integration|FlowSetting|QualificationConfig|CredentialRef|Policy|Product|FieldMapping|LeadSourceMapping)$/]',
          message:
            'Tenant configuration is accessed only through TenantConfigService / TenantCredentialsService (ADR 0008).',
        },
        {
          selector:
            'ObjectPattern > Property[key.name=/^tenant(Integration|FlowSetting|QualificationConfig|CredentialRef|Policy|Product|FieldMapping|LeadSourceMapping)$/]',
          message:
            'Tenant configuration is accessed only through TenantConfigService / TenantCredentialsService (ADR 0008).',
        },
      ],
    },
  },
  {
    // M7 (ADR 0016): `tenant_products` is the projection of the published
    // product model, owned by the products module's persistence layer. Every
    // other configuration delegate stays off-limits there.
    files: ['apps/api/src/modules/products/infrastructure/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^tenant(Integration|FlowSetting|QualificationConfig|CredentialRef|Policy|FieldMapping|LeadSourceMapping)$/]',
          message:
            'Tenant configuration is accessed only through TenantConfigService / TenantCredentialsService (ADR 0008).',
        },
        {
          selector:
            'MemberExpression[computed=true][property.value=/^tenant(Integration|FlowSetting|QualificationConfig|CredentialRef|Policy|FieldMapping|LeadSourceMapping)$/]',
          message:
            'Tenant configuration is accessed only through TenantConfigService / TenantCredentialsService (ADR 0008).',
        },
        {
          selector:
            'ObjectPattern > Property[key.name=/^tenant(Integration|FlowSetting|QualificationConfig|CredentialRef|Policy|FieldMapping|LeadSourceMapping)$/]',
          message:
            'Tenant configuration is accessed only through TenantConfigService / TenantCredentialsService (ADR 0008).',
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
