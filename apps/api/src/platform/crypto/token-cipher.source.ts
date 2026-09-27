import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { SECRET_PROVIDER, type SecretProvider } from '../secrets/secret-provider';
import { TokenCipher } from './token-cipher';

/**
 * Supplies the TokenCipher, loading PLATFORM_TOKEN_ENCRYPTION_KEY on first
 * use. Only processes that actually handle OAuth grants need the key, so
 * static-token tenants and processes keep working without it. A failed load
 * is not cached, so setting the key later takes effect without a restart.
 */
@Injectable()
export class TokenCipherSource {
  #cipher: Promise<TokenCipher> | undefined;

  constructor(@Inject(SECRET_PROVIDER) private readonly secrets: SecretProvider) {}

  get(): Promise<TokenCipher> {
    if (!this.#cipher) {
      const loading = TokenCipher.fromSecrets(this.secrets);
      this.#cipher = loading;
      loading.catch(() => {
        if (this.#cipher === loading) this.#cipher = undefined;
      });
    }
    return this.#cipher;
  }
}

@Global()
@Module({ providers: [TokenCipherSource], exports: [TokenCipherSource] })
export class CryptoModule {}
