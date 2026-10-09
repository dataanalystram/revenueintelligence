import { createCipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvSecretProvider, Secret } from '../secrets';
import { TokenCipher, TokenDecryptionError, TokenKeyError } from './token-cipher';

const key = (): Secret => new Secret(randomBytes(32).toString('base64'));
const AAD = 'tenant_oauth_tokens|00000000-0000-4000-8000-000000000001|hubspot|refresh_token';
/** Splits `v2:<kid>:<body>` / `v1:<body>` into prefix and decoded body. */
const parts = (payload: string) => {
  const prefix = /^(v1:|v2:[a-z0-9-]+:)/.exec(payload)![1]!;
  return { prefix, raw: Buffer.from(payload.slice(prefix.length), 'base64url') };
};
/** A ciphertext as the pre-M10A1 (v1) writer produced it: HKDF label v1, `v1:` prefix. */
const v1Encrypt = (k: Secret, plaintext: string, aad: string) => {
  const raw = Buffer.from(k.reveal(), 'base64');
  const enc = Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), 'lip:token-encryption:v1', 32));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', enc, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url')}`;
};

describe('TokenCipher (AES-256-GCM, ADR 0010)', () => {
  it('round-trips, and every encryption uses a fresh IV', () => {
    const cipher = new TokenCipher(key());
    const a = cipher.encrypt(new Secret('refresh-token-value'), AAD);
    const b = cipher.encrypt(new Secret('refresh-token-value'), AAD);
    expect(a).toMatch(/^v2:legacy:[A-Za-z0-9_-]{38,}$/);
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a, AAD).reveal()).toBe('refresh-token-value');
    expect(parts(a).raw.toString('latin1')).not.toContain('refresh-token-value');
  });

  it('the wrong key cannot decrypt', () => {
    const payload = new TokenCipher(key()).encrypt(new Secret('t'), AAD);
    expect(() => new TokenCipher(key()).decrypt(payload, AAD)).toThrow(TokenDecryptionError);
  });

  it('any tampering is detected (IV, body or tag)', () => {
    const cipher = new TokenCipher(key());
    const payload = cipher.encrypt(new Secret('some-token-value'), AAD);
    const { prefix, raw } = parts(payload);
    for (const index of [0, 13, raw.length - 1]) {
      const copy = Buffer.from(raw);
      copy[index] = copy[index]! ^ 0x01;
      expect(() => cipher.decrypt(`${prefix}${copy.toString('base64url')}`, AAD)).toThrow(
        TokenDecryptionError,
      );
    }
    expect(() => cipher.decrypt('v2:legacy:AAAA', AAD)).toThrow(TokenDecryptionError);
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
      expect(text).not.toContain(payload.slice(10, 30));
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
    // Only the canonical spelling: the last character's unused bits must match too.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias = alphabet[alphabet.indexOf(sig.at(-1)!) ^ 1]!;
    const aliasSig = `${sig.slice(0, -1)}${alias}`;
    expect(Buffer.from(aliasSig, 'base64url')).toEqual(Buffer.from(sig, 'base64url'));
    expect(cipher.verify('payload', aliasSig)).toBe(false);
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

  describe('M10A1 keyring (v2:<kid>, rotation, legacy v1)', () => {
    it('reads v1 ciphertexts with the legacy key and writes v2 with the current key', () => {
      const legacy = key();
      const old = v1Encrypt(legacy, 'v1-token', AAD);
      const asLegacy = new TokenCipher(legacy);
      expect(asLegacy.decrypt(old, AAD).reveal()).toBe('v1-token');
      expect(asLegacy.needsRekey(old)).toBe(true);
      const rotated = new TokenCipher(key(), { kid: 'k2', legacy });
      expect(rotated.currentKeyId).toBe('k2');
      expect(rotated.decrypt(old, AAD).reveal()).toBe('v1-token');
      const fresh = rotated.encrypt(new Secret('v2-token'), AAD);
      expect(TokenCipher.keyOf(fresh)).toEqual({ format: 'v2', kid: 'k2' });
      expect(rotated.needsRekey(fresh)).toBe(false);
      expect(TokenCipher.keyOf(old)).toEqual({ format: 'v1', kid: 'legacy' });
    });

    it('a previous key stays readable; an unknown key id fails with TokenKeyError naming only the id', () => {
      const k1 = key();
      const k2 = key();
      const first = new TokenCipher(k1, { kid: 'k1' }).encrypt(new Secret('t1'), AAD);
      const ring = new TokenCipher(k2, { kid: 'k2', others: [{ kid: 'k1', key: k1 }] });
      expect(ring.decrypt(first, AAD).reveal()).toBe('t1');
      expect(ring.needsRekey(first)).toBe(true);
      expect(ring.keyIds).toEqual(['k2', 'k1']);
      const without = new TokenCipher(k2, { kid: 'k2' });
      const err = (() => {
        try {
          without.decrypt(first, AAD);
        } catch (e) {
          return e as TokenKeyError;
        }
      })();
      expect(err).toBeInstanceOf(TokenKeyError);
      expect(err!.unknownKeyId).toBe('k1');
      expect(String(err)).not.toContain(k1.reveal());
      // The same key under a different id is a different derived key.
      const relabelled = first.replace('v2:k1:', 'v2:k2:');
      expect(() => new TokenCipher(k1, { kid: 'k2' }).decrypt(relabelled, AAD)).toThrow(
        TokenDecryptionError,
      );
      // v1 without a legacy key in the ring.
      expect(() => without.decrypt(v1Encrypt(k1, 'x', AAD), AAD)).toThrow(TokenKeyError);
    });

    it('states are signed with the current key and verified with current and previous keys', () => {
      const k1 = key();
      const k2 = key();
      const before = new TokenCipher(k1, { kid: 'k1' });
      const sig = before.sign('payload');
      const after = new TokenCipher(k2, { kid: 'k2', others: [{ kid: 'k1', key: k1 }] });
      expect(after.verify('payload', sig)).toBe(true);
      expect(after.sign('payload')).not.toBe(sig);
      expect(before.verify('payload', after.sign('payload'))).toBe(false);
      expect(new TokenCipher(k2, { kid: 'k2' }).verify('payload', sig)).toBe(false);
      // A state signed before M10A1 (v1 label, legacy key) still verifies while legacy is kept.
      const legacy = key();
      const v1Mac = Buffer.from(
        hkdfSync(
          'sha256',
          Buffer.from(legacy.reveal(), 'base64'),
          Buffer.alloc(0),
          'lip:oauth-state:v1',
          32,
        ),
      );
      const oldSig = createHmac('sha256', v1Mac).update('payload', 'utf8').digest('base64url');
      expect(new TokenCipher(k2, { kid: 'k2', legacy }).verify('payload', oldSig)).toBe(true);
      expect(new TokenCipher(k2, { kid: 'k2' }).verify('payload', oldSig)).toBe(false);
    });

    it('loads the keyring from the SecretProvider', async () => {
      const k1 = randomBytes(32).toString('base64');
      const k2 = randomBytes(32).toString('base64');
      const legacy = randomBytes(32).toString('base64');
      const ring = await TokenCipher.fromSecrets(
        new EnvSecretProvider({
          PLATFORM_TOKEN_ENCRYPTION_KEY: legacy,
          PLATFORM_TOKEN_ENCRYPTION_KEY_ID: 'k2',
          PLATFORM_TOKEN_ENCRYPTION_KEY_K2: k2,
          PLATFORM_TOKEN_ENCRYPTION_PREVIOUS_KEY_IDS: 'k1',
          PLATFORM_TOKEN_ENCRYPTION_KEY_K1: k1,
        }),
      );
      expect(ring.currentKeyId).toBe('k2');
      expect([...ring.keyIds].sort()).toEqual(['k1', 'k2', 'legacy']);
      await expect(
        TokenCipher.fromSecrets(new EnvSecretProvider({ PLATFORM_TOKEN_ENCRYPTION_KEY_ID: 'k3' })),
      ).rejects.toThrow(/not configured for key id k3/);
      await expect(
        TokenCipher.fromSecrets(
          new EnvSecretProvider({ PLATFORM_TOKEN_ENCRYPTION_KEY_ID: 'Bad_Id' }),
        ),
      ).rejects.toThrow(/id is invalid/);
      await expect(
        TokenCipher.fromSecrets(
          new EnvSecretProvider({
            PLATFORM_TOKEN_ENCRYPTION_KEY_ID: 'k2',
            PLATFORM_TOKEN_ENCRYPTION_KEY_K2: k2,
            PLATFORM_TOKEN_ENCRYPTION_PREVIOUS_KEY_IDS: 'k1',
          }),
        ),
      ).rejects.toThrow(/not configured for key id k1/);
    });
  });
});
