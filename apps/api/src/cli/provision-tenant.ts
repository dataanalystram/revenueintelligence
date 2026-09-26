import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TenancyModule, TenantRegistryService, TenantTemplateSchema } from '../modules/tenancy';
import { loadConfig } from '../platform/config';
import { PlatformModule } from '../platform/platform.module';

/**
 * Provisions a tenant with safe defaults (integrations disabled, flows off).
 *
 *   pnpm --filter @lip/api tenant:provision --slug juniper --name "Juniper Education" --template juniper
 *
 * `--template` is a name in config/tenant-templates/ or a path to a JSON file.
 * Runs with the application database role, like the API.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      template: { type: 'string' },
    },
  });
  if (!values.slug || !values.name) {
    throw new Error('Usage: tenant:provision --slug <slug> --name <name> [--template <name|path>]');
  }

  let template: unknown;
  if (values.template) {
    const file = values.template.endsWith('.json')
      ? resolve(values.template)
      : resolve(__dirname, '../../config/tenant-templates', `${values.template}.json`);
    template = TenantTemplateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  }

  const config = loadConfig();

  @Module({ imports: [PlatformModule.forRoot(config), TenancyModule] })
  class ProvisioningModule {}

  const app = await NestFactory.createApplicationContext(ProvisioningModule, {
    logger: ['error', 'warn'],
  });
  try {
    await app.init();
    const tenant = await app.get(TenantRegistryService).provision({
      slug: values.slug,
      name: values.name,
      template: template as never,
    });
    process.stdout.write(`${JSON.stringify(tenant, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
