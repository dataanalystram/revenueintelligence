import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Secret } from '../secrets/secret';
import type { SecretProvider } from '../secrets/secret-provider';

/** SecretProvider key of the platform token key (env: PLATFORM_TOKEN_ENCRYPTION_KEY). */
export const TOKEN_ENCRYPTION_KEY = 'platform.token_encryption_key';

const FORMAT = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Stored tokens could not be decrypted (wrong key, tampering, or a copied row). */
export class TokenDecryptionError extends Error {
  constructor() {
    super('A stored token could not be decrypted');
    this.name = 'TokenDecryptionError';
  }
}

/** PLATFORM_TOKEN_ENCRYPTION_KEY is missing or not 32 bytes of base64. */
export class TokenKeyError extends Error {
  constructor(reason: string) {
    super(`The platform token encryption key is ${reason}`);
    this.name = 'TokenKeyError';
  }
}

/**
 * Authenticated encryption for tokens at rest (ADR 0010): AES-256-GCM with a
 * random 96-bit IV. The associated data binds each ciphertext to where it is
 * stored (tenant, system, column), so a ciphertext copied into another
 * tenant's row, or into another column, fails to decrypt.
 *
 * Output: `v1:` + base64url(iv | ciphertext | tag).
 *
 * The same 32-byte key also yields, through HKDF with a separate label, the
 * HMAC key that signs OAuth install states; the two uses never share key
 * material directly.
 */
export class TokenCipher {
  readonly #encKey: Buffer;
  readonly #macKey: Buffer;

  constructor(key: Secret) {
    const raw = decodeKey(key);
    this.#encKey = Buffer.from(
      hkdfSync('sha256', raw, Buffer.alloc(0), 'lip:token-encryption:v1', 32),
    );
    this.#macKey = Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), 'lip:oauth-state:v1', 32));
  }

  /** Loads the key from the SecretProvider (fails with TokenKeyError if absent or invalid). */
  static async fromSecrets(secrets: SecretProvider): Promise<TokenCipher> {
    const key = await secrets.find(TOKEN_ENCRYPTION_KEY);
    if (!key) throw new TokenKeyError('not configured');
    return new TokenCipher(key);
  }

  encrypt(plaintext: Secret, associatedData: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#encKey, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext.reveal(), 'utf8'), cipher.final()]);
    return `${FORMAT}:${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
  }

  decrypt(payload: string, associatedData: string): Secret {
    const prefix = `${FORMAT}:`;
    if (!payload.startsWith(prefix)) throw new TokenDecryptionError();
    const data = Buffer.from(payload.slice(prefix.length), 'base64url');
    if (data.length < IV_BYTES + TAG_BYTES + 1) throw new TokenDecryptionError();
    const iv = data.subarray(0, IV_BYTES);
    const tag = data.subarray(data.length - TAG_BYTES);
    const body = data.subarray(IV_BYTES, data.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#encKey, iv);
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(tag);
      return new Secret(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
    } catch {
      // Never surface OpenSSL details: they are useless to callers and could leak.
      throw new TokenDecryptionError();
    }
  }

  /** HMAC-SHA256 (base64url) with the derived state-signing key. */
  sign(data: string): string {
    return createHmac('sha256', this.#macKey).update(data, 'utf8').digest('base64url');
  }

  /** Constant-time check of a signature produced by `sign`. */
  verify(data: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(data), 'base64url');
    const actual = Buffer.from(signature, 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

function decodeKey(key: Secret): Buffer {
  const text = key.reveal().trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) throw new TokenKeyError('not base64');
  const raw = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw.length !== 32)
    throw new TokenKeyError('not 32 bytes (generate one with: openssl rand -base64 32)');
  return raw;
}
