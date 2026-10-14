import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AVAILABLE_REGISTRY_KINDS,
  DATA_POLICY_ENTRY_KEY,
  DATA_POLICY_SCHEMA_VERSION,
  DataPolicyDocumentSchema,
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

export interface RegistryPublishInput {
  /** The version the document was edited from (0 for the first). */
  readonly expectedBaseVersion: number;
  /** The content hash printed by the dry run (Q11: what is published is what was reviewed). */
  readonly expectedContentHash: string;
  readonly document: unknown;
  readonly effectiveFrom?: Date;
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
  ) {}

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
      const parsed = this.parse(k, document);
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
    const parsed = this.parse(kind, input.document);
    if (!parsed.ok) {
      throw new GovernanceError('validation_failed', `Invalid ${kind} document`, {
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
      const violations = registryRuleViolations(
        previous.map((e) => ({ key: e.key, definition: e.definition as Record<string, unknown> })),
        parsed.value.entries,
      );
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
          effectiveFrom: input.effectiveFrom ?? new Date(),
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
            updatedAt: now,
          },
          update: {
            status: e.status ?? before?.status ?? 'active',
            definition: e.definition as TenantJsonInput,
            lastChangedIn: version,
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

  /** Validates a document of an available kind and derives its projected entries. */
  private parse(
    kind: RegistryKind,
    raw: unknown,
  ): { ok: true; value: ParsedDocument } | { ok: false; issues: string[] } {
    if (JSON.stringify(raw ?? null).length > REGISTRY_DOCUMENT_MAX_BYTES) {
      return { ok: false, issues: ['document_too_large'] };
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
