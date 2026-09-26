import { z } from 'zod';
import type { TenantSlug } from '../tenant';
import { IntegrationSystemSchema, type IntegrationSystem } from './integrations';

/** e.g. `client_secret`, `refresh_token`, `access_key`. */
export const CredentialNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,62}$/,
    'credential name must be lowercase letters, digits and underscores',
  );
export type CredentialName = z.infer<typeof CredentialNameSchema>;

export interface CredentialRef {
  readonly system: IntegrationSystem;
  readonly name: CredentialName;
  /** Logical SecretProvider key; always `tenant.<slug>.<system>.<name>`. */
  readonly secretKey: string;
}

export const CredentialRefInputSchema = z.object({
  system: IntegrationSystemSchema,
  name: CredentialNameSchema,
});

/**
 * The only way secret keys are formed. The key is derived, never supplied, so
 * a tenant's configuration cannot point at another tenant's secret; the
 * database enforces the same prefix with a CHECK constraint.
 *
 * With the env provider: tenant `juniper`, hubspot `refresh_token` →
 * `TENANT_JUNIPER_HUBSPOT_REFRESH_TOKEN`.
 */
export function credentialSecretKey(
  slug: TenantSlug,
  system: IntegrationSystem,
  name: CredentialName,
): string {
  return `tenant.${slug}.${system}.${name}`;
}

export function isOwnedSecretKey(slug: TenantSlug, secretKey: string): boolean {
  return secretKey.startsWith(`tenant.${slug}.`);
}
