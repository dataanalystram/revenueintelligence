import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../../../platform/metrics';
import {
  ACCOUNT_CONTEXT_MIN_VERSION,
  ACCOUNT_CONTEXT_MODULE_KEY,
  CANONICAL_MODULES,
  parseStoredContextType,
  CONTEXT_REF_TARGET,
  type AccountContextMappingContext,
  type AccountContextMappingType,
  canonicalHash,
  captureDraft,
  compareCanonicalVersion,
  disabledModuleTargets,
  EXTENSION_CUSTOM_OBJECT_PREFIX,
  EXTENSION_MIN_VERSION,
  EXTENSION_MODULE_KEY,
  findSourceField,
  isCustomObjectEntity,
  isSensitiveName,
  profiledSensitivity,
  type CaptureDraftEntry,
  type CaptureSource,
  type ExtensionMappingContext,
  type ExtensionMappingDefinition,
  MAPPING_RETIRE_REASONS,
  type MappingRetireReason,
  MappingDocumentSchema,
  MappingDraftValidationStampSchema,
  mappingMinCanonicalVersion,
  PROFILE_FRESHNESS,
  SourceProfileSettingsSchema,
  SourceSchemaSchema,
  UNASSIGNED_AUTHORITY,
  validateMapping,
  type Acknowledgement,
  type MappingDocument,
  type MappingIssue,
  type MappingValidation,
} from '../../domain';
import {
  adoptedCanonicalVersion,
  assertAuthorized,
  AuditTrail,
  moduleSettings,
  WriteAuthorizer,
  tenantAdvisoryLock,
  TenantDatabase,
  tenantClient,
  type AuthorizedContext,
  type TenantContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  ConcurrentSourcePublishError,
  ConnectionNotFoundError,
  MappingInvalidError,
  PublishBaseVersionRequiredError,
  SourcesError,
} from '../errors';
import { ProfilesRepository } from '../infrastructure/profiles.repository';
import { SourcesRepository, type StoredMappingVersion } from '../infrastructure/sources.repository';
import { AuditFailures } from '../../tenancy';

export interface PublishMappingOptions {
  /** The version the document was edited from: required (0 for the first). */
  readonly expectedBaseVersion: number;
  /** The snapshot the operator validated against; stale when not the latest. */
  readonly validatedAgainst?: string;
  /** Acknowledged findings of the covering profiles (M9A §7.4). */
  readonly acknowledgements?: readonly Acknowledgement[];
  /** Emergency profile override (D5): disabled in M9A, always refused (decision A1). */
  readonly profileOverride?: { readonly reason: string };
  /** M10A2 drafts: the validated content hash; a different document is refused. */
  readonly expectedContentHash?: string;
}

/** M10A2: a mapping working copy (draft | validated). */
export interface MappingDraftView {
  readonly connectionId: string;
  readonly state: 'draft' | 'validated';
  readonly version: number;
  readonly contentHash: string;
  readonly validatedSnapshotHash: string | null;
  readonly validatedAuthorityVersion: number | null;
  readonly validatedCanonicalVersion: string | null;
  readonly validation: unknown;
}

export interface ValidateMappingOptions {
  readonly validatedAgainst?: string;
  readonly acknowledgements?: readonly Acknowledgement[];
  readonly profileOverride?: { readonly reason: string };
  readonly actor?: string;
}

export interface MappingValidationReport {
  readonly ok: boolean;
  readonly snapshotHash: string;
  readonly authorityVersion: number;
  readonly contentHash?: string;
  readonly errors: readonly MappingIssue[];
  readonly warnings: readonly MappingIssue[];
  /** The profiles that cover the consequential entries (M9A). */
  readonly coveringProfileIds: readonly string[];
}

export interface PublishedMapping {
  readonly version: number;
  readonly contentHash: string;
  readonly snapshotHash: string;
  readonly authorityVersion: number;
  readonly warnings: readonly MappingIssue[];
  readonly coveringProfileIds: readonly string[];
  readonly acknowledgements: number;
}

const ACTOR = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** Versioned, immutable source mappings (ADR 0020 §1–5, §11). */
@Injectable()
export class SourceMappingsService {
  private readonly logger = new Logger('SourceMappings');

