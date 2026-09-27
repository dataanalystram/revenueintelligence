import 'reflect-metadata';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HubSpotModule } from '../modules/hubspot';
import { TenancyModule } from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';

/** Nest context for the HubSpot command-line tools (application database role, like the API). */
export async function withHubSpotContext<T>(
  work: (app: INestApplicationContext) => Promise<T>,
): Promise<T> {
  const config = loadConfig();

  @Module({ imports: [PlatformModule.forRoot(config), TenancyModule, HubSpotModule] })
  class HubSpotCliModule {}

  const app = await NestFactory.createApplicationContext(HubSpotCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    await app.init();
    return await work(app);
  } finally {
    await app.close();
  }
}

export function fail(err: unknown): never {
  const kind =
    typeof err === 'object' && err !== null && 'kind' in err ? ` [${String(err.kind)}]` : '';
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}${kind}\n`);
  process.exit(1);
}
