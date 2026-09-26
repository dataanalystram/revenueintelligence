import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { EnvSecretProvider } from './env-secret-provider';
import { SECRET_PROVIDER, type SecretProvider } from './secret-provider';

@Global()
@Module({
  providers: [
    {
      provide: SECRET_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SecretProvider => {
        switch (config.secretsProvider) {
          case 'env':
            return new EnvSecretProvider();
        }
      },
    },
  ],
  exports: [SECRET_PROVIDER],
})
export class SecretsModule {}
