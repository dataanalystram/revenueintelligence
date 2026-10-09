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

/** SecretProvider key of the legacy platform token key (env: PLATFORM_TOKEN_ENCRYPTION_KEY). */
export const TOKEN_ENCRYPTION_KEY = 'platform.token_encryption_key';
/** Configuration (not secret): the current key id (env: PLATFORM_TOKEN_ENCRYPTION_KEY_ID). */
export const TOKEN_ENCRYPTION_KEY_ID = 'platform.token_encryption_key_id';
/** Configuration (not secret): comma-separated key ids still accepted for reading. */
export const TOKEN_ENCRYPTION_PREVIOUS_KEY_IDS = 'platform.token_encryption_previous_key_ids';
/** SecretProvider key of the key for one key id (env: PLATFORM_TOKEN_ENCRYPTION_KEY_<KID>). */
export const tokenEncryptionKeyName = (kid: string): string => `${TOKEN_ENCRYPTION_KEY}.${kid}`;
/** The key id of the legacy key (no keyring configured; v1 ciphertexts). */
export const LEGACY_KEY_ID = 'legacy';
export const KEY_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Stored tokens could not be decrypted (wrong key, tampering, or a copied row). */
export class TokenDecryptionError extends Error {
  constructor() {
    super('A stored token could not be decrypted');
    this.name = 'TokenDecryptionError';
  }
}

/** A platform token key is missing, malformed, or not in the keyring. */
export class TokenKeyError extends Error {
  constructor(
    reason: string,
    /** Set when a ciphertext names a key id that is not in the keyring. */
    readonly unknownKeyId?: string,
  ) {
    super(`The platform token encryption key is ${reason}`);
    this.name = 'TokenKeyError';
  }
}

/** Which key a stored ciphertext was written with (identifiers only). */
export interface CiphertextKey {
  readonly format: 'v1' | 'v2';
  readonly kid: string;
}

interface DerivedKey {
  readonly enc: Buffer;
  readonly mac: Buffer;
}

function derive(raw: Buffer, kid: string): DerivedKey {
  return {
    enc: Buffer.from(
      hkdfSync('sha256', raw, Buffer.alloc(0), `lip:token-encryption:v2:${kid}`, 32),
    ),
    mac: Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), `lip:oauth-state:v2:${kid}`, 32)),
  };
}

function deriveV1(raw: Buffer): DerivedKey {
  return {
    enc: Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), 'lip:token-encryption:v1', 32)),
    mac: Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), 'lip:oauth-state:v1', 32)),
  };
}

function assertKeyId(kid: string): void {
  if (!KEY_ID_PATTERN.test(kid))
    throw new TokenKeyError(`id is invalid (expected ${KEY_ID_PATTERN.source})`);
}

/**
 * Authenticated encryption for tokens at rest (ADR 0010, M10A1 plan §13):
 * AES-256-GCM with a random 96-bit IV. The associated data binds each
 * ciphertext to where it is stored (tenant, system, column), so a ciphertext
 * copied into another tenant's row, or into another column, fails to decrypt.
 *
 * Output: `v2:<kid>:` + base64url(iv | ciphertext | tag), always with the
 * current key. Reading accepts `v2:<kid>:` for any key in the keyring and the
 * pre-M10A1 `v1:` format with the legacy key.
 *
 * Each key also yields, through HKDF with a separate label that includes the
 * key id, the HMAC key that signs OAuth install states: states are signed with
 * the current key and verified with every key in the keyring (they live
 * minutes, so a rotation never invalidates an install in progress).
 */
export class TokenCipher {
  readonly #current: string;
  readonly #keys = new Map<string, DerivedKey>();
  readonly #legacyV1: DerivedKey | undefined;

