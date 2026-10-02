import { Injectable } from '@nestjs/common';
import {
  indexProductModel,
  validateProductModel,
  type IndexedProductModel,
  type ProductDefinition,
  type ProductModelDocument,
  type ProductModelIssue,
  type PublishedModelRef,
} from '../../domain';
import { TenantDatabase, type TenantContext, type TenantTransaction } from '../../tenancy';
import { ProductModelStore, type StoredModelVersion } from '../infrastructure/product-model.store';

export class ProductModelInvalidError extends Error {
  constructor(
    readonly errors: readonly ProductModelIssue[],
    readonly warnings: readonly ProductModelIssue[],
  ) {
    super(`product model is invalid: ${errors.map((e) => e.code).join(', ')}`);
    this.name = 'ProductModelInvalidError';
  }
}

export class ConcurrentPublishError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `concurrent_publish: expected latest version ${expected}, found ${actual}; validate again`,
    );
    this.name = 'ConcurrentPublishError';
  }
}

export class NoProductModelError extends Error {
  constructor(readonly asOf: Date) {
    super(`no product model is in force at ${asOf.toISOString()}`);
    this.name = 'NoProductModelError';
  }
}

export interface PublishOptions {
  readonly effectiveFrom?: Date;
  /** Who publishes (operator id or tool name; codes only). */
  readonly actor: string;
  /** Optimistic check: the latest version the document was prepared against. */
  readonly basedOnVersion?: number;
  /** Clock reading (tests); defaults to now. */
  readonly now?: Date;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly errors: readonly ProductModelIssue[];
  readonly warnings: readonly ProductModelIssue[];
  readonly contentHash?: string;
  readonly latestVersion: number;
  readonly nextVersion: number;
}

export interface PublishedVersion {
  readonly version: number;
  readonly contentHash: string;
  readonly effectiveFrom: Date;
  readonly warnings: readonly ProductModelIssue[];
}

/**
 * The tenant's product catalogue (ADR 0016): validate and publish immutable
 * model versions, select the version in force, and read the catalogue. The
 * model is authoritative; `tenant_products` is its projection, updated in the
 * same transaction as the version insert.
 */
@Injectable()
export class ProductCatalogueService {
  private readonly cache = new Map<string, IndexedProductModel>();

  constructor(
    private readonly db: TenantDatabase,
    private readonly store: ProductModelStore,
  ) {}

  /** Dry run: full validation against the latest version, nothing written. */
  async validate(
    ctx: TenantContext,
    document: unknown,
    options: Omit<PublishOptions, 'actor'> = {},
  ): Promise<ValidationReport> {
    return this.db.transaction(ctx, async (tx) => {
      const now = options.now ?? new Date();
      const { previous, latest } = await this.previous(tx);
      const v = validateProductModel(document, {
        previous: previous ?? null,
        publish: { effectiveFrom: options.effectiveFrom ?? now, now },
      });
      return {
        ok: v.ok,
        errors: v.ok ? [] : v.errors,
        warnings: v.warnings,
        ...(v.ok ? { contentHash: v.contentHash } : {}),
        latestVersion: latest?.version ?? 0,
        nextVersion: (latest?.version ?? 0) + 1,
      };
    });
  }

  /**
   * Publish atomically: lock, validate against the latest version, insert the
   * immutable version, update the projection, commit. Any failure leaves no
   * version and no projection change.
   */
  async publish(
    ctx: TenantContext,
    document: unknown,
    options: PublishOptions,
  ): Promise<PublishedVersion> {
    return this.db.transaction(ctx, async (tx) => {
      await this.store.lockPublication(tx);
      const now = options.now ?? new Date();
      const effectiveFrom = options.effectiveFrom ?? now;
      const { previous, latest } = await this.previous(tx);
      const latestVersion = latest?.version ?? 0;
      if (options.basedOnVersion !== undefined && options.basedOnVersion !== latestVersion) {
        throw new ConcurrentPublishError(options.basedOnVersion, latestVersion);
      }
      const v = validateProductModel(document, {
        previous: previous ?? null,
        publish: { effectiveFrom, now },
      });
      if (!v.ok) throw new ProductModelInvalidError(v.errors, v.warnings);
      const version = latestVersion + 1;
      await this.store.insertVersion(tx, {
        version,
        document: v.document,
        contentHash: v.contentHash,
        effectiveFrom,
        publishedBy: options.actor,
      });
      await this.store.upsertProjection(tx, v.document, version);
      return { version, contentHash: v.contentHash, effectiveFrom, warnings: v.warnings };
    });
  }

  /** The indexed model in force at `asOf`, or undefined if none is. */
  async modelAt(ctx: TenantContext, asOf: Date): Promise<IndexedProductModel | undefined> {
    return this.db.transaction(ctx, (tx) => this.modelAtTx(tx, asOf));
  }

  /** Same as `modelAt`, inside an existing tenant transaction. */
  async modelAtTx(tx: TenantTransaction, asOf: Date): Promise<IndexedProductModel | undefined> {
    const stored = await this.store.inForceAt(tx, asOf);
    return stored ? this.indexed(tx.tenantId, stored) : undefined;
  }

