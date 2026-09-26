import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSecretProvider } from '../../../platform/secrets';
import { TenantSlugSchema, type TenantSlug } from '../tenant';
import { credentialSecretKey, CredentialNameSchema, isOwnedSecretKey } from './credentials';
import { FieldMappingSchema } from './field-mappings';
import {
  ALLOWED_FLOW_MODES,
  flowConfigurationProblems,
  FlowSchema,
  satisfiesAccess,
} from './flows';
import { IntegrationSettingsSchemas, isEnabled, parseIntegrationSettings } from './integrations';
import { LeadSourceMappingSchema } from './lead-source-mappings';
import { parsePolicyDocument } from './policies';
import {
  DEFAULT_QUALIFICATION_CONFIG,
  modeRequiresJev,
  QualificationConfigInputSchema,
} from './qualification';
import { TenantTemplateSchema } from './template';

const slug = (s: string) => TenantSlugSchema.parse(s);

describe('tenant slugs', () => {
  it.each(['juniper', 'acme2', 'ab'])('accepts %s', (s) =>
    expect(TenantSlugSchema.safeParse(s).success).toBe(true),
  );
  it.each([
    'a',
    '2acme',
    'Acme',
    'acme-schools',
    'acme_schools',
    'acme.schools',
    'x'.repeat(41),
    '',
  ])('rejects %j (separators could make secret keys collide)', (s) =>
    expect(TenantSlugSchema.safeParse(s).success).toBe(false),
  );
});

describe('credential secret keys', () => {
  it('are derived from the tenant slug', () => {
    expect(
      credentialSecretKey(slug('juniper'), 'hubspot', CredentialNameSchema.parse('refresh_token')),
    ).toBe('tenant.juniper.hubspot.refresh_token');
    expect(EnvSecretProvider.toEnvName('tenant.juniper.hubspot.refresh_token')).toBe(
      'TENANT_JUNIPER_HUBSPOT_REFRESH_TOKEN',
    );
  });

  it('recognise ownership by exact slug prefix', () => {
    expect(isOwnedSecretKey(slug('juniper'), 'tenant.juniper.sugar.password')).toBe(true);
    expect(isOwnedSecretKey(slug('juniper'), 'tenant.juniperx.sugar.password')).toBe(false);
    expect(isOwnedSecretKey(slug('jun'), 'tenant.juniper.sugar.password')).toBe(false);
    expect(isOwnedSecretKey(slug('juniper'), 'hubspot.app.client_secret')).toBe(false);
  });

  it('never map two different tenants onto the same environment variable', () => {
    // Exhaustive over a set of adversarial slug/name pairs: the env provider
    // folds . - _ together, so collisions would appear here if slugs allowed them.
    const slugs = ['ab', 'abc', 'abcd', 'bc', 'a1', 'a1b'].map(slug);
    const names = ['c', 'c_d', 'bc', 'b_c', 'token', 'c_token']
      .map((n) => `x${n}`)
      .map((n) => CredentialNameSchema.parse(n));
    const owners = new Map<string, TenantSlug>();
    for (const s of slugs) {
      for (const system of ['hubspot', 'sugar'] as const) {
        for (const name of names) {
          const env = EnvSecretProvider.toEnvName(credentialSecretKey(s, system, name));
          const owner = owners.get(env);
          expect(owner === undefined || owner === s).toBe(true);
          owners.set(env, s);
        }
      }
    }
  });

  it.each(['', 'A', 'has-dash', '1abc', 'with space', 'x'])('rejects credential name %j', (n) => {
    expect(CredentialNameSchema.safeParse(n).success).toBe(false);
  });
});

describe('integration settings', () => {
  it('are strict: unknown keys (such as secrets) are rejected', () => {
    expect(
      IntegrationSettingsSchemas.sugar.safeParse({ baseUrl: 'https://x.example', password: 'p' })
        .success,
    ).toBe(false);
    expect(IntegrationSettingsSchemas.hubspot.safeParse({ accessToken: 'x' }).success).toBe(false);
  });

  it('validate formats', () => {
    expect(
      parseIntegrationSettings('sugar', {
        baseUrl: 'https://juniper.sugarondemand.example',
        apiVersion: 'v11_20',
      }),
    ).toEqual({
      baseUrl: 'https://juniper.sugarondemand.example',
      apiVersion: 'v11_20',
    });
    expect(() => parseIntegrationSettings('sugar', { baseUrl: 'http://plain.example' })).toThrow();
    expect(() => parseIntegrationSettings('hubspot', { portalId: 'abc' })).toThrow();
    expect(isEnabled({ access: 'disabled' })).toBe(false);
    expect(isEnabled({ access: 'read_only' })).toBe(true);
  });
});