  constructor(
    private readonly db: TenantDatabase,
    private readonly repo: SourcesRepository,
    private readonly profiles: ProfilesRepository,
    private readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  /** Validates a candidate against the latest snapshot and the current authority. */
  async validate(
    ctx: TenantContext,
    connectionId: string,
    raw: unknown,
    options: ValidateMappingOptions = {},
  ): Promise<MappingValidationReport> {
    const report = await this.db.transaction(ctx, async (tx) => {
      const { report } = await this.check(tx, connectionId, raw, options);
      return report;
    });
    this.auditOverride(ctx, connectionId, options, options.actor ?? 'cli');
    return report;
  }

  /**
   * Publishes a new immutable version. `expectedBaseVersion` is required: a
   * stale base is refused (`concurrent_publish`), so an edit made from version
   * N can never silently replace a version N+1 published meanwhile.
   */
  @AuditFailures('mapping.publish', 'source_connection')
  async publish(
    actx: AuthorizedContext<'config.mapping.publish'>,
    connectionId: string,
    raw: unknown,
    options: PublishMappingOptions,
  ): Promise<PublishedMapping> {
    assertAuthorized(actx, 'config.mapping.publish');
    const ctx = actx.tenant;
    const actor = actx.actor.id;
    const base = (options as { expectedBaseVersion?: number }).expectedBaseVersion;
    if (base === undefined || !Number.isInteger(base) || base < 0) {
      throw new PublishBaseVersionRequiredError('a mapping');
    }
    if (!ACTOR.test(actor)) throw new SourcesError('invalid_actor', 'Invalid actor');
    // Plan §11: reasons and confirmations are stored free text.
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'mapping.publish', targetKind: 'source_connection', targetRef: connectionId },
      { mapping: raw, options },
    );
    // An override attempt is audited as refused before anything else happens.
    this.auditOverride(ctx, connectionId, options, actor);
    return this.db.transaction(ctx, async (tx) => {
      // One publication per connection at a time.
      await tenantAdvisoryLock(tx, 'source-mapping', connectionId);
      const latest = await this.repo.latestMapping(tx, connectionId);
      const latestVersion = latest?.version ?? 0;
      if (base !== latestVersion) {
        throw new ConcurrentSourcePublishError('The mapping', base, latestVersion);
      }
      const { report, validation } = await this.check(tx, connectionId, raw, options);
      if (!validation.ok) throw new MappingInvalidError(validation.errors);
      if (
        options.expectedContentHash !== undefined &&
        options.expectedContentHash !== validation.contentHash
      ) {
        throw new SourcesError('mapping_not_validated', 'The draft changed since it was validated');
      }
      if (report.authorityVersion === 0) {
        throw new SourcesError('authority_missing', 'The tenant has no authority version');
      }
      // M10A2 mapping hook: no entry may target an entity of a disabled module.
      await this.refuseDisabledModuleTargets(tx, validation.document);
      // M10C (plan §7): a mapping using a 0.3 target (account.parent,
      // person.affiliation) needs the tenant at canonical ≥ 0.3; it then records
      // canonical_version_min = the adopted version (≥ 0.3).
      const needs = mappingMinCanonicalVersion(validation.document);
      const adopted = await adoptedCanonicalVersion(tx);
      if (needs && compareCanonicalVersion(adopted, needs) < 0) {
        throw new SourcesError(
          'canonical_version_too_low',
          `This mapping uses targets of canonical ${needs}; the tenant adopted ${adopted}`,
        );
      }
      const previouslyPublished = await this.repo.publishedMapping(tx, connectionId);
      const stored = await this.repo.insertMapping(tx, {
        connectionId,
        canonicalVersionMin: await adoptedCanonicalVersion(tx),
        version: latestVersion + 1,
        baseVersion: latestVersion,
        document: validation.document,
        contentHash: validation.contentHash,
        schemaSnapshotHash: report.snapshotHash,
        authorityVersion: report.authorityVersion,
        validation: {
          warnings: Object.fromEntries(countBy(validation.warnings.map((w) => w.code))),
          // M9A (§7.1, §7.4): the evidence the publication relied on.
          coveringProfileIds: validation.coveringProfileIds,
          acknowledgements: validation.acknowledgements.map((a) => ({
            findingId: a.findingId,
            code: a.code,
            reasonCode: a.reasonCode,
            actor,
            at: new Date().toISOString(),
          })),
        },
        publishedBy: actor,
      });
      // Tech debt #83 (Q14, ADR 0030 addendum): the owner rows of the custom
      // objects this version sources, claimed in this transaction BEFORE the
      // audit event (sorted keys; the primary key refuses a second owner, also
      // one whose publication is still in flight), the others released.
      const owners = await this.claimCustomObjectOwners(
        tx,
        connectionId,
        stored.version,
        validation.document,
      );
      const auditEventId = await this.audit.recordReturningId(tx, actx, {
        action: 'mapping.publish',
        targetKind: 'mapping',
        targetRef: `${connectionId}/v${stored.version}`,
        details: {
          version: stored.version,
          baseVersion: latestVersion,
          contentHash: stored.contentHash,
          authorityVersion: stored.authorityVersion,
          acknowledgements: validation.acknowledgements.length,
          ...(previouslyPublished ? { supersedes: previouslyPublished.version } : {}),
          ...(owners.claimed.length > 0 ? { customObjectsClaimed: owners.claimed } : {}),
          ...(owners.released.length > 0 ? { customObjectsReleased: owners.released } : {}),
        },
      });
      // M10A2 lifecycle: the previous version is superseded, the new one published,
      // in this transaction under the per-connection lock, with one audit event.
      if (previouslyPublished) {
        await this.repo.appendLifecycle(tx, {
          connectionId,
          version: previouslyPublished.version,
          state: 'superseded',
          actor: actx.actor,
          auditEventId,
        });
      }
      await this.repo.appendLifecycle(tx, {
        connectionId,
        version: stored.version,
        state: 'published',
        actor: actx.actor,
        auditEventId,
      });
      return {
        version: stored.version,
        contentHash: stored.contentHash,
        snapshotHash: stored.schemaSnapshotHash,
        authorityVersion: stored.authorityVersion,
        warnings: validation.warnings,
        coveringProfileIds: validation.coveringProfileIds,
        acknowledgements: validation.acknowledgements.length,
      };
    });
  }

  /**
   * M10A2 plan §10: retires a published or superseded version. A connection
   * whose published version is retired has no published mapping: sync is
   * refused until a new version is published.
   */
  @AuditFailures('mapping.retire', 'mapping')
  async retire(
    actx: AuthorizedContext<'config.mapping.retire'>,
    connectionId: string,
    version: number,
    reason: MappingRetireReason,
  ): Promise<{ readonly version: number; readonly previousState: string }> {
    assertAuthorized(actx, 'config.mapping.retire');
    if (!(MAPPING_RETIRE_REASONS as readonly string[]).includes(reason)) {
      throw new SourcesError('invalid_reason', 'Unknown retire reason');
    }
    return this.db.transaction(actx.tenant, async (tx) => {
      await tenantAdvisoryLock(tx, 'source-mapping', connectionId);
      const state = (await this.repo.mappingStates(tx, connectionId)).find(
        (s) => s.version === version,
      );
      if (!state) throw new SourcesError('mapping_not_found', `No version ${version}`);
      if (state.state === 'retired') {
        throw new SourcesError('no_change', `Version ${version} is already retired`);
      }
      // Tech debt #83 (Q14): retiring the published version leaves the connection
      // with no published mapping, so it no longer owns any custom object.
      const released =
        state.state === 'published' ? await this.repo.releaseCustomObjects(tx, connectionId) : [];
      const auditEventId = await this.audit.recordReturningId(tx, actx, {
        action: 'mapping.retire',
        targetKind: 'mapping',
        targetRef: `${connectionId}/v${version}`,
        details: {
          version,
          from: state.state,
          reason,
          ...(released.length > 0 ? { customObjectsReleased: released } : {}),
        },
      });
      await this.repo.appendLifecycle(tx, {
        connectionId,
        version,
        state: 'retired',
        actor: actx.actor,
        reasonCode: reason,
        auditEventId,
      });
      return { version, previousState: state.state };
    });
  }

  // --- M10A2 drafts (plan §10): draft → validated → published ---------------

  /** Saves the working copy; any edit returns it to `draft` (database trigger). */
  @AuditFailures('mapping.draft.save', 'mapping_draft')
  async saveDraft(
    actx: AuthorizedContext<'config.mapping.draft'>,
    connectionId: string,
    raw: unknown,
    expectedVersion: number,
  ): Promise<MappingDraftView> {
    assertAuthorized(actx, 'config.mapping.draft');
    const entry = {
      action: 'mapping.draft.save' as const,
      targetKind: 'mapping_draft' as const,
      targetRef: connectionId,
    };
    await this.authorizer.refuseSecretLike(actx, entry, { mapping: raw });
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new SourcesError('invalid_mapping', 'A mapping draft is a JSON object');
    }
    return this.db.transaction(actx.tenant, async (tx) => {
      await tenantAdvisoryLock(tx, 'source-mapping-draft', connectionId);
      const connection = await this.repo.connection(tx, connectionId);
      if (!connection) throw new ConnectionNotFoundError(connectionId);
      const db = tenantClient(tx);
      const current = await db.tenantSourceMappingDraft.findUnique({
        where: { tenantId_connectionId: { tenantId: tx.tenantId, connectionId } },
      });
      if ((current?.version ?? 0) !== expectedVersion) {
        throw new SourcesError('stale_base_version', 'The draft changed meanwhile');
      }
      const contentHash = canonicalHash(raw);
      const now = new Date();
      const actor = actx.actor;
      const row = current
        ? await db.tenantSourceMappingDraft.update({
            where: { tenantId_connectionId: { tenantId: tx.tenantId, connectionId } },
            data: {
              document: raw,
              contentHash,
              version: current.version + 1,
              updatedAt: now,
              updatedByKind: actor.kind,
              updatedById: actor.id,
              updatedByAssurance: actor.assurance,
            },
          })
        : await db.tenantSourceMappingDraft.create({
            data: {
              tenantId: tx.tenantId,
              connectionId,
              id: randomUUID(),
              document: raw,
              contentHash,
              version: 1,
              updatedAt: now,
              updatedByKind: actor.kind,
              updatedById: actor.id,
              updatedByAssurance: actor.assurance,
            },
          });
      await this.audit.record(tx, actx, {
        ...entry,
        details: { version: row.version, contentHash },
      });
      return toDraftView(row);
    });
  }

  /** Validates the working copy against the latest snapshot, authority and adopted version. */
  @AuditFailures('mapping.draft.validate', 'mapping_draft')
  async validateDraft(
    actx: AuthorizedContext<'config.mapping.draft'>,
    connectionId: string,
    expectedVersion: number,
    options: { readonly acknowledgements?: readonly Acknowledgement[] } = {},
  ): Promise<{ readonly draft: MappingDraftView; readonly report: MappingValidationReport }> {
    assertAuthorized(actx, 'config.mapping.draft');
    const acknowledgements = options.acknowledgements ?? [];
    return this.db.transaction(actx.tenant, async (tx) => {
      await tenantAdvisoryLock(tx, 'source-mapping-draft', connectionId);
      const db = tenantClient(tx);
      const draft = await db.tenantSourceMappingDraft.findUnique({
        where: { tenantId_connectionId: { tenantId: tx.tenantId, connectionId } },
      });
      if (!draft) throw new SourcesError('mapping_draft_not_found', 'No mapping draft');
      if (draft.version !== expectedVersion) {
        throw new SourcesError('stale_base_version', 'The draft changed meanwhile');
      }
      // M9A §7.4: the acknowledgements the covering profiles require are part of
      // the validated stamp and are reused, unchanged, by the publication.
      const { report, validation } = await this.check(tx, connectionId, draft.document, {
        acknowledgements,
      });
      if (!validation.ok) throw new MappingInvalidError(validation.errors);
      // M10A2 review m7: validation refuses what publication would refuse.
      await this.refuseDisabledModuleTargets(tx, validation.document);
      const canonicalVersion = await adoptedCanonicalVersion(tx);
      const row = await db.tenantSourceMappingDraft.update({
        where: { tenantId_connectionId: { tenantId: tx.tenantId, connectionId } },
        data: {
          state: 'validated',
          validatedSnapshotHash: report.snapshotHash,
          validatedAuthorityVersion: report.authorityVersion,
          validatedCanonicalVersion: canonicalVersion,
          validation: {
            contentHash: validation.contentHash,
            warnings: Object.fromEntries(countBy(validation.warnings.map((w) => w.code))),
            acknowledgements: acknowledgements.map((a) => ({
              findingId: a.findingId,
              reasonCode: a.reasonCode,
            })),
          },
        },
      });
      await this.audit.record(tx, actx, {
        action: 'mapping.draft.validate',
        targetKind: 'mapping_draft',
        targetRef: connectionId,
        details: {
          version: row.version,
          contentHash: validation.contentHash,
          warnings: validation.warnings.length,
        },
      });
      return { draft: toDraftView(row), report };
    });
  }

  /**
   * Publishes a validated draft: refused (`mapping_not_validated`) unless the
   * draft is validated and its stamp (snapshot, authority, adopted version)
   * is still current. The publication itself re-validates and checks that the
   * published content is exactly the validated content.
   */
  @AuditFailures('mapping.publish', 'mapping_draft')
  async publishDraft(
    actx: AuthorizedContext<'config.mapping.publish'>,
    connectionId: string,
    expectedBaseVersion: number,
  ): Promise<PublishedMapping> {
    assertAuthorized(actx, 'config.mapping.publish');
    const draft = await this.db.transaction(actx.tenant, async (tx) => {
      const row = await tenantClient(tx).tenantSourceMappingDraft.findUnique({
        where: { tenantId_connectionId: { tenantId: tx.tenantId, connectionId } },
      });
      if (!row || row.state !== 'validated') {
        throw new SourcesError('mapping_not_validated', 'Validate the draft before publishing');
      }
      const snapshot = await this.repo.latestSnapshot(tx, connectionId);
      const authority = await this.repo.latestAuthority(tx);
      if (
        row.validatedSnapshotHash !== snapshot?.hash ||
        row.validatedAuthorityVersion !== (authority?.version ?? 0) ||
        row.validatedCanonicalVersion !== (await adoptedCanonicalVersion(tx))
      ) {
        throw new SourcesError(
          'mapping_not_validated',
          'The validation stamp is no longer current',
        );
      }
      return row;
    });
    // M10A2 review m8: the stamp is read back from jsonb, so parse it (fail closed).
    const parsedStamp = MappingDraftValidationStampSchema.safeParse(draft.validation);
    if (!parsedStamp.success) {
      throw new SourcesError('mapping_not_validated', 'The validation stamp is malformed');
    }
    const stamp = parsedStamp.data;
    const published = await this.publish(actx, connectionId, draft.document, {
      expectedBaseVersion,
      expectedContentHash: stamp.contentHash,
      ...(stamp.acknowledgements?.length ? { acknowledgements: stamp.acknowledgements } : {}),
    });
    // The working copy is consumed (only if nobody edited it meanwhile).
    await this.db.transaction(actx.tenant, (tx) =>
      tenantClient(tx).tenantSourceMappingDraft.deleteMany({
        where: { tenantId: tx.tenantId, connectionId, version: draft.version },
      }),
    );
    return published;
  }

  @AuditFailures('mapping.draft.discard', 'mapping_draft')
  async discardDraft(
    actx: AuthorizedContext<'config.mapping.draft'>,
    connectionId: string,
  ): Promise<{ readonly discarded: boolean }> {
    assertAuthorized(actx, 'config.mapping.draft');
    return this.db.transaction(actx.tenant, async (tx) => {
      const { count } = await tenantClient(tx).tenantSourceMappingDraft.deleteMany({
        where: { tenantId: tx.tenantId, connectionId },
      });
      await this.audit.record(tx, actx, {
        action: 'mapping.draft.discard',
        targetKind: 'mapping_draft',
        targetRef: connectionId,
        details: { discarded: count > 0 },
      });
      return { discarded: count > 0 };
    });
  }

  async showDraft(ctx: TenantContext, connectionId: string): Promise<MappingDraftView | undefined> {
    const row = await this.db.transaction(ctx, (tx) =>
      tenantClient(tx).tenantSourceMappingDraft.findUnique({
        where: { tenantId_connectionId: { tenantId: tx.tenantId, connectionId } },
      }),
    );
    return row ? toDraftView(row) : undefined;
  }

  /**
   * M10D (plan §5.4, Q20): the registry additions the capture entries of a
   * mapping need (`extension capture-draft`). Reads the given document, else
   * the connection's working copy, else its published mapping; publishes
   * nothing. Codes, keys and source names only (never values).
   */
  // Review m3: an operator command (config.mapping.draft), audited once with counts only.
  @AuditFailures('mapping.draft.validate', 'mapping_draft')
  async captureDraft(
    actx: AuthorizedContext<'config.mapping.draft'>,
    connectionId: string,
    raw?: unknown,
  ): Promise<{
    readonly from: 'document' | 'draft' | 'published';
    readonly entries: CaptureDraftEntry[];
  }> {
    assertAuthorized(actx, 'config.mapping.draft');
    return this.db.transaction(actx.tenant, async (tx) => {
      const connection = await this.repo.connection(tx, connectionId);
      if (!connection) throw new ConnectionNotFoundError(connectionId);
      const snapshot = await this.repo.latestSnapshot(tx, connectionId);
      if (!snapshot) {
        throw new SourcesError('no_schema_snapshot', 'Capture a schema snapshot before mapping');
      }
      let from: 'document' | 'draft' | 'published' = 'document';
      let document = raw;
      if (document === undefined) {
        const draft = await tenantClient(tx).tenantSourceMappingDraft.findUnique({
          where: { tenantId_connectionId: { tenantId: tx.tenantId, connectionId } },
          select: { document: true },
        });
        from = draft ? 'draft' : 'published';
        document =
          draft?.document ?? (await this.repo.publishedMapping(tx, connectionId))?.document;
      }
      const parsed = MappingDocumentSchema.safeParse(document);
      if (!parsed.success) {
        throw new SourcesError(
          'mapping_invalid',
          'No valid mapping document to read capture entries from',
        );
      }
      const schema = SourceSchemaSchema.parse(snapshot.document);
      const profiles = await this.profiles.candidateProfiles(tx, connectionId, snapshot.hash);
      const sources: CaptureSource[] = [];
      for (const o of parsed.data.objects) {
        for (const f of o.fields) {
          if (!('kind' in f) || f.kind !== 'capture') continue;
          const field = findSourceField(schema, o.source, f.source);
          const sensitivity = profiledSensitivity(schema, profiles, o.source, f.source);
          sources.push({
            connectionKind: connection.kind,
            object: o.source,
            entity: o.entity,
            field: f.source,
            ...(sensitivity !== undefined ? { profileSensitivity: sensitivity } : {}),
            ...(field ? { sourceType: field.type } : {}),
          });
        }
      }
      const existing = await tenantClient(tx).tenantRegistryEntry.findMany({
        where: { tenantId: tx.tenantId, kind: 'extension' },
        select: { key: true },
      });
      const entries = captureDraft(sources, new Set(existing.map((e) => e.key)), isSensitiveName);
      await this.audit.record(tx, actx, {
        action: 'mapping.draft.validate',
        targetKind: 'mapping_draft',
        targetRef: connectionId,
        details: {
          capture: true,
          from,
          fields: entries.filter((e) => e.ok).length,
          refused: entries.filter((e) => !e.ok).length,
        },
      });
      return { from, entries };
    });
  }

  /** The lifecycle state of every published version (M10A2). */
  async states(ctx: TenantContext, connectionId: string) {
    return this.db.transaction(ctx, (tx) => this.repo.mappingStates(tx, connectionId));
  }

  private async refuseDisabledModuleTargets(
    tx: TenantTransaction,
    document: MappingDocument,
  ): Promise<void> {
    const enabled = new Set(
      (await moduleSettings(tx)).filter((s) => s.enabled).map((s) => s.moduleKey),
    );
    const blocked = disabledModuleTargets(
      // M10D: custom objects land on entity kind custom_record (module extension);
      // M10E: a line's context reference writes entity kind account_context.
      document.objects.flatMap((o) => [
        isCustomObjectEntity(o.entity) ? 'custom_record' : o.entity,
        ...(o.relationships.some((r) => r.target === CONTEXT_REF_TARGET)
          ? ['account_context']
          : []),
      ]),
      CANONICAL_MODULES,
      enabled,
    );
    if (blocked.length > 0) {
      throw new SourcesError(
        'module_disabled',
        `Mapping targets ${blocked[0]!.entityKind} of disabled module ${blocked[0]!.module}`,
      );
    }
  }

  /**
   * M10E (plan §5): the 0.5 + module gate and the published context types
   * (registry kind `context_type`; unparseable definitions are left out).
   */
  private async accountContextMappingContext(
    tx: TenantTransaction,
  ): Promise<AccountContextMappingContext> {
    const adopted = await adoptedCanonicalVersion(tx);
    const enabled = (await moduleSettings(tx)).some(
      (m) => m.moduleKey === ACCOUNT_CONTEXT_MODULE_KEY && m.enabled,
    );
    const gate =
      compareCanonicalVersion(adopted, ACCOUNT_CONTEXT_MIN_VERSION) < 0
        ? ('canonical_version_too_low' as const)
        : enabled
          ? ('ok' as const)
          : ('module_disabled' as const);
    const rows = await tenantClient(tx).tenantRegistryEntry.findMany({
      where: { tenantId: tx.tenantId, kind: 'context_type' },
      select: { key: true, status: true, definition: true },
    });
    const types = new Map<string, AccountContextMappingType>();
    for (const r of rows) {
      const parsed = parseStoredContextType(r.definition);
      if (!parsed.success) continue;
      types.set(r.key, {
        status: r.status === 'active' && parsed.data.status === 'active' ? 'active' : 'retired',
        dimensions: parsed.data.dimensions.map((d) => ({ key: d.key, required: d.required })),
        memberRoles: parsed.data.member_roles,
      });
    }
    return { gate, types };
  }

  /**
   * M10D (plan §5, Q14, Q18): the 0.4 + module gate, the current published
   * extension registry and, per custom object, the connection whose published
   * mapping maps it (a second connection is refused at publish).
   */
  private async extensionContext(
    tx: TenantTransaction,
    connectionId: string,
  ): Promise<ExtensionMappingContext> {
    const adopted = await adoptedCanonicalVersion(tx);
    const enabled = (await moduleSettings(tx)).some(
      (m) => m.moduleKey === EXTENSION_MODULE_KEY && m.enabled,
    );
    const gate =
      compareCanonicalVersion(adopted, EXTENSION_MIN_VERSION) < 0
        ? ('canonical_version_too_low' as const)
        : enabled
          ? ('ok' as const)
          : ('module_disabled' as const);
    const db = tenantClient(tx);
    const entries = await db.tenantRegistryEntry.findMany({
      where: { tenantId: tx.tenantId, kind: 'extension' },
      select: { key: true, status: true, definition: true, sensitivity: true, categories: true },
    });
    const definitions = new Map<string, ExtensionMappingDefinition>(
      entries.map((e) => {
        const definition = (e.definition ?? {}) as Record<string, unknown>;
        return [
          e.key,
          {
            kind: definition.kind as ExtensionMappingDefinition['kind'],
            status: e.status,
            definition,
            sensitivity: e.sensitivity ?? 'restricted',
            categories: e.categories,
          },
        ];
      }),
    );
    // Tech debt #83: the owner rows are the record of Q14 ownership (claimed
    // and released with the published mappings, backfilled by the migration).
    const objectOwners = await this.repo.otherCustomObjectOwners(tx, connectionId);
    return { gate, definitions, objectOwners };
  }

  /**
   * Tech debt #83 (Q14): claims the owner rows of the custom objects `document`
   * sources for this connection at `version` and releases the rest. A second
   * owner — committed, or a concurrent publication still in flight — is a
   * unique violation on the owner table's primary key, refused with the
   * validation code `custom_object_owned_by_other_connection` (the whole
   * publication rolls back).
   */
  private async claimCustomObjectOwners(
    tx: TenantTransaction,
    connectionId: string,
    version: number,
    document: MappingDocument,
  ): Promise<{ readonly claimed: string[]; readonly released: string[] }> {
    const keys = document.objects
      .filter((o) => isCustomObjectEntity(o.entity))
      .map((o) => o.entity.slice(EXTENSION_CUSTOM_OBJECT_PREFIX.length));
    const result = await this.repo.claimCustomObjects(tx, connectionId, version, keys);
    if ('conflict' in result) {
      const entity = `${EXTENSION_CUSTOM_OBJECT_PREFIX}${result.conflict}`;
      const index = document.objects.findIndex((o) => o.entity === entity);
      throw new MappingInvalidError([
        {
          code: 'custom_object_owned_by_other_connection',
          path: `objects.${index}.entity`,
          message: `${entity} is written by another connection's published mapping (Q14)`,
        },
      ]);
    }
    return { claimed: result.claimed, released: result.released };
  }

  /** D5 safeguards: an override attempt is always logged and counted (refused in M9A). */
  private auditOverride(
    ctx: TenantContext,
    connectionId: string,
    options: { profileOverride?: { reason: string } },
    actor: string,
  ): void {
    if (!options.profileOverride) return;
    this.metrics?.increment('lip_profile_override_total', { kind: 'refused' });
    this.logger.warn(
      {
        tenant: ctx.tenantSlug,
        connectionId,
        actor,
        code: 'override_requires_authenticated_operator',
      },
      'Profile override attempt refused',
    );
  }

  /**
   * A stored mapping version: the given version, or — with no version — the
   * connection's published one (M10A2 review m7), read through the lifecycle
   * like sync and reports; a retired or superseded highest version is not
   * what `show` reports as current.
   */
  async show(
    ctx: TenantContext,
    connectionId: string,
    version?: number,
  ): Promise<(Omit<StoredMappingVersion, 'document'> & { document: MappingDocument }) | undefined> {
    const row = await this.db.transaction(ctx, (tx) =>
      version === undefined
        ? this.repo.publishedMapping(tx, connectionId)
        : this.repo.mappingVersion(tx, connectionId, version),
    );
    return row ? { ...row, document: MappingDocumentSchema.parse(row.document) } : undefined;
  }

  private async check(
    tx: TenantTransaction,
    connectionId: string,
    raw: unknown,
    options: ValidateMappingOptions,
  ): Promise<{ report: MappingValidationReport; validation: MappingValidation }> {
    const connection = await this.repo.connection(tx, connectionId);
    if (!connection) throw new ConnectionNotFoundError(connectionId);
    if (connection.mappingMode !== 'versioned') {
      throw new SourcesError('mapping_not_versioned', `${connection.kind} is mapped in code`);
    }
    const snapshot = await this.repo.latestSnapshot(tx, connectionId);
    if (!snapshot) {
      throw new SourcesError('no_schema_snapshot', 'Capture a schema snapshot before mapping');
    }
    const authority = await this.repo.latestAuthority(tx);
    const schemaHash = options.validatedAgainst ?? snapshot.hash;
    const settings = SourceProfileSettingsSchema.safeParse(connection.config.profile);
    const validation = validateMapping(raw, {
      connectionId,
      kind: connection.kind,
      schema: SourceSchemaSchema.parse(snapshot.document),
      schemaHash,
      latestSchemaHash: snapshot.hash,
      authority: authority?.document ?? UNASSIGNED_AUTHORITY,
      profiling: {
        profiles: await this.profiles.candidateProfiles(tx, connectionId, schemaHash),
        now: new Date(),
        freshnessDays: settings.success
          ? (settings.data.freshnessDays ?? PROFILE_FRESHNESS.defaultDays)
          : PROFILE_FRESHNESS.defaultDays,
        acknowledgements: options.acknowledgements ?? [],
        ...(options.profileOverride ? { override: options.profileOverride } : {}),
        // No authenticated operator channel exists (A1): the CLI actor is unauthenticated.
        operator: { authenticated: false, actor: options.actor ?? 'cli' },
      },
      extension: await this.extensionContext(tx, connectionId),
      accountContext: await this.accountContextMappingContext(tx),
    });
    return {
      validation,
      report: {
        ok: validation.ok,
        snapshotHash: snapshot.hash,
        authorityVersion: authority?.version ?? 0,
        ...(validation.ok ? { contentHash: validation.contentHash } : {}),
        errors: validation.ok ? [] : validation.errors,
        warnings: validation.warnings,
        coveringProfileIds: validation.ok ? validation.coveringProfileIds : [],
      },
    };
  }
}

function countBy(codes: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of codes) out.set(c, (out.get(c) ?? 0) + 1);
  return out;
}

function toDraftView(row: {
  connectionId: string;
  state: string;
  version: number;
  contentHash: string;
  validatedSnapshotHash: string | null;
  validatedAuthorityVersion: number | null;
  validatedCanonicalVersion: string | null;
  validation: unknown;
}): MappingDraftView {
  return {
    connectionId: row.connectionId,
    state: row.state as MappingDraftView['state'],
    version: row.version,
    contentHash: row.contentHash,
    validatedSnapshotHash: row.validatedSnapshotHash,
    validatedAuthorityVersion: row.validatedAuthorityVersion,
    validatedCanonicalVersion: row.validatedCanonicalVersion,
    validation: row.validation,
  };
}
