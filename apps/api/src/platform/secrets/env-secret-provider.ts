import { Secret } from './secret';
import {
  InvalidSecretKeyError,
  SECRET_KEY_PATTERN,
  SecretNotFoundError,
  type SecretProvider,
} from './secret-provider';

/**
 * Resolves secrets from environment variables. Intended for local development,
 * CI and simple container deployments; production deployments can swap in a
 * vault-backed provider behind the same interface.
 *
 * Key mapping: `hubspot.app.client_secret` -> `HUBSPOT_APP_CLIENT_SECRET`.
 */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  static toEnvName(key: string): string {
    if (!SECRET_KEY_PATTERN.test(key)) {
      throw new InvalidSecretKeyError(key);
    }
    return key.replace(/[.-]/g, '_').toUpperCase();
  }

  find(key: string): Promise<Secret | undefined> {
    const value = this.env[EnvSecretProvider.toEnvName(key)];
    return Promise.resolve(value === undefined || value === '' ? undefined : new Secret(value));
  }

  async get(key: string): Promise<Secret> {
    const secret = await this.find(key);
    if (!secret) {
      throw new SecretNotFoundError(key);
    }
    return secret;
  }
}