describe('flows', () => {
  it('orders access levels', () => {
    expect(satisfiesAccess('read_write', 'read_only')).toBe(true);
    expect(satisfiesAccess('read_only', 'read_write')).toBe(false);
    expect(satisfiesAccess('disabled', 'read_only')).toBe(false);
  });

  it('off is always valid', () => {
    for (const flow of FlowSchema.options)
      expect(flowConfigurationProblems(flow, 'off', {})).toEqual([]);
  });

  it('coexist is available only for flows another integration could own', () => {
    expect(ALLOWED_FLOW_MODES.hubspot_to_sugar_handover).toContain('coexist');
    expect(flowConfigurationProblems('gainsight_lead_creation', 'coexist', {})).toEqual([
      'gainsight_lead_creation does not support mode "coexist"',
    ]);
  });

  it('shadow and coexist need read access; active needs write where the flow writes', () => {
    const readOnly = { hubspot: 'read_only', sugar: 'read_only' } as const;
    expect(flowConfigurationProblems('hubspot_to_sugar_handover', 'shadow', readOnly)).toEqual([]);
    expect(flowConfigurationProblems('hubspot_to_sugar_handover', 'coexist', readOnly)).toEqual([]);
    expect(flowConfigurationProblems('hubspot_to_sugar_handover', 'active', readOnly)).toHaveLength(
      2,
    );
    expect(
      flowConfigurationProblems('sugar_to_hubspot_outcomes', 'active', {
        hubspot: 'read_write',
        sugar: 'read_only',
      }),
    ).toEqual([]);
    expect(flowConfigurationProblems('hubspot_to_sugar_handover', 'shadow', {})).toEqual([
      'hubspot_to_sugar_handover in mode "shadow" needs hubspot access "read_only" (currently "disabled")',
      'hubspot_to_sugar_handover in mode "shadow" needs sugar access "read_only" (currently "disabled")',
    ]);
  });
});

describe('qualification config', () => {
  it('defaults to rules with a 0.6 Jev confidence floor', () => {
    expect(DEFAULT_QUALIFICATION_CONFIG).toEqual({
      mode: 'rules',
      rulesetVersion: null,
      settings: { jev: { minConfidence: 0.6 } },
    });
  });

  it('knows which modes need Jev', () => {
    expect(modeRequiresJev('rules')).toBe(false);
    expect(modeRequiresJev('jev')).toBe(true);
    expect(modeRequiresJev('hybrid')).toBe(true);
  });

  it.each([
    { mode: 'magic' },
    { mode: 'rules', settings: { jev: { minConfidence: 1.5 } } },
    { mode: 'rules', extra: 1 },
  ])('rejects %j', (input) =>
    expect(QualificationConfigInputSchema.safeParse(input).success).toBe(false),
  );
});

describe('mappings and policies', () => {
  const base = {
    system: 'sugar',
    objectType: 'Leads',
    canonicalEntity: 'lead',
    canonicalField: 'stage',
    direction: 'bidirectional',
  } as const;

  it('field mappings: tbc ⇔ no external field', () => {
    expect(
      FieldMappingSchema.safeParse({ ...base, externalField: null, status: 'tbc' }).success,
    ).toBe(true);
    expect(
      FieldMappingSchema.safeParse({ ...base, externalField: 'status', status: 'tbc' }).success,
    ).toBe(false);
    expect(
      FieldMappingSchema.safeParse({ ...base, externalField: null, status: 'confirmed' }).success,
    ).toBe(false);
    expect(
      FieldMappingSchema.safeParse({ ...base, externalField: 'status', status: 'proposed' })
        .success,
    ).toBe(true);
  });

  it('lead source mappings: channel must suit the source system', () => {
    const m = { sourceProperty: 'p', matchType: 'contains', sourceValue: 'Demo' } as const;
    expect(
      LeadSourceMappingSchema.safeParse({ ...m, system: 'hubspot', channel: 'demo_request' })
        .success,
    ).toBe(true);
    expect(
      LeadSourceMappingSchema.safeParse({ ...m, system: 'hubspot', channel: 'product_usage' })
        .success,
    ).toBe(false);
    expect(
      LeadSourceMappingSchema.safeParse({ ...m, system: 'gainsight_cs', channel: 'cs_expansion' })
        .success,
    ).toBe(true);
  });

  it('policies validate per kind', () => {
    expect(
      parsePolicyDocument('sla', { responseMinutes: { hot: 60, warm: 1440, cold: 4320 } }),
    ).toBeDefined();
    expect(() =>
      parsePolicyDocument('sla', { responseMinutes: { hot: 0, warm: 1, cold: 1 } }),
    ).toThrow();
    expect(parsePolicyDocument('routing', {})).toEqual({ placeholder: true });
    expect(() => parsePolicyDocument('routing', { rules: [] })).toThrow();
  });
});

describe('tenant templates', () => {
  it('the Juniper template is valid and never enables integrations or flows', () => {
    const raw = JSON.parse(
      readFileSync(resolve('config/tenant-templates/juniper.json'), 'utf8'),
    ) as Record<string, unknown>;
    const template = TenantTemplateSchema.parse(raw);
    expect(raw).not.toHaveProperty('flows');
    expect(raw).not.toHaveProperty('credentials');
    expect(template.policies.sla).toEqual({ responseMinutes: { hot: 60, warm: 1440, cold: 4320 } });
    expect(
      template.fieldMappings
        .filter((m) => m.status === 'tbc')
        .every((m) => m.externalField === null),
    ).toBe(true);
  });

  it('rejects templates that try to set access levels or flows', () => {
    expect(
      TenantTemplateSchema.safeParse({ flows: { hubspot_to_sugar_handover: 'active' } }).success,
    ).toBe(false);
    expect(
      TenantTemplateSchema.safeParse({ integrationSettings: { sugar: { access: 'read_write' } } })
        .success,
    ).toBe(false);
  });
});
