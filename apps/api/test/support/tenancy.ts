import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  CompanySchema,
  PersonSchema,
  type CompanyInput,
  type PersonInput,
  type TenantId,
} from '../../src/modules/domain';
import {
  COMPANY_REPOSITORY,
  PERSON_REPOSITORY,
  type CompanyRepository,
  type PersonRepository,
} from '../../src/modules/identity';
import {
  TenantConfigService,
  TenantContextService,
  TenantCredentialsService,
  TenantDatabase,
  TenantRegistryService,
  type TenantContext,
} from '../../src/modules/tenancy';
import type { AppConfig } from '../../src/platform/config';
import { WorkerModule } from '../../src/worker.module';

export interface TenancyHarness {
  readonly app: INestApplicationContext;
  readonly db: TenantDatabase;
  readonly registry: TenantRegistryService;
  readonly contexts: TenantContextService;
  readonly config: TenantConfigService;
  readonly credentials: TenantCredentialsService;
  readonly persons: PersonRepository;
  readonly companies: CompanyRepository;
  close(): Promise<void>;
}

export async function startTenancy(config: AppConfig): Promise<TenancyHarness> {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
    logger: false,
  });
  await app.init();
  return {
    app,
    db: app.get(TenantDatabase),
    registry: app.get(TenantRegistryService),
    contexts: app.get(TenantContextService),
    config: app.get(TenantConfigService),
    credentials: app.get(TenantCredentialsService),
    persons: app.get<PersonRepository>(PERSON_REPOSITORY),
    companies: app.get<CompanyRepository>(COMPANY_REPOSITORY),
    close: () => app.close(),
  };
}

let counter = 0;
/** A unique, valid tenant slug per call (tests share one database). */
export function uniqueSlug(prefix = 't'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`.replace(/[^a-z0-9]/g, '').slice(0, 40);
}

export async function provisionTenant(h: TenancyHarness, prefix = 't'): Promise<TenantContext> {
  const slug = uniqueSlug(prefix);
  const tenant = await h.registry.provision({ slug, name: `Tenant ${slug}` });
  return h.contexts.forTenantId(tenant.id);
}

const now = new Date('2026-09-28T09:00:00.000Z');

export function person(tenantId: TenantId, id: string, over: Partial<PersonInput> = {}) {
  return PersonSchema.parse({
    id,
    tenantId,
    primaryEmail: `${id.slice(-4)}@school.example`,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

export function company(tenantId: TenantId, id: string, over: Partial<CompanyInput> = {}) {
  return CompanySchema.parse({
    id,
    tenantId,
    name: `Company ${id.slice(-4)}`,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}
