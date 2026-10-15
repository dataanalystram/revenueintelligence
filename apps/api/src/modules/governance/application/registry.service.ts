import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import {
  AVAILABLE_REGISTRY_KINDS,
  compareCanonicalVersion,
  DEFAULT_EXTENSION_GUARDRAILS,
  EXTENSION_DOCUMENT_SCHEMA_VERSION,
  EXTENSION_MIN_VERSION,
  EXTENSION_MODULE_KEY,
  EXTENSION_REFUSAL_CODES,
  extensionNarrowings,
  extensionRuleViolations,
  extensionTargetKind,
  isExtensionHistoryField,
  keysTighteningToRestricted,
  matchesJsonSchema,
  type ExtensionNarrowing,
  validateExtensionDocument,
  type ExtensionEntryDraft,
  type ExtensionGuardrails,
  DATA_POLICY_ENTRY_KEY,
  DATA_POLICY_SCHEMA_VERSION,
  DataPolicyDocumentSchema,
  jsonbTextBytes,
  REGISTRY_DOCUMENT_MAX_BYTES,
  REGISTRY_KINDS,
  registryContentHash,
  registryRuleViolations,
  type RegistryEntryDraft,
  type RegistryKind,
} from '../../domain';
import {
  adoptedCanonicalVersion,
  AuditFailures,
  AuditTrail,
  assertAuthorized,
  CLASSIFICATION_MANIFEST,
  forgetDataPolicy,
  tenantAdvisoryLock,
  tenantClient,
  TenantDatabase,
  WriteAuthorizer,
  type AuthorizedContext,
  type TenantContext,
  type TenantJsonInput,
  type TenantTransaction,
} from '../../tenancy';
import { valueHistoryColumn } from '../../domain';
import { GovernanceError } from '../errors';
import { ModuleGate } from './module-settings.service';

/** Page size of the X5 JSON-schema keyset scan (bounded memory per page). */
const X5_JSON_PAGE = 500;

export interface RegistryPublishInput {
  /** The version the document was edited from (0 for the first). */
  readonly expectedBaseVersion: number;
  /** The content hash printed by the dry run (Q11: what is published is what was reviewed). */
  readonly expectedContentHash: string;
  readonly document: unknown;
  // M10A2 review m9: no `effectiveFrom` — a policy is effective from its publication.
}

export interface RegistryDryRun {
  readonly kind: RegistryKind;
  readonly available: boolean;
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly contentHash: string | null;
  readonly currentVersion: number;
  readonly canonicalVersionMin: string;
}

export interface RegistryPublished {
  readonly kind: RegistryKind;
  readonly version: number;
  readonly contentHash: string;
  readonly canonicalVersionMin: string;
  readonly entries: number;
}

interface ParsedDocument {
  readonly document: Record<string, unknown>;
  readonly schemaVersion: number;
  readonly entries: readonly RegistryEntryDraft[];
}

/**
 * Governed versioned registries (M10A2 plan §5, §6). One generic, immutable
 * version store plus a projection of current entries. Only `data_policy` has
 * a document schema in M10A2 (Q8); it is published with its own capability
 * (Q9). Every publication checks the base version, the reviewed content hash,
 * the generic cross-version rules (R-K, R-X1, R-X3, R-X4) and refuses
 * secret-like values; version, projection and audit event commit together.
 */
@Injectable()
export class RegistryService {
  constructor(
    private readonly db: TenantDatabase,
    readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
    @Optional() private readonly moduleGate?: ModuleGate,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
  ) {}

  /** M10D (plan §2.7): the extension guardrails from configuration, else the E4 defaults. */
  get extensionGuardrails(): ExtensionGuardrails {
    return (
      (this.config as Partial<AppConfig> | undefined)?.canonical?.extension ??
      DEFAULT_EXTENSION_GUARDRAILS
    );
  }