  /**
   * One key: `new TokenCipher(secret)` is the legacy key (kid `legacy`).
   * A keyring: the current key id, its key, and further keys accepted for reading.
   */
  constructor(
    key: Secret,
    options: {
      kid?: string;
      others?: readonly { kid: string; key: Secret }[];
      legacy?: Secret;
    } = {},
  ) {
    const kid = options.kid ?? LEGACY_KEY_ID;
    assertKeyId(kid);
    this.#current = kid;
    this.#keys.set(kid, derive(decodeKey(key), kid));
    for (const other of options.others ?? []) {
      assertKeyId(other.kid);
      if (!this.#keys.has(other.kid))
        this.#keys.set(other.kid, derive(decodeKey(other.key), other.kid));
    }
    const legacy = kid === LEGACY_KEY_ID ? key : options.legacy;
    if (legacy) {
      const raw = decodeKey(legacy);
      this.#legacyV1 = deriveV1(raw);
      if (!this.#keys.has(LEGACY_KEY_ID)) this.#keys.set(LEGACY_KEY_ID, derive(raw, LEGACY_KEY_ID));
    }
  }

  /**
   * Loads the keyring from the SecretProvider. With `PLATFORM_TOKEN_ENCRYPTION_KEY_ID`
   * set, its key is current and the previous key ids stay readable; without it the
   * legacy `PLATFORM_TOKEN_ENCRYPTION_KEY` is the current key (kid `legacy`). The
   * legacy key, when configured, always stays readable (v1 rows).
   */
  static async fromSecrets(secrets: SecretProvider): Promise<TokenCipher> {
    const legacy = await secrets.find(TOKEN_ENCRYPTION_KEY);
    const kid = (await secrets.find(TOKEN_ENCRYPTION_KEY_ID))?.reveal().trim();
    if (!kid) {
      if (!legacy) throw new TokenKeyError('not configured');
      return new TokenCipher(legacy);
    }
    const load = async (id: string) => {
      assertKeyId(id);
      const key = await secrets.find(tokenEncryptionKeyName(id));
      if (!key) throw new TokenKeyError(`not configured for key id ${id}`);
      return key;
    };
    const previous = ((await secrets.find(TOKEN_ENCRYPTION_PREVIOUS_KEY_IDS))?.reveal() ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x && x !== kid && x !== LEGACY_KEY_ID);
    const others = [];
    for (const id of previous) others.push({ kid: id, key: await load(id) });
    return new TokenCipher(await load(kid), { kid, others, ...(legacy ? { legacy } : {}) });
  }

  /** The key id new ciphertexts and state signatures use. */
  get currentKeyId(): string {
    return this.#current;
  }

  /** Every key id this cipher can read (current first). */
  get keyIds(): readonly string[] {
    return [this.#current, ...[...this.#keys.keys()].filter((k) => k !== this.#current)];
  }

  /** The format and key id of a stored ciphertext, without decrypting it. */
  static keyOf(payload: string): CiphertextKey | undefined {
    if (payload.startsWith('v1:')) return { format: 'v1', kid: LEGACY_KEY_ID };
    const m = /^v2:([a-z0-9-]{1,32}):/.exec(payload);
    return m ? { format: 'v2', kid: m[1]! } : undefined;
  }

  /** True when the ciphertext was not written with the current key in the current format. */
  needsRekey(payload: string): boolean {
    const key = TokenCipher.keyOf(payload);
    return !key || key.format !== 'v2' || key.kid !== this.#current;
  }

  encrypt(plaintext: Secret, associatedData: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#keys.get(this.#current)!.enc, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext.reveal(), 'utf8'), cipher.final()]);
    const data = Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
    return `v2:${this.#current}:${data}`;
  }

  decrypt(payload: string, associatedData: string): Secret {
    const key = TokenCipher.keyOf(payload);
    if (!key) throw new TokenDecryptionError();
    const derived = key.format === 'v1' ? this.#legacyV1 : this.#keys.get(key.kid);
    if (!derived) throw new TokenKeyError(`not available for key id ${key.kid}`, key.kid);
    const prefix = key.format === 'v1' ? 'v1:' : `v2:${key.kid}:`;
    const data = Buffer.from(payload.slice(prefix.length), 'base64url');
    if (data.length < IV_BYTES + TAG_BYTES + 1) throw new TokenDecryptionError();
    const iv = data.subarray(0, IV_BYTES);
    const tag = data.subarray(data.length - TAG_BYTES);
    const body = data.subarray(IV_BYTES, data.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', derived.enc, iv);
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(tag);
      return new Secret(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
    } catch {
      // Never surface OpenSSL details: they are useless to callers and could leak.
      throw new TokenDecryptionError();
    }
  }

  /** HMAC-SHA256 (base64url) with the current key's derived state-signing key. */
  sign(data: string): string {
    return mac(this.#keys.get(this.#current)!.mac, data);
  }

  /** Constant-time check against every key in the keyring (and the legacy v1 label). */
  verify(data: string, signature: string): boolean {
    // Compare the canonical base64url text, not decoded bytes: decoding is
    // lenient about the unused bits of the last character, so several
    // spellings would otherwise verify.
    const actual = Buffer.from(signature, 'utf8');
    const candidates = [...this.#keys.values(), ...(this.#legacyV1 ? [this.#legacyV1] : [])];
    let ok = false;
    for (const k of candidates) {
      const expected = Buffer.from(mac(k.mac, data), 'utf8');
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) ok = true;
    }
    return ok;
  }
}

function mac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64url');
}

function decodeKey(key: Secret): Buffer {
  const text = key.reveal().trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) throw new TokenKeyError('not base64');
  const raw = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw.length !== 32)
    throw new TokenKeyError('not 32 bytes (generate one with: openssl rand -base64 32)');
  return raw;
}
