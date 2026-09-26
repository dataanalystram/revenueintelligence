import type { Secret } from './secret';

export const SECRET_PROVIDER = Symbol('SECRET_PROVIDER');

/**
 * Logical secret keys use dot-separated segments, e.g.
 *   `hubspot.app.client_secret`
 *   `tenant.<tenantId>.sugar.password`
 * so the same key can map onto environment variables, Azure Key Vault,
 * AWS Secrets Manager or HashiCorp Vault without changing callers.
 */
export const SECRET_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class SecretNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Secret "${key}" is not configured`);
    this.name = 'SecretNotFoundError';
  }
}

export class InvalidSecretKeyError extends Error {
  constructor(readonly key: string) {
    super(`Invalid secret key "${key}"; expected lowercase dot-separated segments`);
    this.name = 'InvalidSecretKeyError';
  }
}

export interface SecretProvider {
  /** Returns the secret or throws SecretNotFoundError. */
  get(key: string): Promise<Secret>;
  /** Returns the secret, or undefined if it is not configured. */
  find(key: string): Promise<Secret | undefined>;
}