  /** Read-only: validation result and the content hash to confirm with `--expected-hash`. */
  async dryRun(ctx: TenantContext, kind: string, document: unknown): Promise<RegistryDryRun> {
    const k = this.kind(kind);
    return this.db.transaction(ctx, async (tx) => {
      const current = await this.currentVersion(tx, k);
      const canonicalVersionMin = await adoptedCanonicalVersion(tx);
      if (!AVAILABLE_REGISTRY_KINDS.includes(k)) {
        return {
          kind: k,
          available: false,
          valid: false,
          issues: ['registry_kind_not_available'],
          contentHash: null,
          currentVersion: current,
          canonicalVersionMin,
        };
      }
      const gate = k === 'extension' ? await this.extensionGateIssues(tx, canonicalVersionMin) : [];
      const parsed = this.parse(k, document);
      if (gate.length > 0) {
        return {
          kind: k,
          available: true,
          valid: false,
          issues: [...gate, ...(parsed.ok ? [] : parsed.issues)],
          contentHash: null,
          currentVersion: current,
          canonicalVersionMin,
        };
      }
      return {
        kind: k,
        available: true,
        valid: parsed.ok,
        issues: parsed.ok ? [] : parsed.issues,
        contentHash: parsed.ok ? registryContentHash(parsed.value.document) : null,
        currentVersion: current,
        canonicalVersionMin,
      };
    });
  }

  @AuditFailures('data_policy.publish', 'data_policy')
  async publishDataPolicy(
    actx: AuthorizedContext<'config.data_policy.publish'>,
    input: RegistryPublishInput,
  ): Promise<RegistryPublished> {
    assertAuthorized(actx, 'config.data_policy.publish');
    return this.publishKind(actx, 'data_policy', input, 'data_policy.publish');
  }

  /** Every kind except `data_policy`; none has a document schema before its sub-milestone. */
  @AuditFailures('registry.publish', 'registry')
  async publish(
    actx: AuthorizedContext<'config.registry.publish'>,
    kind: string,
    input: RegistryPublishInput,
  ): Promise<RegistryPublished> {
    assertAuthorized(actx, 'config.registry.publish');
    const k = this.kind(kind);
    if (k === 'data_policy') {
      throw new GovernanceError(
        'capability_not_granted',
        'A data policy is published with config.data_policy.publish',
      );
    }
    return this.publishKind(actx, k, input, 'registry.publish');
  }

  async show(ctx: TenantContext, kind: string) {
    const k = this.kind(kind);
    return this.db.transaction(ctx, async (tx) => {
      const db = tenantClient(tx);
      const latest = await db.tenantRegistryVersion.findFirst({
        where: { kind: k },
        orderBy: { version: 'desc' },
        select: {
          version: true,
          contentHash: true,
          document: true,
          canonicalVersionMin: true,
          publishedAt: true,
        },
      });
      const entries = await db.tenantRegistryEntry.findMany({
        where: { kind: k },
        orderBy: { key: 'asc' },
        select: { key: true, status: true, introducedIn: true, lastChangedIn: true },
      });
      return { kind: k, latest, entries };
    });
  }

