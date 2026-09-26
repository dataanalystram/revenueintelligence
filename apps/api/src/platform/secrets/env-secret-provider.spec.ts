import { describe, expect, it } from 'vitest';
import { EnvSecretProvider } from './env-secret-provider';
import { InvalidSecretKeyError, SecretNotFoundError } from './secret-provider';

describe('EnvSecretProvider', () => {
  const provider = new EnvSecretProvider({
    HUBSPOT_APP_CLIENT_SECRET: 'hs-secret',
    TENANT_JUNIPER_SUGAR_PASSWORD: 'sugar-pw',
    EMPTY_VALUE: '',
  });

  it.each([
    ['hubspot.app.client_secret', 'HUBSPOT_APP_CLIENT_SECRET'],
    ['tenant.juniper.sugar.password', 'TENANT_JUNIPER_SUGAR_PASSWORD'],
    ['gainsight-cs.access-key', 'GAINSIGHT_CS_ACCESS_KEY'],
  ])('maps key %s to env var %s', (key, envName) => {
    expect(EnvSecretProvider.toEnvName(key)).toBe(envName);
  });

  it.each(['', 'UPPER.case', 'has space', '../etc/passwd', 'trailing.', '.leading', 'a..b'])(
    'rejects malformed key %j',
    (key) => {
      expect(() => EnvSecretProvider.toEnvName(key)).toThrow(InvalidSecretKeyError);
    },
  );

  it('returns a wrapped secret for a configured key', async () => {
    const secret = await provider.get('hubspot.app.client_secret');
    expect(secret.reveal()).toBe('hs-secret');
    expect(String(secret)).toBe('[REDACTED]');
  });

  it('find() returns undefined for missing or empty values', async () => {
    await expect(provider.find('does.not.exist')).resolves.toBeUndefined();
    await expect(provider.find('empty.value')).resolves.toBeUndefined();
  });

  it('get() throws SecretNotFoundError naming the key but not any value', async () => {
    const error = await provider.get('does.not.exist').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretNotFoundError);
    expect((error as SecretNotFoundError).key).toBe('does.not.exist');
  });

  it('get() rejects malformed keys', async () => {
    await expect(provider.get('Bad Key')).rejects.toBeInstanceOf(InvalidSecretKeyError);
  });
});
