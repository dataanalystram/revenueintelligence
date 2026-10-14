import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  canonicalHash,
  decideModuleChange,
  jsonbTextBytes,
  MODULE_CONFIG_MAX_BYTES,
  MODULE_KEYS,
  type ModuleKey,
} from '../../domain';
import {
  adoptedCanonicalVersion,
  AuditFailures,
  AuditTrail,
  assertAuthorized,
  SecurityEventsService,
  tenantAdvisoryLock,
  tenantClient,
  TenantDatabase,
  WriteAuthorizer,
  type AuthorizedContext,
  type TenantContext,
  type TenantJsonInput,
  type TenantTransaction,
} from '../../tenancy';
import { GovernanceError, ModuleDisabledError } from '../errors';

/**
 * Per-module configuration (M10A2 plan §4): until a module registers its own
 * schema, a flat object of identifiers, codes, numbers and booleans, ≤ 4 KB.
 * Secret-like values are refused before anything is written.
 */
export const ModuleConfigSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((c) => jsonbTextBytes(c) <= MODULE_CONFIG_MAX_BYTES, 'module config exceeds 4 KB');

export interface ModuleState {
  readonly module: ModuleKey;
  readonly title: string;
  readonly available: boolean;
  readonly minimumCanonicalVersion: string | null;
  readonly dependsOn: readonly string[];
  readonly enabled: boolean;
  readonly version: number;
}

export interface ModuleChangeInput {
  readonly module: string;
  /** The setting version the change was made from (0 when the tenant has none yet). */
  readonly expectedVersion: number;
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * Module enablement (M10 plan §17, D5, F4). Separate from canonical adoption:
 * a change never touches the adoption chain. Each change writes the current
 * setting, one setting event and one audit event in one transaction; disable
 * never deletes data.
 */
@Injectable()
export class ModuleSettingsService {
  constructor(
    private readonly db: TenantDatabase,
    readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
  ) {}

  async list(ctx: TenantContext): Promise<ModuleState[]> {
    return this.db.transaction(ctx, (tx) => this.states(tx));
  }

  @AuditFailures('module.enable', 'module')
  async enable(actx: AuthorizedContext<'config.module.change'>, input: ModuleChangeInput) {
    assertAuthorized(actx, 'config.module.change');
    return this.change(actx, input, true, 'module.enable');
  }

  @AuditFailures('module.disable', 'module')
  async disable(actx: AuthorizedContext<'config.module.change'>, input: ModuleChangeInput) {
    assertAuthorized(actx, 'config.module.change');
    return this.change(actx, input, false, 'module.disable');
  }

  /** Changes the configuration of an enabled module (its enabled state stays). */
  @AuditFailures('module.configure', 'module')
  async configure(
    actx: AuthorizedContext<'config.module.change'>,
    input: ModuleChangeInput & { readonly config: Readonly<Record<string, unknown>> },
  ) {
    assertAuthorized(actx, 'config.module.change');
    return this.change(actx, input, undefined, 'module.configure');
  }