  private async publishKind(
    actx: AuthorizedContext<'config.data_policy.publish' | 'config.registry.publish'>,
    kind: RegistryKind,
    input: RegistryPublishInput,
    action: 'data_policy.publish' | 'registry.publish',
  ): Promise<RegistryPublished> {
    const targetKind = kind === 'data_policy' ? ('data_policy' as const) : ('registry' as const);
    const entry = { action, targetKind, targetRef: kind };
    if (!Number.isInteger(input.expectedBaseVersion) || input.expectedBaseVersion < 0) {
      throw new GovernanceError('stale_base_version', 'expectedBaseVersion is required');
    }
    if (!AVAILABLE_REGISTRY_KINDS.includes(kind)) {
      throw new GovernanceError(
        'registry_kind_not_available',
        `Registry kind ${kind} has no document schema yet`,
      );
    }
    // A1 for configuration: secret-like values are refused (audited denied) before anything.
    await this.authorizer.refuseSecretLike(actx, entry, { document: input.document });
    // M10D (Q18): an extension document needs canonical 0.4 and the module enabled.
    if (kind === 'extension') {
      await this.db.transaction(actx.tenant, (tx) => this.requireExtensionGate(tx, actx));
    }
    const parsed = this.parse(kind, input.document);
    if (!parsed.ok) {
      // M10D (plan §16): the control refusals carry their own reason code.
      const refusal = EXTENSION_REFUSAL_CODES.find((c) =>
        parsed.issues.some((i) => i.endsWith(`: ${c}`)),
      );
      throw new GovernanceError(refusal ?? 'validation_failed', `Invalid ${kind} document`, {
        issues: parsed.issues.length,
      });
    }
    const contentHash = registryContentHash(parsed.value.document);
    if (input.expectedContentHash !== contentHash) {
      throw new GovernanceError(
        'expected_hash_mismatch',
        'The document differs from the one the dry run hashed',
      );
    }
    return this.db.transaction(actx.tenant, async (tx) => {
      await tenantAdvisoryLock(tx, 'registry', kind);
      if (kind === 'extension') await this.requireExtensionGate(tx, actx);
      const db = tenantClient(tx);
      const latest = await db.tenantRegistryVersion.findFirst({
        where: { kind },
        orderBy: { version: 'desc' },
        select: { version: true, contentHash: true },
      });
      const current = latest?.version ?? 0;
      if (input.expectedBaseVersion !== current) {
        throw new GovernanceError(
          'stale_base_version',
          `Registry ${kind} is at version ${current}, not ${input.expectedBaseVersion}`,
        );
      }
      if (latest?.contentHash === contentHash) {
        throw new GovernanceError('no_change', `Registry ${kind} already holds this document`);
      }
      const previous = await db.tenantRegistryEntry.findMany({ where: { kind } });
      const violations: { rule: string; key: string }[] = registryRuleViolations(
        previous.map((e) => ({ key: e.key, definition: e.definition as Record<string, unknown> })),
        parsed.value.entries,
      );
      if (kind === 'data_policy') {
        violations.push(...(await this.extensionAllowViolations(tx, parsed.value.document)));
      }
      if (kind === 'extension') {
        await this.checkExtensionRules(
          tx,
          previous,
          parsed.value.entries as ExtensionEntryDraft[],
          violations,
        );
      }
      if (violations.length > 0) {
        throw new GovernanceError(
          'registry_rule_violation',
          `Registry rule ${violations[0]!.rule}`,
          {
            rule: violations[0]!.rule,
            key: violations[0]!.key,
          },
        );
      }
      const version = current + 1;
      // Validated against (and never above) the tenant's adopted version.
      const canonicalVersionMin = await adoptedCanonicalVersion(tx);
      const auditEventId = await this.audit.recordReturningId(tx, actx, {
        ...entry,
        details: {
          version,
          baseVersion: current,
          contentHash,
          entries: parsed.value.entries.length,
        },
      });
      await db.tenantRegistryVersion.create({
        data: {
          tenantId: tx.tenantId,
          kind,
          version,
          baseVersion: current,
          document: parsed.value.document as TenantJsonInput,
          documentSchemaVersion: parsed.value.schemaVersion,
          contentHash,
          canonicalVersionMin,
          // M10A2 review m9: effective from publication; callers cannot backdate or schedule it.
          effectiveFrom: new Date(),
          actorKind: actx.actor.kind,
          actorId: actx.actor.id,
          actorAssurance: actx.actor.assurance,
          correlationId: actx.correlationId,
          auditEventId,
        },
      });
      const now = new Date();
      for (const e of parsed.value.entries) {
        const before = previous.find((p) => p.key === e.key);
        const changed =
          !before || registryContentHash(before.definition) !== registryContentHash(e.definition);
        if (before && !changed) continue;
        await db.tenantRegistryEntry.upsert({
          where: { tenantId_kind_key: { tenantId: tx.tenantId, kind, key: e.key } },
          create: {
            tenantId: tx.tenantId,
            id: randomUUID(),
            kind,
            key: e.key,
            status: e.status ?? 'active',
            definition: e.definition as TenantJsonInput,
            introducedIn: version,
            lastChangedIn: version,
            // M10D (control 8): extension definitions project their classification.
            sensitivity: e.sensitivity ?? null,
            categories: e.categories ? [...e.categories] : undefined,
            updatedAt: now,
          },
          update: {
            status: e.status ?? before?.status ?? 'active',
            definition: e.definition as TenantJsonInput,
            lastChangedIn: version,
            ...(e.sensitivity !== undefined
              ? { sensitivity: e.sensitivity, categories: [...(e.categories ?? [])] }
              : {}),
            updatedAt: now,
          },
        });
      }
      if (kind === 'data_policy') forgetDataPolicy(tx);
      return {
        kind,
        version,
        contentHash,
        canonicalVersionMin,
        entries: parsed.value.entries.length,
      };
    });
  }

