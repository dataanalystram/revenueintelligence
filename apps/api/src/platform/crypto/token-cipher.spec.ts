import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvSecretProvider, Secret } from '../secrets';
import { TokenCipher, TokenDecryptionError, TokenKeyError } from './token-cipher';

const key = (): Secret => new Secret(randomBytes(32).toString('base64'));
const AAD = 'tenant_oauth_tokens|00000000-0000-4000-8000-000000000001|hubspot|refresh_token';

describe('TokenCipher (AES-256-GCM, ADR 0010)', () => {
  it('round-trips, and every encryption uses a fresh IV', () => {
    const cipher = new TokenCipher(key());
    const a = cipher.encrypt(new Secret('refresh-token-value'), AAD);
    const b = cipher.encrypt(new Secret('refresh-token-value'), AAD);
    expect(a).toMatch(/^v1:[A-Za-z0-9_-]{38,}$/);
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a, AAD).reveal()).toBe('refresh-token-value');
    expect(Buffer.from(a.slice(3), 'base64url').toString('latin1')).not.toContain(
      'refresh-token-value',
    );
  });

  it('the wrong key cannot decrypt', () => {
    const payload = new TokenCipher(key()).encrypt(new Secret('t'), AAD);
    expect(() => new TokenCipher(key()).decrypt(payload, AAD)).toThrow(TokenDecryptionError);
  });

  it('any tampering is detected (IV, body or tag)', () => {
    const cipher = new TokenCipher(key());
    const payload = cipher.encrypt(new Secret('some-token-value'), AAD);
    const raw = Buffer.from(payload.slice(3), 'base64url');
    for (const index of [0, 13, raw.length - 1]) {
      const copy = Buffer.from(raw);
      copy[index] = copy[index]! ^ 0x01;
      expect(() => cipher.decrypt(`v1:${copy.toString('base64url')}`, AAD)).toThrow(
        TokenDecryptionError,
      );
    }
    expect(() => cipher.decrypt('v1:AAAA', AAD)).toThrow(TokenDecryptionError);
    expect(() => cipher.decrypt('plaintext', AAD)).toThrow(TokenDecryptionError);
  });

  it('a ciphertext moved to another tenant, system or column fails (associated data)', () => {
    const cipher = new TokenCipher(key());
    const payload = cipher.encrypt(new Secret('t'), AAD);
    for (const other of [
      AAD.replace('0001', '0002'),
      AAD.replace('hubspot', 'sugar'),
      AAD.replace('refresh_token', 'access_token'),
    ]) {
      expect(() => cipher.decrypt(payload, other)).toThrow(TokenDecryptionError);
    }
  });

  it('decryption errors never contain the token, key or ciphertext', () => {
    const k = key();
    const payload = new TokenCipher(k).encrypt(new Secret('super-secret-token'), AAD);
    try {
      new TokenCipher(key()).decrypt(payload, AAD);
      expect.unreachable();
    } catch (err) {
      const text = `${String(err)} ${JSON.stringify(err)} ${(err as Error).stack ?? ''}`;
      expect(text).not.toContain('super-secret-token');
      expect(text).not.toContain(k.reveal());
      expect(text).not.toContain(payload.slice(3, 20));
    }
  });

  it('state signatures verify in constant time and reject any change', () => {
    const cipher = new TokenCipher(key());
    const sig = cipher.sign('payload');
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cipher.verify('payload', sig)).toBe(true);
    expect(cipher.verify('payloaD', sig)).toBe(false);
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(cipher.verify('payload', flipped)).toBe(false);
    expect(cipher.verify('payload', 'short')).toBe(false);
    expect(new TokenCipher(key()).verify('payload', sig)).toBe(false);
  });

  it('requires exactly 32 bytes of base64 key material', async () => {
    expect(() => new TokenCipher(new Secret('too-short'))).toThrow(TokenKeyError);
    expect(() => new TokenCipher(new Secret(randomBytes(16).toString('base64')))).toThrow(
      /32 bytes/,
    );
    expect(() => new TokenCipher(new Secret('not base64 !!'))).toThrow(TokenKeyError);
    await expect(TokenCipher.fromSecrets(new EnvSecretProvider({}))).rejects.toThrow(
      /not configured/,
    );
    const k = randomBytes(32).toString('base64url');
    await expect(
      TokenCipher.fromSecrets(new EnvSecretProvider({ PLATFORM_TOKEN_ENCRYPTION_KEY: k })),
    ).resolves.toBeInstanceOf(TokenCipher);
  });
});