  private async change(
    actx: AuthorizedContext<'config.module.change'>,
    input: ModuleChangeInput,
    targetEnabled: boolean | undefined,
    action: 'module.enable' | 'module.disable' | 'module.configure',
  ): Promise<ModuleState> {
    if (!(MODULE_KEYS as readonly string[]).includes(input.module)) {
      throw new GovernanceError('validation_failed', `Unknown module ${input.module}`);
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new GovernanceError('stale_base_version', 'expectedVersion is required');
    }
    const entry = { action, targetKind: 'module' as const, targetRef: input.module };
    if (input.config !== undefined) {
      await this.authorizer.refuseSecretLike(actx, entry, { config: input.config });
    }
    const config = input.config === undefined ? undefined : ModuleConfigSchema.parse(input.config);
    return this.db.transaction(actx.tenant, async (tx) => {
      // Dependency checks read several modules: one change per tenant at a time.
      await tenantAdvisoryLock(tx, 'module-settings', 'all');
      const db = tenantClient(tx);
      const catalogue = await db.canonicalModule.findMany();
      const module = catalogue.find((m) => m.moduleKey === input.module)!;
      const settings = await db.tenantModuleSetting.findMany();
      const current = settings.find((s) => s.moduleKey === input.module);
      const enabled = new Set(settings.filter((s) => s.enabled).map((s) => s.moduleKey));
      const wasEnabled = current?.enabled ?? false;
      const nextEnabled = targetEnabled ?? wasEnabled;
      const fromHash = current ? canonicalHash(current.config) : null;
      const nextConfig = config ?? (current?.config as Record<string, unknown>) ?? {};
      const toHash = canonicalHash(nextConfig);
      const decision = decideModuleChange({
        module: {
          key: module.moduleKey as ModuleKey,
          available: module.available,
          minimumCanonicalVersion: module.minimumCanonicalVersion,
          dependsOn: (module.dependsOn ?? []) as ModuleKey[],
        },
        catalogue: catalogue.map((m) => ({
          key: m.moduleKey as ModuleKey,
          dependsOn: (m.dependsOn ?? []) as ModuleKey[],
        })),
        enabled,
        adoptedVersion: await adoptedCanonicalVersion(tx),
        currentVersion: current?.version ?? 0,
        expectedVersion: input.expectedVersion,
        targetEnabled: nextEnabled,
        configChanged: fromHash !== toHash,
      });
      if (!decision.ok) {
        throw new GovernanceError(decision.code, `Module change refused (${decision.code})`, {
          module: input.module,
          ...(decision.module ? { requires: decision.module } : {}),
        });
      }
      if (targetEnabled === undefined && !wasEnabled) {
        throw new GovernanceError('module_disabled', 'Only an enabled module can be configured');
      }
      const version = (current?.version ?? 0) + 1;
      const now = new Date();
      const actor = actx.actor;
      await db.tenantModuleSetting.upsert({
        where: { tenantId_moduleKey: { tenantId: tx.tenantId, moduleKey: input.module } },
        create: {
          tenantId: tx.tenantId,
          moduleKey: input.module,
          enabled: nextEnabled,
          config: nextConfig as TenantJsonInput,
          version,
          updatedAt: now,
          updatedByKind: actor.kind,
          updatedById: actor.id,
          updatedByAssurance: actor.assurance,
        },
        update: {
          enabled: nextEnabled,
          config: nextConfig as TenantJsonInput,
          version,
          updatedAt: now,
          updatedByKind: actor.kind,
          updatedById: actor.id,
          updatedByAssurance: actor.assurance,
        },
      });
      const auditEventId = await this.audit.recordReturningId(tx, actx, {
        ...entry,
        details: {
          version,
          baseVersion: input.expectedVersion,
          enabled: nextEnabled,
          configHash: toHash,
        },
      });
      const seq =
        (await db.tenantModuleSettingEvent.count({ where: { moduleKey: input.module } })) + 1;
      await db.tenantModuleSettingEvent.create({
        data: {
          tenantId: tx.tenantId,
          id: randomUUID(),
          seq,
          moduleKey: input.module,
          fromEnabled: current ? wasEnabled : null,
          toEnabled: nextEnabled,
          fromConfigHash: fromHash,
          toConfigHash: toHash,
          baseVersion: input.expectedVersion,
          actorKind: actor.kind,
          actorId: actor.id,
          actorAssurance: actor.assurance,
          auditEventId,
        },
      });
      return (await this.states(tx)).find((s) => s.module === input.module)!;
    });
  }

  private async states(tx: TenantTransaction): Promise<ModuleState[]> {
    const db = tenantClient(tx);
    const catalogue = await db.canonicalModule.findMany();
    const settings = await db.tenantModuleSetting.findMany();
    return MODULE_KEYS.map((key) => {
      const m = catalogue.find((c) => c.moduleKey === key)!;
      const s = settings.find((x) => x.moduleKey === key);
      return {
        module: key,
        title: m.title,
        available: m.available,
        minimumCanonicalVersion: m.minimumCanonicalVersion,
        dependsOn: m.dependsOn ?? [],
        enabled: s?.enabled ?? false,
        version: s?.version ?? 0,
      };
    });
  }
}

/**
 * The gate later writers call before writing module data (M10A2 plan §4): a
 * disabled module refuses the write with `module_disabled`, recorded as a
 * `denied` audit event (in its own transaction, so it survives the refusal)
 * and as the security event `module_disabled_write_refused`. First real
 * caller: M10D/M10E.
 */
@Injectable()
export class ModuleGate {
  constructor(
    private readonly audit: AuditTrail,
    private readonly events: SecurityEventsService,
  ) {}

  async require(
    tx: TenantTransaction,
    actx: AuthorizedContext,
    moduleKey: ModuleKey,
  ): Promise<void> {
    const setting = await tenantClient(tx).tenantModuleSetting.findUnique({
      where: { tenantId_moduleKey: { tenantId: tx.tenantId, moduleKey } },
      select: { enabled: true },
    });
    if (setting?.enabled) return;
    this.events.emit({
      event: 'module_disabled_write_refused',
      outcome: 'refused',
      tenant: actx.tenant.tenantSlug,
      actorKind: actx.actor.kind,
      capability: actx.capability,
      reasonCode: 'module_disabled',
      correlationId: actx.correlationId,
      coordinates: { module: moduleKey },
    });
    await this.audit.recordDenied(actx.tenant, {
      actor: actx.actor,
      capability: actx.capability,
      reason: 'module_disabled',
      correlationId: actx.correlationId,
      action: 'operation.denied',
      targetKind: 'module',
      targetRef: moduleKey,
    });
    throw new ModuleDisabledError(moduleKey);
  }
}