  private kind(kind: string): RegistryKind {
    if (!(REGISTRY_KINDS as readonly string[]).includes(kind)) {
      throw new GovernanceError('validation_failed', `Unknown registry kind ${kind}`);
    }
    return kind as RegistryKind;
  }

  private async currentVersion(tx: TenantTransaction, kind: RegistryKind): Promise<number> {
    const latest = await tenantClient(tx).tenantRegistryVersion.findFirst({
      where: { kind },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return latest?.version ?? 0;
  }

  /** M10D (Q18): adopted canonical >= 0.4 and module `extension` enabled; refusals audited. */
  private async requireExtensionGate(
    tx: TenantTransaction,
    actx: AuthorizedContext<'config.data_policy.publish' | 'config.registry.publish'>,
  ): Promise<void> {
    const adopted = await adoptedCanonicalVersion(tx);
    if (compareCanonicalVersion(adopted, EXTENSION_MIN_VERSION) < 0) {
      throw new GovernanceError(
        'canonical_version_too_low',
        `Extension definitions need canonical ${EXTENSION_MIN_VERSION} (adopted ${adopted})`,
      );
    }
    if (this.moduleGate) {
      await this.moduleGate.require(tx, actx, EXTENSION_MODULE_KEY);
      return;
    }
    // Without the gate service (unit wiring), the setting is still checked.
    if (!(await this.extensionModuleEnabled(tx))) {
      throw new GovernanceError('module_disabled', 'Module extension is disabled for this tenant');
    }
  }

  private async extensionModuleEnabled(tx: TenantTransaction): Promise<boolean> {
    const setting = await tenantClient(tx).tenantModuleSetting.findUnique({
      where: { tenantId_moduleKey: { tenantId: tx.tenantId, moduleKey: EXTENSION_MODULE_KEY } },
      select: { enabled: true },
    });
    return setting?.enabled === true;
  }

  /** The dry run reports the gate as issues (nothing audited, nothing written). */
  private async extensionGateIssues(tx: TenantTransaction, adopted: string): Promise<string[]> {
    const issues: string[] = [];
    if (compareCanonicalVersion(adopted, EXTENSION_MIN_VERSION) < 0) {
      issues.push('canonical_version_too_low');
    }
    if (!(await this.extensionModuleEnabled(tx))) issues.push('module_disabled');
    return issues;
  }

  /**
   * M10D (plan §2.5): X2, X4 on relationship ends and R-X6 against the stored
   * projection; a key tightened to `restricted` is refused while stored data of
   * that definition exists (Q10), probed with bounded EXISTS queries.
   */
  private async checkExtensionRules(
    tx: TenantTransaction,
    previous: readonly {
      id: string;
      key: string;
      definition: unknown;
      sensitivity: string | null;
      categories: string[];
    }[],
    next: readonly ExtensionEntryDraft[],
    violations: { rule: string; key: string }[],
  ): Promise<void> {
    const stored = previous.map((p) => ({
      key: p.key,
      definition: p.definition as Record<string, unknown>,
      sensitivity: p.sensitivity,
      categories: p.sensitivity === null ? null : p.categories,
    }));
    violations.push(...extensionRuleViolations(stored, next));
    // X5: a narrowed constraint is refused while a stored value violates it.
    const idByKey = new Map(previous.map((p) => [p.key, p.id]));
    for (const n of extensionNarrowings(stored, next)) {
      const id = idByKey.get(n.key);
      if (id && (await this.narrowingViolated(tx, id, n))) {
        violations.push({ rule: 'R-X5', key: n.key });
      }
    }
    const tightened = keysTighteningToRestricted(stored, next);
    if (tightened.length === 0) return;
    const ids = previous.filter((p) => tightened.includes(p.key));
    const db = tenantClient(tx);
    for (const p of ids) {
      const rows = await db.$queryRawUnsafe<{ present: boolean }[]>(
        `SELECT (EXISTS (SELECT 1 FROM tenant_extension_values
                          WHERE tenant_id = $1::uuid AND field_id = $2::uuid AND value_state = 'present')
              OR EXISTS (SELECT 1 FROM tenant_custom_records WHERE tenant_id = $1::uuid AND object_id = $2::uuid)
              OR EXISTS (SELECT 1 FROM tenant_custom_relationships WHERE tenant_id = $1::uuid AND rel_def_id = $2::uuid)
               ) AS present`,
        tx.tenantId,
        p.id,
      );
      if (rows[0]?.present) violations.push({ rule: 'R-X6', key: p.key });
    }
  }

  /**
   * M10D (Q23): each `ext:<key>` value-history allow entry of a data policy
   * names a current extension field of that target kind that records value
   * history; anything else refuses the publish (`R-DP-EXT`, entry key only).
   */
  private async extensionAllowViolations(
    tx: TenantTransaction,
    document: Record<string, unknown>,
  ): Promise<{ rule: string; key: string }[]> {
    const parsed = DataPolicyDocumentSchema.safeParse(document);
    if (!parsed.success) return [];
    const ext = parsed.data.value_history.allow.filter((a) =>
      isExtensionHistoryField(a.entity_kind, a.field),
    );
    if (ext.length === 0) return [];
    const keys = ext.map((a) => a.field.slice('ext:'.length));
    const entries = await tenantClient(tx).tenantRegistryEntry.findMany({
      where: { kind: 'extension', key: { in: keys } },
      select: { key: true, definition: true },
    });
    const byKey = new Map(entries.map((e) => [e.key, e.definition as Record<string, unknown>]));
    const out: { rule: string; key: string }[] = [];
    for (const a of ext) {
      const def = byKey.get(a.field.slice('ext:'.length));
      const target = typeof def?.target === 'string' ? def.target : '';
      if (
        !def ||
        def.kind !== 'field' ||
        def.history !== 'value_history' ||
        extensionTargetKind(target) !== a.entity_kind
      ) {
        out.push({ rule: 'R-DP-EXT', key: `${a.entity_kind}.${a.field}` });
      }
    }
    return out;
  }

  /**
   * X5 probe (plan §2.5, §17): one bounded EXISTS query on the typed columns /
   * the items table; a JSON schema change is checked by a keyset scan in
   * bounded pages that stops at the first violating value.
   */
  private async narrowingViolated(
    tx: TenantTransaction,
    id: string,
    n: ExtensionNarrowing,
  ): Promise<boolean> {
    const db = tenantClient(tx);
    const present = `FROM tenant_extension_values v
                      WHERE v.tenant_id = $1::uuid AND v.field_id = $2::uuid AND v.value_state = 'present'`;
    const items = `FROM tenant_extension_values v
                     JOIN tenant_extension_value_items i ON i.tenant_id = v.tenant_id AND i.value_id = v.id
                    WHERE v.tenant_id = $1::uuid AND v.field_id = $2::uuid AND v.value_state = 'present'`;
    const exists = async (sql: string, ...params: unknown[]): Promise<boolean> => {
      const rows = await db.$queryRawUnsafe<{ present: boolean }[]>(
        `SELECT EXISTS (${sql}) AS present`,
        tx.tenantId,
        id,
        ...params,
      );
      return rows[0]?.present === true;
    };
    switch (n.check) {
      case 'max_length':
        return (
          (await exists(`SELECT 1 ${present} AND char_length(v.value_text) > $3::int`, n.limit)) ||
          (await exists(`SELECT 1 ${items} AND char_length(i.item_text) > $3::int`, n.limit))
        );
      case 'min':
      case 'max': {
        const op = n.check === 'min' ? '<' : '>';
        return (
          (await exists(
            `SELECT 1 ${present} AND (v.value_number ${op} $3::numeric OR v.value_money_minor ${op} $3::numeric)`,
            String(n.limit),
          )) ||
          (await exists(`SELECT 1 ${items} AND i.item_number ${op} $3::numeric`, String(n.limit)))
        );
      }
      case 'currency':
        return exists(
          `SELECT 1 ${present} AND v.value_currency IS DISTINCT FROM $3::text`,
          n.currency,
        );
      case 'max_items':
        return exists(`SELECT 1 ${present} AND v.value_item_count > $3::int`, n.limit);
      case 'enum_codes':
        return (
          (await exists(`SELECT 1 ${present} AND v.value_enum = ANY($3::text[])`, [...n.codes])) ||
          (await exists(`SELECT 1 ${items} AND i.item_enum = ANY($3::text[])`, [...n.codes]))
        );
      case 'reference_to':
        return exists(
          `SELECT 1 ${present}
              AND (v.value_ref_kind <> ALL($3::text[])
                   OR (v.value_ref_kind = 'custom_record' AND NOT EXISTS (
                         SELECT 1 FROM tenant_custom_records r
                           JOIN tenant_registry_entries e
                             ON e.tenant_id = r.tenant_id AND e.kind = r.object_registry_kind AND e.id = r.object_id
                          WHERE r.tenant_id = v.tenant_id AND r.id = v.value_ref_id
                            AND e.key = ANY($4::text[]))))`,
          [...n.kinds],
          [...n.objectKeys],
        );
      case 'cardinality': {
        const end = (side: 'from' | 'to'): string =>
          `SELECT 1 FROM tenant_custom_relationships c
            WHERE c.tenant_id = $1::uuid AND c.rel_def_id = $2::uuid AND c.state = 'active'
            GROUP BY c.${side}_kind, c.${side}_id, c.${side}_key HAVING count(*) > 1`;
        if (await exists(end('from'))) return true;
        return n.cardinality === 'one_to_one' ? exists(end('to')) : false;
      }
      case 'json_schema': {
        let after = '00000000-0000-0000-0000-000000000000';
        for (;;) {
          const page = await db.$queryRawUnsafe<{ id: string; value_json: unknown }[]>(
            `SELECT v.id::text AS id, v.value_json ${present} AND v.value_json IS NOT NULL
                AND v.id > $3::uuid ORDER BY v.id LIMIT ${X5_JSON_PAGE}`,
            tx.tenantId,
            id,
            after,
          );
          if (page.some((r) => !matchesJsonSchema(n.schema, r.value_json))) return true;
          if (page.length < X5_JSON_PAGE) return false;
          after = page[page.length - 1]!.id;
        }
      }
    }
  }

  /** Validates a document of an available kind and derives its projected entries. */
  private parse(
    kind: RegistryKind,
    raw: unknown,
  ): { ok: true; value: ParsedDocument } | { ok: false; issues: string[] } {
    const maxBytes =
      kind === 'extension'
        ? this.extensionGuardrails.registryMaxBytes
        : REGISTRY_DOCUMENT_MAX_BYTES;
    if (jsonbTextBytes(raw ?? null) > maxBytes) {
      return {
        ok: false,
        issues: [
          kind === 'extension' ? '(document): extension_guardrail_exceeded' : 'document_too_large',
        ],
      };
    }
    if (kind === 'extension') {
      const v = validateExtensionDocument(raw, this.extensionGuardrails);
      if (!v.ok) return { ok: false, issues: v.issues.map((i) => `${i.key}: ${i.code}`) };
      return {
        ok: true,
        value: {
          document: v.document,
          schemaVersion: EXTENSION_DOCUMENT_SCHEMA_VERSION,
          entries: v.entries,
        },
      };
    }
    if (kind !== 'data_policy') return { ok: false, issues: ['registry_kind_not_available'] };
    const parsed = DataPolicyDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
      };
    }
    // Each allowed field must be a value-history field present in the classification manifest.
    const missing = parsed.data.value_history.allow.filter((a) => {
      // `ext:<key>` entries are checked against the current extension registry at publish (Q23).
      if (isExtensionHistoryField(a.entity_kind, a.field)) return false;
      const column = valueHistoryColumn(a.entity_kind, a.field);
      return !column || !CLASSIFICATION_MANIFEST[column.table]?.[column.column];
    });
    if (missing.length > 0) {
      return { ok: false, issues: missing.map((m) => `${m.entity_kind}.${m.field}: unclassified`) };
    }
    const document = parsed.data as unknown as Record<string, unknown>;
    return {
      ok: true,
      value: {
        document,
        schemaVersion: DATA_POLICY_SCHEMA_VERSION,
        // A data policy is a singleton document: one projected entry.
        entries: [{ key: DATA_POLICY_ENTRY_KEY, definition: document }],
      },
    };
  }
}