  /** A specific version (snapshot replay). Re-validated on load. */
  async modelVersionTx(
    tx: TenantTransaction,
    version: number,
  ): Promise<IndexedProductModel | undefined> {
    const stored = await this.store.byVersion(tx, version);
    return stored ? this.indexed(tx.tenantId, stored) : undefined;
  }

  /** Version history (no documents). */
  async versions(ctx: TenantContext) {
    return this.db.transaction(ctx, (tx) => this.store.versions(tx));
  }

  /** One version with its document, or the latest. */
  async show(ctx: TenantContext, version?: number): Promise<StoredModelVersion | undefined> {
    return this.db.transaction(ctx, (tx) =>
      version === undefined ? this.store.latest(tx) : this.store.byVersion(tx, version),
    );
  }

  /** The catalogue in force (products with status and relationships), for listing and the UI. */
  async listProducts(
    ctx: TenantContext,
    options: { asOf?: Date; includeRetired?: boolean } = {},
  ): Promise<{
    modelVersion: number | null;
    products: readonly ProductDefinition[];
    relationships: ProductModelDocument['relationships'];
  }> {
    const asOf = options.asOf ?? new Date();
    const model = await this.modelAt(ctx, asOf);
    if (!model) return { modelVersion: null, products: [], relationships: [] };
    const products = model.document.products.filter(
      (p) => options.includeRetired || p.status === 'active',
    );
    return { modelVersion: model.version, products, relationships: model.document.relationships };
  }

  async getProduct(
    ctx: TenantContext,
    key: string,
    asOf = new Date(),
  ): Promise<ProductDefinition | undefined> {
    const model = await this.modelAt(ctx, asOf);
    return model?.document.products.find((p) => p.key === key);
  }

  /** Field-level differences between two versions (keys and rule ids only). */
  async diff(ctx: TenantContext, from: number, to: number) {
    return this.db.transaction(ctx, async (tx) => {
      const [a, b] = await Promise.all([
        this.store.byVersion(tx, from),
        this.store.byVersion(tx, to),
      ]);
      if (!a || !b) return undefined;
      const da = this.indexed(tx.tenantId, a).document;
      const dbDoc = this.indexed(tx.tenantId, b).document;
      const byKey = (d: ProductModelDocument) => new Map(d.products.map((p) => [p.key, p]));
      const pa = byKey(da);
      const pb = byKey(dbDoc);
      const changed: { key: string; fields: string[] }[] = [];
      for (const [key, next] of pb) {
        const prev = pa.get(key);
        if (!prev) continue;
        const fields = (
          [
            'name',
            'description',
            'family',
            'status',
            'availableFrom',
            'availableUntil',
            'externalRefs',
          ] as const
        ).filter((f) => JSON.stringify(prev[f] ?? null) !== JSON.stringify(next[f] ?? null));
        if (fields.length) changed.push({ key, fields });
      }
      const ids = (d: ProductModelDocument) =>
        new Set([...d.relationships, ...d.conditions].map((r) => r.id));
      const ia = ids(da);
      const ib = ids(dbDoc);
      return {
        from,
        to,
        productsAdded: [...pb.keys()].filter((k) => !pa.has(k)),
        productsChanged: changed,
        rulesAdded: [...ib].filter((i) => !ia.has(i)).sort(),
        rulesRemoved: [...ia].filter((i) => !ib.has(i)).sort(),
        renames: dbDoc.products
          .filter((p) => p.renamedFrom && pa.get(p.key)?.name !== p.name)
          .map((p) => p.key),
        reactivations: dbDoc.lifecycle.map((l) => l.key),
      };
    });
  }

  private indexed(tenantId: string, stored: StoredModelVersion): IndexedProductModel {
    const key = `${tenantId}:${stored.version}:${stored.contentHash}`;
    let model = this.cache.get(key);
    if (!model) {
      model = indexProductModel({
        version: stored.version,
        effectiveFrom: stored.effectiveFrom,
        document: stored.document,
        contentHash: stored.contentHash,
      });
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(key, model);
    }
    return model;
  }

  /**
   * The previous version for cross-version checks: the latest published one;
   * or, before any version exists, the catalogue rows created before M7 (so
   * the first model cannot silently drop or redefine them: K1–K4).
   */
  private async previous(
    tx: TenantTransaction,
  ): Promise<{ previous?: PublishedModelRef; latest?: StoredModelVersion }> {
    const latest = await this.store.latest(tx);
    if (latest) {
      return {
        latest,
        previous: {
          version: latest.version,
          effectiveFrom: latest.effectiveFrom,
          document: this.indexed(tx.tenantId, latest).document,
        },
      };
    }
    const rows = await this.store.projection(tx);
    if (rows.length === 0) return {};
    const legacy = validateProductModel({
      products: rows.map((r) => ({
        key: r.key,
        name: r.name,
        ...(r.description ? { description: r.description } : {}),
        ...(r.family ? { family: r.family } : {}),
        status: r.active ? 'active' : 'retired',
      })),
    });
    if (!legacy.ok) return {};
    return { previous: { version: 0, effectiveFrom: new Date(0), document: legacy.document } };
  }
}
